//! Logical RewriteRules for the Formula Engine Solver
//!
//! This file implements logical operations by:
//! 1. Extracting values from the manifold (graph navigation)
//! 2. Delegating to ops-core for operation logic (pure functions)
//! 3. Writing results back to manifold (graph rewriting)
//!
//! This separation of concerns follows the composition-engine pattern:
//! - ops-core provides universal, pure operation implementations
//! - Rules handle graph navigation and rewriting
//! - Single source of truth for operation semantics

use crate::rules::{
    ErrorKind, RewriteRule, RuleCostModel, RuleError, RuleProperties, SolverContext,
};
use crate::{ConstraintKind, Hyperedge, HyperedgeSpec, Manifold, Node, NodeId, Value};
use ops_core::{EvalContext, OpError, OpValue};

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
        OpError::NullNotAllowed { operation } => {
            RuleError::ConstraintViolation(ErrorKind::TypeMismatch {
                expected: "non-null value".into(),
                found: format!("null (in {})", operation),
            })
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
    Value::from(op_val.into_inner())
}

/// Get default evaluation context
fn default_ctx() -> EvalContext {
    EvalContext::default()
}

// --- Value Extraction Helpers ---

/// Safely extracts any resolved value from a node.
fn get_resolved_value(manifold: &Manifold, node_id: NodeId) -> Result<Value, RuleError> {
    match manifold.get_node(node_id) {
        Some(Node::Ready(val)) => Ok(val.clone()),
        _ => Err(RuleError::PatternMismatch),
    }
}

/// Extract value and convert to OpValue
fn get_op_value(manifold: &Manifold, node_id: NodeId) -> Result<OpValue, RuleError> {
    let val = get_resolved_value(manifold, node_id)?;
    Ok(to_op_value(&val))
}

/// Extract multiple values and convert to OpValues
fn get_op_values(manifold: &Manifold, node_ids: &[NodeId]) -> Result<Vec<OpValue>, RuleError> {
    node_ids
        .iter()
        .map(|&node_id| get_op_value(manifold, node_id))
        .collect()
}

// --- RewriteRule Implementations ---

pub struct IfRule;
impl RewriteRule for IfRule {
    fn pattern(&self) -> &str {
        "If(cond, then, else)"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() < 2 || edge.input_nodes.len() > 3 {
            return Err(RuleError::PatternMismatch);
        }

        // 1. Extract condition value from manifold
        let op_cond = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Use ops-core for strict boolean validation
        let condition = op_cond.as_bool("If").map_err(op_error_to_rule_error)?;

        // 3. Graph rewriting: select branch and create passthrough
        let chosen_branch_node_id = if condition {
            edge.input_nodes[1] // The 'then' branch
        } else if edge.input_nodes.len() == 3 {
            edge.input_nodes[2] // The 'else' branch
        } else {
            // No 'else' branch, so we create a new node resolved to null.
            manifold.create_node(Node::Ready(Value::null()), "if_null_else".into())
        };

        manifold
            .add_edge(HyperedgeSpec {
                constraint_type: ConstraintKind::VariableLookup("passthrough".into()),
                tags: vec![],
                input_nodes: vec![chosen_branch_node_id],
                output_node: edge.output_node,
            })
            .map_err(|e| RuleError::ConstraintViolation(ErrorKind::InvalidArgument(e)))?;

        Ok(())
    }
}

