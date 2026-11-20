# crates/formula-engine/

The formula engine as one crate: rule trees compiled into composition-ast bindings, the evaluation guards, the request checks, the classifier and the evaluator, for every host.

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Crate `formula-engine` (cdylib + rlib, and the `formula-engine` command); depends on `composition-ast` and `ops-core` |
| `src/lib.rs` | `ready` (check and prepare a binding), `filter_with`, `evaluate_with`, the kept compiled rules (`compiled`), `RowTable` |
| `src/rules.rs` | `Vocabulary`, `compile` (rule tree -> binding, reads, incomplete), `resolve_rule`, `fields_of_tree`, `tree_of_tests` |
| `src/guards.rs` | `Limits` (rules/evaluation-guards.json), `check_binding`, `check_work`, `Budget` (the clock budget between slices and the slow-formula pause) |
| `src/requests.rs` | `filter_records`, `compile_rules`, `holds`, `tests_hold`, `filter_rows`, `evaluate`, `evaluate_formula`, `list_comparisons` |
| `src/classify.rs` | `classify_record` |
| `src/host.rs` | wasm-bindgen exports (built only for `wasm32-unknown-unknown`) |
| `src/main.rs` | The WASI command: request name as its argument, the request on standard input |

## Invariants

- No operator, field or comparison name appears in the crate; meaning is `rules/rule-operators.json` + `ops-core`.
- A row matches only when the binding yields `true`; null, errors and other values do not match, and operator errors are counted.
- Entropy is never offered (`getrandom` 0.2 custom backend reports unsupported on `wasm32-unknown-unknown`).
- A compiled rule is kept (512 at most, oldest first), so callers that read their rules afresh do not compile again.
