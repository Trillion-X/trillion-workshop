# crates/compile-rules/

A person's rule tree compiled to one composition-ast binding, in Rust: `rules/compile-rules.mjs` for a host where no JavaScript runs. The meaning of every comparison stays in `rules/rule-operators.json`; this crate fills its templates and nests groups.

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Crate `formula-engine-compile-rules`; depends only on `serde_json` |
| `src/lib.rs` | `Vocabulary` (`shipped()`: rules/rule-operators.json), `Field {id, kind, path}`, `compile_rules(tree, fields, vocabulary) -> Compiled {binding, reads, incomplete}` |
| `tests/parity.rs` | Every operator on every field kind it applies to, finished and unfinished, alone and in nested, negated and/or groups, compiled here and by `compile-rules.mjs` in node: the same binding, reads and unfinished rules |

## Invariants

- A rule that is not finished is reported in `incomplete`, never guessed; an empty tree compiles to no binding (every row).
- No field, operator or combinator id is named in code.
- The bindings are those of `compile-rules.mjs`, held by `tests/parity.rs`; evaluate them with `crates/evaluate-over-rows`.

## Dependencies

**Depends on:** `serde_json`, and `rules/rule-operators.json` read at build time.

**Depended on by:** `tools/files-on-every-device/core` (ignore rules).
