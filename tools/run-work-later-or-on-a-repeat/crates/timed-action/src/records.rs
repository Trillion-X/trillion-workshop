//! crates/timed-action/src/records.rs
//!
//! Purpose
//!   The writes a scheduled-action record makes: one record, its relationships, its time window, and one action per
//!   owner dispatch; the receipt that says an action ran; and the replacement of a time window. Each answer names the
//!   address, the path and the payload of every write, and a receipt preview. Pure: nothing is stored here. This is
//!   the Rust reading of do-work/write-scheduled-action-record.ts.
//!
//! Non-negotiable invariants
//!   1. Every graph write sits at a narrowly queryable current-item kind path (current-item, scheduled-action-<role>),
//!      and its payload names its own kind.
//!   2. An action row carries its own complete dispatch as DATA (dispatch.name is a slot address; dispatch.input is
//!      opaque). A row with no dispatch, or no dispatch.name, is refused at write time.
//!   3. A required value that is missing, null or empty is refused with "<name> is required".
//!   4. A list entry that is null is read the way the TypeScript reads it: a TypeError on the property it reads.

use serde_json::{Map, Value};

use crate::js::{self, get_opt, to_str, to_str_opt, truthy, Refused, Res};

/// `required(value, name)`: the value, or the refusal when it is missing, null or the empty text.
fn required(value: Option<&Value>, name: &str) -> Res<Value> {
    match value {
        None | Some(Value::Null) => Err(Refused::error(format!("{name} is required"))),
        Some(Value::String(text)) if text.is_empty() => Err(Refused::error(format!("{name} is required"))),
        Some(value) => Ok(value.clone()),
    }
}

/// `a || b` for values: the first when it is truthy, otherwise the second.
fn or(first: Option<&Value>, second: Value) -> Value {
    match first {
        Some(value) if truthy(value) => value.clone(),
        _ => second,
    }
}

/// `a || null` for a value that may be missing.
fn or_null(first: Option<&Value>) -> Value {
    or(first, Value::Null)
}

/// `item.key` for a list entry: a null entry is a TypeError, as the TypeScript reads a property of null.
fn member<'a>(item: &'a Value, key: &str) -> Res<Option<&'a Value>> {
    if item.is_null() {
        return Err(Refused::type_error(format!("Cannot read properties of null (reading '{key}')")));
    }
    Ok(get_opt(item, key))
}

/// `input.<key> || []` for a list the write iterates: a truthy value that is not a list is refused as not iterable.
fn entries<'a>(value: Option<&'a Value>, key: &str) -> Res<Vec<&'a Value>> {
    match value {
        Some(Value::Array(items)) => Ok(items.iter().collect()),
        Some(other) if truthy(other) => Err(Refused::type_error(format!("input.{key} is not iterable"))),
        _ => Ok(Vec::new()),
    }
}

fn graph_address(kind: &str, id: &str) -> String {
    format!("timed-action.scheduled-action.{kind}::{id}")
}

fn graph_path(role: &str) -> Value {
    Value::Array(vec![Value::from("current-item"), Value::from(format!("scheduled-action-{role}"))])
}

fn write(address: String, path: Value, payload: Value) -> Value {
    js::object(vec![("address", Value::from(address)), ("path", path), ("payload", payload)])
}

