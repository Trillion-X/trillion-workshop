# operators/

Pure binding operator adapters used by composition-engine-core.

## Files

| File | Purpose |
|------|---------|
| `formula_adapter.rs` | Formula adapter traits and helpers. The formula engine boundary is explicit: direct evaluation and compiled evaluation must produce identical results for the same formula and environment. |

## Boundary

Operators here are platform-agnostic. They do not own product state, package state, or EEAF row vocabulary.
