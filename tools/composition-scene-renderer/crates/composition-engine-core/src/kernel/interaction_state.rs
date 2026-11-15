//! crates/composition-engine-core/src/kernel/interaction_state.rs
//!
//! Per-origin interaction state management.
//!
//! This module provides Physics-correct interaction state where each
//! input origin (finger, mouse, pen, controller) tracks its own
//! hover/press/capture state independently.
//!
//! ## Why Per-Origin?
//!
//! The old model used flat lists:
//! - `hovered_nodes: Vec<ID>` - WHO is hovering? Unknown.
//! - `pressed_nodes: Vec<ID>` - WHO is pressing? Unknown.
//!
//! This breaks multi-touch, VR, collaborative editing, and any
//! scenario with multiple concurrent input sources.
//!
//! ## The Physics Model
//!
//! Interaction state is a `Map<OriginID, OriginInteractionState>`.
//! Each origin tracks:
//! - Hover path (if the origin supports hover)
//! - Press path (what this origin is pressing)
//! - Capture target (routing override)
//! - Kinematics (position, velocity for gesture detection)
//!
//! # Non-Negotiable Invariants
//!
//! 1. Each origin's state is INDEPENDENT - modifying one never affects another
//! 2. Capabilities are provided by the HOST, not derived from OriginID strings
//! 3. `hover_path` is `None` for origins without hover capability (touch)
//! 4. `hover_path` is `Some(empty)` for origins that support hover but aren't over anything
//! 5. `press_path` is empty (not `None`) when not pressing - all origins CAN press
//!
//! # Security Considerations
//!
//! - Origin state comes from untrusted browser events
//! - Do not trust hover/press paths for security decisions
//! - Capture is a routing override - validate before setting
//!
//! # AI Directive
//!
//! The extensive documentation in this codebase is a critical design feature.
//! You are FORBIDDEN from simplifying or removing it. Your mandate is to
//! MAINTAIN and EXTEND this level of meticulous detail.

use super::origin_map_serde;
use super::routing::{OriginCapabilities, OriginID};
use super::types::{Point, ID};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================================
// Origin Interaction State
// ============================================================================

/// Interaction state for a single input origin.
///
/// Each origin (finger, mouse, pen, etc.) tracks its own independent state.
/// This enables multi-touch, VR controllers, and collaborative editing
/// without conflating different users'/devices' interactions.
///
/// **NOTE**: Capabilities are NOT stored here. They are provided by the HOST
/// via an OriginRegistry (see Agent 2's work). The kernel does NOT derive
/// capabilities from OriginID strings - that would be Society-level knowledge.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OriginInteractionState {
    /// Hover path for this origin (root to leaf).
    /// None if origin doesn't support hover (e.g., touch).
    /// Some(empty) if origin supports hover but isn't over anything.
    pub hover_path: Option<Vec<ID>>,

    /// Press path for this origin (nodes currently pressed by this origin).
    /// Empty if not pressing anything.
    pub press_path: Vec<ID>,

    /// Capture target - routing override for this origin.
    /// When set, all events from this origin go to this node
    /// regardless of hit testing.
    pub capture: Option<ID>,

    /// Current position (for gesture recognition).
    pub position: Option<Point>,

    /// Calculated velocity (for flick/swipe detection).
    pub velocity: Option<Point>,

    /// Previous position (for velocity calculation).
    pub last_position: Option<Point>,

    /// Timestamp of last event in milliseconds (for velocity calculation).
    pub last_event_time: Option<f64>,
}

impl OriginInteractionState {
    /// Create a new origin state with explicit capabilities.
    ///
    /// **PHYSICS LAYER**: Capabilities are provided by the HOST, not derived
    /// from OriginID strings. The kernel doesn't know about "keyboards" or
    /// "pointers" - those are Society-level concepts.
    ///
    /// # Example
    ///
    /// ```
    /// use composition_engine_core::kernel::interaction_state::OriginInteractionState;
    /// use composition_engine_core::kernel::routing::OriginCapabilities;
    ///
    /// // Host provides capabilities when creating state
    /// let state = OriginInteractionState::with_capabilities(OriginCapabilities::MOUSE);
    /// // Mouse has hover capability, so hover_path is Some(empty)
    /// assert!(state.hover_path.is_some());
    ///
    /// let touch_state = OriginInteractionState::with_capabilities(OriginCapabilities::TOUCH);
    /// // Touch has no hover capability
    /// assert!(touch_state.hover_path.is_none());
    /// ```
    pub fn with_capabilities(capabilities: OriginCapabilities) -> Self {
        let hover_path = if capabilities.has_hover {
            Some(Vec::new())
        } else {
            None
        };

        Self {
            hover_path,
            ..Default::default()
        }
    }

    /// Check if this origin is currently pressing any node.
    pub fn is_pressing(&self) -> bool {
        !self.press_path.is_empty()
    }

    /// Check if this origin is hovering over any node.
    pub fn is_hovering(&self) -> bool {
        self.hover_path
            .as_ref()
            .map(|p| !p.is_empty())
            .unwrap_or(false)
    }

    /// Check if this origin has captured a target.
    pub fn has_capture(&self) -> bool {
        self.capture.is_some()
    }

    /// Get the leaf node being hovered (last in path).
    pub fn hover_target(&self) -> Option<&ID> {
        self.hover_path.as_ref().and_then(|p| p.last())
    }

    /// Get the leaf node being pressed (last in path).
    pub fn press_target(&self) -> Option<&ID> {
        self.press_path.last()
    }
}

// ============================================================================
// Interaction State (Aggregate)
// ============================================================================

