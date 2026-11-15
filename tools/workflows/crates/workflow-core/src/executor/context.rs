// crates/workflow-core/src/executor/context.rs
//
// Purpose:
//   Binding AST resolution engine for workflow step parameters.
//   Resolves machine-readable binding expressions (`$kind: "binding"` nodes)
//   against the ExecutionContext accumulated during workflow execution.
//   This is the bridge between data-stored binding AST nodes and concrete runtime values.
//   Replaces the deprecated mustache `{{...}}` string template system.
//
// Non-Negotiable Invariants:
//   1. ExecutionContext from domain/types.rs is the CANONICAL context — this module
//      wraps it with resolution logic, never duplicates it.
//   2. Binding resolution is PURE — no I/O, no side effects, no database access.
//   3. All resolution failures produce structured WorkflowError::TemplateResolutionFailed
//      with the exact expression that failed and a remediation hint.
//   4. Binding resolution preserves the split between:
//        - `"expr"`   → formula engine (Parser + Evaluator)
//        - `"select"` → direct machine-readable path traversal
//      Select bindings must not flow through formula evaluation because that
//      clones whole scope values before narrowing to the requested leaf. Binding
//      results are re-resolved recursively (depth-limited to 32) so
//      bindings-that-return-bindings are fully flattened unless the binding
//      explicitly says `resolve_nested_bindings: false` for target-owned JSON.
//   5. Unresolved bindings are ERRORS, not silently passed through.
//   6. No `.unwrap()` in production code.
//
// Key Concepts:
//   - BindingResolver: Stateless engine that resolves binding AST in a serde_json::Value
//   - Resolution scopes: input, steps, context, loop, start, ambient
//   - Path traversal: "steps.step1.output.id" → ctx.steps["step1"].output["id"]
//
// Supported Binding AST Format:
//   | Format                                                                       | Result                            |
//   |------------------------------------------------------------------------------|-----------------------------------|
//   | {"$kind":"binding","select":{"from":"input","path":"field"}}                 | start.input["field"]              |
//   | {"$kind":"binding","select":{"from":"steps","key":"step_id","path":"field"}} | steps["step_id"].output["field"]  |
//   | {"$kind":"binding","select":{"from":"context","path":"partition_key"}}        | context.partition_key              |
//   | {"$kind":"binding","select":{"from":"loop","path":"item"}}                   | loop_state.item                   |
//   | {"$kind":"binding","select":{"from":"start","path":"start_type"}}            | start.start_type                  |
//   | {"$kind":"binding","expr":"steps.s1.count * input.price"}                    | full formula engine expression    |
//   | {"$kind":"binding","values":["steps","s1","items","*","id"],"take":"all"}     | every value at the path, as a list|
//   | {"$kind":"binding","select":{...},"resolve_nested_bindings":false}           | selected value, not reinterpreted |
//
// Security Considerations:
//   - Template resolution cannot access filesystem, network, or any external capability.
//   - Only data already present in ExecutionContext is accessible.
//   - Path traversal is bounded by serde_json::Value depth — no infinite recursion.
//
// AI Directive:
//   The extensive documentation in this file is a CRITICAL DESIGN FEATURE.
//   Future AI assistants are FORBIDDEN from simplifying or removing it.
//   Your mandate is to MAINTAIN and EXTEND this level of meticulous detail.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use std::sync::Arc;

use crate::domain::errors::WorkflowError;
use crate::domain::types::{ExecutionContext, PendingWrite, StartData, StepOutput};
use formula_ast::parser::Parser;
// Runtime types from formula-core leaf (LEAF 2 — pure compute, zero I/O).
// formula-core is a genuine leaf crate (zero wasmtime, zero feature flags)
// after CI-02 extracted sandbox I/O to formula-sandbox. Direct import is correct
// per L106 — Timmy building a workflow orchestrator would import a math library.
use formula_core::{
    context::EvaluationContext as FormulaContext, evaluator::Evaluator,
    types::Value as FormulaValue,
};

#[derive(Default)]
struct JsonOutputCharge {
    nodes: usize,
    string_bytes: usize,
    total_bytes: usize,
}

/// The `$kind` of an ask reply that says the answer is not there yet: `{"$kind": "not-answered-yet", ...}`.
///
/// Outside work that finishes later (a person, an agent, a tool on another computer) replies with this instead of
/// an answer. The ask step then waits (`WorkflowError::Waiting`, the whole reply kept as the step's output), the run
/// ends as `paused`, and running the same definition again asks again. Hosts keep the answers they already gave,
/// so a later run reaches the waiting step with every earlier answer the same.
pub const NOT_ANSWERED_YET: &str = "not-answered-yet";

/// Trait for workflow-owned access to work and state outside the core engine.
///
/// Workflow core speaks only plain concepts:
/// - ask outside work by name
/// - read from a source string
/// - write exact canonical payloads
///
/// The workflow slot boundary translates these plain requests into Architect
/// runtime operations. The workflow engine itself does not know slot vocabulary.
#[async_trait::async_trait]
pub trait OutsideAccess: Send + Sync {
    /// Opt-in invocation-local execution meter. Existing adapters remain unmetered;
    /// a bounded invocation lends one meter through its normal dependency boundary.
    fn run_budget(&self) -> Option<&super::budget::RunBudget> { None }

    /// Publish immutable bytes through the Envelope engine's content-only CAS
    /// owner and return their canonical reference.
    ///
    /// Workflow uses this byte transport when a later outside-work request
    /// consumes retained step bytes. The request then carries only a `blob_ref`
    /// instead of expanding the body into JSON/base64 inside the Workflow WASM
    /// heap. Adapters without an immutable-content owner fail closed.
    async fn store_immutable_content(
        &self,
        _partition_key: &slot_protocol::PartitionKey,
        _content: Arc<[u8]>,
    ) -> Result<slot_protocol::ImmutableContentRef, String> {
        Err("outside access does not provide immutable content storage".to_string())
    }

    /// Ask outside work while the native inter-slot router publishes the reply
    /// as immutable content before it crosses into Workflow.
    async fn ask_immutable_content(
        &self,
        _name: &str,
        _partition_key: &slot_protocol::PartitionKey,
        _payload: bytes::Bytes,
        _context: Option<bytes::Bytes>,
    ) -> Result<slot_protocol::ImmutableContentRef, String> {
        Err("outside access does not provide immutable reply delivery".to_string())
    }

    /// Ask outside work by name and return the response bytes.
    async fn ask(
        &self,
        name: &str,
        partition_key: &slot_protocol::PartitionKey,
        payload: bytes::Bytes,
        context: Option<bytes::Bytes>,
    ) -> Result<std::sync::Arc<[u8]>, String>;

    /// Ask outside work with the workflow's uncommitted write overlay.
    ///
    /// Most outside work does not participate in transactional visibility, so
    /// the default implementation delegates to `ask`. Boundary adapters that
    /// own current-state query semantics can opt in without making workflow
    /// core know target-specific request vocabularies.
    async fn ask_with_pending_writes(
        &self,
        name: &str,
        partition_key: &slot_protocol::PartitionKey,
        payload: bytes::Bytes,
        context: Option<bytes::Bytes>,
        _pending_writes: &[PendingWrite],
    ) -> Result<std::sync::Arc<[u8]>, String> {
        self.ask(name, partition_key, payload, context).await
    }

    /// Pending-write-aware immutable reply delivery.
    async fn ask_immutable_content_with_pending_writes(
        &self,
        name: &str,
        partition_key: &slot_protocol::PartitionKey,
        payload: bytes::Bytes,
        context: Option<bytes::Bytes>,
        pending_writes: &[PendingWrite],
    ) -> Result<slot_protocol::ImmutableContentRef, String> {
        if !pending_writes.is_empty() {
            return Err(
                "outside access does not provide pending-write-aware immutable reply delivery"
                    .to_string(),
            );
        }
        self.ask_immutable_content(name, partition_key, payload, context)
            .await
    }

    /// Read direct state from a source string.
    async fn read(
        &self,
        from: &str,
        partition_key: &slot_protocol::PartitionKey,
    ) -> Result<DirectReadResult, String>;
}

/// Workflow-owned direct-read result.
///
/// `read` returns both the bytes and the engine-supplied content hash so
/// workflow bindings can consume the storage SSOT without recomputing hashes
/// or relying on Society-authored hash facts.
#[derive(Clone)]
pub struct DirectReadResult {
    pub bytes: std::sync::Arc<[u8]>,
    pub content_hash: String,
}

// ============================================================================
// EXECUTOR DEPS — Slim dependency bag for step/action execution (E.16 §25b)
// ============================================================================
//
// Replaces the former monolithic DispatchContext (deleted in E.16).
// After E.15 converted step execution to generic Envelope dispatch, only 3
// fields are actually used:
//   - outside_access: workflow-owned boundary adapter
//   - partition_key: Envelope routing key
//   - circuit_state: circuit breaker for retry gating
//
// Formula evaluation uses direct formula-core import (pure compute leaf,
// zero I/O — L106 passes). No Envelope dispatch needed for a library call.
//
// Everything else (transport_policy, wasm_module_resolver, reference_resolver,
// local_embodiment_executor, write_batch_sink, envelope_sink, capability_scope)
// was consumed by the deleted typed dispatch functions. Dead weight.

/// Everything the workflow engine needs to execute a definition.
///
/// ONE bag. ONE source of truth. No "injected" vs "registered" distinction.
/// A capability is a capability — the engine receives them all as parameters
/// and threads them through the execution path.
///
/// StepHandler::execute receives `&ExecutorDeps`. Handlers access what they need.
pub struct ExecutorDeps {
    /// Boundary adapter for outside work and direct reads.
    pub outside_access: std::sync::Arc<dyn OutsideAccess>,

    /// Logical workflow partition string carried in workflow-owned context and definitions.
    /// Arc<str> for O(1) clone — ExecutorDeps is threaded through every step dispatch.
    pub partition_key: std::sync::Arc<str>,

    /// Actual Envelope routing partition for cross-slot read/ask dispatch.
    pub dispatch_partition: slot_protocol::PartitionKey,

    /// Circuit breaker state for retry gating.
    pub circuit_state: Option<std::sync::Arc<resilience::StateLock<resilience::CircuitState>>>,

    /// Step handler registry — blind dispatch by step.kind (L090).
    /// Arc-wrapped for O(1) sharing across concurrent step futures and recursive
    /// `execute_dag_concurrent` calls (action steps are sub-DAGs).
    pub step_registry: std::sync::Arc<crate::domain::handlers::StepHandlerRegistry>,

    /// Edge handler registry — blind dispatch by edge.kind (L090).
    /// Arc-wrapped — same reason as step_registry.
    pub edge_registry: std::sync::Arc<crate::domain::handlers::EdgeHandlerRegistry>,

    /// Join handler registry — blind dispatch by step.join (L090).
    /// Arc-wrapped — same reason as step_registry.
    pub join_registry: std::sync::Arc<crate::domain::handlers::JoinHandlerRegistry>,

    /// Definition store for loading sub-definitions (action steps need this).
    ///
    /// L063: the OWNING SLOT pre-hydrates the ENTIRE transitively-referenced
    /// definition closure into this store BEFORE the executor runs (see the
    /// slot's closure-walk over `Definition::referenced_definition_ids`). The
    /// nested action/loop resolver is therefore a pure cache lookup — it NEVER
    /// makes a host call to resolve a sub-definition mid-execution. That is what
    /// structurally eliminates the wasmtime-reentry trap class: the capability to
    /// ask mid-resolution does not exist on this dependency bag.
    pub definition_store: std::sync::Arc<dyn crate::domain::DefinitionStore>,

    /// Compiled definition cache keyed by (definition_id, version).
    ///
    /// Action and loop replay must not rebuild and recompile the same definition
    /// graph for every iteration. The hot path shares compiled DAGs here.
    pub compiled_definition_cache: std::sync::Arc<std::sync::RwLock<DefinitionCache>>,

    /// The host's product word, from which the process wire identities this engine decodes
    /// (`compute.process` and `compute.process_sequence` replies) are derived. The host owns it.
    pub product_word_ids: std::sync::Arc<execution_types::ProductWordIds>,
}

impl Clone for ExecutorDeps {
    /// O(1) clone — all fields are Arc-wrapped. Used by recursive
    /// `execute_dag_concurrent` calls (action sub-DAGs share deps with parent).
    fn clone(&self) -> Self {
        Self {
            outside_access: self.outside_access.clone(),
            partition_key: self.partition_key.clone(),
            dispatch_partition: self.dispatch_partition.clone(),
            circuit_state: self.circuit_state.clone(),
            step_registry: self.step_registry.clone(),
            edge_registry: self.edge_registry.clone(),
            join_registry: self.join_registry.clone(),
            definition_store: self.definition_store.clone(),
            compiled_definition_cache: self.compiled_definition_cache.clone(),
            product_word_ids: self.product_word_ids.clone(),
        }
    }
}

/// The neutral product word every in-crate test runs with.
#[cfg(test)]
pub(crate) fn test_product_word_ids() -> execution_types::ProductWordIds {
    execution_types::ProductWordIds::new("example").expect("valid product word")
}

// ============================================================================
// TEMPLATE RESOLVER
// ============================================================================

/// Stateless binding AST resolution engine.
///
/// Resolves machine-readable binding AST (`$kind: "binding"` nodes) within a
/// `serde_json::Value` tree. Walks the Value recursively:
/// - Objects with `$kind: "binding"` are resolved via resolve_binding_ast()
/// - Objects and arrays are traversed, resolving all nested bindings
/// - Strings with `{{...}}` are NOT resolved — they remain literal (L030)
/// - Non-binding primitives (numbers, booleans, null) pass through unchanged
///
/// # Resolution Strategy
///
/// Binding AST nodes must use the machine-readable `$kind: "binding"` format.
/// For every property that needs dynamic resolution, the data must explicitly
/// state its source via the `select` field: which scope (input, steps, context, start, loop)
/// and which path within that scope.
///
/// # Example
///
/// ```ignore
/// let resolved = BindingResolver::resolve_value(&params, &ctx)?;
/// ```
pub struct BindingResolver;

