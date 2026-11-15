//! Math RewriteRules for the Formula Engine Solver
//!
//! This module delegates math operations to ops-core while handling
//! the graph rewriting aspects (extracting from manifold, writing results).

use crate::rules::{
    ErrorKind, RewriteRule, RuleCostModel, RuleError, RuleProperties, SolverContext,
};
use crate::{Hyperedge, Manifold, Node, NodeId, Value};
use ops_core::{EvalContext, FloatMode, OpError, OpValue};

// --- ops-core Integration Helpers ---

/// Convert ops-core OpError to formula-engine RuleError
fn op_error_to_rule_error(e: OpError) -> RuleError {
    match &e {
        OpError::TypeMismatch {
            expected, actual, ..
        } => RuleError::ConstraintViolation(ErrorKind::TypeMismatch {
            expected: expected.clone(),
            found: actual.clone(),
        }),
        OpError::DivisionByZero { .. } => RuleError::ConstraintViolation(ErrorKind::DivideByZero),
        OpError::NumericOverflow { .. } => {
            RuleError::ConstraintViolation(ErrorKind::ArithmeticOverflow)
        }
        OpError::InvalidArgument { reason, .. } => {
            RuleError::ConstraintViolation(ErrorKind::InvalidArgument(reason.clone()))
        }
        _ => RuleError::ConstraintViolation(ErrorKind::InvalidArgument(e.to_string())),
    }
}

/// Convert formula-engine Value to ops-core OpValue
fn to_op_value(val: &Value) -> OpValue {
    OpValue::from(val.inner().clone())
}

/// Convert ops-core OpValue to formula-engine Value
fn from_op_value(op_val: OpValue) -> Value {
    Value(op_val.into_inner())
}

/// Create default EvalContext for ops-core operations (Strict mode for Decimal precision)
fn strict_ctx() -> EvalContext {
    EvalContext {
        float_mode: FloatMode::Strict,
        ..EvalContext::default()
    }
}

/// Create f64-only EvalContext for scientific operations
fn fast_ctx() -> EvalContext {
    EvalContext {
        float_mode: FloatMode::Fast,
        ..EvalContext::default()
    }
}

/// Get a resolved value from manifold as OpValue
fn get_op_value(manifold: &Manifold, node_id: NodeId) -> Result<OpValue, RuleError> {
    match manifold.get_node(node_id) {
        Some(Node::Ready(val)) => Ok(to_op_value(val)),
        Some(Node::Pending) => Ok(OpValue::null()),
        None => Err(RuleError::PatternMismatch),
    }
}

/// Collect OpValues from input nodes
fn get_op_values(manifold: &Manifold, node_ids: &[NodeId]) -> Result<Vec<OpValue>, RuleError> {
    node_ids
        .iter()
        .map(|&id| get_op_value(manifold, id))
        .collect()
}

// --- Binary Arithmetic Rules ---

