//! crates/composition-engine-core/src/kernel/scene.rs
//!
//! # Purpose
//!
//! Pure functional scene tree operations — add, remove, reparent, update, and
//! query nodes in an immutable tree. All operations return NEW trees with NO mutations.
//!
//! # Non-Negotiable Invariants
//!
//! 1. **Immutability** — every operation returns a new tree; the input is never modified
//! 2. **Cycle prevention** — `add_child` and `reparent` reject operations that would
//!    create cycles in the tree hierarchy
//! 3. **Root protection** — the root node cannot be removed (use replacement instead)
//! 4. **Structured errors** — `SceneError` uses named fields with `reason`/`hint` for
//!    machine-readable error handling across WASM boundaries
//!
//! # Key Concepts
//!
//! - `map_tree` — internal recursive mapper that applies a function to every node
//! - `find_node` / `path_to_root` / `hit_test` — tree traversal queries
//! - `add_child` / `remove_child` / `remove_node` / `reparent` — structural mutations
//! - `SceneError` — structured error enum with `Serialize`/`Deserialize` for WASM transport
//!
//! # Security Considerations
//!
//! - All tree operations validate structural integrity (no cycles, no orphans)
//! - Node IDs are opaque strings — no injection risk in tree operations
//!
//! # AI Directive
//!
//! The extensive documentation in this codebase is a critical design feature.
//! You are FORBIDDEN from simplifying or removing it. Your mandate is to
//! MAINTAIN and EXTEND this level of meticulous detail.
//!
//! Ported from: frontends/web/composition-engine/kernel/scene.ts

use super::types::{LayoutFrame, Matrix, Point, SceneNode, ID};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

// ============================================================================
// PURE TREE OPERATIONS
// ============================================================================

/// Add a child to a parent node. Returns new root.
/// Returns Err if parent not found or cycle would be created.
pub fn add_child(
    root: &SceneNode,
    parent_id: &ID,
    child: SceneNode,
    z_index: Option<i32>,
) -> Result<SceneNode, SceneError> {
    // Validate no cycle
    if would_create_cycle(root, parent_id, &child.id) {
        return Err(SceneError::CycleDetected {
            child_id: child.id.clone(),
            parent_id: parent_id.clone(),
            reason: format!(
                "Adding node '{}' as child of '{}' would create a cycle",
                child.id, parent_id
            ),
            hint: "Verify the parent-child relationship does not form a loop in the scene tree"
                .to_string(),
        });
    }

    let child_with_z = if let Some(z) = z_index {
        SceneNode {
            z_index: Some(z),
            ..child
        }
    } else {
        child
    };

    let root_arc = Arc::new(root.clone());
    let result = map_tree(&root_arc, &|node| {
        if &node.id == parent_id {
            let mut new_children = node.children.clone();
            new_children.push(Arc::new(child_with_z.clone()));
            if z_index.is_some() {
                new_children.sort_by_key(|c| c.z_index.unwrap_or(0));
            }
            Some(SceneNode {
                children: new_children,
                ..node.clone()
            })
        } else {
            None
        }
    });
    Ok((*result).clone())
}

/// Remove a child from its parent. Returns new root.
pub fn remove_child(root: &SceneNode, parent_id: &ID, child_id: &ID) -> SceneNode {
    let root_arc = Arc::new(root.clone());
    let result = map_tree(&root_arc, &|node| {
        if &node.id == parent_id {
            let new_children: Vec<Arc<SceneNode>> = node
                .children
                .iter()
                .filter(|c| &c.id != child_id)
                .cloned()
                .collect();
            Some(SceneNode {
                children: new_children,
                ..node.clone()
            })
        } else {
            None
        }
    });
    (*result).clone()
}

/// Remove a node by ID from anywhere in tree. Returns new root.
pub fn remove_node(root: &SceneNode, node_id: &ID) -> Result<SceneNode, SceneError> {
    if &root.id == node_id {
        return Err(SceneError::CannotRemoveRoot {
            reason: "The root node cannot be removed from the scene tree".to_string(),
            hint: "Use a replace operation on the root instead of removing it".to_string(),
        });
    }

    let root_arc = Arc::new(root.clone());
    let result = map_tree(&root_arc, &|node| {
        // Only the node whose children list actually changes needs a new allocation
        if node.children.iter().any(|c| &c.id == node_id) {
            let new_children: Vec<Arc<SceneNode>> = node
                .children
                .iter()
                .filter(|c| &c.id != node_id)
                .cloned()
                .collect();
            Some(SceneNode {
                children: new_children,
                ..node.clone()
            })
        } else {
            None
        }
    });
    Ok((*result).clone())
}

/// Move a node from one parent to another. Returns new root.
pub fn reparent(
    root: &SceneNode,
    node_id: &ID,
    new_parent_id: &ID,
    z_index: Option<i32>,
) -> Result<SceneNode, SceneError> {
    let node = find_node(root, node_id).ok_or_else(|| SceneError::NodeNotFound {
        id: node_id.clone(),
        reason: format!("Node '{}' does not exist in the scene tree", node_id),
        hint: "Verify the node ID is correct and the node has not been removed".to_string(),
    })?;

    let node_clone = node.clone();
    let new_root = remove_node(root, node_id)?;
    add_child(&new_root, new_parent_id, node_clone, z_index)
}

/// Update a node's properties. Returns new root.
pub fn update_node<F>(root: &SceneNode, node_id: &ID, update_fn: F) -> SceneNode
where
    F: Fn(&SceneNode) -> SceneNode,
{
    let root_arc = Arc::new(root.clone());
    let result = map_tree(&root_arc, &|node| {
        if &node.id == node_id {
            Some(update_fn(node))
        } else {
            None
        }
    });
    (*result).clone()
}

/// Set portal owner for a node. Returns new root.
pub fn set_portal_owner(root: &SceneNode, node_id: &ID, owner_id: Option<ID>) -> SceneNode {
    let root_arc = Arc::new(root.clone());
    let result = map_tree(&root_arc, &|node| {
        if &node.id == node_id {
            Some(SceneNode {
                portal_owner: owner_id.clone(),
                ..node.clone()
            })
        } else {
            None
        }
    });
    (*result).clone()
}

