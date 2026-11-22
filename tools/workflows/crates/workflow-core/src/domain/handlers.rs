// crates/workflow-core/src/domain/handlers.rs
//
// Purpose:
//   Handler traits for the graph-native DAG execution model (§45 amendment).
//   Three registries — StepHandler, EdgeHandler, JoinHandler — all dispatched
//   by string kind + opaque Value config. ZERO enums in the engine (L090).
//
// Non-Negotiable Invariants:
//   1. The engine NEVER enumerates step/edge/join kinds — handlers are registered
//      by string key. Adding a new kind = registering a handler. Zero engine changes.
//   2. All handler state is immutable after registration — handlers are Send + Sync.
//   3. Each registry is a HashMap<String, Box<dyn Handler>> — the L090 generative
//      primitive of self-describing data + generic dispatch.
//
// Key Concepts:
//   - StepHandler: Executes a single step node. Registered by step.kind string.
//   - EdgeHandler: Evaluates whether an edge is satisfied given source outcome.
//   - JoinHandler: Evaluates node readiness at fan-in/merge points.
//   - All use opaque config (serde_json::Value) — the handler parses what it needs.

use async_trait::async_trait;
use serde_json::Value;
use slot_protocol::ActorContext;
use std::collections::HashMap;

use crate::domain::errors::WorkflowError;
use crate::domain::types::{
    ExecutionContext, NodeReadiness, StartData, Step, StepHandlerResult, StepOutput,
};
use crate::executor::context::BindingResolver;

// ============================================================================
// EXECUTOR DEPENDENCIES — passed to StepHandlers during execution
// ============================================================================

// ============================================================================
// STEP HANDLER — Registered by step.kind string (L090)
//
// Plan reference: graph-native-dag-proposal.md §5e
// The execute_single_step match block is REPLACED by:
//   registry.get(step.kind).execute(step, exec_ctx, deps, actor)
// ============================================================================

/// Step handler trait — registered by kind string (§5e).
///
/// Built-in handlers registered at engine startup:
///   "primitive" → dispatches Envelope to a slot
///   "action"    → loads sub-Definition, executes its steps via deps.step_registry
///   "loop"      → iterates, executes sub-Definition per item
///   "wait"      → suspends execution (temporal primitive)
///
/// Custom kinds → user-registered handlers. Zero engine code changes.
///
/// NOTE: "branch" and "parallel" are NOT built-in step kinds in the DAG model.
///   Branching = edge conditions (EdgeHandler evaluates StepOutput via Binding AST)
///   Parallelism = concurrent graph walker (emergent from DAG independence)
///
/// # Concurrency Contract
///
/// `exec_ctx` is READ-ONLY — the handler sees a snapshot of completed step outputs
/// for binding resolution, but does NOT mutate the orchestrator's master context.
/// Handlers that execute sub-steps (action, loop) create their own internal
/// mutable context and return sub-step recordings via `StepHandlerResult.sub_steps`.
/// The concurrent walker merges these into the master context after the handler returns.
#[async_trait]
pub trait StepHandler: Send + Sync {
    /// Execute a single step against a read-only execution context snapshot.
    ///
    /// - `step`: The Step with its kind and opaque config
    /// - `exec_ctx`: Read-only execution context (step outputs, trigger, params)
    /// - `deps`: The ONE unified dependency bag (CSSOT — host + engine capabilities)
    /// - `actor`: The actor context (who triggered this)
    ///
    /// Returns a StepHandlerResult containing the primary StepOutput plus any
    /// sub-step recordings. The CALLER (concurrent walker) merges these into the
    /// master context — handlers do NOT write to the orchestrator's state.
    async fn execute(
        &self,
        step: &Step,
        exec_ctx: &ExecutionContext,
        deps: &crate::executor::context::ExecutorDeps,
        actor: &ActorContext,
    ) -> Result<StepHandlerResult, WorkflowError>;
}

/// The step handler registry — HashMap<String, Box<dyn StepHandler>>.
/// Adding a new step kind = registering a handler. Zero engine code changes.
pub type StepHandlerRegistry = HashMap<String, Box<dyn StepHandler>>;

// ============================================================================
// EDGE HANDLER — Registered by edge.kind string (L090)
// ============================================================================

/// Edge handler trait — registered by kind string.
///
/// Given the source step's outcome and the edge's condition config,
/// returns true if this edge should be traversed.
///
/// Built-in handlers:
///   "always"    → unconditional (condition ignored)
///   "on_result" → evaluates StepOutput against a condition (Binding AST)
///
/// Custom edge kinds → user-registered handlers.
pub trait EdgeHandler: Send + Sync {
    fn evaluate(
        &self,
        source_id: &str,
        outcome: &StepOutput,
        condition: &Option<Value>,
    ) -> Result<bool, WorkflowError>;
}

