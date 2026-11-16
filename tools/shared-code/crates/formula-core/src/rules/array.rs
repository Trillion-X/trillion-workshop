//! Array RewriteRules for the Formula Engine Solver
//!
//! This module delegates array operations to ops-core while handling
//! the graph rewriting aspects (extracting from manifold, writing results).

use crate::rules::{
    ErrorKind, RewriteRule, RuleCostModel, RuleError, RuleProperties, SolverContext,
};
use crate::{Hyperedge, Manifold, Node, NodeId, Value};
use ops_core::{EvalContext, OpError, OpValue};
use unicode_segmentation::UnicodeSegmentation;

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
        OpError::IndexOutOfBounds {
            operation,
            index,
            length,
        } => RuleError::ConstraintViolation(ErrorKind::InvalidArgument(format!(
            "{}: index {} out of bounds (length={})",
            operation, index, length
        ))),
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

/// Create default EvalContext for ops-core operations
fn default_ctx() -> EvalContext {
    EvalContext::default()
}

/// Get a resolved value from manifold as OpValue
fn get_op_value(manifold: &Manifold, node_id: NodeId) -> Result<OpValue, RuleError> {
    match manifold.get_node(node_id) {
        Some(Node::Ready(val)) => Ok(to_op_value(val)),
        Some(Node::Pending) => Ok(OpValue::null()),
        None => Err(RuleError::PatternMismatch),
    }
}

// --- Legacy Helpers (for rules that ops-core doesn't directly support) ---

/// Safely extracts a resolved value from a node.
fn get_resolved_value(manifold: &Manifold, node_id: NodeId) -> Result<Option<Value>, RuleError> {
    match manifold.get_node(node_id) {
        Some(Node::Ready(val)) => Ok(Some(val.clone())),
        Some(Node::Pending) => Ok(None),
        None => Err(RuleError::PatternMismatch),
    }
}

/// Safely extracts a resolved integer from a node, without unsafe coercion.
fn get_resolved_integer(manifold: &Manifold, node_id: NodeId) -> Result<Option<i64>, RuleError> {
    match manifold.get_node(node_id) {
        Some(Node::Ready(val)) => {
            if val.is_null() {
                return Ok(None);
            }
            // Prioritize i64, then check if f64 is a whole number.
            if let Some(i) = val.inner().as_i64() {
                return Ok(Some(i));
            }
            if let Some(f) = val.inner().as_f64() {
                if f.fract() == 0.0 && f.is_finite() {
                    return Ok(Some(f as i64));
                }
            }
            Err(RuleError::ConstraintViolation(ErrorKind::TypeMismatch {
                expected: "integer".into(),
                found: val.type_name().into(),
            }))
        }
        _ => Err(RuleError::PatternMismatch),
    }
}

/// Check if two values are equal with numeric tolerance
fn values_equal(a: &Value, b: &Value) -> bool {
    if a == b {
        true
    } else {
        // Check if both are numbers and numerically equal
        match (a.inner().as_f64(), b.inner().as_f64()) {
            (Some(x), Some(y)) => (x - y).abs() < f64::EPSILON,
            _ => false,
        }
    }
}

// --- RewriteRule Implementations ---

