# built-stored-bytes/

Built output of the formula engine that other hosts load directly, rebuilt from Trillion's own source by `scripts/build-formula-evaluator.mjs`. Regenerate; never edit.

## Files

| File | Purpose |
|------|---------|
| `evaluate-over-rows/evaluate-over-rows_bg.wasm` | `formula-engine-evaluate-over-rows` (`../trillion-rust/crates/evaluate-over-rows`) compiled for `wasm32-unknown-unknown` |
| `evaluate-over-rows/evaluate-over-rows.js` | wasm-bindgen `web` loader; `initSync({module: bytes})` works in browsers and Node |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `replace_rows` / `patch_rows` / `filter_rows` / `evaluate` | JSON text in, JSON text out | See `../trillion-rust/crates/evaluate-over-rows/README.md` |

## Dependencies

**Depends on:** `scripts/build-formula-evaluator.mjs` (the only writer), over `../trillion-rust/crates/evaluate-over-rows`, `../trillion-rust/crates/composition-ast` and `../trillion-rust/crates/ops-core`.

**Depended on by:** `../rules/evaluate-over-rows.mjs`, `scripts/build-workspace.mjs` (serves the wasm to the page), `test/formula-rules.test.mjs`.
