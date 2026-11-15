# slot-protocol/wit

| File | Purpose |
| --- | --- |
| `handler.wit` | Component-model ABI for generic query handlers and the opaque `talk-to-other-slots.send-request-bytes(...)` import. |

Both query exports are async. A guest that awaits `send-request-bytes(...)` must
stay on the component async boundary; it must not bridge through a guest-side
sync `block_on`.
