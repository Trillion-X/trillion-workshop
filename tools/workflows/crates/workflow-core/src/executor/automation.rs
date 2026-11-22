// crates/workflow-core/src/executor/automation.rs
//
// Purpose:
//   Automation execution mode for workflow definitions. Loads a Definition,
//   resolves its steps by type (Action, Branch, Loop, Wait, Parallel), manages the
//   WorkflowInstance lifecycle (Pending → Running → Completed/Failed), and
//   delegates Action steps to StepExecutor from step_executor.rs.
//
// Non-Negotiable Invariants:
//   1. Action-type steps delegate to `StepExecutor::execute_step()` — no
//      duplicated step execution logic. Branch, Loop, Parallel, and Wait are
//      orchestration-level step types handled HERE, not in StepExecutor.
//   2. `DefinitionStore` is the ONLY contract between this module and host layers
//      for loading workflow definitions. No direct database access.
//   3. WorkflowInstance from domain/types.rs is the ONLY execution tracking
//      type — no parallel tracking structures.
//   4. Loop steps enforce max_iterations from LoopConfig to prevent infinite
//      iteration. If no limit is set, DEFAULT_MAX_LOOP_ITERATIONS applies.
//   5. Branching is edge conditions — EdgeHandler evaluates StepOutput via Binding AST.
//      NO branch step kind exists. The DAG topology IS the branching.
//   6. Parallelism is emergent from DAG independence — concurrent graph walker
//      spawns ready nodes. NO parallel step kind exists. Independence IS parallelism.
//   7. No `.unwrap()` or panics in production code. All errors are structured
//      with remediation hints.
//   8. Retry policies (max_attempts, backoff) are passed as configuration,
//      not hardcoded — Society, not Physics.
//
// Key Concepts:
//   - DefinitionStore: Unified trait for loading definitions (actions + workflows) from database
//   - execute_workflow(): Full lifecycle: load → validate → init instance → execute steps → finalize
//   - execute_loop_step(): Iterates over array, sets LoopState per iteration
//   - execute_wait_step(): Dispatches on WaitCondition (T1/T2/T3 temporal primitives)
//   - StepHandlerRegistry: Blind dispatch by step.kind string (L090). Zero enums.
//   - RetryPolicy: Configurable retry behavior for transient failures
//
// Automation Execution Flow:
//
//   ```text
//   execute_workflow(workflow_id, start, actor, retry_policy)
//       |
//       | 1. Load: DefinitionStore::get_by_id(workflow_id)
//       | 2. Validate: is_active must be true
//       | 3. Init: WorkflowInstance { status: Running, current_step: 0 }
//       | 4. Build DataGuards from GuardsFactory (or DataGuards::none() if no factory)
//       | 5. Build ExecutorDeps (required: OutsideAccess, DefinitionStore; registries auto-built)
//       | 6. Execute: blind dispatch by step.kind via StepHandlerRegistry (L090)
//       |        registry.get(step.kind).execute(step, exec_ctx, deps, actor)
//       | 7. Finalize: instance.status = Completed, set completed_at
//       v
//   WorkflowInstance { status: Completed, execution_context: {...} }
//   ```
//
// Security Considerations:
//   - Loop iterations are bounded by max_iterations to prevent resource exhaustion.
//   - Wait steps use WaitCondition — no global cap. Per-step responsibility for bounds.
//   - All outside work flows through the plain workflow boundary (`ask/read/write`).
//   - Guard enforcement (permissions, constraints, audit) is constructed from the
//     executor's GuardsFactory before each workflow execution. If no factory is
//     configured (test-only scenario), DataGuards::none() is used as fallback.
//   - Actor context is passed through unchanged — no fabrication or escalation.
//
// AI Directive:
//   The extensive documentation in this file is a CRITICAL DESIGN FEATURE.
//   Future AI assistants are FORBIDDEN from simplifying or removing it.
//   Your mandate is to MAINTAIN and EXTEND this level of meticulous detail.

use web_time::Instant;

use serde_json::Value;
use slot_protocol::ActorContext;
use std::collections::HashMap;
use std::sync::Arc;

use crate::domain::errors::WorkflowError;
use crate::executor::budget::{BoundedExecutionError, BoundedRunLimits, BoundedRunUsage, BudgetedAccess, RunBudget};
use chrono::Utc;

use super::step_executor::StepExecutor;
use super::AsyncWorkflowExecutor;
use crate::domain::types::{
    CompiledDefinition, ContextualParams, Definition,
    ExecutionContext, ExecutionStatus, LoopState, NodeReadiness, StartData, Step,
    StepHandlerResult, StepOutput, WaitCondition, WorkflowInstance,
};
use crate::executor::context::{
    canonical_step_id, compile_steps_and_edges, is_node_ready, record_step_output, BindingResolver,
    ExecutorDeps,
};
use crate::loader::load_definition_by_id_shared;

// ============================================================================
// SHARED SUB-DEFINITION RESOLVER — pure cache lookup (L063)
// ============================================================================

/// Resolve a sub-definition by id for nested action/loop execution.
///
/// PURE CACHE LOOKUP — no host call, no live-state pull, no await on outside
/// work. This is the structural elimination (L063) of the wasmtime-reentry trap
/// class: the OWNING SLOT pre-hydrates the ENTIRE transitively-referenced
/// definition closure into `definition_store` BEFORE the executor runs (it walks
/// `Definition::referenced_definition_ids` to a fixpoint, hydrating each via a
/// SAFE top-level ask). By the time the DAG executes, every sub-definition an
/// action/loop step can reference is already cached, so this lookup never misses
/// for a durable record — and there is NO code path here that asks the host to
/// resolve a definition mid-execution. Eliminating that mid-execution ask is
/// what removes the intermittent reentry trap (the cold-miss ask raced the
/// wasmtime call window ~1-in-6); the leaf step-body asks (read/ask in
/// `step_executor`) are unaffected — they were never the trigger.
///
/// This is the ONE boundary BOTH nested call sites (`execute_action_step` and
/// `execute_action_step_inner`) route through, so the contract is identical at
/// every site. A genuine miss (the closure walk could not reach the record, or
/// the record does not exist) returns `None` → the caller reports the ordinary
/// `DefinitionNotFound`, exactly as a non-slot/library embed would.
/// Where a run looks for a workflow a step names, said in every refusal: everything the run was handed is in its
/// definition store (the running workflow's own uses and each enclosing workflow's uses, at any depth, and the person's
/// workflow rows its starter read for it).
const LOOKED_IN: &str = "looked in the running workflow's own uses, each enclosing workflow's uses, and the person's workflow \
    rows its starter read for this run";
const LOOK_HINT: &str = "Keep it in a uses of a workflow the run reaches, or as a workflow row the run's starter reads (the \
    workflow component's read_definition with uses_ids_at and uses_at; wf start reads the person's own stores)";

/// Whether a dynamically chosen workflow is one a step's `definition_refs` admits: named exactly, or of a family the
/// step names as an id prefix ending in `*` (`workflow:write-cold-emails-*`).
fn admitted<S: AsRef<str>>(refs: &[S], definition_id: &str) -> bool {
    refs.iter().map(AsRef::as_ref).any(|candidate| candidate == definition_id
        || candidate.strip_suffix('*').is_some_and(|family| !family.is_empty() && definition_id.starts_with(family)))
}

fn resolve_sub_definition(
    deps: &ExecutorDeps,
    definition_id: &str,
) -> Result<Option<Arc<Definition>>, WorkflowError> {
    load_definition_by_id_shared(
        deps.definition_store.as_ref(),
        definition_id,
        &deps.partition_key,
    )
}

// ============================================================================
// BUILT-IN STEP HANDLERS — Concrete StepHandler implementations (L090)
//
// Each handler delegates to the existing execution functions which now
// return StepOutput. The engine dispatches blindly by step.kind string.
// NO branch or parallel handlers — branching is edge conditions,
// parallelism is DAG independence (graph walker property).
// ============================================================================

fn build_context_delta(scratchpad: &ExecutionContext, output: StepOutput) -> StepHandlerResult {
    let writes = scratchpad.captured_writes();

    let mut raw_step_bytes = HashMap::new();
    for key in &scratchpad.dirty_raw_step_bytes {
        if let Some(value) = scratchpad.raw_step_bytes.get(key) {
            raw_step_bytes.insert(key.clone(), Arc::clone(value));
        }
    }

    let cleared_raw_step_bytes = scratchpad.cleared_raw_step_bytes.iter().cloned().collect();
    let runtime_outputs = scratchpad.dirty_runtime_outputs.iter()
        .filter_map(|key| scratchpad.runtime_outputs.get(key).map(|value| (key.clone(), value.clone())))
        .collect();

    StepHandlerResult {
        output,
        writes,
        raw_step_bytes,
        cleared_raw_step_bytes,
        runtime_outputs,
    }
}

fn resolved_definition_steps(definition: &Definition) -> Vec<Step> {
    let extra = &definition.extra_properties;
    if extra.is_empty() {
        return definition.steps.clone();
    }

    let replacements = extra
        .iter()
        .map(|(key, value)| (format!("${key}"), value.as_str()))
        .collect::<Vec<_>>();

    definition
        .steps
        .iter()
        .map(|step| {
            let resolved_config = resolve_value_placeholders(&step.config, &replacements);
            Step {
                id: step.id.clone(),
                kind: step.kind.clone(),
                config: resolved_config,
                join: step.join.clone(),
                join_config: step.join_config.clone(),
            }
        })
        .collect()
}

fn resolve_value_placeholders(value: &Value, replacements: &[(String, &str)]) -> Value {
    match value {
        Value::String(text) => Value::String(resolve_text_placeholders(text, replacements)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| resolve_value_placeholders(item, replacements))
                .collect(),
        ),
        Value::Object(map) => {
            let mut resolved = serde_json::Map::with_capacity(map.len());
            for (key, value) in map {
                resolved.insert(
                    resolve_text_placeholders(key, replacements),
                    resolve_value_placeholders(value, replacements),
                );
            }
            Value::Object(resolved)
        }
        primitive => primitive.clone(),
    }
}

fn resolve_text_placeholders(text: &str, replacements: &[(String, &str)]) -> String {
    if !text.contains('$') {
        return text.to_string();
    }

    let mut resolved = text.to_string();
    for (placeholder, replacement) in replacements {
        if resolved.contains(placeholder) {
            resolved = resolved.replace(placeholder, replacement);
        }
    }
    resolved
}

fn cached_compiled_definition(
    definition: &Definition,
    deps: &ExecutorDeps,
) -> Result<Arc<CompiledDefinition>, WorkflowError> {
    let cache_key = (definition.id.clone(), definition.version);
    if let Ok(cache) = deps.compiled_definition_cache.read() {
        if let Some(compiled) = cache.get(&cache_key) {
            return Ok(Arc::clone(compiled));
        }
    }

    let resolved_steps = resolved_definition_steps(definition);
    let compiled = Arc::new(compile_steps_and_edges(&resolved_steps, &definition.edges)?);

    let mut cache = deps
        .compiled_definition_cache
        .write()
        .map_err(|_| WorkflowError::ExecutionFailed {
            reason: "Compiled definition cache lock poisoned".to_string(),
            hint: "The workflow compiled-definition cache is inconsistent; retry after restarting the slot."
                .to_string(),
        })?;
    Ok(Arc::clone(
        cache
            .entry(cache_key)
            .or_insert_with(|| Arc::clone(&compiled)),
    ))
}

struct ReadStepHandler;

#[async_trait::async_trait]
impl crate::domain::handlers::StepHandler for ReadStepHandler {
    async fn execute(
        &self,
        step: &Step,
        exec_ctx: &ExecutionContext,
        deps: &ExecutorDeps,
        actor: &ActorContext,
    ) -> Result<StepHandlerResult, WorkflowError> {
        let step_id = step.id.clone();
        StepExecutor::execute_leaf_step_delta(step, &step_id, exec_ctx, deps, actor, None).await
    }
}

struct WriteStepHandler;

#[async_trait::async_trait]
impl crate::domain::handlers::StepHandler for WriteStepHandler {
    async fn execute(
        &self,
        step: &Step,
        exec_ctx: &ExecutionContext,
        deps: &ExecutorDeps,
        actor: &ActorContext,
    ) -> Result<StepHandlerResult, WorkflowError> {
        let step_id = step.id.clone();
        StepExecutor::execute_leaf_step_delta(step, &step_id, exec_ctx, deps, actor, None).await
    }
}

struct AskStepHandler;

#[async_trait::async_trait]
impl crate::domain::handlers::StepHandler for AskStepHandler {
    async fn execute(
        &self,
        step: &Step,
        exec_ctx: &ExecutionContext,
        deps: &ExecutorDeps,
        actor: &ActorContext,
    ) -> Result<StepHandlerResult, WorkflowError> {
        let step_id = step.id.clone();
        StepExecutor::execute_leaf_step_delta(step, &step_id, exec_ctx, deps, actor, None).await
    }
}

struct ReturnStepHandler;

#[async_trait::async_trait]
impl crate::domain::handlers::StepHandler for ReturnStepHandler {
    async fn execute(
        &self,
        step: &Step,
        exec_ctx: &ExecutionContext,
        _deps: &ExecutorDeps,
        _actor: &ActorContext,
    ) -> Result<StepHandlerResult, WorkflowError> {
        let start = Instant::now();
        let output = BindingResolver::resolve_value(step.return_value_template(), exec_ctx)?;
        Ok(StepHandlerResult::leaf(StepOutput {
            output,
            status: ExecutionStatus::Completed,
            error: None,
            duration_ms: start.elapsed().as_millis() as i64,
        }))
    }
}

/// Explicit terminal failure for recovery/compensation DAG branches.
///
/// A definition can traverse `on_failure`, invoke owner-declared inverse
/// actions, record recovery evidence, and then end unsuccessfully so its
/// accumulated pending writes are never committed. The error value is DATA and
/// may use the ordinary Binding AST; no domain-specific rollback vocabulary
/// enters Workflow Physics.
struct FailStepHandler;

#[async_trait::async_trait]
impl crate::domain::handlers::StepHandler for FailStepHandler {
    async fn execute(
        &self,
        step: &Step,
        exec_ctx: &ExecutionContext,
        _deps: &ExecutorDeps,
        _actor: &ActorContext,
    ) -> Result<StepHandlerResult, WorkflowError> {
        let resolved = BindingResolver::resolve_value(
            step.config.get("error").unwrap_or(&Value::Null),
            exec_ctx,
        )?;
        let said = resolved
            .as_str()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| resolved.to_string());
        Err(WorkflowError::Refused { step_id: step.id.clone(), said })
    }
}

struct ActionStepHandler;

#[async_trait::async_trait]
impl crate::domain::handlers::StepHandler for ActionStepHandler {
    async fn execute(
        &self,
        step: &Step,
        exec_ctx: &ExecutionContext,
        deps: &ExecutorDeps,
        actor: &ActorContext,
    ) -> Result<StepHandlerResult, WorkflowError> {
        // Action handlers execute sub-steps on a local mutable clone.
        // Sub-step outputs are captured and returned for walker merge.
        let mut scratchpad = exec_ctx.fork_for_delta_capture();
        let output = execute_action_step(step, &mut scratchpad, deps, actor).await?;
        Ok(build_context_delta(&scratchpad, output))
    }
}

/// Execute an owner-carried `execute_definition` request in the CURRENT workflow.
///
/// This is the address-envelope carrier primitive for recursion that already
/// belongs to this workflow process. It accepts the downstream request as
/// target-owned DATA, validates its tiny public shape, and recursively executes
/// the requested definition through the same in-process DAG walker. It never
/// sends that request back to `slot::workflow`, so a workflow cannot deadlock
/// on its own persistent command-lane mutex.
///
/// Admission is the explicit request itself: the durable owner that authored
/// the dispatch row selected both the definition id and its opaque input. The
/// handler resolves only from the already-hydrated definition store; it cannot
/// ask for a missing definition mid-execution.
struct RunOwnerRequestedDefinitionStepHandler;

#[async_trait::async_trait]
impl crate::domain::handlers::StepHandler for RunOwnerRequestedDefinitionStepHandler {
    async fn execute(
        &self,
        step: &Step,
        exec_ctx: &ExecutionContext,
        deps: &ExecutorDeps,
        actor: &ActorContext,
    ) -> Result<StepHandlerResult, WorkflowError> {
        let step_id = step.id.clone();
        let invalid_request = |reason: String, hint: &str| WorkflowError::InvalidStep {
            step_id: step_id.clone(),
            reason,
            hint: hint.to_string(),
        };

        let request_template = step
            .config
            .get("request")
            .ok_or_else(|| invalid_request(
                "run-owner-requested-definition step is missing config.request".to_string(),
                "Bind the owner's complete execute_definition request with resolve_nested_bindings: false, or wrap a literal request in $kind: opaque-json.",
            ))?;
        let request_is_opaque = request_template
            .as_object()
            .and_then(|value| value.get("$kind"))
            .and_then(Value::as_str)
            .map(|kind| {
                kind == "opaque-json"
                    || (kind == "binding"
                        && request_template
                            .get("resolve_nested_bindings")
                            .and_then(Value::as_bool)
                            == Some(false))
            })
            .unwrap_or(false);
        if !request_is_opaque {
            return Err(invalid_request(
                "config.request must select target-owned JSON without interpreting nested bindings"
                    .to_string(),
                "Use a binding with resolve_nested_bindings: false, or wrap the complete request in $kind: opaque-json.",
            ));
        }

        let request = BindingResolver::resolve_value(request_template, exec_ctx)?;
        let request_object = request.as_object().ok_or_else(|| {
            invalid_request(
                "config.request must resolve to an execute_definition object".to_string(),
                "The durable owner must carry {operation, definition_id, input}.",
            )
        })?;
        if request_object.get("operation").and_then(Value::as_str) != Some("execute_definition") {
            return Err(invalid_request(
                "owner request operation must be execute_definition".to_string(),
                "Other owner operations use their ordinary address-envelope ask path.",
            ));
        }
        let definition_id = request_object
            .get("definition_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                invalid_request(
                    "owner request definition_id must be a non-empty string".to_string(),
                    "The dispatch owner must name the definition to execute.",
                )
            })?;
        let nested_input = request_object.get("input").cloned().unwrap_or(Value::Null);

        let action = resolve_sub_definition(deps, definition_id)?.ok_or_else(|| {
            WorkflowError::DefinitionNotFound {
                definition_id: definition_id.to_string(),
                reason: format!(
                    "Definition '{}' requested by step '{}' is not hydrated in partition '{}'",
                    definition_id, step_id, deps.partition_key
                ),
                hint: "The workflow definition delta subscription or top-level closure hydration must deliver this owner-selected definition before execution".to_string(),
            }
        })?;
        if !action.is_active {
            return Err(WorkflowError::DefinitionNotActive {
                definition_id: definition_id.to_string(),
                reason: format!(
                    "Definition '{}' requested by step '{}' is not active",
                    definition_id, step_id
                ),
                hint: "Set the referenced definition's is_active flag to true before executing this workflow"
                    .to_string(),
            });
        }

        let mut scratchpad = exec_ctx.fork_for_delta_capture();
        let output = execute_cached_definition_in_current_workflow(
            Instant::now(),
            &step_id,
            action,
            nested_input,
            true,
            &mut scratchpad,
            deps,
            actor,
        )
        .await?;
        Ok(build_context_delta(&scratchpad, output))
    }
}

struct LoopStepHandler;

#[async_trait::async_trait]
impl crate::domain::handlers::StepHandler for LoopStepHandler {
    async fn execute(
        &self,
        step: &Step,
        exec_ctx: &ExecutionContext,
        deps: &ExecutorDeps,
        actor: &ActorContext,
    ) -> Result<StepHandlerResult, WorkflowError> {
        // Loop handlers iterate on a local mutable clone.
        // Iteration outputs are captured and returned for walker merge.
        let mut scratchpad = exec_ctx.fork_for_delta_capture();
        let output = execute_loop_step(step, &mut scratchpad, deps, actor).await?;
        Ok(build_context_delta(&scratchpad, output))
    }
}

struct WaitStepHandler;

#[async_trait::async_trait]
impl crate::domain::handlers::StepHandler for WaitStepHandler {
    async fn execute(
        &self,
        step: &Step,
        exec_ctx: &ExecutionContext,
        deps: &ExecutorDeps,
        _actor: &ActorContext,
    ) -> Result<StepHandlerResult, WorkflowError> {
        let output = execute_wait_step(step, exec_ctx, deps).await?;
        Ok(StepHandlerResult::leaf(output))
    }
}

/// Build the default step handler registry with all built-in handlers.
///
/// Called once at ExecutorDeps construction. No branch or parallel handlers —
/// in a DAG engine, branching is an Edge condition (EdgeHandler) and
/// parallelism is emergent from DAG independence (concurrent graph walker).
pub fn default_step_registry() -> crate::domain::handlers::StepHandlerRegistry {
    let mut registry = crate::domain::handlers::StepHandlerRegistry::new();
    registry.insert("read".to_string(), Box::new(ReadStepHandler));
    registry.insert("write".to_string(), Box::new(WriteStepHandler));
    registry.insert("ask".to_string(), Box::new(AskStepHandler));
    registry.insert("return".to_string(), Box::new(ReturnStepHandler));
    registry.insert("fail".to_string(), Box::new(FailStepHandler));
    registry.insert("action".to_string(), Box::new(ActionStepHandler));
    registry.insert(
        "run-owner-requested-definition".to_string(),
        Box::new(RunOwnerRequestedDefinitionStepHandler),
    );
    registry.insert("loop".to_string(), Box::new(LoopStepHandler));
    registry.insert("wait".to_string(), Box::new(WaitStepHandler));
    registry
}

// ============================================================================
// CONSTANTS — Physics bounds that prevent resource exhaustion
// ============================================================================

/// Default maximum loop iterations when LoopConfig.max_iterations is None.
/// This is a Physics safety bound, not a Society preference.
const DEFAULT_MAX_LOOP_ITERATIONS: i32 = 1000;

/// Default maximum in-flight loop iterations when `parallel` is enabled and the
/// authored workflow does not specify a bound.
const DEFAULT_MAX_LOOP_CONCURRENCY: usize = 8;

/// Default wait duration when no condition is specified (no-op).
/// The per-step WaitCondition is the canonical bound — this is only used as
/// a safe fallback when inputs parse to no condition at all.
const DEFAULT_WAIT_SECS_WHEN_UNSPECIFIED: u64 = 0;

// ============================================================================
// STEP ID FORMAT CONSTANTS
//
// Steps are identified by structured compound IDs that encode hierarchy.
// These constants prevent silent breakage if a separator is changed in one
// location but not another.
//
// Example IDs produced:
//   "step_0"                          — top-level step (order 0)
//   "step_0_action_1"                 — 2nd inner action-step of step 0
//   "step_0_iter_3"                   — 4th loop iteration of step 0
//   "step_0_iter_3_action_0"          — 1st inner action-step of 4th iteration
//   "step_0_branch_1"                 — 2nd parallel branch of step 0
//   "step_0_branch_1_action_0"        — 1st inner action of 2nd parallel branch
//   "step_0_retry_1"                  — 2nd retry attempt of step 0
// ============================================================================

/// Suffix separator for loop iteration step IDs.
/// Produces: "{step_id}{STEP_SUFFIX_ITER}{iteration_index}".
const STEP_SUFFIX_ITER: &str = "_iter_";

/// Workflow instance ID prefix.
/// Produces: "{WORKFLOW_INSTANCE_ID_PREFIX}{ulid}".
const WORKFLOW_INSTANCE_ID_PREFIX: &str = "wfi:";

// ============================================================================
// WORKFLOW STORE TRAIT
//
// Host layers implement this to provide workflow definition loading.
// The workflow crate never executes SQL — it only consumes these results.
// Modeled after DefinitionStore in loader.rs.
// ============================================================================

// DefinitionStore trait is defined in domain/stores.rs.
// It is re-exported from the crate root (lib.rs) for consumers.
// Use `crate::DefinitionStore` to reference the trait.
// ============================================================================
// RETRY POLICY — Configurable retry behavior (Society, not Physics)
// ============================================================================

/// Configurable retry policy for workflow execution.
///
/// All values are passed as configuration — no hardcoded retry behavior.
/// The automation engine uses this to determine when and how to retry
/// failed workflow steps.
///
/// # Backoff Strategy
///
/// - `Fixed`: Wait `base_delay_ms` between each retry
/// - `Exponential`: Wait `base_delay_ms * 2^attempt` between retries
/// - `None`: No retries (max_attempts = 1 effectively)
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Maximum number of execution attempts (1 = no retries).
    pub max_attempts: u32,
    /// Base delay between retries in milliseconds.
    pub base_delay_ms: u64,
    /// Backoff strategy for computing delay between retries.
    pub backoff: BackoffStrategy,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 1,
            base_delay_ms: 0,
            backoff: BackoffStrategy::None,
        }
    }
}

impl RetryPolicy {
    /// Compute the delay for a given attempt number (0-indexed).
    ///
    /// Returns the number of milliseconds to wait before the next attempt.
    pub fn delay_for_attempt(&self, attempt: u32) -> u64 {
        match self.backoff {
            BackoffStrategy::None => 0,
            BackoffStrategy::Fixed => self.base_delay_ms,
            BackoffStrategy::Exponential => self
                .base_delay_ms
                .saturating_mul(2u64.saturating_pow(attempt)),
        }
    }
}

/// Backoff strategy for retry delays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackoffStrategy {
    /// No delay between retries.
    None,
    /// Fixed delay between retries.
    Fixed,
    /// Exponential backoff: base_delay * 2^attempt.
    Exponential,
}

// ============================================================================
// WORKFLOW EXECUTION — execute_workflow on AsyncWorkflowExecutor
// ============================================================================

impl AsyncWorkflowExecutor {
    /// Execute a workflow definition in automation mode.
    ///
    /// Loads the workflow definition from the database via DefinitionStore,
    /// validates it is active, initializes a WorkflowInstance, then executes
    /// all steps sequentially respecting step_type semantics (Action, Branch,
    /// Loop, Wait).
    ///
    /// # Arguments
    ///
    /// * `definition_store` — DefinitionStore implementation for loading definitions
    /// * `definition_store` — DefinitionStore implementation for loading action definitions
    ///   (needed by Action-type steps)
    /// * `workflow_id` — entity ID of the workflow to execute
    /// * `start` — Start data that initiated this execution
    /// * `actor` — Authenticated actor performing the operation
    /// * `retry_policy` — Configurable retry behavior for transient failures
    ///
    /// # Returns
    ///
    /// * `Ok(WorkflowInstance)` — Execution completed. Instance contains
    ///   status (Completed or Failed), execution context with all step outputs,
    ///   and timing metadata.
    /// * `Err(WorkflowError)` — Fatal error before execution could start.
    ///
    /// # Errors
    ///
    /// | Error Type | Cause |
    /// |-----------|-------|
    /// | `WorkflowNotFound` | No workflow with the given ID exists |
    /// | `DefinitionNotActive` | Workflow exists but is_active = false |
    /// | `ExecutionFailed` | A step failed and exhausted retry attempts |
    /// | `LoopExecutionFailed` | Loop source expression did not resolve to array |
    /// | `ConditionEvaluationFailed` | Branch condition could not be evaluated |
    /// | `Timeout` | Wait step exceeded maximum allowed duration |
    ///
    /// Execute a workflow from a pre-loaded or inline-constructed definition.
    ///
    /// This is the L069 generative primitive — the value-based entry point.
    /// All execution paths (store-backed, inline, AI-composed, test, recursive)
    /// converge here. The executor has no opinion about where the definition
    /// came from.
    ///
    /// # Arguments
    ///
    /// * `definition` — The workflow definition to execute (from any source)
    /// * `action_store` — Store for loading nested action definitions
    /// * `start` — Start data (event context)
    /// * `actor` — Actor identity for permission enforcement
    /// * `retry_policy` — Retry configuration for transient failures
    ///
    /// # Returns
    ///
    /// A `WorkflowInstance` representing the execution state (Completed/Failed).
    pub async fn execute_definition(
        &self,
        definition: Definition,
        start: StartData,
        actor: ActorContext,
        retry_policy: &RetryPolicy,
    ) -> Result<WorkflowInstance, WorkflowError> {
        self.execute_definition_inner(definition, start, actor, retry_policy, None).await
    }

