// src/records/write.rs
//
// Purpose: The writes and the reads that go with them: `records:write { records: [{ id, type, value | null, expected? }], check_only? }`
// and `workspace:write { writes: [{ address_label, payload }] }` answer `{ changed, write_count }`; `records:result { request_key,
// operation, input }` answers the receipt of an earlier write; `workspace:read { selection: { labels, prefixes: [] } }` answers the
// payloads of exact labels in the HTTP result envelope `{ status, content_type, text }`.
//
// Non-Negotiable Invariants:
// - A write changes every row it names or none: the rows, and the receipt that keeps the answer under the call's request key, are one
//   transaction (`Rows::mutate_all`). The same key with the same input answers the receipt and changes nothing; the same key with
//   another input is `original_command_conflict` and changes nothing.
// - `expected` is checked against the rows as the write read them: null requires absence, `{ type, value }` requires that exact row of that
//   type; any mismatch refuses the whole write before it changes anything. A row that changes between the read and the commit refuses the
//   transaction (`Conflict`), and the write reads again, up to `ATTEMPTS` times, then answers busy.
// - A removal of a record that is not there changes nothing and counts nothing. A record whose value is what is written counts nothing.
// - `changed` is whether `write_count` is not zero; `write_count` is how many rows the write really changed.
// - A write never leaves a record without an id and a type, or an id with a '/': those refuse before anything is read.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{closed, Records, Refusal};
use rows_store::store::{Error as StoreError, Mutation};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

/// How many times a write reads again when another change lands between its read and its commit.
const ATTEMPTS: usize = 5;

/// What a record asked to hold before it is written.
enum Expected {
    Absent,
    Is { kind: String, value: Value },
}

/// One row to write: where it is, its new value (none removes it) and what it must hold now.
struct Planned {
    scope: String,
    id: String,
    kind: String,
    value: Option<Value>,
    expected: Option<Expected>,
}

impl Records {
    pub(super) fn write_records(&self, input: &Map<String, Value>, key: &str) -> Result<Value, Refusal> {
        closed(input, &["records", "check_only"])?;
        let items = input.get("records").and_then(Value::as_array).filter(|items| (1..=self.settings.bounds.writes_most).contains(&items.len())).ok_or_else(Refusal::input)?;
        let mut planned = Vec::with_capacity(items.len());
        for item in items {
            let item = item.as_object().ok_or_else(Refusal::input)?;
            closed(item, &["id", "type", "value", "expected"])?;
            let (id, kind) = (self.id_of(item)?, self.name_of(item, "type")?);
            let value = match item.get("value") {
                Some(Value::Null) => None,
                Some(value @ Value::Object(_)) => Some(value.clone()),
                _ => return Err(Refusal::input()),
            };
            let expected = match item.get("expected") {
                None => None,
                Some(Value::Null) => Some(Expected::Absent),
                Some(Value::Object(held)) => {
                    closed(held, &["type", "value"])?;
                    let kind = held.get("type").and_then(Value::as_str).ok_or_else(Refusal::input)?;
                    let value = held.get("value").filter(|value| value.is_object()).ok_or_else(Refusal::input)?;
                    Some(Expected::Is { kind: kind.to_owned(), value: value.clone() })
                }
                Some(_) => return Err(Refusal::input()),
            };
            planned.push(Planned { scope: self.records_scope(kind), id: id.to_owned(), kind: kind.to_owned(), value, expected });
        }
        let check_only = match input.get("check_only") {
            None | Some(Value::Null) | Some(Value::Bool(false)) => false,
            Some(Value::Bool(true)) => true,
            Some(_) => return Err(Refusal::input()),
        };
        self.apply("records:write", input, key, planned, check_only)
    }

    pub(super) fn write_workspace(&self, input: &Map<String, Value>, key: &str) -> Result<Value, Refusal> {
        closed(input, &["writes"])?;
        let writes = input.get("writes").and_then(Value::as_array).filter(|writes| (1..=self.settings.bounds.writes_most).contains(&writes.len())).ok_or_else(Refusal::input)?;
        let mut planned = Vec::with_capacity(writes.len());
        for write in writes {
            let write = write.as_object().ok_or_else(Refusal::input)?;
            closed(write, &["address_label", "payload"])?;
            let label = self.name_of(write, "address_label")?;
            let payload = write.get("payload").ok_or_else(Refusal::input)?;
            planned.push(Planned { scope: self.settings.scopes.workspace.clone(), id: label.to_owned(), kind: String::new(), value: Some(payload.clone()), expected: None });
        }
        self.apply("workspace:write", input, key, planned, false)
    }

