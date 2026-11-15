# src/

Platform-agnostic composition engine core.

## Files

| File | Purpose |
|------|---------|
| `lib.rs` | Public module surface for composition-engine-core. |
| `host.rs` | Trait definitions for platform adapters plus `RootElement`, an opaque pointer wrapper used only at platform boundaries. |
| `bridge/` | Data and journal bridge abstractions. |
| `binding/` | Binding AST evaluation and operator adapters. |
| `blueprint/` | Blueprint lowering support. |
| `kernel/` | Pure UI kernel: scene state, layout, input, routing, snapshots, and deltas. |

## Boundary

This crate owns pure composition/runtime mechanics. Platform-specific rendering and I/O remain outside this crate; opaque platform pointers must be explicitly cast by the adapter that created them.
