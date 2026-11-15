// Purpose: Implement the original ordinary-browser viewer startup read.
// Invariants: use the SAME selected account and current own-records browser
// admission; service settings are independently selected, never inferred from
// missing Rust capabilities, request fields, restored values or another account.
// Key concepts: account-routes.mjs viewer; client-program.mjs hostAudiencesFor,
// hostAudiences and programsFor; current policy account_controls.client_programs.
// Security: bounded specific field projection, redacted diagnostics, current
// policy/config rechecks and original cancellation. No store, key, command,
// policy mutation, network access or successful placeholder startup answers.

use crate::account::{AccountError, AccountResult, BrowserAdmission};
use content_crypto::advanced::blake3;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fmt,
    sync::atomic::{AtomicBool, Ordering},
};

const OPERATOR_SETTING: &str = "OPERATOR_ACCOUNT_ID";
const MAX_PROGRAMS: usize = 4096;
const MAX_CONFIG_BYTES: usize = 1024 * 1024;
const MAX_POLICY_BYTES: usize = 4 * 1024 * 1024;
const MAX_VALUE_NODES: usize = 100_000;

fn bounded(text: &str, max: usize) -> bool {
    !text.is_empty() && text.len() <= max && !text.chars().any(char::is_control)
}
fn cancelled(cancel: &AtomicBool) -> AccountResult<()> {
    if cancel.load(Ordering::Acquire) {
        Err(crate::cause!(AccountError::SourceChanged))
    } else {
        Ok(())
    }
}

struct Program {
    id: String,
    setting: String,
    audience: Value,
}
impl fmt::Debug for Program {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StartupProgram([redacted])")
    }
}
fn program(row: &Value) -> AccountResult<Program> {
    let text = |value: &Value| {
        value
            .as_str()
            .filter(|s| bounded(s, 512))
            .map(str::to_owned)
            .ok_or(crate::cause!(AccountError::SourceUnavailable))
    };
    Ok(Program {
        id: text(&row["id"])?,
        setting: text(&row["host"]["account"]["setting"])?,
        audience: row["host"]["audience"].clone(),
    })
}

/// Original client-program.json DATA with an independently supplied content
/// identity. A pin measured from untrusted request bytes is not selection.
pub struct ProgramData {
    programs: Vec<Program>,
}
impl fmt::Debug for ProgramData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StartupProgramData([redacted])")
    }
}
impl ProgramData {
    pub fn from_source(bytes: &[u8], expected_blake3: &str) -> AccountResult<Self> {
        if bytes.len() > MAX_CONFIG_BYTES
            || expected_blake3.len() != 64
            || blake3::hash(bytes).to_hex().as_str() != expected_blake3
        {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        let value: Value =
            serde_json::from_slice(bytes).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let rows = value["programs"]
            .as_array()
            .filter(|r| r.len() <= MAX_PROGRAMS)
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        Ok(Self {
            programs: rows.iter().map(program).collect::<AccountResult<_>>()?,
        })
    }
}

/// Only the particular current policy field needed by viewer is retained.
/// BrowserAdmission must be produced by account::current_browser on the same
/// selected owner and own-records gate as the surrounding request. Its ordinary
/// session check establishes that throwaway/view-as sessions are not admitted.
/// Typed current admission for the same canonical viewer projector. The
/// ordinary browser implementation remains the default. Other transports must
/// supply their real checked account/sign-in/policy proof, not browser DTOs.
pub trait ViewerAdmission {
    fn account(&self) -> &crate::account::AccountIdentity;
    fn same(&self, other: &Self) -> bool;
}
impl ViewerAdmission for BrowserAdmission {
    fn account(&self) -> &crate::account::AccountIdentity { &self.account }
    fn same(&self, other: &Self) -> bool {
        self.account == other.account && self.still() && other.still()
    }
}
pub struct ViewerState<A: ViewerAdmission = BrowserAdmission> {
    pub admission: A,
    /// None means this control is not qualified/supplied, not known absence.
    /// Only the actual configured operator needs this source. Some(Null) is an
    /// established current null, normalized by original heldPrograms semantics.
    pub client_programs: Option<Value>,
}
impl<A: ViewerAdmission> fmt::Debug for ViewerState<A> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StartupViewerState([redacted])")
    }
}

/// Root/native composition implements this over its existing SelectedAccount.
/// No method is optional and no default implementation can invent absence.
pub trait ViewerSource<A: ViewerAdmission = BrowserAdmission> {
    /// Read fresh ordinary-browser admission and the current same-account
    /// policy account_controls.client_programs under one retained selection.
    fn current_viewer(&mut self, session_id: &str) -> AccountResult<ViewerState<A>>;
    /// Exact original selected service-configuration point read. None means
    /// established current absence, never a missing loader or failed vault.
    fn service_setting(&mut self, name: &str) -> AccountResult<Option<String>>;
    /// Recheck current selected policy AND service-configuration witnesses.
    fn assert_current(&mut self) -> AccountResult<()>;
}

