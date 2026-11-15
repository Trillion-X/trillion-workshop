//! Bounded physical read of one whole task of the tools.
//!
//! This module supplies bytes from the selected Storage snapshot only. It does
//! not establish who owns the task, whether a method is authorized, or whether
//! an effect exists. Those claims stay with their existing owners.
//! A tools operation-run Task is not the inherited original/amended human
//! request contract. Reading it cannot establish applicability or task coverage.

use crate::{
    ecma_json::{self, Value as JsonValue},
    storage::{self, Bound, Error as StorageError, Range, Read, Row, Storage, Value},
};
use std::{
    fmt,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

/// Source writer ceiling: `src/workshop-tasks.mjs` reliability-ceilings.json.
const MAX_WORKSHOP_TASK_VALUE_BYTES: usize = 1_048_576;
const MAX_TASK_ID_BYTES: usize = 256;
const MAX_RESOURCE_CLAIM_BYTES: usize = 8192;
const MAX_PERMIT_STATE_BYTES: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReadError {
    Missing(crate::refusal_cause::Cause),
    NoPermit(crate::refusal_cause::Cause),
    Aborted(crate::refusal_cause::Cause),
    Unassociated(crate::refusal_cause::Cause),
    NotLinked(crate::refusal_cause::Cause),
    InvalidIdentifier(crate::refusal_cause::Cause),
    Malformed(crate::refusal_cause::Cause),
    Mismatch(crate::refusal_cause::Cause),
    Source(crate::refusal_cause::Cause),
    Budget(crate::refusal_cause::Cause),
    Unsupported(crate::refusal_cause::Cause),
    Cancelled(crate::refusal_cause::Cause),
    Deadline(crate::refusal_cause::Cause),
}
impl ReadError {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Missing(cause) => cause,
            Self::NoPermit(cause) => cause,
            Self::Aborted(cause) => cause,
            Self::Unassociated(cause) => cause,
            Self::NotLinked(cause) => cause,
            Self::InvalidIdentifier(cause) => cause,
            Self::Malformed(cause) => cause,
            Self::Mismatch(cause) => cause,
            Self::Source(cause) => cause,
            Self::Budget(cause) => cause,
            Self::Unsupported(cause) => cause,
            Self::Cancelled(cause) => cause,
            Self::Deadline(cause) => cause,
        }
    }
}
crate::impl_caused!(ReadError);


impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} cause={}", match self {
            Self::Missing(_) => "Workshop task is absent",
            Self::NoPermit(_) => "resource capability permit is absent",
            Self::Aborted(_) => "resource capability permit was aborted",
            Self::Unassociated(_) => "resource capability permit has no linked task",
            Self::NotLinked(_) => "Workshop task is not linked to this resource permit",
            Self::InvalidIdentifier(_) => "Workshop task identifier is invalid",
            Self::Malformed(_) => "Workshop task source is malformed",
            Self::Mismatch(_) => "Workshop task identity does not match its key",
            Self::Source(_) => "Workshop task source is unreadable",
            Self::Budget(_) => "Workshop task read exceeded its budget",
            Self::Unsupported(_) => "record supplier does not support this bounded read",
            Self::Cancelled(_) => "Workshop task read was cancelled",
            Self::Deadline(_) => "Workshop task read deadline elapsed",
        }, self.cause())
    }
}
impl std::error::Error for ReadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// Exact source version identity. The digest is over the stored raw UTF-8 JSON,
/// independent of identities or digests the task itself may contain.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SourceIdentity {
    pub(crate) seq: i64,
    pub(crate) raw_blake3: String,
}
impl fmt::Debug for SourceIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SourceIdentity")
            .field("seq", &self.seq)
            .field("raw_blake3", &"[redacted]")
            .finish()
    }
}

/// A complete decoded task and the physical identity of the row that supplied it.
/// It remains provisional until the caller finishes its source and final rights
/// checks. This value cannot authorize a task, a method or an operation.
/// Debug deliberately omits task contents and identity data.
pub(crate) struct TaskSnapshot {
    pub(crate) task: JsonValue,
    pub(crate) identity: SourceIdentity,
}
impl fmt::Debug for TaskSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TaskSnapshot([redacted])")
    }
}

fn check(cancel: &AtomicBool, deadline: Instant) -> Result<(), ReadError> {
    if cancel.load(Ordering::Acquire) {
        return Err(crate::cause!(ReadError::Cancelled));
    }
    if Instant::now() >= deadline {
        return Err(crate::cause!(ReadError::Deadline));
    }
    Ok(())
}

