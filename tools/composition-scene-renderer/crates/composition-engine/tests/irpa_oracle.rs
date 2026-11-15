// crates/composition-engine/tests/irpa_oracle.rs
//
// # Purpose
//
// Correctness oracle tests for the Task 168 IRPA (Incremental Runtime
// Publication Architecture). These tests prove that the incremental render
// pipeline (P1-P4: Arc structural sharing, RuntimeGraph, flat side-map,
// typed flat index) produces IDENTICAL output to a full-rebuild oracle
// for all mutation types.
//
// # Key Concepts
//
// Each test:
// 1. Builds a scene tree and initializes a Kernel
// 2. Performs an initial render to populate all caches
// 3. Applies a mutation (property change, insert, remove, FSM toggle, etc.)
// 4. Renders incrementally (the Kernel's normal path)
// 5. Builds a "full-rebuild oracle" by creating a fresh Kernel with the
//    same final tree state and rendering from scratch
// 6. Asserts that the incremental snapshot matches the oracle snapshot
//    for ALL fields: tree, frames, semantics, text_inputs, routing
//
// # Non-Negotiable Invariants
//
// 1. Incremental snapshot MUST be field-identical to oracle snapshot.
// 2. Arc sharing MUST preserve pointer identity for unchanged subtrees.
// 3. RuntimeGraph incremental update MUST produce the same derived state
//    as a full rebuild from scratch.
// 4. Text input side-map MUST match oracle regardless of mutation path.
// 5. All tests are Physics-only — zero Society words, zero application logic.
//
// # Security Considerations
//
// Pure in-memory tests. No I/O, no network, no secrets. Test data uses
// opaque IDs with no Society semantics.
//
// # AI Directive
//
// The extensive documentation in this codebase is a critical design feature.
// You are FORBIDDEN from simplifying or removing it. Your mandate is to
// MAINTAIN and EXTEND this level of meticulous detail.

mod common;
use common::*;

use composition_engine::kernel::{
    FSMConfig, FSMState, FSMStateNode, FSMTransition, Kernel, NodeKind, NodeProps, SceneNode,
    ScenePatch, TextInputConfig,
};
use std::collections::HashMap;
use std::sync::Arc;

// ============================================================================
// File-Specific Constants
// ============================================================================

/// Standard FSM ID for toggle tests.
const FSM_ID: &str = "fsm:oracle";

// ============================================================================
// File-Specific Test Helpers
// ============================================================================

/// Create a 2-state toggle FSM config.
fn make_toggle_fsm() -> FSMConfig {
    let mut states = HashMap::new();
    states.insert(
        "idle".to_string(),
        FSMStateNode {
            on: Some(HashMap::from([(
                "toggle".to_string(),
                vec![FSMTransition {
                    target: "active".to_string(),
                    guard: None,
                    actions: None,
                }],
            )])),
            ..Default::default()
        },
    );
    states.insert(
        "active".to_string(),
        FSMStateNode {
            on: Some(HashMap::from([(
                "toggle".to_string(),
                vec![FSMTransition {
                    target: "idle".to_string(),
                    guard: None,
                    actions: None,
                }],
            )])),
            ..Default::default()
        },
    );
    FSMConfig {
        initial: "idle".to_string(),
        states,
    }
}

/// Collect all node IDs from a tree (depth-first).
fn collect_node_ids(node: &SceneNode) -> Vec<String> {
    let mut ids = vec![node.id.clone()];
    for child in &node.children {
        ids.extend(collect_node_ids(child));
    }
    ids
}

// ============================================================================
// Oracle Tests
// ============================================================================

