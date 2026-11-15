//! crates/composition-engine-core/src/kernel/routing.rs
//!
//! Physics-correct routing state: Map<OriginID, TargetID>
//!
//! This module replaces the Society-polluted singleton `focused_id: Option<ID>`
//! with Physics-correct routing that supports multiple input origins.
//!
//! # Background (MACP Converged Truth)
//!
//! Four AI agents performed adversarial case testing and converged on
//! 4 Irreducible Primitives of Input Physics:
//!
//! 1. **Discrete Event** - occurrence with payload and temporal anchor
//! 2. **Origin Identity** - immutable provenance tag (who/what produced the event)
//! 3. **Routing State** - Map<OriginID, TargetID> (NOT a singleton)
//! 4. **Routing Logic** - deterministic function: (Event + Origin + State) → Destination(s)
//!
//! # Why This Matters
//!
//! Society (desktop GUI convention): One keyboard, one mouse, one focus
//! Physics (universal truth): Multiple input origins, multiple routes
//!
//! The singleton model breaks for:
//! - Multi-touch (each finger is an independent origin)
//! - VR controllers (left hand, right hand)
//! - Collaborative editing (Alice's cursor, Bob's cursor)
//! - Accessibility (eye tracker + keyboard simultaneously)
//! - Piano apps (multiple simultaneous touch points)
//! - Game controllers (multiple buttons/sticks)
//!
//! # Non-Negotiable Invariants
//!
//! 1. Routes map is NEVER modified in place - all functions return NEW state
//! 2. OriginID format is ALWAYS "type:identifier" (e.g., "pointer:1", "touch:3")
//! 3. Empty routes map means no active input sources
//! 4. Multiple origins CAN route to the same target (multi-touch on same button)
//! 5. Routing functions ONLY affect the specified origin's route
//!
//! # Security Considerations
//!
//! - OriginID strings are user-influenced (come from browser events)
//! - Validate format before trusting origin type checks
//! - Do not use OriginID in security-sensitive decisions without validation
//!
//! # AI Directive
//!
//! The extensive documentation in this codebase is a critical design feature.
//! You are FORBIDDEN from simplifying or removing it. Your mandate is to
//! MAINTAIN and EXTEND this level of meticulous detail.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::origin_map_serde;
use super::ID;

// ============================================================================
// Origin Identity (Physics Primitive 2)
// ============================================================================

/// Origin identity - WHO/WHAT produced an event.
///
/// **PHYSICS LAYER**: This is an OPAQUE identifier. The kernel knows NOTHING
/// about "keyboards", "pointers", or device types. The string format is
/// determined by the HOST (Society layer), not the kernel.
///
/// This is the immutable provenance tag that identifies the source of input.
/// Different origins can have independent routing targets simultaneously.
///
/// # Examples
///
/// ```
/// use composition_engine_core::kernel::routing::OriginID;
///
/// // Create from any string - kernel doesn't interpret
/// let origin = OriginID::new("my-custom-origin");
/// assert_eq!(origin.id, "my-custom-origin");
///
/// // Hosts are free to use any convention
/// let host_origin = OriginID::new("keyboard:0");
/// assert_eq!(host_origin.id, "keyboard:0");
/// ```
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OriginID {
    /// Unique identifier string. Opaque to the kernel.
    /// Defaults to empty string - no Society assumptions about "keyboard:0" etc.
    #[serde(default)]
    pub id: String,
}

impl OriginID {
    /// Create an OriginID from any string.
    ///
    /// The string is opaque to the kernel - hosts determine conventions.
    pub fn new(id: impl Into<String>) -> Self {
        Self { id: id.into() }
    }
}

// ============================================================================
// Origin Capabilities (Host-provided via Registry)
// ============================================================================

/// Capabilities that vary by origin type.
///
/// **PHYSICS LAYER**: These capabilities are provided by the HOST via an
/// OriginRegistry (see Agent 2's work). The kernel does NOT derive capabilities
/// from OriginID strings - that would be Society-level knowledge.
///
/// Hosts register origins with their capabilities when they create them.
/// The kernel just stores and queries these opaque capability flags.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginCapabilities {
    /// Whether this origin supports hover (cursor present without press).
    pub has_hover: bool,
    /// Whether this origin reports pressure data.
    pub has_pressure: bool,
    /// Whether this origin reports tilt/angle data.
    pub has_tilt: bool,
}

impl OriginCapabilities {
    /// No capabilities (unknown device).
    pub const NONE: Self = Self {
        has_hover: false,
        has_pressure: false,
        has_tilt: false,
    };

    /// Mouse capabilities: hover only.
    pub const MOUSE: Self = Self {
        has_hover: true,
        has_pressure: false,
        has_tilt: false,
    };

    /// Touch capabilities: none (finger must contact screen).
    pub const TOUCH: Self = Self {
        has_hover: false,
        has_pressure: false,
        has_tilt: false,
    };

    /// Pen capabilities: hover, pressure, and tilt.
    pub const PEN: Self = Self {
        has_hover: true,
        has_pressure: true,
        has_tilt: true,
    };

