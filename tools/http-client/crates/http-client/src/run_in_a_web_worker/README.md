# run_in_a_web_worker/

Web host entry for the request sender: the unchanged `slot_work::call_external` path compiled as a plain wasm-bindgen module (`wasm32-unknown-unknown`) for a Cloudflare Worker Durable Object.

## Files

| File | Purpose |
|------|---------|
| `mod.rs` | `HttpClientInWebWorker` + `WebHostDispatch` (`AsyncEnvelopeDispatch` answered by `slot_protocol::web_host::dispatch`) |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `HttpClientInWebWorker::new` | `(host_dispatch: Function, partition_label: String, slot_config: Vec<u8>) -> Result<Self, JsError>` | Decodes `HttpClientRuntimeConfig` JSON, installs the host dispatch |
| `HttpClientInWebWorker::call` | `(&self, request: Vec<u8>, caller_context: Option<Vec<u8>>) -> Promise` | Runs one `CallExternalRequest`; resolves to scrubbed `CallExternalResponse` JSON bytes, rejects with the (scrubbed) error |
| `WebHostDispatch` (private) | `impl AsyncEnvelopeDispatch` | Every outward call (vault `read`/`resolve_handle`, transport) goes to the host |

## Dependencies

**Depends on:** `crate::slot_work` (`handle_http_client_request_with_async_dispatch`, `AsyncEnvelopeDispatch`, `HttpClientRuntimeConfig`), `slot_protocol::web_host`, `wasm-bindgen`, `wasm-bindgen-futures`, `js-sys`.

**Depended on by:** the Trillion Worker's held-values host (plan B9); `packages/http-client/tests/run-in-a-web-worker.test.mjs`.

## Invariants

- No request logic here; grant check, resolve, placement, drop and echo scrub are `slot_work::call_external`.
- The host's dispatch map decides which targets exist (vault, transport).