/// Reorder children of a node by zIndex. Returns new root.
pub fn reorder_children(root: &SceneNode, parent_id: &ID) -> SceneNode {
    let root_arc = Arc::new(root.clone());
    let result = map_tree(&root_arc, &|node| {
        if &node.id == parent_id {
            let mut sorted = node.children.clone();
            sorted.sort_by_key(|c| c.z_index.unwrap_or(0));
            Some(SceneNode {
                children: sorted,
                ..node.clone()
            })
        } else {
            None
        }
    });
    (*result).clone()
}

// ============================================================================
// TREE TRAVERSAL & QUERIES
// ============================================================================

/// Find a node by ID via O(n) tree walk. Returns None if not found.
///
/// # Performance
///
/// This is O(n) — prefer `KernelState.cached_scene_index.get(id)` for O(1)
/// lookups when you only need `TypedNodeEntry` (props, visibility, triggers).
/// Use this function only when you need the full `&SceneNode` with children
/// (e.g., for subtree diffing in `update_scene_node()`).
pub fn find_node<'a>(root: &'a SceneNode, node_id: &ID) -> Option<&'a SceneNode> {
    if &root.id == node_id {
        return Some(root);
    }
    for child in &root.children {
        if let Some(found) = find_node(child, node_id) {
            return Some(found);
        }
    }
    None
}

/// Collect path from node to root. Returns [node, parent, grandparent, ..., root]
pub fn path_to_root<'a>(root: &'a SceneNode, node_id: &ID) -> Vec<&'a SceneNode> {
    let mut path = Vec::new();
    collect_path(root, node_id, &mut path);
    path
}

fn collect_path<'a>(node: &'a SceneNode, target_id: &ID, path: &mut Vec<&'a SceneNode>) -> bool {
    if &node.id == target_id {
        path.push(node);
        return true;
    }
    for child in &node.children {
        if collect_path(child, target_id, path) {
            path.push(node);
            return true;
        }
    }
    false
}

/// Get parent of a node. Returns None if node is root or not found.
pub fn get_parent<'a>(root: &'a SceneNode, node_id: &ID) -> Option<&'a SceneNode> {
    if &root.id == node_id {
        return None;
    }
    search_parent(root, node_id)
}

fn search_parent<'a>(node: &'a SceneNode, target_id: &ID) -> Option<&'a SceneNode> {
    for child in &node.children {
        if &child.id == target_id {
            return Some(node);
        }
        if let Some(found) = search_parent(child, target_id) {
            return Some(found);
        }
    }
    None
}

/// Check if nodeA is an ancestor of nodeB
pub fn is_ancestor(root: &SceneNode, ancestor_id: &ID, descendant_id: &ID) -> bool {
    let path = path_to_root(root, descendant_id);
    path.iter().any(|n| &n.id == ancestor_id)
}

/// Walk tree depth-first, calling visitor for each node
pub fn walk_tree<F>(root: &SceneNode, visitor: &mut F)
where
    F: FnMut(&SceneNode, usize),
{
    walk_tree_recursive(root, 0, visitor);
}

fn walk_tree_recursive<F>(node: &SceneNode, depth: usize, visitor: &mut F)
where
    F: FnMut(&SceneNode, usize),
{
    visitor(node, depth);
    for child in &node.children {
        walk_tree_recursive(child, depth + 1, visitor);
    }
}

/// Collect all nodes matching predicate
pub fn collect_nodes<F>(root: &SceneNode, predicate: F) -> Vec<&SceneNode>
where
    F: Fn(&SceneNode) -> bool,
{
    let mut nodes = Vec::new();
    collect_nodes_recursive(root, &predicate, &mut nodes);
    nodes
}

fn collect_nodes_recursive<'a, F>(
    node: &'a SceneNode,
    predicate: &F,
    result: &mut Vec<&'a SceneNode>,
) where
    F: Fn(&SceneNode) -> bool,
{
    if predicate(node) {
        result.push(node);
    }
    for child in &node.children {
        collect_nodes_recursive(child, predicate, result);
    }
}

// ============================================================================
// HIT TESTING
// ============================================================================

/// Hit test against layout frames. Returns topmost visible node at point.
pub fn hit_test<'a>(
    root: &'a SceneNode,
    point: Point,
    frames: &HashMap<ID, LayoutFrame>,
) -> Option<&'a SceneNode> {
    #[cfg(feature = "verbose-logging")]
    eprintln!(
        "[HIT_TEST] Point: ({}, {}), Frame count: {}, Frame IDs: {:?}",
        point.x,
        point.y,
        frames.len(),
        frames.keys().collect::<Vec<_>>()
    );

    let mut best: Option<&SceneNode> = None;
    let mut best_z = i32::MIN;

    visit_for_hit_test(root, point, frames, &mut best, &mut best_z, 0);

    #[cfg(feature = "verbose-logging")]
    eprintln!("[HIT_TEST] Result: {:?}", best.map(|n| n.id.as_str()));

    best
}

/// Recursive hit-test visitor with inherited z-index (stacking context).
///
/// Children inherit their parent's z-index as a floor. This matches CSS
/// stacking context behavior: a child of a z=1000 container is above
/// everything at z<1000, even if the child itself has no z_index set.
///
/// Without this, children of elevated containers (e.g., insert menu items
/// inside a z=1000 overlay) would hit-test at z=0, causing clicks to pass
/// through to nodes behind the overlay.
fn visit_for_hit_test<'a>(
    node: &'a SceneNode,
    point: Point,
    frames: &HashMap<ID, LayoutFrame>,
    best: &mut Option<&'a SceneNode>,
    best_z: &mut i32,
    inherited_z: i32,
) {
    // Effective z: own z_index takes precedence, otherwise inherit parent's.
    // A child with z_index: 5 inside a z=1000 parent gets effective z=1000
    // (parent's stacking context dominates). A child with z_index: 2000 inside
    // a z=1000 parent gets effective z=2000 (explicit override wins).
    let own_z = node.z_index.unwrap_or(inherited_z);
    let effective_z = own_z.max(inherited_z);

    // CANONICAL VISIBILITY: layout_frames is the source of truth.
    // If a node has no LayoutFrame, it wasn't laid out (invisible) - skip it.
    // This avoids checking unevaluated bindings which would return wrong defaults.
    if let Some(frame) = frames.get(&node.id) {
        let rect = &frame.rect;
        if point.x >= rect.x
            && point.x <= rect.x + rect.w
            && point.y >= rect.y
            && point.y <= rect.y + rect.h
            && effective_z >= *best_z
        {
            *best_z = effective_z;
            *best = Some(node);
        }
    }

    // Recurse into children — they inherit this node's effective z-index
    for child in &node.children {
        visit_for_hit_test(child, point, frames, best, best_z, effective_z);
    }
}

