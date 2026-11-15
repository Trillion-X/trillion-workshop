// src/native_boot/mcp_local/view_matcher.rs
//
// Purpose: Which rows of a list a saved view's rules let through, for the read-only page of a reach share
// (`account_rights::share_grant::ViewMatcher`). The rules are compiled by the engine's one rules compiler
// (`rule_bindings::compile_rules`) against the operator DATA the account's installed Workshop carries and each row is
// decided by the engine's one formula evaluator (`rule_bindings::evaluator::FormulaBindingEvaluator`); this file adds no
// operator, no comparison and no field name of its own.
//
// Non-Negotiable Invariants:
// - A tree the compiler refuses, leaves unfinished (`incomplete`) or maps to an operator the DATA does not carry is no
//   answer (None): the page says the view cannot be shown, it never guesses which rows match.
// - Only JSON true is a match (the canonical evaluate-over-rows contract); a row the evaluator refuses ends the answer.
// - The work is bounded by the compiler's own limits and its elapsed time.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::LocalSelectedMcp;
use crate::{
    ecma_json::{self, Value},
    rule_bindings::{self, evaluator::FormulaBindingEvaluator},
    workspace_session::owner_wait,
};
use std::time::Instant;

/// `value` as engine JSON, or None when it does not fit the default bounds.
fn engine_json(value: &serde_json::Value) -> Option<Value> {
    ecma_json::parse(value.to_string().as_bytes(), Default::default()).ok()
}

/// The rows of `rows` that pass `rules`, by the compiler over `operators` and the evaluator, within `limits`.
fn decide(operators: &Value, rules: &serde_json::Value, fields: &[serde_json::Value], rows: &[&serde_json::Value],
    limits: rule_bindings::Limits, deadline: Instant,
) -> Option<Vec<bool>> {
    let tree = engine_json(rules)?;
    let fields: Vec<Value> = fields.iter().map(engine_json).collect::<Option<_>>()?;
    let locale = crate::native_boot::tool_label_locale::engine_locale().ok()?;
    let mut text: &crate::tool_label_locale::QualifiedLocale = &locale;
    let compiled = rule_bindings::compile_rules(Some(&tree), &fields, operators, &mut text, limits).ok()?;
    if !compiled.incomplete.is_empty() {
        return None;
    }
    let mut evaluator = FormulaBindingEvaluator;
    rows.iter().map(|row| {
        if Instant::now() >= deadline {
            return None;
        }
        let row = engine_json(row)?;
        Some(matches!(compiled.evaluate(&mut evaluator, &row), Ok(Value::Bool(true))))
    }).collect()
}

impl LocalSelectedMcp {
    /// For each of `rows` whether it passes `rules` over `fields`, or None when the rules cannot be applied.
    pub(super) fn view_matches_rows(&self, rules: &serde_json::Value, fields: &[serde_json::Value], rows: &[&serde_json::Value],
    ) -> Option<Vec<bool>> {
        let limits = rule_bindings::Limits::default();
        let deadline = Instant::now() + limits.elapsed;
        let (_, state_root) = owner_wait::acquire(&self.admission, || Instant::now() >= deadline).ok()?.tool_place();
        let operators = crate::local_account::tools_json(&state_root, "rule-operators").ok()?;
        decide(&operators, rules, fields, rows, limits, deadline)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Operator DATA in the Workshop's own shape (`formula-engine/rules/rule-operators.json`), with the one operator and the
    /// combinators the test's rules use.
    fn operators() -> Value {
        let data = json!({"schema": "formula-engine.rule-operators", "description": "synthetic",
            "combinators": [{"id": "and", "label": "All", "sentence": "and", "op": "op:core.and"}, {"id": "or", "label": "Any", "sentence": "or", "op": "op:core.or"}],
            "operators": [{"id": "is_any_of", "label": "is any of", "chip": "is", "icon": "list-checks", "input": "values", "applies_to": ["choice"],
                "binding": {"$kind": "binding", "select": {"from": "self", "path": {"$field": "path"}},
                    "transform": [{"op": "op:core.in_list", "args": {"values": {"$param": "values"}}}]}}]});
        ecma_json::parse(data.to_string().as_bytes(), Default::default()).unwrap()
    }

    #[test]
    fn the_engines_own_compiler_and_evaluator_decide_which_rows_a_view_lets_through() {
        let rows = [json!({"kind": "purchase"}), json!({"kind": "payment"}), json!({"kind": "purchase"})];
        let refs: Vec<&serde_json::Value> = rows.iter().collect();
        let fields = [json!({"id": "kind", "label": "Kind", "kind": "choice"})];
        let rules = json!({"kind": "group", "combinator": "and", "negate": false,
            "rules": [{"kind": "rule", "field": "kind", "operator": "is_any_of", "params": {"values": ["purchase"]}}]});
        let limits = rule_bindings::Limits::default();
        let deadline = Instant::now() + limits.elapsed;
        assert_eq!(decide(&operators(), &rules, &fields, &refs, limits, deadline), Some(vec![true, false, true]));
        // An operator the DATA does not carry is no answer, never a guess.
        let strange = json!({"kind": "group", "combinator": "and", "negate": false,
            "rules": [{"kind": "rule", "field": "kind", "operator": "no_such_operator", "params": {}}]});
        assert_eq!(decide(&operators(), &strange, &fields, &refs, limits, deadline), None);
        // A tree of no rules lets every row through.
        let empty = json!({"kind": "group", "combinator": "and", "negate": false, "rules": []});
        assert_eq!(decide(&operators(), &empty, &fields, &refs, limits, deadline), Some(vec![true; 3]));
    }
}
