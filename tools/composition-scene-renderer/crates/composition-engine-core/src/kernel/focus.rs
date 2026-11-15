//! crates/composition-engine-core/src/kernel/focus.rs
//!
//! Focus helper types and collection functions.
//!
//! This module provides types (FocusDirection, ArrowDirection, NavigationMode) and
//! helper functions for collecting focusable/tabbable nodes from scene trees.
//!
//! # Note
//!
//! For focus/routing operations, use the `routing` module which provides
//! Physics-correct routing with explicit origin_id:
//! - `routing::set_routing()` - route specific origin to target
//! - `routing::clear_routing()` - clear route for specific origin
//! - `routing::move_routing()` - Tab navigation per-origin
//! - `routing::navigate_routing()` - Arrow navigation per-origin

use super::scene::{path_to_root, walk_tree};
use super::types::{FocusScope, FocusState, Role, SceneNode, SemanticProps, ID};
use std::collections::HashMap;

// ============================================================================
// Types
// ============================================================================

/// Focus direction for tab traversal
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusDirection {
    Forward,
    Backward,
}

/// Arrow direction for navigation
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrowDirection {
    Up,
    Down,
    Left,
    Right,
}

/// Navigation mode based on ARIA role
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationMode {
    Horizontal,
    Vertical,
    Both,
    None,
}

/// Get navigation mode based on ARIA role
pub fn get_navigation_mode(role: Option<Role>) -> NavigationMode {
    match role {
        Some(Role::Menu) | Some(Role::Menuitem) | Some(Role::Listbox) | Some(Role::Option) => {
            NavigationMode::Vertical
        }
        Some(Role::Slider) => NavigationMode::Horizontal,
        Some(Role::Radio) => NavigationMode::Both,
        _ => NavigationMode::None,
    }
}

// ============================================================================
// Initialization Functions
// ============================================================================

/// Initialize focus state for a scene tree.
///
/// **Not used in the render pipeline.** The render pipeline uses
/// `RuntimeGraph::from_tree()` at init and `RuntimeGraph::update()` for
/// incremental updates. This function exists for the standalone focus API
/// used in tests and focus.rs unit tests only.
pub fn init_focus_state(root: &SceneNode) -> FocusState {
    let focusable_nodes = collect_focusable_nodes(root);
    let tabbable_nodes = collect_tabbable_nodes(root);

    FocusState {
        focused_id: None,
        focusable_nodes,
        scopes: HashMap::new(),
        tabbable_nodes,
    }
}

/// Update focus state with new tree (recompute focusable/tabbable nodes).
///
/// **Not used in the render pipeline.** The render pipeline maintains focus
/// state incrementally via `RuntimeGraph`. This function exists for the
/// standalone focus API used in tests and focus.rs unit tests only.
pub fn update_focus_state(state: &FocusState, tree: &SceneNode) -> FocusState {
    let new_focusable = collect_focusable_nodes(tree);
    let new_tabbable = collect_tabbable_nodes(tree);

    // Validate focused node still exists and is focusable
    let new_focused_id = match &state.focused_id {
        Some(id) if new_focusable.contains(id) => Some(id.clone()),
        _ => None,
    };

    FocusState {
        focused_id: new_focused_id,
        focusable_nodes: new_focusable,
        scopes: state.scopes.clone(),
        tabbable_nodes: new_tabbable,
    }
}

/// Focus the first tabbable element
pub fn focus_first(state: &FocusState) -> FocusState {
    FocusState {
        focused_id: state.tabbable_nodes.first().cloned(),
        focusable_nodes: state.focusable_nodes.clone(),
        scopes: state.scopes.clone(),
        tabbable_nodes: state.tabbable_nodes.clone(),
    }
}

/// Focus the last tabbable element
pub fn focus_last(state: &FocusState) -> FocusState {
    FocusState {
        focused_id: state.tabbable_nodes.last().cloned(),
        focusable_nodes: state.focusable_nodes.clone(),
        scopes: state.scopes.clone(),
        tabbable_nodes: state.tabbable_nodes.clone(),
    }
}

// ============================================================================
// Scope Management
// ============================================================================

