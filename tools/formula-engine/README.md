# tools/formula-engine/

Rules and formulas over rows, in one Rust engine every host calls directly. A person's rule tree (comparisons such as "is any of", "contains", "is more than", "is between", "is empty", joined in all-of and any-of groups that can be negated and nested) is compiled by the engine into one composition-ast binding and evaluated over rows; a formula (a binding) is evaluated over a value; a record gets the label of the first rule that holds. The comparisons are DATA (`rules/rule-operators.json`), and the limits every evaluation is held to are DATA (`rules/evaluation-guards.json`): adding a comparison is one row, no code.

There is no JavaScript around the engine. Until Nov 19 2026 a JavaScript compiler (`rules/compile-rules.mjs`), five more `rules/*.mjs` wrappers and a second folder (`tools/formulas`) stood between callers and the Rust evaluator; they were deleted in the landing that moved compiling, the request checks, the guards and the classifier into the crate, and every caller now imports the built module and calls it.

Logic has three states, and only a true answer keeps a row. A value that is unknown (missing, null) has no answer to a comparison that has to look at it, and NOT of unknown stays unknown, so such a row matches neither the comparison nor its negation. `is any of` / `is none of` and `is` / `is not` ask whether the value is in the list or equals the word, so an unknown value is kept by `is none of` and `is not`. A rule that is not finished (an unknown field or comparison, a comparison the field's kind does not offer, missing values) is left out and returned in `incomplete`, never guessed.

## Files

| File | Purpose |
|------|---------|
| `crates/formula-engine/` | The engine: `src/rules.rs` (rule tree to binding), `src/guards.rs` (the limits), `src/requests.rs` (each request and its refusals), `src/classify.rs` (first rule that holds), `src/lib.rs` (evaluation), `src/host.rs` (the wasm-bindgen exports), `src/main.rs` (the WASI command) |
| `built-stored-bytes/formula-engine/` | `formula_engine.js` and `formula_engine_bg.wasm`: the crate for a JavaScript host (wasm-bindgen `web` target). Pages and Node tools import these and call the engine directly |
| `built-stored-bytes/component/formula-engine.wasm` | The crate's command built for wasm32-wasip2: the one component the engine runs for this folder's tool rows on any computer (trillion-rust `src/tool_runs/tools/component.rs`) |
| `rules/rule-operators.json` | Every comparison and group combinator as DATA |
| `rules/evaluation-guards.json` | The limits and their refusal words as DATA |
| `tool-rows.json`, `kits/` | `tool:filter-rows-by-rules`, `tool:evaluate-a-formula`, `tool:list-comparisons`, `tool:classify-a-record`, each running the component |
| `test/*.test.mjs` | Three-state logic, comparisons, errors and path safety (binding), rule trees (rules), the classifier (classify), the guards, the shipped module and the stored-formula contracts, and every row's sample run through the component (rows) |
| `part.json` | The files other code may import |

Rebuild both built forms with `node tools/build-engine-modules-for-web-hosts/build/build-formula-evaluator.mjs` (then commit the three files); `cargo test -p formula-engine` in `crates/` runs the crate's own tests.

## Key Types / Functions

Load once (`initSync({ module: <the bytes of formula_engine_bg.wasm> })` in Node, `await init({ module_or_path })` in a page), then call. Each takes one object; a refusal is thrown as an Error with the engine's words, a guard's refusal with `code: 'formula_guard'`, `guard` and `limit`.

| Export | Request -> answer |
|--------|-------------------|
| `filterRecords` | `{records, fields: [{id, kind, path?}], tree?, operators?}` -> `{total, matches, kept, records, reads, incomplete, error_rows, first_error}` |
| `compileRules` | `{tree, fields, operators?}` -> `{binding \| null, reads, incomplete}` |
| `holds` | `{tree, facts, operators?}` -> whether the tree holds over one set of facts (an unfinished rule is refused) |
| `testsHold` | `{tests, row, present?}` -> whether the data files' short spelling `{path, equals \| one_of \| starts_with \| present, not}` holds over a row |
| `filterRows` | `{rows, binding}` -> `{matches, error_rows, first_error}` |
| `evaluate` / `evaluateFormula` | `{binding, input}` -> `{value}`; `{binding, rows}` -> `{values, errors}` |
| `listComparisons` | `{field_kind?, operators?}` -> `{combinators, comparisons, field_kinds}` |
| `classifyRecord` | `{facts, rules, record, now_ms?}` -> `{result: {key, label, tone, severity} \| null}` |
| `replaceRows` / `patchRows` / `filterLoadedRows` | A loaded table for a host that owns the module alone (a page's measure engine) |

The component takes the same requests by name: `component <formula-engine.wasm> <request>`, the request on standard input, `{"result": ...}` or `{"error": ...}` as its last line.

## Dependencies

**Depends on:** `tools/shared-code/crates/composition-ast` and `ops-core` (every operator's meaning), built by `tools/build-engine-modules-for-web-hosts`.

**Depended on by:** every tool that filters or decides by rules (the workflow chooser `tools/workflows/read-data/choose-the-workflows-that-fire.mjs` among them), the workspace pages' record filters and computed columns, and its own tool rows.
