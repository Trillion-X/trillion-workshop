use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, OnceLock};

use composition_ast::binding::ast::{
    Binding, BindingEvaluationContext, DiagnosticLevel, PathInput, PathSegment, SelectSource,
};
use composition_ast::binding::evaluator::evaluate_binding_with_resolver;
use composition_ast::binding::operators::create_core_registry;
use composition_ast::binding::operators::registry::OperatorResolver;
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, Visitor};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use slot_protocol::{FactAddress, PartitionKey};

const MAX_DISPATCH_CHANGE_BYTES: usize = 2 * 1024 * 1024;

/// Per-record content the trigger engine retains for matching and dispatch.
///
/// Physics-closed algebraic state (same category as `Option`/`Result`, NOT a
/// Society-extensible taxonomy — the L083 enum-dissolution rule explicitly
/// permits states closed by Physics): a record's content is either
///
/// - `Absent` — a retraction carries no content;
/// - `Retained` — content within the callback-safe bound, held once as an
///   `Arc<[u8]>` so the 256-entry replay ring, `to_context`, and
///   `observed_mutations()` all SHARE the buffer by pointer (O(1) clone,
///   Performance P1 structural sharing) instead of deep-copying it N times;
/// - `Oversized` — content ABOVE the bound, dropped to a size marker.
///
/// The bound is the deepest-root fix (converged Claude + Codex GPT-5.5 gauntlet):
/// the engine's own match/dispatch paths ALREADY degrade content past
/// `MAX_DISPATCH_CHANGE_BYTES` to a size summary (`raw_bytes_match_summary`) or a
/// typed failure (`parse_dispatch_change`). Retaining the raw bytes above that
/// bound therefore buys the engine NOTHING it can use — it only lets one bulk
/// delta multiply into an unbounded `Vec<u8>` clone that exhausts the ~4GB WASM
/// heap and traps the slot (killing every autonomous trigger). Dropping oversized
/// content at retention makes it structurally impossible for a delta of ANY size
/// to OOM the slot: peak retained content is bounded at
/// `OBSERVED_MUTATION_REPLAY_LIMIT * MAX_DISPATCH_CHANGE_BYTES`, and the match /
/// dispatch outputs are byte-for-byte identical to today's degraded behavior.
#[derive(Debug, Clone)]
pub(super) enum RetainedContent {
    Absent,
    Retained(Arc<[u8]>),
    Oversized { len: usize },
}

impl RetainedContent {
    /// Apply the callback-safe bound at the moment content enters retained state.
    /// Content that fits is shared as `Arc<[u8]>` (no deep copy — `Arc::from` of a
    /// boxed slice reuses the allocation); content that does not is reduced to its
    /// length so the buffer can be freed immediately.
    pub(super) fn from_bytes(bytes: Vec<u8>) -> Self {
        if bytes.len() > MAX_DISPATCH_CHANGE_BYTES {
            RetainedContent::Oversized { len: bytes.len() }
        } else {
            RetainedContent::Retained(Arc::from(bytes.into_boxed_slice()))
        }
    }
}

/// The match projection for content that exceeded the retention bound: the same
/// `{ "kind": "raw_bytes", "size": N }` envelope that `raw_bytes_match_summary`
/// produces for a >bound buffer on the live path, so retention-bounding changes
/// no observable match behavior.
pub(super) fn oversized_content_match_summary(len: usize) -> Value {
    json!({
        "kind": "raw_bytes",
        "size": len,
    })
}

/// The typed dispatch failure for content that exceeded the retention bound —
/// identical wording (contains "callback-safe JSON bound") to the live-path
/// `parse_dispatch_change` error, so a rule that dispatches the full change of an
/// oversized record fails closed instead of trapping.
fn oversized_dispatch_error(len: usize) -> String {
    format!(
        "trigger-engine: dispatch change materialization exceeds callback-safe JSON bound: bytes={len} max={MAX_DISPATCH_CHANGE_BYTES}"
    )
}

#[derive(Debug, Clone)]
pub(super) struct MutationContext {
    pub(super) change_for_match: Value,
    pub(super) change_for_dispatch: OnceLock<Result<Value, String>>,
    pub(super) raw_bytes: RetainedContent,
    pub(super) envelope: Value,
}

impl MutationContext {
    /// The retained change payload's own `kind` field, when the content is
    /// small enough to have been retained and parses as a JSON object. Used by
    /// the dispatch-failure write path's recursion guard; None for oversized,
    /// absent, or non-object content.
    pub(super) fn retained_change_kind(&self) -> Option<String> {
        const MAX_KIND_PROBE_BYTES: usize = 65_536;
        let RetainedContent::Retained(bytes) = &self.raw_bytes else {
            return None;
        };
        if bytes.len() > MAX_KIND_PROBE_BYTES {
            return None;
        }
        serde_json::from_slice::<Value>(bytes)
            .ok()?
            .get("kind")?
            .as_str()
            .map(str::to_string)
    }

    pub(super) fn match_json(&self) -> Value {
        json!({
            "change": self.change_for_match.clone(),
            "envelope": self.envelope.clone(),
        })
    }

    fn full_json(&self) -> Result<Value, String> {
        let mut context = Map::new();
        context.insert("change".to_string(), self.change_for_dispatch()?);
        context.insert("envelope".to_string(), self.envelope.clone());
        Ok(Value::Object(context))
    }

    fn change_for_dispatch(&self) -> Result<Value, String> {
        self.change_for_dispatch
            .get_or_init(|| match &self.raw_bytes {
                RetainedContent::Retained(raw_bytes) => parse_dispatch_change(raw_bytes),
                RetainedContent::Oversized { len } => Err(oversized_dispatch_error(*len)),
                RetainedContent::Absent => Ok(self.change_for_match.clone()),
            })
            .clone()
    }

    fn dispatch_value_at_path(&self, context_path: &str) -> Result<Value, String> {
        match context_path.split_once('.') {
            None if context_path.is_empty() => self.full_json(),
            None if context_path == "change" => self.change_for_dispatch(),
            None if context_path == "envelope" => Ok(self.envelope.clone()),
            Some(("change", rest)) => self.change_dispatch_value_at_path(rest),
            Some(("envelope", rest)) => Ok(value_at_path(&self.envelope, rest)
                .cloned()
                .unwrap_or(Value::Null)),
            _ => Ok(Value::Null),
        }
    }

