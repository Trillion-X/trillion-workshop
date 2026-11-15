//! crates/evaluate-over-rows/src/lib.rs
//!
//! Purpose
//!   Answer "which of these rows does this binding hold for" inside a
//!   JavaScript host. A host loads a table of plain JSON rows once, patches
//!   single rows as they change, and asks for the indices a binding is true
//!   for. The binding is the ordinary composition-ast `Binding`; every
//!   comparison, boolean combinator and text operation it names is an ops-core
//!   operator reached through `create_core_registry`, exactly as the
//!   formula-engine slot evaluates it.
//!
//! Non-negotiable invariants
//!   - No operator, comparison or field name appears here. A binding that the
//!     slot accepts is accepted here with the same meaning.
//!   - A row matches only when the binding yields JSON `true`. Null, a missing
//!     field, an operator error or any other value is "does not match".
//!   - A binding is parsed once per request, never once per row.
//!   - Rows are held as ops-core `OpValue`s and the binding is a composition-ast
//!     `PreparedBinding`, so reading a large value (a transcript) is a
//!     reference-count bump, never a copy.
//!
//! Host boundary (wasm-bindgen, JSON text in and out; errors throw a string)
//!   replace_rows(rows)      `[row, ...]` replaces the table
//!   patch_rows(patch)       `{"length":n,"set":[{"index":i,"row":{}}]}`
//!   filter_rows(request)    `{"binding":{}}`
//!   evaluate(request)       `{"binding":{}, "input":any}`; the input is `self` for the binding's own
//!                           selection and, as `from: "context"`, the input for every nested argument binding

use std::sync::{Arc, OnceLock};

use composition_ast::binding::ast::{Binding, BindingEvaluationContext, Diagnostic, DiagnosticLevel};
use composition_ast::binding::operators::create_core_registry;
use composition_ast::binding::operators::registry::OperatorResolver;
use composition_ast::binding::prepared::PreparedBinding;
use ops_core::OpValue;
use serde::Deserialize;
use serde_json::Value;

// Evaluating a binding never draws entropy; see Cargo.toml.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn entropy_is_not_offered(_buffer: &mut [u8]) -> Result<(), getrandom_02::Error> {
    Err(getrandom_02::Error::UNSUPPORTED)
}
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
getrandom_02::register_custom_getrandom!(entropy_is_not_offered);

fn operator_resolver() -> &'static OperatorResolver {
    static RESOLVER: OnceLock<OperatorResolver> = OnceLock::new();
    RESOLVER.get_or_init(|| {
        let registry = Arc::new(create_core_registry().expect("core operator registry"));
        Arc::new(move |key: &str| registry.get(key))
    })
}

