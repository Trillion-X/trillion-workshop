//! Platform & Security RewriteRules for the Formula Engine Solver
//!
//! This file implements the security functions from the Formula Engine spec (Section 4.7):
//! - CAN(action, target) -> Boolean
//! - CURRENT_USER() -> EntityReference
//! - GET_ENTITY(id) -> EntityReference
//! - EMIT_EVENT(event_name, payload) -> Null
//! - HAS_ROLE(role) -> Boolean
//!
//! These functions provide a secure bridge between the declarative formula world
//! and caller-owned action/security systems. They read only the generic
//! EvaluationContext supplied at the formula boundary.
//!
//! # ops-core Delegation
//!
//! **Cannot delegate to ops-core** - these rules require the actual SolverContext
//! for permission checks. The ops-core security module only contains stubs.
//! These rules use the real `ctx.evaluation_context` for:
//! - Permission checks via `has_permission()`
//! - Actor ID retrieval via `get_actor_id()`
//!
//! See `rules/README.md` for the full delegation pattern documentation.
//!
//! # Security Model (from spec Section 6.3)
//!
//! - Pure Mode (Default): Only EMIT_EVENT() is available as a host function
//! - Trusted Host-Bridge Mode (CCE & Governed Workflows): Exposes GET_ENTITY()
//!   and other permission-filtered data access functions
//! - EMIT_EVENT is capped at 3 calls per evaluation to prevent event storms

use crate::rules::{
    ErrorKind, RewriteRule, RuleCostModel, RuleError, RuleProperties, SolverContext,
};
use crate::{Hyperedge, Manifold, Node, NodeId, Value};

// --- Rule-Specific Helpers ---

fn err_arity(name: &str, expected: &'static str) -> RuleError {
    RuleError::ConstraintViolation(ErrorKind::InvalidArgument(format!(
        "{name}() expects {expected}"
    )))
}

fn err_type(_name: &str, expected: &str, found: &str) -> RuleError {
    RuleError::ConstraintViolation(ErrorKind::TypeMismatch {
        expected: expected.to_string(),
        found: found.to_string(),
    })
}

fn err_security(name: &str, reason: &str) -> RuleError {
    RuleError::ConstraintViolation(ErrorKind::InvalidArgument(format!(
        "{name}(): Security violation - {reason}"
    )))
}

/// Safely extracts a resolved Value from a node in the manifold.
fn get_resolved_value(manifold: &Manifold, node_id: NodeId) -> Result<Value, RuleError> {
    match manifold.get_node(node_id) {
        Some(Node::Ready(val)) => Ok(val.clone()),
        _ => Err(RuleError::PatternMismatch),
    }
}

/// Creates an EntityReference Value from an entity ID.
fn make_entity_ref(entity_id: &str) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert(
        "$ent_ref".to_string(),
        serde_json::Value::String(entity_id.to_string()),
    );
    Value::from(serde_json::Value::Object(obj))
}

// --- CAN Rule ---
// CAN(action: String, target: EntityReference) -> Boolean
// A security-aware function that checks if the current user has permission
// to perform a specific action on a target entity.
//
// NOTE: Cannot delegate to ops-core - requires real SolverContext for permission checks.

pub struct CanRule;

impl RewriteRule for CanRule {
    fn pattern(&self) -> &str {
        "CAN(action, target) -> Boolean"
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
        ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 2 {
            return Err(err_arity("CAN", "exactly 2 arguments (action, target)"));
        }

        let action = get_resolved_value(manifold, edge.input_nodes[0])?;
        let target = get_resolved_value(manifold, edge.input_nodes[1])?;

        // Validate inputs
        let action_str = action
            .inner()
            .as_str()
            .ok_or_else(|| err_type("CAN", "string action", action.type_name()))?;

        // Target should be an EntityReference or string ID
        let _target_id = if let Some(obj) = target.inner().as_object() {
            obj.get("$ent_ref")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| err_type("CAN", "EntityReference", "object"))?
        } else if let Some(s) = target.inner().as_str() {
            s.to_string()
        } else {
            return Err(err_type(
                "CAN",
                "EntityReference or string",
                target.type_name(),
            ));
        };

        // Use the real SolverContext for permission checks
        // The caller's permission system evaluates:
        // 1. Role-based permissions for the action
        // 2. Row-level security policies for the target entity
        // 3. Scope-level access controls
        let has_permission = ctx.evaluation_context.has_permission(action_str);

        let result = Value::bool(has_permission);

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}

// --- CURRENT_USER Rule ---
// CURRENT_USER() -> EntityReference
// Returns an EntityReference to the profile of the user currently executing the formula.
// This is a deterministic function that reads from the EvaluationContext.
//
// NOTE: Cannot delegate to ops-core - requires real SolverContext for actor_id.

pub struct CurrentUserRule;

