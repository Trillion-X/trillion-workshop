//! A keep rule's condition decided by the engine's one formula owner: the rule tree of the row's `expire_when` (the formula
//! engine's `{tree, fields}`) compiled by `rule_bindings::compile_rules` against the operator DATA the account's installed
//! Workshop carries, and each record decided by `evaluator::FormulaBindingEvaluator` over the record's own values plus one
//! fact, its age in milliseconds, under the name the store's settings give it. It adds no operator, no comparison and no
//! field name of its own.
//!
//! Non-Negotiable Invariants:
//! - A tree the compiler refuses, leaves unfinished (`incomplete`) or maps to an operator the DATA does not carry compiles to
//!   nothing: the rule is refused, never guessed at.
//! - Only JSON true is expired (the canonical evaluate-over-rows contract); a record the evaluator refuses, or that does not
//!   fit the engine's JSON bounds, is not expired.
//! - The work is bounded by the compiler's own limits.
//!
//! AI Assistant Directive:
//! The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{evaluator::FormulaBindingEvaluator, Limits, TextSemantics};
use crate::ecma_json::{self, Value};
use serde_json::Value as Json;

/// `value` as engine JSON, or None when it does not fit the default bounds.
fn engine_json(value: &Json) -> Option<Value> {
    ecma_json::parse(value.to_string().as_bytes(), Default::default()).ok()
}

/// The decision of `when` (`{tree, fields}`) over `operators`: given a record's value and its age in milliseconds, whether the
/// record has expired. The age is the fact `age_fact`, a number field the tree may read; a `fields` list that does not
/// declare it is given it. None when `when` cannot be compiled.
pub fn compile(operators: &Value, text: &mut impl TextSemantics, when: &Json, age_fact: &str) -> Option<Box<dyn FnMut(&Json, u64) -> bool>> {
    let tree = engine_json(when.get("tree")?)?;
    let mut fields: Vec<Json> = when.get("fields")?.as_array()?.clone();
    if !fields.iter().any(|field| field.get("id").and_then(Json::as_str) == Some(age_fact)) {
        fields.push(serde_json::json!({"id": age_fact, "label": age_fact, "kind": "duration"}));
    }
    let fields: Vec<Value> = fields.iter().map(engine_json).collect::<Option<_>>()?;
    let compiled = super::compile_rules(Some(&tree), &fields, operators, text, Limits::default()).ok()?;
    if !compiled.incomplete.is_empty() {
        return None;
    }
    let age_fact = age_fact.to_owned();
    let mut evaluator = FormulaBindingEvaluator;
    Some(Box::new(move |value: &Json, age_ms: u64| {
        let mut row = match value {
            Json::Object(row) => row.clone(),
            _ => return false,
        };
        row.insert(age_fact.clone(), Json::from(age_ms));
        let Some(row) = engine_json(&Json::Object(row)) else { return false };
        matches!(compiled.evaluate(&mut evaluator, &row), Ok(Value::Bool(true)))
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Operator DATA in the Workshop's own shape (`formula-engine/rules/rule-operators.json`), with one number operator and the
    /// combinators the test's rules use.
    fn operators() -> Value {
        let data = json!({"schema": "formula-engine.rule-operators", "description": "synthetic",
            "combinators": [{"id": "and", "label": "All", "sentence": "and", "op": "op:core.and"}, {"id": "or", "label": "Any", "sentence": "or", "op": "op:core.or"}],
            "operators": [
                {"id": "greater_than", "label": "is greater than", "chip": ">", "icon": "chevron-right", "input": "value", "applies_to": ["number", "duration"],
                    "binding": {"$kind": "binding", "select": {"from": "self", "path": {"$field": "path"}},
                        "transform": [{"op": "op:core.gt", "args": {"value": {"$param": "value"}}}]}},
                {"id": "is_any_of", "label": "is any of", "chip": "is", "icon": "list-checks", "input": "values", "applies_to": ["choice"],
                    "binding": {"$kind": "binding", "select": {"from": "self", "path": {"$field": "path"}},
                        "transform": [{"op": "op:core.in_list", "args": {"values": {"$param": "values"}}}]}}]});
        ecma_json::parse(data.to_string().as_bytes(), Default::default()).unwrap()
    }

    fn locale() -> std::sync::Arc<crate::tool_label_locale::QualifiedLocale> {
        crate::native_boot::tool_label_locale::engine_locale().unwrap()
    }

    #[test]
    fn a_rule_tree_over_the_records_values_and_its_age_decides_expiry() {
        let locale = locale();
        let mut text: &crate::tool_label_locale::QualifiedLocale = &locale;
        let when = json!({"tree": {"kind": "group", "combinator": "and", "negate": false, "rules": [
                {"kind": "rule", "field": "status", "operator": "is_any_of", "params": {"values": ["done"]}},
                {"kind": "rule", "field": "age_ms", "operator": "greater_than", "params": {"value": 1000}}]},
            "fields": [{"id": "status", "label": "Status", "kind": "choice"}]});
        let mut expired = compile(&operators(), &mut text, &when, "age_ms").expect("the tree compiles");
        assert!(expired(&json!({"status": "done"}), 2000), "done and old expires");
        assert!(!expired(&json!({"status": "done"}), 500), "done but new stays");
        assert!(!expired(&json!({"status": "waiting"}), 2000), "old but not done stays");
        assert!(!expired(&json!("not a record"), 2000), "a value that is not a record is never expired");
    }

    #[test]
    fn a_tree_the_operator_data_cannot_compile_is_no_condition() {
        let locale = locale();
        let mut text: &crate::tool_label_locale::QualifiedLocale = &locale;
        let strange = json!({"tree": {"kind": "group", "combinator": "and", "negate": false,
            "rules": [{"kind": "rule", "field": "age_ms", "operator": "no_such_operator", "params": {}}]}, "fields": []});
        assert!(compile(&operators(), &mut text, &strange, "age_ms").is_none());
        assert!(compile(&operators(), &mut text, &json!({"fields": []}), "age_ms").is_none(), "no tree is no condition");
    }
}
