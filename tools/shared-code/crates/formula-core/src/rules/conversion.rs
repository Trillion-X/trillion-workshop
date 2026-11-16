//! Conversion RewriteRules for the Formula Engine Solver
//!
//! This module delegates type conversion operations to ops-core while handling
//! the graph rewriting aspects (extracting from manifold, writing results).
//!
//! Implements from Formula Engine spec (Section 4.8):
//! - VALUE(text) -> Number | Decimal
//! - TEXT(value, format?) -> String
//! - IS_NUMBER(value) -> Boolean
//! - IS_NAN(value) -> Boolean
//! - IS_FINITE(value) -> Boolean

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
        OpError::ConversionError { from, to, .. } => {
            RuleError::ConstraintViolation(ErrorKind::TypeMismatch {
                expected: to.clone(),
                found: from.clone(),
            })
        }
        OpError::InvalidOperation { reason: _, .. } => {
            RuleError::ConstraintViolation(ErrorKind::NonFiniteResult)
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

/// Get a resolved value from manifold as OpValue
fn get_op_value(manifold: &Manifold, node_id: NodeId) -> Result<OpValue, RuleError> {
    match manifold.get_node(node_id) {
        Some(Node::Ready(val)) => Ok(to_op_value(val)),
        Some(Node::Pending) => Ok(OpValue::null()),
        None => Err(RuleError::PatternMismatch),
    }
}

// --- VALUE Rule ---
// VALUE(text: String) -> Number | Decimal
// Converts a string to a number. Returns Decimal for financial precision.
// Delegates to ops_core::conversion::to_number

pub struct ValueRule;

impl RewriteRule for ValueRule {
    fn pattern(&self) -> &str {
        "VALUE(text) -> number"
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
            return Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
                "VALUE() expects exactly 1 argument".to_string(),
            )));
        }

        let op_input = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::conversion::to_number(&op_input, &strict_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- TEXT Rule ---
// TEXT(value: Any, format?: String) -> String
// Converts any value to a string representation.
// Delegates to ops_core::conversion::to_string

pub struct TextRule;

impl RewriteRule for TextRule {
    fn pattern(&self) -> &str {
        "TEXT(value, format?) -> string"
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
            return Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
                "TEXT() expects 1 or 2 arguments".to_string(),
            )));
        }

        let op_input = get_op_value(manifold, edge.input_nodes[0])?;
        // Note: format parameter is captured but not yet used by ops-core
        // Future enhancement: pass format to ops-core when supported

        let result = ops_core::conversion::to_string(&op_input, &strict_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- IS_NUMBER Rule ---
// IS_NUMBER(value: Any) -> Boolean
// Returns true if the value is a valid number (not NaN, not Infinity).
// Uses type_of() to check if type is "number", then is_finite() to check for NaN/Infinity

pub struct IsNumberRule;

impl RewriteRule for IsNumberRule {
    fn pattern(&self) -> &str {
        "IS_NUMBER(value) -> boolean"
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
            return Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
                "IS_NUMBER() expects exactly 1 argument".to_string(),
            )));
        }

        let op_input = get_op_value(manifold, edge.input_nodes[0])?;
        // type_of(value) == "number" AND is_finite(value)
        let type_result = ops_core::conversion::type_of(&op_input, &strict_ctx())
            .map_err(op_error_to_rule_error)?;
        let is_number_type = type_result.as_str("is_number").ok() == Some("number");

        let is_finite_result = ops_core::conversion::is_finite(&op_input, &strict_ctx())
            .map_err(op_error_to_rule_error)?;
        let is_finite_val = is_finite_result.is_truthy();

        let result = OpValue::bool(is_number_type && is_finite_val);

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- IS_NAN Rule ---
// IS_NAN(value: Any) -> Boolean
// Returns true if the value is NaN (Not a Number).
// Delegates to ops_core::conversion::is_nan

pub struct IsNanRule;

impl RewriteRule for IsNanRule {
    fn pattern(&self) -> &str {
        "IS_NAN(value) -> boolean"
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
            return Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
                "IS_NAN() expects exactly 1 argument".to_string(),
            )));
        }

        let op_input = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::conversion::is_nan(&op_input, &strict_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- IS_FINITE Rule ---
// IS_FINITE(value: Any) -> Boolean
// Returns true if the value is a finite number (not NaN, not Infinity).
// Delegates to ops_core::conversion::is_finite

pub struct IsFiniteRule;

impl RewriteRule for IsFiniteRule {
    fn pattern(&self) -> &str {
        "IS_FINITE(value) -> boolean"
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
            return Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
                "IS_FINITE() expects exactly 1 argument".to_string(),
            )));
        }

        let op_input = get_op_value(manifold, edge.input_nodes[0])?;
        let result = ops_core::conversion::is_finite(&op_input, &strict_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- Tests ---

#[cfg(test)]
mod tests {
    // Tests would use mock implementations of Manifold and SolverContext
    // See services/mock.rs for test doubles
}
