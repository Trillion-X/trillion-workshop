// Purpose: Apply admitted rights changes in the existing canonical policy owner.
// Invariants: no path opener, schema creation, new authority database or
// takeover of a source. The actual owner supplies its already writable policy_directory;
// an original policy update must have drained its gates before mutation.
// Key concepts: AccountControl.#changeOwnRights, born-account rights changes,
// same-update retry evidence and retained publication/quota pauses.
// Security: a restored snapshot is not ownership or management permission.
// Original commitment reconciliation and pause publication stay with their
// owners. This module never declares a disconnected/uncertain commit aborted.

use crate::account::AccountIdentity;
use content_crypto::advanced::blake3;
use chrono::{DateTime, SecondsFormat, Utc};
use crate::storage::{Intent, Read, Scope, Storage, Value as Stored, When};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;

mod catch_up;
mod update;
pub mod resource_connection;
pub mod run_capability;
pub mod run_rules;
pub mod share_given;
pub mod share_grant;
pub mod run_cause;
pub use catch_up::{catch_up_gate, GatePolicy};
pub use update::{
    begin_update, register_gate, resume_update, AckPhase, Acknowledgement, Gate,
    GateRegistrationOwner, HostStatus, PolicyHost, Registration, UpdateStep,
};

const MAX_JSON: usize = 4 * 1024 * 1024;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
// Original born-account.mjs ENDED_SIGN_IN_KEPT_MS; not a token or a permit.
const ENDED_SIGN_IN_MS: u64 = 24 * 60 * 60 * 1000;
const RECEIPT_VERSION: &str = "trillion.account-policy-change/v1";

#[derive(Clone, Debug)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Unavailable(crate::refusal_cause::Cause),
    SourceChanged(crate::refusal_cause::Cause),
    NotCanonical(crate::refusal_cause::Cause),
    NotDrained(crate::refusal_cause::Cause),
    NotAuthorized(crate::refusal_cause::Cause),
    UpdateChanged(crate::refusal_cause::Cause),
    DifferentChange(crate::refusal_cause::Cause),
}
impl Error { pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { match self {
Self::Invalid(cause)=>cause,
Self::Unavailable(cause)=>cause,
Self::SourceChanged(cause)=>cause,
Self::NotCanonical(cause)=>cause,
Self::NotDrained(cause)=>cause,
Self::NotAuthorized(cause)=>cause,
Self::UpdateChanged(cause)=>cause,
Self::DifferentChange(cause)=>cause,
} } }
crate::impl_caused!(Error);
impl PartialEq for Error {fn eq(&self, other:&Self)->bool {std::mem::discriminant(self)==std::mem::discriminant(other)}}
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid(_) => "account rights input refused",
            Self::Unavailable(_) => "account rights source unavailable",
            Self::SourceChanged(_) => "account rights source changed",
            Self::NotCanonical(_) => "canonical account rights owner unavailable",
            Self::NotDrained(_) => "account rights update has not drained",
            Self::NotAuthorized(_) => "account rights change not admitted",
            Self::UpdateChanged(_) => "account rights update changed",
            Self::DifferentChange(_) => "account rights update names another change",
        })
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;
#[track_caller]
fn unavailable<T: crate::refusal_cause::Caused>(error: T) -> Error {
    crate::carry_cause!(caller: Error::Unavailable, error)
}
fn bounded(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}

/// The existing rights command supplies its original accepted time. A retry
/// reuses the same change, not a new wall clock that extends a revoked key.
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Change {
    EndSignIn {
        sign_in: String,
        at_ms: u64,
    },
    Disconnect {
        at_ms: u64,
    },
    /// The canonical owner captures this under its original update, then binds
    /// it to the retained management input. It is not a client-supplied right.
    EndBrowserSessions {
        expected_generation: u64,
    },
}
impl fmt::Debug for Change {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AccountRightsChange([redacted])")
    }
}
impl Change {
    /// Bind the original accepted management input to its retained update.
    /// This content identity grants no ownership or management permission.
    pub fn identity(&self) -> Result<String> {
        match self {
            Self::EndSignIn { sign_in, at_ms } => {
                if !bounded(sign_in, 300)
                    || *at_ms == 0
                    || at_ms
                        .checked_add(ENDED_SIGN_IN_MS)
                        .is_none_or(|v| v > MAX_SAFE)
                {
                    return Err(crate::cause!(Error::Invalid));
                }
            }
            Self::Disconnect { at_ms } => {
                iso(*at_ms)?;
            }
            Self::EndBrowserSessions {
                expected_generation,
            } => {
                if *expected_generation >= MAX_SAFE {
                    return Err(crate::cause!(Error::Invalid));
                }
            }
        }
        let bytes = serde_json::to_vec(self).map_err(unavailable)?;
        let mut hash = blake3::Hasher::new();
        hash.update(b"trillion.account-policy-change/v1\0");
        hash.update(&bytes);
        Ok(hash.finalize().to_hex().to_string())
    }
}

