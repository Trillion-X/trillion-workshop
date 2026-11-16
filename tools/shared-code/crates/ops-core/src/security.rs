//! Security operators for ops-core
//!
//! This module provides stubs for security-related operators that require
//! Kernel context for actual implementation. These operators interface with
//! the platform's permission system.
//!
//! # Operators
//!
//! - `can(action, target)` - Check permission
//! - `current_user()` - Get current user
//! - `has_role(role)` - Check role membership
//! - `get_entity(id)` - Get entity by ID
//! - `emit_event(event_type, payload)` - Emit event to Event Bus
//!
//! # Note
//!
//! These are **stub implementations**. The actual security checks must be
//! performed by the Kernel through the SolverContext. These functions only
//! validate input types and return placeholder values.
//!
//! In production, the formula-engine's RewriteRule implementations delegate
//! to the Kernel's permission system via `ctx.evaluation_context.has_permission()`.

use crate::{EvalContext, OpError, OpValue};

const ENTITY_REF_KEY: &str = "$ent_ref";

/// Check if the current user has permission to perform an action on a target.
///
/// This is a STUB. Actual permission checks require Kernel context.
///
/// # Arguments
/// - `action` - The action to check (e.g., "read", "write", "delete")
/// - `target` - The target node (node reference or string ID)
///
/// # Returns
/// - `Ok(bool)` - Whether the action is permitted
///
/// # Note
/// In the real implementation, this delegates to `ctx.evaluation_context.has_permission(action)`
pub fn can(action: &OpValue, target: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    // Validate action is a string
    let _action_str = action.as_str("can")?;

    // Validate target is either a node reference object or string ID
    if !target.is_string() && !target.is_object() {
        return Err(OpError::TypeMismatch {
            operation: "can".to_string(),
            expected: "node reference or string".to_string(),
            actual: target.type_name().to_string(),
        });
    }

    // STUB: In production, this would check:
    // ctx.evaluation_context.has_permission(action_str)
    //
    // For now, return false (deny by default)
    Ok(OpValue::bool(false))
}

/// Get the current user as a node reference.
///
/// This is a STUB. Actual user retrieval requires Kernel context.
///
/// # Returns
/// - `Ok(node reference)` - The current user's node reference
///
/// # Note
/// In the real implementation, this returns:
/// `make_node_ref(ctx.evaluation_context.get_actor_id())`
pub fn current_user(_ctx: &EvalContext) -> Result<OpValue, OpError> {
    // STUB: Return a placeholder node reference
    // In production, this would return the actual actor_id from the context
    let mut obj = serde_json::Map::new();
    obj.insert(
        ENTITY_REF_KEY.to_string(),
        serde_json::Value::String("stub:current_user".to_string()),
    );
    Ok(OpValue::object(obj))
}

/// Check if the current user has a specific role.
///
/// This is a STUB. Actual role checks require Kernel context.
///
/// # Arguments
/// - `role` - The role to check (e.g., "admin", "editor", "viewer")
///
/// # Returns
/// - `Ok(bool)` - Whether the user has the role
///
/// # Note
/// In the real implementation, this checks:
/// `ctx.evaluation_context.has_permission(&format!("role:{}", role_str))`
pub fn has_role(role: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    // Validate role is a string
    let _role_str = role.as_str("has_role")?;

    // STUB: In production, this would check the role
    // For now, return false (deny by default)
    Ok(OpValue::bool(false))
}

/// Get a node by ID.
///
/// This is a STUB. Actual node retrieval requires Kernel context and
/// Trusted Host-Bridge Mode capability.
///
/// # Arguments
/// - `id` - The node ID
///
/// # Returns
/// - `Ok(node reference)` - The node reference
///
/// # Note
/// In the real implementation:
/// 1. Checks for "formula:get_node" capability
/// 2. Validates the node exists
/// 3. Returns the node reference
pub fn get_entity(id: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    // Validate id is a string
    let id_str = id.as_str("get_entity")?;

    // STUB: Return a placeholder node reference
    // In production, this would:
    // 1. Check capabilities
    // 2. Fetch from Kernel
    // 3. Return actual node reference
    let mut obj = serde_json::Map::new();
    obj.insert(
        ENTITY_REF_KEY.to_string(),
        serde_json::Value::String(id_str.to_string()),
    );
    Ok(OpValue::object(obj))
}