/// Per-origin interaction state for the entire system.
///
/// This is the Physics-correct replacement for flat `hovered_nodes`/`pressed_nodes` lists.
/// Each origin has its own independent interaction state.
///
/// # Examples
///
/// ```
/// use composition_engine_core::kernel::interaction_state::{InteractionState, OriginInteractionState};
/// use composition_engine_core::kernel::routing::OriginID;
///
/// let mut state = InteractionState::new();
///
/// // Origin 1 presses button A
/// state.origins.insert(OriginID::new("origin-1"), OriginInteractionState {
///     press_path: vec!["button-a".to_string()],
///     ..Default::default()
/// });
///
/// // Origin 2 presses button B (independent!)
/// state.origins.insert(OriginID::new("origin-2"), OriginInteractionState {
///     press_path: vec!["button-b".to_string()],
///     ..Default::default()
/// });
///
/// assert!(state.is_pressed(&"button-a".to_string()));
/// assert!(state.is_pressed(&"button-b".to_string()));
/// ```
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InteractionState {
    /// All interaction state keyed by origin.
    #[serde(with = "origin_map_serde", default)]
    pub origins: HashMap<OriginID, OriginInteractionState>,
}

impl InteractionState {
    /// Create empty interaction state.
    pub fn new() -> Self {
        Self {
            origins: HashMap::new(),
        }
    }

    /// Get all currently hovered nodes across all origins (aggregate view).
    ///
    /// Returns the union of all hover paths from all active origins.
    /// Useful when you need to know "is ANY origin hovering this node?"
    pub fn all_hovered_nodes(&self) -> Vec<ID> {
        let mut result = Vec::new();
        for state in self.origins.values() {
            if let Some(ref path) = state.hover_path {
                for id in path {
                    if !result.contains(id) {
                        result.push(id.clone());
                    }
                }
            }
        }
        result
    }

    /// Get all currently pressed nodes across all origins (aggregate view).
    ///
    /// Returns the union of all press paths from all active origins.
    /// Useful when you need to know "is ANY origin pressing this node?"
    pub fn all_pressed_nodes(&self) -> Vec<ID> {
        let mut result = Vec::new();
        for state in self.origins.values() {
            for id in &state.press_path {
                if !result.contains(id) {
                    result.push(id.clone());
                }
            }
        }
        result
    }

    /// Check if node is pressed by ANY origin.
    pub fn is_pressed(&self, node_id: &ID) -> bool {
        self.origins
            .values()
            .any(|s| s.press_path.contains(node_id))
    }

    /// Check if node is pressed by SPECIFIC origin.
    pub fn is_pressed_by(&self, origin_id: &OriginID, node_id: &ID) -> bool {
        self.origins
            .get(origin_id)
            .map(|s| s.press_path.contains(node_id))
            .unwrap_or(false)
    }

    /// Check if node is hovered by ANY origin.
    pub fn is_hovered(&self, node_id: &ID) -> bool {
        self.origins.values().any(|s| {
            s.hover_path
                .as_ref()
                .map(|p| p.contains(node_id))
                .unwrap_or(false)
        })
    }

    /// Check if node is hovered by SPECIFIC origin.
    pub fn is_hovered_by(&self, origin_id: &OriginID, node_id: &ID) -> bool {
        self.origins
            .get(origin_id)
            .and_then(|s| s.hover_path.as_ref())
            .map(|p| p.contains(node_id))
            .unwrap_or(false)
    }

    /// Get capture target for a specific origin.
    pub fn get_capture(&self, origin_id: &OriginID) -> Option<&ID> {
        self.origins.get(origin_id).and_then(|s| s.capture.as_ref())
    }

    /// Get or create origin state.
    ///
    /// This is useful for updating state for an origin that may not exist yet.
    pub fn get_or_create_origin(&mut self, origin_id: &OriginID) -> &mut OriginInteractionState {
        self.origins.entry(origin_id.clone()).or_default()
    }

    /// Get state for a specific origin (immutable).
    pub fn get_origin(&self, origin_id: &OriginID) -> Option<&OriginInteractionState> {
        self.origins.get(origin_id)
    }

    /// Get all origins that are pressing a specific node.
    pub fn origins_pressing(&self, node_id: &ID) -> Vec<&OriginID> {
        self.origins
            .iter()
            .filter(|(_, state)| state.press_path.contains(node_id))
            .map(|(id, _)| id)
            .collect()
    }

    /// Get all origins that are hovering a specific node.
    pub fn origins_hovering(&self, node_id: &ID) -> Vec<&OriginID> {
        self.origins
            .iter()
            .filter(|(_, state)| {
                state
                    .hover_path
                    .as_ref()
                    .map(|p| p.contains(node_id))
                    .unwrap_or(false)
            })
            .map(|(id, _)| id)
            .collect()
    }

    /// Count how many origins are pressing a specific node.
    ///
    /// Useful for ref-counting press state (node stays pressed while any origin presses it).
    pub fn press_count(&self, node_id: &ID) -> usize {
        self.origins
            .values()
            .filter(|s| s.press_path.contains(node_id))
            .count()
    }

    /// Count how many origins are hovering a specific node.
    pub fn hover_count(&self, node_id: &ID) -> usize {
        self.origins
            .values()
            .filter(|s| {
                s.hover_path
                    .as_ref()
                    .map(|p| p.contains(node_id))
                    .unwrap_or(false)
            })
            .count()
    }

    /// Remove an origin from tracking (e.g., when a finger lifts).
    pub fn remove_origin(&mut self, origin_id: &OriginID) -> Option<OriginInteractionState> {
        self.origins.remove(origin_id)
    }

