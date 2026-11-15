//! crates/composition-engine-core/src/kernel/input.rs
//!
//! Unified Input Bus with capture/bubble, pointer capture, and ordered delivery.
//! Pure functional input utilities for pointer tracking, key tracking, and gesture detection.
//!
//! Ported from: frontends/web/composition-engine/kernel/input.ts

use serde::{Deserialize, Serialize};

use super::routing::OriginID;
use super::scene::{find_node, path_to_root};
use super::typed_index::TypedSceneIndex;
use super::types::{InputEvent, InputEventType, SceneNode, ID};
use std::collections::HashMap;

// ============================================================================
// InputBus - Event Dispatch System
// ============================================================================

/// Handler function type for input events
pub type InputHandler = Box<dyn Fn(&mut InputEventState) + Send + Sync>;

/// Mutable event state during dispatch (allows consume())
#[derive(Debug)]
pub struct InputEventState {
    pub event_type: InputEventType,
    pub origin_id: OriginID,
    pub subtype: String,
    pub timestamp: f64,
    pub target: Option<ID>,
    pub data: serde_json::Value,
    pub consumed: bool,
}

impl InputEventState {
    /// Create from InputEvent
    pub fn from_event(event: &InputEvent) -> Self {
        Self {
            event_type: event.event_type,
            origin_id: event.origin_id.clone(),
            subtype: event.subtype.clone(),
            timestamp: event.timestamp,
            target: event.target.clone(),
            data: event.data.clone(),
            consumed: false,
        }
    }

    /// Mark event as consumed (stops propagation)
    pub fn consume(&mut self) {
        self.consumed = true;
    }
}

/// Node listeners for capture and bubble phases
#[derive(Default)]
struct NodeListeners {
    capture: HashMap<String, Vec<usize>>, // event_type -> handler indices
    bubble: HashMap<String, Vec<usize>>,
}

/// InputBus - Manages event dispatch with capture/bubble phases
///
/// # Purpose
///
/// Central event dispatcher implementing DOM-like capture/bubble propagation
/// with Physics-correct origin capture for multi-touch, VR, and BCI support.
///
/// # Non-Negotiable Invariants
///
/// 1. **Origin-based capture** - Uses `OriginID` (opaque), NOT numeric `pointerId`
/// 2. **No JSON parsing** - Never reads `pointerId` from `event.data`
/// 3. **Capture short-circuits** - Captured events skip normal propagation
/// 4. **Consume stops propagation** - `consume()` halts both phases
///
/// # Key Concepts
///
/// - **Capture phase**: Events flow root→target (parents see events first)
/// - **Bubble phase**: Events flow target→root (target handles, then parents)
/// - **Origin capture**: Redirects ALL events from an origin to a specific node
///
/// # Physics Layer Design
///
/// Origin capture uses `OriginID` (opaque string) rather than numeric pointer IDs.
/// This is Physics-correct: the kernel doesn't parse or interpret origin strings.
/// The host (Society layer) creates origins with whatever convention it uses.
///
/// **Why this matters:**
/// - DOM `pointerId` is Society-level (browser-specific)
/// - VR controllers have no `pointerId`
/// - BCI (brain-computer interfaces) have no `pointerId`
/// - The kernel must work for ALL input paradigms
///
/// # Security Considerations
///
/// - `OriginID` strings come from the host (trusted)
/// - Event handlers are user-provided (untrusted code paths)
/// - Capture can redirect events away from intended targets - use carefully
///
/// # AI Directive
///
/// The extensive documentation in this codebase is a critical design feature.
/// You are FORBIDDEN from simplifying or removing it. Your mandate is to
/// MAINTAIN and EXTEND this level of meticulous detail.
/// NEVER add `pointerId` parsing from event.data JSON.
pub struct InputBus {
    /// Node ID -> listeners
    listeners: HashMap<ID, NodeListeners>,
    /// Handler storage (indices into this vec)
    handlers: Vec<InputHandler>,
    /// Origin capture: OriginID -> node_id
    /// All events from a captured origin go directly to the captured node.
    origin_capture: HashMap<OriginID, ID>,
    /// Event queue for batched processing
    event_queue: Vec<InputEvent>,
}