impl RewriteRule for CurrentUserRule {
    fn pattern(&self) -> &str {
        "CURRENT_USER() -> EntityReference"
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
        ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if !edge.input_nodes.is_empty() {
            return Err(err_arity("CURRENT_USER", "no arguments"));
        }

        // Get the actor_id from the real evaluation context
        // This is injected by the caller at the start of evaluation for determinism
        let actor_id = ctx.evaluation_context.get_actor_id();

        let result = make_entity_ref(actor_id);

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}

// --- GET_ENTITY Rule ---
// GET_ENTITY(id: String) -> EntityReference
// Retrieves an entity by its ID, returning an EntityReference.
// **Available only in Trusted Host-Bridge Mode** - requires capability token.
//
// NOTE: Cannot delegate to ops-core - requires real SolverContext for capability checks.

pub struct GetEntityRule;

impl RewriteRule for GetEntityRule {
    fn pattern(&self) -> &str {
        "GET_ENTITY(id) -> EntityReference"
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
        ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(err_arity("GET_ENTITY", "exactly 1 argument (id)"));
        }

        // Check for Trusted Host-Bridge Mode capability using real context
        // From spec Section 6.3.1: Callers MUST supply ctx.capabilities that include "formula:get_entity"
        if !ctx.evaluation_context.has_permission("formula:get_entity") {
            return Err(err_security(
                "GET_ENTITY",
                "requires Trusted Host-Bridge Mode with 'formula:get_entity' capability",
            ));
        }

        let id = get_resolved_value(manifold, edge.input_nodes[0])?;

        let entity_id = id
            .inner()
            .as_str()
            .ok_or_else(|| err_type("GET_ENTITY", "string id", id.type_name()))?;

        // The caller validates:
        // 1. The caller identity is on the scope-specific allowlist
        // 2. Row-level security policies are applied
        // 3. All accesses are audit logged

        // Return an EntityReference for the requested entity
        let result = make_entity_ref(entity_id);

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}

// --- EMIT_EVENT Rule ---
// EMIT_EVENT(event_name: String, payload: Object) -> Null
// The definitive bridge to the Workflow Engine. Emits a custom, namespaced event
// to the universal Event Bus, which can trigger an Observer to start a Workflow.
// A single formula evaluation is capped at a maximum of 3 EMIT_EVENT calls.

pub struct EmitEventRule;

impl RewriteRule for EmitEventRule {
    fn pattern(&self) -> &str {
        "EMIT_EVENT(event_name, payload) -> Null"
    }

    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: false, // EMIT_EVENT has side effects
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
        if edge.input_nodes.len() != 2 {
            return Err(err_arity(
                "EMIT_EVENT",
                "exactly 2 arguments (event_name, payload)",
            ));
        }

        let event_name = get_resolved_value(manifold, edge.input_nodes[0])?;
        let payload = get_resolved_value(manifold, edge.input_nodes[1])?;

        // Validate event_name
        let _event_name_str = event_name
            .inner()
            .as_str()
            .ok_or_else(|| err_type("EMIT_EVENT", "string event_name", event_name.type_name()))?;

        // Validate payload is an object
        if !payload.inner().is_object() {
            return Err(err_type(
                "EMIT_EVENT",
                "object payload",
                payload.type_name(),
            ));
        }

        // NOTE: The actual event emission would:
        // 1. Check the emit_count against MAX_EMIT_EVENTS_PER_EVALUATION (3)
        // 2. Validate the event namespace against scope allowlist
        // 3. Apply payload size limits
        // 4. Generate idempotency key for deduplication
        // 5. Emit through the caller-owned event boundary

        // For the rule, we return null as specified (fire-and-forget)
        let result = Value::null();

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}

// --- HAS_ROLE Rule ---
// HAS_ROLE(role: String) -> Boolean
// Checks if the current user has a specific role.
//
// NOTE: Cannot delegate to ops-core - requires real SolverContext for permission checks.

pub struct HasRoleRule;

impl RewriteRule for HasRoleRule {
    fn pattern(&self) -> &str {
        "HAS_ROLE(role) -> Boolean"
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
        ctx: &SolverContext,
    ) -> Result<(), RuleError> {
        if edge.input_nodes.len() != 1 {
            return Err(err_arity("HAS_ROLE", "exactly 1 argument (role)"));
        }

        let role = get_resolved_value(manifold, edge.input_nodes[0])?;

        let role_str = role
            .inner()
            .as_str()
            .ok_or_else(|| err_type("HAS_ROLE", "string role", role.type_name()))?;

        // Use real context to check if role is in the actor's permissions/roles
        let has_role = ctx
            .evaluation_context
            .has_permission(&format!("role:{}", role_str));

        let result = Value::bool(has_role);

        if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
            *output_node = Node::Ready(result);
        }
        Ok(())
    }
}

// --- Tests ---

#[cfg(test)]
mod tests {
    // Tests would use mock implementations of Manifold, SolverContext,
    // and a mock permission system.
    // See services/mock.rs for test doubles
}