    /// Execute with one ephemeral host-owned aggregate budget shared across retries,
    /// nested action graphs, and cloned parallel loop contexts. A budget refusal is
    /// returned as a typed error instead of being flattened into `error_message`.
    pub async fn execute_definition_bounded(
        &self,
        definition: Definition,
        start: StartData,
        actor: ActorContext,
        retry_policy: &RetryPolicy,
        limits: BoundedRunLimits,
    ) -> Result<(WorkflowInstance, BoundedRunUsage), BoundedExecutionError> {
        let budget = Arc::new(RunBudget::new(limits.validate()?));
        let instance = self.execute_definition_inner(definition, start, actor, retry_policy, Some(Arc::clone(&budget))).await.map_err(|error| budget.refusal().map_or_else(|| BoundedExecutionError::Workflow(error), BoundedExecutionError::Budget))?;
        Ok((instance, budget.usage()))
    }

    async fn execute_definition_inner(
        &self,
        definition: Definition,
        start: StartData,
        actor: ActorContext,
        retry_policy: &RetryPolicy,
        budget: Option<Arc<RunBudget>>,
    ) -> Result<WorkflowInstance, WorkflowError> {
        let partition_key = definition.partition_key.clone();
        let start_id = start.start_id.clone();
        let json_conversion_policy = self.json_conversion_policy;

        // 1. Validate definition is active
        if !definition.is_active {
            return Err(WorkflowError::DefinitionNotActive {
                definition_id: definition.id.clone(),
                reason: format!(
                    "Definition '{}' ({}) is not active",
                    definition.id, definition.name
                ),
                hint: "Set the is_active flag to true on the definition before executing it"
                    .to_string(),
            });
        }

        // 2. Initialize WorkflowInstance
        let timestamp = if start.started_at.is_empty() {
            current_timestamp()
        } else {
            start.started_at.clone()
        };
        let mut instance = WorkflowInstance {
            id: format!("{}{}", WORKFLOW_INSTANCE_ID_PREFIX, ulid_placeholder()),
            partition_key: partition_key.clone(),
            workflow_id: definition.id.clone(),
            status: ExecutionStatus::Running,
            started_at: Some(timestamp.clone()),
            completed_at: None,
            error_message: None,
            start_id,
            current_step: 0,
            execution_context: ExecutionContext {
                start,
                json_conversion_policy,
                trusted_local_invocation: self.trusted_local_invocation,
                context: ContextualParams {
                    actor: actor.clone(),
                    partition_key: partition_key.clone(),
                    organization_id: String::new(),
                    platform: crate::domain::PlatformInfo {
                        os: std::env::consts::OS.to_string(),
                        arch: std::env::consts::ARCH.to_string(),
                    },
                },
                ..Default::default()
            },
        };

        // 3. Build executor deps with all optional deps (L063: ONE function, zero duplication)
        //    Arc-wrapped for sharing across concurrent step futures.
        let mut deps = self.build_executor_deps();
        deps.partition_key = Arc::from(partition_key.clone());
        if let Some(budget) = &budget {
            deps.outside_access = Arc::new(BudgetedAccess::new(deps.outside_access, Arc::clone(budget)));
        }
        let deps = Arc::new(deps);

        // 4. Compile definition → CompiledDefinition (DirectedGraph + step_map)
        let compiled = cached_compiled_definition(&definition, &deps)?;

        // 5. Concurrent Graph Walker — O(active) not O(total)
        //
        // Model: track in-degree for each node. Frontier = nodes with in-degree 0.
        // When a node completes, evaluate outgoing edges → decrement children's
        // in-degree. Any child hitting 0 enters the frontier immediately.
        // FuturesUnordered provides cooperative concurrency on both native and WASM.
        //
        // Skip Propagation (L063): when a node is Skipped (branch condition failed),
        // the skip is propagated through the same join algebra as normal execution.
        // Merge nodes with another satisfied inbound path still run.
        let walker_result = execute_dag_concurrent(
            compiled,
            &mut instance.execution_context,
            deps,
            &actor,
            retry_policy,
        )
        .await;

        if let Err(error) = &walker_result {
            if budget.as_ref().is_some_and(|budget| budget.is_exhausted()) {
                return Err(error.clone());
            }
        }

        match walker_result {
            Ok(()) => {
                instance.status = ExecutionStatus::Completed;
                instance.completed_at = Some(current_timestamp());
            }
            // Paused, not failed: a step is waiting for its answer, and running the definition again goes on.
            Err(WorkflowError::Waiting { .. }) => {
                instance.status = ExecutionStatus::Paused;
            }
            Err(err) => {
                instance.status = ExecutionStatus::Failed;
                instance.completed_at = Some(current_timestamp());
                instance.error_message = Some(err.to_string());
            }
        }

        Ok(instance)
    }

    pub async fn execute_workflow(
        &self,
        workflow_id: &str,
        start: StartData,
        actor: ActorContext,
        retry_policy: &RetryPolicy,
    ) -> Result<WorkflowInstance, WorkflowError> {
        let partition_key = self.partition_key();

        // Load phase: obtain definition from the executor's definition store
        let definition = self
            .definition_store
            .get_by_id(workflow_id, partition_key)?
            .ok_or_else(|| WorkflowError::WorkflowNotFound {
                workflow_id: workflow_id.to_string(),
                reason: format!(
                    "Workflow '{}' not found in partition '{}'",
                    workflow_id, partition_key
                ),
                hint: "Verify the workflow_id is a valid entity ID and the workflow \
                           exists in the target partition"
                    .to_string(),
            })?;

        // Delegate to value-based entry point
        self.execute_definition(definition, start, actor, retry_policy)
            .await
    }
}

// ============================================================================
// STEP EXECUTION WITH RETRY
// ============================================================================

/// Execute a single workflow step with retry logic.
///
/// Dispatches to the appropriate handler based on step_type, retrying
/// on transient failures according to the retry policy.
///
/// # Circuit State Integration (Wave 3)
///
/// When `circuit_state` is `Some`, the circuit FSM is checked at the TOP of
/// every attempt loop — before `execute_single_step` is called. This is the
/// Physics guarantee: an OPEN circuit consumes ZERO retry budget.
///
/// - `fsm == OPEN (1)`: return `WorkflowError::CircuitOpen` immediately.
///   Retry budget is NOT consumed. is_retryable() = false.
/// - `fsm == HALF_OPEN (2)`: return `WorkflowError::CircuitHalfOpen` immediately.
///   Yield to the orchestrator for reschedule after probe resolves.
///   is_retryable() = false, is_fatal() = false.
/// - `fsm == CLOSED (0)`: proceed normally — execute step, apply retry policy.
///
/// # Retry Guard (Wave 3)
///
/// The `Err(err) if ...` guard now also checks `err.is_retryable()`. This
/// prevents non-transient errors (e.g., `PermissionDenied`, `CircuitOpen`)
/// from spinning through all `max_attempts` before propagating.
///
/// # Call Site Note
///
/// Pass `None` as `circuit_state` when no BoundaryGuardEngine is available.
/// Wave 4 (task-0521) wires the actual state from the dispatch path.
/// Execute a step with retry logic. Takes read-only context, returns StepHandlerResult.
///
/// The concurrent walker owns the master ExecutionContext. This function dispatches
/// to the handler with a read-only snapshot and returns the result.
async fn execute_step_with_retry(
    step: &Step,
    exec_ctx: &ExecutionContext,
    deps: &ExecutorDeps,
    actor: &ActorContext,
    retry_policy: &RetryPolicy,
) -> Result<StepHandlerResult, WorkflowError> {
    let max_attempts = retry_policy.max_attempts.max(1);

    for attempt in 0..max_attempts {
        // R9: Check circuit FSM before each attempt — OPEN/HALF_OPEN exit immediately.
        if let Some(ref cs) = deps.circuit_state {
            let packed = {
                #[cfg(not(target_arch = "wasm32"))]
                {
                    cs.read()
                        .packed_state
                        .load(core::sync::atomic::Ordering::Acquire)
                }
                #[cfg(target_arch = "wasm32")]
                {
                    cs.borrow()
                        .packed_state
                        .load(core::sync::atomic::Ordering::Acquire)
                }
            };
            let fsm = (packed >> 56) as u8;
            if fsm == 1 {
                return Err(WorkflowError::CircuitOpen {
                    reason: "Circuit OPEN — step execution skipped to conserve retry budget"
                        .to_string(),
                });
            }
            if fsm == 2 {
                return Err(WorkflowError::CircuitHalfOpen {
                    reason: "Circuit HALF_OPEN — yield to orchestrator for reschedule after probe resolves"
                        .to_string(),
                });
            }
        }

        if let Some(budget) = deps.outside_access.run_budget() {
            budget.reserve("step_attempts", 1)?;
        }

        let result = execute_single_step(step, exec_ctx, deps, actor).await;

        match result {
            Ok(handler_result) => return Ok(handler_result),
            // A nested handler can exhaust the shared invocation meter. Its
            // ordinary legacy error must not enter retry backoff before the
            // enclosing graph observes that fatal state.
            Err(err) if deps.outside_access.run_budget().is_some_and(RunBudget::is_exhausted) => return Err(err),
            Err(err) if attempt + 1 < max_attempts && err.is_retryable() => {
                #[cfg(feature = "native")]
                {
                    let delay_ms = retry_policy.delay_for_attempt(attempt);
                    if delay_ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    }
                }
            }
            Err(err) => return Err(err),
        }
    }

    Err(WorkflowError::ExecutionFailed {
        reason: "Exhausted all retry attempts".to_string(),
        hint: "Increase the retry limit in the RetryPolicy or investigate \
               why the step fails repeatedly"
            .to_string(),
    })
}

// ============================================================================
// CONCURRENT GRAPH WALKER — O(active) execution (L056/L057)
//
// The concurrent walker tracks the execution frontier. When a node completes,
// only its children are evaluated. The engine never loops over the whole graph
// checking nodes that aren't ready.
//
// On Native: FuturesUnordered provides cooperative concurrent execution.
// On WASM: Same code — single-threaded cooperative interleaving at .await points.
// ONE code path, ONE execution model (L089).
// ============================================================================

/// Concurrent DAG walker — executes workflow steps with emergent parallelism.
///
/// # Model
///
/// 1. Build in-degree map for all nodes from the compiled DAG
/// 2. Seed frontier with root nodes (in-degree 0)
/// 3. Spawn all frontier nodes into FuturesUnordered
/// 4. When a future yields (node_id, StepHandlerResult):
///    a. Record output + sub-steps in master ExecutionContext
///    b. Evaluate outgoing edges via EdgeHandlerRegistry
///    c. For satisfied edges: decrement child's in-degree
///    d. For unsatisfied edges: propagate a skipped outcome through the same join algebra
///    e. Any child hitting in-degree 0 enters frontier
/// 5. Loop until FuturesUnordered is empty and frontier is empty
///
/// # Complexity
///
/// O(active) per tick — only nodes whose predecessors just completed are evaluated.
/// Zero wasted cycles on nodes deep in the graph that aren't ready.
///
/// # Subgraph Skipping (L063)
///
/// When ALL inbound edges to a node fail, the node is Skipped. That skipped
/// outcome is then propagated forward like any other predecessor outcome, so
/// downstream merge nodes still execute when another inbound path is satisfied.
async fn execute_dag_concurrent(
    compiled: Arc<CompiledDefinition>,
    exec_ctx: &mut ExecutionContext,
    deps: Arc<ExecutorDeps>,
    actor: &ActorContext,
    retry_policy: &RetryPolicy,
) -> Result<(), WorkflowError> {
    use futures::stream::{self, StreamExt};
    use graph::NodeIndex;

    let all_indices = compiled.dag.all_node_indices();
    if all_indices.is_empty() {
        return Ok(());
    }

    // 1. Build in-degree map by NodeIndex — O(1) lookup, zero string hashing (P1).
    let mut in_degree: HashMap<NodeIndex, usize> = HashMap::with_capacity(all_indices.len());
    for &idx in &all_indices {
        in_degree.insert(idx, compiled.dag.in_degree_by_index(idx));
    }

    // Track skipped nodes by index — O(1) membership test
    let mut skipped: std::collections::HashSet<NodeIndex> = std::collections::HashSet::new();

    // The first step found waiting for its answer; the walk goes on through every branch that does not need it.
    let mut waiting: Option<WorkflowError> = None;

    // Track completed step outcomes for is_node_ready() readiness evaluation.
    // String-keyed because is_node_ready is shared with rebuild_from_persisted
    // (persistence layer uses string keys). Incrementally maintained O(1) per node.
    let mut outcomes_str: HashMap<String, StepOutput> = HashMap::new();

    // 2. Seed frontier with root nodes (in-degree 0)
    let mut frontier: Vec<NodeIndex> = in_degree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(idx, _)| *idx)
        .collect();

    // 3. Main walker loop — execute each ready frontier wave against one shared
    // immutable context view, then merge results before opening the next wave.
    loop {
        let ready_nodes: Vec<(NodeIndex, String, Arc<Step>)> = frontier
            .drain(..)
            .filter(|node_idx| !skipped.contains(node_idx))
            .filter_map(|node_idx| {
                let node_key = compiled.dag.get_key(node_idx)?.clone();
                let step = Arc::clone(compiled.step_map.get(&node_key)?);
                Some((node_idx, node_key, step))
            })
            .collect();

        if ready_nodes.is_empty() {
            break;
        }

        let ctx_view: &ExecutionContext = &*exec_ctx;
        // Wave concurrency is a PLATFORM ADAPTATION, identical to the loop body
        // (`execute_loop_body`: concurrent on native, sequential on WASM — see the
        // `parallel: true + WASM → execute_loop_sequential` contract below).
        //
        // On native, independent steps in a ready wave fan out via `buffer_unordered`.
        // On WASM the guest is single-threaded and each `ask` step issues an async
        // `send-request-bytes` host call; firing two or more concurrently lets the
        // wit-bindgen async runtime interleave reply lowering across in-flight
        // FutureStates, which corrupts the returned reply bytes and traps the guest
        // inside `decode_ask_output`'s `serde_json::from_str`. Capping in-flight work
        // to 1 makes that corruption category structurally impossible (only ever one
        // host call in flight) without touching the host or the toolchain.
        #[cfg(feature = "native")]
        let wave_concurrency = ready_nodes.len().max(1);
        #[cfg(not(feature = "native"))]
        let wave_concurrency = 1;
        let wave_results =
            stream::iter(ready_nodes.into_iter().map(|(node_idx, node_key, step)| {
                let deps_arc = Arc::clone(&deps);
                let actor_owned = actor.clone();
                let retry_owned = retry_policy.clone();
                async move {
                    let result = execute_step_with_retry(
                        step.as_ref(),
                        ctx_view,
                        &deps_arc,
                        &actor_owned,
                        &retry_owned,
                    )
                    .await;
                    match result {
                        Ok(handler_result) => Ok((node_idx, node_key, handler_result)),
                        Err(err) => Err((node_idx, node_key, err)),
                    }
                }
            }))
            .buffer_unordered(wave_concurrency)
            .collect::<Vec<_>>()
            .await;

        for completion in wave_results {
            let (node_idx, node_key, handler_result, step_error) = match completion {
                Ok((idx, key, result)) => (idx, key, result, None),
                Err((_, key, err)) => {
                    // A bounded refusal is invocation-fatal. Do not flatten it into
                    // step evidence, let failure edges recover it, or continue the wave.
                    if deps.outside_access.run_budget().is_some_and(RunBudget::is_exhausted) {
                        return Err(err);
                    }
                    let node_idx = match compiled.dag.get_index(&key) {
                        Some(index) => index,
                        None => return Err(WorkflowError::ExecutionFailed {
                            reason: format!(
                                "Failed step '{}' disappeared from the compiled DAG",
                                key
                            ),
                            hint: "The compiled definition must remain immutable during execution."
                                .to_string(),
                        }),
                    };
                    // A waiting step keeps what the host said about the wait, and a failed one what it found
                    // (a check's problems), as data the caller reads without parsing the message.
                    let status = if matches!(err, WorkflowError::Waiting { .. }) {
                        ExecutionStatus::Paused
                    } else {
                        ExecutionStatus::Failed
                    };
                    (
                        node_idx,
                        key,
                        StepHandlerResult::leaf(StepOutput {
                            output: err.evidence(),
                            status,
                            error: Some(err.to_string()),
                            duration_ms: 0,
                        }),
                        Some(err),
                    )
                }
            };

            // 5. Record output in master context (String key — required by ExecutionContext)
            let outcome = handler_result.output.clone();
            record_step_output(exec_ctx, &node_key, outcome.clone());
            for write in &handler_result.writes {
                exec_ctx.push_write(write.clone());
            }
            for key in &handler_result.cleared_raw_step_bytes {
                exec_ctx.clear_raw_step_bytes(key);
            }
            for (key, value) in &handler_result.raw_step_bytes {
                exec_ctx.record_raw_step_bytes(key.clone(), Arc::clone(value));
            }
            for (key, value) in &handler_result.runtime_outputs {
                exec_ctx.runtime_outputs.insert(key.clone(), value.clone());
                exec_ctx.dirty_runtime_outputs.insert(key.clone());
            }

            // Track outcome for is_node_ready() — O(1) per completed node
            outcomes_str.insert(node_key.clone(), outcome.clone());

            // 6. Decrement children's in-degree by NodeIndex — O(out-degree), zero key hashing.
            //
            // Edge satisfaction is NOT evaluated here — is_node_ready() re-evaluates ALL
            // inbound edges via EdgeHandler when the child's in-degree hits 0. Evaluating
            // at the walker level would be redundant work. The walker only needs to track
            // when all predecessors have completed (in-degree 0), then delegate the
            // satisfied/skipped decision to the JoinHandler inside is_node_ready().
            let outgoing = compiled.dag.outgoing_edges_by_index(node_idx);
            if let Some(error) = step_error {
                // A step waiting for its answer opens none of its children and is no failure: every branch that
                // does not depend on it still runs, and the run ends paused (see `execute_definition`).
                if matches!(error, WorkflowError::Waiting { .. }) {
                    waiting.get_or_insert(error);
                    continue;
                }
                // A definition that ends itself on purpose says why in its own words.
                let refused = matches!(error, WorkflowError::Refused { .. }).then(|| error.clone());
                let error = error.to_string();
                let mut handled = false;
                for (_, edge_meta) in &outgoing {
                    let edge_handler =
                        deps.edge_registry
                            .get(edge_meta.kind.as_str())
                            .ok_or_else(|| WorkflowError::InvalidWorkflow {
                                reason: format!(
                                    "Unknown edge kind '{}' leaving failed step '{}'",
                                    edge_meta.kind, node_key
                                ),
                                hint: "Register the edge handler before executing the definition."
                                    .to_string(),
                            })?;
                    if edge_handler.evaluate(&node_key, &outcome, &edge_meta.condition)? {
                        handled = true;
                        break;
                    }
                }
                if !handled {
                    if let Some(refused) = refused {
                        return Err(refused);
                    }
                    return Err(WorkflowError::ExecutionFailed {
                        reason: format!("Step '{}' failed: {}", node_key, error),
                        hint: "Add a DATA-declared on_failure path when the definition owns a recovery or inverse action; otherwise fix the failing step."
                            .to_string(),
                    });
                }
            }
            for (child_idx, _edge_meta) in &outgoing {
                if skipped.contains(child_idx) {
                    continue;
                }

                if let Some(deg) = in_degree.get_mut(child_idx) {
                    *deg = deg.saturating_sub(1);
                    if *deg == 0 {
                        // Resolve child key for is_node_ready (called once per fan-in,
                        // not per edge — acceptable String allocation)
                        let child_key = match compiled.dag.get_key(*child_idx) {
                            Some(k) => k,
                            None => continue,
                        };
                        if let Some(step) = compiled.step_map.get(child_key) {
                            match is_node_ready(
                                child_key,
                                step.as_ref(),
                                &compiled.dag,
                                &outcomes_str,
                                &deps.edge_registry,
                                &deps.join_registry,
                            )? {
                                NodeReadiness::Ready => frontier.push(*child_idx),
                                NodeReadiness::Skipped => {
                                    let mut skip_propagation = SkipPropagation {
                                        compiled: compiled.as_ref(),
                                        in_degree: &mut in_degree,
                                        skipped: &mut skipped,
                                        exec_ctx,
                                        outcomes: &mut outcomes_str,
                                        edge_registry: deps.edge_registry.as_ref(),
                                        join_registry: deps.join_registry.as_ref(),
                                        frontier: &mut frontier,
                                    };
                                    propagate_skipped_node(
                                        *child_idx,
                                        "Skipped — all inbound edges unsatisfied",
                                        &mut skip_propagation,
                                    )?;
                                }
                                NodeReadiness::Waiting => {}
                            }
                        }
                    }
                }
            }
        }
    }

    if let Some(error) = waiting {
        return Err(error);
    }
    // A walk that ends with no step waiting has run or skipped every step. One left neither is a walk that lost its
    // way, and the run says so by name instead of ending completed with that step's work never done.
    let unrun: Vec<&String> = all_indices
        .iter()
        .filter(|idx| !skipped.contains(idx))
        .filter_map(|&idx| compiled.dag.get_key(idx))
        .filter(|key| !outcomes_str.contains_key(*key))
        .collect();
    if !unrun.is_empty() {
        let mut names: Vec<&str> = unrun.iter().map(|key| key.as_str()).collect();
        names.sort_unstable();
        return Err(WorkflowError::ExecutionFailed {
            reason: format!("The run ended with steps that neither ran nor were skipped: {}", names.join(", ")),
            hint: "Every step must either run or be skipped by its edges; read the edges into these steps.".to_string(),
        });
    }
    Ok(())
}

fn skipped_step_output(reason: &str) -> StepOutput {
    StepOutput {
        output: Value::Null,
        status: ExecutionStatus::Skipped,
        error: Some(reason.to_string()),
        duration_ms: 0,
    }
}

fn record_skipped_node(
    node_idx: graph::NodeIndex,
    dag: &graph::DirectedGraph<String, crate::domain::types::CompiledEdge>,
    skipped: &mut std::collections::HashSet<graph::NodeIndex>,
    exec_ctx: &mut ExecutionContext,
    outcomes: &mut HashMap<String, StepOutput>,
    reason: &str,
) -> bool {
    if !skipped.insert(node_idx) {
        return false;
    }
    if let Some(key) = dag.get_key(node_idx) {
        let output = skipped_step_output(reason);
        record_step_output(exec_ctx, key, output.clone());
        outcomes.insert(key.clone(), output);
    }
    true
}

struct SkipPropagation<'a> {
    compiled: &'a CompiledDefinition,
    in_degree: &'a mut HashMap<graph::NodeIndex, usize>,
    skipped: &'a mut std::collections::HashSet<graph::NodeIndex>,
    exec_ctx: &'a mut ExecutionContext,
    outcomes: &'a mut HashMap<String, StepOutput>,
    edge_registry: &'a crate::domain::handlers::EdgeHandlerRegistry,
    join_registry: &'a crate::domain::handlers::JoinHandlerRegistry,
    frontier: &'a mut Vec<graph::NodeIndex>,
}

fn propagate_skipped_node(
    node_idx: graph::NodeIndex,
    reason: &str,
    state: &mut SkipPropagation<'_>,
) -> Result<(), WorkflowError> {
    let mut stack = vec![(node_idx, reason.to_string())];
    while let Some((skipped_idx, skipped_reason)) = stack.pop() {
        if !record_skipped_node(
            skipped_idx,
            &state.compiled.dag,
            state.skipped,
            state.exec_ctx,
            state.outcomes,
            &skipped_reason,
        ) {
            continue;
        }

        let outgoing = state.compiled.dag.outgoing_edges_by_index(skipped_idx);
        for (child_idx, _edge_meta) in outgoing {
            if state.skipped.contains(&child_idx) {
                continue;
            }

            let child_ready_to_check = if let Some(deg) = state.in_degree.get_mut(&child_idx) {
                *deg = deg.saturating_sub(1);
                *deg == 0
            } else {
                false
            };
            if !child_ready_to_check {
                continue;
            }

            let Some(child_key) = state.compiled.dag.get_key(child_idx) else {
                continue;
            };
            let Some(step) = state.compiled.step_map.get(child_key) else {
                continue;
            };

            match is_node_ready(
                child_key,
                step.as_ref(),
                &state.compiled.dag,
                state.outcomes,
                state.edge_registry,
                state.join_registry,
            )? {
                NodeReadiness::Ready => state.frontier.push(child_idx),
                NodeReadiness::Skipped => {
                    stack.push((
                        child_idx,
                        "Skipped — all inbound edges unsatisfied".to_string(),
                    ));
                }
                NodeReadiness::Waiting => {}
            }
        }
    }
    Ok(())
}

// ============================================================================
// SINGLE STEP DISPATCH BY TYPE
// ============================================================================

/// Execute a single workflow step via the StepHandler registry (L090 — blind dispatch).
///
/// The engine does NOT know what a "loop", "action", or "primitive" is.
/// It looks up `step.kind` in `deps.step_registry` and calls the registered handler.
/// If someone invents a "quantum_fork" step kind, they register a handler.
/// Zero engine code changes. (Plan §5e)
///
/// Returns `StepHandlerResult` — the concurrent walker records it into the master context.
/// This function does NOT mutate the ExecutionContext — that's the walker's job.
async fn execute_single_step(
    step: &Step,
    exec_ctx: &ExecutionContext,
    deps: &ExecutorDeps,
    actor: &ActorContext,
) -> Result<StepHandlerResult, WorkflowError> {
    // Look up handler by step.kind — the engine never enumerates kinds (L090)
    let handler =
        deps.step_registry
            .get(step.kind.as_str())
            .ok_or_else(|| WorkflowError::InvalidStep {
                step_id: step.id.clone(),
                reason: format!("No handler registered for step kind '{}'", step.kind),
                hint: "Register a StepHandler for this kind at engine startup.".to_string(),
            })?;

    // Blind dispatch — handler returns StepHandlerResult, walker records it
    handler.execute(step, exec_ctx, deps, actor).await
}

// ============================================================================
// ACTION STEP — delegates to StepExecutor
// ============================================================================

