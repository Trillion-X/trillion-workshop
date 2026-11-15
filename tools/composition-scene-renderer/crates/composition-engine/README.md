# Composition Engine Slot

`composition-engine` is the slot boundary for composition output. It receives subscribed scene deltas through the SharedBufferProtocol ABI, applies them through `composition-engine-core`, and replies with encoded `SceneSnapshot` bytes for the renderer (`tools/composition-scene-renderer/packages/composition-scene-renderer/show`).

In Trillion it is also built for the page (wasm32-unknown-unknown, wasm-bindgen) by `tools/build-engine-modules-for-web-hosts/build/build-compiled-modules.mjs` into that tool's `built-stored-bytes/composition-engine/` (`PAGE_COMPILED_MODULES` in its `build/compiled-modules.mjs`), where the documents screen calls `answer_composition(request_bytes) -> snapshot_json_bytes`.

## Files

| Path | Purpose |
|---|---|
| `src/lib.rs` | Slot wrapper root and public compatibility re-exports from `composition-engine-core`. |
| `src/slot_entry/` | SharedBufferProtocol entry, incoming-byte read, reply-byte write, and startup. Not built for wasm32-unknown-unknown (the page has no shared-buffer host). |
| `src/run_in_a_page.rs` | The page entry, built only for wasm32-unknown-unknown: `#[wasm_bindgen] answer_composition(request: &[u8]) -> Result<Vec<u8>, JsError>`; empty bytes when there is nothing to render, an error with the reason when the request cannot be read or applied. |
| `src/slot_work/` | Slot-local scene state, delta apply, scene decode, snapshot encoding, and `answer_request`, the one request decision both entries call. |

## Key Types / Functions

| Item | Signature / Shape | Role |
|---|---|---|
| `answer_composition` (page) | `(request: &[u8]) -> Result<Vec<u8>, JsError>` | JS export `answer_composition(Uint8Array) -> Uint8Array`; throws with the reason. |
| `init`, `handle_query` (slot ABI) | `extern "C" fn init()`, `extern "C" fn handle_query(input_len: i32) -> i32` | SharedBufferProtocol entry points (native and wasip builds). |
| `slot_work::answer_request::answer_request` | `(payload: &[u8]) -> Result<Option<Vec<u8>>, String>` | Composition transaction (`{type:'composition-transaction', session, set_scene, scene_patches, edge_mutations, layout_patches, camera, viewport, text_measurements, interactions}`) or `DeltaPayload` delta in, the changed session's `SceneSnapshot` JSON (`tree`, `frames`, `routing`, `semantics`, `text_inputs`, `camera`, `visible_edge_routes`) out. |

## Dependencies

**Depends on:** `composition-engine-core`, `slot-protocol` (`DeltaPayload`, fact addresses), `serde`, `serde_json`, `hex`; on wasm32-unknown-unknown also `wasm-bindgen`, `uuid`/`getrandom` (`js`/`wasm_js`) and `getrandom` 0.2 (`js`).

**Depended on by:** the Trillion page (`tools/build-engine-modules-for-web-hosts/built-stored-bytes/composition-engine/`), ported from `bitfield-packages/packages/composition-engine/source`.

## Invariants

- Reusable kernel/blueprint/binding/bridge/host implementation lives in `composition-engine-core`, not in this slot wrapper.
- This crate may keep public Rust re-exports for compatibility, but must not preserve old source buckets under `src/`.
- The slot wrapper owns only boundary mechanics and slot-specific state transition wiring.
- The slot ABI and the page entry never decide a request differently: both call `slot_work::answer_request`.
- Component scene nodes may be viewport-sized wrappers for owner material. The wrapper stays interaction-inert; mounted material opts into pointer handling inside its own DOM.

## Validation

After changing this crate or `composition-engine-core`, run `node tools/build-engine-modules-for-web-hosts/build/build-compiled-modules.mjs`; its fingerprint says when the committed modules are stale. No compiled module carries the path of the computer that built it (`build/shared-cargo-target.mjs`, `pathRemapFlags`).