/// The edge handler registry — HashMap<String, Box<dyn EdgeHandler>>.
pub type EdgeHandlerRegistry = HashMap<String, Box<dyn EdgeHandler>>;

// ============================================================================
// JOIN HANDLER — Registered by step.join string (L090)
// ============================================================================

/// Context passed to JoinHandlers for fan-in readiness evaluation.
pub struct JoinContext<'a> {
    /// Number of inbound edges that are satisfied
    pub satisfied_edges: usize,
    /// Total number of inbound edges
    pub total_edges: usize,
    /// The node's join_config (opaque JSON — handler parses what it needs)
    pub config: &'a Value,
    /// Detail: (source_id, outcome, edge_satisfied) for each inbound edge
    pub inbound: &'a [(&'a str, &'a StepOutput, bool)],
}

/// Join handler trait — registered by step.join string.
///
/// Determines how a node with multiple inbound edges evaluates readiness.
///
/// Built-in handlers:
///   "any" → satisfied_edges > 0 (default — fan-in/merge)
///   "all" → satisfied_edges == total_edges (strict synchronization barrier)
///
/// Custom: "quorum" → threshold from join_config, "weighted" → custom math, etc.
pub trait JoinHandler: Send + Sync {
    fn evaluate(&self, ctx: &JoinContext) -> NodeReadiness;
}

/// The join handler registry — HashMap<String, Box<dyn JoinHandler>>.
pub type JoinHandlerRegistry = HashMap<String, Box<dyn JoinHandler>>;

// ============================================================================
// BUILT-IN EDGE HANDLERS
// ============================================================================

/// Always-edge: unconditionally satisfied.
pub struct AlwaysEdgeHandler;
impl EdgeHandler for AlwaysEdgeHandler {
    fn evaluate(
        &self,
        _source_id: &str,
        outcome: &StepOutput,
        _condition: &Option<Value>,
    ) -> Result<bool, WorkflowError> {
        use crate::domain::types::ExecutionStatus;
        Ok(outcome.status == ExecutionStatus::Completed && outcome.error.is_none())
    }
}

/// On-result edge: satisfied when the source step completed successfully
/// and the optional condition (Binding AST) evaluates to true against the output.
///
/// Condition evaluation uses the same BindingResolver path as step inputs.
/// When a condition is present, `input` is the full source StepOutput, so data
/// can select `output`, `status`, `error`, or `duration_ms` without any
/// edge-handler-specific mini-language. Without a condition, completion alone
/// is sufficient.
pub struct OnResultEdgeHandler;
impl EdgeHandler for OnResultEdgeHandler {
    fn evaluate(
        &self,
        source_id: &str,
        outcome: &StepOutput,
        condition: &Option<Value>,
    ) -> Result<bool, WorkflowError> {
        use crate::domain::types::ExecutionStatus;
        if outcome.status != ExecutionStatus::Completed || outcome.error.is_some() {
            return Ok(false);
        }
        match condition {
            None => Ok(true),
            Some(ast) => evaluate_step_output_condition(source_id, outcome, ast),
        }
    }
}

/// On-failure edge: satisfied only when the source step failed.
///
/// This is the generic DATA seam for recovery, inverse actions, and recovery
/// evidence. The engine does not know what is being compensated; definitions
/// compose the owner-declared inverse through ordinary steps.
pub struct OnFailureEdgeHandler;
impl EdgeHandler for OnFailureEdgeHandler {
    fn evaluate(
        &self,
        source_id: &str,
        outcome: &StepOutput,
        condition: &Option<Value>,
    ) -> Result<bool, WorkflowError> {
        use crate::domain::types::ExecutionStatus;
        if outcome.status != ExecutionStatus::Failed || outcome.error.is_none() {
            return Ok(false);
        }
        match condition {
            None => Ok(true),
            Some(ast) => evaluate_step_output_condition(source_id, outcome, ast),
        }
    }
}

