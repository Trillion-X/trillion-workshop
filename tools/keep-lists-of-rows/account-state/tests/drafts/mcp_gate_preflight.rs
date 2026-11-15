// Actual selected MCP read with an existing read-only own-gate source.
// These filesystem controls distinguish a no-effect admission from a required
// first-use mutation; they do not count internal calls or replace the reader.
use super::*;
use tower::ServiceExt;

#[tokio::test]
async fn mcp_gate_preflight_existing_vouch_reads_readonly_gate_without_effects() {
    for protocol in ["2025-06-18", "2026-07-28"] {
        let fixture = Fixture::new();
        fs::set_permissions(fixture.root.join("own.sqlite"), fs::Permissions::from_mode(0o400)).unwrap();
        let before = state(&fixture);
        let app = crate::native_boot::mcp_local::route_table(
            Arc::new(std::sync::Mutex::new(fixture.selected())),
            "127.0.0.1:28788".into(),
        ).unwrap();
        let response = app.oneshot(local_read_http_request_for_protocol(
            &fixture, "readonly-own-gate", "synthetic-reader", "@own-records", protocol,
        )).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{protocol}");
        let bytes = axum::body::to_bytes(response.into_body(), 65_536).await.unwrap();
        let reply: Value = serde_json::from_slice(&bytes).unwrap();
        let result = &reply["result"]["structuredContent"];
        assert_eq!(result["status"], 200, "{protocol}: {}", reply["result"]["isError"]);
        let canonical: Value = serde_json::from_str(result["text"].as_str().unwrap()).unwrap();
        assert_eq!(canonical["records"]["saved-board"], json!({"items":["kept"]}));
        assert_eq!(state(&fixture), before, "readonly admission must not append record/journal effects");
    }
}

#[tokio::test]
async fn mcp_gate_preflight_first_use_cannot_bypass_required_registration_write() {
    for protocol in ["2025-06-18", "2026-07-28"] {
        let fixture = Fixture::new();
        change_gate(&fixture, "own.sqlite", |state| {
            state["sign_ins"].as_object_mut().unwrap().remove(&fixture.signin);
        });
        fs::set_permissions(fixture.root.join("own.sqlite"), fs::Permissions::from_mode(0o400)).unwrap();
        let before = state(&fixture);
        let app = crate::native_boot::mcp_local::route_table(
            Arc::new(std::sync::Mutex::new(fixture.selected())),
            "127.0.0.1:28788".into(),
        ).unwrap();
        let response = app.oneshot(local_read_http_request_for_protocol(
            &fixture, "readonly-first-use", "synthetic-reader", "@own-records", protocol,
        )).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{protocol}");
        let bytes = axum::body::to_bytes(response.into_body(), 65_536).await.unwrap();
        let reply: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(reply["result"]["isError"], true, "unregistered readonly gate: {protocol}");
        assert!(reply["result"]["structuredContent"]["text"].is_null());
        assert_eq!(state(&fixture), before, "refusal must not append record/journal effects");
    }
}