    fn change_dispatch_value_at_path(&self, path: &str) -> Result<Value, String> {
        if path.is_empty() {
            return self.change_for_dispatch();
        }

        match &self.raw_bytes {
            RetainedContent::Retained(raw_bytes) => {
                let projection = project_change_bytes_for_dispatch(raw_bytes, &[path.to_string()])?;
                Ok(value_at_path(&projection, path)
                    .cloned()
                    .unwrap_or(Value::Null))
            }
            RetainedContent::Oversized { len } => Err(oversized_dispatch_error(*len)),
            RetainedContent::Absent => Ok(value_at_path(&self.change_for_match, path)
                .cloned()
                .unwrap_or(Value::Null)),
        }
    }

    fn match_value_at_path(&self, path: &str) -> Option<&Value> {
        match path.split_once('.') {
            None if path == "change" => Some(&self.change_for_match),
            None if path == "envelope" => Some(&self.envelope),
            Some(("change", rest)) => value_at_path(&self.change_for_match, rest),
            Some(("envelope", rest)) => value_at_path(&self.envelope, rest),
            _ => None,
        }
    }
}

#[cfg(test)]
fn lifecycle_mutation(event_type: &str) -> MutationContext {
    MutationContext {
        change_for_match: json!({
            "properties": {
                "event_type": event_type,
            }
        }),
        change_for_dispatch: OnceLock::new(),
        raw_bytes: RetainedContent::Absent,
        envelope: Value::Object(Map::new()),
    }
}

pub(super) fn project_change_bytes_for_match(bytes: &[u8], paths: &[String]) -> Value {
    if paths.is_empty() {
        return Value::Object(Map::new());
    }

    if paths.iter().any(|path| path.is_empty()) {
        // Bounded full materialization (mirrors the dispatch path's MAX_DISPATCH_CHANGE_BYTES
        // guard in parse_dispatch_change / project_change_bytes_for_dispatch).
        //
        // An empty required path comes from a `change` predicate with no sub-path
        // (collect_predicate_change_paths pushes String::new()): it forces parsing the WHOLE
        // delta content into a Value. Because the trigger-engine's live subscription matches ALL
        // addresses, it receives multi-megabyte deltas (bulk eeaf/package writes). Without this
        // bound, full-parsing one — then cloning it in match_json() — exhausts WASM linear memory
        // and traps (BTreeMap clone OOM) inside handle_query, killing every autonomous trigger.
        //
        // Oversized content is matched against its size envelope only; address / partition /
        // retraction predicates still evaluate because the envelope Value is separate and small,
        // and content-field predicates simply do not match a blob too large to inspect safely
        // (the same outcome the bounded dispatch path already enforces). The streaming projection
        // branch below needs no bound: it materializes only the projected sub-tree (IgnoredAny
        // skips everything else), so it is memory-bounded by construction.
        if bytes.len() > MAX_DISPATCH_CHANGE_BYTES {
            return raw_bytes_match_summary(bytes);
        }
        return serde_json::from_slice::<Value>(bytes)
            .unwrap_or_else(|_| raw_bytes_match_summary(bytes));
    }

    let projection = ProjectionNode::from_paths(paths);
    project_change_bytes_with_projection(bytes, &projection)
        .unwrap_or_else(|_| raw_bytes_match_summary(bytes))
}

fn raw_bytes_match_summary(bytes: &[u8]) -> Value {
    json!({
        "kind": "raw_bytes",
        "size": bytes.len(),
    })
}

fn parse_dispatch_change(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_DISPATCH_CHANGE_BYTES {
        return Err(format!(
            "trigger-engine: dispatch change materialization exceeds callback-safe JSON bound: bytes={} max={}",
            bytes.len(),
            MAX_DISPATCH_CHANGE_BYTES
        ));
    }

    serde_json::from_slice(bytes)
        .map_err(|e| format!("trigger-engine: dispatch change JSON parse failed: {e}"))
}

fn project_change_bytes_for_dispatch(bytes: &[u8], paths: &[String]) -> Result<Value, String> {
    if bytes.len() > MAX_DISPATCH_CHANGE_BYTES {
        return Err(format!(
            "trigger-engine: dispatch path materialization exceeds callback-safe JSON bound: bytes={} max={}",
            bytes.len(),
            MAX_DISPATCH_CHANGE_BYTES
        ));
    }

    if paths.is_empty() || paths.iter().any(|path| path.is_empty()) {
        return parse_dispatch_change(bytes);
    }

    let projection = ProjectionNode::from_paths(paths);
    project_change_bytes_with_projection(bytes, &projection)
        .map_err(|e| format!("trigger-engine: dispatch path JSON parse failed: {e}"))
}

pub(super) fn envelope_value(
    partition: &PartitionKey,
    address: &FactAddress,
    content_hash: Option<&str>,
    is_retraction: bool,
) -> Value {
    let mut value = json!({
        "address": address.to_string(),
        "partition_key": partition.to_string(),
        "is_retraction": is_retraction,
    });

    if let Some(hash) = content_hash {
        value["content_hash"] = json!(hash);
    }

    if let Some(text) = address.as_utf8_text() {
        value["address_text"] = json!(text);
    }

    value
}