/// Each read requires the caller's still-held read scope and the same physical
/// handle before and after the operation. Custody proves handle identity only;
/// it does not provide account authority or global currentness.
fn source_check(source: &dyn Storage) -> Result<(), ReadError> {
    source.custody().map_err(map_storage_error)?;
    if !source.scoped() {
        return Err(crate::cause!(ReadError::Source));
    }
    Ok(())
}

fn map_storage_error(error: StorageError) -> ReadError {
    let cause = error.cause();
    match error {
        StorageError::TooBig(_) | StorageError::Interrupted(_) => ReadError::Budget(cause),
        StorageError::Deadline(_) => ReadError::Deadline(cause),
        StorageError::Undeclared(_) => ReadError::Unsupported(cause),
        _ => ReadError::Source(cause),
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_TASK_ID_BYTES && !id.chars().any(char::is_control)
}
fn valid_component(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn bounded_text(value: Value, max: usize) -> Result<String, ReadError> {
    match value {
        Value::Text(text) if text.len() <= max => Ok(text),
        Value::Oversized(_) => Err(crate::cause!(ReadError::Budget)),
        _ => Err(crate::cause!(ReadError::Malformed)),
    }
}

fn string_property<'a>(value: &'a JsonValue, key: &str) -> Option<&'a ecma_json::JsString> {
    let JsonValue::Object(object) = value else {
        return None;
    };
    match object.get(&key.into()) {
        Some(JsonValue::String(value)) => Some(value),
        _ => None,
    }
}

fn property<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    let JsonValue::Object(object) = value else {
        return None;
    };
    object.get(&key.into())
}