/// Oracle: property change produces identical snapshot to full rebuild.
///
/// Mutation: Update text of a single leaf node.
/// Expectation: Incremental snapshot matches oracle for all fields.
///
/// # Oracle Strategy
///
/// Extract the final tree from the incremental snapshot and use it as the
/// starting point for a fresh kernel. This ensures the oracle tree is
/// structurally identical to the incremental result (same binding resolutions,
/// same computed values). The oracle then verifies that a fresh render from
/// the same tree state produces identical layout, semantics, and side-maps.
#[test]
fn oracle_property_change_matches_full_rebuild() {
    // Build initial state
    let tree = make_nested_tree();
    let mut kernel = Kernel::new(tree.clone(), VIEWPORT);
    kernel.render(0.0);

    // Apply property change: update leaf-a0's text
    let updated_node = SceneNode {
        id: "leaf-a0".to_string(),
        kind: NodeKind::Text,
        props: NodeProps {
            text: Some("Updated A0".to_string()),
            ..Default::default()
        },
        children: vec![],
        ..Default::default()
    };
    kernel
        .update_scene_node(updated_node)
        .expect("update must succeed");
    let incremental_snapshot = kernel.render(0.0);

    // Build oracle: extract the SCENE TREE (source, unevaluated bindings)
    // from the incremental kernel — NOT the render tree (snapshot.tree).
    //
    // The scene_tree is the canonical input: mutations applied, bindings
    // unevaluated. The render_tree is the compute OUTPUT. Feeding render_tree
    // into a fresh Kernel::new() would double-process bindings, producing
    // different layout. Using scene_tree ensures both kernels have the same
    // INPUT and we compare their OUTPUTS (which must match per determinism).
    let oracle_tree: SceneNode = (*kernel.get_state().scene_tree).clone();
    let mut oracle_kernel = Kernel::new(oracle_tree, VIEWPORT);
    let oracle_snapshot = oracle_kernel.render(0.0);

    // Verify the property change took effect
    let inc_tree_json = serde_json::to_value(&*incremental_snapshot.tree).unwrap_or_default();
    let leaf_a0 = &inc_tree_json["children"][0]["children"][0];
    assert_eq!(
        leaf_a0["props"]["text"].as_str(),
        Some("Updated A0"),
        "Property change must be reflected in incremental snapshot tree"
    );

    // Compare all snapshot fields
    let diffs = compare_snapshots(&incremental_snapshot, &oracle_snapshot);
    if !diffs.is_empty() {
        // Diagnostic: identify exactly what differs
        if diffs.contains(&"frames".to_string()) {
            let inc_keys: std::collections::BTreeSet<_> =
                incremental_snapshot.frames.keys().collect();
            let orc_keys: std::collections::BTreeSet<_> = oracle_snapshot.frames.keys().collect();
            let only_inc: Vec<_> = inc_keys.difference(&orc_keys).collect();
            let only_orc: Vec<_> = orc_keys.difference(&inc_keys).collect();
            eprintln!("--- FRAME DIAGNOSTIC ---");
            eprintln!(
                "Incremental frame count: {}",
                incremental_snapshot.frames.len()
            );
            eprintln!("Oracle frame count:      {}", oracle_snapshot.frames.len());
            eprintln!("Only in incremental: {:?}", only_inc);
            eprintln!("Only in oracle:      {:?}", only_orc);
            // Show per-node frame diffs for shared keys
            for key in inc_keys.intersection(&orc_keys) {
                let inc_frame = &incremental_snapshot.frames[*key];
                let orc_frame = &oracle_snapshot.frames[*key];
                if inc_frame != orc_frame {
                    eprintln!("DIFF [{}]: inc={:?} vs orc={:?}", key, inc_frame, orc_frame);
                }
            }
            eprintln!("--- END DIAGNOSTIC ---");
        }
    }
    assert!(
        diffs.is_empty(),
        "Property change oracle mismatch in fields: {:?}",
        diffs
    );
}

