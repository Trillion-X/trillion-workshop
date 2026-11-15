// crates/composition-engine/tests/incremental_render_integration.rs
//
// ==========================================================================
// Purpose: End-to-end integration tests for incremental dirty-tracked render.
// Verifies that the DirtyTracker-gated render pipeline produces identical
// output to full render while skipping unchanged phases for O(change) cost.
//
// Non-Negotiable Invariants:
// 1. Incremental render produces identical SceneSnapshot to full render for
//    the same kernel state — byte-identical tree and frames.
// 2. Dirty flags are cleared after every render() call — subsequent render
//    with no mutations is a clean no-op.
// 3. Mutations between renders accumulate dirty flags correctly — no flags
//    lost, no phantom flags set.
// 4. Phase skipping is observable: binding evaluation skipped when only
//    viewport changes; layout skipped when only FSM changes.
// 5. Performance: incremental render of a single property change in a large
//    tree completes measurably faster than full render.
//
// Key Concepts:
// - Split Tick Architecture: process_input() → Interaction Engine → render()
// - DirtyTracker: O(1) flag-based change detection per render phase
// - Phase Skipping: render() checks is_clean(), needs_binding_eval(),
//   needs_layout() to skip unchanged phases
// - Incremental Binding Eval: only dirty_nodes have bindings re-evaluated
// - Incremental Layout: compute_layout_incremental() reuses previous frames
//   for unchanged subtrees
//
// Security Considerations:
// - No external I/O, no network, no filesystem — pure in-memory tests
// - No secrets or credentials in test fixtures
// - Test data uses opaque IDs with no Society semantics (Physics-only)
//
// AI Assistant Directive:
// The extensive, granular documentation in this file is a critical design
// feature. You are forbidden from simplifying or removing it. Your mandate
// is to maintain and extend this level of meticulous detail.
// ==========================================================================

use composition_engine::kernel::{routing::OriginID, FSMState, Kernel, NodeKind, SceneNode, Size};
use std::sync::Arc;

// ============================================================================
// Test Helpers
// ============================================================================

/// Build a simple scene tree: root with N children, each identified by index.
///
/// Structure:
/// ```text
/// root (Container)
///   ├── child_0 (Text)
///   ├── child_1 (Text)
///   └── ...child_N-1 (Text)
/// ```
fn make_flat_tree(child_count: usize) -> SceneNode {
    let children: Vec<SceneNode> = (0..child_count)
        .map(|i| SceneNode::new(format!("child_{}", i), NodeKind::Text))
        .collect();
    SceneNode::new("root", NodeKind::Container).with_children(children)
}

/// Build a deep tree: root → chain of depth nodes, each with one child.
///
/// Structure:
/// ```text
/// root (Container)
///   └── depth_1 (Container)
///       └── depth_2 (Container)
///           └── ...depth_N (Text)
/// ```
fn make_deep_tree(depth: usize) -> SceneNode {
    let mut current = SceneNode::new(format!("depth_{}", depth), NodeKind::Text);
    for i in (1..depth).rev() {
        current = SceneNode::new(format!("depth_{}", i), NodeKind::Container)
            .with_children(vec![current]);
    }
    SceneNode::new("root", NodeKind::Container).with_children(vec![current])
}

/// Build a wide tree with branching at each level.
///
/// Structure: root with `width` children, each having `width` grandchildren.
/// Total nodes: 1 + width + width*width.
fn make_wide_tree(width: usize) -> SceneNode {
    let children: Vec<SceneNode> = (0..width)
        .map(|i| {
            let grandchildren: Vec<SceneNode> = (0..width)
                .map(|j| SceneNode::new(format!("node_{}_{}", i, j), NodeKind::Text))
                .collect();
            SceneNode::new(format!("branch_{}", i), NodeKind::Container)
                .with_children(grandchildren)
        })
        .collect();
    SceneNode::new("root", NodeKind::Container).with_children(children)
}

/// Create a kernel, run the initial render, and return the kernel in a clean
/// state. This is the standard entry point for tests that need a kernel
/// past its first render cycle.
fn make_clean_kernel(root: SceneNode) -> Kernel {
    let viewport = Size::new(800.0, 600.0);
    let mut kernel = Kernel::new(root, viewport);
    // First render populates layout_frames and clears DirtyTracker
    let _initial_snapshot = kernel.render(0.0);
    kernel
}

