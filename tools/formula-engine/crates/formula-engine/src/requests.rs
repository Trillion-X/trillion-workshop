//! crates/formula-engine/src/requests.rs
//!
//! Purpose
//!   One function per thing a caller asks the formula engine, each taking the request object as JSON. A request the
//!   engine cannot run is refused with a sentence that says what to send. The comparisons are DATA (the default rows,
//!   or the `operators` a request brings); no field, comparison or value is named here.
//!
//!   filter_records    {records, fields, tree?, operators?} -> {total, matches, kept, records, reads, incomplete,
//!                     error_rows, first_error}: the rows a person's rule tree keeps (tool:filter-rows-by-rules)
//!   compile_rules     {tree, fields, operators?} -> {binding, reads, incomplete}: the tree as one binding (null:
//!                     every row); a group whose combinator is not listed is joined by the first listed one
//!   holds             {tree, facts, operators?} -> bool: whether a tree holds over one set of facts, keyed by field
//!   tests_hold        {tests, row, present?} -> bool: whether the short-spelling tests hold over one row
//!   filter_rows       {rows, binding} -> {matches, error_rows, first_error}: one binding over rows
//!   evaluate          {binding, input} -> {value}: one binding over one value
//!   evaluate_formula  {binding, rows} -> {values, errors}: one binding over each row (tool:evaluate-a-formula)
//!   list_comparisons  {field_kind?, operators?} -> {combinators, comparisons, field_kinds} (tool:list-comparisons)

use serde_json::{json, Map, Value};
use std::collections::HashSet;

use crate::rules::{fields_of_tree, tree_of_tests, Vocabulary};
use crate::{compiled, default_vocabulary, evaluate_with, filter_with, ready, sentence, Refused};
use ops_core::OpValue;

type Answer = Result<Value, Refused>;

fn need(ok: bool, words: &str) -> Result<(), Refused> {
    if ok { Ok(()) } else { Err(sentence(words)) }
}

fn is_path(value: &Value) -> bool {
    value.as_array().is_some_and(|steps| steps.iter().all(|step| step.is_string() || step.as_u64().is_some()))
}

fn list_of(ids: &[&str]) -> String {
    ids.join(", ")
}

/// The request's own comparison rows, checked, or None for the default ones.
fn operators_of(request: &Value) -> Result<Option<Vocabulary>, Refused> {
    let Some(operators) = request.get("operators").filter(|operators| !operators.is_null()) else {
        return Ok(None);
    };
    need(
        operators.is_object() && operators["operators"].is_array() && operators["combinators"].is_array(),
        "operators must be { combinators: [...], operators: [...] }, the shape of the formula engine's rule-operators.json.",
    )?;
    let mut joins: Vec<&str> = Vec::new();
    for row in default_vocabulary().data["combinators"].as_array().into_iter().flatten() {
        if let Some(op) = row["op"].as_str() {
            if !joins.contains(&op) {
                joins.push(op);
            }
        }
    }
    let combinators = operators["combinators"].as_array().expect("checked");
    need(
        !combinators.is_empty()
            && combinators.iter().all(|row| row.is_object() && row["id"].is_string() && row["op"].as_str().is_some_and(|op| joins.contains(&op))),
        &format!("every combinator needs an id and an op the formula engine joins rules with ({}).", list_of(&joins)),
    )?;
    need(
        operators["operators"].as_array().expect("checked").iter().all(|row| {
            row.is_object()
                && row["id"].is_string()
                && row["applies_to"].is_array()
                && (row["binding"].is_object() || row["parts"].get(0).is_some_and(|part| part["binding"].is_object()))
        }),
        "every comparison needs an id, applies_to and a binding (or parts).",
    )?;
    Ok(Some(Vocabulary::new(operators.clone())))
}

/// Every group names a combinator the vocabulary holds: a group is never joined by a guess.
fn check_combinators(node: &Value, vocabulary: &Vocabulary) -> Result<(), Refused> {
    if !node.is_object() || node["kind"].as_str() != Some("group") {
        return Ok(());
    }
    let ids: Vec<&str> = vocabulary.data["combinators"].as_array().into_iter().flatten().filter_map(|row| row["id"].as_str()).collect();
    let named = node.get("combinator").cloned().unwrap_or(Value::Null);
    need(
        named.as_str().is_some_and(|id| ids.contains(&id)),
        &format!("a group's combinator {} is not one of {}; a group is never joined by a guess.", named, list_of(&ids)),
    )?;
    for member in node["rules"].as_array().into_iter().flatten() {
        check_combinators(member, vocabulary)?;
    }
    Ok(())
}

