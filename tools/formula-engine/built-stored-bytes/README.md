# built-stored-bytes/

The formula engine built from `../crates/formula-engine` by `tools/build-engine-modules-for-web-hosts/build/build-formula-evaluator.mjs` (the only writer). Regenerate; never edit.

## Files

| File | Purpose |
|------|---------|
| `formula-engine/formula_engine_bg.wasm` | The crate's library compiled for `wasm32-unknown-unknown` |
| `formula-engine/formula_engine.js` | wasm-bindgen `web` glue: `initSync({ module: bytes })` in Node and Workers, `init({ module_or_path })` in a page; then each export is a direct call into the engine |
| `component/formula-engine.wasm` | The crate's command compiled for `wasm32-wasip2`: one component every computer's engine compiles for itself and runs for this folder's tool rows |

## Dependencies

**Depends on:** `../crates/formula-engine` over `tools/shared-code/crates/composition-ast` and `ops-core`.

**Depended on by:** every caller of the formula engine (they import `formula-engine/formula_engine.js`), `tools/build-engine-modules-for-web-hosts/build/compiled-modules.mjs` (copies `formula-engine/` for the app's release), `../tool-rows.json` (runs `component/formula-engine.wasm`).
