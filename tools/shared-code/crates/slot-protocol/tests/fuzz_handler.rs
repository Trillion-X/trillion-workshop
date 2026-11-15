// crates/slot-protocol/tests/fuzz_handler.rs
//
// Category 7 from UWHA Plan §Task O: Red-Team Gauntlet.
// Fuzz-style tests: arbitrary bytes as Envelope query payload → handler never panics.
// Arbitrary JSON as deserialization target → never panics.
// Uses deterministic byte patterns (reproducible, no rand needed).

use slot_protocol::handler::{deserialize_payload, serialize_response, QueryHandler};
use slot_protocol::{Envelope, EnvelopeError, FactAddress, PartitionKey, QueryResult};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

// ============================================================================
// Helpers
// ============================================================================

/// Handler that attempts to deserialize payload as JSON, returning error on failure.
struct JsonParsingHandler;

impl QueryHandler for JsonParsingHandler {
    fn query(
        &self,
        envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            let value: serde_json::Value = deserialize_payload(&envelope, "fuzz")?;
            let response = serialize_response(&value, "fuzz")?;
            Ok(QueryResult::read_only(response))
        })
    }
}

/// Handler that always returns Ok — tests that the handler mechanism itself never panics.
struct AlwaysOkHandler;

impl QueryHandler for AlwaysOkHandler {
    fn query(
        &self,
        _envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
        Box::pin(async move { Ok(QueryResult::read_only(Arc::from(b"ok".as_slice()))) })
    }
}

fn make_envelope_with_bytes(data: &[u8]) -> Envelope {
    let pk = PartitionKey::from_digest(0x1F, vec![0u8; 32]);
    let addr = FactAddress::from_digest(0x1F, vec![1u8; 32]);
    Envelope::minimal(pk, addr, Some(bytes::Bytes::copy_from_slice(data)))
}

fn make_envelope_empty() -> Envelope {
    let pk = PartitionKey::from_digest(0x1F, vec![0u8; 32]);
    let addr = FactAddress::from_digest(0x1F, vec![1u8; 32]);
    Envelope::minimal(pk, addr, None)
}

// ============================================================================
// Fuzz: arbitrary bytes as query payload → never panics, returns Ok or Err
// ============================================================================

#[tokio::test]
async fn fuzz_json_handler_arbitrary_bytes_never_panics() {
    let handler = JsonParsingHandler;

    for i in 0..10_000u32 {
        let bytes: Vec<u8> = (0..7)
            .map(|j| {
                let b = i.to_le_bytes();
                [b[0], b[1], b[2], b[3], 0xFF, 0x00, b[0] ^ 0xAA][j as usize]
            })
            .collect();

        let envelope = make_envelope_with_bytes(&bytes);
        // Must be Ok or Err — never panic.
        let _ = handler.query(envelope).await;
    }
}

#[tokio::test]
async fn fuzz_always_ok_handler_arbitrary_bytes_never_panics() {
    let handler = AlwaysOkHandler;

    for i in 0..10_000u32 {
        let bytes: Vec<u8> = (0..64).map(|j| ((i * 7 + j * 13) % 256) as u8).collect();
        let envelope = make_envelope_with_bytes(&bytes);
        let result = handler.query(envelope).await;
        assert!(
            result.is_ok(),
            "AlwaysOkHandler must never fail, iteration {i}"
        );
    }
}

#[tokio::test]
async fn fuzz_empty_payload_never_panics() {
    let handler = JsonParsingHandler;
    let envelope = make_envelope_empty();
    let result = handler.query(envelope).await;
    assert!(result.is_err(), "empty payload should be a parse error");
}

#[tokio::test]
async fn fuzz_zero_bytes_never_panics() {
    let handler = JsonParsingHandler;

    let envelope = make_envelope_with_bytes(&[0u8; 0]);
    let _ = handler.query(envelope).await;

    let envelope = make_envelope_with_bytes(&[0u8; 1]);
    let _ = handler.query(envelope).await;

    let envelope = make_envelope_with_bytes(&[0u8; 1024]);
    let _ = handler.query(envelope).await;
}

#[tokio::test]
async fn fuzz_all_0xff_never_panics() {
    let handler = JsonParsingHandler;
    let envelope = make_envelope_with_bytes(&[0xFF; 256]);
    let _ = handler.query(envelope).await;
}

// ============================================================================
// Fuzz: deserialize_payload with hostile inputs → never panics
// ============================================================================

#[test]
fn fuzz_deserialize_payload_arbitrary_bytes() {
    for i in 0..10_000u32 {
        let bytes: Vec<u8> = (0..32).map(|j| ((i * 11 + j * 17) % 256) as u8).collect();
        let envelope = make_envelope_with_bytes(&bytes);
        let _: Result<serde_json::Value, _> = deserialize_payload(&envelope, "fuzz");
    }
}

#[test]
fn fuzz_deserialize_payload_edge_cases() {
    let edge_cases: Vec<&[u8]> = vec![
        b"null",
        b"true",
        b"false",
        b"0",
        b"-1",
        b"1e999",
        b"\"\"",
        b"[]",
        b"{}",
        b"[[[[[[[[[[[[[[[[[[[[[[[",
        b"{{{{{{{{{{{{{{{{{{",
        b"\"\\u0000\"",
        b"\"\\uFFFF\"",
        b"\x00\x00\x00\x00",
        b"\xFF\xFE\xFD\xFC",
    ];

    for case in edge_cases {
        let envelope = make_envelope_with_bytes(case);
        // No panic = pass.
        let _: Result<serde_json::Value, _> = deserialize_payload(&envelope, "fuzz");
    }
}

// ============================================================================
// Fuzz: serialize_response with hostile JSON values → never panics
// ============================================================================

#[test]
fn fuzz_serialize_response_various_values() {
    let values = vec![
        serde_json::Value::Null,
        serde_json::Value::Bool(true),
        serde_json::Value::Bool(false),
        serde_json::json!(0),
        serde_json::json!(i64::MIN),
        serde_json::json!(i64::MAX),
        serde_json::json!(u64::MAX),
        serde_json::json!(f64::MIN),
        serde_json::json!(f64::MAX),
        serde_json::json!(""),
        serde_json::json!("a".repeat(100_000)),
        serde_json::json!([]),
        serde_json::json!({}),
        serde_json::json!({"deeply": {"nested": {"object": {"here": true}}}}),
    ];

    for val in &values {
        let result = serialize_response(val, "fuzz");
        if let Ok(bytes) = result {
            assert!(!bytes.is_empty());
        }
    }
}
