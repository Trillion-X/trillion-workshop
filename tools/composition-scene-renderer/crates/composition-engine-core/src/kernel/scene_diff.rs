//! crates/composition-engine-core/src/kernel/scene_diff.rs
//!
//! Core scene diffing algorithm - computes minimal, deterministic patches
//! to transform one SceneNode tree into another.
//!
//! # Purpose
//!
//! This module implements the "Physics of Continuity" for the Composition Engine.
//! It enables efficient UI updates while preserving ephemeral state (focus, FSM,
//! gestures, animations) for nodes that survive the update.
//!
//! # Non-Negotiable Invariants
//!
//! 1. **UNIQUE IDS**: Every node ID in a tree must be unique. Duplicates are validation errors.
//! 2. **DETERMINISM**: Same input trees always produce byte-identical patch lists.
//! 3. **O(N) COMPLEXITY**: Diff is linear in total node count. Never O(N²).
//! 4. **ITERATIVE SAFETY**: No recursion. All traversal uses explicit stack.
//! 5. **KIND STABILITY**: Same ID implies same kind. Violation is a structured error.
//! 6. **CORRECTNESS THEOREM**: apply(old, diff(old, new)) == new
//!
//! # Algorithm Overview
//!
//! ```text
//! diff_scene(old, new) -> Result<Vec<ScenePatch>, SceneDiffError>
//!
//! 1. VALIDATE: Check both trees (unique IDs, valid format)
//! 2. INDEX: Build SceneIndex for old and new trees
//! 3. DETECT ROOT CHANGE: If root IDs differ, emit SetRoot and return
//! 4. VALIDATE KIND STABILITY: Same IDs must have same kind (error if violated)
//! 5. BUCKET PATCHES: Collect into separate vectors (NOT one Vec):
//!    - removals: IDs in old but not in new (deepest-first)
//!    - moves: Same-ID nodes with different parent
//!    - reorders: Parents whose children changed order (BTreeSet for determinism)
//!    - insertions: IDs in new but not in old (parent-before-child, sibling-index order)
//!    - updates: Same-ID nodes with property differences
//! 6. CONCATENATE: Return patches in CANONICAL ORDER
//! ```

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use super::scene_diff_types::{DiffDiagnostics, PropChanges, SceneDiffError, ScenePatch};
use super::scene_index::{validate_id, SceneIndex};
use super::types::{SceneNode, ID};

// ============================================================================
// Public API
// ============================================================================

/// Compute minimal, deterministic patches to transform old tree into new tree.
///
/// # Invariants Enforced
///
/// - UNIQUE IDS: Duplicates are validation errors
/// - KIND STABILITY: Same ID must have same kind
/// - DETERMINISM: Same inputs always produce identical patches
/// - O(N) COMPLEXITY: Linear in total node count
///
/// # Returns
///
/// - `Ok(patches)` in canonical order: removals, insertions, moves, reorders, updates
/// - `Err` if validation fails (duplicate IDs, invalid IDs, kind stability violation)
///
/// # Example
///
/// ```rust,ignore
/// let old_tree = SceneNode::new("root", NodeKind::Container);
/// let new_tree = SceneNode::new("root", NodeKind::Container)
///     .with_children(vec![SceneNode::new("child", NodeKind::Text)]);
///
/// let patches = diff_scene(&old_tree, &new_tree)?;
/// // patches contains a single InsertNode patch
/// ```
pub fn diff_scene(
    old_root: &SceneNode,
    new_root: &SceneNode,
) -> Result<Vec<ScenePatch>, SceneDiffError> {
    let start = web_time::Instant::now();

    // 1. VALIDATE: Check both trees (unique IDs, valid format)
    validate_tree(old_root, "old tree")?;
    validate_tree(new_root, "new tree")?;

    // 2. INDEX: Build SceneIndex for old and new trees (O(N) each)
    let old_index = SceneIndex::build(old_root)?;
    let new_index = SceneIndex::build(new_root)?;

    // 3. DETECT ROOT CHANGE: If root IDs differ, emit SetRoot and return
    if old_root.id != new_root.id {
        return Ok(vec![ScenePatch::SetRoot {
            node: new_root.clone(),
        }]);
    }

    // 4. VALIDATE KIND STABILITY: Same IDs must have same kind (error if violated)
    let old_nodes = build_node_map(old_root);
    let new_nodes = build_node_map(new_root);
    validate_kind_stability(&old_nodes, &new_nodes, &new_index)?;

    // 5. BUCKET PATCHES: Collect into separate vectors (NOT one shared Vec)
    let removals = compute_removals(&old_index, &new_index);
    let (mut moves, reorders) =
        compute_moves_and_reorders(&old_nodes, &new_nodes, &old_index, &new_index);
    let insertions = compute_insertions(new_root, &old_index, &new_index);
    let updates = compute_updates(&old_nodes, &new_nodes, &new_index);

    // 6. CONCATENATE: Return patches in CANONICAL ORDER (by construction, not convention)
    let mut patches = Vec::with_capacity(
        removals.len() + moves.len() + reorders.len() + insertions.len() + updates.len(),
    );
    patches.extend(removals); // First: removals (deepest-first)
    moves.sort_by_key(|patch| match patch {
        ScenePatch::MoveNode { new_parent_id, new_index, .. } => (new_parent_id.clone(), *new_index),
        _ => unreachable!("moves contain only move patches"),
    });
    patches.extend(insertions); // Create destinations before moving surviving nodes.
    patches.extend(moves);
    patches.extend(reorders);
    patches.extend(updates); // Fifth: property updates

    let _elapsed = start.elapsed();
    // Note: DiffDiagnostics is returned by apply_patches, not diff_scene

    Ok(patches)
}

