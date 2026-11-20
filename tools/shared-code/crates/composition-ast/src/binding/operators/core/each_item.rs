//! crates/composition-ast/src/binding/operators/core/each_item.rs
//!
//! Purpose:
//!   The operators that run a transform chain on each item of a list: keep the items it holds for
//!   (`filter_where`), take the first one (`find_where`), splice what it makes (`flat_map`), count them
//!   (`array_count_if` with `where`), pick one path from each item (`map`), and fold them into one value
//!   (`reduce`). The chain is DATA, a list of `{op, args}` steps exactly like a binding's `transform`, so any
//!   registered operator can judge or shape an item, and a chain inside a chain nests without limit.
//!
//! Non-Negotiable Invariants:
//!   1. An item's chain is evaluated by the canonical evaluator (`OperatorContext::evaluate_nested_bindings`),
//!      as the binding `{select: {from: "vars", key: "$item"}, transform: <chain>}` with `$item` and `$index`
//!      bound, so it reaches every other value the same way any binding does.
//!   2. An item is held when its chain yields a truthy value (ops-core truthiness).
//!   5. `item_var` names the item's variable (default `$item`, with `$index`), so a chain inside a chain can still
//!      read the outer item: the inner item is bound beside it, never over it.
//!   3. A chain that reports an error is an error of the operator, never a silent "not held".
//!   4. These operators name no field, kind or value: what an item is, is the chain's business.

use super::super::registry::{OperatorContext, OperatorResult};
use crate::binding::ast::{Diagnostic, DiagnosticCode, DiagnosticLevel};
use ops_core::OpValue;
use serde_json::{json, Value};

fn refused(code: DiagnosticCode, message: String) -> Diagnostic {
    Diagnostic { code, level: DiagnosticLevel::Error, message, at: String::new(), data: None }
}

/// The items of the pipeline value: a list's items, nothing for null.
fn items(input: &OpValue, op: &str) -> Result<Vec<Value>, Diagnostic> {
    match input.as_inner() {
        Value::Array(items) => Ok(items),
        Value::Null => Ok(Vec::new()),
        other => Err(refused(
            DiagnosticCode::EvalTypeMismatch,
            format!("{op} needs a list, and the value is {}", match other {
                Value::Object(_) => "an object",
                Value::String(_) => "text",
                Value::Number(_) => "a number",
                Value::Bool(_) => "true or false",
                _ => "something else",
            }),
        )),
    }
}

/// The chain named `name` in the operator's arguments.
fn chain(args: Option<&OpValue>, name: &str, op: &str) -> Result<Value, Diagnostic> {
    match args.map(OpValue::as_inner).and_then(|args| args.get(name).cloned()) {
        Some(Value::Array(steps)) => Ok(Value::Array(steps)),
        _ => Err(refused(DiagnosticCode::OpArgsInvalid, format!("{op} needs `{name}`: a list of {{op, args}} steps"))),
    }
}

/// The variable an item is bound to: `item_var`, or `$item`; its index is `<item_var>_index`, or `$index`.
fn item_var(args: Option<&OpValue>) -> (String, String) {
    match args.map(OpValue::as_inner).and_then(|args| args.get("item_var").and_then(Value::as_str).map(str::to_string)) {
        Some(name) => (name.clone(), format!("{name}_index")),
        None => ("$item".to_string(), "$index".to_string()),
    }
}

/// What one item's chain yields.
fn run_chain(ctx: &OperatorContext, args: Option<&OpValue>, steps: &Value, item: &Value, index: usize, op: &str) -> Result<Value, Diagnostic> {
    let (name, index_name) = item_var(args);
    let item_ctx = ctx.with_iteration_vars(item.clone(), index, &name, &index_name);
    run_chain_on(&item_ctx, &name, steps, op)
}

/// What a chain yields when it starts from the variable `start` of a context whose variables are already bound.
fn run_chain_on(item_ctx: &OperatorContext, start: &str, steps: &Value, op: &str) -> Result<Value, Diagnostic> {
    let binding = json!({ "$kind": "binding", "select": { "from": "vars", "key": start }, "transform": steps });
    let value = item_ctx
        .evaluate_nested_bindings(&binding)
        .ok_or_else(|| refused(DiagnosticCode::BindingOperatorError, format!("{op} needs the evaluator to run a chain")))?;
    if let Some(error) = item_ctx
        .take_nested_diagnostics()
        .into_iter()
        .find(|diagnostic| matches!(diagnostic.level, DiagnosticLevel::Error))
    {
        return Err(error);
    }
    Ok(value)
}

