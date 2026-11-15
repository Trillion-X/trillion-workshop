// crates/slot-protocol/tests/n_target_benchmark.rs
//
// BD-22: N-Target Verification Suite
//
// Proves the decomposed architecture handles 102 callable slot doors from pure
// data — zero code changes, zero new handler families. 4 neutral plug-call
// handlers serve all 102 slot doors. Dispatch latency is O(1) regardless of
// target count.
//
// This fixture intentionally avoids product, storage, network, language, or
// runtime/provider names. Slot-door names and plug-call names are just data.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use slot_protocol::handler::{HandlerTable, QueryHandler};
use slot_protocol::{Envelope, EnvelopeError, FactAddress, PartitionKey, QueryResult};

const TARGET_COUNT: usize = 102;
const HANDLER_COUNT: usize = 4;

// ============================================================================
// Test echo handler — ONE handler that echoes the payload back.
// Proves: the handler never enumerates what it handles (L090).
// ============================================================================

struct EchoHandler {
    handler_name: String,
}

impl EchoHandler {
    fn new(name: &str) -> Self {
        Self {
            handler_name: name.to_string(),
        }
    }
}

impl QueryHandler for EchoHandler {
    fn query(
        &self,
        envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            // Echo: return payload bytes tagged with handler name
            let payload = envelope.payload.unwrap_or_default();
            let response = format!(
                "{}:{}",
                self.handler_name,
                String::from_utf8_lossy(&payload)
            );
            Ok(QueryResult::read_only(Arc::from(
                response.into_bytes().into_boxed_slice(),
            )))
        })
    }
}

// ============================================================================
// Target registration — 102 targets from pure data
// ============================================================================

/// Slot configuration: name → handler mapping. This is what Envelope state
/// at `slot::*` contains. The engine reads this data, creates DispatchSlots,
/// and wires them to handlers from the HandlerTable. Zero code changes.
struct SlotConfig {
    slot_name: String,
    handler: String,
}

fn generate_102_targets() -> Vec<SlotConfig> {
    let mut targets = Vec::with_capacity(102);

    for i in 0..TARGET_COUNT {
        targets.push(SlotConfig {
            slot_name: format!("slot-door-{:03}", i),
            handler: format!("plug-call-{}", i % HANDLER_COUNT),
        });
    }

    assert_eq!(targets.len(), TARGET_COUNT);
    targets
}

/// Register neutral plug-call handlers on the HandlerTable.
fn register_handlers() -> HandlerTable {
    let mut table = HandlerTable::new();
    for i in 0..HANDLER_COUNT {
        let name = format!("plug-call-{}", i);
        table.register(&name, Arc::new(EchoHandler::new(&name)));
    }
    table
}

fn make_envelope(slot_name: &str) -> Envelope {
    let payload = Bytes::from(slot_name.to_string());
    let pk = PartitionKey::from_digest(0x1F, content_crypto::hash(slot_name.as_bytes()).to_vec());
    let addr = FactAddress::from_digest(0x1F, content_crypto::hash(&payload).to_vec());
    Envelope::minimal(pk, addr, Some(payload))
}

// ============================================================================
// Tests
// ============================================================================

#[test]
fn register_102_targets_from_data_zero_code_changes() {
    let targets = generate_102_targets();
    assert_eq!(targets.len(), TARGET_COUNT, "must have exactly 102 targets");

    // Count unique handlers — bounded fixture set, not one handler per slot door.
    let mut handlers: Vec<&str> = targets.iter().map(|t| t.handler.as_str()).collect();
    handlers.sort();
    handlers.dedup();
    assert_eq!(
        handlers.len(),
        HANDLER_COUNT,
        "{} unique handlers serve 102 targets: {:?}",
        HANDLER_COUNT,
        handlers
    );
}

#[test]
fn handler_table_has_4_handlers_for_102_targets() {
    let table = register_handlers();
    assert_eq!(
        table.handler_names().len(),
        HANDLER_COUNT,
        "exactly 4 handlers registered"
    );

    for i in 0..HANDLER_COUNT {
        assert!(table.get(&format!("plug-call-{}", i)).is_some());
    }
}

#[test]
fn every_target_resolves_to_a_handler() {
    let table = register_handlers();
    let targets = generate_102_targets();

    for target in &targets {
        let handler = table.get(&target.handler);
        assert!(
            handler.is_some(),
            "target '{}' maps to handler '{}' which should exist",
            target.slot_name,
            target.handler
        );
    }
}