/// Register a focus scope
pub fn register_scope(state: &FocusState, scope: FocusScope) -> FocusState {
    let mut new_scopes = state.scopes.clone();
    new_scopes.insert(scope.id.clone(), scope);

    FocusState {
        focused_id: state.focused_id.clone(),
        focusable_nodes: state.focusable_nodes.clone(),
        scopes: new_scopes,
        tabbable_nodes: state.tabbable_nodes.clone(),
    }
}

/// Unregister a focus scope
pub fn unregister_scope(state: &FocusState, scope_id: &ID) -> FocusState {
    let mut new_scopes = state.scopes.clone();
    new_scopes.remove(scope_id);

    FocusState {
        focused_id: state.focused_id.clone(),
        focusable_nodes: state.focusable_nodes.clone(),
        scopes: new_scopes,
        tabbable_nodes: state.tabbable_nodes.clone(),
    }
}

/// Check if focus is trapped within a scope
pub fn is_focus_trapped(state: &FocusState, tree: &SceneNode) -> bool {
    let focused_id = match &state.focused_id {
        Some(id) => id,
        None => return false,
    };

    // Check if any ancestor has a trap_focus scope
    let path = path_to_root(tree, focused_id);
    for node in path {
        if let Some(scope) = state.scopes.get(&node.id) {
            if scope.trap_focus {
                return true;
            }
        }
    }

    false
}

/// Get the active focus trap scope (if any)
pub fn get_active_trap(state: &FocusState, tree: &SceneNode) -> Option<FocusScope> {
    let focused_id = match &state.focused_id {
        Some(id) => id,
        None => return None,
    };

    let path = path_to_root(tree, focused_id);
    for node in path {
        if let Some(scope) = state.scopes.get(&node.id) {
            if scope.trap_focus {
                return Some(scope.clone());
            }
        }
    }

    None
}

// ============================================================================
// Collection Functions
// ============================================================================

/// Collect all focusable node IDs from tree via O(n) tree walk.
///
/// **Called only during initialization and tests** — the render pipeline uses
/// `RuntimeGraph::update_focusable_incremental()` for O(dirty) incremental
/// updates instead of this O(n) full collection.
///
/// Call sites:
/// - `RuntimeGraph::init_rebuild()` — first frame only
/// - `init_routing_state()` — kernel initialization only
/// - Tests (oracle correctness verification)
pub fn collect_focusable_nodes(root: &SceneNode) -> Vec<ID> {
    let mut focusable = Vec::new();

    walk_tree(root, &mut |node, _depth| {
        if is_focusable(node) {
            focusable.push(node.id.clone());
        }
    });

    focusable
}

/// Collect all tabbable node IDs from tree (focusable + non-negative tabindex)
/// via O(n) tree walk + O(n log n) sort.
///
/// **Called only during initialization and tests** — the render pipeline uses
/// `RuntimeGraph::update_tabbable_incremental()` for O(dirty) incremental
/// updates with O(log m) binary-search insertion instead of this full collection.
///
/// Call sites:
/// - `RuntimeGraph::init_rebuild()` — first frame only
/// - `init_routing_state()` — kernel initialization only
/// - Tests (oracle correctness verification)
pub fn collect_tabbable_nodes(root: &SceneNode) -> Vec<ID> {
    let mut tabbable: Vec<(ID, i32, i32)> = Vec::new(); // (id, tab_index, z_index)

    walk_tree(root, &mut |node, _depth| {
        if is_tabbable(node) {
            let tab_index = node
                .props
                .a11y
                .as_ref()
                .and_then(|a| a.tab_index)
                .unwrap_or(0);
            let z_index = node.z_index.unwrap_or(0);
            tabbable.push((node.id.clone(), tab_index, z_index));
        }
    });

    // Sort by tabIndex (positive first), then by z-index
    tabbable.sort_by(|a, b| {
        let (_, a_tab, a_z) = a;
        let (_, b_tab, b_z) = b;

        // Explicit positive tabindex comes first
        if *a_tab > 0 && *b_tab <= 0 {
            return std::cmp::Ordering::Less;
        }
        if *b_tab > 0 && *a_tab <= 0 {
            return std::cmp::Ordering::Greater;
        }
        if *a_tab > 0 && *b_tab > 0 {
            return a_tab.cmp(b_tab);
        }

        // Otherwise, sort by z-index
        a_z.cmp(b_z)
    });

    tabbable.into_iter().map(|(id, _, _)| id).collect()
}