/// The first value a condition selects from somewhere an edge cannot see. An edge sees only `input`, the outcome of
/// the step it leaves from; any other run scope (`steps`, `loop`, `context`, ...) would select nothing and make the
/// condition silently false, so it is refused instead, naming what it reads.
fn unseen_by_an_edge(condition: &Value) -> Option<String> {
    match condition {
        Value::Object(map) => {
            if map.get("$kind").and_then(Value::as_str) == Some("binding") {
                let from = map.get("select").and_then(|select| select.get("from")).and_then(Value::as_str);
                if let Some(from @ ("steps" | "loop" | "context" | "start" | "change" | "ambient")) = from {
                    return Some(format!("{from} {}", map.get("select").map(Value::to_string).unwrap_or_default()));
                }
                if let Some(path) = map.get("values").and_then(Value::as_array) {
                    let root = path.first().and_then(|first| first.as_array().and_then(|inner| inner.first()).or(Some(first)));
                    if root.and_then(Value::as_str) != Some("input") {
                        return Some(format!("values {}", Value::Array(path.clone())));
                    }
                }
            }
            map.values().find_map(unseen_by_an_edge)
        }
        Value::Array(items) => items.iter().find_map(unseen_by_an_edge),
        _ => None,
    }
}

fn evaluate_step_output_condition(
    source_id: &str,
    outcome: &StepOutput,
    condition: &Value,
) -> Result<bool, WorkflowError> {
    if let Some(unseen) = unseen_by_an_edge(condition) {
        return Err(WorkflowError::ConditionEvaluationFailed {
            step_id: source_id.to_string(),
            reason: format!("An edge condition leaving '{source_id}' reads {unseen}, which an edge cannot see"),
            hint: "An edge condition sees only `input`: the step it leaves from (input.output, input.status, input.error). To branch on another step's value, return it from a step first and branch on that step's output.".to_string(),
        });
    }
    let input = serde_json::to_value(outcome).map_err(|error| {
        WorkflowError::ConditionEvaluationFailed {
            step_id: source_id.to_string(),
            reason: format!("Could not expose source StepOutput to edge condition: {error}"),
            hint: "StepOutput must remain JSON-serializable so edge Binding AST conditions can inspect it.".to_string(),
        }
    })?;
    let context = ExecutionContext {
        start: StartData {
            start_type: "edge_condition".to_string(),
            input,
            ..Default::default()
        },
        ..Default::default()
    };
    let resolved = BindingResolver::resolve_value(condition, &context).map_err(|error| {
        WorkflowError::ConditionEvaluationFailed {
            step_id: source_id.to_string(),
            reason: format!("Edge condition resolution failed: {error}"),
            hint: "Use workflow Binding AST over input.output/input.status/input.error/input.duration_ms; edge conditions do not use string templates or target-specific mini-languages.".to_string(),
        }
    })?;
    // A condition that comes to anything but true or false is a type error, never a quiet false: on Nov 21 2026 (4:14 PM CST,
    // run workflow_newsletter-for-a-pursuit) a step's `pass` was not a boolean, neither of its two on_result edges was taken,
    // every later step was skipped, and the run ended "completed".
    match resolved {
        Value::Bool(taken) => Ok(taken),
        other => {
            let shown: String = other.to_string().chars().take(200).collect();
            Err(WorkflowError::ConditionEvaluationFailed {
                step_id: source_id.to_string(),
                reason: format!("An edge condition leaving '{source_id}' came to {shown}, not true or false"),
                hint: "An on_result or on_failure condition must come to a boolean: compare the value with an op (op:core.eq, op:core.gte, ...) rather than using it as it is.".to_string(),
            })
        }
    }
}

// ============================================================================
// BUILT-IN JOIN HANDLERS
// ============================================================================

/// Any-join: ready if at least one inbound edge is satisfied (fan-in/merge default).
pub struct AnyJoinHandler;
impl JoinHandler for AnyJoinHandler {
    fn evaluate(&self, ctx: &JoinContext) -> NodeReadiness {
        if ctx.satisfied_edges > 0 {
            NodeReadiness::Ready
        } else {
            NodeReadiness::Skipped
        }
    }
}

/// All-join: ready only if every inbound edge is satisfied (strict barrier).
pub struct AllJoinHandler;
impl JoinHandler for AllJoinHandler {
    fn evaluate(&self, ctx: &JoinContext) -> NodeReadiness {
        if ctx.satisfied_edges == ctx.total_edges {
            NodeReadiness::Ready
        } else {
            NodeReadiness::Skipped
        }
    }
}

// ============================================================================
// REGISTRY CONSTRUCTION
// ============================================================================

/// Create the default edge handler registry with built-in handlers.
pub fn default_edge_registry() -> EdgeHandlerRegistry {
    let mut registry: EdgeHandlerRegistry = HashMap::new();
    registry.insert("always".to_string(), Box::new(AlwaysEdgeHandler));
    registry.insert("on_result".to_string(), Box::new(OnResultEdgeHandler));
    registry.insert("on_failure".to_string(), Box::new(OnFailureEdgeHandler));
    registry
}

