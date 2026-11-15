//! crates/composition-engine-core/src/kernel/fsm.rs
//!
//! FSM Primitive (P4) - PURE FUNCTIONAL
//!
//! All state transitions are pure functions that return new state.
//! No mutations. No side effects.
//!
//! Laws:
//! 1. fsm_transition(state, event) returns NEW state, never mutates input
//! 2. Entry/exit actions are pure (return new context or unchanged)
//! 3. Guards are pure predicates
//! 4. Transition is deterministic (same inputs → same output)
//!
//! Ported from: frontends/web/composition-engine/kernel/fsm.ts

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::types::{FSMConfig, FSMEvent, FSMState, FSMStateNode, FSMTransition};

// Re-export core FSM functions from composition-ast (leaf crate).
// These pure functions live in composition-ast alongside the types they operate on,
// allowing leaf consumers (hosts, other crates) to use FSM transitions without
// depending on the full composition-engine slot crate.
pub use composition_ast::kernel::fsm::{
    can_transition, execute_actions, fsm_transition, get_possible_events, init_fsm,
};

// ============================================================================
// FSM State With History
// ============================================================================

/// FSM state with history tracking for returning to previous states
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FSMStateWithHistory {
    /// Current state value
    pub value: String,
    /// State context data
    pub context: serde_json::Value,
    /// History of state values (oldest first)
    pub history: Vec<String>,
}

impl Default for FSMStateWithHistory {
    fn default() -> Self {
        Self {
            value: String::new(),
            context: serde_json::Value::Object(serde_json::Map::new()),
            history: Vec::new(),
        }
    }
}

impl From<FSMState> for FSMStateWithHistory {
    fn from(state: FSMState) -> Self {
        Self {
            value: state.value.clone(),
            context: state.context,
            history: vec![state.value],
        }
    }
}

// Core FSM functions (fsm_transition, init_fsm, can_transition, get_possible_events)
// are in composition-ast::kernel::fsm and re-exported above.

// ============================================================================
// FSM WITH HISTORY
// ============================================================================

/// Initialize FSM with history tracking
pub fn init_fsm_with_history(
    config: &FSMConfig,
    initial_context: serde_json::Value,
) -> FSMStateWithHistory {
    let base_state = init_fsm(config, initial_context);
    FSMStateWithHistory {
        value: base_state.value.clone(),
        context: base_state.context,
        history: vec![base_state.value],
    }
}

/// Transition FSM with history tracking
pub fn fsm_transition_with_history(
    current_state: &FSMStateWithHistory,
    event: &FSMEvent,
    config: &FSMConfig,
    max_history: usize,
) -> FSMStateWithHistory {
    let base_state = FSMState {
        value: current_state.value.clone(),
        context: current_state.context.clone(),
    };

    let next_state = fsm_transition(&base_state, event, config);

    if next_state.value == current_state.value {
        return FSMStateWithHistory {
            value: next_state.value,
            context: next_state.context,
            history: current_state.history.clone(),
        };
    }

    let mut new_history = current_state.history.clone();
    new_history.push(next_state.value.clone());

    if new_history.len() > max_history {
        new_history.remove(0);
    }

    FSMStateWithHistory {
        value: next_state.value,
        context: next_state.context,
        history: new_history,
    }
}

/// Go back to previous state (if history exists)
pub fn fsm_go_back(current_state: &FSMStateWithHistory, config: &FSMConfig) -> FSMStateWithHistory {
    if current_state.history.len() <= 1 {
        return current_state.clone();
    }

    let new_history = current_state.history[..current_state.history.len() - 1].to_vec();
    let previous_state = match new_history.last() {
        Some(s) => s.clone(),
        None => return current_state.clone(),
    };

    if !config.states.contains_key(&previous_state) {
        return current_state.clone();
    }

    let mut context = current_state.context.clone();
    if let Some(state_node) = config.states.get(&previous_state) {
        if let Some(ref entry_actions) = state_node.entry {
            context = execute_actions(&context, entry_actions, None);
        }
    }

    FSMStateWithHistory {
        value: previous_state,
        context,
        history: new_history,
    }
}

// ============================================================================
// SERIALIZATION
// ============================================================================

/// Serialized FSM snapshot for persistence/debugging
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FSMSnapshot {
    pub value: String,
    pub context: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<String>>,
}

/// Serialize FSM state for persistence
pub fn serialize_fsm(state: &FSMState) -> FSMSnapshot {
    FSMSnapshot {
        value: state.value.clone(),
        context: state.context.clone(),
        history: None,
    }
}

/// Serialize FSM state with history
pub fn serialize_fsm_with_history(state: &FSMStateWithHistory) -> FSMSnapshot {
    FSMSnapshot {
        value: state.value.clone(),
        context: state.context.clone(),
        history: Some(state.history.clone()),
    }
}

