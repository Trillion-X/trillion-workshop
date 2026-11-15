// Server-SDK HTTP protocol request -> Gateway -> registered route -> selected Mac
// dispatcher -> original workspace commit and protected result custody. The
// request is encoded directly; a separate fixture owns the actual rmcp client.
use super::*;
use super::current_state as state;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{sync::Arc, thread};
use tower::ServiceExt;

pub(super) fn oauth_write_request(bearer: &str, key: &str) -> axum::http::Request<axum::body::Body> {
    let body = json!({
        "jsonrpc":"2.0", "id":"oauth-write-sdk", "method":"tools/call",
        "params": {
            "name":"run_resource_operation",
            "arguments": {
                "address":"@own-records", "method":"workspace:write",
                "request_key":key, "input":input()
            },
            "_meta": {
                "io.modelcontextprotocol/protocolVersion":"2026-07-28",
                "io.modelcontextprotocol/clientInfo":{"name":"oauth-write-fixture","version":"1"},
                "io.modelcontextprotocol/clientCapabilities":{}
            }
        }
    });
    axum::http::Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("Host", "127.0.0.1:28788")
        .header("Authorization", format!("Bearer {bearer}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", "tools/call")
        .header("Mcp-Name", "run_resource_operation")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_sdk_http_oauth_write_commits_once_and_returns_the_protected_result() {
    let fixture = Fixture::new_with_oauth_grant();
    let issuer = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&fixture));
    let bearer = issuer.bearer();
    let before = state(&fixture);
    let (app, gateway, mac) = super::oauth_read_consumer_controls::start_selected_gateway(
        &fixture, issuer.clone(),
    ).await;
    let response = app.oneshot(oauth_write_request(&bearer, "oauth-write-sdk-current"))
        .await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 65_536).await.unwrap();
    let reply: Value = serde_json::from_slice(&bytes).unwrap();
    let structured = &reply["result"]["structuredContent"];
    assert_eq!(reply["id"], "oauth-write-sdk");
    assert_eq!(structured["written"], 1);
    let after = state(&fixture);
    assert!(after.0.contains("written"));
    assert!(after.1 > before.1, "the original record log must contain the commit");
    assert_eq!(after.2, before.2 + 1, "one SDK operation creates one original command");
    assert!(issuer.requests() >= 4, "issuer validates Gateway, selected authority and protected release");
    drop(bytes);
    drop(gateway);
    mac.join().unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_sdk_http_oauth_write_keeps_commit_but_withholds_result_after_final_revalidation_refusal() {
    let calibration_fixture = Fixture::new_with_oauth_grant();
    let calibration = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&calibration_fixture));
    let calibration_bearer = calibration.bearer();
    let (calibration_app, calibration_gateway, calibration_mac) =
        super::oauth_read_consumer_controls::start_selected_gateway(
            &calibration_fixture, calibration.clone(),
        ).await;
    let calibration_response = calibration_app
        .oneshot(oauth_write_request(&calibration_bearer, "oauth-write-calibration"))
        .await.unwrap();
    let calibration_body = axum::body::to_bytes(calibration_response.into_body(), 65_536).await.unwrap();
    let calibration_reply: Value = serde_json::from_slice(&calibration_body).unwrap();
    assert_eq!(calibration_reply["result"]["structuredContent"]["written"], 1,
        "calibration must complete the protected write before selecting a release-stage request; failure code={:?}",
        calibration_reply["result"]["structuredContent"]["code"].as_str());
    assert!(state(&calibration_fixture).0.contains("written"),
        "calibration must observe the original committed record");
    let final_validation_number = calibration.requests();
    assert!(final_validation_number > 1);
    drop(calibration_body);
    drop(calibration_gateway);
    calibration_mac.join().unwrap().unwrap();

    let fixture = Fixture::new_with_oauth_grant();
    let issuer = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&fixture));
    let bearer = issuer.bearer();
    issuer.revoke_on_request(final_validation_number);
    let before = state(&fixture);
    let (app, gateway, mac) = super::oauth_read_consumer_controls::start_selected_gateway(
        &fixture, issuer.clone(),
    ).await;
    let response = app.oneshot(oauth_write_request(&bearer, "oauth-write-withheld-final-frame"))
        .await.unwrap();
    let body = axum::body::to_bytes(response.into_body(), 65_536).await;
    let bytes = body.unwrap_or_default();
    assert!(!String::from_utf8_lossy(&bytes).contains("written"),
        "a committed write result must not escape after its final authority check fails");
    assert_eq!(issuer.requests(), final_validation_number,
        "the refused validation must actually reach the calibrated request before interpreting the commit state");
    let after = state(&fixture);
    assert!(after.0.contains("written"), "the original write committed before result release");
    assert!(after.1 > before.1, "the original record log records the durable commit");
    assert_eq!(after.2, before.2 + 1, "withholding the result must not replay the command");
    assert_eq!(issuer.requests(), final_validation_number,
        "the exact final-result revalidation is refused by the synthetic issuer");
    drop(bytes);
    drop(gateway);
    let _ = mac.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_sdk_http_oauth_write_withholds_result_after_parent_connection_withdrawal() {
    let calibration_fixture = Fixture::new_with_oauth_grant();
    let calibration_issuer = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&calibration_fixture));
    let calibration_bearer = calibration_issuer.bearer();
    let calibration_calls = Arc::new(AtomicUsize::new(0));
    let calibration_probe = {
        let calls = calibration_calls.clone();
        Arc::new(move || {
            calls.fetch_add(1, Ordering::AcqRel);
            true
        })
    };
    let (calibration_app, calibration_gateway, calibration_mac) =
        super::oauth_read_consumer_controls::start_selected_gateway_with_parent_current(
            &calibration_fixture, calibration_issuer.clone(), calibration_probe,
        ).await;
    let calibration_response = calibration_app
        .oneshot(oauth_write_request(&calibration_bearer, "oauth-write-parent-calibration"))
        .await.unwrap();
    let calibration_body = axum::body::to_bytes(calibration_response.into_body(), 65_536).await.unwrap();
    let calibration_reply: Value = serde_json::from_slice(&calibration_body).unwrap();
    assert_eq!(calibration_reply["result"]["structuredContent"]["written"], 1);
    let successful_parent_checks = calibration_calls.load(Ordering::Acquire);
    assert!(successful_parent_checks > 2, "the parent check must run at operation and custody boundaries");
    drop(calibration_body);
    drop(calibration_gateway);
    calibration_mac.join().unwrap().unwrap();

    let fixture = Fixture::new_with_oauth_grant();
    let issuer = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&fixture));
    let bearer = issuer.bearer();
    let calls = Arc::new(AtomicUsize::new(0));
    let parent_probe = {
        let calls = calls.clone();
        Arc::new(move || calls.fetch_add(1, Ordering::AcqRel) + 1 < successful_parent_checks)
    };
    let before = state(&fixture);
    let (app, gateway, mac) = super::oauth_read_consumer_controls::start_selected_gateway_with_parent_current(
        &fixture, issuer.clone(), parent_probe,
    ).await;
    let response = app.oneshot(oauth_write_request(&bearer, "oauth-write-parent-withheld"))
        .await.unwrap();
    let body = axum::body::to_bytes(response.into_body(), 65_536).await;
    let bytes = body.unwrap_or_default();
    assert!(!String::from_utf8_lossy(&bytes).contains("written"),
        "parent withdrawal must stop protected result disclosure");
    let after = state(&fixture);
    assert!(after.0.contains("written"), "the original write committed before parent withdrawal");
    assert!(after.1 > before.1, "the original record log records the durable commit");
    assert_eq!(after.2, before.2 + 1, "withholding the result must not replay the command");
    assert_eq!(calls.load(Ordering::Acquire), successful_parent_checks,
        "the parent withdrawal must be observed at the same final custody boundary");
    drop(bytes);
    drop(gateway);
    let _ = mac.join().unwrap();
}
