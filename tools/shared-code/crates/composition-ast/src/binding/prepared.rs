//! crates/composition-ast/src/binding/prepared.rs
//!
//! # Purpose
//!
//! Evaluate ONE binding against MANY inputs without redoing per-binding work
//! for every input. `evaluate_binding_with_resolver` validates the binding's
//! shape, parses its path, re-serializes its argument bag, re-parses every
//! nested binding and clones the whole input on every call. That is correct
//! for a single evaluation and ruinous for a filter over thousands of rows.
//! `PreparedBinding::prepare` does all of that once; `evaluate` then runs over
//! `OpValue` input, whose clones are reference-count bumps, so a row's large
//! values are never copied.
//!
//! # Non-Negotiable Invariants
//!
//! 1. **Same meaning.** For every binding and input, `evaluate` returns the value
//!    `evaluate_binding_with_resolver` returns (see the equivalence tests). Any
//!    selection this module does not run natively (every source except `self`
//!    and `literal`) is delegated to the canonical selection code.
//! 2. **No operator logic.** Operators are resolved through the caller's
//!    resolver once, then applied exactly as the canonical evaluator applies them.
//! 3. **Runtime-only preservation is not handled here.** A context with
//!    `preserve_runtime_bindings` set is evaluated by the canonical evaluator,
//!    because partial evaluation returns AST, not a value.
//!
//! # Key Concepts
//!
//! | Type | Role |
//! |------|------|
//! | `PreparedBinding` | A validated binding with its path parsed and its steps' operators resolved |
//! | `PreparedValue` | An argument or default: a constant, a nested prepared binding, or a container of them |
//! | `PreparedResult` | The value (`OpValue`) and any diagnostics, in the canonical shapes |

use std::collections::HashMap;
use std::sync::Arc;

use ops_core::value::OpNode;
use ops_core::OpValue;

use super::ast::{
    Binding, BindingEvaluationContext, Diagnostic, DiagnosticCode, DiagnosticLevel, Path,
    PathSegment, SelectSource, BINDING_KIND,
};
use super::evaluator::evaluate_binding_with_resolver;
use super::operators::registry::{Operator, OperatorContext, OperatorResolver};
use super::path::is_forbidden_key;
use super::validator::validate_binding_ast_shape;

/// An argument bag, default, or any value inside one, ready for repeated use.
pub enum PreparedValue {
    /// Contains no nested binding; converted to `OpValue` once.
    Constant(OpValue),
    /// A nested `{"$kind":"binding"}` object.
    Binding(Box<PreparedBinding>),
    /// An object with at least one nested binding somewhere inside.
    Object(Vec<(String, PreparedValue)>),
    /// An array with at least one nested binding somewhere inside.
    Array(Vec<PreparedValue>),
}

struct PreparedStep {
    key: String,
    operator: Option<Arc<dyn Operator>>,
    args: Option<PreparedValue>,
    raw_args: Option<OpValue>,
}

enum PreparedSelect {
    /// No select, or `self` without a usable path: the input itself.
    Input,
    /// `self` with a parsed path.
    InputPath(Path),
    /// `literal` with no nested binding: the inline value, converted once.
    Constant(OpValue),
    /// `literal` holding selections (nested bindings): each evaluated against the input, as an argument bag's are.
    Value(PreparedValue),
    /// Any other source: the canonical selection code decides.
    Canonical,
}

/// A binding validated and resolved once, evaluated many times.
pub struct PreparedBinding {
    binding: Binding,
    invalid: Option<Vec<Diagnostic>>,
    select: PreparedSelect,
    steps: Vec<PreparedStep>,
    default: Option<PreparedValue>,
    default_value: OpValue,
}

/// The outcome of one prepared evaluation.
pub struct PreparedResult {
    pub value: OpValue,
    pub diagnostics: Vec<Diagnostic>,
}

