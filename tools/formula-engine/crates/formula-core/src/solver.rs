//! Solver - Core evaluation engine replacing evaluator.rs
//!
//! The Solver iteratively finds "ready" hyperedges in the Manifold and applies
//! the correct transformation rule until the graph is fully resolved.

use crate::rules::registry::RuleRegistry;
use crate::rules::{RewriteRule, RuleCostModel, RuleError, RuleProperties, SolverContext};
use crate::{context::EvaluationContext, ConstraintKind, Hyperedge, Manifold, Node, Value};

use std::collections::{HashMap, HashSet};

// A library of the built-in "physical laws".
type TransformRules = HashMap<String, Box<dyn RewriteRule>>;

// ============================================================================
// Platform-Agnostic Time Source (First Principles Design)
// ============================================================================
//
// The Solver needs elapsed time for:
// 1. Timeout enforcement (budget control)
// 2. Telemetry (execution_time_micros)
//
// Rather than scattering #[cfg(...)] throughout, we abstract the clock.
// This is injected at construction - the Solver is platform-agnostic.

/// Minimal trait for time measurement. Platform provides implementation.
pub trait Clock: Send + Sync {
    /// Microseconds since this clock was created/started.
    fn elapsed_micros(&self) -> u64;
}

/// Native clock using std::time::Instant (not available in WASM)
#[cfg(not(target_arch = "wasm32"))]
pub struct NativeClock {
    start: std::time::Instant,
}

