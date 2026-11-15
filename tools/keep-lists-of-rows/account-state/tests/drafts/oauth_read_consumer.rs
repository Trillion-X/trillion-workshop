// Server-SDK HTTP request -> Gateway -> registered route -> selected Mac
// dispatcher -> guarded read chunk. OAuth issuer and all account data are synthetic.
use super::*;
use super::current_state as state;
use crate::{
    native_boot::{forwarder_connection::SelectedMacDispatcher, oauth_gateway::{OAuthBearerAuthenticator, OAuthBearerForwarder}},
    forwarder::{gateway::Gateway, session::{ConnectionAdmission, ConnectionGrant}},
    resource_authority::Route,
};
use std::{
    io,
    os::unix::net::UnixStream,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread,
};
use tower::ServiceExt;

fn oauth_now() -> i64 { millis() as i64 }

fn sdk_reply_category(bytes: &[u8]) -> &'static str {
    let Ok(reply) = serde_json::from_slice::<Value>(bytes) else { return "invalid-json"; };
    if reply.get("error").is_some_and(Value::is_object) { return "rpc-error"; }
    let structured = &reply["result"]["structuredContent"];
    if structured["status"].as_u64().is_some() { return "structured-http-answer"; }
    if reply["result"]["isError"].as_bool() == Some(true) {
        return match structured["code"].as_str() {
            Some("resource_outcome_unknown") => "resource-outcome-unknown",
            Some("current_workspace_rights_refused") => "rights-refused",
            Some("original_workspace_source_unavailable") => "workspace-source-unavailable",
            Some("original_workspace_read_unavailable") => "workspace-read-unavailable",
            Some("original_read_output_unavailable") => "protected-output-unavailable",
            _ => "other-tool-error",
        };
    }
    "other-json-reply"
}

struct SyntheticRouteAdmission { route: Route }
impl ConnectionAdmission for SyntheticRouteAdmission {
    fn admit(&self, credential: &[u8], now_ms: i64) -> Option<ConnectionGrant> {
        if credential != b"synthetic-selected-mac-device" || now_ms <= 0 { return None; }
        Some(ConnectionGrant {
            route: self.route.clone(),
            expires_at_ms: now_ms.checked_add(60_000)?,
            admission_identity: Some("synthetic-selected-mac-registration".into()),
        })
    }
    fn is_current(&self, grant: &ConnectionGrant, now_ms: i64) -> bool {
        grant.route == self.route && now_ms > 0 && now_ms < grant.expires_at_ms
            && grant.admission_identity.as_deref() == Some("synthetic-selected-mac-registration")
    }
}

pub(super) async fn start_selected_gateway(
    fixture: &Fixture,
    issuer: Arc<super::oauth_test_support::SyntheticOAuthIssuer>,
) -> (axum::Router, Arc<Gateway>, thread::JoinHandle<io::Result<()>>) {
    start_selected_gateway_with_parent_current(fixture, issuer, Arc::new(|| true)).await
}

pub(super) async fn start_selected_gateway_with_parent_current(
    fixture: &Fixture,
    issuer: Arc<super::oauth_test_support::SyntheticOAuthIssuer>,
    parent_connection_current: crate::native_boot::mcp_selected_personal::oauth_policy_witness::ParentConnectionCurrent,
) -> (axum::Router, Arc<Gateway>, thread::JoinHandle<io::Result<()>>) {
    let (app, gateway, mac, _) = start_selected_gateway_and_owner(
        fixture, issuer, parent_connection_current,
    ).await;
    (app, gateway, mac)
}