/// Mandatory supply from the SAME mutable account owner it took over. This is not
/// implemented by immutable CatalogSource/SelectedKvSource or an arbitrary
/// snapshot. Ownership includes source state lock, original account mapping and the
/// actual writable handle; management admission binds this exact update/input.
/// assert_current must attest the supplied physical handle to the retained
/// canonical resource, not merely accept equal account labels or a stable copy.
/// It must recognize its own retained update while that update pauses new work.
pub trait CanonicalPolicyOwner {
    fn assert_current(&mut self, account: &AccountIdentity, policy: &dyn Storage) -> Result<()>;
    fn assert_management_admission(
        &mut self,
        account: &AccountIdentity,
        update: &str,
        change_identity: &str,
    ) -> Result<()>;
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub version: String,
    pub change_identity: String,
    /// Original result: {ended: sign_in}, disconnected ISO timestamp, or next
    /// browser generation. Never a credential or a newly issued grant.
    pub result: Value,
}
impl fmt::Debug for Receipt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AccountRightsReceipt([redacted])")
    }
}

/// The policy store must still be the writable handle its owner opened.
fn physical(store: &dyn Storage) -> Result<()> {
    store.custody().map_err(|error| crate::carry_cause!(Error::SourceChanged, error))
}
/// One policy_directory value. SQLite never materializes a value above MAX_JSON: the read is bounded in storage.
fn read(store: &dyn Storage, name: &str) -> Result<Value> {
    let row = store
        .get("policy_directory", &[Stored::from(name)], &[Read::at_most("value", MAX_JSON)])
        .map_err(unavailable)?;
    match row.map(|mut row| row.take(0)) {
        None => Ok(Value::Null),
        Some(Stored::Text(text)) => serde_json::from_str(&text).map_err(unavailable),
        Some(_) => Err(crate::cause!(Error::Unavailable)),
    }
}
fn put(store: &dyn Storage, name: &str, value: &Value) -> Result<()> {
    let bytes = serde_json::to_string(value).map_err(unavailable)?;
    if bytes.len() > MAX_JSON {
        return Err(crate::cause!(Error::Unavailable));
    }
    store
        .put("policy_directory", &[("name", Stored::from(name)), ("value", Stored::Text(bytes))], When::Always)
        .map_err(unavailable)?;
    Ok(())
}
fn canonical_account(store: &dyn Storage, account: &AccountIdentity) -> Result<Value> {
    if !bounded(&account.user_id, 512)
        || account.owner_id.len() != 64
        || !account
            .owner_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(crate::cause!(Error::Invalid));
    }
    let source = read(store, "policy-source")?;
    if !matches!(
        source["from"].as_str(),
        Some("born" | "fence" | "fence-exit")
    ) || source["missing"].as_array().is_none_or(|v| !v.is_empty())
        || !read(store, "policy-source-carry")?.is_null()
    {
        return Err(crate::cause!(Error::NotCanonical));
    }
    let part = read(store, "policy-source:account")?;
    if !part["lifecycle"].is_object()
        || part["account_controls"]["owner_user_id"] != account.user_id
    {
        return Err(crate::cause!(Error::NotCanonical));
    }
    Ok(part)
}

