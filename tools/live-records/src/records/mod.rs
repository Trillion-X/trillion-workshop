// src/records/mod.rs
//
// Purpose: The operations of the records door (tools/records-door/README.md) over the person's rows: `records:read`, `records:list`,
// `records:search`, `records:write` and `records:result` of records, and `workspace:read` and `workspace:write` of workspace labels. The
// engine narrows each call to the rights its row declared and sends the tool the narrowed input with the call's `request_key` (and
// `after_byte` for the next page of a big answer); the tool never decides who may call, only whether the call is well formed and what
// it answers.
//
// Non-Negotiable Invariants:
// - A record of type T is the row `id` of the scope `<records>T`; two types never share a row, and a read with a type answers only
//   that type's row (value null when there is none).
// - Unknown input fields refuse (`original_input_refused`): nothing the caller named is silently dropped.
// - A refusal is a code and whether the call may have had an effect (`not_started` or `unknown`), never words or a value.
// - A write changes every record it names or none (one transaction), and its receipt is kept in that transaction under the call's
//   request key, so the same key sent again answers the first receipt and changes nothing (`write.rs`).
// - An answer is as the README gives it; one too big for a message goes as byte pages (`answer.rs`), and every later page is asked for
//   with `after_byte` and answered from the same call re-run, so no page is kept between calls.
//
// Key Concepts:
// - `Refusal`: the door's refusal as this tool answers it.
// - `Records::call`: one call by operation name; the caller (serve/mcp.rs) gives it the arguments the engine sent.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

mod list;
mod search;
mod write;

use crate::{
    answer::Fit,
    settings::Settings,
};
use rows_store::store::{Error as StoreError, RecordRows};
use serde_json::{json, Map, Value};
use std::{sync::Arc, time::Instant};

/// The operations this tool answers, in the words of the door.
pub const OPERATIONS: [&str; 7] = ["records:read", "records:list", "records:search", "records:write", "records:result", "workspace:read", "workspace:write"];

/// The door's refusal: its code and whether the call may have had an effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub unknown: bool,
}

impl Refusal {
    /// The call is not well formed, or asks for what this tool does not answer.
    pub fn input() -> Self {
        Self { code: "original_input_refused", unknown: false }
    }
    /// The rows cannot be reached.
    pub fn source() -> Self {
        Self { code: "original_workspace_source_unavailable", unknown: false }
    }
    /// A write that may have committed: the same request key tells.
    pub fn source_unknown() -> Self {
        Self { code: "original_workspace_source_unavailable", unknown: true }
    }
    /// The rows stayed busy: a call that changed nothing may be sent again.
    pub fn busy() -> Self {
        Self { code: "selected_owner_unavailable", unknown: false }
    }
    /// The call's condition, or its request key's earlier body, does not hold.
    pub fn conflict() -> Self {
        Self { code: "original_command_conflict", unknown: false }
    }
}

impl From<StoreError> for Refusal {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Invalid(..) => Self::input(),
            StoreError::Conflict(_) => Self::conflict(),
            StoreError::Unavailable(_) => Self::source(),
            StoreError::OutcomeUnknown(_) => Self::source_unknown(),
        }
    }
}

/// The person's records, served by one run.
pub struct Records {
    store: Arc<dyn RecordRows>,
    settings: Settings,
    fit: Fit,
}

/// The call's own fields, taken off its arguments.
struct Taken {
    request_key: Option<String>,
    after_byte: Option<u64>,
    input: Map<String, Value>,
}

impl Records {
    pub fn new(store: Arc<dyn RecordRows>, settings: Settings) -> Self {
        let fit = Fit { answer_bytes: settings.bounds.answer_bytes, page_bytes: settings.bounds.byte_page_bytes };
        Self { store, settings, fit }
    }

    /// One call: `operation` with the `arguments` the engine sent. The answer fits a message, or is a byte page of it.
    pub fn call(&self, operation: &str, arguments: &Value) -> Result<Value, Refusal> {
        let Taken { request_key, after_byte, input } = self.take(arguments)?;
        let started = Instant::now();
        let writes = matches!(operation, "records:write" | "workspace:write");
        if writes && (request_key.is_none() || after_byte.is_some()) {
            return Err(Refusal::input());
        }
        let key = request_key.as_deref();
        let answer = match operation {
            "records:read" => self.read(&input)?,
            "records:list" => self.list(&input, started)?,
            "records:search" => self.search(&input)?,
            "records:write" => self.write_records(&input, key.unwrap_or_default())?,
            "records:result" => self.result(&input)?,
            "workspace:read" => self.read_workspace(&input)?,
            "workspace:write" => self.write_workspace(&input, key.unwrap_or_default())?,
            _ => return Err(Refusal::input()),
        };
        self.fit.deliver(answer, after_byte).map_err(|_| Refusal::input())
    }

    fn take(&self, arguments: &Value) -> Result<Taken, Refusal> {
        let mut input = arguments.as_object().cloned().ok_or_else(Refusal::input)?;
        let request_key = match input.remove(self.settings.call_fields.request_key.as_str()) {
            None | Some(Value::Null) => None,
            Some(Value::String(key)) if !key.is_empty() && key.len() <= self.settings.bounds.request_key_bytes => Some(key),
            Some(_) => return Err(Refusal::input()),
        };
        let after_byte = match input.remove(self.settings.call_fields.after_byte.as_str()) {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_u64().ok_or_else(Refusal::input)?),
        };
        Ok(Taken { request_key, after_byte, input })
    }

    /// `records:read { id, type }`: `{ id, type, value }`, value null when the record is absent or of another type.
    fn read(&self, input: &Map<String, Value>) -> Result<Value, Refusal> {
        closed(input, &["id", "type"])?;
        let (id, kind) = (self.id_of(input)?, self.name_of(input, "type")?);
        let record = self.store.get(&self.records_scope(kind), id)?.record;
        Ok(json!({"id": id, "type": kind, "value": record.map_or(Value::Null, |record| record.value)}))
    }

    /// The scope of the rows of one record type.
    fn records_scope(&self, kind: &str) -> String {
        format!("{}{kind}", self.settings.scopes.records)
    }

    /// A required record id: text without '/', within its bound.
    fn id_of<'a>(&self, input: &'a Map<String, Value>) -> Result<&'a str, Refusal> {
        match input.get("id") {
            Some(Value::String(id)) if self.plain_id(id) => Ok(id),
            _ => Err(Refusal::input()),
        }
    }

    fn plain_id(&self, id: &str) -> bool {
        !id.is_empty() && id.len() <= self.settings.bounds.id_bytes && !id.contains('/') && !id.chars().any(char::is_control)
    }

    /// A required name (a record type): non-empty, within its bound, no control character.
    fn name_of<'a>(&self, input: &'a Map<String, Value>, field: &str) -> Result<&'a str, Refusal> {
        match input.get(field) {
            Some(Value::String(name)) if self.plain_name(name) => Ok(name),
            _ => Err(Refusal::input()),
        }
    }

    fn plain_name(&self, name: &str) -> bool {
        !name.is_empty() && name.len() <= self.settings.bounds.name_bytes && !name.chars().any(char::is_control)
    }
}

/// Refuse an input that names a field outside `allowed`.
fn closed(input: &Map<String, Value>, allowed: &[&str]) -> Result<(), Refusal> {
    if input.keys().all(|name| allowed.contains(&name.as_str())) {
        Ok(())
    } else {
        Err(Refusal::input())
    }
}

#[cfg(test)]
mod tests;
