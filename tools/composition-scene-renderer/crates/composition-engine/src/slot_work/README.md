# Slot Work

`slot_work/` owns composition-engine work that is specific to this slot boundary.

## Files

| File | Purpose |
|---|---|
| `answer_request.rs` | The one request decision: composition transaction, else delta, then the changed session's snapshot bytes; called by `slot_entry/do_work_when_asked.rs` and `run_in_a_page.rs`. |
| `composition_transaction.rs` | Decodes and applies `composition-transaction` payloads (scene patches, edges, layout, camera, viewport, text measurements, fsm interactions). |
| `scene_state.rs` | Owns the session map of kernels (one kernel per session key) and renders a session's snapshot bytes (`render_snapshot_bytes`). |
| `delta_apply.rs` | Applies subscribed delta payloads to scene state. |
| `scene_decode.rs` | Decodes canonical scene assertions into core scene nodes. |
| `snapshot_write.rs` | Not present in this crate: snapshot encoding is `scene_state.rs` `render_snapshot_bytes`. |

## Invariants

- Reusable kernel implementation stays in `composition-engine-core`.
- Slot work names the exact work role; generic kernel modules do not live here.
- No browser rendering or component mounting code lives here.
