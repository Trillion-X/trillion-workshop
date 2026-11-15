# domain/

Pure data types and structured errors for the approved outside-request route:
zero I/O, zero platform dependencies.

## Files

| File | Purpose |
|------|---------|
| `mod.rs` | Module declarations — exposes `types` and `errors` submodules |
| `types.rs` | Approved outside request and receipt types |
| `errors.rs` | Structured error enum with 10 variants, each with a unique machine-readable code |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `CallExternalRequest` | `{ url: String, method: HttpMethod, headers: HashMap, body: Option<CallExternalBody>, credential_injections: Vec<CredentialInjection>, authorization: Option<RequestAuthorization>, timeout_ms: Option<u64> }` | Approved outside request descriptor |
| `CallExternalBody` | inline `Vec<u8>` or addressed `{ kind: "blob_ref", hash }` | Keeps existing small-body compatibility while allowing CAS bodies to mount directly in the transport owner |
| `CredentialInjection` | `{ handle, placement }` | Opaque credential-handle placement requested by the caller |
| `CredentialPlacement` | `header`, `signed_token`, `query`, or `form_field` (appended to an `application/x-www-form-urlencoded` inline body, e.g. an OAuth `refresh_token`) | Provider-specific credential placement as data, never hardcoded in the slot |
| `RequestAuthorization` | `oauth2_refresh_token` with token URL, credential handles, required scope groups, placement, and client credential use | Derives transient authorization inside `http-client` without exposing fresh access tokens to workflows |
| `OAuth2ClientCredentialUse` | `body_form_fields` or `basic_authorization_header` | Provider-neutral token-refresh client credential use |
| `CallExternalResponse` | `{ status_code: u16, headers: HashMap, body: Vec<u8>, latency_ms: u64 }` | Outside request receipt |
| `HttpMethod` | validated string token | Open HTTP method token; extension methods are data |
| `ParseHttpMethodError` | `{ invalid_input: String }` | Error from `HttpMethod::from_str()` parsing |
| `HttpClientError` | 10 variants: DomainNotAllowed, SsrfBlocked, Timeout, NetworkError, SecretNotFound, SecretExpired, InvalidUrl, HttpsRequired, PermissionDenied, InvalidRequest | `.code()` returns stable machine-readable string |

## Dependencies

**Depends on:** `serde`, `serde_json`, `thiserror`, `std::collections::HashMap`

**Depended on by:** `crates/http-client/src/core/` (Agent 2), `crates/http-client/src/lib.rs` (Agent 4 re-exports)