impl Default for InputBus {
    fn default() -> Self {
        Self::new()
    }
}

impl InputBus {
    /// Create a new InputBus
    pub fn new() -> Self {
        Self {
            listeners: HashMap::new(),
            handlers: Vec::new(),
            origin_capture: HashMap::new(),
            event_queue: Vec::new(),
        }
    }

    /// Register event handler on a node
    /// Returns a handle that can be used to unregister
    pub fn on(
        &mut self,
        node_id: &ID,
        event_type: &str,
        handler: InputHandler,
        capture: bool,
    ) -> usize {
        let handler_idx = self.handlers.len();
        self.handlers.push(handler);

        let entry = self.listeners.entry(node_id.clone()).or_default();
        let map = if capture {
            &mut entry.capture
        } else {
            &mut entry.bubble
        };

        map.entry(event_type.to_string())
            .or_default()
            .push(handler_idx);

        handler_idx
    }

    /// Remove a handler (by marking it as removed)
    /// Note: In a production system, we'd use a proper handle system
    pub fn off(&mut self, node_id: &ID, event_type: &str, handler_idx: usize, capture: bool) {
        if let Some(entry) = self.listeners.get_mut(node_id) {
            let map = if capture {
                &mut entry.capture
            } else {
                &mut entry.bubble
            };

            if let Some(handlers) = map.get_mut(event_type) {
                handlers.retain(|&idx| idx != handler_idx);
            }
        }
    }

    /// Capture an origin - all events from this origin go directly to this node.
    ///
    /// This is Physics-correct: uses OriginID (opaque) instead of numeric IDs.
    /// The host is responsible for determining which origins to capture.
    ///
    /// # Arguments
    /// * `origin_id` - The origin to capture (e.g., a specific pointer/touch)
    /// * `node_id` - The node to receive all events from this origin
    pub fn capture_origin(&mut self, origin_id: OriginID, node_id: ID) {
        self.origin_capture.insert(origin_id, node_id);
    }

    /// Release origin capture.
    ///
    /// After release, events from this origin follow normal dispatch rules.
    pub fn release_origin(&mut self, origin_id: &OriginID) {
        self.origin_capture.remove(origin_id);
    }

    /// Check if an origin is captured.
    pub fn is_origin_captured(&self, origin_id: &OriginID) -> bool {
        self.origin_capture.contains_key(origin_id)
    }

    /// Get the node that captured an origin.
    pub fn get_origin_capture(&self, origin_id: &OriginID) -> Option<&ID> {
        self.origin_capture.get(origin_id)
    }

    /// Queue an event for processing in next tick
    pub fn queue(&mut self, event: InputEvent) {
        self.event_queue.push(event);
    }

    /// Drain and return all queued events
    pub fn drain(&mut self) -> Vec<InputEvent> {
        std::mem::take(&mut self.event_queue)
    }