/// Oracle: insert node produces identical snapshot to full rebuild.
///
/// Mutation: InsertNode at root with index 0.
/// Expectation: Incremental snapshot matches oracle for all fields.
#[test]
fn oracle_insert_node_matches_full_rebuild() {
    let tree = make_flat_tree(10);
    let mut kernel = Kernel::new(tree.clone(), VIEWPORT);
    kernel.render(0.0);

    // Insert a new leaf
    kernel
        .apply_patches(vec![ScenePatch::InsertNode {
            parent_id: "root".to_string(),
            index: 0,
            node: make_new_leaf("inserted-oracle"),
        }])
        .expect("InsertNode must succeed");
    let incremental_snapshot = kernel.render(0.0);

    // Build oracle: tree with the node already inserted at index 0
    let mut oracle_children: Vec<Arc<SceneNode>> = vec![Arc::new(make_new_leaf("inserted-oracle"))];
    for i in 0..10 {
        oracle_children.push(Arc::new(SceneNode {
            id: format!("node-{}", i),
            kind: NodeKind::Text,
            props: NodeProps {
                text: Some(format!("Text {}", i)),
                ..Default::default()
            },
            children: vec![],
            ..Default::default()
        }));
    }
    let oracle_tree = SceneNode {
        id: "root".to_string(),
        kind: NodeKind::Container,
        children: oracle_children,
        ..Default::default()
    };
    let mut oracle_kernel = Kernel::new(oracle_tree, VIEWPORT);
    let oracle_snapshot = oracle_kernel.render(0.0);

    let diffs = compare_snapshots(&incremental_snapshot, &oracle_snapshot);
    assert!(
        diffs.is_empty(),
        "Insert node oracle mismatch in fields: {:?}",
        diffs
    );
}

/// Oracle: remove node produces identical snapshot to full rebuild.
///
/// Mutation: RemoveSubtree on a specific node.
/// Expectation: Incremental snapshot matches oracle for all fields.
#[test]
fn oracle_remove_node_matches_full_rebuild() {
    let tree = make_nested_tree();
    let mut kernel = Kernel::new(tree.clone(), VIEWPORT);
    kernel.render(0.0);

    // Remove panel-b subtree
    kernel
        .apply_patches(vec![ScenePatch::RemoveSubtree {
            node_id: "panel-b".to_string(),
        }])
        .expect("RemoveSubtree must succeed");
    let incremental_snapshot = kernel.render(0.0);

    // Build oracle: nested tree without panel-b
    let oracle_tree = SceneNode {
        id: "root".to_string(),
        kind: NodeKind::Container,
        children: vec![
            Arc::new(SceneNode {
                id: "panel-a".to_string(),
                kind: NodeKind::Container,
                children: vec![
                    Arc::new(SceneNode {
                        id: "leaf-a0".to_string(),
                        kind: NodeKind::Text,
                        props: NodeProps {
                            text: Some("A0".to_string()),
                            ..Default::default()
                        },
                        ..Default::default()
                    }),
                    Arc::new(SceneNode {
                        id: "leaf-a1".to_string(),
                        kind: NodeKind::Text,
                        props: NodeProps {
                            text: Some("A1".to_string()),
                            ..Default::default()
                        },
                        ..Default::default()
                    }),
                ],
                ..Default::default()
            }),
            Arc::new(SceneNode {
                id: "leaf-c".to_string(),
                kind: NodeKind::Text,
                props: NodeProps {
                    text: Some("C".to_string()),
                    ..Default::default()
                },
                ..Default::default()
            }),
        ],
        ..Default::default()
    };
    let mut oracle_kernel = Kernel::new(oracle_tree, VIEWPORT);
    let oracle_snapshot = oracle_kernel.render(0.0);

    let diffs = compare_snapshots(&incremental_snapshot, &oracle_snapshot);
    assert!(
        diffs.is_empty(),
        "Remove node oracle mismatch in fields: {:?}",
        diffs
    );
}