impl BindingResolver {
    fn op_eval_context() -> &'static ops_core::EvalContext {
        static OP_EVAL_CONTEXT: std::sync::OnceLock<ops_core::EvalContext> =
            std::sync::OnceLock::new();
        OP_EVAL_CONTEXT.get_or_init(ops_core::EvalContext::default)
    }

    fn op_value(value: &Value, ctx: &ExecutionContext) -> Result<ops_core::OpValue, WorkflowError> {
        ops_core::try_from_json_with_budget(value, &ctx.json_conversion_policy.as_ops_budget())
            .map_err(Self::json_conversion_error)
    }

    fn json_conversion_error(error: ops_core::JsonConversionError) -> WorkflowError {
        match error {
            ops_core::JsonConversionError::TooDeep { observed, limit } => {
                WorkflowError::PayloadTooDeep { observed, limit }
            }
            ops_core::JsonConversionError::TooManyNodes { observed, limit } => {
                WorkflowError::PayloadTooLarge {
                    dimension: "nodes".to_string(),
                    observed,
                    limit,
                }
            }
            ops_core::JsonConversionError::TooLarge {
                observed_bytes,
                limit_bytes,
            } => WorkflowError::PayloadTooLarge {
                dimension: "bytes".to_string(),
                observed: observed_bytes,
                limit: limit_bytes,
            },
            ops_core::JsonConversionError::InvalidPolicy { field, reason } => {
                WorkflowError::ResourcePolicyInvalid { field, reason }
            }
        }
    }

    fn budget_json_clone(value: &Value, ctx: &ExecutionContext) -> Result<Value, WorkflowError> {
        Ok(Self::op_value(value, ctx)?.into_inner())
    }

    fn charge_output_units(
        charge: &mut JsonOutputCharge,
        ctx: &ExecutionContext,
        nodes: usize,
        string_bytes: usize,
        total_bytes: usize,
    ) -> Result<(), WorkflowError> {
        let budget = ctx.json_conversion_policy;
        charge.nodes =
            charge
                .nodes
                .checked_add(nodes)
                .ok_or_else(|| WorkflowError::PayloadTooLarge {
                    dimension: "nodes".to_string(),
                    observed: usize::MAX,
                    limit: budget.max_nodes,
                })?;
        if charge.nodes > budget.max_nodes {
            return Err(WorkflowError::PayloadTooLarge {
                dimension: "nodes".to_string(),
                observed: charge.nodes,
                limit: budget.max_nodes,
            });
        }

        charge.string_bytes = charge
            .string_bytes
            .checked_add(string_bytes)
            .ok_or_else(|| WorkflowError::PayloadTooLarge {
                dimension: "bytes".to_string(),
                observed: usize::MAX,
                limit: budget.max_string_bytes,
            })?;
        if charge.string_bytes > budget.max_string_bytes {
            return Err(WorkflowError::PayloadTooLarge {
                dimension: "bytes".to_string(),
                observed: charge.string_bytes,
                limit: budget.max_string_bytes,
            });
        }

        charge.total_bytes = charge.total_bytes.checked_add(total_bytes).ok_or_else(|| {
            WorkflowError::PayloadTooLarge {
                dimension: "bytes".to_string(),
                observed: usize::MAX,
                limit: budget.max_total_bytes,
            }
        })?;
        if charge.total_bytes > budget.max_total_bytes {
            return Err(WorkflowError::PayloadTooLarge {
                dimension: "bytes".to_string(),
                observed: charge.total_bytes,
                limit: budget.max_total_bytes,
            });
        }

        Ok(())
    }

    fn charge_json_value(
        value: &Value,
        ctx: &ExecutionContext,
        charge: &mut JsonOutputCharge,
        root_depth: usize,
    ) -> Result<(), WorkflowError> {
        let budget = ctx.json_conversion_policy;
        let mut validation = vec![(value, root_depth)];
        while let Some((current, depth)) = validation.pop() {
            if depth > budget.max_depth {
                return Err(WorkflowError::PayloadTooDeep {
                    observed: depth,
                    limit: budget.max_depth,
                });
            }
            let (string_bytes, total_bytes) = match current {
                Value::Null | Value::Bool(_) | Value::Number(_) => (0, 16),
                Value::String(value) => (value.len(), 16usize.saturating_add(value.len())),
                Value::Array(values) => {
                    for child in values.iter().rev() {
                        validation.push((child, depth + 1));
                    }
                    (0, 24usize.saturating_add(values.len().saturating_mul(16)))
                }
                Value::Object(values) => {
                    let key_bytes = values.keys().map(|key| key.len()).sum::<usize>();
                    for child in values.values().rev() {
                        validation.push((child, depth + 1));
                    }
                    (
                        key_bytes,
                        48usize
                            .saturating_add(key_bytes)
                            .saturating_add(values.len().saturating_mul(32)),
                    )
                }
            };
            Self::charge_output_units(charge, ctx, 1, string_bytes, total_bytes)?;
        }
        Ok(())
    }

    fn charge_output_array_start(
        charge: &mut JsonOutputCharge,
        ctx: &ExecutionContext,
    ) -> Result<(), WorkflowError> {
        Self::charge_output_units(charge, ctx, 1, 0, 24)
    }

    fn charge_output_array_slot(
        charge: &mut JsonOutputCharge,
        ctx: &ExecutionContext,
    ) -> Result<(), WorkflowError> {
        Self::charge_output_units(charge, ctx, 0, 0, 16)
    }

    fn direct_get_path_ref<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
        const FORBIDDEN: &[&str] = &["__proto__", "prototype", "constructor"];
        let mut current = value;
        for segment in path.split('.').filter(|segment| !segment.is_empty()) {
            if FORBIDDEN.contains(&segment) {
                return None;
            }
            current = match current {
                Value::Object(map) => map.get(segment)?,
                Value::Array(items) => segment.parse::<usize>().ok().and_then(|i| items.get(i))?,
                _ => return None,
            };
        }
        Some(current)
    }

    fn direct_get_path(
        value: &Value,
        path: &str,
        ctx: &ExecutionContext,
    ) -> Result<Value, WorkflowError> {
        match Self::direct_get_path_ref(value, path) {
            Some(selected) => Self::budget_json_clone(selected, ctx),
            None => Ok(Value::Null),
        }
    }

    /// Resolve binding AST nodes (`$kind: "binding"`) in a Value tree against the ExecutionContext.
    ///
    /// Recursively walks the Value:
    /// - `Value::Object` with `$kind: "binding"` → resolve binding AST (calls resolve_binding_ast)
    /// - `Value::Object` without binding AST → recurse into object values
    /// - `Value::Array` → resolve each element
    /// - `Value::String` → pass through unchanged (strings with {{...}} are NOT resolved — L030)
    /// - Other primitives → pass through unchanged
    ///
    /// # Errors
    ///
    /// Returns `WorkflowError::TemplateResolutionFailed` if any binding
    /// cannot be resolved (unknown scope, missing key, etc.).
    ///
    /// # Note: Mustache {{...}} Strings
    ///
    /// Strings containing `{{...}}` mustache syntax are NOT resolved by this engine.
    /// They remain as literal string values. All dynamic resolution must use binding AST format.
    /// This is a breaking change from the deprecated BindingResolver (L030).
    /// Maximum recursion depth for binding resolution.
    /// Guards against circular references where a binding resolves to another binding
    /// that resolves back to the first, creating an infinite loop.
    /// Value of 32 is generous for any real workflow; production graphs rarely exceed 5.
    const MAX_BINDING_DEPTH: u32 = 32;

    pub fn resolve_value(value: &Value, ctx: &ExecutionContext) -> Result<Value, WorkflowError> {
        Self::resolve_value_recursive(value, ctx, 0, false)
    }

    /// Resolve a write-step item template.
    ///
    /// Declared byte writers own their `rows` input. When `rows` selects a
    /// prior step's JSON output and the original response bytes are retained,
    /// the resolver returns a byte-backed row source so the writer can stream
    /// rows without cloning the decoded JSON tree.
    pub fn resolve_write_items_value(
        value: &Value,
        ctx: &ExecutionContext,
    ) -> Result<Value, WorkflowError> {
        Self::resolve_value_recursive(value, ctx, 0, false)
    }

    /// Internal recursive resolver with depth tracking.
    ///
    /// After each binding is resolved, the result is passed back through this function
    /// so that bindings that resolve to other bindings are fully flattened.
    /// The depth limit (MAX_BINDING_DEPTH) prevents infinite loops on circular references.
    fn resolve_value_recursive(
        value: &Value,
        ctx: &ExecutionContext,
        depth: u32,
        target_owned_binding_result: bool,
    ) -> Result<Value, WorkflowError> {
        if depth > Self::MAX_BINDING_DEPTH {
            return Err(WorkflowError::TemplateResolutionFailed {
                reason: format!(
                    "Maximum binding resolution depth ({}) exceeded — possible circular reference",
                    Self::MAX_BINDING_DEPTH
                ),
                hint: "Check for bindings that resolve to other bindings in a cycle".to_string(),
            });
        }

        match value {
            Value::Object(map) => {
                // Target-owned JSON subtrees are intentionally opaque to
                // workflow template resolution. This lets an ask step pass a
                // downstream slot's own request AST without workflow opening
                // and interpreting that target's `$kind` fields as workflow
                // bindings.
                if map.get("$kind").and_then(|v| v.as_str()) == Some("opaque-json") {
                    return map.get("value").cloned().ok_or_else(|| {
                        WorkflowError::TemplateResolutionFailed {
                            reason: "opaque-json node is missing required value field".to_string(),
                            hint: "Use {\"$kind\":\"opaque-json\",\"value\": <target-owned JSON>}"
                                .to_string(),
                        }
                    });
                }

                // Check for binding AST node after opaque literals.
                if map.get("$kind").and_then(|v| v.as_str()) == Some("binding") {
                    if target_owned_binding_result {
                        if let Some(source) = Self::target_owned_step_json_source(map, ctx) {
                            return Ok(source);
                        }
                    }
                    let resolved = Self::resolve_binding_ast(map, ctx)?;
                    if target_owned_binding_result && !map.contains_key("resolve_nested_bindings") {
                        return Ok(resolved);
                    }
                    if !Self::binding_resolves_nested_result(map)? {
                        return Ok(resolved);
                    }
                    // Re-resolve the result — it may itself contain binding AST nodes
                    return Self::resolve_value_recursive(&resolved, ctx, depth + 1, false);
                }

                // Not a binding AST — recurse into object values
                let declared_byte_writer =
                    map.get("value_to_bytes").and_then(Value::as_str).is_some();
                let mut resolved = serde_json::Map::with_capacity(map.len());
                for (key, val) in map {
                    if Self::omit_missing_object_member(val, ctx)? {
                        continue;
                    }
                    let child_target_owned_binding = declared_byte_writer && key == "rows";
                    resolved.insert(
                        key.clone(),
                        Self::resolve_value_recursive(val, ctx, depth, child_target_owned_binding)?,
                    );
                }
                Ok(Value::Object(resolved))
            }
            Value::Array(arr) => {
                let resolved: Result<Vec<Value>, WorkflowError> = arr
                    .iter()
                    .map(|v| Self::resolve_value_recursive(v, ctx, depth, false))
                    .collect();
                Ok(Value::Array(resolved?))
            }
            // Strings are NOT resolved as mustache templates (L030 — deleted)
            // If a string contains {{...}}, it stays as a literal string.
            // All dynamic values must use binding AST.
            _ => Ok(value.clone()),
        }
    }

    fn binding_resolves_nested_result(
        map: &serde_json::Map<String, Value>,
    ) -> Result<bool, WorkflowError> {
        match map.get("resolve_nested_bindings") {
            None => Ok(true),
            Some(Value::Bool(value)) => Ok(*value),
            Some(_) => Err(WorkflowError::TemplateResolutionFailed {
                reason: "binding field resolve_nested_bindings must be a boolean".to_string(),
                hint: "Use true to flatten bindings in the resolved value, or false to copy target-owned JSON without interpreting nested $kind nodes.".to_string(),
            }),
        }
    }

    // Optional object members can distinguish an absent path from an explicit
    // null. Omission is opt-in and only applies at an object-member boundary;
    // ordinary bindings, array positions and root values keep their semantics.
    fn omit_missing_object_member(
        value: &Value,
        ctx: &ExecutionContext,
    ) -> Result<bool, WorkflowError> {
        let Some(map) = value.as_object() else { return Ok(false); };
        if map.get("$kind").and_then(Value::as_str) != Some("binding") {
            return Ok(false);
        }
        match map.get("omit_if_missing") {
            None | Some(Value::Bool(false)) => Ok(false),
            Some(Value::Bool(true)) => {
                let path = map.get("values").and_then(Value::as_array)
                    .filter(|_| !map.contains_key("expr") && !map.contains_key("select"))
                    .ok_or_else(|| WorkflowError::TemplateResolutionFailed {
                        reason: "omit_if_missing requires a values path binding".to_string(),
                        hint: "Use a binding with values and omit_if_missing: true for an optional object member.".to_string(),
                    })?;
                Ok(super::checks::values_in_run(ctx, None, path).is_empty())
            }
            Some(_) => Err(WorkflowError::TemplateResolutionFailed {
                reason: "binding field omit_if_missing must be a boolean".to_string(),
                hint: "Use true to omit an object member only when its values path is absent.".to_string(),
            }),
        }
    }

    /// Resolve a `$kind: binding` AST node against the ExecutionContext.
    ///
    /// This function is the CSSOT for binding evaluation. Full `expr` bindings
    /// use the formula engine; machine-readable `select` bindings resolve by
    /// direct scope/path traversal.
    ///
    /// Binding AST format (machine-readable alternative to mustache):
    /// ```ignore
    /// {
    ///   "$kind": "binding",
    ///   "select": {
    ///     "from": "steps",    // scope: input, steps, context, start, loop, ambient
    ///     "key": "step_name", // for steps scope: the step's output_name
    ///     "path": "id"        // dot-separated path into the resolved value
    ///   }
    /// }
    /// ```
    ///
    /// Scope mapping to ExecutionContext:
    /// - `"input"` / `"ambient"` → start.input
    /// - `"context"` → contextual params
    /// - `"steps"` → step outputs
    /// - `"start"` → start data
    /// - `"loop"` → loop state
    ///
    /// Note: `"state"` scope is NOT supported here — it requires I/O (JS extern)
    /// and is handled by the host (workflow-wasm) as a pre-resolution step.
    ///
    /// By default, a resolved value is recursively passed back into the binding
    /// resolver. This preserves the long-standing flattening behavior for
    /// bindings-that-return-bindings. Set `resolve_nested_bindings: false` on
    /// the binding when the selected value belongs to a downstream target and
    /// must be copied without workflow interpreting its internal `$kind` nodes.
    fn resolve_binding_ast(
        map: &serde_json::Map<String, Value>,
        ctx: &ExecutionContext,
    ) -> Result<Value, WorkflowError> {
        // --- Full expression path (formula engine parser) ---
        // {"$kind": "binding", "expr": "steps.s1.count * input.price"}
        // This gives full formula engine capability: arithmetic, conditionals, function calls.
        if let Some(expr_str) = map.get("expr").and_then(|v| v.as_str()) {
            let formula_ctx = Self::build_formula_context(ctx)?;
            let mut parser = Parser::new();
            let ast = parser.parse(expr_str).map_err(|e| WorkflowError::TemplateResolutionFailed {
                reason: format!("Failed to parse binding expression '{}': {:?}", expr_str, e),
                hint: "Check that the expression uses valid formula engine syntax (e.g., 'steps.s1.count + 1')".to_string(),
            })?;
            let mut evaluator = Evaluator::new(formula_ctx);
            let result = evaluator.evaluate_ast(&ast).map_err(|e| {
                WorkflowError::TemplateResolutionFailed {
                    reason: format!("Formula engine evaluation failed for expr '{}': {:?}", expr_str, e),
                    hint: "Check that all referenced scopes (input, steps, context, etc.) have the expected fields".to_string(),
                }
            })?;
            return Ok(result.into_inner());
        }

        // --- Every value at a path, "*" stepping into lists (executor/checks.rs) ---
        // {"$kind": "binding", "values": ["steps", "draft", "sources", "*", "url"], "take": "all"}
        // "take": "all" gives the list; anything else the first value (null when the path reaches nothing).
        if let Some(path) = map.get("values").and_then(|v| v.as_array()) {
            let found = super::checks::values_in_run(ctx, None, path);
            return Ok(match map.get("take").and_then(|v| v.as_str()) {
                Some("all") => Value::Array(found),
                _ => found.into_iter().next().unwrap_or(Value::Null),
            });
        }

        // --- Select-based path resolution (existing path) ---
        let select = map.get("select").ok_or_else(|| WorkflowError::TemplateResolutionFailed {
            reason: "Binding AST node has $kind: \"binding\" but no \"select\" or \"expr\" field".to_string(),
            hint: "Binding AST requires either:\n  {\"$kind\": \"binding\", \"select\": {\"from\": \"...\", \"path\": \"...\"}}\n  {\"$kind\": \"binding\", \"expr\": \"steps.s1.count + 1\"}".to_string(),
        })?;

        let from = select.get("from").and_then(|v| v.as_str()).unwrap_or("");
        let key = select.get("key").and_then(|v| v.as_str()).unwrap_or("");
        let path = select.get("path").and_then(|v| v.as_str()).unwrap_or("");

        // Validate the scope before constructing the expression.
        // For "loop" scope, verify a loop is actually active (select-based bindings only —
        // expr-based bindings that access loop.* fields are responsible for their own guards).
        match from {
            "input" | "ambient" | "context" | "steps" | "start" | "change" => {}
            "loop" => {
                if ctx.loop_state.is_none() {
                    return Err(WorkflowError::TemplateResolutionFailed {
                        reason: "Binding uses loop scope but no loop is currently active"
                            .to_string(),
                        hint: "Loop bindings are only valid inside Loop step types".to_string(),
                    });
                }
            }
            "state" => {
                return Err(WorkflowError::TemplateResolutionFailed {
                    reason: "Binding scope 'state' requires I/O and is not supported in BindingResolver. \
                             Pre-resolve state bindings before calling BindingResolver."
                        .to_string(),
                    hint: "The host (workflow-wasm) should pre-resolve 'state' bindings via JS extern \
                           before passing params to BindingResolver."
                        .to_string(),
                });
            }
            _ => {
                return Err(WorkflowError::TemplateResolutionFailed {
                    reason: format!("Unknown binding scope '{}' in $kind: binding AST", from),
                    hint: "Valid binding scopes are: input, steps, context, start, loop, ambient. \
                           'state' requires pre-resolution by the host."
                        .to_string(),
                });
            }
        }

        if let Some(raw_resolved) = Self::resolve_raw_step_binding(ctx, from, key, path) {
            let mut resolved = raw_resolved;
            if let Some(transforms) = map.get("transform").and_then(|v| v.as_array()) {
                resolved = Self::evaluate_transform_chain(resolved, transforms, ctx)?;
            }
            return Ok(resolved);
        }

        let mut resolved = Self::resolve_select_binding(ctx, from, key, path)?;

        // Apply transforms (if any). Transforms post-process the resolved value.
        // Generic dispatch — each transform operates on the current resolved value.
        //
        // ops-core is the CSSOT for ALL operator semantics. This block is the
        // wiring layer: it dispatches op:core.* names to the ops-core functions.
        //
        // Supported transforms (op name → ops-core function):
        //   op:core.map        {path}           — extract field from each array element → array
        //   op:core.get_path   {path}           — navigate a dotted path into an object/array → value
        //   op:core.equals     {value}          — resolved == value → bool
        //   op:core.not_equals {value}          — resolved != value → bool
        //   op:core.not                         — !is_truthy(resolved) → bool
        //   op:core.is_null                     — resolved === null → bool
        //   op:core.is_not_null                 — resolved !== null → bool
        //   op:core.first                       — first element of array
        //   op:core.last                        — last element of array
        //   op:core.append     {value}          — array plus one value → array
        //   op:core.replace    {find, replace}  — string.replace(find, replacement) → string
        //   op:core.upper                       — string.toUpperCase() → string
        //   op:core.lower                       — string.toLowerCase() → string
        //   op:core.trim                        — string.trim() → string
        //   op:core.gt         {value}          — resolved > value → bool
        //   op:core.gte        {value}          — resolved >= value → bool
        //   op:core.lt         {value}          — resolved < value → bool
        //   op:core.lte        {value}          — resolved <= value → bool
        //
        // Adding a new transform requires ONE match arm below — zero other changes.
        if let Some(transforms) = map.get("transform").and_then(|v| v.as_array()) {
            resolved = Self::evaluate_transform_chain(resolved, transforms, ctx)?;
        }

        Ok(resolved)
    }

    fn resolve_select_binding(
        ctx: &ExecutionContext,
        from: &str,
        key: &str,
        path: &str,
    ) -> Result<Value, WorkflowError> {
        let segments: Vec<&str> = if path.is_empty() {
            Vec::new()
        } else {
            path.split('.').collect()
        };

        match from {
            "input" | "ambient" => Ok(Self::select_json_path(ctx, &ctx.start.input, &segments)),
            "change" => Ok(ctx
                .start
                .input
                .get("change")
                .map(|value| Self::select_json_path(ctx, value, &segments))
                .unwrap_or(Value::Null)),
            "context" => Self::select_context_path(ctx, &ctx.context, &segments),
            "start" => Self::select_start_path(ctx, &ctx.start, &segments),
            "loop" => match ctx.loop_state.as_ref() {
                Some(loop_state) => Self::select_loop_path(ctx, loop_state, &segments),
                None => Ok(Value::Null),
            },
            "steps" => {
                let (step_key, step_segments) = if key.is_empty() && !segments.is_empty() {
                    (segments[0], &segments[1..])
                } else {
                    (key, segments.as_slice())
                };
                match ctx.step_output(step_key) {
                    Some(step) => Self::select_step_path(ctx, step, step_segments),
                    // A step that has not produced output yet is a legitimate absence during
                    // execution, unlike a member name that cannot exist, so this stays Null.
                    None => Ok(Value::Null),
                }
            }
            other => Err(WorkflowError::TemplateResolutionFailed {
                reason: format!("Unknown binding scope '{}' in $kind: binding AST", other),
                hint: "Valid binding scopes are: input, steps, context, start, loop, ambient. 'state' requires pre-resolution by the host.".to_string(),
            }),
        }
    }

    /// A binding scope's member set is fixed by the struct behind it, so a name outside that set
    /// is a defect in the binding, never an absent value. This mirrors the unknown-SCOPE error in
    /// `resolve_select_binding` one level up: the same question deserves the same answer at both
    /// levels. Returning `Value::Null` here instead is what let `context.now` resolve to nothing
    /// across five packages without a single error being raised, because `Value::Null` was
    /// carrying "this member does not exist" and "this value is legitimately absent" at once.
    ///
    /// `select_json_path` deliberately does NOT use this. It walks user-authored data, where the
    /// set of paths is open and absence is an ordinary answer.
    fn unknown_scope_member(scope: &str, member: &str, known: &str) -> WorkflowError {
        WorkflowError::TemplateResolutionFailed {
            reason: format!("Unknown member '{}' of binding scope '{}'", member, scope),
            hint: format!("Valid members of '{}' are: {}", scope, known),
        }
    }

    fn select_start_path(
        ctx: &ExecutionContext,
        start: &StartData,
        segments: &[&str],
    ) -> Result<Value, WorkflowError> {
        if segments.is_empty() {
            return Ok(serde_json::to_value(start).unwrap_or(Value::Null));
        }

        match segments[0] {
            "start_type" => Ok(Self::select_json_path(
                ctx,
                &Value::String(start.start_type.clone()),
                &segments[1..],
            )),
            "input" => Ok(Self::select_json_path(ctx, &start.input, &segments[1..])),
            "started_at" => Ok(Self::select_json_path(
                ctx,
                &Value::String(start.started_at.clone()),
                &segments[1..],
            )),
            "start_id" => Ok(Self::select_json_path(
                ctx,
                &start
                    .start_id
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
                &segments[1..],
            )),
            other => Err(Self::unknown_scope_member(
                "start",
                other,
                "start_type, input, started_at, start_id",
            )),
        }
    }

    fn select_context_path(
        ctx: &ExecutionContext,
        context: &crate::domain::types::ContextualParams,
        segments: &[&str],
    ) -> Result<Value, WorkflowError> {
        if segments.is_empty() {
            return Ok(serde_json::json!({
                "actor": {
                    "user_id": context.actor.user_id.clone(),
                    "session_id": context.actor.session_id.clone(),
                    "ip_address": context.actor.ip_address.clone(),
                },
                "partition_key": context.partition_key.clone(),
                "organization_id": context.organization_id.clone(),
                "platform": {
                    "os": context.platform.os.clone(),
                    "arch": context.platform.arch.clone(),
                },
            }));
        }

        match segments[0] {
            "actor" => Self::select_actor_context_path(ctx, &context.actor, &segments[1..]),
            "partition_key" => Ok(Self::select_json_path(
                ctx,
                &Value::String(context.partition_key.clone()),
                &segments[1..],
            )),
            "organization_id" => Ok(Self::select_json_path(
                ctx,
                &Value::String(context.organization_id.clone()),
                &segments[1..],
            )),
            "platform" => Self::select_platform_path(ctx, &context.platform, &segments[1..]),
            other => Err(Self::unknown_scope_member(
                "context",
                other,
                "actor, partition_key, organization_id, platform",
            )),
        }
    }

    fn select_actor_context_path(
        ctx: &ExecutionContext,
        actor: &slot_protocol::ActorContext,
        segments: &[&str],
    ) -> Result<Value, WorkflowError> {
        if segments.is_empty() {
            return Ok(serde_json::json!({
                "user_id": actor.user_id.clone(),
                "session_id": actor.session_id.clone(),
                "ip_address": actor.ip_address.clone(),
            }));
        }

        match segments[0] {
            "user_id" => Ok(Self::select_json_path(
                ctx,
                &Value::String(actor.user_id.clone()),
                &segments[1..],
            )),
            "session_id" => Ok(Self::select_json_path(
                ctx,
                &actor
                    .session_id
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
                &segments[1..],
            )),
            "ip_address" => Ok(Self::select_json_path(
                ctx,
                &actor
                    .ip_address
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
                &segments[1..],
            )),
            other => Err(Self::unknown_scope_member(
                "context.actor",
                other,
                "user_id, session_id, ip_address",
            )),
        }
    }

    fn select_platform_path(
        ctx: &ExecutionContext,
        platform: &crate::domain::types::PlatformInfo,
        segments: &[&str],
    ) -> Result<Value, WorkflowError> {
        if segments.is_empty() {
            return Ok(serde_json::json!({
                "os": platform.os.clone(),
                "arch": platform.arch.clone(),
            }));
        }

        match segments[0] {
            "os" => Ok(Self::select_json_path(
                ctx,
                &Value::String(platform.os.clone()),
                &segments[1..],
            )),
            "arch" => Ok(Self::select_json_path(
                ctx,
                &Value::String(platform.arch.clone()),
                &segments[1..],
            )),
            other => Err(Self::unknown_scope_member(
                "context.platform",
                other,
                "os, arch",
            )),
        }
    }

    fn select_loop_path(
        ctx: &ExecutionContext,
        loop_state: &crate::domain::types::LoopState,
        segments: &[&str],
    ) -> Result<Value, WorkflowError> {
        if segments.is_empty() {
            let mut loop_obj = serde_json::Map::new();
            loop_obj.insert(loop_state.item_var.clone(), loop_state.item.clone());
            loop_obj.insert(
                "index".to_string(),
                serde_json::Value::Number(serde_json::Number::from(loop_state.index)),
            );
            loop_obj.insert(
                "total".to_string(),
                serde_json::Value::Number(serde_json::Number::from(loop_state.total)),
            );
            loop_obj.insert(
                "first".to_string(),
                serde_json::Value::Bool(loop_state.first),
            );
            loop_obj.insert("last".to_string(), serde_json::Value::Bool(loop_state.last));
            return Ok(serde_json::Value::Object(loop_obj));
        }

        match segments[0] {
            "index" => Ok(Self::select_json_path(
                ctx,
                &serde_json::Value::Number(serde_json::Number::from(loop_state.index)),
                &segments[1..],
            )),
            "total" => Ok(Self::select_json_path(
                ctx,
                &serde_json::Value::Number(serde_json::Number::from(loop_state.total)),
                &segments[1..],
            )),
            "first" => Ok(Self::select_json_path(
                ctx,
                &serde_json::Value::Bool(loop_state.first),
                &segments[1..],
            )),
            "last" => Ok(Self::select_json_path(
                ctx,
                &serde_json::Value::Bool(loop_state.last),
                &segments[1..],
            )),
            item_key if item_key == loop_state.item_var => Ok(Self::select_json_path(
                ctx,
                &loop_state.item,
                &segments[1..],
            )),
            // The loop member set is not knowable when the DATA is authored, because `item_var`
            // names the item. It IS fully known here, at resolution, so the same strictness
            // applies: a set that is open at authoring time can still be closed at resolution
            // time, and resolution is where the check belongs.
            other => Err(Self::unknown_scope_member(
                "loop",
                other,
                &format!("index, total, first, last, {}", loop_state.item_var),
            )),
        }
    }

    fn select_step_path(
        ctx: &ExecutionContext,
        step: &StepOutput,
        segments: &[&str],
    ) -> Result<Value, WorkflowError> {
        if segments.is_empty() {
            return Ok(serde_json::to_value(step).unwrap_or(Value::Null));
        }

        match segments[0] {
            "output" => Ok(Self::select_json_path(ctx, &step.output, &segments[1..])),
            "status" => Ok(Self::select_json_path(
                ctx,
                &serde_json::to_value(step.status).unwrap_or(Value::Null),
                &segments[1..],
            )),
            "error" => Ok(Self::select_json_path(
                ctx,
                &step.error.clone().map(Value::String).unwrap_or(Value::Null),
                &segments[1..],
            )),
            "duration_ms" => Ok(Self::select_json_path(
                ctx,
                &Value::from(step.duration_ms),
                &segments[1..],
            )),
            other => Err(Self::unknown_scope_member(
                "steps",
                other,
                "output, status, error, duration_ms",
            )),
        }
    }

    fn select_json_path(ctx: &ExecutionContext, root: &Value, segments: &[&str]) -> Value {
        let mut current = root;
        for (index, segment) in segments.iter().enumerate() {
            match current {
                Value::Object(map) => {
                    if let Some(next) = map.get(*segment) {
                        current = next;
                    } else if let Some(next) = Self::select_bytes_ref_field(ctx, map, segment) {
                        return Self::select_json_path(ctx, &next, &segments[index + 1..]);
                    } else {
                        return Value::Null;
                    }
                }
                Value::Array(items) => {
                    let Ok(index) = segment.parse::<usize>() else {
                        return Value::Null;
                    };
                    if let Some(next) = items.get(index) {
                        current = next;
                    } else {
                        return Value::Null;
                    }
                }
                _ => return Value::Null,
            }
        }
        current.clone()
    }

    fn target_owned_step_json_source(
        map: &serde_json::Map<String, Value>,
        ctx: &ExecutionContext,
    ) -> Option<Value> {
        if map.contains_key("transform") {
            return None;
        }
        let select = map.get("select")?.as_object()?;
        if select.get("from")?.as_str()? != "steps" {
            return None;
        }

        let key = select.get("key").and_then(Value::as_str).unwrap_or("");
        let path = select.get("path").and_then(Value::as_str).unwrap_or("");
        let segments: Vec<&str> = if path.is_empty() {
            Vec::new()
        } else {
            path.split('.').collect()
        };
        let (step_key, step_segments) = if key.is_empty() && !segments.is_empty() {
            (segments[0], &segments[1..])
        } else {
            (key, segments.as_slice())
        };
        if step_key.is_empty() || step_segments.first().copied() != Some("output") {
            return None;
        }
        ctx.raw_step_bytes(step_key)?;
        let path: Vec<Value> = step_segments[1..]
            .iter()
            .map(|segment| Value::String((*segment).to_string()))
            .collect();
        Some(serde_json::json!({
            "format": "json",
            "source": {
                "kind": "bytes",
                "ref": step_key
            },
            "path": path
        }))
    }

    fn select_bytes_ref_field(
        ctx: &ExecutionContext,
        map: &serde_json::Map<String, Value>,
        segment: &str,
    ) -> Option<Value> {
        if map.get("kind")?.as_str()? != "bytes" {
            return None;
        }
        let reference = map.get("ref")?.as_str()?;
        let raw_bytes = ctx.raw_step_bytes(reference)?;
        match segment {
            "bytes" => Some(Value::Array(
                raw_bytes
                    .iter()
                    .map(|byte| Value::from(u64::from(*byte)))
                    .collect(),
            )),
            "base64" => Some(Value::String(STANDARD.encode(raw_bytes.as_ref()))),
            "text" => Some(
                std::str::from_utf8(raw_bytes.as_ref())
                    .map(|text| Value::String(text.to_string()))
                    .unwrap_or(Value::Null),
            ),
            _ => None,
        }
    }

    fn direct_first(value: &Value, ctx: &ExecutionContext) -> Result<Option<Value>, WorkflowError> {
        match value {
            Value::Array(items) => items
                .first()
                .map(|selected| Self::budget_json_clone(selected, ctx))
                .transpose(),
            _ => Ok(None),
        }
    }

    fn direct_last(value: &Value, ctx: &ExecutionContext) -> Result<Option<Value>, WorkflowError> {
        match value {
            Value::Array(items) => items
                .last()
                .map(|selected| Self::budget_json_clone(selected, ctx))
                .transpose(),
            _ => Ok(None),
        }
    }

    fn direct_lookup<'a>(value: &'a Value, key: &Value) -> Option<&'a Value> {
        match (value, key) {
            (Value::Object(map), Value::String(field)) => map.get(field),
            (Value::Array(items), Value::Number(index)) => {
                index.as_u64().and_then(|i| items.get(i as usize))
            }
            (Value::Array(items), Value::String(index)) => {
                index.parse::<usize>().ok().and_then(|i| items.get(i))
            }
            _ => None,
        }
    }

    fn json_parse_bounded(value: &Value, ctx: &ExecutionContext) -> Result<Value, WorkflowError> {
        match value {
            Value::String(text) => match serde_json::from_str::<Value>(text) {
                Ok(parsed) => Self::budget_json_clone(&parsed, ctx),
                Err(_) => Ok(Value::Null),
            },
            Value::Array(items) => {
                let mut charge = JsonOutputCharge::default();
                Self::charge_output_array_start(&mut charge, ctx)?;
                let mut parsed = Vec::new();
                for item in items {
                    let next = match item {
                        Value::String(text) => {
                            serde_json::from_str::<Value>(text).unwrap_or(Value::Null)
                        }
                        other => other.clone(),
                    };
                    Self::charge_output_array_slot(&mut charge, ctx)?;
                    Self::charge_json_value(&next, ctx, &mut charge, 2)?;
                    parsed.push(next);
                }
                Ok(Value::Array(parsed))
            }
            _ => Self::budget_json_clone(value, ctx),
        }
    }

    fn resolve_raw_step_binding(
        ctx: &ExecutionContext,
        from: &str,
        key: &str,
        path: &str,
    ) -> Option<Value> {
        if from != "steps" || key.is_empty() {
            return None;
        }
        // Exact `output` is the decoded step result. Generic JSON replies also
        // retain their original response bytes for diagnostics and explicit
        // `output.bytes|base64|text` side-channel access, but exact `output`
        // must not become the side-channel descriptor. Intercepting it here
        // would replace `{"items":[...]}` with `{"kind":"bytes","ref":...}` and
        // silently empty every downstream JSON projection.
        if path == "output" {
            let intentionally_raw = ctx.step_output(key).is_some_and(|step| {
                step.output.get("kind").and_then(Value::as_str) == Some("bytes")
                    && step.output.get("ref").and_then(Value::as_str) == Some(key)
            });
            if !intentionally_raw {
                return None;
            }
        }
        let raw_bytes = ctx.raw_step_bytes(key)?;
        match path {
            "output" => Some(serde_json::json!({
                "kind": "bytes",
                "ref": key,
                "size": raw_bytes.len(),
            })),
            "output.bytes" => Some(Value::Array(
                raw_bytes
                    .iter()
                    .map(|byte| Value::from(u64::from(*byte)))
                    .collect(),
            )),
            "output.base64" => Some(Value::String(STANDARD.encode(raw_bytes.as_ref()))),
            "output.text" => Some(
                std::str::from_utf8(raw_bytes.as_ref())
                    .map(|text| Value::String(text.to_string()))
                    .unwrap_or(Value::Null),
            ),
            _ => None,
        }
    }

    /// Evaluate a transform chain on a value. Extracted for reuse by higher-order
    /// operators (find_where, filter_where) that evaluate predicate sub-chains
    /// on each array element.
    ///
    /// The predicate has full access to the execution context — bindings like
    /// {"$kind":"binding","select":{"from":"loop","path":"module_name"}} resolve
    /// against the outer scope. This is the closure/capture mechanism: the
    /// predicate pipeline operates on the element value, while binding references
    /// reach into the execution context for external values.
    fn evaluate_transform_chain(
        mut resolved: Value,
        transforms: &[Value],
        ctx: &ExecutionContext,
    ) -> Result<Value, WorkflowError> {
        let op_ctx = Self::op_eval_context();
        let mut transform_index = 0;
        while transform_index < transforms.len() {
            let t = &transforms[transform_index];
            let op = t.get("op").and_then(|v| v.as_str()).unwrap_or("");
            let args = t.get("args");
            if op == "op:core.decode"
                && args.and_then(|a| a.get("encoding")).and_then(Value::as_str) == Some("base64")
                && matches!(
                    transforms.get(transform_index + 1),
                    Some(next)
                        if next.get("op").and_then(Value::as_str) == Some("op:core.json_parse")
                )
            {
                if let Value::String(text) = &resolved {
                    let decoded = STANDARD.decode(text.as_bytes()).map_err(|e| {
                        WorkflowError::TemplateResolutionFailed {
                            reason: format!("op:core.decode failed: {e}"),
                            hint: "Use canonical base64 input for the decode transform.".into(),
                        }
                    })?;
                    let parsed = serde_json::from_slice::<Value>(&decoded).unwrap_or(Value::Null);
                    let mut charge = JsonOutputCharge::default();
                    Self::charge_json_value(&parsed, ctx, &mut charge, 1)?;
                    resolved = parsed;
                    transform_index += 2;
                    continue;
                }
            }
            // JSON-native projection operators do not materialize the untouched
            // tree. Every remaining operator is admitted through the required
            // budget before any legacy, now-provably-bounded infallible helper
            // can observe it. The transform DATA itself is budgeted as well.
            if !matches!(
                op,
                "op:core.map"
                    | "op:core.get_path"
                    | "op:core.first"
                    | "op:core.last"
                    | "op:core.lookup"
            ) {
                drop(Self::op_value(&resolved, ctx)?);
                drop(Self::op_value(t, ctx)?);
            }
            resolved = match op {
                // ── Array operations ──────────────────────────────────────────────
                "op:core.map" => {
                    // Field extraction: iterate array, lookup named field per element
                    if let Some(field) = args.and_then(|a| a.get("path")).and_then(|p| p.as_str()) {
                        if let Value::Array(arr) = &resolved {
                            let mut charge = JsonOutputCharge::default();
                            Self::charge_output_array_start(&mut charge, ctx)?;
                            let mut mapped = Vec::new();
                            for item in arr {
                                let selected =
                                    Self::direct_get_path_ref(item, field).unwrap_or(&Value::Null);
                                Self::charge_output_array_slot(&mut charge, ctx)?;
                                Self::charge_json_value(selected, ctx, &mut charge, 2)?;
                                mapped.push(selected.clone());
                            }
                            Value::Array(mapped)
                        } else {
                            Self::budget_json_clone(&resolved, ctx)?
                        }
                    } else {
                        Self::budget_json_clone(&resolved, ctx)?
                    }
                }
                "op:core.get_path" => {
                    // Navigate a dotted path (e.g. "records", "style.padding",
                    // "items.0") into the resolved object/array. Reuses ops-core's
                    // OpValue::get_path so the navigation logic has ONE home (no
                    // builtinOps↔ops-core duplication). Missing path → the value
                    // unchanged; missing key → Null (ops-core semantics).
                    if let Some(path) = args.and_then(|a| a.get("path")).and_then(|p| p.as_str()) {
                        Self::direct_get_path(&resolved, path, ctx)?
                    } else {
                        Self::budget_json_clone(&resolved, ctx)?
                    }
                }
                "op:core.first" => Self::direct_first(&resolved, ctx)?.unwrap_or(Value::Null),
                "op:core.last" => Self::direct_last(&resolved, ctx)?.unwrap_or(Value::Null),
                // ── Equality / comparison ─────────────────────────────────────────
                "op:core.equals" => {
                    let cmp = args
                        .and_then(|a| a.get("value"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::logical::eq(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&cmp, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Bool(false))
                }
                "op:core.not_equals" => {
                    let cmp = args
                        .and_then(|a| a.get("value"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::logical::ne(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&cmp, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Bool(true))
                }
                "op:core.gt" => {
                    let cmp = args
                        .and_then(|a| a.get("value"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::logical::gt(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&cmp, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Bool(false))
                }
                "op:core.gte" => {
                    let cmp = args
                        .and_then(|a| a.get("value"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::logical::ge(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&cmp, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Bool(false))
                }
                "op:core.lt" => {
                    let cmp = args
                        .and_then(|a| a.get("value"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::logical::lt(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&cmp, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Bool(false))
                }
                "op:core.lte" => {
                    let cmp = args
                        .and_then(|a| a.get("value"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::logical::le(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&cmp, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Bool(false))
                }
                // ── Boolean logic ──────────────────────────────────────────────────
                "op:core.not" => ops_core::logical::not(&Self::op_value(&resolved, ctx)?, op_ctx)
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Bool(false)),
                "op:core.is_null" => {
                    ops_core::logical::is_null(&Self::op_value(&resolved, ctx)?, op_ctx)
                        .map(|v| v.into_inner())
                        .unwrap_or(Value::Bool(false))
                }
                "op:core.is_not_null" => {
                    ops_core::logical::is_not_null(&Self::op_value(&resolved, ctx)?, op_ctx)
                        .map(|v| v.into_inner())
                        .unwrap_or(Value::Bool(true))
                }
                // ── String operations ──────────────────────────────────────────────
                "op:core.replace" => {
                    let find = args
                        .and_then(|a| a.get("find"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    let replacement = args
                        .and_then(|a| a.get("replace"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::text::replace(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&find, ctx)?,
                        &Self::op_value(&replacement, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Null)
                }
                "op:core.upper" => ops_core::text::upper(&Self::op_value(&resolved, ctx)?, op_ctx)
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Null),
                "op:core.lower" => ops_core::text::lower(&Self::op_value(&resolved, ctx)?, op_ctx)
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Null),
                "op:core.trim" => ops_core::text::trim(&Self::op_value(&resolved, ctx)?, op_ctx)
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Null),
                "op:core.left" => {
                    let count = args
                        .and_then(|a| a.get("count"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::text::left(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&count, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Null)
                }
                "op:core.concat" => {
                    if let Some(values) = args
                        .and_then(|a| a.get("values"))
                        .and_then(|v| v.as_array())
                    {
                        let mut parts = Vec::with_capacity(values.len());
                        for value in values {
                            let resolved_value = Self::resolve_value(value, ctx)?;
                            parts.push(Self::op_value(&resolved_value, ctx)?);
                        }
                        ops_core::text::concat_many(&parts, op_ctx)
                            .map(|v| v.into_inner())
                            .unwrap_or(Value::Null)
                    } else {
                        let prefix = args
                            .and_then(|a| a.get("prefix"))
                            .map(|v| Self::resolve_value(v, ctx))
                            .transpose()?
                            .unwrap_or(Value::String(String::new()));
                        let suffix = args
                            .and_then(|a| a.get("suffix"))
                            .map(|v| Self::resolve_value(v, ctx))
                            .transpose()?
                            .unwrap_or(Value::String(String::new()));
                        // concat(a, b) concatenates two strings. Chain: prefix + input + suffix.
                        let with_prefix = ops_core::text::concat(
                            &Self::op_value(&prefix, ctx)?,
                            &Self::op_value(&resolved, ctx)?,
                            op_ctx,
                        )
                        .map(|v| v.into_inner())
                        .unwrap_or(Value::Null);
                        ops_core::text::concat(
                            &Self::op_value(&with_prefix, ctx)?,
                            &Self::op_value(&suffix, ctx)?,
                            op_ctx,
                        )
                        .map(|v| v.into_inner())
                        .unwrap_or(Value::Null)
                    }
                }
                "op:core.format" => {
                    let prefix = args
                        .and_then(|a| a.get("prefix"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?;
                    let suffix = args
                        .and_then(|a| a.get("suffix"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?;

                    if prefix.is_some() || suffix.is_some() {
                        match resolved.as_str() {
                            Some(input) => {
                                let formatted = format!(
                                    "{}{}{}",
                                    prefix.as_ref().and_then(Value::as_str).unwrap_or(""),
                                    input,
                                    suffix.as_ref().and_then(Value::as_str).unwrap_or(""),
                                );
                                Value::String(formatted)
                            }
                            None => Value::Null,
                        }
                    } else {
                        let mut values = Vec::new();
                        if let Some(args_values) = args
                            .and_then(|a| a.get("values"))
                            .and_then(|v| v.as_array())
                        {
                            values.reserve(args_values.len());
                            for value in args_values {
                                let resolved_value = Self::resolve_value(value, ctx)?;
                                values.push(Self::op_value(&resolved_value, ctx)?);
                            }
                        }
                        ops_core::text::format(&Self::op_value(&resolved, ctx)?, &values, op_ctx)
                            .map(|v| v.into_inner())
                            .unwrap_or(Value::Null)
                    }
                }
                "op:core.starts_with" => {
                    let prefix = args
                        .and_then(|a| a.get("prefix"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::text::starts_with(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&prefix, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Bool(false))
                }
                "op:core.contains" => {
                    let needle = args
                        .and_then(|a| a.get("value"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::text::contains(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&needle, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Bool(false))
                }
                "op:core.includes" => {
                    let cmp = args
                        .and_then(|a| a.get("value"))
                        .map(|value| Self::resolve_value(value, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::array::includes(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&cmp, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Bool(false))
                }
                "op:core.append" => {
                    let value = args
                        .and_then(|a| a.get("value"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::array::append(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&value, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .map_err(|e| WorkflowError::TemplateResolutionFailed {
                        reason: format!("op:core.append failed: {e}"),
                        hint: "Append requires the current value to be an array or null."
                            .to_string(),
                    })?
                }
                "op:core.set" => {
                    let key = args
                        .and_then(|a| a.get("key"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    let value = args
                        .and_then(|a| a.get("value"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    let result = ops_core::structure::set(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&key, ctx)?,
                        &Self::op_value(&value, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .map_err(|e| WorkflowError::TemplateResolutionFailed {
                        reason: format!("op:core.set failed: {e}"),
                        hint: "Set requires the current value to be an object, array, or null and a key valid for that value.".to_string(),
                    })?;
                    Self::budget_json_clone(&result, ctx)?
                }
                "op:core.merge" => {
                    let source = args
                        .and_then(|a| a.get("value"))
                        .or_else(|| args.and_then(|a| a.get("source")))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    let result = ops_core::structure::merge(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&source, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .map_err(|e| WorkflowError::TemplateResolutionFailed {
                        reason: format!("op:core.merge failed: {e}"),
                        hint: "Merge requires the current value and source to be objects or null.".to_string(),
                    })?;
                    Self::budget_json_clone(&result, ctx)?
                }
                "op:core.in_list" => {
                    let values = args
                        .and_then(|a| a.get("values"))
                        .map(|value| Self::resolve_value(value, ctx))
                        .transpose()?
                        .unwrap_or_else(|| Value::Array(Vec::new()));
                    ops_core::array::includes(
                        &Self::op_value(&values, ctx)?,
                        &Self::op_value(&resolved, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Bool(false))
                }
                "op:core.if_null" => {
                    let fallback = args
                        .and_then(|a| a.get("fallback"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::logical::if_null(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&fallback, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Null)
                }
                // ── Object/Array lookup ──────────────────────────────────────────
                "op:core.lookup" => {
                    let key = args
                        .and_then(|a| a.get("key"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    let key = Self::budget_json_clone(&key, ctx)?;
                    match &resolved {
                        Value::Object(_) | Value::Array(_) => Self::direct_lookup(&resolved, &key)
                            .map(|selected| Self::budget_json_clone(selected, ctx))
                            .transpose()?
                            .unwrap_or(Value::Null),
                        _ => Value::Null,
                    }
                }
                // ── Array find_by ────────────────────────────────────────────────
                "op:core.find_by" => {
                    let field = args
                        .and_then(|a| a.get("field"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    let value = args
                        .and_then(|a| a.get("value"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::array::find_by(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&field, ctx)?,
                        &Self::op_value(&value, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Null)
                }
                // ── Join/Split/Concat ────────────────────────────────────────
                "op:core.join" => {
                    let delimiter = args
                        .and_then(|a| a.get("delimiter"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::String("".to_string()));
                    ops_core::text::join(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&delimiter, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Null)
                }
                "op:core.split" => {
                    let delimiter = args
                        .and_then(|a| a.get("delimiter"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::String("".to_string()));
                    ops_core::text::split(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&delimiter, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Null)
                }
                // ── Serialization transforms ────────────────────────────────
                "op:core.json_parse" => Self::json_parse_bounded(&resolved, ctx)?,
                "op:core.stringify" => {
                    let format = args
                        .and_then(|a| a.get("format"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .ok_or_else(|| WorkflowError::TemplateResolutionFailed {
                            reason: "op:core.stringify requires a format".to_string(),
                            hint:
                                "Provide args.format explicitly, for example {\"format\":\"json\"}."
                                    .to_string(),
                        })?;
                    ops_core::serialization::stringify(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&format, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .map_err(|e| WorkflowError::TemplateResolutionFailed {
                        reason: format!("op:core.stringify failed: {e}"),
                        hint: "Use a registered format such as json, yaml, toml, or cbor."
                            .to_string(),
                    })?
                }
                "op:core.encode" => {
                    let encoding = args
                        .and_then(|a| a.get("encoding"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .ok_or_else(|| WorkflowError::TemplateResolutionFailed {
                            reason: "op:core.encode requires an encoding".to_string(),
                            hint: "Provide args.encoding explicitly, for example {\"encoding\":\"base64\"}."
                                .to_string(),
                        })?;
                    ops_core::crypto::encode(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&encoding, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .map_err(|e| WorkflowError::TemplateResolutionFailed {
                        reason: format!("op:core.encode failed: {e}"),
                        hint: "Use a registered encoding such as base64, base64url, or hex."
                            .to_string(),
                    })?
                }
                "op:core.decode" => {
                    let encoding = args
                        .and_then(|a| a.get("encoding"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .ok_or_else(|| WorkflowError::TemplateResolutionFailed {
                            reason: "op:core.decode requires an encoding".to_string(),
                            hint: "Provide args.encoding explicitly, for example {\"encoding\":\"base64\"}."
                                .to_string(),
                        })?;
                    ops_core::crypto::decode(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&encoding, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .map_err(|e| WorkflowError::TemplateResolutionFailed {
                        reason: format!("op:core.decode failed: {e}"),
                        hint: "Use a registered encoding such as base64, base64url, or hex."
                            .to_string(),
                    })?
                }
                // ── Regex extraction ──────────────────────────────────────────
                "op:core.regex_extract" => {
                    let pattern = args
                        .and_then(|a| a.get("pattern"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::text::regex_extract(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&pattern, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Null)
                }
                // ── Higher-order array search (predicate sub-chain) ────────
                "op:core.find_where" => {
                    let predicate = args
                        .and_then(|a| a.get("predicate"))
                        .and_then(|v| v.as_array());
                    if let (Value::Array(arr), Some(pred_transforms)) = (&resolved, predicate) {
                        let pred_vec: Vec<Value> = pred_transforms.clone();
                        let mut found = Value::Null;
                        for element in arr {
                            let pred_result =
                                Self::evaluate_transform_chain(element.clone(), &pred_vec, ctx)?;
                            if Self::op_value(&pred_result, ctx)?.is_truthy() {
                                found = element.clone();
                                break;
                            }
                        }
                        found
                    } else {
                        Value::Null
                    }
                }
                "op:core.filter_where" => {
                    let predicate = args
                        .and_then(|a| a.get("predicate"))
                        .and_then(|v| v.as_array());
                    if let (Value::Array(arr), Some(pred_transforms)) = (&resolved, predicate) {
                        let pred_vec: Vec<Value> = pred_transforms.clone();
                        let mut results = Vec::new();
                        for element in arr {
                            let pred_result =
                                Self::evaluate_transform_chain(element.clone(), &pred_vec, ctx)?;
                            if Self::op_value(&pred_result, ctx)?.is_truthy() {
                                results.push(element.clone());
                            }
                        }
                        Value::Array(results)
                    } else {
                        Value::Null
                    }
                }
                // ── Map each element through a subchain, then concatenate ──────
                // Completes the higher-order op family (map / filter_where /
                // flat_map). For each element the `transform` subchain runs; an
                // Array result is spliced (flattened one level), a Null result is
                // dropped, and any other value is pushed as-is. Generic and blind:
                // callers supply the per-element subchain as DATA, this op names
                // nothing about the elements (L069/L090).
                "op:core.flat_map" => {
                    let mapper = args
                        .and_then(|a| a.get("transform"))
                        .and_then(|v| v.as_array());
                    if let (Value::Array(arr), Some(map_transforms)) = (&resolved, mapper) {
                        let map_vec: Vec<Value> = map_transforms.clone();
                        let mut results = Vec::new();
                        for element in arr {
                            let mapped =
                                Self::evaluate_transform_chain(element.clone(), &map_vec, ctx)?;
                            match mapped {
                                Value::Array(inner) => results.extend(inner),
                                Value::Null => {}
                                other => results.push(other),
                            }
                        }
                        Value::Array(results)
                    } else {
                        Value::Null
                    }
                }
                // ── Sort objects by field ──────────────────────────────────────
                "op:core.sort_by" => {
                    let field = args
                        .and_then(|a| a.get("field"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    let direction = args
                        .and_then(|a| a.get("direction"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::String("asc".to_string()));
                    ops_core::array::sort_by(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&field, ctx)?,
                        &Self::op_value(&direction, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Null)
                }
                "op:core.take" => {
                    let count = args
                        .and_then(|a| a.get("count"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::array::take(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&count, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Null)
                }
                // ── Is prefix of (inverse starts_with) ────────────────────────
                "op:core.is_prefix_of" => {
                    let target = args
                        .and_then(|a| a.get("value"))
                        .map(|v| Self::resolve_value(v, ctx))
                        .transpose()?
                        .unwrap_or(Value::Null);
                    ops_core::text::is_prefix_of(
                        &Self::op_value(&resolved, ctx)?,
                        &Self::op_value(&target, ctx)?,
                        op_ctx,
                    )
                    .map(|v| v.into_inner())
                    .unwrap_or(Value::Bool(false))
                }
                _ => {
                    return Err(WorkflowError::UnknownTransform {
                        op: op.to_string(),
                        hint: format!(
                            "Transform '{}' is not a wired ops-core operation. \
                             Supported: op:core.{{map,equals,not_equals,not,is_null,\
                             is_not_null,first,last,replace,upper,lower,trim,left,\
                             gt,gte,lt,lte,contains,includes,in_list,if_null,lookup,find_by,\
                             regex_extract,json_parse,stringify,encode,join,split,concat,starts_with,\
                             find_where,filter_where,sort_by,take,is_prefix_of,set,merge}}. \
                             To add a new op: add a match arm in context.rs dispatch \
                             and call the corresponding ops_core::module::function.",
                            op
                        ),
                    });
                }
            };
            transform_index += 1;
        }

        Ok(resolved)
    }

    /// Build a formula engine context from workflow ExecutionContext.
    ///
    /// Registers ALL known scopes unconditionally so that any binding expression
    /// can reference any combination of scopes without restriction. A binding like
    /// `{"expr": "steps.s1.price * input.quantity"}` requires both "steps" and "input"
    /// to be registered — registering only the "primary" scope would break cross-scope
    /// expressions.
    ///
    /// Scope mapping:
    /// - "input" + "ambient" → ctx.start.input (same data, two names for compatibility)
    /// - "context"           → serialized ctx.context params
    /// - "steps"             → all step outputs as a JSON object keyed by step ID
    /// - "start"             → full serialized ctx.start
    /// - "loop"              → loop state object (item/index/total/first/last), or empty object if no active loop
    fn build_formula_context(ctx: &ExecutionContext) -> Result<FormulaContext, WorkflowError> {
        let mut formula_ctx = FormulaContext::new();

        // input / ambient → start.input
        formula_ctx.set_variable("input", FormulaValue::from(ctx.start.input.clone()));
        formula_ctx.set_variable("ambient", FormulaValue::from(ctx.start.input.clone()));

        // context → serialized context params
        let ctx_value = serde_json::to_value(&ctx.context).map_err(|e| {
            WorkflowError::TemplateResolutionFailed {
                reason: format!("Failed to serialize context: {}", e),
                hint: "Check that context params are valid JSON-serializable values".to_string(),
            }
        })?;
        formula_ctx.set_variable("context", FormulaValue::from(ctx_value));

        // steps → all step outputs as a JSON object keyed by step ID.
        // Lexical scoping: global steps first, then scope stack entries overlay.
        // Innermost scope wins — local keys (action_0) shadow global keys.
        let mut steps_obj = serde_json::Map::new();
        for (id, output) in ctx.steps.iter() {
            if let Ok(output_val) = serde_json::to_value(output) {
                steps_obj.insert(id.clone(), output_val);
            }
        }
        // Overlay scope stack entries (innermost = last in Vec = highest priority)
        for scope in ctx.scope_stack.iter() {
            for (id, output) in scope.iter() {
                if let Ok(output_val) = serde_json::to_value(output) {
                    steps_obj.insert(id.clone(), output_val);
                }
            }
        }
        formula_ctx.set_variable(
            "steps",
            FormulaValue::from(serde_json::Value::Object(steps_obj)),
        );

        // start → full start data
        let start_value = serde_json::to_value(&ctx.start).map_err(|e| {
            WorkflowError::TemplateResolutionFailed {
                reason: format!("Failed to serialize start data: {}", e),
                hint: "Check that the start data is valid JSON-serializable".to_string(),
            }
        })?;
        formula_ctx.set_variable("start", FormulaValue::from(start_value));

        // loop → loop state if active, empty object otherwise
        // An empty object (not an error) lets expressions like `loop.index` resolve
        // to null rather than hard-failing when there is no active loop. The scope
        // validation in resolve_binding_ast handles the "loop binding outside a loop"
        // error for select-based bindings; expr-based bindings can decide themselves.
        let loop_value = if let Some(loop_state) = ctx.loop_state.as_ref() {
            let mut loop_obj = serde_json::Map::new();
            // Use item_var as the key — e.g. item_var="component" → loop.component
            loop_obj.insert(loop_state.item_var.clone(), loop_state.item.clone());
            loop_obj.insert(
                "index".to_string(),
                serde_json::Value::Number(serde_json::Number::from(loop_state.index)),
            );
            loop_obj.insert(
                "total".to_string(),
                serde_json::Value::Number(serde_json::Number::from(loop_state.total)),
            );
            loop_obj.insert(
                "first".to_string(),
                serde_json::Value::Bool(loop_state.first),
            );
            loop_obj.insert("last".to_string(), serde_json::Value::Bool(loop_state.last));
            serde_json::Value::Object(loop_obj)
        } else {
            serde_json::Value::Object(serde_json::Map::new())
        };
        formula_ctx.set_variable("loop", FormulaValue::from(loop_value));

        Ok(formula_ctx)
    }
}

/// Metadata for a single binding — transform chains applied after resolution.
#[derive(Debug, Clone)]
pub struct BindingMeta {
    /// Transform chain to apply after formula evaluation.
    /// Empty if no transforms on this binding.
    pub transforms: Vec<Value>,
}

// Two-phase Envelope batch path DELETED (L030). formula-core is a genuine
// leaf crate (zero I/O after CI-02 sandbox extraction). Direct sync evaluation
// via resolve_value → resolve_binding_ast → Parser + Evaluator is the ONE path.
// No async Envelope dispatch needed for a pure compute library call.

// ============================================================================
// ============================================================================
// CONTEXT EXTENSION HELPERS
// ============================================================================

/// Record a step's output into the ExecutionContext.
///
/// After a step completes, call this to make its output available
/// to subsequent steps via `{{steps.step_id.output}}`.
pub fn record_step_output(
    ctx: &mut ExecutionContext,
    step_id: &str,
    output: crate::domain::types::StepOutput,
) {
    if !ctx.runtime_path.is_empty() {
        let mut identity = ctx.runtime_path.clone();
        identity.push(step_id.to_string());
        let runtime_id = serde_json::to_string(&identity).unwrap_or_default();
        ctx.runtime_outputs.insert(runtime_id.clone(), output.clone());
        ctx.dirty_runtime_outputs.insert(runtime_id);
    }
    if let Some(scope) = ctx.scope_stack.last_mut() {
        scope.insert(step_id.to_string(), output);
    } else {
        ctx.steps.insert(step_id.to_string(), output);
    }
    ctx.dirty_steps.insert(step_id.to_string());
}

/// Canonical step ID used by the compiled DAG and execution context.
///
/// Legacy `workflow_steps` arrays often omit `step.id`. Those definitions still
/// need a stable execution identity, so empty IDs normalize to `step_{index}`.
/// Explicit IDs remain authoritative.
pub fn canonical_step_id(step: &crate::domain::types::Step, index: usize) -> String {
    if step.id.is_empty() {
        format!("step_{}", index)
    } else {
        step.id.clone()
    }
}

// compute_dag_step_order — DELETED (L030).
//
// The sequential bridge function that computed topological order for sequential
// execution has been replaced by execute_dag_concurrent — the concurrent graph
// walker that IS the execution engine. There is no "compute order then loop"
// phase. Topology is consumed by the walker as nodes complete.

// ============================================================================
// DEFINITION COMPILATION — Authored Model → Runtime Model (§4 DAG proposal)
//
// The authored Definition (JSON/Value) is compiled ONCE per definition version
// into a typed, cached runtime model. The hot execution path NEVER touches
// the authored model or raw JSON.
// ============================================================================

/// Compile an authored Definition into a CompiledDefinition.
///
/// Builds the DirectedGraph from steps (nodes) and edges (topology).
/// Edge conditions are stored as raw Value for now — BindingAst parsing
/// happens at edge evaluation time via the EdgeHandler. Cycle detection
/// is structural via the graph crate's add_edge_with().
pub fn compile_steps_and_edges(
    steps: &[crate::domain::types::Step],
    edges: &[crate::domain::types::StepEdge],
) -> Result<crate::domain::types::CompiledDefinition, WorkflowError> {
    use crate::domain::types::{CompiledDefinition, CompiledEdge};
    use std::collections::HashMap;

    let mut dag = graph::DirectedGraph::new();
    let mut step_map = HashMap::with_capacity(steps.len());
    let use_implicit_sequence = edges.is_empty();
    let mut step_ids = Vec::with_capacity(steps.len());

    // Add all steps as nodes + build O(1) lookup. Legacy step arrays that omit
    // IDs normalize to `step_{index}` so the full DAG executor can own the
    // public execute_definition path without depending on the old flat runner.
    for (index, step) in steps.iter().enumerate() {
        let canonical_id = canonical_step_id(step, index);
        if step_map.contains_key(&canonical_id) {
            return Err(WorkflowError::InvalidWorkflow {
                reason: format!("Duplicate step ID: {}", canonical_id),
                hint: "Each step in a definition must have a unique ID, including generated IDs."
                    .to_string(),
            });
        }
        let mut normalized_step = step.clone();
        normalized_step.id = canonical_id.clone();
        dag.add_node(canonical_id.clone());
        step_map.insert(canonical_id.clone(), Arc::new(normalized_step));
        step_ids.push(canonical_id);
    }

    if use_implicit_sequence {
        for pair in step_ids.windows(2) {
            let from = &pair[0];
            let to = &pair[1];
            dag.add_edge_with(
                from,
                to,
                CompiledEdge {
                    kind: "always".to_string(),
                    condition: None,
                },
            )
            .map_err(|_| WorkflowError::InvalidWorkflow {
                reason: format!(
                    "Cycle detected: implicit edge {} -> {} creates a cycle",
                    from, to
                ),
                hint:
                    "Definitions must be acyclic (DAG). Loops are step behavior, not graph cycles."
                        .to_string(),
            })?;
        }
    } else {
        // Add all explicit edges — store condition as raw Value (EdgeHandler parses at eval time)
        for edge in edges {
            let condition = if edge.config.is_null() || edge.config == serde_json::json!({}) {
                None
            } else {
                Some(edge.config.clone())
            };

            dag.add_edge_with(
                &edge.from,
                &edge.to,
                CompiledEdge {
                    kind: edge.kind.clone(),
                    condition,
                },
            )
            .map_err(|_| WorkflowError::InvalidWorkflow {
                reason: format!(
                    "Cycle detected: edge {} -> {} creates a cycle",
                    edge.from, edge.to
                ),
                hint:
                    "Definitions must be acyclic (DAG). Loops are step behavior, not graph cycles."
                        .to_string(),
            })?;
        }
    }

    Ok(CompiledDefinition { step_map, dag })
}

pub fn compile_definition(
    def: &crate::domain::types::Definition,
) -> Result<crate::domain::types::CompiledDefinition, WorkflowError> {
    compile_steps_and_edges(&def.steps, &def.edges)
}

/// Definition compilation cache — keyed by (definition_id, version).
/// Recompilation happens ONLY when the authored definition changes.
/// The execution hot-path receives Arc<CompiledDefinition> — zero compilation cost.
pub type DefinitionCache = std::collections::HashMap<
    (String, i32),
    std::sync::Arc<crate::domain::types::CompiledDefinition>,
>;

// ============================================================================
// NODE READINESS — Fan-In / Merge Correctness (§5c DAG proposal)
// ============================================================================

/// Evaluate whether a node is ready to execute based on inbound edge satisfaction
/// and its registered JoinHandler.
///
/// A node is Ready when all predecessors are done AND the JoinHandler says so.
/// A node is Skipped when all predecessors are done but JoinHandler says Skipped.
/// A node is Waiting when predecessors are still running.
pub fn is_node_ready(
    node_id: &str,
    step: &crate::domain::types::Step,
    dag: &graph::DirectedGraph<String, crate::domain::types::CompiledEdge>,
    outcomes: &std::collections::HashMap<String, crate::domain::types::StepOutput>,
    edge_registry: &crate::domain::handlers::EdgeHandlerRegistry,
    join_registry: &crate::domain::handlers::JoinHandlerRegistry,
) -> Result<crate::domain::types::NodeReadiness, WorkflowError> {
    use crate::domain::handlers::JoinContext;
    use crate::domain::types::{NodeReadiness, StepOutput};

    let node_key = node_id.to_string();
    let inbound = dag.inbound_edges(&node_key);
    if inbound.is_empty() {
        return Ok(NodeReadiness::Ready); // Root node — always ready
    }

    let mut all_predecessors_done = true;
    let mut satisfied_count = 0usize;
    let mut total_count = 0usize;
    let mut inbound_detail: Vec<(&str, &StepOutput, bool)> = Vec::new();

    for (source_id, edge_meta) in &inbound {
        total_count += 1;
        match outcomes.get(source_id) {
            None => {
                all_predecessors_done = false;
            }
            Some(outcome) => {
                // Evaluate edge satisfaction via the registered EdgeHandler
                let edge_handler = edge_registry
                    .get(edge_meta.kind.as_str())
                    .ok_or_else(|| WorkflowError::InvalidWorkflow {
                        reason: format!(
                            "Unknown edge kind '{}' on edge {} -> {}",
                            edge_meta.kind, source_id, node_id
                        ),
                        hint: "Register an EdgeHandler for this edge kind before executing the definition.".to_string(),
                    })?;
                let satisfied = edge_handler.evaluate(source_id, outcome, &edge_meta.condition)?;
                if satisfied {
                    satisfied_count += 1;
                }
                inbound_detail.push((source_id.as_str(), outcome, satisfied));
            }
        }
    }

    // Dispatch to registered JoinHandler — the handler decides readiness,
    // including whether partial predecessor completion is sufficient.
    // "any" join: ready if at least one edge is satisfied (even if others pending).
    // "all" join: ready only if ALL edges satisfied (needs all predecessors done).
    let handler = join_registry
        .get(step.join.as_str())
        .or_else(|| join_registry.get("any"))
        .ok_or_else(|| WorkflowError::InvalidWorkflow {
            reason: format!(
                "Unknown join kind '{}' for node '{}' and no default 'any' handler is registered",
                step.join, node_id
            ),
            hint: "Register the requested JoinHandler or the default 'any' JoinHandler before executing the definition.".to_string(),
        })?;

    // If some predecessors aren't done, let the handler decide.
    // If the handler says Ready with partial data, that's the "any" semantics.
    // If the handler needs all predecessors (all-join), it will check total vs satisfied.
    let result = handler.evaluate(&JoinContext {
        satisfied_edges: satisfied_count,
        total_edges: total_count,
        config: &step.join_config,
        inbound: &inbound_detail,
    });

    // If the handler says Ready, trust it (any-join with partial predecessors).
    // If the handler says Skipped but predecessors aren't all done, downgrade to Waiting
    // because more edges may still become satisfied when pending predecessors complete.
    match result {
        NodeReadiness::Ready => Ok(NodeReadiness::Ready),
        NodeReadiness::Skipped if !all_predecessors_done => Ok(NodeReadiness::Waiting),
        other => Ok(other),
    }
}

/// Rebuild the frontier (ready set) from persisted step outputs after a crash.
///
/// Uses the SAME readiness algebra as is_node_ready() — if a node was completed,
/// it's done. If it wasn't, check if it's ready based on what was persisted.
/// This guarantees crash recovery produces identical behavior to normal execution.
pub fn rebuild_from_persisted(
    compiled: &crate::domain::types::CompiledDefinition,
    persisted_outcomes: &std::collections::HashMap<String, crate::domain::types::StepOutput>,
    edge_registry: &crate::domain::handlers::EdgeHandlerRegistry,
    join_registry: &crate::domain::handlers::JoinHandlerRegistry,
) -> Result<Vec<String>, WorkflowError> {
    use crate::domain::types::NodeReadiness;

    let mut frontier = Vec::new();

    for node_id in compiled.dag.nodes() {
        // Skip already-completed nodes
        if persisted_outcomes.contains_key(&node_id) {
            continue;
        }

        // Check if this node is ready based on persisted outcomes
        if let Some(step) = compiled.step_map.get(&node_id) {
            if let NodeReadiness::Ready = is_node_ready(
                &node_id,
                step,
                &compiled.dag,
                persisted_outcomes,
                edge_registry,
                join_registry,
            )? {
                frontier.push(node_id);
            }
        }
    }

    Ok(frontier)
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::types::{
        ContextualParams, ExecutionContext, ExecutionStatus, LoopState, StartData, StepOutput,
    };
    use serde_json::json;
    use slot_protocol::ActorContext;

    /// Build a test ExecutionContext with start data, step outputs, and context.
    fn test_context() -> ExecutionContext {
        let mut ctx = ExecutionContext {
            start: StartData {
                start_type: "entity_created".to_string(),
                input: json!({
                    "target_id": "node-123",
                    "entity_type": "page",
                    "nested": {"deep": {"value": 42}},
                    "change": {
                        "kind": "raw_bytes",
                        "properties": {"event_type": "runtime_loaded"}
                    }
                }),
                started_at: "2026-01-29T12:00:00Z".to_string(),
                start_id: Some("evt-001".to_string()),
            },
            context: ContextualParams {
                actor: ActorContext::new("user:admin"),
                partition_key: "partition:genesis".to_string(),
                organization_id: "org:default".to_string(),
                platform: crate::domain::PlatformInfo {
                    os: std::env::consts::OS.to_string(),
                    arch: std::env::consts::ARCH.to_string(),
                },
            },
            ..Default::default()
        };

        // Step outputs
        ctx.steps.insert(
            "step1".to_string(),
            StepOutput {
                output: json!({"created_id": "entity-456", "count": 3}),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 42,
            },
        );
        ctx.steps.insert(
            "step2".to_string(),
            StepOutput {
                output: json!("simple_string_output"),
                status: ExecutionStatus::Completed,
                error: Some("minor warning".to_string()),
                duration_ms: 7,
            },
        );

        ctx
    }

    fn test_context_with_loop() -> ExecutionContext {
        let mut ctx = test_context();
        ctx.loop_state = Some(LoopState {
            item_var: "item".to_string(),
            item: json!({"name": "Task A", "priority": 1}),
            index: 2,
            total: 5,
            first: false,
            last: false,
        });
        ctx
    }

    fn nested_array(depth: usize) -> Value {
        let mut nested = Value::Null;
        for _ in 0..depth {
            nested = Value::Array(vec![nested]);
        }
        nested
    }

    fn nested_json_string(depth: usize) -> String {
        let mut nested = "null".to_string();
        for _ in 0..depth {
            nested = format!("[{nested}]");
        }
        nested
    }

    #[test]
    fn stringify_rejects_over_depth_json_with_typed_error() {
        let mut ctx = test_context();
        ctx.json_conversion_policy.max_depth = 16;
        let nested = nested_array(64);
        ctx.start.input = json!({"hostile": nested});
        let binding = json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "hostile"},
            "transform": [{
                "op": "op:core.stringify",
                "args": {"format": "json"}
            }]
        });
        let error = BindingResolver::resolve_value(&binding, &ctx).unwrap_err();
        assert_eq!(error.code(), "FE_PAYLOAD_TOO_DEEP");
        assert!(matches!(error, WorkflowError::PayloadTooDeep { .. }));
    }

    #[test]
    fn get_path_projects_leaf_before_conversion_budget() {
        let mut ctx = test_context();
        ctx.json_conversion_policy.max_nodes = 4;
        ctx.start.input = json!({
            "provider": {
                "untouched": (0..100).collect::<Vec<_>>(),
                "selected": {"answer": "ok"}
            }
        });
        let binding = json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "provider"},
            "transform": [{"op": "op:core.get_path", "args": {"path": "selected.answer"}}]
        });
        assert_eq!(
            BindingResolver::resolve_value(&binding, &ctx).unwrap(),
            json!("ok")
        );
    }

    #[test]
    fn get_path_rejects_over_depth_selected_leaf_with_typed_error() {
        let mut ctx = test_context();
        ctx.json_conversion_policy.max_depth = 16;
        ctx.start.input = json!({
            "provider": {
                "selected": nested_array(64),
                "untouched": "small"
            }
        });
        let binding = json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "provider"},
            "transform": [{"op": "op:core.get_path", "args": {"path": "selected"}}]
        });
        let error = BindingResolver::resolve_value(&binding, &ctx).unwrap_err();
        assert_eq!(error.code(), "FE_PAYLOAD_TOO_DEEP");
    }

    #[test]
    fn first_rejects_over_depth_selected_element_with_typed_error() {
        let mut ctx = test_context();
        ctx.json_conversion_policy.max_depth = 16;
        ctx.start.input = json!({"items": [nested_array(64)]});
        let binding = json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "items"},
            "transform": [{"op": "op:core.first", "args": {}}]
        });
        let error = BindingResolver::resolve_value(&binding, &ctx).unwrap_err();
        assert_eq!(error.code(), "FE_PAYLOAD_TOO_DEEP");
    }

    #[test]
    fn map_rejects_oversized_projected_output_with_typed_error() {
        let mut ctx = test_context();
        ctx.json_conversion_policy.max_nodes = 5;
        ctx.start.input = json!({
            "items": [
                {"name": "a"},
                {"name": "b"},
                {"name": "c"},
                {"name": "d"},
                {"name": "e"}
            ]
        });
        let binding = json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "items"},
            "transform": [{"op": "op:core.map", "args": {"path": "name"}}]
        });
        let error = BindingResolver::resolve_value(&binding, &ctx).unwrap_err();
        assert_eq!(error.code(), "FE_PAYLOAD_TOO_LARGE");
    }

    #[test]
    fn resolved_comparison_arg_rejects_over_depth_json_with_typed_error() {
        let mut ctx = test_context();
        ctx.json_conversion_policy.max_depth = 16;
        ctx.start.input = json!({
            "left": "ok",
            "hostile": nested_array(64)
        });
        let binding = json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "left"},
            "transform": [{
                "op": "op:core.equals",
                "args": {
                    "value": {
                        "$kind": "binding",
                        "select": {"from": "input", "path": "hostile"}
                    }
                }
            }]
        });
        let error = BindingResolver::resolve_value(&binding, &ctx).unwrap_err();
        assert_eq!(error.code(), "FE_PAYLOAD_TOO_DEEP");
    }

    #[test]
    fn json_parse_rejects_over_depth_result_with_typed_error() {
        let mut ctx = test_context();
        ctx.json_conversion_policy.max_depth = 16;
        ctx.start.input = json!({"encoded": nested_json_string(64)});
        let binding = json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "encoded"},
            "transform": [{"op": "op:core.json_parse", "args": {}}]
        });
        let error = BindingResolver::resolve_value(&binding, &ctx).unwrap_err();
        assert_eq!(error.code(), "FE_PAYLOAD_TOO_DEEP");
    }

    // ========================================================================
    // Test 1: Binding AST input scope resolves from start input
    // ========================================================================

    #[test]
    fn test_resolve_input_target_id() {
        let ctx = test_context();
        let params = json!({"target_id": {"$kind": "binding", "select": {"from": "input", "path": "target_id"}}});

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["target_id"], "node-123");
    }

    // ========================================================================
    // Test 2: Binding AST steps scope returns step output object
    // ========================================================================

    #[test]
    fn test_resolve_steps_step1_output() {
        let ctx = test_context();
        let params = json!({"prev": {"$kind": "binding", "select": {"from": "steps", "key": "step1", "path": "output"}}});

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["prev"]["created_id"], "entity-456");
        assert_eq!(resolved["prev"]["count"], 3);
    }

    // ========================================================================
    // Test 3: Binding AST steps scope with deep path
    // ========================================================================

    #[test]
    fn test_resolve_steps_deep_path() {
        let ctx = test_context();
        let params = json!({"id": {"$kind": "binding", "select": {"from": "steps", "key": "step1", "path": "output.created_id"}}});

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["id"], "entity-456");
    }

    #[test]
    fn test_resolve_steps_raw_bytes_side_channel() {
        let mut ctx = test_context();
        ctx.steps.insert(
            "blob".to_string(),
            StepOutput {
                output: json!({"kind": "bytes", "ref": "blob", "size": 3}),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 1,
            },
        );
        ctx.record_raw_step_bytes("blob".to_string(), std::sync::Arc::from([0u8, 1u8, 255u8]));

        let params = json!({
            "bytes": {
                "$kind": "binding",
                "select": {"from": "steps", "key": "blob", "path": "output.bytes"}
            },
            "base64": {
                "$kind": "binding",
                "select": {"from": "steps", "key": "blob", "path": "output.base64"}
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["bytes"], json!([0, 1, 255]));
        assert_eq!(resolved["base64"], json!("AAH/"));
    }

    #[test]
    fn json_step_output_wins_over_retained_raw_response_bytes() {
        let mut ctx = test_context();
        ctx.record_raw_step_bytes(
            "step1".to_string(),
            std::sync::Arc::from(br#"{"items":[{"item_id":"removed-source"}]}"#.as_slice()),
        );

        let params = json!({
            "previous": {
                "$kind": "binding",
                "select": {"from": "steps", "key": "step1", "path": "output"},
                "transform": [{"op": "op:core.stringify", "args": {"format": "json"}}]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        let previous = serde_json::from_str::<Value>(
            resolved["previous"]
                .as_str()
                .expect("stringified JSON output"),
        )
        .unwrap();
        assert_eq!(previous, json!({"created_id": "entity-456", "count": 3}));
    }

    // ========================================================================
    // Test 4: Binding AST context scope resolves partition_key
    // ========================================================================

    #[test]
    fn test_resolve_context_partition_key() {
        let ctx = test_context();
        let params = json!({
            "ws": {"$kind": "binding", "select": {"from": "context", "path": "partition_key"}},
            "actor": {"$kind": "binding", "select": {"from": "context", "path": "actor.user_id"}},
            "platform": {"$kind": "binding", "select": {"from": "context", "path": "platform.os"}},
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["ws"], "partition:genesis");
        assert_eq!(resolved["actor"], "user:admin");
        assert_eq!(resolved["platform"], std::env::consts::OS);
    }

    /// This test previously asserted the opposite, that `context.does_not_exist` resolves to
    /// `Value::Null`. That assertion was the defect written down as an expectation: it is what
    /// let `context.now` resolve to nothing across five packages with no error raised anywhere.
    /// A scope's member set is fixed by the struct behind it, so a name outside that set is a
    /// broken binding, and the resolver already treats an unknown SCOPE exactly this way.
    #[test]
    fn unknown_member_of_a_closed_scope_is_an_error_not_null() {
        let ctx = test_context();

        for (scope, path) in [
            ("context", "does_not_exist"),
            ("context", "now"),
            ("context", "actor.does_not_exist"),
            ("context", "platform.does_not_exist"),
            ("start", "does_not_exist"),
        ] {
            let params = json!({
                "value": {"$kind": "binding", "select": {"from": scope, "path": path}}
            });
            let result = BindingResolver::resolve_value(&params, &ctx);
            assert!(
                result.is_err(),
                "binding {}.{} should be refused, not resolved to null",
                scope,
                path
            );
        }
    }

    /// The other half of the same rule, and the reason `select_json_path` was left alone. Inside
    /// user-authored data the set of paths is OPEN, so an absent one is an ordinary answer rather
    /// than a defect. Making that strict too would be the opposite error.
    #[test]
    fn absent_path_inside_user_data_still_resolves_to_null() {
        let ctx = test_context();
        let params = json!({
            "value": {"$kind": "binding", "select": {"from": "input", "path": "no_such_field"}},
            "nested": {"$kind": "binding", "select": {"from": "start", "path": "input.a.b.c"}}
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx)
            .expect("an absent path in open user data is not an error");
        assert_eq!(resolved["value"], Value::Null);
        assert_eq!(resolved["nested"], Value::Null);
    }

    // ========================================================================
    // Test 5: Binding AST loop scope resolves item, index, total, first, last
    // ========================================================================

    #[test]
    fn test_resolve_loop_item_and_index() {
        let ctx = test_context_with_loop();
        let params = json!({
            "current": {"$kind": "binding", "select": {"from": "loop", "path": "item"}},
            "idx": {"$kind": "binding", "select": {"from": "loop", "path": "index"}},
            "total": {"$kind": "binding", "select": {"from": "loop", "path": "total"}},
            "is_first": {"$kind": "binding", "select": {"from": "loop", "path": "first"}},
            "is_last": {"$kind": "binding", "select": {"from": "loop", "path": "last"}}
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["current"]["name"], "Task A");
        assert_eq!(resolved["current"]["priority"], 1);
        assert_eq!(resolved["idx"], 2);
        assert_eq!(resolved["total"], 5);
        assert_eq!(resolved["is_first"], false);
        assert_eq!(resolved["is_last"], false);
    }

    // ========================================================================
    // Test 6: Binding AST with unknown scope returns helpful error
    // ========================================================================

    #[test]
    fn test_invalid_template_scope_returns_error() {
        let ctx = test_context();
        let params =
            json!({"bad": {"$kind": "binding", "select": {"from": "unknown", "path": "field"}}});

        let result = BindingResolver::resolve_value(&params, &ctx);
        assert!(result.is_err());

        let err = result.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Unknown binding scope"), "Error: {}", msg);
        assert!(msg.contains("unknown"), "Error: {}", msg);
        assert!(msg.contains("Hint:"), "Error must contain hint: {}", msg);
    }

    // ========================================================================
    // Test 7: Binding AST with missing input field resolves to null
    // ========================================================================

    #[test]
    fn test_missing_input_field_returns_error() {
        let ctx = test_context();
        let params = json!({"missing": {"$kind": "binding", "select": {"from": "input", "path": "nonexistent_field"}}});

        // Formula engine returns null for missing paths (not an error)
        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert!(resolved["missing"].is_null());
    }

    // ========================================================================
    // Test 8: Binding AST with missing step ID resolves to null
    // ========================================================================

    #[test]
    fn test_missing_step_id_returns_error() {
        let ctx = test_context();
        let params = json!({"ref": {"$kind": "binding", "select": {"from": "steps", "key": "nonexistent_step", "path": "output"}}});

        // Formula engine returns null for missing step IDs (not an error)
        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert!(resolved["ref"].is_null());
    }

    // ========================================================================
    // Test 9: No-template strings pass through unchanged
    // ========================================================================

    #[test]
    fn test_no_template_passes_through() {
        let ctx = test_context();
        let params = json!({
            "literal": "just a string",
            "number": 42,
            "bool": true,
            "null_val": null,
            "array": [1, 2, 3]
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved, params);
    }

    // ========================================================================
    // Test 10: Multiple binding AST fields in same object
    // ========================================================================

    #[test]
    fn test_mixed_template_and_literal() {
        let ctx = test_context();
        let params = json!({
            "entity": {"$kind": "binding", "select": {"from": "input", "path": "target_id"}},
            "partition": {"$kind": "binding", "select": {"from": "context", "path": "partition_key"}},
            "literal": "unchanged"
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["entity"], "node-123");
        assert_eq!(resolved["partition"], "partition:genesis");
        assert_eq!(resolved["literal"], "unchanged");
    }

    #[test]
    fn test_opaque_json_preserves_target_owned_binding_ast() {
        let ctx = test_context();
        let target_owned_ast = json!({
            "$kind": "binding",
            "select": {"from": "literal", "value": null},
            "transform": [{
                "op": "op:core.set",
                "args": {
                    "key": "score",
                    "value": {"$kind": "binding", "select": {"from": "context", "path": "score"}}
                }
            }]
        });
        let params = json!({
            "binding": {
                "$kind": "opaque-json",
                "value": target_owned_ast
            },
            "context": {
                "entity": {"$kind": "binding", "select": {"from": "input", "path": "target_id"}}
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["binding"], target_owned_ast);
        assert_eq!(resolved["context"]["entity"], "node-123");
    }

    #[test]
    fn test_binding_result_flattens_nested_bindings_by_default() {
        let mut ctx = test_context();
        ctx.steps.insert(
            "producer".to_string(),
            StepOutput {
                output: json!({
                    "value": {
                        "$kind": "binding",
                        "select": {"from": "input", "path": "target_id"}
                    }
                }),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 1,
            },
        );
        let params = json!({
            "payload": {
                "$kind": "binding",
                "select": {"from": "steps", "key": "producer", "path": "output"}
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["payload"]["value"], "node-123");
    }

    #[test]
    fn test_binding_can_copy_selected_target_owned_json_opaquely() {
        let mut ctx = test_context();
        let target_owned_records = json!([
            {
                "kind": "reply-template",
                "payload": {
                    "$kind": "binding",
                    "select": {"from": "dataSource", "path": "row"},
                    "transform": [{
                        "op": "op:core.map",
                        "args": {"path": "value_json"}
                    }]
                }
            }
        ]);
        ctx.steps.insert(
            "producer".to_string(),
            StepOutput {
                output: json!({"items": target_owned_records}),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 1,
            },
        );
        let params = json!({
            "payload": {
                "$kind": "binding",
                "select": {"from": "steps", "key": "producer", "path": "output.items"},
                "resolve_nested_bindings": false
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["payload"], target_owned_records);
    }

    // ========================================================================
    // Test 11: Binding AST preserves type (number from step output)
    // ========================================================================

    #[test]
    fn test_exact_template_preserves_type() {
        let ctx = test_context();
        let params = json!({"count": {"$kind": "binding", "select": {"from": "steps", "key": "step1", "path": "output.count"}}});

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["count"], 3);
        assert!(resolved["count"].is_number());
    }

    // ========================================================================
    // Test 12: Nested object with binding AST at leaf positions
    // ========================================================================

    #[test]
    fn test_nested_object_resolution() {
        let ctx = test_context();
        let params = json!({
            "outer": {
                "inner": {
                    "value": {"$kind": "binding", "select": {"from": "input", "path": "target_id"}}
                },
                "list": [{"$kind": "binding", "select": {"from": "input", "path": "entity_type"}}, "literal"]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["outer"]["inner"]["value"], "node-123");
        assert_eq!(resolved["outer"]["list"][0], "page");
        assert_eq!(resolved["outer"]["list"][1], "literal");
    }

    // ========================================================================
    // Test 13: Binding AST loop scope without active loop returns error
    // ========================================================================

    #[test]
    fn test_loop_template_without_active_loop_errors() {
        let ctx = test_context(); // No loop state
        let params =
            json!({"item": {"$kind": "binding", "select": {"from": "loop", "path": "item"}}});

        let result = BindingResolver::resolve_value(&params, &ctx);
        assert!(result.is_err());

        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("no loop"), "Error: {}", msg);
    }

    // ========================================================================
    // Test 14: Binding AST start scope resolution
    // ========================================================================

    #[test]
    fn test_start_scope_resolution() {
        let ctx = test_context();
        let params = json!({
            "type": {"$kind": "binding", "select": {"from": "start", "path": "start_type"}},
            "ts": {"$kind": "binding", "select": {"from": "start", "path": "started_at"}},
            "id": {"$kind": "binding", "select": {"from": "start", "path": "start_id"}}
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["type"], "entity_created");
        assert_eq!(resolved["ts"], "2026-01-29T12:00:00Z");
        assert_eq!(resolved["id"], "evt-001");
    }

    // ========================================================================
    // Test 15: Binding AST deep nested input path
    // ========================================================================

    #[test]
    fn test_deep_nested_input_path() {
        let ctx = test_context();
        let params = json!({"deep": {"$kind": "binding", "select": {"from": "input", "path": "nested.deep.value"}}});

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["deep"], 42);
    }

    #[test]
    fn test_change_scope_resolution() {
        let ctx = test_context();
        let params = json!({
            "event_type": {"$kind": "binding", "select": {"from": "change", "path": "properties.event_type"}}
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["event_type"], "runtime_loaded");
    }

    // ========================================================================
    // Test 16: Binding AST step status and error accessors
    // ========================================================================

    #[test]
    fn test_step_status_and_error_accessors() {
        let ctx = test_context();
        let params = json!({
            "s1_status": {"$kind": "binding", "select": {"from": "steps", "key": "step1", "path": "status"}},
            "s2_error": {"$kind": "binding", "select": {"from": "steps", "key": "step2", "path": "error"}},
            "s1_dur": {"$kind": "binding", "select": {"from": "steps", "key": "step1", "path": "duration_ms"}}
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["s1_status"], "completed");
        assert_eq!(resolved["s2_error"], "minor warning");
        assert_eq!(resolved["s1_dur"], 42);
    }

    // ========================================================================
    // Test 17: record_step_output accumulates correctly
    // ========================================================================

    #[test]
    fn test_record_step_output() {
        let mut ctx = ExecutionContext::default();
        assert!(ctx.steps.is_empty());

        record_step_output(
            &mut ctx,
            "step_a",
            StepOutput {
                output: json!({"result": "ok"}),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 10,
            },
        );

        assert_eq!(ctx.steps.len(), 1);
        assert_eq!(ctx.steps["step_a"].output["result"], "ok");

        // Second step accumulates
        record_step_output(
            &mut ctx,
            "step_b",
            StepOutput {
                output: json!(42),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 5,
            },
        );

        assert_eq!(ctx.steps.len(), 2);
        assert_eq!(ctx.steps["step_b"].output, 42);
    }

    // ========================================================================
    // Test 18: Empty expression returns error
    // ========================================================================

    #[test]
    fn test_empty_expression_returns_error() {
        let ctx = test_context();
        // "{{}}" has empty content — find_tokens skips empty expressions
        let params = json!({"val": "{{  }}"});

        // Empty expressions are skipped by find_tokens (no resolution attempted)
        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["val"], "{{  }}");
    }

    // ========================================================================
    // BINDING AST TESTS (Machine-Readable Alternative to Mustache)
    // ========================================================================

    // ========================================================================
    // Test 19: Binding AST with from: "input" resolves from start.input
    // ========================================================================

    #[test]
    fn test_binding_ast_optional_member_preserves_explicit_null_and_array_positions() {
        let mut ctx = test_context();
        ctx.start.input = json!({"present": "reference", "cleared": null});
        let optional = |name: &str| json!({"$kind": "binding", "values": ["input", name], "omit_if_missing": true});
        let params = json!({
            "missing": optional("absent"),
            "present": optional("present"),
            "cleared": optional("cleared"),
            "ordinary": {"$kind": "binding", "values": ["input", "absent"]},
            "nested": {"missing": optional("absent"), "literal_null": null},
            "array": [optional("absent"), optional("cleared"), optional("present")]
        });
        assert_eq!(BindingResolver::resolve_value(&params, &ctx).unwrap(), json!({
            "present": "reference", "cleared": null, "ordinary": null,
            "nested": {"literal_null": null}, "array": [null, null, "reference"]
        }));
        assert_eq!(BindingResolver::resolve_value(&optional("absent"), &ctx).unwrap(), Value::Null);
        for invalid in [
            json!({"$kind": "binding", "values": ["input", "absent"], "omit_if_missing": "true"}),
            json!({"$kind": "binding", "expr": "input.present", "omit_if_missing": true})
        ] {
            assert!(BindingResolver::resolve_value(&json!({"optional": invalid}), &ctx).is_err());
        }
    }

    #[test]
    fn test_binding_ast_input_scope() {
        let ctx = test_context();
        let params = json!({
            "target": {
                "$kind": "binding",
                "select": {
                    "from": "input",
                    "path": "target_id"
                }
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["target"], "node-123");
    }

    // ========================================================================
    // Test 20: Binding AST with from: "steps" resolves step output
    // ========================================================================

    #[test]
    fn test_binding_ast_steps_scope_with_key_and_path() {
        let ctx = test_context();
        let params = json!({
            "entity_id": {
                "$kind": "binding",
                "select": {
                    "from": "steps",
                    "key": "step1",
                    "path": "output.created_id"
                }
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["entity_id"], "entity-456");
    }

    // ========================================================================
    // Test 21: Binding AST with from: "steps", empty path returns full output
    // ========================================================================

    #[test]
    fn test_binding_ast_steps_scope_full_output() {
        let ctx = test_context();
        let params = json!({
            "step_data": {
                "$kind": "binding",
                "select": {
                    "from": "steps",
                    "key": "step1",
                    "path": ""
                }
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        // Empty path returns full StepOutput: {output: {...}, status, error, duration_ms}
        assert_eq!(resolved["step_data"]["output"]["created_id"], "entity-456");
        assert_eq!(resolved["step_data"]["output"]["count"], 3);
    }

    // ========================================================================
    // Test 22: Binding AST with from: "context" resolves context fields
    // ========================================================================

    #[test]
    fn test_binding_ast_context_scope() {
        let ctx = test_context();
        let params = json!({
            "ws": {
                "$kind": "binding",
                "select": {
                    "from": "context",
                    "path": "partition_key"
                }
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["ws"], "partition:genesis");
    }

    // ========================================================================
    // Test 23: Binding AST with from: "loop" resolves loop.item
    // ========================================================================

    #[test]
    fn test_binding_ast_loop_scope() {
        let ctx = test_context_with_loop();
        let params = json!({
            "current_item": {
                "$kind": "binding",
                "select": {
                    "from": "loop",
                    "path": "item"
                }
            },
            "current_index": {
                "$kind": "binding",
                "select": {
                    "from": "loop",
                    "path": "index"
                }
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["current_item"]["name"], "Task A");
        assert_eq!(resolved["current_item"]["priority"], 1);
        assert_eq!(resolved["current_index"], 2);
    }

    // ========================================================================
    // Test 24: Binding AST with from: "ambient" resolves from start.input
    // ========================================================================

    #[test]
    fn test_binding_ast_ambient_scope() {
        let ctx = test_context();
        let params = json!({
            "entity_type": {
                "$kind": "binding",
                "select": {
                    "from": "ambient",
                    "path": "entity_type"
                }
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["entity_type"], "page");
    }

    // ========================================================================
    // Test 25: Binding AST with from: "state" returns error (requires pre-resolution)
    // ========================================================================

    #[test]
    fn test_binding_ast_state_scope_returns_error() {
        let ctx = test_context();
        let params = json!({
            "state_val": {
                "$kind": "binding",
                "select": {
                    "from": "state",
                    "path": "some_field"
                }
            }
        });

        let result = BindingResolver::resolve_value(&params, &ctx);
        assert!(result.is_err());

        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("state"), "Error: {}", msg);
        assert!(msg.contains("requires I/O"), "Error: {}", msg);
    }

    // ========================================================================
    // Test 26: Binding AST with unknown scope returns error
    // ========================================================================

    #[test]
    fn test_binding_ast_unknown_scope_returns_error() {
        let ctx = test_context();
        let params = json!({
            "bad": {
                "$kind": "binding",
                "select": {
                    "from": "unknown_scope",
                    "path": "field"
                }
            }
        });

        let result = BindingResolver::resolve_value(&params, &ctx);
        assert!(result.is_err());

        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Unknown binding scope"), "Error: {}", msg);
        assert!(msg.contains("unknown_scope"), "Error: {}", msg);
    }

    // ========================================================================
    // Test 27: Binding AST mixed with mustache in same params object
    // ========================================================================

    #[test]
    fn test_binding_ast_and_literal_string_together() {
        let ctx = test_context();
        let params = json!({
            "from_binding": {
                "$kind": "binding",
                "select": {
                    "from": "input",
                    "path": "target_id"
                }
            },
            "literal_string": "{{input.entity_type}}"
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["from_binding"], "node-123");
        // Mustache syntax is NOT resolved (L030 — deleted). Stays literal.
        assert_eq!(resolved["literal_string"], "{{input.entity_type}}");
    }

    // ========================================================================
    // Test 28: Binding AST with missing "select" field returns error
    // ========================================================================

    #[test]
    fn test_binding_ast_missing_select_returns_error() {
        let ctx = test_context();
        let params = json!({
            "bad": {
                "$kind": "binding"
                // Missing "select" field
            }
        });

        let result = BindingResolver::resolve_value(&params, &ctx);
        assert!(result.is_err());

        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("no \"select\""), "Error: {}", msg);
    }

    // ========================================================================
    // Test 29: Binding AST with from: "start" resolves start data
    // ========================================================================

    #[test]
    fn test_binding_ast_start_scope() {
        let ctx = test_context();
        let params = json!({
            "event_type": {
                "$kind": "binding",
                "select": {
                    "from": "start",
                    "path": "start_type"
                }
            },
            "timestamp": {
                "$kind": "binding",
                "select": {
                    "from": "start",
                    "path": "started_at"
                }
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["event_type"], "entity_created");
        assert_eq!(resolved["timestamp"], "2026-01-29T12:00:00Z");
    }

    // ========================================================================
    // Test 30: Binding AST with nested path in input scope
    // ========================================================================

    #[test]
    fn test_binding_ast_nested_path() {
        let ctx = test_context();
        let params = json!({
            "deep_value": {
                "$kind": "binding",
                "select": {
                    "from": "input",
                    "path": "nested.deep.value"
                }
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["deep_value"], 42);
    }

    // ========================================================================
    // Test 31: Binding AST without key in steps scope uses path only
    // ========================================================================

    #[test]
    fn test_binding_ast_steps_scope_no_key() {
        let ctx = test_context();
        let params = json!({
            "step_output": {
                "$kind": "binding",
                "select": {
                    "from": "steps",
                    "path": "step1.output.created_id"
                }
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["step_output"], "entity-456");
    }

    // ========================================================================
    // PIPE FILTER TESTS
    // ========================================================================

    // ========================================================================
    // Test 32: Binding AST with op:core.upper transform
    // ========================================================================

    #[test]
    fn test_binding_ast_transform_upper() {
        let ctx = test_context();
        let params = json!({
            "upper_type": {
                "$kind": "binding",
                "select": {"from": "input", "path": "entity_type"},
                "transform": [{"op": "op:core.upper", "args": {}}]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["upper_type"], "PAGE");
    }

    #[test]
    fn test_binding_ast_transform_concat_values() {
        let ctx = test_context();
        let params = json!({
            "address": {
                "$kind": "binding",
                "select": {"from": "input", "path": "target_id"},
                "transform": [{
                    "op": "op:core.concat",
                    "args": {
                        "values": [
                            "attribute_fact|partition:genesis|",
                            {"$kind": "binding", "select": {"from": "input", "path": "target_id"}},
                            "|prop:resource:compiler_config|type:extension"
                        ]
                    }
                }]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(
            resolved["address"],
            "attribute_fact|partition:genesis|node-123|prop:resource:compiler_config|type:extension"
        );
    }

    #[test]
    fn test_binding_ast_resolves_addressed_write_descriptor_batch() {
        let mut ctx = test_context();
        ctx.start.input = json!({
            "event_ref": "owner-action-event:generic-package:record-state:test-batch",
            "actor_ref": "actor:test-batch",
            "target_ref": "target:test-batch",
            "requested_at": "2999-01-01T00:00:00.000Z",
            "payload": {
                "subject_ref": "subject:test-batch",
                "patch": {
                    "draft_text": "draft text",
                    "reply_selection_refs": ["related:item"],
                    "activity_state_ref": "activity-state:active",
                    "activity_phrase": "active phrase",
                    "activity_expires_at": "2999-01-01T00:01:00.000Z"
                }
            }
        });

        fn event_concat(prefix: &str, suffix: &str) -> Value {
            json!({
                "$kind": "binding",
                "select": {
                    "from": "input",
                    "path": "event_ref"
                },
                "transform": [{
                    "op": "op:core.concat",
                    "args": {
                        "values": [
                            prefix,
                            {
                                "$kind": "binding",
                                "select": {
                                    "from": "input",
                                    "path": "event_ref"
                                }
                            },
                            suffix
                        ]
                    }
                }]
            })
        }

        fn stringified_input(path: &str) -> Value {
            json!({
                "$kind": "binding",
                "select": {
                    "from": "input",
                    "path": path
                },
                "transform": [{
                    "op": "op:core.stringify",
                    "args": {
                        "format": "json"
                    }
                }]
            })
        }

        let subject_binding = event_concat("state-record:", "");
        let mut items = vec![json!({
            "address": event_concat("record|state-record:", ""),
            "path": ["record-state", "record"],
            "payload": {
                "table": "record",
                "id": subject_binding
            }
        })];

        for (property_id, type_id, input_path) in [
            ("prop:state_record:actor_ref", "type:string", "actor_ref"),
            ("prop:state_record:target_ref", "type:string", "target_ref"),
            (
                "prop:state_record:subject_ref",
                "type:string",
                "payload.subject_ref",
            ),
            (
                "prop:state_record:draft_text",
                "type:string",
                "payload.patch.draft_text",
            ),
            (
                "prop:state_record:reply_selection_refs",
                "type:json",
                "payload.patch.reply_selection_refs",
            ),
            (
                "prop:state_record:activity_state_ref",
                "type:string",
                "payload.patch.activity_state_ref",
            ),
            (
                "prop:state_record:activity_phrase",
                "type:string",
                "payload.patch.activity_phrase",
            ),
            (
                "prop:state_record:activity_expires_at",
                "type:string",
                "payload.patch.activity_expires_at",
            ),
            (
                "prop:state_record:updated_at",
                "type:string",
                "requested_at",
            ),
            ("prop:state_record:payload", "type:json", "payload"),
        ] {
            let suffix = format!("|{property_id}|{type_id}");
            items.push(json!({
                "address": event_concat("record_fields|state-record:", &suffix),
                "path": ["record-state", "record-fields"],
                "payload": {
                    "table": "record_fields",
                    "record_id": event_concat("state-record:", ""),
                    "field_id": property_id,
                    "value_kind_id": type_id,
                    "value_json": stringified_input(input_path)
                }
            }));
        }

        let resolved = BindingResolver::resolve_value(&Value::Array(items), &ctx).unwrap();
        let resolved_items = resolved.as_array().expect("resolved write items");
        assert_eq!(resolved_items.len(), 11);
        assert_eq!(
            resolved_items[0]["payload"]["id"],
            "state-record:owner-action-event:generic-package:record-state:test-batch"
        );
        assert_eq!(
            resolved_items[5]["payload"]["value_json"],
            "[\"related:item\"]"
        );
        assert_eq!(
            resolved_items[10]["payload"]["value_json"],
            "{\"patch\":{\"activity_expires_at\":\"2999-01-01T00:01:00.000Z\",\"activity_phrase\":\"active phrase\",\"activity_state_ref\":\"activity-state:active\",\"draft_text\":\"draft text\",\"reply_selection_refs\":[\"related:item\"]},\"subject_ref\":\"subject:test-batch\"}"
        );
    }

    #[test]
    fn test_binding_ast_transform_format_prefix() {
        let ctx = test_context();
        let params = json!({
            "label": {
                "$kind": "binding",
                "select": {"from": "input", "path": "target_id"},
                "transform": [{"op": "op:core.format", "args": {"prefix": "label:"}}]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["label"], "label:node-123");
    }

    #[test]
    fn test_binding_ast_transform_format_values() {
        let ctx = test_context();
        let params = json!({
            "message": {
                "$kind": "binding",
                "select": {"from": "input", "path": "entity_type"},
                "transform": [{
                    "op": "op:core.format",
                    "args": {
                        "values": [
                            {"$kind": "binding", "select": {"from": "input", "path": "target_id"}}
                        ]
                    }
                }]
            }
        });

        let mut resolved_template_ctx = ctx.clone();
        resolved_template_ctx.start.input = json!({
            "entity_type": "Entity {0} ready",
            "target_id": "node-123",
            "nested": {"deep": {"value": 42}}
        });

        let resolved = BindingResolver::resolve_value(&params, &resolved_template_ctx).unwrap();
        assert_eq!(resolved["message"], "Entity node-123 ready");
    }

    #[test]
    fn test_binding_ast_transform_stringify_json_escapes_control_chars() {
        let mut ctx = test_context();
        ctx.start.input = json!({
            "bundle_text": "line 1\n\"quoted\""
        });
        let params = json!({
            "bundle_json": {
                "$kind": "binding",
                "select": {"from": "input", "path": "bundle_text"},
                "transform": [{
                    "op": "op:core.stringify",
                    "args": {"format": "json"}
                }]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["bundle_json"], "\"line 1\\n\\\"quoted\\\"\"");
    }

    #[test]
    fn test_binding_ast_transform_stringify_then_encode_base64() {
        let mut ctx = test_context();
        ctx.start.input = json!({
            "rows": [{"subject_id": "record:1", "value_json": "Pinned"}]
        });
        let params = json!({
            "mounted_bytes": {
                "$kind": "binding",
                "select": {"from": "input", "path": "rows"},
                "transform": [
                    {"op": "op:core.stringify", "args": {"format": "json"}},
                    {"op": "op:core.encode", "args": {"encoding": "base64"}}
                ]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(
            resolved["mounted_bytes"],
            "W3sic3ViamVjdF9pZCI6InJlY29yZDoxIiwidmFsdWVfanNvbiI6IlBpbm5lZCJ9XQ=="
        );
    }

    #[test]
    fn test_binding_ast_transform_decode_base64_then_json_parse() {
        let mut ctx = test_context();
        ctx.start.input = json!({
            "output_bytes": "eyJtZXNzYWdlX2NvdW50IjozfQ=="
        });
        let params = json!({
            "message_count": {
                "$kind": "binding",
                "select": {"from": "input", "path": "output_bytes"},
                "transform": [
                    {"op": "op:core.decode", "args": {"encoding": "base64"}},
                    {"op": "op:core.json_parse"},
                    {"op": "op:core.lookup", "args": {"key": "message_count"}}
                ]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["message_count"], 3);
    }

    #[test]
    fn test_binding_ast_transform_decode_base64_json_parse_large_write_batch() {
        let rows: Vec<Value> = (0..5_000)
            .map(|index| {
                json!({
                    "address": format!("research-workspace::source::{index}"),
                    "payload": {
                        "kind": "research-source",
                        "item_id": format!("item-{index}"),
                        "title": format!("Large batch source {index}")
                    }
                })
            })
            .collect();
        let encoded = STANDARD.encode(serde_json::to_string(&rows).unwrap());
        let mut ctx = test_context();
        ctx.start.input = json!({ "writes_base64": encoded });
        let params = json!({
            "writes": {
                "$kind": "binding",
                "select": {"from": "input", "path": "writes_base64"},
                "transform": [
                    {"op": "op:core.decode", "args": {"encoding": "base64"}},
                    {"op": "op:core.json_parse"}
                ]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        let resolved_rows = resolved["writes"].as_array().unwrap();
        assert_eq!(resolved_rows.len(), 5_000);
        assert_eq!(resolved_rows[0]["address"], "research-workspace::source::0");
        assert_eq!(
            resolved_rows[4_999]["address"],
            "research-workspace::source::4999"
        );
    }

    #[test]
    fn test_binding_ast_transform_decode_base64_then_bound_utf8_presentation() {
        let mut ctx = test_context();
        ctx.start.input = json!({
            "stderr_base64": "dGhpcyBpcyBhIGJvdW5kZWQgZXJyb3I="
        });
        let params = json!({
            "stderr": {
                "$kind": "binding",
                "select": {"from": "input", "path": "stderr_base64"},
                "transform": [
                    {"op": "op:core.decode", "args": {"encoding": "base64"}},
                    {"op": "op:core.left", "args": {"count": 9}}
                ]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["stderr"], "this is a");
    }

    #[test]
    fn test_binding_ast_transform_get_path_extracts_top_level_and_nested() {
        // The leaf-materializer use case: a compute step emits base64 JSON
        // {"records":[...],"view":{...},"meta":{"n":2}}; a write step binds each
        // field out of the decoded value in pure DATA (no host code) via get_path,
        // which reuses ops-core's OpValue::get_path (single navigation home).
        let mut ctx = test_context();
        // base64 of {"records":[{"id":"a"}],"view":{"fields":[]},"meta":{"n":2}}
        ctx.start.input = json!({
            "output_bytes": "eyJyZWNvcmRzIjpbeyJpZCI6ImEifV0sInZpZXciOnsiZmllbGRzIjpbXX0sIm1ldGEiOnsibiI6Mn19"
        });
        let decoded = |path: &str| {
            json!({
                "$kind": "binding",
                "select": {"from": "input", "path": "output_bytes"},
                "transform": [
                    {"op": "op:core.decode", "args": {"encoding": "base64"}},
                    {"op": "op:core.json_parse"},
                    {"op": "op:core.get_path", "args": {"path": path}}
                ]
            })
        };
        let params = json!({
            "records": decoded("records"),
            "view": decoded("view"),
            "nested": decoded("meta.n"),
        });
        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["records"], json!([{"id": "a"}]));
        assert_eq!(resolved["view"], json!({"fields": []}));
        assert_eq!(resolved["nested"], json!(2)); // dotted nested path
    }

    // ========================================================================
    // Test 33: Binding AST with unknown transform returns error
    // ========================================================================

    #[test]
    fn test_unknown_filter_returns_error() {
        let ctx = test_context();
        let params = json!({
            "val": {
                "$kind": "binding",
                "select": {"from": "input", "path": "target_id"},
                "transform": [{"op": "op:core.nonexistent", "args": {}}]
            }
        });

        let result = BindingResolver::resolve_value(&params, &ctx);
        assert!(result.is_err());

        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("nonexistent"), "Error: {}", msg);
    }

    // ========================================================================
    // Test 34: Binding AST transform on number preserves type
    // ========================================================================

    #[test]
    fn test_filter_on_non_string_is_noop() {
        let ctx = test_context();
        let params = json!({
            "count": {
                "$kind": "binding",
                "select": {"from": "steps", "key": "step1", "path": "output.count"}
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["count"], 3);
        assert!(resolved["count"].is_number());
    }

    // ========================================================================
    // Test 35: Binding AST with op:core.equals transform
    // ========================================================================

    #[test]
    fn test_escape_applescript_escapes_double_quotes() {
        let ctx = test_context();
        let params = json!({
            "is_match": {
                "$kind": "binding",
                "select": {"from": "input", "path": "target_id"},
                "transform": [{"op": "op:core.equals", "args": {"value": "node-123"}}]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["is_match"], true);
    }

    #[test]
    fn test_binding_transform_in_list() {
        let ctx = test_context();
        let params = json!({
            "is_match": {
                "$kind": "binding",
                "select": {"from": "input", "path": "target_id"},
                "transform": [{
                    "op": "op:core.in_list",
                    "args": {"values": ["node-999", "node-123"]}
                }]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["is_match"], true);
    }

    #[test]
    fn membership_operators_resolve_bound_comparison_operands() {
        let mut ctx = test_context();
        ctx.start.input["ids"] = json!(["node-123"]);
        let bound = json!({"$kind":"binding","select":{"from":"input","path":"target_id"}});
        let params = json!({
            "includes": {"$kind":"binding","select":{"from":"input","path":"ids"},
                "transform":[{"op":"op:core.includes","args":{"value":bound}}]},
            "in_list": {"$kind":"binding","select":{"from":"input","path":"target_id"},
                "transform":[{"op":"op:core.in_list","args":{"values":{"$kind":"binding","select":{"from":"input","path":"ids"}}}}]}
        });
        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["includes"], true);
        assert_eq!(resolved["in_list"], true);
        let misses = json!({
            "includes": {"$kind":"binding","select":{"from":"input","path":"ids"},
                "transform":[{"op":"op:core.includes","args":{"value":"absent"}}]},
            "in_list": {"$kind":"binding","select":{"from":"input","path":"target_id"},
                "transform":[{"op":"op:core.in_list","args":{"values":["absent"]}}]}
        });
        let resolved = BindingResolver::resolve_value(&misses, &ctx).unwrap();
        assert_eq!(resolved["includes"], false);
        assert_eq!(resolved["in_list"], false);
    }

    #[test]
    fn test_binding_transform_if_null() {
        let ctx = test_context();
        let params = json!({
            "layout": {
                "$kind": "binding",
                "select": {"from": "input", "path": "missing_layout"},
                "transform": [{
                    "op": "op:core.if_null",
                    "args": {
                        "fallback": {
                            "surface": "grid",
                            "containers": {"main": {"id": "main"}}
                        }
                    }
                }]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["layout"]["surface"], "grid");
        assert_eq!(resolved["layout"]["containers"]["main"]["id"], "main");
    }

    #[test]
    fn test_binding_transform_append_resolves_appended_value_bindings() {
        let mut ctx = test_context();
        ctx.start.input["items"] = json!([{"id": "seed"}]);
        let params = json!({
            "items": {
                "$kind": "binding",
                "select": {"from": "input", "path": "items"},
                "transform": [{
                    "op": "op:core.append",
                    "args": {
                        "value": {
                            "id": {"$kind": "binding", "select": {"from": "input", "path": "target_id"}}
                        }
                    }
                }]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(
            resolved["items"].as_array().unwrap().last().unwrap()["id"],
            "node-123"
        );
    }

    #[test]
    fn test_binding_transform_set_resolves_key_and_value_from_independent_scopes() {
        let mut ctx = test_context();
        ctx.start.input["destination"] = json!({"existing": true});
        ctx.start.input["dynamic_key"] = json!("created_id");
        let params = json!({
            "projected": {
                "$kind": "binding",
                "select": {"from": "input", "path": "destination"},
                "transform": [{
                    "op": "op:core.set",
                    "args": {
                        "key": {"$kind": "binding", "select": {"from": "input", "path": "dynamic_key"}},
                        "value": {"$kind": "binding", "select": {"from": "steps", "key": "step1", "path": "created_id"}}
                    }
                }]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["projected"], json!({"existing": true, "created_id": "entity-456"}));
        assert_eq!(ctx.start.input["destination"], json!({"existing": true}), "set must leave its source scope unchanged");
    }

    #[test]
    fn test_binding_transform_set_keeps_missing_binding_as_explicit_null() {
        let ctx = test_context();
        let params = json!({
            "projected": {
                "$kind": "binding",
                "select": {"from": "input", "path": "nested.deep"},
                "transform": [{
                    "op": "op:core.set",
                    "args": {
                        "key": "optional_value",
                        "value": {"$kind": "binding", "select": {"from": "input", "path": "field_that_is_absent"}}
                    }
                }]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["projected"], json!({"optional_value": null}));
    }

    #[test]
    fn test_binding_transform_set_type_refusal_is_structured() {
        let ctx = test_context();
        let params = json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "target_id"},
            "transform": [{"op": "op:core.set", "args": {"key": "field", "value": true}}]
        });

        assert!(matches!(
            BindingResolver::resolve_value(&params, &ctx),
            Err(WorkflowError::TemplateResolutionFailed { reason, hint })
                if reason.contains("op:core.set failed") && hint.contains("object, array, or null")
        ));
    }

    #[test]
    fn test_binding_transform_merge_resolves_source_and_source_wins_without_mutation() {
        let mut ctx = test_context();
        ctx.start.input["base"] = json!({"keep": 1, "replace": "old"});
        ctx.context.organization_id = "org:updated".to_string();
        let params = json!({
            "projected": {
                "$kind": "binding",
                "select": {"from": "input", "path": "base"},
                "transform": [{
                    "op": "op:core.merge",
                    "args": {
                        "source": {
                            "replace": {"$kind": "binding", "select": {"from": "context", "path": "organization_id"}},
                            "added": {"$kind": "binding", "select": {"from": "steps", "key": "step1", "path": "count"}}
                        }
                    }
                }]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["projected"], json!({"keep": 1, "replace": "org:updated", "added": 3}));
        assert_eq!(ctx.start.input["base"], json!({"keep": 1, "replace": "old"}), "merge must leave its source scope unchanged");
    }

    #[test]
    fn test_binding_transform_merge_type_refusal_is_structured() {
        let ctx = test_context();
        let params = json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "target_id"},
            "transform": [{"op": "op:core.merge", "args": {"source": {"field": 1}}}]
        });

        assert!(matches!(
            BindingResolver::resolve_value(&params, &ctx),
            Err(WorkflowError::TemplateResolutionFailed { reason, hint })
                if reason.contains("op:core.merge failed") && hint.contains("objects or null")
        ));
    }

    // ========================================================================
    // Test 36: Binding AST with op:core.first transform on array
    // ========================================================================

    #[test]
    fn test_escape_applescript_escapes_backslashes_first() {
        let mut ctx = test_context();
        ctx.steps.insert(
            "query".to_string(),
            StepOutput {
                output: json!({"items": ["alpha", "beta", "gamma"]}),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 5,
            },
        );

        let params = json!({
            "first_item": {
                "$kind": "binding",
                "select": {"from": "steps", "key": "query", "path": "output.items"},
                "transform": [{"op": "op:core.first", "args": {}}]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["first_item"], "alpha");
    }

    #[test]
    fn test_binding_transform_take_uses_existing_array_primitive() {
        let mut ctx = test_context();
        ctx.steps.insert(
            "query".to_string(),
            StepOutput {
                output: json!({"items": ["alpha", "beta", "gamma"]}),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 5,
            },
        );

        let params = json!({
            "limited_items": {
                "$kind": "binding",
                "select": {"from": "steps", "key": "query", "path": "output.items"},
                "transform": [{"op": "op:core.take", "args": {"count": 2}}]
            }
        });

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["limited_items"], json!(["alpha", "beta"]));
    }

    // ========================================================================
    // Test 37: Mustache {{...}} strings are NOT resolved (L030 — deleted)
    // ========================================================================

    #[test]
    fn test_escape_applescript_plain_string_unchanged() {
        let ctx = test_context();
        let params = json!({"val": "{{input.target_id}}"});

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        // Mustache is deleted — string passes through as literal
        assert_eq!(resolved["val"], "{{input.target_id}}");
    }

    // ========================================================================
    // Test 38: Mustache mixed string stays literal
    // ========================================================================

    #[test]
    fn test_escape_applescript_in_mixed_template() {
        let ctx = test_context();
        let params = json!({"msg": "Entity {{input.target_id}} created"});

        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["msg"], "Entity {{input.target_id}} created");
    }
}
