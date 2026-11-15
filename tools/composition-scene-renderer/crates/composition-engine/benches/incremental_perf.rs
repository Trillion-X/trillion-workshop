// crates/composition-engine/benches/incremental_perf.rs
//
// # Purpose
//
// Performance conformance gate benchmarks for the composition engine's
// incremental rendering pipeline. These benchmarks enforce sub-millisecond
// recompute targets after Task 167 optimizations (Phases A-E):
//
// - Phase A: Structure-dirty decoupling (InsertNode → incremental compute)
// - Phase B: JSON serialization elimination (cached scene_index/previous_index)
// - Phase C: Key-scoped dirty + binding dependency index (O(affected) vs O(tree))
// - Phase E: Double-compute elimination (recompute clears dirty → render() O(1))
//
// # Non-Negotiable Invariants
//
// 1. ALL benchmarks use a 100-node tree — the canonical performance baseline.
// 2. Benchmarks are split into two categories:
//    a. RENDER-ONLY: Measures mutation + render() where the mutation does NOT
//       trigger eager recompute. This isolates the single-pass render cost.
//       (set_fsm_state, set_ambient, apply_patches, update_scene_node)
//    b. FULL-CYCLE: Measures mutation + render() where the mutation triggers
//       eager recompute (dispatch_fsm_event, set_route). After Phase E,
//       recompute does the work and clears dirty; render() takes O(1) fast path.
// 3. `iter_batched` with `BatchSize::SmallInput` ensures each iteration starts
//    from a clean state (caches populated by initial render, no residual dirty).
// 4. Pure Physics — zero Society words, zero application-specific concepts.
//
// # Architecture After Phase E (Double-Compute Elimination)
//
// Before Phase E:
//   dispatch_fsm_event → recompute (compute+layout) → dirty PRESERVED
//   render() → compute+layout AGAIN → dirty cleared → snapshot
//   Total: 2x compute + 2x layout + 2x JSON serialize (the same work twice)
//
// After Phase E:
//   dispatch_fsm_event → recompute (compute+layout) → dirty CLEARED
//   render() → is_clean()=true → O(1) fast path → snapshot from cache
//   Total: 1x compute + 1x layout + 1x JSON serialize + snapshot creation
//
// For mutations that DON'T trigger recompute (set_fsm_state, set_ambient,
// apply_patches): dirty flags persist, render() does the single pass.
//
// # Perf Gates (Machine-Measurable)
//
// | Gate                                    | Target   | Measurement                                      |
// |-----------------------------------------|----------|--------------------------------------------------|
// | `recompute_p95`                         | <= 1ms   | render() for single dirty node on 100-node tree   |
// | `time_to_snapshot_state_update_p95`     | <= 1ms   | Action dispatch → SceneSnapshot (full cycle)       |
// | `commit_settle_p95`                     | <= 50ms  | Async DB commit — NOT a visual blocker             |
// | `conformance_byte_identical`            | 100%     | Proposed writeset_hash == committed writeset_hash   |
//
// Note: "click → pixel <= 1ms" is NOT a valid browser guarantee. Browser
// rendering involves requestAnimationFrame → paint → composite, bounded by
// vsync (~16.67ms). The measurable gate is `time_to_snapshot_state_update_p95
// <= 1ms` — time from action dispatch to React setState with the new
// SceneSnapshot. The pixel change appears on the next frame after setState.
//
// # Security Considerations
//
// Benchmarks execute arbitrary tree structures and FSM configurations in a
// sandboxed measurement harness. No external I/O, no network access, no
// filesystem writes beyond criterion's report directory.
//
// # AI Directive
//
// The extensive documentation in this codebase is a critical design feature.
// You are FORBIDDEN from simplifying or removing it. Your mandate is to
// MAINTAIN and EXTEND this level of meticulous detail.

use criterion::{criterion_group, criterion_main, BatchSize, BenchmarkId, Criterion};
use std::collections::HashMap;
use std::hint::black_box;
use std::sync::Arc;
use std::time::Duration;

use composition_engine::{
    BindingSelect, BindingTransform, FSMConfig, FSMState, FSMStateNode, FSMTransition, Kernel,
    NodeKind, NodeProps, OriginID, SceneNode, ScenePatch, SelectKey, Size, Visibility,
    VisibilityBinding,
};

// ============================================================================
// Constants — canonical benchmark parameters
// ============================================================================

/// Canonical tree size for all performance benchmarks.
/// 100 nodes approximates a real application scene (editor with sidebar,
/// toolbar, content area, popover, and their children).
const TREE_SIZE: usize = 100;

/// Viewport size for all benchmarks — standard 1080p.
const VIEWPORT: Size = Size {
    w: 1920.0,
    h: 1080.0,
};

/// Number of nodes with FSM-dependent visibility bindings.
/// 3 nodes matches a typical scene: toolbar mode indicator, edit overlay,
/// and context-dependent action bar.
const FSM_BINDING_COUNT: usize = 3;

/// Number of nodes with routing-dependent visibility bindings.
/// 5 nodes matches a typical scene: popover, tooltip, selection highlight,
/// focus ring, and routing-dependent panel.
const ROUTING_BINDING_COUNT: usize = 5;

