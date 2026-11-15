// crates/composition-engine/tests/irpa_no_json_hot_path.rs
//
// # Purpose
//
// Hot-path prohibition tests for Task 168 IRPA (Incremental Runtime
// Publication Architecture). These tests verify that the render pipeline
// no longer uses `serde_json::to_value()` for index building, and that
// `TypedSceneIndex` (typed Rust structures) is used instead of
// `HashMap<String, serde_json::Value>` (JSON blobs).
//
// # Key Concepts
//
// Before Task 168 P4:
// - `build_scene_index()` called `serde_json::to_value(node)` for EACH node,
//   serializing it WITH ALL DESCENDANTS — O(n^2) total.
// - `build_previous_node_index()` took `&serde_json::Value` and cloned JSON subtrees.
// - `render()` called `serde_json::to_value(&render_tree)` for the previous index.
//
// After Task 168 P4:
// - `build_scene_index()` returns `TypedSceneIndex` — flat per-node entries, O(n).
// - `build_previous_node_index()` takes `&SceneNode` directly — no JSON.
// - `render()` calls `build_previous_node_index(&render_tree)` directly — no serde.
// - `TypedNodeEntry` stores `child_ids: Vec<String>` instead of nested children.
//
// # Non-Negotiable Invariants
//
// 1. `serde_json::to_value` MUST NOT be called in render() for index building.
// 2. `TypedSceneIndex` (typed HashMap) MUST be used, not JSON HashMap.
// 3. `TypedNodeEntry` MUST have `child_ids` (flat), not nested children.
// 4. Scene index entry count MUST equal total node count (flat, no subtree duplication).
//
// # Test Strategy
//
// These tests verify the STRUCTURAL properties of the index types,
// not the absence of specific function calls (which would require
// instrumentation). The key insight: if `TypedSceneIndex` is used
// (with flat `child_ids`), then JSON serialization for index building
// is structurally impossible — the types enforce the invariant.
//
// # Security Considerations
//
// Pure in-memory tests. No I/O, no network, no secrets.
//
// # AI Directive
//
// The extensive documentation in this codebase is a critical design feature.
// You are FORBIDDEN from simplifying or removing it. Your mandate is to
// MAINTAIN and EXTEND this level of meticulous detail.

mod common;
use common::{make_flat_tree, VIEWPORT};

use composition_engine::kernel::{
    compute::{build_previous_node_index, build_scene_index},
    typed_index::{TypedNodeEntry, TypedPreviousIndex, TypedSceneIndex},
    Kernel, NodeKind, NodeProps, SceneNode,
};
use std::sync::Arc;

// ============================================================================
// File-Specific Test Helpers
// ============================================================================

/// Build a nested tree (3 levels) — file-specific structure for hot-path tests.
///
/// Structure:
/// ```text
/// root (Container)
/// ├── panel (Container)
/// │   ├── leaf-0 (Text "Leaf 0")
/// │   └── leaf-1 (Text "Leaf 1")
/// └── sibling (Text)
/// ```
///
/// NOTE: This is INTENTIONALLY different from `common::make_nested_tree()`
/// which uses panel-a/panel-b/leaf-a0/leaf-a1/leaf-b0/leaf-b1/leaf-c IDs.
/// This simpler structure matches the specific assertions in hot-path tests
/// (e.g., `child_ids == ["panel", "sibling"]`).
fn make_nested_tree() -> SceneNode {
    SceneNode {
        id: "root".to_string(),
        kind: NodeKind::Container,
        children: vec![
            Arc::new(SceneNode {
                id: "panel".to_string(),
                kind: NodeKind::Container,
                children: vec![
                    Arc::new(SceneNode {
                        id: "leaf-0".to_string(),
                        kind: NodeKind::Text,
                        props: NodeProps {
                            text: Some("Leaf 0".to_string()),
                            ..Default::default()
                        },
                        ..Default::default()
                    }),
                    Arc::new(SceneNode {
                        id: "leaf-1".to_string(),
                        kind: NodeKind::Text,
                        props: NodeProps {
                            text: Some("Leaf 1".to_string()),
                            ..Default::default()
                        },
                        ..Default::default()
                    }),
                ],
                ..Default::default()
            }),
            Arc::new(SceneNode {
                id: "sibling".to_string(),
                kind: NodeKind::Text,
                ..Default::default()
            }),
        ],
        ..Default::default()
    }
}

