//! crates/state-graph/src/lib.rs
//!
//! # State Graph
//!
//! Unified runtime state graph - the **single source of truth** for all platform state.
//!
//! This crate provides a unified `StateGraph` struct that contains ALL runtime state
//! across the Architect platform. Both `composition-engine` and `interaction-engine`
//! use this shared state, enabling:
//!
//! - Trigger queries to access ALL state (including FSM state)
//! - No manual bridging between engines
//! - DRY principle - types defined once, used everywhere
//! - Full JSON serialization for formula evaluation
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────┐
//! │                        StateGraph                            │
//! │                                                              │
//! │  ┌─────────────────┐  ┌─────────────────┐                   │
//! │  │  Input State    │  │   UI State      │                   │
//! │  │  ─────────────  │  │   ────────      │                   │
//! │  │  pointers       │  │   fsm           │                   │
//! │  │  keyboard       │  │                 │                   │
//! │  │  device         │  │                 │                   │
//! │  │  audio          │  │                 │                   │
//! │  └─────────────────┘  └─────────────────┘                   │
//! │                                                              │
//! │  ┌─────────────────────────────────────────────────────┐   │
//! │  │  History & Meta                                      │   │
//! │  │  ───────────────                                     │   │
//! │  │  recent_events (for pattern matching)                │   │
//! │  │  meta (timing, session info)                         │   │
//! │  └─────────────────────────────────────────────────────┘   │
//! └─────────────────────────────────────────────────────────────┘
//! ```
//!
//! ## CRITICAL INVARIANT: Focus is NOT Stored State
//!
//! Focus is derived from `routing.routes` in the composition-engine kernel.
//! The concept of `FocusState` as stored state was Society pollution that caused
//! split-brain bugs. See Task 059: Routing as Focus Source of Truth.
//!
//! ## Example Usage
//!
//! ```rust
//! use state_graph::{StateGraph, EventRecord};
//!
//! // Create a new state graph
//! let mut graph = StateGraph::new();
//!
//! // Track keyboard input
//! graph.keyboard.key_down("Control", 100);
//! graph.keyboard.key_down("s", 110);
//!
//! // Track FSM state
//! graph.fsm.set("fsm:editor:mode", "edit");
//!
//! // Check state in trigger queries
//! assert!(graph.keyboard.is_pressed("Control"));
//! assert!(graph.fsm.is_in_state("fsm:editor:mode", "edit"));
//!
//! // Record events for pattern matching
//! graph.record_event(EventRecord::key_event("key_down", "Enter", 200));
//! ```
//!
//! ## Design Principles
//!
//! 1. **Single Source of Truth**: StateGraph is THE state. No duplicates.
//! 2. **Pure Data**: No business logic - just state storage and accessors.
//! 3. **Serializable**: Full JSON serialization for formula evaluation.
//! 4. **Physics Layer**: Universal truths, not society-level configuration.
//!
//! # AI Directive
//!
//! The extensive documentation in this codebase is a critical design feature.
//! You are FORBIDDEN from simplifying or removing it. Your mandate is to
//! MAINTAIN and EXTEND this level of meticulous detail.

pub mod history;
pub mod input;
pub mod meta;
pub mod ui;

// Re-export all public types for convenient access
pub use history::{EventHistory, EventHistoryConfig, EventRecord};
pub use input::{
    AudioState, DeviceState, KeyboardState, PointerState, PointerStatus, WelfordAccumulator,
};
pub use meta::MetaState;
pub use ui::{FsmId, FsmRegistry, FsmStateValue};

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

/// Time-to-live for ephemeral state nodes (30 seconds)
pub const STATE_NODE_TTL_MS: u64 = 30_000;

/// Delta description for state mutations — enables change propagation without re-polling
/// (P6: Change Propagation as First-Class Contract)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum StateDelta {
    /// Keyboard key state changed
    KeyboardKey { key: String, pressed: bool },
    /// Pointer moved
    PointerMoved { pointer_id: u64, x: f32, y: f32 },
    /// Pointer button state changed
    PointerButton {
        pointer_id: u64,
        button: u8,
        pressed: bool,
    },
    /// Event recorded to history
    EventRecorded { event_kind: String },
}

/// Trait for zero-copy, typed queries against state during trigger evaluation.
/// Replaces `to_trigger_context()` which serialized the entire StateGraph to JSON
/// on every trigger evaluation (O(n) allocation, zero information gain).
///
/// Implementers must provide O(1) lookups for trigger query patterns without allocation.
pub trait TriggerQueryable {
    /// Get the current state of an FSM (state name string), or None if FSM not found
    fn fsm_state(&self, entity_id: &str) -> Option<&str>;