fn prepare_value(value: &serde_json::Value, resolver: &OperatorResolver) -> PreparedValue {
    match value {
        serde_json::Value::Object(object) => {
            if object.get("$kind").and_then(|kind| kind.as_str()) == Some(BINDING_KIND) {
                if let Ok(binding) = serde_json::from_value::<Binding>(value.clone()) {
                    return PreparedValue::Binding(Box::new(PreparedBinding::prepare(&binding, resolver)));
                }
            }
            let fields: Vec<(String, PreparedValue)> = object
                .iter()
                .map(|(key, value)| (key.clone(), prepare_value(value, resolver)))
                .collect();
            if fields.iter().all(|(_, value)| matches!(value, PreparedValue::Constant(_))) {
                PreparedValue::Constant(OpValue::from(value.clone()))
            } else {
                PreparedValue::Object(fields)
            }
        }
        serde_json::Value::Array(items) => {
            let items: Vec<PreparedValue> = items.iter().map(|item| prepare_value(item, resolver)).collect();
            if items.iter().all(|item| matches!(item, PreparedValue::Constant(_))) {
                PreparedValue::Constant(OpValue::from(value.clone()))
            } else {
                PreparedValue::Array(items)
            }
        }
        other => PreparedValue::Constant(OpValue::from(other.clone())),
    }
}

impl PreparedValue {
    fn evaluate(
        &self,
        input: &OpValue,
        ctx: &BindingEvaluationContext,
        resolver: &OperatorResolver,
        diagnostics: &mut Vec<Diagnostic>,
    ) -> OpValue {
        match self {
            PreparedValue::Constant(value) => value.clone(),
            PreparedValue::Binding(binding) => {
                let result = binding.evaluate(input, ctx, resolver);
                diagnostics.extend(result.diagnostics);
                result.value
            }
            PreparedValue::Object(fields) => OpValue::from_arc(OpNode::object(
                fields
                    .iter()
                    .map(|(key, value)| (Arc::<str>::from(key.as_str()), value.evaluate(input, ctx, resolver, diagnostics).into_arc()))
                    .collect(),
            )),
            PreparedValue::Array(items) => OpValue::from_op_array(
                items.iter().map(|item| item.evaluate(input, ctx, resolver, diagnostics)).collect(),
            ),
        }
    }
}

fn read_path(input: &OpValue, path: &Path) -> OpValue {
    let mut current: Arc<OpNode> = input.arc_node();
    for segment in path {
        let next = match segment {
            PathSegment::Key(key) => {
                if is_forbidden_key(key) {
                    return OpValue::null();
                }
                match current.as_ref() {
                    OpNode::Object(fields) => fields.get(key.as_str()).cloned(),
                    _ => None,
                }
            }
            PathSegment::Index(index) => match current.as_ref() {
                OpNode::Array(items) => items.get(*index).cloned(),
                _ => None,
            },
        };
        match next {
            Some(node) => current = node,
            None => return OpValue::null(),
        }
    }
    OpValue::from_arc(current)
}

fn not_found(index: usize, key: &str) -> Diagnostic {
    let mut data = HashMap::new();
    data.insert("index".to_string(), serde_json::json!(index));
    data.insert("op".to_string(), serde_json::json!(key));
    Diagnostic {
        code: DiagnosticCode::BindingOperatorNotFound,
        level: DiagnosticLevel::Error,
        message: format!("operator not registered: {key}"),
        at: String::new(),
        data: Some(data),
    }
}

fn operator_failed(index: usize, key: &str, message: String) -> Diagnostic {
    let mut data = HashMap::new();
    data.insert("index".to_string(), serde_json::json!(index));
    data.insert("error".to_string(), serde_json::json!(message));
    Diagnostic {
        code: DiagnosticCode::BindingOperatorError,
        level: DiagnosticLevel::Error,
        message: format!("operator failed: {key}"),
        at: String::new(),
        data: Some(data),
    }
}

