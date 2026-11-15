//! Protected host funding captures for finite resource holds.
//!
//! This owner verifies a distinct funding issuer's signed effect, binds it to
//! one account/physical home/origin and one immutable finite grant, and retains
//! the effect identity across key rotation, revoke and restart. It cannot turn
//! a customer balance, subscription or ordinary access signature into money.
//! Trust keys and the protected storage home are supplied by the trusted host,
//! never selected by an invoking tool. The issuer remains responsible for the
//! underlying captured payment or explicitly funded company guarantee.
//!
//! Captures and hold books MUST share one authoritative physical write home.
//! Their resource names differ; the common SQLite writer serializes signed
//! revocation with the budget owner's commit-time current-policy read.

use super::{CapturedGrant, Error, HostPolicy, Owner, Payer, Terms, View};
use crate::{
    records::{Error as RecordError, Mutation, Records},
    signed_authority::AuthorityClock,
    storage::{record_store::RecordStore, Storage},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use content_crypto::advanced::blake3;
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

/// Native storage placements are internal and share one physical writer.
pub const CAPTURES: &str = "@resource-budget/funding";
pub const HOLDS: &str = "@resource-budget/leases";

const MAX_PAYLOAD: usize = 8192;

/// Public issuer key installed by the host's independent trust owner. Neither
/// a receipt nor an account's editable records can introduce a trusted key.
#[derive(Clone)]
pub struct TrustedIssuer {
    pub issuer: String,
    pub key_id: String,
    pub public_key: [u8; 32],
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Capture {
    pub issuer: String,
    /// Independently captured payment, treasury guarantee allocation, or BYO
    /// attestation. One effect funds one grant; replay cannot mint another.
    pub effect: String,
    pub physical_home: String,
    pub terms: Terms,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Instruction {
    Capture {
        capture: Capture,
    },
    Revoke {
        issuer: String,
        effect: String,
        grant: String,
        physical_home: String,
        reason: String,
    },
    /// Independent issuer-attested terminal work, never a timer or an editable
    /// account claim. Exact retries retain the original evidence identity.
    Reconcile {
        issuer: String,
        effect: String,
        grant: String,
        physical_home: String,
        #[serde(rename = "lease")] hold: String,
        units: u64,
        evidence: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    key_id: String,
    payload: String,
    signature: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Kept {
    capture: Option<Capture>,
    grant: String,
    revoked: Option<String>,
    recovery: std::collections::BTreeMap<String, (u64, String)>,
}

/// Internal, protected host owner. `home_is_current` checks the real folder or
/// service-instance identity, outside copied state, on every access and check.
/// Constructor resource names are declared by the storage owner and inaccessible
/// through own-records. There is deliberately no customer-facing capture route.
pub struct Registry<S: Storage> {
    store: Mutex<RecordStore<S>>,
    account: String,
    resource: String,
    hold_resource: String,
    physical_home: String,
    home_is_current: Arc<dyn Fn() -> bool + Send + Sync>,
    keys: Vec<TrustedIssuer>,
    clock: Arc<dyn AuthorityClock>,
    signature_domain: Vec<u8>,
}

fn bounded(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}
fn id(issuer: &str, effect: &str) -> String {
    blake3::hash(&serde_json::to_vec(&(issuer, effect)).expect("strings encode"))
        .to_hex()
        .to_string()
}
fn record_error(error: RecordError) -> Error {
    match error {
        RecordError::Conflict(cause) => Error::Conflict(cause),
        RecordError::OutcomeUnknown(cause) => Error::Unknown(cause),
        error => Error::Unavailable(error.cause()),
    }
}

impl<S: Storage + Send + 'static> Registry<S> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: RecordStore<S>,
        account: String,
        resource: String,
        hold_resource: String,
        physical_home: String,
        home_is_current: Arc<dyn Fn() -> bool + Send + Sync>,
        keys: Vec<TrustedIssuer>,
        clock: Arc<dyn AuthorityClock>,
        signature_domain: Vec<u8>,
    ) -> Result<Arc<Self>, Error> {
        if [&account, &resource, &hold_resource, &physical_home]
            .iter()
            .any(|s| !bounded(s))
            || resource == "own-records"
            || hold_resource == "own-records"
            || resource == hold_resource
            || keys.is_empty()
            || keys.len() > 32
            || signature_domain.is_empty()
            || signature_domain.len() > 128
            || signature_domain.last() != Some(&0)
            || keys
                .iter()
                .any(|k| !bounded(&k.issuer) || !bounded(&k.key_id))
            || keys
                .iter()
                .enumerate()
                .any(|(i, k)| keys[..i].iter().any(|prior| prior.key_id == k.key_id))
        {
            return Err(crate::cause!(Error::Authority));
        }
        Ok(Arc::new(Self {
            store: Mutex::new(store),
            account,
            resource,
            hold_resource,
            physical_home,
            home_is_current,
            keys,
            clock,
            signature_domain,
        }))
    }
    fn checked(&self, proof: &str) -> Result<Instruction, Error> {
        if proof.len() > 16384 || !(self.home_is_current)() {
            return Err(crate::cause!(Error::Authority));
        }
        let envelope: Envelope = serde_json::from_str(proof).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let key = self
            .keys
            .iter()
            .find(|key| key.key_id == envelope.key_id)
            .ok_or(crate::cause!(Error::Authority))?;
        let payload = URL_SAFE_NO_PAD
            .decode(envelope.payload)
            .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let signature = URL_SAFE_NO_PAD
            .decode(envelope.signature)
            .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        if payload.len() > MAX_PAYLOAD || signature.len() != 64 {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut message = self.signature_domain.clone();
        message.extend_from_slice(&payload);
        UnparsedPublicKey::new(&ED25519, key.public_key)
            .verify(&message, &signature)
            .map_err(|error| crate::carry_cause!(Error::Authority, error))?;
        let instruction: Instruction =
            serde_json::from_slice(&payload).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let (issuer, effect, grant, home) = match &instruction {
            Instruction::Capture { capture } => (
                &capture.issuer,
                &capture.effect,
                &capture.terms.grant,
                &capture.physical_home,
            ),
            Instruction::Revoke {
                issuer,
                effect,
                grant,
                physical_home,
                ..
            }
            | Instruction::Reconcile {
                issuer,
                effect,
                grant,
                physical_home,
                ..
            } => (issuer, effect, grant, physical_home),
        };
        if issuer != &key.issuer
            || !bounded(effect)
            || !bounded(grant)
            || home != &self.physical_home
        {
            return Err(crate::cause!(Error::Authority));
        }
        if let Instruction::Capture { capture } = &instruction {
            let t = &capture.terms;
            if t.account != self.account
                || t.resource != self.hold_resource
                || t.limit == 0
                || !bounded(&t.basis)
                || !bounded(&t.unit)
                || t.expires_at_ms <= 0
                || self.clock.now_ms() < 0
                || matches!(&t.payer, Payer::Funded { funding_identity } if funding_identity != &id(&capture.issuer, &capture.effect))
            {
                return Err(crate::cause!(Error::Authority));
            }
        }
        Ok(instruction)
    }
    fn kept(&self, issuer: &str, effect: &str) -> Result<Option<Kept>, Error> {
        if !(self.home_is_current)() {
            return Err(crate::cause!(Error::Authority));
        }
        let store = self.store.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        store
            .get(&self.account, &self.resource, &id(issuer, effect))
            .map_err(record_error)?
            .record
            .map(|row| serde_json::from_value(row.value).map_err(|error| crate::carry_cause!(Error::Unavailable, error)))
            .transpose()
    }
    /// The captures of this account at this home that can admit now, of grant
    /// `unit`: captured, unrevoked, unexpired and bound to this exact home;
    /// the one expiring last first. Read from the protected captures alone:
    /// nothing a customer edits is consulted, and nothing here is written.
    pub fn current(&self, unit: &str) -> Result<Vec<(String, String)>, Error> {
        if !(self.home_is_current)() {
            return Err(crate::cause!(Error::Authority));
        }
        let now = self.clock.now_ms();
        let store = self.store.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let mut found = Vec::new();
        let mut after = String::new();
        loop {
            let page = store.list_page(&self.account, &self.resource, &after, 256).map_err(record_error)?;
            let full = page.items.len() == 256;
            for row in page.items {
                after = row.id.clone();
                let Ok(kept) = serde_json::from_value::<Kept>(row.value) else { continue };
                if let (Some(capture), None) = (kept.capture, kept.revoked) {
                    let terms = &capture.terms;
                    if terms.unit == unit && terms.account == self.account && capture.physical_home == self.physical_home
                        && terms.expires_at_ms > now {
                        found.push((terms.expires_at_ms, capture.issuer, capture.effect));
                    }
                }
            }
            if !full {
                break;
            }
        }
        found.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(found.into_iter().map(|(_, issuer, effect)| (issuer, effect)).collect())
    }
    /// Apply only a signature-verified instruction through the protected host
    /// writer. Captures cannot be rewritten, reactivated, or erased by this API.
    pub fn apply(&self, proof: &str) -> Result<(), Error> {
        let instruction = self.checked(proof)?;
        let (issuer, effect) = match &instruction {
            Instruction::Capture { capture } => (&capture.issuer, &capture.effect),
            Instruction::Revoke { issuer, effect, .. }
            | Instruction::Reconcile { issuer, effect, .. } => (issuer, effect),
        };
        let key = id(issuer, effect);
        let mut store = self.store.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        for _ in 0..32 {
            let row = store
                .get(&self.account, &self.resource, &key)
                .map_err(record_error)?
                .record;
            let version = row.as_ref().map_or(0, |row| row.version);
            let mut kept: Option<Kept> = row
                .map(|row| serde_json::from_value(row.value).map_err(|error| crate::carry_cause!(Error::Unavailable, error)))
                .transpose()?;
            match &instruction {
                Instruction::Capture { capture } => match &kept {
                    Some(prior) if prior.capture.as_ref() != Some(capture) => {
                        return Err(crate::cause!(Error::Conflict))
                    }
                    Some(_) => return Ok(()), // Never clears an existing revoke.
                    None => {
                        if capture.terms.expires_at_ms <= self.clock.now_ms() {
                            return Err(crate::cause!(Error::Authority));
                        }
                        kept = Some(Kept {
                            capture: Some(capture.clone()),
                            grant: capture.terms.grant.clone(),
                            revoked: None,
                            recovery: Default::default(),
                        });
                    }
                },
                Instruction::Revoke { grant, reason, .. } => {
                    if !bounded(reason) {
                        return Err(crate::cause!(Error::Invalid));
                    }
                    // An authenticated revoke can arrive before its capture.
                    // Retain its tombstone so delayed delivery cannot revive it.
                    let kept = kept.get_or_insert_with(|| Kept {
                        capture: None,
                        grant: grant.clone(),
                        revoked: None,
                        recovery: Default::default(),
                    });
                    if &kept.grant != grant {
                        return Err(crate::cause!(Error::Conflict));
                    }
                    if let Some(prior) = &kept.revoked {
                        return if prior == reason {
                            Ok(())
                        } else {
                            Err(crate::cause!(Error::Conflict))
                        };
                    }
                    kept.revoked = Some(reason.clone());
                }
                Instruction::Reconcile {
                    grant,
                    hold,
                    units,
                    evidence,
                    ..
                } => {
                    let kept = kept.as_mut().ok_or(crate::cause!(Error::Authority))?;
                    let capture = kept.capture.as_ref().ok_or(crate::cause!(Error::Authority))?;
                    if &kept.grant != grant
                        || !bounded(hold)
                        || !bounded(evidence)
                        || *units > capture.terms.limit
                    {
                        return Err(crate::cause!(Error::Invalid));
                    }
                    if let Some(prior) = kept.recovery.get(hold) {
                        return if prior == &(*units, evidence.clone()) {
                            Ok(())
                        } else {
                            Err(crate::cause!(Error::Conflict))
                        };
                    }
                    if kept.recovery.len() >= 1024 {
                        return Err(crate::cause!(Error::Exhausted));
                    }
                    kept.recovery
                        .insert(hold.clone(), (*units, evidence.clone()));
                }
            }
            let value =
                serde_json::to_value(kept.ok_or(crate::cause!(Error::Invalid))?).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
            let request_key =
                blake3::hash(&serde_json::to_vec(&(version, &value)).map_err(|error| crate::carry_cause!(Error::Invalid, error))?)
                    .to_hex()
                    .to_string();
            let result = store.mutate_local_with_check(
                &self.account,
                &self.resource,
                Mutation {
                    id: key.clone(),
                    expected_version: version,
                    request_key,
                    deleted: false,
                    value,
                },
                || {
                    if (self.home_is_current)() {
                        Ok(())
                    } else {
                        Err(crate::cause!(RecordError::Unavailable))
                    }
                },
            );
            match result {
                Ok(_) => return Ok(()),
                Err(RecordError::Conflict(_)) => continue,
                Err(error) => return Err(record_error(error)),
            }
        }
        Err(crate::cause!(Error::Conflict))
    }
    /// The callable native binding: read this exact signed capture and compose
    /// the existing budget Owner over the same authoritative physical home.
    /// The caller supplies a separate handle to that home, never a copied book.
    pub fn owner(
        self: &Arc<Self>,
        store: RecordStore<S>,
        issuer: &str,
        effect: &str,
        recovery: bool,
    ) -> Result<Owner<S>, Error> {
        let kept = self.kept(issuer, effect)?.ok_or(crate::cause!(Error::Authority))?;
        let capture = kept.capture.ok_or(crate::cause!(Error::Authority))?;
        let policy: Arc<dyn HostPolicy> = Arc::new(Policy {
            registry: self.clone(),
            issuer: issuer.into(),
            effect: effect.into(),
        });
        let grant = if recovery {
            CapturedGrant::restore(capture.terms, policy)?
        } else {
            CapturedGrant::capture(capture.terms, policy)?
        };
        Ok(Owner::new(store, grant))
    }
}

struct Policy<S: Storage> {
    registry: Arc<Registry<S>>,
    issuer: String,
    effect: String,
}
impl<S: Storage + Send + 'static> Policy<S> {
    fn matching(&self, terms: &Terms) -> Option<Kept> {
        let kept = self.registry.kept(&self.issuer, &self.effect).ok()??;
        kept.capture
            .as_ref()
            .is_some_and(|capture| {
                capture.terms == *terms && capture.physical_home == self.registry.physical_home
            })
            .then_some(kept)
    }
}
impl<S: Storage + Send + 'static> HostPolicy for Policy<S> {
    fn now_ms(&self) -> i64 {
        self.registry.clock.now_ms()
    }
    fn capture(&self, terms: &Terms) -> bool {
        self.matching(terms).is_some()
    }
    fn current(&self, terms: &Terms) -> bool {
        self.matching(terms)
            .is_some_and(|kept| kept.revoked.is_none())
    }
    fn recovery_current(&self, terms: &Terms) -> bool {
        self.matching(terms).is_some()
    }
    fn reconcile(&self, terms: &Terms, hold: &str, _: &View, units: u64, evidence: &str) -> bool {
        self.matching(terms).is_some_and(|kept| {
            kept.recovery
                .get(hold)
                .is_some_and(|prior| prior.0 == units && prior.1 == evidence)
        })
    }
}

/// The value a genuine funding issuer puts in Terms::payer. It is public,
/// contains no funds itself, and is accepted only beside its verified capture.
pub fn funding_identity(issuer: &str, effect: &str) -> String {
    id(issuer, effect)
}

/// Native host binding. Only this owner selects/open its protected home; the
/// calling tool cannot hand it another budget database or copied account book.
pub struct Native {
    root: std::path::PathBuf,
    physical_home: String,
    registry: Arc<Registry<crate::storage::sqlite::Supply<crate::storage::sqlite::Handle>>>,
}
impl Native {
    pub fn open(
        root: &std::path::Path,
        account: &str,
        keys: Vec<TrustedIssuer>,
        clock: Arc<dyn AuthorityClock>,
        signature_domain: Vec<u8>,
    ) -> Result<Self, Error> {
        use crate::{
            account_files::account_routes::folder_identity, sqlite_work::WorkMeter, storage::record_store_resources,
        };
        let root = root.canonicalize().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let physical_home = folder_identity(&root).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let (capture_path, store) =
            record_store_resources::open_state_resource(CAPTURES, &root, WorkMeter::new())
                .map_err(record_error)?;
        let hold_path = record_store_resources::placement(HOLDS)
            .and_then(|p| p.in_state_for(HOLDS, &root))
            .ok_or(crate::cause!(Error::Unavailable))?;
        if capture_path != hold_path {
            return Err(crate::cause!(Error::Authority));
        }
        let home_root = root.clone();
        let home_id = physical_home.clone();
        let current =
            Arc::new(move || folder_identity(&home_root).ok().as_deref() == Some(&home_id));
        let registry = Registry::new(
            store,
            account.into(),
            CAPTURES.into(),
            HOLDS.into(),
            physical_home.clone(),
            current,
            keys,
            clock,
            signature_domain,
        )?;
        Ok(Self {
            root,
            physical_home,
            registry,
        })
    }
    pub fn physical_home(&self) -> &str {
        &self.physical_home
    }
    pub fn apply(&self, signed_instruction: &str) -> Result<(), Error> {
        self.registry.apply(signed_instruction)
    }
    /// The captures that can admit `unit` now, the one expiring last first (`Registry::current`).
    pub fn current(&self, unit: &str) -> Result<Vec<(String, String)>, Error> {
        self.registry.current(unit)
    }
    pub fn owner(
        &self,
        issuer: &str,
        effect: &str,
        recovery: bool,
    ) -> Result<Owner<crate::storage::sqlite::Supply<crate::storage::sqlite::Handle>>, Error> {
        let (_, store) = crate::storage::record_store_resources::open_state_resource(
            HOLDS,
            &self.root,
            crate::sqlite_work::WorkMeter::new(),
        )
        .map_err(record_error)?;
        self.registry.owner(store, issuer, effect, recovery)
    }
    /// The account files byte allowance's chunk supply for personal/OAuth/native
    /// ingress. This requires a real signed capture reference, not caller-supplied terms.
    pub fn chunks(
        &self,
        issuer: &str,
        effect: &str,
    ) -> Result<super::account_files::Chunks<crate::storage::sqlite::Supply<crate::storage::sqlite::Handle>>, Error> {
        super::account_files::Chunks::new(self.owner(issuer, effect, false)?)
    }
}