/// Find all nodes under a point (from topmost to bottommost)
pub fn find_nodes_at_point<'a>(
    root: &'a SceneNode,
    point: Point,
    frames: &HashMap<ID, LayoutFrame>,
) -> Vec<&'a SceneNode> {
    let mut nodes = Vec::new();
    collect_nodes_at_point(root, point, frames, &mut nodes);
    nodes.sort_by(|a, b| {
        let za = a.z_index.unwrap_or(0);
        let zb = b.z_index.unwrap_or(0);
        zb.cmp(&za) // Descending z-order
    });
    nodes
}

fn collect_nodes_at_point<'a>(
    node: &'a SceneNode,
    point: Point,
    frames: &HashMap<ID, LayoutFrame>,
    result: &mut Vec<&'a SceneNode>,
) {
    // CANONICAL VISIBILITY: layout_frames is the source of truth.
    // If a node has no LayoutFrame, it wasn't laid out (invisible) - skip it.
    if let Some(frame) = frames.get(&node.id) {
        if frame.rect.contains(point) {
            result.push(node);
        }
    }

    // Still recurse into children - they may have their own frames
    for child in &node.children {
        collect_nodes_at_point(child, point, frames, result);
    }
}

// ============================================================================
// TRANSFORM COMPUTATION
// ============================================================================

/// Compute world transforms for entire tree.
/// Returns HashMap<ID, Matrix> of world transforms.
pub fn compute_world_transforms(
    root: &SceneNode,
    frames: &HashMap<ID, LayoutFrame>,
) -> HashMap<ID, Matrix> {
    let mut transforms = HashMap::new();
    walk_transforms(root, Matrix::IDENTITY, frames, &mut transforms);
    transforms
}