    /// Keyboard capabilities: none (no spatial input).
    pub const KEYBOARD: Self = Self {
        has_hover: false,
        has_pressure: false,
        has_tilt: false,
    };

    /// Controller capabilities: pressure (analog triggers).
    pub const CONTROLLER: Self = Self {
        has_hover: false,
        has_pressure: true,
        has_tilt: false,
    };
}

// ============================================================================
// Routing Scope (analogous to FocusScope)
// ============================================================================

/// Routing scope configuration.
///
/// Scopes allow grouping routable nodes with special behavior:
/// - Trap routing: Routes cannot escape the scope
/// - Roving tabindex: Arrow navigation within scope
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RoutingScope {
    /// Unique identifier for this scope
    pub id: ID,
    /// If true, routing cannot escape this scope
    pub trap_routing: bool,
    /// If true, arrow keys navigate within scope (roving tabindex pattern)
    pub roving_tabindex: bool,
}

// ============================================================================
// Routing State (Physics Primitive 3)
// ============================================================================

/// Routing state - Map<OriginID, TargetID>
///
/// This replaces the Society-polluted singleton `focused_id: Option<ID>`.
/// Each input origin has its own independent route to a target node.
///
/// # Examples
///
/// ```
/// use composition_engine_core::kernel::routing::{OriginID, RoutingState};
///
/// let mut state = RoutingState::default();
///
/// // Multiple origins can route independently
/// state.routes.insert(OriginID::new("origin-1"), "text-input-1".to_string());
/// state.routes.insert(OriginID::new("origin-2"), "button-a".to_string());
/// state.routes.insert(OriginID::new("origin-3"), "button-b".to_string());
///
/// assert_eq!(state.routes.len(), 3);
/// ```
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct RoutingState {
    /// Maps each input origin to its current target node.
    ///
    /// Multiple origins can:
    /// - Route to the same target (two fingers on one button)
    /// - Route to different targets (multi-selection)
    /// - Have no route (origin not currently active)
    #[serde(with = "origin_map_serde", default)]
    pub routes: HashMap<OriginID, ID>,

    /// Nodes that can receive routing (focusable in a11y terms).
    ///
    /// This is the universe of valid route targets.
    pub routable_nodes: Vec<ID>,

    /// Routing scopes for trapping and roving tabindex behavior.
    pub scopes: HashMap<ID, RoutingScope>,

    /// Tab order for keyboard navigation.
    ///
    /// Sequential navigation (Tab/Shift+Tab) follows this order.
    pub tab_order: Vec<ID>,
}

impl RoutingState {
    /// Create a new empty routing state.
    pub fn new() -> Self {
        Self::default()
    }

    /// Get the current target for an origin.
    pub fn get_target(&self, origin: &OriginID) -> Option<&ID> {
        self.routes.get(origin)
    }

    /// Check if an origin has a route.
    pub fn has_route(&self, origin: &OriginID) -> bool {
        self.routes.contains_key(origin)
    }

    /// Get all currently routed origins.
    pub fn active_origins(&self) -> impl Iterator<Item = &OriginID> {
        self.routes.keys()
    }

    /// Get the number of active routes.
    pub fn active_route_count(&self) -> usize {
        self.routes.len()
    }

    /// Check if a node is routable.
    pub fn is_routable(&self, node_id: &ID) -> bool {
        self.routable_nodes.contains(node_id)
    }
}

// ============================================================================
// Routing Functions (Physics Primitive 4 - Routing Logic)
// ============================================================================
//
// Pure functional routing operations. Each function:
// - Takes origin_id explicitly (no singleton assumption)
// - Returns a NEW RoutingState (no mutation)
// - Only affects the specified origin's route

use super::focus::{ArrowDirection, FocusDirection};
use super::scene::{find_node, path_to_root};
use super::typed_index::TypedSceneIndex;
use super::types::{Role, SceneNode};

/// Set routing for a specific origin (Physics-correct).
///
/// Creates a new RoutingState with the specified origin routing to the target.
/// Other origins' routes remain unchanged.
///
/// # Arguments
/// * `state` - Current routing state
/// * `origin_id` - The input origin (e.g., keyboard, touch finger)
/// * `target_id` - The node to route to
///
/// # Returns
/// New RoutingState with the route added/updated
///
/// # Example
/// ```
/// use composition_engine_core::kernel::routing::{OriginID, RoutingState, set_routing};
///
/// let state = RoutingState::new();
/// let origin = OriginID::new("my-origin");
/// let new_state = set_routing(&state, &origin, &"text-input".to_string());
/// assert_eq!(new_state.get_target(&origin), Some(&"text-input".to_string()));
/// ```
pub fn set_routing(state: &RoutingState, origin_id: &OriginID, target_id: &ID) -> RoutingState {
    // Verify target is routable (if we have routable_nodes populated)
    if !state.routable_nodes.is_empty() && !state.routable_nodes.contains(target_id) {
        return state.clone();
    }

    let mut new_routes = state.routes.clone();
    new_routes.insert(origin_id.clone(), target_id.clone());

    RoutingState {
        routes: new_routes,
        routable_nodes: state.routable_nodes.clone(),
        scopes: state.scopes.clone(),
        tab_order: state.tab_order.clone(),
    }
}