impl PreparedBinding {
    /// Validate the binding, parse its path and resolve every operator once.
    pub fn prepare(binding: &Binding, resolver: &OperatorResolver) -> Self {
        let validation = validate_binding_ast_shape(binding);
        let default_value = OpValue::from(binding.default.clone().unwrap_or(serde_json::Value::Null));
        let invalid = (!validation.ok).then_some(validation.diagnostics);
        let select = match binding.select.as_ref() {
            None => PreparedSelect::Input,
            Some(select) => match select.from.unwrap_or(SelectSource::SelfSource) {
                SelectSource::SelfSource => match select.path.as_ref().and_then(|path| path.to_path().ok()) {
                    Some(path) => PreparedSelect::InputPath(path),
                    None => PreparedSelect::Input,
                },
                SelectSource::Literal => match prepare_value(select.value.as_ref().unwrap_or(&serde_json::Value::Null), resolver) {
                    PreparedValue::Constant(value) => PreparedSelect::Constant(value),
                    held => PreparedSelect::Value(held),
                },
                _ => PreparedSelect::Canonical,
            },
        };
        let steps = binding
            .transform
            .iter()
            .flatten()
            .map(|step| {
                let operator = resolver(&step.op);
                let deferred = operator.as_ref().is_some_and(|op| op.owns_nested_arguments());
                let raw = step.args.as_ref().map(|args| serde_json::to_value(args).unwrap_or(serde_json::Value::Null));
                PreparedStep {
                    key: step.op.clone(),
                    operator,
                    args: if deferred { None } else { raw.as_ref().map(|args| prepare_value(args, resolver)) },
                    raw_args: if deferred { raw.map(OpValue::from) } else { None },
                }
            })
            .collect();
        Self {
            binding: binding.clone(),
            invalid,
            select,
            steps,
            default: binding.default.as_ref().map(|value| prepare_value(value, resolver)),
            default_value,
        }
    }

