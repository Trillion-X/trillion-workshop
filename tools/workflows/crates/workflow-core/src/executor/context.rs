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
//   4. This module owns WHERE a binding's values come from (the run's scopes: input,
//      steps, context, start, loop, change, ambient) and nothing about WHAT an operator
//      means: every `transform` step is evaluated by the one shared evaluator
//      (tools/shared-code/crates/composition-ast, `create_core_registry`) that the
//      formula and trigger engines use, so an operator name means the same in every
//      engine and no operator name appears in this crate. A `"expr"` formula string is
//      refused with the binding to write instead. Binding
//      results are re-resolved recursively (depth-limited to 32) so
//      a value a binding only selects is data, passed on as selected; a binding with a transform has its result
//      resolved again (its arguments are written in the definition). `resolve_nested_bindings` overrides either.
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

    /// The scope and path a binding's `select` reads (`loop.last_output.held`) when what it selects is absent or null,
    /// before any transform: a condition that reads nothing names it rather than coming to false. None for a value
    /// that is no select binding, or one whose selection holds something.
    pub fn unresolved_select(value: &Value, ctx: &ExecutionContext) -> Result<Option<String>, WorkflowError> {
        let Some(select) = value.as_object()
            .filter(|map| map.get("$kind").and_then(Value::as_str) == Some("binding"))
            .and_then(|map| map.get("select")).and_then(Value::as_object) else { return Ok(None) };
        let from = select.get("from").and_then(Value::as_str).unwrap_or_default();
        let key = select.get("key").and_then(Value::as_str).unwrap_or_default();
        let path = select.get("path").and_then(Value::as_str).unwrap_or_default();
        // A literal holds what is written in it; only what it comes to after its transforms can be empty.
        if from == "literal" { return Ok(None); }
        let selected = Self::resolve_select_binding(ctx, from, key, path)?;
        let named = [from, key, path].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(".");
        Ok(selected.is_null().then_some(named))
    }

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
            // A value a binding only selects is data: it is passed on as it is, never read again as a template, so a
            // value that holds binding-shaped objects (a drafted workflow, a fact told from outside) keeps them. A
            // binding with a transform is resolved again, because its arguments are written in the definition and
            // may be placed into the result unresolved (op:core.set, op:core.merge). Either way an explicit
            // `resolve_nested_bindings` decides.
            None => Ok(map.contains_key("transform")),
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
            // On a select binding the flag says its path may find nothing, read as null (absence_expected); the member
            // stays, as a select binding has always kept it.
            Some(Value::Bool(true)) if map.contains_key("select") && !map.contains_key("values") => Ok(false),
            Some(Value::Bool(true)) => {
                let path = map.get("values").and_then(Value::as_array)
                    .filter(|_| !map.contains_key("expr") && !map.contains_key("select"))
                    .ok_or_else(|| WorkflowError::TemplateResolutionFailed {
                        reason: "omit_if_missing requires a values path binding".to_string(),
                        hint: "Use a binding with values and omit_if_missing: true for an optional object member.".to_string(),
                    })?;
                Ok(values_in_run(ctx, None, path).is_empty())
            }
            Some(_) => Err(WorkflowError::TemplateResolutionFailed {
                reason: "binding field omit_if_missing must be a boolean".to_string(),
                hint: "Use true to omit an object member only when its values path is absent.".to_string(),
            }),
        }
    }

    /// Resolve a `$kind: binding` AST node against the ExecutionContext.
    ///
    /// Selection is resolved here by direct scope/path traversal; each transform
    /// step goes to the shared evaluator (`evaluate_transform_chain`).
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
        // A formula string is not a binding: every engine's bindings are select + transform, read by the one
        // shared evaluator.
        if map.contains_key("expr") {
            return Err(WorkflowError::TemplateResolutionFailed {
                reason: "A binding with \"expr\" is no longer read".to_string(),
                hint: "Write it as a binding: {\"$kind\": \"binding\", \"select\": {\"from\": \"steps\", \"key\": \"s1\", \"path\": \"count\"}, \"transform\": [{\"op\": \"op:core.mul\", \"args\": {\"value\": ...}}]}".to_string(),
            });
        }

        // --- Every value at a path, "*" stepping into lists (`values_in_run` below) ---
        // {"$kind": "binding", "values": ["steps", "draft", "sources", "*", "url"], "take": "all"}
        // `values` is one path, or a list of paths whose values are read together. "take": "all" gives the list;
        // anything else the first value (null when the path reaches nothing). A `transform` then runs on it, as on
        // any selected value.
        if let Some(paths) = map.get("values").and_then(|v| v.as_array()) {
            let found: Vec<Value> = if paths.first().is_some_and(Value::is_array) {
                paths.iter().filter_map(Value::as_array).flat_map(|path| values_in_run(ctx, None, path)).collect()
            } else {
                values_in_run(ctx, None, paths)
            };
            let selected = match map.get("take").and_then(|v| v.as_str()) {
                Some("all") => Value::Array(found),
                _ => found.into_iter().next().unwrap_or(Value::Null),
            };
            return match map.get("transform").and_then(|v| v.as_array()) {
                Some(transforms) => Self::evaluate_transform_chain(selected, transforms, ctx),
                None => Ok(selected),
            };
        }

        // --- Select-based path resolution (existing path) ---
        let select = map.get("select").ok_or_else(|| WorkflowError::TemplateResolutionFailed {
            reason: "Binding AST node has $kind: \"binding\" but no \"select\" or \"expr\" field".to_string(),
            hint: "Binding AST requires either:\n  {\"$kind\": \"binding\", \"select\": {\"from\": \"...\", \"path\": \"...\"}}\n  {\"$kind\": \"binding\", \"values\": [\"steps\", \"s1\", \"items\", \"*\"], \"take\": \"all\"}".to_string(),
        })?;

        let from = select.get("from").and_then(|v| v.as_str()).unwrap_or("");
        let key = select.get("key").and_then(|v| v.as_str()).unwrap_or("");
        let path = select.get("path").and_then(|v| v.as_str()).unwrap_or("");

        // A value written into the binding itself is the shared evaluator's, like every operator: the run only
        // fills in what its own scopes hold inside it.
        if from == "literal" {
            let value = Self::resolve_run_scoped(select.get("value").unwrap_or(&Value::Null), ctx)?;
            return match map.get("transform").and_then(|v| v.as_array()) {
                Some(transforms) => Self::evaluate_transform_chain(value, transforms, ctx),
                None => Ok(value),
            };
        }

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
                    hint: format!("Valid binding scopes are: {}. 'state' requires pre-resolution by the host.", BINDING_SCOPES.join(", ")),
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

        // A path that finds nothing inside a completed step's answer, or inside a loop's item, is a typed error naming
        // it (WorkflowError::BindingMissing), never a null the next step reads as nothing: unless the binding says that
        // absence is expected (`omit_if_missing: true`, or a first transform that handles absence). A step's raw-bytes
        // side channel (output.bytes, base64, text) is answered above and is never such a path.
        if !Self::absence_expected(map)? {
            if let Some(missing) = Self::missing_inside(ctx, from, key, path) {
                return Err(missing);
            }
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
                hint: format!("Valid binding scopes are: {}. 'state' requires pre-resolution by the host.", BINDING_SCOPES.join(", ")),
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

    /// Whether a select binding expects its path may find nothing: it declares `omit_if_missing: true`, or its first
    /// transform is one that reads absence (`op:core.if_null`, `op:core.coalesce`, `op:core.is_null`,
    /// `op:core.is_not_null`). Any other `omit_if_missing` value is refused, as for a `values` binding.
    fn absence_expected(map: &serde_json::Map<String, Value>) -> Result<bool, WorkflowError> {
        match map.get("omit_if_missing") {
            None | Some(Value::Bool(false)) => {}
            Some(Value::Bool(true)) => return Ok(true),
            Some(_) => {
                return Err(WorkflowError::TemplateResolutionFailed {
                    reason: "binding field omit_if_missing must be a boolean".to_string(),
                    hint: "Use true when the path may find nothing and the step reads that as null.".to_string(),
                })
            }
        }
        Ok(map
            .get("transform")
            .and_then(Value::as_array)
            .and_then(|transforms| transforms.first())
            .and_then(|first| first.get("op"))
            .and_then(Value::as_str)
            .is_some_and(|op| READS_ABSENCE.contains(&op)))
    }

    /// `step` (one transform) with every select binding in its `args` marked `omit_if_missing: true`, when its operator
    /// reads absence: a coalesce's candidates are each allowed to find nothing (that is what it chooses among), so a
    /// path one of them misses reads as null there instead of failing the binding. Any other step is returned as is.
    fn args_expecting_absence(step: &Value) -> std::borrow::Cow<'_, Value> {
        fn mark(value: &mut Value) {
            match value {
                Value::Object(map) => {
                    if map.get("$kind").and_then(Value::as_str) == Some("binding") && map.contains_key("select") {
                        map.entry("omit_if_missing").or_insert(Value::Bool(true));
                    }
                    map.values_mut().for_each(mark);
                }
                Value::Array(items) => items.iter_mut().for_each(mark),
                _ => {}
            }
        }
        let reads_absence = step.get("op").and_then(Value::as_str).is_some_and(|op| READS_ABSENCE.contains(&op));
        match step.get("args") {
            Some(_) if reads_absence => {
                let mut marked = step.clone();
                if let Some(args) = marked.get_mut("args") { mark(args); }
                std::borrow::Cow::Owned(marked)
            }
            _ => std::borrow::Cow::Borrowed(step),
        }
    }

    /// The BindingMissing error for a `steps` path into a completed step's answer (`output...`) or a `loop` path into
    /// the item or the last output, when that path finds nothing; None when it finds a value (null included), when the
    /// step has not answered yet (a legitimate absence while the run goes on), or for any other scope.
    fn missing_inside(ctx: &ExecutionContext, from: &str, key: &str, path: &str) -> Option<WorkflowError> {
        let segments: Vec<&str> = if path.is_empty() { Vec::new() } else { path.split('.').collect() };
        let (root, rest, binding) = match from {
            "steps" => {
                let (step_key, step_segments) = if key.is_empty() && !segments.is_empty() { (segments[0], &segments[1..]) } else { (key, segments.as_slice()) };
                let step = ctx.step_output(step_key)?;
                if step.status != crate::domain::types::ExecutionStatus::Completed || step_segments.first() != Some(&"output") {
                    return None;
                }
                (&step.output, &step_segments[1..], format!("steps.{step_key}"))
            }
            "loop" => {
                let loop_state = ctx.loop_state.as_ref()?;
                match segments.first() {
                    Some(&"last_output") => (&loop_state.last_output, &segments[1..], "loop.last_output".to_string()),
                    Some(item) if *item == loop_state.item_var => (&loop_state.item, &segments[1..], format!("loop.{item}")),
                    _ => return None,
                }
            }
            _ => return None,
        };
        let found = Self::path_holds(ctx, root, rest);
        (!found).then(|| WorkflowError::BindingMissing {
            reason: format!("{binding} found nothing at {path}"),
            hint: "The value this binding reads does not hold that path: read the field the answer has, or declare omit_if_missing: true when its absence is expected.".to_string(),
            binding,
            path: path.to_string(),
        })
    }

    /// Whether `segments` reach a value in `root`, as `select_json_path` walks it (a JSON null reached is a value).
    fn path_holds(ctx: &ExecutionContext, root: &Value, segments: &[&str]) -> bool {
        let mut current = root;
        for (index, segment) in segments.iter().enumerate() {
            match current {
                Value::Object(map) => {
                    if let Some(next) = map.get(*segment) {
                        current = next;
                    } else if let Some(next) = Self::select_bytes_ref_field(ctx, map, segment) {
                        return Self::path_holds(ctx, &next, &segments[index + 1..]);
                    } else {
                        return false;
                    }
                }
                Value::Array(items) => match segment.parse::<usize>().ok().and_then(|index| items.get(index)) {
                    Some(next) => current = next,
                    None => return false,
                },
                _ => return false,
            }
        }
        true
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
            "last_output" => Ok(Self::select_json_path(ctx, &loop_state.last_output, &segments[1..])),
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
                &format!("index, total, first, last, last_output, {}", loop_state.item_var),
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
    /// Every operator a transform names: the one shared registry the formula and trigger engines also use, so a
    /// name means the same thing in every engine.
    fn operators() -> &'static composition_ast::binding::operators::registry::OperatorResolver {
        static OPERATORS: std::sync::OnceLock<composition_ast::binding::operators::registry::OperatorResolver> =
            std::sync::OnceLock::new();
        OPERATORS.get_or_init(|| {
            let registry = std::sync::Arc::new(
                composition_ast::binding::operators::create_core_registry().expect("the shared operator registry"),
            );
            std::sync::Arc::new(move |key: &str| registry.get(key))
        })
    }

    /// The run's own scopes. A binding selecting from one of them is resolved here; any other binding (`vars`,
    /// `self`, `literal`) belongs to the shared evaluator, which binds `$item` and the pipeline value itself.
    fn selects_run_scope(map: &serde_json::Map<String, Value>) -> bool {
        if map.contains_key("values") || map.contains_key("expr") {
            return true;
        }
        matches!(
            map.get("select").and_then(|select| select.get("from")).and_then(Value::as_str),
            Some("input" | "ambient" | "change" | "context" | "start" | "loop" | "steps")
        )
    }

    /// A transform's arguments with every run-scoped binding in them replaced by its value, at any depth, so the
    /// shared evaluator only ever sees values and its own bindings.
    fn resolve_run_scoped(value: &Value, ctx: &ExecutionContext) -> Result<Value, WorkflowError> {
        match value {
            Value::Object(map) if map.get("$kind").and_then(Value::as_str) == Some("binding") && Self::selects_run_scope(map) => {
                Self::resolve_value(value, ctx)
            }
            Value::Object(map) => {
                let mut resolved = serde_json::Map::with_capacity(map.len());
                for (key, item) in map {
                    resolved.insert(key.clone(), Self::resolve_run_scoped(item, ctx)?);
                }
                Ok(Value::Object(resolved))
            }
            Value::Array(items) => items.iter().map(|item| Self::resolve_run_scoped(item, ctx)).collect::<Result<Vec<_>, _>>().map(Value::Array),
            other => Ok(other.clone()),
        }
    }

    /// Runs a binding's `transform` steps in order over the selected value. Each step is evaluated by the shared
    /// evaluator; the run only supplies the values its scopes hold, and charges each step's result to the run's
    /// output budget.
    fn evaluate_transform_chain(
        mut resolved: Value,
        transforms: &[Value],
        ctx: &ExecutionContext,
    ) -> Result<Value, WorkflowError> {
        use composition_ast::binding::ast::{Binding, BindingEvaluationContext, DiagnosticLevel};
        use composition_ast::binding::evaluator::evaluate_binding_with_resolver;

        for step in transforms {
            let op = step.get("op").and_then(Value::as_str).unwrap_or("");
            if Self::operators()(op).is_none() {
                return Err(WorkflowError::UnknownTransform {
                    op: op.to_string(),
                    hint: "A transform names an operator of the shared registry (tools/shared-code/crates/composition-ast, operators/core); a new operator is registered there once and every engine has it.".to_string(),
                });
            }
            // The value is read whole by the evaluator, so its depth is bounded first (recursion is Physics); its
            // size is charged on what the step makes, so taking one leaf out of a large value is never refused.
            let depth_only = ops_core::JsonConversionBudget {
                max_depth: ctx.json_conversion_policy.max_depth,
                max_nodes: usize::MAX,
                max_string_bytes: usize::MAX,
                max_total_bytes: usize::MAX,
            };
            drop(ops_core::try_from_json_with_budget(&resolved, &depth_only).map_err(Self::json_conversion_error)?);
            let step = Self::resolve_run_scoped(&Self::args_expecting_absence(step), ctx)?;
            drop(Self::op_value(&step, ctx)?);
            let binding: Binding = serde_json::from_value(serde_json::json!({ "$kind": "binding", "transform": [step] }))
                .map_err(|error| WorkflowError::TemplateResolutionFailed {
                    reason: format!("{op} could not be read: {error}"),
                    hint: "A transform step is {\"op\": <name>, \"args\": {...}}.".to_string(),
                })?;
            let result = evaluate_binding_with_resolver(
                &binding,
                &resolved,
                &BindingEvaluationContext::default(),
                Self::operators(),
                None,
            );
            if let Some(problem) = result.diagnostics.iter().find(|diagnostic| matches!(diagnostic.level, DiagnosticLevel::Error)) {
                return Err(WorkflowError::TemplateResolutionFailed {
                    reason: format!("{op} failed: {}", problem.message),
                    hint: "The value or the arguments are not what this operator takes.".to_string(),
                });
            }
            let mut charge = JsonOutputCharge::default();
            Self::charge_json_value(&result.value, ctx, &mut charge, 1)?;
            resolved = result.value;
        }
        Ok(resolved)
    }
}