/// Restore FSM state from snapshot
pub fn restore_fsm(snapshot: &FSMSnapshot, config: &FSMConfig) -> Result<FSMState, String> {
    if !config.states.contains_key(&snapshot.value) {
        return Err(format!(
            "Cannot restore FSM: state \"{}\" not found",
            snapshot.value
        ));
    }

    Ok(FSMState {
        value: snapshot.value.clone(),
        context: snapshot.context.clone(),
    })
}

/// Restore FSM state with history from snapshot
pub fn restore_fsm_with_history(
    snapshot: &FSMSnapshot,
    config: &FSMConfig,
) -> Result<FSMStateWithHistory, String> {
    if !config.states.contains_key(&snapshot.value) {
        return Err(format!(
            "Cannot restore FSM: state \"{}\" not found",
            snapshot.value
        ));
    }

    Ok(FSMStateWithHistory {
        value: snapshot.value.clone(),
        context: snapshot.context.clone(),
        history: snapshot
            .history
            .clone()
            .unwrap_or_else(|| vec![snapshot.value.clone()]),
    })
}

// ============================================================================
// FSM MATCHING UTILITIES
// ============================================================================

/// Check if FSM is in a specific state
pub fn matches(state: &FSMState, state_values: &[&str]) -> bool {
    state_values.contains(&state.value.as_str())
}

/// Check if FSM with history is in a specific state
pub fn matches_with_history(state: &FSMStateWithHistory, state_values: &[&str]) -> bool {
    state_values.contains(&state.value.as_str())
}

/// Get all reachable states from a given state
pub fn get_reachable_states(from_state: &str, config: &FSMConfig) -> Vec<String> {
    let node = match config.states.get(from_state) {
        Some(n) => n,
        None => return Vec::new(),
    };

    let mut reachable = std::collections::HashSet::new();

    if let Some(ref on) = node.on {
        for transitions in on.values() {
            for t in transitions {
                reachable.insert(t.target.clone());
            }
        }
    }

    reachable.into_iter().collect()
}

/// Get all states in the FSM config
pub fn get_all_states(config: &FSMConfig) -> Vec<String> {
    config.states.keys().cloned().collect()
}

// ============================================================================
// COMMON FSM PATTERNS (Config Factories)
// ============================================================================

