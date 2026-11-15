# crates/evaluate-over-rows/

The formula engine's binding evaluator compiled for a JavaScript host: it holds a table of JSON rows and returns the indices a composition-ast binding is true for.

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Crate `formula-engine-evaluate-over-rows` (cdylib + rlib); depends only on `composition-ast` and `ops-core` |
| `src/lib.rs` | `RowTable` (replace, patch, filter), `evaluate_request`, and the wasm-bindgen boundary (`replace_rows`, `patch_rows`, `filter_rows`, `evaluate`) |

Built by `scripts/build-formula-evaluator.mjs` (wasm32-unknown-unknown, wasm-bindgen `web` target, no TypeScript) into `parts/formula-engine/built-stored-bytes/evaluate-over-rows/`; the CLI must match the wasm-bindgen version `crates/Cargo.lock` pins. Ported from bitfield-packages `packages/formula-engine/evaluate-over-rows`; answers for 2,000 random rule trees over 300 rows are identical to the evaluator Bitfield built.

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `RowTable` | `replace(Vec<Value>)`, `patch(RowPatch)`, `filter(FilterRequest) -> Result<FilterOutcome, String>` | Rows held as `OpValue`; a binding is prepared once per filter |
| `FilterRequest` | `{ binding: Value }` | The binding to hold for |
| `FilterOutcome` | `{ matches: Vec<u32>, error_rows: u32, first_error: Option<String> }` | Matching row indices and the first evaluation error |
| `RowPatch` / `RowAt` | `{ length, set: [{ index, row }] }` | Delta: resize and replace single rows |
| `evaluate_request` | `(EvaluateRequest { binding, input }) -> Result<Value, String>` | One evaluation |
| wasm exports | `replace_rows(json)`, `patch_rows(json)`, `filter_rows(json)`, `evaluate(json)` -> JSON text, throw on error | Host boundary |

## Invariants

- A row matches only when the binding yields `true`; null (an unknown value), errors and other values do not match. NOT of unknown stays unknown (ops-core tristate logic).
- No operator or field name appears in this crate; operator meaning is `composition-ast` + `ops-core`, identical to the formula-engine slot.
- Entropy is never offered (`getrandom` 0.2 custom backend reports unsupported); binding evaluation never draws randomness.

## Performance

Measured on 23,000 rows (half carrying ~4.5 KB of text): a single comparison 13 ms native / ~40 ms wasm; transcript contains 18 ms / ~80 ms; a three-rule nested group ~140 ms wasm. Loading the table once costs ~2 s in wasm for ~50 MB of JSON, so a host loads once and sends row patches.

## Dependencies

**Depends on:** `composition-ast` (`PreparedBinding`, core operator registry), `ops-core` (`OpValue`), `serde`, `serde_json`, `wasm-bindgen` (wasm only), `getrandom` 0.2 `custom` (wasm only).

**Depended on by:** `scripts/build-formula-evaluator.mjs`, and through the built module `parts/formula-engine/rules/evaluate-over-rows.mjs` (the Files and Decisions record views) and `test/formula-rules.test.mjs`.