/// Read a task only when the same physical snapshot contains its exact durable
/// resource-capability permit row and the task carries the matching claim.
/// `expected_permit_input_identity` must come from that capability permit owner;
/// it is intentionally distinct from the task's own input identity.
/// This is a supplier composition primitive; it does not re-authorize the
/// account, resource, operation, or task and does not identify an effect.
pub(crate) fn read_permitted_task(
    source: &dyn Storage,
    owner: &str,
    resource: &str,
    permit_id: &str,
    expected_permit_input_identity: &str,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<TaskSnapshot, ReadError> {
    check(cancel, deadline)?;
    if !valid_component(permit_id, MAX_RESOURCE_CLAIM_BYTES)
        || !valid_component(owner, MAX_RESOURCE_CLAIM_BYTES)
        || !valid_component(resource, MAX_RESOURCE_CLAIM_BYTES)
        || !valid_digest(expected_permit_input_identity)
    {
        return Err(crate::cause!(ReadError::InvalidIdentifier));
    }
    source_check(source)?;
    let permit = source
        .get(
            "resource_capability_commands",
            &[Value::Text(permit_id.to_owned())],
            &[
                Read::at_most("permit_id", MAX_RESOURCE_CLAIM_BYTES),
                Read::at_most("input_identity", 64),
                Read::at_most("state", MAX_PERMIT_STATE_BYTES),
                Read::at_most("task_id", MAX_TASK_ID_BYTES),
            ],
        )
        .map_err(map_storage_error);
    check(cancel, deadline)?;
    source_check(source)?;
    let Some(permit) = permit? else {
        return Err(crate::cause!(ReadError::NoPermit));
    };
    let [stored_permit, input_identity, state, task_id] = permit.0.as_slice() else {
        return Err(crate::cause!(ReadError::Source));
    };
    let stored_permit = bounded_text(stored_permit.clone(), MAX_RESOURCE_CLAIM_BYTES)?;
    let input_identity = bounded_text(input_identity.clone(), 64)?;
    let state = bounded_text(state.clone(), MAX_PERMIT_STATE_BYTES)?;
    if stored_permit != permit_id || !valid_digest(&input_identity) {
        return Err(crate::cause!(ReadError::Malformed));
    }
    if input_identity != expected_permit_input_identity {
        return Err(crate::cause!(ReadError::NotLinked));
    }
    if state == "aborted" {
        return Err(crate::cause!(ReadError::Aborted));
    }
    if state != "admitted" && state != "committed" {
        return Err(crate::cause!(ReadError::Unsupported));
    }
    let task_id = match task_id {
        Value::Text(task_id) if task_id.len() <= MAX_TASK_ID_BYTES => task_id,
        Value::Oversized(_) => return Err(crate::cause!(ReadError::Budget)),
        Value::Null => return Err(crate::cause!(ReadError::Unassociated)),
        _ => return Err(crate::cause!(ReadError::Malformed)),
    };
    let task = read_task(source, task_id, cancel, deadline)?;
    let claim = property(
        property(&task.task, "resource_authorization").unwrap_or(&JsonValue::Null),
        "command_claim",
    );
    let claim_value = |key: &str| {
        claim
            .and_then(|value| string_property(value, key))
            .and_then(|value| value.to_rust_string().ok())
    };
    if claim_value("owner").as_deref() != Some(owner)
        || claim_value("resource").as_deref() != Some(resource)
        || claim_value("permit_id").as_deref() != Some(permit_id)
        || claim_value("input_identity").as_deref() != Some(input_identity.as_str())
    {
        return Err(crate::cause!(ReadError::NotLinked));
    }
    check(cancel, deadline)?;
    source_check(source)?;
    Ok(task)
}

/// Read one exact whole task from the supplier's current snapshot.
///
/// The source is physical only. A caller that needs currentness after a
/// possible commit must call this with a newly acquired current owner snapshot.
pub(crate) fn read_task(
    source: &dyn Storage,
    task_id: &str,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<TaskSnapshot, ReadError> {
    check(cancel, deadline)?;
    if !valid_id(task_id) {
        return Err(crate::cause!(ReadError::InvalidIdentifier));
    }
    source_check(source)?;
    let entity = format!("task:{task_id}");
    let range = Range {
        order: storage::Order::Named("latest"),
        from: Bound::Included(vec![Value::Text(entity.clone())]),
        to: Bound::Included(vec![Value::Text(entity)]),
        reverse: true,
        limit: Some(1),
    };
    let rows = source
        .scan(
            "workshop_facts",
            &range,
            &[
                Read::at_most("seq", 32),
                Read::at_most("value", MAX_WORKSHOP_TASK_VALUE_BYTES),
            ],
        )
        .map_err(map_storage_error);
    check(cancel, deadline)?;
    source_check(source)?;
    let rows = rows?;
    if rows.len() > 1 {
        return Err(crate::cause!(ReadError::Source));
    }
    let Some(Row(row)) = rows.into_iter().next() else {
        return Err(crate::cause!(ReadError::Missing));
    };
    let [seq, raw] = row.as_slice() else {
        return Err(crate::cause!(ReadError::Malformed));
    };
    let seq = match seq {
        Value::Integer(seq) => *seq,
        Value::Oversized(_) => return Err(crate::cause!(ReadError::Budget)),
        _ => return Err(crate::cause!(ReadError::Malformed)),
    };
    if seq <= 0 {
        return Err(crate::cause!(ReadError::Malformed));
    }
    let raw = match raw {
        Value::Text(raw) if raw.len() <= MAX_WORKSHOP_TASK_VALUE_BYTES => raw,
        Value::Oversized(_) => return Err(crate::cause!(ReadError::Budget)),
        _ => return Err(crate::cause!(ReadError::Malformed)),
    };
    let mut limits = ecma_json::Limits::default();
    limits.input_bytes = MAX_WORKSHOP_TASK_VALUE_BYTES;
    limits.output_bytes = MAX_WORKSHOP_TASK_VALUE_BYTES;
    let task = ecma_json::parse(raw.as_bytes(), limits).map_err(|error| {
        let cause = error.cause();
        match error {
            ecma_json::Error::InvalidJson(_) => ReadError::Malformed(cause),
            ecma_json::Error::InvalidLimits(_) => ReadError::Source(cause),
            _ => ReadError::Budget(cause),
        }
    })?;
    let stored_id = string_property(&task, "task_id").ok_or(crate::cause!(ReadError::Malformed))?;
    if stored_id
        .to_rust_string()
        .map_err(|error| crate::carry_cause!(ReadError::Malformed, error))?
        != task_id
    {
        return Err(crate::cause!(ReadError::Mismatch));
    }
    check(cancel, deadline)?;
    let raw_blake3 = content_crypto::advanced::blake3::hash(raw.as_bytes())
        .to_hex()
        .to_string();
    check(cancel, deadline)?;
    source_check(source)?;
    Ok(TaskSnapshot {
        task,
        identity: SourceIdentity {
            seq,
            raw_blake3,
        },
    })
}

#[cfg(test)]
#[path = "../../../tests/drafts/native_method_effect_context.rs"]
mod controls;

/// Compare exact versions within the supplied physical snapshot. This is not
/// global currentness: re-reading through a held snapshot cannot detect a
/// commit made after it was established. A release owner must independently
/// acquire and finish its actual current source and rights witnesses.
pub(crate) fn matches_snapshot(
    source: &dyn Storage,
    task_id: &str,
    expected: &SourceIdentity,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<bool, ReadError> {
    match read_task(source, task_id, cancel, deadline) {
        Ok(current) => Ok(&current.identity == expected),
        Err(ReadError::Missing(_)) => Ok(false),
        Err(error) => Err(error),
    }
}