/// Clear routing for a specific origin.
///
/// Creates a new RoutingState with the specified origin's route removed.
/// Other origins' routes remain unchanged.
///
/// # Arguments
/// * `state` - Current routing state
/// * `origin_id` - The input origin to clear
///
/// # Returns
/// New RoutingState with the route removed
///
/// # Example
/// ```
/// use composition_engine_core::kernel::routing::{OriginID, RoutingState, set_routing, clear_routing};
///
/// let state = RoutingState::new();
/// let origin = OriginID::new("my-origin");
/// let state = set_routing(&state, &origin, &"text-input".to_string());
/// let state = clear_routing(&state, &origin);
/// assert_eq!(state.get_target(&origin), None);
/// ```
pub fn clear_routing(state: &RoutingState, origin_id: &OriginID) -> RoutingState {
    let mut new_routes = state.routes.clone();
    new_routes.remove(origin_id);

    RoutingState {
        routes: new_routes,
        routable_nodes: state.routable_nodes.clone(),
        scopes: state.scopes.clone(),
        tab_order: state.tab_order.clone(),
    }
}

/// Get current routing target for an origin.
///
/// Returns the node ID that the specified origin is currently routed to,
/// or None if the origin has no route.
///
/// # Arguments
/// * `state` - Current routing state
/// * `origin_id` - The input origin to query
///
/// # Returns
/// Optional reference to the target ID
pub fn get_routing<'a>(state: &'a RoutingState, origin_id: &OriginID) -> Option<&'a ID> {
    state.routes.get(origin_id)
}

/// Move routing in a direction for a specific origin.
///
/// Implements Tab/Shift+Tab navigation for the specified origin.
/// Other origins' routes remain unchanged.
///
/// # Arguments
/// * `state` - Current routing state
/// * `origin_id` - The input origin to move
/// * `direction` - Forward (Tab) or Backward (Shift+Tab)
///
/// # Returns
/// New RoutingState with the origin's route updated
///
/// # Example
/// ```
/// use composition_engine_core::kernel::routing::{OriginID, RoutingState, set_routing, move_routing};
/// use composition_engine_core::kernel::focus::FocusDirection;
///
/// let mut state = RoutingState::new();
/// state.tab_order = vec!["btn1".to_string(), "btn2".to_string(), "btn3".to_string()];
/// state.routable_nodes = state.tab_order.clone();
///
/// // Move forward from first node
/// let origin = OriginID::new("my-origin");
/// let state = set_routing(&state, &origin, &"btn1".to_string());
/// let state = move_routing(&state, &origin, FocusDirection::Forward);
/// assert_eq!(state.get_target(&origin), Some(&"btn2".to_string()));
/// ```
pub fn move_routing(
    state: &RoutingState,
    origin_id: &OriginID,
    direction: FocusDirection,
) -> RoutingState {
    let candidates = &state.tab_order;

    if candidates.is_empty() {
        return state.clone();
    }

    let current_target = state.routes.get(origin_id);

    // If origin has no route, route to first/last
    if current_target.is_none() {
        let next_id = match direction {
            FocusDirection::Forward => candidates.first().cloned(),
            FocusDirection::Backward => candidates.last().cloned(),
        };

        if let Some(target) = next_id {
            return set_routing(state, origin_id, &target);
        }
        return state.clone();
    }

    // Find current index in tab order
    let current_index = candidates.iter().position(|id| Some(id) == current_target);

    let next_index = match current_index {
        None => {
            // Current target is not in tab order, go to first
            Some(0)
        }
        Some(idx) => match direction {
            FocusDirection::Forward => Some((idx + 1) % candidates.len()),
            FocusDirection::Backward => {
                if idx == 0 {
                    Some(candidates.len() - 1)
                } else {
                    Some(idx - 1)
                }
            }
        },
    };

    if let Some(idx) = next_index {
        let target = &candidates[idx];
        set_routing(state, origin_id, target)
    } else {
        state.clone()
    }
}

// Import NavigationMode from focus module (canonical location)
use super::focus::NavigationMode;

/// Get navigation mode based on ARIA role.
fn get_navigation_mode(role: Option<Role>) -> NavigationMode {
    super::focus::get_navigation_mode(role)
}