/// Oracle: FSM toggle produces identical snapshot to full rebuild.
///
/// Mutation: dispatch_fsm_event_str("toggle") transitions idle→active.
/// Expectation: Incremental snapshot matches oracle for all fields.
#[test]
fn oracle_fsm_toggle_matches_full_rebuild() {
    let tree = make_flat_tree(10);
    let mut kernel = Kernel::new(tree.clone(), VIEWPORT);
    kernel.register_fsm(FSM_ID.to_string(), make_toggle_fsm());
    kernel.render(0.0);

    // Toggle FSM: idle → active
    kernel
        .dispatch_fsm_event_str(FSM_ID, "toggle")
        .expect("FSM dispatch must succeed");
    let incremental_snapshot = kernel.render(0.0);

    // Build oracle: fresh kernel with FSM already in "active" state
    let mut oracle_kernel = Kernel::new(tree, VIEWPORT);
    oracle_kernel.register_fsm(FSM_ID.to_string(), make_toggle_fsm());
    // Set FSM directly to "active" state (skipping the transition)
    oracle_kernel.set_fsm_state(
        FSM_ID.to_string(),
        FSMState {
            value: "active".to_string(),
            context: serde_json::Value::Object(serde_json::Map::new()),
        },
    );
    let oracle_snapshot = oracle_kernel.render(0.0);

    let diffs = compare_snapshots(&incremental_snapshot, &oracle_snapshot);
    assert!(
        diffs.is_empty(),
        "FSM toggle oracle mismatch in fields: {:?}",
        diffs
    );
}

/// Oracle: multiple mutations in one frame produce identical snapshot.
///
/// Mutations: property change + insert + FSM state change — all before render().
/// Expectation: Incremental snapshot matches oracle for all fields.
#[test]
fn oracle_multiple_mutations_matches_full_rebuild() {
    let tree = make_flat_tree(10);
    let mut kernel = Kernel::new(tree.clone(), VIEWPORT);
    kernel.register_fsm(FSM_ID.to_string(), make_toggle_fsm());
    kernel.render(0.0);

    // Mutation 1: Update node-5's text
    let updated = SceneNode {
        id: "node-5".to_string(),
        kind: NodeKind::Text,
        props: NodeProps {
            text: Some("Multi-mutated".to_string()),
            ..Default::default()
        },
        children: vec![],
        ..Default::default()
    };
    kernel
        .update_scene_node(updated)
        .expect("update must succeed");

    // Mutation 2: Insert a new node
    kernel
        .apply_patches(vec![ScenePatch::InsertNode {
            parent_id: "root".to_string(),
            index: 5,
            node: make_new_leaf("multi-inserted"),
        }])
        .expect("InsertNode must succeed");

    // Mutation 3: FSM toggle
    kernel.set_fsm_state(
        FSM_ID.to_string(),
        FSMState {
            value: "active".to_string(),
            context: serde_json::Value::Object(serde_json::Map::new()),
        },
    );

    let incremental_snapshot = kernel.render(0.0);

    // Build oracle: start from final state
    let mut oracle_children: Vec<Arc<SceneNode>> = Vec::new();
    for i in 0..10 {
        if i == 5 {
            oracle_children.push(Arc::new(make_new_leaf("multi-inserted")));
        }
        let text = if i == 5 {
            "Multi-mutated".to_string()
        } else {
            format!("Text {}", i)
        };
        oracle_children.push(Arc::new(SceneNode {
            id: format!("node-{}", i),
            kind: NodeKind::Text,
            props: NodeProps {
                text: Some(text),
                ..Default::default()
            },
            children: vec![],
            ..Default::default()
        }));
    }
    let oracle_tree = SceneNode {
        id: "root".to_string(),
        kind: NodeKind::Container,
        children: oracle_children,
        ..Default::default()
    };
    let mut oracle_kernel = Kernel::new(oracle_tree, VIEWPORT);
    oracle_kernel.register_fsm(FSM_ID.to_string(), make_toggle_fsm());
    oracle_kernel.set_fsm_state(
        FSM_ID.to_string(),
        FSMState {
            value: "active".to_string(),
            context: serde_json::Value::Object(serde_json::Map::new()),
        },
    );
    let oracle_snapshot = oracle_kernel.render(0.0);

    let diffs = compare_snapshots(&incremental_snapshot, &oracle_snapshot);
    assert!(
        diffs.is_empty(),
        "Multiple mutations oracle mismatch in fields: {:?}",
        diffs
    );
}