pub(super) async fn start_selected_gateway_and_owner(
    fixture: &Fixture,
    issuer: Arc<super::oauth_test_support::SyntheticOAuthIssuer>,
    parent_connection_current: crate::native_boot::mcp_selected_personal::oauth_policy_witness::ParentConnectionCurrent,
) -> (axum::Router, Arc<Gateway>, thread::JoinHandle<io::Result<()>>, Arc<Mutex<crate::native_boot::SelectedAccount>>) {
    fixture.prepare_current_own_records();
    let selected_route = route();
    let admission = Arc::new(SyntheticRouteAdmission { route: selected_route.clone() });
    let authority = issuer.authority.clone();
    let gateway = Arc::new(Gateway::new(
        "127.0.0.1:28788",
        Arc::new(OAuthBearerAuthenticator::new(authority.clone(), oauth_now)),
        Arc::new(OAuthBearerForwarder {}),
        admission,
        oauth_now,
    ));
    let (gateway_stream, mac_stream) = UnixStream::pair().unwrap();
    let owner = Arc::new(Mutex::new(fixture.selected()));
    let retained_owner = owner.clone();
    let runtime = tokio::runtime::Handle::current();
    let mac_authority = authority.clone();
    let route_for_mac = selected_route.clone();
    let mac_now = oauth_now;
    let mac = thread::spawn(move || {
        let dispatcher = SelectedMacDispatcher::new_with_oauth(
            owner, route_for_mac.clone(), mac_authority, parent_connection_current, mac_now,
        ).unwrap();
        let result = crate::forwarder::session::connect_mac_session_with_admission(
            mac_stream,
            b"synthetic-selected-mac-device",
            &route_for_mac,
            oauth_now,
            || Ok(()),
            |bytes| runtime.block_on(dispatcher.dispatch(bytes)),
        );
        result
    });
    let admission_gateway = gateway.clone();
    let admitted = tokio::task::spawn_blocking(move || {
        admission_gateway.admit_mac_connection(gateway_stream)
    }).await.unwrap();
    let admitted_route = admitted.unwrap();
    assert_eq!(admitted_route, selected_route, "the Mac must use the actually admitted registered route");
    let app = crate::mcp::http::axum_adapter::route_table(gateway.http_service().unwrap());
    (app, gateway, mac, retained_owner)
}

