// src/native_boot/catalog_source.rs
//
// Purpose: Supply actual selected-account raw KV catalog assembly under its current browser and native selection witnesses.
// Invariants: Borrow the same SelectedAccount/LocalAccount; never infer a publisher address or effective setting absence; no route grant from raw DATA.
// Security: Preserve fresh browser admission before/after assembly, cheap state lock/file checks per raw read, cancellation and redacted failures.
// AI Assistant Directive: Preserve and extend these source and unsupported-boundary details.

use super::SelectedAccount;
use content_crypto::advanced::blake3;
use crate::{
    account::{BrowserAdmission, NativeAccountOwner},
    ecma_json::JsString,
    local_account::{
        catalog_delivery::CatalogDeliveryWitness,
        catalog_source::{CatalogMetadata, PUBLISHER_SETTINGS},
    },
    tools_catalog::{self, Catalog, CatalogSource, Failure, Limits, ReadBudget, Selection},
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

struct CurrentCatalog<'a> {
    selected: &'a mut SelectedAccount,
    metadata: CatalogMetadata,
    session_id: &'a str,
    admitted: BrowserAdmission,
    cancel: &'a AtomicBool,
    observation: Option<&'a CatalogDeliveryWitness>,
}
impl CatalogSource for CurrentCatalog<'_> {
    fn assert_current(&mut self) -> Result<(), Failure> {
        if self.cancel.load(Ordering::Acquire) {
            return Err(crate::cause!(Failure::Cancelled));
        }
        self.selected
            .assert_source_current()
            .map_err(|error| Failure::Source(error.cause()))?;
        let now = crate::account::current_browser_read_only(self.selected, self.session_id)
            .map_err(|error| Failure::Source(error.cause()))?;
        if now.account != self.admitted.account
            || !self.admitted.still()
        {
            return Err(crate::cause!(Failure::Source));
        }
        self.metadata.assert_current()?;
        Ok(())
    }
    fn selection(&mut self) -> Result<Selection, Failure> {
        self.selected
            .assert_source_current()
            .map_err(|error| Failure::Source(error.cause()))?;
        let mut makers = Vec::new();
        for name in PUBLISHER_SETTINGS {
            // Original localOnlyOptions has no OPERATOR binding, and private
            // restore bindings cannot supply it. A valid missing public
            // OPERATOR is genuinely unconfigured. The Marketplace publisher
            // must replace the synthetic base and may be credential-backed;
            // unresolved publisher identity is never an absent default.
            let Some(address) = self.metadata.publisher_person_id(name)? else {
                continue;
            };
            // Original makerOfStore hashes the original PERSON address, not
            // the configured account name, physical localId or selected user.
            let maker = JsString::from(format!(
                "maker:{}",
                blake3::hash(address.as_bytes()).to_hex()
            ));
            if !makers.contains(&maker) {
                makers.push(maker);
            }
        }
        self.selected
            .assert_source_current()
            .map_err(|error| Failure::Source(error.cause()))?;
        self.metadata.assert_current()?;
        Ok(Selection {
            workshop_identity: self.metadata.workshop_identity.clone(),
            default_makers: makers,
        })
    }
    fn read_raw(&mut self, key: &str, budget: ReadBudget) -> Result<Option<Vec<u8>>, Failure> {
        // As for the current record witness: no disclosure occurs per query.
        // Hold the same account's state lock/file custody here. The
        // exclusively borrowed outer selection and full browser/policy checks
        // are rechecked at assembly boundaries before any result can escape;
        // do not reread every frontend program file around each KV lookup.
        self.selected.owner.catalog_raw_read_observed(
            &self.metadata,
            key,
            budget,
            self.cancel,
            self.observation,
        )
    }
}
impl SelectedAccount {
    /// Concrete catalog assembly on the same selected current account. Missing
    /// publisher settings and PERSON mappings remain unsupported. Returned raw
    /// payloads still require descriptor admission; this method is no HTTP route
    /// or execution grant and does not adopt a copied/static account snapshot.
    pub fn current_tools_catalog<'a>(
        &'a mut self,
        session_id: &'a str,
        limits: &Limits,
        cancel: &'a AtomicBool,
    ) -> Result<Catalog, Failure> {
        self.current_tools_catalog_observed(session_id, limits, cancel, None)
    }

    pub(crate) fn current_tools_catalog_observed<'a>(
        &'a mut self,
        session_id: &'a str,
        limits: &Limits,
        cancel: &'a AtomicBool,
        observation: Option<&'a CatalogDeliveryWitness>,
    ) -> Result<Catalog, Failure> {
        if cancel.load(Ordering::Acquire) {
            return Err(crate::cause!(Failure::Cancelled));
        }
        if limits.elapsed.is_zero() || limits.elapsed > Duration::from_secs(30) {
            return Err(crate::cause!(Failure::Invalid));
        }
        let started = Instant::now();
        let deadline = started.checked_add(limits.elapsed).ok_or(crate::cause!(Failure::Bounds))?;
        self.assert_source_current().map_err(|error| Failure::Source(error.cause()))?;
        let admitted =
            crate::account::current_browser(self, session_id).map_err(|error| Failure::Source(error.cause()))?;
        let metadata = self.owner.catalog_metadata(cancel, deadline)?;
        let mut remaining = limits.clone();
        remaining.elapsed = limits
            .elapsed
            .checked_sub(started.elapsed())
            .ok_or(crate::cause!(Failure::Bounds))?;
        let mut source = CurrentCatalog {
            selected: self,
            metadata,
            session_id,
            admitted,
            cancel,
            observation,
        };
        let catalog = tools_catalog::read_catalog(&mut source, &remaining, cancel)?;
        if let Some(observation) = observation {
            source
                .selected
                .owner
                .tools_catalog_delivery_current(observation)
                .map_err(|error| Failure::Source(error.cause()))?;
            observation
                .remember_metadata(source.metadata)
                .map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        }
        Ok(catalog)
    }

    /// The same catalog, assembled once and answered again while everything it was read from is unchanged. The
    /// catalog is a pure function of the account's KV entries, the blobs they name, the pinned restore metadata and
    /// the clock against the entries' expiry: exactly what a `CatalogDeliveryWitness` holds (the KV file's
    /// `data_version` on its own handle, every blob's generation, the metadata, the earliest expiry). While that
    /// witness is current the kept bytes are the bytes a fresh assembly would produce, so a hit reads no KV entry and
    /// no blob. Browser admission is still checked on every call, before and after, as for a fresh assembly.
    /// Assembling it on every tool-screens read was ~1.2 s of the account owner's time per read (sampled 2026-10-30
    /// on a clone of a real account), which turned the page's concurrent first reads into 503s.
    pub(crate) fn kept_tools_catalog(
        &mut self,
        session_id: &str,
        limits: &Limits,
        cancel: &AtomicBool,
    ) -> Result<KeptCatalogRead, Failure> {
        if cancel.load(Ordering::Acquire) {
            return Err(crate::cause!(Failure::Cancelled));
        }
        let account = self.kept_catalog_account();
        let mut kept = KEPT_CATALOGS.lock().map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        if let Some(at) = kept.iter().position(|held| held.account == account) {
            let held = kept.remove(at);
            self.assert_source_current().map_err(|error| Failure::Source(error.cause()))?;
            let admitted =
                crate::account::current_browser(self, session_id).map_err(|error| Failure::Source(error.cause()))?;
            let current = {
                let witness = held.witness.lock().map_err(|error| crate::carry_cause!(Failure::Source, error))?;
                self.owner.tools_catalog_delivery_current(&witness).is_ok()
            };
            if current {
                let now =
                    crate::account::current_browser_read_only(self, session_id).map_err(|error| Failure::Source(error.cause()))?;
                if now.account != admitted.account
                    || !admitted.still()
                {
                    return Err(crate::cause!(Failure::Source));
                }
                let read = KeptCatalogRead {
                    account: held.account.clone(),
                    witness: held.witness.clone(),
                    catalog: held.catalog.clone(),
                };
                kept.push(held);
                return Ok(read);
            }
        }
        let witness = self
            .owner
            .tools_catalog_delivery_witness()
            .map_err(|error| Failure::Source(error.cause()))?;
        let catalog = Arc::new(self.current_tools_catalog_observed(
            session_id,
            limits,
            cancel,
            Some(&witness),
        )?);
        let witness = Arc::new(Mutex::new(witness));
        if kept.len() >= KEPT_CATALOGS_MOST {
            kept.remove(0);
        }
        kept.push(KeptCatalog {
            account: account.clone(),
            witness: witness.clone(),
            catalog: catalog.clone(),
        });
        Ok(KeptCatalogRead { account, witness, catalog })
    }

    /// Whether everything the catalog `read` holds was read from is unchanged: the catalog a page was projected from
    /// is still the one a fresh assembly would give. A read checks the witness of the catalog it holds, never
    /// whichever one is kept now, so it answers the same whether or not its catalog is still kept.
    pub(crate) fn kept_tools_catalog_current(&mut self, read: &KeptCatalogRead) -> Result<(), Failure> {
        if read.account != self.kept_catalog_account() {
            return Err(crate::cause!(Failure::Source));
        }
        let witness = read.witness.lock().map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        self.owner
            .tools_catalog_delivery_current(&witness)
            .map_err(|error| Failure::Source(error.cause()))
    }

    /// The account a kept catalog belongs to: its selected state folder and restore receipt.
    fn kept_catalog_account(&self) -> (std::path::PathBuf, String) {
        (
            self.selection.selected().root.clone(),
            self.selection.selected().receipt.blake3.clone(),
        )
    }
}

/// A kept catalog with the witness of what it was read from and the account it belongs to.
struct KeptCatalog {
    account: (std::path::PathBuf, String),
    witness: Arc<Mutex<CatalogDeliveryWitness>>,
    catalog: Arc<Catalog>,
}
/// What one read took from the kept catalogs: the catalog and the witness it was read under, to check it again
/// later. The read holds its own witness, so a catalog no longer kept (another account's took its place) is still
/// checked against everything it was read from.
pub(crate) struct KeptCatalogRead {
    account: (std::path::PathBuf, String),
    witness: Arc<Mutex<CatalogDeliveryWitness>>,
    pub(crate) catalog: Arc<Catalog>,
}
/// The most accounts whose catalog is kept at once (an engine serves one selected account; tests open many).
const KEPT_CATALOGS_MOST: usize = 8;
/// Kept catalogs, the most recently used last.
static KEPT_CATALOGS: Mutex<Vec<KeptCatalog>> = Mutex::new(Vec::new());
