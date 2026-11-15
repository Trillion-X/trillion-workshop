//! crates/composition-engine-core/src/kernel/effects.rs
//!
//! Effect emission and deduplication for the Unified Input Pipeline (Step 45).
//!
//! This module provides:
//! - `EffectQueue` - A collection that deduplicates effects automatically
//! - `deduplicate_effects()` - Standalone deduplication function
//! - `effects_are_duplicate()` - Check if two effects are duplicates
//! - Helper constructors for creating effects
//!
//! # Deduplication Rules
//!
//! Effects are deduplicated based on their "identity":
//! - `DispatchAction` and `ExecuteAction` are duplicates if they have the
//!   same action/dispatch name AND the same target_id
//! - `DispatchFsmEvent` effects are duplicates if they target the same FSM
//!   with the same event type
//! - Cross-type deduplication: `DispatchAction` and `ExecuteAction` with
//!   matching action names are considered duplicates
//!
//! # Example
//!
//! ```rust,ignore
//! use composition_engine_core::kernel::effects::{EffectQueue, create_execute_action};
//!
//! let mut queue = EffectQueue::new();
//!
//! // Add effects - duplicates are automatically filtered
//! queue.push(create_execute_action("save", "trigger:1", Some("node:1")));
//! queue.push(create_execute_action("save", "trigger:2", Some("node:1"))); // duplicate
//! queue.push(create_execute_action("save", "trigger:1", Some("node:2"))); // different target
//!
//! assert_eq!(queue.len(), 2); // Only 2 unique effects
//! ```

use crate::kernel::types::{Effect, FSMEvent, TriggerContext, ID};
use std::collections::HashMap;

// Re-export Effect types for convenience
pub use crate::kernel::types::{Effect as KernelEffect, TriggerContext as KernelTriggerContext};

// ============================================================================
// Effect Queue (Deduplicating Collection)
// ============================================================================

/// A queue of effects with automatic deduplication.
///
/// Effects pushed to the queue are checked against existing effects.
/// Duplicates (based on action/dispatch name and target) are ignored.
#[derive(Debug, Clone, Default)]
pub struct EffectQueue {
    effects: Vec<Effect>,
}

impl EffectQueue {
    /// Create a new empty effect queue.
    pub fn new() -> Self {
        Self {
            effects: Vec::new(),
        }
    }

    /// Create an effect queue with initial capacity.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            effects: Vec::with_capacity(capacity),
        }
    }

    /// Push an effect to the queue.
    /// Returns `true` if the effect was added, `false` if it was a duplicate.
    pub fn push(&mut self, effect: Effect) -> bool {
        if !effects_are_duplicate(&self.effects, &effect) {
            self.effects.push(effect);
            true
        } else {
            false
        }
    }

    /// Extend the queue with multiple effects, deduplicating as we go.
    /// Returns the number of effects actually added.
    pub fn extend(&mut self, effects: impl IntoIterator<Item = Effect>) -> usize {
        let mut added = 0;
        for effect in effects {
            if self.push(effect) {
                added += 1;
            }
        }
        added
    }

    /// Get the number of effects in the queue.
    pub fn len(&self) -> usize {
        self.effects.len()
    }

    /// Check if the queue is empty.
    pub fn is_empty(&self) -> bool {
        self.effects.is_empty()
    }

    /// Consume the queue and return the effects as a Vec.
    pub fn into_effects(self) -> Vec<Effect> {
        self.effects
    }

    /// Get a reference to the effects.
    pub fn effects(&self) -> &[Effect] {
        &self.effects
    }

    /// Clear all effects from the queue.
    pub fn clear(&mut self) {
        self.effects.clear();
    }

    /// Iterate over the effects.
    pub fn iter(&self) -> impl Iterator<Item = &Effect> {
        self.effects.iter()
    }
}

impl FromIterator<Effect> for EffectQueue {
    fn from_iter<T: IntoIterator<Item = Effect>>(iter: T) -> Self {
        let mut queue = EffectQueue::new();
        queue.extend(iter);
        queue
    }
}

impl IntoIterator for EffectQueue {
    type Item = Effect;
    type IntoIter = std::vec::IntoIter<Effect>;

    fn into_iter(self) -> Self::IntoIter {
        self.effects.into_iter()
    }
}