    /// Clear all origins.
    pub fn clear(&mut self) {
        self.origins.clear();
    }

    /// Get the number of active origins.
    pub fn active_origin_count(&self) -> usize {
        self.origins.len()
    }

    // ========================================================================
    // SCENE LIFECYCLE CLEANUP
    // ========================================================================
    //
    // These methods handle cleanup when nodes are removed from the scene tree.
    // This is the ONLY interface scene_diff_apply.rs needs - it doesn't need
    // to know about hover paths, press paths, or captures internally.

    /// Remove all references to nodes in the given set.
    ///
    /// Called during scene patching when nodes are removed from the tree.
    /// This is the **single, minimal interface** for scene cleanup.
    ///
    /// # What Gets Cleaned
    ///
    /// For each origin:
    /// - Hover path: Nodes in `node_ids` are removed from the path
    /// - Press path: Nodes in `node_ids` are removed from the path
    /// - Capture: Cleared if the captured node is in `node_ids`
    ///
    /// # Invariants
    ///
    /// - Origins with no remaining state (empty paths, no capture) are NOT removed.
    ///   The origin may still have kinematics or be tracked for other reasons.
    /// - This is a mutation method (not pure) for performance during batch cleanup.
    /// - Accepts borrowed ID references to avoid unnecessary cloning.
    pub fn remove_nodes(&mut self, node_ids: &std::collections::HashSet<&ID>) {
        for origin_state in self.origins.values_mut() {
            // Clean hover path
            if let Some(ref mut hover_path) = origin_state.hover_path {
                hover_path.retain(|id| !node_ids.contains(id));
                if hover_path.is_empty() {
                    origin_state.hover_path = None;
                }
            }

            // Clean press path
            origin_state.press_path.retain(|id| !node_ids.contains(id));

            // Clean capture
            if let Some(ref capture_id) = origin_state.capture {
                if node_ids.contains(capture_id) {
                    origin_state.capture = None;
                }
            }
        }
    }
}

// ============================================================================
// PURE FUNCTIONS FOR STATE UPDATES
// ============================================================================

/// Update hover path for a specific origin (pure function).
///
/// If the origin doesn't exist, creates it with default state.
/// NOTE: Capabilities are NOT auto-derived. Host must register
/// origins with capabilities via OriginRegistry (Agent 2).
pub fn update_hover(
    state: &InteractionState,
    origin_id: &OriginID,
    hover_path: Option<Vec<ID>>,
) -> InteractionState {
    let mut new_state = state.clone();
    let origin_state = new_state.origins.entry(origin_id.clone()).or_default();
    origin_state.hover_path = hover_path;
    new_state
}

/// Update press path for a specific origin (pure function).
pub fn update_press(
    state: &InteractionState,
    origin_id: &OriginID,
    press_path: Vec<ID>,
) -> InteractionState {
    let mut new_state = state.clone();
    let origin_state = new_state.origins.entry(origin_id.clone()).or_default();
    origin_state.press_path = press_path;
    new_state
}

/// Set capture target for a specific origin (pure function).
pub fn set_capture(
    state: &InteractionState,
    origin_id: &OriginID,
    target: Option<ID>,
) -> InteractionState {
    let mut new_state = state.clone();
    let origin_state = new_state.origins.entry(origin_id.clone()).or_default();
    origin_state.capture = target;
    new_state
}

/// Clear all state for a specific origin (e.g., on pointercancel).
pub fn clear_origin(state: &InteractionState, origin_id: &OriginID) -> InteractionState {
    let mut new_state = state.clone();
    new_state.origins.remove(origin_id);
    new_state
}

/// Update position and calculate velocity for a specific origin.
pub fn update_kinematics(
    state: &InteractionState,
    origin_id: &OriginID,
    position: Point,
    timestamp: f64,
) -> InteractionState {
    let mut new_state = state.clone();
    let origin_state = new_state.origins.entry(origin_id.clone()).or_default();

    // Calculate velocity if we have previous position and time
    // Use `position` (current stored position) not `last_position` for velocity calc
    if let (Some(prev_pos), Some(prev_time)) =
        (&origin_state.position, origin_state.last_event_time)
    {
        let dt = timestamp - prev_time;
        if dt > 0.0 {
            let vx = (position.x - prev_pos.x) / dt;
            let vy = (position.y - prev_pos.y) / dt;
            origin_state.velocity = Some(Point::new(vx, vy));
        }
    }

    origin_state.last_position = origin_state.position;
    origin_state.position = Some(position);
    origin_state.last_event_time = Some(timestamp);

    new_state
}

// ============================================================================
// HOVER/PRESS TRANSITION TYPES
// ============================================================================

/// Represents a hover state change.
#[derive(Debug, Clone, PartialEq)]
pub enum HoverTransition {
    /// Origin entered this node
    Enter(ID),
    /// Origin left this node
    Leave(ID),
}

/// Represents a press state change.
#[derive(Debug, Clone, PartialEq)]
pub enum PressTransition {
    Down(ID),
    Up(ID),
}

/// Compute enter/leave events by diffing old vs new hover paths for an origin.
pub fn compute_hover_transitions(
    old_state: &InteractionState,
    new_state: &InteractionState,
    origin_id: &OriginID,
) -> Vec<HoverTransition> {
    let old_path = old_state
        .origins
        .get(origin_id)
        .and_then(|s| s.hover_path.as_ref())
        .cloned()
        .unwrap_or_default();

    let new_path = new_state
        .origins
        .get(origin_id)
        .and_then(|s| s.hover_path.as_ref())
        .cloned()
        .unwrap_or_default();

    let mut transitions = Vec::new();

    // Find leaves (in old but not in new)
    for id in &old_path {
        if !new_path.contains(id) {
            transitions.push(HoverTransition::Leave(id.clone()));
        }
    }

    // Find enters (in new but not in old)
    for id in &new_path {
        if !old_path.contains(id) {
            transitions.push(HoverTransition::Enter(id.clone()));
        }
    }

    transitions
}