/// Execute an Action-type step via recursive concurrent walker.
///
/// An Action is a reference to another Definition. A Definition is a DAG.
/// All DAGs use the same execution physics: `execute_dag_concurrent` (L088 CSSOT).
/// Sub-steps within an action benefit from the same parallelism and subgraph
/// skipping as top-level steps. Zero sequential shadows.
async fn execute_action_step(
    step: &Step,
    exec_ctx: &mut ExecutionContext,
    deps: &ExecutorDeps,
    actor: &ActorContext,
) -> Result<StepOutput, WorkflowError> {
    let start = Instant::now();
    let step_id = step.id.clone();

    // Resolve the nested action identity from DATA. Literal strings preserve
    // every existing definition byte-for-byte; binding ASTs select an admitted
    // candidate at execution time.
    let resolved_definition_id =
        BindingResolver::resolve_value(step.definition_id_value(), exec_ctx)?;
    let definition_id = resolved_definition_id
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| WorkflowError::InvalidStep {
            step_id: step_id.clone(),
            reason: format!(
                "Action step '{}' definition_id must resolve to a non-empty string; got {}",
                step_id, resolved_definition_id
            ),
            hint: "Set config.definition_id to a literal definition id or a binding that resolves \
                   to one; DATA-selected actions must also declare every candidate in \
                   config.definition_refs"
                .to_string(),
        })?;

    // Dynamic selection cannot escape the closure the owning slot pre-hydrated.
    // The candidate list is DATA, so adding a new publication/output/action
    // mode remains a record change rather than a code branch; a candidate ending
    // in `*` admits every workflow whose id starts with the rest (a family), so a
    // new member is added by its row alone.
    if step.definition_id().is_none() && !admitted(&step.definition_refs(), definition_id) {
        return Err(WorkflowError::InvalidStep {
            step_id: step_id.clone(),
            reason: format!(
                "Action step '{}' resolved definition_id '{}' outside definition_refs",
                step_id, definition_id
            ),
            hint: "Add the selected definition id to config.definition_refs so the owning slot \
                   can pre-hydrate and admit the complete nested-definition closure"
                .to_string(),
        });
    }

    let action = resolve_sub_definition(deps, definition_id)?.ok_or_else(|| {
        WorkflowError::DefinitionNotFound {
            definition_id: definition_id.to_string(),
            reason: format!(
                "Definition '{}' referenced by step '{}' was not found: {}",
                definition_id, step_id, LOOKED_IN
            ),
            hint: LOOK_HINT.to_string(),
        }
    })?;

    if !action.is_active {
        return Err(WorkflowError::DefinitionNotActive {
            definition_id: definition_id.to_string(),
            reason: format!(
                "Definition '{}' referenced by step '{}' is not active",
                definition_id, step_id
            ),
            hint: "Set the referenced definition's is_active flag to true before executing this workflow"
                .to_string(),
        });
    }

    // Resolve input templates for this step
    let resolved_inputs = BindingResolver::resolve_value(step.inputs(), exec_ctx)?;

    execute_cached_definition_in_current_workflow(
        start,
        &step_id,
        action,
        resolved_inputs,
        false,
        exec_ctx,
        deps,
        actor,
    )
    .await
}

/// Execute an already-resolved definition through this workflow's recursive DAG walker.
///
/// `install_input_even_when_null` distinguishes the two callers. An ordinary
/// action preserves parent input when its authored `inputs` resolves to null.
/// An outside `execute_definition` request starts a fresh nested execution even
/// when its explicit input is null.
#[allow(clippy::too_many_arguments)]
async fn execute_cached_definition_in_current_workflow(
    start: Instant,
    step_id: &str,
    action: Arc<Definition>,
    resolved_inputs: Value,
    install_input_even_when_null: bool,
    exec_ctx: &mut ExecutionContext,
    deps: &ExecutorDeps,
    actor: &ActorContext,
) -> Result<StepOutput, WorkflowError> {
    // Nested action execution must not clone the whole prior payload just to
    // restore it later. Move-swap the input only when this step authored one.
    let original_input = if install_input_even_when_null || !resolved_inputs.is_null() {
        Some(std::mem::replace(
            &mut exec_ctx.start.input,
            resolved_inputs,
        ))
    } else {
        None
    };


    // Build a sub-Definition from the action's resolved steps + edges.
    // Compile it and execute via the SAME concurrent walker (L088 — one physics).
    let compiled = cached_compiled_definition(action.as_ref(), deps)?;
    let deps_arc = Arc::new(deps.clone());

    // Nested definitions have lexical step scope. Without this boundary, a
    // reusable child whose legacy steps normalize to `step_0`, `step_1`, ...
    // can shadow or overwrite the caller's identically named results.
    if let Some(budget) = deps.outside_access.run_budget() {
        budget.enter_action(exec_ctx.runtime_path.len())?;
    }
    let runtime_path_len = exec_ctx.runtime_path.len();
    // Tag call frames so an authored action named `pages_iter_0` cannot
    // collide with the first iteration of a loop named `pages`.
    exec_ctx.runtime_path.push(serde_json::json!({ "action": step_id, "definition_id": action.id }).to_string());
    exec_ctx.push_scope();
    let execution =
        execute_dag_concurrent(compiled, exec_ctx, deps_arc, actor, &RetryPolicy::default()).await;

    let last_output = if execution.is_ok() { action_answer(action.as_ref(), exec_ctx) } else { Value::Null };
    exec_ctx.pop_scope();
    exec_ctx.runtime_path.truncate(runtime_path_len);

    // Restore original payload
    if let Some(original_input) = original_input {
        exec_ctx.start.input = original_input;
    }

    execution?;

    Ok(StepOutput {
        status: ExecutionStatus::Completed,
        output: last_output,
        error: None,
        duration_ms: start.elapsed().as_millis() as i64,
    })
}

/// What a used workflow (an action, or one loop iteration) answers: the output of the last step that actually ran,
/// preferring a step nothing follows. A branch that was not taken is recorded `skipped` with no output (before Nov 21
/// 2026, completed with a "Skipped" error), so taking the last listed step answered nothing whenever that step was a
/// skipped branch: a
/// workflow that ends `held` then `refused` answered null after `held` ran (Nov 20 2026: the owner's voice step handed
/// a carousel null pages, and the format judge's verdict reached its queue empty).
fn action_answer(action: &Definition, exec_ctx: &ExecutionContext) -> Value {
    let followed: std::collections::HashSet<&str> = action.edges.iter().map(|edge| edge.from.as_str()).collect();
    let ran = |index: usize, step: &crate::domain::types::Step| {
        exec_ctx
            .step_output(&canonical_step_id(step, index))
            .filter(|output| output.status != ExecutionStatus::Skipped)
            .map(|output| output.output.clone())
    };
    let steps = || action.steps.iter().enumerate().rev();
    steps()
        .filter(|(_, step)| !followed.contains(step.id.as_str()))
        .find_map(|(index, step)| ran(index, step))
        .or_else(|| steps().find_map(|(index, step)| ran(index, step)))
        .unwrap_or(Value::Null)
}

/// Evaluate the truthiness of a JSON value.
///
/// - `null` → false
/// - `bool(b)` → b
/// - `number(0)` → false, any other number → true
/// - `string("")` → false, non-empty string → true
/// - `array([])` → false, non-empty array → true
/// - `object({})` → false, non-empty object → true
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i != 0
            } else if let Some(f) = n.as_f64() {
                f != 0.0
            } else {
                true
            }
        }
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

// ============================================================================
// LOOP STEP — iterates over array, sets LoopState per iteration
//
// Supports two execution modes controlled by LoopConfig.parallel:
//
//   parallel: false (default)
//     Sequential iteration — each item `.await`s before the next.
//     Identical to pre-parallel behavior. LoopState is set directly
//     on the shared ExecutionContext per iteration.
//
//   parallel: true (native, cfg(feature = "native"))
//     Concurrent iteration — bounded cooperative fanout via
//     `futures::stream::buffer_unordered`. Each iteration gets its own
//     cloned ExecutionContext with an isolated LoopState. Results are
//     collected into indexed positions (NOT completion order) so the
//     output array always matches the input array order. Every iteration
//     runs to its end; then a real failure ends the loop, else a lane still
//     waiting pauses it, with every lane's ask already made.
//     `LoopConfig.max_concurrency` bounds in-flight work.
//
//   parallel: true (WASM too)
//     The same bounded cooperative fanout: single-threaded is not
//     sequential. Iterations interleave at each await, so every lane's
//     ask is made before any answer is needed.
// ============================================================================

/// Execute a Loop-type step by iterating over a source array.
///
/// The loop source expression is resolved from the execution context.
/// For each item, LoopState is set on the context and the loop body
/// steps (steps with parent_branch matching this step's ID) are executed.
///
/// When `parallel: true` is set in the loop config, iterations execute
/// concurrently on every platform (cooperative async via
/// `futures::stream::buffer_unordered`).
///
/// # Parallel Execution Invariants
///
/// 1. Each iteration gets its own `ExecutionContext` clone — no shared mutable state.
/// 2. Results are indexed by position, not completion order — output[i] corresponds to input[i].
/// 3. Every iteration runs to its end; a real failure then ends the loop, else a waiting lane pauses it.
/// 4. `max_iterations` is enforced identically in both sequential and parallel modes.
/// 5. After all iterations complete, step outputs from each iteration context are merged
///    back into the parent context.
///
/// # Errors
///
/// - `InvalidStep` — Step has `step_type=Loop` but no `loop_config`.
/// - `LoopExecutionFailed` — Source expression did not resolve to a JSON array.
/// - Any error from a loop iteration's action execution propagates as-is.
async fn execute_loop_step(
    step: &Step,
    exec_ctx: &mut ExecutionContext,
    deps: &ExecutorDeps,
    actor: &ActorContext,
) -> Result<StepOutput, WorkflowError> {
    let step_id = step.id.clone();
    let start = Instant::now();

    let loop_config = step
        .loop_config()
        .ok_or_else(|| WorkflowError::InvalidStep {
            step_id: step_id.clone(),
            reason: format!(
                "Step '{}' has kind=loop but no loop_config in config",
                step_id
            ),
            hint: "Loop steps must have source, item_var, \
                   and optional max_iterations in their config"
                .to_string(),
        })?;

    // Parse the loop config ONCE here. Threading these owned values into the
    // iteration bodies eliminates a per-iteration `step.loop_config()` call —
    // each of which cloned the whole `config` Value and re-deserialized LoopConfig.
    // Under the persistent WASM instance that repeated alloc fragments the heap and
    // intermittently traps at LoopConfig::deserialize (P1/P2/P4: derive once, reuse).
    let item_var = loop_config.item_var.clone();
    // The authored concurrency bound is resolved against the default inside the
    // native parallel path (the const is native-only; the WASM path runs sequentially
    // and ignores it). Threading the raw Option keeps the WASM build const-free.
    let max_concurrency = loop_config.max_concurrency;
    let tolerate_item_errors = loop_config.tolerate_item_errors;

    // Branch on for-each mode (source) vs do-while mode (condition).
    //
    // For-each: source template resolves to an array; iterate over each item.
    // Do-while: execute body first, then evaluate condition; loop while truthy.
    let previous_loop_state = exec_ctx.loop_state.clone();
    let loop_outputs_result: Result<Vec<Value>, WorkflowError> = async {
    let loop_outputs = if let Some(ref source_value) = loop_config.source {
        // FOR-EACH MODE — resolve source to array, iterate over items.
        // source_value is Value (binding AST, literal array, or legacy string).
        // BindingResolver is the CSSOT for expression evaluation (Task T10).
        let resolved_source = BindingResolver::resolve_value(source_value, exec_ctx)?;

        let items =
            resolved_source
                .as_array()
                .ok_or_else(|| WorkflowError::LoopExecutionFailed {
                    step_id: step_id.clone(),
                    reason: format!(
                        "Step '{}': loop source {:?} resolved to {} (expected array)",
                        step_id,
                        source_value,
                        value_type_name(&resolved_source)
                    ),
                    hint: "The source expression must resolve to a JSON array; \
                       check the template path returns a list"
                        .to_string(),
                })?;

        let max_iterations = loop_config
            .max_iterations
            .unwrap_or(DEFAULT_MAX_LOOP_ITERATIONS);
        if items.len() > max_iterations as usize {
            return Err(WorkflowError::LoopExecutionFailed {
                step_id: step_id.clone(),
                reason: format!(
                    "Step '{}': source has {} items, exceeding max_iterations {}",
                    step_id,
                    items.len(),
                    max_iterations
                ),
                hint: "Raise the DATA-owned workflow bound or page the source; \
                       Workflow never silently truncates a collection"
                    .to_string(),
            });
        }
        let total = items.len();
        // Reserve the entire known batch before cloning it or starting any body.
        if let Some(budget) = deps.outside_access.run_budget() {
            budget.reserve("loop_iterations", total)?;
        }
        let items_to_iterate: Vec<Value> = items.to_vec();
        let body = LoopBodyExecution {
            step,
            deps,
            actor,
            step_id: &step_id,
            item_var: &item_var,
            items: &items_to_iterate,
            total,
            tolerate_item_errors,
        };

        // Dispatch to parallel or sequential execution based on config and platform.
        //
        // Decision matrix:
        //   parallel: false (any platform)  → execute_loop_sequential
        //   parallel: true  (any platform)  → execute_loop_body_parallel (bounded cooperative fanout)
        if loop_config.parallel {
            execute_loop_body_parallel(exec_ctx, max_concurrency, body).await?
        } else {
            execute_loop_body_sequential(exec_ctx, body).await?
        }
    } else if let Some(ref condition_value) = loop_config.condition {
        // DO-WHILE MODE — execute body first (guaranteed one execution), then
        // evaluate condition. Loop continues while condition is truthy.
        // Bounded by max_iterations for safety.
        // condition_value is Value (binding AST or literal). Resolved through
        // BindingResolver — same CSSOT path as source (L063).
        let max_iterations = loop_config
            .max_iterations
            .unwrap_or(DEFAULT_MAX_LOOP_ITERATIONS) as usize;
        let mut do_while_outputs: Vec<Value> = Vec::new();
        let mut iteration: usize = 0;

        loop {
            if let Some(budget) = deps.outside_access.run_budget() {
                budget.reserve("loop_iterations", 1)?;
            }
            // Set loop state for this iteration. Total is max_iterations since
            // do-while has no known upper bound at start.
            let i = iteration as i32;
            let t = max_iterations as i32;
            exec_ctx.loop_state = Some(LoopState {
                item_var: loop_config.item_var.clone(),
                item: Value::Null,
                index: i,
                total: t,
                first: i == 0,
                last: false, // do-while: last is unknown until condition becomes falsy
                last_output: do_while_outputs.last().cloned().unwrap_or(Value::Null),
            });

            let iter_step_id = format!("{}{}{}", step_id, STEP_SUFFIX_ITER, iteration);

            // Execute the loop body (do-while guarantees at least one execution)
            if !step.definition_id_value().is_null() {
                execute_action_step_inner(step, exec_ctx, deps, actor, &iter_step_id).await?;
            }

            // Capture output for this iteration, through the same innermost-first scopes bindings
            // use: a loop inside a used workflow records its passes in that workflow's scope.
            if let Some(output) = exec_ctx.step_output(&iter_step_id) {
                do_while_outputs.push(output.output.clone());
            } else {
                do_while_outputs.push(Value::Null);
            }
            // The condition reads what this pass returned as `loop.last_output`.
            if let Some(state) = exec_ctx.loop_state.as_mut() {
                state.last_output = do_while_outputs.last().cloned().unwrap_or(Value::Null);
            }

            iteration += 1;

            // Evaluate condition AFTER body — loop continues while truthy. A condition that
            // reads nothing (its selected path is absent or null, or it comes to null) is an
            // error naming the path, never a quiet false that ends the loop after one pass.
            if let Some(path) = BindingResolver::unresolved_select(condition_value, exec_ctx)? {
                return Err(WorkflowError::LoopExecutionFailed {
                    step_id: step_id.clone(),
                    reason: format!(
                        "Step '{}': the loop condition reads {}, which holds nothing after pass {}",
                        step_id, path, iteration
                    ),
                    hint: "A do-while condition sees what the body's pass returned (its last step's output) as \
                           loop.last_output, e.g. loop.last_output.rows.0.held; the body's own steps are not \
                           visible to it by name"
                        .to_string(),
                });
            }
            let resolved_condition = BindingResolver::resolve_value(condition_value, exec_ctx)?;
            if resolved_condition.is_null() {
                return Err(WorkflowError::LoopExecutionFailed {
                    step_id: step_id.clone(),
                    reason: format!("Step '{}': the loop condition came to null after pass {}", step_id, iteration),
                    hint: "A do-while condition must come to a value; read loop.last_output".to_string(),
                });
            }
            if !is_truthy(&resolved_condition) {
                break;
            }
            if iteration >= max_iterations {
                return Err(WorkflowError::LoopExecutionFailed {
                    step_id: step_id.clone(),
                    reason: format!(
                        "Step '{}': condition remained true at max_iterations {}",
                        step_id, max_iterations
                    ),
                    hint:
                        "Raise the DATA-owned workflow bound or make the loop condition converge; \
                           Workflow never reports a capped do-while as complete"
                            .to_string(),
                });
            }
        }

        do_while_outputs
    } else {
        return Err(WorkflowError::InvalidStep {
            step_id: step_id.clone(),
            reason: format!(
                "Step '{}' loop_config has neither 'source' (for-each) nor 'condition' (do-while)",
                step_id
            ),
            hint: "Loop steps must specify either 'source' (for-each mode) or \
                   'condition' (do-while mode)"
                .to_string(),
        });
    };
    Ok(loop_outputs)
    }
    .await;

    // Restore the caller's loop state. Nested loops run inside the active
    // iteration frame; clearing it here breaks the caller's do-while condition.
    exec_ctx.loop_state = previous_loop_state;
    let loop_outputs = loop_outputs_result?;

    Ok(StepOutput {
        status: ExecutionStatus::Completed,
        output: Value::Array(loop_outputs),
        error: None,
        duration_ms: start.elapsed().as_millis() as i64,
    })
}

/// Sequential loop body — executes iterations one-at-a-time.
///
/// This is the original loop execution path. Each iteration `.await`s before
/// the next begins. LoopState is set directly on the shared execution context.
///
/// Used when `parallel: false` (default) or when running on WASM
/// (`#[cfg(not(feature = "native"))]` path for `parallel: true`).
#[derive(Clone, Copy)]
struct LoopBodyExecution<'a> {
    step: &'a Step,
    deps: &'a ExecutorDeps,
    actor: &'a ActorContext,
    step_id: &'a str,
    item_var: &'a str,
    items: &'a [Value],
    total: usize,
    tolerate_item_errors: bool,
}

async fn execute_loop_body_sequential(
    exec_ctx: &mut ExecutionContext,
    body: LoopBodyExecution<'_>,
) -> Result<Vec<Value>, WorkflowError> {
    let LoopBodyExecution {
        step,
        deps,
        actor,
        step_id,
        item_var,
        items,
        total,
        tolerate_item_errors,
    } = body;
    let mut loop_outputs: Vec<Value> = Vec::with_capacity(total);

    for (index, item) in items.iter().enumerate() {
        let i = index as i32;
        let t = total as i32;

        // Set loop state on the execution context. `item_var` is parsed once by the
        // caller and threaded in — never re-deserialized per iteration (heap-fragment fix).
        exec_ctx.loop_state = Some(LoopState {
            item_var: item_var.to_string(),
            item: item.clone(),
            index: i,
            total: t,
            first: i == 0,
            last: i == t - 1,
            last_output: Value::Null,
        });

        // If step has an definition_id, execute it as an action step for each iteration
        if !step.definition_id_value().is_null() {
            match execute_action_step_inner(
                step,
                exec_ctx,
                deps,
                actor,
                &format!("{}{}{}", step_id, STEP_SUFFIX_ITER, index),
            )
            .await
            {
                Ok(()) => {}
                Err(error) if tolerate_item_errors && !matches!(error, WorkflowError::Waiting { .. }) && !deps.outside_access.run_budget().is_some_and(RunBudget::is_exhausted) => {
                    // DATA-owned fault isolation: this iteration failed, but the
                    // loop was configured to keep processing siblings. The item's
                    // output is an error-shaped value — machine-readable, one
                    // query away, never silently dropped.
                    loop_outputs.push(tolerated_error_output(index, item, &error));
                    continue;
                }
                Err(error) => return Err(error),
            }
        }

        // Capture the loop item output (last step output from this iteration)
        let iter_step_id = format!("{}{}{}", step_id, STEP_SUFFIX_ITER, index);
        if let Some(output) = exec_ctx.steps.get(&iter_step_id) {
            loop_outputs.push(output.output.clone());
        } else {
            loop_outputs.push(item.clone());
        }
    }

    Ok(loop_outputs)
}

/// Error-shaped output for a tolerated loop-iteration failure.
///
/// The shape is stable, machine-readable DATA (L090): downstream steps can
/// filter items on the presence of `tolerated_error` (e.g. `op:core.is_null`
/// on `item.tolerated_error`) without any engine change.
/// The item is carried out with the error ON PURPOSE.
///
/// A position is not an identity. A consumer that has to act on the failure
/// (skip this input, retry it next time, tell someone which one broke) can only
/// use an index if it is holding the identical list in the identical order, and
/// that coupling is invisible until the day the two lists differ. The caller
/// already handed the item in; handing it back costs one clone and makes the
/// failure self-describing.
///
/// Found through a real regression: a per-source decode loop marked every source
/// it HANDED to the loop as done, so once failures stopped killing the run, a
/// source that failed every single time was recorded as successfully empty and
/// never retried. The mark could only be withheld by knowing which source
/// failed, and the error did not say.
fn tolerated_error_output(index: usize, item: &Value, error: &WorkflowError) -> Value {
    serde_json::json!({
        "tolerated_error": {
            "iteration_index": index,
            "item": item.clone(),
            "error": error.to_string(),
        }
    })
}

/// Parallel loop body — runs iterations concurrently, on every platform.
///
/// Uses `futures::stream::buffer_unordered` for bounded cooperative concurrency: up to
/// `max_concurrency` iterations are in flight at once. Concurrency is cooperative, not threads, so a single-threaded
/// host (WASM) interleaves the iterations at each await exactly as the DAG walker does (`FuturesUnordered`): every
/// lane's ask is made before any answer is needed. Results are collected by index position so the output array
/// order matches the input array order regardless of completion order.
///
/// Every iteration runs to its own end. Afterwards a real failure (the lowest index) ends the loop with that error;
/// otherwise an iteration still waiting for its answer pauses the loop (the lowest index is the step's wait), so a
/// host sees every lane's waiting ask at once, never one per run. A wait is never tolerated as an item error.
///
/// # Isolation Model
///
/// Each iteration receives a CLONE of the parent `ExecutionContext`. This means:
/// - `loop_state` is set independently per iteration (no cross-contamination)
/// - Step outputs from each iteration are recorded in the iteration's own context
/// - After all iterations complete, step outputs are merged back to the parent
async fn execute_loop_body_parallel(
    exec_ctx: &mut ExecutionContext,
    max_concurrency: Option<usize>,
    body: LoopBodyExecution<'_>,
) -> Result<Vec<Value>, WorkflowError> {
    {
        use futures::stream::{self, StreamExt};

        let LoopBodyExecution {
            step,
            deps,
            actor,
            step_id,
            item_var,
            items,
            total,
            tolerate_item_errors,
        } = body;
        let max_concurrency = max_concurrency
            .unwrap_or(DEFAULT_MAX_LOOP_CONCURRENCY)
            .max(1);

        let iteration_futures = items
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, item_owned)| {
                let mut iter_ctx = exec_ctx.fork_for_delta_capture();
                let i = index as i32;
                let t = total as i32;
                let iter_step_id = format!("{}{}{}", step_id, STEP_SUFFIX_ITER, index);

                // Set isolated loop state for this iteration. `item_var` is parsed once
                // by the caller and threaded in — never re-deserialized per iteration.
                iter_ctx.loop_state = Some(LoopState {
                    item_var: item_var.to_string(),
                    item: item_owned.clone(),
                    index: i,
                    total: t,
                    first: i == 0,
                    last: i == t - 1,
                    last_output: Value::Null,
                });

                async move {
                    // Execute the action step if present
                    if !step.definition_id_value().is_null() {
                        match execute_action_step_inner(
                            step,
                            &mut iter_ctx,
                            deps,
                            actor,
                            &iter_step_id,
                        )
                        .await
                        {
                            Ok(()) => {}
                            Err(error) if tolerate_item_errors && !matches!(error, WorkflowError::Waiting { .. }) && !deps.outside_access.run_budget().is_some_and(RunBudget::is_exhausted) => {
                                // DATA-owned fault isolation: yield an error-shaped
                                // item instead of cancelling sibling iterations.
                                // The iteration's context delta is discarded — a
                                // failed iteration must not commit partial writes.
                                let output = tolerated_error_output(index, &item_owned, &error);
                                let delta = StepHandlerResult::leaf(StepOutput {
                                    output: output.clone(),
                                    status: ExecutionStatus::Completed,
                                    error: Some(error.to_string()),
                                    duration_ms: 0,
                                });
                                return Ok::<(usize, Value, StepHandlerResult), (usize, WorkflowError)>((
                                    index, output, delta,
                                ));
                            }
                            Err(error) => return Err((index, error)),
                        }
                    }

                    // Extract the output for this iteration
                    let output = if let Some(step_output) = iter_ctx.steps.get(&iter_step_id) {
                        step_output.output.clone()
                    } else {
                        item_owned
                    };

                    // Return index for positional ordering, output value, and
                    // all step outputs from this iteration's isolated context
                    let delta = build_context_delta(
                        &iter_ctx,
                        StepOutput {
                            output: output.clone(),
                            status: ExecutionStatus::Completed,
                            error: None,
                            duration_ms: 0,
                        },
                    );

                    Ok::<(usize, Value, StepHandlerResult), (usize, WorkflowError)>((index, output, delta))
                }
            });

        // Run every iteration, bounded by max_concurrency, each to its own end.
        let mut finished: Vec<(usize, Result<(Value, StepHandlerResult), WorkflowError>)> = stream::iter(iteration_futures)
            .buffer_unordered(max_concurrency)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(|result| match result {
                Ok((index, output, delta)) => (index, Ok((output, delta))),
                Err((index, error)) => (index, Err(error)),
            })
            .collect();
        finished.sort_by_key(|(index, _)| *index);
        let failed = |waiting: bool| finished.iter().position(|(_, result)| matches!(result, Err(error) if matches!(error, WorkflowError::Waiting { .. }) == waiting));
        if let Some(at) = failed(false).or_else(|| failed(true)) {
            let (_, result) = finished.swap_remove(at);
            return Err(result.err().expect("an error was found at this position"));
        }
        let results: Vec<(usize, Value, StepHandlerResult)> = finished
            .into_iter()
            .map(|(index, result)| {
                let (output, delta) = result.expect("every error ended the loop above");
                (index, output, delta)
            })
            .collect();

        // Collect outputs by index position (NOT completion order).
        let mut loop_outputs: Vec<Value> = vec![Value::Null; total];
        for (index, output, delta) in results {
            for write in delta.writes {
                exec_ctx.push_write(write);
            }
            for key in delta.cleared_raw_step_bytes {
                exec_ctx.clear_raw_step_bytes(&key);
            }
            for (key, value) in delta.raw_step_bytes {
                exec_ctx.record_raw_step_bytes(key, value);
            }
            for (key, value) in delta.runtime_outputs {
                exec_ctx.runtime_outputs.insert(key.clone(), value);
                exec_ctx.dirty_runtime_outputs.insert(key);
            }
            loop_outputs[index] = output;
        }

        Ok(loop_outputs)
    }
}