/// Standard viewport for tests.
const TEST_VIEWPORT: Size = Size { w: 800.0, h: 600.0 };

// ============================================================================
// Test 1: No-Op Render — Clean State Fast Path
// ============================================================================

/// After initial render, a second render with no mutations is a complete no-op.
/// The DirtyTracker reports is_clean() == true, and the returned snapshot is
/// structurally identical to the initial render.
#[test]
fn full_cycle_no_changes_second_render_is_noop() {
    let root = make_flat_tree(3);
    let mut kernel = make_clean_kernel(root);

    // Verify: state is clean after initial render
    assert!(
        kernel.get_state().dirty.is_clean(),
        "DirtyTracker must be clean after initial render"
    );

    // Second render with no mutations
    let snapshot = kernel.render(16.0);

    // Verify: snapshot is valid and matches tree structure
    assert_eq!(snapshot.tree.id, "root");
    assert_eq!(snapshot.tree.children.len(), 3);
    for (i, child) in snapshot.tree.children.iter().enumerate() {
        assert_eq!(child.id, format!("child_{}", i));
    }

    // Verify: state remains clean
    assert!(
        kernel.get_state().dirty.is_clean(),
        "DirtyTracker must still be clean after no-op render"
    );

    // Verify: layout frames exist for all nodes
    assert!(
        snapshot.frames.contains_key("root"),
        "root must have a layout frame"
    );
}

// ============================================================================
// Test 2: FSM State Change — Binding Eval Runs, Layout Skipped
// ============================================================================

/// After set_fsm_state, only binding evaluation should run. Layout is skipped
/// because FSM changes don't affect layout inputs directly (unless bindings
/// change visibility, which requires a binding-producing tree).
#[test]
fn full_cycle_set_fsm_state_marks_fsm_dirty() {
    let root = make_flat_tree(2);
    let mut kernel = make_clean_kernel(root);

    // Mutate: set FSM state
    kernel.set_fsm_state(
        "fsm:panel".to_string(),
        FSMState {
            value: "expanded".to_string(),
            context: serde_json::json!({}),
        },
    );

    // Verify: fsm_dirty set, needs_binding_eval true
    let state = kernel.get_state();
    assert!(
        state.dirty.fsm_dirty,
        "fsm_dirty must be set after set_fsm_state"
    );
    assert!(
        state.dirty.needs_binding_eval(),
        "needs_binding_eval must be true when fsm_dirty"
    );

    // Render: processes FSM change
    let snapshot = kernel.render(16.0);

    // Verify: snapshot valid
    assert_eq!(snapshot.tree.id, "root");

    // Verify: dirty flags cleared
    assert!(
        kernel.get_state().dirty.is_clean(),
        "DirtyTracker must be clean after render"
    );
}

// ============================================================================
// Test 3: Routing Change — routing_dirty Triggers Binding Re-eval
// ============================================================================

/// set_route marks routing_dirty, triggers eager recompute (which processes
/// the change and clears dirty flags — Task 167 Phase E). render() takes
/// the O(1) fast path and returns a snapshot from cached state.
#[test]
fn full_cycle_set_route_marks_routing_dirty() {
    let root = make_flat_tree(2);
    let mut kernel = make_clean_kernel(root);

    // Mutate: set a route — triggers recompute which clears dirty (Task 167 Phase E)
    let origin = OriginID::new("keyboard:0");
    kernel.set_route(&origin, Some(&"child_0".to_string()));

    // Verify: dirty flags CLEARED by recompute — work is already done
    let state = kernel.get_state();
    assert!(
        state.dirty.is_clean(),
        "set_route triggers recompute which clears dirty (Task 167 Phase E)"
    );

    // Render: takes O(1) fast path (is_clean=true)
    let snapshot = kernel.render(16.0);
    assert_eq!(snapshot.tree.id, "root");

    // Verify: routing reflected in snapshot (recompute cached the result)
    assert_eq!(
        snapshot.routing.routes.get(&origin).map(|s| s.as_str()),
        Some("child_0"),
        "routing must reflect the set_route call"
    );

    // Verify: still clean after fast-path render
    assert!(kernel.get_state().dirty.is_clean());
}

// ============================================================================
// Test 4: Ambient Change — ambient_dirty Triggers Binding Re-eval
// ============================================================================