impl<'a> IntoIterator for &'a EffectQueue {
    type Item = &'a Effect;
    type IntoIter = std::slice::Iter<'a, Effect>;

    fn into_iter(self) -> Self::IntoIter {
        self.effects.iter()
    }
}

// ============================================================================
// Deduplication Functions
// ============================================================================

/// Check if a new effect is a duplicate of any existing effect.
///
/// Two effects are considered duplicates if they have the same type
/// and key identifiers:
/// - `DispatchAction` / `ExecuteAction`: same dispatch/action name AND target_id
/// - `DispatchFsmEvent`: same FSM target AND event type
///
/// Cross-type duplicates are also detected (e.g., a `DispatchAction` with
/// dispatch "save" is a duplicate of an `ExecuteAction` with action "save"
/// if they have the same target).
pub fn effects_are_duplicate(existing: &[Effect], new_effect: &Effect) -> bool {
    for existing_effect in existing {
        if are_effects_equal(existing_effect, new_effect) {
            return true;
        }
    }
    false
}

/// Check if two individual effects are duplicates of each other.
pub fn are_effects_equal(a: &Effect, b: &Effect) -> bool {
    match (a, b) {
        // Same type: DispatchAction == DispatchAction
        (
            Effect::DispatchAction {
                dispatch: d1,
                target_id: t1,
                ..
            },
            Effect::DispatchAction {
                dispatch: d2,
                target_id: t2,
                ..
            },
        ) => d1 == d2 && t1 == t2,

        // Same type: ExecuteAction == ExecuteAction
        (
            Effect::ExecuteAction {
                action: a1,
                target_id: t1,
                ..
            },
            Effect::ExecuteAction {
                action: a2,
                target_id: t2,
                ..
            },
        ) => a1 == a2 && t1 == t2,

        // Cross-type: DispatchAction == ExecuteAction (by action name)
        // Note: DispatchAction.target_id is ID, ExecuteAction.target_id is Option<ID>
        // We compare by wrapping the ID in Some() for comparison
        (
            Effect::DispatchAction {
                dispatch,
                target_id: t1,
                ..
            },
            Effect::ExecuteAction {
                action,
                target_id: t2,
                ..
            },
        ) => dispatch == action && Some(t1) == t2.as_ref(),

        (
            Effect::ExecuteAction {
                action,
                target_id: t1,
                ..
            },
            Effect::DispatchAction {
                dispatch,
                target_id: t2,
                ..
            },
        ) => action == dispatch && t1.as_ref() == Some(t2),

        // Same type: DispatchFsmEvent == DispatchFsmEvent
        (
            Effect::DispatchFsmEvent {
                target_id: t1,
                event: e1,
            },
            Effect::DispatchFsmEvent {
                target_id: t2,
                event: e2,
            },
        ) => t1 == t2 && e1.event_type == e2.event_type,

        // Different types are not duplicates
        _ => false,
    }
}

/// Deduplicate a list of effects in-place.
///
/// Removes duplicate effects from the vector, keeping the first occurrence.
pub fn deduplicate_effects(effects: &mut Vec<Effect>) {
    let mut unique = EffectQueue::with_capacity(effects.len());
    for effect in effects.drain(..) {
        unique.push(effect);
    }
    *effects = unique.into_effects();
}

/// Merge two lists of effects, deduplicating across both.
///
/// Effects from `primary` are kept first, then unique effects from `secondary`.
pub fn merge_effects(primary: Vec<Effect>, secondary: Vec<Effect>) -> Vec<Effect> {
    let mut queue = EffectQueue::from_iter(primary);
    queue.extend(secondary);
    queue.into_effects()
}

// ============================================================================
// Effect Constructors
// ============================================================================

/// Create a DispatchAction effect.
///
/// # Arguments
/// * `dispatch` - The action dispatch key (e.g., "save", "editor:toggle_mode")
/// * `target_id` - The target node ID
/// * `params` - Optional action parameters
pub fn create_dispatch_action(
    dispatch: impl Into<String>,
    target_id: impl Into<ID>,
    params: Option<HashMap<String, serde_json::Value>>,
) -> Effect {
    Effect::DispatchAction {
        dispatch: dispatch.into(),
        target_id: target_id.into(),
        params,
    }
}