/// Arrow navigation for a specific origin.
///
/// Implements Up/Down/Left/Right navigation within ARIA-aware containers
/// for the specified origin. Other origins' routes remain unchanged.
///
/// # Arguments
/// * `state` - Current routing state
/// * `tree` - The scene tree for navigation context
/// * `origin_id` - The input origin to navigate
/// * `direction` - Arrow direction (Up, Down, Left, Right)
///
/// # Returns
/// New RoutingState with the origin's route updated
pub fn navigate_routing(
    state: &RoutingState,
    tree: &SceneNode,
    origin_id: &OriginID,
    direction: ArrowDirection,
    scene_index: Option<&TypedSceneIndex>,
) -> RoutingState {
    let current_target = match state.routes.get(origin_id) {
        Some(id) => id,
        None => return state.clone(),
    };

    // Task 202: O(1) node property lookup via index instead of O(n) find_node()
    let role = if let Some(index) = scene_index {
        index
            .get(current_target)
            .and_then(|e| e.props.a11y.as_ref().and_then(|a| a.role))
    } else {
        find_node(tree, current_target).and_then(|n| n.props.a11y.as_ref().and_then(|a| a.role))
    };
    let mode = get_navigation_mode(role);

    if mode == NavigationMode::None {
        return state.clone();
    }

    // Task 202: O(1) sibling lookup via index parent_id + child_ids
    let siblings = if let Some(index) = scene_index {
        get_routable_siblings_via_index(current_target, index, state)
    } else {
        match find_node(tree, current_target) {
            Some(node) => get_routable_siblings(tree, node, state),
            None => return state.clone(),
        }
    };
    if siblings.is_empty() {
        return state.clone();
    }

    let current_index = siblings.iter().position(|id| id == current_target);
    let current_idx = match current_index {
        Some(idx) => idx,
        None => return state.clone(),
    };

    let mut next_index = current_idx;

    match direction {
        ArrowDirection::Up => {
            if mode == NavigationMode::Vertical || mode == NavigationMode::Both {
                next_index = if current_idx == 0 {
                    siblings.len() - 1
                } else {
                    current_idx - 1
                };
            }
        }
        ArrowDirection::Down => {
            if mode == NavigationMode::Vertical || mode == NavigationMode::Both {
                next_index = (current_idx + 1) % siblings.len();
            }
        }
        ArrowDirection::Left => {
            if mode == NavigationMode::Horizontal || mode == NavigationMode::Both {
                next_index = if current_idx == 0 {
                    siblings.len() - 1
                } else {
                    current_idx - 1
                };
            }
        }
        ArrowDirection::Right => {
            if mode == NavigationMode::Horizontal || mode == NavigationMode::Both {
                next_index = (current_idx + 1) % siblings.len();
            }
        }
    }

    if next_index == current_idx {
        return state.clone();
    }

    set_routing(state, origin_id, &siblings[next_index])
}

/// Get routable siblings for arrow key navigation.
/// Task 202: O(1) sibling lookup via index parent_id + child_ids.
/// Replaces O(n) get_routable_siblings() which used path_to_root() DFS.
fn get_routable_siblings_via_index(
    node_id: &ID,
    index: &TypedSceneIndex,
    state: &RoutingState,
) -> Vec<ID> {
    let parent_id = match index.get(node_id).and_then(|e| e.parent_id.as_ref()) {
        Some(pid) => pid,
        None => return Vec::new(), // root has no siblings
    };
    let parent_entry = match index.get(parent_id) {
        Some(e) => e,
        None => return Vec::new(),
    };
    parent_entry
        .child_ids
        .iter()
        .filter(|id| state.routable_nodes.contains(*id) || state.routable_nodes.is_empty())
        .cloned()
        .collect()
}

fn get_routable_siblings(tree: &SceneNode, node: &SceneNode, state: &RoutingState) -> Vec<ID> {
    // Find parent
    let path = path_to_root(tree, &node.id);
    if path.len() < 2 {
        return Vec::new();
    }

    let parent = path[1]; // path[0] is node itself, path[1] is parent

    // Return routable siblings (children of parent that are routable)
    parent
        .children
        .iter()
        .filter(|c| state.routable_nodes.contains(&c.id) || state.routable_nodes.is_empty())
        .map(|c| c.id.clone())
        .collect()
}

/// Initialize routing state from a scene tree.
///
/// Collects routable nodes and tab order from the tree.
///
/// # Arguments
/// * `root` - The root of the scene tree
///
/// # Returns
/// New RoutingState initialized from the tree
pub fn init_routing_state(root: &SceneNode) -> RoutingState {
    use super::focus::{collect_focusable_nodes, collect_tabbable_nodes};

    let routable_nodes = collect_focusable_nodes(root);
    let tab_order = collect_tabbable_nodes(root);

    RoutingState {
        routes: HashMap::new(),
        routable_nodes,
        scopes: HashMap::new(),
        tab_order,
    }
}

/// Register a routing scope.
///
/// # Arguments
/// * `state` - Current routing state
/// * `scope` - The scope to register
///
/// # Returns
/// New RoutingState with the scope added
pub fn register_routing_scope(state: &RoutingState, scope: RoutingScope) -> RoutingState {
    let mut new_scopes = state.scopes.clone();
    new_scopes.insert(scope.id.clone(), scope);

    RoutingState {
        routes: state.routes.clone(),
        routable_nodes: state.routable_nodes.clone(),
        scopes: new_scopes,
        tab_order: state.tab_order.clone(),
    }
}