/// Compute diff and return diagnostics along with patches.
///
/// This is useful for observability - monitoring diff performance.
pub fn diff_scene_with_diagnostics(
    old_root: &SceneNode,
    new_root: &SceneNode,
) -> Result<(Vec<ScenePatch>, DiffDiagnostics), SceneDiffError> {
    let start = web_time::Instant::now();
    let patches = diff_scene(old_root, new_root)?;

    // Build diagnostics
    let mut diagnostics = DiffDiagnostics::default();
    for patch in &patches {
        match patch {
            ScenePatch::SetRoot { .. } => diagnostics.root_replaced = true,
            ScenePatch::RemoveSubtree { .. } => diagnostics.nodes_removed += 1,
            ScenePatch::MoveNode { .. } => diagnostics.nodes_moved += 1,
            ScenePatch::ReorderChildren { .. } => diagnostics.reorders += 1,
            ScenePatch::InsertNode { .. } => diagnostics.nodes_inserted += 1,
            ScenePatch::UpdateProps { .. } => diagnostics.nodes_updated += 1,
        }
    }
    diagnostics.patch_count = patches.len();
    diagnostics.elapsed_micros = start.elapsed().as_micros() as u64;

    Ok((patches, diagnostics))
}

// ============================================================================
// Validation Functions
// ============================================================================

/// Validates a scene tree for unique IDs and valid ID format.
///
/// Uses iterative traversal (no recursion) to prevent stack overflow.
fn validate_tree(root: &SceneNode, context: &str) -> Result<(), SceneDiffError> {
    let mut seen_ids: HashSet<&str> = HashSet::new();
    let mut stack: Vec<&SceneNode> = vec![root];

    while let Some(node) = stack.pop() {
        // Validate ID format
        validate_id(&node.id)?;

        // Check uniqueness
        if !seen_ids.insert(&node.id) {
            return Err(SceneDiffError::DuplicateId {
                id: node.id.clone(),
                context: context.to_string(),
            });
        }

        // Push children onto stack (reverse order for left-to-right processing)
        for child in node.children.iter().rev() {
            stack.push(child);
        }
    }

    Ok(())
}

/// Validates that same-ID nodes have same kind (KIND STABILITY invariant).
///
/// This MUST be called before computing diffs - kind changes are errors, not patches.
fn validate_kind_stability(
    old_nodes: &HashMap<ID, &SceneNode>,
    new_nodes: &HashMap<ID, &SceneNode>,
    new_index: &SceneIndex,
) -> Result<(), SceneDiffError> {
    // Process in deterministic order using new_index
    for id in new_index.ids_shallowest_first() {
        if let Some(old_node) = old_nodes.get(&id) {
            let new_node = new_nodes.get(&id).unwrap();
            if old_node.kind != new_node.kind {
                return Err(SceneDiffError::KindChangedForId {
                    id: id.clone(),
                    old_kind: old_node.kind,
                    new_kind: new_node.kind,
                });
            }
        }
    }

    Ok(())
}

// ============================================================================
// Patch Computation Functions
// ============================================================================

/// Returns removals in deepest-first order (deterministic).
///
/// Key insight: Only emit `RemoveSubtree` for "removal roots" - nodes whose
/// parent still exists in the new tree. Descendants are implicitly removed.
fn compute_removals(old_index: &SceneIndex, new_index: &SceneIndex) -> Vec<ScenePatch> {
    let mut removals = Vec::new();

    // Get all old IDs sorted deepest-first (deterministic via depth, then ID)
    let old_ids = old_index.ids_deepest_first();

    for id in old_ids {
        // Skip if node exists in new tree
        if new_index.contains(&id) {
            continue;
        }

        // Check if this is a "removal root" (parent exists in new tree OR is root)
        let parent_id = old_index.get_parent_id(&id);
        let is_removal_root = match parent_id {
            None => true,                         // Root node being removed
            Some(pid) => new_index.contains(pid), // Parent survives
        };

        if is_removal_root {
            removals.push(ScenePatch::RemoveSubtree { node_id: id });
        }
        // Descendants are NOT emitted - they're implicitly removed
    }

    removals
}