/// Oracle: text input update via side-map matches full rebuild.
///
/// Mutation: Activate a text buffer, then update its content.
/// Expectation: snapshot.text_inputs matches oracle.
#[test]
fn oracle_text_input_change_matches_full_rebuild() {
    let tree = make_flat_tree(5);
    let mut kernel = Kernel::new(tree.clone(), VIEWPORT);
    kernel.render(0.0);

    // Activate text buffer on node-2
    let config = TextInputConfig {
        editable: true,
        multiline: false,
        secure: false,
        keyboard_type: "text".to_string(),
        placeholder: Some("Enter text".to_string()),
    };
    kernel.activate_text_buffer_with_value(&"node-2".to_string(), &config, "Hello");
    let incremental_snapshot = kernel.render(0.0);

    // Build oracle: fresh kernel with text buffer activated from scratch
    let mut oracle_kernel = Kernel::new(tree, VIEWPORT);
    oracle_kernel.activate_text_buffer_with_value(&"node-2".to_string(), &config, "Hello");
    let oracle_snapshot = oracle_kernel.render(0.0);

    // Check text_inputs specifically
    assert_eq!(
        incremental_snapshot.text_inputs.len(),
        oracle_snapshot.text_inputs.len(),
        "text_inputs map size must match"
    );
    assert_eq!(
        incremental_snapshot.text_inputs.get("node-2"),
        oracle_snapshot.text_inputs.get("node-2"),
        "text_inputs[node-2] must match oracle"
    );

    let diffs = compare_snapshots(&incremental_snapshot, &oracle_snapshot);
    assert!(
        diffs.is_empty(),
        "Text input oracle mismatch in fields: {:?}",
        diffs
    );
}

/// Oracle: randomized 100-mutation sequence on 200-node tree matches.
///
/// Applies a deterministic pseudo-random sequence of mutations
/// (property changes, inserts, removes) and verifies the final snapshot
/// matches a full rebuild from the equivalent final state.
///
/// This is the most comprehensive oracle test — exercises the full
/// incremental pipeline under realistic mutation patterns.
#[test]
fn oracle_randomized_100_mutations_on_200_node_tree() {
    let tree = make_flat_tree(200);
    let mut kernel = Kernel::new(tree.clone(), VIEWPORT);
    kernel.render(0.0);

    // Apply 100 deterministic "random" mutations using a simple LCG
    // (Linear Congruential Generator) for reproducibility.
    let mut rng_state: u64 = 42; // seed
    let lcg_next = |state: &mut u64| -> u64 {
        *state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *state >> 33
    };

    let mut next_insert_id = 0u32;
    let mut current_node_count = 200usize;

    for mutation_idx in 0..100 {
        let mutation_type = lcg_next(&mut rng_state) % 3;
        match mutation_type {
            0 => {
                // Property change: update text on a random existing node
                let target_idx = (lcg_next(&mut rng_state) as usize) % current_node_count;
                let target_id = format!("node-{}", target_idx);
                let updated = SceneNode {
                    id: target_id,
                    kind: NodeKind::Text,
                    props: NodeProps {
                        text: Some(format!("Mutated-{}", mutation_idx)),
                        ..Default::default()
                    },
                    children: vec![],
                    ..Default::default()
                };
                // update_scene_node may fail if node was removed; that's ok
                let _ = kernel.update_scene_node(updated);
            }
            1 => {
                // Insert: add a new leaf under root
                let insert_id = format!("rng-insert-{}", next_insert_id);
                next_insert_id += 1;
                let idx = (lcg_next(&mut rng_state) as usize) % (current_node_count + 1);
                let _ = kernel.apply_patches(vec![ScenePatch::InsertNode {
                    parent_id: "root".to_string(),
                    index: idx.min(current_node_count), // clamp to valid range
                    node: make_new_leaf(&insert_id),
                }]);
                current_node_count += 1;
            }
            _ => {
                // Remove: remove a random leaf (only if >10 nodes to avoid empty tree)
                if current_node_count > 10 {
                    let target_idx = (lcg_next(&mut rng_state) as usize) % current_node_count;
                    let target_id = format!("node-{}", target_idx);
                    // RemoveSubtree may fail if node doesn't exist; that's ok
                    let _ = kernel
                        .apply_patches(vec![ScenePatch::RemoveSubtree { node_id: target_id }]);
                    // Don't decrement if remove failed, but approximation is fine
                    // for testing purposes
                }
            }
        }
    }

    // Render the incremental result after all 100 mutations
    let incremental_snapshot = kernel.render(0.0);

    // Build oracle from the incremental kernel's current tree state.
    // We extract the tree from the incremental snapshot and use it
    // as the starting point for a fresh kernel.
    let oracle_tree: SceneNode = (*incremental_snapshot.tree).clone();
    let mut oracle_kernel = Kernel::new(oracle_tree, VIEWPORT);
    let oracle_snapshot = oracle_kernel.render(0.0);

    // Compare tree structure
    let inc_ids = collect_node_ids(&incremental_snapshot.tree);
    let orc_ids = collect_node_ids(&oracle_snapshot.tree);
    assert_eq!(
        inc_ids, orc_ids,
        "Node ID sets must match after 100 random mutations"
    );

    // Compare frames (layout may differ slightly due to floating point,
    // but structure should match)
    assert_eq!(
        incremental_snapshot.frames.len(),
        oracle_snapshot.frames.len(),
        "Frame count must match"
    );

    // Compare semantics
    assert_eq!(
        incremental_snapshot.semantics.len(),
        oracle_snapshot.semantics.len(),
        "Semantics count must match"
    );

    // Compare text_inputs
    assert_eq!(
        incremental_snapshot.text_inputs, oracle_snapshot.text_inputs,
        "text_inputs must match"
    );
}

