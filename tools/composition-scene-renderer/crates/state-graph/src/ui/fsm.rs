//! FSM state tracking for the unified state graph.
//!
//! This module provides a simple FSM state registry that tracks
//! the current state of all finite state machines in the system.
//!
//! The actual FSM definitions (states, transitions, guards) are stored in EEAF.
//! This module only tracks the current state values for trigger evaluation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Type alias for FSM IDs (e.g., "fsm:editor:mode")
pub type FsmId = String;

/// Type alias for FSM state values (e.g., "view", "edit")
pub type FsmStateValue = String;

/// FSM state registry - tracks current state of all FSMs.
///
/// This is a simple HashMap wrapper that provides typed access
/// to FSM states for trigger evaluation queries like:
/// `graph.fsm["fsm:editor:mode"] == "edit"`
///
/// # Serialization
///
/// The `states` field is flattened during serialization so that
/// `graph.fsm["fsm:editor:mode"]` works directly without needing
/// `graph.fsm.states["fsm:editor:mode"]`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct FsmRegistry {
    /// FSM ID → current state value
    /// Flattened so graph.fsm["fsm:editor:mode"] works in formula queries
    #[serde(flatten)]
    states: HashMap<FsmId, FsmStateValue>,
}

impl FsmRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        Self::default()
    }

    /// Get the current state of an FSM
    pub fn get(&self, fsm_id: &str) -> Option<&FsmStateValue> {
        self.states.get(fsm_id)
    }

    /// Set the current state of an FSM
    pub fn set(&mut self, fsm_id: impl Into<FsmId>, state: impl Into<FsmStateValue>) {
        self.states.insert(fsm_id.into(), state.into());
    }

    /// Remove an FSM from tracking
    pub fn remove(&mut self, fsm_id: &str) -> Option<FsmStateValue> {
        self.states.remove(fsm_id)
    }

    /// Check if an FSM is in a specific state
    pub fn is_in_state(&self, fsm_id: &str, state: &str) -> bool {
        self.states.get(fsm_id).is_some_and(|s| s == state)
    }

    /// Check if an FSM is registered
    pub fn contains(&self, fsm_id: &str) -> bool {
        self.states.contains_key(fsm_id)
    }

    /// Get the number of tracked FSMs
    pub fn len(&self) -> usize {
        self.states.len()
    }

    /// Check if the registry is empty
    pub fn is_empty(&self) -> bool {
        self.states.is_empty()
    }

    /// Clear all FSM states
    pub fn clear(&mut self) {
        self.states.clear();
    }

    /// Iterate over all FSM states
    pub fn iter(&self) -> impl Iterator<Item = (&FsmId, &FsmStateValue)> {
        self.states.iter()
    }

    /// Get the underlying HashMap (for formula evaluation)
    pub fn as_map(&self) -> &HashMap<FsmId, FsmStateValue> {
        &self.states
    }

    /// Get mutable access to underlying HashMap
    pub fn as_map_mut(&mut self) -> &mut HashMap<FsmId, FsmStateValue> {
        &mut self.states
    }
}

impl From<HashMap<FsmId, FsmStateValue>> for FsmRegistry {
    fn from(states: HashMap<FsmId, FsmStateValue>) -> Self {
        Self { states }
    }
}

impl From<FsmRegistry> for HashMap<FsmId, FsmStateValue> {
    fn from(registry: FsmRegistry) -> Self {
        registry.states
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fsm_registry_default() {
        let registry = FsmRegistry::new();
        assert!(registry.is_empty());
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn test_fsm_get_set() {
        let mut registry = FsmRegistry::new();

        registry.set("fsm:editor:mode", "view");
        assert!(registry.contains("fsm:editor:mode"));
        assert_eq!(registry.get("fsm:editor:mode"), Some(&"view".to_string()));
        assert!(registry.is_in_state("fsm:editor:mode", "view"));
        assert!(!registry.is_in_state("fsm:editor:mode", "edit"));

        registry.set("fsm:editor:mode", "edit");
        assert!(registry.is_in_state("fsm:editor:mode", "edit"));
    }

    #[test]
    fn test_fsm_remove() {
        let mut registry = FsmRegistry::new();
        registry.set("fsm:test", "active");
        assert!(registry.contains("fsm:test"));

        let removed = registry.remove("fsm:test");
        assert_eq!(removed, Some("active".to_string()));
        assert!(!registry.contains("fsm:test"));
    }

    #[test]
    fn test_fsm_iteration() {
        let mut registry = FsmRegistry::new();
        registry.set("fsm:a", "state-a");
        registry.set("fsm:b", "state-b");

        let states: Vec<_> = registry.iter().collect();
        assert_eq!(states.len(), 2);
    }

    #[test]
    fn test_fsm_from_hashmap() {
        let mut map = HashMap::new();
        map.insert("fsm:test".to_string(), "running".to_string());

        let registry: FsmRegistry = map.into();
        assert!(registry.is_in_state("fsm:test", "running"));
    }

    /// CONFORMANCE: Verify that serialization flattens the states field.
    ///
    /// This test ensures `#[serde(flatten)]` is working correctly.
    /// Formula queries like `LOOKUP(graph.fsm, "fsm:editor:mode")` expect
    /// FSM states to be at the top level of the JSON object, NOT nested
    /// under a "states" wrapper.
    ///
    /// Without flatten: `{"states": {"fsm:editor:mode": "edit"}}` - WRONG
    /// With flatten:    `{"fsm:editor:mode": "edit"}`             - CORRECT
    ///
    /// If this test fails, trigger queries using FSM state will break.
    #[test]
    fn test_fsm_serialization_flattened() {
        let mut registry = FsmRegistry::new();
        registry.set("fsm:editor:mode", "edit");
        registry.set("fsm:palette", "closed");

        let json = serde_json::to_value(&registry).unwrap();

        // Keys should be at the top level, NOT under a "states" wrapper
        assert_eq!(json["fsm:editor:mode"], "edit");
        assert_eq!(json["fsm:palette"], "closed");

        // Should NOT have a "states" wrapper
        assert!(json.get("states").is_none());
    }

    /// CONFORMANCE: Verify roundtrip serialization preserves state with flatten.
    ///
    /// This ensures that flattened JSON can be deserialized back into
    /// an FsmRegistry with all states intact. Required for any persistence
    /// or state transfer scenarios.
    #[test]
    fn test_fsm_serialization_roundtrip() {
        let mut registry = FsmRegistry::new();
        registry.set("fsm:editor:mode", "edit");
        registry.set("fsm:palette", "open");

        let json = serde_json::to_string(&registry).unwrap();
        let deserialized: FsmRegistry = serde_json::from_str(&json).unwrap();

        assert!(deserialized.is_in_state("fsm:editor:mode", "edit"));
        assert!(deserialized.is_in_state("fsm:palette", "open"));
    }
}
