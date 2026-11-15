//! Graph Traversal RewriteRules for the Formula Engine Solver
//!
//! This file implements the graph traversal functions from the Formula Engine spec (Section 4.6):
//! - PARENTS(entity, relationship_type) -> Array<EntityReference>
//! - CHILDREN(entity, relationship_type) -> Array<EntityReference>
//! - NEIGHBORS(entity) -> Array<EntityReference>
//! - TRAVERSE(start, path_definition) -> GraphPath
//!
//! These are powerful, platform-specific functions for navigating the ERTCA knowledge graph.
//! They operate on EntityReferences and return arrays of related entities.
//!
//! # Architecture Note
//!
//! These rules delegate to ops-core for input validation and stub behavior.
//! Actual graph traversal is performed by caller-owned code through the SolverContext.
//! The ops-core functions are stubs that return empty arrays after validation.
//!
//! Resource Limits (from spec Section 6.6):
//! - Breadth budget: 10,000 nodes
//! - Edge budget: 50,000 edges
//! - Cycle detection enabled via visited set keyed on entity ID
//! - Global 50ms evaluation timeout respected
//! - Early termination returns E_GRAPH_BUDGET_EXCEEDED

use crate::rules::{
    ErrorKind, RewriteRule, RuleCostModel, RuleError, RuleProperties, SolverContext,
};
use crate::{Hyperedge, Manifold, Node, NodeId, Value};
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

/// Get ops-core OpValue from a manifold node
fn get_op_value(manifold: &Manifold, node_id: NodeId) -> Result<OpValue, RuleError> {
    match manifold.get_node(node_id) {
        Some(Node::Ready(val)) => Ok(to_op_value(val)),
        _ => Err(RuleError::PatternMismatch),
    }
}

/// Create default EvalContext for graph operations
fn default_ctx() -> EvalContext {
    EvalContext::default()
}

// --- Rule-Specific Helpers ---

fn err_arity(name: &str, expected: &'static str) -> RuleError {
    RuleError::ConstraintViolation(ErrorKind::InvalidArgument(format!(
        "{name}() expects {expected}"
    )))
}

// --- PARENTS Rule ---
// PARENTS(entity: EntityReference, relationship_type: String) -> Array<EntityReference>
// Returns all parent entities connected by a specific relationship type.

pub struct ParentsRule;

impl RewriteRule for ParentsRule {
    fn pattern(&self) -> &str {
        "PARENTS(entity, relationship_type) -> Array<EntityReference>"
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 1000,
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
            return Err(err_arity(
                "PARENTS",
                "exactly 2 arguments (entity, relationship_type)",
            ));
        }

        let entity = get_op_value(manifold, edge.input_nodes[0])?;
        let rel_type = get_op_value(manifold, edge.input_nodes[1])?;

        // Delegate to ops-core for validation and stub behavior
        // NOTE: Actual graph traversal is performed by caller-owned code through the SolverContext.
        // In Pure Mode, graph data must be pre-resolved in the evaluation context.
        // In trusted bridge mode, the caller performs the actual traversal.
        let result = ops_core::graph::parents(&entity, &rel_type, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- CHILDREN Rule ---
// CHILDREN(entity: EntityReference, relationship_type: String) -> Array<EntityReference>
// Returns all child entities connected by a specific relationship type.

pub struct ChildrenRule;

impl RewriteRule for ChildrenRule {
    fn pattern(&self) -> &str {
        "CHILDREN(entity, relationship_type) -> Array<EntityReference>"
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 1000,
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
            return Err(err_arity(
                "CHILDREN",
                "exactly 2 arguments (entity, relationship_type)",
            ));
        }

        let entity = get_op_value(manifold, edge.input_nodes[0])?;
        let rel_type = get_op_value(manifold, edge.input_nodes[1])?;

        // Delegate to ops-core for validation and stub behavior
        let result = ops_core::graph::children(&entity, &rel_type, &default_ctx())
            .map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- NEIGHBORS Rule ---
// NEIGHBORS(entity: EntityReference) -> Array<EntityReference>
// Returns all entities connected to the given entity, regardless of relationship type or direction.

pub struct NeighborsRule;

impl RewriteRule for NeighborsRule {
    fn pattern(&self) -> &str {
        "NEIGHBORS(entity) -> Array<EntityReference>"
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 1000,
            cost_model: RuleCostModel::aggregation_complex(),
        }
    }

    fn rewrite(
        &self,
        manifold: &mut Manifold,
        edge: &Hyperedge,
        _ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(err_arity("NEIGHBORS", "exactly 1 argument (entity)"));
        }

        let entity = get_op_value(manifold, edge.input_nodes[0])?;

        // Delegate to ops-core for validation and stub behavior
        let result =
            ops_core::graph::neighbors(&entity, &default_ctx()).map_err(op_error_to_rule_error)?;

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(from_op_value(result));
        }
        Ok(())
    }
}

// --- TRAVERSE Rule ---
// TRAVERSE(start: EntityReference, path_definition: String) -> GraphPath
// Traverses the graph from a starting entity following a defined path of relationship types.
// The path_definition is a string like "owns->item->category" or "parent<-child".

pub struct TraverseRule;

impl RewriteRule for TraverseRule {
    fn pattern(&self) -> &str {
        "TRAVERSE(start, path_definition) -> GraphPath"
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 5000,
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
            return Err(err_arity(
                "TRAVERSE",
                "exactly 2 arguments (start, path_definition)",
            ));
        }

        let start = get_op_value(manifold, edge.input_nodes[0])?;
        let path = get_op_value(manifold, edge.input_nodes[1])?;

        // Delegate to ops-core for validation and stub behavior
        // NOTE: Real traversal implementation would:
        // 1. Parse the path_definition string (e.g., "owns->item->category")
        // 2. Query the knowledge graph through caller-owned code
        // 3. Apply cycle detection (visited set keyed on entity ID)
        // 4. Enforce resource limits (10,000 nodes, 50,000 edges)
        // 5. Return early with E_GRAPH_BUDGET_EXCEEDED if limits hit
        let result = ops_core::graph::traverse(&start, &path, &default_ctx())
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
    // Tests would use mock implementations of Manifold, SolverContext,
    // and a mock graph data structure.
    // See services/mock.rs for test doubles
}