fn check_fields(fields: &Value) -> Result<&Vec<Value>, Refused> {
    let list = fields.as_array().filter(|list| {
        list.iter().all(|field| {
            field.is_object()
                && field["id"].is_string()
                && field["kind"].is_string()
                && (field.get("path").is_none() || field["path"].is_null() || is_path(&field["path"]))
        })
    });
    let list = list.ok_or_else(|| {
        sentence("fields must be a list of { id, kind, path? }, path being a list of keys and positions into a record (the id by default).")
    })?;
    let ids: HashSet<&str> = list.iter().filter_map(|field| field["id"].as_str()).collect();
    need(ids.len() == list.len(), "two fields share an id; each field id must be its own.")?;
    Ok(list)
}

fn check_tree(tree: &Value) -> Result<(), Refused> {
    need(
        tree.is_null() || tree.is_object(),
        "tree must be a group { kind: \"group\", combinator, negate, rules } or a rule { kind: \"rule\", field, operator, params }.",
    )
}

fn as_rows(values: &[Value]) -> Vec<OpValue> {
    values.iter().cloned().map(OpValue::from).collect()
}

/// The rows of a list that a person's rule tree keeps, with the rules it could not use.
pub fn filter_records(request: &Value, clock: &dyn Fn() -> f64) -> Answer {
    need(request.is_object(), "Send an object with records, fields and a rule tree.")?;
    let records = request["records"]
        .as_array()
        .filter(|records| records.iter().all(Value::is_object))
        .ok_or_else(|| sentence("records must be a list of objects."))?;
    let fields = check_fields(&request["fields"])?;
    check_tree(&request["tree"])?;
    let own = operators_of(request)?;
    check_combinators(&request["tree"], own.as_ref().unwrap_or_else(|| default_vocabulary()))?;
    let kept = compiled(request.get("tree"), fields, own.as_ref())?;
    let outcome = match &kept.ready {
        None => crate::Outcome { matches: (0..records.len() as u32).collect(), ..Default::default() },
        Some(ready) => filter_with(ready, &as_rows(records), clock)?,
    };
    Ok(json!({
        "total": records.len(),
        "matches": outcome.matches,
        "kept": outcome.matches.len(),
        "records": outcome.matches.iter().map(|at| records[*at as usize].clone()).collect::<Vec<_>>(),
        "reads": kept.reads,
        "incomplete": kept.incomplete,
        "error_rows": outcome.error_rows,
        "first_error": outcome.first_error,
    }))
}

/// A rule tree compiled into the one binding the evaluator runs: `binding` null means every row.
pub fn compile_rules(request: &Value) -> Answer {
    need(request.is_object(), "Send an object with a rule tree and its fields.")?;
    let fields: Vec<Value> = request["fields"].as_array().into_iter().flatten().filter(|field| field.is_object()).cloned().collect();
    let own = operators_of(request)?;
    let kept = compiled(request.get("tree"), &fields, own.as_ref())?;
    Ok(json!({"binding": kept.binding, "reads": kept.reads, "incomplete": kept.incomplete}))
}

fn holds_over(tree: &Value, fields: Vec<Value>, row: Value, own: Option<&Vocabulary>, clock: &dyn Fn() -> f64) -> Result<bool, Refused> {
    let kept = compiled(Some(tree), &fields, own)?;
    if let Some(unfinished) = kept.incomplete.first() {
        return Err(sentence(format!("The rule engine could not finish a condition: {unfinished}.")));
    }
    match &kept.ready {
        None => Ok(true),
        Some(ready) => Ok(filter_with(ready, &[OpValue::from(row)], clock)?.matches.len() == 1),
    }
}

/// Whether a rule tree holds over ONE set of facts (an event's fields, a transcript row, a screen's state at one
/// element), `facts` keyed by the rules' `field`. A fact nobody gave is null. An empty or missing tree holds; a tree
/// with a rule the engine could not finish is refused with the rule named, never read as holding.
pub fn holds(request: &Value, clock: &dyn Fn() -> f64) -> Result<bool, Refused> {
    let tree = &request["tree"];
    if tree.is_null() {
        return Ok(true);
    }
    let fields = fields_of_tree(tree);
    if fields.is_empty() {
        return Ok(true);
    }
    let own = operators_of(request)?;
    let row: Map<String, Value> = fields
        .iter()
        .filter_map(|field| field["id"].as_str())
        .map(|id| (id.to_owned(), request["facts"].get(id).cloned().unwrap_or(Value::Null)))
        .collect();
    holds_over(tree, fields, Value::Object(row), own.as_ref(), clock)
}

