//! Bring one sign-in's resource gate up to the account's current policy revision.
//!
//! A gate the hosted AccountControl published counts its own epoch: finishUpdate saves `epoch + 1` for each update
//! published to that gate (trillion src/account-control-state.mjs), while the directory's `revision` counts every
//! account update. The native policy owner publishes a gate at the directory revision
//! and native admission requires the two to be equal, so a gate carried over from the hosted owner refuses every
//! admission until it is published at the current revision.
//!
//! This step is that publication for one gate. It decides the gate's rights again from the account's current policy
//! source with the hosted finishUpdate rule and saves them at the current revision: every choice and revocation in the
//! current source applies, the gate's own signed registration (made, ceiling) and its latest use are kept, and a
//! sign-in the source and the gate never granted gains nothing. It never only renumbers the epoch.
//!
//! It runs only on a gate that already holds the account's latest published update (the gate's `published-update`
//! equals the directory's latest), with no pause and no open gate update. Any other gate may have missed a change that
//! only the paused update protocol delivers, so the step refuses it (`UpdateChanged`) and changes nothing.
//!
//! The gate's pending hosted permits (in-flight commands of the retired hosted owner) do not hold it back and stay
//! unredeemable: the `account_gate` schema declares no permit family, so no native read or write reaches one.

use super::{read, unavailable, Error, Result, MAX_JSON, MAX_SAFE};
use crate::storage::{Intent, Read, Scope, Storage, Value as Stored, When};
use chrono::DateTime;
use serde_json::{json, Value};

const STATE: &str = "account_control_state";
const GATE_PUBLISHED: &str = "published-update";

fn use_time(value: &Value) -> Result<i64> {
    DateTime::parse_from_rfc3339(value.as_str().ok_or(crate::cause!(Error::Unavailable))?)
        .map(|at| at.timestamp_millis())
        .map_err(|error| unavailable(error))
}

/// The gate state the hosted finishUpdate saves from `source` over `old`, at `revision`.
fn republished(source: &Value, old: &Value, revision: u64) -> Result<Value> {
    let mut next = source.clone();
    if !next["lifecycle"].is_object() || !next["sign_ins"].is_object() {
        return Err(crate::cause!(Error::Unavailable));
    }
    next["epoch"] = json!(revision);
    let old_rows = old["sign_ins"].as_object().ok_or(crate::cause!(Error::Unavailable))?;
    let rows = next["sign_ins"].as_object_mut().ok_or(crate::cause!(Error::Unavailable))?;
    for (sign_in, old_row) in old_rows {
        let old_row = old_row.as_object().ok_or(crate::cause!(Error::Unavailable))?;
        let row = rows
            .entry(sign_in.clone())
            .or_insert_with(|| Value::Object(old_row.clone()))
            .as_object_mut()
            .ok_or(crate::cause!(Error::Unavailable))?;
        // Policy sources can omit the authenticated monotonic registration; keep it while applying fresh choices and
        // revocations.
        for name in ["made", "ceiling"] {
            let kept = old_row.get(name).filter(|value| !value.is_null());
            if row.get(name).is_none_or(Value::is_null) {
                if let Some(kept) = kept {
                    row.insert(name.into(), kept.clone());
                }
            }
        }
        if let Some(old_used) = old_row.get("last_used").filter(|value| !value.is_null()) {
            let newer = match row.get("last_used").filter(|value| !value.is_null()) {
                None => true,
                Some(used) => use_time(old_used)? > use_time(used)?,
            };
            if newer {
                row.insert("last_used".into(), old_used.clone());
            }
        }
    }
    Ok(next)
}

/// The account's current policy for this gate, read by its caller from the account's policy directory.
pub struct GatePolicy<'a> {
    /// The gate's identity row: `{owner, sign_in, resource}`.
    pub identity: &'a Value,
    /// The current policy snapshot for the gate's sign-in (lifecycle, sign_ins and the account's parts).
    pub source: &'a Value,
    /// The directory revision the source was read at.
    pub revision: u64,
    /// The directory's latest published update.
    pub latest_update: &'a Value,
}

/// Publish `gate` at `policy.revision`, its rights decided again from `policy.source`, in one write scope.
/// `still_current` runs inside the scope just before commit and must prove the policy it was given is still current.
/// Ok(false) when the gate already stands at the revision; nothing is written.
pub fn catch_up_gate(
    gate: &dyn Storage,
    policy: &GatePolicy<'_>,
    still_current: impl FnOnce() -> Result<()>,
) -> Result<bool> {
    if policy.revision > MAX_SAFE || !policy.latest_update.is_string() {
        return Err(crate::cause!(Error::Invalid));
    }
    gate.custody().map_err(|error| crate::carry_cause!(Error::SourceChanged, error))?;
    if gate.scoped() {
        return Err(crate::cause!(Error::SourceChanged));
    }
    let tx = Scope::begin(gate, Intent::Write).map_err(|error| unavailable(error))?;
    if &read(&*tx, "identity")? != policy.identity {
        return Err(crate::cause!(Error::NotAuthorized));
    }
    if !read(&*tx, "fence")?.is_null() {
        return Err(crate::cause!(Error::UpdateChanged));
    }
    let mut row = tx
        .get(
            STATE,
            &[Stored::Integer(1)],
            &[Read::whole("epoch"), Read::at_most("state_json", MAX_JSON), Read::whole("updating_id")],
        )
        .map_err(|error| unavailable(error))?
        .ok_or(crate::cause!(Error::Unavailable))?;
    if !row.take(2).is_null() {
        return Err(crate::cause!(Error::UpdateChanged));
    }
    let epoch = row
        .take(0)
        .as_integer()
        .and_then(|epoch| u64::try_from(epoch).ok())
        .filter(|epoch| *epoch <= MAX_SAFE)
        .ok_or(crate::cause!(Error::Unavailable))?;
    if epoch == policy.revision {
        return Ok(false);
    }
    if &read(&*tx, GATE_PUBLISHED)? != policy.latest_update {
        return Err(crate::cause!(Error::UpdateChanged));
    }
    let Stored::Text(saved) = row.take(1) else {
        return Err(crate::cause!(Error::Unavailable));
    };
    let old: Value = serde_json::from_str(&saved).map_err(|error| unavailable(error))?;
    if old["epoch"].as_u64() != Some(epoch) {
        return Err(crate::cause!(Error::SourceChanged));
    }
    let body = republished(policy.source, &old, policy.revision)?.to_string();
    if body.len() > MAX_JSON {
        return Err(crate::cause!(Error::Unavailable));
    }
    let old_epoch = Stored::Integer(i64::try_from(epoch).map_err(|error| unavailable(error))?);
    let changed = tx
        .put(
            STATE,
            &[
                ("singleton", Stored::Integer(1)),
                ("epoch", Stored::Integer(i64::try_from(policy.revision).map_err(|error| unavailable(error))?)),
                ("state_json", Stored::Text(body)),
            ],
            When::Matches(&[("epoch", old_epoch), ("updating_id", Stored::Null)]),
        )
        .map_err(|error| unavailable(error))?;
    if changed != 1 {
        return Err(crate::cause!(Error::SourceChanged));
    }
    still_current()?;
    tx.custody().map_err(|error| crate::carry_cause!(Error::SourceChanged, error))?;
    tx.commit().map_err(|error| unavailable(error))?;
    Ok(true)
}

#[cfg(test)]
mod tests;