pub(super) fn match_compiled_rule_locally(
    predicates: &[CompiledMatchPredicate],
    mutation: &MutationContext,
) -> Result<bool, String> {
    for predicate in predicates {
        if !evaluate_compiled_match_predicate(predicate, mutation)? {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn match_change_paths(predicates: &[CompiledMatchPredicate]) -> Vec<String> {
    let mut paths = Vec::new();
    for predicate in predicates {
        collect_predicate_change_paths(predicate, &mut paths);
    }
    paths.sort();
    paths.dedup();
    paths
}

#[derive(Debug, Clone)]
pub(super) enum CompiledMatchPredicate {
    Equals {
        path: String,
        expected: Value,
    },
    NotEquals {
        path: String,
        expected: Value,
    },
    OneOf {
        path: String,
        values: Vec<Value>,
    },
    StartsWith {
        path: String,
        prefix: String,
    },
    IsNull {
        path: String,
    },
    IsNotNull {
        path: String,
    },
    Binding {
        binding: Box<Binding>,
        context_paths: Vec<String>,
    },
}

fn collect_predicate_change_paths(predicate: &CompiledMatchPredicate, paths: &mut Vec<String>) {
    match predicate {
        CompiledMatchPredicate::Equals { path, .. }
        | CompiledMatchPredicate::NotEquals { path, .. }
        | CompiledMatchPredicate::OneOf { path, .. }
        | CompiledMatchPredicate::StartsWith { path, .. }
        | CompiledMatchPredicate::IsNull { path }
        | CompiledMatchPredicate::IsNotNull { path } => {
            if let Some(change_path) = path.strip_prefix("change.") {
                paths.push(change_path.to_string());
            } else if path == "change" {
                paths.push(String::new());
            }
        }
        CompiledMatchPredicate::Binding { context_paths, .. } => {
            for path in context_paths {
                if let Some(change_path) = path.strip_prefix("change.") {
                    paths.push(change_path.to_string());
                } else if path == "change" {
                    paths.push(String::new());
                }
            }
        }
    }
}

fn evaluate_compiled_match_predicate(
    predicate: &CompiledMatchPredicate,
    mutation: &MutationContext,
) -> Result<bool, String> {
    match predicate {
        CompiledMatchPredicate::Equals { path, expected } => {
            Ok(mutation.match_value_at_path(path) == Some(expected))
        }
        CompiledMatchPredicate::NotEquals { path, expected } => {
            let Some(actual) = mutation.match_value_at_path(path) else {
                return Ok(false);
            };
            Ok(actual != expected)
        }
        CompiledMatchPredicate::OneOf { path, values } => {
            let Some(actual) = mutation.match_value_at_path(path) else {
                return Ok(false);
            };
            Ok(values.iter().any(|expected| actual == expected))
        }
        CompiledMatchPredicate::StartsWith { path, prefix } => {
            let Some(actual) = mutation.match_value_at_path(path).and_then(Value::as_str) else {
                return Ok(false);
            };
            Ok(actual.starts_with(prefix))
        }
        CompiledMatchPredicate::IsNull { path } => Ok(mutation
            .match_value_at_path(path)
            .map(Value::is_null)
            .unwrap_or(true)),
        CompiledMatchPredicate::IsNotNull { path } => Ok(mutation
            .match_value_at_path(path)
            .map(|value| !value.is_null())
            .unwrap_or(false)),
        CompiledMatchPredicate::Binding {
            binding,
            context_paths,
        } => {
            let context = materialize_context_paths(mutation, context_paths);
            evaluate_binding(binding.as_ref(), &context).map(|value| truthy(&value))
        }
    }
}

pub(super) fn resolve_template_value_for_mutation(
    value: &Value,
    mutation: &MutationContext,
    matched_bindings: Option<&Map<String, Value>>,
) -> Result<Value, String> {
    match value {
        Value::Object(map) => {
            if map.contains_key("$bind")
                || map.get("$kind").and_then(Value::as_str) == Some("binding")
            {
                let binding = normalize_binding_value(value)?;
                if let Some(value) =
                    resolve_direct_mutation_binding(&binding, mutation, matched_bindings)?
                {
                    return Ok(value);
                }

                let context = materialize_dispatch_context_for_binding(mutation, &binding)?;
                let context = with_matched_bindings(context, matched_bindings);
                return evaluate_binding(&binding, &context);
            }

            let mut out = Map::new();
            for (k, v) in map {
                out.insert(
                    k.clone(),
                    resolve_template_value_for_mutation(v, mutation, matched_bindings)?,
                );
            }
            Ok(Value::Object(out))
        }
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(resolve_template_value_for_mutation(
                    item,
                    mutation,
                    matched_bindings,
                )?);
            }
            Ok(Value::Array(out))
        }
        primitive => Ok(primitive.clone()),
    }
}

pub(super) fn value_at_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return Some(value);
    }

    let mut current = value;
    for segment in path.split('.') {
        match current {
            Value::Object(map) => {
                current = map.get(segment)?;
            }
            Value::Array(items) => {
                current = items.get(segment.parse::<usize>().ok()?)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::Null => false,
        Value::Number(n) => n.as_i64().map(|v| v != 0).unwrap_or_else(|| {
            n.as_u64()
                .map(|v| v != 0)
                .unwrap_or_else(|| n.as_f64().map(|v| v != 0.0).unwrap_or(false))
        }),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn operator_resolver() -> &'static OperatorResolver {
    static RESOLVER: OnceLock<OperatorResolver> = OnceLock::new();
    RESOLVER.get_or_init(|| {
        let registry = Arc::new(create_core_registry().expect("core operator registry"));
        Arc::new(move |key: &str| registry.get(key))
    })
}

fn evaluate_binding(binding: &Binding, context: &Value) -> Result<Value, String> {
    let ctx = BindingEvaluationContext {
        context: context.clone(),
        ..BindingEvaluationContext::default()
    };
    let result =
        evaluate_binding_with_resolver(binding, &Value::Null, &ctx, operator_resolver(), None);
    if result
        .diagnostics
        .iter()
        .any(|d| matches!(d.level, DiagnosticLevel::Error))
    {
        return Err(format!(
            "binding evaluation produced errors: {:?}",
            result.diagnostics
        ));
    }
    Ok(result.value)
}

fn resolve_direct_mutation_binding(
    binding: &Binding,
    mutation: &MutationContext,
    matched_bindings: Option<&Map<String, Value>>,
) -> Result<Option<Value>, String> {
    if binding.transform.is_some() || binding.default.is_some() {
        return Ok(None);
    }

    let Some(select) = &binding.select else {
        return Ok(None);
    };

    if select.key.is_some() {
        return Ok(None);
    }

    match select.from.unwrap_or_default() {
        SelectSource::Context => {
            let path = select
                .path
                .as_ref()
                .and_then(static_path_string)
                .unwrap_or_default();
            if path == "bindings" {
                return Ok(Some(
                    matched_bindings
                        .map(|bindings| Value::Object(bindings.clone()))
                        .unwrap_or(Value::Null),
                ));
            }
            if let Some(path) = path.strip_prefix("bindings.") {
                let value = matched_bindings
                    .map(|bindings| {
                        let bindings_value = Value::Object(bindings.clone());
                        value_at_path(&bindings_value, path)
                            .cloned()
                            .unwrap_or(Value::Null)
                    })
                    .unwrap_or(Value::Null);
                return Ok(Some(value));
            }
            if path.is_empty()
                || path == "change"
                || path == "envelope"
                || path.starts_with("change.")
                || path.starts_with("envelope.")
            {
                return mutation.dispatch_value_at_path(&path).map(Some);
            }
            Ok(None)
        }
        SelectSource::Literal => Ok(Some(select.value.clone().unwrap_or(Value::Null))),
        _ => Ok(None),
    }
}

fn materialize_dispatch_context_for_binding(
    mutation: &MutationContext,
    binding: &Binding,
) -> Result<Value, String> {
    let mut context_paths = Vec::new();
    collect_binding_context_paths(binding, &mut context_paths);
    context_paths.sort();
    context_paths.dedup();
    materialize_dispatch_context_paths(mutation, &context_paths)
}

fn materialize_dispatch_context_paths(
    mutation: &MutationContext,
    paths: &[String],
) -> Result<Value, String> {
    if paths.is_empty() {
        return Ok(Value::Object(Map::new()));
    }

    if paths.iter().any(|path| path.is_empty()) {
        return mutation.full_json();
    }

    let mut context = Value::Object(Map::new());
    for path in paths {
        let value = mutation.dispatch_value_at_path(path)?;
        if !value.is_null() {
            insert_path_value(&mut context, path, value);
        }
    }
    Ok(context)
}

fn with_matched_bindings(
    mut context: Value,
    matched_bindings: Option<&Map<String, Value>>,
) -> Value {
    let Some(bindings) = matched_bindings else {
        return context;
    };

    if !context.is_object() {
        context = Value::Object(Map::new());
    }
    if let Some(context_obj) = context.as_object_mut() {
        context_obj.insert("bindings".to_string(), Value::Object(bindings.clone()));
    }
    context
}

pub(super) fn compile_match_condition(
    condition: &Value,
) -> Result<Vec<CompiledMatchPredicate>, String> {
    match condition {
        Value::Object(map) => {
            if let Some(conditions) = map.get("conditions").and_then(|v| v.as_array()) {
                let mut predicates = Vec::new();
                for condition in conditions {
                    predicates.extend(compile_single_match_condition(condition)?);
                }
                Ok(predicates)
            } else {
                compile_single_match_condition(condition)
            }
        }
        Value::Array(items) => {
            let mut predicates = Vec::new();
            for item in items {
                predicates.extend(compile_single_match_condition(item)?);
            }
            Ok(predicates)
        }
        _ => Err("match_condition must be an object or array".to_string()),
    }
}

fn compile_single_match_condition(
    condition: &Value,
) -> Result<Vec<CompiledMatchPredicate>, String> {
    let binding = normalize_binding_value(condition)?;
    Ok(vec![compile_binding_predicate(binding)])
}

fn compile_binding_predicate(binding: Binding) -> CompiledMatchPredicate {
    let Some(select) = &binding.select else {
        return binding_fallback_predicate(binding);
    };

    if select.from != Some(SelectSource::Context) || select.key.is_some() {
        return binding_fallback_predicate(binding);
    }

    let Some(path) = select.path.as_ref().and_then(static_path_string) else {
        return binding_fallback_predicate(binding);
    };

    let Some(transform) = &binding.transform else {
        return binding_fallback_predicate(binding);
    };

    if transform.len() != 1 {
        return binding_fallback_predicate(binding);
    }

    let step = &transform[0];
    match step.op.as_str() {
        "op:core.eq" | "op:core.equals" => step
            .args
            .as_ref()
            .and_then(|args| args.get("value").cloned())
            .map(|expected| CompiledMatchPredicate::Equals { path, expected })
            .unwrap_or_else(|| binding_fallback_predicate(binding)),
        "op:core.ne" | "op:core.not_equals" => step
            .args
            .as_ref()
            .and_then(|args| args.get("value").cloned())
            .map(|expected| CompiledMatchPredicate::NotEquals { path, expected })
            .unwrap_or_else(|| binding_fallback_predicate(binding)),
        "op:core.in_list" => step
            .args
            .as_ref()
            .and_then(|args| args.get("values"))
            .and_then(Value::as_array)
            .map(|values| CompiledMatchPredicate::OneOf {
                path,
                values: values.clone(),
            })
            .unwrap_or_else(|| binding_fallback_predicate(binding)),
        "op:core.starts_with" => step
            .args
            .as_ref()
            .and_then(|args| args.get("prefix"))
            .and_then(Value::as_str)
            .map(|prefix| CompiledMatchPredicate::StartsWith {
                path,
                prefix: prefix.to_string(),
            })
            .unwrap_or_else(|| binding_fallback_predicate(binding)),
        "op:core.is_null" => CompiledMatchPredicate::IsNull { path },
        "op:core.is_not_null" => CompiledMatchPredicate::IsNotNull { path },
        "op:core.or" => step
            .args
            .as_ref()
            .and_then(|args| args.get("values"))
            .and_then(Value::as_array)
            .and_then(|values| extract_self_equals_values(values))
            .map(|values| CompiledMatchPredicate::OneOf { path, values })
            .unwrap_or_else(|| binding_fallback_predicate(binding)),
        _ => binding_fallback_predicate(binding),
    }
}

fn binding_fallback_predicate(binding: Binding) -> CompiledMatchPredicate {
    let mut context_paths = Vec::new();
    collect_binding_context_paths(&binding, &mut context_paths);
    context_paths.sort();
    context_paths.dedup();
    CompiledMatchPredicate::Binding {
        binding: Box::new(binding),
        context_paths,
    }
}

fn extract_self_equals_values(values: &[Value]) -> Option<Vec<Value>> {
    let mut expected_values = Vec::with_capacity(values.len());
    for value in values {
        let binding = serde_json::from_value::<Binding>(value.clone()).ok()?;
        let expected = extract_self_equals_value(&binding)?;
        expected_values.push(expected);
    }
    Some(expected_values)
}

fn extract_self_equals_value(binding: &Binding) -> Option<Value> {
    let select = binding.select.as_ref()?;
    if select.from != Some(SelectSource::SelfSource) || select.key.is_some() {
        return None;
    }
    if select
        .path
        .as_ref()
        .and_then(static_path_string)
        .is_some_and(|path| !path.is_empty())
    {
        return None;
    }

    let transform = binding.transform.as_ref()?;
    if transform.len() != 1 {
        return None;
    }

    let step = &transform[0];
    if step.op != "op:core.equals" {
        return None;
    }

    step.args.as_ref()?.get("value").cloned()
}

fn collect_binding_context_paths(binding: &Binding, paths: &mut Vec<String>) {
    if let Some(select) = &binding.select {
        collect_select_context_paths(select, paths);
    }

    if let Some(transforms) = &binding.transform {
        for transform in transforms {
            if let Some(args) = &transform.args {
                for value in args.values() {
                    collect_value_context_paths(value, paths);
                }
            }
        }
    }
}

fn collect_select_context_paths(
    select: &composition_ast::binding::ast::BindingSelect,
    paths: &mut Vec<String>,
) {
    if let Some(composition_ast::binding::ast::SelectKey::Dynamic(binding)) = &select.key {
        collect_binding_context_paths(binding, paths);
    }

    if select.from == Some(SelectSource::Context) {
        paths.push(
            select
                .path
                .as_ref()
                .and_then(static_path_string)
                .unwrap_or_default(),
        );
    }
}

fn collect_value_context_paths(value: &Value, paths: &mut Vec<String>) {
    match value {
        Value::Object(map)
            if map.get("$kind").and_then(Value::as_str) == Some("binding")
                || map.contains_key("$bind") =>
        {
            if let Ok(binding) = normalize_binding_value(value) {
                collect_binding_context_paths(&binding, paths);
                return;
            }
            for value in map.values() {
                collect_value_context_paths(value, paths);
            }
        }
        Value::Object(map) => {
            for value in map.values() {
                collect_value_context_paths(value, paths);
            }
        }
        Value::Array(items) => {
            for value in items {
                collect_value_context_paths(value, paths);
            }
        }
        _ => {}
    }
}

fn materialize_context_paths(mutation: &MutationContext, paths: &[String]) -> Value {
    if paths.is_empty() || paths.iter().any(|path| path.is_empty()) {
        return mutation.match_json();
    }

    let mut context = Value::Object(Map::new());
    for path in paths {
        if let Some(value) = mutation.match_value_at_path(path) {
            insert_path_value(&mut context, path, value.clone());
        }
    }
    context
}

fn insert_path_value(root: &mut Value, path: &str, value: Value) {
    let segments: Vec<&str> = path
        .split('.')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.is_empty() {
        *root = value;
        return;
    }

    let mut current = root;
    for segment in &segments[..segments.len() - 1] {
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }
        let map = current.as_object_mut().expect("object initialized above");
        current = map
            .entry((*segment).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
    }

    if !current.is_object() {
        *current = Value::Object(Map::new());
    }
    let map = current.as_object_mut().expect("object initialized above");
    map.insert(segments[segments.len() - 1].to_string(), value);
}

#[derive(Debug, Default)]
struct ProjectionNode {
    include_self: bool,
    children: BTreeMap<String, ProjectionNode>,
}

impl ProjectionNode {
    fn from_paths(paths: &[String]) -> Self {
        let mut root = Self::default();
        for path in paths {
            let mut current = &mut root;
            for segment in path.split('.').filter(|segment| !segment.is_empty()) {
                current = current.children.entry(segment.to_string()).or_default();
            }
            current.include_self = true;
        }
        root
    }
}

struct ProjectedJsonSeed<'a> {
    projection: &'a ProjectionNode,
}

impl<'de> DeserializeSeed<'de> for ProjectedJsonSeed<'_> {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        if self.projection.include_self {
            return Value::deserialize(deserializer);
        }

        if self.projection.children.is_empty() {
            IgnoredAny::deserialize(deserializer)?;
            return Ok(Value::Null);
        }

        deserializer.deserialize_any(ProjectedJsonVisitor {
            projection: self.projection,
        })
    }
}