/// The rows a host has loaded, in the host's own order. The host keeps the
/// index-to-identity map; this table never learns what a row is.
#[derive(Default)]
pub struct RowTable {
    rows: Vec<OpValue>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilterRequest {
    pub binding: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluateRequest {
    pub binding: Value,
    #[serde(default)]
    pub input: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RowPatch {
    pub length: usize,
    #[serde(default)]
    pub set: Vec<RowAt>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RowAt {
    pub index: usize,
    pub row: Value,
}

/// The first error an operator reported and how many rows reported one, so a
/// caller can say "this rule could not be checked" instead of silently
/// showing nothing.
#[derive(Debug, PartialEq)]
pub struct FilterOutcome {
    pub matches: Vec<u32>,
    pub error_rows: u32,
    pub first_error: Option<String>,
}

fn parse_binding(value: Value) -> Result<PreparedBinding, String> {
    let binding: Binding =
        serde_json::from_value(value).map_err(|error| format!("The rule could not be read: {error}"))?;
    Ok(PreparedBinding::prepare(&binding, operator_resolver()))
}

fn first_error(diagnostics: Vec<Diagnostic>) -> Option<String> {
    diagnostics
        .into_iter()
        .find(|diagnostic| matches!(diagnostic.level, DiagnosticLevel::Error))
        .map(|diagnostic| match diagnostic.data.as_ref().and_then(|data| data.get("error")) {
            Some(detail) => format!("{}: {}", diagnostic.message, detail),
            None => diagnostic.message,
        })
}

impl RowTable {
    pub fn replace(&mut self, rows: Vec<Value>) {
        self.rows = rows.into_iter().map(OpValue::from).collect();
    }

    pub fn patch(&mut self, patch: RowPatch) -> Result<(), String> {
        self.rows.resize(patch.length, OpValue::null());
        for RowAt { index, row } in patch.set {
            let slot = self
                .rows
                .get_mut(index)
                .ok_or_else(|| format!("Row {index} is outside a table of {} rows.", patch.length))?;
            *slot = OpValue::from(row);
        }
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn filter(&self, request: FilterRequest) -> Result<FilterOutcome, String> {
        let binding = parse_binding(request.binding)?;
        let context = BindingEvaluationContext::default();
        let mut outcome = FilterOutcome { matches: Vec::new(), error_rows: 0, first_error: None };
        for (index, row) in self.rows.iter().enumerate() {
            let result = binding.evaluate(row, &context, operator_resolver());
            if let Some(message) = first_error(result.diagnostics) {
                outcome.error_rows += 1;
                if outcome.first_error.is_none() {
                    outcome.first_error = Some(message);
                }
                continue;
            }
            if matches!(result.value.node(), ops_core::value::OpNode::Bool(true)) {
                outcome.matches.push(index as u32);
            }
        }
        Ok(outcome)
    }
}

pub fn evaluate_request(request: EvaluateRequest) -> Result<Value, String> {
    let binding = parse_binding(request.binding)?;
    // The input is also the evaluation context (`from: "context"`): a transform argument's nested binding reads
    // the pipeline's current value through `self`, so it reaches the input itself only through this root.
    let context = BindingEvaluationContext::default().with_context(request.input.clone());
    let result = binding.evaluate(&OpValue::from(request.input), &context, operator_resolver());
    match first_error(result.diagnostics) {
        Some(message) => Err(message),
        None => Ok(result.value.into_inner()),
    }
}

// -----------------------------------------------------------------------------
// Host boundary (wasm-bindgen; JSON text in, JSON text out)
// -----------------------------------------------------------------------------

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod host {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;
    use wasm_bindgen::prelude::*;

    thread_local! {
        static TABLE: RefCell<RowTable> = RefCell::new(RowTable::default());
    }

    fn decode<T: for<'de> Deserialize<'de>>(text: &str) -> Result<T, String> {
        serde_json::from_str(text).map_err(|error| format!("The request could not be read: {error}"))
    }

    /// `[row, ...]` replaces the table. Returns `{"length":n}`.
    #[wasm_bindgen]
    pub fn replace_rows(rows: &str) -> Result<String, String> {
        let rows = decode::<Vec<Value>>(rows)?;
        let length = rows.len();
        TABLE.with(|table| table.borrow_mut().replace(rows));
        Ok(json!({ "length": length }).to_string())
    }

    /// `{"length":n,"set":[{"index":i,"row":{}}]}`. Returns `{"length":n}`.
    #[wasm_bindgen]
    pub fn patch_rows(patch: &str) -> Result<String, String> {
        let patch = decode::<RowPatch>(patch)?;
        TABLE.with(|table| {
            let mut table = table.borrow_mut();
            table.patch(patch)?;
            Ok(json!({ "length": table.len() }).to_string())
        })
    }

    /// `{"binding":{}}`. Returns
    /// `{"matches":[index],"error_rows":n,"first_error":text|null}`.
    #[wasm_bindgen]
    pub fn filter_rows(request: &str) -> Result<String, String> {
        let request = decode::<FilterRequest>(request)?;
        let outcome = TABLE.with(|table| table.borrow().filter(request))?;
        Ok(json!({
            "matches": outcome.matches,
            "error_rows": outcome.error_rows,
            "first_error": outcome.first_error,
        })
        .to_string())
    }

    /// `{"binding":{},"input":any}`. Returns `{"value":any}`.
    #[wasm_bindgen]
    pub fn evaluate(request: &str) -> Result<String, String> {
        let value = evaluate_request(decode::<EvaluateRequest>(request)?)?;
        Ok(json!({ "value": value }).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(path: &str, op: &str, value: Value) -> Value {
        json!({"$kind":"binding","select":{"from":"self","path":path},"transform":[{"op":op,"args":{"value":value}}]})
    }

    fn group(op: &str, members: Vec<Value>, negate: bool) -> Value {
        let mut transform = vec![json!({"op":op,"args":{"values":members}})];
        if negate {
            transform.push(json!({"op":"op:core.not"}));
        }
        json!({"$kind":"binding","select":{"from":"self"},"transform":transform})
    }

    fn table() -> RowTable {
        let mut table = RowTable::default();
        table.replace(vec![
            json!({"duration": 95.0, "words": "then the forehand swing", "labels": ["drill"], "kind": "original"}),
            json!({"duration": 30.0, "words": "backhand only", "labels": ["junk"], "kind": "export"}),
            json!({"duration": 240.0, "words": "Forehand and serve", "labels": ["junk", "drill"], "kind": "original"}),
            json!({"duration": null, "words": "", "labels": [], "kind": "project"}),
        ]);
        table
    }

    fn matches(binding: Value) -> Vec<u32> {
        table().filter(FilterRequest { binding }).expect("filter").matches
    }

    #[test]
    fn and_or_not_compose_through_nested_bindings() {
        let long = rule("duration", "op:core.gt", json!(60));
        let short = rule("duration", "op:core.lt", json!(40));
        assert_eq!(matches(group("op:core.and", vec![long.clone()], false)), vec![0, 2]);
        assert_eq!(matches(group("op:core.or", vec![long.clone(), short.clone()], false)), vec![0, 1, 2]);
        // Tristate: a row whose duration is unknown is neither long nor
        // short, and NOT of unknown stays unknown, so it never matches.
        assert_eq!(matches(group("op:core.or", vec![long.clone(), short.clone()], true)), Vec::<u32>::new());
        assert_eq!(matches(group("op:core.and", vec![long], true)), vec![1]);
    }

    #[test]
    fn range_is_two_comparisons_and_null_never_matches() {
        let between = group(
            "op:core.and",
            vec![rule("duration", "op:core.ge", json!(30)), rule("duration", "op:core.le", json!(120))],
            false,
        );
        assert_eq!(matches(between), vec![0, 1]);
    }

    #[test]
    fn multi_select_any_of_a_single_value_field() {
        let any = json!({"$kind":"binding","select":{"from":"self","path":"kind"},"transform":[{"op":"op:core.in_list","args":{"values":["export","project"]}}]});
        assert_eq!(matches(any), vec![1, 3]);
    }

    #[test]
    fn multi_valued_field_holds_a_value() {
        let has_junk = json!({"$kind":"binding","select":{"from":"self","path":"labels"},"transform":[{"op":"op:core.index_of","args":{"value":"junk"}},{"op":"op:core.ge","args":{"value":0}}]});
        assert_eq!(matches(has_junk.clone()), vec![1, 2]);
        let not_junk = group("op:core.and", vec![has_junk], true);
        assert_eq!(matches(not_junk), vec![0, 3]);
    }

    #[test]
    fn transcript_contains_ignores_case_through_lower() {
        let contains = json!({"$kind":"binding","select":{"from":"self","path":"words"},"transform":[{"op":"op:core.lower"},{"op":"op:core.contains","args":{"value":"forehand"}}]});
        assert_eq!(matches(contains), vec![0, 2]);
    }

    #[test]
    fn patch_replaces_one_row_and_resizes() {
        let mut rows = table();
        rows.patch(RowPatch { length: 5, set: vec![RowAt { index: 4, row: json!({"duration": 400}) }] }).expect("patch");
        let found = rows
            .filter(FilterRequest { binding: rule("duration", "op:core.gt", json!(300)) })
            .expect("filter");
        assert_eq!(found.matches, vec![4]);
        assert!(rows.patch(RowPatch { length: 2, set: vec![RowAt { index: 3, row: json!({}) }] }).is_err());
    }

    // Arithmetic operators answer exact decimals as text ("3", "0.25"), the same as `mul` always has.
    fn evaluated(binding: Value, input: Value) -> Value {
        evaluate_request(EvaluateRequest { binding, input }).expect("evaluate")
    }

    #[test]
    fn a_field_divides_by_another_field_of_the_input() {
        let ratio = json!({"$kind":"binding","select":{"from":"self","path":["views"]},"transform":[
            {"op":"op:core.div","args":{"value":{"$kind":"binding","select":{"from":"context","path":["channel_median"]}}}}]});
        assert_eq!(evaluated(ratio.clone(), json!({"views": 300.0, "channel_median": 100.0})), json!("3"));
        assert_eq!(evaluated(ratio, json!({"views": 50.0, "channel_median": 200.0})), json!("0.25"));
    }

    #[test]
    fn a_nested_argument_reaches_the_input_while_self_stays_the_pipeline_value() {
        let both = json!({"$kind":"binding","select":{"from":"self","path":["views"]},"transform":[
            {"op":"op:core.mul","args":{"value":{"$kind":"binding","select":{"from":"self"}}}},
            {"op":"op:core.add","args":{"value":{"$kind":"binding","select":{"from":"context","path":["bonus"]}}}}]});
        // views * views (self is the pipeline value, 4) then + the input's bonus (1).
        assert_eq!(evaluated(both, json!({"views": 4.0, "bonus": 1.0})), json!("17"));
    }

    #[test]
    fn the_largest_of_a_list_of_selections_is_one_formula() {
        // A literal list whose items are selections (each a nested binding over the input) is one selection; max takes
        // the largest. The plain 0 keeps the answer from going below nothing.
        let difference = |least: &str, live: &str| json!({"$kind":"binding","select":{"from":"self","path":[least]},
            "transform":[{"op":"op:core.sub","args":{"value":{"$kind":"binding","select":{"from":"context","path":[live]}}}}]});
        let largest = json!({"$kind":"binding","select":{"from":"literal","value":[0,
            difference("least_voters", "voters"), difference("least_copy_keepers", "copy_keepers")]},
            "transform":[{"op":"op:core.max"}]});
        let input = |voters: f64, keepers: f64| json!({"least_voters": 3.0, "voters": voters, "least_copy_keepers": 2.0, "copy_keepers": keepers});
        let mut listed = largest.clone();
        listed.as_object_mut().unwrap().remove("transform");
        assert_eq!(evaluated(listed, input(1.0, 2.0)), json!([0, "2", "0"]), "each selection is evaluated");
        assert_eq!(evaluated(largest.clone(), input(1.0, 2.0)), json!("2"));
        assert_eq!(evaluated(largest.clone(), input(3.0, 1.0)), json!("1"));
        assert_eq!(evaluated(largest, input(5.0, 5.0)), json!("0"), "never below the plain 0");
        // A literal with no selection inside is the value as written.
        assert_eq!(evaluated(json!({"$kind":"binding","select":{"from":"literal","value":[1, {"a": 2}]}}), json!(null)), json!([1, {"a": 2}]));
    }

    #[test]
    fn unreadable_binding_is_an_error_not_an_empty_answer() {
        assert!(table().filter(FilterRequest { binding: json!({"select": 3}) }).is_err());
    }
}