/// Inner helper: execute an action step for a loop iteration.
///
/// Uses recursive `execute_dag_concurrent` — same physics at every nesting level.
/// Sub-steps within an action benefit from the same parallelism and subgraph
/// skipping as top-level steps. Zero sequential shadows (L088 CSSOT).
async fn execute_action_step_inner(
    step: &Step,
    exec_ctx: &mut ExecutionContext,
    deps: &ExecutorDeps,
    actor: &ActorContext,
    iter_step_id: &str,
) -> Result<(), WorkflowError> {
    // Resolve the same literal-or-DATA-selected identity accepted by ordinary
    // action steps. Testing `definition_id()` here used to silently turn every
    // binding-selected loop into a map that only echoed its source items.
    let resolved_definition_id =
        BindingResolver::resolve_value(step.definition_id_value(), exec_ctx)?;
    let definition_id = resolved_definition_id
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| WorkflowError::InvalidStep {
            step_id: iter_step_id.to_string(),
            reason: format!(
                "Loop/parallel step '{}' definition_id must resolve to a non-empty string; got {}",
                iter_step_id, resolved_definition_id
            ),
            hint: "Set definition_id to a literal or an admitted binding-selected definition"
                .to_string(),
        })?;
    if step.definition_id().is_none() && !admitted(&step.definition_refs(), definition_id) {
        return Err(WorkflowError::InvalidStep {
            step_id: iter_step_id.to_string(),
            reason: format!(
                "Loop/parallel step '{}' resolved definition_id '{}' outside definition_refs",
                iter_step_id, definition_id
            ),
            hint: "Add the selected definition id to config.definition_refs".to_string(),
        });
    }

    let action = resolve_sub_definition(deps, definition_id)?.ok_or_else(|| {
        WorkflowError::DefinitionNotFound {
            definition_id: definition_id.to_string(),
            reason: format!(
                "Definition '{}' referenced by loop/parallel iteration '{}' was not found: {}",
                definition_id, iter_step_id, LOOKED_IN
            ),
            hint: LOOK_HINT.to_string(),
        }
    })?;

    // Resolve step inputs
    let resolved_inputs = BindingResolver::resolve_value(step.inputs(), exec_ctx)?;

    let original_input = if !resolved_inputs.is_null() {
        Some(std::mem::replace(
            &mut exec_ctx.start.input,
            resolved_inputs,
        ))
    } else {
        None
    };


    // Build sub-Definition and execute via recursive concurrent walker (L088 — one physics).
    // Same execution model at every nesting level: compile → concurrent DAG walker.
    let compiled = cached_compiled_definition(action.as_ref(), deps)?;
    let deps_arc = Arc::new(deps.clone());

    if let Some(budget) = deps.outside_access.run_budget() {
        budget.enter_action(exec_ctx.runtime_path.len())?;
    }
    let runtime_path_len = exec_ctx.runtime_path.len();
    exec_ctx.runtime_path.push(serde_json::json!({ "iteration": iter_step_id, "definition_id": action.id }).to_string());
    exec_ctx.push_scope();
    let execution =
        execute_dag_concurrent(compiled, exec_ctx, deps_arc, actor, &RetryPolicy::default()).await;

    let last_output = if execution.is_ok() { action_answer(action.as_ref(), exec_ctx) } else { Value::Null };
    exec_ctx.pop_scope();
    exec_ctx.runtime_path.truncate(runtime_path_len);

    if let Some(original_input) = original_input {
        exec_ctx.start.input = original_input;
    }

    execution?;

    record_step_output(
        exec_ctx,
        iter_step_id,
        StepOutput {
            output: last_output,
            status: ExecutionStatus::Completed,
            error: None,
            duration_ms: 0,
        },
    );

    Ok(())
}

// ============================================================================
// WAIT STEP — temporal primitives: T1 (Until/Duration), T2 (Event), T3 (Race)
// ============================================================================

/// Execute a Wait-type step using the 3 irreducible temporal primitives.
///
/// Parses `WaitCondition` from `step.inputs()`. Supports both the canonical
/// `{ "type": "..." }` format and the legacy `{ "duration_secs": N }` format
/// for backward compatibility.
///
/// ## Temporal Primitives Dispatched
///
/// - **T1 `Duration { secs }`** — converted to `Until(now + secs)` for durability,
///   then waits via `tokio::time::sleep_until` (native) or no-op (WASM).
/// - **T1 `Until { datetime }`** — waits until absolute wall-clock time. If the
///   target is in the past, resolves immediately (idempotent).
/// - **T2 `Event { event_type, filter }`** — asked of outside work (below): the
///   engine sees no events, so it never completes one by itself.
/// - **T3 `Race { conditions }`** — evaluates children concurrently (native) via
///   `tokio::select!` macro over pinned futures. First to resolve wins; returns
///   `winner_index` and the winning condition's result in step output.
///
/// ## Step Output
///
/// `{ "condition": <type>, "winner_index"?: N, "waited_secs"?: N, "target_datetime"?: "..." }`
///
/// ## A wait the engine cannot hold where it runs
///
/// A build without timers (the Worker's WASM) holds only a wait that is already
/// over: no seconds, a time already passed, or a race with one of those. No
/// build sees events. Every other wait is asked of outside work under the name
/// [`WAIT_ASK`] (payload `{ "wait": <condition> }`, context `{ "step_id", "_runtime_identity" }`),
/// the way an ask step is: an answer ends the wait (`{ "condition", "answered" }`),
/// and `not-answered-yet` pauses the run there, so no later step runs before the
/// wait is over. The host that owns time and events answers it.
async fn execute_wait_step(
    step: &Step,
    exec_ctx: &ExecutionContext,
    deps: &ExecutorDeps,
) -> Result<StepOutput, WorkflowError> {
    let start = Instant::now();

    // Wait config: either config["wait_condition"] (from Step::wait constructor)
    // or config itself (if flat format like {"duration_secs": N})
    let wait_data = step.config.get("wait_condition").unwrap_or(&step.config);
    let resolved_wait_data = BindingResolver::resolve_value(wait_data, exec_ctx)?;
    let condition = parse_wait_condition(&resolved_wait_data);
    let output = if held_here(&condition) {
        dispatch_wait_condition(&condition).await?
    } else {
        ask_outside_to_wait(step, &condition, exec_ctx, deps).await?
    };

    Ok(StepOutput {
        status: ExecutionStatus::Completed,
        output,
        error: None,
        duration_ms: start.elapsed().as_millis() as i64,
    })
}

/// The name a wait this build cannot hold is asked of outside work under.
pub const WAIT_ASK: &str = "wait";

/// Whether this build holds the wait itself: a native build on its own timers,
/// any build when the wait is already over. An event is never held here.
fn held_here(condition: &WaitCondition) -> bool {
    match condition {
        WaitCondition::Event { .. } => false,
        WaitCondition::Race { conditions } if cfg!(feature = "native") => conditions.iter().all(held_here),
        WaitCondition::Race { conditions } => conditions.iter().any(over_now),
        other => cfg!(feature = "native") || over_now(other),
    }
}

/// A wait that is over as it starts: no seconds, or a time already passed. A
/// time that does not parse counts as over so its dispatch refuses it.
fn over_now(condition: &WaitCondition) -> bool {
    match condition {
        WaitCondition::Duration { secs } => *secs == 0,
        WaitCondition::Until { datetime } => chrono::DateTime::parse_from_rfc3339(datetime)
            .map(|target| target.with_timezone(&Utc) <= Utc::now())
            .unwrap_or(true),
        _ => false,
    }
}

/// Asks outside work to end a wait this build cannot hold (see `execute_wait_step`).
async fn ask_outside_to_wait(
    step: &Step,
    condition: &WaitCondition,
    exec_ctx: &ExecutionContext,
    deps: &ExecutorDeps,
) -> Result<serde_json::Value, WorkflowError> {
    let encode = |value: serde_json::Value| bytes::Bytes::from(serde_json::to_vec(&value).unwrap_or_default());
    let mut runtime_identity = exec_ctx.runtime_path.clone();
    runtime_identity.push(step.id.clone());
    let reply = deps
        .outside_access
        .ask(
            WAIT_ASK,
            &deps.dispatch_partition,
            encode(serde_json::json!({ "wait": condition })),
            Some(encode(serde_json::json!({ "step_id": step.id, "_runtime_identity": runtime_identity }))),
        )
        .await
        .map_err(|reason| WorkflowError::PrimitiveDispatchFailed {
            primitive: format!("ask:{}", WAIT_ASK),
            reason,
            hint: "The host running this workflow must answer waits it cannot hold by itself.".to_string(),
        })?;
    let answer: serde_json::Value = serde_json::from_slice(&reply).map_err(|e| WorkflowError::StepExecutionFailed {
        step_id: step.id.clone(),
        reason: format!("The answer to a wait is not JSON: {}", e),
        hint: "Answer a wait with a JSON value.".to_string(),
    })?;
    if answer.get("$kind").and_then(serde_json::Value::as_str) == Some(crate::executor::context::NOT_ANSWERED_YET) {
        return Err(WorkflowError::Waiting { step_id: step.id.clone(), detail: answer });
    }
    let kind = serde_json::to_value(condition).ok().and_then(|value| value.get("type").cloned()).unwrap_or(serde_json::Value::Null);
    Ok(serde_json::json!({ "condition": kind, "answered": answer }))
}

/// Parse a `WaitCondition` from step inputs.
///
/// Tries the canonical `WaitCondition` serde format first, then falls back
/// to the legacy `{ "duration_secs": N }` format for backward compatibility.
/// Returns `WaitCondition::Duration { secs: 0 }` (no-op) if neither format matches.
fn parse_wait_condition(inputs: &serde_json::Value) -> WaitCondition {
    // Try canonical WaitCondition format: { "type": "until"|"duration"|"event"|"race", ... }
    if let Ok(condition) = serde_json::from_value::<WaitCondition>(inputs.clone()) {
        return condition;
    }
    // Legacy format: { "duration_secs": N }
    if let Some(secs) = inputs.get("duration_secs").and_then(|v| v.as_u64()) {
        return WaitCondition::Duration { secs };
    }
    WaitCondition::Duration {
        secs: DEFAULT_WAIT_SECS_WHEN_UNSPECIFIED,
    }
}

/// Dispatch on `WaitCondition` variant and return the step output JSON.
///
/// Returns a `BoxFuture` to allow recursive dispatch (T3 Race evaluates children
/// via this same function). The `Send` bound is required for tokio's multi-threaded
/// scheduler on native; met because all captured data is `Send`.
///
/// All timer operations are cfg-gated: native uses tokio timers, WASM no-ops.
fn dispatch_wait_condition(
    condition: &WaitCondition,
) -> futures::future::BoxFuture<'_, Result<serde_json::Value, WorkflowError>> {
    use futures::FutureExt;
    async move {
        match condition {
            WaitCondition::Duration { secs } => {
                // Convert to absolute time for durability (T1 canonical form)
                let target = Utc::now() + chrono::Duration::seconds(*secs as i64);
                wait_until_datetime_impl(&target).await;
                Ok(serde_json::json!({
                    "condition": "duration",
                    "waited_secs": secs,
                    "target_datetime": target.to_rfc3339(),
                }))
            }
            WaitCondition::Until { datetime } => {
                let target = chrono::DateTime::parse_from_rfc3339(datetime)
                    .map_err(|e| WorkflowError::InvalidStep {
                        step_id: "wait".to_string(),
                        reason: format!("Invalid RFC 3339 datetime '{}': {}", datetime, e),
                        hint: "Provide datetime in ISO 8601 / RFC 3339 format, e.g. '2026-03-01T09:00:00Z'".to_string(),
                    })?
                    .with_timezone(&Utc);
                wait_until_datetime_impl(&target).await;
                Ok(serde_json::json!({
                    "condition": "until",
                    "target_datetime": target.to_rfc3339(),
                }))
            }
            WaitCondition::Event { event_type, .. } => {
                // The engine sees no events: execute_wait_step asks outside work for these, so reaching here is a
                // wait that would otherwise pass without its event.
                Err(WorkflowError::InvalidStep {
                    step_id: "wait".to_string(),
                    reason: format!("A wait for the event '{}' is never held by the engine itself", event_type),
                    hint: "Run the wait step, which asks outside work for the event.".to_string(),
                })
            }
            WaitCondition::Race { conditions } => {
                dispatch_wait_race(conditions).await
            }
        }
    }
    .boxed()
}

/// Suspend until the target datetime (T1 canonical implementation).
///
/// If target is in the past, returns immediately (idempotent — surviving-restart
/// behavior: a workflow resumed after a crash sees its target in the past and
/// continues without re-sleeping).
///
/// On WASM: no-op (no tokio timer support).
async fn wait_until_datetime_impl(target: &chrono::DateTime<Utc>) {
    #[cfg(feature = "native")]
    {
        let now = Utc::now();
        if *target > now {
            let delta = (*target - now)
                .to_std()
                .unwrap_or(std::time::Duration::ZERO);
            tokio::time::sleep(delta).await;
        }
        // Target in the past: immediate return (idempotent)
    }
    #[cfg(not(feature = "native"))]
    {
        let _ = target; // WASM: no-op
    }
}

/// Dispatch T3 Race: evaluate all conditions concurrently, first wins.
///
/// On native: uses `tokio::select!` over a dynamic set of pinned futures.
/// Returns `{ "condition": "race", "winner_index": N, "winner_result": {...} }`.
///
/// On WASM: only reached when a condition is already over (execute_wait_step
/// asks outside work otherwise); the first such condition wins.
async fn dispatch_wait_race(
    conditions: &[WaitCondition],
) -> Result<serde_json::Value, WorkflowError> {
    if conditions.is_empty() {
        return Err(WorkflowError::InvalidStep {
            step_id: "wait".to_string(),
            reason: "Race requires at least one condition".to_string(),
            hint: "Add at least one WaitCondition to the Race conditions array".to_string(),
        });
    }

    #[cfg(feature = "native")]
    {
        use futures::future::BoxFuture;
        use futures::FutureExt;

        // Build a vec of (index, future) pairs
        let futures_with_index: Vec<(
            usize,
            BoxFuture<'_, Result<serde_json::Value, WorkflowError>>,
        )> = conditions
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let fut: BoxFuture<'_, Result<serde_json::Value, WorkflowError>> =
                    dispatch_wait_condition(c).boxed();
                (i, fut)
            })
            .collect();

        // Extract just the futures for select_all
        let (indices, futs): (Vec<usize>, Vec<_>) = futures_with_index.into_iter().unzip();

        let (result, winner_pos, _remaining) = futures::future::select_all(futs).await;
        let winner_index = indices[winner_pos];

        Ok(serde_json::json!({
            "condition": "race",
            "winner_index": winner_index,
            "winner_result": result?,
        }))
    }
    #[cfg(not(feature = "native"))]
    {
        // Without timers only a condition already over can win (execute_wait_step asks outside work otherwise).
        let winner_index = conditions.iter().position(over_now).unwrap_or(0);
        let result = dispatch_wait_condition(&conditions[winner_index]).await?;
        Ok(serde_json::json!({
            "condition": "race",
            "winner_index": winner_index,
            "winner_result": result,
        }))
    }
}

// ============================================================================
// HELPERS
// ============================================================================