/// `buildScheduledActionRecordWrite(input)`.
pub fn build_record_write(input: &Value) -> Res<Value> {
    let record_id = required(get_opt(input, "record_id"), "record_id")?;
    let record_text = to_str(&record_id);
    let operation = or(get_opt(input, "operation"), Value::from("upsert-record"));
    let source_refs = or(get_opt(input, "source_descriptor_refs"), Value::Array(Vec::new()));
    let mut writes = vec![write(
        graph_address("record", &record_text),
        graph_path("record"),
        js::object(vec![
            ("kind", Value::from("scheduled-action-record")),
            ("role", Value::from("record")),
            ("record_id", record_id.clone()),
            ("fields", or(get_opt(input, "fields"), Value::Object(Map::new()))),
            ("owner_ref", or_null(get_opt(input, "owner_ref"))),
        ]),
    )];

    for relation in entries(get_opt(input, "relationships"), "relationships")? {
        let relation_id = match member(relation, "relationship_id")? {
            Some(id) if truthy(id) => to_str(id),
            _ => format!(
                "{record_text}:{}:{}",
                to_str_opt(member(relation, "relation_role")?),
                to_str_opt(member(relation, "target_id")?)
            ),
        };
        let target_id = required(member(relation, "target_id")?, "relationship.target_id")?;
        let relation_role = required(member(relation, "relation_role")?, "relationship.relation_role")?;
        writes.push(write(
            graph_address("relationship", &relation_id),
            graph_path("relationship"),
            js::object(vec![
                ("kind", Value::from("scheduled-action-relationship")),
                ("source_id", record_id.clone()),
                ("target_id", target_id),
                ("relation_role", relation_role),
                ("evidence", or_null(member(relation, "evidence")?)),
            ]),
        ));
    }

    if let Some(window) = get_opt(input, "time_window").filter(|window| truthy(window)) {
        let window_id = match get_opt(window, "time_window_id") {
            Some(id) if truthy(id) => to_str(id),
            _ => format!("{record_text}:time-window"),
        };
        let mut payload = match window {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        payload.insert("kind".to_string(), Value::from("scheduled-action-time-window"));
        payload.insert("time_window_id".to_string(), Value::from(window_id.clone()));
        payload.insert("record_id".to_string(), record_id.clone());
        writes.push(write(
            graph_address("time-window", &window_id),
            graph_path("time-window"),
            Value::Object(payload),
        ));
    }

    for action in entries(get_opt(input, "actions"), "actions")? {
        // `action.operation || action.action_id`: undefined (the key is left out of the JSON) when neither is set.
        let action_id_field = member(action, "action_id")?;
        let operation_field = match member(action, "operation")? {
            Some(value) if truthy(value) => Some(value.clone()),
            _ => action_id_field.cloned(),
        };
        let action_id = match action_id_field {
            Some(id) if truthy(id) => to_str(id),
            _ => format!("{record_text}:{}", to_str_opt(operation_field.as_ref())),
        };
        let dispatch = required(member(action, "dispatch")?, "action.dispatch")?;
        required(get_opt(&dispatch, "name"), "action.dispatch.name")?;
        let mut pairs = vec![
            ("kind", Value::from("scheduled-action-action")),
            ("action_id", Value::from(action_id.clone())),
            ("record_id", record_id.clone()),
        ];
        if let Some(operation) = operation_field {
            pairs.push(("operation", operation));
        }
        pairs.push(("dispatch", dispatch));
        writes.push(write(graph_address("action", &action_id), graph_path("action"), js::object(pairs)));
    }

    let write_count = writes.len();
    Ok(js::object(vec![
        ("operation", operation.clone()),
        ("record_id", record_id.clone()),
        ("writes", Value::Array(writes)),
        (
            "receipt_preview",
            js::object(vec![
                ("operation", operation.clone()),
                ("record_id", record_id.clone()),
                ("write_count", js::num(write_count as f64)),
                ("idempotency_key_material", Value::Array(vec![record_id, operation])),
                ("blocked_reason_refs", Value::Array(Vec::new())),
                ("source_descriptor_refs", source_refs),
            ]),
        ),
    ]))
}

/// `buildScheduledActionStateWrite(input)`: the receipt that says an operation ran.
pub fn build_state_write(input: &Value) -> Res<Value> {
    let record_id = required(get_opt(input, "record_id"), "record_id")?;
    let operation = required(get_opt(input, "operation"), "operation")?;
    let observed_at = or_null(get_opt(input, "observed_at"));
    let observed_text = match &observed_at {
        Value::Null => "pending".to_string(),
        value => to_str(value),
    };
    let receipt_id = match get_opt(input, "receipt_id") {
        Some(id) if truthy(id) => to_str(id),
        _ => format!("{}:{}:{}", to_str(&record_id), to_str(&operation), observed_text),
    };
    let reason_refs = or(get_opt(input, "reason_refs"), Value::Array(Vec::new()));
    let source_refs = or(get_opt(input, "source_descriptor_refs"), Value::Array(Vec::new()));
    let writes = vec![write(
        graph_address("receipt", &receipt_id),
        graph_path("receipt"),
        js::object(vec![
            ("kind", Value::from("scheduled-action-receipt")),
            ("receipt_id", Value::from(receipt_id.clone())),
            ("record_id", record_id.clone()),
            ("operation", operation.clone()),
            ("observed_at", observed_at),
            ("reason_refs", reason_refs.clone()),
        ]),
    )];
    Ok(js::object(vec![
        ("operation", operation.clone()),
        ("record_id", record_id.clone()),
        ("writes", Value::Array(writes)),
        (
            "receipt_preview",
            js::object(vec![
                ("operation", operation.clone()),
                ("record_id", record_id.clone()),
                ("write_count", js::num(1.0)),
                ("idempotency_key_material", Value::Array(vec![record_id, operation, Value::from(receipt_id)])),
                ("blocked_reason_refs", reason_refs),
                ("source_descriptor_refs", source_refs),
            ]),
        ),
    ]))
}

/// `buildReplaceTimeWindowWrite(input)`: the record write that replaces the record's time window.
pub fn build_replace_time_window_write(input: &Value) -> Res<Value> {
    let record_id = required(get_opt(input, "record_id"), "record_id")?;
    let mut window = match get_opt(input, "time_window") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let window_id = required(window.get("time_window_id"), "time_window.time_window_id")?;
    window.insert("time_window_id".to_string(), window_id);
    let request = js::object(vec![
        ("operation", Value::from("replace-time-window")),
        ("record_id", record_id),
        ("fields", or(get_opt(input, "fields"), Value::Object(Map::new()))),
        ("time_window", Value::Object(window)),
        ("relationships", or(get_opt(input, "relationships"), Value::Array(Vec::new()))),
        (
            "source_descriptor_refs",
            or(get_opt(input, "source_descriptor_refs"), Value::Array(Vec::new())),
        ),
    ]);
    build_record_write(&request)
}
