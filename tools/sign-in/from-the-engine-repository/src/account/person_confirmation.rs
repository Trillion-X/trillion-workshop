// src/account/person_confirmation.rs
//
// Purpose: a write that needs the person present. A declaring record (a list) may mark one of its fields with
// `record_write_model::PERSON_PRESENT_MARK`, naming values that a write may set only with a fresh confirmation by the
// person: a WebAuthn assertion, by one of the account's own passkeys, whose challenge binds that exact write. This
// module says which confirmations a write needs (`required`), issues the one-use challenge a confirmation signs
// (`Challenges::issue`) and checks a confirmation against it (`Challenges::confirm`). The one records-write authority
// (`local_account::native_command_context::NativeTransaction::write_records`) asks it for every records:write, with
// any key, on any account route; nothing else may skip it.
//
// Non-Negotiable Invariants:
// - The engine names no list, row kind, field or value. The mark and its values are DATA in the declaring record;
//   this module reads them only through the live record model (`record_write_model::Model`).
// - A row's write needs a confirmation for each marked value it newly sets (a value its field did not already hold).
//   Writing another value, leaving the field as it is, removing the row or writing an unmarked field needs nothing.
// - The mark protects itself: a write of a declaring record that removes any (row kind, field, value) it marked (the
//   value narrowed out of the mark, the mark removed, the field's id or the declared row kind changed, the record
//   removed) needs a confirmation for each one. Adding to a mark needs nothing.
// - Rows read their marks from EVERY current declaration of their kind, before and after the batch, so a second
//   declaring record without the mark cannot shadow the first.
// - A challenge is BLAKE3 (the engine's declared owner, `content_crypto`) over the account, record id, field, value
//   and a random one-use nonce. The confirming write rebuilds it from itself, never from the caller's words, and the
//   nonce is kept by this process with its account, record, field, value and an expiry of at most
//   CHALLENGE_LIFETIME_MS. A nonce is consumed by the one confirmation it admits; an expired one is forgotten.
// - The assertion is verified only by `passkey_verification::verify_assertion` (no second verifier), against the
//   account's own stored passkeys (`Passkeys`), with the user-present and user-verified flags required and the passkey's
//   counter advanced.
// - With no passkey source for the account, nothing confirms: a write that needs the person present is refused.
//
// Key Concepts:
// - Requirement: (record id, field, value), the one confirmation a write needs and the one a challenge binds.
// - Proof: what a request carries beside its request_key, in its `REQUEST_FIELD`: {nonce, assertion}, where assertion
//   is the browser's PublicKeyCredential JSON (id, response.{authenticatorData, clientDataJSON, signature}).
// - One confirmation per write: a write that needs two or more is refused naming the first and how many it needs, so a
//   client splits it; no nonce is consumed by such a write.
//
// Security Considerations:
// - Pending challenges live in memory only: a restart forgets them, which only refuses (fails closed).
// - A nonce that does not match the account or the write is left as it is (it is not the caller's to consume).
// - Record ids, fields and values are the person's own words: Debug is redacted and nothing here logs them.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::passkey_verification::{verify_assertion, AssertionPolicy};
use crate::ecma_json::{JsString, Value as JsValue};
use crate::record_write_model::Model;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    fmt,
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

/// The field of a request, beside its request_key, that carries a confirmation by the person present.
pub const REQUEST_FIELD: &str = "person_present";
/// The refusal code of a write that needs the person present.
pub const REFUSAL_CODE: &str = "needs_person_present";
/// The longest a challenge may wait for its confirmation.
pub const CHALLENGE_LIFETIME_MS: u64 = 5 * 60 * 1000;
/// The most challenges this process keeps waiting at once (each lives at most CHALLENGE_LIFETIME_MS).
const MOST_PENDING: usize = 4096;
/// Random bytes in one nonce.
const NONCE_BYTES: usize = 32;
/// Separates this challenge's BLAKE3 input from every other identity the engine hashes.
const CHALLENGE_CONTEXT: &str = "trillion person-present record write v1";
/// The largest confirmation a request may carry, and the verifier's per-component bound.
pub const MAX_PROOF_BYTES: usize = 65_536;
/// The longest record id, field or value a challenge binds.
const MAX_TEXT_BYTES: usize = 4096;