/// Add(a, b) -> c
/// Delegates to ops_core::math::add
pub struct AddRule;
impl RewriteRule for AddRule {
    fn pattern(&self) -> &str {
        "Add(a, b) -> c"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let op_a = get_op_value(manifold, edge.input_nodes[0])?;
        let op_b = get_op_value(manifold, edge.input_nodes[1])?;

        let result =
            ops_core::math::add(&op_a, &op_b, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Sub(a, b) -> c
/// Delegates to ops_core::math::sub
pub struct SubRule;
impl RewriteRule for SubRule {
    fn pattern(&self) -> &str {
        "Sub(a, b) -> c"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let op_a = get_op_value(manifold, edge.input_nodes[0])?;
        let op_b = get_op_value(manifold, edge.input_nodes[1])?;

        let result =
            ops_core::math::sub(&op_a, &op_b, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Mul(a, b) -> c
/// Delegates to ops_core::math::mul
pub struct MulRule;
impl RewriteRule for MulRule {
    fn pattern(&self) -> &str {
        "Mul(a, b) -> c"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let op_a = get_op_value(manifold, edge.input_nodes[0])?;
        let op_b = get_op_value(manifold, edge.input_nodes[1])?;

        let result =
            ops_core::math::mul(&op_a, &op_b, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Div(a, b) -> c
/// Delegates to ops_core::math::div
pub struct DivRule;
impl RewriteRule for DivRule {
    fn pattern(&self) -> &str {
        "Div(a, b) -> c"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let op_a = get_op_value(manifold, edge.input_nodes[0])?;
        let op_b = get_op_value(manifold, edge.input_nodes[1])?;

        let result =
            ops_core::math::div(&op_a, &op_b, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Mod(a, b) -> c
/// Delegates to ops_core::math::modulo
pub struct ModRule;
impl RewriteRule for ModRule {
    fn pattern(&self) -> &str {
        "Mod(a, b) -> c"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let op_a = get_op_value(manifold, edge.input_nodes[0])?;
        let op_b = get_op_value(manifold, edge.input_nodes[1])?;

        let result =
            ops_core::math::modulo(&op_a, &op_b, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- Unary Arithmetic Rules ---

/// Ceil(x) -> result
/// Delegates to ops_core::math::ceil
pub struct CeilRule;
impl RewriteRule for CeilRule {
    fn pattern(&self) -> &str {
        "Ceil(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::ceil(&op_x, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Floor(x) -> result
/// Delegates to ops_core::math::floor
pub struct FloorRule;
impl RewriteRule for FloorRule {
    fn pattern(&self) -> &str {
        "Floor(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::floor(&op_x, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Abs(x) -> result
/// Delegates to ops_core::math::abs
pub struct AbsRule;
impl RewriteRule for AbsRule {
    fn pattern(&self) -> &str {
        "Abs(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::abs(&op_x, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Sign(x) -> result
/// Delegates to ops_core::math::sign
pub struct SignRule;
impl RewriteRule for SignRule {
    fn pattern(&self) -> &str {
        "Sign(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::sign(&op_x, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Round(value, digits) -> result
/// Delegates to ops_core::math::round
pub struct RoundRule;
impl RewriteRule for RoundRule {
    fn pattern(&self) -> &str {
        "Round(value, digits) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.is_empty() || edge.input_nodes.len() > 2 {
            return Err(RuleError::PatternMismatch);
        }

        let op_num = get_op_value(manifold, edge.input_nodes[0])?;
        let op_digits = if edge.input_nodes.len() == 2 {
            get_op_value(manifold, edge.input_nodes[1])?
        } else {
            OpValue::number(0.0)
        };

        let result = ops_core::math::round(&op_num, &op_digits, &strict_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- Aggregator Rules ---

/// DSum(...) -> Decimal sum of inputs
/// Delegates to ops_core::math::sum (strict mode)
pub struct DSumRule;
impl RewriteRule for DSumRule {
    fn pattern(&self) -> &str {
        "DSum(...)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 500,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        let op_values = get_op_values(manifold, &edge.input_nodes)?;

        let result =
            ops_core::math::sum(&op_values, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Min(...) -> minimum value
/// Delegates to ops_core::math::min
pub struct MinRule;
impl RewriteRule for MinRule {
    fn pattern(&self) -> &str {
        "Min(...)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 500,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        let op_values = get_op_values(manifold, &edge.input_nodes)?;

        let result =
            ops_core::math::min(&op_values, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Max(...) -> maximum value
/// Delegates to ops_core::math::max
pub struct MaxRule;
impl RewriteRule for MaxRule {
    fn pattern(&self) -> &str {
        "Max(...)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 500,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        let op_values = get_op_values(manifold, &edge.input_nodes)?;

        let result =
            ops_core::math::max(&op_values, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Average(...) -> average of values
/// Delegates to ops_core::math::average
pub struct AverageRule;
impl RewriteRule for AverageRule {
    fn pattern(&self) -> &str {
        "Average(...)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 500,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        let op_values = get_op_values(manifold, &edge.input_nodes)?;

        let result =
            ops_core::math::average(&op_values, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Median(...) -> median of values
/// Delegates to ops_core::math::median
pub struct MedianRule;
impl RewriteRule for MedianRule {
    fn pattern(&self) -> &str {
        "Median(...)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 500,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        let op_values = get_op_values(manifold, &edge.input_nodes)?;

        let result =
            ops_core::math::median(&op_values, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Count(array) -> count of elements
/// Delegates to ops_core::math::count
pub struct CountRule;
impl RewriteRule for CountRule {
    fn pattern(&self) -> &str {
        "Count(array)"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_arr = get_op_value(manifold, edge.input_nodes[0])?;
        let result =
            ops_core::math::count(&op_arr, &strict_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- Scientific Functions (f64-based) ---

/// Sqrt(x) -> square root
/// Delegates to ops_core::math::sqrt
pub struct SqrtRule;
impl RewriteRule for SqrtRule {
    fn pattern(&self) -> &str {
        "Sqrt(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::sqrt(&op_x, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Exp(x) -> e^x
/// Delegates to ops_core::math::exp
pub struct ExpRule;
impl RewriteRule for ExpRule {
    fn pattern(&self) -> &str {
        "Exp(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::exp(&op_x, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Ln(x) -> natural log
/// Delegates to ops_core::math::ln
pub struct LnRule;
impl RewriteRule for LnRule {
    fn pattern(&self) -> &str {
        "Ln(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        // Natural logarithm: log(x, e)
        let base = OpValue::number(std::f64::consts::E);
        let result =
            ops_core::math::log(&op_x, &base, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Log10(x) -> base-10 log
/// Uses ops_core::math::log with base 10
pub struct Log10Rule;
impl RewriteRule for Log10Rule {
    fn pattern(&self) -> &str {
        "Log10(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        // Base-10 logarithm: log(x, 10)
        let base = OpValue::number(10.0);
        let result =
            ops_core::math::log(&op_x, &base, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Log2(x) -> base-2 log
/// Uses ops_core::math::log with base 2
pub struct Log2Rule;
impl RewriteRule for Log2Rule {
    fn pattern(&self) -> &str {
        "Log2(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        // Base-2 logarithm: log(x, 2)
        let base = OpValue::number(2.0);
        let result =
            ops_core::math::log(&op_x, &base, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Sin(x) -> sine
/// Delegates to ops_core::math::sin
pub struct SinRule;
impl RewriteRule for SinRule {
    fn pattern(&self) -> &str {
        "Sin(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::sin(&op_x, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Cos(x) -> cosine
/// Delegates to ops_core::math::cos
pub struct CosRule;
impl RewriteRule for CosRule {
    fn pattern(&self) -> &str {
        "Cos(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::cos(&op_x, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Tan(x) -> tangent
/// Delegates to ops_core::math::tan
pub struct TanRule;
impl RewriteRule for TanRule {
    fn pattern(&self) -> &str {
        "Tan(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::tan(&op_x, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Asin(x) -> arcsine
/// Delegates to ops_core::math::asin
pub struct AsinRule;
impl RewriteRule for AsinRule {
    fn pattern(&self) -> &str {
        "Asin(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::asin(&op_x, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Acos(x) -> arccosine
/// Delegates to ops_core::math::acos
pub struct AcosRule;
impl RewriteRule for AcosRule {
    fn pattern(&self) -> &str {
        "Acos(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::acos(&op_x, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Atan(x) -> arctangent
/// Delegates to ops_core::math::atan
pub struct AtanRule;
impl RewriteRule for AtanRule {
    fn pattern(&self) -> &str {
        "Atan(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::atan(&op_x, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Cbrt(x) -> cube root
/// Delegates to ops_core::math::cbrt
pub struct CbrtRule;
impl RewriteRule for CbrtRule {
    fn pattern(&self) -> &str {
        "Cbrt(x) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let op_x = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::math::cbrt(&op_x, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Pow(base, exp) -> base^exp
/// Delegates to ops_core::math::pow
pub struct PowRule;
impl RewriteRule for PowRule {
    fn pattern(&self) -> &str {
        "Pow(base, exp) -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let op_base = get_op_value(manifold, edge.input_nodes[0])?;
        let op_exp = get_op_value(manifold, edge.input_nodes[1])?;

        let result =
            ops_core::math::pow(&op_base, &op_exp, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- Constants ---

/// Pi() -> PI constant
/// Delegates to ops_core::math::pi
pub struct PiRule;
impl RewriteRule for PiRule {
    fn pattern(&self) -> &str {
        "Pi() -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !edge.input_nodes.is_empty() {
            return Err(RuleError::PatternMismatch);
        }

        let result = ops_core::math::pi(&fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// E() -> Euler's number constant
/// Delegates to ops_core::math::e_const
pub struct ERule;
impl RewriteRule for ERule {
    fn pattern(&self) -> &str {
        "E() -> result"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !edge.input_nodes.is_empty() {
            return Err(RuleError::PatternMismatch);
        }

        let result = ops_core::math::e_const(&fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- F64 Aggregators ---

/// FSum(...) -> f64 sum
/// Delegates to ops_core::math::fsum
pub struct FSumRule;
impl RewriteRule for FSumRule {
    fn pattern(&self) -> &str {
        "FSum(...)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 500,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        let op_values = get_op_values(manifold, &edge.input_nodes)?;

        let result =
            ops_core::math::fsum(&op_values, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// FMedian(...) -> f64 median
/// Delegates to ops_core::math::fmedian
pub struct FMedianRule;
impl RewriteRule for FMedianRule {
    fn pattern(&self) -> &str {
        "FMedian(...)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 500,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        let op_values = get_op_values(manifold, &edge.input_nodes)?;

        let result =
            ops_core::math::fmedian(&op_values, &fast_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}