fn holds(value: &Value) -> bool {
    OpValue::from(value.clone()).is_truthy()
}

/// The list folded into one value: `step` runs from `$acc` (the value so far, first `initial`, null without it) with
/// the item bound as `$item` and `$index` (or `item_var`), and what it yields is the next `$acc`. An empty list gives
/// `initial`.
pub fn reduce(input: &OpValue, args: Option<&OpValue>, ctx: &OperatorContext) -> OperatorResult {
    let steps = chain(args, "step", "reduce")?;
    let (name, index_name) = item_var(args);
    let initial = args.map(OpValue::as_inner).and_then(|args| args.get("initial").cloned()).unwrap_or(Value::Null);
    let mut acc = ctx.evaluate_nested_bindings(&initial).unwrap_or(initial);
    for (index, item) in items(input, "reduce")?.into_iter().enumerate() {
        let item_ctx = ctx
            .with_iteration_vars(item, index, &name, &index_name)
            .with_iteration_vars(acc, index, "$acc", &index_name);
        acc = run_chain_on(&item_ctx, "$acc", &steps, "reduce")?;
    }
    Ok(OpValue::from(acc))
}

pub fn filter_where(input: &OpValue, args: Option<&OpValue>, ctx: &OperatorContext) -> OperatorResult {
    let steps = chain(args, "predicate", "filter_where")?;
    let mut kept = Vec::new();
    for (index, item) in items(input, "filter_where")?.into_iter().enumerate() {
        if holds(&run_chain(ctx, args, &steps, &item, index, "filter_where")?) {
            kept.push(item);
        }
    }
    Ok(OpValue::from(Value::Array(kept)))
}

pub fn find_where(input: &OpValue, args: Option<&OpValue>, ctx: &OperatorContext) -> OperatorResult {
    let steps = chain(args, "predicate", "find_where")?;
    for (index, item) in items(input, "find_where")?.into_iter().enumerate() {
        if holds(&run_chain(ctx, args, &steps, &item, index, "find_where")?) {
            return Ok(OpValue::from(item));
        }
    }
    Ok(OpValue::null())
}

/// Each item's chain result: a list is spliced in, null is dropped, anything else is kept as it is.
pub fn flat_map(input: &OpValue, args: Option<&OpValue>, ctx: &OperatorContext) -> OperatorResult {
    let steps = chain(args, "transform", "flat_map")?;
    let mut made = Vec::new();
    for (index, item) in items(input, "flat_map")?.into_iter().enumerate() {
        match run_chain(ctx, args, &steps, &item, index, "flat_map")? {
            Value::Array(inner) => made.extend(inner),
            Value::Null => {}
            other => made.push(other),
        }
    }
    Ok(OpValue::from(Value::Array(made)))
}

/// `where` counts the items its chain holds for; without it, `predicate` names a ready-made chain.
pub fn count_if(input: &OpValue, args: Option<&OpValue>, ctx: &OperatorContext) -> OperatorResult {
    let named = args.map(OpValue::as_inner).and_then(|args| args.get("predicate").and_then(Value::as_str).map(str::to_string));
    let steps = match args.map(OpValue::as_inner).and_then(|args| args.get("where").cloned()) {
        Some(steps) => steps,
        None => ready_made_count(named.as_deref().unwrap_or("non_null")),
    };
    if steps.as_array().is_some_and(Vec::is_empty) {
        return Ok(OpValue::from_usize(items(input, "array_count_if")?.len()));
    }
    let mut count = 0;
    for (index, item) in items(input, "array_count_if")?.into_iter().enumerate() {
        if holds(&run_chain(ctx, args, &steps, &item, index, "array_count_if")?) {
            count += 1;
        }
    }
    Ok(OpValue::from_usize(count))
}