/// One confirmation a write needs: setting `value` in `field` of the record `record` (for a declaring record, the
/// mark on its field `field` that kept `value`).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Requirement {
    pub record: String,
    pub field: String,
    pub value: String,
}
impl fmt::Debug for Requirement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PersonPresentRequirement([redacted])")
    }
}
impl Requirement {
    fn bounded(&self) -> bool {
        [&self.record, &self.field, &self.value].iter().all(|text| !text.is_empty() && text.len() <= MAX_TEXT_BYTES)
    }
}

/// Why a confirmation did not admit a write. None of these names the person's words.
#[derive(Clone, Debug)]
pub enum Refused {
    /// The request carried no confirmation, or one of the wrong shape.
    Missing(crate::refusal_cause::Cause),
    /// No challenge is waiting under this nonce (never issued, already used, or forgotten).
    Unknown(crate::refusal_cause::Cause),
    /// The challenge's lifetime ended; it is forgotten.
    Expired(crate::refusal_cause::Cause),
    /// The challenge was issued for another account, record, field or value.
    Mismatch(crate::refusal_cause::Cause),
    /// The assertion is not a current, verified signature of this challenge by one of the account's passkeys.
    Unverified(crate::refusal_cause::Cause),
    /// Too many challenges are waiting; ask again later.
    Busy(crate::refusal_cause::Cause),
    /// The account has no passkey source in this process.
    NoPasskeys(crate::refusal_cause::Cause),
}
impl Refused {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Missing(cause) => cause.clone(),
            Self::Unknown(cause) => cause.clone(),
            Self::Expired(cause) => cause.clone(),
            Self::Mismatch(cause) => cause.clone(),
            Self::Unverified(cause) => cause.clone(),
            Self::Busy(cause) => cause.clone(),
            Self::NoPasskeys(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Refused);

impl PartialEq for Refused {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Missing(_), Self::Missing(_)) => true,
            (Self::Unknown(_), Self::Unknown(_)) => true,
            (Self::Expired(_), Self::Expired(_)) => true,
            (Self::Mismatch(_), Self::Mismatch(_)) => true,
            (Self::Unverified(_), Self::Unverified(_)) => true,
            (Self::Busy(_), Self::Busy(_)) => true,
            (Self::NoPasskeys(_), Self::NoPasskeys(_)) => true,
            _ => false,
        }
    }
}
impl Eq for Refused {}


/// The values of a field, as text: one text, or the texts of an array (other values set nothing markable).
fn texts(value: Option<&JsValue>) -> BTreeSet<JsString> {
    match value {
        Some(JsValue::String(text)) => BTreeSet::from([text.clone()]),
        Some(JsValue::Array(items)) => {
            items.iter().filter_map(|item| match item { JsValue::String(text) => Some(text.clone()), _ => None }).collect()
        }
        _ => BTreeSet::new(),
    }
}
fn member<'a>(value: &'a JsValue, name: &JsString) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(name),
        _ => None,
    }
}
fn rust(text: &JsString) -> Result<String, crate::refusal_cause::CodedError<()>> {
    text.to_rust_string().map_err(|_| crate::refusal_cause::CodedError::new(()))
}

/// The confirmations one write needs, in order and without repeats. `declared` is the model of the declarations
/// current before the batch; `effective` the model after the batch's effective writes. `old` is the record this write
/// replaces at its point of the batch (its kind and value), none for a new record. `value` none removes the record.
/// Err when a name the write involves is not text (a lone surrogate); the caller refuses the write.
pub fn required(declared: &Model, effective: &Model, id: &JsString, kind: &JsString, value: Option<&JsValue>,
    old: Option<(&JsString, &JsValue)>) -> Result<Vec<Requirement>, crate::refusal_cause::CodedError<()>> {
    let record = rust(id)?;
    let mut needed = BTreeSet::new();
    // The mark protects itself: every (row kind, field, value) the record marked before and does not mark now.
    let before = old.map(|(kind, value)| declared.marks_declared(kind, value)).unwrap_or_default();
    if !before.is_empty() {
        let after = value.map(|value| declared.marks_declared(kind, value)).unwrap_or_default();
        for (_, field, marked) in before.difference(&after) {
            needed.insert(Requirement { record: record.clone(), field: rust(field)?, value: rust(marked)? });
        }
    }
    // A row: each marked value it newly sets.
    if let Some(value) = value {
        let mut marks = declared.person_present_marks(kind);
        for (field, values) in effective.person_present_marks(kind) {
            marks.entry(field).or_default().extend(values);
        }
        let held = old.filter(|(old_kind, _)| *old_kind == kind).map(|(_, value)| value);
        for (field, values) in marks {
            let now = texts(member(value, &field));
            let was = held.map(|held| texts(member(held, &field))).unwrap_or_default();
            for set in now.difference(&was).filter(|set| values.contains(*set)) {
                needed.insert(Requirement { record: record.clone(), field: rust(&field)?, value: rust(set)? });
            }
        }
    }
    Ok(needed.into_iter().collect())
}

