//! Shared rule system for Formula Engine optimization and execution
//!
//! This module contains all shared definitions for both optimization rules (used by the compiler)
//! and rewrite rules (used by the solver). By centralizing these definitions, we ensure
//! consistency and avoid code duplication across the system.

// Submodule declarations for rule implementations
pub mod array;
pub mod conversion;
pub mod crypto;
pub mod datetime;
pub mod graph;
pub mod logical;
pub mod math;
pub mod registry;
pub mod security;
pub mod text;

use crate::{Hyperedge, HyperedgeId, Manifold, ManifoldPatch};

/// Cost scaling behavior for different input sizes.
#[derive(Debug, Clone, Copy)]
pub enum CostScaling {
    /// Constant time: O(1)
    Constant,
    /// Linear scaling: O(n)
    Linear,
    /// Logarithmic scaling: O(log n)
    Logarithmic,
    /// Linearithmic scaling: O(n log n)
    Linearithmic,
    /// Quadratic scaling: O(n²)
    Quadratic,
}

/// Optimization priority levels for rule selection.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub enum OptimizationPriority {
    /// Low priority optimizations (cosmetic improvements)
    Low = 1,
    /// Medium priority optimizations (moderate performance gains)
    Medium = 5,
    /// High priority optimizations (significant performance improvements)
    High = 10,
    /// Critical optimizations (order-of-magnitude improvements)
    Critical = 20,
}

/// Comprehensive cost model for rewrite rule optimization decisions.
#[derive(Debug, Clone)]
pub struct RuleCostModel {
    /// Base cost in micro-operations (microsecond equivalents)
    pub base_cost_micro_ops: u64,
    /// Cost scaling factor for input size (linear, quadratic, etc.)
    pub scaling_factor: CostScaling,
    /// Memory allocation cost in bytes
    pub memory_cost_bytes: u64,
    /// Cache locality impact (higher = better cache locality)
    pub cache_locality_score: f32,
    /// Optimization priority (higher = more beneficial to apply)
    pub optimization_priority: OptimizationPriority,
    /// Applicable data size ranges for this rule
    pub applicable_size_range: (u64, u64), // (min_elements, max_elements)
}

impl RuleCostModel {
    /// Create a cost model for simple arithmetic operations.
    pub fn arithmetic_basic() -> Self {
        Self {
            base_cost_micro_ops: 50, // 50 microseconds base cost
            scaling_factor: CostScaling::Linear,
            memory_cost_bytes: 64,     // Minimal memory allocation
            cache_locality_score: 0.9, // Good cache locality
            optimization_priority: OptimizationPriority::Medium,
            applicable_size_range: (1, 1000), // Small to medium datasets
        }
    }

    /// Create a cost model for complex aggregation operations.
    pub fn aggregation_complex() -> Self {
        Self {
            base_cost_micro_ops: 500, // Higher base cost
            scaling_factor: CostScaling::Linearithmic,
            memory_cost_bytes: 1024,   // More memory for temporary storage
            cache_locality_score: 0.7, // Moderate cache locality
            optimization_priority: OptimizationPriority::High,
            applicable_size_range: (100, 100000), // Medium to large datasets
        }
    }

    /// Check if this rule is applicable to the given data size
    pub fn is_applicable(&self, data_size: u64) -> bool {
        data_size >= self.applicable_size_range.0 && data_size <= self.applicable_size_range.1
    }

    /// Calculate optimization score (benefit/cost ratio)
    pub fn optimization_score(&self, data_size: u64) -> f64 {
        let cost = self.estimate_cost(data_size) as f64;
        let priority_multiplier = match self.optimization_priority {
            OptimizationPriority::Critical => 4.0,
            OptimizationPriority::High => 3.0,
            OptimizationPriority::Medium => 2.0,
            OptimizationPriority::Low => 1.0,
        };

        // Higher score means better benefit/cost ratio
        priority_multiplier / (cost + 1.0)
    }

