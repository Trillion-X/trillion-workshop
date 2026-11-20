# operators/

Re-exports the binding operators from composition-ast, where they live (L088). Nothing here adds an operator.

## Files

| File | Purpose |
|------|---------|
| `mod.rs` | Re-exports `composition_ast::binding::operators::{core, registry}` and their registry types under `composition_engine_core::binding::operators`. |

## Boundary

Operators are platform-agnostic. They do not own product state, package state, or EEAF row vocabulary.