    /// Check if a keyboard key is currently pressed
    fn key_is_down(&self, key: &str) -> bool;

    /// Get the current position of a pointer, or None if pointer not active
    fn pointer_position(&self, pointer_id: u64) -> Option<(f32, f32)>;
}

/// Update payload for pointer state mutations
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PointerUpdate {
    /// Move pointer to new position
    MoveTo { x: f32, y: f32, timestamp: u64 },
    /// Pointer button down
    Down {
        x: f32,
        y: f32,
        timestamp: u64,
        pressure: f32,
    },
    /// Pointer button up
    Up { timestamp: u64 },
}

/// The unified state graph - single source of truth for ALL runtime state.
///
/// Both `composition-engine` and `interaction-engine` use this shared state,
/// enabling trigger queries to naturally access all state including FSM.
///
/// # CRITICAL INVARIANT
///
/// Focus is NOT stored here. Focus is derived from `routing.routes` in the
/// composition-engine kernel. This eliminates the split-brain bug where
/// multiple sources of truth existed for focus state.
///
/// # Example
///
/// ```rust
/// use state_graph::StateGraph;
///
/// let mut graph = StateGraph::new();
///
/// // Input state
/// graph.keyboard.key_down("a", 100);
/// assert!(graph.keyboard.is_pressed("a"));
///
/// // UI state (FSM only - focus is in routing)
/// graph.fsm.set("fsm:editor:mode", "view");
/// assert!(graph.fsm.is_in_state("fsm:editor:mode", "view"));
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StateGraph {
    // === INPUT STATE (from interaction-engine) ===
    /// Active pointer states by pointer ID
    pub pointers: HashMap<u64, PointerState>,

    /// Current keyboard state (pressed_keys HashSet)
    pub keyboard: KeyboardState,

    /// Device sensor state (accelerometer, gyroscope, etc.)
    pub device: DeviceState,

    /// Voice recognition state
    pub audio: AudioState,

    // === UI STATE (from composition-engine) ===
    /// FSM states: FSM ID → current state string
    pub fsm: FsmRegistry,

    // NOTE: Focus is NOT stored here. Focus is derived from routing.routes
    // in the composition-engine kernel. See Task 059.

    // === HISTORY & META ===
    /// Universal event history for pattern matching (double-tap, etc.) — VecDeque for O(1) insertion
    /// Bounded to max_recent_events (default 1000) to prevent unbounded memory growth
    pub recent_events: VecDeque<EventRecord>,

    /// Maximum capacity for recent_events ring buffer (default 1000)
    pub max_recent_events: usize,

    /// Timing and session metadata
    pub meta: MetaState,
}

impl Default for StateGraph {
    fn default() -> Self {
        Self {
            pointers: HashMap::new(),
            keyboard: KeyboardState::default(),
            device: DeviceState::default(),
            audio: AudioState::default(),
            fsm: FsmRegistry::default(),
            recent_events: VecDeque::new(),
            max_recent_events: 1000,
            meta: MetaState::default(),
        }
    }
}

impl StateGraph {
    /// Create a new empty state graph with default max_recent_events = 1000
    pub fn new() -> Self {
        Self {
            max_recent_events: 1000,
            ..Default::default()
        }
    }

    /// Create a state graph with custom max_recent_events capacity
    pub fn with_events_capacity(capacity: usize) -> Self {
        Self {
            recent_events: VecDeque::with_capacity(capacity),
            max_recent_events: capacity,
            ..Default::default()
        }
    }

    /// Create a state graph with session start time
    pub fn with_session_start(session_start: u64) -> Self {
        Self {
            max_recent_events: 1000,
            meta: MetaState::with_session_start(session_start),
            ..Default::default()
        }
    }

    // === POINTER HELPERS ===

    /// Get a pointer state by ID (immutable read)
    pub fn get_pointer(&self, pointer_id: u64) -> Option<&PointerState> {
        self.pointers.get(&pointer_id)
    }