/// Every value `keys` reaches from `root`: "*" steps into every item of a list, and a list reached at the end gives
/// its items.
pub fn values_at(root: &Value, keys: &[Value]) -> Vec<Value> {
    let mut at: Vec<&Value> = vec![root];
    for key in keys {
        let key = key.as_str().unwrap_or_default();
        at = if key == "*" {
            at.into_iter().flat_map(|item| item.as_array().into_iter().flatten()).collect()
        } else {
            at.into_iter()
                .filter_map(|item| match item {
                    Value::Object(map) => map.get(key),
                    Value::Array(items) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
                    _ => None,
                })
                .collect()
        };
    }
    at.into_iter()
        .flat_map(|item| match item {
            Value::Array(items) => items.to_vec(),
            other => vec![other.clone()],
        })
        .collect()
}

/// Every value `path` reaches in a run: "this" starts at `this` (a checked step's output), "input" at the run's input,
/// and "steps" at the output of the step named next. Bindings of the form `{"$kind": "binding", "values": <path>}`
/// read through this.
pub fn values_in_run(ctx: &ExecutionContext, this: Option<&Value>, path: &[Value]) -> Vec<Value> {
    match path.first().and_then(Value::as_str) {
        Some("this") => this.map(|root| values_at(root, &path[1..])).unwrap_or_default(),
        Some("input") => values_at(&ctx.start.input, &path[1..]),
        Some("steps") => match path.get(1).and_then(Value::as_str).and_then(|id| ctx.step_output(id)) {
            Some(step) => values_at(&step.output, &path[2..]),
            None => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// Metadata for a single binding — transform chains applied after resolution.
#[derive(Debug, Clone)]
pub struct BindingMeta {
    /// Transform chain to apply after selection.
    /// Empty if no transforms on this binding.
    pub transforms: Vec<Value>,
}

// Two-phase Envelope batch path DELETED (L030). Operators are a pure library
// call into the shared evaluator; no async Envelope dispatch is needed.

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

/// The transform operators that read absence: a binding whose first transform is one of them, and every select binding
/// in such a transform's args, reads a path that finds nothing as null rather than failing as BindingMissing.
const READS_ABSENCE: [&str; 4] = ["op:core.if_null", "op:core.coalesce", "op:core.is_null", "op:core.is_not_null"];

/// The roots a `select` binding may read, each answered by `BindingResolver::resolve_binding_ast` (`state` is answered
/// as the error that the host pre-resolves it). `compile_steps_and_edges` refuses a definition naming any other root.
pub const BINDING_SCOPES: [&str; 9] = ["input", "ambient", "change", "context", "start", "loop", "steps", "literal", "state"];

/// The first `select` binding in `value` whose `from` is not one of `BINDING_SCOPES` (a missing `from` included): its
/// JSON pointer under `at` and the root it names.
fn unknown_scope_in(value: &Value, at: String) -> Option<(String, String)> {
    match value {
        Value::Object(map) => {
            if map.get("$kind").and_then(Value::as_str) == Some("binding") {
                if let Some(select) = map.get("select").and_then(Value::as_object) {
                    let from = select.get("from").and_then(Value::as_str).unwrap_or("");
                    if !BINDING_SCOPES.contains(&from) {
                        return Some((at, from.to_owned()));
                    }
                }
            }
            map.iter().find_map(|(name, inner)| unknown_scope_in(inner, format!("{at}/{}", name.replace('~', "~0").replace('/', "~1"))))
        }
        Value::Array(items) => items.iter().enumerate().find_map(|(index, inner)| unknown_scope_in(inner, format!("{at}/{index}"))),
        _ => None,
    }
}

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

    // A binding that reads a root no binding has is refused here, before any step runs, never at its step: Nov 25 2026,
    // workflow:keep-the-use-case-catalog-current's read moved its sweep mark and its apply then failed on scope 'read',
    // so every change it had read was dropped. The roots are BINDING_SCOPES, the same ones the resolver answers.
    for (index, step) in steps.iter().enumerate() {
        if let Some((pointer, from)) = unknown_scope_in(&step.config, String::from("/config")) {
            return Err(WorkflowError::InvalidWorkflow {
                reason: format!("binding-scope-unknown: step '{}' reads the scope '{from}' at {pointer}", canonical_step_id(step, index)),
                hint: format!("A binding's select.from is one of: {}. A step's answer is read as {{\"from\": \"steps\", \"key\": \"<step id>\", \"path\": \"output.<field>\"}}.", BINDING_SCOPES.join(", ")),
            });
        }
    }

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
        // Add all explicit edges — store condition as raw Value (EdgeHandler parses at eval time).
        // The graph keeps one edge per (from, to) pair, so a second edge between the same two steps replaced the first
        // one's kind and condition without a word: on Nov 21 2026 a definition with `parse -> judge` once `always` and
        // once `on_failure` kept only `on_failure`, so a parse that succeeded skipped the judge, and the run ended
        // completed with nothing judged. Each pair is one edge; what should open the step is said in its one condition.
        let mut pairs = std::collections::HashSet::with_capacity(edges.len());
        for edge in edges {
            for end in [&edge.from, &edge.to] {
                if !step_map.contains_key(end) {
                    return Err(WorkflowError::InvalidWorkflow {
                        reason: format!("Edge {} -> {} names step '{}', which the definition does not have", edge.from, edge.to, end),
                        hint: "An edge joins two steps of the same definition, named by their ids.".to_string(),
                    });
                }
            }
            if !pairs.insert((edge.from.as_str(), edge.to.as_str())) {
                return Err(WorkflowError::InvalidWorkflow {
                    reason: format!("Two edges join step '{}' to step '{}'", edge.from, edge.to),
                    hint: "Keep one edge per pair of steps and say in its one kind and condition everything that should open the next step."
                        .to_string(),
                });
            }
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

    #[test]
    fn a_loop_reads_what_its_body_last_returned_and_names_an_empty_read() {
        let ctx = test_context_with_loop();
        let held = json!({"$kind": "binding", "select": {"from": "loop", "path": "last_output.held"}});
        assert_eq!(BindingResolver::resolve_value(&held, &ctx).unwrap(), json!(false));
        assert_eq!(BindingResolver::unresolved_select(&held, &ctx).unwrap(), None);
        let missing = json!({"$kind": "binding", "select": {"from": "loop", "path": "last_output.nothing"},
            "transform": [{"op": "op:core.not"}]});
        assert_eq!(BindingResolver::unresolved_select(&missing, &ctx).unwrap().as_deref(), Some("loop.last_output.nothing"));
        assert_eq!(BindingResolver::unresolved_select(&json!(true), &ctx).unwrap(), None, "a literal is no select");
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
            last_output: json!({"held": false}),
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
    fn test_a_selected_value_is_data_and_is_resolved_again_only_when_asked() {
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

        // A drafted workflow or a fact from outside holds binding-shaped objects: selected, they are kept as written.
        let resolved = BindingResolver::resolve_value(&params, &ctx).unwrap();
        assert_eq!(resolved["payload"]["value"], json!({"$kind": "binding", "select": {"from": "input", "path": "target_id"}}));
        // A binding that asks for its result to be resolved again gets the old flattening.
        let mut asked = params.clone();
        asked["payload"]["resolve_nested_bindings"] = json!(true);
        let flattened = BindingResolver::resolve_value(&asked, &ctx).unwrap();
        assert_eq!(flattened["payload"]["value"], "node-123");
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
                        "value": {"$kind": "binding", "select": {"from": "steps", "key": "step1", "path": "output.created_id"}}
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
        // The source (input.nested.deep) keeps what it holds; the absent binding is set as an explicit null.
        assert_eq!(resolved["projected"], json!({"value": 42, "optional_value": null}));
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
                if reason.contains("op:core.set failed") && !hint.is_empty()
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
                            "added": {"$kind": "binding", "select": {"from": "steps", "key": "step1", "path": "output.count"}}
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
                if reason.contains("op:core.merge failed") && !hint.is_empty()
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

    // ========================================================================
    // binding-missing: a path that finds nothing inside a value that is there (Nov 25 2026 router case)
    // ========================================================================

    fn missing_of(result: Result<Value, WorkflowError>) -> (String, String) {
        match result {
            Err(WorkflowError::BindingMissing { binding, path, .. }) => (binding, path),
            other => panic!("a binding-missing error, not {other:?}"),
        }
    }

    #[test]
    fn a_step_answer_path_that_finds_nothing_fails_naming_the_binding_and_path() {
        let mut ctx = test_context();
        ctx.steps.insert("choose".to_string(), StepOutput {
            output: json!({"result": {"chosen": [{"workflow": "workflow:x"}]}}), status: ExecutionStatus::Completed, error: None, duration_ms: 1 });
        let params = json!({"each": {"$kind": "binding", "select": {"from": "steps", "key": "choose", "path": "output.chosen"},
            "transform": [{"op": "op:core.filter_where", "args": {"predicate": [{"op": "op:core.get_path", "args": {"path": "installed"}}]}}]}});
        assert_eq!(missing_of(BindingResolver::resolve_value(&params, &ctx)), ("steps.choose".to_string(), "output.chosen".to_string()));
        let err = BindingResolver::resolve_value(&params, &ctx).unwrap_err();
        assert_eq!(err.code(), "BINDING_MISSING");
        assert!(err.to_string().starts_with("binding-missing: steps.choose found nothing at output.chosen"), "{err}");
    }

    #[test]
    fn a_held_null_a_step_not_answered_yet_and_an_expected_absence_read_as_null() {
        let mut ctx = test_context();
        ctx.steps.insert("read".to_string(), StepOutput { output: json!({"rows": [], "label": null}), status: ExecutionStatus::Completed, error: None, duration_ms: 1 });
        let held_null = json!({"$kind": "binding", "select": {"from": "steps", "key": "read", "path": "output.label"}});
        assert_eq!(BindingResolver::resolve_value(&held_null, &ctx).unwrap(), Value::Null, "a null that is there is a value");
        let not_yet = json!({"$kind": "binding", "select": {"from": "steps", "key": "later", "path": "output.anything"}});
        assert_eq!(BindingResolver::resolve_value(&not_yet, &ctx).unwrap(), Value::Null, "a step with no answer yet");
        let omitted = json!({"$kind": "binding", "select": {"from": "steps", "key": "read", "path": "output.rows.0.label"}, "omit_if_missing": true});
        assert_eq!(BindingResolver::resolve_value(&omitted, &ctx).unwrap(), Value::Null, "omit_if_missing on a select binding");
        let fallback = json!({"$kind": "binding", "select": {"from": "steps", "key": "read", "path": "output.rows.0.label"},
            "transform": [{"op": "op:core.if_null", "args": {"fallback": "none"}}]});
        assert_eq!(BindingResolver::resolve_value(&fallback, &ctx).unwrap(), json!("none"), "a first transform that reads absence");
        let refused = json!({"$kind": "binding", "select": {"from": "steps", "key": "read", "path": "output.rows.0.label"}, "omit_if_missing": "yes"});
        assert!(BindingResolver::resolve_value(&refused, &ctx).is_err(), "omit_if_missing must be a boolean");
        let after_step = json!({"$kind": "binding", "select": {"from": "steps", "key": "read", "path": "output.rows.0.label"}, "transform": [{"op": "op:core.not"}]});
        assert_eq!(missing_of(BindingResolver::resolve_value(&after_step, &ctx)).1, "output.rows.0.label", "a later transform does not excuse it");
    }

    #[test]
    fn a_loop_item_or_last_output_path_that_finds_nothing_fails() {
        let ctx = test_context_with_loop();
        let item = json!({"$kind": "binding", "select": {"from": "loop", "path": "item.owner"}});
        assert_eq!(missing_of(BindingResolver::resolve_value(&item, &ctx)), ("loop.item".to_string(), "item.owner".to_string()));
        let last = json!({"$kind": "binding", "select": {"from": "loop", "path": "last_output.nothing"}});
        assert_eq!(missing_of(BindingResolver::resolve_value(&last, &ctx)).0, "loop.last_output");
        let present = json!({"$kind": "binding", "select": {"from": "loop", "path": "item.name"}});
        assert_eq!(BindingResolver::resolve_value(&present, &ctx).unwrap(), json!("Task A"));
        let index = json!({"$kind": "binding", "select": {"from": "loop", "path": "index"}});
        assert_eq!(BindingResolver::resolve_value(&index, &ctx).unwrap(), json!(2), "the loop's own members are not item paths");
    }

    #[test]
    fn the_other_roots_keep_their_reading_of_absence() {
        // input, ambient, change, start and context read a path that finds nothing as null, as before: a run's input and
        // a fact's fields are open sets (a row change never carries kinds), so their absence is the input's own answer.
        let ctx = test_context();
        for (from, path) in [("input", "nothing.here"), ("ambient", "nothing"), ("change", "properties.nothing"), ("start", "input.nothing")] {
            let binding = json!({"$kind": "binding", "select": {"from": from, "path": path}});
            assert_eq!(BindingResolver::resolve_value(&binding, &ctx).unwrap(), Value::Null, "{from}.{path}");
        }
        let unknown_member = json!({"$kind": "binding", "select": {"from": "context", "path": "nothing"}});
        assert!(BindingResolver::resolve_value(&unknown_member, &ctx).is_err(), "context's members are a fixed set, refused as before");
    }

    #[test]
    fn a_coalesce_reads_each_candidate_that_finds_nothing_as_null() {
        // The Nov 25 2026 bridge rows read a step's answer under either shape; each candidate may miss.
        let source = json!({"$kind": "binding", "resolve_nested_bindings": true, "select": {"from": "steps", "key": "find", "path": "output.result.messages"},
            "transform": [{"op": "op:core.coalesce", "args": {"values": [
                {"$kind": "binding", "select": {"from": "steps", "key": "find", "path": "output.result.messages"}},
                {"$kind": "binding", "select": {"from": "steps", "key": "find", "path": "output.messages"}}]}}]});
        for (output, want) in [(json!({"messages": [1]}), json!([1])), (json!({"result": {"messages": [2]}}), json!([2]))] {
            let mut ctx = test_context();
            ctx.steps.insert("find".to_string(), StepOutput { output, status: ExecutionStatus::Completed, error: None, duration_ms: 1 });
            assert_eq!(BindingResolver::resolve_value(&source, &ctx).unwrap(), want);
        }
        // Outside such an operator a candidate's miss still fails by name.
        let mut ctx = test_context();
        ctx.steps.insert("find".to_string(), StepOutput { output: json!({"messages": [1]}), status: ExecutionStatus::Completed, error: None, duration_ms: 1 });
        let strict = json!({"$kind": "binding", "select": {"from": "steps", "key": "find", "path": "output.messages"},
            "transform": [{"op": "op:core.concat", "args": {"values": [{"$kind": "binding", "select": {"from": "steps", "key": "find", "path": "output.result.messages"}}]}}]});
        assert_eq!(missing_of(BindingResolver::resolve_value(&strict, &ctx)), ("steps.find".to_string(), "output.result.messages".to_string()));
    }

    #[test]
    fn omit_if_missing_on_a_select_binding_inside_an_object_reads_null() {
        let mut ctx = test_context();
        ctx.steps.insert("read".to_string(), StepOutput { output: json!({"rows": []}), status: ExecutionStatus::Completed, error: None, duration_ms: 1 });
        let object = json!({"label": {"$kind": "binding", "select": {"from": "steps", "key": "read", "path": "output.rows.0.label"}, "omit_if_missing": true}});
        assert_eq!(BindingResolver::resolve_value(&object, &ctx).unwrap(), json!({"label": null}));
    }

    #[test]
    fn a_literal_root_with_a_concat_builds_the_text_from_its_args() {
        // The shape tell-the-owner-what-changed-for-each-person uses since Nov 25 2026, instead of selecting input.start_at
        // (the engine's start marker, absent from most runs) only to throw it away.
        let mut ctx = test_context();
        ctx.steps.insert("read".to_string(), StepOutput { output: json!({"id": 44}), status: ExecutionStatus::Completed, error: None, duration_ms: 1 });
        let built = json!({"$kind": "binding", "resolve_nested_bindings": true, "select": {"from": "literal", "value": null},
            "transform": [{"op": "op:core.concat", "args": {"values": ["told:", {"$kind": "binding", "select": {"from": "steps", "key": "read", "path": "output.id"}, "transform": [{"op": "op:core.to_string"}]}]}}]});
        assert_eq!(BindingResolver::resolve_value(&built, &ctx).unwrap(), json!("told:44"));
    }

    fn step_reading(select: Value) -> crate::domain::types::Step {
        serde_json::from_value(json!({"id": "apply", "kind": "ask", "config": {"name": "tool:x", "input": {"params": [1, {"$kind": "binding", "select": select}]}}})).unwrap()
    }

    #[test]
    fn a_definition_whose_binding_reads_an_unknown_scope_is_refused_before_any_step_runs() {
        for select in [json!({"from": "read", "path": "delta"}), json!({"from": "step", "step": "read", "path": "output.rows"}), json!({"path": "output"})] {
            let error = compile_steps_and_edges(&[step_reading(select.clone())], &[]).err().unwrap_or_else(|| panic!("{select} compiled"));
            let said = error.to_string();
            let from = select.get("from").and_then(Value::as_str).unwrap_or("");
            assert!(said.contains(&format!("binding-scope-unknown: step 'apply' reads the scope '{from}' at /config/input/params/1")), "{said}");
        }
        assert!(compile_steps_and_edges(&[step_reading(json!({"from": "steps", "key": "read", "path": "output.rows.0.delta"}))], &[]).is_ok());
    }

    #[test]
    fn every_scope_compile_admits_is_one_the_resolver_answers() {
        // BINDING_SCOPES is the one list: each root in it resolves (or, for state, says the host pre-resolves it), so the
        // compile check and the resolver cannot drift apart.
        let ctx = test_context();
        for from in BINDING_SCOPES {
            assert!(compile_steps_and_edges(&[step_reading(json!({"from": from, "path": "x"}))], &[]).is_ok(), "{from}");
            let binding = json!({"$kind": "binding", "select": {"from": from, "path": "x", "value": 1}});
            if let Err(error) = BindingResolver::resolve_value(&binding, &ctx) {
                assert!(!error.to_string().contains("Unknown binding scope"), "{from}: {error}");
            }
        }
    }
}