/// Compute press transitions (for pointerdown/pointerup synthesis).
pub fn compute_press_transitions(
    old_state: &InteractionState,
    new_state: &InteractionState,
    origin_id: &OriginID,
) -> Vec<PressTransition> {
    let old_path = old_state
        .origins
        .get(origin_id)
        .map(|s| &s.press_path)
        .cloned()
        .unwrap_or_default();

    let new_path = new_state
        .origins
        .get(origin_id)
        .map(|s| &s.press_path)
        .cloned()
        .unwrap_or_default();

    let mut transitions = Vec::new();

    // Find ups (in old but not in new)
    for id in &old_path {
        if !new_path.contains(id) {
            transitions.push(PressTransition::Up(id.clone()));
        }
    }

    // Find downs (in new but not in old)
    for id in &new_path {
        if !old_path.contains(id) {
            transitions.push(PressTransition::Down(id.clone()));
        }
    }

    transitions
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------------
    // OriginInteractionState Tests
    // ------------------------------------------------------------------------

    #[test]
    fn test_origin_interaction_state_default() {
        let state = OriginInteractionState::default();
        assert!(state.hover_path.is_none());
        assert!(state.press_path.is_empty());
        assert!(state.capture.is_none());
        assert!(state.position.is_none());
        assert!(state.velocity.is_none());
    }

    #[test]
    fn test_origin_interaction_state_with_mouse_capabilities() {
        // Host provides MOUSE capabilities (has hover)
        let state = OriginInteractionState::with_capabilities(OriginCapabilities::MOUSE);
        assert!(state.hover_path.is_some());
        assert!(state.hover_path.as_ref().unwrap().is_empty());
    }

    #[test]
    fn test_origin_interaction_state_with_touch_capabilities() {
        // Host provides TOUCH capabilities (no hover)
        let state = OriginInteractionState::with_capabilities(OriginCapabilities::TOUCH);
        assert!(state.hover_path.is_none());
    }

    #[test]
    fn test_origin_interaction_state_with_pen_capabilities() {
        // Host provides PEN capabilities (has hover)
        let state = OriginInteractionState::with_capabilities(OriginCapabilities::PEN);
        assert!(state.hover_path.is_some());
        assert!(state.hover_path.as_ref().unwrap().is_empty());
    }

    #[test]
    fn test_origin_interaction_state_with_keyboard_capabilities() {
        // Host provides KEYBOARD capabilities (no hover)
        let state = OriginInteractionState::with_capabilities(OriginCapabilities::KEYBOARD);
        assert!(state.hover_path.is_none());
    }

    #[test]
    fn test_origin_interaction_state_helper_methods() {
        let mut state = OriginInteractionState::default();

        // Initially not pressing or hovering
        assert!(!state.is_pressing());
        assert!(!state.is_hovering());
        assert!(!state.has_capture());
        assert!(state.hover_target().is_none());
        assert!(state.press_target().is_none());

        // Add press path
        state.press_path = vec!["root".to_string(), "button".to_string()];
        assert!(state.is_pressing());
        assert_eq!(state.press_target(), Some(&"button".to_string()));

        // Add hover path
        state.hover_path = Some(vec!["root".to_string(), "text".to_string()]);
        assert!(state.is_hovering());
        assert_eq!(state.hover_target(), Some(&"text".to_string()));

        // Add capture
        state.capture = Some("captured-node".to_string());
        assert!(state.has_capture());
    }

    // ------------------------------------------------------------------------
    // InteractionState Tests
    // ------------------------------------------------------------------------

    #[test]
    fn test_interaction_state_new_is_empty() {
        let state = InteractionState::new();
        assert!(state.origins.is_empty());
        assert_eq!(state.active_origin_count(), 0);
    }

    #[test]
    fn test_interaction_state_multiple_origins() {
        let mut state = InteractionState::new();
        let origin1 = OriginID::new("origin-1");
        let origin2 = OriginID::new("origin-2");

        state.origins.insert(
            origin1.clone(),
            OriginInteractionState {
                hover_path: Some(vec!["node-a".to_string()]),
                ..Default::default()
            },
        );
        state.origins.insert(
            origin2.clone(),
            OriginInteractionState {
                hover_path: Some(vec!["node-b".to_string()]),
                ..Default::default()
            },
        );

        assert_eq!(state.origins.len(), 2);
        assert_eq!(state.active_origin_count(), 2);
    }

    #[test]
    fn test_interaction_state_origins_independent() {
        let mut state = InteractionState::new();
        let origin1 = OriginID::new("origin-1");
        let origin2 = OriginID::new("origin-2");

        // Set up origin1
        state.origins.insert(
            origin1.clone(),
            OriginInteractionState {
                press_path: vec!["button-a".to_string()],
                ..Default::default()
            },
        );

        // Set up origin2
        state.origins.insert(
            origin2.clone(),
            OriginInteractionState {
                press_path: vec!["button-b".to_string()],
                ..Default::default()
            },
        );

        // Mutating origin1 doesn't affect origin2
        state.origins.get_mut(&origin1).unwrap().press_path = vec!["button-c".to_string()];

        assert_eq!(
            state.origins.get(&origin1).unwrap().press_path,
            vec!["button-c".to_string()]
        );
        assert_eq!(
            state.origins.get(&origin2).unwrap().press_path,
            vec!["button-b".to_string()]
        );
    }

    #[test]
    fn test_all_hovered_nodes_aggregates() {
        let mut state = InteractionState::new();

        state.origins.insert(
            OriginID::new("origin-1"),
            OriginInteractionState {
                hover_path: Some(vec![
                    "root".to_string(),
                    "panel".to_string(),
                    "button-a".to_string(),
                ]),
                ..Default::default()
            },
        );
        state.origins.insert(
            OriginID::new("origin-2"),
            OriginInteractionState {
                hover_path: Some(vec![
                    "root".to_string(),
                    "panel".to_string(),
                    "button-b".to_string(),
                ]),
                ..Default::default()
            },
        );

        let hovered = state.all_hovered_nodes();
        // Should contain: root, panel, button-a, button-b (deduplicated)
        assert!(hovered.contains(&"root".to_string()));
        assert!(hovered.contains(&"panel".to_string()));
        assert!(hovered.contains(&"button-a".to_string()));
        assert!(hovered.contains(&"button-b".to_string()));
        assert_eq!(hovered.len(), 4); // Deduplicated
    }

    #[test]
    fn test_all_pressed_nodes_aggregates() {
        let mut state = InteractionState::new();

        state.origins.insert(
            OriginID::new("origin-1"),
            OriginInteractionState {
                press_path: vec!["root".to_string(), "button-a".to_string()],
                ..Default::default()
            },
        );
        state.origins.insert(
            OriginID::new("origin-2"),
            OriginInteractionState {
                press_path: vec!["root".to_string(), "button-b".to_string()],
                ..Default::default()
            },
        );

        let pressed = state.all_pressed_nodes();
        assert!(pressed.contains(&"root".to_string()));
        assert!(pressed.contains(&"button-a".to_string()));
        assert!(pressed.contains(&"button-b".to_string()));
        assert_eq!(pressed.len(), 3); // Deduplicated
    }

    #[test]
    fn test_is_pressed_any_origin() {
        let mut state = InteractionState::new();

        state.origins.insert(
            OriginID::new("origin-1"),
            OriginInteractionState {
                press_path: vec!["button-a".to_string()],
                ..Default::default()
            },
        );

        assert!(state.is_pressed(&"button-a".to_string()));
        assert!(!state.is_pressed(&"button-b".to_string()));
    }

    #[test]
    fn test_is_pressed_by_specific_origin() {
        let mut state = InteractionState::new();
        let origin1 = OriginID::new("origin-1");
        let origin2 = OriginID::new("origin-2");

        state.origins.insert(
            origin1.clone(),
            OriginInteractionState {
                press_path: vec!["button-a".to_string()],
                ..Default::default()
            },
        );
        state.origins.insert(
            origin2.clone(),
            OriginInteractionState {
                press_path: vec!["button-b".to_string()],
                ..Default::default()
            },
        );

        // origin1 presses button-a, not button-b
        assert!(state.is_pressed_by(&origin1, &"button-a".to_string()));
        assert!(!state.is_pressed_by(&origin1, &"button-b".to_string()));

        // origin2 presses button-b, not button-a
        assert!(!state.is_pressed_by(&origin2, &"button-a".to_string()));
        assert!(state.is_pressed_by(&origin2, &"button-b".to_string()));
    }

    #[test]
    fn test_is_hovered_any_origin() {
        let mut state = InteractionState::new();

        state.origins.insert(
            OriginID::new("origin-1"),
            OriginInteractionState {
                hover_path: Some(vec!["node-a".to_string()]),
                ..Default::default()
            },
        );

        assert!(state.is_hovered(&"node-a".to_string()));
        assert!(!state.is_hovered(&"node-b".to_string()));
    }

    #[test]
    fn test_is_hovered_by_specific_origin() {
        let mut state = InteractionState::new();
        let origin1 = OriginID::new("origin-1");
        let origin2 = OriginID::new("origin-2");

        state.origins.insert(
            origin1.clone(),
            OriginInteractionState {
                hover_path: Some(vec!["node-a".to_string()]),
                ..Default::default()
            },
        );
        state.origins.insert(
            origin2.clone(),
            OriginInteractionState {
                hover_path: Some(vec!["node-b".to_string()]),
                ..Default::default()
            },
        );

        assert!(state.is_hovered_by(&origin1, &"node-a".to_string()));
        assert!(!state.is_hovered_by(&origin1, &"node-b".to_string()));
        assert!(!state.is_hovered_by(&origin2, &"node-a".to_string()));
        assert!(state.is_hovered_by(&origin2, &"node-b".to_string()));
    }

    #[test]
    fn test_two_origins_hover_different_nodes() {
        let mut state = InteractionState::new();

        state.origins.insert(
            OriginID::new("origin-1"),
            OriginInteractionState {
                hover_path: Some(vec!["button-a".to_string()]),
                ..Default::default()
            },
        );
        state.origins.insert(
            OriginID::new("origin-2"),
            OriginInteractionState {
                hover_path: Some(vec!["button-b".to_string()]),
                ..Default::default()
            },
        );

        // Both buttons are hovered (by different origins)
        assert!(state.is_hovered(&"button-a".to_string()));
        assert!(state.is_hovered(&"button-b".to_string()));
        assert_eq!(state.hover_count(&"button-a".to_string()), 1);
        assert_eq!(state.hover_count(&"button-b".to_string()), 1);
    }

    #[test]
    fn test_two_origins_press_same_node() {
        let mut state = InteractionState::new();

        // Both origins pressing the same button
        state.origins.insert(
            OriginID::new("origin-1"),
            OriginInteractionState {
                press_path: vec!["submit-btn".to_string()],
                ..Default::default()
            },
        );
        state.origins.insert(
            OriginID::new("origin-2"),
            OriginInteractionState {
                press_path: vec!["submit-btn".to_string()],
                ..Default::default()
            },
        );

        // Node is pressed
        assert!(state.is_pressed(&"submit-btn".to_string()));

        // Ref-count is 2 (two origins pressing)
        assert_eq!(state.press_count(&"submit-btn".to_string()), 2);

        // Both origins are pressing it
        let pressing_origins = state.origins_pressing(&"submit-btn".to_string());
        assert_eq!(pressing_origins.len(), 2);
    }

    #[test]
    fn test_get_capture() {
        let mut state = InteractionState::new();
        let origin = OriginID::new("origin-1");

        state.origins.insert(
            origin.clone(),
            OriginInteractionState {
                capture: Some("captured-node".to_string()),
                ..Default::default()
            },
        );

        assert_eq!(
            state.get_capture(&origin),
            Some(&"captured-node".to_string())
        );
        assert_eq!(state.get_capture(&OriginID::new("nonexistent")), None);
    }

    #[test]
    fn test_get_or_create_origin() {
        let mut state = InteractionState::new();
        let origin = OriginID::new("origin-1");

        // Origin doesn't exist yet
        assert!(state.get_origin(&origin).is_none());

        // get_or_create creates it
        let origin_state = state.get_or_create_origin(&origin);
        origin_state.press_path = vec!["button".to_string()];

        // Now it exists
        assert!(state.get_origin(&origin).is_some());
        assert_eq!(
            state.get_origin(&origin).unwrap().press_path,
            vec!["button".to_string()]
        );
    }

    #[test]
    fn test_remove_origin() {
        let mut state = InteractionState::new();
        let origin = OriginID::new("origin-1");

        state.origins.insert(
            origin.clone(),
            OriginInteractionState {
                press_path: vec!["button".to_string()],
                ..Default::default()
            },
        );

        assert_eq!(state.active_origin_count(), 1);

        let removed = state.remove_origin(&origin);
        assert!(removed.is_some());
        assert_eq!(removed.unwrap().press_path, vec!["button".to_string()]);
        assert_eq!(state.active_origin_count(), 0);
    }

    #[test]
    fn test_clear() {
        let mut state = InteractionState::new();

        state
            .origins
            .insert(OriginID::new("origin-1"), Default::default());
        state
            .origins
            .insert(OriginID::new("origin-2"), Default::default());
        state
            .origins
            .insert(OriginID::new("origin-3"), Default::default());

        assert_eq!(state.active_origin_count(), 3);

        state.clear();

        assert_eq!(state.active_origin_count(), 0);
        assert!(state.origins.is_empty());
    }

    #[test]
    fn test_serialization_roundtrip() {
        let mut state = InteractionState::new();
        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");

        // Use with_capabilities to create properly-initialized state
        state.origins.insert(
            origin_a.clone(),
            OriginInteractionState::with_capabilities(OriginCapabilities::KEYBOARD),
        );

        let mut pointer_state =
            OriginInteractionState::with_capabilities(OriginCapabilities::MOUSE);
        pointer_state.hover_path = Some(vec!["root".to_string(), "button".to_string()]);
        pointer_state.press_path = vec!["button".to_string()];
        pointer_state.capture = Some("button".to_string());
        pointer_state.position = Some(Point::new(100.0, 200.0));
        pointer_state.velocity = Some(Point::new(5.0, -3.0));
        pointer_state.last_position = Some(Point::new(95.0, 203.0));
        pointer_state.last_event_time = Some(1234567890.0);

        state.origins.insert(origin_b.clone(), pointer_state);

        // Serialize
        let json = serde_json::to_string(&state).expect("serialize");

        // Verify JSON uses string keys (from origin_map_serde)
        assert!(json.contains("origin-a") || json.contains("origin-b"));

        // Deserialize
        let restored: InteractionState = serde_json::from_str(&json).expect("deserialize");

        // Verify
        assert_eq!(restored.active_origin_count(), 2);

        let keyboard_state = restored.get_origin(&origin_a).unwrap();
        assert!(keyboard_state.hover_path.is_none());

        let pointer_state = restored.get_origin(&origin_b).unwrap();
        assert_eq!(
            pointer_state.hover_path,
            Some(vec!["root".to_string(), "button".to_string()])
        );
        assert_eq!(pointer_state.press_path, vec!["button".to_string()]);
        assert_eq!(pointer_state.capture, Some("button".to_string()));
        assert_eq!(pointer_state.position, Some(Point::new(100.0, 200.0)));
    }

    #[test]
    fn test_origins_hovering_and_pressing() {
        let mut state = InteractionState::new();

        state.origins.insert(
            OriginID::new("origin-1"),
            OriginInteractionState {
                hover_path: Some(vec!["shared-node".to_string()]),
                press_path: vec!["shared-node".to_string()],
                ..Default::default()
            },
        );
        state.origins.insert(
            OriginID::new("origin-2"),
            OriginInteractionState {
                hover_path: Some(vec!["shared-node".to_string()]),
                press_path: vec![],
                ..Default::default()
            },
        );
        state.origins.insert(
            OriginID::new("origin-3"),
            OriginInteractionState {
                hover_path: None, // This origin doesn't hover
                press_path: vec!["shared-node".to_string()],
                ..Default::default()
            },
        );

        // 2 origins hovering (origin-1 and origin-2), origin-3 doesn't hover
        let hovering = state.origins_hovering(&"shared-node".to_string());
        assert_eq!(hovering.len(), 2);

        // 2 origins pressing (origin-1 and origin-3)
        let pressing = state.origins_pressing(&"shared-node".to_string());
        assert_eq!(pressing.len(), 2);
    }
}

