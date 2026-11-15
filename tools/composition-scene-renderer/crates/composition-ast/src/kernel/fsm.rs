// crates/composition-ast/src/kernel/fsm.rs
//
// Purpose:
//   Pure FSM transition functions — ZERO I/O, ZERO state, ZERO side effects.
//   Lives in the leaf computation crate alongside the FSM types (FSMState,
//   FSMEvent, FSMConfig) it operates on.
//
// Non-Negotiable Invariants:
//   1. fsm_transition(state, event, config) returns NEW state, never mutates input
//   2. Entry/exit actions are pure (return new context or unchanged)
//   3. Guards are pure predicates
//   4. Transition is deterministic (same inputs → same output)
//   5. ZERO imports beyond serde_json and types from this crate

use super::types::{FSMConfig, FSMEvent, FSMState, FSMTransition};

// ============================================================================
// Core FSM Functions
// ============================================================================

/// Execute a state machine transition — PURE FUNCTION.
/// Returns NEW state object, never mutates input.
pub fn fsm_transition(current_state: &FSMState, event: &FSMEvent, config: &FSMConfig) -> FSMState {
    let current_node = match config.states.get(&current_state.value) {
        Some(node) => node,
        None => return current_state.clone(),
    };

    let transitions = match &current_node.on {
        Some(on) => match on.get(&event.event_type) {
            Some(t) => t,
            None => return current_state.clone(),
        },
        None => return current_state.clone(),
    };

    // Try each transition in order (first matching guard wins)
    for transition in transitions {
        if let Some(ref guard) = transition.guard {
            if !evaluate_guard(guard, &current_state.context, event) {
                continue;
            }
        }

        if !config.states.contains_key(&transition.target) {
            eprintln!("FSM: Target state \"{}\" does not exist", transition.target);
            return current_state.clone();
        }

        return execute_transition(current_state, &transition.target, transition, event, config);
    }

    current_state.clone()
}

/// Initialize FSM state — PURE FUNCTION.
pub fn init_fsm(config: &FSMConfig, initial_context: serde_json::Value) -> FSMState {
    let mut context = initial_context;

    if let Some(state_node) = config.states.get(&config.initial) {
        if let Some(ref entry_actions) = state_node.entry {
            context = execute_actions(&context, entry_actions, None);
        }
    }

    FSMState {
        value: config.initial.clone(),
        context,
    }
}

/// Check if FSM can transition on given event — PURE PREDICATE.
pub fn can_transition(state: &FSMState, event: &FSMEvent, config: &FSMConfig) -> bool {
    let node = match config.states.get(&state.value) {
        Some(n) => n,
        None => return false,
    };

    let transitions = match &node.on {
        Some(on) => match on.get(&event.event_type) {
            Some(t) => t,
            None => return false,
        },
        None => return false,
    };

    transitions.iter().any(|t| {
        t.guard
            .as_ref()
            .map(|g| evaluate_guard(g, &state.context, event))
            .unwrap_or(true)
    })
}

/// Get all possible events from current state — PURE QUERY.
pub fn get_possible_events(state: &FSMState, config: &FSMConfig) -> Vec<String> {
    let node = match config.states.get(&state.value) {
        Some(n) => n,
        None => return Vec::new(),
    };

    match &node.on {
        Some(on) => on.keys().cloned().collect(),
        None => Vec::new(),
    }
}

// ============================================================================
// Internal helpers — all pure functions
// ============================================================================

/// Execute transition with entry/exit actions — PURE FUNCTION.
fn execute_transition(
    from_state: &FSMState,
    to_state: &str,
    transition: &FSMTransition,
    event: &FSMEvent,
    config: &FSMConfig,
) -> FSMState {
    let mut context = from_state.context.clone();

    // Exit actions from current state
    if let Some(state_node) = config.states.get(&from_state.value) {
        if let Some(ref exit_actions) = state_node.exit {
            context = execute_actions(&context, exit_actions, None);
        }
    }

    // Transition actions
    if let Some(ref actions) = transition.actions {
        context = execute_actions(&context, actions, Some(event));
    }

    // Entry actions for new state
    if let Some(state_node) = config.states.get(to_state) {
        if let Some(ref entry_actions) = state_node.entry {
            context = execute_actions(&context, entry_actions, None);
        }
    }

    FSMState {
        value: to_state.to_string(),
        context,
    }
}

/// Execute actions and return new context — PURE FUNCTION.
pub fn execute_actions(
    context: &serde_json::Value,
    actions: &[String],
    _event: Option<&FSMEvent>,
) -> serde_json::Value {
    let mut next_context = context.clone();

    for action in actions {
        // Simple action syntax: "key=value" sets context.key to value
        if let Some((key, value)) = action.split_once('=') {
            if let serde_json::Value::Object(ref mut map) = next_context {
                let parsed_value = serde_json::from_str(value)
                    .unwrap_or_else(|_| serde_json::Value::String(value.to_string()));
                map.insert(key.trim().to_string(), parsed_value);
            }
        }
    }

    next_context
}

/// Evaluate a guard expression — PURE PREDICATE.
fn evaluate_guard(guard: &str, context: &serde_json::Value, _event: &FSMEvent) -> bool {
    // Simple guard syntax: "key==value"
    if let Some((key, expected)) = guard.split_once("==") {
        if let serde_json::Value::Object(map) = context {
            if let Some(actual) = map.get(key.trim()) {
                let expected_trimmed = expected.trim();
                return actual
                    .as_str()
                    .map(|s| s == expected_trimmed)
                    .unwrap_or(false)
                    || actual.to_string().trim_matches('"') == expected_trimmed;
            }
        }
        return false;
    }

    // Simple guard syntax: "key!=value"
    if let Some((key, expected)) = guard.split_once("!=") {
        if let serde_json::Value::Object(map) = context {
            if let Some(actual) = map.get(key.trim()) {
                let expected_trimmed = expected.trim();
                let is_equal = actual
                    .as_str()
                    .map(|s| s == expected_trimmed)
                    .unwrap_or(false)
                    || actual.to_string().trim_matches('"') == expected_trimmed;
                return !is_equal;
            }
        }
        return true;
    }

    true
}