/// Canonical FSM ID used across all FSM benchmarks.
const FSM_ID: &str = "fsm:bench";

/// Canonical routing origin used across all routing benchmarks.
const ROUTING_ORIGIN: &str = "pointer:0";

// ============================================================================
// Tree Builders — deterministic, reproducible benchmark fixtures
// ============================================================================

/// Build a flat N-node tree with no bindings.
///
/// Structure: root (Container) → N children (Text).
/// No visibility bindings, no FSM, no routing dependencies.
/// Used for insert benchmarks where the tree itself is simple
/// and the benchmark measures InsertNode + incremental recompute.
fn make_plain_tree(n: usize) -> SceneNode {
    let children: Vec<Arc<SceneNode>> = (0..n)
        .map(|i| {
            Arc::new(SceneNode {
                id: format!("node-{}", i),
                kind: NodeKind::Text,
                props: NodeProps {
                    text: Some(format!("Text node {}", i)),
                    ..Default::default()
                },
                children: vec![],
                ..Default::default()
            })
        })
        .collect();
    SceneNode {
        id: "root".to_string(),
        kind: NodeKind::Container,
        children,
        ..Default::default()
    }
}

/// Build a N-node tree where `n_fsm` nodes have FSM-dependent visibility bindings.
///
/// The first `n_fsm` children get `visible: Binding(...)` that reads from
/// FSM key `FSM_ID` and applies `op:core.equals` with value "edit".
/// When the FSM is in "container" state, these nodes are visible (default=true).
/// When dispatching "toggle" event → FSM transitions to "edit" → binding
/// re-evaluates → `op:core.equals("edit", current_state)` → true/false.
///
/// This exercises the key-scoped dirty + BindingDepIndex path (Phase C):
/// only nodes with `DepKey::Fsm("fsm:bench")` are re-evaluated.
fn make_tree_with_fsm_bindings(n: usize, n_fsm: usize) -> SceneNode {
    let children: Vec<Arc<SceneNode>> = (0..n)
        .map(|i| {
            let visible = if i < n_fsm {
                Visibility::Binding(VisibilityBinding {
                    kind: "binding".to_string(),
                    select: BindingSelect {
                        from: "fsm".to_string(),
                        path: Some(FSM_ID.to_string()),
                        key: None,
                    },
                    transform: vec![BindingTransform {
                        op: "op:core.equals".to_string(),
                        args: serde_json::json!({"value": "edit"}),
                    }],
                    default: true,
                })
            } else {
                Visibility::Resolved(true)
            };
            Arc::new(SceneNode {
                id: format!("node-{}", i),
                kind: NodeKind::Text,
                props: NodeProps {
                    text: Some(format!("Text node {}", i)),
                    ..Default::default()
                },
                visible,
                children: vec![],
                ..Default::default()
            })
        })
        .collect();
    SceneNode {
        id: "root".to_string(),
        kind: NodeKind::Container,
        children,
        ..Default::default()
    }
}

/// Build a N-node tree where `n_routing` nodes have routing-dependent
/// visibility bindings.
///
/// The first `n_routing` children get `visible: Binding(...)` that reads from
/// routing key `ROUTING_ORIGIN` via `SelectKey::Static`.
/// Binding transform `op:core.equals` checks if the routed target matches
/// a specific node ID. When `set_route` changes the target, only these
/// `n_routing` nodes are re-evaluated (Phase C scoped resolution).
fn make_tree_with_routing_bindings(n: usize, n_routing: usize) -> SceneNode {
    let children: Vec<Arc<SceneNode>> = (0..n)
        .map(|i| {
            let visible = if i < n_routing {
                Visibility::Binding(VisibilityBinding {
                    kind: "binding".to_string(),
                    select: BindingSelect {
                        from: "routing".to_string(),
                        path: None,
                        key: Some(SelectKey::Static(ROUTING_ORIGIN.to_string())),
                    },
                    transform: vec![BindingTransform {
                        op: "op:core.equals".to_string(),
                        args: serde_json::json!({"value": format!("node-{}", i)}),
                    }],
                    default: false,
                })
            } else {
                Visibility::Resolved(true)
            };
            Arc::new(SceneNode {
                id: format!("node-{}", i),
                kind: NodeKind::Text,
                props: NodeProps {
                    text: Some(format!("Text node {}", i)),
                    ..Default::default()
                },
                visible,
                children: vec![],
                ..Default::default()
            })
        })
        .collect();
    SceneNode {
        id: "root".to_string(),
        kind: NodeKind::Container,
        children,
        ..Default::default()
    }
}

/// Create a simple 2-state FSM toggle config.
///
/// States: "container" ↔ "edit" via "toggle" event.
/// No guards, no actions — pure state transition for benchmarking.
fn make_fsm_config_toggle() -> FSMConfig {
    let mut states = HashMap::new();
    states.insert(
        "container".to_string(),
        FSMStateNode {
            on: Some(HashMap::from([(
                "toggle".to_string(),
                vec![FSMTransition {
                    target: "edit".to_string(),
                    guard: None,
                    actions: None,
                }],
            )])),
            ..Default::default()
        },
    );
    states.insert(
        "edit".to_string(),
        FSMStateNode {
            on: Some(HashMap::from([(
                "toggle".to_string(),
                vec![FSMTransition {
                    target: "container".to_string(),
                    guard: None,
                    actions: None,
                }],
            )])),
            ..Default::default()
        },
    );
    FSMConfig {
        initial: "container".to_string(),
        states,
    }
}

