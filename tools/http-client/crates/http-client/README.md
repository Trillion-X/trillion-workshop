# http-client/

HTTP client crate implementing the approved outside-request owner. The active
production path is the routed `slot::http-client` process/session path.

## Architecture

```
http-client/
├── Cargo.toml
├── README.md
├── src/
│   ├── lib.rs              # Crate root — module declarations + public re-exports
│   ├── core/               # Test-support traits, no production side-effect route
│   │   ├── mod.rs          # Core module — declares traits
│   │   └── traits.rs       # HttpExecutor trait, HttpExecutorResponse, test native fixture
│   ├── slot_entry/         # WASM Envelope entry; reads runtime config from context (not built for wasm32-unknown-unknown)
│   ├── run_in_a_web_worker/ # wasm-bindgen entry for a Cloudflare Worker / browser (wasm32-unknown-unknown only)
│   ├── slot_work/          # Slot-owned call_external work
│   ├── talk_to_other_slots/ # Opaque routed dispatch helpers
│   └── domain/             # Pure data types (zero I/O)
│       ├── mod.rs          # Domain module — declares types + errors submodules
│       ├── types.rs        # request/receipt types, open HttpMethod token
│       └── errors.rs       # HttpClientError enum with machine-readable codes
└── tests/
    └── public_api.rs       # Integration tests — verifies all pub re-exports are accessible
```

## WASM Compatibility

The slot entry compiles as WASI. Native HTTP helpers are test fixtures only:

```bash
# WASM slot check
cargo check --target wasm32-wasip2 -p http-client --no-default-features

# Package-set slot build
cargo build --target wasm32-wasip2 --release -p http-client --no-default-features

# Native tests
cargo test -p http-client
```

The slot reads runtime config from slot-owned query context and validates caller
URL grants from caller-owned query context. Rebuild the package-owned
`slots/http_client.wasm` artifact whenever the shared slot query-context frame
changes.

The WIT `handle-query` and `handle-query-batch` exports are async component
functions. Runtime-owned callers await those futures through the command lane.
This source must not call `wit_bindgen::block_on`, create a Tokio runtime, or
use `Handle::block_on` from slot or engine callback paths. Sync wrappers belong
only at outer OS entrypoints, never inside runtime-owned execution.

## Web host build (Cloudflare Worker)

```bash
cargo build -p http-client --lib --release --no-default-features --target wasm32-unknown-unknown
wasm-bindgen --target <web|experimental-nodejs-module> ...   # CLI version = Cargo.lock wasm-bindgen
```

`HttpClientInWebWorker` runs the same `call_external_async` path (grant check,
resolve by name through the vault target, placement, drop, transport, echo
scrub). On this target only, the transport step sends the
`TransportProcessRequest` JSON (`{url, method, headers, body_b64, body_file,
timeout_ms, deliver_parts_to}`) straight to `transport_target` and decodes a
`{status_code, headers, body_b64}` reply, because a Worker `fetch` runs no
process and has no containment receipt to give. A `blob_ref` body is refused
there. The wasi slot and native paths keep the process transport unchanged.
The module imports only its own wasm-bindgen glue. The package check
`../tests/run-in-a-web-worker.test.mjs` wires it to the web-host vault module.

## Echo scrub