/// The challenge a confirmation of `requirement` by `account` signs under `nonce`: base64url (no padding) of the
/// BLAKE3 hash of the context, the account, the record id, the field, the value and the nonce, as one JSON array.
pub fn challenge_of(account: &str, requirement: &Requirement, nonce: &str) -> String {
    let bound = serde_json::to_vec(&[CHALLENGE_CONTEXT, account, &requirement.record, &requirement.field,
        &requirement.value, nonce]).unwrap_or_default();
    URL_SAFE_NO_PAD.encode(content_crypto::hash(&bound))
}

fn challenge_in_domain(account: &str, domain: Option<&crate::storage::record_store_resources::domains::Identity>,
    requirement: &Requirement, nonce: &str) -> String {
    let original = challenge_of(account, requirement, nonce);
    match domain {
        None => original,
        Some(domain) => {
            let bound = serde_json::to_vec(&(CHALLENGE_CONTEXT, domain, original)).unwrap_or_default();
            URL_SAFE_NO_PAD.encode(content_crypto::hash(&bound))
        }
    }
}

/// One stored passkey of an account: the credential as `verify_assertion` reads it ({id, publicKey, algorithm}) and
/// the last counter it signed.
#[derive(Clone)]
pub struct StoredPasskey {
    pub credential: Value,
    pub counter: u32,
}
impl fmt::Debug for StoredPasskey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StoredPasskey([redacted])")
    }
}

/// The account's own stored passkeys and the page they sign for. The account's sign-in owner supplies it
/// (`register_passkeys`); this module never stores a credential and never accepts one from a request.
pub trait Passkeys: Send + Sync {
    /// The origin the person's browser signs from (clientDataJSON.origin).
    fn origin(&self) -> String;
    /// The relying party id the passkeys were made for.
    fn relying_party(&self) -> String;
    /// The account's current passkeys.
    fn credentials(&self, account: &str) -> Vec<StoredPasskey>;
    /// Keep `counter` as the passkey's last signed counter; false refuses the confirmation.
    fn advance(&self, account: &str, credential_id: &str, counter: u32) -> bool;
}

fn registry() -> &'static Mutex<HashMap<String, Arc<dyn Passkeys>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<dyn Passkeys>>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// While held, `account`'s passkeys come from the registered source; dropping it removes the source.
pub struct Registration {
    account: String,
    source: Arc<dyn Passkeys>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut sources) = registry().lock() {
            if sources.get(&self.account).is_some_and(|held| Arc::ptr_eq(held, &self.source)) {
                sources.remove(&self.account);
            }
        }
    }
}
impl fmt::Debug for Registration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PasskeysRegistration([redacted])")
    }
}

/// Register `account`'s passkey source for this process (replacing any other).
pub fn register_passkeys(account: &str, source: Arc<dyn Passkeys>) -> Registration {
    if let Ok(mut sources) = registry().lock() {
        sources.insert(account.to_owned(), source.clone());
    }
    Registration { account: account.to_owned(), source }
}

fn passkeys_of(account: &str) -> Option<Arc<dyn Passkeys>> {
    registry().lock().ok()?.get(account).cloned()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|at| at.as_millis() as u64).unwrap_or(0)
}

/// One issued challenge, answered to the caller that asked for it.
#[derive(Clone, PartialEq, Eq)]
pub struct Issued {
    pub nonce: String,
    pub challenge: String,
    pub expires_at_ms: u64,
}
impl fmt::Debug for Issued {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("IssuedChallenge([redacted])")
    }
}

struct Pending {
    account: String,
    domain: Option<crate::storage::record_store_resources::domains::Identity>,
    requirement: Requirement,
    expires_at_ms: u64,
}

