//! Text RewriteRules for the Formula Engine Solver
//!
//! This module delegates text operations to ops-core while handling
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

/// Collect OpValues from input nodes
fn get_op_values(manifold: &Manifold, node_ids: &[NodeId]) -> Result<Vec<OpValue>, RuleError> {
    node_ids
        .iter()
        .map(|&id| get_op_value(manifold, id))
        .collect()
}

// --- Legacy Helpers (for rules that ops-core doesn't directly support) ---

/// Safely extracts a resolved string value from a node.
fn get_resolved_string(manifold: &Manifold, node_id: NodeId) -> Result<Option<String>, RuleError> {
    match manifold.get_node(node_id) {
        Some(Node::Ready(val)) => {
            if val.is_null() {
                return Ok(None);
            }
            Ok(Some(to_text_or_empty(val)))
        }
        _ => Err(RuleError::PatternMismatch),
    }
}

/// Safely extracts a resolved number (as usize) from a node.
fn get_resolved_usize(manifold: &Manifold, node_id: NodeId) -> Result<Option<usize>, RuleError> {
    match manifold.get_node(node_id) {
        Some(Node::Ready(val)) => {
            if val.is_null() {
                return Ok(None);
            }
            if let Some(n) = val.inner().as_f64() {
                if n >= 0.0 && n.is_finite() && n.fract() == 0.0 {
                    return Ok(Some(n as usize));
                }
            }
            Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
                "Expected a non-negative integer.".into(),
            )))
        }
        _ => Err(RuleError::PatternMismatch),
    }
}

