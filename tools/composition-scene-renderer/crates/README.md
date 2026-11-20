# crates/

The Cargo workspace of this tool: the composition engine the Write screen lays a page out with, ported whole from bitfield-packages (`packages/composition-engine/source`, `crates/composition-engine-core`, `crates/state-graph`; the core's unused hashing and time-zone dependencies dropped, and the four core tests that needed bitfield's `interaction-engine`). It decides the scene the renderer in `../packages/composition-scene-renderer/show` draws.

## Files

| Folder | Purpose |
|--------|---------|
| `composition-engine/` | The slot boundary: scene deltas in, `SceneSnapshot` bytes out. Built for `wasm32-wasip1` as a plain slot and for `wasm32-unknown-unknown` as a wasm-bindgen module whose one export `answer_composition(request_bytes) -> snapshot_bytes` (`src/run_in_a_page.rs`) makes the same decision as the slot's `handle_query` (`src/slot_work/answer_request.rs`). |
| `composition-engine-core/` | The pure kernel: blueprint, binding, bridge, layout, scene and snapshot. |
| `state-graph/` | The unified runtime state graph (finite-state machines and focus) the kernel uses. |

The module built from these goes to `tools/build-engine-modules-for-web-hosts/built-stored-bytes/composition-engine/`; the page runs it through `tools/workspace-screens/web/src/workspace/slot-in-the-page.ts`.

## Dependencies

**Depends on:** cargo, the engine's `composition-ast`, `ops-core`, `graph` and `slot-protocol` in `../trillion-rust/crates`.

**Depended on by:** `tools/build-engine-modules-for-web-hosts` (`PAGE_COMPILED_MODULES`).
