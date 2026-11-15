# src/

Rust source for the `http-client` package slot.

## Folders

| Folder | Purpose |
| --- | --- |
| `domain/` | Pure request, receipt, authorization, method-token, and error data types. |
| `slot_entry/` | WASM query entry that reads slot/caller context and delegates to slot work (wasi and native only). |
| `run_in_a_web_worker/` | wasm-bindgen entry for a web host (Cloudflare Worker); same slot work through `slot_protocol::web_host`. |
| `slot_work/` | The active approved outside-request owner path. |
| `talk_to_other_slots/` | Opaque Envelope dispatch helpers. |
| `core/` | Test-support traits; no production side-effect route. |

## Current Contract

`slot_work` is the only production execution locus for outside HTTP side
effects. Native adapters are not exported as a production route.