    /// Update a pointer state and return a StateDelta describing the change
    pub fn update_pointer(&mut self, pointer_id: u64, update: PointerUpdate) -> Option<StateDelta> {
        let pointer = self.get_or_create_pointer(pointer_id);
        match update {
            PointerUpdate::MoveTo { x, y, timestamp } => {
                pointer.move_to(x, y, timestamp, 0.5);
                Some(StateDelta::PointerMoved { pointer_id, x, y })
            }
            PointerUpdate::Down {
                x,
                y,
                timestamp,
                pressure,
            } => {
                pointer.down(x, y, timestamp, pressure);
                Some(StateDelta::PointerButton {
                    pointer_id,
                    button: 0,
                    pressed: true,
                })
            }
            PointerUpdate::Up { timestamp } => {
                pointer.up(timestamp);
                Some(StateDelta::PointerButton {
                    pointer_id,
                    button: 0,
                    pressed: false,
                })
            }
        }
    }

    /// Get or create a pointer state
    pub fn get_or_create_pointer(&mut self, pointer_id: u64) -> &mut PointerState {
        self.pointers
            .entry(pointer_id)
            .or_insert_with(|| PointerState::new(pointer_id))
    }

    /// Remove a pointer state
    pub fn remove_pointer(&mut self, pointer_id: u64) -> Option<PointerState> {
        self.pointers.remove(&pointer_id)
    }

    /// Get the number of active pointers
    pub fn pointer_count(&self) -> usize {
        self.pointers.len()
    }

    /// Prune stale pointers (past TTL)
    pub fn prune_stale_pointers(&mut self, current_time: u64) {
        self.pointers
            .retain(|_, p| current_time.saturating_sub(p.last_updated) < STATE_NODE_TTL_MS);
    }

    // === EVENT HELPERS ===

    /// Record an event (O(1) prepend to front - newest first).
    /// Returns a StateDelta describing what was recorded.
    /// If recent_events exceeds max capacity, silently drops oldest event.
    pub fn record_event(&mut self, event: EventRecord) -> Option<StateDelta> {
        let event_kind = event.event_type.clone();
        let timestamp = event.timestamp;
        self.recent_events.push_front(event);
        if self.recent_events.len() > self.max_recent_events {
            self.recent_events.pop_back();
        }
        self.meta.record_event(timestamp);
        Some(StateDelta::EventRecorded { event_kind })
    }

    // === SERIALIZATION HELPERS ===

    /// Serialize the state graph to JSON
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Serialize the state graph to pretty JSON
    pub fn to_json_pretty(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    /// Deserialize a state graph from JSON
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// Reset the state graph for a new session
    pub fn reset(&mut self, session_start: u64) {
        self.pointers.clear();
        self.keyboard.clear();
        self.device = DeviceState::default();
        self.audio = AudioState::default();
        self.fsm.clear();
        self.recent_events.clear();
        self.meta.reset(session_start);
    }
}

impl TriggerQueryable for StateGraph {
    fn fsm_state(&self, entity_id: &str) -> Option<&str> {
        self.fsm.get(entity_id).map(|s| s.as_str())
    }

    fn key_is_down(&self, key: &str) -> bool {
        self.keyboard.is_pressed(key)
    }

