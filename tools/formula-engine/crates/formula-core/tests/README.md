# tests/

Integration tests for formula-core behavior that must hold through the public API.

## Files

| File | Purpose |
|------|---------|
| `reactive_integration.rs` | End-to-end reactive recomputation tests using `ChangeSet`, `DependencyChange`, `DependencyKey`, and `FormulaRegistry` |
| `deps_tests.rs` | Dependency graph and cycle-detection integration coverage |
| `graph_tests.rs` | Graph rewrite-rule integration coverage through caller-owned solver context seams |

## Boundary

Reactive tests pass already-normalized `DependencyKey` values into formula-core. Formula-core never translates caller records, graph records, package records, or any caller-specific event into dependency keys.
