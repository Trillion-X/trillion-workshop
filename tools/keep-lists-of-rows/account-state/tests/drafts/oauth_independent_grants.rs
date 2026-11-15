// Purpose: Exercise distinct synthetic OAuth grants through the existing SDK,
// Gateway, selected Mac dispatcher, policy gates and original SQLite writer.
// Invariants: one selected account and state; distinct client/sign-in/bearer
// identities; denied work never adds a record-log or command-journal effect.
// Security: fresh loopback TLS issuer and temporary schemas only. No real AI
// enrollment, account custody, service activation or provider-cost claim.
use super::*;
use super::current_state as state;
use super::oauth_test_support::{SyntheticOAuthGrant, SyntheticOAuthIssuer};
use super::oauth_rmcp_client_consumer_controls::client_call_on_gateway;
use super::oauth_read_consumer_controls::{oauth_read_request, start_selected_gateway};
use super::oauth_write_consumer_controls::oauth_write_request;
use crate::native_boot::forwarder_connection::SelectedMacDispatcher;
use crate::resource_authority::InvokeMessage;
use tower::ServiceExt;

pub(super) const GRANT_A: &str = "grant:synthetic-independent-a";
pub(super) const GRANT_B: &str = "grant:synthetic-independent-b";
pub(super) const TOKEN_A: &str = "synthetic-independent-bearer-a";
pub(super) const TOKEN_B: &str = "synthetic-independent-bearer-b";
const FOREIGN_TOKEN: &str = "synthetic-independent-foreign-bearer";
const FOREIGN_OWNER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn now_ms() -> i64 { i64::try_from(millis()).unwrap() }

fn independent_fixture() -> (Fixture, Arc<SyntheticOAuthIssuer>) {
    with_independent_grants(Fixture::new())
}

pub(super) fn with_independent_grants(mut fixture: Fixture) -> (Fixture, Arc<SyntheticOAuthIssuer>) {
    Connection::open(fixture.root.join("records.sqlite")).unwrap().execute(
        "UPDATE workspace_records SET value=? WHERE label='saved-board'",
        [json!({"items":["protected-original-independent-fixture"]}).to_string()],
    ).unwrap();
    fixture.prefill_named_oauth_grant_sources(GRANT_A, "oauth-a", "3", "4");
    fixture.prefill_named_oauth_grant_sources(GRANT_B, "oauth-b", "5", "6");
    fixture.prepare_current_own_records();
    let issuer = Arc::new(SyntheticOAuthIssuer::with_grants(&fixture, vec![
        SyntheticOAuthGrant { bearer: TOKEN_A, account: OWNER, user: "synthetic-user",
            sign_in: GRANT_A, client: "synthetic-independent-client-a" },
        SyntheticOAuthGrant { bearer: TOKEN_B, account: OWNER, user: "synthetic-user",
            sign_in: GRANT_B, client: "synthetic-independent-client-b" },
        SyntheticOAuthGrant { bearer: FOREIGN_TOKEN, account: FOREIGN_OWNER, user: "synthetic-other-user",
            sign_in: "grant:synthetic-independent-foreign", client: "synthetic-independent-client-foreign" },
    ]));
    (fixture, issuer)
}