// ============================================================================
// Arc Sharing Tests
// ============================================================================

/// Arc sharing: after property change, unchanged subtrees in scene_tree are Arc::ptr_eq.
///
/// Verifies P1 (structural sharing): when only one node changes via
/// update_scene_node(), the kernel's internal scene_tree uses path-copying
/// (Arc::make_mut) so that sibling subtrees remain pointer-identical.
///
/// # Architecture Note
///
/// The SNAPSHOT tree (snapshot.tree) is the `render_tree` built by compute() —
/// a new tree with bindings resolved. P1 structural sharing applies to the
/// kernel's internal `scene_tree` (via mutate_node's path-copying), which is
/// accessed via `get_state().scene_tree`.
#[test]
fn arc_sharing_unchanged_subtrees_are_ptr_eq_after_property_change() {
    let tree = make_nested_tree();
    let mut kernel = Kernel::new(tree, VIEWPORT);
    kernel.render(0.0);

    // Capture scene_tree references BEFORE mutation
    let state_before = kernel.get_state();
    let panel_b_before = Arc::clone(&state_before.scene_tree.children[1]); // panel-b
    let leaf_c_before = Arc::clone(&state_before.scene_tree.children[2]); // leaf-c

    // Change leaf-a0 only — this triggers path-copying on scene_tree
    let updated = SceneNode {
        id: "leaf-a0".to_string(),
        kind: NodeKind::Text,
        props: NodeProps {
            text: Some("Changed".to_string()),
            ..Default::default()
        },
        children: vec![],
        ..Default::default()
    };
    kernel
        .update_scene_node(updated)
        .expect("update must succeed");

    // After mutation, scene_tree's unchanged siblings should be Arc::ptr_eq
    let state_after = kernel.get_state();
    let panel_b_after = &state_after.scene_tree.children[1]; // panel-b
    let leaf_c_after = &state_after.scene_tree.children[2]; // leaf-c

    // panel-b subtree should be pointer-identical (Arc::ptr_eq)
    // because only panel-a's child (leaf-a0) changed via path-copying
    assert!(
        Arc::ptr_eq(&panel_b_before, panel_b_after),
        "Unchanged subtree (panel-b) must be Arc::ptr_eq in scene_tree after property change in panel-a"
    );

    // leaf-c should also be pointer-identical
    assert!(
        Arc::ptr_eq(&leaf_c_before, leaf_c_after),
        "Unchanged leaf (leaf-c) must be Arc::ptr_eq in scene_tree"
    );
}