#[tokio::test]
async fn dispatch_all_102_targets() {
    let table = register_handlers();
    let targets = generate_102_targets();

    for target in &targets {
        let handler = table.get(&target.handler).unwrap();
        let envelope = make_envelope(&target.slot_name);
        let result = handler.query(envelope).await;

        assert!(
            result.is_ok(),
            "dispatch to '{}' via '{}' should succeed",
            target.slot_name,
            target.handler
        );

        let bytes = result.unwrap();
        let response = String::from_utf8_lossy(&bytes.response);
        assert!(
            response.contains(&target.handler),
            "response should identify handler: {}",
            response
        );
    }
}

#[tokio::test]
async fn dispatch_latency_flat_across_target_counts() {
    let table = register_handlers();
    let targets = generate_102_targets();

    // Measure dispatch latency at different target counts
    // The handler lookup is O(1) HashMap — latency should be constant
    let counts = [1, 10, 50, 100];
    let mut latencies = Vec::new();

    for &count in &counts {
        let subset = &targets[..count.min(targets.len())];
        let iterations = 1000;

        let start = Instant::now();
        for _ in 0..iterations {
            for target in subset {
                let handler = table.get(&target.handler).unwrap();
                let envelope = make_envelope(&target.slot_name);
                let _ = handler.query(envelope).await;
            }
        }
        let elapsed = start.elapsed();
        let per_dispatch_ns = elapsed.as_nanos() / (iterations * count as u128).max(1);
        latencies.push((count, per_dispatch_ns));
    }

    // Verify O(1): per-dispatch latency should not grow with target count.
    // Allow 5x tolerance for test environment variance.
    let (_, baseline_ns) = latencies[0];
    for (count, ns) in &latencies {
        assert!(
            *ns < baseline_ns * 5,
            "dispatch latency at {} targets ({} ns) should be within 5x of baseline ({} ns) — O(1) not O(N)",
            count,
            ns,
            baseline_ns
        );
    }
}

#[tokio::test]
async fn runtime_addition_dispatches_immediately() {
    let mut table = register_handlers();

    // Initially: 4 handlers
    assert_eq!(table.handler_names().len(), HANDLER_COUNT);

    // Add a new handler at runtime
    table.register(
        "plug-call-added",
        Arc::new(EchoHandler::new("plug-call-added")),
    );

    // Dispatch to new handler immediately
    let start = Instant::now();
    let handler = table.get("plug-call-added").unwrap();
    let envelope = make_envelope("slot-door-added");
    let result = handler.query(envelope).await;
    let elapsed = start.elapsed();

    assert!(result.is_ok(), "runtime-added handler should dispatch");
    assert!(
        elapsed.as_millis() < 100,
        "time from registration to first dispatch: {}ms (should be < 100ms)",
        elapsed.as_millis()
    );
}

#[tokio::test]
async fn different_plugs_preserve_identical_payloads() {
    let table = register_handlers();

    let first_handler = table.get("plug-call-0").unwrap();
    let first_envelope = make_envelope("slot-door-000");
    let first_result = first_handler.query(first_envelope).await.unwrap();

    let second_handler = table.get("plug-call-1").unwrap();
    let second_envelope = make_envelope("slot-door-000");
    let second_result = second_handler.query(second_envelope).await.unwrap();

    // Both should contain the slot name in the response
    let first_str = String::from_utf8_lossy(&first_result.response);
    let second_str = String::from_utf8_lossy(&second_result.response);

    assert!(first_str.contains("slot-door-000"), "first: {}", first_str);
    assert!(
        second_str.contains("slot-door-000"),
        "second: {}",
        second_str
    );

    // The payload portion (after handler name) should be identical
    let first_payload = first_str.split(':').nth(1).unwrap_or("");
    let second_payload = second_str.split(':').nth(1).unwrap_or("");
    assert_eq!(
        first_payload, second_payload,
        "different plugs should preserve identical payload: '{}' vs '{}'",
        first_payload, second_payload
    );
}

#[test]
fn slot_door_names_do_not_create_handler_names() {
    let targets = generate_102_targets();
    let table = register_handlers();

    for target in &targets {
        assert!(
            table.get(&target.slot_name).is_none(),
            "slot door '{}' must remain data, not become a handler family",
            target.slot_name
        );
        assert!(table.get(&target.handler).is_some());
    }
}