/// Generate a unique time-ordered ID for workflow instances.
fn ulid_placeholder() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Get the current timestamp as an ISO-compatible string.
fn current_timestamp() -> String {
    use web_time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

/// Human-readable type name for a serde_json::Value (used in error messages).
fn value_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::errors::WorkflowResult;
    use crate::domain::types::{Definition, PendingWrite, Step, TriggerType, WaitCondition};
    use crate::domain::DefinitionStore;
    use crate::CachedDefinitionStore;
    use execution_types::{ProcessOutputArtifact, ProcessOutputStorage, ProcessTermination};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    // ========================================================================
    // TestDefinitionStore — unified store for testing (implements DefinitionStore)
    // ========================================================================

    struct TestDefinitionStore {
        definitions: std::collections::HashMap<String, Definition>,
    }

    impl TestDefinitionStore {
        fn new() -> Self {
            Self {
                definitions: std::collections::HashMap::new(),
            }
        }

        fn register(&mut self, def: Definition) {
            self.definitions.insert(def.id.clone(), def);
        }
    }

    impl DefinitionStore for TestDefinitionStore {
        fn get_by_id(&self, id: &str, _partition_key: &str) -> WorkflowResult<Option<Definition>> {
            Ok(self.definitions.get(id).cloned())
        }

        fn get_by_slug(
            &self,
            slug: &str,
            _partition_key: &str,
        ) -> WorkflowResult<Option<Definition>> {
            Ok(self.definitions.values().find(|d| d.name == slug).cloned())
        }

        fn get_active(
            &self,
            _partition_key: &str,
            kind: Option<&str>,
        ) -> WorkflowResult<Vec<Definition>> {
            Ok(self
                .definitions
                .values()
                .filter(|d| d.is_active)
                .filter(|d| kind.is_none_or(|k| d.kind == k))
                .cloned()
                .collect())
        }

        fn get_by_trigger(
            &self,
            trigger_source: &str,
            _partition_key: &str,
        ) -> WorkflowResult<Vec<Definition>> {
            Ok(self
                .definitions
                .values()
                .filter(|d| d.trigger_source == trigger_source && d.is_active)
                .cloned()
                .collect())
        }
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    fn make_executor() -> AsyncWorkflowExecutor {
        AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            std::sync::Arc::new(NoOpOutsideAccess),
            std::sync::Arc::new(TestDefinitionStore::new()),
            crate::executor::context::test_product_word_ids(),
        )
    }

    fn make_executor_with_store(store: TestDefinitionStore) -> AsyncWorkflowExecutor {
        AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            std::sync::Arc::new(NoOpOutsideAccess),
            Arc::new(store),
            crate::executor::context::test_product_word_ids(),
        )
    }

    fn make_executor_with_store_and_access(
        store: TestDefinitionStore,
        outside_access: std::sync::Arc<dyn crate::executor::context::OutsideAccess>,
    ) -> AsyncWorkflowExecutor {
        AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            outside_access,
            Arc::new(store),
            crate::executor::context::test_product_word_ids(),
        )
    }

    fn make_start() -> StartData {
        StartData {
            start_type: "test_event".to_string(),
            input: json!({"key": "value"}),
            started_at: "1234567890".to_string(),
            start_id: Some("evt-001".to_string()),
        }
    }

    fn make_actor() -> ActorContext {
        ActorContext::default()
    }

    fn make_action(id: &str, steps: Vec<Step>) -> Definition {
        Definition {
            id: id.to_string(),
            partition_key: "partition:test".to_string(),
            name: id.to_string(),
            description: format!("Test action {}", id),
            input_schema: json!({}),
            steps,
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        }
    }

    fn make_leaf_step() -> Step {
        Step::ask("test.owner", json!({"op": "test"}))
    }

    fn make_workflow(id: &str, steps: Vec<Step>) -> Definition {
        Definition {
            id: id.to_string(),
            partition_key: "partition:test".to_string(),
            name: id.to_string(),
            description: format!("Test workflow {}", id),
            trigger_type: TriggerType::Event,
            trigger_source: "test_event".to_string(),
            is_active: true,
            steps,
            version: 1,
            ..Default::default()
        }
    }

    fn make_action_step(order: i32, definition_id: &str) -> Step {
        Step::action(definition_id, json!({})).with_id(&format!("ws-{}", order))
    }

    struct RuntimeIdentityAccess(Mutex<Vec<Value>>);

    #[async_trait::async_trait]
    impl crate::executor::context::OutsideAccess for RuntimeIdentityAccess {
        async fn ask(
            &self,
            _name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            _payload: bytes::Bytes,
            context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            if let Some(context) = context {
                self.0.lock().unwrap().push(
                    serde_json::from_slice(&context).map_err(|error| error.to_string())?,
                );
            }
            Ok(std::sync::Arc::from(b"{}".to_vec().into_boxed_slice()))
        }

        async fn read(
            &self,
            _from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<crate::executor::context::DirectReadResult, String> {
            Err("runtime identity test does not read".into())
        }
    }

    #[tokio::test]
    async fn nested_loop_ask_runtime_identity_is_distinct_and_stable_on_cold_replay() {
        let make_store = || {
            let mut store = TestDefinitionStore::new();
            let mut leaf = make_action("identity-leaf", vec![make_leaf_step().with_id("slot")]);
            leaf.steps[0].config["context"] = json!({
                "step_id": "slot",
                "title": "Authored title"
            });
            store.register(leaf);
            store.register(make_action(
                "identity-body",
                vec![make_action_step(0, "identity-leaf")],
            ));
            let mut loop_step = Step::loop_step(json!({
                "definition_id": "identity-body",
                "source": {"$kind":"binding","select":{"from":"start","path":"input.items"}},
                "item_var": "item",
                "max_iterations": 10,
                "parallel": false
            }));
            loop_step.id = "pages".into();
            store.register(make_workflow("wf-runtime-identity", vec![loop_step]));
            store
        };
        let identities = Arc::new(RuntimeIdentityAccess(Mutex::new(Vec::new())));
        let first = make_executor_with_store_and_access(make_store(), identities.clone())
            .execute_workflow(
                "wf-runtime-identity",
                StartData {
                    start_type: "test_event".into(),
                    input: json!({"items": ["a", "b"]}),
                    started_at: "2026-10-14T00:00:00Z".into(),
                    start_id: None,
                },
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("first run executes");
        let first_identities = identities.0.lock().unwrap().clone();
        identities.0.lock().unwrap().clear();

        let replay = make_executor_with_store_and_access(make_store(), identities.clone())
            .execute_workflow(
                "wf-runtime-identity",
                StartData {
                    start_type: "test_event".into(),
                    input: json!({"items": ["a", "b"]}),
                    started_at: "2026-10-14T00:00:00Z".into(),
                    start_id: None,
                },
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("cold replay executes");
        let replay_identities = identities.0.lock().unwrap().clone();

        assert_eq!(first.status, ExecutionStatus::Completed);
        assert_eq!(replay.status, ExecutionStatus::Completed);
        assert_eq!(first_identities, replay_identities);
        assert_eq!(first_identities.len(), 2);
        assert_eq!(first_identities[0]["step_id"], json!("slot"));
        assert_eq!(first_identities[0]["title"], json!("Authored title"));
        assert_ne!(
            first_identities[0]["_runtime_identity"],
            first_identities[1]["_runtime_identity"]
        );
        assert_eq!(
            first_identities[0]["_runtime_identity"][0],
            json!(json!({ "iteration": "pages_iter_0", "definition_id": "identity-body" }).to_string())
        );
        assert_eq!(
            first_identities[0]["_runtime_identity"][1],
            json!(json!({ "action": "ws-0", "definition_id": "identity-leaf" }).to_string())
        );
        assert_eq!(first_identities[0]["_runtime_identity"][2], json!("slot"));
    }

    #[tokio::test]
    async fn runtime_identity_distinguishes_authored_action_id_from_generated_loop_iteration() {
        let mut store = TestDefinitionStore::new();
        let mut leaf = make_action("frame-leaf", vec![make_leaf_step().with_id("review")]);
        leaf.steps[0].config["context"] = json!({"step_id": "review"});
        store.register(leaf);
        let mut loop_step = Step::loop_step(json!({
            "definition_id": "frame-leaf",
            "source": ["one"],
            "item_var": "item",
            "max_iterations": 2,
            "parallel": false
        }));
        loop_step.id = "pages".into();
        let action = Step::action("frame-leaf", json!({})).with_id("pages_iter_0");
        store.register(make_workflow("wf-frame-collision", vec![loop_step, action]));
        let access = Arc::new(RuntimeIdentityAccess(Mutex::new(Vec::new())));

        let run = make_executor_with_store_and_access(store, access.clone())
            .execute_workflow(
                "wf-frame-collision",
                StartData {
                    start_type: "test_event".into(),
                    input: json!({}),
                    started_at: "2026-10-14T00:00:00Z".into(),
                    start_id: None,
                },
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("both child calls execute");

        assert_eq!(run.status, ExecutionStatus::Completed);
        let calls = access.0.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_ne!(
            calls[0]["_runtime_identity"],
            calls[1]["_runtime_identity"],
            "an authored action and a generated loop iteration need distinct durable identities"
        );
    }

    #[tokio::test]
    async fn nested_wait_runtime_identity_is_stable_across_cold_replay() {
        let make_store = || {
            let mut store = TestDefinitionStore::new();
            let mut wait = Step::wait(json!({
                "type": "event",
                "event_type": "post.release"
            }));
            wait.id = "hold".into();
            store.register(make_action("wait-body", vec![wait]));
            store.register(make_workflow(
                "wf-nested-wait-identity",
                vec![make_action_step(0, "wait-body")],
            ));
            store
        };
        let access = Arc::new(RuntimeIdentityAccess(Mutex::new(Vec::new())));

        for _ in 0..2 {
            let run = make_executor_with_store_and_access(make_store(), access.clone())
                .execute_workflow(
                    "wf-nested-wait-identity",
                    StartData {
                        start_type: "test_event".into(),
                        input: json!({}),
                        started_at: "2026-10-14T00:00:00Z".into(),
                        start_id: None,
                    },
                    make_actor(),
                    &RetryPolicy::default(),
                )
                .await
                .expect("nested event wait executes");
            assert_eq!(run.status, ExecutionStatus::Completed);
        }

        let asks = access.0.lock().unwrap();
        assert_eq!(asks.len(), 2);
        assert_eq!(asks[0]["step_id"], json!("hold"));
        assert_eq!(asks[0]["_runtime_identity"], asks[1]["_runtime_identity"]);
        assert_eq!(
            asks[0]["_runtime_identity"],
            json!([
                json!({ "action": "ws-0", "definition_id": "wait-body" }).to_string(),
                "hold"
            ])
        );
    }

    #[test]
    fn resolved_definition_steps_replaces_placeholders_structurally() {
        let mut action = make_action(
            "action:placeholder",
            vec![Step::ask(
                "test.owner",
                json!({
                    "text": "prefix $label suffix",
                    "$field": {
                        "literal": "$label",
                        "number": 7,
                        "items": ["$label"]
                    }
                }),
            )],
        );
        action
            .extra_properties
            .insert("label".to_string(), "quoted \"value\"\nnext".to_string());
        action
            .extra_properties
            .insert("field".to_string(), "dynamic_key".to_string());

        let steps = resolved_definition_steps(&action);

        assert_eq!(
            steps[0].config,
            json!({
                "name": "test.owner",
                "input": {
                    "text": "prefix quoted \"value\"\nnext suffix",
                    "dynamic_key": {
                        "literal": "quoted \"value\"\nnext",
                        "number": 7,
                        "items": ["quoted \"value\"\nnext"]
                    }
                }
            })
        );
    }

    // ========================================================================
    // Test 1: Workflow not found returns error
    // ========================================================================

    #[tokio::test]
    async fn test_workflow_not_found() {
        let executor = make_executor();
        let _store = TestDefinitionStore::new();

        let start = make_start();
        let actor = make_actor();
        let policy = RetryPolicy::default();

        let result = executor
            .execute_workflow("nonexistent", start, actor, &policy)
            .await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            matches!(err, WorkflowError::WorkflowNotFound { .. }),
            "Expected WorkflowNotFound, got: {:?}",
            err
        );
    }

    // ========================================================================
    // Test 2: Inactive workflow returns error
    // ========================================================================

    #[tokio::test]
    async fn test_inactive_workflow_rejected() {
        let mut store = TestDefinitionStore::new();
        let mut workflow = make_workflow("wf-1", vec![]);
        workflow.is_active = false;
        store.register(workflow);
        let executor = make_executor_with_store(store);

        let start = make_start();
        let actor = make_actor();
        let policy = RetryPolicy::default();

        let result = executor
            .execute_workflow("wf-1", start, actor, &policy)
            .await;

        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            WorkflowError::DefinitionNotActive { .. }
        ));
    }

    // ========================================================================
    // Test 3: Empty workflow completes successfully
    // ========================================================================

    #[tokio::test]
    async fn test_empty_workflow_completes() {
        let mut store = TestDefinitionStore::new();
        store.register(make_workflow("wf-empty", vec![]));
        let executor = make_executor_with_store(store);

        let start = make_start();
        let actor = make_actor();
        let policy = RetryPolicy::default();

        let result = executor
            .execute_workflow("wf-empty", start, actor, &policy)
            .await;

        let instance = result.expect("empty workflow should succeed");
        assert_eq!(instance.status, ExecutionStatus::Completed);
        assert!(instance.completed_at.is_some());
        assert!(instance.error_message.is_none());
    }

    // ========================================================================
    // Test 4: Action step executes via StepExecutor
    // ========================================================================

    #[tokio::test]
    async fn test_action_step_executes() {
        let mut store = TestDefinitionStore::new();
        let action = make_action("action-1", vec![make_leaf_step()]);
        store.register(action.clone());
        let workflow = make_workflow("wf-action", vec![make_action_step(0, "action-1")]);
        store.register(workflow);
        let executor = make_executor_with_store(store);

        let start = make_start();
        let actor = make_actor();
        let policy = RetryPolicy::default();

        let instance = executor
            .execute_workflow("wf-action", start, actor, &policy)
            .await
            .expect("action workflow should succeed");

        assert_eq!(
            instance.status,
            ExecutionStatus::Completed,
            "Expected Completed but got {:?}. Error: {:?}",
            instance.status,
            instance.error_message
        );
        // The action step output should be recorded (key = step.id)
        assert!(instance.execution_context.steps.contains_key("ws-0"));
    }

    #[tokio::test]
    async fn nested_action_implicit_step_ids_are_lexically_scoped() {
        let mut store = TestDefinitionStore::new();
        let child = make_action(
            "action:child-with-implicit-ids",
            vec![
                Step::return_value(json!({"child": "local"})),
                Step::return_value(json!({
                    "$kind": "binding",
                    "select": {
                        "from": "steps",
                        "key": "step_0",
                        "path": "output.child"
                    }
                })),
            ],
        );
        store.register(child);

        let workflow = make_workflow(
            "wf:nested-action-lexical-step-scope",
            vec![
                Step::return_value(json!({"parent": "keep"})),
                Step::action("action:child-with-implicit-ids", json!({})).with_id("call_child"),
                Step::return_value(json!({
                    "$kind": "binding",
                    "select": {
                        "from": "steps",
                        "key": "step_0",
                        "path": "output.parent"
                    }
                }))
                .with_id("return_parent"),
            ],
        );
        store.register(workflow);
        let executor = make_executor_with_store(store);

        let instance = executor
            .execute_workflow(
                "wf:nested-action-lexical-step-scope",
                make_start(),
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("nested action with colliding implicit IDs should succeed");

        assert_eq!(
            instance.execution_context.steps["step_0"].output,
            json!({"parent": "keep"})
        );
        assert_eq!(
            instance.execution_context.steps["call_child"].output,
            json!("local")
        );
        assert_eq!(
            instance.execution_context.steps["return_parent"].output,
            json!("keep")
        );
        assert!(instance.execution_context.scope_stack.is_empty());
    }

    #[tokio::test]
    async fn data_selected_action_executes_one_prehydrated_candidate() {
        let mut store = TestDefinitionStore::new();
        store.register(make_action(
            "action:static-publication",
            vec![Step::return_value(json!({"selected": "static"})).with_id("return")],
        ));
        store.register(make_action(
            "action:interactive-publication",
            vec![Step::return_value(json!({"selected": "interactive"})).with_id("return")],
        ));
        let dynamic_step: Step = serde_json::from_value(json!({
            "id": "publish",
            "kind": "action",
            "config": {
                "definition_id": {
                    "$kind": "binding",
                    "select": {"from": "input", "path": "publication_action"}
                },
                "definition_refs": [
                    "action:static-publication",
                    "action:interactive-publication"
                ],
                "inputs": {}
            }
        }))
        .expect("DATA-selected action step should deserialize");
        let workflow = make_workflow("wf:data-selected-action", vec![dynamic_step]);
        assert_eq!(
            workflow.referenced_definition_ids(),
            vec![
                "action:static-publication",
                "action:interactive-publication"
            ],
            "the owning slot must be able to pre-hydrate every DATA candidate"
        );
        store.register(workflow);
        let executor = make_executor_with_store(store);
        let start = StartData {
            start_type: "test_event".to_string(),
            input: json!({"publication_action": "action:interactive-publication"}),
            started_at: "1234567890".to_string(),
            start_id: Some("evt-dynamic-action".to_string()),
        };

        let instance = executor
            .execute_workflow(
                "wf:data-selected-action",
                start,
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("the DATA-selected action workflow should execute");

        assert_eq!(instance.status, ExecutionStatus::Completed);
        assert_eq!(
            instance.execution_context.steps["publish"].output,
            json!({"selected": "interactive"})
        );
    }

    #[tokio::test]
    async fn data_selected_action_rejects_definition_outside_prehydrated_candidates() {
        let mut store = TestDefinitionStore::new();
        store.register(make_action(
            "action:not-admitted",
            vec![Step::return_value(json!({"escaped": true})).with_id("return")],
        ));
        let dynamic_step: Step = serde_json::from_value(json!({
            "id": "publish",
            "kind": "action",
            "config": {
                "definition_id": {
                    "$kind": "binding",
                    "select": {"from": "input", "path": "publication_action"}
                },
                "definition_refs": ["action:admitted"],
                "inputs": {}
            }
        }))
        .expect("DATA-selected action step should deserialize");
        store.register(make_workflow(
            "wf:data-selected-action-deny",
            vec![dynamic_step],
        ));
        let executor = make_executor_with_store(store);
        let start = StartData {
            start_type: "test_event".to_string(),
            input: json!({"publication_action": "action:not-admitted"}),
            started_at: "1234567890".to_string(),
            start_id: Some("evt-dynamic-action-deny".to_string()),
        };

        let instance = executor
            .execute_workflow(
                "wf:data-selected-action-deny",
                start,
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("workflow failures are returned as failed instances");

        assert_eq!(instance.status, ExecutionStatus::Failed);
        assert!(instance
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("outside definition_refs")));
        assert!(
            !instance.execution_context.steps.contains_key("return"),
            "an unadmitted definition must never execute"
        );
    }

    // A step may admit a family of workflows (`prefix*`), so a new member is added by its row alone; an id outside
    // the family is still refused and never runs.
    #[tokio::test]
    async fn data_selected_action_admits_a_member_of_a_named_family_only() {
        let mut store = TestDefinitionStore::new();
        store.register(make_action(
            "action:method-new",
            vec![Step::return_value(json!({"selected": "new"})).with_id("return")],
        ));
        store.register(make_action(
            "action:other",
            vec![Step::return_value(json!({"escaped": true})).with_id("escaped")],
        ));
        let dynamic_step: Step = serde_json::from_value(json!({
            "id": "publish",
            "kind": "action",
            "config": {
                "definition_id": {
                    "$kind": "binding",
                    "select": {"from": "input", "path": "publication_action"}
                },
                "definition_refs": ["action:method-*"],
                "inputs": {}
            }
        }))
        .expect("DATA-selected action step should deserialize");
        store.register(make_workflow("wf:family", vec![dynamic_step]));
        let executor = make_executor_with_store(store);
        let run = |chosen: &str| StartData {
            start_type: "test_event".to_string(),
            input: json!({"publication_action": chosen}),
            started_at: "1234567890".to_string(),
            start_id: Some(format!("evt-family-{chosen}")),
        };
        let member = executor
            .execute_workflow("wf:family", run("action:method-new"), make_actor(), &RetryPolicy::default())
            .await
            .expect("a member of the family runs");
        assert_eq!(member.status, ExecutionStatus::Completed);
        assert_eq!(member.execution_context.steps["publish"].output, json!({"selected": "new"}));
        let outside = executor
            .execute_workflow("wf:family", run("action:other"), make_actor(), &RetryPolicy::default())
            .await
            .expect("workflow failures are returned as failed instances");
        assert_eq!(outside.status, ExecutionStatus::Failed);
        assert!(outside.error_message.as_deref().is_some_and(|message| message.contains("outside definition_refs")));
        assert!(!outside.execution_context.steps.contains_key("escaped"));
        assert!(admitted(&["workflow:a"], "workflow:a") && !admitted(&["*"], "workflow:a"), "a bare * admits nothing");
    }

    #[tokio::test]
    async fn data_selected_action_rejects_non_string_or_empty_resolution() {
        let bad_values = [Value::Null, json!(""), json!(42), json!({"id": "action:x"})];
        for (index, value) in bad_values.into_iter().enumerate() {
            let dynamic_step: Step = serde_json::from_value(json!({
                "id": "publish",
                "kind": "action",
                "config": {
                    "definition_id": {
                        "$kind": "binding",
                        "select": {"from": "input", "path": "publication_action"}
                    },
                    "definition_refs": ["action:admitted"],
                    "inputs": {}
                }
            }))
            .expect("DATA-selected action step should deserialize");
            let mut store = TestDefinitionStore::new();
            store.register(make_workflow(
                &format!("wf:data-selected-action-invalid-{index}"),
                vec![dynamic_step],
            ));
            let executor = make_executor_with_store(store);
            let start = StartData {
                start_type: "test_event".to_string(),
                input: json!({"publication_action": value}),
                started_at: "1234567890".to_string(),
                start_id: Some(format!("evt-dynamic-action-invalid-{index}")),
            };

            let instance = executor
                .execute_workflow(
                    &format!("wf:data-selected-action-invalid-{index}"),
                    start,
                    make_actor(),
                    &RetryPolicy::default(),
                )
                .await
                .expect("workflow failures are returned as failed instances");

            assert_eq!(instance.status, ExecutionStatus::Failed);
            assert!(
                instance
                    .error_message
                    .as_deref()
                    .is_some_and(|message| message.contains("non-empty string")),
                "invalid DATA selection #{index} must fail closed: {:?}",
                instance.error_message
            );
        }
    }

    #[tokio::test]
    async fn owner_requested_definition_runs_in_current_workflow_without_outside_access() {
        let target_owned_input = json!({
            "literal_binding_ast": {
                "$kind": "binding",
                "select": {"from": "input", "path": "parent_secret"}
            },
            "value": 42
        });
        let mut store = TestDefinitionStore::new();
        let child = make_action(
            "action:owner-requested-child",
            vec![
                Step::write(json!([{
                    "address": "record::owner-requested-child-write",
                    "path": ["current-item", "owner-requested-child"],
                    "payload": {"kind": "owner-requested-write"}
                }]))
                .with_id("write_proof"),
                Step::return_value(json!({
                    "$kind": "binding",
                    "select": {"from": "input"},
                    "resolve_nested_bindings": false
                }))
                .with_id("return_input"),
            ],
        );
        store.register(child);

        let carrier_step: Step = serde_json::from_value(json!({
            "id": "run_owner_request",
            "kind": "run-owner-requested-definition",
            "config": {
                "request": {
                    "$kind": "binding",
                    "select": {"from": "input", "path": "owner_request"},
                    "resolve_nested_bindings": false
                }
            }
        }))
        .expect("owner-request carrier step should deserialize");
        let parent_proof = Step::return_value(json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "parent_value"}
        }))
        .with_id("parent_still_readable");
        store.register(make_workflow(
            "wf:owner-requested-definition",
            vec![carrier_step, parent_proof],
        ));

        let start = StartData {
            start_type: "test_event".to_string(),
            input: json!({
                "parent_value": "keep-me",
                "parent_secret": "must-not-leak-into-child-input",
                "owner_request": {
                    "operation": "execute_definition",
                    "definition_id": "action:owner-requested-child",
                    "input": target_owned_input.clone()
                }
            }),
            started_at: "1234567890".to_string(),
            start_id: Some("evt-owner-requested-definition".to_string()),
        };
        let executor =
            make_executor_with_store_and_access(store, std::sync::Arc::new(ForbiddenOutsideAccess));

        let instance = executor
            .execute_workflow(
                "wf:owner-requested-definition",
                start,
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("owner-requested definition should run in-process");

        assert_eq!(instance.status, ExecutionStatus::Completed);
        assert_eq!(
            instance.execution_context.steps["run_owner_request"].output, target_owned_input,
            "the request input must be copied verbatim, not reinterpreted as caller bindings"
        );
        assert_eq!(
            instance.execution_context.steps["parent_still_readable"].output,
            json!("keep-me"),
            "the parent input must be restored after the nested execution"
        );
        assert_eq!(
            instance.execution_context.start.input["parent_value"],
            json!("keep-me")
        );
        assert_eq!(instance.execution_context.writes.len(), 1);
        assert_eq!(
            instance.execution_context.writes[0].address,
            "record::owner-requested-child-write"
        );
    }

    #[tokio::test]
    async fn owner_requested_definition_fails_closed_for_invalid_owner_requests() {
        struct Case {
            name: &'static str,
            request: Value,
            expected_error: &'static str,
        }

        let cases = [
            Case {
                name: "wrong operation",
                request: json!({
                    "operation": "cancel_workflow",
                    "definition_id": "action:any",
                    "input": null
                }),
                expected_error: "operation must be execute_definition",
            },
            Case {
                name: "missing definition id",
                request: json!({
                    "operation": "execute_definition",
                    "input": null
                }),
                expected_error: "definition_id must be a non-empty string",
            },
            Case {
                name: "missing definition",
                request: json!({
                    "operation": "execute_definition",
                    "definition_id": "action:absent",
                    "input": null
                }),
                expected_error: "not hydrated",
            },
            Case {
                name: "inactive definition",
                request: json!({
                    "operation": "execute_definition",
                    "definition_id": "action:inactive",
                    "input": null
                }),
                expected_error: "not active",
            },
        ];

        for case in cases {
            let mut store = TestDefinitionStore::new();
            let mut inactive = make_action(
                "action:inactive",
                vec![Step::return_value(json!({"must_not_run": true})).with_id("return")],
            );
            inactive.is_active = false;
            store.register(inactive);
            let step: Step = serde_json::from_value(json!({
                "id": "run_owner_request",
                "kind": "run-owner-requested-definition",
                "config": {
                    "request": {
                        "$kind": "opaque-json",
                        "value": case.request
                    }
                }
            }))
            .expect("invalid-request carrier step should deserialize");
            store.register(make_workflow(
                "wf:owner-requested-definition-invalid",
                vec![step],
            ));
            let start = StartData {
                start_type: "test_event".to_string(),
                input: json!({}),
                started_at: "1234567890".to_string(),
                start_id: Some(format!("evt-invalid-{}", case.name)),
            };
            let executor = make_executor_with_store_and_access(
                store,
                std::sync::Arc::new(ForbiddenOutsideAccess),
            );

            let instance = executor
                .execute_workflow(
                    "wf:owner-requested-definition-invalid",
                    start,
                    make_actor(),
                    &RetryPolicy::default(),
                )
                .await
                .expect("workflow failures are returned as failed instances");

            assert_eq!(instance.status, ExecutionStatus::Failed, "{}", case.name);
            assert!(
                instance
                    .error_message
                    .as_deref()
                    .is_some_and(|message| message.contains(case.expected_error)),
                "{} produced {:?}",
                case.name,
                instance.error_message
            );
        }
    }

    #[tokio::test]
    async fn owner_requested_definition_rejects_reinterpreting_request_templates() {
        let step: Step = serde_json::from_value(json!({
            "id": "run_owner_request",
            "kind": "run-owner-requested-definition",
            "config": {
                "request": {
                    "operation": "execute_definition",
                    "definition_id": "action:any",
                    "input": {"$kind": "binding", "select": {"from": "input", "path": "secret"}}
                }
            }
        }))
        .expect("non-opaque request template should deserialize");
        let mut store = TestDefinitionStore::new();
        store.register(make_workflow(
            "wf:owner-requested-definition-transparent-template",
            vec![step],
        ));
        let executor = make_executor_with_store(store);
        let start = StartData {
            start_type: "test_event".to_string(),
            input: json!({"secret": "must-not-be-resolved"}),
            started_at: "1234567890".to_string(),
            start_id: Some("evt-transparent-owner-request".to_string()),
        };

        let instance = executor
            .execute_workflow(
                "wf:owner-requested-definition-transparent-template",
                start,
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("template rejection is returned as a failed instance");

        assert_eq!(instance.status, ExecutionStatus::Failed);
        assert!(instance
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("target-owned JSON")));
    }

    // ========================================================================
    // Test 7: Loop step iterates over array
    // ========================================================================

    #[tokio::test]
    async fn test_loop_step_iterates() {
        let mut store = TestDefinitionStore::new();
        let action = make_action("loop-action", vec![make_leaf_step()]);
        store.register(action.clone());
        let mut loop_step = Step::loop_step(json!({
            "definition_id": {"$kind":"binding","select":{"from":"start","path":"input.action_id"}},
            "definition_refs": ["loop-action"],
            "source": {"$kind":"binding","select":{"from":"start","path":"input.items"}},
            "item_var": "item",
            "max_iterations": 10,
            "parallel": false,
        }));
        loop_step.id = "step_0".to_string();
        let workflow = make_workflow("wf-loop", vec![loop_step]);
        store.register(workflow);
        let executor = make_executor_with_store(store);

        let start = StartData {
            start_type: "test_event".to_string(),
            input: json!({"items": [1, 2, 3], "action_id": "loop-action"}),
            started_at: "1234567890".to_string(),
            start_id: Some("evt-loop".to_string()),
        };
        let actor = make_actor();
        let policy = RetryPolicy::default();

        let instance = executor
            .execute_workflow("wf-loop", start, actor, &policy)
            .await
            .expect("loop workflow should succeed");

        assert_eq!(instance.status, ExecutionStatus::Completed);
        // Loop step output should be recorded (key = step.id)
        assert!(instance.execution_context.steps.contains_key("step_0"));
        assert_ne!(instance.execution_context.steps["step_0"].output, json!([1, 2, 3]),
            "a binding-selected loop action must execute, not silently echo its source items");
        // Iteration internals stay local to the loop scope
        assert!(!instance
            .execution_context
            .steps
            .contains_key("step_0_iter_0"));
        assert!(!instance
            .execution_context
            .steps
            .contains_key("step_0_iter_1"));
        assert!(!instance
            .execution_context
            .steps
            .contains_key("step_0_iter_2"));
    }

    #[tokio::test]
    async fn nested_loop_ask_identity_is_distinct_and_stable_on_cold_replay() {
        let make_store = || {
            let mut store = TestDefinitionStore::new();
            let mut leaf = make_action("identity-leaf", vec![make_leaf_step().with_id("slot")]);
            leaf.steps[0].config["context"] = json!({"step_id": "slot", "title": "Authored title"});
            store.register(leaf);
            store.register(make_action(
                "identity-body",
                vec![make_action_step(0, "identity-leaf")],
            ));
            let mut loop_step = Step::loop_step(json!({
                "definition_id": "identity-body",
                "source": {"$kind":"binding","select":{"from":"start","path":"input.items"}},
                "item_var": "item",
                "max_iterations": 10,
                "parallel": false
            }));
            loop_step.id = "pages".into();
            store.register(make_workflow("wf-runtime-identity", vec![loop_step]));
            store
        };
        let identities = Arc::new(RuntimeIdentityAccess(Mutex::new(Vec::new())));
        let first = make_executor_with_store_and_access(make_store(), identities.clone())
            .execute_workflow(
                "wf-runtime-identity",
                StartData {
                    start_type: "test_event".into(),
                    input: json!({"items": ["a", "b"]}),
                    started_at: "2026-10-14T00:00:00Z".into(),
                    start_id: None,
                },
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("first run executes");
        let first_identities = identities.0.lock().unwrap().clone();
        identities.0.lock().unwrap().clear();
        let replay = make_executor_with_store_and_access(make_store(), identities.clone())
            .execute_workflow(
                "wf-runtime-identity",
                StartData {
                    start_type: "test_event".into(),
                    input: json!({"items": ["a", "b"]}),
                    started_at: "2026-10-14T00:00:00Z".into(),
                    start_id: None,
                },
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("cold replay executes");
        let replay_identities = identities.0.lock().unwrap().clone();

        assert_eq!(first.status, ExecutionStatus::Completed);
        assert_eq!(replay.status, ExecutionStatus::Completed);
        assert_eq!(first_identities, replay_identities);
        assert_eq!(first_identities.len(), 2);
        assert_eq!(first_identities[0]["step_id"], json!("slot"));
        assert_eq!(first_identities[0]["title"], json!("Authored title"));
        assert_ne!(first_identities[0]["_runtime_identity"], first_identities[1]["_runtime_identity"]);
        assert_eq!(first_identities[0]["_runtime_identity"][0], json!(json!({ "iteration": "pages_iter_0", "definition_id": "identity-body" }).to_string()));
        assert_eq!(first_identities[0]["_runtime_identity"][1], json!(json!({ "action": "ws-0", "definition_id": "identity-leaf" }).to_string()));
        assert_eq!(first_identities[0]["_runtime_identity"][2], json!("slot"));
    }

    #[tokio::test]
    async fn action_name_cannot_collide_with_another_loops_runtime_iteration() {
        let mut store = TestDefinitionStore::new();
        let mut leaf = make_action("frame-leaf", vec![make_leaf_step().with_id("review")]);
        leaf.steps[0].config["context"] = json!({"step_id": "review"});
        store.register(leaf);
        let mut loop_step = Step::loop_step(json!({
            "definition_id": "frame-leaf", "source": ["one"],
            "item_var": "item", "max_iterations": 2, "parallel": false
        }));
        loop_step.id = "pages".into();
        let action = Step::action("frame-leaf", json!({})).with_id("pages_iter_0");
        store.register(make_workflow("wf-frame-collision", vec![loop_step, action]));
        let access = Arc::new(RuntimeIdentityAccess(Mutex::new(Vec::new())));
        let run = make_executor_with_store_and_access(store, access.clone())
            .execute_workflow("wf-frame-collision", StartData {
                start_type: "test_event".into(), input: json!({}),
                started_at: "2026-10-14T00:00:00Z".into(), start_id: None,
            }, make_actor(), &RetryPolicy::default())
            .await.expect("both child calls execute");
        assert_eq!(run.status, ExecutionStatus::Completed);
        let calls = access.0.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_ne!(calls[0]["_runtime_identity"], calls[1]["_runtime_identity"],
            "an authored action and a generated iteration cannot share durable answers");
    }

    #[tokio::test]
    async fn nested_field_projection_loop_restores_outer_do_while_state() {
        let mut store = TestDefinitionStore::new();
        let mut inner = Step::loop_step(json!({
            "source": {"$kind":"binding","select":{"from":"start","path":"input.fields"}},
            "item_var": "field",
            "max_iterations": 10,
            "parallel": false
        }));
        inner.id = "project_fields".into();
        store.register(make_action("do-body", vec![inner]));

        let mut outer = Step::loop_step(json!({
            "definition_id": "do-body",
            "condition": {
                "$kind":"binding",
                "select":{"from":"loop","path":"index"},
                "transform":[{"op":"op:core.lt","args":{"value":1}}]
            },
            "item_var":"iteration",
            "max_iterations":4
        }));
        outer.id = "release".into();
        store.register(make_workflow("wf-nested-loop-state", vec![outer]));

        let instance = make_executor_with_store(store)
            .execute_workflow(
                "wf-nested-loop-state",
                StartData {
                    start_type: "test_event".into(),
                    input: json!({"fields":[{"name":"title"},{"name":"body"}]}),
                    started_at: "2026-10-14T00:00:00Z".into(),
                    start_id: None,
                },
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("outer do-while continues after its nested loop");

        assert_eq!(instance.status, ExecutionStatus::Completed);
        assert_eq!(instance.execution_context.steps["release"].output.as_array().unwrap().len(), 2);
    }

    // A do-while condition reads what its body just returned (`loop.last_output`), so it repeats until the body says
    // held; a condition that reads nothing fails naming its path instead of ending the loop after one pass.
    #[tokio::test]
    async fn do_while_repeats_until_the_body_says_held_and_an_empty_read_fails_loud() {
        let run = |condition: Value| async move {
            let mut store = TestDefinitionStore::new();
            store.register(make_action("try-once", vec![Step::return_value(json!({
                "held": {"$kind":"binding","select":{"from":"loop","path":"index"},
                    "transform":[{"op":"op:core.lt","args":{"value":2}},{"op":"op:core.not"}]}
            })).with_id("answer")]));
            let mut retry = Step::loop_step(json!({
                "definition_id": "try-once",
                "condition": condition,
                "item_var": "attempt",
                "max_iterations": 5
            }));
            retry.id = "retry".into();
            store.register(make_workflow("wf-retry", vec![retry]));
            make_executor_with_store(store)
                .execute_workflow("wf-retry", StartData { start_type: "test_event".into(), input: json!({}),
                    started_at: "2026-11-21T00:00:00Z".into(), start_id: None }, make_actor(), &RetryPolicy::default())
                .await
                .expect("failures are returned as failed instances")
        };
        let held = run(json!({"$kind":"binding","select":{"from":"loop","path":"last_output.held"},
            "transform":[{"op":"op:core.not"}]})).await;
        assert_eq!(held.status, ExecutionStatus::Completed, "{:?}", held.error_message);
        let passes = held.execution_context.steps["retry"].output.as_array().unwrap().clone();
        assert_eq!(passes.len(), 3, "two not-held passes, then held: {passes:?}");
        assert_eq!(passes[2]["held"], json!(true));
        let empty = run(json!({"$kind":"binding","select":{"from":"loop","path":"last_output.no_such"},
            "transform":[{"op":"op:core.not"}]})).await;
        assert_eq!(empty.status, ExecutionStatus::Failed);
        let why = empty.error_message.unwrap_or_default();
        assert!(why.contains("loop.last_output.no_such"), "{why}");
    }

    // The same do-while inside a used workflow (an action step's body holds the loop) reads its passes through that
    // workflow's scope; a literal condition is accepted as any binding is.
    #[tokio::test]
    async fn a_do_while_inside_an_action_reads_its_last_pass() {
        let mut store = TestDefinitionStore::new();
        store.register(make_action("try-once", vec![Step::return_value(json!({
            "rows": [{"held": {"$kind":"binding","select":{"from":"loop","path":"index"},
                "transform":[{"op":"op:core.lt","args":{"value":1}},{"op":"op:core.not"}]}}]
        })).with_id("judge")]));
        let mut retry = Step::loop_step(json!({
            "definition_id": "try-once",
            "condition": {"$kind":"binding","select":{"from":"loop","path":"last_output.rows.0.held"},
                "transform":[{"op":"op:core.not"}]},
            "item_var": "attempt",
            "max_iterations": 3
        }));
        retry.id = "law-loop".into();
        store.register(make_action("voice-body", vec![retry]));
        let mut once = Step::loop_step(json!({
            "definition_id": "try-once",
            "condition": {"$kind":"binding","select":{"from":"literal","value":false}},
            "item_var": "attempt",
            "max_iterations": 3
        }));
        once.id = "once".into();
        store.register(make_workflow("wf-voice", vec![
            Step::action("voice-body", json!({})).with_id("voice"),
            once,
        ]));
        let instance = make_executor_with_store(store)
            .execute_workflow("wf-voice", StartData { start_type: "test_event".into(), input: json!({}),
                started_at: "2026-11-21T00:00:00Z".into(), start_id: None }, make_actor(), &RetryPolicy::default())
            .await
            .expect("failures are returned as failed instances");
        assert_eq!(instance.status, ExecutionStatus::Completed, "{:?}", instance.error_message);
        let passes = instance.execution_context.steps["voice"].output.as_array().cloned().unwrap_or_default();
        assert_eq!(passes.len(), 2, "not held, then held: {:?}", instance.execution_context.steps["voice"].output);
        assert_eq!(passes[1]["rows"][0]["held"], json!(true));
        assert_eq!(instance.execution_context.steps["once"].output.as_array().unwrap().len(), 1, "a literal false ends after one pass");
    }

    struct WaitBindingAccess(Mutex<Vec<(Value, Value)>>);

    #[async_trait::async_trait]
    impl crate::executor::context::OutsideAccess for WaitBindingAccess {
        async fn ask(
            &self,
            _name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            payload: bytes::Bytes,
            context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            let payload: Value = serde_json::from_slice(&payload).map_err(|error| error.to_string())?;
            let context: Value = serde_json::from_slice(context.as_deref().unwrap_or(b"{}"))
                .map_err(|error| error.to_string())?;
            self.0.lock().unwrap().push((payload, context));
            Ok(std::sync::Arc::from(b"{}".to_vec().into_boxed_slice()))
        }

        async fn read(
            &self,
            _from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<crate::executor::context::DirectReadResult, String> {
            Err("wait binding test does not read".into())
        }
    }

    #[tokio::test]
    async fn nested_wait_resolves_binding_and_carries_runtime_identity_on_cold_replay() {
        let make_store = || {
            let mut store = TestDefinitionStore::new();
            let condition = json!({
                "$kind":"binding",
                "select":{"from":"start","path":"input.condition"}
            });
            let mut wait = Step::wait(condition);
            wait.id = "hold".into();
            store.register(make_action("wait-body", vec![wait]));
            // A used workflow's start input is the inputs its action step hands it, so the condition is handed down.
            let hand_down = Step::action("wait-body", json!({
                "condition": {"$kind":"binding","select":{"from":"start","path":"input.condition"}}
            })).with_id("ws-0");
            store.register(make_workflow("wf-bound-wait", vec![hand_down]));
            store
        };
        let access = Arc::new(WaitBindingAccess(Mutex::new(Vec::new())));
        for _ in 0..2 {
            let instance = make_executor_with_store_and_access(make_store(), access.clone())
                .execute_workflow(
                    "wf-bound-wait",
                    StartData {
                        start_type: "test_event".into(),
                        input: json!({"condition":{"type":"event","event_type":"post.release","filter":{"post_id":"post:42"}}}),
                        started_at: "2026-10-14T00:00:00Z".into(),
                        start_id: None,
                    },
                    make_actor(),
                    &RetryPolicy::default(),
                )
                .await
                .expect("nested wait executes");
            assert_eq!(instance.status, ExecutionStatus::Completed);
        }
        let asks = access.0.lock().unwrap();
        assert_eq!(asks.len(), 2);
        assert_eq!(asks[0].0["wait"]["event_type"], json!("post.release"));
        assert_eq!(asks[0].0["wait"]["filter"]["post_id"], json!("post:42"));
        assert_eq!(asks[0].1["_runtime_identity"], asks[1].1["_runtime_identity"]);
        assert_eq!(asks[0].1["_runtime_identity"], json!([json!({ "action": "ws-0", "definition_id": "wait-body" }).to_string(), "hold"]));
    }

    // ========================================================================
    // Test 7a: tolerate_item_errors — a failing iteration yields an
    // error-shaped item and siblings keep running; default (false) preserves
    // the all-or-nothing contract.
    // ========================================================================

    fn make_tolerance_workflow(tolerate: bool) -> TestDefinitionStore {
        let mut store = TestDefinitionStore::new();
        // The loop body references a definition that does NOT exist in the
        // store, so every iteration fails at resolve_sub_definition — the
        // same per-iteration failure class as a credential-less source's
        // slot ask error, without needing a fallible outside-access stub.
        let mut loop_step = Step::loop_step(json!({
            "definition_id": "missing-action",
            "source": {"$kind":"binding","select":{"from":"start","path":"input.items"}},
            "item_var": "item",
            "max_iterations": 10,
            "parallel": false,
            "tolerate_item_errors": tolerate,
        }));
        loop_step.id = "step_0".to_string();
        store.register(make_workflow("wf-tolerant-loop", vec![loop_step]));
        store
    }

    #[tokio::test]
    async fn test_loop_tolerate_item_errors_yields_error_items() {
        let executor = make_executor_with_store(make_tolerance_workflow(true));
        let start = StartData {
            start_type: "test_event".to_string(),
            input: json!({"items": [1, 2, 3]}),
            started_at: "1234567890".to_string(),
            start_id: Some("evt-tol".to_string()),
        };

        let instance = executor
            .execute_workflow(
                "wf-tolerant-loop",
                start,
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("tolerant loop must complete despite every iteration failing");

        assert_eq!(instance.status, ExecutionStatus::Completed);
        let output = &instance.execution_context.steps["step_0"].output;
        let items = output.as_array().expect("loop output is an array");
        // ALL siblings ran — nothing was cancelled by the first failure.
        assert_eq!(items.len(), 3);
        for (i, item) in items.iter().enumerate() {
            let err = item
                .get("tolerated_error")
                .unwrap_or_else(|| panic!("item {i} must be error-shaped: {item}"));
            assert_eq!(err["iteration_index"], json!(i));
            // The failure names WHAT it was working on, not only where it sat.
            // A consumer that has to withhold a done-mark from the input that
            // failed can match on identity; with only a position it would have
            // to be holding the same list in the same order to know anything,
            // and that coupling breaks silently.
            assert_eq!(
                err["item"],
                json!(i + 1),
                "the failing item rides out with its error: {item}"
            );
            assert!(err["error"]
                .as_str()
                .expect("error is a string")
                .contains("missing-action"));
        }
    }

    #[tokio::test]
    async fn test_loop_default_still_fails_whole_loop() {
        let executor = make_executor_with_store(make_tolerance_workflow(false));
        let start = StartData {
            start_type: "test_event".to_string(),
            input: json!({"items": [1, 2, 3]}),
            started_at: "1234567890".to_string(),
            start_id: Some("evt-tol-off".to_string()),
        };

        let instance = executor
            .execute_workflow(
                "wf-tolerant-loop",
                start,
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("executor returns the failed instance, not Err");
        // Default contract: the first iteration failure fails the WHOLE loop
        // (instance finalizes as Failed with the iteration's error message).
        assert_eq!(
            instance.status,
            ExecutionStatus::Failed,
            "default loop contract must remain all-or-nothing"
        );
        assert!(instance
            .error_message
            .as_deref()
            .unwrap_or_default()
            .contains("missing-action"));
    }

    // ========================================================================
    // Test 7b: Nested loop resolves from the PRE-HYDRATED closure (L063, #48/#55)
    //
    // The wasmtime-reentry trap class is eliminated structurally: the owning
    // slot pre-hydrates the ENTIRE transitively-referenced definition closure
    // into the store BEFORE the executor runs (it walks
    // `Definition::referenced_definition_ids` to a fixpoint via safe top-level
    // asks). The nested loop/action resolver is then a PURE cache lookup — no
    // host call mid-execution, so nothing can race the wasmtime call window.
    //
    // These tests prove the post-fix contract end-to-end in workflow-core:
    //   (a) the pure discovery primitive surfaces the loop's sub-definition id,
    //   (b) a store pre-populated with the closure resolves the nested loop with
    //       NO hydrator anywhere (Completed),
    //   (c) a genuinely-absent sub-definition is a hard DefinitionNotFound — the
    //       resolver has NO hidden self-heal, so the slot MUST pre-hydrate. This
    //       is the honest "pure lookup" contract that makes the mid-execution
    //       ask (and its reentry trap) structurally impossible.
    // ========================================================================

    fn make_cold_loop_executor(store: Arc<CachedDefinitionStore>) -> AsyncWorkflowExecutor {
        AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            std::sync::Arc::new(NoOpOutsideAccess),
            store,
            crate::executor::context::test_product_word_ids(),
        )
    }

    fn cold_loop_workflow_and_subdef() -> (Definition, Definition) {
        let sub_definition = make_action("loop-action-cold", vec![make_leaf_step()]);
        let mut loop_step = Step::loop_step(json!({
            "definition_id": "loop-action-cold",
            "source": {"$kind":"binding","select":{"from":"start","path":"input.items"}},
            "item_var": "item",
            "max_iterations": 10,
            "parallel": false,
        }));
        loop_step.id = "step_0".to_string();
        let workflow = make_workflow("wf-loop-cold", vec![loop_step]);
        (workflow, sub_definition)
    }

    fn cold_loop_start() -> StartData {
        StartData {
            start_type: "test_event".to_string(),
            input: json!({"items": [1, 2, 3]}),
            started_at: "1234567890".to_string(),
            start_id: Some("evt-loop-cold".to_string()),
        }
    }

    #[test]
    fn referenced_definition_ids_surfaces_nested_loop_subdef() {
        // The pure closure-discovery primitive (workflow-core's half of the
        // pre-hydrate walk): a loop step's STATIC `definition_id` literal is
        // reported, so the slot can walk the closure transitively.
        let (workflow, _sub) = cold_loop_workflow_and_subdef();
        assert_eq!(
            workflow.referenced_definition_ids(),
            vec!["loop-action-cold"],
            "the loop's static sub-definition id must be statically discoverable"
        );
        // A definition with no action/loop steps references nothing.
        let leaf = make_action("leaf-only", vec![make_leaf_step()]);
        assert!(
            leaf.referenced_definition_ids().is_empty(),
            "a leaf definition references no sub-definitions"
        );
    }

    #[tokio::test]
    async fn test_nested_loop_resolves_from_prehydrated_closure() {
        let (workflow, sub_definition) = cold_loop_workflow_and_subdef();

        // Simulate the slot's closure walk having pre-hydrated the WHOLE closure
        // (parent + every transitively-referenced sub-definition) into the store
        // BEFORE execution. No hydrator is injected — the nested resolver is a
        // pure cache lookup.
        let store = Arc::new(CachedDefinitionStore::new());
        store.insert_definition(workflow);
        store.insert_definition(sub_definition);

        let executor = make_cold_loop_executor(store);

        let instance = executor
            .execute_workflow(
                "wf-loop-cold",
                cold_loop_start(),
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("pre-hydrated closure must resolve the nested loop sub-definition");

        assert_eq!(
            instance.status,
            ExecutionStatus::Completed,
            "Expected Completed but got {:?}. Error: {:?}",
            instance.status,
            instance.error_message
        );
        assert!(instance.execution_context.steps.contains_key("step_0"));
    }

    #[tokio::test]
    async fn test_nested_loop_absent_subdef_is_hard_not_found() {
        let (workflow, _sub_definition) = cold_loop_workflow_and_subdef();

        // Seed ONLY the parent — the sub-definition was NOT pre-hydrated. The
        // resolver is a pure cache lookup with no self-heal, so the loop fails.
        // This is the honest contract that forces the slot to pre-hydrate the
        // closure and makes any mid-execution resolution ask (and its reentry
        // trap) structurally impossible.
        let store = Arc::new(CachedDefinitionStore::new());
        store.insert_definition(workflow);

        let executor = make_cold_loop_executor(store);

        let result = executor
            .execute_workflow(
                "wf-loop-cold",
                cold_loop_start(),
                make_actor(),
                &RetryPolicy::default(),
            )
            .await;

        assert!(
            result.is_err()
                || result
                    .as_ref()
                    .map(|i| i.status != ExecutionStatus::Completed)
                    .unwrap_or(false),
            "An un-hydrated cold sub-definition must NOT resolve, got: {:?}",
            result.map(|i| i.status)
        );
    }

    // ========================================================================
    // Test 8: Wait step pauses execution
    // ========================================================================

    #[tokio::test]
    async fn test_wait_step_pauses() {
        let mut store = TestDefinitionStore::new();
        let mut wait_step = Step::wait(json!({"duration_secs": 0}));
        wait_step.id = "step_0".to_string();
        let workflow = make_workflow("wf-wait", vec![wait_step]);
        store.register(workflow);
        let executor = make_executor_with_store(store);

        let start = make_start();
        let actor = make_actor();
        let policy = RetryPolicy::default();

        let instance = executor
            .execute_workflow("wf-wait", start, actor, &policy)
            .await
            .expect("wait workflow should succeed");

        assert_eq!(instance.status, ExecutionStatus::Completed);
        let step_output = instance
            .execution_context
            .steps
            .get("step_0")
            .expect("wait step output should exist");
        assert_eq!(step_output.output["waited_secs"], 0);
    }

    // ========================================================================
    // Test 9: Failed workflow records error in instance
    // ========================================================================

    #[tokio::test]
    async fn test_failed_workflow_records_error() {
        let mut store = TestDefinitionStore::new();
        // No actions registered → will fail
        let workflow = make_workflow("wf-fail", vec![make_action_step(0, "nonexistent-action")]);
        store.register(workflow);
        let executor = make_executor_with_store(store);

        let start = make_start();
        let actor = make_actor();
        let policy = RetryPolicy::default();

        let instance = executor
            .execute_workflow("wf-fail", start, actor, &policy)
            .await
            .expect("should return instance with Failed status, not Err");

        assert_eq!(instance.status, ExecutionStatus::Failed);
        assert!(instance.error_message.is_some());
        assert!(instance.completed_at.is_some());
    }

    // ========================================================================
    // Test 10: Retry logic retries on failure
    // ========================================================================

    #[tokio::test]
    async fn test_retry_logic_retries_on_failure() {
        let mut store = TestDefinitionStore::new();
        // No action → always fails
        let workflow = make_workflow("wf-retry", vec![make_action_step(0, "missing-action")]);
        store.register(workflow);
        let executor = make_executor_with_store(store);

        let start = make_start();
        let actor = make_actor();
        let policy = RetryPolicy {
            max_attempts: 3,
            base_delay_ms: 0, // No delay for test speed
            backoff: BackoffStrategy::None,
        };

        let instance = executor
            .execute_workflow("wf-retry", start, actor, &policy)
            .await
            .expect("should return Failed instance");

        // DefinitionNotFound is NOT retryable — fails immediately, no retry records
        assert_eq!(instance.status, ExecutionStatus::Failed);
        assert!(
            !instance
                .execution_context
                .steps
                .contains_key("step_0_retry_0"),
            "DefinitionNotFound is not retryable — no retry records should exist"
        );
    }

    // ========================================================================
    // Test 11: RetryPolicy delay calculation
    // ========================================================================

    #[test]
    fn test_retry_policy_delay_calculation() {
        let fixed = RetryPolicy {
            max_attempts: 3,
            base_delay_ms: 100,
            backoff: BackoffStrategy::Fixed,
        };
        assert_eq!(fixed.delay_for_attempt(0), 100);
        assert_eq!(fixed.delay_for_attempt(1), 100);
        assert_eq!(fixed.delay_for_attempt(2), 100);

        let exponential = RetryPolicy {
            max_attempts: 5,
            base_delay_ms: 100,
            backoff: BackoffStrategy::Exponential,
        };
        assert_eq!(exponential.delay_for_attempt(0), 100); // 100 * 2^0
        assert_eq!(exponential.delay_for_attempt(1), 200); // 100 * 2^1
        assert_eq!(exponential.delay_for_attempt(2), 400); // 100 * 2^2
        assert_eq!(exponential.delay_for_attempt(3), 800); // 100 * 2^3

        let none = RetryPolicy::default();
        assert_eq!(none.delay_for_attempt(0), 0);
    }

    // ========================================================================
    // Test 12: is_truthy evaluates correctly
    // ========================================================================

    #[test]
    fn test_is_truthy() {
        assert!(!is_truthy(&Value::Null));
        assert!(!is_truthy(&json!(false)));
        assert!(is_truthy(&json!(true)));
        assert!(!is_truthy(&json!(0)));
        assert!(is_truthy(&json!(1)));
        assert!(is_truthy(&json!(-1)));
        assert!(!is_truthy(&json!("")));
        assert!(is_truthy(&json!("hello")));
        assert!(!is_truthy(&json!([])));
        assert!(is_truthy(&json!([1])));
        assert!(!is_truthy(&json!({})));
        assert!(is_truthy(&json!({"a": 1})));
    }

    // ========================================================================
    // Test 13: DefinitionStore trait — get_by_trigger
    // ========================================================================

    #[test]
    fn test_definition_store_get_by_trigger() {
        let mut store = TestDefinitionStore::new();

        let wf1 = make_workflow("wf-1", vec![]);
        let mut wf2 = make_workflow("wf-2", vec![]);
        wf2.trigger_source = "other_event".to_string();
        let mut wf3 = make_workflow("wf-3", vec![]);
        wf3.is_active = false;

        store.register(wf1);
        store.register(wf2);
        store.register(wf3);

        let matches = store
            .get_by_trigger("test_event", "partition:test")
            .expect("should succeed");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].id, "wf-1");
    }

    // ========================================================================
    // Test 14: WorkflowInstance lifecycle
    // ========================================================================

    #[tokio::test]
    async fn test_workflow_instance_lifecycle() {
        let mut store = TestDefinitionStore::new();
        store.register(make_workflow("wf-life", vec![]));
        let executor = make_executor_with_store(store);

        let start = make_start();
        let actor = make_actor();
        let policy = RetryPolicy::default();

        let instance = executor
            .execute_workflow("wf-life", start.clone(), actor, &policy)
            .await
            .expect("should succeed");

        // Verify instance fields
        assert!(instance.id.starts_with(WORKFLOW_INSTANCE_ID_PREFIX));
        assert_eq!(instance.partition_key, "partition:test");
        assert_eq!(instance.workflow_id, "wf-life");
        assert_eq!(instance.status, ExecutionStatus::Completed);
        assert!(instance.started_at.is_some());
        assert!(instance.completed_at.is_some());
        assert!(instance.error_message.is_none());
        assert_eq!(instance.start_id, Some("evt-001".to_string()));
        assert_eq!(instance.execution_context.start.start_type, "test_event");
    }

    #[tokio::test]
    async fn test_execute_definition_uses_definition_partition_key() {
        let mut store = TestDefinitionStore::new();
        let mut action = make_action("action:ws-genesis", vec![]);
        action.partition_key = "partition:genesis".to_string();
        store.register(action.clone());
        let executor = make_executor_with_store(store);

        let instance = executor
            .execute_definition(action, make_start(), make_actor(), &RetryPolicy::default())
            .await
            .expect("should succeed");

        assert_eq!(instance.partition_key, "partition:genesis");
        assert_eq!(
            instance.execution_context.context.partition_key,
            "partition:genesis"
        );
    }

    // ========================================================================
    // Test 15: Loop with max_iterations enforced
    // ========================================================================

    #[tokio::test]
    async fn test_loop_max_iterations_fails_closed_instead_of_truncating() {
        let mut store = TestDefinitionStore::new();

        let action = make_action("iter-action", vec![make_leaf_step()]);
        store.register(action.clone());

        let loop_step = Step {
            id: "ws-0".to_string(),
            kind: "loop".to_string(),
            config: json!({
                "definition_id": "iter-action",
                "source": {"$kind":"binding","select":{"from":"start","path":"input.items"}},
                "item_var": "item",
                "max_iterations": 2,
                "parallel": false,
            }),
            join: "any".to_string(),
            join_config: json!({}),
        };

        let workflow = make_workflow("wf-loop-limit", vec![loop_step]);
        store.register(workflow);
        let executor = make_executor_with_store(store);

        let start = StartData {
            start_type: "test".to_string(),
            input: json!({"items": [1, 2, 3, 4, 5]}), // 5 items but max 2
            started_at: "0".to_string(),
            start_id: None,
        };
        let actor = make_actor();
        let policy = RetryPolicy::default();

        let instance = executor
            .execute_workflow("wf-loop-limit", start, actor, &policy)
            .await
            .expect("the executor records a failed workflow instance");
        assert_eq!(instance.status, ExecutionStatus::Failed);
        let message = instance
            .error_message
            .expect("a fail-closed loop must preserve its structured error");
        assert!(message.contains("5 items"));
        assert!(message.contains("max_iterations 2"));
    }

    // ========================================================================
    // PARALLEL EXECUTION TESTS (Task 157 Agent 1)
    //
    // Tests for "parallel" concurrent branch execution.
    // Branches are defined in step.inputs()["branches"] as Vec<Step>.
    // Each branch gets an independent ExecutionContext clone.
    // ========================================================================

    // ========================================================================
    // WaitCondition Tests — T1/T2/T3 temporal primitives
    // ========================================================================

    // -- Test: WaitCondition::Duration serializes/deserializes correctly --
    #[test]
    fn test_wait_condition_duration_serde() {
        let condition = WaitCondition::Duration { secs: 30 };
        let json = serde_json::to_value(&condition).expect("serialize");
        assert_eq!(json["type"], "duration");
        assert_eq!(json["secs"], 30);

        let roundtrip: WaitCondition = serde_json::from_value(json).expect("deserialize");
        assert_eq!(roundtrip, WaitCondition::Duration { secs: 30 });
    }

    // -- Test: WaitCondition::Until serializes/deserializes correctly --
    #[test]
    fn test_wait_condition_until_serde() {
        let condition = WaitCondition::Until {
            datetime: "2026-03-01T09:00:00Z".to_string(),
        };
        let json = serde_json::to_value(&condition).expect("serialize");
        assert_eq!(json["type"], "until");
        assert_eq!(json["datetime"], "2026-03-01T09:00:00Z");

        let roundtrip: WaitCondition = serde_json::from_value(json).expect("deserialize");
        assert_eq!(
            roundtrip,
            WaitCondition::Until {
                datetime: "2026-03-01T09:00:00Z".to_string()
            }
        );
    }

    // -- Test: WaitCondition::Event serializes/deserializes correctly --
    #[test]
    fn test_wait_condition_event_serde() {
        let condition = WaitCondition::Event {
            event_type: "payment.received".to_string(),
            filter: Some(json!({ "amount": { "$gt": 100 } })),
        };
        let json = serde_json::to_value(&condition).expect("serialize");
        assert_eq!(json["type"], "event");
        assert_eq!(json["event_type"], "payment.received");
        assert!(json.get("filter").is_some());

        // Without filter: skip_serializing_if = None
        let no_filter = WaitCondition::Event {
            event_type: "order.placed".to_string(),
            filter: None,
        };
        let json2 = serde_json::to_value(&no_filter).expect("serialize");
        assert!(
            json2.get("filter").is_none(),
            "None filter should be omitted"
        );
    }

    // -- Test: WaitCondition::Race serializes/deserializes with nested conditions --
    #[test]
    fn test_wait_condition_race_serde() {
        let condition = WaitCondition::Race {
            conditions: vec![
                WaitCondition::Duration { secs: 60 },
                WaitCondition::Event {
                    event_type: "inventory.restocked".to_string(),
                    filter: None,
                },
            ],
        };
        let json = serde_json::to_value(&condition).expect("serialize");
        assert_eq!(json["type"], "race");
        let arr = json["conditions"].as_array().expect("conditions array");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["type"], "duration");
        assert_eq!(arr[1]["type"], "event");

        let roundtrip: WaitCondition = serde_json::from_value(json).expect("deserialize");
        assert_eq!(roundtrip, condition);
    }

    // -- Test: Legacy duration_secs input parses as WaitCondition::Duration --
    #[test]
    fn test_parse_legacy_duration_secs() {
        let inputs = json!({ "duration_secs": 45 });
        let condition = parse_wait_condition(&inputs);
        assert_eq!(condition, WaitCondition::Duration { secs: 45 });
    }

    // -- Test: Canonical { "type": "until", "datetime": "..." } parses correctly --
    #[test]
    fn test_parse_canonical_until_format() {
        let inputs = json!({ "type": "until", "datetime": "2026-03-01T09:00:00Z" });
        let condition = parse_wait_condition(&inputs);
        assert_eq!(
            condition,
            WaitCondition::Until {
                datetime: "2026-03-01T09:00:00Z".to_string()
            }
        );
    }

    // -- Test: Canonical { "type": "duration", "secs": N } parses correctly --
    #[test]
    fn test_parse_canonical_duration_format() {
        let inputs = json!({ "type": "duration", "secs": 120 });
        let condition = parse_wait_condition(&inputs);
        assert_eq!(condition, WaitCondition::Duration { secs: 120 });
    }

    // -- Test: Canonical race format parses nested conditions --
    #[test]
    fn test_parse_canonical_race_format() {
        let inputs = json!({
            "type": "race",
            "conditions": [
                { "type": "duration", "secs": 5 },
                { "type": "event", "event_type": "payment.received" }
            ]
        });
        let condition = parse_wait_condition(&inputs);
        assert_eq!(
            condition,
            WaitCondition::Race {
                conditions: vec![
                    WaitCondition::Duration { secs: 5 },
                    WaitCondition::Event {
                        event_type: "payment.received".to_string(),
                        filter: None,
                    },
                ]
            }
        );
    }

    // -- Test: Empty inputs parse as Duration { secs: 0 } (no-op fallback) --
    #[test]
    fn test_parse_empty_inputs_no_op() {
        let inputs = json!({});
        let condition = parse_wait_condition(&inputs);
        assert_eq!(condition, WaitCondition::Duration { secs: 0 });
    }

    // -- Test: Until(past datetime) resolves immediately (idempotent restart behavior) --
    #[tokio::test]
    async fn test_wait_until_past_resolves_immediately() {
        let past = WaitCondition::Until {
            datetime: "2020-01-01T00:00:00Z".to_string(),
        };
        let result = dispatch_wait_condition(&past).await;
        assert!(result.is_ok(), "Past datetime should resolve without error");
        let output = result.unwrap();
        assert_eq!(output["condition"], "until");
    }

    // -- Test: Invalid datetime in Until returns error --
    #[tokio::test]
    async fn test_wait_until_invalid_datetime_errors() {
        let bad = WaitCondition::Until {
            datetime: "not-a-datetime".to_string(),
        };
        let result = dispatch_wait_condition(&bad).await;
        assert!(result.is_err(), "Invalid datetime must return error");
    }

    // -- Test: Race with empty conditions returns error --
    #[tokio::test]
    async fn test_wait_race_empty_conditions_errors() {
        let race = WaitCondition::Race { conditions: vec![] };
        let result = dispatch_wait_condition(&race).await;
        assert!(result.is_err(), "Empty race conditions must return error");
    }

    // -- Test: Race with single condition returns winner_index 0 --
    #[tokio::test]
    async fn test_wait_race_single_condition_resolves() {
        let race = WaitCondition::Race {
            conditions: vec![WaitCondition::Duration { secs: 0 }],
        };
        let result = dispatch_wait_condition(&race).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert_eq!(output["condition"], "race");
        assert_eq!(output["winner_index"], 0);
    }

    // -- Test: an event wait is never completed by the engine itself --
    #[tokio::test]
    async fn test_wait_event_is_never_held_by_the_engine() {
        let event = WaitCondition::Event {
            event_type: "order.placed".to_string(),
            filter: None,
        };
        assert!(!held_here(&event), "an event wait is asked of outside work");
        assert!(dispatch_wait_condition(&event).await.is_err(), "and never passes by itself");
    }

    // -- Test: Duration condition outputs waited_secs and target_datetime --
    #[tokio::test]
    async fn test_wait_duration_outputs_both_fields() {
        let dur = WaitCondition::Duration { secs: 0 };
        let result = dispatch_wait_condition(&dur).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert_eq!(output["condition"], "duration");
        assert_eq!(output["waited_secs"], 0);
        assert!(
            output["target_datetime"].is_string(),
            "target_datetime must be present"
        );
    }

    // ========================================================================
    // Circuit-Aware Retry Tests (Wave 3 — task-0517)
    //
    // These tests verify that execute_step_with_retry() checks circuit FSM
    // state BEFORE calling execute_single_step. OPEN and HALF_OPEN circuits
    // must return immediately without consuming any retry budget.
    // ========================================================================

    /// Build a minimal ExecutorDeps for circuit-state tests.
    /// The circuit check exits BEFORE execute_single_step is called,
    /// so the outside-access contents are irrelevant for OPEN and HALF_OPEN tests.
    fn make_test_deps() -> crate::executor::context::ExecutorDeps {
        crate::executor::context::ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: std::sync::Arc::new(NoOpOutsideAccess),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(TestDefinitionStore::new()),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        }
    }

    fn make_test_deps_with_circuit(
        circuit_state: std::sync::Arc<resilience::StateLock<resilience::CircuitState>>,
    ) -> crate::executor::context::ExecutorDeps {
        let mut deps = make_test_deps();
        deps.circuit_state = Some(circuit_state);
        deps
    }

    /// No-op outside-access adapter for tests where dispatch is never reached.
    struct NoOpOutsideAccess;

    #[async_trait::async_trait]
    impl crate::executor::context::OutsideAccess for NoOpOutsideAccess {
        async fn ask(
            &self,
            _name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            _payload: bytes::Bytes,
            _context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            let response = serde_json::json!({"status": "ok"});
            Ok(std::sync::Arc::from(
                serde_json::to_vec(&response).unwrap().into_boxed_slice(),
            ))
        }

        async fn read(
            &self,
            _from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<crate::executor::context::DirectReadResult, String> {
            let response = serde_json::json!({"status": "ok"});
            Ok(crate::executor::context::DirectReadResult {
                bytes: std::sync::Arc::from(
                    serde_json::to_vec(&response).unwrap().into_boxed_slice(),
                ),
                content_hash: "test-content-hash".to_string(),
            })
        }
    }

    /// Outside access is a defect in tests that prove pure in-process execution.
    struct ForbiddenOutsideAccess;

    #[async_trait::async_trait]
    impl crate::executor::context::OutsideAccess for ForbiddenOutsideAccess {
        async fn ask(
            &self,
            name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            _payload: bytes::Bytes,
            _context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            Err(format!("forbidden outside ask to {name} was attempted"))
        }

        async fn read(
            &self,
            from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<crate::executor::context::DirectReadResult, String> {
            Err(format!("forbidden outside read from {from} was attempted"))
        }
    }

    /// A real `compute.process` envelope reply for the full DAG regression.
    ///
    /// The output file deliberately contains a bare write-items JSON array.
    /// The next wave must recover those retained bytes through the process
    /// artifact reference, apply `json_parse`, and emit the writes. This covers
    /// the public executor path used by the Workflow slot rather than the
    /// single-step helper's local mutation path.
    struct ProcessResultOutsideAccess;

    #[async_trait::async_trait]
    impl crate::executor::context::OutsideAccess for ProcessResultOutsideAccess {
        async fn ask(
            &self,
            name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            _payload: bytes::Bytes,
            _context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            if name != "compute.process" {
                return Err(format!("unexpected outside-work target {name:?}"));
            }
            let result = crate::executor::step_executor::process_result_fixture(
                ProcessTermination::Exited { code: 0 },
                Vec::new(),
                Vec::new(),
                vec![
                    ProcessOutputArtifact {
                        mount_path: "state.out.json".to_string(),
                        content_type: Some("application/json".to_string()),
                        storage: ProcessOutputStorage::Inline,
                        byte_len: 2,
                        integrity_hash: "1f:state".to_string(),
                        content_hash: None,
                        chunk_manifest_hash: None,
                        chunk_manifest_address: None,
                        envelope_address: None,
                        envelope_path: Vec::new(),
                        chunk_size_bytes: None,
                        bytes: b"{}".to_vec(),
                    },
                    ProcessOutputArtifact {
                        mount_path: "facts.out.json".to_string(),
                        content_type: Some("application/json".to_string()),
                        storage: ProcessOutputStorage::Inline,
                        byte_len: 72,
                        integrity_hash: "1f:facts".to_string(),
                        content_hash: None,
                        chunk_manifest_hash: None,
                        chunk_manifest_address: None,
                        envelope_address: None,
                        envelope_path: Vec::new(),
                        chunk_size_bytes: None,
                        bytes: br#"[{"address":"proof::raw-output","path":["current"],"payload":{"ok":true}}]"#.to_vec(),
                    },
                ],
                1,
            );
            serde_json::to_vec(&result)
                .map(|bytes| std::sync::Arc::from(bytes.into_boxed_slice()))
                .map_err(|error| error.to_string())
        }

        async fn read(
            &self,
            _from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<crate::executor::context::DirectReadResult, String> {
            Err("full-DAG process regression does not perform reads".to_string())
        }
    }

    /// A request that declared an exact termination receives no ProcessResult
    /// when the process owner observes a mismatch. The owner error must stop the
    /// DAG before missing artifacts can become downstream write inputs.
    struct RejectedProcessOutsideAccess;

    #[async_trait::async_trait]
    impl crate::executor::context::OutsideAccess for RejectedProcessOutsideAccess {
        async fn ask(
            &self,
            _name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            _payload: bytes::Bytes,
            _context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            Err(
                "process owner rejected termination Exited { code: 1 }; stderr=fixture process could not create facts.out.json"
                    .to_string(),
            )
        }

        async fn read(
            &self,
            _from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<crate::executor::context::DirectReadResult, String> {
            Err("failed-process regression does not perform reads".to_string())
        }
    }

    struct SnapshotReplyOutsideAccess {
        captured_process_input: Mutex<Option<serde_json::Value>>,
    }

    #[async_trait::async_trait]
    impl crate::executor::context::OutsideAccess for SnapshotReplyOutsideAccess {
        async fn ask(
            &self,
            name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            payload: bytes::Bytes,
            _context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            if name == "slot::find-current-items" {
                return Ok(Arc::from(
                    br#"{"snapshot":{"digest":"1f:snapshot"},"items":[{"id":"row-1"}]}"#.as_slice(),
                ));
            }
            if name == "compute.process" {
                *self.captured_process_input.lock().unwrap() =
                    Some(serde_json::from_slice(&payload).unwrap());
                let result = crate::executor::step_executor::process_result_fixture(
                    ProcessTermination::Exited { code: 0 },
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    1,
                );
                return serde_json::to_vec(&result)
                    .map(|bytes| Arc::from(bytes.into_boxed_slice()))
                    .map_err(|e| e.to_string());
            }
            Err(format!("unexpected target {name}"))
        }

        async fn read(
            &self,
            _from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<crate::executor::context::DirectReadResult, String> {
            Err("not used".into())
        }
    }

    #[tokio::test]
    async fn full_dag_process_artifact_json_parse_retains_raw_bytes_across_waves() {
        let ask = Step::ask("compute.process", json!({"argv": ["fixture"]})).with_id("ann_upsert");
        let write = Step::write(json!({
            "$kind": "binding",
            "select": {
                "from": "steps",
                "key": "ann_upsert",
                "path": "output.outputs.1.bytes.base64"
            },
            "transform": [
                {"op": "op:core.decode", "args": {"encoding": "base64"}},
                {"op": "op:core.json_parse", "args": {}}
            ]
        }))
        .with_id("write_ann_facts");
        let definition = make_action("action:raw-process-artifact-to-write", vec![ask, write]);
        let executor = AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            Arc::new(ProcessResultOutsideAccess),
            Arc::new(TestDefinitionStore::new()),
            crate::executor::context::test_product_word_ids(),
        );

        let instance = executor
            .execute_definition(
                definition,
                make_start(),
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("public definition execution returns an instance");

        assert_eq!(
            instance.status,
            ExecutionStatus::Completed,
            "{:?}",
            instance.error_message
        );
        assert_eq!(instance.execution_context.writes.len(), 1);
        assert_eq!(
            instance.execution_context.writes[0].address,
            "proof::raw-output"
        );
        assert_eq!(instance.execution_context.writes[0].path, vec!["current"]);
        assert_eq!(
            instance.execution_context.writes[0].payload.as_deref(),
            Some(br#"{"ok":true}"#.as_slice())
        );
        assert!(
            instance
                .execution_context
                .raw_step_bytes("ann_upsert.outputs.1")
                .is_some(),
            "the artifact byte reference must survive the ask-wave delta merge"
        );
    }

    #[tokio::test]
    async fn full_dag_failed_process_fails_closed_before_downstream_write() {
        let ask = Step::ask("compute.process", json!({"argv": ["fixture"]})).with_id("ann_upsert");
        let write = Step::write(json!({
            "$kind": "binding",
            "select": {
                "from": "steps",
                "key": "ann_upsert",
                "path": "output.outputs.1.bytes.base64"
            },
            "transform": [
                {"op": "op:core.decode", "args": {"encoding": "base64"}},
                {"op": "op:core.json_parse", "args": {}}
            ]
        }))
        .with_id("write_ann_facts");
        let definition = make_action("action:failed-process-never-writes", vec![ask, write]);
        let executor = AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            Arc::new(RejectedProcessOutsideAccess),
            Arc::new(TestDefinitionStore::new()),
            crate::executor::context::test_product_word_ids(),
        );

        let instance = executor
            .execute_definition(
                definition,
                make_start(),
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("public definition execution returns a failed instance");

        assert_eq!(instance.status, ExecutionStatus::Failed);
        assert!(instance.execution_context.writes.is_empty());
        let message = instance
            .error_message
            .expect("failure evidence is preserved");
        assert!(message.contains("Exited { code: 1 }"), "{message}");
        assert!(
            message.contains("could not create facts.out.json"),
            "{message}"
        );
    }

    #[tokio::test]
    async fn full_dag_snapshot_reply_keeps_parsed_items_and_explicit_raw_bytes() {
        let reply = Step::ask(
            "slot::find-current-items",
            json!({"operation":"find-current-items"}),
        )
        .with_id("read_reply");
        let process = Step::ask("compute.process", json!({
            "argv": ["fixture"],
            "inputs": [{"mount_path":"scan.json","source":{"kind":"inline","bytes":{"$kind":"binding","select":{"from":"steps","key":"read_reply","path":"output.base64"}}}}],
            "parsed_items": {"$kind":"binding","select":{"from":"steps","key":"read_reply","path":"output.items"}}
        })).with_id("consume_reply");
        let access = Arc::new(SnapshotReplyOutsideAccess {
            captured_process_input: Mutex::new(None),
        });
        let outside_access: Arc<dyn crate::executor::context::OutsideAccess> = access.clone();
        let executor = AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            outside_access,
            Arc::new(TestDefinitionStore::new()),
            crate::executor::context::test_product_word_ids(),
        );
        let instance = executor
            .execute_definition(
                make_action("action:snapshot-binding", vec![reply, process]),
                make_start(),
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .unwrap();
        assert_eq!(
            instance.status,
            ExecutionStatus::Completed,
            "{:?}",
            instance.error_message
        );
        let captured = access
            .captured_process_input
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        assert_eq!(captured["parsed_items"], json!([{"id":"row-1"}]));
        let encoded = captured["inputs"][0]["source"]["bytes"].as_str().unwrap();
        assert_eq!(
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).unwrap(),
            br#"{"snapshot":{"digest":"1f:snapshot"},"items":[{"id":"row-1"}]}"#
        );
    }

    /// Build a CircuitState with a specific FSM value packed into packed_state.
    ///
    /// Packing formula (from circuit_breaker.rs):
    ///   packed = (fsm as u64) << 56 | (timestamp & TS_MASK)
    ///   CLOSED=0, OPEN=1, HALF_OPEN=2
    fn make_circuit_state_with_fsm(
        fsm: u8,
    ) -> Arc<resilience::StateLock<resilience::CircuitState>> {
        use core::sync::atomic::Ordering;
        let state = resilience::CircuitState::default(); // starts CLOSED
                                                         // Overwrite packed_state with the requested FSM value (timestamp=0)
        let packed = (fsm as u64) << 56;
        state.packed_state.store(packed, Ordering::Relaxed);
        Arc::new(resilience::StateLock::new(state))
    }

    // -- Test: OPEN circuit returns CircuitOpen immediately, no execute_single_step --
    #[tokio::test]
    async fn test_circuit_open_returns_immediately_without_consuming_retry_budget() {
        let deps = make_test_deps_with_circuit(make_circuit_state_with_fsm(1)); // OPEN
        let actor = make_actor();
        let step = make_action_step(0, "action:any");
        let exec_ctx = ExecutionContext::default();
        let policy = RetryPolicy {
            max_attempts: 5,
            base_delay_ms: 0,
            backoff: BackoffStrategy::None,
        };

        let result = execute_step_with_retry(&step, &exec_ctx, &deps, &actor, &policy).await;

        assert!(
            matches!(result, Err(WorkflowError::CircuitOpen { .. })),
            "Expected CircuitOpen, got: {:?}",
            result
        );
        // No retry outputs recorded — budget was NOT consumed
        assert!(
            exec_ctx.steps.is_empty(),
            "No step outputs should be recorded for OPEN circuit: {:?}",
            exec_ctx.steps.keys().collect::<Vec<_>>()
        );
    }

    // -- Test: HALF_OPEN circuit returns CircuitHalfOpen immediately --
    #[tokio::test]
    async fn test_circuit_half_open_returns_immediately_yields_to_orchestrator() {
        let deps = make_test_deps_with_circuit(make_circuit_state_with_fsm(2)); // HALF_OPEN
        let actor = make_actor();
        let step = make_action_step(0, "action:any");
        let exec_ctx = ExecutionContext::default();
        let policy = RetryPolicy {
            max_attempts: 5,
            base_delay_ms: 0,
            backoff: BackoffStrategy::None,
        };

        let result = execute_step_with_retry(&step, &exec_ctx, &deps, &actor, &policy).await;

        assert!(
            matches!(result, Err(WorkflowError::CircuitHalfOpen { .. })),
            "Expected CircuitHalfOpen, got: {:?}",
            result
        );
        // No retry outputs — budget NOT consumed
        assert!(
            exec_ctx.steps.is_empty(),
            "No step outputs should be recorded for HALF_OPEN circuit"
        );
    }

    // -- Test: CLOSED circuit (None) proceeds with normal retry logic --
    // When circuit_state is None, the function behaves exactly as before Wave 3.
    // A missing action causes StepNotFound (non-retryable) → returns immediately
    // after the first attempt without recording retry outputs.
    #[tokio::test]
    async fn test_circuit_none_proceeds_normally_non_retryable_error_exits_immediately() {
        let deps = make_test_deps(); // no circuit state — CLOSED path
        let actor = make_actor();
        let step = make_action_step(0, "action:missing");
        let exec_ctx = ExecutionContext::default();
        let policy = RetryPolicy {
            max_attempts: 3,
            base_delay_ms: 0,
            backoff: BackoffStrategy::None,
        };

        let result = execute_step_with_retry(&step, &exec_ctx, &deps, &actor, &policy).await;

        // Missing action is non-retryable: exits immediately with error,
        // zero retry_N outputs recorded
        assert!(result.is_err(), "Expected error for missing action");
        assert!(
            exec_ctx.steps.is_empty(),
            "Non-retryable error must not record retry outputs"
        );
    }

    // -- Test: is_retryable/is_fatal classification on circuit variants --
    #[test]
    fn test_circuit_error_classification() {
        let open_err = WorkflowError::CircuitOpen {
            reason: "open".into(),
        };
        assert!(
            !open_err.is_retryable(),
            "CircuitOpen must not be retryable"
        );
        assert!(
            !open_err.is_fatal(),
            "CircuitOpen must not be fatal — it is transient"
        );

        let half_open_err = WorkflowError::CircuitHalfOpen {
            reason: "half".into(),
        };
        assert!(
            !half_open_err.is_retryable(),
            "CircuitHalfOpen must not be retryable"
        );
        assert!(
            !half_open_err.is_fatal(),
            "CircuitHalfOpen must not be fatal — it is transient"
        );
    }

    // ========================================================================
    // GRAPH-NATIVE DAG TESTS (§14 adversarial matrix from graph-native-dag-proposal.md)
    //
    // These test compile_definition(), is_node_ready(), EdgeHandler/JoinHandler
    // registries, and rebuild_from_persisted(). The DAG model's core primitives.
    // ========================================================================

    use crate::domain::errors::WorkflowError;
    use crate::executor::budget::{BoundedRunLimits, BudgetedAccess, RunBudget};
    use crate::domain::handlers::{default_edge_registry, default_join_registry};
    use crate::domain::types::{ExecutionStatus, NodeReadiness, StepEdge, StepOutput};
    use crate::executor::context::{compile_definition, is_node_ready, rebuild_from_persisted};

    fn make_step(id: &str, kind: &str) -> Step {
        Step {
            id: id.to_string(),
            kind: kind.to_string(),
            config: json!({}),
            join: "any".to_string(),
            join_config: json!({}),
        }
    }

    fn make_edge(from: &str, to: &str) -> StepEdge {
        StepEdge {
            from: from.to_string(),
            to: to.to_string(),
            kind: "always".to_string(),
            config: serde_json::Value::Null,
        }
    }

    fn completed_output() -> StepOutput {
        StepOutput {
            status: ExecutionStatus::Completed,
            output: json!({"ok": true}),
            error: None,
            duration_ms: 1,
        }
    }

    fn completed_process_output(exit_code: u8) -> StepOutput {
        StepOutput {
            status: ExecutionStatus::Completed,
            output: json!({
                "termination": ProcessTermination::Exited { code: exit_code }
            }),
            error: None,
            duration_ms: 1,
        }
    }

    fn failed_output() -> StepOutput {
        StepOutput {
            status: ExecutionStatus::Failed,
            output: json!(null),
            error: Some("failed".to_string()),
            duration_ms: 1,
        }
    }

    // -- Test: Linear chain A→B→C compiles + root detection --
    #[test]
    fn test_dag_linear_chain_compile_and_root() {
        let def = Definition {
            steps: vec![
                make_step("A", "primitive"),
                make_step("B", "primitive"),
                make_step("C", "primitive"),
            ],
            edges: vec![make_edge("A", "B"), make_edge("B", "C")],
            ..Default::default()
        };
        let compiled = compile_definition(&def).unwrap();
        assert_eq!(compiled.step_map.len(), 3);
        // A has in_degree 0 (root), B and C have in_degree > 0
        assert_eq!(compiled.dag.in_degree(&"A".to_string()), 0);
        assert_eq!(compiled.dag.in_degree(&"B".to_string()), 1);
        assert_eq!(compiled.dag.in_degree(&"C".to_string()), 1);
    }

    // -- Test: Diamond DAG — A→B, A→C, B→D, C→D. D is ready after BOTH B and C (any-join). --
    #[test]
    fn test_dag_diamond_any_join() {
        let def = Definition {
            steps: vec![
                make_step("A", "primitive"),
                make_step("B", "primitive"),
                make_step("C", "primitive"),
                make_step("D", "primitive"), // join: "any" (default)
            ],
            edges: vec![
                make_edge("A", "B"),
                make_edge("A", "C"),
                make_edge("B", "D"),
                make_edge("C", "D"),
            ],
            ..Default::default()
        };
        let compiled = compile_definition(&def).unwrap();
        let edge_reg = default_edge_registry();
        let join_reg = default_join_registry();

        // After A completes, B and C should be ready
        let mut outcomes = std::collections::HashMap::new();
        outcomes.insert("A".to_string(), completed_output());

        assert_eq!(
            is_node_ready(
                "B",
                &compiled.step_map["B"],
                &compiled.dag,
                &outcomes,
                &edge_reg,
                &join_reg
            )
            .unwrap(),
            NodeReadiness::Ready
        );
        assert_eq!(
            is_node_ready(
                "C",
                &compiled.step_map["C"],
                &compiled.dag,
                &outcomes,
                &edge_reg,
                &join_reg
            )
            .unwrap(),
            NodeReadiness::Ready
        );
        // D is waiting — B and C not done yet
        assert_eq!(
            is_node_ready(
                "D",
                &compiled.step_map["D"],
                &compiled.dag,
                &outcomes,
                &edge_reg,
                &join_reg
            )
            .unwrap(),
            NodeReadiness::Waiting
        );

        // After B completes, D should be Ready (any-join: 1 of 2 satisfied)
        outcomes.insert("B".to_string(), completed_output());
        assert_eq!(
            is_node_ready(
                "D",
                &compiled.step_map["D"],
                &compiled.dag,
                &outcomes,
                &edge_reg,
                &join_reg
            )
            .unwrap(),
            NodeReadiness::Ready
        );
    }

    // -- Test: Diamond DAG with all-join — D requires BOTH B and C --
    #[test]
    fn test_dag_diamond_all_join() {
        let mut d_step = make_step("D", "primitive");
        d_step.join = "all".to_string();

        let def = Definition {
            steps: vec![
                make_step("A", "primitive"),
                make_step("B", "primitive"),
                make_step("C", "primitive"),
                d_step,
            ],
            edges: vec![
                make_edge("A", "B"),
                make_edge("A", "C"),
                make_edge("B", "D"),
                make_edge("C", "D"),
            ],
            ..Default::default()
        };
        let compiled = compile_definition(&def).unwrap();
        let edge_reg = default_edge_registry();
        let join_reg = default_join_registry();

        let mut outcomes = std::collections::HashMap::new();
        outcomes.insert("A".to_string(), completed_output());
        outcomes.insert("B".to_string(), completed_output());

        // Only B done (1 of 2), C still pending — Waiting (not Skipped, because C may still complete)
        assert_eq!(
            is_node_ready(
                "D",
                &compiled.step_map["D"],
                &compiled.dag,
                &outcomes,
                &edge_reg,
                &join_reg
            )
            .unwrap(),
            NodeReadiness::Waiting
        );

        // Both B and C done — all-join says Ready
        outcomes.insert("C".to_string(), completed_output());
        assert_eq!(
            is_node_ready(
                "D",
                &compiled.step_map["D"],
                &compiled.dag,
                &outcomes,
                &edge_reg,
                &join_reg
            )
            .unwrap(),
            NodeReadiness::Ready
        );
    }

    // -- Test: Fan-out — A→B, A→C, A→D. All three ready after A. --
    #[test]
    fn test_dag_fan_out() {
        let def = Definition {
            steps: vec![
                make_step("A", "primitive"),
                make_step("B", "primitive"),
                make_step("C", "primitive"),
                make_step("D", "primitive"),
            ],
            edges: vec![
                make_edge("A", "B"),
                make_edge("A", "C"),
                make_edge("A", "D"),
            ],
            ..Default::default()
        };
        let compiled = compile_definition(&def).unwrap();
        let edge_reg = default_edge_registry();
        let join_reg = default_join_registry();

        let mut outcomes = std::collections::HashMap::new();
        outcomes.insert("A".to_string(), completed_output());

        // All three successors ready simultaneously — emergent parallelism
        assert_eq!(
            is_node_ready(
                "B",
                &compiled.step_map["B"],
                &compiled.dag,
                &outcomes,
                &edge_reg,
                &join_reg
            )
            .unwrap(),
            NodeReadiness::Ready
        );
        assert_eq!(
            is_node_ready(
                "C",
                &compiled.step_map["C"],
                &compiled.dag,
                &outcomes,
                &edge_reg,
                &join_reg
            )
            .unwrap(),
            NodeReadiness::Ready
        );
        assert_eq!(
            is_node_ready(
                "D",
                &compiled.step_map["D"],
                &compiled.dag,
                &outcomes,
                &edge_reg,
                &join_reg
            )
            .unwrap(),
            NodeReadiness::Ready
        );
    }

    // -- Test: on_result edge — edge only satisfied when source completed successfully --
    #[test]
    fn test_dag_on_result_edge_failed_source() {
        let def = Definition {
            steps: vec![make_step("A", "primitive"), make_step("B", "primitive")],
            edges: vec![StepEdge {
                from: "A".to_string(),
                to: "B".to_string(),
                kind: "on_result".to_string(),
                config: serde_json::Value::Null,
            }],
            ..Default::default()
        };
        let compiled = compile_definition(&def).unwrap();
        let edge_reg = default_edge_registry();
        let join_reg = default_join_registry();

        // A failed — on_result edge NOT satisfied
        let mut outcomes = std::collections::HashMap::new();
        outcomes.insert("A".to_string(), failed_output());

        // B should be Skipped (predecessor done, edge not satisfied, any-join with 0 satisfied)
        assert_eq!(
            is_node_ready(
                "B",
                &compiled.step_map["B"],
                &compiled.dag,
                &outcomes,
                &edge_reg,
                &join_reg
            )
            .unwrap(),
            NodeReadiness::Skipped
        );
    }

    // -- Test: on_result edge condition uses BindingResolver/ops-core, not presence = true --
    #[test]
    fn test_dag_on_result_edge_condition_controls_readiness() {
        let success_condition = json!({
            "$kind": "binding",
            "select": {
                "from": "input",
                "path": "output.termination.code"
            },
            "transform": [
                {
                    "op": "op:core.equals",
                    "args": { "value": 0 }
                }
            ]
        });
        let def = Definition {
            steps: vec![make_step("A", "primitive"), make_step("B", "primitive")],
            edges: vec![StepEdge {
                from: "A".to_string(),
                to: "B".to_string(),
                kind: "on_result".to_string(),
                config: success_condition,
            }],
            ..Default::default()
        };
        let compiled = compile_definition(&def).unwrap();
        let edge_reg = default_edge_registry();
        let join_reg = default_join_registry();

        let mut outcomes = std::collections::HashMap::new();
        outcomes.insert("A".to_string(), completed_process_output(0));
        assert_eq!(
            is_node_ready(
                "B",
                &compiled.step_map["B"],
                &compiled.dag,
                &outcomes,
                &edge_reg,
                &join_reg,
            )
            .unwrap(),
            NodeReadiness::Ready
        );

        outcomes.insert("A".to_string(), completed_process_output(1));
        assert_eq!(
            is_node_ready(
                "B",
                &compiled.step_map["B"],
                &compiled.dag,
                &outcomes,
                &edge_reg,
                &join_reg,
            )
            .unwrap(),
            NodeReadiness::Skipped
        );
    }

    #[tokio::test]
    async fn execute_dag_merge_runs_when_other_branch_is_skipped() {
        let scan_needed = json!({
            "$kind": "binding",
            "select": {
                "from": "input",
                "path": "output.scan_needed"
            },
            "transform": [
                {
                    "op": "op:core.equals",
                    "args": { "value": true }
                }
            ]
        });
        let scan_not_needed = json!({
            "$kind": "binding",
            "select": {
                "from": "input",
                "path": "output.scan_needed"
            },
            "transform": [
                {
                    "op": "op:core.equals",
                    "args": { "value": false }
                }
            ]
        });
        let definition = Definition {
            id: "action:merge-after-skipped-branch".to_string(),
            partition_key: "partition:test".to_string(),
            name: "merge after skipped branch".to_string(),
            description: "test".to_string(),
            input_schema: json!({}),
            steps: vec![
                Step::return_value(json!({"scan_needed": false})).with_id("decide"),
                Step::return_value(json!({"ran": true})).with_id("scan"),
                Step::return_value(json!({"proof": "current"})).with_id("proof"),
            ],
            edges: vec![
                StepEdge {
                    from: "decide".to_string(),
                    to: "scan".to_string(),
                    kind: "on_result".to_string(),
                    config: scan_needed,
                },
                StepEdge {
                    from: "decide".to_string(),
                    to: "proof".to_string(),
                    kind: "on_result".to_string(),
                    config: scan_not_needed,
                },
                StepEdge {
                    from: "scan".to_string(),
                    to: "proof".to_string(),
                    kind: "always".to_string(),
                    config: serde_json::Value::Null,
                },
            ],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };

        let executor = make_executor();
        let instance = executor
            .execute_definition(
                definition,
                make_start(),
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("merge executes");

        assert_eq!(instance.status, ExecutionStatus::Completed);
        assert_eq!(
            instance.execution_context.steps["proof"].output,
            json!({"proof": "current"})
        );
        assert!(
            instance.execution_context.steps["scan"]
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("Skipped"),
            "scan branch should be skipped without killing the merge"
        );
        assert_eq!(instance.execution_context.steps["scan"].status, ExecutionStatus::Skipped);
    }

    fn edge(from: &str, to: &str, kind: &str, config: Value) -> StepEdge {
        StepEdge { from: from.to_string(), to: to.to_string(), kind: kind.to_string(), config }
    }

    fn refusal(steps: Vec<Step>, edges: Vec<StepEdge>) -> String {
        match compile_definition(&Definition { steps, edges, ..Default::default() }) {
            Err(WorkflowError::InvalidWorkflow { reason, .. }) => reason,
            Err(other) => panic!("refused as {other:?}"),
            Ok(_) => panic!("the definition compiled"),
        }
    }

    // Nov 21 2026: `parse -> judge` written once `always` and once `on_failure` kept only the last, so a parse that
    // succeeded skipped the judge and the run ended completed with nothing judged.
    #[test]
    fn two_edges_between_the_same_two_steps_are_refused() {
        let steps = || vec![Step::return_value(json!({"parsed": true})).with_id("parse"), Step::return_value(json!(99)).with_id("judge")];
        let reason = refusal(steps(), vec![edge("parse", "judge", "always", Value::Null), edge("parse", "judge", "on_failure", Value::Null)]);
        assert!(reason.contains("Two edges join step 'parse' to step 'judge'"), "{reason}");
        let when = |value: &str| json!({"$kind": "binding", "select": {"from": "input", "path": "output.status"},
            "transform": [{"op": "op:core.equals", "args": {"value": value}}]});
        let reason = refusal(steps(), vec![edge("parse", "judge", "on_result", when("a")), edge("parse", "judge", "on_result", when("b"))]);
        assert!(reason.contains("Two edges join"), "two conditions to the same step are refused too: {reason}");
    }

    #[test]
    fn an_edge_to_a_step_the_definition_lacks_is_refused_by_name() {
        let reason = refusal(vec![Step::return_value(json!(1)).with_id("a")], vec![edge("a", "judge", "always", Value::Null)]);
        assert!(reason.contains("names step 'judge'"), "{reason}");
        let reason = refusal(vec![Step::return_value(json!(1)).with_id("a")], vec![edge("parse", "a", "always", Value::Null)]);
        assert!(reason.contains("names step 'parse'"), "{reason}");
    }

    #[test]
    fn an_edge_loop_is_refused() {
        let steps = vec![Step::return_value(json!(1)).with_id("a"), Step::return_value(json!(2)).with_id("b")];
        let reason = refusal(steps, vec![edge("a", "b", "always", Value::Null), edge("b", "a", "always", Value::Null)]);
        assert!(reason.contains("Cycle detected"), "{reason}");
    }

    #[tokio::test]
    async fn a_recovery_branch_not_taken_is_skipped_and_the_run_completes() {
        let definition = Definition {
            id: "action:recovery-not-taken".to_string(),
            steps: vec![
                Step::return_value(json!({"parsed": true})).with_id("parse"),
                Step::return_value(json!({"verdict": 99})).with_id("judge"),
                Step::return_value(json!({"recovered": true})).with_id("recover"),
            ],
            edges: vec![edge("parse", "judge", "always", Value::Null), edge("parse", "recover", "on_failure", Value::Null)],
            is_active: true,
            ..Default::default()
        };
        let run = make_executor()
            .execute_definition(definition, make_start(), make_actor(), &RetryPolicy::default())
            .await
            .expect("the run executes");
        assert_eq!(run.status, ExecutionStatus::Completed, "{:?}", run.error_message);
        let steps = &run.execution_context.steps;
        assert_eq!(steps["judge"].status, ExecutionStatus::Completed);
        assert_eq!(steps["judge"].output, json!({"verdict": 99}));
        assert_eq!(steps["recover"].status, ExecutionStatus::Skipped);
        assert_eq!(serde_json::to_value(steps["recover"].status).unwrap(), json!("skipped"));
    }

    #[test]
    fn on_failure_edge_is_satisfied_only_by_failed_outcomes() {
        let definition = Definition {
            steps: vec![
                Step::fail(json!("boom")).with_id("origin"),
                Step::return_value(json!({"recovered": true})).with_id("recover"),
            ],
            edges: vec![StepEdge {
                from: "origin".to_string(),
                to: "recover".to_string(),
                kind: "on_failure".to_string(),
                config: Value::Null,
            }],
            ..Default::default()
        };
        let compiled = compile_definition(&definition).expect("definition compiles");
        let edge_registry = default_edge_registry();
        let join_registry = default_join_registry();
        let mut outcomes = HashMap::new();
        outcomes.insert(
            "origin".to_string(),
            StepOutput {
                output: Value::Null,
                status: ExecutionStatus::Failed,
                error: Some("boom".to_string()),
                duration_ms: 0,
            },
        );
        assert_eq!(
            is_node_ready(
                "recover",
                &compiled.step_map["recover"],
                &compiled.dag,
                &outcomes,
                &edge_registry,
                &join_registry,
            )
            .expect("failure edge evaluates"),
            NodeReadiness::Ready
        );
        outcomes.insert("origin".to_string(), completed_output());
        assert_eq!(
            is_node_ready(
                "recover",
                &compiled.step_map["recover"],
                &compiled.dag,
                &outcomes,
                &edge_registry,
                &join_registry,
            )
            .expect("success outcome evaluates"),
            NodeReadiness::Skipped
        );
    }

    #[tokio::test]
    async fn on_failure_branch_can_recover_through_data_and_unhandled_fail_still_aborts() {
        let recovered = Definition {
            id: "action:recover".to_string(),
            partition_key: "partition:test".to_string(),
            name: "recover".to_string(),
            steps: vec![
                Step::fail(json!("simulated failure")).with_id("origin"),
                Step::return_value(json!({
                    "recovered_error": {
                        "$kind": "binding",
                        "select": {"from": "steps", "key": "origin", "path": "error"}
                    }
                }))
                .with_id("recover"),
            ],
            edges: vec![StepEdge {
                from: "origin".to_string(),
                to: "recover".to_string(),
                kind: "on_failure".to_string(),
                config: Value::Null,
            }],
            is_active: true,
            ..Default::default()
        };
        let instance = make_executor()
            .execute_definition(
                recovered,
                make_start(),
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("DATA-declared recovery completes");
        assert_eq!(instance.status, ExecutionStatus::Completed);
        assert!(
            instance.execution_context.steps["recover"].output["recovered_error"]
                .as_str()
                .is_some_and(|error| error.contains("simulated failure"))
        );

        let unhandled = make_action(
            "action:unhandled-failure",
            vec![Step::fail(json!("must abort")).with_id("fail")],
        );
        let failed = make_executor()
            .execute_definition(
                unhandled,
                make_start(),
                make_actor(),
                &RetryPolicy::default(),
            )
            .await
            .expect("execution failures are represented by the returned instance");
        assert_eq!(failed.status, ExecutionStatus::Failed);
        assert!(failed
            .error_message
            .as_deref()
            .is_some_and(|error| error.contains("must abort")));
    }

    /// A DATA-declared threshold comparison on an `on_result` edge must route in BOTH
    /// directions: traverse when the condition holds, and refuse to traverse when it does not.
    ///
    /// Every other `on_result` test either leaves `config` null (unconditional) or asserts the
    /// error path for an unregistered op, so the ordinary true/false routing that every
    /// data-declared admission decision depends on had no coverage. A guard built on this edge
    /// would inherit that gap: an edge that never denies looks identical to an edge that always
    /// permits, and only the false case distinguishes them.
    fn threshold_edge(min: f64) -> StepEdge {
        StepEdge {
            from: "A".to_string(),
            to: "B".to_string(),
            kind: "on_result".to_string(),
            config: json!({
                "$kind": "binding",
                "select": { "from": "input", "path": "output.measured" },
                "transform": [{ "op": "op:core.gte", "args": { "value": min } }]
            }),
        }
    }

    fn measured_output(measured: f64) -> StepOutput {
        StepOutput {
            status: ExecutionStatus::Completed,
            output: json!({ "measured": measured }),
            error: None,
            duration_ms: 1,
        }
    }

    fn edge_traverses(edge: StepEdge, outcome: StepOutput) -> bool {
        let def = Definition {
            steps: vec![make_step("A", "primitive"), make_step("B", "primitive")],
            edges: vec![edge],
            ..Default::default()
        };
        let compiled = compile_definition(&def).unwrap();
        let mut outcomes = std::collections::HashMap::new();
        outcomes.insert("A".to_string(), outcome);
        matches!(
            is_node_ready(
                "B",
                &compiled.step_map["B"],
                &compiled.dag,
                &outcomes,
                &default_edge_registry(),
                &default_join_registry(),
            )
            .expect("a registered op resolves without error"),
            NodeReadiness::Ready
        )
    }

    #[test]
    fn test_dag_on_result_threshold_condition_routes_in_both_directions() {
        // Above and exactly at the threshold admit.
        assert!(
            edge_traverses(threshold_edge(0.75), measured_output(0.9)),
            "0.9 >= 0.75 must traverse"
        );
        assert!(
            edge_traverses(threshold_edge(0.75), measured_output(0.75)),
            "the boundary value is inclusive for gte and must traverse"
        );
        // Below the threshold must NOT traverse. This is the assertion that gives a
        // data-declared guard its meaning.
        assert!(
            !edge_traverses(threshold_edge(0.75), measured_output(0.6)),
            "0.6 < 0.75 must not traverse, or the threshold decides nothing"
        );
        // A different threshold on the same value proves the comparison reads the DATA rather
        // than a constant baked into the engine.
        assert!(
            edge_traverses(threshold_edge(0.5), measured_output(0.6)),
            "0.6 >= 0.5 must traverse, so the bound comes from the edge config"
        );
    }

    /// The absent case, which is where a threshold guard would silently invert. When the value
    /// the condition reads is missing, the edge must not traverse: an admission decision that
    /// treats "no measurement" as "passed" is worse than one that never ran.
    #[test]
    fn test_dag_on_result_threshold_fails_naming_the_step_when_the_value_is_absent() {
        // A missing measurement neither satisfies a threshold nor quietly skips everything after it (Nov 21 2026 4:14 PM CST,
        // workflow_newsletter-for-a-pursuit): the condition comes to null, and the run fails, naming the step and the value.
        let absent = StepOutput {
            status: ExecutionStatus::Completed,
            output: json!({}),
            error: None,
            duration_ms: 1,
        };
        let def = Definition {
            steps: vec![make_step("A", "primitive"), make_step("B", "primitive")],
            edges: vec![threshold_edge(0.75)],
            ..Default::default()
        };
        let compiled = compile_definition(&def).unwrap();
        let mut outcomes = std::collections::HashMap::new();
        outcomes.insert("A".to_string(), absent);
        let refused = is_node_ready("B", &compiled.step_map["B"], &compiled.dag, &outcomes, &default_edge_registry(), &default_join_registry())
            .err().expect("an absent value is a type error, never a quiet not-taken");
        assert!(refused.to_string().contains("'A' came to null, not true or false"), "{refused}");
    }

    // -- Test: invalid on_result conditions fail loudly instead of silently traversing. --
    #[test]
    fn test_dag_on_result_edge_condition_error_is_structured() {
        let def = Definition {
            steps: vec![make_step("A", "primitive"), make_step("B", "primitive")],
            edges: vec![StepEdge {
                from: "A".to_string(),
                to: "B".to_string(),
                kind: "on_result".to_string(),
                config: json!({
                    "$kind": "binding",
                    "select": {
                        "from": "input",
                        "path": "output.termination.code"
                    },
                    "transform": [
                        { "op": "op:core.not_registered" }
                    ]
                }),
            }],
            ..Default::default()
        };
        let compiled = compile_definition(&def).unwrap();
        let edge_reg = default_edge_registry();
        let join_reg = default_join_registry();
        let mut outcomes = std::collections::HashMap::new();
        outcomes.insert("A".to_string(), completed_process_output(0));

        let error = is_node_ready(
            "B",
            &compiled.step_map["B"],
            &compiled.dag,
            &outcomes,
            &edge_reg,
            &join_reg,
        )
        .unwrap_err();

        assert!(matches!(
            error,
            WorkflowError::ConditionEvaluationFailed { .. }
        ));
    }

    // -- Test: Crash recovery via rebuild_from_persisted --
    #[test]
    fn test_dag_rebuild_from_persisted() {
        let def = Definition {
            steps: vec![
                make_step("A", "primitive"),
                make_step("B", "primitive"),
                make_step("C", "primitive"),
            ],
            edges: vec![make_edge("A", "B"), make_edge("B", "C")],
            ..Default::default()
        };
        let compiled = compile_definition(&def).unwrap();
        let edge_reg = default_edge_registry();
        let join_reg = default_join_registry();

        // Simulate crash: A completed, B not started
        let mut persisted = std::collections::HashMap::new();
        persisted.insert("A".to_string(), completed_output());

        let frontier = rebuild_from_persisted(&compiled, &persisted, &edge_reg, &join_reg).unwrap();
        // B should be in the frontier (ready), C should not (waiting for B)
        assert!(
            frontier.contains(&"B".to_string()),
            "B should be in frontier: {:?}",
            frontier
        );
        assert!(
            !frontier.contains(&"C".to_string()),
            "C should NOT be in frontier: {:?}",
            frontier
        );
        assert!(
            !frontier.contains(&"A".to_string()),
            "A already completed: {:?}",
            frontier
        );
    }

    // -- Test: Cycle detection in compile_definition --
    #[test]
    fn test_dag_cycle_detection() {
        let def = Definition {
            steps: vec![make_step("A", "primitive"), make_step("B", "primitive")],
            edges: vec![make_edge("A", "B"), make_edge("B", "A")],
            ..Default::default()
        };
        let result = compile_definition(&def);
        assert!(result.is_err(), "Cycle A→B→A should fail compilation");
        match result {
            Err(e) => {
                let err_msg = e.to_string();
                assert!(
                    err_msg.contains("Cycle") || err_msg.contains("cycle"),
                    "Error should mention cycle: {}",
                    err_msg
                );
            }
            Ok(_) => panic!("Expected cycle detection error"),
        }
    }

    // -- Test: Empty edges = implicit sequential (array order) --
    #[test]
    fn test_dag_no_edges_use_implicit_sequence() {
        let def = Definition {
            steps: vec![make_step("A", "primitive"), make_step("B", "primitive")],
            edges: vec![],
            ..Default::default()
        };
        let compiled = compile_definition(&def).unwrap();
        // Empty edges are the compatibility/authoring shorthand for array-order
        // sequencing, so A is the root and B waits for A.
        assert_eq!(compiled.dag.in_degree(&"A".to_string()), 0);
        assert_eq!(compiled.dag.in_degree(&"B".to_string()), 1);
    }

    // -- Test: Default step_registry has all built-in kinds --
    #[test]
    fn test_default_step_registry_built_in_kinds() {
        let registry = default_step_registry();
        assert!(registry.contains_key("read"), "read handler missing");
        assert!(registry.contains_key("write"), "write handler missing");
        assert!(registry.contains_key("ask"), "ask handler missing");
        assert!(registry.contains_key("return"), "return handler missing");
        assert!(registry.contains_key("fail"), "fail handler missing");
        assert!(registry.contains_key("action"), "action handler missing");
        assert!(
            registry.contains_key("run-owner-requested-definition"),
            "run-owner-requested-definition handler missing"
        );
        assert!(registry.contains_key("loop"), "loop handler missing");
        assert!(registry.contains_key("wait"), "wait handler missing");
        // Branch and parallel are NOT step kinds in the DAG model
        assert!(
            !registry.contains_key("branch"),
            "branch should NOT be a step kind"
        );
        assert!(
            !registry.contains_key("parallel"),
            "parallel should NOT be a step kind"
        );
    }

    // -- Test: Default edge_registry has built-in kinds --
    #[test]
    fn test_default_edge_registry_built_in_kinds() {
        let registry = default_edge_registry();
        assert!(
            registry.contains_key("always"),
            "always edge handler missing"
        );
        assert!(
            registry.contains_key("on_result"),
            "on_result edge handler missing"
        );
        assert!(
            registry.contains_key("on_failure"),
            "on_failure edge handler missing"
        );
    }

    // -- Test: Default join_registry has built-in kinds --
    #[test]
    fn test_default_join_registry_built_in_kinds() {
        let registry = default_join_registry();
        assert!(registry.contains_key("any"), "any join handler missing");
        assert!(registry.contains_key("all"), "all join handler missing");
    }

    #[test]
    fn test_build_context_delta_preserves_shared_raw_byte_refs_without_reemitting() {
        let shared = Arc::<[u8]>::from(vec![1_u8, 2, 3, 4]);

        let mut base_ctx = ExecutionContext::default();
        base_ctx.record_raw_step_bytes("blob".to_string(), Arc::clone(&shared));

        let scratchpad = base_ctx.fork_for_delta_capture();

        let delta = build_context_delta(
            &scratchpad,
            StepOutput {
                output: Value::Null,
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 0,
            },
        );

        assert!(
            delta.raw_step_bytes.is_empty(),
            "shared raw byte refs should not be re-emitted in the delta",
        );
        assert!(
            delta.cleared_raw_step_bytes.is_empty(),
            "shared raw byte refs should not be marked as cleared",
        );
    }

    #[test]
    fn fork_for_delta_capture_keeps_inherited_writes_visible_without_reemitting() {
        let inherited_payload = Arc::<[u8]>::from(br#"{"subject_id":"item:one"}"#.to_vec());
        let inherited = PendingWrite {
            partition_key: None,
            address: "attribute_fact|partition:test|item:one|prop:title|type:string".to_string(),
            address_mode: None,
            path: vec!["current-item".to_string(), "attribute_fact".to_string()],
            payload: Some(Arc::clone(&inherited_payload)),
        };
        let produced = PendingWrite {
            partition_key: None,
            address: "journal-notes".to_string(),
            address_mode: None,
            path: vec!["current-item".to_string(), "feed".to_string()],
            payload: Some(b"RTBL".to_vec().into()),
        };

        let mut base_ctx = ExecutionContext::default();
        base_ctx.push_write(inherited.clone());

        let mut scratchpad = base_ctx.fork_for_delta_capture();
        assert!(
            Arc::ptr_eq(
                base_ctx.writes[0].payload.as_ref().expect("base payload"),
                scratchpad.writes[0].payload.as_ref().expect("fork payload"),
            ),
            "forking a transaction must share immutable payload bytes",
        );
        assert_eq!(
            scratchpad.writes,
            vec![inherited],
            "forked action contexts must read inherited pending writes",
        );
        scratchpad.push_write(produced.clone());

        let delta = build_context_delta(
            &scratchpad,
            StepOutput {
                output: Value::Null,
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 0,
            },
        );

        assert_eq!(
            delta.writes,
            vec![produced],
            "action deltas must emit only writes produced inside the fork",
        );
    }

    #[test]
    fn transaction_writes_are_last_write_wins_and_overrides_are_delta_visible() {
        let first = PendingWrite {
            partition_key: None,
            address: "record::same".to_string(),
            address_mode: Some("identity_text".to_string()),
            path: vec!["first-path".to_string()],
            payload: Some(b"first".to_vec().into()),
        };
        let replacement = PendingWrite {
            partition_key: None,
            address: "record::same".to_string(),
            address_mode: Some("identity_text".to_string()),
            path: vec!["replacement-path".to_string()],
            payload: None,
        };
        let mut base_ctx = ExecutionContext::default();
        base_ctx.context.partition_key = "runtime-partition".to_string();
        base_ctx.push_write(first);

        let mut scratchpad = base_ctx.fork_for_delta_capture();
        scratchpad.push_write(replacement.clone());
        assert_eq!(
            scratchpad.writes,
            vec![replacement.clone()],
            "the transaction retains one current value per effective fact identity",
        );
        assert_eq!(
            scratchpad.captured_writes(),
            vec![replacement],
            "replacing an inherited value is still emitted by the child delta",
        );
    }

    #[test]
    fn explicit_default_partition_and_inherited_partition_share_one_identity() {
        let mut context = ExecutionContext::default();
        context.context.partition_key = "runtime-partition".to_string();
        context.push_write(PendingWrite {
            partition_key: None,
            address: "row|one".to_string(),
            address_mode: None,
            path: Vec::new(),
            payload: Some(b"first".to_vec().into()),
        });
        context.push_write(PendingWrite {
            partition_key: Some("runtime-partition".to_string()),
            address: "row|one".to_string(),
            address_mode: Some("identity_text".to_string()),
            path: Vec::new(),
            payload: Some(b"second".to_vec().into()),
        });

        assert_eq!(context.writes.len(), 1);
        assert_eq!(
            context.writes[0].payload.as_deref(),
            Some(b"second".as_slice())
        );
    }

    #[tokio::test]
    async fn return_step_resolves_raw_bytes_without_reinterpreting_payload_json() {
        let mut exec_ctx = ExecutionContext::default();
        let page = json!({
            "version": 1,
            "lines": [{
                "type": "tool_use",
                "content": "payload",
                "toolInput": {
                    "$kind": "binding",
                    "select": { "from": "context", "path": "partition_key" }
                }
            }]
        });
        let page_bytes = serde_json::to_vec(&page).expect("page serializes");
        exec_ctx.record_raw_step_bytes(
            "process_step.outputs.0".to_string(),
            Arc::from(page_bytes.into_boxed_slice()),
        );
        record_step_output(
            &mut exec_ctx,
            "process_step",
            StepOutput {
                output: json!({
                    "outputs": [{
                        "mount_path": "transcript-page.json",
                        "bytes": {
                            "kind": "bytes",
                            "ref": "process_step.outputs.0",
                            "size": 0
                        }
                    }]
                }),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 0,
            },
        );

        let step = Step::return_value(json!({
            "$kind": "binding",
            "select": {
                "from": "steps",
                "key": "process_step",
                "path": "output.outputs.0.bytes.base64"
            },
            "transform": [
                { "op": "op:core.decode", "args": { "encoding": "base64" } },
                { "op": "op:core.json_parse" }
            ],
            "resolve_nested_bindings": false
        }))
        .with_id("return_page");
        let deps = make_test_deps();
        let registry = default_step_registry();
        let handler = registry.get("return").expect("return handler registered");

        let result = handler
            .execute(&step, &exec_ctx, &deps, &make_actor())
            .await
            .expect("return step resolves");

        assert_eq!(result.output.status, ExecutionStatus::Completed);
        assert_eq!(
            result.output.output["lines"][0]["toolInput"]["$kind"],
            json!("binding")
        );
        assert_eq!(
            result.output.output["lines"][0]["toolInput"]["select"]["from"],
            json!("context")
        );
    }

    #[tokio::test]
    async fn bounded_budget_charges_each_retry_before_reentering_the_handler() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct FailsOnce(Arc<AtomicUsize>);
        #[async_trait::async_trait]
        impl crate::domain::handlers::StepHandler for FailsOnce {
            async fn execute(
                &self,
                _step: &Step,
                _ctx: &ExecutionContext,
                _deps: &crate::executor::context::ExecutorDeps,
                _actor: &ActorContext,
            ) -> Result<StepHandlerResult, WorkflowError> {
                if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err(WorkflowError::ExecutionFailed { reason: "retry me".into(), hint: "test".into() })
                } else {
                    Ok(StepHandlerResult::leaf(StepOutput {
                        output: Value::Null, status: ExecutionStatus::Completed, error: None, duration_ms: 0,
                    }))
                }
            }
        }

        let calls = Arc::new(AtomicUsize::new(0));
        let mut deps = make_test_deps();
        let mut registry = default_step_registry();
        registry.insert("retry-budget".into(), Box::new(FailsOnce(Arc::clone(&calls))));
        deps.step_registry = Arc::new(registry);
        let budget = Arc::new(RunBudget::new(BoundedRunLimits {
            max_step_attempts: 1, max_loop_iterations: 4, max_action_depth: 4,
        }));
        deps.outside_access = Arc::new(BudgetedAccess::new(deps.outside_access, Arc::clone(&budget)));
        let context = ExecutionContext::default();
        let step: Step = serde_json::from_value(json!({
            "id": "retry", "kind": "retry-budget", "config": {}
        })).unwrap();
        let retry = RetryPolicy { max_attempts: 2, base_delay_ms: 0, backoff: BackoffStrategy::None };
        let error = execute_step_with_retry(&step, &context, &deps, &make_actor(), &retry)
            .await.expect_err("second attempt is refused before handler dispatch");
        assert!(matches!(error, WorkflowError::ExecutionFailed { .. }));
        let refusal = budget.refusal().expect("typed sticky budget refusal");
        assert_eq!(refusal.dimension, "step_attempts");
        assert_eq!(refusal.attempted, 2);
        assert_eq!(refusal.limit, 1);
        assert_eq!(refusal.step_attempts_used, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "only the admitted first handler attempt ran");
    }

    #[cfg(feature = "native")]
    #[tokio::test]
    async fn bounded_nested_exhaustion_refuses_before_native_retry_backoff() {
        let mut store = TestDefinitionStore::new();
        store.register(make_action("child-budget", vec![make_leaf_step().with_id("ask")]));
        let executor = make_executor_with_store(store);
        let definition = make_workflow("root-budget", vec![make_action_step(0, "child-budget")]);
        let retry = RetryPolicy { max_attempts: 2, base_delay_ms: 2000, backoff: BackoffStrategy::Fixed };
        let future = executor.execute_definition_bounded(
            definition, make_start(), make_actor(), &retry,
            BoundedRunLimits { max_step_attempts: 1, max_loop_iterations: 4, max_action_depth: 4 },
        );
        let failure = tokio::time::timeout(std::time::Duration::from_millis(250), future)
            .await.expect("a known fatal invocation refusal must not sleep for retry backoff")
            .expect_err("the child's dispatch exceeds the one root attempt allowance");
        let BoundedExecutionError::Budget(refusal) = failure else { panic!("expected typed budget refusal") };
        assert_eq!(refusal.dimension, "step_attempts");
        assert_eq!(refusal.step_attempts_used, 1);
        assert_eq!(refusal.attempted, 2);
    }
}
