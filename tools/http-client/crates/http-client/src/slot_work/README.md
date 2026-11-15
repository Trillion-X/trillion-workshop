# slot_work/

Slot-owned approved outside-request execution.

## Files

| File | Purpose |
| --- | --- |
| `mod.rs` | Exposes the routed slot work entrypoints. |
| `call_external.rs` | Validates caller URL grants, resolves credential handles inside `http-client`, applies authorization transforms, builds the data-owned process descriptor payload, dispatches to process/session, and returns the bounded receipt bytes. |

## Current Contract

- `HttpClientRuntimeConfig` is required slot context; its `execution_namespace` word, supplied by the host, names the process wire identities the transport encodes and decodes.
- `transport_target` names the existing process/session route.
- `transport_process` is package data for argv, env key, sandbox, capture flags, and timeout padding.
- `OAuth2ClientCredentialUse` supports body-form and Basic client credential use without exposing plaintext credentials outside this owner.
- HTTP methods are open validated tokens.
- Every placed value (injections and an OAuth2 access token) is kept in `Zeroizing` until the reply is decoded; every echo of it (as placed or form-urlencoded) in the reply body, header values and failure text becomes `[held value]` (`scrub_placed_values`, `scrub_placed_text`).
- On `wasm32-unknown-unknown` the transport step sends the `TransportProcessRequest` JSON directly to `transport_target` and decodes `{status_code, headers, body_b64}` (a web host fetch runs no process); `blob_ref` bodies are refused there. `Instant` is `web_time::Instant`.

## Proof

- 2026-06-21: `cargo test` covers URL grant rejection, credential injection,
  body-form OAuth refresh, Basic client OAuth refresh, and transport descriptor
  assembly from config.