/// Count all nodes in a tree recursively.
fn count_nodes(node: &SceneNode) -> usize {
    1 + node.children.iter().map(|c| count_nodes(c)).sum::<usize>()
}

// ============================================================================
// Hot-Path Prohibition: TypedSceneIndex Is Used (Not JSON)
// ============================================================================

/// TypedSceneIndex is a HashMap<String, TypedNodeEntry> — NOT JSON.
///
/// This test verifies the structural type guarantee: if the code compiles
/// with `TypedSceneIndex`, then `serde_json::to_value` is NOT used for
/// index building (because `TypedNodeEntry` is a Rust struct, not JSON).
#[test]
fn build_scene_index_returns_typed_scene_index() {
    let tree = make_flat_tree(10);
    let index: TypedSceneIndex = build_scene_index(&tree);

    // Verify it's a HashMap<String, TypedNodeEntry> (typed, not JSON)
    assert_eq!(index.len(), 11, "10 children + 1 root = 11 entries");

    // Access a typed field — this would be impossible with JSON values
    let root_entry: &TypedNodeEntry = index.get("root").expect("root must exist");
    assert_eq!(root_entry.kind, NodeKind::Container);
    assert_eq!(root_entry.child_ids.len(), 10);
}

/// build_previous_node_index takes &SceneNode (not &serde_json::Value).
///
/// Before P4, this function took `&serde_json::Value` — requiring a prior
/// `serde_json::to_value(&render_tree)` call. Now it takes &SceneNode directly,
/// eliminating the JSON serialization step entirely.
#[test]
fn build_previous_node_index_accepts_scene_node_not_json() {
    let tree = make_flat_tree(10);
    // This compiles because the function signature accepts &SceneNode.
    // Pre-P4, this would require `serde_json::to_value(&tree)` first.
    let index: TypedPreviousIndex = build_previous_node_index(&tree);

    assert_eq!(index.len(), 11);
    let node_5: &TypedNodeEntry = index.get("node-5").expect("node-5 must exist");
    assert_eq!(node_5.id, "node-5");
}

/// TypedNodeEntry has child_ids (flat IDs), not nested children.
///
/// This is the structural guarantee that breaks the O(n^2) bug.
/// If entries had nested children, building the index would serialize
/// each node's entire subtree. With child_ids, each entry is O(1).
#[test]
fn typed_node_entry_has_flat_child_ids_not_nested_children() {
    let tree = make_nested_tree();
    let index = build_scene_index(&tree);

    let root_entry = index.get("root").expect("root must exist");
    // child_ids are String references to direct children — not nested structures
    assert_eq!(root_entry.child_ids, vec!["panel", "sibling"]);

    let panel_entry = index.get("panel").expect("panel must exist");
    assert_eq!(panel_entry.child_ids, vec!["leaf-0", "leaf-1"]);

    // Leaf nodes have empty child_ids
    let leaf_entry = index.get("leaf-0").expect("leaf-0 must exist");
    assert!(leaf_entry.child_ids.is_empty());
}

/// Scene index entry count equals total node count (O(n), not O(n^2)).
///
/// The old O(n^2) index serialized each node WITH all descendants:
/// root entry = entire tree, first child = entire subtree, etc.
/// The new flat index has exactly one entry per node — no subtree duplication.
#[test]
fn scene_index_has_exactly_one_entry_per_node() {
    let tree = make_nested_tree();
    let total_nodes = count_nodes(&tree);
    let index = build_scene_index(&tree);

    assert_eq!(
        index.len(),
        total_nodes,
        "Index must have exactly {} entries (one per node), got {}",
        total_nodes,
        index.len()
    );
}

/// 100-node tree: build_scene_index has exactly 100 entries (not more).
///
/// This guards against the O(n^2) regression where the old JSON index
/// would effectively have O(n) entries but each entry contained O(subtree_size)
/// data. The flat index has exactly n entries with O(1) data each.
#[test]
fn scene_index_100_nodes_exactly_100_entries() {
    let tree = make_flat_tree(99); // root + 99 children = 100 nodes
    let index = build_scene_index(&tree);
    assert_eq!(
        index.len(),
        100,
        "100-node tree must have exactly 100 index entries"
    );
}