/// Returns insertions in the order patch application needs:
/// parents before children, and siblings in their actual target index order.
///
/// Key insight: Only emit `InsertNode` for "insertion roots" - nodes whose
/// parent exists in the old tree. Descendants that already exist are omitted:
/// they are moved into the inserted container by their own patches, so the
/// insert never duplicates a live node.
fn compute_insertions(
    new_root: &SceneNode,
    old_index: &SceneIndex,
    new_index: &SceneIndex,
) -> Vec<ScenePatch> {
    let mut insertions = Vec::new();
    let new_nodes = build_node_map(new_root);

    // Tree preorder is the canonical insertion order. Sorting same-depth nodes
    // by ID is deterministic, but it is not patch-correct: inserting child
    // index 5 before child index 1 is invalid when the parent is still growing.
    let mut stack: Vec<&SceneNode> = vec![new_root];
    while let Some(node) = stack.pop() {
        for child in node.children.iter().rev() {
            stack.push(child);
        }

        // Skip if node exists in old tree (it's an update/move, not insert)
        if old_index.contains(&node.id) {
            continue;
        }

        let location = new_index.get_location(&node.id).unwrap();

        // Handle root insertion (new root with different ID is SetRoot, not InsertNode)
        // This case is already handled in diff_scene() main function
        if location.parent_id.is_none() {
            continue;
        }

        let parent_id = location.parent_id.clone().unwrap();

        // Check if this is an "insertion root" (parent exists in old tree)
        // If parent is ALSO new, skip this node - it will be included in the parent's InsertNode
        // (InsertNode includes the full subtree atomically)
        if !old_index.contains(&parent_id) {
            continue;
        }

        // Incoming retained siblings arrive only in the later move phase.
        // Their final positions are not available insertion positions yet.
        let index = new_nodes[&parent_id].children[..location.index_in_parent]
            .iter()
            .filter(|child| !old_index.contains(&child.id)
                || old_index.get_parent_id(&child.id) == Some(&parent_id))
            .count();
        insertions.push(ScenePatch::InsertNode {
            parent_id,
            index,
            node: insertion_subtree(node, old_index),
        });
    }

    insertions
}

/// Builds the payload for an insertion root. Existing descendants must not be
/// copied into it: they retain identity and arrive through MoveNode patches.
/// Traversal is iterative because documents may be arbitrarily deep.
fn insertion_subtree(node: &SceneNode, old_index: &SceneIndex) -> SceneNode {
    let mut built: HashMap<ID, SceneNode> = HashMap::new();
    let mut stack: Vec<(&SceneNode, bool)> = vec![(node, false)];
    while let Some((current, visited)) = stack.pop() {
        if old_index.contains(&current.id) { continue; }
        if !visited {
            stack.push((current, true));
            for child in current.children.iter().rev() {
                if !old_index.contains(&child.id) {
                    stack.push((child.as_ref(), false));
                }
            }
            continue;
        }
        let mut cloned = current.clone();
        cloned.children = current.children.iter()
            .filter(|child| !old_index.contains(&child.id))
            .map(|child| Arc::new(built.remove(&child.id).expect("new child is built before its parent")))
            .collect();
        built.insert(current.id.clone(), cloned);
    }
    built.remove(&node.id).expect("insertion root is new")
}

/// Returns (moves, reorders) as separate vectors.
///
/// Uses `BTreeSet` (NOT `HashSet`) for `parents_to_check` to guarantee
/// deterministic iteration order.
fn compute_moves_and_reorders(
    old_nodes: &HashMap<ID, &SceneNode>,
    new_nodes: &HashMap<ID, &SceneNode>,
    old_index: &SceneIndex,
    new_index: &SceneIndex,
) -> (Vec<ScenePatch>, Vec<ScenePatch>) {
    let mut moves = Vec::new();

    // BTreeSet guarantees deterministic iteration (sorted by ID)
    // NOT HashSet - HashSet iteration order is non-deterministic!
    let mut parents_to_check: BTreeSet<ID> = BTreeSet::new();

    // Process in new-tree preorder for determinism
    let new_ids = new_index.ids_shallowest_first();

    for id in new_ids {
        // Skip if this is an insertion (not in old tree)
        if !old_nodes.contains_key(&id) {
            continue;
        }

        let old_loc = old_index.get_location(&id).unwrap();
        let new_loc = new_index.get_location(&id).unwrap();

        // Check for reparenting (different parent)
        if old_loc.parent_id != new_loc.parent_id {
            if let Some(new_parent_id) = &new_loc.parent_id {
                moves.push(ScenePatch::MoveNode {
                    node_id: id.clone(),
                    new_parent_id: new_parent_id.clone(),
                    new_index: new_loc.index_in_parent,
                });
            }
            // If new_loc.parent_id is None, it means node became root - handled separately
        } else if old_loc.index_in_parent != new_loc.index_in_parent {
            // Same parent, different index = needs reorder
            if let Some(pid) = &new_loc.parent_id {
                parents_to_check.insert(pid.clone());
            }
        }
    }

    // Emit ReorderChildren for parents with reordered children
    // BTreeSet iteration is sorted by ID (deterministic)
    //
    // Reorders run after insertions, so the final order must include every
    // target child, including new nodes.
    let reorders: Vec<ScenePatch> = parents_to_check
        .into_iter()
        .filter_map(|parent_id| {
            let new_parent = new_nodes.get(&parent_id).unwrap();

            let new_order: Vec<ID> = new_parent
                .children
                .iter()
                .map(|c| c.id.clone())
                .collect();

            if new_order.len() >= 2 {
                Some(ScenePatch::ReorderChildren {
                    parent_id,
                    new_order,
                })
            } else {
                None
            }
        })
        .collect();

    (moves, reorders)
}