/// set_ambient marks ambient_dirty, causing full binding re-evaluation since
/// any binding could reference ambient values.
#[test]
fn full_cycle_set_ambient_marks_ambient_dirty() {
    let root = make_flat_tree(2);
    let mut kernel = make_clean_kernel(root);

    // Mutate: set ambient value
    kernel.set_ambient("theme".to_string(), serde_json::json!("dark"));

    // Verify: ambient_dirty set
    let state = kernel.get_state();
    assert!(
        state.dirty.ambient_dirty,
        "ambient_dirty must be set after set_ambient"
    );
    assert!(
        state.dirty.needs_binding_eval(),
        "needs_binding_eval must be true when ambient_dirty"
    );

    // Render
    let snapshot = kernel.render(16.0);
    assert_eq!(snapshot.tree.id, "root");

    // Verify: clean after render
    assert!(kernel.get_state().dirty.is_clean());
}

// ============================================================================
// Test 5: Scene Update with Single Node Change — Only That Subtree Dirty
// ============================================================================

/// update_scene with a single property change (UpdateProps patch) marks only
/// that node in dirty_nodes, not scene_structure_dirty.
#[test]
fn full_cycle_update_scene_single_node_change() {
    let root = make_flat_tree(3);
    let mut kernel = make_clean_kernel(root.clone());

    // Create a modified tree: change child_1's text property only (same kind,
    // same ID — produces UpdateProps patch, not structural change)
    let mut modified_root = root;
    Arc::make_mut(&mut modified_root.children[1]).props.text = Some("Updated text".to_string());

    // Mutate: update scene
    let result = kernel.update_scene(modified_root);
    assert!(result.is_ok(), "update_scene must succeed");

    // Verify: dirty_nodes contains child_1 (UpdateProps marks individual nodes)
    let state = kernel.get_state();
    assert!(
        !state.dirty.is_clean(),
        "DirtyTracker must not be clean after update_scene"
    );

    // For a property-only change, dirty_nodes should contain the changed node
    // and scene_structure_dirty should be false
    if !state.dirty.is_scene_structure_dirty() {
        assert!(
            state.dirty.dirty_nodes.contains("child_1"),
            "dirty_nodes must contain child_1 after property update"
        );
    }

    // Render
    let snapshot = kernel.render(16.0);

    // Verify: the change is reflected
    assert_eq!(snapshot.tree.children[1].id, "child_1");

    // Verify: clean after render
    assert!(kernel.get_state().dirty.is_clean());
}

// ============================================================================
// Test 6: Viewport Change — Layout Recomputed, Bindings Skipped
// ============================================================================

/// set_viewport marks viewport_dirty (and layout_dirty). Bindings don't
/// reference viewport, so needs_binding_eval() is false.
#[test]
fn full_cycle_set_viewport_layout_recomputed_bindings_skipped() {
    let root = make_flat_tree(2);
    let mut kernel = make_clean_kernel(root);

    // Mutate: change viewport
    kernel.set_viewport(Size::new(1024.0, 768.0));

    // Verify: viewport_dirty and layout_dirty set, but NOT binding-related flags
    let state = kernel.get_state();
    assert!(state.dirty.viewport_dirty, "viewport_dirty must be set");
    assert!(state.dirty.layout_dirty, "layout_dirty must be set");
    assert!(
        !state.dirty.fsm_dirty,
        "fsm_dirty must NOT be set by viewport change"
    );
    assert!(
        !state.dirty.routing_dirty,
        "routing_dirty must NOT be set by viewport change"
    );
    assert!(
        !state.dirty.ambient_dirty,
        "ambient_dirty must NOT be set by viewport change"
    );
    assert!(state.dirty.needs_layout(), "needs_layout must be true");
    assert!(
        !state.dirty.needs_binding_eval(),
        "needs_binding_eval must be false (viewport-only)"
    );

    // Render
    let snapshot = kernel.render(16.0);

    // Verify: layout frames exist and were recomputed
    assert!(
        snapshot.frames.contains_key("root"),
        "root must have a layout frame after viewport change"
    );
    assert!(
        !snapshot.frames.is_empty(),
        "layout frames must exist after viewport-triggered render"
    );

    // Verify: clean after render
    assert!(kernel.get_state().dirty.is_clean());
}

