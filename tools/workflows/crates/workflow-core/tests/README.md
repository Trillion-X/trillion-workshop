# tests/

Integration tests for the workflow crate.

## Files

| File | Purpose |
|------|---------|
| `error_conformance.rs` | CI gate: compile-time verification that all WorkflowError variants use named-field syntax, plus Display, accessor, serialization, and variant count guards |
| `monte_carlo_marketing.rs` | Monte Carlo simulation tests for marketing workflow execution |
| `permission_integration.rs` | Permission integration smoke test |

## Dependencies

**Depends on:** `workflow` (public API: KernelBridge, WorkflowError, domain types), `data` (DataBackend, ResourceRegistry), `auth` (ActorContext), `serde_json`, `tokio`

**Depended on by:** CI test suite (`cargo test -p workflow`)