pub struct AndRule;
impl RewriteRule for AndRule {
    fn pattern(&self) -> &str {
        "And(...)"
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
        // 1. Extract all values from manifold
        let op_values = get_op_values(manifold, &edge.input_nodes)?;

        // 2. Use ops-core for AND logic (tristate boolean semantics)
        let result = ops_core::logical::and_many(&op_values, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

pub struct OrRule;
impl RewriteRule for OrRule {
    fn pattern(&self) -> &str {
        "Or(...)"
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
        // 1. Extract all values from manifold
        let op_values = get_op_values(manifold, &edge.input_nodes)?;

        // 2. Use ops-core for OR logic (tristate boolean semantics)
        let result = ops_core::logical::or_many(&op_values, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

pub struct NotRule;
impl RewriteRule for NotRule {
    fn pattern(&self) -> &str {
        "Not(value)"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        // 1. Extract value from manifold
        let op_val = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Use ops-core for NOT logic (tristate: NOT(null) -> null)
        let result =
            ops_core::logical::not(&op_val, &default_ctx()).map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

pub struct IsNullRule;
impl RewriteRule for IsNullRule {
    fn pattern(&self) -> &str {
        "IsNull(value)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 25,
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

        // 1. Extract value from manifold
        let op_val = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Use ops-core for is_null logic
        let result =
            ops_core::logical::is_null(&op_val, &default_ctx()).map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

pub struct IsEmptyRule;
impl RewriteRule for IsEmptyRule {
    fn pattern(&self) -> &str {
        "IsEmpty(value)"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        // 1. Extract value from manifold
        let op_val = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Use ops-core for is_empty logic
        let result =
            ops_core::logical::is_empty(&op_val, &default_ctx()).map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

pub struct CoalesceRule;
impl RewriteRule for CoalesceRule {
    fn pattern(&self) -> &str {
        "Coalesce(...)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: false, // Order matters
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
        // 1. Extract all values from manifold
        let op_values = get_op_values(manifold, &edge.input_nodes)?;

        // 2. Use ops-core for coalesce logic (first non-null)
        let result = ops_core::logical::coalesce(&op_values, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

pub struct XorRule;
impl RewriteRule for XorRule {
    fn pattern(&self) -> &str {
        "Xor(a, b)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: false, // XOR is not idempotent
            reduces_graph: true,
            max_cost_ops: 75,
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

        // 1. Extract values from manifold
        let op_left = get_op_value(manifold, edge.input_nodes[0])?;
        let op_right = get_op_value(manifold, edge.input_nodes[1])?;

        // 2. Use ops-core for XOR logic
        let result = ops_core::logical::xor(&op_left, &op_right, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

pub struct BoolRule;
impl RewriteRule for BoolRule {
    fn pattern(&self) -> &str {
        "Bool(value)"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        // 1. Extract value from manifold
        let op_val = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Use ops-core for strict boolean validation
        let bool_val = op_val.as_bool("Bool").map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(Value::bool(bool_val));
        }
        Ok(())
    }
}

pub struct SwitchRule;
impl RewriteRule for SwitchRule {
    fn pattern(&self) -> &str {
        "Switch(value, case1, result1, case2, result2, ..., default)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 200,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() < 3 {
            return Err(RuleError::PatternMismatch);
        }

        // 1. Extract all values from manifold
        let op_values = get_op_values(manifold, &edge.input_nodes)?;

        // 2. Use ops-core for switch logic
        // switch expects: switch_value, then pairs of [case, result, case, result, ...], optional default
        let result = ops_core::logical::switch(&op_values[0], &op_values[1..], &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

pub struct IfErrorRule;
impl RewriteRule for IfErrorRule {
    fn pattern(&self) -> &str {
        "IfError(try_value, error_value)"
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

        // Try to get the first value - if it fails, use fallback
        // Note: In formula-engine context, we check if the node is resolved
        let result = match get_resolved_value(manifold, edge.input_nodes[0]) {
            Ok(val) => val,
            Err(_) => {
                // Error occurred during resolution, use error_value
                get_resolved_value(manifold, edge.input_nodes[1])?
            }
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}

pub struct TryRule;
impl RewriteRule for TryRule {
    fn pattern(&self) -> &str {
        "Try(value)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 75,
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

        // Try to get the value, convert errors to null
        let result = match get_resolved_value(manifold, edge.input_nodes[0]) {
            Ok(val) => val,
            Err(_) => Value::null(), // Any error becomes null
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}

pub struct IfNullRule;
impl RewriteRule for IfNullRule {
    fn pattern(&self) -> &str {
        "IfNull(value, fallback)"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        // 1. Extract values from manifold
        let op_val = get_op_value(manifold, edge.input_nodes[0])?;
        let op_fallback = get_op_value(manifold, edge.input_nodes[1])?;

        // 2. Use ops-core for if_null logic
        let result = ops_core::logical::if_null(&op_val, &op_fallback, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}