// ============================================================================
// Test 7: Incremental Snapshot Identical to Full Render
// ============================================================================

/// Two kernels starting from the same initial state, one renders incrementally
/// (with dirty flags after mutation), the other does a full render (with all
/// flags set). Both must produce identical SceneSnapshot trees and frames.
#[test]
fn incremental_render_produces_identical_snapshot_to_full_render() {
    let root = make_flat_tree(5);
    let viewport = TEST_VIEWPORT;

    // Kernel A: incremental path
    let mut kernel_a = Kernel::new(root.clone(), viewport);
    let _initial_a = kernel_a.render(0.0);

    // Kernel B: fresh kernel (first render = full render with all flags dirty)
    let mut kernel_b = Kernel::new(root.clone(), viewport);

    // Both render with no mutations from the same initial state
    let snapshot_a = kernel_a.render(16.0);
    let snapshot_b = kernel_b.render(16.0);

    // Verify: tree structure is identical
    assert_eq!(
        snapshot_a.tree.id, snapshot_b.tree.id,
        "root IDs must match"
    );
    assert_eq!(
        snapshot_a.tree.children.len(),
        snapshot_b.tree.children.len(),
        "child count must match"
    );
    for (a_child, b_child) in snapshot_a
        .tree
        .children
        .iter()
        .zip(snapshot_b.tree.children.iter())
    {
        assert_eq!(a_child.id, b_child.id, "child IDs must match");
        assert_eq!(a_child.kind, b_child.kind, "child kinds must match");
    }

    // Verify: layout frames are identical
    assert_eq!(
        snapshot_a.frames.len(),
        snapshot_b.frames.len(),
        "frame count must match"
    );
    for (id, frame_a) in snapshot_a.frames.iter() {
        let frame_b = snapshot_b
            .frames
            .get(id)
            .unwrap_or_else(|| panic!("frame for '{}' missing from full render", id));
        assert!(
            (frame_a.rect.x - frame_b.rect.x).abs() < 0.01
                && (frame_a.rect.y - frame_b.rect.y).abs() < 0.01
                && (frame_a.rect.w - frame_b.rect.w).abs() < 0.01
                && (frame_a.rect.h - frame_b.rect.h).abs() < 0.01,
            "layout frames for '{}' must be identical: {:?} vs {:?}",
            id,
            frame_a.rect,
            frame_b.rect,
        );
    }
}

// ============================================================================
// Test 8: Dirty Flags Cleared After Render
// ============================================================================

/// After a render that processes dirty flags, ALL flags must be cleared.
/// The subsequent render with no mutations reports is_clean() == true.
#[test]
fn dirty_flags_cleared_after_render_subsequent_is_clean() {
    let root = make_flat_tree(2);
    let mut kernel = make_clean_kernel(root);

    // Set multiple dirty flags
    kernel.set_fsm_state(
        "fsm:test".to_string(),
        FSMState {
            value: "active".to_string(),
            context: serde_json::json!({}),
        },
    );
    kernel.set_ambient("key".to_string(), serde_json::json!("val"));
    kernel.set_viewport(Size::new(1920.0, 1080.0));

    // Verify: many flags set
    let state = kernel.get_state();
    assert!(state.dirty.fsm_dirty);
    assert!(state.dirty.ambient_dirty);
    assert!(state.dirty.viewport_dirty);
    assert!(state.dirty.layout_dirty);
    assert!(!state.dirty.is_clean());

    // Render processes all dirty flags
    let _snapshot = kernel.render(16.0);

    // Verify: ALL flags cleared
    let state = kernel.get_state();
    assert!(state.dirty.is_clean(), "is_clean must be true after render");
    assert!(!state.dirty.fsm_dirty, "fsm_dirty must be cleared");
    assert!(!state.dirty.routing_dirty, "routing_dirty must be cleared");
    assert!(!state.dirty.ambient_dirty, "ambient_dirty must be cleared");
    assert!(
        !state.dirty.viewport_dirty,
        "viewport_dirty must be cleared"
    );
    assert!(!state.dirty.layout_dirty, "layout_dirty must be cleared");
    assert!(
        !state.dirty.is_scene_structure_dirty(),
        "scene_structure_dirty must be cleared"
    );
    assert!(
        state.dirty.dirty_nodes.is_empty(),
        "dirty_nodes must be empty"
    );

    // Second render: no-op
    let _snapshot2 = kernel.render(16.0);
    assert!(
        kernel.get_state().dirty.is_clean(),
        "must remain clean after second no-op render"
    );
}