/// Create an ExecuteAction effect (from trigger matching).
///
/// # Arguments
/// * `action` - The action type from recipe
/// * `trigger_id` - The ID of the trigger that matched
/// * `target_id` - Optional target node that received the input
/// * `params` - Optional action parameters
/// * `context` - Optional trigger context from the matched input event
pub fn create_execute_action(
    action: impl Into<String>,
    trigger_id: impl Into<ID>,
    target_id: Option<ID>,
    params: Option<HashMap<String, serde_json::Value>>,
    context: Option<TriggerContext>,
) -> Effect {
    Effect::ExecuteAction {
        action: action.into(),
        trigger_id: trigger_id.into(),
        target_id,
        params,
        context,
    }
}

/// Create a DispatchFsmEvent effect.
///
/// # Arguments
/// * `fsm_id` - The target FSM ID (e.g., "fsm:editor:main")
/// * `event_type` - The FSM event type (e.g., "open", "close")
pub fn create_fsm_event(fsm_id: impl Into<ID>, event_type: impl Into<String>) -> Effect {
    Effect::DispatchFsmEvent {
        target_id: fsm_id.into(),
        event: FSMEvent::new(event_type.into()),
    }
}

/// Create a DispatchFsmEvent effect with payload.
///
/// # Arguments
/// * `fsm_id` - The target FSM ID
/// * `event_type` - The FSM event type
/// * `payload` - Event payload (will be merged into the FSMEvent)
pub fn create_fsm_event_with_payload(
    fsm_id: impl Into<ID>,
    event_type: impl Into<String>,
    payload: HashMap<String, serde_json::Value>,
) -> Effect {
    let mut event = FSMEvent::new(event_type);
    for (key, value) in payload {
        event = event.with_payload(&key, value);
    }
    Effect::DispatchFsmEvent {
        target_id: fsm_id.into(),
        event,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Effect Creation Tests
    // ========================================================================

    #[test]
    fn test_create_dispatch_action() {
        let effect = create_dispatch_action("save", "node:1", None);
        match effect {
            Effect::DispatchAction {
                dispatch,
                target_id,
                params,
            } => {
                assert_eq!(dispatch, "save");
                assert_eq!(target_id, "node:1");
                assert!(params.is_none());
            }
            _ => panic!("Expected DispatchAction"),
        }
    }

    #[test]
    fn test_create_dispatch_action_with_params() {
        let mut params = HashMap::new();
        params.insert("filename".to_string(), serde_json::json!("test.txt"));

        let effect = create_dispatch_action("save", "node:1", Some(params));
        match effect {
            Effect::DispatchAction {
                params: Some(p), ..
            } => {
                assert_eq!(p.get("filename").unwrap(), &serde_json::json!("test.txt"));
            }
            _ => panic!("Expected DispatchAction with params"),
        }
    }

    #[test]
    fn test_create_execute_action() {
        let effect = create_execute_action(
            "editor:save",
            "trigger:1",
            Some("node:1".to_string()),
            None,
            None,
        );
        match effect {
            Effect::ExecuteAction {
                action,
                trigger_id,
                target_id,
                params,
                context,
            } => {
                assert_eq!(action, "editor:save");
                assert_eq!(trigger_id, "trigger:1");
                assert_eq!(target_id, Some("node:1".to_string()));
                assert!(params.is_none());
                assert!(context.is_none());
            }
            _ => panic!("Expected ExecuteAction"),
        }
    }

    #[test]
    fn test_create_fsm_event() {
        let effect = create_fsm_event("fsm:editor:main", "open");
        match effect {
            Effect::DispatchFsmEvent { target_id, event } => {
                assert_eq!(target_id, "fsm:editor:main");
                assert_eq!(event.event_type, "open");
            }
            _ => panic!("Expected DispatchFsmEvent"),
        }
    }

    #[test]
    fn test_create_fsm_event_with_payload() {
        let mut payload = HashMap::new();
        payload.insert("menu_id".to_string(), serde_json::json!("insert-menu"));

        let effect = create_fsm_event_with_payload("fsm:editor:main", "open", payload);
        match effect {
            Effect::DispatchFsmEvent { event, .. } => {
                assert_eq!(event.event_type, "open");
                // Payload should be in the event
                assert!(event.payload.contains_key("menu_id"));
            }
            _ => panic!("Expected DispatchFsmEvent with payload"),
        }
    }

    // ========================================================================
    // Deduplication Tests
    // ========================================================================

    #[test]
    fn test_dispatch_action_duplicates() {
        let a = create_dispatch_action("save", "node:1", None);
        let b = create_dispatch_action("save", "node:1", None);
        assert!(are_effects_equal(&a, &b));
    }

    #[test]
    fn test_dispatch_action_different_targets_not_duplicates() {
        let a = create_dispatch_action("save", "node:1", None);
        let b = create_dispatch_action("save", "node:2", None);
        assert!(!are_effects_equal(&a, &b));
    }

    #[test]
    fn test_dispatch_action_different_actions_not_duplicates() {
        let a = create_dispatch_action("save", "node:1", None);
        let b = create_dispatch_action("load", "node:1", None);
        assert!(!are_effects_equal(&a, &b));
    }

    #[test]
    fn test_execute_action_duplicates() {
        let a = create_execute_action("save", "t:1", Some("node:1".to_string()), None, None);
        let b = create_execute_action("save", "t:2", Some("node:1".to_string()), None, None);
        // Same action and target, different trigger - should be duplicates
        assert!(are_effects_equal(&a, &b));
    }

    #[test]
    fn test_execute_action_different_targets_not_duplicates() {
        let a = create_execute_action("save", "t:1", Some("node:1".to_string()), None, None);
        let b = create_execute_action("save", "t:1", Some("node:2".to_string()), None, None);
        assert!(!are_effects_equal(&a, &b));
    }

    #[test]
    fn test_cross_type_duplicates_dispatch_vs_execute() {
        let dispatch = create_dispatch_action("save", "node:1", None);
        let execute = create_execute_action("save", "t:1", Some("node:1".to_string()), None, None);

        // Cross-type comparison: DispatchAction.target_id (ID) vs ExecuteAction.target_id (Option<ID>)
        // Should be considered duplicates when action names match AND targets match
        let result = are_effects_equal(&dispatch, &execute);
        assert!(result, "Same action with same target should be duplicates");
    }

    #[test]
    fn test_cross_type_not_duplicates_when_execute_has_none_target() {
        let dispatch = create_dispatch_action("save", "node:1", None);
        let execute = create_execute_action("save", "t:1", None, None, None);

        // ExecuteAction has no target, DispatchAction has target - not duplicates
        let result = are_effects_equal(&dispatch, &execute);
        assert!(
            !result,
            "ExecuteAction with None target should not match DispatchAction"
        );
    }

    #[test]
    fn test_cross_type_not_duplicates_different_actions() {
        let dispatch = create_dispatch_action("save", "node:1", None);
        let execute = create_execute_action("load", "t:1", Some("node:1".to_string()), None, None);

        // Different action names - not duplicates
        let result = are_effects_equal(&dispatch, &execute);
        assert!(!result, "Different actions should not be duplicates");
    }

    #[test]
    fn test_fsm_event_duplicates() {
        let a = create_fsm_event("fsm:1", "open");
        let b = create_fsm_event("fsm:1", "open");
        assert!(are_effects_equal(&a, &b));
    }

    #[test]
    fn test_fsm_event_different_fsms_not_duplicates() {
        let a = create_fsm_event("fsm:1", "open");
        let b = create_fsm_event("fsm:2", "open");
        assert!(!are_effects_equal(&a, &b));
    }

    #[test]
    fn test_fsm_event_different_events_not_duplicates() {
        let a = create_fsm_event("fsm:1", "open");
        let b = create_fsm_event("fsm:1", "close");
        assert!(!are_effects_equal(&a, &b));
    }

    #[test]
    fn test_different_effect_types_not_duplicates() {
        let dispatch = create_dispatch_action("save", "node:1", None);
        let fsm = create_fsm_event("fsm:1", "open");
        assert!(!are_effects_equal(&dispatch, &fsm));
    }

    // ========================================================================
    // EffectQueue Tests
    // ========================================================================

    #[test]
    fn test_effect_queue_push_unique() {
        let mut queue = EffectQueue::new();

        assert!(queue.push(create_dispatch_action("save", "n:1", None)));
        assert!(queue.push(create_dispatch_action("load", "n:1", None)));

        assert_eq!(queue.len(), 2);
    }

    #[test]
    fn test_effect_queue_push_duplicate() {
        let mut queue = EffectQueue::new();

        assert!(queue.push(create_dispatch_action("save", "n:1", None)));
        assert!(!queue.push(create_dispatch_action("save", "n:1", None))); // duplicate

        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn test_effect_queue_extend() {
        let mut queue = EffectQueue::new();

        let effects = vec![
            create_dispatch_action("save", "n:1", None),
            create_dispatch_action("save", "n:1", None), // duplicate
            create_dispatch_action("load", "n:1", None),
            create_fsm_event("fsm:1", "open"),
        ];

        let added = queue.extend(effects);
        assert_eq!(added, 3); // 3 unique effects
        assert_eq!(queue.len(), 3);
    }

    #[test]
    fn test_effect_queue_from_iterator() {
        let effects = vec![
            create_dispatch_action("save", "n:1", None),
            create_dispatch_action("save", "n:1", None),
            create_dispatch_action("load", "n:1", None),
        ];

        let queue: EffectQueue = effects.into_iter().collect();
        assert_eq!(queue.len(), 2);
    }

    #[test]
    fn test_effect_queue_into_effects() {
        let mut queue = EffectQueue::new();
        queue.push(create_dispatch_action("save", "n:1", None));
        queue.push(create_fsm_event("fsm:1", "open"));

        let effects = queue.into_effects();
        assert_eq!(effects.len(), 2);
    }

    #[test]
    fn test_effect_queue_clear() {
        let mut queue = EffectQueue::new();
        queue.push(create_dispatch_action("save", "n:1", None));
        queue.push(create_fsm_event("fsm:1", "open"));

        queue.clear();
        assert!(queue.is_empty());
    }

    // ========================================================================
    // Merge and Deduplicate Functions Tests
    // ========================================================================

    #[test]
    fn test_deduplicate_effects_in_place() {
        let mut effects = vec![
            create_dispatch_action("save", "n:1", None),
            create_dispatch_action("save", "n:1", None),
            create_dispatch_action("load", "n:1", None),
            create_dispatch_action("save", "n:1", None),
        ];

        deduplicate_effects(&mut effects);
        assert_eq!(effects.len(), 2);
    }

    #[test]
    fn test_merge_effects() {
        let primary = vec![
            create_dispatch_action("save", "n:1", None),
            create_dispatch_action("load", "n:1", None),
        ];
        let secondary = vec![
            create_dispatch_action("save", "n:1", None), // duplicate
            create_fsm_event("fsm:1", "open"),
        ];

        let merged = merge_effects(primary, secondary);
        assert_eq!(merged.len(), 3); // save, load, fsm:open
    }

    #[test]
    fn test_merge_effects_preserves_order() {
        let primary = vec![
            create_dispatch_action("a", "n:1", None),
            create_dispatch_action("b", "n:1", None),
        ];
        let secondary = vec![create_dispatch_action("c", "n:1", None)];

        let merged = merge_effects(primary, secondary);

        // Check order is preserved
        match (&merged[0], &merged[1], &merged[2]) {
            (
                Effect::DispatchAction { dispatch: d1, .. },
                Effect::DispatchAction { dispatch: d2, .. },
                Effect::DispatchAction { dispatch: d3, .. },
            ) => {
                assert_eq!(d1, "a");
                assert_eq!(d2, "b");
                assert_eq!(d3, "c");
            }
            _ => panic!("Expected all DispatchAction"),
        }
    }

    // ========================================================================
    // Edge Case Tests
    // ========================================================================

    #[test]
    fn test_empty_queue() {
        let queue = EffectQueue::new();
        assert!(queue.is_empty());
        assert_eq!(queue.len(), 0);
    }

    #[test]
    fn test_effects_are_duplicate_empty_list() {
        let existing: Vec<Effect> = vec![];
        let effect = create_dispatch_action("save", "n:1", None);
        assert!(!effects_are_duplicate(&existing, &effect));
    }

    #[test]
    fn test_effect_queue_iteration() {
        let mut queue = EffectQueue::new();
        queue.push(create_dispatch_action("a", "n:1", None));
        queue.push(create_dispatch_action("b", "n:1", None));

        let dispatches: Vec<String> = queue
            .iter()
            .filter_map(|e| {
                if let Effect::DispatchAction { dispatch, .. } = e {
                    Some(dispatch.clone())
                } else {
                    None
                }
            })
            .collect();

        assert_eq!(dispatches, vec!["a", "b"]);
    }
}
