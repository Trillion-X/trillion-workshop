# tools/formula-engine/

Rules and formulas over rows, in one Rust engine every host calls directly. A person's rule tree (comparisons such as "is any of", "contains", "is more than", "is between", "is empty", joined in all-of and any-of groups that can be negated and nested) is compiled by the engine into one composition-ast binding and evaluated over rows; a formula (a binding, or the same formula written as text such as `=price * quantity` or `FILTER(items, |x| => x.age > 3)`, which the engine compiles into the binding it means) is evaluated over a value; a record gets the label of the first rule that holds. The comparisons are DATA (`rules/rule-operators.json`), so are the functions and operators a text formula may use (`rules/text-formulas.json`, each with an example the tests run), and the limits every evaluation is held to are DATA (`rules/evaluation-guards.json`): adding a comparison is one row, no code.

There is no JavaScript around the engine. Until Nov 19 2026 a JavaScript compiler (`rules/compile-rules.mjs`), five more `rules/*.mjs` wrappers and a second folder (`tools/formulas`) stood between callers and the Rust evaluator; they were deleted in the landing that moved compiling, the request checks, the guards and the classifier into the crate, and every caller now imports the built module and calls it.

There is no second formula system. Until Nov 20 2026 `tools/shared-code/crates/formula-core`, `formula-ast` and `trigger-ast` held another evaluator, its text grammar and a trigger matcher that nothing fed. What this engine lacked from them (the operators listed in `rules/text-formulas.json` and formulas written as text) was ported in and proven first; then the three crates were deleted, and the grammar moved to `src/grammar/`.

Logic has three states, and only a true answer keeps a row. A value that is unknown (missing, null) has no answer to a comparison that has to look at it, and NOT of unknown stays unknown, so such a row matches neither the comparison nor its negation. `is any of` / `is none of` and `is` / `is not` ask whether the value is in the list or equals the word, so an unknown value is kept by `is none of` and `is not`. A rule that is not finished (an unknown field or comparison, a comparison the field's kind does not offer, missing values) is left out and returned in `incomplete`, never guessed.

## Files

| File | Purpose |
|------|---------|
| `crates/formula-engine/` | The engine: `src/rules.rs` (rule tree to binding), `src/guards.rs` (the limits), `src/requests.rs` (each request and its refusals), `src/classify.rs` (first rule that holds), `src/grammar/` (the text formula grammar: lexer, parser and expression), `src/text.rs` (a text formula to a binding), `src/lib.rs` (evaluation), `src/host.rs` (the wasm-bindgen exports), `src/main.rs` (the WASI command) |
| `built-stored-bytes/formula-engine/` | `formula_engine.js` and `formula_engine_bg.wasm`: the crate for a JavaScript host (wasm-bindgen `web` target). Pages and Node tools import these and call the engine directly |
| `built-stored-bytes/component/formula-engine.wasm` | The crate's command built for wasm32-wasip2: the one component the engine runs for this folder's tool rows on any computer (trillion-rust `src/tool_runs/tools/component.rs`) |
| `rules/rule-operators.json` | Every comparison and group combinator as DATA |
| `rules/evaluation-guards.json` | The limits and their refusal words as DATA |
| `rules/text-formulas.json` | Every function and operator of a text formula: the op it runs, where each argument goes, and one example. A name the table does not hold is refused; the old positional REPLACE, DSUM, IS_NUMBER and the retired role functions are listed there as not carried, with why and where their job lives now |
| `what-this-tool-does-and-how-to-run-it.json`, `kits/` | `tool:filter-rows-by-rules`, `tool:evaluate-a-formula`, `tool:list-comparisons`, `tool:classify-a-record`, each running the component |
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
| `compileText` | `{text}` -> `{binding}`: the binding a text formula means. `filterRows`, `evaluate` and `evaluateFormula` take `text` in place of `binding` and compile it first. In it a name or `@.path` reads the row (as `from: context`, so it means the row at any depth), `F(...)` is a row of `rules/text-formulas.json`, `|x| => ...` is a lambda, and arithmetic answers numbers |
| `listComparisons` | `{field_kind?, operators?}` -> `{combinators, comparisons, field_kinds}` |
| `classifyRecord` | `{facts, rules, record, now_ms?}` -> `{result: {key, label, tone, severity} \| null}` |
| `replaceRows` / `patchRows` / `filterLoadedRows` | A loaded table for a host that owns the module alone (a page's measure engine) |

The component takes the same requests by name: `component <formula-engine.wasm> <request>`, the request on standard input, `{"result": ...}` or `{"error": ...}` as its last line.

## Dependencies

**Depends on:** `tools/shared-code/crates/composition-ast` and `ops-core` (every operator's meaning), built by `tools/build-engine-modules-for-web-hosts`.

**Depended on by:** every tool that filters or decides by rules (the workflow chooser `tools/workflows/read-data/choose-the-workflows-that-fire.mjs` among them), the workspace pages' record filters and computed columns, and its own tool rows.