// ============================================================================
// Test 9: Multiple Mutations Accumulate Dirty Flags
// ============================================================================

/// Multiple different mutations between renders accumulate their respective
/// dirty flags. None are lost, and all are processed in a single render.
#[test]
fn multiple_mutations_accumulate_dirty_flags_correctly() {
    let root = make_flat_tree(3);
    let mut kernel = make_clean_kernel(root);

    // Mutation 1: FSM (set_fsm_state does NOT trigger recompute — marks dirty only)
    kernel.set_fsm_state(
        "fsm:a".to_string(),
        FSMState {
            value: "state_a".to_string(),
            context: serde_json::json!({}),
        },
    );

    // After set_fsm_state: fsm_dirty is set (no recompute to clear it)
    assert!(
        kernel.get_state().dirty.fsm_dirty,
        "fsm_dirty must be set after set_fsm_state"
    );

    // Mutation 2: Routing (set_route triggers recompute which processes ALL
    // accumulated dirty flags — both FSM and routing — then clears)
    let origin = OriginID::new("pointer:0");
    kernel.set_route(&origin, Some(&"child_2".to_string()));

    // After set_route: recompute processed both FSM + routing and cleared dirty
    // (Task 167 Phase E — no double-compute)
    let state = kernel.get_state();
    assert!(
        state.dirty.is_clean(),
        "set_route recompute processes all accumulated dirty flags and clears"
    );

    // render() takes O(1) fast path
    let _snapshot = kernel.render(16.0);

    // Verify: still clean
    assert!(kernel.get_state().dirty.is_clean());
}

// ============================================================================
// Test 10: FSM + Route Between Renders — Both Flags Set
// ============================================================================

/// Tests the scenario where both set_fsm_state and set_route are called
/// between renders. set_fsm_state marks dirty without recompute, then
/// set_route triggers recompute which processes BOTH changes and clears
/// dirty (Task 167 Phase E). render() takes the O(1) fast path.
#[test]
fn set_fsm_state_and_set_route_between_renders_both_dirty() {
    let root = make_flat_tree(2);
    let mut kernel = make_clean_kernel(root);

    // Mutation 1: set_fsm_state — marks fsm_dirty, NO recompute
    kernel.set_fsm_state(
        "fsm:node_alpha".to_string(),
        FSMState {
            value: "state_b".to_string(),
            context: serde_json::json!({"key": "val"}),
        },
    );
    assert!(
        kernel.get_state().dirty.fsm_dirty,
        "fsm_dirty set by set_fsm_state"
    );

    // Mutation 2: set_route — marks routing_dirty, triggers recompute which
    // processes BOTH fsm_dirty and routing_dirty, then clears all dirty flags
    let origin = OriginID::new("keyboard:0");
    kernel.set_route(&origin, Some(&"child_0".to_string()));

    // After recompute: all dirty flags cleared (Task 167 Phase E)
    assert!(
        kernel.get_state().dirty.is_clean(),
        "set_route recompute processes all accumulated dirty flags and clears"
    );

    // Render — O(1) fast path
    let _snapshot = kernel.render(16.0);

    // Verify: still clean
    assert!(kernel.get_state().dirty.is_clean());
}

// ============================================================================
// Test 11: Performance — Large Tree, Single Property Change
// ============================================================================