struct ProjectedJsonVisitor<'a> {
    projection: &'a ProjectionNode,
}

impl<'de> Visitor<'de> for ProjectedJsonVisitor<'_> {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value to project")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut output = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if let Some(child) = self.projection.children.get(&key) {
                let value = map.next_value_seed(ProjectedJsonSeed { projection: child })?;
                output.insert(key, value);
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(Value::Object(output))
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: de::SeqAccess<'de>,
    {
        // Projection paths address arrays by numeric segment ("items.0.title") —
        // the same addressing value_at_path resolves. Non-selected elements are
        // streamed past as IgnoredAny; selected indices recurse with their child
        // projection. Output preserves element positions so the projected tree
        // stays addressable by the ORIGINAL path.
        let mut output = Vec::new();
        let mut index = 0usize;
        loop {
            let child = self.projection.children.get(&index.to_string());
            let element = match child {
                Some(child) => seq.next_element_seed(ProjectedJsonSeed { projection: child })?,
                None => seq
                    .next_element::<IgnoredAny>()?
                    .map(|IgnoredAny| Value::Null),
            };
            match element {
                Some(value) => output.push(value),
                None => break,
            }
            index += 1;
        }
        Ok(Value::Array(output))
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Null)
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Null)
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Null)
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Null)
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Null)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Null)
    }
}