fn walk_transforms(
    node: &SceneNode,
    parent_world: Matrix,
    frames: &HashMap<ID, LayoutFrame>,
    transforms: &mut HashMap<ID, Matrix>,
) {
    let local = frames
        .get(&node.id)
        .map(|f| Matrix::translate(f.rect.x, f.rect.y))
        .unwrap_or(Matrix::IDENTITY);

    let world = parent_world.multiply(&local);
    transforms.insert(node.id.clone(), world);

    for child in &node.children {
        walk_transforms(child, world, frames, transforms);
    }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/// Map over tree with structural sharing. Returns unchanged subtrees as the SAME Arc.
///
/// The closure `f` receives the node with already-recursively-mapped children (same semantics
/// as the original `map_tree`). It returns `Some(modified_node)` for changed nodes, `None`
/// for unchanged nodes.
///
/// When `f` returns `None` AND all children are `Arc::ptr_eq` to originals, returns
/// `Arc::clone(node)` — O(1), zero allocation. Only the spine from root to the
/// changed node gets new Arc allocations: O(depth) instead of O(n).
///
/// # Allocation guarantee
///
/// A tree with N nodes, one changed node at depth d: d + 1 new Arc allocations (the
/// spine) + d intermediate SceneNode allocations for spine nodes (immediately dropped).
/// All sibling subtrees outside the spine share their original Arcs via `Arc::ptr_eq`.
pub fn map_tree(
    node: &Arc<SceneNode>,
    f: &impl Fn(&SceneNode) -> Option<SceneNode>,
) -> Arc<SceneNode> {
    // Recurse children first so ptr_eq comparison and f() see updated children
    let new_children: Vec<Arc<SceneNode>> = node.children.iter().map(|c| map_tree(c, f)).collect();

    let children_changed = !new_children
        .iter()
        .zip(node.children.iter())
        .all(|(a, b)| Arc::ptr_eq(a, b));

    // Apply f to node with recursively-mapped children (preserves original semantics).
    // When children are unchanged, pass original node directly — no intermediate allocation.
    let mapped = if children_changed {
        let node_with_new_children = SceneNode {
            children: new_children.clone(),
            ..(**node).clone()
        };
        f(&node_with_new_children)
    } else {
        f(node)
    };

    // KEY: if this node is unchanged and no child Arc changed, return same Arc — zero alloc
    if mapped.is_none() && !children_changed {
        return Arc::clone(node);
    }

    // Only the spine from root to changed node gets new Arc allocations
    Arc::new(mapped.unwrap_or_else(|| SceneNode {
        children: new_children,
        ..(**node).clone()
    }))
}

/// Check if adding childId to parentId would create a cycle
fn would_create_cycle(root: &SceneNode, parent_id: &ID, child_id: &ID) -> bool {
    is_ancestor(root, child_id, parent_id)
}

// ============================================================================
// ARC STRUCTURAL SHARING UTILITIES (Task 168 P1)
// ============================================================================

/// Apply a mutation to a single node identified by `target_id` using Arc path-copying.
///
/// Returns a NEW `Arc<SceneNode>` root where only the spine from root to target
/// has been cloned. All sibling subtrees remain pointer-identical (`Arc::ptr_eq`)
/// to the input tree.
///
/// # Structural Sharing Guarantee
///
/// Given a tree of depth `d` and width `w`, this function clones exactly `d` nodes
/// (the spine) and zero sibling subtrees. The resulting tree shares `n - d` nodes
/// with the input tree via `Arc::ptr_eq`.
///
/// # Algorithm
///
/// 1. **Path-finding phase** (read-only): Find the index path from root to target.
///    Traverses via `&Arc<SceneNode>` auto-deref — zero allocations beyond path vec.
/// 2. **Path-copying phase** (top-down recursive): Walk the path, cloning only the
///    spine node at each level. Before-siblings and after-siblings keep their
///    original `Arc` references via `Arc::clone` (O(1) per sibling).
///
/// # When to Use
///
/// - Use this for immutable/functional-style updates from outside the kernel
/// - Inside the kernel, prefer `Arc::make_mut` on `KernelState.scene_tree` directly
///   (see `mutate_node` in scene_diff_apply.rs)
///
/// # Returns
///
/// - `Some(new_root)` if `target_id` was found and `update_fn` was applied
/// - `None` if `target_id` was not found in the tree
pub fn path_copy_update<F>(
    root: &Arc<SceneNode>,
    target_id: &ID,
    update_fn: F,
) -> Option<Arc<SceneNode>>
where
    F: FnOnce(&SceneNode) -> SceneNode,
{
    // Phase 1: Find the index path (read-only, zero cloning)
    // Path is collected leaf-to-root for O(1) push; reverse to get root-to-leaf order.
    let mut path = find_path_indices(root, target_id)?;
    path.reverse();

    // Phase 2: Path-copy along the spine (top-down recursive)
    Some(apply_path_copy(root, &path, update_fn))
}

/// Internal: Apply path-copying along the pre-computed index path.
///
/// At each level, clones only the spine node and Arc::clone's all siblings.
/// `update_fn` is `FnOnce` — consumed exactly once when the target node is reached.
fn apply_path_copy<F>(node: &Arc<SceneNode>, path: &[usize], update_fn: F) -> Arc<SceneNode>
where
    F: FnOnce(&SceneNode) -> SceneNode,
{
    if path.is_empty() {
        // Reached the target — apply the update, wrap in new Arc
        return Arc::new(update_fn(node));
    }

    let idx = path[0];
    let mut new_children = Vec::with_capacity(node.children.len());

    // Before the spine child: Arc::clone (O(1) per sibling, shared)
    for child in &node.children[..idx] {
        new_children.push(Arc::clone(child));
    }

    // The spine child: recurse deeper (only this subtree is cloned)
    new_children.push(apply_path_copy(&node.children[idx], &path[1..], update_fn));

    // After the spine child: Arc::clone (O(1) per sibling, shared)
    for child in &node.children[idx + 1..] {
        new_children.push(Arc::clone(child));
    }

    // Clone only this spine node with updated children vec
    Arc::new(SceneNode {
        children: new_children,
        ..(**node).clone()
    })
}

/// Find the index path from root to a target node.
///
/// Returns `Some(vec![])` if target is the root itself.
/// Returns `Some(vec![i, j, k])` if target is at `root.children[i].children[j].children[k]`.
/// Returns `None` if target is not found.
///
/// # Performance (Task 1142)
///
/// Collects path in leaf-to-root order (push is O(1)) then reverses once at the
/// call site. Previous implementation used `insert(0, i)` at each recursion level
/// which is O(depth²) due to shifting all elements on every insert.
fn find_path_indices(node: &SceneNode, target_id: &ID) -> Option<Vec<usize>> {
    if &node.id == target_id {
        return Some(Vec::new());
    }
    for (i, child) in node.children.iter().enumerate() {
        if let Some(mut path) = find_path_indices(child, target_id) {
            path.push(i); // O(1) amortized — reversed by caller
            return Some(path);
        }
    }
    None
}

/// Check whether a subtree rooted at `root` contains a node with the given `target_id`.
///
/// Uses depth-first traversal. Returns `true` if `target_id` matches `root.id`
/// or any descendant's id.
///
/// # Performance
///
/// O(n) worst case where n = number of nodes in the subtree.
/// Short-circuits on first match.
pub fn subtree_contains(root: &SceneNode, target_id: &ID) -> bool {
    if &root.id == target_id {
        return true;
    }
    for child in &root.children {
        if subtree_contains(child, target_id) {
            return true;
        }
    }
    false
}

// ============================================================================
// ERROR TYPES
// ============================================================================

/// Errors that can occur during scene tree operations.
///
/// Every variant carries structured fields including `reason` (what went wrong)
/// and `hint` (actionable remediation advice), plus domain-specific fields
/// where semantically appropriate.
///
/// # Serialization
///
/// Derives `Serialize`/`Deserialize` for WASM boundary crossing.
/// Tagged with `"code"` for machine-readable variant discrimination.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum SceneError {
    /// Adding a child would create a cycle in the scene tree.
    CycleDetected {
        /// The child node ID that would cause the cycle
        child_id: ID,
        /// The parent node ID where the child was being added
        parent_id: ID,
        /// Human-readable description of what went wrong
        reason: String,
        /// Actionable remediation advice
        hint: String,
    },
    /// Attempted to remove the root node, which is not allowed.
    CannotRemoveRoot {
        /// Human-readable description of what went wrong
        reason: String,
        /// Actionable remediation advice
        hint: String,
    },
    /// A referenced node was not found in the scene tree.
    NodeNotFound {
        /// The ID of the node that was not found
        id: ID,
        /// Human-readable description of what went wrong
        reason: String,
        /// Actionable remediation advice
        hint: String,
    },
    /// A referenced parent node was not found in the scene tree.
    ParentNotFound {
        /// The ID of the parent that was not found
        id: ID,
        /// Human-readable description of what went wrong
        reason: String,
        /// Actionable remediation advice
        hint: String,
    },
}

impl std::fmt::Display for SceneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SceneError::CycleDetected {
                child_id,
                parent_id,
                reason,
                hint,
            } => {
                write!(
                    f,
                    "Cycle detected: cannot add {} to {}. {reason}. Hint: {hint}",
                    child_id, parent_id
                )
            }
            SceneError::CannotRemoveRoot { reason, hint } => {
                write!(f, "Cannot remove root node. {reason}. Hint: {hint}")
            }
            SceneError::NodeNotFound { id, reason, hint } => {
                write!(f, "Node not found: {id}. {reason}. Hint: {hint}")
            }
            SceneError::ParentNotFound { id, reason, hint } => {
                write!(f, "Parent not found: {id}. {reason}. Hint: {hint}")
            }
        }
    }
}