/// The four `predicate` names `array_count_if` always took, each the chain it stands for. An unknown name counts
/// every item, as it always did.
fn ready_made_count(name: &str) -> Value {
    match name {
        "non_null" => json!([{ "op": "op:core.is_not_null" }]),
        "truthy" => json!([{ "op": "op:core.identity" }]),
        "numeric" => json!([{ "op": "op:core.type_of" }, { "op": "op:core.equals", "args": { "value": "number" } }]),
        _ => json!([]),
    }
}

/// The value at `path` in each item; a missing path gives null. Without a `path` the list is unchanged.
pub fn map_path(input: &OpValue, args: Option<&OpValue>, _ctx: &OperatorContext) -> OperatorResult {
    let Some(path) = args.map(OpValue::as_inner).and_then(|args| args.get("path").and_then(Value::as_str).map(str::to_string)) else {
        return Ok(input.clone());
    };
    match input.as_inner() {
        Value::Array(items) => Ok(OpValue::from(Value::Array(
            items.iter().map(|item| OpValue::from(item.clone()).get_path(&path).into_inner()).collect(),
        ))),
        _ => Ok(input.clone()),
    }
}

#[cfg(test)]
mod tests {
    use crate::binding::ast::{Binding, BindingEvaluationContext, DiagnosticLevel};
    use crate::binding::evaluator::evaluate_binding_with_resolver;
    use crate::binding::operators::create_core_registry;
    use crate::binding::operators::registry::OperatorResolver;
    use serde_json::{json, Value};
    use std::sync::Arc;

    fn run(transform: Value, input: Value) -> Result<Value, String> {
        let registry = Arc::new(create_core_registry().unwrap());
        let resolver: OperatorResolver = Arc::new(move |key: &str| registry.get(key));
        let binding: Binding = serde_json::from_value(json!({ "$kind": "binding", "transform": transform })).unwrap();
        let result = evaluate_binding_with_resolver(&binding, &input, &BindingEvaluationContext::default(), &resolver, None);
        match result.diagnostics.into_iter().find(|d| matches!(d.level, DiagnosticLevel::Error)) {
            Some(error) => Err(match error.data.as_ref().and_then(|data| data.get("error")) {
                Some(detail) => format!("{}: {}", error.message, detail),
                None => error.message,
            }),
            None => Ok(result.value),
        }
    }

    fn is(value: &str) -> Value {
        json!([{ "op": "op:core.get_path", "args": { "path": "kind" } }, { "op": "op:core.equals", "args": { "value": value } }])
    }

    #[test]
    fn filter_find_and_count_hold_a_chain_per_item() {
        let rows = json!([{ "kind": "a", "n": 1 }, { "kind": "b", "n": 2 }, { "kind": "a", "n": 3 }]);
        assert_eq!(run(json!([{ "op": "op:core.filter_where", "args": { "predicate": is("a") } }]), rows.clone()).unwrap(), json!([{ "kind": "a", "n": 1 }, { "kind": "a", "n": 3 }]));
        assert_eq!(run(json!([{ "op": "op:core.find_where", "args": { "predicate": is("b") } }]), rows.clone()).unwrap(), json!({ "kind": "b", "n": 2 }));
        assert_eq!(run(json!([{ "op": "op:core.find_where", "args": { "predicate": is("z") } }]), rows.clone()).unwrap(), Value::Null);
        assert_eq!(run(json!([{ "op": "op:core.array_count_if", "args": { "where": is("a") } }]), rows.clone()).unwrap(), json!(2));
        assert_eq!(run(json!([{ "op": "op:core.filter_where", "args": { "predicate": is("a") } }]), Value::Null).unwrap(), json!([]));
    }

    #[test]
    fn count_if_ready_made_names_keep_their_old_counts() {
        let values = json!([0, 1, "", "x", null, [], [1], {}, true, false]);
        let count = |name: &str| run(json!([{ "op": "op:core.array_count_if", "args": { "predicate": name } }]), values.clone()).unwrap();
        assert_eq!(count("all"), json!(10));
        assert_eq!(count("non_null"), json!(9));
        assert_eq!(count("truthy"), json!(4));
        assert_eq!(count("numeric"), json!(2));
        assert_eq!(run(json!([{ "op": "op:core.array_count_if" }]), values).unwrap(), json!(9));
    }

