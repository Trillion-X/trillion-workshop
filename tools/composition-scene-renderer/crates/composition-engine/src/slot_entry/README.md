# Slot Entry

`slot_entry/` owns the outside-facing SharedBufferProtocol boundary for `composition-engine`.

## Files

| File | Purpose |
|---|---|
| `mod.rs` | Exports `init` and `handle_query`, declares shared buffers and imported ABI functions. |
| `start_up.rs` | Initializes buffers and default scene state, then writes the initial snapshot reply. |
| `read_incoming_bytes.rs` | Reads caller bytes from the input buffer. |
| `do_work_when_asked.rs` | Reads request bytes, asks `slot_work::answer_request`, and writes snapshot reply bytes (0 = nothing to reply, -1 = refused). |
| `write_reply_bytes.rs` | Writes reply bytes to the output buffer and notifies the runtime. |

## Invariants

- Not compiled for wasm32-unknown-unknown: the page build calls `run_in_a_page.rs` instead.

- Entry files do not own kernel logic.
- Entry files do not know society surfaces or packages.
- Entry files translate only between SharedBufferProtocol bytes and slot work.