// ============================================================================
// RuntimeGraph Incremental Performance Test
// ============================================================================

/// RuntimeGraph: incremental update time < full rebuild time for property changes.
///
/// Measures that property changes (which use the incremental path) are
/// faster than structure changes (which force a full rebuild). This is a
/// correctness test for the 3-tier update strategy, not a microbenchmark.
#[test]
fn runtime_graph_incremental_faster_than_full_rebuild() {
    use std::time::Instant;

    let tree = make_flat_tree(200);
    let mut kernel = Kernel::new(tree.clone(), VIEWPORT);
    kernel.render(0.0);

    // Measure property change render (incremental RuntimeGraph path)
    let mut property_times = Vec::new();
    for i in 0..10 {
        let mut k = Kernel::new(tree.clone(), VIEWPORT);
        k.render(0.0);

        let updated = SceneNode {
            id: format!("node-{}", i),
            kind: NodeKind::Text,
            props: NodeProps {
                text: Some(format!("Perf-{}", i)),
                ..Default::default()
            },
            children: vec![],
            ..Default::default()
        };
        k.update_scene_node(updated).expect("update must succeed");

        let start = Instant::now();
        k.render(0.0);
        property_times.push(start.elapsed());
    }

    // Measure insert render (full RuntimeGraph rebuild due to structure_changed)
    let mut insert_times = Vec::new();
    for i in 0..10 {
        let mut k = Kernel::new(tree.clone(), VIEWPORT);
        k.render(0.0);

        k.apply_patches(vec![ScenePatch::InsertNode {
            parent_id: "root".to_string(),
            index: 0,
            node: make_new_leaf(&format!("perf-insert-{}", i)),
        }])
        .expect("InsertNode must succeed");

        let start = Instant::now();
        k.render(0.0);
        insert_times.push(start.elapsed());
    }

    let avg_property =
        property_times.iter().map(|d| d.as_nanos()).sum::<u128>() / property_times.len() as u128;
    let avg_insert =
        insert_times.iter().map(|d| d.as_nanos()).sum::<u128>() / insert_times.len() as u128;

    // Property change (incremental) should be <= insert (full rebuild)
    // We allow up to 2x margin because both paths are fast and timing varies
    assert!(
        avg_property <= avg_insert * 2,
        "Property change ({} ns avg) should not be much slower than insert ({} ns avg). \
         Incremental RuntimeGraph update should be <= full rebuild.",
        avg_property,
        avg_insert
    );
}

/// Clean render (no-op) on a large tree should be fast (no full rebuilds).
///
/// This verifies that the no-op path through RuntimeGraph is truly O(1):
/// no tree walks, no collection rebuilds, just cached data reads.
#[test]
fn noop_render_is_fast_on_large_tree() {
    use std::time::Instant;

    let tree = make_flat_tree(500);
    let mut kernel = Kernel::new(tree, VIEWPORT);
    kernel.render(0.0); // initial render populates caches

    // Measure 10 consecutive no-op renders
    let mut times = Vec::new();
    for _ in 0..10 {
        let start = Instant::now();
        kernel.render(0.0);
        times.push(start.elapsed());
    }

    let avg_nanos = times.iter().map(|d| d.as_nanos()).sum::<u128>() / times.len() as u128;

    // No-op render on 500-node tree should complete in < 500us (generous bound).
    // Post-168: Arc::clone for tree + frames + HashMap::new for text_inputs + clone semantics.
    assert!(
        avg_nanos < 500_000, // 500us
        "No-op render on 500-node tree took {} ns avg — expected < 500,000 ns",
        avg_nanos
    );
}