/// Returns property updates in new-tree preorder (deterministic).
fn compute_updates(
    old_nodes: &HashMap<ID, &SceneNode>,
    new_nodes: &HashMap<ID, &SceneNode>,
    new_index: &SceneIndex,
) -> Vec<ScenePatch> {
    let mut updates = Vec::new();

    // Process in new-tree preorder for determinism
    let new_ids = new_index.ids_shallowest_first();

    for id in new_ids {
        // Skip if this is an insertion (not in old tree)
        let Some(old_node) = old_nodes.get(&id) else {
            continue;
        };
        let new_node = new_nodes.get(&id).unwrap();

        // Check for property changes (kind excluded - handled by KIND STABILITY)
        let changes = diff_props(old_node, new_node);
        if !changes.is_empty() {
            updates.push(ScenePatch::UpdateProps {
                node_id: id.clone(),
                changes,
            });
        }
    }

    updates
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Build a map from ID to node reference for O(1) access.
///
/// Uses iterative traversal (no recursion).
fn build_node_map(root: &SceneNode) -> HashMap<ID, &SceneNode> {
    let mut map = HashMap::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        map.insert(node.id.clone(), node);
        for child in &node.children {
            stack.push(child);
        }
    }

    map
}

/// Diff properties EXCLUDING kind (kind change is an error, not a patch).
///
/// Returns PropChanges with only the changed fields set.
fn diff_props(old: &SceneNode, new: &SceneNode) -> PropChanges {
    // NOTE: `kind` is NOT here. KIND STABILITY invariant means same ID = same kind.
    // Kind changes are validated earlier and return SceneDiffError::KindChangedForId.
    PropChanges {
        visible: if old.visible != new.visible {
            // Visibility is Resolved after compute phase - extract boolean
            Some(new.visible.as_bool())
        } else {
            None
        },
        z_index: if old.z_index != new.z_index {
            Some(new.z_index)
        } else {
            None
        },
        props: if old.props != new.props {
            Some(new.props.clone())
        } else {
            None
        },
        style: if old.style != new.style {
            Some(new.style.clone())
        } else {
            None
        },
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::types::{NodeKind, NodeProps};
    use std::sync::Arc;

    /// Helper to create a simple node with given ID and children
    fn make_node(id: &str, children: Vec<SceneNode>) -> SceneNode {
        SceneNode::new(id, NodeKind::Container).with_children(children)
    }

    /// Helper to create a node with specific kind
    fn make_node_with_kind(id: &str, kind: NodeKind, children: Vec<SceneNode>) -> SceneNode {
        SceneNode::new(id, kind).with_children(children)
    }

    /// Helper to verify correctness theorem: apply(old, diff(old, new)) == new
    /// Note: This helper just verifies the patches are generated correctly.
    /// Full apply verification is in Agent 4's tests.
    fn assert_diff_compiles(old: &SceneNode, new: &SceneNode) {
        let result = diff_scene(old, new);
        assert!(
            result.is_ok(),
            "diff_scene should succeed: {:?}",
            result.err()
        );
    }

    // ========================================================================
    // Test 1: No changes → empty patches
    // ========================================================================
    #[test]
    fn test_no_changes_empty_patches() {
        let tree = make_node(
            "root",
            vec![make_node("child1", vec![]), make_node("child2", vec![])],
        );

        let patches = diff_scene(&tree, &tree).unwrap();
        assert!(patches.is_empty(), "Same tree must produce empty patches");
    }

    // ========================================================================
    // Test 2: Same tree twice → deterministic (patches1 == patches2)
    // ========================================================================
    #[test]
    fn test_determinism() {
        let old = make_node(
            "root",
            vec![
                make_node("z", vec![make_node("z_child", vec![])]),
                make_node("a", vec![make_node("a_child", vec![])]),
                make_node("m", vec![]),
            ],
        );

        let new = make_node(
            "root",
            vec![
                make_node("z", vec![make_node("z_child", vec![])]),
                make_node("a", vec![]), // a_child removed
                make_node("m", vec![make_node("m_child", vec![])]), // m_child added
            ],
        );

        let patches1 = diff_scene(&old, &new).unwrap();
        let patches2 = diff_scene(&old, &new).unwrap();

        assert_eq!(
            patches1, patches2,
            "Same inputs must produce identical patches"
        );
    }

    // ========================================================================
    // Test 3: Root replacement (different root ID) → single SetRoot
    // ========================================================================
    #[test]
    fn test_root_replacement() {
        let old = make_node("root_a", vec![make_node("child", vec![])]);
        let new = make_node("root_b", vec![make_node("other_child", vec![])]);

        let patches = diff_scene(&old, &new).unwrap();

        assert_eq!(patches.len(), 1);
        assert!(matches!(&patches[0], ScenePatch::SetRoot { node } if node.id == "root_b"));

        assert_diff_compiles(&old, &new);
    }

    // ========================================================================
    // Test 4: Single child insert → InsertNode
    // ========================================================================
    #[test]
    fn test_single_child_insert() {
        let old = make_node("root", vec![]);
        let new = make_node("root", vec![make_node("child", vec![])]);

        let patches = diff_scene(&old, &new).unwrap();

        assert_eq!(patches.len(), 1);
        assert!(matches!(
            &patches[0],
            ScenePatch::InsertNode { parent_id, index, node }
            if parent_id == "root" && *index == 0 && node.id == "child"
        ));

        assert_diff_compiles(&old, &new);
    }

    // ========================================================================
    // Test 5: Single child remove → RemoveSubtree
    // ========================================================================
    #[test]
    fn test_single_child_remove() {
        let old = make_node("root", vec![make_node("child", vec![])]);
        let new = make_node("root", vec![]);

        let patches = diff_scene(&old, &new).unwrap();

        assert_eq!(patches.len(), 1);
        assert!(matches!(
            &patches[0],
            ScenePatch::RemoveSubtree { node_id } if node_id == "child"
        ));

        assert_diff_compiles(&old, &new);
    }

    // ========================================================================
    // Test 6: Subtree removal → only one RemoveSubtree (no redundant patches)
    // ========================================================================
    #[test]
    fn test_subtree_removal_no_redundant_patches() {
        let old = make_node(
            "root",
            vec![make_node(
                "parent",
                vec![
                    make_node("child1", vec![]),
                    make_node("child2", vec![make_node("grandchild", vec![])]),
                ],
            )],
        );
        let new = make_node("root", vec![]);

        let patches = diff_scene(&old, &new).unwrap();

        // Only ONE RemoveSubtree for "parent", NOT three or four patches
        assert_eq!(
            patches.len(),
            1,
            "Should be exactly 1 patch, got {:?}",
            patches
        );
        assert!(matches!(
            &patches[0],
            ScenePatch::RemoveSubtree { node_id } if node_id == "parent"
        ));

        assert_diff_compiles(&old, &new);
    }

    // ========================================================================
    // Test 7: Child reorder → single ReorderChildren (not multiple MoveNodes)
    // ========================================================================
    #[test]
    fn test_child_reorder() {
        let old = make_node(
            "root",
            vec![
                make_node("a", vec![]),
                make_node("b", vec![]),
                make_node("c", vec![]),
            ],
        );
        let new = make_node(
            "root",
            vec![
                make_node("c", vec![]),
                make_node("a", vec![]),
                make_node("b", vec![]),
            ],
        );

        let patches = diff_scene(&old, &new).unwrap();

        // Should emit ONE ReorderChildren, not three MoveNodes
        assert_eq!(
            patches.len(),
            1,
            "Should be exactly 1 patch, got {:?}",
            patches
        );
        assert!(matches!(
            &patches[0],
            ScenePatch::ReorderChildren { parent_id, new_order }
            if parent_id == "root" && new_order == &vec!["c".to_string(), "a".to_string(), "b".to_string()]
        ));

        assert_diff_compiles(&old, &new);
    }

    // ========================================================================
    // Test 8: Reparenting → MoveNode
    // ========================================================================
    #[test]
    fn test_reparenting() {
        let old = make_node(
            "root",
            vec![
                make_node("a", vec![make_node("child", vec![])]),
                make_node("b", vec![]),
            ],
        );
        let new = make_node(
            "root",
            vec![
                make_node("a", vec![]),
                make_node(
                    "b",
                    vec![
                        make_node("child", vec![]), // Moved from a to b
                    ],
                ),
            ],
        );

        let patches = diff_scene(&old, &new).unwrap();

        // Should have a MoveNode patch
        let has_move = patches.iter().any(|p| {
            matches!(
                p,
                ScenePatch::MoveNode { node_id, new_parent_id, .. }
                if node_id == "child" && new_parent_id == "b"
            )
        });
        assert!(
            has_move,
            "Should have MoveNode for 'child' to 'b', got {:?}",
            patches
        );

        assert_diff_compiles(&old, &new);
    }

    // ========================================================================
    // Test 9: Property update → UpdateProps
    // ========================================================================
    #[test]
    fn test_property_update() {
        use crate::kernel::types::Visibility;
        let mut old = make_node("root", vec![]);
        old.visible = Visibility::Resolved(true);

        let mut new = make_node("root", vec![]);
        new.visible = Visibility::Resolved(false);

        let patches = diff_scene(&old, &new).unwrap();

        assert_eq!(patches.len(), 1);
        assert!(matches!(
            &patches[0],
            ScenePatch::UpdateProps { node_id, changes }
            if node_id == "root" && changes.visible == Some(false)
        ));

        assert_diff_compiles(&old, &new);
    }

    // ========================================================================
    // Test 10: KIND STABILITY violation → KindChangedForId error
    // ========================================================================
    #[test]
    fn test_kind_stability_violation() {
        let old = make_node(
            "root",
            vec![make_node_with_kind("child", NodeKind::Container, vec![])],
        );
        let new = make_node(
            "root",
            vec![
                make_node_with_kind("child", NodeKind::Text, vec![]), // Different kind, same ID!
            ],
        );

        let result = diff_scene(&old, &new);
        assert!(result.is_err());

        match result.unwrap_err() {
            SceneDiffError::KindChangedForId {
                id,
                old_kind,
                new_kind,
            } => {
                assert_eq!(id, "child");
                assert_eq!(old_kind, NodeKind::Container);
                assert_eq!(new_kind, NodeKind::Text);
            }
            other => panic!("Expected KindChangedForId error, got: {:?}", other),
        }
    }

    // ========================================================================
    // Test 11: Duplicate ID in old tree → DuplicateId error
    // ========================================================================
    #[test]
    fn test_duplicate_id_in_old_tree() {
        let old = make_node(
            "root",
            vec![
                make_node("dupe", vec![]),
                make_node("dupe", vec![]), // Duplicate!
            ],
        );
        let new = make_node("root", vec![]);

        let result = diff_scene(&old, &new);
        assert!(result.is_err());

        match result.unwrap_err() {
            SceneDiffError::DuplicateId { id, context } => {
                assert_eq!(id, "dupe");
                assert!(context.contains("old"));
            }
            other => panic!("Expected DuplicateId error, got: {:?}", other),
        }
    }

    // ========================================================================
    // Test 12: Duplicate ID in new tree → DuplicateId error
    // ========================================================================
    #[test]
    fn test_duplicate_id_in_new_tree() {
        let old = make_node("root", vec![]);
        let new = make_node(
            "root",
            vec![
                make_node("dupe", vec![]),
                make_node("dupe", vec![]), // Duplicate!
            ],
        );

        let result = diff_scene(&old, &new);
        assert!(result.is_err());

        match result.unwrap_err() {
            SceneDiffError::DuplicateId { id, context } => {
                assert_eq!(id, "dupe");
                assert!(context.contains("new"));
            }
            other => panic!("Expected DuplicateId error, got: {:?}", other),
        }
    }

    // ========================================================================
    // Test 13: Invalid ID (with @) → InvalidId error
    // ========================================================================
    #[test]
    fn test_invalid_id_at_symbol() {
        let old = make_node("root@invalid", vec![]);
        let new = make_node("root", vec![]);

        let result = diff_scene(&old, &new);
        assert!(result.is_err());

        match result.unwrap_err() {
            SceneDiffError::InvalidId { id, reason } => {
                assert_eq!(id, "root@invalid");
                assert!(reason.contains("invalid character"));
            }
            other => panic!("Expected InvalidId error, got: {:?}", other),
        }
    }

    // ========================================================================
    // Test 14: Empty ID → InvalidId error
    // ========================================================================
    #[test]
    fn test_empty_id() {
        let old = make_node("", vec![]);
        let new = make_node("root", vec![]);

        let result = diff_scene(&old, &new);
        assert!(result.is_err());

        match result.unwrap_err() {
            SceneDiffError::InvalidId { id, reason } => {
                assert_eq!(id, "");
                assert!(reason.contains("empty"));
            }
            other => panic!("Expected InvalidId error, got: {:?}", other),
        }
    }

    // ========================================================================
    // Test 15: Deep tree (1000 levels) → no stack overflow
    // ========================================================================
    #[test]
    fn test_deep_tree_no_stack_overflow() {
        // Build a tree with 1000 levels
        let depth = 1000;
        let mut node = make_node(&format!("level_{}", depth), vec![]);

        for i in (0..depth).rev() {
            node = make_node(&format!("level_{}", i), vec![node]);
        }

        // Should not stack overflow
        let patches = diff_scene(&node, &node).unwrap();
        assert!(
            patches.is_empty(),
            "Same deep tree should produce empty patches"
        );

        // Also test with modifications
        use crate::kernel::types::Visibility;
        let mut modified = make_node(&format!("level_{}", depth), vec![]);
        for i in (0..depth).rev() {
            modified = make_node(&format!("level_{}", i), vec![modified]);
        }
        // Change visibility of deepest node
        fn set_deepest_invisible(node: &mut SceneNode) {
            if node.children.is_empty() {
                node.visible = Visibility::Resolved(false);
            } else {
                set_deepest_invisible(Arc::make_mut(&mut node.children[0]));
            }
        }
        set_deepest_invisible(&mut modified);

        let patches = diff_scene(&node, &modified).unwrap();
        assert!(
            !patches.is_empty(),
            "Modified deep tree should have patches"
        );
    }

    // ========================================================================
    // Test 16: Complex tree with mixed operations
    // ========================================================================
    #[test]
    fn test_complex_mixed_operations() {
        let old = make_node(
            "root",
            vec![
                make_node("keep", vec![make_node("keep_child", vec![])]),
                make_node(
                    "remove_me",
                    vec![make_node("orphan1", vec![]), make_node("orphan2", vec![])],
                ),
                make_node("reorder_a", vec![]),
                make_node("reorder_b", vec![]),
                make_node("move_target", vec![]),
            ],
        );

        use crate::kernel::types::Visibility;
        let mut new_keep = make_node("keep", vec![make_node("keep_child", vec![])]);
        new_keep.visible = Visibility::Resolved(false); // Update property

        let new = make_node(
            "root",
            vec![
                new_keep,
                make_node("reorder_b", vec![]), // Reordered
                make_node(
                    "reorder_a",
                    vec![
                        make_node("move_target", vec![]), // Moved into reorder_a
                    ],
                ),
                make_node("new_node", vec![]), // Inserted
            ],
        );

        let patches = diff_scene(&old, &new).unwrap();

        // Verify we have the expected types of patches
        let has_removal = patches
            .iter()
            .any(|p| matches!(p, ScenePatch::RemoveSubtree { node_id } if node_id == "remove_me"));
        let has_move = patches
            .iter()
            .any(|p| matches!(p, ScenePatch::MoveNode { node_id, .. } if node_id == "move_target"));
        let has_insert = patches
            .iter()
            .any(|p| matches!(p, ScenePatch::InsertNode { node, .. } if node.id == "new_node"));
        let has_update = patches
            .iter()
            .any(|p| matches!(p, ScenePatch::UpdateProps { node_id, .. } if node_id == "keep"));

        assert!(has_removal, "Should have removal for 'remove_me'");
        assert!(has_move, "Should have move for 'move_target'");
        // Note: reorder might not appear if the only reordering is due to move
        assert!(has_insert, "Should have insert for 'new_node'");
        assert!(has_update, "Should have update for 'keep' visibility");

        assert_diff_compiles(&old, &new);
    }

    // ========================================================================
    // Test 17: z_index change → UpdateProps
    // ========================================================================
    #[test]
    fn test_z_index_update() {
        let mut old = make_node("root", vec![]);
        old.z_index = Some(5);

        let mut new = make_node("root", vec![]);
        new.z_index = Some(10);

        let patches = diff_scene(&old, &new).unwrap();

        assert_eq!(patches.len(), 1);
        assert!(matches!(
            &patches[0],
            ScenePatch::UpdateProps { node_id, changes }
            if node_id == "root" && changes.z_index == Some(Some(10))
        ));
    }

    // ========================================================================
    // Test 18: Props change → UpdateProps
    // ========================================================================
    #[test]
    fn test_props_update() {
        let mut old = make_node("root", vec![]);
        old.props = NodeProps {
            text: Some("old text".to_string()),
            ..Default::default()
        };

        let mut new = make_node("root", vec![]);
        new.props = NodeProps {
            text: Some("new text".to_string()),
            ..Default::default()
        };

        let patches = diff_scene(&old, &new).unwrap();

        assert_eq!(patches.len(), 1);
        assert!(matches!(
            &patches[0],
            ScenePatch::UpdateProps { node_id, changes }
            if node_id == "root" && changes.props.is_some()
        ));
    }

    // ========================================================================
    // Test 19: Insert multiple children at once
    // ========================================================================
    #[test]
    fn test_insert_multiple_children() {
        let old = make_node("root", vec![]);
        let new = make_node(
            "root",
            vec![
                make_node("child1", vec![]),
                make_node("child2", vec![]),
                make_node("child3", vec![]),
            ],
        );

        let patches = diff_scene(&old, &new).unwrap();

        // Should have 3 InsertNode patches
        let insert_count = patches
            .iter()
            .filter(|p| matches!(p, ScenePatch::InsertNode { .. }))
            .count();
        assert_eq!(insert_count, 3);

        // Verify order: shallowest-first, which for same depth means insertion order
        assert!(matches!(
            &patches[0],
            ScenePatch::InsertNode { node, index, .. }
            if node.id == "child1" && *index == 0
        ));

        assert_diff_compiles(&old, &new);
    }

    #[test]
    fn test_insert_multiple_children_preserves_sibling_index_order_not_id_order() {
        let old = make_node("root", vec![]);
        let new = make_node(
            "root",
            vec![
                make_node("z_first", vec![]),
                make_node("a_second", vec![]),
                make_node("m_third", vec![]),
            ],
        );

        let patches = diff_scene(&old, &new).unwrap();
        let inserts: Vec<_> = patches
            .iter()
            .filter_map(|patch| match patch {
                ScenePatch::InsertNode { index, node, .. } => Some((*index, node.id.as_str())),
                _ => None,
            })
            .collect();

        assert_eq!(
            inserts,
            vec![(0, "z_first"), (1, "a_second"), (2, "m_third")],
            "insertions must be emitted in target sibling order, not ID order"
        );
    }

    // ========================================================================
    // Test 20: diff_scene_with_diagnostics returns correct metrics
    // ========================================================================
    #[test]
    fn test_diff_with_diagnostics() {
        let old = make_node("root", vec![make_node("remove", vec![])]);

        use crate::kernel::types::Visibility;
        let mut new_root = make_node("root", vec![make_node("insert", vec![])]);
        new_root.visible = Visibility::Resolved(false);

        let (patches, diagnostics) = diff_scene_with_diagnostics(&old, &new_root).unwrap();

        assert_eq!(patches.len(), 3); // 1 removal, 1 insert, 1 update
        assert_eq!(diagnostics.nodes_removed, 1);
        assert_eq!(diagnostics.nodes_inserted, 1);
        assert_eq!(diagnostics.nodes_updated, 1);
        assert_eq!(diagnostics.patch_count, 3);
        assert!(!diagnostics.root_replaced);
    }

    // ========================================================================
    // Test 21: Canonical patch order
    // ========================================================================
    #[test]
    fn test_canonical_patch_order() {
        // Create a scenario that generates all patch types
        let old = make_node(
            "root",
            vec![
                make_node("to_remove", vec![]),
                make_node("to_move", vec![]),
                make_node("reorder_a", vec![]),
                make_node("reorder_b", vec![]),
                make_node("target", vec![]),
            ],
        );

        use crate::kernel::types::Visibility;
        let mut to_update = make_node(
            "target",
            vec![
                make_node("to_move", vec![]), // Moved into target
            ],
        );
        to_update.visible = Visibility::Resolved(false);

        let new = make_node(
            "root",
            vec![
                make_node("reorder_b", vec![]), // Reordered
                make_node("reorder_a", vec![]),
                to_update,
                make_node("new_node", vec![]), // Inserted
            ],
        );

        let patches = diff_scene(&old, &new).unwrap();

        // Verify producer order: removals, insertions, moves, reorders, updates
        let mut found_removal = false;
        let mut found_move = false;
        let mut found_reorder = false;
        let mut found_insert = false;
        let mut found_update = false;

        for patch in &patches {
            match patch {
                ScenePatch::RemoveSubtree { .. } => {
                    assert!(
                        !found_move && !found_reorder && !found_insert && !found_update,
                        "Removal should come before move, reorder, insert, update"
                    );
                    found_removal = true;
                }
                ScenePatch::MoveNode { .. } => {
                    assert!(
                        !found_reorder && !found_update,
                        "Move should come before reorder and update"
                    );
                    found_move = true;
                }
                ScenePatch::ReorderChildren { .. } => {
                    assert!(
                        !found_update,
                        "Reorder should come before update"
                    );
                    found_reorder = true;
                }
                ScenePatch::InsertNode { .. } => {
                    assert!(!found_move && !found_reorder && !found_update, "Insert should create destinations before moves");
                    found_insert = true;
                }
                ScenePatch::UpdateProps { .. } => {
                    found_update = true;
                }
                ScenePatch::SetRoot { .. } => {
                    panic!("Should not have SetRoot in this test");
                }
            }
        }

        assert!(
            found_removal && found_move && found_insert && found_update,
            "Should have all patch types"
        );
    }
}