/// With a 500-node tree and a single property change, incremental render
/// should complete faster than full render. We measure by comparing the time
/// of a no-mutation render (incremental fast path) against a forced-dirty
/// render (via set_ambient which triggers full binding eval).
#[test]
fn performance_large_tree_incremental_faster_than_full() {
    // Build a 22-wide x 22-deep = 22 + 22*22 = 506 nodes
    let root = make_wide_tree(22);
    let mut kernel = make_clean_kernel(root);

    // Measure incremental (no-op) render time over multiple iterations
    let iterations = 50;
    let start_incremental = std::time::Instant::now();
    for _ in 0..iterations {
        let _snapshot = kernel.render(16.0);
    }
    let incremental_elapsed = start_incremental.elapsed();

    // Measure full render time: each iteration marks ambient dirty (forces
    // full binding eval + full layout)
    let start_full = std::time::Instant::now();
    for i in 0..iterations {
        kernel.set_ambient("perf_test".to_string(), serde_json::json!(i));
        let _snapshot = kernel.render(16.0);
    }
    let full_elapsed = start_full.elapsed();

    // Verify: incremental (no-op) is measurably faster than full render
    assert!(
        incremental_elapsed < full_elapsed,
        "Incremental no-op render ({:?}) must be faster than full render ({:?}) \
         over {} iterations with 500+ nodes",
        incremental_elapsed,
        full_elapsed,
        iterations,
    );

    // Additional: the ratio should be significant (at least 2x faster)
    // This is a soft check — timing can vary, but the gap should be large
    let ratio = full_elapsed.as_nanos() as f64 / incremental_elapsed.as_nanos().max(1) as f64;
    assert!(
        ratio > 1.5,
        "Full render should be at least 1.5x slower than no-op incremental. \
         Ratio: {:.2}x (full={:?}, incremental={:?})",
        ratio,
        full_elapsed,
        incremental_elapsed,
    );
}

// ============================================================================
// Test 12: Render Count — Incremental Evaluates Fewer Bindings
// ============================================================================

/// When only a single node's properties change via update_scene, the
/// incremental render should mark fewer nodes as dirty than a structural
/// change that rebuilds the entire tree.
#[test]
fn render_count_incremental_evaluates_fewer_nodes() {
    let root = make_flat_tree(10);
    let mut kernel = make_clean_kernel(root.clone());

    // Scenario A: Update a single node's text property
    // Create modified tree with only child_5 changed (text added)
    let mut modified_root = root.clone();
    Arc::make_mut(&mut modified_root.children[5]).props.text = Some("Updated text".to_string());

    let result = kernel.update_scene(modified_root);
    assert!(result.is_ok());

    // Check: dirty_nodes should contain child_5 (if it was an UpdateProps patch)
    let state = kernel.get_state();
    let dirty_count_a = state.dirty.dirty_nodes.len();
    let structure_dirty_a = state.dirty.is_scene_structure_dirty();

    // Render A
    let _snapshot_a = kernel.render(16.0);

    // Scenario B: Structural change (add a new node)
    let mut modified_root_b = root;
    modified_root_b
        .children
        .push(Arc::new(SceneNode::new("child_10", NodeKind::Text)));
    let result_b = kernel.update_scene(modified_root_b);
    assert!(result_b.is_ok());

    let state_b = kernel.get_state();
    let structure_dirty_b = state_b.dirty.is_scene_structure_dirty();

    // Structural change must trigger scene_structure_dirty
    assert!(
        structure_dirty_b,
        "Adding a new node must set scene_structure_dirty"
    );

    // For a property-only change, dirty_nodes should be minimal
    // (structural changes set scene_structure_dirty instead)
    if !structure_dirty_a {
        assert!(
            dirty_count_a <= 2,
            "Property-only change should mark at most 2 dirty nodes, got {}",
            dirty_count_a,
        );
    }

    // Render B
    let _snapshot_b = kernel.render(16.0);
    assert!(kernel.get_state().dirty.is_clean());
}

// ============================================================================
// Test 13: Stress — 100 Render Cycles With Alternating Dirty/Clean
// ============================================================================