/// Create a toggle FSM configuration (inactive ⇄ active)
pub fn create_toggle_config() -> FSMConfig {
    let mut states = HashMap::new();

    states.insert(
        "inactive".to_string(),
        FSMStateNode {
            entry: None,
            exit: None,
            on: Some({
                let mut on = HashMap::new();
                on.insert(
                    "TOGGLE".to_string(),
                    vec![FSMTransition {
                        target: "active".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on
            }),
        },
    );

    states.insert(
        "active".to_string(),
        FSMStateNode {
            entry: None,
            exit: None,
            on: Some({
                let mut on = HashMap::new();
                on.insert(
                    "TOGGLE".to_string(),
                    vec![FSMTransition {
                        target: "inactive".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on
            }),
        },
    );

    FSMConfig {
        initial: "inactive".to_string(),
        states,
    }
}

/// Create a loading FSM configuration (idle → loading → success/error)
pub fn create_loading_config() -> FSMConfig {
    let mut states = HashMap::new();

    states.insert(
        "idle".to_string(),
        FSMStateNode {
            entry: None,
            exit: None,
            on: Some({
                let mut on = HashMap::new();
                on.insert(
                    "FETCH".to_string(),
                    vec![FSMTransition {
                        target: "loading".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on
            }),
        },
    );

    states.insert(
        "loading".to_string(),
        FSMStateNode {
            entry: None,
            exit: None,
            on: Some({
                let mut on = HashMap::new();
                on.insert(
                    "SUCCESS".to_string(),
                    vec![FSMTransition {
                        target: "success".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on.insert(
                    "ERROR".to_string(),
                    vec![FSMTransition {
                        target: "error".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on
            }),
        },
    );

    states.insert(
        "success".to_string(),
        FSMStateNode {
            entry: None,
            exit: None,
            on: Some({
                let mut on = HashMap::new();
                on.insert(
                    "FETCH".to_string(),
                    vec![FSMTransition {
                        target: "loading".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on.insert(
                    "RESET".to_string(),
                    vec![FSMTransition {
                        target: "idle".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on
            }),
        },
    );

    states.insert(
        "error".to_string(),
        FSMStateNode {
            entry: None,
            exit: None,
            on: Some({
                let mut on = HashMap::new();
                on.insert(
                    "FETCH".to_string(),
                    vec![FSMTransition {
                        target: "loading".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on.insert(
                    "RESET".to_string(),
                    vec![FSMTransition {
                        target: "idle".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on
            }),
        },
    );

    FSMConfig {
        initial: "idle".to_string(),
        states,
    }
}

/// Create an expandable/collapsible FSM configuration
pub fn create_expandable_config() -> FSMConfig {
    let mut states = HashMap::new();

    states.insert(
        "collapsed".to_string(),
        FSMStateNode {
            entry: None,
            exit: None,
            on: Some({
                let mut on = HashMap::new();
                on.insert(
                    "EXPAND".to_string(),
                    vec![FSMTransition {
                        target: "expanded".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on.insert(
                    "TOGGLE".to_string(),
                    vec![FSMTransition {
                        target: "expanded".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on
            }),
        },
    );

    states.insert(
        "expanded".to_string(),
        FSMStateNode {
            entry: None,
            exit: None,
            on: Some({
                let mut on = HashMap::new();
                on.insert(
                    "COLLAPSE".to_string(),
                    vec![FSMTransition {
                        target: "collapsed".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on.insert(
                    "TOGGLE".to_string(),
                    vec![FSMTransition {
                        target: "collapsed".to_string(),
                        guard: None,
                        actions: None,
                    }],
                );
                on
            }),
        },
    );

    FSMConfig {
        initial: "collapsed".to_string(),
        states,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_fsm() {
        let config = create_toggle_config();
        let state = init_fsm(&config, serde_json::json!({}));
        assert_eq!(state.value, "inactive");
    }

    #[test]
    fn test_fsm_transition() {
        let config = create_toggle_config();
        let state = init_fsm(&config, serde_json::json!({}));

        let event = FSMEvent::new("TOGGLE");
        let next = fsm_transition(&state, &event, &config);
        assert_eq!(next.value, "active");

        let next2 = fsm_transition(&next, &event, &config);
        assert_eq!(next2.value, "inactive");
    }

    #[test]
    fn test_fsm_no_transition_for_unknown_event() {
        let config = create_toggle_config();
        let state = init_fsm(&config, serde_json::json!({}));

        let event = FSMEvent::new("UNKNOWN");
        let next = fsm_transition(&state, &event, &config);
        assert_eq!(next.value, "inactive");
    }

    #[test]
    fn test_can_transition() {
        let config = create_toggle_config();
        let state = init_fsm(&config, serde_json::json!({}));

        assert!(can_transition(&state, &FSMEvent::new("TOGGLE"), &config));
        assert!(!can_transition(&state, &FSMEvent::new("UNKNOWN"), &config));
    }

    #[test]
    fn test_get_possible_events() {
        let config = create_loading_config();
        let state = FSMState {
            value: "loading".to_string(),
            context: serde_json::json!({}),
        };

        let events = get_possible_events(&state, &config);
        assert!(events.contains(&"SUCCESS".to_string()));
        assert!(events.contains(&"ERROR".to_string()));
    }

    #[test]
    fn test_fsm_with_history() {
        let config = create_loading_config();
        let state = init_fsm_with_history(&config, serde_json::json!({}));
        assert_eq!(state.value, "idle");
        assert_eq!(state.history, vec!["idle"]);

        let state2 = fsm_transition_with_history(&state, &FSMEvent::new("FETCH"), &config, 10);
        assert_eq!(state2.value, "loading");
        assert_eq!(state2.history, vec!["idle", "loading"]);

        let state3 = fsm_transition_with_history(&state2, &FSMEvent::new("SUCCESS"), &config, 10);
        assert_eq!(state3.value, "success");
        assert_eq!(state3.history, vec!["idle", "loading", "success"]);
    }

    #[test]
    fn test_fsm_go_back() {
        let config = create_loading_config();
        let mut state = init_fsm_with_history(&config, serde_json::json!({}));
        state = fsm_transition_with_history(&state, &FSMEvent::new("FETCH"), &config, 10);
        state = fsm_transition_with_history(&state, &FSMEvent::new("SUCCESS"), &config, 10);
        assert_eq!(state.value, "success");

        let back = fsm_go_back(&state, &config);
        assert_eq!(back.value, "loading");
        assert_eq!(back.history, vec!["idle", "loading"]);
    }

    #[test]
    fn test_fsm_go_back_no_history() {
        let config = create_toggle_config();
        let state = init_fsm_with_history(&config, serde_json::json!({}));

        let back = fsm_go_back(&state, &config);
        assert_eq!(back.value, "inactive");
    }

    #[test]
    fn test_history_trimming() {
        let config = create_toggle_config();
        let mut state = init_fsm_with_history(&config, serde_json::json!({}));

        for _ in 0..10 {
            state = fsm_transition_with_history(&state, &FSMEvent::new("TOGGLE"), &config, 3);
        }

        assert!(state.history.len() <= 3);
    }

    #[test]
    fn test_serialize_restore() {
        let config = create_toggle_config();
        let state = FSMState {
            value: "active".to_string(),
            context: serde_json::json!({"count": 5}),
        };

        let snapshot = serialize_fsm(&state);
        let restored = restore_fsm(&snapshot, &config).unwrap();

        assert_eq!(restored.value, "active");
        assert_eq!(restored.context["count"], 5);
    }

    #[test]
    fn test_serialize_restore_with_history() {
        let config = create_loading_config();
        let state = FSMStateWithHistory {
            value: "success".to_string(),
            context: serde_json::json!({}),
            history: vec![
                "idle".to_string(),
                "loading".to_string(),
                "success".to_string(),
            ],
        };

        let snapshot = serialize_fsm_with_history(&state);
        let restored = restore_fsm_with_history(&snapshot, &config).unwrap();

        assert_eq!(restored.value, "success");
        assert_eq!(restored.history.len(), 3);
    }

    #[test]
    fn test_restore_invalid_state() {
        let config = create_toggle_config();
        let snapshot = FSMSnapshot {
            value: "nonexistent".to_string(),
            context: serde_json::json!({}),
            history: None,
        };

        let result = restore_fsm(&snapshot, &config);
        assert!(result.is_err());
    }

    #[test]
    fn test_matches() {
        let state = FSMState {
            value: "loading".to_string(),
            context: serde_json::json!({}),
        };

        assert!(matches(&state, &["loading", "idle"]));
        assert!(!matches(&state, &["success", "error"]));
    }

    #[test]
    fn test_get_reachable_states() {
        let config = create_loading_config();
        let reachable = get_reachable_states("loading", &config);

        assert!(reachable.contains(&"success".to_string()));
        assert!(reachable.contains(&"error".to_string()));
    }

    #[test]
    fn test_get_all_states() {
        let config = create_loading_config();
        let all = get_all_states(&config);

        assert_eq!(all.len(), 4);
    }

    #[test]
    fn test_expandable_config() {
        let config = create_expandable_config();
        let state = init_fsm(&config, serde_json::json!({}));
        assert_eq!(state.value, "collapsed");

        let expanded = fsm_transition(&state, &FSMEvent::new("EXPAND"), &config);
        assert_eq!(expanded.value, "expanded");

        let collapsed = fsm_transition(&expanded, &FSMEvent::new("TOGGLE"), &config);
        assert_eq!(collapsed.value, "collapsed");
    }

    #[test]
    fn test_actions_execution() {
        let mut states = HashMap::new();
        states.insert(
            "idle".to_string(),
            FSMStateNode {
                entry: None,
                exit: None,
                on: Some({
                    let mut on = HashMap::new();
                    on.insert(
                        "START".to_string(),
                        vec![FSMTransition {
                            target: "running".to_string(),
                            guard: None,
                            actions: Some(vec!["count=1".to_string()]),
                        }],
                    );
                    on
                }),
            },
        );
        states.insert(
            "running".to_string(),
            FSMStateNode {
                entry: Some(vec!["status=active".to_string()]),
                exit: None,
                on: None,
            },
        );

        let config = FSMConfig {
            initial: "idle".to_string(),
            states,
        };

        let state = init_fsm(&config, serde_json::json!({}));
        let next = fsm_transition(&state, &FSMEvent::new("START"), &config);

        assert_eq!(next.value, "running");
        assert_eq!(next.context["count"], 1);
        assert_eq!(next.context["status"], "active");
    }

    #[test]
    fn test_guard_evaluation() {
        let mut states = HashMap::new();
        states.insert(
            "idle".to_string(),
            FSMStateNode {
                entry: None,
                exit: None,
                on: Some({
                    let mut on = HashMap::new();
                    on.insert(
                        "START".to_string(),
                        vec![
                            FSMTransition {
                                target: "premium".to_string(),
                                guard: Some("tier==premium".to_string()),
                                actions: None,
                            },
                            FSMTransition {
                                target: "basic".to_string(),
                                guard: None,
                                actions: None,
                            },
                        ],
                    );
                    on
                }),
            },
        );
        states.insert("premium".to_string(), FSMStateNode::default());
        states.insert("basic".to_string(), FSMStateNode::default());

        let config = FSMConfig {
            initial: "idle".to_string(),
            states,
        };

        let state_premium = FSMState {
            value: "idle".to_string(),
            context: serde_json::json!({"tier": "premium"}),
        };
        let next = fsm_transition(&state_premium, &FSMEvent::new("START"), &config);
        assert_eq!(next.value, "premium");

        let state_basic = FSMState {
            value: "idle".to_string(),
            context: serde_json::json!({"tier": "free"}),
        };
        let next = fsm_transition(&state_basic, &FSMEvent::new("START"), &config);
        assert_eq!(next.value, "basic");
    }
}