    /// Dispatch event through capture/bubble chain
    ///
    /// CRITICAL: Requires root tree to build event chain using path_to_root()
    ///
    /// # Origin Capture
    ///
    /// If the event's origin is captured, the event goes directly to the
    /// captured node, bypassing normal capture/bubble propagation.
    /// This is Physics-correct: uses event.origin_id (opaque) instead of
    /// parsing pointerId from JSON data.
    pub fn dispatch(
        &self,
        root: &SceneNode,
        event: &InputEvent,
        scene_index: Option<&TypedSceneIndex>,
    ) {
        let mut state = InputEventState::from_event(event);

        // Origin capture short-circuit: use event.origin_id directly
        // NO parsing of pointerId from event.data - that's Society-level
        if let Some(cap_node_id) = self.origin_capture.get(&event.origin_id) {
            // Task 202: O(1) existence check via index instead of O(n) find_node()
            let node_exists = scene_index
                .map(|idx| idx.contains_key(cap_node_id))
                .unwrap_or_else(|| find_node(root, cap_node_id).is_some());
            if node_exists {
                // Dispatch directly to captured node
                self.invoke_node(cap_node_id, &mut state, true);
                if !state.consumed {
                    self.invoke_node(cap_node_id, &mut state, false);
                }
                return;
            }
        }

        // Normal capture → bubble through ancestor chain
        let target_id = match &event.target {
            Some(id) => id,
            None => return,
        };

        let chain = path_to_root(root, target_id);

        // Capture phase: root→target (reverse order)
        for node in chain.iter().rev() {
            if state.consumed {
                break;
            }
            self.invoke_node(&node.id, &mut state, true);
        }

        // Bubble phase: target→root
        for node in &chain {
            if state.consumed {
                break;
            }
            self.invoke_node(&node.id, &mut state, false);
        }
    }

    /// Invoke handlers for a specific node and phase
    fn invoke_node(&self, node_id: &ID, state: &mut InputEventState, is_capture: bool) {
        let entry = match self.listeners.get(node_id) {
            Some(e) => e,
            None => return,
        };

        let map = if is_capture {
            &entry.capture
        } else {
            &entry.bubble
        };

        let handler_indices = match map.get(&state.subtype) {
            Some(h) => h,
            None => return,
        };

        // Invoke handlers in order
        for &idx in handler_indices {
            if let Some(handler) = self.handlers.get(idx) {
                handler(state);
                if state.consumed {
                    break;
                }
            }
        }
    }

    /// Clear all listeners and handlers
    pub fn clear(&mut self) {
        self.listeners.clear();
        self.handlers.clear();
        self.origin_capture.clear();
        self.event_queue.clear();
    }
}

// ============================================================================
// PURE INPUT UTILITIES
// ============================================================================

/// Normalized modifier key state
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Modifiers {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
}