pub(super) async fn http_reply(app: axum::Router, request: axum::http::Request<axum::body::Body>)
    -> (axum::http::StatusCode, Value)
{
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 65_536).await.unwrap();
    assert_no_protected_markers(&bytes);
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn assert_no_protected_markers(bytes: &[u8]) {
    let text = std::str::from_utf8(bytes).unwrap();
    for marker in ["protected-original-independent-fixture", "independent-a-committed", "independent-b-committed"] {
        assert!(!text.contains(marker), "a refused reply must not disclose a protected record marker");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn distinct_oauth_grants_share_one_committed_state_and_revocation_is_per_grant() {
    let (fixture, issuer) = independent_fixture();
    let before = state(&fixture);
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    let written = client_call_on_gateway(app.clone(), TOKEN_A.into(), "independent-sdk-client-a",
        "workspace:write", "independent-a-write",
        json!({"writes":[{"address_label":"saved-board","payload":{"items":["independent-a-committed"]}}],"conflict_policy":"retry"})).await;
    assert_eq!(written["written"], 1);
    let committed = state(&fixture);
    assert!(committed.0.contains("independent-a-committed"));
    assert!(committed.1 > before.1);
    assert_eq!(committed.2, before.2 + 1);

    let read = client_call_on_gateway(app.clone(), TOKEN_B.into(), "independent-sdk-client-b",
        "workspace:read", "independent-b-read", json!({})).await;
    assert_eq!(read["status"], 200);
    assert!(read["text"].as_str().unwrap().contains("independent-a-committed"));
    assert_eq!(state(&fixture), committed);

    issuer.revoke_bearer(TOKEN_A);
    for request in [oauth_read_request(TOKEN_A, "independent-a-revoked-read"),
        oauth_write_request(TOKEN_A, "independent-a-revoked-write")]
    {
        let (status, _) = http_reply(app.clone(), request).await;
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
        assert_eq!(state(&fixture), committed, "each denied call must leave committed records and journal unchanged");
    }
    let retained = client_call_on_gateway(app.clone(), TOKEN_B.into(), "independent-sdk-client-b",
        "workspace:read", "independent-b-after-a-revoked", json!({})).await;
    assert_eq!(retained["status"], 200);
    assert!(retained["text"].as_str().unwrap().contains("independent-a-committed"));
    assert_eq!(state(&fixture), committed);
    let b_write = client_call_on_gateway(app, TOKEN_B.into(), "independent-sdk-client-b",
        "workspace:write", "independent-b-write",
        json!({"writes":[{"address_label":"saved-board","payload":{"items":["independent-b-committed"]}}],"conflict_policy":"retry"})).await;
    assert_eq!(b_write["written"], 1);
    let after_b = state(&fixture);
    assert!(after_b.0.contains("independent-b-committed"));
    assert!(after_b.1 > committed.1);
    assert_eq!(after_b.2, committed.2 + 1);
    drop(gateway);
    mac.join().unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn valid_foreign_oauth_grant_is_refused_by_gateway_and_selected_owner() {
    let (fixture, issuer) = independent_fixture();
    let foreign = issuer.authority.validate_bearer(FOREIGN_TOKEN.as_bytes(), now_ms(),
        Instant::now() + Duration::from_secs(5)).unwrap();
    assert_eq!(foreign.account_id, FOREIGN_OWNER, "isolation must use a valid foreign grant");
    let before = state(&fixture);
    let (app, gateway, mac, owner) = super::oauth_read_consumer_controls::start_selected_gateway_and_owner(
        &fixture, issuer.clone(), Arc::new(|| true),
    ).await;
    for request in [oauth_read_request(FOREIGN_TOKEN, "foreign-read"),
        oauth_write_request(FOREIGN_TOKEN, "foreign-write")]
    {
        let (status, reply) = http_reply(app.clone(), request).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(reply["result"]["isError"], true);
        assert_eq!(reply["result"]["structuredContent"]["code"], "resource_route_unavailable");
        assert!(reply["result"]["structuredContent"]["text"].is_null());
        assert_eq!(state(&fixture), before);
    }
    // Preserve every admitted selected-route field so the actual selected
    // OAuth authority, rather than the outer route-shape guard, rejects it.
    let dispatcher = SelectedMacDispatcher::new_with_oauth(
        owner, route(), issuer.authority.clone(),
        Arc::new(|| true), now_ms).unwrap();
    let selected_route = route();
    for operation in ["workspace:read", "workspace:write"] {
        let message = InvokeMessage { person_present: None,
            request_id: format!("foreign-forged-selected-{operation}"),
            operation_resource: None,
            account_id: selected_route.account_id.clone(), device_id: selected_route.device_id.clone(),
            resource_address: selected_route.resource_address.clone(), generation: selected_route.generation.clone(),
            operation: operation.into(), input: if operation == "workspace:read" { json!({}) } else { input() },
            request_key: format!("foreign-forged-selected-{operation}"),
            client_authorization: FOREIGN_TOKEN.into(), deadline_at_ms: now_ms() + 10_000,
        };
        let refused = dispatcher.dispatch(&serde_json::to_vec(&message).unwrap()).await.unwrap();
        assert_no_protected_markers(refused.as_ref());
        let refused: Value = serde_json::from_slice(refused.as_ref()).unwrap();
        assert_eq!(refused["state"], "refused");
        assert_eq!(refused["code"], "client_not_authorized");
        assert_eq!(state(&fixture), before);
    }
    let still_current = client_call_on_gateway(app, TOKEN_B.into(), "independent-sdk-client-b",
        "workspace:read", "b-after-foreign-refusal", json!({})).await;
    assert_eq!(still_current["status"], 200);
    assert_eq!(state(&fixture), before);
    drop(dispatcher);
    drop(gateway);
    mac.join().unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selected_local_gate_withdraws_only_its_oauth_grant_while_issuer_stays_current() {
    let (fixture, issuer) = independent_fixture();
    let before = state(&fixture);
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    for (token, client, key) in [(TOKEN_A, "independent-sdk-client-a", "local-a-current"),
        (TOKEN_B, "independent-sdk-client-b", "local-b-current")]
    {
        let read = client_call_on_gateway(app.clone(), token.into(), client,
            "workspace:read", key, json!({})).await;
        assert_eq!(read["status"], 200);
        assert_eq!(state(&fixture), before);
    }
    change_gate(&fixture, "oauth-a-use.sqlite", |state| {
        state["sign_ins"][GRANT_A]["ended_until_ms"] = json!(millis() + 60_000);
    });
    let identity = issuer.authority.validate_bearer(TOKEN_A.as_bytes(), now_ms(),
        Instant::now() + Duration::from_secs(5)).unwrap();
    assert_eq!(identity.sign_in, GRANT_A, "issuer remains current while the local gate withdraws A");
    for (request, code, unknown) in [
        (oauth_read_request(TOKEN_A, "local-a-withdrawn-read"), "resource_outcome_unknown", true),
        (oauth_write_request(TOKEN_A, "local-a-withdrawn-write"), "current_workspace_rights_refused", false)]
    {
        let (status, reply) = http_reply(app.clone(), request).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(reply["result"]["isError"], true);
        assert_eq!(reply["result"]["structuredContent"]["code"], code);
        if unknown {
            assert_eq!(reply["result"]["structuredContent"]["outcome"], "unknown",
                "admission may have effects; keeping the route must preserve uncertainty");
        }
        assert!(reply["result"]["structuredContent"]["text"].is_null());
        assert_eq!(state(&fixture), before);
    }
    let read = client_call_on_gateway(app.clone(), TOKEN_B.into(), "independent-sdk-client-b",
        "workspace:read", "local-b-after-a-withdrawal", json!({})).await;
    assert_eq!(read["status"], 200);
    assert_eq!(state(&fixture), before);
    let written = client_call_on_gateway(app, TOKEN_B.into(), "independent-sdk-client-b",
        "workspace:write", "local-b-write-after-a-withdrawal",
        json!({"writes":[{"address_label":"saved-board","payload":{"items":["local-b-after-a-withdrawal-committed"]}}],"conflict_policy":"retry"})).await;
    assert_eq!(written["written"], 1);
    let after = state(&fixture);
    assert!(after.0.contains("local-b-after-a-withdrawal-committed"));
    assert!(after.1 > before.1);
    assert_eq!(after.2, before.2 + 1);
    drop(gateway);
    mac.join().unwrap().unwrap();
}
