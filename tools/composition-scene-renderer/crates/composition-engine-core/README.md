# Composition Engine Core

`composition-engine-core` is the reusable pure implementation library behind the `composition-engine` slot. It is not a slot and does not own SharedBufferProtocol, WIT, browser assets, or slot manifest behavior.

## Files

| Path | Purpose |
|---|---|
| `src/binding/` | Re-exports the one binding evaluator, validator and operators from composition-ast; adds `scene_index_from_typed`. |
| `src/blueprint/` | Blueprint validation, normalization, and scene resolution. |
| `src/bridge/` | Data and journal bridge traits/adapters. |
| `src/host.rs` | Host adapter traits used by pure composition code. |
| `src/kernel/` | Scene/layout/input/focus/fsm/ambient/compute/anchoring/text/timeline/mapping/snapshot kernel work. |

## Key Types / Functions

| Item | Signature / Shape | Role |
|---|---|---|
| `kernel::Kernel` | `Kernel::new(root: SceneNode, viewport: Size)`, `apply_patches`, `update_scene`, `set_viewport`, `render(dt) -> SceneSnapshot` | The scene kernel one composition session owns. |
| `kernel::types` | `SceneNode`, `NodeKind`, `Size`, `Camera`, `EdgeConnection`, `EdgeMutation` | Scene vocabulary. |
| `kernel::scene_diff_types::ScenePatch` | tagged `{type:'INSERT_NODE' | ...}` | Incremental scene changes. |

## Dependencies

**Depends on:** `composition-ast`, `ops-core`, `state-graph`, `graph`, `serde`, `serde_json`, `thiserror`, `lazy_static`, `chrono`, `web-time`, `rust_decimal`, `uuid`, `regex`, `urlencoding`.

**Depended on by:** `composition-engine`.

## Invariants

- No slot boundary code lives here.
- No browser thing-to-put-on-screen assets live here.
- Public API compatibility is exposed through `composition-engine` re-exports; the implementation lives here.
- This crate may depend on leaf crates such as `composition-ast`, `ops-core`, `state-graph` and `graph`.

## In Trillion

Ported from `bitfield-packages/crates/composition-engine-core`. Dependencies the source never used (`bitfield-crypto`, `slot-protocol`, `md5`, `sha3`, `hex`, `hmac`, `base64`, `chrono-tz`, `unicode-segmentation`) are dropped, and the four kernel tests that needed `interaction-engine` (`compile_triggers`), which Trillion does not have, are removed. The perf-budget tests (`perf_conformance_tests`, `layout::tests::incremental_performance_1000_nodes_1_dirty`) hold their budgets in a release build (`cargo test --release`).
