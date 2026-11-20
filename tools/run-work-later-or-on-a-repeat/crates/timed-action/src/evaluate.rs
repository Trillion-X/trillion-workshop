//! crates/timed-action/src/evaluate.rs
//!
//! Purpose
//!   The generic due-and-unfired evaluator for the scheduled-action graph: it returns exactly the action fires that are
//!   due and not yet done. It knows nothing about any feature domain. The graph is timed-action's own shape, separate
//!   arrays joined by record_id: time_windows, actions and receipts. This is the Rust reading of
//!   do-work/evaluate-due-scheduled-actions.ts.
//!
//! Non-negotiable invariants
//!   1. A due instant is an explicit due_at, else the window's start. A record with no window is unscheduled and never
//!      fires (fail closed).
//!   2. A fire is deduplicated by (record_id, operation). The operation is the action's `operation`, else its action_id.
//!   3. An action with no dispatch.name is unscheduled work: never emitted (fail closed).
//!   4. The clock is an input (`now`). Nothing here reads a clock.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::date;
use crate::js::{self, get, get_opt, json_text, key_of, list, to_str, Key, Refused, Res};

/// `actionOperation(action)`: the operation a receipt names, else the action's id, else null.
pub fn action_operation(action: &Value) -> Value {
    let operation = get(action, "operation");
    if !operation.is_null() {
        return operation.clone();
    }
    get(action, "action_id").clone()
}

/// `receiptKey(record_id, operation)`: the identity a receipt and an action agree on.
pub fn receipt_key(record_id: &Value, operation: &Value) -> String {
    json_text(&Value::Array(vec![record_id.clone(), operation.clone()]))
}

/// `resolveDueAt(window)`: the window's explicit due_at, else its start; null when neither is set.
pub fn resolve_due_at(window: Option<&Value>) -> Value {
    let window = window.unwrap_or(&js::NULL);
    let due_at = get(window, "due_at");
    if !due_at.is_null() {
        return due_at.clone();
    }
    get(window, "start").clone()
}

/// The windows by record_id; a later window for the same record replaces an earlier one, as a JavaScript Map does.
pub fn window_by_record(time_windows: &[Value]) -> HashMap<Key, &Value> {
    let mut windows = HashMap::new();
    for window in time_windows {
        let record_id = get(window, "record_id");
        if record_id.is_null() {
            continue;
        }
        if let Some(key) = key_of(Some(record_id)) {
            windows.insert(key, window);
        }
    }
    windows
}

/// The receipt keys already recorded: each receipt with a record_id names (record_id, operation).
pub fn fired_keys(receipts: &[Value]) -> HashSet<String> {
    receipts
        .iter()
        .filter(|receipt| !get(receipt, "record_id").is_null())
        .map(|receipt| receipt_key(get(receipt, "record_id"), get(receipt, "operation")))
        .collect()
}

/// Whether an action names its own dispatch (`action.dispatch?.name != null`): a row without one is never fired.
pub fn dispatch_named(action: &Value) -> bool {
    !get(get(action, "dispatch"), "name").is_null()
}

/// The result of one evaluation, before it is written as JSON.
pub struct Evaluation {
    pub evaluated_at: String,
    pub scanned_action_count: usize,
    pub already_fired_count: usize,
    pub due: Vec<Value>,
}

impl Evaluation {
    pub fn to_value(&self) -> Value {
        js::object(vec![
            ("evaluated_at", Value::from(self.evaluated_at.clone())),
            ("scanned_action_count", js::num(self.scanned_action_count as f64)),
            ("already_fired_count", js::num(self.already_fired_count as f64)),
            ("due_count", js::num(self.due.len() as f64)),
            ("due", Value::Array(self.due.clone())),
        ])
    }
}

/// `evaluateDueScheduledActions({ time_windows, actions, receipts, now })` with `now` already read as milliseconds.
pub fn evaluate(time_windows: &[Value], actions: &[Value], receipts: &[Value], now_ms: f64) -> Res<Evaluation> {
    let windows = window_by_record(time_windows);
    let fired = fired_keys(receipts);
    let mut due = Vec::new();
    for action in actions {
        let record_id = get(action, "record_id");
        if record_id.is_null() {
            continue;
        }
        let window = key_of(Some(record_id)).and_then(|key| windows.get(&key).copied());
        let due_at = resolve_due_at(window);
        if due_at.is_null() {
            continue;
        }
        let due_ms = date::parse(&to_str(&due_at));
        if due_ms.is_nan() || now_ms < due_ms {
            continue;
        }
        let operation = action_operation(action);
        if fired.contains(&receipt_key(record_id, &operation)) {
            continue;
        }
        if !dispatch_named(action) {
            continue;
        }
        let window_field = |key: &str| window.map_or(Value::Null, |window| get(window, key).clone());
        due.push(js::object(vec![
            ("record_id", record_id.clone()),
            ("operation", operation),
            ("action_id", get(action, "action_id").clone()),
            ("time_window_id", window_field("time_window_id")),
            ("due_at", due_at),
            ("evaluated_at", Value::from(date::to_iso(now_ms)?)),
        ]));
    }
    Ok(Evaluation {
        evaluated_at: date::to_iso(now_ms)?,
        scanned_action_count: actions.len(),
        already_fired_count: fired.len(),
        due,
    })
}

/// The `time_windows`, `actions` and `receipts` of a request, each read as a list.
pub fn graph_of(input: &Value) -> (&[Value], &[Value], &[Value]) {
    (
        list(get(input, "time_windows")),
        list(get(input, "actions")),
        list(get(input, "receipts")),
    )
}

/// Whether a value is set (not null and not missing), as `x != null` reads it.
pub fn is_set(value: Option<&Value>) -> bool {
    value.is_some_and(|value| !value.is_null())
}

/// The refusal for a request with no `now`: the TypeScript would read the system clock here, and this engine does not.
pub fn now_required() -> Refused {
    Refused::error("evaluate-due-scheduled-actions: `now` is required; the caller reads the clock, not this engine")
}

/// `input.now` read as the TypeScript reads it: Date.parse of its text.
pub fn now_of(input: &Value) -> Res<f64> {
    let now = get_opt(input, "now");
    if !is_set(now) {
        return Err(now_required());
    }
    let ms = date::parse(&to_str(now.unwrap_or(&js::NULL)));
    if ms.is_nan() {
        return Err(Refused::error("evaluate-due-scheduled-actions: `now` is not a parseable timestamp"));
    }
    Ok(ms)
}