fn static_path_string(path: &PathInput) -> Option<String> {
    match path {
        PathInput::String(path) => Some(path.clone()),
        PathInput::Array(segments) => {
            let mut path = String::new();
            for (index, segment) in segments.iter().enumerate() {
                if index > 0 {
                    path.push('.');
                }
                match segment {
                    PathSegment::Key(key) => path.push_str(key),
                    PathSegment::Index(index) => path.push_str(&index.to_string()),
                }
            }
            Some(path)
        }
    }
}

fn normalize_binding_value(value: &Value) -> Result<Binding, String> {
    let binding_json = match value {
        Value::Object(map) if map.contains_key("$bind") => map
            .get("$bind")
            .cloned()
            .ok_or_else(|| "legacy $bind object missing inner binding".to_string())?,
        Value::Object(map) if map.get("$kind").and_then(Value::as_str) == Some("binding") => {
            value.clone()
        }
        _ => {
            return Err(format!(
                "unsupported binding node: {}",
                serde_json::to_string(value).unwrap_or_default()
            ))
        }
    };

    let binding_json = normalize_binding_object(binding_json)?;
    serde_json::from_value(binding_json).map_err(|e| format!("binding deserialize failed: {e}"))
}

fn normalize_binding_object(mut binding_json: Value) -> Result<Value, String> {
    let obj = binding_json
        .as_object_mut()
        .ok_or_else(|| "binding node must be a JSON object".to_string())?;
    obj.entry("$kind".to_string())
        .or_insert_with(|| Value::String("binding".to_string()));

    if let Some(select) = obj.get_mut("select").and_then(|v| v.as_object_mut()) {
        normalize_select(select)?;
    }

    let keys: Vec<String> = obj.keys().cloned().collect();
    for key in keys {
        if let Some(value) = obj.remove(&key) {
            obj.insert(key, normalize_binding_tree(value)?);
        }
    }

    Ok(binding_json)
}

fn normalize_binding_tree(value: Value) -> Result<Value, String> {
    match value {
        Value::Object(map) if map.contains_key("$bind") => {
            let inner = map
                .get("$bind")
                .cloned()
                .ok_or_else(|| "legacy $bind object missing inner binding".to_string())?;
            normalize_binding_object(inner)
        }
        Value::Object(map) if map.get("$kind").and_then(Value::as_str) == Some("binding") => {
            normalize_binding_object(Value::Object(map))
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, value) in map {
                out.insert(key, normalize_binding_tree(value)?);
            }
            Ok(Value::Object(out))
        }
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(normalize_binding_tree(item)?);
            }
            Ok(Value::Array(out))
        }
        primitive => Ok(primitive),
    }
}

