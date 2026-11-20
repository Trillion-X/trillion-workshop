//! crates/formula-engine/src/host.rs
//!
//! Purpose
//!   The formula engine as a JavaScript host (a page, a Worker, a Node tool) calls it: plain objects in, plain objects
//!   out, through wasm-bindgen. Each export is one of src/requests.rs (or the classifier), so a host calls the engine
//!   directly and never keeps a compiler, a guard or a request check of its own.
//!
//! Non-negotiable invariants
//!   - A value crosses as JSON text (the host's own JSON.stringify and JSON.parse), so what a host sends reads exactly
//!     as it has always been sent; a value that contains itself has no JSON text and is refused as the `cycle` guard.
//!   - A refusal is thrown as an Error with the engine's words; a guard's refusal also carries `code: "formula_guard"`,
//!     `guard` (which limit) and `limit`.
//!   - The loaded table (replaceRows, patchRows, filterLoadedRows) is for a host that owns this module alone and keeps
//!     its rows loaded between calls (a page's measure engine).

use serde_json::Value;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

use crate::guards::now_ms;
use crate::{classify, filter_with, limits, ready, requests, Refused, RowTable};

thread_local! {
    static TABLE: RefCell<RowTable> = RefCell::new(RowTable::default());
}

fn thrown(refused: Refused) -> JsValue {
    let error = js_sys::Error::new(refused.message());
    if let Refused::Guard(refusal) = &refused {
        let set = |key: &str, value: JsValue| {
            let _ = js_sys::Reflect::set(&error, &JsValue::from_str(key), &value);
        };
        set("code", JsValue::from_str("formula_guard"));
        set("guard", JsValue::from_str(&refusal.guard));
        set("limit", refusal.limit.as_ref().and_then(Value::as_f64).map(JsValue::from_f64).unwrap_or(JsValue::NULL));
    }
    error.into()
}

fn read(value: &JsValue) -> Result<Value, JsValue> {
    if value.is_undefined() {
        return Ok(Value::Null);
    }
    let text = js_sys::JSON::stringify(value).map_err(|_| thrown(Refused::Guard(limits().refusal("cycle", &[]))))?;
    let text: String = text.into();
    serde_json::from_str(&text).map_err(|error| thrown(crate::sentence(format!("The request could not be read: {error}"))))
}

fn write(value: &Value) -> Result<JsValue, JsValue> {
    js_sys::JSON::parse(&value.to_string())
}

fn answer(result: Result<Value, Refused>) -> Result<JsValue, JsValue> {
    write(&result.map_err(thrown)?)
}

/// `{records, fields, tree?, operators?}` -> `{total, matches, kept, records, reads, incomplete, error_rows, first_error}`.
#[wasm_bindgen(js_name = filterRecords)]
pub fn filter_records(request: JsValue) -> Result<JsValue, JsValue> {
    answer(requests::filter_records(&read(&request)?, &now_ms))
}

/// `{tree, fields, operators?}` -> `{binding, reads, incomplete}`.
#[wasm_bindgen(js_name = compileRules)]
pub fn compile_rules(request: JsValue) -> Result<JsValue, JsValue> {
    answer(requests::compile_rules(&read(&request)?))
}

/// `{tree, facts, operators?}` -> whether the tree holds over the facts.
#[wasm_bindgen]
pub fn holds(request: JsValue) -> Result<bool, JsValue> {
    requests::holds(&read(&request)?, &now_ms).map_err(thrown)
}

/// `{tests, row, present?}` -> whether every test holds over the row.
#[wasm_bindgen(js_name = testsHold)]
pub fn tests_hold(request: JsValue) -> Result<bool, JsValue> {
    requests::tests_hold(&read(&request)?, &now_ms).map_err(thrown)
}

/// `{rows, binding}` -> `{matches, error_rows, first_error}`.
#[wasm_bindgen(js_name = filterRows)]
pub fn filter_rows(request: JsValue) -> Result<JsValue, JsValue> {
    answer(requests::filter_rows(&read(&request)?, &now_ms))
}

/// `{binding, input}` -> `{value}`.
#[wasm_bindgen]
pub fn evaluate(request: JsValue) -> Result<JsValue, JsValue> {
    answer(requests::evaluate(&read(&request)?, &now_ms))
}

/// `{text}` -> `{binding}`: a formula written as text, as the binding it means.
#[wasm_bindgen(js_name = compileText)]
pub fn compile_text(request: JsValue) -> Result<JsValue, JsValue> {
    answer(requests::compile_text(&read(&request)?))
}

/// `{binding, rows}` -> `{values, errors}`.
#[wasm_bindgen(js_name = evaluateFormula)]
pub fn evaluate_formula(request: JsValue) -> Result<JsValue, JsValue> {
    answer(requests::evaluate_formula(&read(&request)?, &now_ms))
}

/// `{field_kind?, operators?}` -> `{combinators, comparisons, field_kinds}`.
#[wasm_bindgen(js_name = listComparisons)]
pub fn list_comparisons(request: JsValue) -> Result<JsValue, JsValue> {
    answer(requests::list_comparisons(&read(&request)?))
}

/// `{facts, rules, record, now_ms?}` -> `{result: {key, label, tone, severity} | null}`.
#[wasm_bindgen(js_name = classifyRecord)]
pub fn classify_record(request: JsValue) -> Result<JsValue, JsValue> {
    answer(classify::classify_record(&read(&request)?))
}

/// `[row, ...]` replaces the loaded table; answers its length.
#[wasm_bindgen(js_name = replaceRows)]
pub fn replace_rows(rows: JsValue) -> Result<usize, JsValue> {
    let rows = match read(&rows)? {
        Value::Array(rows) => rows,
        _ => return Err(thrown(crate::sentence("rows must be a list of values."))),
    };
    Ok(TABLE.with(|table| {
        let mut table = table.borrow_mut();
        table.replace(rows);
        table.rows.len()
    }))
}

/// `{length, set: [{index, row}]}` resizes the loaded table and replaces single rows; answers its length.
#[wasm_bindgen(js_name = patchRows)]
pub fn patch_rows(patch: JsValue) -> Result<usize, JsValue> {
    let patch = read(&patch)?;
    let length = patch["length"].as_u64().ok_or_else(|| thrown(crate::sentence("A patch names its length.")))? as usize;
    let set = patch["set"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| entry["index"].as_u64().map(|index| (index as usize, entry["row"].clone())))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| thrown(crate::sentence("Each patched row names its index.")))?;
    TABLE.with(|table| {
        let mut table = table.borrow_mut();
        table.patch(length, set).map_err(thrown)?;
        Ok(table.rows.len())
    })
}

/// A binding over the loaded table: `{matches, error_rows, first_error}`. No binding holds for every row.
#[wasm_bindgen(js_name = filterLoadedRows)]
pub fn filter_loaded_rows(binding: JsValue) -> Result<JsValue, JsValue> {
    let binding = read(&binding)?;
    let outcome = TABLE.with(|table| -> Result<crate::Outcome, Refused> {
        let table = table.borrow();
        if binding.is_null() {
            return Ok(crate::Outcome { matches: (0..table.rows.len() as u32).collect(), ..Default::default() });
        }
        filter_with(&ready(&binding)?, &table.rows, &now_ms)
    });
    let outcome = outcome.map_err(thrown)?;
    write(&serde_json::json!({"matches": outcome.matches, "error_rows": outcome.error_rows, "first_error": outcome.first_error}))
}