/// ARRAY_LENGTH(array) -> number
/// Delegates to ops_core::array::length
pub struct ArrayLengthRule;
impl RewriteRule for ArrayLengthRule {
    fn pattern(&self) -> &str {
        "ArrayLength(array)"
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

        // 1. Extract from manifold
        let op_arr = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Delegate to ops-core
        let result =
            ops_core::array::length(&op_arr, &default_ctx()).map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// ARRAY_GET(array, index) -> value
/// Delegates to ops_core::array::nth
pub struct ArrayGetRule;
impl RewriteRule for ArrayGetRule {
    fn pattern(&self) -> &str {
        "ArrayGet(array, index)"
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
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        // 1. Extract from manifold
        let op_arr = get_op_value(manifold, edge.input_nodes[0])?;
        let op_idx = get_op_value(manifold, edge.input_nodes[1])?;

        // 2. Delegate to ops-core
        let result = ops_core::array::nth(&op_arr, &op_idx, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// ARRAY_CONTAINS(haystack, needle) -> boolean
/// Delegates to ops_core::array::includes for arrays
/// Note: For strings, uses custom logic (substring search) which ops-core doesn't support
pub struct ArrayContainsRule;
impl RewriteRule for ArrayContainsRule {
    fn pattern(&self) -> &str {
        "ArrayContains(haystack, needle)"
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
        if edge.input_nodes.len() != 2 {
            return Err(RuleError::PatternMismatch);
        }

        let haystack_opt = get_resolved_value(manifold, edge.input_nodes[0])?;
        let needle_opt = get_resolved_value(manifold, edge.input_nodes[1])?;

        let result = match (haystack_opt, needle_opt) {
            (Some(haystack), Some(needle)) => {
                // String haystack: substring contains (ops-core doesn't have this)
                if let Some(hay_str) = haystack.inner().as_str() {
                    if let Some(needle_str) = needle.inner().as_str() {
                        Value::bool(hay_str.contains(needle_str))
                    } else {
                        return Err(RuleError::ConstraintViolation(ErrorKind::TypeMismatch {
                            expected: "string needle for string haystack".into(),
                            found: needle.type_name().into(),
                        }));
                    }
                }
                // Array haystack: delegate to ops-core
                else if haystack.inner().as_array().is_some() {
                    let op_arr = to_op_value(&haystack);
                    let op_needle = to_op_value(&needle);
                    let result = ops_core::array::includes(&op_arr, &op_needle, &default_ctx())
                        .map_err(op_error_to_rule_error)?;
                    from_op_value(result)
                } else {
                    return Err(RuleError::ConstraintViolation(ErrorKind::TypeMismatch {
                        expected: "array or string".into(),
                        found: haystack.type_name().into(),
                    }));
                }
            }
            _ => Value::null(),
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}

/// LOOKUP(container, key_or_index, [fallback]) -> value
/// Delegates to ops_core::array::lookup
pub struct LookupRule;
impl RewriteRule for LookupRule {
    fn pattern(&self) -> &str {
        "Lookup(container, key_or_index, [fallback])"
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
        if edge.input_nodes.len() < 2 || edge.input_nodes.len() > 3 {
            return Err(RuleError::PatternMismatch);
        }

        // 1. Extract from manifold
        let op_container = get_op_value(manifold, edge.input_nodes[0])?;
        let op_key = get_op_value(manifold, edge.input_nodes[1])?;
        let op_fallback = if edge.input_nodes.len() == 3 {
            Some(get_op_value(manifold, edge.input_nodes[2])?)
        } else {
            None
        };

        // 2. Delegate to ops-core
        let result =
            ops_core::array::lookup(&op_container, &op_key, op_fallback.as_ref(), &default_ctx())
                .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// IndexOf(haystack, needle, [start]) -> number
/// Note: ops-core's index_of is simpler (0-based, no start). We keep custom logic
/// for 1-based indexing and Unicode support.
pub struct IndexOfRule;
impl RewriteRule for IndexOfRule {
    fn pattern(&self) -> &str {
        "IndexOf(haystack, needle, [start])"
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
        if edge.input_nodes.len() < 2 || edge.input_nodes.len() > 3 {
            return Err(RuleError::PatternMismatch);
        }

        let haystack_opt = get_resolved_value(manifold, edge.input_nodes[0])?;
        let needle_opt = get_resolved_value(manifold, edge.input_nodes[1])?;
        let start_opt = if edge.input_nodes.len() == 3 {
            get_resolved_integer(manifold, edge.input_nodes[2])?
        } else {
            Some(1) // 1-based default start index
        };

        let result = match (haystack_opt, needle_opt, start_opt) {
            (Some(haystack), Some(needle), Some(start)) => {
                let start_idx = if start > 0 { (start - 1) as usize } else { 0 };

                // String mode (Unicode-safe with graphemes)
                if let Some(hay_str) = haystack.inner().as_str() {
                    if let Some(needle_str) = needle.inner().as_str() {
                        let hay_graphemes: Vec<&str> = hay_str.graphemes(true).collect();
                        let needle_graphemes: Vec<&str> = needle_str.graphemes(true).collect();

                        if start_idx >= hay_graphemes.len() {
                            Value::number(0.0) // Not found
                        } else if needle_graphemes.is_empty() {
                            // Empty needle always matches at start position
                            Value::number((start_idx + 1) as f64)
                        } else if needle_graphemes.len() > hay_graphemes.len() - start_idx {
                            // Needle is longer than remaining haystack
                            Value::number(0.0)
                        } else {
                            // Use a sliding window for multi-grapheme search.
                            let position = hay_graphemes[start_idx..]
                                .windows(needle_graphemes.len())
                                .position(|window| window == needle_graphemes.as_slice());

                            match position {
                                Some(pos) => Value::number((pos + start_idx + 1) as f64), // 1-based
                                None => Value::number(0.0),
                            }
                        }
                    } else {
                        return Err(RuleError::ConstraintViolation(ErrorKind::TypeMismatch {
                            expected: "string needle for string haystack".into(),
                            found: needle.type_name().into(),
                        }));
                    }
                }
                // Array mode
                else if let Some(arr) = haystack.inner().as_array() {
                    if start_idx >= arr.len() {
                        Value::number(0.0) // Not found
                    } else {
                        let position = arr[start_idx..]
                            .iter()
                            .position(|v| values_equal(&Value(v.clone()), &needle));
                        match position {
                            Some(pos) => Value::number((pos + start_idx + 1) as f64), // 1-based
                            None => Value::number(0.0),
                        }
                    }
                } else {
                    return Err(RuleError::ConstraintViolation(ErrorKind::TypeMismatch {
                        expected: "array or string".into(),
                        found: haystack.type_name().into(),
                    }));
                }
            }
            _ => Value::null(),
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}

// --- Higher-Order Functions (Composability Support) ---

// NOTE: These rules are complex. They need to invoke the solver recursively
// on a lambda expression. This requires passing the EvaluationContext and a handle
// to the solver itself, which is a significant architectural pattern.
// ops-core provides stubs (map_stub, reduce_stub) but they don't actually work.

pub struct FilterRule;
impl RewriteRule for FilterRule {
    fn pattern(&self) -> &str {
        "Filter(array, lambda)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: false, // Lambda evaluation is not necessarily monotonic
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 1000,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
    fn rewrite(
        &self,
        _manifold: &mut Manifold,
        _edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        // This is a placeholder for the complex lazy evaluation logic.
        // A full implementation requires solver re-entrancy.
        Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
            "FILTER with lambda evaluation is not yet fully implemented in the solver.".into(),
        )))
    }
}

pub struct MapRule;
impl RewriteRule for MapRule {
    fn pattern(&self) -> &str {
        "Map(array, lambda)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: false,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 1000,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
    fn rewrite(
        &self,
        _manifold: &mut Manifold,
        _edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
            "MAP with lambda evaluation is not yet fully implemented in the solver.".into(),
        )))
    }
}

pub struct ReduceRule;
impl RewriteRule for ReduceRule {
    fn pattern(&self) -> &str {
        "Reduce(array, lambda, initial)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: false,
            is_idempotent: false, // Depends on the lambda and initial value
            reduces_graph: true,
            max_cost_ops: 1000,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
    fn rewrite(
        &self,
        _manifold: &mut Manifold,
        _edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
            "REDUCE with lambda evaluation is not yet fully implemented in the solver.".into(),
        )))
    }
}

/// COUNT(array) -> number
/// Delegates to ops_core::array::count
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

        // 1. Extract from manifold
        let op_arr = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Delegate to ops-core
        let result =
            ops_core::array::count(&op_arr, &default_ctx()).map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// COUNTIF(array, lambda) -> number
pub struct CountIfRule;
impl RewriteRule for CountIfRule {
    fn pattern(&self) -> &str {
        "CountIf(array, lambda)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: false, // Lambda evaluation is not necessarily monotonic
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 1000,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }
    fn rewrite(
        &self,
        _manifold: &mut Manifold,
        _edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        // This is a placeholder for the complex lazy evaluation logic
        // required to execute the lambda. A full implementation requires
        // solver re-entrancy.
        Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
            "COUNTIF with lambda evaluation is not yet fully implemented in the solver.".into(),
        )))
    }
}

/// SIZE(value) -> number (universal size/length function)
/// Note: This is more general than ops-core's length (works on strings, objects too)
pub struct SizeRule;
impl RewriteRule for SizeRule {
    fn pattern(&self) -> &str {
        "Size(value)"
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

        let value_opt = get_resolved_value(manifold, edge.input_nodes[0])?;

        let result = match value_opt {
            Some(value) => {
                if let Some(s) = value.inner().as_str() {
                    // Use grapheme count for Unicode safety
                    Value::number(s.graphemes(true).count() as f64)
                } else if let Some(arr) = value.inner().as_array() {
                    Value::number(arr.len() as f64)
                } else if let Some(obj) = value.inner().as_object() {
                    Value::number(obj.len() as f64)
                } else if value.is_null() {
                    Value::number(0.0)
                } else {
                    // Atomic values (numbers, booleans) have size 1
                    Value::number(1.0)
                }
            }
            None => Value::number(0.0),
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}
