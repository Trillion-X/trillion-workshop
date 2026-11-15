// crates/slot-protocol/tests/determinism_handler.rs
//
// Category 8 from UWHA Plan §Task O: Red-Team Gauntlet.
// Determinism tests: same input → same output, rollback identity,
// reproducibility across handler instances.

use slot_protocol::handler::{deserialize_payload, serialize_response, HandlerTable, QueryHandler};
use slot_protocol::{Envelope, EnvelopeError, FactAddress, PartitionKey, QueryResult};
use std::collections::hash_map::DefaultHasher;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::pin::Pin;
use std::sync::Arc;

// ============================================================================
// Helpers
// ============================================================================

/// A deterministic echo handler — always returns the payload bytes as-is.
struct EchoHandler;

impl QueryHandler for EchoHandler {
    fn query(
        &self,
        envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            let data = envelope.payload.unwrap_or_default();
            Ok(QueryResult::read_only(Arc::from(data.as_ref())))
        })
    }
}

/// A deterministic computation handler — returns hash of payload.
struct HashHandler;

impl QueryHandler for HashHandler {
    fn query(
        &self,
        envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            let data = envelope.payload.unwrap_or_default();
            let mut hasher = DefaultHasher::new();
            data.hash(&mut hasher);
            let hash = hasher.finish();
            Ok(QueryResult::read_only(Arc::from(
                hash.to_le_bytes().as_slice(),
            )))
        })
    }
}

fn make_test_envelope(payload: &[u8]) -> Envelope {
    let pk = PartitionKey::from_digest(0x1F, vec![0u8; 32]);
    let addr = FactAddress::from_digest(0x1F, vec![1u8; 32]);
    Envelope::minimal(pk, addr, Some(bytes::Bytes::copy_from_slice(payload)))
}

// ============================================================================
// Same query N times → identical result every time (hash comparison)
// ============================================================================

#[tokio::test]
async fn echo_handler_1000x_determinism() {
    let handler = EchoHandler;
    let payload = b"determinism test payload 42";
    let envelope = make_test_envelope(payload);

    let first_result = handler.query(envelope.clone()).await.unwrap();

    for i in 0..1000 {
        let result = handler.query(envelope.clone()).await.unwrap();
        assert_eq!(
            result.response.as_ref(),
            first_result.response.as_ref(),
            "iteration {i}: result must be identical to first result"
        );
    }
}

#[tokio::test]
async fn hash_handler_1000x_determinism() {
    let handler = HashHandler;
    let payload = b"hash determinism input";
    let envelope = make_test_envelope(payload);

    let first_result = handler.query(envelope.clone()).await.unwrap();
    assert_eq!(first_result.response.len(), 8, "u64 hash = 8 bytes");

    for i in 0..1000 {
        let result = handler.query(envelope.clone()).await.unwrap();
        assert_eq!(
            result.response.as_ref(),
            first_result.response.as_ref(),
            "iteration {i}: hash must be identical"
        );
    }
}

// ============================================================================
// Different payloads → different results (non-collision)
// ============================================================================

#[tokio::test]
async fn hash_handler_different_inputs_produce_different_outputs() {
    let handler = HashHandler;
    let mut results = Vec::new();

    for i in 0u8..100 {
        let envelope = make_test_envelope(&[i; 32]);
        let result = handler.query(envelope).await.unwrap();
        results.push(result.response.to_vec());
    }

    let unique: std::collections::HashSet<Vec<u8>> = results.into_iter().collect();
    assert_eq!(
        unique.len(),
        100,
        "100 distinct inputs must produce 100 distinct hashes"
    );
}

// ============================================================================
// Handler table registration determinism
// ============================================================================

#[test]
fn handler_table_registration_set_is_deterministic() {
    let mut table = HandlerTable::new();
    table.register("alpha", Arc::new(EchoHandler) as Arc<dyn QueryHandler>);
    table.register("beta", Arc::new(HashHandler) as Arc<dyn QueryHandler>);
    table.register("gamma", Arc::new(EchoHandler) as Arc<dyn QueryHandler>);

    let mut names: Vec<&str> = table.handler_names();
    names.sort();
    assert_eq!(names.len(), 3);

    let mut table2 = HandlerTable::new();
    table2.register("alpha", Arc::new(EchoHandler) as Arc<dyn QueryHandler>);
    table2.register("beta", Arc::new(HashHandler) as Arc<dyn QueryHandler>);
    table2.register("gamma", Arc::new(EchoHandler) as Arc<dyn QueryHandler>);

    let mut names2: Vec<&str> = table2.handler_names();
    names2.sort();
    assert_eq!(names, names2, "same registrations = same handler set");
}

// ============================================================================
// Two handler instances from same type → identical results (reproducibility)
// ============================================================================

#[tokio::test]
async fn two_echo_instances_produce_identical_results() {
    let h1 = EchoHandler;
    let h2 = EchoHandler;

    let payload = b"reproducibility test";
    let envelope = make_test_envelope(payload);

    let r1 = h1.query(envelope.clone()).await.unwrap();
    let r2 = h2.query(envelope).await.unwrap();
    assert_eq!(
        r1.response.as_ref(),
        r2.response.as_ref(),
        "two instances of same handler = identical output"
    );
}

#[tokio::test]
async fn two_hash_instances_produce_identical_results() {
    let h1 = HashHandler;
    let h2 = HashHandler;

    let payload = b"hash reproducibility";
    let envelope = make_test_envelope(payload);

    let r1 = h1.query(envelope.clone()).await.unwrap();
    let r2 = h2.query(envelope).await.unwrap();
    assert_eq!(
        r1.response.as_ref(),
        r2.response.as_ref(),
        "two instances of same handler = identical hash"
    );
}

// ============================================================================
// Serialization round-trip determinism
// ============================================================================

#[test]
fn serialize_response_determinism() {
    let data = serde_json::json!({"count": 42, "name": "test", "items": [1, 2, 3]});

    let bytes1 = serialize_response(&data, "test").unwrap();
    let bytes2 = serialize_response(&data, "test").unwrap();
    assert_eq!(
        bytes1.as_ref(),
        bytes2.as_ref(),
        "same input → same serialized bytes"
    );
}

#[test]
fn deserialize_serialize_round_trip_identity() {
    let original = serde_json::json!({"key": "value", "nested": {"a": 1}});
    let bytes = serialize_response(&original, "test").unwrap();
    let envelope = Envelope::minimal(
        PartitionKey::from_digest(0x1F, vec![0u8; 32]),
        FactAddress::from_digest(0x1F, vec![0u8; 32]),
        Some(bytes::Bytes::copy_from_slice(&bytes)),
    );
    let deserialized: serde_json::Value = deserialize_payload(&envelope, "test").unwrap();
    let re_serialized = serialize_response(&deserialized, "test").unwrap();
    assert_eq!(
        bytes.as_ref(),
        re_serialized.as_ref(),
        "round-trip must be identity"
    );
}