/// Create a new leaf node for InsertNode benchmarks.
fn make_new_leaf_node(id: &str) -> SceneNode {
    SceneNode {
        id: id.to_string(),
        kind: NodeKind::Text,
        props: NodeProps {
            text: Some(format!("Inserted: {}", id)),
            ..Default::default()
        },
        children: vec![],
        ..Default::default()
    }
}

/// Create a subtree with a root container and children for deep-insert benchmarks.
fn make_subtree(id: &str, n_children: usize) -> SceneNode {
    let children: Vec<Arc<SceneNode>> = (0..n_children)
        .map(|i| {
            Arc::new(SceneNode {
                id: format!("{}-child-{}", id, i),
                kind: NodeKind::Text,
                props: NodeProps {
                    text: Some(format!("Subtree child {}", i)),
                    ..Default::default()
                },
                children: vec![],
                ..Default::default()
            })
        })
        .collect();
    SceneNode {
        id: id.to_string(),
        kind: NodeKind::Container,
        children,
        ..Default::default()
    }
}

/// Initialize a Kernel with a given tree, do initial render to populate
/// all caches (scene_index, previous_index, binding_dep_index, layout_frames).
fn init_kernel_with_render(root: SceneNode) -> Kernel {
    let mut kernel = Kernel::new(root, VIEWPORT);
    kernel.render(0.0);
    kernel
}

/// Initialize a Kernel with FSM configuration and initial render.
fn init_kernel_with_fsm(root: SceneNode) -> Kernel {
    let mut kernel = Kernel::new(root, VIEWPORT);
    kernel.register_fsm(FSM_ID.to_string(), make_fsm_config_toggle());
    kernel.render(0.0);
    kernel
}

// ============================================================================
// RENDER-ONLY BENCHMARKS (recompute_p95 gate)
//
// These benchmarks use mutations that do NOT trigger eager recompute:
// - set_fsm_state(): marks fsm_dirty only
// - set_ambient(): marks ambient_dirty only
// - apply_patches(): marks dirty_nodes only
// - update_scene_node(): marks dirty_nodes only
//
// render() does a SINGLE pass: compute + layout + snapshot.
// This isolates the render cost without double-compute.
// ============================================================================

/// Perf Gate: `recompute_p95 <= 1ms`
///
/// Measures: set_fsm_state() + render() on a 100-node tree with 3 FSM bindings.
///
/// set_fsm_state() marks fsm_dirty WITHOUT triggering eager recompute.
/// render() does a single compute+layout pass. Phase C (BindingDepIndex)
/// resolves only the 3 FSM-dependent nodes. 97 nodes use cached overlay.
///
/// This is the TRUE render-only cost for an FSM state change.
fn bench_render_only_fsm(c: &mut Criterion) {
    c.bench_function("render_only_fsm_toggle", |b| {
        b.iter_batched(
            || init_kernel_with_fsm(make_tree_with_fsm_bindings(TREE_SIZE, FSM_BINDING_COUNT)),
            |mut kernel| {
                // Mark FSM dirty without triggering recompute
                kernel.set_fsm_state(
                    FSM_ID.to_string(),
                    FSMState {
                        value: "edit".to_string(),
                        context: serde_json::Value::Object(serde_json::Map::new()),
                    },
                );
                // Single-pass render
                black_box(kernel.render(0.0))
            },
            BatchSize::SmallInput,
        );
    });
}

/// Perf Gate: `recompute_p95 <= 1ms`
///
/// Measures: InsertNode patch + render() on a 100-node tree.
///
/// apply_patches(InsertNode) marks the new node dirty and sets
/// scene_structure_dirty. It does NOT trigger recompute.
/// render() does a single pass: compute (incremental for 1 new node) +
/// layout (full, because structure changed) + snapshot.
fn bench_render_only_insert(c: &mut Criterion) {
    c.bench_function("render_only_insert_node", |b| {
        b.iter_batched(
            || init_kernel_with_render(make_plain_tree(TREE_SIZE)),
            |mut kernel| {
                kernel
                    .apply_patches(vec![ScenePatch::InsertNode {
                        parent_id: "root".to_string(),
                        index: 0,
                        node: make_new_leaf_node("inserted-bench"),
                    }])
                    .expect("InsertNode must succeed");
                black_box(kernel.render(0.0))
            },
            BatchSize::SmallInput,
        );
    });
}