pub(super) fn oauth_read_request(bearer: &str, key: &str) -> axum::http::Request<axum::body::Body> {
    let body = json!({
        "jsonrpc":"2.0", "id":"oauth-read-sdk", "method":"tools/call",
        "params": {
            "name":"run_resource_operation",
            "arguments": {
                "address":"@own-records", "method":"workspace:read",
                "request_key":key, "input":{}
            },
            "_meta":{
                "io.modelcontextprotocol/protocolVersion":"2026-07-28",
                "io.modelcontextprotocol/clientInfo":{"name":"oauth-read-consumer","version":"1"},
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
async fn server_sdk_http_oauth_read_is_withheld_when_grant_is_revoked_before_mac_final_chunk() {
    let fixture = Fixture::new_with_oauth_grant();
    let issuer = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&fixture));
    let bearer = issuer.bearer();
    let before = state(&fixture);
    let calibration_fixture = Fixture::new_with_oauth_grant();
    let calibration = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&calibration_fixture));
    let calibration_bearer = calibration.bearer();
    let (calibration_app, calibration_gateway, calibration_mac) = start_selected_gateway(&calibration_fixture, calibration.clone()).await;
    let calibration_response = calibration_app.oneshot(oauth_read_request(&calibration_bearer, "oauth-read-calibration")).await.unwrap();
    let calibration_status = calibration_response.status();
    // The selected Mac has finished; HTTP body consumption has its own later issuer check.
    let final_validation_number = calibration.requests();
    let calibration_bytes = axum::body::to_bytes(calibration_response.into_body(), 65_536).await.unwrap();
    assert_eq!(calibration_status, axum::http::StatusCode::OK,
        "calibration SDK status; reply-category={}; issuer diagnostics={:?}",
        sdk_reply_category(&calibration_bytes), calibration.diagnostics());
    let calibration_category = sdk_reply_category(&calibration_bytes);
    drop(calibration_bytes);
    drop(calibration_gateway);
    let calibration_mac_result = calibration_mac.join().unwrap();
    assert!(calibration_mac_result.is_ok(),
        "calibration Mac dispatch failed; SDK reply-category={}; issuer diagnostics={:?}",
        calibration_category, calibration.diagnostics());
    assert!(final_validation_number > 1,
        "calibration validation count={final_validation_number}; issuer diagnostics={:?}", calibration.diagnostics());
    issuer.revoke_on_request(final_validation_number);
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;

    let response = app.oneshot(oauth_read_request(&bearer, "oauth-read-revoke-final-frame"))
        .await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 65_536).await.unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("saved-board"),
        "no SDK result may contain the protected projection after revocation");
    let reply: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(reply["result"]["isError"].as_bool().unwrap_or(false)
        || reply["error"].is_object(), "revoked result must be a protocol error");
    assert_eq!(issuer.requests(), final_validation_number, "the final release revalidation must be the refused issuer call");
    assert_eq!(state(&fixture), before, "read and withheld output do not mutate business records");
    drop(bytes);
    drop(gateway);
    let _ = mac.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_sdk_http_oauth_read_returns_selected_projection_while_grant_is_current() {
    let fixture = Fixture::new_with_oauth_grant();
    let issuer = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&fixture));
    let bearer = issuer.bearer();
    let before = state(&fixture);
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    let response = app.oneshot(oauth_read_request(&bearer, "oauth-read-sdk-current"))
        .await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 65_536).await.unwrap();
    assert_eq!(status, axum::http::StatusCode::OK,
        "SDK status; reply-category={}; issuer diagnostics={:?}",
        sdk_reply_category(&bytes), issuer.diagnostics());
    let reply: Value = serde_json::from_slice(&bytes).unwrap();
    let structured = &reply["result"]["structuredContent"];
    assert_eq!(reply["id"], "oauth-read-sdk");
    assert_eq!(structured["status"], 200,
        "SDK reply-category={}; issuer diagnostics={:?}",
        sdk_reply_category(&bytes), issuer.diagnostics());
    assert_eq!(structured["request_key"], "oauth-read-sdk-current");
    assert!(structured["text"].as_str().unwrap().contains("saved-board"));
    assert_eq!(state(&fixture), before, "workspace read has no business-record effects");
    drop(bytes);
    drop(gateway);
    mac.join().unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_sdk_http_oauth_read_rechecks_parent_connection_currentness() {
    let fixture = Fixture::new_with_oauth_grant();
    let issuer = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&fixture));
    let bearer = issuer.bearer();
    let parent_current = Arc::new(AtomicBool::new(true));
    let current_for_callback = parent_current.clone();
    let parent_current_callback: crate::native_boot::mcp_selected_personal::oauth_policy_witness::ParentConnectionCurrent =
        Arc::new(move || current_for_callback.load(Ordering::Acquire));
    let (app, gateway, mac) = start_selected_gateway_with_parent_current(
        &fixture, issuer.clone(), parent_current_callback,
    ).await;

    let first = app.clone().oneshot(oauth_read_request(&bearer, "oauth-read-parent-current"))
        .await.unwrap();
    assert_eq!(first.status(), axum::http::StatusCode::OK);
    let first_bytes = axum::body::to_bytes(first.into_body(), 65_536).await.unwrap();
    let first_reply: Value = serde_json::from_slice(&first_bytes).unwrap();
    assert_eq!(first_reply["result"]["structuredContent"]["status"], 200,
        "initial reply-category={}; issuer diagnostics={:?}",
        sdk_reply_category(&first_bytes), issuer.diagnostics());
    let validations_before_withdrawal = issuer.requests();

    parent_current.store(false, Ordering::Release);
    let withdrawn = app.oneshot(oauth_read_request(&bearer, "oauth-read-parent-withdrawn"))
        .await.unwrap();
    assert_eq!(withdrawn.status(), axum::http::StatusCode::OK);
    let withdrawn_bytes = axum::body::to_bytes(withdrawn.into_body(), 65_536).await.unwrap();
    assert!(!String::from_utf8_lossy(&withdrawn_bytes).contains("saved-board"),
        "withdrawn parent connection must not disclose the projection");
    assert_eq!(issuer.requests(), validations_before_withdrawal + 1,
        "HTTP bearer authentication is the only Worker call; withdrawn parent currentness must block selected-Mac validation");
    drop(first_bytes);
    drop(withdrawn_bytes);
    drop(gateway);
    let _ = mac.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_sdk_http_oauth_read_withholds_when_parent_withdraws_at_final_chunk() {
    let fixture = Fixture::new_with_oauth_grant();
    let issuer = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&fixture));
    let bearer = issuer.bearer();
    let parent_checks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let checks_for_callback = parent_checks.clone();
    // The first ten checks cover dispatcher admission, OAuth/gate preparation,
    // projection preparation, and its last-current check. The next check is
    // the retained last-chunk release check.
    let parent_current_callback: crate::native_boot::mcp_selected_personal::oauth_policy_witness::ParentConnectionCurrent =
        Arc::new(move || checks_for_callback.fetch_add(1, Ordering::AcqRel) < 10);
    let (app, gateway, mac) = start_selected_gateway_with_parent_current(
        &fixture, issuer.clone(), parent_current_callback,
    ).await;
    let response = app.oneshot(oauth_read_request(&bearer, "oauth-read-parent-withdrawn-final-frame"))
        .await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 65_536).await.unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("saved-board"),
        "withdrawal at the last-chunk check must withhold the prepared projection");
    assert_eq!(sdk_reply_category(&bytes), "resource-outcome-unknown",
        "the read was prepared but its final parent-currentness check failed");
    assert_eq!(parent_checks.load(Ordering::Acquire), 11,
        "the final release check must be the first check that observes withdrawal");
    assert_eq!(issuer.requests(), 7,
        "the final Worker revalidation must not run after parent-currentness withdrawal");
    drop(bytes);
    drop(gateway);
    let _ = mac.join().unwrap();
}