    /// The write of `planned` under `key`: read, check, change every row and keep the receipt in one transaction.
    fn apply(&self, operation: &str, input: &Map<String, Value>, key: &str, planned: Vec<Planned>, check_only: bool) -> Result<Value, Refusal> {
        let mut seen = BTreeSet::new();
        if !planned.iter().all(|row| seen.insert((row.scope.as_str(), row.id.as_str()))) {
            return Err(Refusal::input());
        }
        let identity = identity_of(operation, input);
        let receipts = &self.settings.scopes.receipts;
        for _ in 0..ATTEMPTS {
            if let Some(answer) = self.receipt(key, &identity)? {
                return Ok(answer);
            }
            let mut changes = Vec::new();
            for row in &planned {
                let (version, current) = self.store.held_record_with_version(&row.scope, &row.id)?;
                let held = current.as_ref().map(|record| &record.value);
                match &row.expected {
                    None => {}
                    Some(Expected::Absent) if held.is_some() => return Err(Refusal::conflict()),
                    Some(Expected::Is { kind, value }) if *kind != row.kind || held != Some(value) => return Err(Refusal::conflict()),
                    Some(_) => {}
                }
                let (deleted, value) = match &row.value {
                    Some(value) if held == Some(value) => continue,
                    Some(value) => (false, value.clone()),
                    None if held.is_none() => continue,
                    None => (true, Value::Null),
                };
                changes.push((row.scope.clone(), Mutation { id: row.id.clone(), expected_version: version, request_key: key.to_owned(), deleted, value }));
            }
            let answer = json!({"changed": !changes.is_empty(), "write_count": changes.len()});
            if check_only {
                return Ok(json!({"changed": answer["changed"], "write_count": answer["write_count"], "check_only": true}));
            }
            changes.push((receipts.clone(), Mutation { id: key.to_owned(), expected_version: 0, request_key: key.to_owned(), deleted: false,
                value: json!({"identity": identity, "answer": answer}) }));
            match self.store.mutate_all(&changes) {
                Ok(_) => return Ok(answer),
                // Another change landed between the read and the commit: read again.
                Err(StoreError::Conflict(_)) => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(Refusal::busy())
    }

    /// The receipt kept under `key`: its answer when it is the receipt of this input, a conflict when another input kept it, none when
    /// nothing was kept.
    fn receipt(&self, key: &str, identity: &str) -> Result<Option<Value>, Refusal> {
        let Some(record) = self.store.get(&self.settings.scopes.receipts, key)?.record else { return Ok(None) };
        if record.value["identity"] == identity { Ok(Some(record.value["answer"].clone())) } else { Err(Refusal::conflict()) }
    }

    /// `records:result { request_key, operation, input }`: the receipt of the original write, never an effect. A write that left none is
    /// not said to have had no effect: the answer is that the source is unavailable, outcome unknown.
    pub(super) fn result(&self, input: &Map<String, Value>) -> Result<Value, Refusal> {
        closed(input, &["request_key", "operation", "input"])?;
        let key = input.get("request_key").and_then(Value::as_str).filter(|key| !key.is_empty() && key.len() <= self.settings.bounds.request_key_bytes).ok_or_else(Refusal::input)?;
        let operation = input.get("operation").and_then(Value::as_str).filter(|operation| matches!(*operation, "records:write" | "workspace:write")).ok_or_else(Refusal::input)?;
        let original = input.get("input").and_then(Value::as_object).ok_or_else(Refusal::input)?;
        self.receipt(key, &identity_of(operation, original))?.ok_or_else(Refusal::source_unknown)
    }

    /// `workspace:read { selection: { labels, prefixes: [] } }`: the payloads of the exact labels that are there, as `{ records: { label:
    /// payload } }` in the HTTP result envelope the door's reader checks. A label that is not there is absent, never null.
    pub(super) fn read_workspace(&self, input: &Map<String, Value>) -> Result<Value, Refusal> {
        closed(input, &["selection"])?;
        let selection = input.get("selection").and_then(Value::as_object).ok_or_else(Refusal::input)?;
        closed(selection, &["labels", "prefixes"])?;
        if !selection.get("prefixes").and_then(Value::as_array).is_some_and(Vec::is_empty) {
            return Err(Refusal::input());
        }
        let labels = selection.get("labels").and_then(Value::as_array).filter(|labels| (1..=self.settings.bounds.labels_most).contains(&labels.len())).ok_or_else(Refusal::input)?;
        let labels = labels.iter().map(|label| label.as_str().filter(|label| self.plain_name(label)).ok_or_else(Refusal::input)).collect::<Result<Vec<_>, _>>()?;
        if labels.iter().collect::<BTreeSet<_>>().len() != labels.len() {
            return Err(Refusal::input());
        }
        let rows = self.store.get_many(&self.settings.scopes.workspace, &labels)?;
        let records: Map<String, Value> = labels.iter().zip(rows).filter_map(|(label, row)| row.map(|row| ((*label).to_owned(), row.value))).collect();
        let text = serde_json::to_string(&json!({"records": records})).map_err(|_| Refusal::source())?;
        Ok(json!({"status": 200, "content_type": "application/json", "text": text}))
    }
}

/// The identity of one call: the BLAKE3 of the operation and its input as canonical JSON (keys in order), so the same key with the same
/// input is the same call and no other is.
fn identity_of(operation: &str, input: &Map<String, Value>) -> String {
    let bytes = serde_json::to_vec(&json!([operation, input])).unwrap_or_default();
    content_crypto::advanced::blake3::hash(&bytes).to_hex().to_string()
}