/// Perf Gate: `incremental_layout_property_change <= 0.5ms`
///
/// Measures: update_scene_node() + render() on a 100-node tree.
///
/// Property changes mark only the affected node dirty. No structure change,
/// no global context change. This is the fastest dirty render path:
/// - Compute: incremental (1 dirty node)
/// - Layout: incremental (reuses cached frames)
/// - Scene index: reused from cache
fn bench_render_only_property_change(c: &mut Criterion) {
    c.bench_function("render_only_property_change", |b| {
        b.iter_batched(
            || {
                let root = make_plain_tree(TREE_SIZE);
                let mut kernel = Kernel::new(root.clone(), VIEWPORT);
                kernel.render(0.0);

                let mut updated_node = root.children[50].as_ref().clone();
                updated_node.props.text = Some("Updated text content".to_string());
                (kernel, updated_node)
            },
            |(mut kernel, updated_node)| {
                kernel
                    .update_scene_node(updated_node)
                    .expect("update_scene_node must succeed");
                black_box(kernel.render(0.0))
            },
            BatchSize::SmallInput,
        );
    });
}

/// Perf Gate: `recompute_p95 <= 1ms`
///
/// Measures: set_ambient() + render() on a 100-node tree.
///
/// set_ambient() marks ambient_dirty WITHOUT triggering recompute.
/// render() does a single pass with full binding eval (ambient is global).
fn bench_render_only_ambient(c: &mut Criterion) {
    c.bench_function("render_only_ambient_change", |b| {
        b.iter_batched(
            || init_kernel_with_render(make_plain_tree(TREE_SIZE)),
            |mut kernel| {
                kernel.set_ambient("bench_key".to_string(), serde_json::json!("bench_value"));
                black_box(kernel.render(0.0))
            },
            BatchSize::SmallInput,
        );
    });
}

/// Measures: InsertNode with a 5-node subtree + render().
///
/// Tests that `mark_node_recursive` correctly marks all 5 nodes dirty and
/// incremental compute evaluates each new node's bindings. Layout runs full
/// due to `scene_structure_dirty`.
fn bench_render_only_deep_subtree(c: &mut Criterion) {
    c.bench_function("render_only_deep_subtree", |b| {
        b.iter_batched(
            || init_kernel_with_render(make_plain_tree(TREE_SIZE)),
            |mut kernel| {
                kernel
                    .apply_patches(vec![ScenePatch::InsertNode {
                        parent_id: "root".to_string(),
                        index: 0,
                        node: make_subtree("subtree-bench", 4),
                    }])
                    .expect("InsertNode must succeed");
                black_box(kernel.render(0.0))
            },
            BatchSize::SmallInput,
        );
    });
}

// ============================================================================
// FULL-CYCLE BENCHMARKS (time_to_snapshot_state_update_p95 gate)
//
// These benchmarks use mutations that trigger eager recompute:
// - dispatch_fsm_event_str(): recompute + clear dirty (Phase E)
// - set_route(): recompute + clear dirty (Phase E)
//
// After Phase E: recompute does the work and clears dirty flags.
// render() takes the O(1) fast path (is_clean()=true).
// Total cost = recompute + snapshot creation (no double-compute).
// ============================================================================

/// Perf Gate: `time_to_snapshot_state_update_p95 <= 1ms`
///
/// Measures: dispatch_fsm_event("toggle") + render() on a 100-node tree
/// with 3 FSM-dependent visibility bindings.
///
/// After Phase E: dispatch triggers recompute (processes change, clears dirty),
/// render() takes O(1) fast path. Total = recompute + snapshot from cache.
fn bench_full_cycle_fsm_dispatch(c: &mut Criterion) {
    c.bench_function("full_cycle_fsm_dispatch", |b| {
        b.iter_batched(
            || init_kernel_with_fsm(make_tree_with_fsm_bindings(TREE_SIZE, FSM_BINDING_COUNT)),
            |mut kernel| {
                kernel
                    .dispatch_fsm_event_str(FSM_ID, "toggle")
                    .expect("FSM dispatch must succeed");
                black_box(kernel.render(0.0))
            },
            BatchSize::SmallInput,
        );
    });
}

/// Perf Gate: `time_to_snapshot_state_update_p95 <= 1ms`
///
/// Measures: set_route() + render() on a 100-node tree with 5 routing
/// bindings.
///
/// After Phase E: set_route triggers recompute (processes change, clears
/// dirty), render() takes O(1) fast path.
fn bench_full_cycle_routing_change(c: &mut Criterion) {
    let origin = OriginID {
        id: ROUTING_ORIGIN.to_string(),
    };

    c.bench_function("full_cycle_routing_change", |b| {
        b.iter_batched(
            || {
                let root = make_tree_with_routing_bindings(TREE_SIZE, ROUTING_BINDING_COUNT);
                let mut kernel = Kernel::new(root, VIEWPORT);
                kernel.set_route(&origin, Some(&"node-0".to_string()));
                kernel.render(0.0);
                kernel
            },
            |mut kernel| {
                let origin = OriginID {
                    id: ROUTING_ORIGIN.to_string(),
                };
                kernel.set_route(&origin, Some(&"node-50".to_string()));
                black_box(kernel.render(0.0))
            },
            BatchSize::SmallInput,
        );
    });
}

// ============================================================================
// BASELINE BENCHMARKS
// ============================================================================