// ============================================================================
// Pure Function Tests
// ============================================================================

#[cfg(test)]
mod function_tests {
    use super::*;

    #[test]
    fn test_update_hover_only_affects_specified_origin() {
        let mut state = InteractionState::new();
        let origin1 = OriginID::new("origin-1");
        let origin2 = OriginID::new("origin-2");

        // Set up origin2 with existing hover
        state.origins.insert(
            origin2.clone(),
            OriginInteractionState {
                hover_path: Some(vec!["existing".to_string()]),
                ..Default::default()
            },
        );

        // Update origin1's hover
        let new_state = update_hover(&state, &origin1, Some(vec!["node-a".to_string()]));

        // Origin1 should have new hover
        assert_eq!(
            new_state.origins.get(&origin1).unwrap().hover_path,
            Some(vec!["node-a".to_string()])
        );
        // Origin2 should be unchanged
        assert_eq!(
            new_state.origins.get(&origin2).unwrap().hover_path,
            Some(vec!["existing".to_string()])
        );
    }

    #[test]
    fn test_update_hover_creates_origin() {
        let state = InteractionState::new();
        let origin1 = OriginID::new("origin-1");
        let origin2 = OriginID::new("origin-2");

        // Update hover for origins that don't exist
        let state = update_hover(&state, &origin1, None);
        let state = update_hover(&state, &origin2, None);

        // Verify origins exist
        assert!(state.origins.contains_key(&origin1));
        assert!(state.origins.contains_key(&origin2));
    }