/// KernelState uses TypedSceneIndex for cached indexes (not JSON).
///
/// After P4, `KernelState.cached_scene_index` is `Option<Arc<TypedSceneIndex>>`,
/// not `Option<Arc<HashMap<String, serde_json::Value>>>`. This test verifies
/// the kernel actually uses typed indexes in the render pipeline by checking
/// that a rendered kernel's state contains typed entries.
#[test]
fn kernel_state_uses_typed_scene_index() {
    let tree = make_flat_tree(10);
    let mut kernel = Kernel::new(tree, VIEWPORT);
    kernel.render(0.0);

    // Access the kernel state and verify cached indexes are typed
    let state = kernel.get_state();

    // cached_scene_index should be populated after first render
    let scene_index = state
        .cached_scene_index
        .as_ref()
        .expect("cached_scene_index must be populated after render");

    // It's a TypedSceneIndex — we can access TypedNodeEntry fields
    let root_entry = scene_index
        .get("root")
        .expect("root must be in cached scene index");
    assert_eq!(root_entry.kind, NodeKind::Container);
    assert_eq!(root_entry.child_ids.len(), 10);
}

/// Previous index uses TypedPreviousIndex (not JSON).
///
/// Same verification for the previous index cache.
#[test]
fn kernel_state_uses_typed_previous_index() {
    let tree = make_flat_tree(10);
    let mut kernel = Kernel::new(tree, VIEWPORT);
    kernel.render(0.0);

    let state = kernel.get_state();
    let prev_index = state
        .cached_previous_index
        .as_ref()
        .expect("cached_previous_index must be populated after render");

    // Typed access — impossible with JSON indexes
    let node_entry = prev_index
        .get("node-3")
        .expect("node-3 must be in previous index");
    assert_eq!(node_entry.id, "node-3");
    assert_eq!(node_entry.kind, NodeKind::Text);
}

/// After render with property change, indexes remain typed.
///
/// Verifies that the incremental render path (dirty nodes only)
/// still produces typed indexes, not falling back to JSON.
#[test]
fn incremental_render_maintains_typed_indexes() {
    let tree = make_flat_tree(10);
    let mut kernel = Kernel::new(tree.clone(), VIEWPORT);
    kernel.render(0.0);

    // Property change
    let updated = SceneNode {
        id: "node-5".to_string(),
        kind: NodeKind::Text,
        props: NodeProps {
            text: Some("Updated".to_string()),
            ..Default::default()
        },
        children: vec![],
        ..Default::default()
    };
    kernel
        .update_scene_node(updated)
        .expect("update must succeed");
    kernel.render(0.0);

    let state = kernel.get_state();

    // Scene index should still be typed
    let scene_index = state
        .cached_scene_index
        .as_ref()
        .expect("scene index must exist after incremental render");
    let entry = scene_index.get("node-5").expect("node-5 must exist");
    // After compute, text might be resolved — verify it's a TypedNodeEntry
    assert_eq!(entry.kind, NodeKind::Text);

    // Previous index should be typed and reflect the update
    let prev_index = state
        .cached_previous_index
        .as_ref()
        .expect("previous index must exist after incremental render");
    let prev_entry = prev_index.get("node-5").expect("node-5 must exist in prev");
    assert_eq!(prev_entry.kind, NodeKind::Text);
}

/// No serde_json::Value in TypedNodeEntry's core fields.
///
/// The only `serde_json::Value` allowed in TypedNodeEntry is the `value` field
/// (for Custom node input values) and indirectly in `NodeProps`. The structural
/// fields (`child_ids`, `id`, `kind`, `visible`, etc.) are all typed.
/// This is a compile-time guarantee backed by a runtime assertion.
#[test]
fn typed_node_entry_core_fields_are_not_json() {
    let node = SceneNode {
        id: "test".to_string(),
        kind: NodeKind::Container,
        children: vec![Arc::new(SceneNode {
            id: "child-1".to_string(),
            kind: NodeKind::Text,
            ..Default::default()
        })],
        ..Default::default()
    };

    let entry = TypedNodeEntry::from_node(&node, None);

    // These are typed — NOT serde_json::Value:
    assert_eq!(entry.id, "test"); // String, not Value::String
    assert_eq!(entry.kind, NodeKind::Container); // enum, not Value
    assert_eq!(entry.child_ids, vec!["child-1"]); // Vec<String>, not Value::Array
    assert!(!entry.synthetic); // bool, not Value::Bool
    assert_eq!(entry.z_index, None); // Option<i32>, not Value
    assert_eq!(entry.portal_owner, None); // Option<String>, not Value
}
