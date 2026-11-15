# shared-slot-batches

Same-program plugged slot call primitive.

Plain English: this crate is the hot lane for calling a plugged slot without the engine knowing what machine sits behind the plug. The caller sends fixed-width rows plus byte spans. The private runner behind the plug does the real work.

## Files

| File | Purpose |
|---|---|
| `Cargo.toml` | Crate manifest |
| `src/lib.rs` | Shared plug/install/invoke/complete/clear contracts and same-program engine handle trait |
| `src/slot_plugs.rs` | Slot plug row type |
| `src/slot_requests.rs` | Guest slot request row type |
| `src/same_program_slots.rs` | Same-program wrapper over the four canonical operations |
| `src/slot_lifecycle.rs` | Slot lifecycle helpers |
| `tests/in_process_cycle.rs` | Plug/invoke/complete/clear cycle tests |
| `benches/throughput_floor.rs` | Batch throughput floor benchmark |

## Boundary Law

- A `slot` is the door.
- A `plug` connects that door to a private callable thing.
- A `plug_call_id` names the callable thing behind the plug.
- A call row carries numeric ids plus byte offsets and byte lengths.
- This crate must not know WASM, Wasmtime, OS processes, JS, Python, Swift, browser workers, product package names, or runtime/provider names.

## Hot Path Shape

```text
slot_id
slot_generation
plug_call_id
payload_offset
payload_len
correlation_id
flags
```

`invoke_record_flags::NO_REPLY` is the canonical no-reply bit for the invoke
record `flags` field. Runners and generated bindings import that constant from
this crate; they do not redefine the bit value locally.

The hot path has already resolved the slot and plug. It must not search a runtime catalog, parse artifact names, or allocate runtime-specific objects.

## Required Replacement Work

The active AP-07C plan requires this crate to replace old native-target wording:

- `NativeTargetToken` becomes `PlugCallId`.
- `SlotPlug` maps `slot_id + generation` to `plug_call_id`.
- The plugged slot table becomes a direct-index table keyed by `slot_id`, not a `HashMap`.
- `PlugCallPermissionRow` records the policy/resource/audit/revocation words for the plug.
- `PlugCallPermissionRow` is serializable because cold slot-door state stores the accepted permission row and the hot lane consumes its fixed-width ids.

## Reference

See `<checkout>/guides/core/slot-plug-call-boundary-guide.md`.