#[cfg(not(target_arch = "wasm32"))]
impl NativeClock {
    pub fn new() -> Self {
        Self {
            start: std::time::Instant::now(),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Default for NativeClock {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Clock for NativeClock {
    fn elapsed_micros(&self) -> u64 {
        self.start.elapsed().as_micros() as u64
    }
}

/// No-op clock for WASM (time tracking disabled, step-based limits only)
pub struct NoOpClock;

impl Clock for NoOpClock {
    fn elapsed_micros(&self) -> u64 {
        0
    }
}

/// Create the appropriate clock for the current platform
pub fn platform_clock() -> Box<dyn Clock> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        Box::new(NativeClock::new())
    }
    #[cfg(target_arch = "wasm32")]
    {
        Box::new(NoOpClock)
    }
}

// ============================================================================
// Telemetry
// ============================================================================

/// Simple execution log entry for telemetry
#[derive(Debug, Clone)]
pub struct ExecutionLogEntry {
    pub formula_hash: String,
    pub execution_time_micros: u64,
    pub cache_status: &'static str,
    pub steps_executed: u32,
    pub outcome: &'static str,
    pub partition_key: String,
}

/// Simple log writer for telemetry
pub struct LogWriter {
    logs: Vec<ExecutionLogEntry>,
}

impl LogWriter {
    pub fn new_default() -> Self {
        Self { logs: Vec::new() }
    }

    pub fn log_execution(&mut self, entry: ExecutionLogEntry) {
        self.logs.push(entry);
    }

    pub fn log_unstable_execution(&mut self, _manifold: &Manifold, _reason: &str) {
        // For now, just log that instability was detected
    }
}

/// Result of solver execution with approximation tracking.
#[derive(Debug, Clone)]
pub struct SolverResult {
    pub value: Value,
    /// True if result contains approximations from widening operations
    pub is_approximate: bool,
    /// Details about any approximations made during solving
    pub approximation_details: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SolverBudget {
    pub max_steps: u32,
    pub widening_after_steps: u32,
}

impl SolverBudget {
    pub fn validate(self) -> Result<Self, String> {
        if self.max_steps == 0 {
            return Err("max_steps must be greater than zero".to_string());
        }
        if self.widening_after_steps == 0 {
            return Err("widening_after_steps must be greater than zero".to_string());
        }
        if self.widening_after_steps > self.max_steps {
            return Err("widening_after_steps must not exceed max_steps".to_string());
        }
        Ok(self)
    }
}

impl Default for SolverBudget {
    fn default() -> Self {
        Self {
            max_steps: 10_000,
            widening_after_steps: 100,
        }
    }
}

pub struct Solver {
    transform_rules: TransformRules,
    function_registry: RuleRegistry,
    log_writer: LogWriter,
}

impl Solver {
    pub fn new() -> Self {
        let mut rules: TransformRules = HashMap::new();

        // Add basic arithmetic rules
        rules.insert("Add".to_string(), Box::new(AddRule));
        rules.insert("Subtract".to_string(), Box::new(SubtractRule));
        rules.insert("Multiply".to_string(), Box::new(MultiplyRule));
        rules.insert("Divide".to_string(), Box::new(DivideRule));
        rules.insert("Modulo".to_string(), Box::new(ModuloRule));
        rules.insert("Negate".to_string(), Box::new(NegateRule));

        // Add comparison rules
        rules.insert("Equal".to_string(), Box::new(EqualRule));
        rules.insert("NotEqual".to_string(), Box::new(NotEqualRule));
        rules.insert("LessThan".to_string(), Box::new(LessThanRule));
        rules.insert("GreaterThan".to_string(), Box::new(GreaterThanRule));

        // Add logical rules
        rules.insert("And".to_string(), Box::new(AndRule));
        rules.insert("Or".to_string(), Box::new(OrRule));
        rules.insert("Not".to_string(), Box::new(NotRule));

        // Add advanced constraint rules
        rules.insert("MemberAccess".to_string(), Box::new(MemberAccessRule));
        rules.insert("VariableLookup".to_string(), Box::new(VariableLookupRule));
        rules.insert("ConstructArray".to_string(), Box::new(ConstructArrayRule));
        rules.insert("ConstructObject".to_string(), Box::new(ConstructObjectRule));
        rules.insert("Const".to_string(), Box::new(ConstRule));
        rules.insert("IndexAccess".to_string(), Box::new(IndexAccessRule));

        Solver {
            transform_rules: rules,
            function_registry: RuleRegistry::with_builtin_rules(),
            log_writer: LogWriter::new_default(),
        }
    }
}

impl Default for Solver {
    fn default() -> Self {
        Self::new()
    }
}

impl Solver {
    /// The main "solve" method. It takes the Manifold and runs the simulation.
    ///
    /// Implements visited-state hashing for loop detection and widening for
    /// numeric constraints as specified in the amendment.
    pub fn solve(
        &mut self,
        manifold: &mut Manifold,
        ctx: &EvaluationContext,
        timeout_ms: u64,
    ) -> Result<SolverResult, String> {
        let clock = platform_clock();
        self.solve_with_budget_and_clock(
            manifold,
            ctx,
            SolverBudget::default(),
            clock.as_ref(),
            timeout_ms,
        )
    }

    /// Deterministic semantic entry point. Step budget and widening policy are
    /// explicit owner DATA; wall-clock time is observability only.
    pub fn solve_with_budget(
        &mut self,
        manifold: &mut Manifold,
        ctx: &EvaluationContext,
        budget: SolverBudget,
    ) -> Result<SolverResult, String> {
        self.solve_with_budget_and_clock(manifold, ctx, budget, &NoOpClock, u64::MAX)
    }

    fn solve_with_budget_and_clock(
        &mut self,
        manifold: &mut Manifold,
        ctx: &EvaluationContext,
        budget: SolverBudget,
        clock: &dyn Clock,
        nested_timeout_ms: u64,
    ) -> Result<SolverResult, String> {
        let budget = budget.validate()?;
        let mut steps_executed = 0;
        let mut is_approximate = false;
        let mut approximation_details: Vec<String> = Vec::new();

        // CONFLUENCE CHECK: Visited-state hashing for loop detection
        let mut visited_states: HashSet<u64> = HashSet::new();

        while let Some(edge) = manifold.find_ready_edge().cloned() {
            if steps_executed >= budget.max_steps {
                return self.handle_unstable_exit(manifold, "budget_exhausted");
            }

            // Confluence check: loop detection via state hashing
            let state_hash = manifold.compute_state_hash();
            if visited_states.contains(&state_hash) {
                return self.handle_unstable_exit(manifold, "Loop Detected");
            }
            visited_states.insert(state_hash);

            steps_executed += 1;

            // Apply widening for numeric constraints if needed (forces convergence)
            if steps_executed > budget.widening_after_steps
                && self.apply_widening_if_needed(
                    manifold,
                    steps_executed,
                    budget.widening_after_steps,
                    ctx,
                )
            {
                is_approximate = true;
                approximation_details.push(format!("Widening applied at step {}", steps_executed));
            }

            // OBSERVE primitive: Log the step for telemetry.
            self.log_writer.log_execution(ExecutionLogEntry {
                formula_hash: "TODO".to_string(),
                execution_time_micros: clock.elapsed_micros(),
                cache_status: "MISS",
                steps_executed,
                outcome: "IN_PROGRESS",
                partition_key: ctx
                    .get_partition_key()
                    .unwrap_or(&"unknown".to_string())
                    .clone(),
            });

            // --- DEFINITIVE LAZY EVALUATION FIX ---
            // Check for lazy constraints that need special handling before all inputs are ready.
            match edge.constraint_type {
                ConstraintKind::If => {
                    // IF is special: it only needs its first argument (the condition) to be ready.
                    if manifold
                        .get_node(edge.input_nodes[0])
                        .is_some_and(|n| n.is_ready())
                    {
                        // The condition is ready, so we can execute the IF logic now.
                        let solver_context = SolverContext {
                            solver: self,
                            evaluation_context: ctx,
                            remaining_timeout_ms: nested_timeout_ms,
                        };
                        self.apply_transform(manifold, &edge, &solver_context)?;
                        manifold.remove_edge(&edge);
                        continue; // Restart the loop to find the next ready edge
                    }
                }
                // Add cases for AND, OR, SWITCH etc. here for full lazy evaluation.
                _ => {
                    // For all other (eager) rules, proceed as normal.
                    let solver_context = SolverContext {
                        solver: self,
                        evaluation_context: ctx,
                        remaining_timeout_ms: nested_timeout_ms,
                    };
                    self.apply_transform(manifold, &edge, &solver_context)?;
                    manifold.remove_edge(&edge);
                }
            }
        }

        // OBSERVE primitive: Log the final result and time.
        self.log_writer.log_execution(ExecutionLogEntry {
            formula_hash: "TODO".to_string(),
            execution_time_micros: clock.elapsed_micros(),
            cache_status: "MISS",
            steps_executed,
            outcome: "SUCCESS",
            partition_key: ctx
                .get_partition_key()
                .unwrap_or(&"unknown".to_string())
                .clone(),
        });

        // Find the final result node in the now-stable manifold.
        let value = self.find_result_node(manifold)?;
        Ok(SolverResult {
            value,
            is_approximate,
            approximation_details: if approximation_details.is_empty() {
                None
            } else {
                Some(approximation_details.join("; "))
            },
        })
    }

    /// Handle unstable solver exit (budget exceeded or loop detected).
    /// Logs the instability and returns an error.
    fn handle_unstable_exit(
        &mut self,
        manifold: &Manifold,
        reason: &str,
    ) -> Result<SolverResult, String> {
        // 1. Emit UNSTABLE event with full trace
        self.log_writer.log_unstable_execution(manifold, reason);

        // 2. Extract dependency keys from the manifold (for cache invalidation)
        let dependency_keys = manifold.extract_dependency_keys();

        // 3. In a full implementation, we would poison related cached plans:
        // self.invalidation_client.poison_and_invalidate(dependency_keys, reason);

        // 4. Return error with detailed diagnostic information
        Err(format!(
            "Solver unstable exit: {} - {} dependencies affected. See trace for details.",
            reason,
            dependency_keys.len()
        ))
    }

    /// Apply widening to numeric constraints to force convergence.
    /// This is a key termination guarantee for the solver.
    fn apply_widening_if_needed(
        &self,
        manifold: &mut Manifold,
        iterations: u32,
        widening_after_steps: u32,
        ctx: &EvaluationContext,
    ) -> bool {
        if iterations > widening_after_steps {
            let mut widening_applied = false;

            // Find all nodes involved in numeric constraints
            for node_id in manifold.get_numeric_constraint_nodes() {
                if let Some(Node::Pending) = manifold.get_node(node_id) {
                    // Apply widening with the correct float mode from context
                    manifold.apply_widening_to_node(node_id, ctx.get_float_mode());
                    widening_applied = true;
                }
            }

            return widening_applied;
        }

        false
    }

    /// "Quiet mode" solver used by the Adaptive Optimizer.
    /// It does the same work but without telemetry calls to prevent infinite loops.
    pub fn solve_for_optimization(
        &self,
        manifold: &mut Manifold,
        ctx: &EvaluationContext,
        budget: SolverBudget,
    ) -> Result<Value, String> {
        let budget = budget.validate()?;
        let mut steps = 0;

        while let Some(edge) = manifold.find_ready_edge().cloned() {
            if steps >= budget.max_steps {
                return Err("optimization budget_exhausted".to_string());
            }
            steps += 1;
            let solver_context = SolverContext {
                solver: self,
                evaluation_context: ctx,
                remaining_timeout_ms: 1000, // Default for optimization solver
            };
            self.apply_transform(manifold, &edge, &solver_context)?;
            manifold.remove_edge(&edge);
        }
        self.find_result_node(manifold)
    }

    fn apply_transform(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        s_ctx: &SolverContext,
    ) -> Result<(), String> {
        // Handle FunctionCall constraints by dispatching to the appropriate rule based on function name
        if let ConstraintKind::FunctionCall { name, version: _ } = &edge.constraint_type {
            return self.dispatch_function_call(manifold, edge, s_ctx, name);
        }

        let rule_key = match &edge.constraint_type {
            ConstraintKind::Add => "Add".to_string(),
            ConstraintKind::Subtract => "Subtract".to_string(),
            ConstraintKind::Multiply => "Multiply".to_string(),
            ConstraintKind::Divide => "Divide".to_string(),
            ConstraintKind::Modulo => "Modulo".to_string(),
            ConstraintKind::Negate => "Negate".to_string(),
            ConstraintKind::Equal => "Equal".to_string(),
            ConstraintKind::NotEqual => "NotEqual".to_string(),
            ConstraintKind::LessThan => "LessThan".to_string(),
            ConstraintKind::GreaterThan => "GreaterThan".to_string(),
            ConstraintKind::And => "And".to_string(),
            ConstraintKind::Or => "Or".to_string(),
            ConstraintKind::Not => "Not".to_string(),
            ConstraintKind::MemberAccess(_) => "MemberAccess".to_string(),
            ConstraintKind::VariableLookup(_) => "VariableLookup".to_string(),
            ConstraintKind::ConstructArray => "ConstructArray".to_string(),
            ConstraintKind::ConstructObject => "ConstructObject".to_string(),
            ConstraintKind::Const(_) => "Const".to_string(),
            ConstraintKind::IndexAccess => "IndexAccess".to_string(),
            _ => {
                return Err(format!(
                    "Unsupported constraint type: {:?}",
                    edge.constraint_type
                ))
            }
        };

        let rule = self
            .transform_rules
            .get(&rule_key)
            .ok_or_else(|| format!("Unknown constraint type: {:?}", edge.constraint_type))?;
        rule.rewrite(manifold, edge, s_ctx)
            .map_err(|error| format!("Rule application failed: {error:?}"))
    }

    /// Dispatch FunctionCall constraints to the appropriate rules from all rule files
    fn dispatch_function_call(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        s_ctx: &SolverContext,
        name: &str,
    ) -> Result<(), String> {
        let registered = self
            .function_registry
            .get(name)
            .ok_or_else(|| format!("Unknown function: {name}"))?;
        registered
            .rule
            .rewrite(manifold, edge, s_ctx)
            .map_err(|error| format!("Function {name} failed: {error:?}"))
    }

    fn find_result_node(&self, manifold: &Manifold) -> Result<Value, String> {
        // Use the designated result node for robust, deterministic result selection
        let result_node_id = manifold
            .result_node
            .ok_or_else(|| "No result node designated in manifold".to_string())?;

        match manifold.get_node(result_node_id) {
            Some(Node::Ready(value)) => Ok(value.clone()),
            Some(Node::Pending) => {
                // Build diagnostic info about remaining edges
                let remaining_edges: Vec<String> = manifold
                    .edges_snapshot()
                    .iter()
                    .map(|edge| {
                        let inputs_ready: Vec<_> = edge
                            .input_nodes
                            .iter()
                            .map(|&id| match manifold.get_node(id) {
                                Some(Node::Ready(_)) => "R",
                                Some(Node::Pending) => "P",
                                None => "?",
                            })
                            .collect();
                        let output_ready = match manifold.get_node(edge.output_node) {
                            Some(Node::Ready(_)) => "R",
                            Some(Node::Pending) => "P",
                            None => "?",
                        };
                        format!(
                            "{:?}[in:{} out:{}]",
                            edge.constraint_type,
                            inputs_ready.join(","),
                            output_ready
                        )
                    })
                    .collect();

                Err(format!(
                    "Result node is unresolved in stable manifold. Remaining {} edges: {}",
                    remaining_edges.len(),
                    remaining_edges.join(", ")
                ))
            }
            None => Err("Result node not found in manifold".to_string()),
        }
    }
}

// Basic arithmetic rules implementation

struct AddRule;

impl RewriteRule for AddRule {
    fn pattern(&self) -> &str {
        "Add(a, b) -> c"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let left_val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let right_val = manifold
            .get_node_value(edge.input_nodes[1])
            .ok_or(RuleError::PatternMismatch)?;

        // Simple addition for numbers
        let result = match (&left_val.0, &right_val.0) {
            (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
                let a_f64 = a.as_f64().unwrap_or(0.0);
                let b_f64 = b.as_f64().unwrap_or(0.0);
                Value(serde_json::json!(a_f64 + b_f64))
            }
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Number".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        // Update the output node with the result
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 100,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct SubtractRule;

impl RewriteRule for SubtractRule {
    fn pattern(&self) -> &str {
        "Subtract(a, b) -> c"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let left_val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let right_val = manifold
            .get_node_value(edge.input_nodes[1])
            .ok_or(RuleError::PatternMismatch)?;

        // Null-propagating: null - x → null, x - null → null
        let result = match (&left_val.0, &right_val.0) {
            (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
                let a_f64 = a.as_f64().unwrap_or(0.0);
                let b_f64 = b.as_f64().unwrap_or(0.0);
                Value(serde_json::json!(a_f64 - b_f64))
            }
            (serde_json::Value::Null, _) | (_, serde_json::Value::Null) => {
                Value(serde_json::Value::Null)
            }
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Number".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 100,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct MultiplyRule;

impl RewriteRule for MultiplyRule {
    fn pattern(&self) -> &str {
        "Multiply(a, b) -> c"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let left_val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let right_val = manifold
            .get_node_value(edge.input_nodes[1])
            .ok_or(RuleError::PatternMismatch)?;

        let result = match (&left_val.0, &right_val.0) {
            (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
                let a_f64 = a.as_f64().unwrap_or(0.0);
                let b_f64 = b.as_f64().unwrap_or(0.0);
                Value(serde_json::json!(a_f64 * b_f64))
            }
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Number".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 100,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct DivideRule;

impl RewriteRule for DivideRule {
    fn pattern(&self) -> &str {
        "Divide(a, b) -> c"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let left_val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let right_val = manifold
            .get_node_value(edge.input_nodes[1])
            .ok_or(RuleError::PatternMismatch)?;

        let result = match (&left_val.0, &right_val.0) {
            (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
                let a_f64 = a.as_f64().unwrap_or(0.0);
                let b_f64 = b.as_f64().unwrap_or(0.0);

                if b_f64 == 0.0 {
                    return Err(RuleError::ConstraintViolation(
                        crate::rules::ErrorKind::DivideByZero,
                    ));
                }

                Value(serde_json::json!(a_f64 / b_f64))
            }
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Number".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 150, // Slightly higher cost due to division
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct ModuloRule;

impl RewriteRule for ModuloRule {
    fn pattern(&self) -> &str {
        "Modulo(a, b) -> c"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let left_val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let right_val = manifold
            .get_node_value(edge.input_nodes[1])
            .ok_or(RuleError::PatternMismatch)?;

        let result = match (&left_val.0, &right_val.0) {
            (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
                let a_f64 = a.as_f64().unwrap_or(0.0);
                let b_f64 = b.as_f64().unwrap_or(0.0);

                if b_f64 == 0.0 {
                    return Err(RuleError::ConstraintViolation(
                        crate::rules::ErrorKind::DivideByZero,
                    ));
                }

                Value(serde_json::json!(a_f64 % b_f64))
            }
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Number".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 150,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct NegateRule;

impl RewriteRule for NegateRule {
    fn pattern(&self) -> &str {
        "Negate(a) -> b"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let result = match &val.0 {
            serde_json::Value::Number(n) => {
                let f64_val = n.as_f64().unwrap_or(0.0);
                Value(serde_json::json!(-f64_val))
            }
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Number".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct EqualRule;

impl RewriteRule for EqualRule {
    fn pattern(&self) -> &str {
        "Equal(a, b) -> c"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let left_val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let right_val = manifold
            .get_node_value(edge.input_nodes[1])
            .ok_or(RuleError::PatternMismatch)?;

        // Use Value::are_equal() to handle number normalization (integer vs float representation)
        let is_equal = Value::are_equal(left_val, right_val);
        let result = Value::bool(is_equal);

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct NotEqualRule;

impl RewriteRule for NotEqualRule {
    fn pattern(&self) -> &str {
        "NotEqual(a, b) -> c"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let left_val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let right_val = manifold
            .get_node_value(edge.input_nodes[1])
            .ok_or(RuleError::PatternMismatch)?;

        // Use Value::are_equal() to handle number normalization (integer vs float representation)
        let is_equal = Value::are_equal(left_val, right_val);
        let result = Value::bool(!is_equal);

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct LessThanRule;

impl RewriteRule for LessThanRule {
    fn pattern(&self) -> &str {
        "LessThan(a, b) -> c"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let left_val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let right_val = manifold
            .get_node_value(edge.input_nodes[1])
            .ok_or(RuleError::PatternMismatch)?;

        // Null-propagating: comparisons with null → false (SQL semantics)
        let result = match (&left_val.0, &right_val.0) {
            (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
                let a_f64 = a.as_f64().unwrap_or(0.0);
                let b_f64 = b.as_f64().unwrap_or(0.0);
                Value(serde_json::json!(a_f64 < b_f64))
            }
            (serde_json::Value::Null, _) | (_, serde_json::Value::Null) => {
                Value(serde_json::json!(false))
            }
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Number".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct GreaterThanRule;

impl RewriteRule for GreaterThanRule {
    fn pattern(&self) -> &str {
        "GreaterThan(a, b) -> c"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let left_val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let right_val = manifold
            .get_node_value(edge.input_nodes[1])
            .ok_or(RuleError::PatternMismatch)?;

        let result = match (&left_val.0, &right_val.0) {
            (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
                let a_f64 = a.as_f64().unwrap_or(0.0);
                let b_f64 = b.as_f64().unwrap_or(0.0);
                Value(serde_json::json!(a_f64 > b_f64))
            }
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Number".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct AndRule;

impl RewriteRule for AndRule {
    fn pattern(&self) -> &str {
        "And(a, b) -> c"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let left_val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let right_val = manifold
            .get_node_value(edge.input_nodes[1])
            .ok_or(RuleError::PatternMismatch)?;

        let result = match (&left_val.0, &right_val.0) {
            (serde_json::Value::Bool(a), serde_json::Value::Bool(b)) => {
                Value(serde_json::json!(*a && *b))
            }
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Boolean".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct OrRule;

impl RewriteRule for OrRule {
    fn pattern(&self) -> &str {
        "Or(a, b) -> c"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let left_val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let right_val = manifold
            .get_node_value(edge.input_nodes[1])
            .ok_or(RuleError::PatternMismatch)?;

        let result = match (&left_val.0, &right_val.0) {
            (serde_json::Value::Bool(a), serde_json::Value::Bool(b)) => {
                Value(serde_json::json!(*a || *b))
            }
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Boolean".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct NotRule;

impl RewriteRule for NotRule {
    fn pattern(&self) -> &str {
        "Not(a) -> b"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let result = match &val.0 {
            serde_json::Value::Bool(b) => Value(serde_json::json!(!b)),
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Boolean".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct MemberAccessRule;

impl RewriteRule for MemberAccessRule {
    fn pattern(&self) -> &str {
        "MemberAccess(property) -> value"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if let ConstraintKind::MemberAccess(property) = &edge.constraint_type {
            if edge.input_nodes.len() != 1 {
                return Err(RuleError::PatternMismatch);
            }

            let object_val = manifold
                .get_node_value(edge.input_nodes[0])
                .ok_or(RuleError::PatternMismatch)?;

            // Null-propagating semantics: null.property → null (not an error)
            // This enables safe optional chaining like graph.recent_events[0].key
            let result = match &object_val.0 {
                serde_json::Value::Object(map) => map
                    .get(property)
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                serde_json::Value::Null => serde_json::Value::Null,
                _ => {
                    return Err(RuleError::ConstraintViolation(
                        crate::rules::ErrorKind::TypeMismatch {
                            expected: "Object".to_string(),
                            found: "other".to_string(),
                        },
                    ))
                }
            };

            if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
                *output_node = Node::Ready(Value(result));
            }

            Ok(())
        } else {
            Err(RuleError::PatternMismatch)
        }
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 100,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct VariableLookupRule;

impl RewriteRule for VariableLookupRule {
    fn pattern(&self) -> &str {
        "VariableLookup(name) -> value"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if let ConstraintKind::VariableLookup(name) = &edge.constraint_type {
            if !edge.input_nodes.is_empty() {
                return Err(RuleError::PatternMismatch);
            }

            let val = ctx.evaluation_context.get_variable(name).ok_or_else(|| {
                RuleError::ConstraintViolation(crate::rules::ErrorKind::InvalidArgument(format!(
                    "Variable '{}' not found",
                    name
                )))
            })?;

            if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
                *output_node = Node::Ready(val.clone());
            }
            Ok(())
        } else {
            Err(RuleError::PatternMismatch)
        }
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct ConstructArrayRule;

impl RewriteRule for ConstructArrayRule {
    fn pattern(&self) -> &str {
        "ConstructArray(elements...) -> array"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        let mut array = Vec::new();

        for &node_id in &edge.input_nodes {
            match manifold.get_node(node_id) {
                Some(Node::Ready(val)) => array.push(val.0.clone()),
                _ => return Err(RuleError::PatternMismatch),
            }
        }

        let result = Value(serde_json::Value::Array(array));

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 200,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
}

struct ConstructObjectRule;

impl RewriteRule for ConstructObjectRule {
    fn pattern(&self) -> &str {
        "ConstructObject(key_value_pairs...) -> object"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !edge.input_nodes.len().is_multiple_of(2) {
            return Err(RuleError::ConstraintViolation(
                crate::rules::ErrorKind::InvalidArgument(
                    "ConstructObject requires even number of inputs (key-value pairs)".to_string(),
                ),
            ));
        }

        let mut object = serde_json::Map::new();

        for pair in edge.input_nodes.chunks(2) {
            let key_val = match manifold.get_node(pair[0]) {
                Some(Node::Ready(val)) => val,
                _ => return Err(RuleError::PatternMismatch),
            };

            let value_val = match manifold.get_node(pair[1]) {
                Some(Node::Ready(val)) => val,
                _ => return Err(RuleError::PatternMismatch),
            };

            let key = match &key_val.0 {
                serde_json::Value::String(s) => s.clone(),
                _ => {
                    return Err(RuleError::ConstraintViolation(
                        crate::rules::ErrorKind::TypeMismatch {
                            expected: "String".to_string(),
                            found: "other".to_string(),
                        },
                    ))
                }
            };

            object.insert(key, value_val.0.clone());
        }

        let result = Value(serde_json::Value::Object(object));

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 300,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
}

struct ConstRule;

impl RewriteRule for ConstRule {
    fn pattern(&self) -> &str {
        "Const(value) -> value"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if let ConstraintKind::Const(value) = &edge.constraint_type {
            if !edge.input_nodes.is_empty() {
                return Err(RuleError::PatternMismatch);
            }

            if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
                *output_node = Node::Ready(value.clone());
            }

            Ok(())
        } else {
            Err(RuleError::PatternMismatch)
        }
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 1,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

struct IndexAccessRule;

impl RewriteRule for IndexAccessRule {
    fn pattern(&self) -> &str {
        "IndexAccess(array, index) -> value"
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let array_val = manifold
            .get_node_value(edge.input_nodes[0])
            .ok_or(RuleError::PatternMismatch)?;

        let index_val = manifold
            .get_node_value(edge.input_nodes[1])
            .ok_or(RuleError::PatternMismatch)?;

        // Extract index as integer
        // Note: serde_json::Number can be i64 or f64. as_i64() returns None for f64 values.
        // We need to handle both cases: try as_i64() first, then as_f64() and convert.
        let index = match &index_val.0 {
            serde_json::Value::Number(n) => {
                // Try integer first, then fall back to float conversion
                if let Some(i) = n.as_i64() {
                    i
                } else if let Some(f) = n.as_f64() {
                    // Convert float to integer (truncate towards zero)
                    if f.is_nan() || f.is_infinite() || f < i64::MIN as f64 || f > i64::MAX as f64 {
                        -1 // Invalid, will trigger out-of-bounds
                    } else {
                        f as i64
                    }
                } else {
                    -1
                }
            }
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Number".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        // Null-propagating semantics: null[index] → null
        // Out-of-bounds access → null (not error)
        let result = match &array_val.0 {
            serde_json::Value::Array(arr) => {
                if index < 0 || (index as usize) >= arr.len() {
                    serde_json::Value::Null
                } else {
                    arr[index as usize].clone()
                }
            }
            serde_json::Value::Null => serde_json::Value::Null,
            _ => {
                return Err(RuleError::ConstraintViolation(
                    crate::rules::ErrorKind::TypeMismatch {
                        expected: "Array".to_string(),
                        found: "other".to_string(),
                    },
                ))
            }
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(Value(result));
        }

        Ok(())
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 50,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ConstraintKind, HyperedgeSpec};
    use serde_json::json;

    fn two_step_addition_manifold() -> Manifold {
        let mut manifold = Manifold::new();
        let one = manifold.add_node(Value(json!(1)));
        let two = manifold.add_node(Value(json!(2)));
        let three = manifold.add_node(Value(json!(3)));
        let subtotal = manifold.create_node(Node::Pending, "subtotal".to_string());
        let total = manifold.create_node(Node::Pending, "total".to_string());
        manifold
            .add_edge(HyperedgeSpec {
                constraint_type: ConstraintKind::Add,
                tags: vec![ConstraintKind::ArithmeticOp],
                input_nodes: vec![one, two],
                output_node: subtotal,
            })
            .unwrap();
        manifold
            .add_edge(HyperedgeSpec {
                constraint_type: ConstraintKind::Add,
                tags: vec![ConstraintKind::ArithmeticOp],
                input_nodes: vec![subtotal, three],
                output_node: total,
            })
            .unwrap();
        manifold.set_result_node(total).unwrap();
        manifold
    }

    #[test]
    fn test_solver_creation() {
        let solver = Solver::new();
        assert_eq!(solver.transform_rules.len(), 19); // All registered transform rules
    }

    #[test]
    fn deterministic_max_step_exhaustion_and_budgeted_optimization() {
        let context = EvaluationContext::default();
        let budget = SolverBudget {
            max_steps: 1,
            widening_after_steps: 1,
        };

        let mut normal = two_step_addition_manifold();
        let normal_error = Solver::new()
            .solve_with_budget(&mut normal, &context, budget)
            .expect_err("the second transition must exceed max_steps=1");
        assert!(normal_error.contains("budget_exhausted"));

        let mut optimization = two_step_addition_manifold();
        let optimization_error = Solver::new()
            .solve_for_optimization(&mut optimization, &context, budget)
            .expect_err("optimizer must enforce the same explicit step budget");
        assert!(optimization_error.contains("budget_exhausted"));
    }

    #[test]
    fn widening_threshold_has_one_explicit_owner() {
        let context = EvaluationContext::default();
        let mut manifold = Manifold::new();
        let pending = manifold.create_node(Node::Pending, "pending".to_string());
        let ready = manifold.add_node(Value(json!(1)));
        let output = manifold.create_node(Node::Pending, "output".to_string());
        manifold
            .add_edge(HyperedgeSpec {
                constraint_type: ConstraintKind::Add,
                tags: vec![ConstraintKind::ArithmeticOp],
                input_nodes: vec![pending, ready],
                output_node: output,
            })
            .unwrap();
        let solver = Solver::new();
        assert!(!solver.apply_widening_if_needed(&mut manifold, 7, 7, &context));
        assert!(matches!(manifold.get_node(pending), Some(Node::Pending)));
        assert!(solver.apply_widening_if_needed(&mut manifold, 8, 7, &context));
        assert!(matches!(manifold.get_node(pending), Some(Node::Ready(_))));
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn native_and_noop_clocks_have_identical_semantics() {
        let context = EvaluationContext::default();
        let budget = SolverBudget::default();
        let mut native_manifold = two_step_addition_manifold();
        let mut noop_manifold = native_manifold.clone();
        let native = Solver::new()
            .solve_with_budget_and_clock(
                &mut native_manifold,
                &context,
                budget,
                &NativeClock::new(),
                u64::MAX,
            )
            .unwrap();
        let noop = Solver::new()
            .solve_with_budget_and_clock(&mut noop_manifold, &context, budget, &NoOpClock, u64::MAX)
            .unwrap();
        assert_eq!(native.value, noop.value);
        assert_eq!(native.is_approximate, noop.is_approximate);
        assert_eq!(native.approximation_details, noop.approximation_details);
    }

    #[test]
    fn test_addition_rule() {
        let mut manifold = Manifold::new();
        let ctx = EvaluationContext::default();

        // Create nodes: 2 + 3 = ?
        let left_node = manifold.add_node(Value(json!(2)));
        let right_node = manifold.add_node(Value(json!(3)));
        let result_node = manifold.create_node(Node::Pending, "addition_result".to_string());

        // Create edge
        let edge = Hyperedge {
            id: 0,
            constraint_type: ConstraintKind::Add,
            tags: vec![ConstraintKind::Add],
            input_nodes: vec![left_node, right_node],
            output_node: result_node,
        };

        // Create a minimal solver context
        let solver = Solver::new();
        let solver_ctx = SolverContext {
            solver: &solver,
            evaluation_context: &ctx,
            remaining_timeout_ms: 5000,
        };

        // Apply rule
        let rule = AddRule;
        rule.rewrite(&mut manifold, &edge, &solver_ctx).unwrap();

        // Check result
        if let Some(Node::Ready(value)) = manifold.get_node(result_node) {
            assert_eq!(value.0, json!(5.0));
        } else {
            panic!("Expected ready result node");
        }
    }

    #[test]
    fn test_division_by_zero() {
        let mut manifold = Manifold::new();
        let ctx = EvaluationContext::default();

        let left_node = manifold.add_node(Value(json!(5)));
        let right_node = manifold.add_node(Value(json!(0)));
        let result_node = manifold.create_node(Node::Pending, "division_result".to_string());

        let edge = Hyperedge {
            id: 0,
            constraint_type: ConstraintKind::Divide,
            tags: vec![ConstraintKind::Divide],
            input_nodes: vec![left_node, right_node],
            output_node: result_node,
        };

        // Create a minimal solver context
        let solver = Solver::new();
        let solver_ctx = SolverContext {
            solver: &solver,
            evaluation_context: &ctx,
            remaining_timeout_ms: 5000,
        };

        let rule = DivideRule;
        let result = rule.rewrite(&mut manifold, &edge, &solver_ctx);

        assert!(result.is_err());
    }

    /// Helper function to evaluate a formula with event and graph context.
    /// Returns the raw Value for inspection.
    fn eval_formula_raw(
        query: &str,
        event_json: &serde_json::Value,
        graph_json: &serde_json::Value,
    ) -> Result<Value, String> {
        use crate::{Compiler, CostAwareOptimizer, ExecutionPlan, InMemoryCache, Parser};

        let mut parser = Parser::new();
        let ast = parser
            .parse(query)
            .map_err(|e| format!("Parse error: {}", e))?;

        let mut ctx = EvaluationContext::new();
        ctx.set_variable("event", Value(event_json.clone()));
        ctx.set_variable("graph", Value(graph_json.clone()));

        let cache = Box::new(InMemoryCache::new());
        let optimizer = CostAwareOptimizer::with_standard_rules(10000);
        let compiler = Compiler::new(cache, optimizer);

        let plan = compiler
            .compile(&ast, &ctx)
            .map_err(|e| format!("Compilation error: {}", e))?;

        match plan {
            ExecutionPlan::Bytecode(_) => {
                Err("Bytecode execution not supported in tests".to_string())
            }
            ExecutionPlan::Manifold(mut manifold) => {
                let mut solver = Solver::new();
                let solver_result = solver
                    .solve(&mut manifold, &ctx, 5000)
                    .map_err(|e| format!("Solver error: {}", e))?;
                Ok(solver_result.value)
            }
        }
    }

    /// Helper function to evaluate a formula and return bool.
    fn eval_formula_with_context(
        query: &str,
        event_json: &serde_json::Value,
        graph_json: &serde_json::Value,
    ) -> Result<bool, String> {
        eval_formula_raw(query, event_json, graph_json).map(|v| v.is_truthy())
    }

    #[test]
    fn test_double_ctrl_trigger_index_2() {
        // Test the EXACT scenario from browser debug output:
        // - 5 items in recent_events
        // - Current event is Control keyup at 3060.29ms
        // - recent_events[2] is Control key_up at 2935ms (125ms ago - should match!)
        //
        // This reproduces the bug where all conditions should be true but result is false.

        let event_json = json!({
            "type": "keyboard",
            "key": "Control",
            "code": "ControlLeft",
            "subtype": "keyup",
            "timestamp": 3060.2999999523163,  // Exact value from browser
            "modifiers": {
                "ctrl": false,
                "alt": false,
                "shift": false,
                "meta": false
            }
        });

        // Exact recent_events from browser debug output:
        // [0]: key_up Control 3060
        // [1]: key_down Control 3001
        // [2]: key_up Control 2935  <- This is what we want to match!
        // [3]: key_down Control 2860
        // [4]: key_up Meta 885
        let graph_json = json!({
            "recent_events": [
                { "event_type": "key_up", "key": "Control", "pointer_id": null, "position": null, "timestamp": 3060 },
                { "event_type": "key_down", "key": "Control", "pointer_id": null, "position": null, "timestamp": 3001 },
                { "event_type": "key_up", "key": "Control", "pointer_id": null, "position": null, "timestamp": 2935 },
                { "event_type": "key_down", "key": "Control", "pointer_id": null, "position": null, "timestamp": 2860 },
                { "event_type": "key_up", "key": "Meta", "pointer_id": null, "position": null, "timestamp": 885 }
            ]
        });

        // Test individual conditions to find which one fails:

        // 1. event.type == "keyboard"
        let result =
            eval_formula_with_context(r#"event.type == "keyboard""#, &event_json, &graph_json);
        assert!(result.is_ok(), "event.type check failed: {:?}", result);
        assert!(result.unwrap(), "event.type should be 'keyboard'");

        // 2. event.key == "Control"
        let result =
            eval_formula_with_context(r#"event.key == "Control""#, &event_json, &graph_json);
        assert!(result.is_ok(), "event.key check failed: {:?}", result);
        assert!(result.unwrap(), "event.key should be 'Control'");

        // 3. event.subtype == "keyup"
        let result =
            eval_formula_with_context(r#"event.subtype == "keyup""#, &event_json, &graph_json);
        assert!(result.is_ok(), "event.subtype check failed: {:?}", result);
        assert!(result.unwrap(), "event.subtype should be 'keyup'");

        // 4. graph.recent_events[2].event_type == "key_up"
        let result = eval_formula_with_context(
            r#"graph.recent_events[2].event_type == "key_up""#,
            &event_json,
            &graph_json,
        );
        assert!(
            result.is_ok(),
            "recent_events[2].event_type check failed: {:?}",
            result
        );
        assert!(
            result.unwrap(),
            "recent_events[2].event_type should be 'key_up'"
        );

        // 5. graph.recent_events[2].key == "Control"
        let result = eval_formula_with_context(
            r#"graph.recent_events[2].key == "Control""#,
            &event_json,
            &graph_json,
        );
        assert!(
            result.is_ok(),
            "recent_events[2].key check failed: {:?}",
            result
        );
        assert!(result.unwrap(), "recent_events[2].key should be 'Control'");

        // 6. event.timestamp - graph.recent_events[2].timestamp < 300
        // 3060.29 - 2935 = 125.29 < 300 (should be true)
        let result = eval_formula_with_context(
            r#"event.timestamp - graph.recent_events[2].timestamp < 300"#,
            &event_json,
            &graph_json,
        );
        assert!(result.is_ok(), "timestamp diff check failed: {:?}", result);
        assert!(
            result.unwrap(),
            "timestamp diff (3060.29 - 2935 = 125.29) should be < 300"
        );

        // 7. Full query - this is what was returning false in browser
        let full_query = r#"event.type == "keyboard" && event.key == "Control" && event.subtype == "keyup" && graph.recent_events[2].event_type == "key_up" && graph.recent_events[2].key == "Control" && event.timestamp - graph.recent_events[2].timestamp < 300"#;
        let result = eval_formula_with_context(full_query, &event_json, &graph_json);
        assert!(result.is_ok(), "Full query failed: {:?}", result);
        assert!(result.unwrap(), "Full double-ctrl query should match!");
    }
}