/// The challenges this process has issued and not yet seen confirmed or expire.
#[derive(Default)]
pub struct Challenges {
    pending: Mutex<HashMap<String, Pending>>,
}
impl Challenges {
    /// This process's one store of waiting challenges.
    pub fn shipped() -> &'static Challenges {
        static SHIPPED: OnceLock<Challenges> = OnceLock::new();
        SHIPPED.get_or_init(Challenges::default)
    }

    /// A new one-use challenge for `account` to confirm `requirement`, waiting until `now_ms` + CHALLENGE_LIFETIME_MS.
    pub fn issue(&self, account: &str, requirement: &Requirement, now_ms: u64) -> Result<Issued, Refused> {
        self.issue_in_domain(account, None, requirement, now_ms)
    }

    fn issue_in_domain(&self, account: &str, domain: Option<&crate::storage::record_store_resources::domains::Identity>,
        requirement: &Requirement, now_ms: u64) -> Result<Issued, Refused> {
        if account.is_empty() || account.len() > MAX_TEXT_BYTES || !requirement.bounded() {
            return Err(crate::cause!(Refused::Missing));
        }
        let mut bytes = [0u8; NONCE_BYTES];
        SystemRandom::new().fill(&mut bytes).map_err(|error| crate::carry_cause!(Refused::Busy, error))?;
        let nonce = URL_SAFE_NO_PAD.encode(bytes);
        let expires_at_ms = now_ms.saturating_add(CHALLENGE_LIFETIME_MS);
        let mut pending = self.pending.lock().map_err(|error| crate::carry_cause!(Refused::Busy, error))?;
        pending.retain(|_, waiting| waiting.expires_at_ms > now_ms);
        if pending.len() >= MOST_PENDING {
            return Err(crate::cause!(Refused::Busy));
        }
        let challenge = challenge_in_domain(account, domain, requirement, &nonce);
        pending.insert(nonce.clone(), Pending { account: account.to_owned(), domain: domain.cloned(), requirement: requirement.clone(), expires_at_ms });
        Ok(Issued { nonce, challenge, expires_at_ms })
    }

    /// Whether `proof` ({nonce, assertion}) confirms `requirement` for `account` at `now_ms`: its nonce waits for exactly
    /// this account and requirement and has not expired, and the assertion is a verified, user-verified signature of
    /// the challenge rebuilt from them, by one of the account's `passkeys`, whose counter advances. The nonce is
    /// consumed when, and only when, it confirms; an expired nonce is forgotten.
    pub fn confirm(&self, account: &str, requirement: &Requirement, proof: &Value, now_ms: u64, passkeys: &dyn Passkeys)
        -> Result<(), Refused> {
        self.confirm_in_domain(account, None, requirement, proof, now_ms, passkeys)
    }

    fn confirm_in_domain(&self, account: &str, domain: Option<&crate::storage::record_store_resources::domains::Identity>,
        requirement: &Requirement, proof: &Value, now_ms: u64, passkeys: &dyn Passkeys) -> Result<(), Refused> {
        let fields = proof.as_object().ok_or(crate::cause!(Refused::Missing))?;
        if fields.len() != 2 || serde_json::to_vec(proof).map_or(true, |bytes| bytes.len() > MAX_PROOF_BYTES) {
            return Err(crate::cause!(Refused::Missing));
        }
        let nonce = fields.get("nonce").and_then(Value::as_str).ok_or(crate::cause!(Refused::Missing))?;
        let assertion = fields.get("assertion").filter(|value| value.is_object()).ok_or(crate::cause!(Refused::Missing))?;
        let mut pending = self.pending.lock().map_err(|error| crate::carry_cause!(Refused::Busy, error))?;
        let waiting = pending.get(nonce).ok_or(crate::cause!(Refused::Unknown))?;
        if waiting.expires_at_ms <= now_ms {
            pending.remove(nonce);
            return Err(crate::cause!(Refused::Expired));
        }
        if waiting.account != account || waiting.domain.as_ref() != domain || waiting.requirement != *requirement {
            return Err(crate::cause!(Refused::Mismatch));
        }
        // Rebuilt from the write and the account, never taken from the caller.
        let challenge = challenge_in_domain(account, domain, requirement, nonce);
        let id = assertion.get("id").and_then(Value::as_str).ok_or(crate::cause!(Refused::Unverified))?;
        let stored = passkeys.credentials(account).into_iter()
            .find(|stored| stored.credential.get("id").and_then(Value::as_str) == Some(id))
            .ok_or(crate::cause!(Refused::Unverified))?;
        let (origin, relying_party) = (passkeys.origin(), passkeys.relying_party());
        let policy = AssertionPolicy {
            challenge: &challenge,
            origin: &origin,
            relying_party: &relying_party,
            user_verified: true,
            previous_counter: stored.counter,
            maximum_component_bytes: MAX_PROOF_BYTES,
            client_json_limits: Default::default(),
        };
        let verified = verify_assertion(assertion, &stored.credential, &policy).map_err(|error| Refused::Unverified(error.cause()))?;
        if !passkeys.advance(account, id, verified.counter) {
            return Err(crate::cause!(Refused::Unverified));
        }
        pending.remove(nonce);
        Ok(())
    }
}