/// Baseline: render() when nothing is dirty (is_clean() = true).
///
/// This is the O(1) fast path — create_snapshot from cached state.
/// Measures the irreducible cost of snapshot creation: tree walks for
/// focusable/tabbable nodes, semantics collection, text_input enrichment,
/// layout_frames clone.
///
/// Expected: < 0.5ms. Any benchmark result = recompute_cost + this baseline.
fn bench_render_noop_clean(c: &mut Criterion) {
    c.bench_function("render_noop_clean_state", |b| {
        b.iter_batched(
            || init_kernel_with_render(make_plain_tree(TREE_SIZE)),
            |mut kernel| black_box(kernel.render(0.0)),
            BatchSize::SmallInput,
        );
    });
}

/// Measures the first render() call on a 100-node tree (cold start).
///
/// Worst-case path: no caches, no previous_index, no dep_index.
/// Full binding eval + full layout + full snapshot creation.
/// Not a perf gate — documented for regression detection.
fn bench_initial_render_cold(c: &mut Criterion) {
    c.bench_function("initial_render_cold_100_node", |b| {
        b.iter_batched(
            || {
                let root = make_tree_with_fsm_bindings(TREE_SIZE, FSM_BINDING_COUNT);
                let mut kernel = Kernel::new(root, VIEWPORT);
                kernel.register_fsm(FSM_ID.to_string(), make_fsm_config_toggle());
                kernel
            },
            |mut kernel| black_box(kernel.render(0.0)),
            BatchSize::SmallInput,
        );
    });
}

// ============================================================================
// SCALING BENCHMARKS
// ============================================================================