    /// Estimate the computational cost for this data size
    pub fn estimate_cost(&self, data_size: u64) -> u64 {
        let scaled_cost = match self.scaling_factor {
            CostScaling::Constant => self.base_cost_micro_ops,
            CostScaling::Linear => self.base_cost_micro_ops + data_size,
            CostScaling::Logarithmic => self.base_cost_micro_ops + ((data_size as f64).ln() as u64),
            CostScaling::Linearithmic => {
                self.base_cost_micro_ops + (data_size * ((data_size as f64).ln() as u64))
            }
            CostScaling::Quadratic => self.base_cost_micro_ops + (data_size * data_size),
        };

        scaled_cost + self.memory_cost_bytes
    }
}

/// Properties of a rule for termination analysis and optimization.
pub struct RuleProperties {
    /// Whether this rule is monotonic (progress towards termination).
    pub is_monotonic: bool,
    /// Whether this rule is idempotent (applying twice = applying once).
    pub is_idempotent: bool,
    /// Whether this rule always reduces the constraint graph size.
    pub reduces_graph: bool,
    /// Maximum computational cost (for budget enforcement).
    pub max_cost_ops: u64,
    /// Detailed cost model for optimizer decision-making.
    pub cost_model: RuleCostModel,
}

/// Specific, machine-parseable error kinds for runtime execution failures.
#[derive(Debug, Clone, PartialEq)]
pub enum ErrorKind {
    /// E_TYPE_MISMATCH: Operation expected a different type (e.g., adding a string to a number).
    TypeMismatch { expected: String, found: String },
    /// E_DIVIDE_BY_ZERO: Attempted to divide by zero.
    DivideByZero,
    /// E_ARITHMETIC_OVERFLOW: A calculation exceeded the representational bounds of the number type.
    ArithmeticOverflow,
    /// E_NUMERIC_NAN: A calculation resulted in a non-finite number (NaN or infinity).
    NonFiniteResult,
    /// E_INVALID_ARGUMENT: An argument was outside the valid domain for a function (e.g., SQRT(-1)).
    InvalidArgument(String),
}

/// Error type for rewrite rule failures, now with structured error kinds.
#[derive(Debug, Clone)]
pub enum RuleError {
    /// A rule was applied to an edge that did not match its expected pattern.
    /// This typically indicates a solver bug, not a user error.
    PatternMismatch,

    /// A user-level constraint was violated during execution.
    /// This contains a specific, actionable error kind.
    ConstraintViolation(ErrorKind),

    /// A resource limit was exceeded during rule execution.
    ResourceExhausted,
}

impl std::fmt::Display for RuleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RuleError::PatternMismatch => write!(f, "Pattern mismatch"),
            RuleError::ConstraintViolation(kind) => write!(f, "Constraint violation: {:?}", kind),
            RuleError::ResourceExhausted => write!(f, "Resource exhausted"),
        }
    }
}

impl std::error::Error for RuleError {}

/// Trait for structural optimizations performed by the COMPILER.
/// These rules analyze the manifold and propose patches without mutating it.
pub trait OptimizationRule: Send + Sync {
    /// Return rule properties for cost analysis and termination guarantees.
    fn properties(&self) -> RuleProperties;

    /// Return Some(patch) if the rule applies; None otherwise.
    /// MUST NOT mutate the manifold; only compute the patch.
    fn try_apply(&self, manifold: &Manifold, edge_id: HyperedgeId) -> Option<ManifoldPatch>;
}

/// Context provided to rewrite rules for solver re-entrancy
pub struct SolverContext<'a> {
    pub solver: &'a crate::solver::Solver,
    pub evaluation_context: &'a crate::context::EvaluationContext,
    pub remaining_timeout_ms: u64,
}

/// Trait for execution rules used by the SOLVER.
/// These rules directly transform manifold state during solving.
pub trait RewriteRule {
    /// The pattern this rule looks for in the hypergraph.
    fn pattern(&self) -> &str;

    /// The transformation to apply when the pattern is found.
    /// UPDATED: Now accepts a solver context for re-entrancy.
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        ctx: &SolverContext,
    ) -> Result<(), RuleError>;

    /// Rule properties for termination analysis.
    fn properties(&self) -> RuleProperties;
}