/// Whether every test of the short spelling data files use (`{path, equals | one_of | starts_with | present, not}`)
/// holds over `row`, each read at its path. `present` is `is_known` (default: not null) or `is_not_empty`.
pub fn tests_hold(request: &Value, clock: &dyn Fn() -> f64) -> Result<bool, Refused> {
    let tests = request["tests"].as_array().cloned().unwrap_or_default();
    let present = request["present"].as_str().unwrap_or("is_known");
    let (tree, fields) = tree_of_tests(&tests, present);
    if fields.is_empty() {
        return Ok(true);
    }
    holds_over(&tree, fields, request.get("row").cloned().unwrap_or(Value::Null), None, clock)
}

/// One binding over rows: the positions it holds for. No binding holds for every row.
pub fn filter_rows(request: &Value, clock: &dyn Fn() -> f64) -> Answer {
    let rows = request["rows"].as_array().ok_or_else(|| sentence("rows must be a list of values."))?;
    let outcome = match request.get("binding").filter(|binding| !binding.is_null()) {
        None => crate::Outcome { matches: (0..rows.len() as u32).collect(), ..Default::default() },
        Some(binding) => filter_with(&ready(binding)?, &as_rows(rows), clock)?,
    };
    Ok(json!({"matches": outcome.matches, "error_rows": outcome.error_rows, "first_error": outcome.first_error}))
}

/// One binding over one value.
pub fn evaluate(request: &Value, clock: &dyn Fn() -> f64) -> Answer {
    let binding = request.get("binding").filter(|binding| binding.is_object()).ok_or_else(|| sentence("A formula binding is required."))?;
    let value = evaluate_with(&ready(binding)?, request.get("input").cloned().unwrap_or_else(|| json!({})), clock)?;
    Ok(json!({"value": value}))
}

/// One binding evaluated over each row: the value or the error it gave.
pub fn evaluate_formula(request: &Value, clock: &dyn Fn() -> f64) -> Answer {
    need(request.is_object(), "Send an object with a binding and rows.")?;
    need(
        request["binding"].is_object(),
        "binding must be an object like { \"$kind\": \"binding\", \"select\": { \"from\": \"self\", \"path\": [...] }, \"transform\": [{ \"op\": ... }] }, the ops being the formula engine's (op:core.*).",
    )?;
    let rows = request["rows"].as_array().ok_or_else(|| sentence("rows must be a list of values to evaluate the binding over."))?;
    let prepared = ready(&request["binding"]);
    let mut values = Vec::with_capacity(rows.len());
    let mut errors = Vec::new();
    for (at, row) in rows.iter().enumerate() {
        let answer = match &prepared {
            Ok(ready) => evaluate_with(ready, row.clone(), clock),
            Err(refused) => Err(refused.clone()),
        };
        match answer {
            Ok(value) => values.push(value),
            Err(refused) => {
                values.push(Value::Null);
                errors.push(json!({"row": at, "error": refused.message()}));
            }
        }
    }
    Ok(json!({"values": values, "errors": errors}))
}

