# src/

Pure trigger AST helpers and precompiled trigger evaluation support.

## Files

| File | Purpose |
|------|---------|
| `lib.rs` | Crate exports for trigger dependency analysis and precompiled trigger helpers |
| `precompiled.rs` | `PreCompiledTrigger`, named construction input, dependency analysis, and no-reparse trigger evaluation |
| `trigger_deps.rs` | Static event-category dependency profile for selective dispatch |

## Boundary

This crate stores parsed trigger formula artifacts and dependency metadata. Construction uses `PreCompiledTriggerInput` so adding fields does not create positional argument bugs.