Every placed value (each credential injection and an OAuth2 access token) is
held in `Zeroizing` until the transport reply is decoded. Every occurrence in
the reply body, the reply header values and any transport failure message, as
placed or form-urlencoded, is replaced by `[held value]`; then the values are
dropped. Tests: `placed_value_echoed_by_the_service_is_replaced_in_the_reply`,
`placed_value_echoed_in_a_transport_failure_is_replaced_in_the_error`.

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Crate manifest; no compile-time dependency on sibling slots |
| `src/lib.rs` | Crate root; exports data types and test-support traits |
| `src/core/mod.rs` | Core module; traits only |
| `src/core/traits.rs` | `HttpExecutor` trait + test-only native fixture |
| `src/domain/mod.rs` | Domain module — declares `types` and `errors` submodules |
| `src/domain/types.rs` | Approved outside request and receipt types with an open method token |
| `src/domain/errors.rs` | Structured error enum with stable error codes |
| `src/slot_entry/mod.rs` | WASM slot entry; reads configured routed target names from `envelope.context`. Not compiled for wasm32-unknown-unknown |
| `src/run_in_a_web_worker/mod.rs` | `HttpClientInWebWorker` (wasm-bindgen): `new(host_dispatch, partition_label, slot_config)`, `call(request, caller_context?) -> Promise<CallExternalResponse JSON bytes>`; outward calls through `slot_protocol::web_host` |
| `src/slot_work/call_external.rs` | Slot-owned HTTP request execution over configured transport and credential resolver targets |
| `src/talk_to_other_slots/` | Opaque Envelope dispatch helper; no sibling slot imports |
| `tests/public_api.rs` | Integration tests verifying the public data contract |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `HttpExecutor` | `trait: async fn execute(method, url, headers, body, timeout_ms)` | Test fixture interface, not a production export path |
| `HttpExecutorResponse` | `{ status: u16, headers: HashMap, body: Vec<u8> }` | Raw response from any HTTP implementation |
| `CallExternalRequest` | `{ url, method, headers, body?, credential_injections, authorization?, timeout_ms }` | Input to `_callExternal`; `body` is either inline bytes or `{kind:"blob_ref",hash}` |
| `CallExternalBody` | inline bytes or `Addressed(BlobRef)` | One provider-neutral body-source algebra; CAS bodies mount directly into transport without expanding through workflow state |
| `RequestAuthorization::OAuth2RefreshToken` | `{ token_url, client_id_handle, client_secret_handle?, refresh_token_handle, required_scope_groups, placement, client_credential_use }` | Internal OAuth2 refresh-token exchange; the derived access token is injected into the outbound request and never returned to the caller |
| `CredentialPlacement` | `header {name, prefix, suffix}` \| `query {name, prefix, suffix}` \| `signed_token {name, prefix, format: "jwt", algorithm: "HS256", key_id_separator?, key_encoding: hex\|base64\|raw, claims, lifetime_seconds}` | Where a held value goes in the request. `signed_token` places a short-lived JWT signed with the held key (the key id before `key_id_separator` becomes `kid`); the held value itself is never placed, and the token is scrubbed from any echo like the value |
| `OAuth2ClientCredentialUse` | `body_form_fields` or `basic_authorization_header` | Provider-neutral data for client credential use inside the owner boundary |
| `CallExternalResponse` | `{ status_code, headers, body, latency_ms }` | Output from `_callExternal` primitive |
| `HttpClientRuntimeConfig` | `{ execution_namespace, transport_target, transport_process, credential_resolver_target?, credential_resolver_actor_id?, url_grants[] }` | Manifest/context-supplied routed target names, process descriptor, and caller-context grants; not source-code law. `execution_namespace` is the host's own word (its declared name), from which every process wire identity is derived (`ExecutionNamespace::new`) |
| `HttpMethod` | validated string token | Open HTTP method token; extension methods are data |
| `HttpClientError` | 10 variants with `.code() -> &str` | Structured error with machine-readable codes |

## Public API

```rust
// Platform-agnostic (always available, works on WASM)
use http_client::{
    HttpExecutor, HttpExecutorResponse,           // Platform abstraction
    CallExternalRequest, CallExternalResponse,    // Request/response types
    HttpMethod, HttpClientError,                  // Open method token + errors
};
```

## Dependencies

**Always available:** `serde`, `serde_json`, `thiserror`, `url`, `async-trait`, `tracing`

**Native feature only:** `reqwest`, `tokio` for test fixtures.

**Routed compositions:** callers may ask this slot by envelope. This crate source does not import or hardcode caller internals, credential-owner internals, product names, or sibling slot crates. Runtime data supplies the transport target, optional credential resolver target, and opaque caller-context URL grants.

## Proof Log

- 2026-06-19 CDT: added request-level OAuth2 refresh-token authorization. The
  routed slot resolves client id, client secret, and refresh token handles,
  posts the form exchange to the configured token endpoint, validates required
  scope groups, injects the fresh access token according to the caller's
  placement, and returns only the real provider response.
- 2026-06-21 CDT: implemented the June 20 logic/backend rebase core. HTTP
  methods are validated open tokens, OAuth2 refresh supports body-form and
  Basic client credential use as data, the process descriptor lives in package
  config, and native public side-effect exports are deactivated. Proof:
  `cargo test`; `cargo check --target wasm32-wasip2 --no-default-features`.
- 2026-08-23 CDT: added the generic addressed request-body lane. Existing inline
  byte arrays retain their wire shape; `{kind:"blob_ref",hash}` bodies become a
  direct process CAS input mount, while credential resolution stays inside the
  HTTP owner and the caller receives only the normalized HTTP response.
