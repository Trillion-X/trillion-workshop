# core/

Core test-support traits for the approved outside-request owner. Production
side effects do not run through this folder; they run through
`slot_work/call_external.rs` and the configured process/session target.

## Files

| File | Purpose |
|------|---------|
| `mod.rs` | Module declaration for traits only |
| `traits.rs` | `HttpExecutor` trait, `HttpExecutorResponse`, and test-only `ReqwestHttpExecutor` fixture |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `HttpExecutor` | `trait: async fn execute(method, url, headers, body, timeout_ms) -> Result<HttpExecutorResponse, HttpClientError>` | Test fixture abstraction |
| `HttpExecutorResponse` | `{ status: u16, headers: HashMap<String, String>, body: Vec<u8> }` | Raw response from any HTTP implementation |
| `ReqwestHttpExecutor` | `struct { client: reqwest::Client }` with `new()`, `with_default_client()`, `client()` | Native test fixture only |

## Current Notes

- 2026-06-21 CDT: the native execution route was deleted from this module. The
  routed slot/process path is the single production side-effect locus.

## Dependencies

**Always available (traits.rs):** `domain::types::HttpMethod`, `domain::errors::HttpClientError`, `std::collections::HashMap`, `url::Url`, `async-trait`

**Native feature only:** `reqwest`, `tokio`, and `tracing` are limited to test
fixtures. URL validation, credential resolution, audit logging, and transport
do not create a second production route.

**Depended on by:** `src/lib.rs` for public test-support trait re-exports.
