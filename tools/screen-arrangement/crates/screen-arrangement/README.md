# crates/screen-arrangement/

The screen arrangement's layout math: given a layout and a command (split, move a tab, close, focus, float), the next layout and what changed, as JSON bytes in and out. Compiled for the page by `scripts/build-workspace.mjs` and served as `/workspace/screen-arrangement.wasm`.

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Crate manifest; `wasm-bindgen`, `getrandom` (`wasm_js`) and `uuid` (`js`) only for the web target. |
| `src/lib.rs` | Crate root: `arrange` and, for the web target, `run_in_a_page`. |
| `src/run_in_a_page.rs` | `arrange_screen(request: &[u8]) -> Result<Vec<u8>, JsError>`, the one export the page calls. |
| `src/arrange/` | The arrangement itself (split, freeform, overlay, focus, delta publication, types); see its README. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `arrange_screen` | `(&[u8]) -> Result<Vec<u8>, JsError>` | JSON `ScreenArrangementRequest` in, JSON reply out (wasm-bindgen). |
| `arrange::arrange_screen_bytes` | `(&[u8]) -> Result<Vec<u8>, String>` | The same, for native callers and tests. |

## Dependencies

**Depends on:** `serde`, `serde_json`, `uuid`; for the page, `wasm-bindgen` and `getrandom`.

**Depended on by:** `scripts/build-workspace.mjs`, `src/workspace/targets.ts` (targets `slot::screen-arrangement` and `screen-arrangement`).