/// The records-write authority's question: does the request's `proof` confirm `requirement` for `account` now, by the
/// account's registered passkeys? Consumes the nonce when it does.
pub(crate) fn confirm_write(account: &str, requirement: &Requirement, proof: Option<&Value>) -> Result<(), Refused> {
    confirm_write_in_domain(account, None, requirement, proof)
}

pub(crate) fn confirm_write_in_domain(account: &str, domain: Option<&crate::storage::record_store_resources::domains::Identity>,
    requirement: &Requirement, proof: Option<&Value>) -> Result<(), Refused> {
    let proof = proof.ok_or(crate::cause!(Refused::Missing))?;
    let passkeys = passkeys_of(account).ok_or(crate::cause!(Refused::NoPasskeys))?;
    Challenges::shipped().confirm_in_domain(account, domain, requirement, proof, now_ms(), passkeys.as_ref())
}

/// The account routes' challenge operation: `input` {id, field, value} for `account`, answered {nonce, challenge,
/// expires_at_ms}. The caller hands `challenge` (base64url bytes) to the person's passkey prompt and retries its write
/// with {nonce, assertion} in `REQUEST_FIELD`.
pub fn issue_for_input(account: &str, input: &Value) -> Result<Value, Refused> {
    let fields = input.as_object().ok_or(crate::cause!(Refused::Missing))?;
    let domain = crate::storage::record_store_resources::domains::Selection::from_input(input)
        .map_err(|error| crate::carry_cause!(Refused::Missing, error))?.map(|selection| selection.identity());
    if fields.len() != 3 + usize::from(domain.is_some()) {
        return Err(crate::cause!(Refused::Missing));
    }
    let text = |name: &str| fields.get(name).and_then(Value::as_str).map(str::to_owned).ok_or(crate::cause!(Refused::Missing));
    let requirement = Requirement { record: text("id")?, field: text("field")?, value: text("value")? };
    let issued = Challenges::shipped().issue_in_domain(account, domain.as_ref(), &requirement, now_ms())?;
    Ok(serde_json::json!({"nonce": issued.nonce, "challenge": issued.challenge, "expires_at_ms": issued.expires_at_ms}))
}

/// A page's request for the person's confirmation of `requirement`: a new one-use challenge (`Challenges::issue`) and what
/// the browser's passkey step needs to sign it, answered {nonce, challenge, expires_at_ms, rp_id, credential_ids} (the
/// credential ids as the account stores them, base64url). The page then sends {nonce, assertion} in `REQUEST_FIELD`
/// with the change it confirms. An account with no passkey source or no passkey is `NoPasskeys`.
pub fn assertion_request(account: &str, requirement: &Requirement) -> Result<Value, Refused> {
    let passkeys = passkeys_of(account).ok_or(crate::cause!(Refused::NoPasskeys))?;
    let ids: Vec<String> = passkeys.credentials(account).iter()
        .filter_map(|stored| stored.credential.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
    if ids.is_empty() {
        return Err(crate::cause!(Refused::NoPasskeys));
    }
    let issued = Challenges::shipped().issue(account, requirement, now_ms())?;
    Ok(serde_json::json!({"nonce": issued.nonce, "challenge": issued.challenge, "expires_at_ms": issued.expires_at_ms,
        "rp_id": passkeys.relying_party(), "credential_ids": ids}))
}

#[cfg(test)]
pub(crate) mod tests;