    fn pointer_position(&self, pointer_id: u64) -> Option<(f32, f32)> {
        self.pointers.get(&pointer_id).map(|p| p.position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_state_graph_default() {
        let graph = StateGraph::new();
        assert!(graph.pointers.is_empty());
        assert!(graph.keyboard.pressed_keys.is_empty());
        assert!(graph.fsm.is_empty());
    }

    #[test]
    fn test_state_graph_with_session() {
        let graph = StateGraph::with_session_start(1000);
        assert_eq!(graph.meta.session_start, 1000);
    }

    #[test]
    fn test_pointer_tracking() {
        let mut graph = StateGraph::new();

        // Create pointer
        let ptr = graph.get_or_create_pointer(1);
        ptr.down(100.0, 100.0, 1000, 0.5);

        assert_eq!(graph.pointer_count(), 1);
        assert!(graph.get_pointer(1).is_some());
        assert!(graph.get_pointer(2).is_none());

        // Move pointer via update_pointer
        let delta = graph.update_pointer(
            1,
            PointerUpdate::MoveTo {
                x: 110.0,
                y: 100.0,
                timestamp: 1016,
            },
        );

        assert!(delta.is_some());
        assert_eq!(graph.get_pointer(1).unwrap().status, PointerStatus::Moving);
    }

    #[test]
    fn test_multi_touch_pointers() {
        let mut graph = StateGraph::new();

        // Simulate multi-touch
        graph.get_or_create_pointer(1).down(100.0, 100.0, 1000, 0.5);
        graph.get_or_create_pointer(2).down(200.0, 200.0, 1000, 0.5);
        graph.get_or_create_pointer(3).down(300.0, 300.0, 1000, 0.5);

        assert_eq!(graph.pointer_count(), 3);

        // Release one via update_pointer
        let delta = graph.update_pointer(2, PointerUpdate::Up { timestamp: 1100 });

        assert!(delta.is_some());
        assert_eq!(graph.get_pointer(2).unwrap().status, PointerStatus::Up);
    }

    #[test]
    fn test_keyboard_integration() {
        let mut graph = StateGraph::new();

        graph.keyboard.key_down("Control", 100);
        graph.keyboard.key_down("s", 110);

        assert!(graph.keyboard.is_pressed("Control"));
        assert!(graph.keyboard.is_pressed("s"));
        assert!(graph.keyboard.all_pressed(&["Control", "s"]));
    }

    #[test]
    fn test_fsm_integration() {
        let mut graph = StateGraph::new();

        graph.fsm.set("fsm:editor:mode", "view");
        assert!(graph.fsm.is_in_state("fsm:editor:mode", "view"));

        graph.fsm.set("fsm:editor:mode", "edit");
        assert!(graph.fsm.is_in_state("fsm:editor:mode", "edit"));
        assert!(!graph.fsm.is_in_state("fsm:editor:mode", "view"));
    }

    #[test]
    fn test_event_recording() {
        let mut graph = StateGraph::new();

        graph.record_event(EventRecord::key_event("key_down", "Enter", 100));
        graph.record_event(EventRecord::key_event("key_up", "Enter", 150));

        assert_eq!(graph.recent_events.len(), 2);
        assert_eq!(graph.meta.event_count, 2);
    }

    #[test]
    fn test_json_serialization() {
        let mut graph = StateGraph::new();
        graph.keyboard.key_down("a", 100);
        graph.fsm.set("fsm:test", "active");

        let json = graph.to_json().unwrap();
        let restored = StateGraph::from_json(&json).unwrap();

        assert!(restored.keyboard.is_pressed("a"));
        assert!(restored.fsm.is_in_state("fsm:test", "active"));
    }

    #[test]
    fn test_json_deserialization() {
        let json = r#"{
            "pointers": {},
            "keyboard": {
                "pressed_keys": ["Control", "c"],
                "last_updated": 100
            },
            "device": {},
            "audio": {},
            "fsm": {},
            "recent_events": [],
            "max_recent_events": 1000,
            "meta": {}
        }"#;

        let graph = StateGraph::from_json(json).unwrap();
        assert!(graph.keyboard.is_pressed("Control"));
        assert!(graph.keyboard.is_pressed("c"));
    }

    #[test]
    fn test_trigger_queryable() {
        let mut graph = StateGraph::new();
        graph.keyboard.key_down("Control", 100);
        graph.fsm.set("fsm:editor:mode", "edit");
        graph.get_or_create_pointer(1).down(100.0, 200.0, 1000, 0.5);

        // Use TriggerQueryable trait for zero-copy O(1) queries
        assert!(graph.key_is_down("Control"));
        assert_eq!(graph.fsm_state("fsm:editor:mode"), Some("edit"));
        assert_eq!(graph.pointer_position(1), Some((100.0, 200.0)));
        assert_eq!(graph.pointer_position(99), None);
    }

    #[test]
    fn test_prune_stale_pointers() {
        let mut graph = StateGraph::new();

        // Add pointers at different times
        graph.get_or_create_pointer(1).down(0.0, 0.0, 1000, 0.5);
        graph.get_or_create_pointer(2).down(0.0, 0.0, 20000, 0.5);

        // Prune at time 32000 (pointer 1 is older than 30s TTL)
        graph.prune_stale_pointers(32000);

        assert!(!graph.pointers.contains_key(&1)); // Pruned
        assert!(graph.pointers.contains_key(&2)); // Still valid
    }

    #[test]
    fn test_reset() {
        let mut graph = StateGraph::new();
        graph.keyboard.key_down("a", 100);
        graph.fsm.set("fsm:test", "active");
        graph.record_event(EventRecord::new("test", 100));

        graph.reset(5000);

        assert!(graph.keyboard.pressed_keys.is_empty());
        assert!(graph.fsm.is_empty());
        assert!(graph.recent_events.is_empty());
        assert_eq!(graph.meta.session_start, 5000);
    }
}