/// Emit a custom event to the Event Bus.
///
/// This is a STUB. Actual event emission requires Kernel context.
///
/// # Arguments
/// - `event_type` - The type of event to emit (e.g., "user_action", "metric")
/// - `payload` - The event payload (any JSON-serializable value)
///
/// # Returns
/// - `Ok(null)` - Always returns null (fire-and-forget semantics)
///
/// # Rate Limiting
/// In the real implementation, this is capped at 3 calls per evaluation
/// to prevent event spam.
///
/// # Note
/// In the real implementation, this:
/// 1. Validates the event_type is a string
/// 2. Checks the per-evaluation call count (max 3)
/// 3. Emits via ctx.evaluation_context.emit_event(event_type, payload)
/// 4. Returns null
pub fn emit_event(
    event_type: &OpValue,
    payload: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    // Validate event_type is a string
    let _event_type_str = event_type.as_str("emit_event")?;

    // Validate payload is provided (can be any type)
    // In production, payload would be serialized and sent to Event Bus
    let _ = payload;

    // STUB: In production, this would:
    // 1. Check call count (max 3 per evaluation)
    // 2. Emit to Event Bus via ctx.evaluation_context.emit_event()
    // 3. Increment call counter
    //
    // For now, just validate and return null (fire-and-forget)
    Ok(OpValue::null())
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> EvalContext {
        EvalContext::default()
    }

    #[test]
    fn test_can_validates_action_type() {
        let action = OpValue::number(123.0);
        let target = OpValue::string("entity:123");
        let result = can(&action, &target, &ctx());
        assert!(result.is_err());
    }

    #[test]
    fn test_can_validates_target_type() {
        let action = OpValue::string("read");
        let target = OpValue::number(123.0);
        let result = can(&action, &target, &ctx());
        assert!(result.is_err());
    }

    #[test]
    fn test_can_stub_returns_false() {
        let action = OpValue::string("read");
        let target = OpValue::string("entity:123");
        let result = can(&action, &target, &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(false));
    }

    #[test]
    fn test_current_user_returns_entity_ref() {
        let result = current_user(&ctx()).unwrap();
        assert!(result.is_object());
    }

    #[test]
    fn test_has_role_validates_role_type() {
        let role = OpValue::number(123.0);
        let result = has_role(&role, &ctx());
        assert!(result.is_err());
    }

    #[test]
    fn test_has_role_stub_returns_false() {
        let role = OpValue::string("admin");
        let result = has_role(&role, &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(false));
    }

    #[test]
    fn test_get_entity_returns_entity_ref() {
        let id = OpValue::string("entity:123");
        let result = get_entity(&id, &ctx()).unwrap();
        assert!(result.is_object());
    }

    #[test]
    fn test_emit_event_validates_event_type() {
        let event_type = OpValue::number(123.0);
        let payload = OpValue::string("test payload");
        let result = emit_event(&event_type, &payload, &ctx());
        assert!(result.is_err());
    }

    #[test]
    fn test_emit_event_returns_null() {
        let event_type = OpValue::string("user_action");
        let payload = OpValue::string("clicked button");
        let result = emit_event(&event_type, &payload, &ctx()).unwrap();
        assert!(result.is_null());
    }

    #[test]
    fn test_emit_event_accepts_any_payload() {
        let event_type = OpValue::string("metric");

        // Object payload
        let mut obj = serde_json::Map::new();
        obj.insert("count".to_string(), serde_json::Value::Number(42.into()));
        let payload = OpValue::object(obj);
        let result = emit_event(&event_type, &payload, &ctx()).unwrap();
        assert!(result.is_null());

        // Array payload
        let payload = OpValue::array(vec![
            serde_json::Value::Number(1.into()),
            serde_json::Value::Number(2.into()),
        ]);
        let result = emit_event(&event_type, &payload, &ctx()).unwrap();
        assert!(result.is_null());

        // Null payload
        let result = emit_event(&event_type, &OpValue::null(), &ctx()).unwrap();
        assert!(result.is_null());
    }
}