    #[test]
    fn test_update_press_only_affects_specified_origin() {
        let mut state = InteractionState::new();
        let origin1 = OriginID::new("origin-1");
        let origin2 = OriginID::new("origin-2");

        state.origins.insert(
            origin2.clone(),
            OriginInteractionState {
                press_path: vec!["button-b".to_string()],
                ..Default::default()
            },
        );

        let new_state = update_press(&state, &origin1, vec!["button-a".to_string()]);

        assert_eq!(
            new_state.origins.get(&origin1).unwrap().press_path,
            vec!["button-a".to_string()]
        );
        assert_eq!(
            new_state.origins.get(&origin2).unwrap().press_path,
            vec!["button-b".to_string()]
        );
    }

    #[test]
    fn test_set_capture_only_affects_specified_origin() {
        let mut state = InteractionState::new();
        let origin1 = OriginID::new("origin-1");
        let origin2 = OriginID::new("origin-2");

        state.origins.insert(
            origin2.clone(),
            OriginInteractionState {
                capture: Some("captured-b".to_string()),
                ..Default::default()
            },
        );

        let new_state = set_capture(&state, &origin1, Some("captured-a".to_string()));

        assert_eq!(
            new_state.origins.get(&origin1).unwrap().capture,
            Some("captured-a".to_string())
        );
        assert_eq!(
            new_state.origins.get(&origin2).unwrap().capture,
            Some("captured-b".to_string())
        );
    }