/// Collect semantic properties for all nodes. Returns map of node ID to semantic props.
pub fn collect_semantics(tree: &SceneNode, focus_state: &FocusState) -> HashMap<ID, SemanticProps> {
    let mut semantics = HashMap::new();

    walk_tree(tree, &mut |node, _depth| {
        if let Some(ref a11y) = node.props.a11y {
            let is_focused = focus_state.focused_id.as_ref() == Some(&node.id);

            let mut states = a11y.states.clone();
            if is_focused {
                let states_map = states.get_or_insert_with(HashMap::new);
                states_map.insert("focused".to_string(), true);
            }

            let props = SemanticProps {
                role: a11y.role,
                label: a11y.label.clone(),
                tab_index: a11y.tab_index,
                props: a11y.props.clone(),
                states,
            };

            semantics.insert(node.id.clone(), props);
        }
    });

    semantics
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Check if node is focusable (visible + has a11y role or tab_index).
///
/// A node is focusable if:
/// 1. It is visible (Visibility::as_bool() handles both Resolved and unevaluated Binding)
/// 2. It has a11y props with either a role OR an explicit tab_index
///
/// Used by RuntimeGraph for incremental focus/tab maintenance.
pub fn is_focusable(node: &SceneNode) -> bool {
    if !node.visible.as_bool() {
        return false;
    }

    let a11y = match &node.props.a11y {
        Some(a) => a,
        None => return false,
    };

    // Has role or explicit tabindex
    a11y.role.is_some() || a11y.tab_index.is_some()
}

/// Check if node is tabbable (focusable + non-negative tab_index).
///
/// A node is tabbable if it is focusable AND its tab_index is not negative.
/// Nodes with tab_index < 0 are focusable programmatically but not via Tab key.
///
/// Used by RuntimeGraph for incremental focus/tab maintenance.
pub fn is_tabbable(node: &SceneNode) -> bool {
    if !is_focusable(node) {
        return false;
    }

    let tab_index = node.props.a11y.as_ref().and_then(|a| a.tab_index);

    // Negative tabindex = focusable but not tabbable
    !matches!(tab_index, Some(t) if t < 0)
}

/// Extract the sort key for a tabbable node: (tab_index, z_index).
///
/// Tabbable nodes are sorted by:
/// 1. Positive tab_index ascending (tab_index > 0 comes before tab_index <= 0)
/// 2. Within the same group, by z_index ascending
///
/// Returns (tab_index, z_index) for use in binary search insertion.
///
/// Used by RuntimeGraph for incremental sorted tabbable list maintenance.
pub fn tabbable_sort_key(node: &SceneNode) -> (i32, i32) {
    let tab_index = node
        .props
        .a11y
        .as_ref()
        .and_then(|a| a.tab_index)
        .unwrap_or(0);
    let z_index = node.z_index.unwrap_or(0);
    (tab_index, z_index)
}

/// Compare two tabbable sort keys using the canonical tab order.
///
/// Sort order:
/// 1. Positive tab_index (>0) comes before zero/default tab_index (<=0)
/// 2. Within positive: ascending by tab_index
/// 3. Within zero/default: ascending by z_index
pub fn compare_tab_order(a: (i32, i32), b: (i32, i32)) -> std::cmp::Ordering {
    let (a_tab, a_z) = a;
    let (b_tab, b_z) = b;

    // Explicit positive tabindex comes first
    if a_tab > 0 && b_tab <= 0 {
        return std::cmp::Ordering::Less;
    }
    if b_tab > 0 && a_tab <= 0 {
        return std::cmp::Ordering::Greater;
    }
    if a_tab > 0 && b_tab > 0 {
        return a_tab.cmp(&b_tab);
    }

    // Otherwise, sort by z-index
    a_z.cmp(&b_z)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::types::{A11yProps, NodeKind, NodeProps};

    fn make_test_tree() -> SceneNode {
        SceneNode::new("root", NodeKind::Container).with_children(vec![
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
            SceneNode::new("btn3", NodeKind::Container).with_props(NodeProps {
                a11y: Some(A11yProps {
                    role: Some(Role::Button),
                    tab_index: Some(0),
                    ..Default::default()
                }),
                ..Default::default()
            }),
        ])
    }

    #[test]
    fn test_init_focus_state() {
        let tree = make_test_tree();
        let state = init_focus_state(&tree);

        assert!(state.focused_id.is_none());
        assert_eq!(state.focusable_nodes.len(), 3);
        assert_eq!(state.tabbable_nodes.len(), 3);
    }

    #[test]
    fn test_get_navigation_mode() {
        assert_eq!(
            get_navigation_mode(Some(Role::Menu)),
            NavigationMode::Vertical
        );
        assert_eq!(
            get_navigation_mode(Some(Role::Menuitem)),
            NavigationMode::Vertical
        );
        assert_eq!(
            get_navigation_mode(Some(Role::Listbox)),
            NavigationMode::Vertical
        );
        assert_eq!(
            get_navigation_mode(Some(Role::Slider)),
            NavigationMode::Horizontal
        );
        assert_eq!(get_navigation_mode(Some(Role::Radio)), NavigationMode::Both);
        assert_eq!(
            get_navigation_mode(Some(Role::Button)),
            NavigationMode::None
        );
        assert_eq!(get_navigation_mode(None), NavigationMode::None);
    }

    #[test]
    fn test_collect_semantics() {
        let tree = make_test_tree();
        let mut state = init_focus_state(&tree);
        // Manually set focused_id since we removed set_focus
        state.focused_id = Some("btn1".to_string());

        let semantics = collect_semantics(&tree, &state);

        assert!(semantics.contains_key(&"btn1".to_string()));
        let btn1_props = semantics.get(&"btn1".to_string()).unwrap();
        assert_eq!(btn1_props.role, Some(Role::Button));

        // Check focused state is set
        assert!(btn1_props
            .states
            .as_ref()
            .map(|s| s.get("focused") == Some(&true))
            .unwrap_or(false));
    }

    #[test]
    fn test_focus_scope() {
        let tree = make_test_tree();
        let state = init_focus_state(&tree);

        let scope = FocusScope {
            id: "btn1".to_string(),
            trap_focus: true,
            roving_tabindex: false,
        };

        let state2 = register_scope(&state, scope);
        assert!(state2.scopes.contains_key(&"btn1".to_string()));

        let state3 = unregister_scope(&state2, &"btn1".to_string());
        assert!(!state3.scopes.contains_key(&"btn1".to_string()));
    }

    #[test]
    fn test_update_focus_state() {
        let tree = make_test_tree();
        let mut state = init_focus_state(&tree);
        // Manually set focused_id since we removed set_focus
        state.focused_id = Some("btn1".to_string());

        // Create a new tree where btn1 is removed
        let new_tree =
            SceneNode::new("root", NodeKind::Container).with_children(vec![SceneNode::new(
                "btn2",
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

        let state2 = update_focus_state(&state, &new_tree);

        // Focus should be cleared since btn1 no longer exists
        assert!(state2.focused_id.is_none());
        assert_eq!(state2.focusable_nodes.len(), 1);
    }

    #[test]
    fn test_focus_first_last() {
        let tree = make_test_tree();
        let state = init_focus_state(&tree);

        let s1 = focus_first(&state);
        assert_eq!(s1.focused_id, Some("btn1".to_string()));

        let s2 = focus_last(&state);
        assert_eq!(s2.focused_id, Some("btn3".to_string()));
    }

    #[test]
    fn test_tabbable_excludes_negative_tabindex() {
        let tree = SceneNode::new("root", NodeKind::Container).with_children(vec![
            SceneNode::new("focusable", NodeKind::Container).with_props(NodeProps {
                a11y: Some(A11yProps {
                    role: Some(Role::Button),
                    tab_index: Some(-1), // Focusable but not tabbable
                    ..Default::default()
                }),
                ..Default::default()
            }),
            SceneNode::new("tabbable", NodeKind::Container).with_props(NodeProps {
                a11y: Some(A11yProps {
                    role: Some(Role::Button),
                    tab_index: Some(0),
                    ..Default::default()
                }),
                ..Default::default()
            }),
        ]);

        let state = init_focus_state(&tree);

        assert_eq!(state.focusable_nodes.len(), 2);
        assert_eq!(state.tabbable_nodes.len(), 1);
        assert!(state.tabbable_nodes.contains(&"tabbable".to_string()));
        assert!(!state.tabbable_nodes.contains(&"focusable".to_string()));
    }
}