    #[test]
    fn flat_map_splices_lists_drops_nulls_and_keeps_values() {
        let rows = json!([{ "tags": ["x", "y"] }, { "tags": null }, { "tags": "z" }]);
        let made = run(json!([{ "op": "op:core.flat_map", "args": { "transform": [{ "op": "op:core.get_path", "args": { "path": "tags" } }] } }]), rows).unwrap();
        assert_eq!(made, json!(["x", "y", "z"]));
    }

    #[test]
    fn a_chain_that_fails_fails_the_operator() {
        let error = run(json!([{ "op": "op:core.filter_where", "args": { "predicate": [{ "op": "op:core.no_such_operator" }] } }]), json!([1])).unwrap_err();
        assert!(error.contains("no_such_operator"), "{error}");
    }

    #[test]
    fn chains_nest_and_map_picks_one_path() {
        let groups = json!([{ "items": [{ "kind": "a" }, { "kind": "b" }] }, { "items": [{ "kind": "b" }] }]);
        let has_a = json!([{ "op": "op:core.get_path", "args": { "path": "items" } }, { "op": "op:core.array_count_if", "args": { "where": is("a") } }, { "op": "op:core.ge", "args": { "value": 1 } }]);
        assert_eq!(run(json!([{ "op": "op:core.array_count_if", "args": { "where": has_a } }]), groups.clone()).unwrap(), json!(1));
        assert_eq!(run(json!([{ "op": "op:core.map", "args": { "path": "items.0.kind" } }]), groups).unwrap(), json!(["a", "b"]));
    }

    #[test]
    fn other_names_reach_the_same_operators() {
        assert_eq!(run(json!([{ "op": "op:core.first" }]), json!([7, 8])).unwrap(), json!(7));
        assert_eq!(run(json!([{ "op": "op:core.gte", "args": { "value": 2 } }]), json!(2)).unwrap(), json!(true));
        assert_eq!(run(json!([{ "op": "op:core.json_parse" }]), json!("{\"a\":1}")).unwrap(), json!({ "a": 1 }));
        assert_eq!(run(json!([{ "op": "op:core.concat", "args": { "prefix": "<", "suffix": ">" } }]), json!("x")).unwrap(), json!("<x>"));
        assert_eq!(run(json!([{ "op": "op:core.concat", "args": { "values": ["a", "b"] } }]), Value::Null).unwrap(), json!("ab"));
        assert_eq!(run(json!([{ "op": "op:core.merge", "args": { "source": { "b": 2 } } }]), json!({ "a": 1 })).unwrap(), json!({ "a": 1, "b": 2 }));
        assert_eq!(run(json!([{ "op": "op:core.append", "args": { "value": 3 } }]), json!([1])).unwrap(), json!([1, 3]));
        assert_eq!(run(json!([{ "op": "op:core.take", "args": { "count": 1 } }]), json!([1, 2])).unwrap(), json!([1]));
    }

    #[test]
    fn an_inner_chain_reads_the_outer_item_by_its_own_name() {
        // Which values are mentioned in none of the texts: the inner count runs over the texts as `$text`, beside `$item`.
        let texts = json!(["I play tennis daily", "a walk"]);
        let mentioned = json!([
            { "op": "op:core.coalesce", "args": { "values": [{ "$kind": "binding", "select": { "from": "literal", "value": texts },
                "transform": [{ "op": "op:core.array_count_if", "args": { "item_var": "$text", "where": [
                    { "op": "op:core.lower" },
                    { "op": "op:core.contains", "args": { "value": { "$kind": "binding", "select": { "from": "vars", "key": "$item" }, "transform": [{ "op": "op:core.lower" }] } } }
                ] } }] }] } },
            { "op": "op:core.ge", "args": { "value": 1 } }
        ]);
        let unmentioned = run(json!([{ "op": "op:core.filter_where", "args": { "predicate": [{ "op": "op:core.identity" }, mentioned.as_array().unwrap()[0].clone(), mentioned.as_array().unwrap()[1].clone(), { "op": "op:core.not" }] } }]), json!(["Tennis", "golf", "WALK"])).unwrap();
        assert_eq!(unmentioned, json!(["golf"]));
        assert_eq!(run(json!([{ "op": "op:core.concat_arrays", "args": { "value": [3] } }]), json!([1, 2])).unwrap(), json!([1, 2, 3]));
    }
}