fn normalize_select(select: &mut Map<String, Value>) -> Result<(), String> {
    let source = select
        .get("from")
        .and_then(Value::as_str)
        .unwrap_or("context")
        .to_string();
    let path = select
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    match source.as_str() {
        "change" => {
            select.insert("from".to_string(), Value::String("context".to_string()));
            select.insert(
                "path".to_string(),
                Value::String(if path.is_empty() {
                    "change".to_string()
                } else {
                    format!("change.{path}")
                }),
            );
        }
        "envelope" => {
            select.insert("from".to_string(), Value::String("context".to_string()));
            select.insert(
                "path".to_string(),
                Value::String(if path.is_empty() {
                    "envelope".to_string()
                } else {
                    format!("envelope.{path}")
                }),
            );
        }
        "input" => {
            select.insert("from".to_string(), Value::String("self".to_string()));
        }
        other if SelectSource::all_names().contains(&other) => {}
        other => return Err(format!("unsupported binding source '{other}'")),
    }

    Ok(())
}

fn project_change_bytes_with_projection(
    bytes: &[u8],
    projection: &ProjectionNode,
) -> Result<Value, serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    ProjectedJsonSeed { projection }.deserialize(&mut deserializer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_input_bindings_in_operator_args_use_current_match_value() {
        let bindings = compile_match_condition(&json!({
            "conditions": [{
                "$bind": {
                    "select": { "from": "change", "path": "sample_key" },
                    "transform": [{
                        "op": "op:core.or",
                        "args": {
                            "values": [
                                {
                                    "$kind": "binding",
                                    "select": { "from": "input", "path": "" },
                                    "transform": [{ "op": "op:core.equals", "args": { "value": "other-value" } }]
                                },
                                {
                                    "$kind": "binding",
                                    "select": { "from": "input", "path": "" },
                                    "transform": [{ "op": "op:core.equals", "args": { "value": "target-value" } }]
                                }
                            ]
                        }
                    }]
                }
            }]
        }))
        .unwrap();
        let mutation = MutationContext {
            change_for_match: json!({ "sample_key": "target-value" }),
            change_for_dispatch: OnceLock::new(),
            raw_bytes: RetainedContent::Absent,
            envelope: Value::Object(Map::new()),
        };

        assert!(match_compiled_rule_locally(&bindings, &mutation).unwrap());
    }

    #[test]
    fn simple_change_equals_condition_compiles_to_borrowed_predicate() {
        let predicates = compile_match_condition(&json!({
            "conditions": [{
                "$bind": {
                    "select": { "from": "change", "path": "sample_key" },
                    "transform": [{ "op": "op:core.equals", "args": { "value": "target-value" } }]
                }
            }]
        }))
        .unwrap();

        assert!(matches!(
            predicates.as_slice(),
            [CompiledMatchPredicate::Equals { path, expected }]
                if path == "change.sample_key" && expected == &json!("target-value")
        ));
    }

    #[test]
    fn simple_change_not_equals_condition_compiles_to_borrowed_predicate() {
        let predicates = compile_match_condition(&json!({
            "conditions": [{
                "$bind": {
                    "select": { "from": "change", "path": "sample_key" },
                    "transform": [{ "op": "op:core.not_equals", "args": { "value": "" } }]
                }
            }]
        }))
        .unwrap();

        assert!(matches!(
            predicates.as_slice(),
            [CompiledMatchPredicate::NotEquals { path, expected }]
                if path == "change.sample_key" && expected == &json!("")
        ));

        let matching_mutation = MutationContext {
            change_for_match: json!({ "sample_key": "target-value" }),
            change_for_dispatch: OnceLock::new(),
            raw_bytes: RetainedContent::Absent,
            envelope: Value::Object(Map::new()),
        };
        let non_matching_mutation = MutationContext {
            change_for_match: json!({ "sample_key": "" }),
            change_for_dispatch: OnceLock::new(),
            raw_bytes: RetainedContent::Absent,
            envelope: Value::Object(Map::new()),
        };
        let missing_path_mutation = MutationContext {
            change_for_match: json!({ "properties": { "event_type": "runtime_loaded" } }),
            change_for_dispatch: OnceLock::new(),
            raw_bytes: RetainedContent::Absent,
            envelope: Value::Object(Map::new()),
        };

        assert!(match_compiled_rule_locally(&predicates, &matching_mutation).unwrap());
        assert!(!match_compiled_rule_locally(&predicates, &non_matching_mutation).unwrap());
        assert!(!match_compiled_rule_locally(&predicates, &missing_path_mutation).unwrap());
    }

    #[test]
    fn simple_change_in_list_condition_compiles_to_borrowed_predicate() {
        let predicates = compile_match_condition(&json!({
            "conditions": [{
                "$bind": {
                    "select": { "from": "change", "path": "sample_key" },
                    "transform": [{ "op": "op:core.in_list", "args": { "values": ["alpha", "beta"] } }]
                }
            }]
        }))
        .unwrap();

        assert!(matches!(
            predicates.as_slice(),
            [CompiledMatchPredicate::OneOf { path, values }]
                if path == "change.sample_key" && values == &vec![json!("alpha"), json!("beta")]
        ));
    }

    #[test]
    fn starts_with_and_nested_or_condition_compile_to_borrowed_predicates() {
        let predicates = compile_match_condition(&json!({
            "conditions": [
                {
                    "$bind": {
                        "select": { "from": "envelope", "path": "address_text" },
                        "transform": [{ "op": "op:core.starts_with", "args": { "prefix": "sample-record|" } }]
                    }
                },
                {
                    "$bind": {
                        "select": { "from": "change", "path": "sample_key" },
                        "transform": [{
                            "op": "op:core.or",
                            "args": {
                                "values": [
                                    {
                                        "$kind": "binding",
                                        "select": { "from": "input", "path": "" },
                                        "transform": [{ "op": "op:core.equals", "args": { "value": "alpha" } }]
                                    },
                                    {
                                        "$kind": "binding",
                                        "select": { "from": "input", "path": "" },
                                        "transform": [{ "op": "op:core.equals", "args": { "value": "beta" } }]
                                    }
                                ]
                            }
                        }]
                    }
                }
            ]
        }))
        .unwrap();

        assert!(matches!(
            predicates.as_slice(),
            [
                CompiledMatchPredicate::StartsWith { path, prefix },
                CompiledMatchPredicate::OneOf { path: path2, values }
            ]
                if path == "envelope.address_text"
                    && prefix == "sample-record|"
                    && path2 == "change.sample_key"
                    && values == &vec![json!("alpha"), json!("beta")]
        ));

        let mutation = MutationContext {
            change_for_match: json!({ "sample_key": "beta" }),
            change_for_dispatch: OnceLock::new(),
            raw_bytes: RetainedContent::Absent,
            envelope: json!({ "address_text": "sample-record|partition|item|beta" }),
        };

        assert!(match_compiled_rule_locally(&predicates, &mutation).unwrap());
    }

    #[test]
    fn direct_lifecycle_condition_matches_event_type() {
        let bindings = compile_match_condition(&json!({
            "conditions": [{
                "$bind": {
                    "select": { "from": "change", "path": "properties.event_type" },
                    "transform": [{ "op": "op:core.equals", "args": { "value": "runtime_loaded" } }]
                }
            }]
        }))
        .unwrap();
        let mutation = lifecycle_mutation("runtime_loaded");

        assert!(match_compiled_rule_locally(&bindings, &mutation).unwrap());
    }

    #[test]
    fn change_projection_reads_only_requested_paths() {
        let bytes = serde_json::to_vec(&json!({
            "sample_owner": "item-one",
            "sample_key": "target-value",
            "sample_value": "\"enabled\"",
            "large_body": ["this value should not be materialized"]
        }))
        .unwrap();

        let projection = project_change_bytes_for_match(
            &bytes,
            &["sample_key".to_string(), "sample_value".to_string()],
        );

        assert_eq!(
            projection,
            json!({
                "sample_key": "target-value",
                "sample_value": "\"enabled\""
            })
        );
    }

    #[test]
    fn change_projection_resolves_numeric_array_index_paths() {
        // The exact shape that broke live dispatch: content-generation.article-result
        // carries its title at items[0], and the emit-engagement-candidate rule binds
        // `change.items.0.title`. The streaming projector must traverse the array
        // (visit_seq) instead of erroring "invalid type: sequence".
        let bytes = serde_json::to_vec(&json!({
            "kind": "content-generation.article-result",
            "items": [
                { "title": "the-title", "slug": "the-slug", "blocks": ["not", "projected"] },
                { "title": "second", "slug": "ignored" }
            ]
        }))
        .unwrap();

        let projection =
            project_change_bytes_for_dispatch(&bytes, &["items.0.title".to_string()]).unwrap();
        assert_eq!(
            value_at_path(&projection, "items.0.title"),
            Some(&json!("the-title"))
        );
        // Non-selected sibling fields/elements are not materialized.
        assert_eq!(value_at_path(&projection, "items.0.slug"), None);
        assert_eq!(value_at_path(&projection, "items.1.title"), None);
    }

    #[test]
    fn projection_composes_over_every_container_shape_without_special_cases() {
        // L069 adversarial combinatorial gauntlet for the ONE projection primitive
        // (shared by match AND dispatch): every hostile composition of the path
        // grammar over every container shape must emerge from the same two visitor
        // arms (visit_map / visit_seq) with ZERO type-branching special cases.
        // The discriminant (is "0" an array index or an object key?) lives in the
        // DATA, never in the code — the same segment string resolves against
        // whatever container the bytes actually carry.

        // seq-in-seq: "grid.1.0"
        let bytes = serde_json::to_vec(&json!({ "grid": [[10, 11], [20, 21]] })).unwrap();
        let projection =
            project_change_bytes_for_dispatch(&bytes, &["grid.1.0".to_string()]).unwrap();
        assert_eq!(value_at_path(&projection, "grid.1.0"), Some(&json!(20)));

        // map-in-seq-in-map-in-seq: "runs.0.steps.1.name"
        let bytes = serde_json::to_vec(&json!({
            "runs": [ { "steps": [ { "name": "a" }, { "name": "b" } ] } ]
        }))
        .unwrap();
        let projection =
            project_change_bytes_for_dispatch(&bytes, &["runs.0.steps.1.name".to_string()])
                .unwrap();
        assert_eq!(
            value_at_path(&projection, "runs.0.steps.1.name"),
            Some(&json!("b"))
        );

        // The SAME numeric segment resolving an OBJECT KEY "0" (JSON allows it):
        // no array assumption is baked into the path grammar.
        let bytes = serde_json::to_vec(&json!({ "byId": { "0": { "v": "zero" } } })).unwrap();
        let projection =
            project_change_bytes_for_dispatch(&bytes, &["byId.0.v".to_string()]).unwrap();
        assert_eq!(value_at_path(&projection, "byId.0.v"), Some(&json!("zero")));

        // Out-of-bounds index and non-numeric segment against an array: fail-safe
        // Null binding (same contract as a missing object key), never an error.
        let bytes = serde_json::to_vec(&json!({ "items": [ { "t": "x" } ] })).unwrap();
        let projection =
            project_change_bytes_for_dispatch(&bytes, &["items.9.t".to_string()]).unwrap();
        assert_eq!(value_at_path(&projection, "items.9.t"), None);
        let projection =
            project_change_bytes_for_dispatch(&bytes, &["items.first.t".to_string()]).unwrap();
        assert_eq!(value_at_path(&projection, "items.first.t"), None);

        // The MATCH leg shares the primitive: a match projection over an array path
        // resolves identically (no dispatch-only fix).
        let bytes = serde_json::to_vec(&json!({
            "items": [ { "title": "match-me", "noise": ["skip"] } ]
        }))
        .unwrap();
        let projection = project_change_bytes_for_match(&bytes, &["items.0.title".to_string()]);
        assert_eq!(
            value_at_path(&projection, "items.0.title"),
            Some(&json!("match-me"))
        );
    }

    #[test]
    fn root_scoped_presence_match_does_not_match_nested_dispatch_receipt_payload() {
        let predicates = compile_match_condition(&json!({
            "conditions": [
                {
                    "$kind": "binding",
                    "select": { "from": "change", "path": "accepted.0" },
                    "transform": [{ "op": "op:core.is_not_null" }]
                },
                {
                    "$kind": "binding",
                    "select": { "from": "envelope", "path": "is_retraction" },
                    "transform": [{ "op": "op:core.equals", "args": { "value": false } }]
                }
            ]
        }))
        .unwrap();

        let receipt_bytes = serde_json::to_vec(&json!({
            "kind": "trigger-dispatch-outcome",
            "dispatch": {
                "input": {
                    "batch": {
                        "accepted": [{ "native_ref": "nested-only" }]
                    }
                }
            }
        }))
        .unwrap();
        let change_paths = match_change_paths(&predicates);
        assert_eq!(change_paths, vec!["accepted.0"]);
        let projected = project_change_bytes_for_match(&receipt_bytes, &change_paths);
        assert_eq!(projected, json!({}));
        let mutation = MutationContext {
            change_for_match: projected,
            change_for_dispatch: OnceLock::new(),
            raw_bytes: RetainedContent::from_bytes(receipt_bytes),
            envelope: json!({ "is_retraction": false }),
        };

        assert!(matches!(
            &predicates[0],
            CompiledMatchPredicate::IsNotNull { path }
                if path == "change.accepted.0"
        ));

        assert!(!match_compiled_rule_locally(&predicates, &mutation).unwrap());
    }

    #[test]
    fn compiled_presence_predicates_preserve_missing_null_and_present_semantics() {
        let is_null = compile_match_condition(&json!({
            "$kind": "binding",
            "select": { "from": "change", "path": "value" },
            "transform": [{ "op": "op:core.is_null" }]
        }))
        .unwrap();
        let is_not_null = compile_match_condition(&json!({
            "$kind": "binding",
            "select": { "from": "change", "path": "value" },
            "transform": [{ "op": "op:core.is_not_null" }]
        }))
        .unwrap();

        for (change, expected_null, expected_not_null) in [
            (json!({}), true, false),
            (json!({ "value": null }), true, false),
            (json!({ "value": false }), false, true),
            (json!({ "value": 0 }), false, true),
            (json!({ "value": "" }), false, true),
        ] {
            let mutation = MutationContext {
                change_for_match: change,
                change_for_dispatch: OnceLock::new(),
                raw_bytes: RetainedContent::Absent,
                envelope: Value::Object(Map::new()),
            };
            assert_eq!(
                match_compiled_rule_locally(&is_null, &mutation).unwrap(),
                expected_null
            );
            assert_eq!(
                match_compiled_rule_locally(&is_not_null, &mutation).unwrap(),
                expected_not_null
            );
        }
    }

    #[test]
    fn empty_path_small_change_is_fully_materialized() {
        // A `change` predicate with no sub-path (empty required path) must still see the whole
        // content for normal, callback-safe records — this is what lets recording / result /
        // enrichment triggers match on arbitrary content fields.
        let bytes = serde_json::to_vec(&json!({
            "properties": { "kind": "recorded-file" },
            "owner": "item-one"
        }))
        .unwrap();

        let materialized = project_change_bytes_for_match(&bytes, &[String::new()]);

        assert_eq!(
            materialized,
            json!({
                "properties": { "kind": "recorded-file" },
                "owner": "item-one"
            })
        );
    }

    #[test]
    fn empty_path_oversized_change_is_bounded_to_size_summary() {
        // The OOM regression guard: an empty required path forces full materialization, but the
        // all-matching subscription receives multi-megabyte deltas. Content past the callback-safe
        // bound must collapse to a size envelope instead of parsing+cloning a giant Value (which
        // traps the WASM with a BTreeMap clone OOM in handle_query / match_json).
        let filler = "x".repeat(MAX_DISPATCH_CHANGE_BYTES + 1);
        let bytes = serde_json::to_vec(&json!({
            "properties": { "kind": "bulk-eeaf-write" },
            "blob": filler
        }))
        .unwrap();
        assert!(bytes.len() > MAX_DISPATCH_CHANGE_BYTES);

        let materialized = project_change_bytes_for_match(&bytes, &[String::new()]);

        assert_eq!(
            materialized,
            json!({
                "kind": "raw_bytes",
                "size": bytes.len(),
            })
        );
    }

    #[test]
    fn oversized_content_is_dropped_at_retention_not_merely_at_projection() {
        // The deepest-root guard (converged Claude + Codex GPT-5.5 gauntlet). The prior guard
        // (`empty_path_oversized_change_is_bounded_to_size_summary`) proves the PROJECTION of
        // oversized bytes is bounded — but the OOM came from RETAINING the raw `Vec<u8>` and
        // deep-cloning it per mutation / per replay, and from a specific-path projection that is
        // NOT globally length-capped. `RetainedContent::from_bytes` closes the category: bytes
        // past the bound never enter retained state at all, so peak retained content is
        // `OBSERVED_MUTATION_REPLAY_LIMIT * MAX_DISPATCH_CHANGE_BYTES`, independent of delta size.

        // Oversized content is reduced to a size marker (buffer freed immediately, nothing retained).
        let filler = "x".repeat(MAX_DISPATCH_CHANGE_BYTES + 1);
        let oversized = serde_json::to_vec(&json!({
            "properties": { "kind": "bulk-eeaf-write" },
            "deep": { "nested": { "blob": filler } }
        }))
        .unwrap();
        let oversized_len = oversized.len();
        assert!(oversized_len > MAX_DISPATCH_CHANGE_BYTES);
        match RetainedContent::from_bytes(oversized) {
            RetainedContent::Oversized { len } => assert_eq!(len, oversized_len),
            other => panic!("oversized content must not be retained, got {other:?}"),
        }

        // Callback-safe content is retained ONCE as an Arc<[u8]> (shared by pointer on every clone).
        let small = serde_json::to_vec(&json!({
            "properties": { "kind": "chat-message" },
            "owner": "thread-one"
        }))
        .unwrap();
        let retained = RetainedContent::from_bytes(small);
        let shared = match &retained {
            RetainedContent::Retained(bytes) => Arc::clone(bytes),
            other => panic!("callback-safe content must be retained, got {other:?}"),
        };
        // Clone is O(1) pointer-sharing: the cloned Arc points at the SAME allocation.
        assert!(Arc::ptr_eq(
            &shared,
            match &retained.clone() {
                RetainedContent::Retained(bytes) => bytes,
                _ => unreachable!(),
            }
        ));

        // A MutationContext built from oversized content degrades EXACTLY like the live path:
        // the match sees the size envelope, the dispatch fails closed (never traps, never parses).
        let context = MutationContext {
            change_for_match: oversized_content_match_summary(oversized_len),
            change_for_dispatch: OnceLock::new(),
            raw_bytes: RetainedContent::Oversized { len: oversized_len },
            envelope: Value::Object(Map::new()),
        };
        assert_eq!(
            context.match_json(),
            json!({
                "change": { "kind": "raw_bytes", "size": oversized_len },
                "envelope": {},
            })
        );
        let dispatch = context.change_for_dispatch();
        assert!(
            dispatch
                .as_ref()
                .err()
                .is_some_and(|e| e.contains("callback-safe JSON bound")),
            "oversized dispatch must fail closed, got {dispatch:?}"
        );
        // A specific-path dispatch on oversized content also fails closed rather than materializing
        // an uncapped subtree (the hole Codex found: `change.deep.nested.blob` on a 4MB record).
        let deep = context.change_dispatch_value_at_path("deep.nested.blob");
        assert!(
            deep.as_ref()
                .err()
                .is_some_and(|e| e.contains("callback-safe JSON bound")),
            "oversized specific-path dispatch must fail closed, got {deep:?}"
        );
    }
}