/// Parameterized: insert recompute at varying tree sizes.
///
/// Demonstrates that incremental compute is O(dirty) not O(tree):
/// - 50-node tree → ~same insert time
/// - 100-node tree → ~same insert time
/// - 200-node tree → ~same insert time (slightly higher layout cost)
fn bench_insert_scaling(c: &mut Criterion) {
    let mut group = c.benchmark_group("insert_scaling");
    for size in [50, 100, 200] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || init_kernel_with_render(make_plain_tree(size)),
                |mut kernel| {
                    kernel
                        .apply_patches(vec![ScenePatch::InsertNode {
                            parent_id: "root".to_string(),
                            index: 0,
                            node: make_new_leaf_node("scale-bench"),
                        }])
                        .expect("InsertNode must succeed");
                    black_box(kernel.render(0.0))
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

/// Parameterized: render-only FSM toggle at varying binding counts.
///
/// Uses set_fsm_state() (no recompute) to isolate single-pass render cost.
/// Demonstrates Phase C scoped resolution is O(affected_bindings).
fn bench_render_only_fsm_scaling(c: &mut Criterion) {
    let mut group = c.benchmark_group("render_only_fsm_scaling");
    for n_fsm in [1, 3, 10] {
        group.bench_with_input(BenchmarkId::from_parameter(n_fsm), &n_fsm, |b, &n_fsm| {
            b.iter_batched(
                || init_kernel_with_fsm(make_tree_with_fsm_bindings(TREE_SIZE, n_fsm)),
                |mut kernel| {
                    kernel.set_fsm_state(
                        FSM_ID.to_string(),
                        FSMState {
                            value: "edit".to_string(),
                            context: serde_json::Value::Object(serde_json::Map::new()),
                        },
                    );
                    black_box(kernel.render(0.0))
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

/// Parameterized: full-cycle FSM dispatch at varying binding counts.
///
/// Uses dispatch_fsm_event_str() which triggers recompute + clear (Phase E).
/// render() takes O(1) fast path. Measures total action→snapshot cost.
fn bench_full_cycle_fsm_scaling(c: &mut Criterion) {
    let mut group = c.benchmark_group("full_cycle_fsm_scaling");
    for n_fsm in [1, 3, 10] {
        group.bench_with_input(BenchmarkId::from_parameter(n_fsm), &n_fsm, |b, &n_fsm| {
            b.iter_batched(
                || init_kernel_with_fsm(make_tree_with_fsm_bindings(TREE_SIZE, n_fsm)),
                |mut kernel| {
                    kernel
                        .dispatch_fsm_event_str(FSM_ID, "toggle")
                        .expect("FSM dispatch must succeed");
                    black_box(kernel.render(0.0))
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

// ============================================================================
// TASK 168 IRPA: SCALE-INVARIANCE GATE BENCHMARKS (Agent 5)
//
// These benchmarks prove that the render pipeline is O(dirty), not O(tree).
// After Task 168 P1-P4 (Arc structural sharing, RuntimeGraph incremental
// derived state, typed flat indexes, flat side-map):
//
// - Single-node insert on a 50-node tree ≈ single-node insert on 1000-node tree
// - Clean no-op on a 50-node tree ≈ clean no-op on 1000-node tree
//
// Scaling within 3x between smallest and largest tree is the conformance gate.
// Any linear regression (20x growth from 50→1000 nodes) indicates an O(n)
// operation leaked back into the hot path.
// ============================================================================

/// IRPA Scale-Invariance Gate: Insert + render at varying tree sizes.
///
/// After Task 168 P1-P4:
/// - P1 (Arc): snapshot creation is O(1) Arc::clone, not O(n) deep clone
/// - P2 (RuntimeGraph): derived state (focus/tab/semantics) is O(dirty),
///   not O(n) tree walk, except on structure change (full rebuild)
/// - P3 (Side-Map): text_input is O(k) HashMap build, not O(n) tree reconstruction
/// - P4 (Typed Index): index building is O(n) flat, not O(n^2) JSON subtree
///
/// Insert IS a structure change, so RuntimeGraph does a full rebuild.
/// The key assertion: the full rebuild cost at 1000 nodes should NOT be 20x
/// the cost at 50 nodes. Arc sharing, typed indexes, and side-map make
/// even the full-rebuild path significantly cheaper than pre-168.
fn bench_scale_invariance_insert(c: &mut Criterion) {
    let mut group = c.benchmark_group("scale_invariance_insert");
    for size in [50, 100, 200, 500, 1000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || init_kernel_with_render(make_plain_tree(size)),
                |mut kernel| {
                    kernel
                        .apply_patches(vec![ScenePatch::InsertNode {
                            parent_id: "root".to_string(),
                            index: 0,
                            node: make_new_leaf_node("scale-gate-insert"),
                        }])
                        .expect("InsertNode must succeed");
                    black_box(kernel.render(0.0))
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

/// IRPA No-Op Scaling Gate: Clean render at varying tree sizes.
///
/// Measures the cost of render() when NOTHING is dirty (is_clean() = true).
///
/// After Task 168:
/// - P1 (Arc): `create_snapshot()` uses `Arc::clone()` for tree and frames — O(1)
/// - P2 (RuntimeGraph): derived state reads are O(1) clones of cached collections
/// - P3 (Side-Map): `build_text_input_side_map()` is O(k) with k=0 — O(1)
///
/// The clean-frame path should be near-constant time regardless of tree size:
/// no tree walks, no clones, no serialization. Just Arc pointer copies and
/// HashMap::new() for 0 text inputs.
///
/// Pre-168: ~417us on 100 nodes (linear scaling from O(n) tree walks in
/// create_snapshot). Post-168 target: bounded, near-constant regardless of size.
fn bench_noop_scaling(c: &mut Criterion) {
    let mut group = c.benchmark_group("noop_scaling");
    for size in [50, 100, 200, 500, 1000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || init_kernel_with_render(make_plain_tree(size)),
                |mut kernel| black_box(kernel.render(0.0)),
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

/// IRPA Property Change Scaling Gate: Single property change at varying sizes.
///
/// Unlike insert (which triggers structure_changed → RuntimeGraph full rebuild),
/// a property change only affects the single dirty node. RuntimeGraph performs
/// an O(dirty) incremental update. This is the purest test of O(dirty) behavior:
///
/// - Compute: only 1 node re-evaluated
/// - Layout: incremental (only 1 dirty node)
/// - RuntimeGraph: incremental update (O(1) check per dirty node)
/// - Snapshot: O(1) Arc clones
///
/// Frame time should be bounded constant regardless of total tree size.
fn bench_scale_invariance_property(c: &mut Criterion) {
    let mut group = c.benchmark_group("scale_invariance_property");
    for size in [50, 100, 200, 500, 1000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    let root = make_plain_tree(size);
                    let target_idx = size / 2; // middle node
                    let mut kernel = Kernel::new(root.clone(), VIEWPORT);
                    kernel.render(0.0);

                    let mut updated = root.children[target_idx].as_ref().clone();
                    updated.props.text = Some("Updated content".to_string());
                    (kernel, updated)
                },
                |(mut kernel, updated_node)| {
                    kernel
                        .update_scene_node(updated_node)
                        .expect("update_scene_node must succeed");
                    black_box(kernel.render(0.0))
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

// ============================================================================
// TASK 169 P5: DELTA PUBLICATION BOUNDARY BENCHMARKS (Agent 3)
//
// These benchmarks prove that the WASM boundary cost for delta publication
// is O(dirty), not O(tree). The delta system (render_with_delta) produces
// SnapshotPublication::Delta containing only changed data, which serializes
// much faster than a Full snapshot.
//
// Key measurements:
// - render_with_delta() overhead vs render() (should be negligible)
// - Delta serialization vs Full serialization (delta should be 10-100x faster)
// - Delta serialization time at varying tree sizes (should be ~constant)
//
// Note on frame_patches: In flat flex containers, a single property change
// can cascade layout to all siblings, producing O(n) frame_patches. This is
// correct physics — the O(dirty) claim applies to the tree diff algorithm
// (node_patches, structure_patches), while frame_patches reflect actual
// layout reflow. The benchmark captures total delta serialization cost
// including frame cascade, which is the realistic WASM boundary cost.
// ============================================================================

/// Delta Boundary: render_with_delta() vs render() overhead.
///
/// Measures the marginal cost of delta computation on top of a regular render.
/// render_with_delta() calls render() internally plus:
/// - Captures RuntimeDelta before render
/// - Stores previous snapshot
/// - Computes delta via Arc::ptr_eq tree walk
///
/// Expected: render_with_delta() ≈ render() + small constant overhead.
/// The delta computation is O(dirty_path) via Arc::ptr_eq, so it should
/// not meaningfully increase total render time.
fn bench_delta_overhead_property_change(c: &mut Criterion) {
    let mut group = c.benchmark_group("delta_overhead");

    // render() baseline.
    group.bench_function("render_property_change", |b| {
        b.iter_batched(
            || {
                let root = make_plain_tree(TREE_SIZE);
                let mut kernel = Kernel::new(root.clone(), VIEWPORT);
                kernel.render(0.0);
                let mut updated = root.children[50].as_ref().clone();
                updated.props.text = Some("Delta overhead test".to_string());
                (kernel, updated)
            },
            |(mut kernel, updated)| {
                kernel.update_scene_node(updated).expect("update");
                black_box(kernel.render(0.0))
            },
            BatchSize::SmallInput,
        );
    });

    // render_with_delta() — includes delta computation.
    group.bench_function("render_with_delta_property_change", |b| {
        b.iter_batched(
            || {
                let root = make_plain_tree(TREE_SIZE);
                let mut kernel = Kernel::new(root.clone(), VIEWPORT);
                kernel.render_with_delta(0.0); // Establish baseline (Full).
                let mut updated = root.children[50].as_ref().clone();
                updated.props.text = Some("Delta overhead test".to_string());
                (kernel, updated)
            },
            |(mut kernel, updated)| {
                kernel.update_scene_node(updated).expect("update");
                black_box(kernel.render_with_delta(16.0))
            },
            BatchSize::SmallInput,
        );
    });

    group.finish();
}

/// Delta Boundary: serde serialization of Delta vs Full at 100 nodes.
///
/// Compares the JSON serialization cost of:
/// - Full snapshot (SnapshotPublication::Full) — serializes entire tree
/// - Delta (SnapshotPublication::Delta) — serializes only changed data
///
/// For a single property change, the delta should serialize much faster
/// than the full snapshot. The speedup grows with tree size (O(dirty) vs O(n)).
fn bench_delta_serialization_vs_full(c: &mut Criterion) {
    use composition_engine::snapshot_delta::SnapshotPublication;

    let mut group = c.benchmark_group("delta_serialization");

    // Full snapshot serialization.
    group.bench_function("full_100_node", |b| {
        b.iter_batched(
            || {
                let root = make_plain_tree(TREE_SIZE);
                let mut kernel = Kernel::new(root, VIEWPORT);
                let publication = kernel.render_with_delta(0.0);
                match publication {
                    SnapshotPublication::Full(snap) => snap,
                    _ => panic!("first render must be Full"),
                }
            },
            |snap| black_box(serde_json::to_string(&snap).expect("serialize full")),
            BatchSize::SmallInput,
        );
    });

    // Delta serialization (1 property change).
    group.bench_function("delta_1_property_100_node", |b| {
        b.iter_batched(
            || {
                let root = make_plain_tree(TREE_SIZE);
                let mut kernel = Kernel::new(root.clone(), VIEWPORT);
                kernel.render_with_delta(0.0); // Full baseline.
                let mut updated = root.children[50].as_ref().clone();
                updated.props.text = Some("Serialization test".to_string());
                kernel.update_scene_node(updated).expect("update");
                let pub1 = kernel.render_with_delta(16.0);
                match pub1 {
                    SnapshotPublication::Delta(delta) => delta,
                    _ => panic!("expected Delta after property change"),
                }
            },
            |delta| black_box(serde_json::to_string(&delta).expect("serialize delta")),
            BatchSize::SmallInput,
        );
    });

    group.finish();
}

/// Delta Boundary Scaling: render_with_delta() + delta serialization at
/// varying tree sizes (50/100/200/500/1000 nodes).
///
/// For a fixed dirty count (1 property change), the TOTAL pipeline cost
/// (render + delta computation + serialization) should scale sub-linearly
/// with tree size. The tree diff portion is O(dirty_path) via Arc::ptr_eq;
/// the frame diff portion scales with layout reflow scope.
///
/// This is the definitive boundary scaling benchmark: it measures the
/// complete cost a WASM host pays per frame for a single mutation.
fn bench_delta_boundary_scaling(c: &mut Criterion) {
    use composition_engine::snapshot_delta::SnapshotPublication;

    let mut group = c.benchmark_group("delta_boundary_scaling");
    group.sample_size(20);

    for size in [50, 100, 200, 500, 1000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    let root = make_plain_tree(size);
                    let mut kernel = Kernel::new(root.clone(), VIEWPORT);
                    kernel.render_with_delta(0.0); // Full baseline.
                    let target_idx = size / 2;
                    let mut updated = root.children[target_idx].as_ref().clone();
                    updated.props.text = Some("Boundary scaling".to_string());
                    (kernel, updated)
                },
                |(mut kernel, updated)| {
                    kernel.update_scene_node(updated).expect("update");
                    let publication = kernel.render_with_delta(16.0);
                    // Serialize the publication (this is the WASM boundary cost).
                    match &publication {
                        SnapshotPublication::Delta(delta) => {
                            black_box(serde_json::to_string(delta).expect("serialize delta"));
                        }
                        SnapshotPublication::Full(snap) => {
                            black_box(serde_json::to_string(snap).expect("serialize full"));
                        }
                        SnapshotPublication::Noop => {}
                    }
                    black_box(publication)
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

/// Delta Noop Boundary: render_with_delta() on clean frame at varying sizes.
///
/// When nothing is dirty, render_with_delta() returns Noop — zero
/// serialization. This measures the clean-frame overhead compared to
/// render(). Should be near-zero additional cost.
fn bench_delta_noop_scaling(c: &mut Criterion) {
    let mut group = c.benchmark_group("delta_noop_scaling");
    group.sample_size(20);

    for size in [50, 100, 200, 500, 1000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &size| {
            b.iter_batched(
                || {
                    let root = make_plain_tree(size);
                    let mut kernel = Kernel::new(root, VIEWPORT);
                    kernel.render_with_delta(0.0); // Full baseline.
                    kernel
                },
                |mut kernel| {
                    // Clean frame → should return Noop.
                    black_box(kernel.render_with_delta(16.0))
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

// ============================================================================
// Perf Gate Documentation
// ============================================================================

fn print_perf_gates(c: &mut Criterion) {
    c.bench_function("_perf_gate_documentation", |b| {
        b.iter(|| black_box(()));
    });

    eprintln!();
    eprintln!("╔══════════════════════════════════════════════════════════════════╗");
    eprintln!("║      COMPOSITION ENGINE PERF GATES (Task 167 + Task 168)       ║");
    eprintln!("╠══════════════════════════════════════════════════════════════════╣");
    eprintln!("║ Gate                                │ Target   │ Measurement   ║");
    eprintln!("╠─────────────────────────────────────┼──────────┼───────────────╣");
    eprintln!("║ recompute_p95                       │ <= 1ms   │ render() time ║");
    eprintln!("║ time_to_snapshot_state_update_p95   │ <= 1ms   │ full cycle    ║");
    eprintln!("║ commit_settle_p95                   │ <= 50ms  │ async DB      ║");
    eprintln!("║ conformance_byte_identical           │ 100%     │ writeset hash ║");
    eprintln!("║ render_noop_baseline                │ <= 0.5ms │ snapshot only ║");
    eprintln!("╠─────────────────────────────────────┼──────────┼───────────────╣");
    eprintln!("║ IRPA GATES (Task 168 P1-P4)                                   ║");
    eprintln!("╠─────────────────────────────────────┼──────────┼───────────────╣");
    eprintln!("║ scale_invariance_insert 50vs1000    │ <= 3x    │ bounded delta ║");
    eprintln!("║ noop_scaling 50vs1000               │ <= 2x    │ near-constant ║");
    eprintln!("║ scale_invariance_property 50vs1000  │ <= 2x    │ O(dirty) gate ║");
    eprintln!("╚══════════════════════════════════════════════════════════════════╝");
    eprintln!();
}

// ============================================================================
// Criterion Configuration
// ============================================================================

criterion_group! {
    name = render_only_benchmarks;
    config = Criterion::default()
        .sample_size(50)
        .measurement_time(Duration::from_secs(3))
        .warm_up_time(Duration::from_secs(1));
    targets =
        bench_render_only_fsm,
        bench_render_only_insert,
        bench_render_only_property_change,
        bench_render_only_ambient,
        bench_render_only_deep_subtree,
}

criterion_group! {
    name = full_cycle_benchmarks;
    config = Criterion::default()
        .sample_size(50)
        .measurement_time(Duration::from_secs(3))
        .warm_up_time(Duration::from_secs(1));
    targets =
        bench_full_cycle_fsm_dispatch,
        bench_full_cycle_routing_change,
}

criterion_group! {
    name = baseline_benchmarks;
    config = Criterion::default()
        .sample_size(50)
        .measurement_time(Duration::from_secs(3));
    targets =
        bench_render_noop_clean,
        bench_initial_render_cold,
}

criterion_group! {
    name = scaling_benchmarks;
    config = Criterion::default()
        .sample_size(30)
        .measurement_time(Duration::from_secs(2));
    targets =
        bench_insert_scaling,
        bench_render_only_fsm_scaling,
        bench_full_cycle_fsm_scaling,
}

criterion_group! {
    name = irpa_gate_benchmarks;
    config = Criterion::default()
        .sample_size(20)
        .measurement_time(Duration::from_secs(2))
        .warm_up_time(Duration::from_secs(1));
    targets =
        bench_scale_invariance_insert,
        bench_noop_scaling,
        bench_scale_invariance_property,
}

criterion_group! {
    name = delta_boundary_benchmarks;
    config = Criterion::default()
        .sample_size(20)
        .measurement_time(Duration::from_secs(2))
        .warm_up_time(Duration::from_secs(1));
    targets =
        bench_delta_overhead_property_change,
        bench_delta_serialization_vs_full,
        bench_delta_boundary_scaling,
        bench_delta_noop_scaling,
}

criterion_group! {
    name = perf_gates;
    config = Criterion::default().sample_size(10);
    targets = print_perf_gates,
}

criterion_main!(
    perf_gates,
    render_only_benchmarks,
    full_cycle_benchmarks,
    baseline_benchmarks,
    scaling_benchmarks,
    irpa_gate_benchmarks,
    delta_boundary_benchmarks
);