    /// Evaluate against one input. Same value as
    /// `evaluate_binding_with_resolver(binding, input, ctx, resolver, None)`.
    pub fn evaluate(
        &self,
        input: &OpValue,
        ctx: &BindingEvaluationContext,
        resolver: &OperatorResolver,
    ) -> PreparedResult {
        if ctx.preserve_runtime_bindings {
            let result = evaluate_binding_with_resolver(&self.binding, &input.as_inner(), ctx, resolver, None);
            return PreparedResult { value: OpValue::from(result.value), diagnostics: result.diagnostics };
        }
        if let Some(diagnostics) = &self.invalid {
            return PreparedResult { value: self.default_value.clone(), diagnostics: diagnostics.clone() };
        }
        let mut diagnostics = Vec::new();
        let mut value = match &self.select {
            PreparedSelect::Input => input.clone(),
            PreparedSelect::InputPath(path) => read_path(input, path),
            PreparedSelect::Constant(value) => value.clone(),
            PreparedSelect::Value(held) => held.evaluate(input, ctx, resolver, &mut diagnostics),
            PreparedSelect::Canonical => OpValue::from(super::evaluator::select_with_resolver_and_diagnostics(
                self.binding.select.as_ref(),
                &input.as_inner(),
                ctx,
                resolver,
                &mut diagnostics,
            )),
        };
        for (index, step) in self.steps.iter().enumerate() {
            let Some(operator) = step.operator.as_ref() else {
                diagnostics.push(not_found(index, &step.key));
                return PreparedResult {
                    value: self.default_value.clone(),
                    diagnostics,
                };
            };
            let args = if operator.owns_nested_arguments() {
                step.raw_args.clone()
            } else {
                step.args.as_ref().map(|args| args.evaluate(&value, ctx, resolver, &mut diagnostics))
            };
            let op_ctx = OperatorContext::new(ctx.clone(), &step.key, index).with_resolver(resolver.clone());
            let applied = operator.apply(&value, args.as_ref(), &op_ctx);
            diagnostics.extend(op_ctx.take_nested_diagnostics());
            match applied {
                Ok(result) => value = result,
                Err(diagnostic) => {
                    return PreparedResult {
                        value: self.default_value.clone(),
                        diagnostics: { diagnostics.push(operator_failed(index, &step.key, diagnostic.message)); diagnostics },
                    };
                }
            }
        }
        if value.is_null() {
            if let Some(default) = &self.default {
                value = default.evaluate(input, ctx, resolver, &mut diagnostics);
            }
        }
        PreparedResult { value, diagnostics }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binding::evaluator::evaluate_binding;
    use crate::binding::operators::create_core_registry;
    use serde_json::json;

    fn resolver() -> OperatorResolver {
        let registry = Arc::new(create_core_registry().expect("registry"));
        Arc::new(move |key: &str| registry.get(key))
    }

    fn rule(path: &str, op: &str, value: serde_json::Value) -> serde_json::Value {
        json!({"$kind":"binding","select":{"from":"self","path":path},"transform":[{"op":op,"args":{"value":value}}]})
    }

    #[test]
    fn nested_argument_reads_the_row_through_context_and_the_pipeline_value_through_self() {
        let resolver = resolver();
        let row = json!({"views": 300.0, "channel_median": 100.0});
        let ctx = BindingEvaluationContext::default().with_context(row.clone());
        let ratio = json!({"$kind":"binding","select":{"from":"self","path":"views"},"transform":[
            {"op":"op:core.div","args":{"value":{"$kind":"binding","select":{"from":"context","path":"channel_median"}}}}]});
        let ratio = serde_json::from_value::<Binding>(ratio).expect("binding");
        let prepared = PreparedBinding::prepare(&ratio, &resolver);
        let result = prepared.evaluate(&OpValue::from(row.clone()), &ctx, &resolver);
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        assert_eq!(result.value.into_inner(), json!(3));
        // The canonical evaluator gives the same value.
        assert_eq!(evaluate_binding_with_resolver(&ratio, &row, &ctx, &resolver, None).value, json!(3));
        // `self` inside an argument is still the pipeline's current value (300 + 300).
        let doubled = json!({"$kind":"binding","select":{"from":"self","path":"views"},"transform":[
            {"op":"op:core.add","args":{"value":{"$kind":"binding","select":{"from":"self"}}}}]});
        let doubled = serde_json::from_value::<Binding>(doubled).expect("binding");
        let prepared = PreparedBinding::prepare(&doubled, &resolver);
        assert_eq!(prepared.evaluate(&OpValue::from(row), &ctx, &resolver).value.into_inner(), json!(600));
    }

    #[test]
    fn arithmetic_then_a_comparison_answers() {
        // Strict arithmetic answers a number, so a comparison after it compares numbers (6 > 10 is false), never
        // the spelling of two texts ("6" > "10" would be true) and never a refusal of text against a number.
        let resolver = resolver();
        let row = json!({"price": 2, "quantity": 3, "other_price": 5, "other_quantity": 2});
        let ctx = BindingEvaluationContext::default().with_context(row.clone());
        let read = |path: &str| json!({"$kind":"binding","select":{"from":"context","path":path}});
        let cases = [
            ("op:core.gt", json!(10), false),
            ("op:core.ge", json!(6), true),
            ("op:core.lt", json!(6.5), true),
            ("op:core.gt", json!({"$kind":"binding","select":{"from":"context","path":"other_price"},"transform":[{"op":"op:core.mul","args":{"value":read("other_quantity")}}]}), false),
            ("op:core.ge", json!("5.99"), true),
        ];
        for (op, against, holds) in cases {
            let binding = json!({"$kind":"binding","select":{"from":"self","path":"price"},"transform":[
                {"op":"op:core.mul","args":{"value":read("quantity")}}, {"op":op,"args":{"value":against}}]});
            let binding = serde_json::from_value::<Binding>(binding).expect("binding");
            let result = PreparedBinding::prepare(&binding, &resolver).evaluate(&OpValue::from(row.clone()), &ctx, &resolver);
            assert!(result.diagnostics.is_empty(), "{op}: {:?}", result.diagnostics);
            assert_eq!(result.value.into_inner(), json!(holds), "{op} {against}");
        }
        let tenths = json!({"$kind":"binding","select":{"from":"literal","value":0.1},"transform":[{"op":"op:core.add","args":{"value":0.2}}]});
        let tenths = serde_json::from_value::<Binding>(tenths).expect("binding");
        assert_eq!(PreparedBinding::prepare(&tenths, &resolver).evaluate(&OpValue::from(json!({})), &ctx, &resolver).value.into_inner(), json!(0.3));
    }

    #[test]
    fn prepared_evaluation_matches_the_canonical_evaluator() {
        let resolver = resolver();
        let inputs = [
            json!({"duration": 95, "words": "Forehand drill", "labels": ["junk"], "nested": {"a": [1, 2]}}),
            json!({"duration": null, "words": null, "labels": []}),
            json!({"duration": "12", "labels": ["drill", "junk"], "constructor": 1}),
            json!(null),
            json!([1, 2, 3]),
        ];
        let bindings = [
            rule("duration", "op:core.gt", json!(60)),
            rule("duration", "op:core.le", json!(60)),
            rule("constructor", "op:core.eq", json!(1)),
            json!({"$kind":"binding","select":{"from":"self","path":"nested.a.1"}}),
            json!({"$kind":"binding","select":{"from":"self","path":"words"},"transform":[{"op":"op:core.lower"},{"op":"op:core.contains","args":{"value":"forehand"}}]}),
            json!({"$kind":"binding","select":{"from":"self","path":"labels"},"transform":[{"op":"op:core.index_of","args":{"value":"junk"}},{"op":"op:core.ge","args":{"value":0}}]}),
            json!({"$kind":"binding","select":{"from":"self"},"transform":[{"op":"op:core.or","args":{"values":[
                rule("duration", "op:core.gt", json!(60)),
                {"$kind":"binding","select":{"from":"self"},"transform":[{"op":"op:core.and","args":{"values":[rule("duration", "op:core.lt", json!(40))]}},{"op":"op:core.not"}]}
            ]}}]}),
            json!({"$kind":"binding","select":{"from":"literal","value":5},"transform":[{"op":"op:core.add","args":{"value":{"$kind":"binding","select":{"from":"self"}}}}]}),
            json!({"$kind":"binding","select":{"from":"self","path":"missing"},"default":{"$kind":"binding","select":{"from":"self","path":"duration"}}}),
            json!({"$kind":"binding","select":{"from":"self"},"transform":[{"op":"op:core.nope"}],"default":"fallback"}),
            json!({"$kind":"binding","select":{"from":"self","path":"words"},"transform":[{"op":"op:core.upper"}],"default":"x"}),
            json!({"$kind":"nope"}),
            json!({"$kind":"binding","select":{"from":"ambient","path":"theme"}}),
            // A literal holding selections: the largest of a list of them.
            json!({"$kind":"binding","select":{"from":"literal","value":[0,
                {"$kind":"binding","select":{"from":"self","path":"duration"}},
                {"$kind":"binding","select":{"from":"self","path":"nested.a.1"}}]},"transform":[{"op":"op:core.max"}]}),
        ];
        let ctx = BindingEvaluationContext::default().with_ambient("theme", json!("dark"));
        for binding in bindings {
            let parsed: Binding = serde_json::from_value(binding.clone()).expect("binding");
            let prepared = PreparedBinding::prepare(&parsed, &resolver);
            for input in &inputs {
                let canonical = evaluate_binding_with_resolver(&parsed, input, &ctx, &resolver, None);
                let fast = prepared.evaluate(&OpValue::from(input.clone()), &ctx, &resolver);
                assert_eq!(fast.value.as_inner(), canonical.value, "{binding} on {input}");
                assert_eq!(
                    fast.diagnostics.iter().map(|d| (d.code, d.message.clone())).collect::<Vec<_>>(),
                    canonical.diagnostics.iter().map(|d| (d.code, d.message.clone())).collect::<Vec<_>>(),
                    "{binding} on {input}"
                );
            }
        }
    }

    #[test]
    fn mapper_and_nested_error_contract_matches_all_evaluator_paths() {
        let resolver = resolver();
        let registry = create_core_registry().expect("registry");
        let cases = [
            json!({"$kind":"binding","select":{"from":"literal","value":[{"id":"a"},{"id":"b"}]},
                "transform":[{"op":"op:core.map_to_nodes","args":{"template":{
                    "id":{"$kind":"binding","select":{"from":"vars","key":"$item","path":"id"}},
                    "index":{"$kind":"binding","select":{"from":"vars","key":"$index"}}
                }}}]}),
            json!({"$kind":"binding","select":{"from":"literal","value":true},
                "transform":[{"op":"op:core.equals","args":{"value":{
                    "$kind":"binding","select":{"from":"literal","value":5},
                    "transform":[{"op":"op:core.contains","args":{"value":"x"}}],"default":true
                }}}]}),
            json!({"$kind":"binding","select":{"from":"routing","key":{
                    "$kind":"binding","select":{"from":"literal","value":5},
                    "transform":[{"op":"op:core.contains","args":{"value":"x"}}],"default":"route-key"
                }}}),
        ];
        let ctx = BindingEvaluationContext::new().with_route("route-key", "resolved-target");
        for raw in cases {
            let binding: Binding = serde_json::from_value(raw.clone()).expect("binding");
            let fast = PreparedBinding::prepare(&binding, &resolver)
                .evaluate(&OpValue::null(), &ctx, &resolver);
            let canonical = evaluate_binding_with_resolver(&binding, &serde_json::Value::Null, &ctx, &resolver, None);
            let registry_path = evaluate_binding(&binding, &serde_json::Value::Null, &ctx, &registry, None);
            assert_eq!(fast.value.as_inner(), canonical.value, "{raw}");
            assert_eq!(fast.value.as_inner(), registry_path.value, "{raw}");
            let codes = |items: &[Diagnostic]| items.iter().map(|d| d.code).collect::<Vec<_>>();
            assert_eq!(codes(&fast.diagnostics), codes(&canonical.diagnostics), "{raw}");
            assert_eq!(codes(&fast.diagnostics), codes(&registry_path.diagnostics), "{raw}");
        }
    }

    #[test]
    fn partial_evaluation_keeps_iteration_templates_until_runtime() {
        let resolver = resolver();
        let registry = create_core_registry().unwrap();
        let binding: Binding = serde_json::from_value(json!({
            "$kind":"binding", "select":{"from":"state","path":"rows"},
            "transform":[{"op":"op:core.map_to_nodes","args":{"template":{
                "id":{"$kind":"binding","select":{"from":"vars","key":"$item","path":"id"}},
                "index":{"$kind":"binding","select":{"from":"vars","key":"$index"}}
            }}}]
        })).unwrap();
        let partial = BindingEvaluationContext::new().with_preserve_runtime_bindings(true);
        let deferred = [
            evaluate_binding(&binding, &serde_json::Value::Null, &partial, &registry, None).value,
            evaluate_binding_with_resolver(&binding, &serde_json::Value::Null, &partial, &resolver, None).value,
        ];
        let runtime = BindingEvaluationContext::new().with_state("rows", json!([{"id":"a"},{"id":"b"}]));
        for value in deferred {
            let normalized: Binding = serde_json::from_value(value).unwrap();
            let result = PreparedBinding::prepare(&normalized, &resolver).evaluate(&OpValue::null(), &runtime, &resolver);
            assert_eq!(result.value.as_inner(), json!([{"id":"a","index":0},{"id":"b","index":1}]));
            assert!(result.diagnostics.is_empty());
        }
    }
}