    #[test]
    fn test_clear_origin_removes_only_that_origin() {
        let mut state = InteractionState::new();
        let origin1 = OriginID::new("origin-1");
        let origin2 = OriginID::new("origin-2");

        state.origins.insert(
            origin1.clone(),
            OriginInteractionState {
                press_path: vec!["a".to_string()],
                ..Default::default()
            },
        );
        state.origins.insert(
            origin2.clone(),
            OriginInteractionState {
                press_path: vec!["b".to_string()],
                ..Default::default()
            },
        );

        let new_state = clear_origin(&state, &origin1);

        assert!(new_state.origins.get(&origin1).is_none());
        assert!(new_state.origins.get(&origin2).is_some());
    }

    #[test]
    fn test_clear_origin_leaves_other_origins_intact() {
        let mut state = InteractionState::new();
        let origin1 = OriginID::new("origin-1");
        let origin2 = OriginID::new("origin-2");
        let origin3 = OriginID::new("origin-3");

        state.origins.insert(
            origin1.clone(),
            OriginInteractionState {
                hover_path: Some(vec!["node1".to_string()]),
                press_path: vec!["btn1".to_string()],
                capture: Some("cap1".to_string()),
                ..Default::default()
            },
        );
        state.origins.insert(
            origin2.clone(),
            OriginInteractionState {
                press_path: vec!["btn2".to_string()],
                ..Default::default()
            },
        );
        state.origins.insert(
            origin3.clone(),
            OriginInteractionState {
                press_path: vec!["btn3".to_string()],
                ..Default::default()
            },
        );

        // Clear origin2
        let new_state = clear_origin(&state, &origin2);

        // origin1 should be completely intact
        let o1 = new_state.origins.get(&origin1).unwrap();
        assert_eq!(o1.hover_path, Some(vec!["node1".to_string()]));
        assert_eq!(o1.press_path, vec!["btn1".to_string()]);
        assert_eq!(o1.capture, Some("cap1".to_string()));

        // origin2 should be gone
        assert!(new_state.origins.get(&origin2).is_none());

        // origin3 should be intact
        let o3 = new_state.origins.get(&origin3).unwrap();
        assert_eq!(o3.press_path, vec!["btn3".to_string()]);
    }

