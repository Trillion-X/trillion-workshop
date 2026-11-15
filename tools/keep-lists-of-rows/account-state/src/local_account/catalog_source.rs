// src/local_account/catalog_source.rs
//
// Purpose: Reuse this selected account's existing raw KV and original PERSON name index for tool catalog reads. An account
// whose restore receipt names no WORKSHOP_IDENTITY (one made by `account create`, never carried from old Trillion) takes
// its shipped rows from the Workshop copy installed in its own state folder: the copy every computer installs from the
// signed Workshop feed (src/tool_runs/tools/install.rs), read by the one installed-rows reader (`Workshop::installed_rows`).
// Old Trillion bound WORKSHOP_IDENTITY per deploy, to the BLAKE3 of the rows that deploy stored; the installed copy is
// this engine's deploy of the Workshop, so its identity is the BLAKE3 of the installed rows. Nothing is copied.
// Invariants: Child of the real LocalAccount owner; no alternate paths, blob reader, store, name derivation or successful missing-setting fallback.
// Security: Metadata and bytes remain provisional under the same state lock, file custody and outer browser/selection witness. Never log values.
// AI Assistant Directive: Preserve and extend these source and unsupported-boundary details.

use super::catalog_delivery::CatalogDeliveryWitness;
use super::{bounded_file, hex, LocalAccount, MAX_INDEX, MAX_JSON};
use crate::{
    account_source::binding_identity::{
        is_restore_placeholder, Error as BindingError, ProtectedBindingIdentity,
    },
    ecma_json::JsString,
    tools_catalog::{Failure, ReadBudget},
};
use content_crypto::advanced::blake3;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

/// The current native public-setting schema names these same two declared
/// publishers (original marketplace-defaults.json). This does not select tools.
pub(crate) const PUBLISHER_SETTINGS: [&str; 2] =
    ["OPERATOR_ACCOUNT_ID", "MARKETPLACE_PUBLISHER_ACCOUNT_ID"];

pub(crate) struct CatalogMetadata {
    pub(crate) workshop_identity: String,
    settings: BTreeMap<String, JsString>,
    person_ids: BTreeMap<String, String>,
    publisher: Option<ProtectedBindingIdentity>,
    /// The installed Workshop rows this catalog is, for an account whose receipt names no WORKSHOP_IDENTITY.
    installed: Option<Installed>,
}

/// The shipped rows of an account made here: the rows of the Workshop copy installed in its state folder now (none
/// before its first install), as the bytes the catalog reads as its one shipped part.
struct Installed {
    state_root: PathBuf,
    rows: Option<Arc<Vec<Value>>>,
    bytes: Arc<Vec<u8>>,
}
impl Installed {
    fn rows_now(state_root: &std::path::Path) -> Result<Option<Arc<Vec<Value>>>, Failure> {
        crate::tool_runs::tools::shipped()
            .and_then(|workshop| workshop.installed_rows(state_root))
            .map_err(|error| Failure::Source(error.cause()))
    }
    fn bytes_of(rows: Option<&Vec<Value>>) -> Result<Vec<u8>, Failure> {
        serde_json::to_vec(rows.map_or(&[][..], Vec::as_slice))
            .map_err(|error| crate::carry_cause!(Failure::Integrity, error))
    }
    fn read(state_root: PathBuf) -> Result<Self, Failure> {
        let rows = Self::rows_now(&state_root)?;
        let bytes = Self::bytes_of(rows.as_deref())?;
        Ok(Self { state_root, rows, bytes: Arc::new(bytes) })
    }
    /// Whether the installed copy is still the one read: the same kept parse (an installed commit is parsed once and
    /// never changes; a new install is a new parse), or else a parse of the same bytes. A new install changes the
    /// identity, so a kept catalog is never answered for it. The kept-parse check serializes nothing.
    fn assert_current(&self) -> Result<(), Failure> {
        let same = match (&self.rows, Self::rows_now(&self.state_root)?) {
            (Some(before), Some(after)) => {
                Arc::ptr_eq(before, &after) || Self::bytes_of(Some(&after))? == *self.bytes
            }
            (None, None) => true,
            _ => false,
        };
        if !same {
            return Err(crate::cause!(Failure::Source));
        }
        Ok(())
    }
}
impl CatalogMetadata {
    fn person_id(&self, name: &JsString) -> Result<&str, Failure> {
        let name = name.to_rust_string().map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        self.person_ids
            .get(&name)
            .map(String::as_str)
            .ok_or(crate::cause!(Failure::Source))
    }
    pub(crate) fn assert_current(&self) -> Result<(), Failure> {
        if let Some(installed) = &self.installed {
            installed.assert_current()?;
        }
        if let Some(publisher) = &self.publisher {
            publisher.assert_current().map_err(|error| Failure::Source(error.cause()))?;
        }
        Ok(())
    }
    /// Only original PERSON addresses leave this lookup. A credential value
    /// remains in the existing credential owner's zeroizing capability, never
    /// the public environment, selected account setting API, catalog or logs.
    pub(crate) fn publisher_person_id(&self, setting: &str) -> Result<Option<String>, Failure> {
        self.assert_current()?;
        if !PUBLISHER_SETTINGS.contains(&setting) {
            return Err(crate::cause!(Failure::Source));
        }
        // The installed copy is the Workshop's own published rows: no restored publisher shelf is projected over it.
        if self.installed.is_some() {
            return Ok(None);
        }
        if let Some(value) = self.settings.get(setting) {
            if value.is_empty() || value.len() > 2048 {
                return Err(crate::cause!(Failure::Source));
            }
            if setting == "MARKETPLACE_PUBLISHER_ACCOUNT_ID"
                && value.to_rust_string().is_ok_and(|text| is_restore_placeholder(&text))
            {
                return Err(crate::cause!(Failure::Source));
            }
            return self.person_id(value).map(|id| Some(id.to_owned()));
        }
        if setting == "OPERATOR_ACCOUNT_ID" {
            return Ok(None);
        }
        let publisher = self.publisher.as_ref().ok_or(crate::cause!(Failure::Source))?;
        publisher
            .with_current(|name| self.person_ids.get(name).cloned().ok_or(crate::cause!(Failure::Source)))
            .map_err(|error| Failure::Source(error.cause()))?
            .map(Some)
    }
}

