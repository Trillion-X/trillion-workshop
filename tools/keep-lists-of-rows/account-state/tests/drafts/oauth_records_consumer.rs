// OAuth Gateway -> admitted Mac connection -> the same generic records reader.
// Synthetic account, TLS issuer and record bytes only; no public activation.
use super::oauth_read_consumer_controls::start_selected_gateway;
use super::oauth_test_support::{SyntheticOAuthGrant, SyntheticOAuthIssuer};
use super::*;
use crate::native_boot::forwarder_connection::SelectedMacDispatcher;
use crate::resource_authority::InvokeChunk;
use tower::ServiceExt;

const WORDS: &str = "OAUTH_GENERIC_RECORDS_PRIVATE_CANARY";
const FOREIGN_TOKEN: &str = "synthetic-generic-records-foreign-bearer";
const FOREIGN_OWNER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn oauth_generic_write_retained_run_refuses_drop_after_dispatch_admission() {
    use crate::account_rights::run_capability::{self, ParentAuthority, Rights};
    use crate::mcp::RequestDisclosure;
    use crate::native_boot::mcp_selected_personal::{oauth_capabilities::Parent, oauth_dispatch};
    use std::sync::{Mutex, atomic::{AtomicUsize, Ordering}};

    // Exercise both outcomes through the actual selected records writer.
    // The revoking callback waits for the real RECORD_BOOK writer's held
    // transaction, after dispatch has narrowed the live Admitted capability.
    // Original OAuth, route and account gates stay live. This fixture declares
    // RECORD_BOOK as records.sqlite; native_command_context uses that same
    // source.record_book_path for both journal and record changes.
    for revoke_after_admission in [false, true] {
        let fixture = with_generic_records(Fixture::new_with_oauth_grant());
        let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
        let bearer = issuer.bearer();
        let principal = issuer.authority.principal_from_bearer(
            bearer.as_bytes(), millis() as i64,
            Instant::now() + Duration::from_secs(10),
        ).unwrap();
        let owner = Arc::new(Mutex::new(fixture.selected()));
        let parent = Arc::new(Parent::new(
            &owner, issuer.authority.clone(), &route(), &principal,
            bearer.as_bytes(), Arc::new(|| true), None,
        ));
        assert_eq!(parent.authenticate(), Ok(principal.clone()));
        let rights = Rights::declared(&json!({"rights":[{
            "kind":"note", "operations":["records:write"]
        }]})).unwrap();
        let capability = run_capability::mint_with_authority(
            OWNER, bearer.as_bytes(), rights, None, Duration::from_secs(60), parent,
        ).unwrap();
        let run = run_capability::held(capability.token().as_bytes()).unwrap().unwrap();
        let held = Arc::new(Mutex::new(Some(capability)));
        let checks = Arc::new(AtomicUsize::new(0));
        let transaction_checks = Arc::new(AtomicUsize::new(0));
        let in_transaction = transaction_checks.clone();
        let checked = checks.clone();
        let dropping = held.clone();
        let probe = Connection::open(fixture.root.join("records.sqlite")).unwrap();
        probe.busy_timeout(Duration::ZERO).unwrap();
        let probe = Mutex::new(probe);
        let current = Arc::new(move || {
            checked.fetch_add(1, Ordering::SeqCst);
            let probe = probe.lock().unwrap();
            match probe.execute_batch("BEGIN IMMEDIATE") {
                Ok(()) => probe.execute_batch("ROLLBACK").unwrap(),
                Err(rusqlite::Error::SqliteFailure(error, _))
                    if error.code == rusqlite::ErrorCode::DatabaseBusy => {
                    in_transaction.fetch_add(1, Ordering::SeqCst);
                    if revoke_after_admission {
                        drop(dropping.lock().unwrap().take());
                    }
                }
                Err(error) => panic!("unexpected synthetic writer lock probe: {error}"),
            }
            true
        });
        let call = Operation { person_present: None,
            resource: "@own-records".into(),
            operation: "records:write".into(),
            request_key: "oauth-run-commit-fence".into(),
            input: json!({"records":[{"id":"oauth-run-written-note","type":"note",
                "value":{"words":"OAUTH_RUN_COMMIT_FENCE_CANARY"}}]}),
        };
        assert!(run.narrow(&principal, &call).is_ok());
        let before = record_versions(&fixture);
        let disclosure = RequestDisclosure::default();
        let result = oauth_dispatch::invoke(
            owner, issuer.authority.clone(), &route(), &principal, bearer.as_bytes(),
            call, &disclosure, current, Some(Instant::now() + Duration::from_secs(10)), Some(&run),
        );
        assert!(checks.load(Ordering::SeqCst) > 0, "post-dispatch owner check was reached");
        assert!(transaction_checks.load(Ordering::SeqCst) > 0,
            "the real original writer must hold its transaction before the run is dropped");
        if revoke_after_admission {
            assert!(result.is_err(), "a retained Admitted must not outlive its actual run");
            assert!(run.current().is_err());
            assert_eq!(record_versions(&fixture), before,
                "revocation appends neither a record nor a command version");
            assert_eq!(issuer.authority.principal_from_bearer(
                bearer.as_bytes(), millis() as i64, Instant::now() + Duration::from_secs(5),
            ).unwrap(), principal, "the original OAuth grant remains current");
        } else {
            assert_eq!(result.unwrap(), json!({"changed":true,"write_count":1}));
            assert!(run.current().is_ok());
            assert!(record_versions(&fixture) > before, "the live control physically commits");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_oauth_clients_share_generic_records_without_sharing_grants() {
    use super::oauth_independent_grants_controls::{TOKEN_A, TOKEN_B, with_independent_grants};
    let (fixture, issuer) = with_independent_grants(Fixture::new());
    let fixture = with_generic_records(fixture);
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    let input = json!({"records":[{"id":"shared-generic-note","type":"note",
        "value":{"words":"INDEPENDENT_GENERIC_CLIENT_CANARY"}}]});
    let (_, written) = records_reply(
        app.clone(),
        TOKEN_A,
        "records:write",
        "client-a-generic-write",
        input.clone(),
    )
    .await;
    assert_eq!(written["result"]["isError"], false, "{written}");
    let committed = record_versions(&fixture);
    let read_input = json!({"id":"shared-generic-note","type":"note"});
    let (_, read) = records_reply(
        app.clone(),
        TOKEN_B,
        "records:read",
        "client-b-generic-read",
        read_input.clone(),
    )
    .await;
    assert_eq!(
        read["result"]["structuredContent"]["value"]["words"],
        "INDEPENDENT_GENERIC_CLIENT_CANARY"
    );
    assert_eq!(record_versions(&fixture), committed);
    issuer.revoke_bearer(TOKEN_A);
    let (status, _) = records_reply(
        app.clone(),
        TOKEN_A,
        "records:write",
        "client-a-generic-withdrawn",
        input,
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
    assert_eq!(record_versions(&fixture), committed);
    let (_, still_allowed) = records_reply(
        app.clone(),
        TOKEN_B,
        "records:read",
        "client-b-generic-after-a-withdrawal",
        read_input,
    )
    .await;
    assert_eq!(
        still_allowed["result"]["structuredContent"]["value"]["words"],
        "INDEPENDENT_GENERIC_CLIENT_CANARY"
    );
    assert_eq!(record_versions(&fixture), committed);
    drop(app);
    drop(gateway);
    mac.join().unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_generic_write_readback_and_lost_reply_retry_preserve_one_commit() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let before = record_versions(&fixture);
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    let input = json!({"records":[{"id":"oauth-written-note","type":"note",
        "value":{"words":"OAUTH_WRITTEN_ONCE_CANARY"}}]});
    let accepted = app
        .clone()
        .oneshot(records_request(
            &issuer.bearer(),
            "records:write",
            "oauth-generic-write-once",
            input.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), axum::http::StatusCode::OK);
    // The transport receives the accepted bytes but loses them before the
    // caller reads the result. Its original request key must recover that
    // same committed command when it asks again.
    let discarded = axum::body::to_bytes(accepted.into_body(), 65_536)
        .await
        .unwrap();
    assert!(!discarded.is_empty());
    drop(discarded);
    let after_commit = record_versions(&fixture);
    assert!(
        after_commit > before,
        "the write must actually commit before recovery is tested"
    );
    let (_, read) = records_reply(
        app.clone(),
        &issuer.bearer(),
        "records:read",
        "oauth-generic-write-readback",
        json!({"id":"oauth-written-note","type":"note"}),
    )
    .await;
    assert_eq!(read["result"]["isError"], false, "{read}");
    assert_eq!(
        read["result"]["structuredContent"]["value"]["words"],
        "OAUTH_WRITTEN_ONCE_CANARY"
    );
    assert_eq!(record_versions(&fixture), after_commit);
    let (_, recovered) = records_reply(
        app.clone(),
        &issuer.bearer(),
        "records:write",
        "oauth-generic-write-once",
        input,
    )
    .await;
    assert_eq!(recovered["result"]["isError"], false, "{recovered}");
    assert_eq!(
        recovered["result"]["structuredContent"],
        json!({"changed":true,"write_count":1})
    );
    assert_eq!(
        record_versions(&fixture),
        after_commit,
        "retry returns its saved receipt without a second version"
    );
    let (_, conflict) = records_reply(app.clone(), &issuer.bearer(), "records:write", "oauth-generic-write-once",
        json!({"records":[{"id":"oauth-written-note","type":"note","value":{"words":"MUST_NOT_REPLACE"}}]})).await;
    assert_eq!(conflict["result"]["isError"], true, "{conflict}");
    assert_eq!(
        conflict["result"]["structuredContent"]["code"],
        "original_command_conflict"
    );
    assert_eq!(
        record_versions(&fixture),
        after_commit,
        "changed-input retry changes no record or command version"
    );
    let (_, kept) = records_reply(
        app.clone(),
        &issuer.bearer(),
        "records:read",
        "oauth-generic-write-kept",
        json!({"id":"oauth-written-note","type":"note"}),
    )
    .await;
    assert_eq!(
        kept["result"]["structuredContent"]["value"]["words"],
        "OAUTH_WRITTEN_ONCE_CANARY"
    );
    drop(app);
    drop(gateway);
    mac.join().unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_generic_write_rechecks_issuer_after_gateway_admission_before_commit() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let before = record_versions(&fixture);
    // The HTTP gateway and selected Mac each authenticate this live grant.
    // It is withdrawn at the next selected-operation admission, before the
    // native writer may append or commit anything.
    issuer.revoke_on_request(3);
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    let (_, refused) = records_reply(app, &issuer.bearer(), "records:write", "oauth-generic-write-withdrawn",
        json!({"records":[{"id":"oauth-denied-note","type":"note","value":{"words":"MUST_NOT_COMMIT"}}]})).await;
    assert!(
        refused["result"]["isError"] == true || refused["error"].is_object(),
        "{refused}"
    );
    assert_eq!(
        issuer.requests(),
        3,
        "fresh operation admission must reach the now-withdrawn issuer"
    );
    assert_eq!(
        record_versions(&fixture),
        before,
        "a withdrawn grant appends neither record nor command versions"
    );
    drop(gateway);
    let _ = mac.join().unwrap();
}

/// Use the admitted synthetic browser for the existing first-start migration,
/// then prefill records through the canonical personal-key writer. Product OAuth
/// is never translated into a personal key.
pub(super) fn with_generic_records(fixture: Fixture) -> Fixture {
    fixture.prepare_current_own_records();
    let mut selected = fixture.selected();
    let operation = Operation { person_present: None,
        resource: "@own-records".into(),
        operation: "records:write".into(),
        request_key: "oauth-generic-records-prefill".into(),
        input: json!({"records":[
            {"id":"oauth-note-a","type":"note","value":{"words":WORDS}},
            {"id":"oauth-note-b","type":"note","value":{"words":"second synthetic note"}},
            {"id":"oauth-device-only","type":"voice-print","value":{"words":WORDS}}
        ]}),
    };
    let answer = selected
        .personal_records_write(
            fixture.token.as_bytes(),
            &fixture.principal(),
            &operation,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(10),
            Arc::new(|| true),
            &mut crate::record_log::CanonicalLogIds::default(),
            None,
            None,
        )
        .unwrap();
    assert_eq!(answer, json!({"changed":true,"write_count":3}));
    drop(selected);
    fixture
}

fn record_versions(fixture: &Fixture) -> i64 {
    Connection::open(fixture.root.join("records.sqlite"))
        .unwrap()
        .query_row("SELECT count(*) FROM versions", [], |row| row.get(0))
        .unwrap()
}

fn records_request(
    bearer: &str,
    method: &str,
    key: &str,
    input: Value,
) -> axum::http::Request<axum::body::Body> {
    let body = json!({"jsonrpc":"2.0","id":key,"method":"tools/call","params":{
        "name":"run_resource_operation","arguments":{"address":"@own-records","method":method,
            "request_key":key,"input":input},"_meta":{
            "io.modelcontextprotocol/protocolVersion":"2026-07-28",
            "io.modelcontextprotocol/clientInfo":{"name":"oauth-generic-records-consumer","version":"1"},
            "io.modelcontextprotocol/clientCapabilities":{}}}});
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

async fn records_reply(
    app: axum::Router,
    bearer: &str,
    method: &str,
    key: &str,
    input: Value,
) -> (axum::http::StatusCode, Value) {
    let response = app
        .oneshot(records_request(bearer, method, key, input))
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 65_536)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_generic_records_read_list_and_history_reach_the_same_selected_records() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let before = record_versions(&fixture);
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    for (index, (method, input)) in [
        ("records:read", json!({"id":"oauth-note-a","type":"note"})),
        ("records:list", json!({"type":"note","limit":10})),
        ("records:history", json!({"id":"oauth-note-a","limit":10})),
    ]
    .into_iter()
    .enumerate()
    {
        let (_, reply) = records_reply(
            app.clone(),
            &issuer.bearer(),
            method,
            &format!("oauth-generic-{index}"),
            input,
        )
        .await;
        assert_eq!(reply["result"]["isError"], false, "{reply}");
        let answer = &reply["result"]["structuredContent"];
        match method {
            "records:read" => assert_eq!(
                answer,
                &json!({"id":"oauth-note-a","type":"note","value":{"words":WORDS}})
            ),
            "records:list" => {
                let records = answer["records"].as_array().unwrap();
                assert_eq!(records.len(), 2);
                assert!(
                    records
                        .iter()
                        .any(|row| row["id"] == "oauth-note-a" && row["value"]["words"] == WORDS)
                );
                assert_eq!(answer["next"], Value::Null);
            }
            "records:history" => {
                assert_eq!(answer["versions"].as_array().unwrap().len(), 1);
                assert_eq!(answer["versions"][0]["value"]["words"], WORDS);
            }
            _ => unreachable!(),
        }
        assert_eq!(
            record_versions(&fixture),
            before,
            "a records read appends no version"
        );
    }
    drop(app);
    drop(gateway);
    mac.join().unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_generic_records_keep_device_only_kinds_on_this_computer() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let before = record_versions(&fixture);
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    for (index, (method, input)) in [
        (
            "records:read",
            json!({"id":"oauth-device-only","type":"voice-print"}),
        ),
        ("records:list", json!({"type":"voice-print","limit":10})),
        (
            "records:history",
            json!({"id":"oauth-device-only","limit":10}),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let (_, reply) = records_reply(
            app.clone(),
            &issuer.bearer(),
            method,
            &format!("oauth-device-{index}"),
            input,
        )
        .await;
        assert_eq!(reply["result"]["isError"], true, "{reply}");
        assert_eq!(
            reply["result"]["structuredContent"]["code"], "kind_stays_on_this_computer",
            "{reply}"
        );
        assert!(!reply.to_string().contains(WORDS));
        assert_eq!(record_versions(&fixture), before);
    }
    drop(app);
    drop(gateway);
    mac.join().unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_generic_record_is_withheld_if_issuer_revokes_at_final_release() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let calibration_fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let calibration = Arc::new(SyntheticOAuthIssuer::new(&calibration_fixture));
    let (calibration_app, calibration_gateway, calibration_mac) =
        start_selected_gateway(&calibration_fixture, calibration.clone()).await;
    let (_, allowed) = records_reply(
        calibration_app,
        &calibration.bearer(),
        "records:read",
        "oauth-records-calibration",
        json!({"id":"oauth-note-a","type":"note"}),
    )
    .await;
    assert_eq!(allowed["result"]["isError"], false, "{allowed}");
    assert_eq!(
        allowed["result"]["structuredContent"]["value"]["words"],
        WORDS
    );
    let final_request = calibration.requests();
    assert!(final_request > 1);
    drop(calibration_gateway);
    calibration_mac.join().unwrap().unwrap();
    issuer.revoke_on_request(final_request);
    let before = record_versions(&fixture);
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    let response = app
        .oneshot(records_request(
            &issuer.bearer(),
            "records:read",
            "oauth-records-final-withdrawal",
            json!({"id":"oauth-note-a","type":"note"}),
        ))
        .await
        .unwrap();
    // A last-chunk guard can close the body instead of issuing a protocol
    // refusal. Inspect every byte actually delivered in either case.
    let mut body = response.into_body();
    let mut received = Vec::new();
    let mut body_refused = false;
    while let Some(chunk) =
        std::future::poll_fn(|cx| http_body::Body::poll_frame(std::pin::Pin::new(&mut body), cx))
            .await
    {
        match chunk {
            Ok(chunk) => {
                if let Some(bytes) = chunk.data_ref() {
                    received.extend_from_slice(bytes);
                }
            }
            Err(_) => {
                body_refused = true;
                break;
            }
        }
    }
    assert!(
        !String::from_utf8_lossy(&received).contains(WORDS),
        "withdrawn grant disclosed protected bytes before the body ended"
    );
    if !body_refused {
        let refused: Value = serde_json::from_slice(&received).unwrap();
        assert!(
            refused["result"]["isError"] == true || refused["error"].is_object(),
            "{refused}"
        );
    }
    assert_eq!(
        issuer.requests(),
        final_request,
        "the final issuer revalidation refused"
    );
    assert_eq!(record_versions(&fixture), before);
    drop(gateway);
    let _ = mac.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_generic_records_refuse_a_valid_foreign_grant_at_gateway_and_selected_mac() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let issuer = Arc::new(SyntheticOAuthIssuer::with_grants(
        &fixture,
        vec![
            SyntheticOAuthGrant {
                bearer: "synthetic-oauth-bearer-for-selected-mcp-tests",
                account: OWNER,
                user: "synthetic-user",
                sign_in: "grant:synthetic-oauth-grant",
                client: "synthetic-oauth-client",
            },
            SyntheticOAuthGrant {
                bearer: FOREIGN_TOKEN,
                account: FOREIGN_OWNER,
                user: "synthetic-foreign-user",
                sign_in: "grant:synthetic-records-foreign",
                client: "synthetic-records-foreign-client",
            },
        ],
    ));
    let before = record_versions(&fixture);
    let (app, gateway, mac, owner) =
        super::oauth_read_consumer_controls::start_selected_gateway_and_owner(
            &fixture,
            issuer.clone(),
            Arc::new(|| true),
        )
        .await;
    let (_, refused) = records_reply(
        app.clone(),
        FOREIGN_TOKEN,
        "records:read",
        "foreign-generic-gateway",
        json!({"id":"oauth-note-a","type":"note"}),
    )
    .await;
    assert_eq!(refused["result"]["isError"], true, "{refused}");
    assert_eq!(
        refused["result"]["structuredContent"]["code"],
        "resource_route_unavailable"
    );
    assert!(!refused.to_string().contains(WORDS));
    // Every selected route field is preserved, so the Mac's authority check
    // also has to reject the otherwise valid foreign token.
    let dispatcher = SelectedMacDispatcher::new_with_oauth(
        owner,
        route(),
        issuer.authority.clone(),
        Arc::new(|| true),
        || millis() as i64,
    )
    .unwrap();
    let selected_route = route();
    let chunk = InvokeChunk { person_present: None,
        request_id: "foreign-generic-selected".into(),
        operation_resource: None,
        account_id: selected_route.account_id,
        device_id: selected_route.device_id,
        resource_address: selected_route.resource_address,
        generation: selected_route.generation,
        operation: "records:read".into(),
        input: json!({"id":"oauth-note-a","type":"note"}),
        request_key: "foreign-generic-selected".into(),
        client_authorization: FOREIGN_TOKEN.into(),
        deadline_at_ms: millis() as i64 + 10_000,
    };
    let refused = dispatcher
        .dispatch(&serde_json::to_vec(&chunk).unwrap())
        .await
        .unwrap();
    let refused: Value = serde_json::from_slice(refused.as_ref()).unwrap();
    assert_eq!(refused["state"], "refused");
    assert_eq!(refused["code"], "client_not_authorized");
    assert!(!refused.to_string().contains(WORDS));
    assert_eq!(record_versions(&fixture), before);
    drop(dispatcher);
    drop(app);
    drop(gateway);
    mac.join().unwrap().unwrap();
}