/// Create the default join handler registry with built-in handlers.
pub fn default_join_registry() -> JoinHandlerRegistry {
    let mut registry: JoinHandlerRegistry = HashMap::new();
    registry.insert("any".to_string(), Box::new(AnyJoinHandler));
    registry.insert("all".to_string(), Box::new(AllJoinHandler));
    registry
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::types::ExecutionStatus;

    fn outcome(output: Value) -> StepOutput {
        StepOutput { output, status: ExecutionStatus::Completed, error: None, duration_ms: 0 }
    }

    #[test]
    fn a_condition_on_what_the_step_returned_is_judged() {
        let condition = serde_json::json!({ "$kind": "binding", "select": { "from": "input", "path": "output.posts" }, "transform": [{ "op": "op:core.gte", "args": { "value": 10 } }] });
        assert!(OnResultEdgeHandler.evaluate("days", &outcome(serde_json::json!({ "posts": 12 })), &Some(condition.clone())).unwrap());
        assert!(!OnResultEdgeHandler.evaluate("days", &outcome(serde_json::json!({ "posts": 3 })), &Some(condition)).unwrap());
    }

    #[test]
    fn a_condition_that_is_not_a_boolean_fails_naming_the_step_and_its_value() {
        let condition = serde_json::json!({ "$kind": "binding", "select": { "from": "input", "path": "output.pass" } });
        let refused = OnResultEdgeHandler.evaluate("judge", &outcome(serde_json::json!({ "pass": "yes" })), &Some(condition.clone())).unwrap_err();
        assert!(refused.to_string().contains("'judge' came to \"yes\", not true or false"), "{refused}");
        assert!(OnResultEdgeHandler.evaluate("judge", &outcome(serde_json::json!({})), &Some(condition.clone())).is_err(), "a missing value is not false");
        assert!(OnResultEdgeHandler.evaluate("judge", &outcome(serde_json::json!({ "pass": true })), &Some(condition.clone())).unwrap());
        assert!(!OnResultEdgeHandler.evaluate("judge", &outcome(serde_json::json!({ "pass": false })), &Some(condition)).unwrap(), "a real false is a normal not-taken");
    }

    // A formula that counts instead of judging (FILTER then SIZE) comes to a number: refused naming the step and the
    // count, never taken as true or false (the shape behind the 4:14 PM CST Nov 21 2026 dead end); the same formula
    // finished with a comparison judges.
    #[test]
    fn a_filter_and_size_formula_that_counts_is_refused_until_it_compares() {
        let ready = serde_json::json!([{ "op": "op:core.get_path", "args": { "path": "state" } }, { "op": "op:core.equals", "args": { "value": "ready" } }]);
        let counts = serde_json::json!({ "$kind": "binding", "select": { "from": "input", "path": "output.drafts" },
            "transform": [{ "op": "op:core.filter_where", "args": { "predicate": ready.clone() } }, { "op": "op:core.size" }] });
        let drafts = outcome(serde_json::json!({ "drafts": [{ "state": "ready" }, { "state": "held" }, { "state": "ready" }] }));
        let refused = OnResultEdgeHandler.evaluate("pick", &drafts, &Some(counts)).unwrap_err();
        assert!(refused.to_string().contains("'pick' came to 2, not true or false"), "{refused}");
        let judges = serde_json::json!({ "$kind": "binding", "select": { "from": "input", "path": "output.drafts" },
            "transform": [{ "op": "op:core.filter_where", "args": { "predicate": ready } }, { "op": "op:core.size" }, { "op": "op:core.gte", "args": { "value": 1 } }] });
        assert!(OnResultEdgeHandler.evaluate("pick", &drafts, &Some(judges)).unwrap());
    }

    #[test]
    fn a_condition_reading_another_step_is_refused_naming_it_never_silently_false() {
        let condition = serde_json::json!({ "$kind": "binding", "select": { "from": "steps", "key": "size", "path": "output.posts" }, "transform": [{ "op": "op:core.gte", "args": { "value": 10 } }] });
        let refused = OnResultEdgeHandler.evaluate("days", &outcome(serde_json::json!({})), &Some(condition)).unwrap_err();
        assert!(refused.to_string().contains("which an edge cannot see"), "{refused}");
        assert!(refused.to_string().contains("size"), "{refused}");
        let nested = serde_json::json!({ "$kind": "binding", "select": { "from": "input", "path": "output.n" }, "transform": [{ "op": "op:core.eq", "args": { "value": { "$kind": "binding", "values": ["steps", "size", "n"] } } }] });
        assert!(OnResultEdgeHandler.evaluate("days", &outcome(serde_json::json!({ "n": 1 })), &Some(nested)).is_err());
    }
}