/// Helper to convert values to text using standard conversion rules.
fn to_text_or_empty(v: &Value) -> String {
    match v.inner() {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Null => String::new(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => v.inner().to_string(),
    }
}

// --- RewriteRule Implementations ---

/// Concat(...) -> string
/// Delegates to ops_core::text::concat_many
pub struct ConcatRule;
impl RewriteRule for ConcatRule {
    fn pattern(&self) -> &str {
        "Concat(...)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: false,
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
        // 1. Extract from manifold
        let op_values = get_op_values(manifold, &edge.input_nodes)?;

        // 2. Delegate to ops-core
        let result = ops_core::text::concat_many(&op_values, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Len(text) -> number
/// Delegates to ops_core::text::len
pub struct LenRule;
impl RewriteRule for LenRule {
    fn pattern(&self) -> &str {
        "Len(text)"
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

        // 1. Extract from manifold
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Delegate to ops-core
        let result =
            ops_core::text::len(&op_text, &default_ctx()).map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Trim(text) -> string
/// Delegates to ops_core::text::trim
pub struct TrimRule;
impl RewriteRule for TrimRule {
    fn pattern(&self) -> &str {
        "Trim(text)"
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

        // 1. Extract from manifold
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Delegate to ops-core
        let result =
            ops_core::text::trim(&op_text, &default_ctx()).map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Upper(text) -> string
/// Delegates to ops_core::text::upper
pub struct UpperRule;
impl RewriteRule for UpperRule {
    fn pattern(&self) -> &str {
        "Upper(text)"
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

        // 1. Extract from manifold
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Delegate to ops-core
        let result =
            ops_core::text::upper(&op_text, &default_ctx()).map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Lower(text) -> string
/// Delegates to ops_core::text::lower
pub struct LowerRule;
impl RewriteRule for LowerRule {
    fn pattern(&self) -> &str {
        "Lower(text)"
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

        // 1. Extract from manifold
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Delegate to ops-core
        let result =
            ops_core::text::lower(&op_text, &default_ctx()).map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Left(text, count) -> string
/// Delegates to ops_core::text::left
pub struct LeftRule;
impl RewriteRule for LeftRule {
    fn pattern(&self) -> &str {
        "Left(text, count)"
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
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;
        let op_count = get_op_value(manifold, edge.input_nodes[1])?;

        // 2. Delegate to ops-core
        let result = ops_core::text::left(&op_text, &op_count, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Right(text, count) -> string
/// Delegates to ops_core::text::right
pub struct RightRule;
impl RewriteRule for RightRule {
    fn pattern(&self) -> &str {
        "Right(text, count)"
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
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;
        let op_count = get_op_value(manifold, edge.input_nodes[1])?;

        // 2. Delegate to ops-core
        let result = ops_core::text::right(&op_text, &op_count, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Mid(text, start, length) -> string
/// Delegates to ops_core::text::substring
pub struct MidRule;
impl RewriteRule for MidRule {
    fn pattern(&self) -> &str {
        "Mid(text, start, length)"
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
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 3 {
            return Err(RuleError::PatternMismatch);
        }

        // 1. Extract from manifold
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;
        let op_start = get_op_value(manifold, edge.input_nodes[1])?;
        let op_length = get_op_value(manifold, edge.input_nodes[2])?;

        // 2. Delegate to ops-core
        // Note: ops-core substring uses 0-based indexing, Mid uses 1-based
        // We need to adjust the start index
        let result = ops_core::text::substring(&op_text, &op_start, &op_length, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Find(search_text, within_text) -> number
/// Delegates to ops_core::text::index_of
pub struct FindRule;
impl RewriteRule for FindRule {
    fn pattern(&self) -> &str {
        "Find(search_text, within_text)"
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

        // 1. Extract from manifold (note: Find has search first, then text)
        let op_search = get_op_value(manifold, edge.input_nodes[0])?;
        let op_text = get_op_value(manifold, edge.input_nodes[1])?;

        // 2. Delegate to ops-core (note: index_of has text first, then search)
        let result = ops_core::text::index_of(&op_text, &op_search, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Substitute(text, old, new) -> string
/// Delegates to ops_core::text::replace
pub struct SubstituteRule;
impl RewriteRule for SubstituteRule {
    fn pattern(&self) -> &str {
        "Substitute(text, old, new)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: false,
            reduces_graph: true,
            max_cost_ops: 300,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 3 {
            return Err(RuleError::PatternMismatch);
        }

        // 1. Extract from manifold
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;
        let op_old = get_op_value(manifold, edge.input_nodes[1])?;
        let op_new = get_op_value(manifold, edge.input_nodes[2])?;

        // 2. Delegate to ops-core
        let result = ops_core::text::replace(&op_text, &op_old, &op_new, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Split(text, delimiter) -> array
/// Delegates to ops_core::text::split
pub struct SplitRule;
impl RewriteRule for SplitRule {
    fn pattern(&self) -> &str {
        "Split(text, delimiter)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 400,
            cost_model: RuleCostModel::aggregation_complex(),
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
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;
        let op_delimiter = get_op_value(manifold, edge.input_nodes[1])?;

        // 2. Delegate to ops-core
        let result = ops_core::text::split(&op_text, &op_delimiter, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Join(array, delimiter) -> string
/// Delegates to ops_core::text::join
pub struct JoinRule;
impl RewriteRule for JoinRule {
    fn pattern(&self) -> &str {
        "Join(array, delimiter)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 400,
            cost_model: RuleCostModel::aggregation_complex(),
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
        let op_array = get_op_value(manifold, edge.input_nodes[0])?;
        let op_delimiter = get_op_value(manifold, edge.input_nodes[1])?;

        // 2. Delegate to ops-core
        let result = ops_core::text::join(&op_array, &op_delimiter, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Contains(text, search) -> boolean
/// Delegates to ops_core::text::contains
pub struct ContainsRule;
impl RewriteRule for ContainsRule {
    fn pattern(&self) -> &str {
        "Contains(text, search)"
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
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;
        let op_search = get_op_value(manifold, edge.input_nodes[1])?;

        // 2. Delegate to ops-core
        let result = ops_core::text::contains(&op_text, &op_search, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Repeat(text, count) -> string
/// Delegates to ops_core::text::repeat
pub struct RepeatRule;
impl RewriteRule for RepeatRule {
    fn pattern(&self) -> &str {
        "Repeat(text, count)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: false,
            reduces_graph: true,
            max_cost_ops: 300,
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
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;
        let op_count = get_op_value(manifold, edge.input_nodes[1])?;

        // 2. Delegate to ops-core
        let result = ops_core::text::repeat(&op_text, &op_count, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// LTrim(text) -> string
/// Delegates to ops_core::text::trim_start
pub struct LTrimRule;
impl RewriteRule for LTrimRule {
    fn pattern(&self) -> &str {
        "LTrim(text)"
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

        // 1. Extract from manifold
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Delegate to ops-core
        let result =
            ops_core::text::trim_start(&op_text, &default_ctx()).map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// RTrim(text) -> string
/// Delegates to ops_core::text::trim_end
pub struct RTrimRule;
impl RewriteRule for RTrimRule {
    fn pattern(&self) -> &str {
        "RTrim(text)"
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

        // 1. Extract from manifold
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Delegate to ops-core
        let result =
            ops_core::text::trim_end(&op_text, &default_ctx()).map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- Rules without ops-core equivalents (keep original implementation) ---

/// Base64Encode(text) -> string
/// Note: ops-core doesn't have base64 encoding, keep original implementation
pub struct Base64EncodeRule;
impl RewriteRule for Base64EncodeRule {
    fn pattern(&self) -> &str {
        "Base64Encode(text)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: false,
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
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let text_opt = get_resolved_string(manifold, edge.input_nodes[0])?;
        let result = match text_opt {
            Some(text) => {
                use base64::{engine::general_purpose::STANDARD, Engine};
                Value::string(STANDARD.encode(text.as_bytes()))
            }
            None => Value::null(),
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}

/// Base64Decode(encoded) -> string
/// Note: ops-core doesn't have base64 decoding, keep original implementation
pub struct Base64DecodeRule;
impl RewriteRule for Base64DecodeRule {
    fn pattern(&self) -> &str {
        "Base64Decode(encoded)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: false,
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
        if edge.input_nodes.len() != 1 {
            return Err(RuleError::PatternMismatch);
        }

        let text_opt = get_resolved_string(manifold, edge.input_nodes[0])?;
        let result = match text_opt {
            Some(encoded) => {
                use base64::{engine::general_purpose::STANDARD, Engine};
                match STANDARD.decode(&encoded) {
                    Ok(bytes) => match String::from_utf8(bytes) {
                        Ok(decoded) => Value::string(&decoded),
                        Err(_) => {
                            return Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
                                "Invalid UTF-8 in decoded Base64".to_string(),
                            )))
                        }
                    },
                    Err(_) => {
                        return Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
                            "Invalid Base64 encoding".to_string(),
                        )))
                    }
                }
            }
            None => Value::null(),
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}

/// Format(template, ...) -> string
/// Delegates to ops_core::text::format
pub struct FormatRule;
impl RewriteRule for FormatRule {
    fn pattern(&self) -> &str {
        "Format(template, ...)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: false,
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
        if edge.input_nodes.is_empty() {
            return Err(RuleError::PatternMismatch);
        }

        // 1. Extract from manifold
        let op_template = get_op_value(manifold, edge.input_nodes[0])?;
        let op_args = get_op_values(manifold, &edge.input_nodes[1..])?;

        // 2. Delegate to ops-core
        let result = ops_core::text::format(&op_template, &op_args, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// Replace(text, start, length, new_text) -> string
/// Note: This is position-based replacement, different from Substitute
/// ops-core's replace is pattern-based, so keep original implementation
pub struct ReplaceRule;
impl RewriteRule for ReplaceRule {
    fn pattern(&self) -> &str {
        "Replace(text, start, length, new_text)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: false,
            reduces_graph: true,
            max_cost_ops: 300,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }
    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 4 {
            return Err(RuleError::PatternMismatch);
        }

        let text_opt = get_resolved_string(manifold, edge.input_nodes[0])?;
        let start_opt = get_resolved_usize(manifold, edge.input_nodes[1])?;
        let length_opt = get_resolved_usize(manifold, edge.input_nodes[2])?;
        let new_text_opt = get_resolved_string(manifold, edge.input_nodes[3])?;

        let result = match (text_opt, start_opt, length_opt, new_text_opt) {
            (Some(text), Some(start), Some(length), Some(new_text)) => {
                let start_idx = if start > 0 { start - 1 } else { 0 };
                let graphemes: Vec<&str> = text.graphemes(true).collect();
                if start_idx > graphemes.len() {
                    return Err(RuleError::ConstraintViolation(ErrorKind::InvalidArgument(
                        "Start position is out of bounds.".into(),
                    )));
                }
                let end_idx = (start_idx + length).min(graphemes.len());

                let mut result_str = String::new();
                result_str.push_str(&graphemes[..start_idx].join(""));
                result_str.push_str(&new_text);
                result_str.push_str(&graphemes[end_idx..].join(""));

                Value::string(&result_str)
            }
            _ => Value::null(),
        };

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}

/// Normalize(text, form) -> string
/// Delegates to ops_core::text::normalize
pub struct NormalizeRule;
impl RewriteRule for NormalizeRule {
    fn pattern(&self) -> &str {
        "Normalize(text, form)"
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

        // 1. Extract from manifold
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;
        let op_form = get_op_value(manifold, edge.input_nodes[1])?;

        // 2. Delegate to ops-core
        let result = ops_core::text::normalize(&op_text, &op_form, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// RegexExtract(text, pattern) -> array of strings
/// Delegates to ops_core::text::regex_extract
pub struct RegexExtractRule;
impl RewriteRule for RegexExtractRule {
    fn pattern(&self) -> &str {
        "RegexExtract(text, pattern)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 500,
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

        let op_text = get_op_value(manifold, edge.input_nodes[0])?;
        let op_pattern = get_op_value(manifold, edge.input_nodes[1])?;

        let result = ops_core::text::regex_extract(&op_text, &op_pattern, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// JsonParse(input) -> parsed value
/// Delegates to ops_core::text::json_parse
pub struct JsonParseRule;
impl RewriteRule for JsonParseRule {
    fn pattern(&self) -> &str {
        "JsonParse(input)"
    }
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: false, // json_parse(json_parse(x)) != json_parse(x) for double-encoded
            reduces_graph: true,
            max_cost_ops: 500,
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

        let op_input = get_op_value(manifold, edge.input_nodes[0])?;

        let result = ops_core::text::json_parse(&op_input, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

/// CaseFold(text) -> string
/// Delegates to ops_core::text::case_fold
pub struct CaseFoldRule;
impl RewriteRule for CaseFoldRule {
    fn pattern(&self) -> &str {
        "CaseFold(text)"
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
        let op_text = get_op_value(manifold, edge.input_nodes[0])?;

        // 2. Delegate to ops-core
        let result =
            ops_core::text::case_fold(&op_text, &default_ctx()).map_err(op_error_to_rule_error)?;

        // 3. Write result back to manifold
        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}
