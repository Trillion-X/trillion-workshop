# parts/formula-engine/

Rules over records: the operators a filter offers and the compiled evaluator that decides which rows match, used by the workspace's record views (Files, Decisions).

## Files

| File | Purpose |
|------|---------|
| `part.json` | The files other code may import. |
| `rules/rule-operators.json` | The operators each field kind offers (DATA). |
| `rules/filter-records.mjs` | `createRecordFilter(wasmBytes)`: filters rows by rules with the compiled evaluator. |
| `built-stored-bytes/evaluate-over-rows/` | The compiled evaluator (`evaluate-over-rows_bg.wasm`) and its glue, built from `../trillion-rust/crates/evaluate-over-rows` by `scripts/build-formula-evaluator.mjs`. |
| `rules/compile-rules.mjs` | Compiles a rule tree into one composition-ast binding and the fields it reads. |
| `rules/filter-rows-by-rules.mjs` | `makeRowFilter({operators, wasm})` → `filterRowsByRules({tree, fields, rows})`: the Workshop tool `tool:filter-rows-by-rules`. A rule (tree and fields, by value) is compiled once and each row's answer under it is kept, since a compiled rule reads only the row and its own literals. |
| `rules/evaluate-over-rows.mjs` | `loadRowEvaluator(wasm bytes)`: the evaluator's JSON interface; public, so the page evaluates a list's computed columns with it (`src/workspace/list-targets.ts`). Every call passes the evaluation guards first. |
| `rules/evaluation-guards.mjs` / `.json` | The limits every evaluation is held to (depth, parts, a binding containing itself, pattern size, work = rows x weight, wall time per row slice), as DATA; a formula past one is refused with `code: 'formula_guard'` and its own words. Stopping one evaluation part way through needs fuel metering inside the wasm (a rebuild of `../trillion-rust/crates/evaluate-over-rows`); everything decidable before and between evaluator calls is decided here. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `createRecordFilter` | `(wasm bytes) => Promise<filterRecords>` | The record views' filter. |

## Dependencies

**Depends on:** nothing outside the part at run time; its evaluator is built from `../trillion-rust/crates/evaluate-over-rows`.

**Depended on by:** `src/workspace/record-filter.ts`, `src/workspace/list-targets.ts` (computed columns), `src/workspace/files-screen.tsx`, `src/workspace/decisions-screen.tsx`, `scripts/build-workspace.mjs` (copies the evaluator), `test/formula-rules.test.mjs`, `src/engine-tools.mjs` (filter-rows-by-rules), `src/space-permissions.mjs` (compile-rules, to check a space's rules are finished), `scripts/compiled-modules.mjs` (the Worker copy of the evaluator).