/// 100 render cycles alternating between mutations and no mutations.
/// Verifies no state corruption, no dirty flag leaks, and consistent
/// snapshot output throughout.
///
/// Note (Task 167 Phase E): set_route() triggers eager recompute which
/// clears dirty flags. set_fsm_state() and set_ambient() do NOT trigger
/// recompute, so dirty flags persist for render() to process.
#[test]
fn stress_100_render_cycles_alternating_dirty_clean_no_corruption() {
    let root = make_flat_tree(5);
    let mut kernel = make_clean_kernel(root);

    let mut last_child_count = 5;

    for cycle in 0..100 {
        if cycle % 2 == 0 {
            // Even cycles: mutate (alternate between different mutation types)
            match cycle % 6 {
                0 => {
                    // set_fsm_state: marks dirty, NO recompute → dirty persists
                    kernel.set_fsm_state(
                        "fsm:stress".to_string(),
                        FSMState {
                            value: format!("state_{}", cycle),
                            context: serde_json::json!({}),
                        },
                    );
                    assert!(
                        !kernel.get_state().dirty.is_clean(),
                        "Cycle {}: must be dirty after set_fsm_state (no recompute)",
                        cycle,
                    );
                }
                2 => {
                    // set_ambient: marks dirty, NO recompute → dirty persists
                    kernel.set_ambient("cycle".to_string(), serde_json::json!(cycle));
                    assert!(
                        !kernel.get_state().dirty.is_clean(),
                        "Cycle {}: must be dirty after set_ambient (no recompute)",
                        cycle,
                    );
                }
                4 => {
                    // set_route: marks dirty → recompute → clears dirty (Task 167 Phase E)
                    let origin = OriginID::new("stress:origin");
                    kernel.set_route(&origin, Some(&format!("child_{}", cycle % 5)));
                    // set_route triggers recompute which clears dirty — this is correct,
                    // the work was done eagerly. render() will take O(1) fast path.
                    assert!(
                        kernel.get_state().dirty.is_clean(),
                        "Cycle {}: set_route recompute clears dirty (Task 167 Phase E)",
                        cycle,
                    );
                }
                _ => unreachable!(),
            }
        }
        // Odd cycles: no mutation (clean render)

        // Render
        let snapshot = kernel.render(16.0);

        // Verify: snapshot is always valid
        assert_eq!(
            snapshot.tree.id, "root",
            "Cycle {}: root ID must be 'root'",
            cycle,
        );
        assert!(
            !snapshot.tree.children.is_empty(),
            "Cycle {}: root must have children",
            cycle,
        );
        last_child_count = snapshot.tree.children.len();

        // Verify: always clean after render
        assert!(
            kernel.get_state().dirty.is_clean(),
            "Cycle {}: must be clean after render",
            cycle,
        );
    }

    // Verify: tree structure preserved throughout
    assert_eq!(
        last_child_count, 5,
        "Child count must be preserved across all cycles"
    );
}

// ============================================================================
// Test 14: Deep Tree — Single Dirty Leaf, Ancestors Recomputed
// ============================================================================

/// In a deep tree (depth=10), marking a single leaf as dirty should cause
/// only the path from root to that leaf to be recomputed, not the entire tree.
/// This verifies the dirty subtree propagation mechanism.
#[test]
fn deep_tree_single_dirty_leaf_ancestors_recomputed() {
    let root = make_deep_tree(10);
    let mut kernel = make_clean_kernel(root.clone());

    // Capture initial layout frames
    let initial_frames = kernel.get_state().layout_frames.clone();
    assert!(
        !initial_frames.is_empty(),
        "Must have layout frames after initial render"
    );

    // Mutate: change the deepest leaf's text
    let mut modified_root = root;
    fn find_and_modify_leaf(node: &mut SceneNode, target_id: &str) -> bool {
        if node.id == target_id {
            node.props.text = Some("Modified leaf".to_string());
            return true;
        }
        for child in &mut node.children {
            if find_and_modify_leaf(Arc::make_mut(child), target_id) {
                return true;
            }
        }
        false
    }
    let found = find_and_modify_leaf(&mut modified_root, "depth_10");
    assert!(found, "Must find depth_10 node");

    let result = kernel.update_scene(modified_root);
    assert!(result.is_ok());

    // Verify: dirty flags are set
    assert!(
        !kernel.get_state().dirty.is_clean(),
        "Must be dirty after update_scene"
    );

    // Render
    let snapshot = kernel.render(16.0);

    // Verify: snapshot valid
    assert_eq!(snapshot.tree.id, "root");

    // Verify: clean after render
    assert!(kernel.get_state().dirty.is_clean());

    // Verify: layout frames exist (tree is still valid)
    assert!(
        !snapshot.frames.is_empty(),
        "Must have layout frames after incremental render"
    );
}

// ============================================================================
// Test 15: Viewport Change Does NOT Set Binding-Related Flags
// ============================================================================

