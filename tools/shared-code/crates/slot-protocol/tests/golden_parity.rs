// crates/slot-protocol/tests/golden_parity.rs
//
// Category 4 from UWHA Plan §Task O: Red-Team Gauntlet.
// Golden tests: known input → serialize → deserialize → byte-identical.
// Handler output parity: same query to different handler types = same mechanism.

use slot_protocol::handler::{deserialize_payload, serialize_response, HandlerTable, QueryHandler};
use slot_protocol::{Envelope, EnvelopeError, FactAddress, PartitionKey, QueryResult};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

// ============================================================================
// Helpers
// ============================================================================

/// Pass-through handler that returns payload unmodified.
struct PassthroughHandler;

impl QueryHandler for PassthroughHandler {
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

/// JSON echo handler that deserializes and re-serializes the payload.
struct JsonEchoHandler;

impl QueryHandler for JsonEchoHandler {
    fn query(
        &self,
        envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            let value: serde_json::Value = deserialize_payload(&envelope, "golden")?;
            let response = serialize_response(&value, "golden")?;
            Ok(QueryResult::read_only(response))
        })
    }
}

fn make_envelope(payload: &[u8]) -> Envelope {
    let pk = PartitionKey::from_digest(0x1F, vec![0u8; 32]);
    let addr = FactAddress::from_digest(0x1F, vec![1u8; 32]);
    Envelope::minimal(pk, addr, Some(bytes::Bytes::copy_from_slice(payload)))
}

// ============================================================================
// Golden: serialize_response round-trip is byte-identical
// ============================================================================

#[test]
fn golden_serialize_round_trip_simple_object() {
    let input = serde_json::json!({"name": "test", "value": 42});
    let bytes = serialize_response(&input, "golden").unwrap();
    let envelope = make_envelope(&bytes);
    let decoded: serde_json::Value = deserialize_payload(&envelope, "golden").unwrap();
    let re_bytes = serialize_response(&decoded, "golden").unwrap();
    assert_eq!(
        bytes.as_ref(),
        re_bytes.as_ref(),
        "round-trip must be byte-identical"
    );
}

#[test]
fn golden_serialize_round_trip_nested_object() {
    let input = serde_json::json!({
        "root": {
            "child": {
                "grandchild": [1, 2, 3, null, true, false, "string"]
            }
        },
        "array": [{"a": 1}, {"b": 2}],
        "empty": {}
    });
    let bytes = serialize_response(&input, "golden").unwrap();
    let envelope = make_envelope(&bytes);
    let decoded: serde_json::Value = deserialize_payload(&envelope, "golden").unwrap();
    let re_bytes = serialize_response(&decoded, "golden").unwrap();
    assert_eq!(bytes.as_ref(), re_bytes.as_ref());
}

#[test]
fn golden_serialize_round_trip_empty_payload() {
    let input = serde_json::json!({});
    let bytes = serialize_response(&input, "golden").unwrap();
    let envelope = make_envelope(&bytes);
    let decoded: serde_json::Value = deserialize_payload(&envelope, "golden").unwrap();
    let re_bytes = serialize_response(&decoded, "golden").unwrap();
    assert_eq!(bytes.as_ref(), re_bytes.as_ref());
}

#[test]
fn golden_serialize_round_trip_array() {
    let input = serde_json::json!([1, "two", 3.0, null, true]);
    let bytes = serialize_response(&input, "golden").unwrap();
    let envelope = make_envelope(&bytes);
    let decoded: serde_json::Value = deserialize_payload(&envelope, "golden").unwrap();
    let re_bytes = serialize_response(&decoded, "golden").unwrap();
    assert_eq!(bytes.as_ref(), re_bytes.as_ref());
}

#[test]
fn golden_serialize_round_trip_unicode() {
    let input = serde_json::json!({"emoji": "🎯🔥", "cjk": "日本語", "rtl": "مرحبا"});
    let bytes = serialize_response(&input, "golden").unwrap();
    let envelope = make_envelope(&bytes);
    let decoded: serde_json::Value = deserialize_payload(&envelope, "golden").unwrap();
    let re_bytes = serialize_response(&decoded, "golden").unwrap();
    assert_eq!(bytes.as_ref(), re_bytes.as_ref());
}

#[test]
fn golden_serialize_round_trip_large_numbers() {
    let input = serde_json::json!({
        "max_u64": u64::MAX,
        "min_i64": i64::MIN,
        "float": std::f64::consts::PI
    });
    let bytes = serialize_response(&input, "golden").unwrap();
    let envelope = make_envelope(&bytes);
    let decoded: serde_json::Value = deserialize_payload(&envelope, "golden").unwrap();
    let re_bytes = serialize_response(&decoded, "golden").unwrap();
    assert_eq!(bytes.as_ref(), re_bytes.as_ref());
}

// ============================================================================
// Golden: 100 reference queries produce identical output
// ============================================================================

#[tokio::test]
async fn golden_100_queries_passthrough_byte_identical() {
    let handler = PassthroughHandler;

    for i in 0..100u32 {
        let payload = format!(r#"{{"query_id":{i},"data":"reference query {i}"}}"#);
        let envelope = make_envelope(payload.as_bytes());
        let result = handler.query(envelope).await.unwrap();
        assert_eq!(
            result.response.as_ref(),
            payload.as_bytes(),
            "query {i}: passthrough must be byte-identical to input"
        );
    }
}

#[tokio::test]
async fn golden_100_queries_json_echo_byte_identical() {
    let handler = JsonEchoHandler;

    for i in 0..100u32 {
        let input = serde_json::json!({"data": format!("reference query {i}"), "query_id": i});
        let payload = serde_json::to_vec(&input).unwrap();

        let envelope = make_envelope(&payload);
        let result = handler.query(envelope).await.unwrap();
        assert_eq!(
            result.response.as_ref(),
            payload.as_slice(),
            "query {i}: JSON echo must produce byte-identical canonical JSON"
        );
    }
}

// ============================================================================
// Golden: handler parity — same query to different handler types
// ============================================================================

#[tokio::test]
async fn golden_parity_passthrough_vs_json_echo_on_canonical_json() {
    let passthrough = PassthroughHandler;
    let json_echo = JsonEchoHandler;

    for i in 0..50u32 {
        let input = serde_json::json!({"id": i, "value": format!("test-{i}")});
        let canonical_payload = serde_json::to_vec(&input).unwrap();
        let envelope = make_envelope(&canonical_payload);

        let r_pass = passthrough.query(envelope.clone()).await.unwrap();
        let r_json = json_echo.query(envelope).await.unwrap();

        assert_eq!(
            r_pass.response.as_ref(),
            r_json.response.as_ref(),
            "query {i}: passthrough and JSON echo must produce identical bytes for canonical input"
        );
    }
}

// ============================================================================
// Golden: HandlerTable dispatch determinism
// ============================================================================

#[tokio::test]
async fn golden_handler_table_dispatch_identical_across_lookups() {
    let mut table = HandlerTable::new();
    table.register(
        "echo",
        Arc::new(PassthroughHandler) as Arc<dyn QueryHandler>,
    );

    let payload = b"handler table golden test";
    let envelope = make_envelope(payload);

    let h1 = table.get("echo").unwrap();
    let h2 = table.get("echo").unwrap();

    let r1 = h1.query(envelope.clone()).await.unwrap();
    let r2 = h2.query(envelope).await.unwrap();
    assert_eq!(
        r1.response.as_ref(),
        r2.response.as_ref(),
        "same handler from table = same result"
    );
}