fn same_state<A: ViewerAdmission>(a: &ViewerState<A>, b: &ViewerState<A>, needs_programs: bool) -> bool {
    a.admission.same(&b.admission)
        && (!needs_programs || a.client_programs == b.client_programs)
}
fn bounded_value(value: &Value) -> AccountResult<()> {
    let (mut nodes, mut bytes) = (0usize, 0usize);
    let mut pending = vec![(value, 0usize)];
    while let Some((value, depth)) = pending.pop() {
        nodes += 1;
        if nodes > MAX_VALUE_NODES || depth > 64 {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        let size = match value {
            Value::String(s) => s.len() + 2,
            Value::Array(rows) => {
                if rows.len() > MAX_VALUE_NODES {
                    return Err(crate::cause!(AccountError::SourceUnavailable));
                }
                pending.extend(rows.iter().map(|v| (v, depth + 1)));
                rows.len() + 2
            }
            Value::Object(map) => {
                if map.len() > MAX_VALUE_NODES {
                    return Err(crate::cause!(AccountError::SourceUnavailable));
                }
                pending.extend(map.values().map(|v| (v, depth + 1)));
                map.keys().map(|s| s.len() + 4).sum::<usize>() + 2
            }
            _ => 32,
        };
        bytes = bytes
            .checked_add(size)
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        if bytes > MAX_POLICY_BYTES {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
    }
    Ok(())
}
fn setting<A: ViewerAdmission>(
    source: &mut impl ViewerSource<A>,
    seen: &mut BTreeMap<String, Option<String>>,
    name: &str,
    cancel: &AtomicBool,
) -> AccountResult<Option<String>> {
    cancelled(cancel)?;
    if let Some(value) = seen.get(name) {
        return Ok(value.clone());
    }
    let value = source.service_setting(name)?;
    if value
        .as_ref()
        .is_some_and(|s| s.len() > 512 || s.chars().any(char::is_control))
    {
        return Err(crate::cause!(AccountError::SourceUnavailable));
    }
    seen.insert(name.to_owned(), value.clone());
    Ok(value)
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
        _ => true,
    }
}

/// Exact ordinary-browser /work/api/viewer response, computed from current
/// sources rather than accepting a supplied access_refs array. The operator's
/// held programs are consulted only for that actual configured account; other
/// accounts use shipped host audiences without accessing the operator's data.
pub fn viewer<A: ViewerAdmission>(
    source: &mut impl ViewerSource<A>,
    data: &ProgramData,
    session_id: &str,
    cancel: &AtomicBool,
) -> AccountResult<Value> {
    if session_id.len() != 64
        || !session_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(crate::cause!(AccountError::InvalidInput));
    }
    cancelled(cancel)?;
    source.assert_current()?;
    let initial = source.current_viewer(session_id)?;
    if !bounded(&initial.admission.account().user_id, 512)
        || initial.admission.account().owner_id.len() != 64
    {
        return Err(crate::cause!(AccountError::SourceUnavailable));
    }
    let mut settings = BTreeMap::new();
    let operator = setting(source, &mut settings, OPERATOR_SETTING, cancel)?;
    let is_operator = operator
        .as_ref()
        .is_some_and(|id| !id.is_empty() && id == &initial.admission.account().user_id);
    let mut access_refs = Vec::new();
    if is_operator {
        access_refs.push(Value::String("audience:operator".into()));
    }
    for row in &data.programs {
        if setting(source, &mut settings, &row.setting, cancel)?.as_deref()
            == Some(initial.admission.account().user_id.as_str())
        {
            access_refs.push(row.audience.clone());
        }
    }
    if is_operator {
        let held = initial
            .client_programs
            .as_ref()
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        bounded_value(held)?;
        // clientProgramMethods.heldPrograms accepts both representations.
        // Any other ESTABLISHED current value means no held rows; an absent
        // or unqualified policy supplier must have failed before this point.
        let rows = held
            .as_array()
            .or_else(|| held.get("programs").and_then(Value::as_array))
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if rows.len() > MAX_PROGRAMS {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        let known = data
            .programs
            .iter()
            .map(|row| row.id.as_str())
            .collect::<HashSet<_>>();
        for row in rows {
            cancelled(cancel)?;
            // programsFor ignores rows that cannot name their own host. It
            // excludes only shipped IDs; duplicate held IDs retain row order.
            if !truthy(&row["id"]) || !truthy(&row["host"]["account"]["setting"]) {
                continue;
            }
            let id = row["id"].as_str().ok_or(crate::cause!(AccountError::SourceUnavailable))?;
            if known.contains(id) {
                continue;
            }
            let name = row["host"]["account"]["setting"]
                .as_str()
                .filter(|s| bounded(s, 512))
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
            if setting(source, &mut settings, name, cancel)?.as_deref() != operator.as_deref() {
                continue;
            }
            // hostAudiences maps exactly this field. Undefined becomes null
            // in the response array; other JSON values are not reinterpreted.
            access_refs.push(row["host"]["audience"].clone());
        }
    }
    cancelled(cancel)?;
    source.assert_current()?;
    let current = source.current_viewer(session_id)?;
    if !same_state(&initial, &current, is_operator) {
        return Err(crate::cause!(AccountError::SourceChanged));
    }
    for (name, expected) in settings {
        cancelled(cancel)?;
        if source.service_setting(&name)? != expected {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
    }
    source.assert_current()?;
    cancelled(cancel)?;
    Ok(json!({"access_refs":access_refs,"throwaway":false}))
}