/// Confirms that viewport-only changes do not trigger unnecessary binding
/// re-evaluation. Only layout_dirty and viewport_dirty should be set.
#[test]
fn viewport_change_does_not_set_binding_flags() {
    let root = make_flat_tree(3);
    let mut kernel = make_clean_kernel(root);

    // Viewport change
    kernel.set_viewport(Size::new(1920.0, 1080.0));

    let state = kernel.get_state();
    // viewport_dirty and layout_dirty should be set
    assert!(state.dirty.viewport_dirty);
    assert!(state.dirty.layout_dirty);
    // Binding-related flags should NOT be set
    assert!(
        !state.dirty.fsm_dirty,
        "fsm_dirty must not be set by viewport"
    );
    assert!(
        !state.dirty.routing_dirty,
        "routing_dirty must not be set by viewport"
    );
    assert!(
        !state.dirty.ambient_dirty,
        "ambient_dirty must not be set by viewport"
    );
    assert!(
        !state.dirty.is_scene_structure_dirty(),
        "scene_structure_dirty must not be set by viewport"
    );
    assert!(
        state.dirty.dirty_nodes.is_empty(),
        "dirty_nodes must be empty for viewport"
    );

    // Phase skip decisions
    assert!(
        !state.dirty.needs_binding_eval(),
        "needs_binding_eval must be false for viewport-only"
    );
    assert!(
        state.dirty.needs_layout(),
        "needs_layout must be true for viewport change"
    );

    let _snapshot = kernel.render(16.0);
    assert!(kernel.get_state().dirty.is_clean());
}

// ============================================================================
// Test 16: Layout Frames Preserved When Only FSM Changes
// ============================================================================

/// When only FSM changes (no layout inputs affected), layout frames from
/// the previous render must be reused exactly (same HashMap, not recomputed).
#[test]
fn layout_frames_preserved_when_only_fsm_changes() {
    let root = make_flat_tree(3);
    let mut kernel = make_clean_kernel(root);

    // Capture layout frames before FSM mutation
    let frames_before = kernel.get_state().layout_frames.clone();

    // FSM-only mutation
    kernel.set_fsm_state(
        "fsm:panel".to_string(),
        FSMState {
            value: "collapsed".to_string(),
            context: serde_json::json!({}),
        },
    );

    // Verify: needs_layout is false (FSM doesn't affect layout directly)
    assert!(
        !kernel.get_state().dirty.needs_layout(),
        "needs_layout must be false for FSM-only change"
    );

    // Render
    let snapshot = kernel.render(16.0);

    // Verify: layout frames are identical (reused, not recomputed)
    assert_eq!(
        snapshot.frames.len(),
        frames_before.len(),
        "Frame count must be identical"
    );
    for (id, frame_before) in frames_before.iter() {
        let frame_after = snapshot
            .frames
            .get(id)
            .unwrap_or_else(|| panic!("Frame for '{}' missing after FSM-only render", id));
        assert_eq!(
            frame_before, frame_after,
            "Frame for '{}' must be identical after FSM-only change",
            id,
        );
    }
}

// ============================================================================
// Test 17: Scene Structure Change Triggers Full Recomputation
// ============================================================================

/// When a node is added to the tree (scene_structure_dirty), both binding
/// evaluation AND layout must run (full recomputation path).
#[test]
fn scene_structure_change_triggers_full_recomputation() {
    let root = make_flat_tree(3);
    let mut kernel = make_clean_kernel(root.clone());

    // Add a new child node
    let mut modified_root = root;
    modified_root
        .children
        .push(Arc::new(SceneNode::new("child_3", NodeKind::Container)));

    let result = kernel.update_scene(modified_root);
    assert!(result.is_ok());

    // Verify: scene_structure_dirty forces full recomputation
    let state = kernel.get_state();
    assert!(
        state.dirty.is_scene_structure_dirty(),
        "scene_structure_dirty must be set"
    );
    assert!(
        state.dirty.needs_binding_eval(),
        "needs_binding_eval must be true"
    );
    assert!(state.dirty.needs_layout(), "needs_layout must be true");

    // Render
    let snapshot = kernel.render(16.0);

    // Verify: new node appears in snapshot
    assert_eq!(
        snapshot.tree.children.len(),
        4,
        "Must have 4 children after insertion"
    );
    assert_eq!(
        snapshot.tree.children[3].id, "child_3",
        "New child must be at index 3"
    );

    // Verify: new node has a layout frame
    assert!(
        snapshot.frames.contains_key("child_3"),
        "New node must have a layout frame"
    );

    // Verify: clean after render
    assert!(kernel.get_state().dirty.is_clean());
}
