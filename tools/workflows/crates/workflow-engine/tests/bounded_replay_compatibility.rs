//! Actual external bounded consumers retain durable start and nested replay data.
use std::sync::{Arc, Mutex};
use serde_json::{json, Value};
use workflow_core::BoundedRunLimits;
use workflow_engine::{Host, BoundedEnvelopeLimits, run_bounded_v1, run_bounded_with_start_v1};

#[derive(Default)]
struct Recording(Mutex<Vec<Value>>);
#[async_trait::async_trait]
impl Host for Recording {
    async fn ask(&self, _: &str, _: Vec<u8>, context: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
        self.0.lock().unwrap().push(serde_json::from_slice(&context.unwrap_or_default()).unwrap_or(Value::Null));
        Ok(br#"{"answer":"retained"}"#.to_vec())
    }
    async fn read(&self, _: &str) -> Result<Vec<u8>, String> { Ok(b"{}".to_vec()) }
}
fn envelope() -> BoundedEnvelopeLimits {
    BoundedEnvelopeLimits {
        max_definitions_json_bytes: 65536, max_input_json_bytes: 4096,
        max_id_bytes: 256, max_partition_bytes: 256, max_definitions: 8,
        max_total_steps: 32, max_total_edges: 32, max_nested_closure_bytes: 65536,
        max_output_json_bytes: 65536,
    }
}
fn execution() -> BoundedRunLimits {
    BoundedRunLimits { max_step_attempts: 16, max_loop_iterations: 16, max_action_depth: 8 }
}
fn nested() -> String {
    json!([
        {"id":"root","name":"Root","kind":"workflow","is_active":true,"version":1,
         "steps":[{"id":"call","kind":"action","config":{"definition_id":"child","inputs":{}}}]},
        {"id":"child","name":"Child","kind":"action","is_active":true,"version":1,
         "steps":[{"id":"ask","kind":"ask","config":{"name":"tool:answer","input":{}}}]}
    ]).to_string()
}

#[tokio::test]
async fn cold_replay_preserves_start_fields_and_nested_runtime_outputs() {
    let definitions = nested();
    let started = "2026-10-14T16:20:00.000Z";
    for _ in 0..2 {
        let host = Arc::new(Recording::default());
        let raw = run_bounded_with_start_v1(&definitions, "root", "{}", "person:test", "example", started, Some("original-start"), envelope(), execution(), host.clone()).await.unwrap();
        let response: Value = serde_json::from_str(&raw).unwrap();
        let result = &response["result"];
        assert_eq!(result["status"], "completed");
        assert_eq!(result["started_at"], started);
        assert_eq!(result["start_id"], "original-start");
        assert_eq!(result["execution_context"]["start"]["started_at"], started);
        assert_eq!(result["execution_context"]["start"]["start_id"], "original-start");
        let contexts = host.0.lock().unwrap();
        let identity = contexts[0]["_runtime_identity"].as_array().expect("nested ask identity");
        assert_eq!(identity.len(), 2);
        let key = serde_json::to_string(identity).unwrap();
        assert_eq!(result["runtime_outputs"][&key]["output"]["answer"], "retained");
        assert_eq!(response["usage"]["step_attempts"], 2);
        assert_eq!(response["usage"]["action_depth"], 1);
    }
}

#[tokio::test]
async fn start_identity_and_timestamp_wire_caps_precede_parsing_and_dispatch() {
    let host = Arc::new(Recording::default());
    let mut caps = envelope(); caps.max_input_json_bytes = 2;
    let refusal = run_bounded_with_start_v1("not JSON", "ok", "{}", "ok", "example", "long-start", None, caps, execution(), host.clone()).await.unwrap_err();
    assert!(refusal.contains("started_at_bytes"), "{refusal}");
    let mut caps = envelope(); caps.max_id_bytes = 2;
    let refusal = run_bounded_with_start_v1("not JSON", "ok", "{}", "ok", "example", "", Some("long-start"), caps, execution(), host.clone()).await.unwrap_err();
    assert!(refusal.contains("start_id_bytes"), "{refusal}");
    assert!(host.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn bounded_v1_without_replay_fields_keeps_original_signature_and_shape() {
    let raw = run_bounded_v1(&nested(), "root", "{}", "person:test", "example", envelope(), execution(), Arc::new(Recording::default())).await.unwrap();
    let response: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(response["result"]["status"], "completed");
    assert_eq!(response["result"]["execution_context"]["start"]["started_at"], "");
    assert!(response["result"]["start_id"].is_null());
    assert!(response["result"]["runtime_outputs"].is_object());
}

#[tokio::test]
async fn runtime_output_addition_remains_inside_the_original_serialization_cap() {
    let host = Arc::new(Recording::default());
    let mut caps = envelope(); caps.max_output_json_bytes = 32;
    let refusal = run_bounded_with_start_v1(&nested(), "root", "{}", "person:test", "example", "original", None, caps, execution(), host).await.unwrap_err();
    assert!(refusal.contains("FE_PAYLOAD_TOO_LARGE"), "{refusal}");
    assert!(refusal.len() <= 512);
}