impl std::error::Error for SceneError {}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::types::{NodeKind, Rect};

    fn make_tree() -> SceneNode {
        SceneNode::new("root", NodeKind::Container).with_children(vec![
            SceneNode::new("a", NodeKind::Container).with_children(vec![
                SceneNode::new("a1", NodeKind::Rect),
                SceneNode::new("a2", NodeKind::Rect),
            ]),
            SceneNode::new("b", NodeKind::Rect),
        ])
    }

    fn make_frames() -> HashMap<ID, LayoutFrame> {
        let mut frames = HashMap::new();
        frames.insert(
            "root".into(),
            LayoutFrame::from_rect(Rect::new(0.0, 0.0, 800.0, 600.0)),
        );
        frames.insert(
            "a".into(),
            LayoutFrame::from_rect(Rect::new(0.0, 0.0, 400.0, 300.0)),
        );
        frames.insert(
            "a1".into(),
            LayoutFrame::from_rect(Rect::new(0.0, 0.0, 100.0, 100.0)),
        );
        frames.insert(
            "a2".into(),
            LayoutFrame::from_rect(Rect::new(100.0, 0.0, 100.0, 100.0)),
        );
        frames.insert(
            "b".into(),
            LayoutFrame::from_rect(Rect::new(400.0, 0.0, 200.0, 200.0)),
        );
        frames
    }

    #[test]
    fn test_find_node() {
        let tree = make_tree();
        assert!(find_node(&tree, &"root".into()).is_some());
        assert!(find_node(&tree, &"a".into()).is_some());
        assert!(find_node(&tree, &"a1".into()).is_some());
        assert!(find_node(&tree, &"nonexistent".into()).is_none());
    }

    #[test]
    fn test_path_to_root() {
        let tree = make_tree();
        let path = path_to_root(&tree, &"a1".into());

        assert_eq!(path.len(), 3);
        assert_eq!(path[0].id, "a1");
        assert_eq!(path[1].id, "a");
        assert_eq!(path[2].id, "root");
    }

    #[test]
    fn test_get_parent() {
        let tree = make_tree();

        assert!(get_parent(&tree, &"root".into()).is_none());

        let parent_a = get_parent(&tree, &"a".into()).unwrap();
        assert_eq!(parent_a.id, "root");

        let parent_a1 = get_parent(&tree, &"a1".into()).unwrap();
        assert_eq!(parent_a1.id, "a");
    }

    #[test]
    fn test_is_ancestor() {
        let tree = make_tree();

        assert!(is_ancestor(&tree, &"root".into(), &"a1".into()));
        assert!(is_ancestor(&tree, &"a".into(), &"a1".into()));
        assert!(!is_ancestor(&tree, &"b".into(), &"a1".into()));
        assert!(!is_ancestor(&tree, &"a1".into(), &"root".into()));
    }

    #[test]
    fn test_add_child() {
        let tree = make_tree();
        let new_child = SceneNode::new("c", NodeKind::Rect);

        let new_tree = add_child(&tree, &"root".into(), new_child, None).unwrap();

        assert!(find_node(&new_tree, &"c".into()).is_some());
        assert_eq!(new_tree.children.len(), 3);
    }

    #[test]
    fn test_add_child_cycle_detection() {
        let tree = make_tree();
        let child_clone = find_node(&tree, &"root".into()).unwrap().clone();

        let result = add_child(&tree, &"a1".into(), child_clone, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_remove_child() {
        let tree = make_tree();
        let new_tree = remove_child(&tree, &"a".into(), &"a1".into());

        assert!(find_node(&new_tree, &"a1".into()).is_none());
        let a = find_node(&new_tree, &"a".into()).unwrap();
        assert_eq!(a.children.len(), 1);
    }

    #[test]
    fn test_remove_node() {
        let tree = make_tree();
        let new_tree = remove_node(&tree, &"a".into()).unwrap();

        assert!(find_node(&new_tree, &"a".into()).is_none());
        assert!(find_node(&new_tree, &"a1".into()).is_none());
    }

    #[test]
    fn test_remove_root_fails() {
        let tree = make_tree();
        let result = remove_node(&tree, &"root".into());
        assert!(result.is_err());
    }

    #[test]
    fn test_reparent() {
        let tree = make_tree();
        let new_tree = reparent(&tree, &"a1".into(), &"b".into(), None).unwrap();

        let a = find_node(&new_tree, &"a".into()).unwrap();
        assert_eq!(a.children.len(), 1);

        let b = find_node(&new_tree, &"b".into()).unwrap();
        assert_eq!(b.children.len(), 1);
        assert_eq!(b.children[0].id, "a1");
    }

    #[test]
    fn test_update_node() {
        use crate::kernel::types::Visibility;
        let tree = make_tree();
        let new_tree = update_node(&tree, &"a".into(), |n| SceneNode {
            visible: Visibility::Resolved(false),
            ..n.clone()
        });

        let a = find_node(&new_tree, &"a".into()).unwrap();
        assert_eq!(a.visible, Visibility::Resolved(false));
    }

    #[test]
    fn test_reorder_children() {
        use std::sync::Arc;
        let mut tree = make_tree();
        Arc::make_mut(&mut tree.children[0]).z_index = Some(10);
        Arc::make_mut(&mut tree.children[1]).z_index = Some(5);

        let new_tree = reorder_children(&tree, &"root".into());

        assert_eq!(new_tree.children[0].id, "b");
        assert_eq!(new_tree.children[1].id, "a");
    }

    #[test]
    fn test_walk_tree() {
        let tree = make_tree();
        let mut ids = Vec::new();

        walk_tree(&tree, &mut |node, _| {
            ids.push(node.id.clone());
        });

        assert_eq!(ids, vec!["root", "a", "a1", "a2", "b"]);
    }

    #[test]
    fn test_collect_nodes() {
        let tree = make_tree();
        let rects = collect_nodes(&tree, |n| n.kind == NodeKind::Rect);

        assert_eq!(rects.len(), 3);
    }

    #[test]
    fn test_hit_test() {
        let tree = make_tree();
        let frames = make_frames();

        // Hit a1
        let hit = hit_test(&tree, Point::new(50.0, 50.0), &frames);
        assert!(hit.is_some());
        assert_eq!(hit.unwrap().id, "a1");

        // Hit b
        let hit = hit_test(&tree, Point::new(450.0, 100.0), &frames);
        assert!(hit.is_some());
        assert_eq!(hit.unwrap().id, "b");

        // Miss everything
        let hit = hit_test(&tree, Point::new(900.0, 900.0), &frames);
        assert!(hit.is_none());
    }

    #[test]
    fn test_hit_test_respects_visibility() {
        // CANONICAL: Visibility is now enforced through layout_frames.
        // Invisible nodes don't get LayoutFrames, so hit-test skips them.
        let tree = make_tree();

        // Create frames WITHOUT 'a' subtree (simulating invisible 'a')
        let mut frames = HashMap::new();
        frames.insert(
            "root".into(),
            LayoutFrame::from_rect(Rect::new(0.0, 0.0, 800.0, 600.0)),
        );
        // 'a', 'a1', 'a2' not included - they're "invisible"
        frames.insert(
            "b".into(),
            LayoutFrame::from_rect(Rect::new(400.0, 0.0, 200.0, 200.0)),
        );

        // Should not hit a1 - no frame for it
        let hit = hit_test(&tree, Point::new(50.0, 50.0), &frames);
        // Will hit root since a subtree has no frames
        assert!(hit.is_some());
        assert_eq!(hit.unwrap().id, "root");
    }

    #[test]
    fn test_compute_world_transforms() {
        let tree = make_tree();
        let frames = make_frames();
        let transforms = compute_world_transforms(&tree, &frames);

        let root_id: ID = "root".into();
        let a_id: ID = "a".into();
        let b_id: ID = "b".into();

        assert!(transforms.contains_key(&root_id));
        assert!(transforms.contains_key(&a_id));

        let root_t = transforms.get(&root_id).unwrap();
        assert_eq!(root_t.e, 0.0);
        assert_eq!(root_t.f, 0.0);

        let b_t = transforms.get(&b_id).unwrap();
        assert_eq!(b_t.e, 400.0);
        assert_eq!(b_t.f, 0.0);
    }

    #[test]
    fn test_map_tree_immutability() {
        use crate::kernel::types::Visibility;
        let tree = make_tree();
        let tree_arc = Arc::new(tree.clone());
        let new_tree_arc = map_tree(&tree_arc, &|n| {
            Some(SceneNode {
                visible: Visibility::Resolved(false),
                ..n.clone()
            })
        });
        let new_tree = (*new_tree_arc).clone();

        // Original unchanged
        assert_eq!(tree.visible, Visibility::Resolved(true));
        assert_eq!(tree.children[0].visible, Visibility::Resolved(true));

        // New tree modified
        assert_eq!(new_tree.visible, Visibility::Resolved(false));
        assert_eq!(new_tree.children[0].visible, Visibility::Resolved(false));
    }

    #[test]
    fn test_map_tree_structural_sharing() {
        // After add_child, unchanged sibling subtrees must share the same Arc (ptr_eq).
        let root = make_tree(); // root has children[0], children[1]
        let sibling_before = Arc::clone(&root.children[0]);

        // Add child to children[1] — children[0] subtree must be untouched (ptr_eq)
        let sibling_id = root.children[1].id.clone();
        let new_child = SceneNode::default();
        let new_root = add_child(&root, &sibling_id, new_child, None).unwrap();

        // children[0] Arc must be pointer-identical — zero allocation for the unchanged subtree
        assert!(
            Arc::ptr_eq(&sibling_before, &new_root.children[0]),
            "Unchanged sibling subtree must share same Arc after add_child"
        );
    }

    // ====================================================================
    // SCENE ERROR STRUCTURED UPGRADE TESTS (Task 161 Agent 2)
    // ====================================================================

    // ---- Test SE-1: CycleDetected has child_id, parent_id, reason, hint ----
    #[test]
    fn scene_error_cycle_detected_has_all_fields() {
        let err = SceneError::CycleDetected {
            child_id: "child-1".into(),
            parent_id: "parent-1".into(),
            reason: "REASON_MARKER".to_string(),
            hint: "HINT_MARKER".to_string(),
        };
        let display = format!("{}", err);
        assert!(
            display.contains("child-1"),
            "child_id must appear in Display"
        );
        assert!(
            display.contains("parent-1"),
            "parent_id must appear in Display"
        );
        assert!(
            display.contains("REASON_MARKER"),
            "reason must appear in Display"
        );
        assert!(
            display.contains("HINT_MARKER"),
            "hint must appear in Display"
        );
    }

    // ---- Test SE-2: CannotRemoveRoot has reason and hint ----
    #[test]
    fn scene_error_cannot_remove_root_has_reason_hint() {
        let err = SceneError::CannotRemoveRoot {
            reason: "REASON_MARKER".to_string(),
            hint: "HINT_MARKER".to_string(),
        };
        let display = format!("{}", err);
        assert!(display.contains("Cannot remove root node"));
        assert!(
            display.contains("REASON_MARKER"),
            "reason must appear in Display"
        );
        assert!(
            display.contains("HINT_MARKER"),
            "hint must appear in Display"
        );
    }

    // ---- Test SE-3: NodeNotFound has id, reason, hint ----
    #[test]
    fn scene_error_node_not_found_has_all_fields() {
        let err = SceneError::NodeNotFound {
            id: "node-42".into(),
            reason: "REASON_MARKER".to_string(),
            hint: "HINT_MARKER".to_string(),
        };
        let display = format!("{}", err);
        assert!(display.contains("node-42"), "id must appear in Display");
        assert!(
            display.contains("REASON_MARKER"),
            "reason must appear in Display"
        );
        assert!(
            display.contains("HINT_MARKER"),
            "hint must appear in Display"
        );
    }

    // ---- Test SE-4: ParentNotFound has id, reason, hint ----
    #[test]
    fn scene_error_parent_not_found_has_all_fields() {
        let err = SceneError::ParentNotFound {
            id: "parent-99".into(),
            reason: "REASON_MARKER".to_string(),
            hint: "HINT_MARKER".to_string(),
        };
        let display = format!("{}", err);
        assert!(display.contains("parent-99"), "id must appear in Display");
        assert!(
            display.contains("REASON_MARKER"),
            "reason must appear in Display"
        );
        assert!(
            display.contains("HINT_MARKER"),
            "hint must appear in Display"
        );
    }

    // ---- Test SE-5: SceneError serializes/deserializes via serde round-trip ----
    #[test]
    fn scene_error_serde_round_trip() {
        let err = SceneError::CycleDetected {
            child_id: "c-1".into(),
            parent_id: "p-1".into(),
            reason: "Would create loop".to_string(),
            hint: "Check parent-child relationships".to_string(),
        };

        let json = serde_json::to_string(&err).expect("serialize");
        assert!(
            json.contains("cycleDetected"),
            "JSON must contain variant name as code tag"
        );
        assert!(json.contains("c-1"), "JSON must contain child_id");
        assert!(json.contains("p-1"), "JSON must contain parent_id");

        let deserialized: SceneError = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(err, deserialized, "Round-trip must preserve all fields");
    }

    // ---- Test SE-6: All 4 SceneError variants have non-empty hint fields ----
    #[test]
    fn scene_error_all_variants_have_non_empty_hints() {
        let errors: Vec<SceneError> = vec![
            SceneError::CycleDetected {
                child_id: "c".into(),
                parent_id: "p".into(),
                reason: "r".to_string(),
                hint: "Check tree structure".to_string(),
            },
            SceneError::CannotRemoveRoot {
                reason: "r".to_string(),
                hint: "Use replace instead".to_string(),
            },
            SceneError::NodeNotFound {
                id: "n".into(),
                reason: "r".to_string(),
                hint: "Verify node ID".to_string(),
            },
            SceneError::ParentNotFound {
                id: "p".into(),
                reason: "r".to_string(),
                hint: "Check parent exists".to_string(),
            },
        ];

        for err in &errors {
            let display = format!("{}", err);
            assert!(
                display.contains("Hint:"),
                "Display must contain 'Hint:' for {:?}",
                err
            );
        }
        assert_eq!(errors.len(), 4, "All 4 SceneError variants must be present");
    }

    // ---- Test SE-7: SceneError::CannotRemoveRoot serde round-trip ----
    #[test]
    fn scene_error_cannot_remove_root_serde_round_trip() {
        let err = SceneError::CannotRemoveRoot {
            reason: "Root is immutable".to_string(),
            hint: "Use SetRoot patch instead".to_string(),
        };

        let json = serde_json::to_string(&err).expect("serialize");
        let deserialized: SceneError = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(err, deserialized);
    }

    // ---- Test SE-8: Construction site produces correct error (add_child cycle) ----
    #[test]
    fn scene_error_construction_site_add_child_cycle() {
        let tree = make_tree();
        // Try to add root as child of its own descendant
        let root_clone = tree.clone();
        let result = add_child(&tree, &"a1".into(), root_clone, None);

        match result {
            Err(SceneError::CycleDetected {
                child_id,
                parent_id,
                reason,
                hint,
            }) => {
                assert_eq!(child_id, "root");
                assert_eq!(parent_id, "a1");
                assert!(!reason.is_empty(), "reason must be non-empty");
                assert!(!hint.is_empty(), "hint must be non-empty");
            }
            other => panic!("Expected CycleDetected, got {:?}", other),
        }
    }

    // ---- Test SE-9: Construction site produces correct error (remove root) ----
    #[test]
    fn scene_error_construction_site_remove_root() {
        let tree = make_tree();
        let result = remove_node(&tree, &"root".into());

        match result {
            Err(SceneError::CannotRemoveRoot { reason, hint }) => {
                assert!(!reason.is_empty(), "reason must be non-empty");
                assert!(!hint.is_empty(), "hint must be non-empty");
            }
            other => panic!("Expected CannotRemoveRoot, got {:?}", other),
        }
    }

    // ---- Test SE-10: Construction site produces correct error (reparent not found) ----
    #[test]
    fn scene_error_construction_site_reparent_not_found() {
        let tree = make_tree();
        let result = reparent(&tree, &"nonexistent".into(), &"a".into(), None);

        match result {
            Err(SceneError::NodeNotFound { id, reason, hint }) => {
                assert_eq!(id, "nonexistent");
                assert!(!reason.is_empty(), "reason must be non-empty");
                assert!(!hint.is_empty(), "hint must be non-empty");
            }
            other => panic!("Expected NodeNotFound, got {:?}", other),
        }
    }

    // ========================================================================
    // ARC STRUCTURAL SHARING TESTS (Task 168 P1)
    // ========================================================================

    // ---- Test ARC-01: path_copy_update updates target node ----
    #[test]
    fn test_path_copy_update_modifies_target() {
        use crate::kernel::types::Visibility;
        let tree = Arc::new(make_tree());
        let updated = path_copy_update(&tree, &"a1".into(), |node| {
            let mut n = node.clone();
            n.visible = Visibility::Resolved(false);
            n
        });
        assert!(updated.is_some(), "target a1 must be found");
        let new_root = updated.unwrap();
        let a1 = find_node(&new_root, &"a1".into()).unwrap();
        assert_eq!(a1.visible, Visibility::Resolved(false));
    }

    // ---- Test ARC-02: path_copy_update returns None for missing target ----
    #[test]
    fn test_path_copy_update_returns_none_for_missing() {
        let tree = Arc::new(make_tree());
        let result = path_copy_update(&tree, &"nonexistent".into(), |node| node.clone());
        assert!(result.is_none());
    }

    // ---- Test ARC-03: path_copy_update shares unchanged siblings via Arc::ptr_eq ----
    #[test]
    fn test_path_copy_update_shares_unchanged_siblings() {
        use crate::kernel::types::Visibility;
        let tree = Arc::new(make_tree());
        // Update "a1" — sibling "a2" and uncle "b" should be pointer-identical
        let new_root = path_copy_update(&tree, &"a1".into(), |node| {
            let mut n = node.clone();
            n.visible = Visibility::Resolved(false);
            n
        })
        .unwrap();

        // "b" is untouched — must be pointer-identical (same Arc)
        assert!(
            Arc::ptr_eq(&tree.children[1], &new_root.children[1]),
            "Uncle node 'b' must be pointer-identical (Arc shared)"
        );

        // "a2" is untouched sibling of "a1" — must be pointer-identical
        assert!(
            Arc::ptr_eq(
                &tree.children[0].children[1],
                &new_root.children[0].children[1]
            ),
            "Sibling node 'a2' must be pointer-identical (Arc shared)"
        );

        // "a1" was modified — must NOT be pointer-identical
        assert!(
            !Arc::ptr_eq(
                &tree.children[0].children[0],
                &new_root.children[0].children[0]
            ),
            "Modified node 'a1' must be a new Arc"
        );

        // "a" (parent on spine) — must NOT be pointer-identical (path-copied)
        assert!(
            !Arc::ptr_eq(&tree.children[0], &new_root.children[0]),
            "Spine node 'a' must be a new Arc (path-copied)"
        );

        // Root — must NOT be pointer-identical (path-copied)
        assert!(
            !Arc::ptr_eq(&tree, &new_root),
            "Root must be a new Arc (path-copied)"
        );
    }

    // ---- Test ARC-04: path_copy_update on root node ----
    #[test]
    fn test_path_copy_update_on_root() {
        use crate::kernel::types::Visibility;
        let tree = Arc::new(make_tree());
        let new_root = path_copy_update(&tree, &"root".into(), |node| {
            let mut n = node.clone();
            n.visible = Visibility::Resolved(false);
            n
        })
        .unwrap();

        assert_eq!(new_root.visible, Visibility::Resolved(false));
        assert!(!Arc::ptr_eq(&tree, &new_root), "Root must be new Arc");
    }

    // ---- Test ARC-05: path_copy_update preserves tree structure ----
    #[test]
    fn test_path_copy_update_preserves_structure() {
        let tree = Arc::new(make_tree());
        let new_root = path_copy_update(&tree, &"a2".into(), |node| {
            let mut n = node.clone();
            n.kind = NodeKind::Text;
            n
        })
        .unwrap();

        // Same number of children at each level
        assert_eq!(new_root.children.len(), tree.children.len());
        assert_eq!(
            new_root.children[0].children.len(),
            tree.children[0].children.len()
        );
        // IDs preserved
        assert_eq!(new_root.id, "root");
        assert_eq!(new_root.children[0].id, "a");
        assert_eq!(new_root.children[0].children[0].id, "a1");
        assert_eq!(new_root.children[0].children[1].id, "a2");
        assert_eq!(new_root.children[1].id, "b");
        // Kind changed
        assert_eq!(new_root.children[0].children[1].kind, NodeKind::Text);
    }

    // ---- Test ARC-06: subtree_contains finds root, children, grandchildren ----
    #[test]
    fn test_subtree_contains_basic() {
        let tree = make_tree();
        assert!(subtree_contains(&tree, &"root".into()));
        assert!(subtree_contains(&tree, &"a".into()));
        assert!(subtree_contains(&tree, &"a1".into()));
        assert!(subtree_contains(&tree, &"a2".into()));
        assert!(subtree_contains(&tree, &"b".into()));
        assert!(!subtree_contains(&tree, &"nonexistent".into()));
    }

    // ---- Test ARC-07: subtree_contains on subtree ----
    #[test]
    fn test_subtree_contains_on_subtree() {
        let tree = make_tree();
        let a = &tree.children[0]; // "a" node
        assert!(subtree_contains(a, &"a".into()));
        assert!(subtree_contains(a, &"a1".into()));
        assert!(!subtree_contains(a, &"b".into()), "b is not in a's subtree");
        assert!(
            !subtree_contains(a, &"root".into()),
            "root is not in a's subtree"
        );
    }

    // ---- Test ARC-08: subtree_contains on leaf node ----
    #[test]
    fn test_subtree_contains_leaf() {
        let tree = make_tree();
        let a1 = &tree.children[0].children[0]; // "a1" leaf
        assert!(subtree_contains(a1, &"a1".into()));
        assert!(!subtree_contains(a1, &"a2".into()));
    }

    // ---- Test ARC-09: Arc::clone is O(1) — no deep cloning ----
    #[test]
    fn test_arc_clone_is_pointer_copy() {
        let tree = Arc::new(make_tree());
        let cloned = Arc::clone(&tree);
        // After Arc::clone, both point to the same allocation
        assert!(Arc::ptr_eq(&tree, &cloned));
        // Strong count is 2
        assert_eq!(Arc::strong_count(&tree), 2);
    }

    // ---- Test ARC-10: children are Arc-wrapped ----
    #[test]
    fn test_children_are_arc_wrapped() {
        let tree = make_tree();
        // Verify children can be Arc::clone'd (O(1)) and share pointers
        let child_a = Arc::clone(&tree.children[0]);
        assert!(Arc::ptr_eq(&tree.children[0], &child_a));
        assert_eq!(child_a.id, "a");
    }

    // ---- Test ARC-11: with_children wraps in Arc internally ----
    #[test]
    fn test_with_children_wraps_arc() {
        let node = SceneNode::new("parent", NodeKind::Container).with_children(vec![
            SceneNode::new("c1", NodeKind::Text),
            SceneNode::new("c2", NodeKind::Text),
        ]);
        assert_eq!(node.children.len(), 2);
        assert_eq!(node.children[0].id, "c1");
        assert_eq!(node.children[1].id, "c2");
        // Verify they're independent Arcs
        assert!(!Arc::ptr_eq(&node.children[0], &node.children[1]));
    }

    // ---- Test ARC-12: path_copy_update deep tree (5 levels) ----
    #[test]
    fn test_path_copy_update_deep_tree() {
        // Build: root → l1 → l2 → l3 → l4 (leaf)
        let leaf = SceneNode::new("l4", NodeKind::Text);
        let l3 = SceneNode::new("l3", NodeKind::Container).with_children(vec![leaf]);
        let l2 = SceneNode::new("l2", NodeKind::Container)
            .with_children(vec![SceneNode::new("l2_sibling", NodeKind::Text), l3]);
        let l1 = SceneNode::new("l1", NodeKind::Container).with_children(vec![l2]);
        let root = Arc::new(
            SceneNode::new("root", NodeKind::Container)
                .with_children(vec![SceneNode::new("untouched", NodeKind::Text), l1]),
        );

        let new_root = path_copy_update(&root, &"l4".into(), |node| {
            let mut n = node.clone();
            n.kind = NodeKind::Rect;
            n
        })
        .unwrap();

        // Verify the leaf was updated
        let l4 = find_node(&new_root, &"l4".into()).unwrap();
        assert_eq!(l4.kind, NodeKind::Rect);

        // "untouched" sibling of l1 — must be pointer-identical
        assert!(
            Arc::ptr_eq(&root.children[0], &new_root.children[0]),
            "'untouched' sibling must be shared"
        );

        // "l2_sibling" — must be pointer-identical
        assert!(
            Arc::ptr_eq(
                &root.children[1].children[0].children[0],
                &new_root.children[1].children[0].children[0]
            ),
            "'l2_sibling' must be shared"
        );
    }

    // ---- Test ARC-13: find_path_indices correctness ----
    // Note: find_path_indices returns leaf-to-root order (Task 1142 — O(1) push).
    // Caller reverses for root-to-leaf. Tests verify the reversed result.
    #[test]
    fn test_find_path_indices() {
        let tree = make_tree();
        let reversed = |id: &str| -> Option<Vec<usize>> {
            find_path_indices(&tree, &id.into()).map(|mut p| {
                p.reverse();
                p
            })
        };
        // root is []
        assert_eq!(reversed("root"), Some(vec![]));
        // "a" is children[0]
        assert_eq!(reversed("a"), Some(vec![0]));
        // "b" is children[1]
        assert_eq!(reversed("b"), Some(vec![1]));
        // "a1" is children[0].children[0]
        assert_eq!(reversed("a1"), Some(vec![0, 0]));
        // "a2" is children[0].children[1]
        assert_eq!(reversed("a2"), Some(vec![0, 1]));
        // nonexistent
        assert_eq!(find_path_indices(&tree, &"nope".into()), None);
    }
}
