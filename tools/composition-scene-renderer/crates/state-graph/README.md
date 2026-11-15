# State Graph

`state-graph` is the unified runtime state the composition kernel reads and writes: input (pointers, keyboard, device), UI fsm state, recent-event history and session meta, all JSON-serializable so trigger and formula queries can read it. Ported verbatim from `bitfield-packages/crates/state-graph`.

## Files

| Path | Purpose |
|---|---|
| `Cargo.toml` | Crate manifest (serde, serde_json only). |
| `src/lib.rs` | `StateGraph`, the root struct, and its documentation (focus is derived, never stored). |
| `src/input/mod.rs` | Input state root (pointer, keyboard, device, audio). |
| `src/input/pointer.rs` | Pointer state per pointer id. |
| `src/input/keyboard.rs` | Pressed keys and modifiers. |
| `src/ui/mod.rs` | UI state root. |
| `src/ui/fsm.rs` | Per-node fsm states. |
| `src/history.rs` | Recent events kept for pattern matching. |
| `src/meta.rs` | Timing and session meta. |

## Key Types / Functions

| Item | Signature / Shape | Role |
|---|---|---|
| `StateGraph` | `{ pointers, keyboard, device, audio, fsm, recent_events, max_recent_events, meta }`, `Serialize + Deserialize` | The single runtime state a kernel owns. |

## Dependencies

**Depends on:** `serde`, `serde_json`.

**Depended on by:** `composition-engine-core`.