fn publisher_credential(
    receipt: &Value,
    environment: &BTreeMap<String, String>,
    resolve: impl FnOnce(&str) -> Result<ProtectedBindingIdentity, BindingError>,
) -> Result<Option<ProtectedBindingIdentity>, Failure> {
    // Reuse the restore owner's exact public/private conflict and reference
    // schema. A failed resolution is never converted to an absent publisher.
    if super::public_environment(receipt).as_ref() != Some(environment) {
        return Err(crate::cause!(Failure::Source));
    }
    let Some(reference) = receipt
        .get("bindingCredentials")
        .and_then(|bindings| bindings.get("MARKETPLACE_PUBLISHER_ACCOUNT_ID"))
    else {
        return Ok(None);
    };
    let reference = reference.as_str().ok_or(crate::cause!(Failure::Source))?;
    resolve(reference).map(Some).map_err(|error| Failure::Source(error.cause()))
}
fn check(cancel: &AtomicBool, deadline: Option<Instant>) -> Result<(), Failure> {
    if cancel.load(Ordering::Acquire) {
        return Err(crate::cause!(Failure::Cancelled));
    }
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(crate::cause!(Failure::Bounds));
    }
    Ok(())
}

impl LocalAccount {
    /// Read only the already pinned immutable restoration index, through its
    /// existing bounded-file/custody helpers. Original restoredIdentityAdapter
    /// resolves PERSON names from precisely these names/originalId rows; the
    /// account key's text or a hash of that text is never an address substitute.
    pub(crate) fn catalog_metadata(
        &self,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<CatalogMetadata, Failure> {
        self.catalog_metadata_with(cancel, deadline, ProtectedBindingIdentity::open_existing)
    }

    fn catalog_metadata_with(
        &self,
        cancel: &AtomicBool,
        deadline: Instant,
        resolve: impl FnOnce(&str) -> Result<ProtectedBindingIdentity, BindingError>,
    ) -> Result<CatalogMetadata, Failure> {
        check(cancel, Some(deadline))?;
        self.assert_owned().map_err(|error| Failure::Source(error.cause()))?;
        let environment = self
            .source
            .public_environment
            .as_ref()
            .ok_or(crate::cause!(Failure::Source))?;
        let Some(identity) = environment.get("WORKSHOP_IDENTITY") else {
            return self.installed_catalog_metadata(environment, cancel, deadline);
        };
        let identity = Some(identity)
            .filter(|v| hex(v, 64))
            .cloned()
            .ok_or(crate::cause!(Failure::Source))?;
        let settings = PUBLISHER_SETTINGS
            .iter()
            .filter_map(|name| {
                environment
                    .get(*name)
                    .map(|value| ((*name).to_owned(), JsString::from(value.as_str())))
            })
            .collect();
        // The selected receipt already pins the reference. Resolve just that
        // named non-root binding through the existing credential owner; do not
        // list credentials or borrow a derivation/encryption root as identity.
        self.source
            .receipt_file
            .check()
            .map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        let receipt_bytes =
            bounded_file(&self.source.receipt_file.path, MAX_JSON).map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        let receipt: Value = serde_json::from_slice(&receipt_bytes).map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        let publisher = publisher_credential(&receipt, environment, resolve)?;
        self.source
            .receipt_file
            .check()
            .map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        self.source
            .index_file
            .check()
            .map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        let bytes =
            bounded_file(&self.source.index_file.path, MAX_INDEX).map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        let mut person_ids = BTreeMap::new();
        let mut count = 0usize;
        for line in bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
        {
            check(cancel, Some(deadline))?;
            count = count.checked_add(1).ok_or(crate::cause!(Failure::Bounds))?;
            if count > 4096 {
                return Err(crate::cause!(Failure::Bounds));
            }
            let row: Value = serde_json::from_slice(line).map_err(|error| crate::carry_cause!(Failure::Source, error))?;
            if row["binding"] != "PERSON" {
                continue;
            }
            if row["partial_original"] == true || row["complete_original"] == false {
                return Err(crate::cause!(Failure::Source));
            }
            let original = row["originalId"]
                .as_str()
                .filter(|id| hex(id, 64))
                .ok_or(crate::cause!(Failure::Source))?;
            if !row["localId"].as_str().is_some_and(|id| hex(id, 64))
                || !row["className"]
                    .as_str()
                    .is_some_and(|name| !name.is_empty())
            {
                return Err(crate::cause!(Failure::Source));
            }
            let names = row["names"].as_array().ok_or(crate::cause!(Failure::Source))?;
            if names.len() > 4096 {
                return Err(crate::cause!(Failure::Bounds));
            }
            for name in names {
                let name = name
                    .as_str()
                    .filter(|name| !name.is_empty() && name.len() <= 2048)
                    .ok_or(crate::cause!(Failure::Source))?;
                if person_ids
                    .insert(name.to_owned(), original.to_owned())
                    .is_some()
                {
                    return Err(crate::cause!(Failure::Source));
                }
            }
        }
        // Prove the retained account's own mapping before using this index as
        // an original store adapter. Missing PERSON coverage is unsupported.
        if person_ids.get(&self.source.account.user_id) != Some(&self.source.account.owner_id) {
            return Err(crate::cause!(Failure::Source));
        }
        self.source
            .index_file
            .check()
            .map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        self.assert_owned().map_err(|error| Failure::Source(error.cause()))?;
        check(cancel, Some(deadline))?;
        let metadata = CatalogMetadata {
            workshop_identity: identity,
            settings,
            person_ids,
            publisher,
            installed: None,
        };
        metadata.assert_current()?;
        Ok(metadata)
    }

    /// The catalog metadata of an account whose receipt names no WORKSHOP_IDENTITY: its installed Workshop rows. A
    /// receipt that names a publisher (a public setting or a credential reference) belongs to a carried account and
    /// still needs its restored identity, so it is refused here, never read without its publisher.
    fn installed_catalog_metadata(
        &self,
        environment: &BTreeMap<String, String>,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<CatalogMetadata, Failure> {
        self.source
            .receipt_file
            .check()
            .map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        let receipt_bytes =
            bounded_file(&self.source.receipt_file.path, MAX_JSON).map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        let receipt: Value = serde_json::from_slice(&receipt_bytes).map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        if !environment.is_empty()
            || receipt.get("bindingCredentials").is_some_and(|value| !value.is_null())
        {
            return Err(crate::cause!(Failure::Source));
        }
        check(cancel, Some(deadline))?;
        let installed = Installed::read(self.state_root().to_owned())?;
        self.assert_owned().map_err(|error| Failure::Source(error.cause()))?;
        check(cancel, Some(deadline))?;
        Ok(CatalogMetadata {
            workshop_identity: blake3::hash(&installed.bytes).to_hex().to_string(),
            settings: BTreeMap::new(),
            person_ids: BTreeMap::new(),
            publisher: None,
            installed: Some(installed),
        })
    }


    pub(crate) fn catalog_raw_read_observed(
        &mut self,
        metadata: &CatalogMetadata,
        key: &str,
        budget: ReadBudget,
        cancel: &AtomicBool,
        witness: Option<&CatalogDeliveryWitness>,
    ) -> Result<Option<Vec<u8>>, Failure> {
        check(cancel, Some(budget.deadline))?;
        if budget.bytes == 0 {
            return Err(crate::cause!(Failure::Bounds));
        }
        self.assert_owned().map_err(|error| Failure::Source(error.cause()))?;
        let identity = metadata.workshop_identity.as_str();
        let restored = self
            .source
            .public_environment
            .as_ref()
            .and_then(|env| env.get("WORKSHOP_IDENTITY"))
            .map(String::as_str);
        let named = match &metadata.installed {
            None => restored == Some(identity),
            Some(_) => restored.is_none(),
        };
        if !named || !catalog_key(identity, key) {
            return Err(crate::cause!(Failure::Source));
        }
        // The installed rows are the catalog's one shipped part; they never come from the KV.
        if let Some(installed) = &metadata.installed {
            if let Some(suffix) = key.strip_prefix(&format!("workshop:rows:{identity}:")) {
                let part = match suffix {
                    "parts" => Some(b"1".to_vec()),
                    "0" => Some(installed.bytes.as_ref().clone()),
                    _ => None,
                };
                if part.as_ref().is_some_and(|part| part.len() > budget.bytes) {
                    return Err(crate::cause!(Failure::Bounds));
                }
                return Ok(part);
            }
        }
        let now = self.source.clock().map_err(|error| Failure::Source(error.cause()))?;
        let bytes = if let Some(witness) = witness {
            let (bytes, observed) = self
                .source
                .read_kv_bytes_bounded_observed(key, now, budget.bytes)
                .map_err(|error| crate::carry_cause!(Failure::Source, error))?;
            witness.remember(observed).map_err(|error| crate::carry_cause!(Failure::Source, error))?;
            bytes
        } else {
            self.source
                .read_kv_bytes_bounded(key, now, budget.bytes)
                .map_err(|error| crate::carry_cause!(Failure::Source, error))?
        };
        check(cancel, Some(budget.deadline))?;
        self.assert_owned().map_err(|error| Failure::Source(error.cause()))?;
        match bytes {
            None => Ok(None),
            Some(bytes) => {
                if bytes.len() > budget.bytes {
                    return Err(crate::cause!(Failure::Bounds));
                }
                Ok(Some(bytes.to_vec()))
            }
        }
    }
}

fn catalog_key(identity: &str, key: &str) -> bool {
    if !hex(identity, 64) || key.len() > 2048 {
        return false;
    }
    let prefix = format!("workshop:rows:{identity}:");
    if let Some(suffix) = key.strip_prefix(&prefix) {
        return suffix == "parts"
            || (!suffix.is_empty()
                && suffix.len() <= 5
                && suffix.bytes().all(|v| v.is_ascii_digit())
                && (suffix == "0" || !suffix.starts_with('0'))
                && suffix.parse::<usize>().is_ok_and(|n| n < 65_536));
    }
    let Some(encoded) = key.strip_prefix("workshop-projection:") else {
        return false;
    };
    let Ok(value) =
        crate::ecma_json::parse(encoded.as_bytes(), crate::ecma_json::Limits::default())
    else {
        return false;
    };
    use crate::ecma_json::Value as E;
    let E::Array(parts) = value else {
        return false;
    };
    let is =
        |value: &E, expected: &str| matches!(value, E::String(v) if v == &JsString::from(expected));
    match parts.as_slice() {
        [kind, E::String(hash)] if is(kind, "published-identity") => {
            hash.to_rust_string().is_ok_and(|s| hex(&s, 64))
        }
        [kind, shelf] => is(kind, "shelf") && is(shelf, "tool"),
        [kind, shelf, E::String(version), E::Number(page)] => {
            is(kind, "page")
                && is(shelf, "tool")
                && !version.is_empty()
                && version.len() <= 512
                && page.is_finite()
                && page.fract() == 0.0
                && *page >= 0.0
                && *page < 16_384.0
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests;