#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_sdk_http_oauth_read_keeps_projection_snapshot_after_last_current_validation() {
    // Calibrate with a real current selected read. The mutation below happens
    // only after the final canonical issuer validation, not at an assumed phase.
    let calibration_fixture = Fixture::new_with_oauth_grant();
    let calibration = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&calibration_fixture));
    let calibration_bearer = calibration.bearer();
    let (calibration_app, calibration_gateway, calibration_mac) =
        start_selected_gateway(&calibration_fixture, calibration.clone()).await;
    let calibration_response = calibration_app.oneshot(oauth_read_request(
        &calibration_bearer, "oauth-read-source-order-calibration",
    )).await.unwrap();
    assert_eq!(calibration_response.status(), axum::http::StatusCode::OK);
    let final_validation_number = calibration.requests();
    let calibration_bytes = axum::body::to_bytes(calibration_response.into_body(), 65_536).await.unwrap();
    let calibration_reply: Value = serde_json::from_slice(&calibration_bytes).unwrap();
    let total_validation_number = calibration.requests();
    assert_eq!(calibration_reply["result"]["structuredContent"]["status"], 200,
        "calibration reply-category={}; issuer diagnostics={:?}",
        sdk_reply_category(&calibration_bytes), calibration.diagnostics());
    assert!(final_validation_number > 1);
    drop(calibration_bytes);
    drop(calibration_gateway);
    calibration_mac.join().unwrap().unwrap();

    let fixture = Fixture::new_with_oauth_grant();
    let issuer = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&fixture));
    let bearer = issuer.bearer();
    let changed = Arc::new(AtomicBool::new(false));
    let changed_for_callback = changed.clone();
    let issuer_for_callback = issuer.clone();
    let records = fixture.root.join("records.sqlite");
    let parent_current: crate::native_boot::mcp_selected_personal::oauth_policy_witness::ParentConnectionCurrent =
        Arc::new(move || {
            if issuer_for_callback.requests() == final_validation_number
                && changed_for_callback.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                use crate::records::Records;
                let resource = crate::workspace_store::resource().unwrap();
                let mut store = crate::storage::record_store_resources::open(
                    &records, crate::sqlite_work::WorkMeter::new(),
                ).unwrap();
                let before = store.held_version(OWNER, resource, "saved-board").unwrap();
                assert!(before > 0, "the actual record store workspace row must already exist");
                let changed = store.mutate(OWNER, resource, crate::records::Mutation {
                    id: "saved-board".into(), expected_version: before,
                    request_key: "oauth-read-source-order-later-commit".into(),
                    deleted: false, value: Value::String("false".into()),
                }).unwrap();
                assert_eq!(changed.version, before + 1,
                    "the actual retained projection must change exactly once at the calibrated final check");
                assert_eq!(store.get(OWNER, resource, "saved-board").unwrap().record.unwrap().value,
                    Value::String("false".into()));
            }
            true
        });
    let (app, gateway, mac) = start_selected_gateway_with_parent_current(
        &fixture, issuer.clone(), parent_current,
    ).await;
    let response = app.oneshot(oauth_read_request(&bearer, "oauth-read-source-order-withdrawal")).await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 65_536).await.unwrap();
    assert!(changed.load(Ordering::Acquire), "control must reach the calibrated final current check");
    let reply: Value = serde_json::from_slice(&bytes).unwrap();
    let structured = &reply["result"]["structuredContent"];
    assert_eq!(structured["status"], 200,
        "a later commit must preserve an admitted consistent workspace snapshot");
    let projection: Value = serde_json::from_str(structured["text"].as_str().unwrap()).unwrap();
    assert_eq!(projection["records"]["saved-board"], json!({"items":["kept"]}),
        "deliver the original admitted snapshot while the canonical store has the later value");
    assert_eq!(issuer.requests(), total_validation_number,
        "the forwarder retains its own final OAuth check after the selected Mac's physical projection check");
    drop(bytes);
    drop(gateway);
    let _ = mac.join().unwrap();
}
