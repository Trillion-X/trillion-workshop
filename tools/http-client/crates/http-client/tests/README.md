# tests/

Integration tests for the `http-client` public data contract.

## Files

| File | Purpose |
| --- | --- |
| `public_api.rs` | Verifies exported request/receipt/error/types are accessible and that `HttpMethod` is an open validated token. |
| `error_classification.rs` | Verifies stable error classes and remediation text. |

## Current Contract

Native side-effect exports are not part of the public package API. Production
outside HTTP execution belongs to the routed `slot::http-client` process path;
integration tests cover the data contract that callers can construct and read.

## Proof

- 2026-06-21: `cargo test` passed all integration tests.