/// Unregister a routing scope.
///
/// # Arguments
/// * `state` - Current routing state
/// * `scope_id` - The scope ID to remove
///
/// # Returns
/// New RoutingState with the scope removed
pub fn unregister_routing_scope(state: &RoutingState, scope_id: &ID) -> RoutingState {
    let mut new_scopes = state.scopes.clone();
    new_scopes.remove(scope_id);

    RoutingState {
        routes: state.routes.clone(),
        routable_nodes: state.routable_nodes.clone(),
        scopes: new_scopes,
        tab_order: state.tab_order.clone(),
    }
}

/// Update routing state with new tree (recompute routable nodes and tab order).
///
/// Validates that existing routes still point to valid targets.
///
/// # Arguments
/// * `state` - Current routing state
/// * `tree` - The new scene tree
///
/// # Returns
/// New RoutingState with updated routable nodes, preserving valid routes
pub fn update_routing_state(state: &RoutingState, tree: &SceneNode) -> RoutingState {
    use super::focus::{collect_focusable_nodes, collect_tabbable_nodes};

    let new_routable = collect_focusable_nodes(tree);
    let new_tab_order = collect_tabbable_nodes(tree);

    // Filter routes to only keep those with valid targets
    let new_routes: HashMap<OriginID, ID> = state
        .routes
        .iter()
        .filter(|(_, target)| new_routable.contains(target))
        .map(|(origin, target)| (origin.clone(), target.clone()))
        .collect();

    RoutingState {
        routes: new_routes,
        routable_nodes: new_routable,
        scopes: state.scopes.clone(),
        tab_order: new_tab_order,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------------
    // OriginID Tests (Opaque - no semantic helpers)
    // ------------------------------------------------------------------------

    #[test]
    fn test_origin_id_new_creates_from_string() {
        let origin = OriginID::new("my-custom-origin");
        assert_eq!(origin.id, "my-custom-origin");
    }

    #[test]
    fn test_origin_id_new_accepts_any_format() {
        // Kernel is agnostic to format - hosts determine convention
        let o1 = OriginID::new("keyboard:0");
        let o2 = OriginID::new("pointer:42");
        let o3 = OriginID::new("completely-arbitrary-string");
        let o4 = OriginID::new("user:alice:keyboard");

        assert_eq!(o1.id, "keyboard:0");
        assert_eq!(o2.id, "pointer:42");
        assert_eq!(o3.id, "completely-arbitrary-string");
        assert_eq!(o4.id, "user:alice:keyboard");
    }

    #[test]
    fn test_origin_id_equality_works() {
        let origin1 = OriginID::new("origin-a");
        let origin2 = OriginID::new("origin-a");
        let origin3 = OriginID::new("origin-b");

        assert_eq!(origin1, origin2);
        assert_ne!(origin1, origin3);
    }

    #[test]
    fn test_origin_id_hashing_works_as_hashmap_key() {
        let mut map: HashMap<OriginID, String> = HashMap::new();

        let kb = OriginID::new("kb");
        let ptr = OriginID::new("ptr");
        let touch = OriginID::new("touch");

        map.insert(kb.clone(), "text-input".to_string());
        map.insert(ptr.clone(), "button".to_string());
        map.insert(touch.clone(), "slider".to_string());

        assert_eq!(map.get(&kb), Some(&"text-input".to_string()));
        assert_eq!(map.get(&ptr), Some(&"button".to_string()));
        assert_eq!(map.get(&touch), Some(&"slider".to_string()));
        assert_eq!(map.get(&OriginID::new("nonexistent")), None);
    }

    // ------------------------------------------------------------------------
    // RoutingState Tests
    // ------------------------------------------------------------------------

    #[test]
    fn test_routing_state_can_store_multiple_routes() {
        let mut state = RoutingState::new();

        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");
        let origin_c = OriginID::new("origin-c");

        state.routes.insert(origin_a.clone(), "input-a".to_string());
        state
            .routes
            .insert(origin_b.clone(), "button-b".to_string());
        state
            .routes
            .insert(origin_c.clone(), "slider-c".to_string());

        assert_eq!(state.routes.len(), 3);
        assert_eq!(state.get_target(&origin_a), Some(&"input-a".to_string()));
        assert_eq!(state.get_target(&origin_b), Some(&"button-b".to_string()));
        assert_eq!(state.get_target(&origin_c), Some(&"slider-c".to_string()));
    }

    #[test]
    fn test_routing_state_routes_are_independent() {
        let mut state = RoutingState::new();

        let origin_1 = OriginID::new("origin-1");
        let origin_2 = OriginID::new("origin-2");

        // Set up two routes
        state
            .routes
            .insert(origin_1.clone(), "button-a".to_string());
        state
            .routes
            .insert(origin_2.clone(), "button-b".to_string());

        // Changing one doesn't affect the other
        state
            .routes
            .insert(origin_1.clone(), "button-c".to_string());

        assert_eq!(state.get_target(&origin_1), Some(&"button-c".to_string()));
        assert_eq!(state.get_target(&origin_2), Some(&"button-b".to_string()));
    }

    #[test]
    fn test_routing_state_two_origins_same_target() {
        let mut state = RoutingState::new();

        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");

        // Both origins can route to the same target
        state
            .routes
            .insert(origin_a.clone(), "button-submit".to_string());
        state
            .routes
            .insert(origin_b.clone(), "button-submit".to_string());

        assert_eq!(
            state.get_target(&origin_a),
            Some(&"button-submit".to_string())
        );
        assert_eq!(
            state.get_target(&origin_b),
            Some(&"button-submit".to_string())
        );
    }

    #[test]
    fn test_routing_state_serializes_deserializes() {
        let mut state = RoutingState::new();
        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");

        state.routes.insert(origin_a.clone(), "input-1".to_string());
        state
            .routes
            .insert(origin_b.clone(), "button-2".to_string());
        state.routable_nodes = vec!["input-1".to_string(), "button-2".to_string()];
        state.tab_order = vec!["input-1".to_string(), "button-2".to_string()];

        // Serialize
        let json = serde_json::to_string(&state).expect("serialize");

        // Deserialize
        let restored: RoutingState = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(restored.routes.len(), 2);
        assert_eq!(restored.get_target(&origin_a), Some(&"input-1".to_string()));
        assert_eq!(
            restored.get_target(&origin_b),
            Some(&"button-2".to_string())
        );
        assert_eq!(restored.routable_nodes.len(), 2);
        assert_eq!(restored.tab_order.len(), 2);
    }

    #[test]
    fn test_routing_state_helper_methods() {
        let mut state = RoutingState::new();
        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");

        state.routes.insert(origin_a.clone(), "input-1".to_string());
        state.routable_nodes = vec!["input-1".to_string(), "button-2".to_string()];

        assert!(state.has_route(&origin_a));
        assert!(!state.has_route(&origin_b));

        assert!(state.is_routable(&"input-1".to_string()));
        assert!(state.is_routable(&"button-2".to_string()));
        assert!(!state.is_routable(&"unknown".to_string()));

        assert_eq!(state.active_route_count(), 1);
    }

    // ------------------------------------------------------------------------
    // Serialization Tests
    // ------------------------------------------------------------------------

    #[test]
    fn test_origin_id_serializes_correctly() {
        let origin = OriginID::new("my-origin");
        let json = serde_json::to_string(&origin).expect("serialize");
        assert!(json.contains("my-origin"));

        let restored: OriginID = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored, origin);
    }

    #[test]
    fn test_routing_scope_serializes_correctly() {
        let scope = RoutingScope {
            id: "modal-scope".to_string(),
            trap_routing: true,
            roving_tabindex: false,
        };

        let json = serde_json::to_string(&scope).expect("serialize");
        let restored: RoutingScope = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(restored.id, "modal-scope");
        assert!(restored.trap_routing);
        assert!(!restored.roving_tabindex);
    }

    // ------------------------------------------------------------------------
    // Routing Functions Tests
    // ------------------------------------------------------------------------

    /// Test 1: set_routing adds route for specific origin
    #[test]
    fn test_set_routing_adds_route_for_specific_origin() {
        let state = RoutingState::new();
        let origin = OriginID::new("origin-a");
        let new_state = set_routing(&state, &origin, &"text-input".to_string());

        assert_eq!(
            new_state.get_target(&origin),
            Some(&"text-input".to_string())
        );
    }

    /// Test 2: set_routing doesn't affect other origins' routes
    #[test]
    fn test_set_routing_doesnt_affect_other_origins() {
        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");

        // Set up initial routes for two origins
        let state = RoutingState::new();
        let state = set_routing(&state, &origin_a, &"input-a".to_string());
        let state = set_routing(&state, &origin_b, &"button-b".to_string());

        // Modify only origin_a's route
        let state = set_routing(&state, &origin_a, &"input-c".to_string());

        // origin_a changed, origin_b unchanged
        assert_eq!(state.get_target(&origin_a), Some(&"input-c".to_string()));
        assert_eq!(state.get_target(&origin_b), Some(&"button-b".to_string()));
    }

    /// Test 3: clear_routing removes only specified origin
    #[test]
    fn test_clear_routing_removes_only_specified_origin() {
        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");

        let state = RoutingState::new();
        let state = set_routing(&state, &origin_a, &"input-a".to_string());
        let state = set_routing(&state, &origin_b, &"button-b".to_string());

        // Clear origin_a route
        let state = clear_routing(&state, &origin_a);

        assert_eq!(state.get_target(&origin_a), None);
        assert_eq!(state.get_target(&origin_b), Some(&"button-b".to_string()));
    }

    /// Test 4: clear_routing leaves other origins intact
    #[test]
    fn test_clear_routing_leaves_other_origins_intact() {
        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");
        let origin_c = OriginID::new("origin-c");

        let state = RoutingState::new();
        let state = set_routing(&state, &origin_a, &"input-a".to_string());
        let state = set_routing(&state, &origin_b, &"button-b".to_string());
        let state = set_routing(&state, &origin_c, &"button-c".to_string());

        // Clear only origin_b
        let state = clear_routing(&state, &origin_b);

        assert_eq!(state.get_target(&origin_a), Some(&"input-a".to_string()));
        assert_eq!(state.get_target(&origin_b), None);
        assert_eq!(state.get_target(&origin_c), Some(&"button-c".to_string()));
    }

    /// Test 5: get_routing returns correct target for origin
    #[test]
    fn test_get_routing_returns_correct_target() {
        let origin = OriginID::new("my-origin");
        let state = RoutingState::new();
        let state = set_routing(&state, &origin, &"text-input".to_string());

        assert_eq!(
            get_routing(&state, &origin),
            Some(&"text-input".to_string())
        );
    }

    /// Test 6: get_routing returns None for unrouted origin
    #[test]
    fn test_get_routing_returns_none_for_unrouted_origin() {
        let state = RoutingState::new();
        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");

        assert_eq!(get_routing(&state, &origin_a), None);
        assert_eq!(get_routing(&state, &origin_b), None);
    }

    /// Test 7: move_routing moves only specified origin's route
    #[test]
    fn test_move_routing_moves_only_specified_origin() {
        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");

        let mut state = RoutingState::new();
        state.tab_order = vec!["btn1".to_string(), "btn2".to_string(), "btn3".to_string()];
        state.routable_nodes = state.tab_order.clone();

        // Set initial routes
        let state = set_routing(&state, &origin_a, &"btn1".to_string());
        let state = set_routing(&state, &origin_b, &"btn1".to_string());

        // Move only origin_a forward
        let state = move_routing(&state, &origin_a, FocusDirection::Forward);

        // origin_a moved, origin_b unchanged
        assert_eq!(state.get_target(&origin_a), Some(&"btn2".to_string()));
        assert_eq!(state.get_target(&origin_b), Some(&"btn1".to_string()));
    }

    /// Test 8: move_routing leaves other origins' routes unchanged
    #[test]
    fn test_move_routing_leaves_other_origins_unchanged() {
        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");
        let origin_c = OriginID::new("origin-c");

        let mut state = RoutingState::new();
        state.tab_order = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        state.routable_nodes = state.tab_order.clone();

        // Three origins, all starting at "a"
        let state = set_routing(&state, &origin_a, &"a".to_string());
        let state = set_routing(&state, &origin_b, &"a".to_string());
        let state = set_routing(&state, &origin_c, &"a".to_string());

        // Move only origin_b forward
        let state = move_routing(&state, &origin_b, FocusDirection::Forward);

        // Only origin_b moved
        assert_eq!(state.get_target(&origin_a), Some(&"a".to_string()));
        assert_eq!(state.get_target(&origin_b), Some(&"b".to_string()));
        assert_eq!(state.get_target(&origin_c), Some(&"a".to_string()));
    }

    /// Test 9: Two origins can route to same target
    #[test]
    fn test_two_origins_can_route_to_same_target() {
        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");

        let state = RoutingState::new();
        let state = set_routing(&state, &origin_a, &"submit-btn".to_string());
        let state = set_routing(&state, &origin_b, &"submit-btn".to_string());

        // Both point to same target
        assert_eq!(state.get_target(&origin_a), Some(&"submit-btn".to_string()));
        assert_eq!(state.get_target(&origin_b), Some(&"submit-btn".to_string()));
        assert_eq!(state.active_route_count(), 2);
    }

    /// Test 10: Two origins can route to different targets simultaneously
    #[test]
    fn test_two_origins_can_route_to_different_targets() {
        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");
        let origin_c = OriginID::new("origin-c");

        let state = RoutingState::new();
        let state = set_routing(&state, &origin_a, &"input-a".to_string());
        let state = set_routing(&state, &origin_b, &"button-b".to_string());
        let state = set_routing(&state, &origin_c, &"slider-c".to_string());

        // All three have different targets
        assert_eq!(state.get_target(&origin_a), Some(&"input-a".to_string()));
        assert_eq!(state.get_target(&origin_b), Some(&"button-b".to_string()));
        assert_eq!(state.get_target(&origin_c), Some(&"slider-c".to_string()));
        assert_eq!(state.active_route_count(), 3);
    }

    /// Test 11: navigate_routing respects ARIA roles per-origin
    #[test]
    fn test_navigate_routing_respects_aria_roles() {
        use crate::kernel::types::{A11yProps, NodeKind, NodeProps, Role, SceneNode};

        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");

        // Create menu tree with Menuitem children
        let tree = SceneNode::new("menu", NodeKind::Container)
            .with_props(NodeProps {
                a11y: Some(A11yProps {
                    role: Some(Role::Menu),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .with_children(vec![
                SceneNode::new("item1", NodeKind::Container).with_props(NodeProps {
                    a11y: Some(A11yProps {
                        role: Some(Role::Menuitem),
                        tab_index: Some(0),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                SceneNode::new("item2", NodeKind::Container).with_props(NodeProps {
                    a11y: Some(A11yProps {
                        role: Some(Role::Menuitem),
                        tab_index: Some(0),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                SceneNode::new("item3", NodeKind::Container).with_props(NodeProps {
                    a11y: Some(A11yProps {
                        role: Some(Role::Menuitem),
                        tab_index: Some(0),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
            ]);

        let state = init_routing_state(&tree);

        // Route both origins to item1
        let state = set_routing(&state, &origin_a, &"item1".to_string());
        let state = set_routing(&state, &origin_b, &"item1".to_string());

        // Navigate origin_a down (vertical nav for Menuitem)
        let state = navigate_routing(&state, &tree, &origin_a, ArrowDirection::Down, None);

        // origin_a moved, origin_b unchanged
        assert_eq!(state.get_target(&origin_a), Some(&"item2".to_string()));
        assert_eq!(state.get_target(&origin_b), Some(&"item1".to_string()));
    }

    /// Test 12: init_routing_state populates routable_nodes and tab_order
    #[test]
    fn test_init_routing_state_populates_lists() {
        use crate::kernel::types::{A11yProps, NodeKind, NodeProps, Role, SceneNode};

        let tree = SceneNode::new("root", NodeKind::Container).with_children(vec![
            SceneNode::new("btn1", NodeKind::Container).with_props(NodeProps {
                a11y: Some(A11yProps {
                    role: Some(Role::Button),
                    tab_index: Some(0),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            SceneNode::new("btn2", NodeKind::Container).with_props(NodeProps {
                a11y: Some(A11yProps {
                    role: Some(Role::Button),
                    tab_index: Some(0),
                    ..Default::default()
                }),
                ..Default::default()
            }),
        ]);

        let state = init_routing_state(&tree);

        assert_eq!(state.routable_nodes.len(), 2);
        assert!(state.routable_nodes.contains(&"btn1".to_string()));
        assert!(state.routable_nodes.contains(&"btn2".to_string()));
        assert_eq!(state.tab_order.len(), 2);
        assert!(state.routes.is_empty()); // No routes initially
    }

    /// Test 13: update_routing_state removes invalid routes
    #[test]
    fn test_update_routing_state_removes_invalid_routes() {
        use crate::kernel::types::{A11yProps, NodeKind, NodeProps, Role, SceneNode};

        let origin_a = OriginID::new("origin-a");
        let origin_b = OriginID::new("origin-b");

        let original_tree = SceneNode::new("root", NodeKind::Container).with_children(vec![
            SceneNode::new("btn1", NodeKind::Container).with_props(NodeProps {
                a11y: Some(A11yProps {
                    role: Some(Role::Button),
                    tab_index: Some(0),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            SceneNode::new("btn2", NodeKind::Container).with_props(NodeProps {
                a11y: Some(A11yProps {
                    role: Some(Role::Button),
                    tab_index: Some(0),
                    ..Default::default()
                }),
                ..Default::default()
            }),
        ]);

        let mut state = init_routing_state(&original_tree);
        state = set_routing(&state, &origin_a, &"btn1".to_string());
        state = set_routing(&state, &origin_b, &"btn2".to_string());

        // New tree where btn2 is removed
        let new_tree =
            SceneNode::new("root", NodeKind::Container).with_children(vec![SceneNode::new(
                "btn1",
                NodeKind::Container,
            )
            .with_props(NodeProps {
                a11y: Some(A11yProps {
                    role: Some(Role::Button),
                    tab_index: Some(0),
                    ..Default::default()
                }),
                ..Default::default()
            })]);

        let updated_state = update_routing_state(&state, &new_tree);

        // origin_a route to btn1 is preserved, origin_b route to btn2 is removed
        assert_eq!(
            updated_state.get_target(&origin_a),
            Some(&"btn1".to_string())
        );
        assert_eq!(updated_state.get_target(&origin_b), None);
        assert_eq!(updated_state.routable_nodes.len(), 1);
    }

    /// Test 14: move_routing wraps around at boundaries
    #[test]
    fn test_move_routing_wraps_around() {
        let origin = OriginID::new("my-origin");

        let mut state = RoutingState::new();
        state.tab_order = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        state.routable_nodes = state.tab_order.clone();

        // Start at last element
        let state = set_routing(&state, &origin, &"c".to_string());

        // Move forward should wrap to first
        let state = move_routing(&state, &origin, FocusDirection::Forward);
        assert_eq!(state.get_target(&origin), Some(&"a".to_string()));

        // Move backward should wrap to last
        let state = move_routing(&state, &origin, FocusDirection::Backward);
        assert_eq!(state.get_target(&origin), Some(&"c".to_string()));
    }

    /// Test 15: register_routing_scope and unregister_routing_scope
    #[test]
    fn test_register_unregister_routing_scope() {
        let state = RoutingState::new();

        let scope = RoutingScope {
            id: "modal".to_string(),
            trap_routing: true,
            roving_tabindex: false,
        };

        // Register scope
        let state = register_routing_scope(&state, scope);
        assert!(state.scopes.contains_key(&"modal".to_string()));
        assert!(state.scopes.get(&"modal".to_string()).unwrap().trap_routing);

        // Unregister scope
        let state = unregister_routing_scope(&state, &"modal".to_string());
        assert!(!state.scopes.contains_key(&"modal".to_string()));
    }
}
