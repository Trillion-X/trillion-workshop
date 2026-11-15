//! Keyboard state tracking for the unified state graph.
//!
//! This module provides types for tracking keyboard state.
//! This is a Physics-layer type - it tracks raw key state without Society-level interpretation.
//!
//! # Pure Physics Design
//!
//! ALL keys (including "Control", "Shift", "Alt", "Meta") are tracked uniformly
//! in `pressed_keys`. There is no special-casing for "modifier" keys.
//!
//! Society-level meaning (e.g., "Ctrl+S means save") is defined in EEAF trigger
//! queries, not in this Physics layer.
//!
//! # Example
//! ```ignore
//! // Physics: just tracks what's pressed
//! pressed_keys: {"Control", "s"}
//!
//! // Society (trigger query): defines meaning
//! "'Control' in graph.keyboard.pressed_keys && event.key == 's'"
//! ```

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Current keyboard state.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct KeyboardState {
    /// All currently pressed keys (including modifier keys like "Control", "Shift")
    ///
    /// This is pure Physics - no distinction between "modifier" and "regular" keys.
    /// The Society layer (trigger queries) defines what combinations mean.
    pub pressed_keys: HashSet<String>,

    /// Timestamp of last key event
    pub last_updated: u64,
}

impl KeyboardState {
    /// Create a new keyboard state
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a key down event
    pub fn key_down(&mut self, key: &str, timestamp: u64) {
        self.pressed_keys.insert(key.to_string());
        self.last_updated = timestamp;
    }

    /// Record a key up event
    pub fn key_up(&mut self, key: &str, timestamp: u64) {
        self.pressed_keys.remove(key);
        self.last_updated = timestamp;
    }

    /// Check if a key is currently pressed
    pub fn is_pressed(&self, key: &str) -> bool {
        self.pressed_keys.contains(key)
    }

    /// Check if any of the given keys are pressed
    pub fn any_pressed(&self, keys: &[&str]) -> bool {
        keys.iter().any(|k| self.is_pressed(k))
    }

    /// Check if all of the given keys are pressed
    pub fn all_pressed(&self, keys: &[&str]) -> bool {
        keys.iter().all(|k| self.is_pressed(k))
    }

    /// Clear all pressed keys
    pub fn clear(&mut self) {
        self.pressed_keys.clear();
    }

    /// Get the number of currently pressed keys
    pub fn pressed_count(&self) -> usize {
        self.pressed_keys.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_keyboard_state_default() {
        let state = KeyboardState::new();
        assert!(state.pressed_keys.is_empty());
        assert_eq!(state.last_updated, 0);
    }

    #[test]
    fn test_key_down_up() {
        let mut state = KeyboardState::new();

        state.key_down("a", 100);
        assert!(state.is_pressed("a"));
        assert_eq!(state.pressed_count(), 1);

        state.key_down("b", 110);
        assert!(state.is_pressed("a"));
        assert!(state.is_pressed("b"));
        assert_eq!(state.pressed_count(), 2);

        state.key_up("a", 120);
        assert!(!state.is_pressed("a"));
        assert!(state.is_pressed("b"));
        assert_eq!(state.pressed_count(), 1);
    }

    #[test]
    fn test_modifier_keys_same_as_regular() {
        let mut state = KeyboardState::new();

        // Modifier keys are tracked the same as regular keys
        state.key_down("Control", 100);
        state.key_down("s", 110);

        assert!(state.is_pressed("Control"));
        assert!(state.is_pressed("s"));
        assert!(state.all_pressed(&["Control", "s"]));
    }

    #[test]
    fn test_any_all_pressed() {
        let mut state = KeyboardState::new();
        state.key_down("a", 100);
        state.key_down("b", 110);

        assert!(state.any_pressed(&["a", "c", "d"]));
        assert!(!state.any_pressed(&["c", "d", "e"]));

        assert!(state.all_pressed(&["a", "b"]));
        assert!(!state.all_pressed(&["a", "b", "c"]));
    }

    #[test]
    fn test_clear() {
        let mut state = KeyboardState::new();
        state.key_down("a", 100);
        state.key_down("b", 110);
        assert_eq!(state.pressed_count(), 2);

        state.clear();
        assert_eq!(state.pressed_count(), 0);
    }
}
