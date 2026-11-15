# slot-protocol/tests

Protocol conformance and gauntlet tests for the generic slot/envelope boundary.

## Files

| File | Purpose |
|------|---------|
| `queryresult_gauntlet.rs` | Proves `QueryResult` response bytes stay separate from writes and that mutating query acknowledgement fails when emitted writes fail |
| `query_routing.rs` | Proves query routing stays address-driven and payload-opaque |
| `n_target_benchmark.rs` | Proves target count is data, not code shape |
| `adversarial.rs` | Exercises hostile slot/dispatch cases |
| `determinism_handler.rs` | Proves handler output determinism |
| `fuzz_handler.rs` | Exercises malformed/edge payloads |
| `golden_parity.rs` | Golden parity checks for handler serialization |
| `integration.rs` | End-to-end slot registry and dispatch integration |
| `security_handler.rs` | Security and authorization handler checks |