fn iso(at_ms: u64) -> Result<String> {
    if at_ms == 0 || at_ms > MAX_SAFE {
        return Err(crate::cause!(Error::Invalid));
    }
    DateTime::<Utc>::from_timestamp_millis(i64::try_from(at_ms).map_err(|error| crate::carry_cause!(Error::Invalid, error))?)
        .map(|at| at.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or(crate::cause!(Error::Invalid))
}

fn source_timestamp(value: &Value) -> Result<u64> {
    if let Some(at) = value.as_u64().filter(|at| *at <= MAX_SAFE) {
        return Ok(at);
    }
    let text = value.as_str().ok_or(crate::cause!(Error::Unavailable))?;
    let at = DateTime::parse_from_rfc3339(text)
        .map_err(unavailable)?
        .timestamp_millis();
    u64::try_from(at)
        .ok()
        .filter(|at| *at <= MAX_SAFE)
        .ok_or(crate::cause!(Error::Unavailable))
}

fn validate_receipt(store: &dyn Storage, change: &Change, receipt: &Receipt) -> Result<()> {
    let valid = match change {
        Change::EndSignIn { sign_in, at_ms } => {
            receipt.result == json!({"ended":sign_in})
                && read(store, &format!("policy-source:sign-in:{sign_in}"))?["ended_until_ms"]
                    == json!(at_ms + ENDED_SIGN_IN_MS)
        }
        Change::Disconnect { at_ms } => {
            let expected = iso(*at_ms)?;
            receipt.result == expected
                && read(store, "policy-source:account")?["lifecycle"]["disconnected_at"]
                    == expected
        }
        Change::EndBrowserSessions {
            expected_generation,
        } => {
            receipt.result == json!(expected_generation + 1)
                && read(store, "policy-source:account")?["lifecycle"]
                    ["browser_session_generation"]
                    == receipt.result
        }
    };
    if !valid {
        return Err(crate::cause!(Error::SourceChanged));
    }
    Ok(())
}

/// The mutation stage of the ORIGINAL policy update, after its source has
/// established pause/drain completion. Does not begin/finish a policy update,
/// publish a snapshot, release quota, issue credentials or take over another source.
/// Leaves update/progress/pauses held for the original protocol to finish.
pub fn mutate_drained(
    store: &dyn Storage,
    owner: &mut impl CanonicalPolicyOwner,
    account: &AccountIdentity,
    update: &str,
    change: &Change,
) -> Result<Receipt> {
    if !bounded(update, 200)
        || !bounded(&account.user_id, 512)
        || account.owner_id.len() != 64
        || !account
            .owner_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(crate::cause!(Error::Invalid));
    }
    let identity = change.identity()?;
    owner.assert_current(account, store)?;
    owner.assert_management_admission(account, update, &identity)?;
    physical(store)?;
    if store.scoped() {
        return Err(crate::cause!(Error::SourceChanged));
    }
    let tx = Scope::begin(store, Intent::Write).map_err(unavailable)?;
    let mut account_part = canonical_account(&*tx, account)?;
    if read(&*tx, "update")?.as_str() != Some(update)
        || !read(&*tx, "account-erasure-continuation")?.is_null()
        || !read(&*tx, "account-erasure")?.is_null()
    {
        return Err(crate::cause!(Error::UpdateChanged));
    }
    let mut progress = read(&*tx, "update-progress")?;
    if progress["id"].as_str() != Some(update) {
        return Err(crate::cause!(Error::UpdateChanged));
    }
    // Evidence is in the existing update's DATA, atomically with its source
    // change. No second command journal, auth store or guessed terminal exists.
    let prior = progress.get("rights_change").filter(|v| !v.is_null());
    let receipt = if let Some(prior) = prior {
        let receipt: Receipt = serde_json::from_value(prior.clone()).map_err(unavailable)?;
        if receipt.version != RECEIPT_VERSION || receipt.change_identity != identity {
            return Err(crate::cause!(Error::DifferentChange));
        }
        if !matches!(progress["phase"].as_str(), Some("drained" | "published")) {
            return Err(crate::cause!(Error::NotDrained));
        }
        receipt
    } else {
        if progress["phase"] != "drained" || progress["publish_cursor"].as_str() != Some("") {
            return Err(crate::cause!(Error::NotDrained));
        }
        let result = match change {
            Change::EndSignIn { sign_in, at_ms } => {
                let name = format!("policy-source:sign-in:{sign_in}");
                let mut row = read(&*tx, &name)?;
                if row.is_null() {
                    row = json!({});
                }
                if !row.is_object() {
                    return Err(crate::cause!(Error::Unavailable));
                }
                let until = at_ms + ENDED_SIGN_IN_MS;
                let prior = row
                    .get("ended_until_ms")
                    .filter(|v| !v.is_null())
                    .or_else(|| row.get("ended_until").filter(|v| !v.is_null()));
                if let Some(prior) = prior {
                    let before = source_timestamp(prior)?;
                    if until < before {
                        return Err(crate::cause!(Error::Invalid));
                    }
                }
                row["ended_until_ms"] = json!(until);
                put(&*tx, &name, &row)?;
                json!({"ended":sign_in})
            }
            Change::Disconnect { at_ms } => {
                let at = iso(*at_ms)?;
                let prior = &account_part["lifecycle"]["disconnected_at"];
                if !prior.is_null() && source_timestamp(prior)? > *at_ms {
                    return Err(crate::cause!(Error::Invalid));
                }
                account_part["lifecycle"]["disconnected_at"] = json!(at);
                put(&*tx, "policy-source:account", &account_part)?;
                Value::String(at)
            }
            Change::EndBrowserSessions {
                expected_generation,
            } => {
                let before = &account_part["lifecycle"]["browser_session_generation"];
                let generation = if before.is_null() {
                    0
                } else {
                    before
                        .as_u64()
                        .filter(|n| *n < MAX_SAFE)
                        .ok_or(crate::cause!(Error::Unavailable))?
                };
                if generation != *expected_generation {
                    return Err(crate::cause!(Error::SourceChanged));
                }
                account_part["lifecycle"]["browser_session_generation"] = json!(generation + 1);
                put(&*tx, "policy-source:account", &account_part)?;
                json!(generation + 1)
            }
        };
        let receipt = Receipt {
            version: RECEIPT_VERSION.into(),
            change_identity: identity.clone(),
            result,
        };
        progress["rights_change"] = serde_json::to_value(&receipt).map_err(unavailable)?;
        put(&*tx, "update-progress", &progress)?;
        receipt
    };
    // A matching content identity alone cannot turn altered result/progress
    // DATA into a successful retry. Check its exact operation and source effect.
    validate_receipt(&*tx, change, &receipt)?;
    // Check inside the SAME transaction, including before retry disclosure.
    owner.assert_management_admission(account, update, &identity)?;
    owner.assert_current(account, &*tx)?;
    physical(&*tx)?;
    tx.commit().map_err(unavailable)?;
    Ok(receipt)
}