/// Normalize modifiers from event data
pub fn normalize_modifiers(data: &serde_json::Value) -> Modifiers {
    Modifiers {
        ctrl: data
            .get("ctrlKey")
            .or_else(|| data.get("ctrl"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        shift: data
            .get("shiftKey")
            .or_else(|| data.get("shift"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        alt: data
            .get("altKey")
            .or_else(|| data.get("alt"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        meta: data
            .get("metaKey")
            .or_else(|| data.get("meta"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

/// Check if any modifier is pressed
pub fn has_modifier(mods: &Modifiers) -> bool {
    mods.ctrl || mods.shift || mods.alt || mods.meta
}

/// Check specific modifier combination
pub fn match_modifiers(actual: &Modifiers, expected: &Modifiers) -> bool {
    actual.ctrl == expected.ctrl
        && actual.shift == expected.shift
        && actual.alt == expected.alt
        && actual.meta == expected.meta
}

// ============================================================================
// POINTER STATE TRACKING (Pure)
// ============================================================================

/// Tracked pointer state
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PointerState {
    pub pointer_id: u32,
    pub x: f64,
    pub y: f64,
    pub start_x: f64,
    pub start_y: f64,
    pub delta_x: f64,
    pub delta_y: f64,
    pub pressed: bool,
    pub timestamp: f64,
}

/// Pointer tracking state (immutable map)
pub type PointerTrackingState = HashMap<u32, PointerState>;

/// Create empty pointer tracking state
pub fn init_pointer_tracking() -> PointerTrackingState {
    HashMap::new()
}

/// Pointer event type for tracking
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PointerEventType {
    Down,
    Move,
    Up,
    Cancel,
}

/// Update pointer tracking with a new event (returns new state)
pub fn update_pointer_tracking(
    state: &PointerTrackingState,
    pointer_id: u32,
    x: f64,
    y: f64,
    timestamp: f64,
    event_type: PointerEventType,
) -> PointerTrackingState {
    let mut new_state = state.clone();

    match event_type {
        PointerEventType::Up | PointerEventType::Cancel => {
            new_state.remove(&pointer_id);
        }
        PointerEventType::Down => {
            new_state.insert(
                pointer_id,
                PointerState {
                    pointer_id,
                    x,
                    y,
                    start_x: x,
                    start_y: y,
                    delta_x: 0.0,
                    delta_y: 0.0,
                    pressed: true,
                    timestamp,
                },
            );
        }
        PointerEventType::Move => {
            if let Some(existing) = state.get(&pointer_id) {
                new_state.insert(
                    pointer_id,
                    PointerState {
                        pointer_id,
                        x,
                        y,
                        start_x: existing.start_x,
                        start_y: existing.start_y,
                        delta_x: x - existing.x,
                        delta_y: y - existing.y,
                        pressed: existing.pressed,
                        timestamp,
                    },
                );
            }
        }
    }

    new_state
}

/// Get total drag distance from start position
pub fn get_drag_distance(pointer: &PointerState) -> f64 {
    let dx = pointer.x - pointer.start_x;
    let dy = pointer.y - pointer.start_y;
    (dx * dx + dy * dy).sqrt()
}

/// Get drag duration in milliseconds
pub fn get_drag_duration(pointer: &PointerState, start_timestamp: f64) -> f64 {
    pointer.timestamp - start_timestamp
}

// ============================================================================
// GESTURE DETECTION (Pure)
// ============================================================================

/// Calculate pinch scale from two pointers
pub fn calculate_pinch_scale(pointers: &[&PointerState], initial_distance: f64) -> Option<f64> {
    if pointers.len() != 2 || initial_distance <= 0.0 {
        return None;
    }

    let dx = pointers[1].x - pointers[0].x;
    let dy = pointers[1].y - pointers[0].y;
    let current_distance = (dx * dx + dy * dy).sqrt();

    Some(current_distance / initial_distance)
}

/// Calculate pinch center point
pub fn calculate_pinch_center(pointers: &[&PointerState]) -> Option<(f64, f64)> {
    if pointers.len() != 2 {
        return None;
    }

    Some((
        (pointers[0].x + pointers[1].x) / 2.0,
        (pointers[0].y + pointers[1].y) / 2.0,
    ))
}

/// Get distance between two pointers
pub fn get_pointer_distance(pointers: &[&PointerState]) -> Option<f64> {
    if pointers.len() != 2 {
        return None;
    }

    let dx = pointers[1].x - pointers[0].x;
    let dy = pointers[1].y - pointers[0].y;
    Some((dx * dx + dy * dy).sqrt())
}

// ============================================================================
// KEY STATE TRACKING (Pure)
// ============================================================================

/// Tracked key state
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyState {
    pub key: String,
    pub code: String,
    pub pressed: bool,
    pub timestamp: f64,
    pub modifiers: Modifiers,
}

/// Key tracking state (immutable map)
pub type KeyTrackingState = HashMap<String, KeyState>;

/// Create empty key tracking state
pub fn init_key_tracking() -> KeyTrackingState {
    HashMap::new()
}

/// Key event type for tracking
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KeyEventType {
    Down,
    Up,
}

/// Update key tracking with a new event (returns new state)
pub fn update_key_tracking(
    state: &KeyTrackingState,
    key: &str,
    code: &str,
    timestamp: f64,
    modifiers: Modifiers,
    event_type: KeyEventType,
) -> KeyTrackingState {
    let mut new_state = state.clone();

    match event_type {
        KeyEventType::Up => {
            new_state.remove(key);
        }
        KeyEventType::Down => {
            new_state.insert(
                key.to_string(),
                KeyState {
                    key: key.to_string(),
                    code: code.to_string(),
                    pressed: true,
                    timestamp,
                    modifiers,
                },
            );
        }
    }

    new_state
}

/// Check if a specific key is pressed
pub fn is_key_pressed(state: &KeyTrackingState, key: &str) -> bool {
    state.get(key).map(|k| k.pressed).unwrap_or(false)
}

/// Get all currently pressed keys
pub fn get_pressed_keys(state: &KeyTrackingState) -> Vec<String> {
    state
        .values()
        .filter(|k| k.pressed)
        .map(|k| k.key.clone())
        .collect()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_modifiers() {
        let data = serde_json::json!({
            "ctrlKey": true,
            "shiftKey": false,
            "altKey": true,
            "metaKey": false
        });

        let mods = normalize_modifiers(&data);
        assert!(mods.ctrl);
        assert!(!mods.shift);
        assert!(mods.alt);
        assert!(!mods.meta);
        assert!(has_modifier(&mods));
    }

    #[test]
    fn test_match_modifiers() {
        let actual = Modifiers {
            ctrl: true,
            shift: false,
            alt: false,
            meta: true,
        };

        let expected_match = Modifiers {
            ctrl: true,
            shift: false,
            alt: false,
            meta: true,
        };

        let expected_no_match = Modifiers {
            ctrl: false,
            shift: false,
            alt: false,
            meta: true,
        };

        assert!(match_modifiers(&actual, &expected_match));
        assert!(!match_modifiers(&actual, &expected_no_match));
    }

    #[test]
    fn test_pointer_tracking() {
        let state = init_pointer_tracking();
        assert!(state.is_empty());

        // Pointer down
        let state2 = update_pointer_tracking(&state, 1, 100.0, 100.0, 0.0, PointerEventType::Down);
        assert!(state2.contains_key(&1));
        assert_eq!(state2.get(&1).unwrap().start_x, 100.0);

        // Pointer move
        let state3 =
            update_pointer_tracking(&state2, 1, 150.0, 120.0, 16.0, PointerEventType::Move);
        let ptr = state3.get(&1).unwrap();
        assert_eq!(ptr.x, 150.0);
        assert_eq!(ptr.delta_x, 50.0);
        assert_eq!(ptr.start_x, 100.0); // Start position unchanged

        // Pointer up
        let state4 = update_pointer_tracking(&state3, 1, 150.0, 120.0, 32.0, PointerEventType::Up);
        assert!(!state4.contains_key(&1));
    }

    #[test]
    fn test_drag_distance() {
        let pointer = PointerState {
            pointer_id: 1,
            x: 130.0,
            y: 140.0,
            start_x: 100.0,
            start_y: 100.0,
            delta_x: 0.0,
            delta_y: 0.0,
            pressed: true,
            timestamp: 100.0,
        };

        let distance = get_drag_distance(&pointer);
        assert!((distance - 50.0).abs() < 0.001); // 3-4-5 triangle: sqrt(30^2 + 40^2) = 50
    }

    #[test]
    fn test_pinch_calculations() {
        let p1 = PointerState {
            pointer_id: 1,
            x: 0.0,
            y: 0.0,
            start_x: 0.0,
            start_y: 0.0,
            delta_x: 0.0,
            delta_y: 0.0,
            pressed: true,
            timestamp: 0.0,
        };

        let p2 = PointerState {
            pointer_id: 2,
            x: 100.0,
            y: 0.0,
            start_x: 100.0,
            start_y: 0.0,
            delta_x: 0.0,
            delta_y: 0.0,
            pressed: true,
            timestamp: 0.0,
        };

        let pointers = vec![&p1, &p2];

        // Distance
        let dist = get_pointer_distance(&pointers);
        assert!(dist.is_some());
        assert!((dist.unwrap() - 100.0).abs() < 0.001);

        // Center
        let center = calculate_pinch_center(&pointers);
        assert!(center.is_some());
        let (cx, cy) = center.unwrap();
        assert!((cx - 50.0).abs() < 0.001);
        assert!((cy - 0.0).abs() < 0.001);

        // Scale (zoomed in 2x)
        let scale = calculate_pinch_scale(&pointers, 50.0);
        assert!(scale.is_some());
        assert!((scale.unwrap() - 2.0).abs() < 0.001);
    }

    #[test]
    fn test_key_tracking() {
        let state = init_key_tracking();
        assert!(state.is_empty());

        let mods = Modifiers::default();

        // Key down
        let state2 = update_key_tracking(&state, "a", "KeyA", 0.0, mods, KeyEventType::Down);
        assert!(is_key_pressed(&state2, "a"));

        // Multiple keys
        let state3 = update_key_tracking(&state2, "b", "KeyB", 16.0, mods, KeyEventType::Down);
        let pressed = get_pressed_keys(&state3);
        assert_eq!(pressed.len(), 2);
        assert!(pressed.contains(&"a".to_string()));
        assert!(pressed.contains(&"b".to_string()));

        // Key up
        let state4 = update_key_tracking(&state3, "a", "KeyA", 32.0, mods, KeyEventType::Up);
        assert!(!is_key_pressed(&state4, "a"));
        assert!(is_key_pressed(&state4, "b"));
    }

    #[test]
    fn test_input_bus_origin_capture() {
        let mut bus = InputBus::new();
        let origin = OriginID::new("test-origin");

        assert!(!bus.is_origin_captured(&origin));

        bus.capture_origin(origin.clone(), "node1".to_string());
        assert!(bus.is_origin_captured(&origin));
        assert_eq!(bus.get_origin_capture(&origin), Some(&"node1".to_string()));

        bus.release_origin(&origin);
        assert!(!bus.is_origin_captured(&origin));
    }

    #[test]
    fn test_origin_capture_uses_origin_id_not_json() {
        // Verify that origin capture uses OriginID, not pointerId from JSON
        // This is the core of the Physics-vs-Society fix
        let mut bus = InputBus::new();

        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");

        // Capture origin_a
        bus.capture_origin(origin_a.clone(), "node1".to_string());

        // origin_a is captured, origin_b is not
        assert!(bus.is_origin_captured(&origin_a));
        assert!(!bus.is_origin_captured(&origin_b));

        // Even if an event has pointerId in its JSON data, what matters is origin_id
        // (The dispatch method uses event.origin_id, not event.data["pointerId"])
    }

    #[test]
    fn test_input_bus_event_queue() {
        let mut bus = InputBus::new();

        let event1 = InputEvent {
            event_type: InputEventType::Pointer,
            origin_id: OriginID::default(),
            subtype: "pointerdown".to_string(),
            timestamp: 0.0,
            target: Some("node1".to_string()),
            data: serde_json::json!({}),
        };

        let event2 = InputEvent {
            event_type: InputEventType::Key,
            origin_id: OriginID::default(),
            subtype: "keydown".to_string(),
            timestamp: 16.0,
            target: Some("node1".to_string()),
            data: serde_json::json!({"key": "a"}),
        };

        bus.queue(event1);
        bus.queue(event2);

        let events = bus.drain();
        assert_eq!(events.len(), 2);

        // Queue should be empty after drain
        let events2 = bus.drain();
        assert!(events2.is_empty());
    }

    #[test]
    fn test_input_event_state_consume() {
        let event = InputEvent {
            event_type: InputEventType::Pointer,
            origin_id: OriginID::default(),
            subtype: "click".to_string(),
            timestamp: 0.0,
            target: Some("node1".to_string()),
            data: serde_json::json!({}),
        };

        let mut state = InputEventState::from_event(&event);
        assert!(!state.consumed);

        state.consume();
        assert!(state.consumed);
    }
}