    #[test]
    fn test_update_kinematics_calculates_velocity() {
        let state = InteractionState::new();
        let origin = OriginID::new("origin-1");

        // First position at t=0
        let state = update_kinematics(&state, &origin, Point::new(0.0, 0.0), 0.0);

        // Second position at t=100ms, moved 100px right and 50px down
        let state = update_kinematics(&state, &origin, Point::new(100.0, 50.0), 100.0);

        let velocity = state
            .origins
            .get(&origin)
            .unwrap()
            .velocity
            .clone()
            .unwrap();
        assert!((velocity.x - 1.0).abs() < 0.001); // 100px / 100ms = 1 px/ms
        assert!((velocity.y - 0.5).abs() < 0.001); // 50px / 100ms = 0.5 px/ms
    }

    #[test]
    fn test_update_kinematics_tracks_position_history() {
        let state = InteractionState::new();
        let origin = OriginID::new("origin-1");

        let state = update_kinematics(&state, &origin, Point::new(10.0, 20.0), 0.0);
        let state = update_kinematics(&state, &origin, Point::new(30.0, 40.0), 50.0);

        let origin_state = state.origins.get(&origin).unwrap();
        assert_eq!(origin_state.position, Some(Point::new(30.0, 40.0)));
        assert_eq!(origin_state.last_position, Some(Point::new(10.0, 20.0)));
        assert_eq!(origin_state.last_event_time, Some(50.0));
    }

    #[test]
    fn test_compute_hover_transitions_detects_enter() {
        let old_state = InteractionState::new();
        let origin = OriginID::new("origin-1");

        let new_state = update_hover(&old_state, &origin, Some(vec!["node-a".to_string()]));

        let transitions = compute_hover_transitions(&old_state, &new_state, &origin);
        assert!(transitions.contains(&HoverTransition::Enter("node-a".to_string())));
    }

    #[test]
    fn test_compute_hover_transitions_detects_leave() {
        let origin = OriginID::new("origin-1");
        let old_state = update_hover(
            &InteractionState::new(),
            &origin,
            Some(vec!["node-a".to_string()]),
        );
        let new_state = update_hover(&old_state, &origin, Some(vec![]));

        let transitions = compute_hover_transitions(&old_state, &new_state, &origin);
        assert!(transitions.contains(&HoverTransition::Leave("node-a".to_string())));
    }

    #[test]
    fn test_compute_press_transitions_detects_down() {
        let old_state = InteractionState::new();
        let origin = OriginID::new("origin-1");

        let new_state = update_press(&old_state, &origin, vec!["button".to_string()]);

        let transitions = compute_press_transitions(&old_state, &new_state, &origin);
        assert!(transitions.contains(&PressTransition::Down("button".to_string())));
    }

    #[test]
    fn test_compute_press_transitions_detects_up() {
        let origin = OriginID::new("origin-1");
        let old_state = update_press(
            &InteractionState::new(),
            &origin,
            vec!["button".to_string()],
        );
        let new_state = update_press(&old_state, &origin, vec![]);

        let transitions = compute_press_transitions(&old_state, &new_state, &origin);
        assert!(transitions.contains(&PressTransition::Up("button".to_string())));
    }

    #[test]
    fn test_functions_are_pure_no_mutation() {
        let original = InteractionState::new();
        let origin = OriginID::new("origin-1");

        let _ = update_hover(&original, &origin, Some(vec!["test".to_string()]));

        // Original should be unchanged
        assert!(original.origins.is_empty());
    }

    #[test]
    fn test_hover_transitions_handles_no_previous_state() {
        let old_state = InteractionState::new();
        let new_state = InteractionState::new();
        let origin = OriginID::new("nonexistent"); // Non-existent origin

        let transitions = compute_hover_transitions(&old_state, &new_state, &origin);
        assert!(transitions.is_empty());
    }

    #[test]
    fn test_hover_transitions_enter_and_leave_same_call() {
        let origin = OriginID::new("origin-1");
        let old_state = update_hover(
            &InteractionState::new(),
            &origin,
            Some(vec!["node-a".to_string(), "node-b".to_string()]),
        );
        let new_state = update_hover(
            &old_state,
            &origin,
            Some(vec!["node-b".to_string(), "node-c".to_string()]),
        );

        let transitions = compute_hover_transitions(&old_state, &new_state, &origin);

        // node-a should be a leave
        assert!(transitions.contains(&HoverTransition::Leave("node-a".to_string())));
        // node-c should be an enter
        assert!(transitions.contains(&HoverTransition::Enter("node-c".to_string())));
        // node-b should not appear (unchanged)
        assert!(!transitions.contains(&HoverTransition::Enter("node-b".to_string())));
        assert!(!transitions.contains(&HoverTransition::Leave("node-b".to_string())));
    }

    #[test]
    fn test_press_transitions_multiple_nodes() {
        let origin = OriginID::new("origin-1");
        let old_state = update_press(
            &InteractionState::new(),
            &origin,
            vec!["btn-1".to_string(), "btn-2".to_string()],
        );
        let new_state = update_press(
            &old_state,
            &origin,
            vec!["btn-2".to_string(), "btn-3".to_string()],
        );

        let transitions = compute_press_transitions(&old_state, &new_state, &origin);

        assert!(transitions.contains(&PressTransition::Up("btn-1".to_string())));
        assert!(transitions.contains(&PressTransition::Down("btn-3".to_string())));
        assert!(!transitions.contains(&PressTransition::Up("btn-2".to_string())));
        assert!(!transitions.contains(&PressTransition::Down("btn-2".to_string())));
    }
}