/// The comparisons and combinators on offer, for one kind of field or all.
pub fn list_comparisons(request: &Value) -> Answer {
    need(request.is_object(), "Send an object; field_kind is optional.")?;
    let kind = request.get("field_kind").filter(|kind| !kind.is_null());
    need(kind.is_none_or(Value::is_string), "field_kind must be text.")?;
    let own = operators_of(request)?;
    let data = &own.as_ref().unwrap_or_else(|| default_vocabulary()).data;
    let operators = data["operators"].as_array().cloned().unwrap_or_default();
    let mut kinds: Vec<Value> = Vec::new();
    for kind in operators.iter().flat_map(|row| row["applies_to"].as_array().cloned().unwrap_or_default()) {
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    let pick = |row: &Value, keys: &[&str]| -> Value {
        Value::Object(keys.iter().filter_map(|key| row.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect())
    };
    Ok(json!({
        "combinators": data["combinators"].as_array().into_iter().flatten().map(|row| pick(row, &["id", "label", "sentence"])).collect::<Vec<_>>(),
        "comparisons": operators
            .iter()
            .filter(|row| kind.is_none_or(|kind| row["applies_to"].as_array().is_some_and(|kinds| kinds.contains(kind))))
            .map(|row| pick(row, &["id", "label", "input", "applies_to"]))
            .collect::<Vec<_>>(),
        "field_kinds": kinds,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guards::now_ms;

    fn filtered(request: Value) -> Value {
        filter_records(&request, &now_ms).expect("filter")
    }

    #[test]
    fn a_tree_keeps_its_rows_and_names_what_it_left_out() {
        let answer = filtered(json!({
            "records": [{"n": 1}, {"n": 2}, {"n": 3}],
            "fields": [{"id": "n", "kind": "number"}],
            "tree": {"kind": "group", "combinator": "and", "rules": [
                {"kind": "rule", "field": "n", "operator": "greater_than", "params": {"value": 1}},
                {"kind": "rule", "field": "n", "operator": "less_than", "params": {}}]}
        }));
        assert_eq!(answer["matches"], json!([1, 2]));
        assert_eq!(answer["records"], json!([{"n": 2}, {"n": 3}]));
        assert_eq!(answer["incomplete"].as_array().unwrap().len(), 1);
        assert_eq!(answer["reads"], json!(["n"]));
    }

    #[test]
    fn a_path_reads_into_each_record() {
        let answer = filtered(json!({
            "records": [{"a": {"b": "x"}}, {"a": {"b": "y"}}],
            "fields": [{"id": "ab", "kind": "choice", "path": ["a", "b"]}],
            "tree": {"kind": "rule", "field": "ab", "operator": "is_any_of", "params": {"values": ["y"]}}
        }));
        assert_eq!(answer["matches"], json!([1]));
    }

    #[test]
    fn a_group_joined_by_a_guess_is_refused() {
        let refused = filter_records(&json!({"records": [], "fields": [], "tree": {"kind": "group", "combinator": "xor", "rules": []}}), &now_ms);
        assert!(refused.unwrap_err().message().contains("is never joined by a guess"));
    }

    #[test]
    fn tests_read_at_their_paths() {
        let request = |row: Value| json!({"tests": [{"path": ["state"], "equals": "open"}, {"path": ["who", "name"], "present": true}], "row": row});
        assert!(tests_hold(&request(json!({"state": "open", "who": {"name": "Ana"}})), &now_ms).unwrap());
        assert!(!tests_hold(&request(json!({"state": "open"})), &now_ms).unwrap());
        assert!(!tests_hold(&request(json!({"state": "shut", "who": {"name": "Ana"}})), &now_ms).unwrap());
        let not_empty = json!({"tests": [{"path": ["note"], "present": true}], "present": "is_not_empty", "row": {"note": ""}});
        assert!(!tests_hold(&not_empty, &now_ms).unwrap());
    }

    #[test]
    fn an_unfinished_condition_is_refused_never_read_as_holding() {
        let tree = json!({"kind": "rule", "field": "x", "operator": "no_such_comparison", "params": {}});
        assert!(holds(&json!({"tree": tree, "facts": {"x": 1}}), &now_ms).is_err());
        assert!(holds(&json!({"tree": null, "facts": {}}), &now_ms).unwrap());
    }

    #[test]
    fn a_formula_gives_one_value_per_row_and_names_the_rows_that_failed() {
        let binding = json!({"$kind": "binding", "select": {"from": "self", "path": ["n"]}, "transform": [{"op": "op:core.gt", "args": {"value": 1}}]});
        let answer = evaluate_formula(&json!({"binding": binding, "rows": [{"n": 2}, {"n": 0}]}), &now_ms).unwrap();
        assert_eq!(answer["values"], json!([true, false]));
        assert_eq!(answer["errors"], json!([]));
    }

    #[test]
    fn comparisons_are_listed_for_a_kind() {
        let answer = list_comparisons(&json!({"field_kind": "boolean"})).unwrap();
        let ids: Vec<&str> = answer["comparisons"].as_array().unwrap().iter().filter_map(|row| row["id"].as_str()).collect();
        assert!(ids.contains(&"is_true") && !ids.contains(&"greater_than"));
    }
}
