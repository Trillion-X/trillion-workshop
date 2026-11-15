# tests/

Integration tests for the composition-engine crate — end-to-end verification of kernel render cycles, dirty tracking, incremental optimization, and IRPA conformance.

## Files

| File | Purpose |
|------|---------|
| `common/mod.rs` | Canonical shared test helpers — `VIEWPORT`, `make_flat_tree(n)`, `make_nested_tree()`, `make_new_leaf(id)`, `compare_snapshots(a, b)`. Imported via `mod common; use common::*;` (or selective `use common::{...};` when name conflicts exist) |
| `incremental_render_integration.rs` | 17 end-to-end tests proving incremental dirty-tracked render produces identical output to full render with measurably less work |
| `error_conformance.rs` | 14 compile-time CI gate tests verifying all SceneError (4 variants) and SceneDiffError (7 variants) use named-field syntax, plus Display, domain fields, serialization round-trips, and variant count guards |
| `irpa_oracle.rs` | 10 correctness oracle tests (Task 168) comparing incremental pipeline output against full-rebuild oracle for all mutation types: property change, insert, remove, FSM toggle, multiple mutations, text input, randomized 100-mutation sequences, Arc sharing, noop scaling, and RuntimeGraph performance. Uses `common::*` for shared helpers |
| `irpa_no_json_hot_path.rs` | 9 hot-path prohibition tests (Task 168) verifying TypedSceneIndex is used instead of JSON HashMap for index building — structural type guarantees that serde_json::to_value is not called in the render hot path. Uses `common::{make_flat_tree, VIEWPORT}` (selective import — has its own different `make_nested_tree` with simpler structure) |
| `snapshot_delta_oracle.rs` | 14 delta publication oracle tests (Task 169 P5) proving `base_snapshot + apply_all_deltas == fresh_kernel.render()` for property changes, structure changes (insert/remove), 10/50-mutation sequences, mixed mutations, resync via set_scene(), tree-diff O(dirty) size invariance across 100-1000 node trees, and render_with_delta() regression. Uses `common::*` for shared helpers |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `VIEWPORT` | `const Size { w: 1920.0, h: 1080.0 }` | (common) Standard 1080p viewport for all oracle/conformance tests |
| `make_flat_tree(n)` | `fn(usize) -> SceneNode` | (common) Build root with N flat Text children with IDs "node-0".."node-{n-1}" |
| `make_nested_tree()` | `fn() -> SceneNode` | (common) Build 3-level tree: root → [panel-a(leaf-a0, leaf-a1), panel-b(leaf-b0, leaf-b1), leaf-c] |
| `make_new_leaf(id)` | `fn(&str) -> SceneNode` | (common) Single Text node with text "Inserted: {id}" for insertion tests |
| `compare_snapshots(a, b)` | `fn(&SceneSnapshot, &SceneSnapshot) -> Vec<String>` | (common) Compare tree, frames, semantics, text_inputs, routing — returns list of differing fields |
| `make_deep_tree(depth)` | `fn(usize) -> SceneNode` | (incremental_render_integration) Build root → chain of depth nodes for subtree traversal tests |
| `make_wide_tree(width)` | `fn(usize) -> SceneNode` | (incremental_render_integration) Build root with width branches, each having width leaves (500+ nodes for perf tests) |
| `make_clean_kernel(root)` | `fn(SceneNode) -> Kernel` | (incremental_render_integration) Create kernel, run initial render, return in clean state |
| `make_toggle_fsm()` | `fn() -> FSMConfig` | (irpa_oracle) 2-state toggle FSM config: idle ↔ active on "toggle" event |
| `collect_node_ids(node)` | `fn(&SceneNode) -> Vec<String>` | (irpa_oracle) Depth-first collection of all node IDs in a tree |
| `make_nested_tree()` | `fn() -> SceneNode` | (irpa_no_json_hot_path) File-specific simpler nested tree: root → [panel(leaf-0, leaf-1), sibling]. Different from common::make_nested_tree |
| `count_nodes(node)` | `fn(&SceneNode) -> usize` | (irpa_no_json_hot_path) Recursively count all nodes in a tree |
| `apply_delta(base, delta)` | `fn(&SceneSnapshot, &SnapshotDelta) -> SceneSnapshot` | (snapshot_delta_oracle) Host-side delta application oracle — reconstructs snapshot from base + delta, handles structure/node/frame/semantics/text_input/routing patches. Routing is self-contained in the delta (`delta.routing: Option<RoutingState>`) — no side-channel fetch needed (Task 169 P5 Agent 4) |
| `extract_full(pub)` | `fn(&SnapshotPublication) -> &SceneSnapshot` | (snapshot_delta_oracle) Extract Full variant or panic — test helper |
| `extract_delta(pub)` | `fn(&SnapshotPublication) -> &SnapshotDelta` | (snapshot_delta_oracle) Extract Delta variant or panic — test helper |
| `apply_structure_and_node_patches(tree, sp, np)` | `fn(&Arc<SceneNode>, &[StructurePatch], &[NodePatch]) -> SceneNode` | (snapshot_delta_oracle) Apply structural changes then property patches to tree; insert patches unbox their `Box<SceneNode>` subtree only at this host-side oracle boundary |

## Dependencies

**Depends on:** `composition_engine::kernel::{Kernel, SceneNode, NodeKind, NodeProps, Size, SceneSnapshot, ScenePatch, FSMConfig, FSMState, FSMStateNode, FSMTransition, TextInputConfig}`, `composition_engine::kernel::snapshot_delta::{SnapshotPublication, SnapshotDelta, NodePatch, SemanticsPatch, StructurePatch, TextInputPatch}`, `composition_engine::kernel::typed_index::{TypedNodeEntry, TypedSceneIndex, TypedPreviousIndex}`, `composition_engine::kernel::compute::{build_scene_index, build_previous_node_index}`, `composition_engine::kernel::scene::SceneError`, `composition_engine::kernel::scene_diff_types::SceneDiffError`, `serde_json`, `std::time::Instant`, `std::sync::Arc`, `std::collections::HashMap`

**Depended on by:** CI pipeline — these tests gate the incremental render feature (Task 153), IRPA correctness (Task 168), and delta publication correctness (Task 169)
