// Real SDK HTTP -> gateway -> selected Mac instruction projection. All rows,
// account settings, grant identities and TLS are synthetic.
use super::oauth_read_consumer_controls::start_selected_gateway;
use super::oauth_records_consumer_controls::with_generic_records;
use super::oauth_test_support::SyntheticOAuthIssuer;
use super::*;
use tower::ServiceExt;

const PRIVATE_WORDS: &str = "ONLY_THIS_ACCOUNT_INSTRUCTION_CANARY";

fn fixture() -> Fixture {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let folder = fixture.root.join("workshop/tools/any-folder");
    fs::create_dir_all(&folder).unwrap();
    // The tools declare their list by a row of the instruction kind, never by this folder's name.
    let source = json!({"records":[{"payload":{"kind":"ai-instruction-source","id":"source","file":"rows.json"}}]});
    fs::write(folder.join("tool-rows.json"), source.to_string()).unwrap();
    let list = json!({"records":[
        {"payload":{"kind":"ai-instruction-settings","id":"settings","setting":{"type":"setting","record_prefix":"setting:ai-instruction:"},
            "limits":{"person_rows":20,"text_bytes":2000,"initialize_bytes":4000,"page_bytes":4000},
            "read":{"resource":"@own-records","operation":"instructions:read","more":"Read the rest after {order}."}}},
        {"payload":{"kind":"ai-instruction","id":"first","order":10,"text":"SHIPPED_FALLBACK_MUST_BE_REPLACED"}},
        {"payload":{"kind":"ai-instruction","id":"tool","order":20,"text":"SHIPPED_TOOL_FALLBACK","reaches":["tool-description"]}}
    ]});
    fs::write(folder.join("rows.json"), list.to_string()).unwrap();
    let workshop = crate::tool_runs::tools::shipped().unwrap();
    let place = crate::tool_runs::tools::Place {
        account: OWNER,
        state_root: &fixture.root,
        door: None,
        origin: None,
    };
    let bytes = workshop
        .instruction_file(&place)
        .expect("the selected fixture Workshop instruction file");
    crate::mcp::instructions::Shipped::from_data(&bytes)
        .expect("synthetic instruction DATA parses");
    let mut selected = fixture.selected();
    let call = Operation { person_present: None,
        resource: "@own-records".into(),
        operation: "records:write".into(),
        request_key: "instruction-own-override".into(),
        input: json!({"records":[
            {"id":"setting:ai-instruction:first","type":"setting","value":{"value":{"text":PRIVATE_WORDS}}},
            {"id":"setting:ai-instruction:tool","type":"setting","value":{"value":{"text":format!("Tool: {PRIVATE_WORDS}")}}}
        ]}),
    };
    selected
        .personal_records_write(
            fixture.token.as_bytes(),
            &fixture.principal(),
            &call,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(10),
            Arc::new(|| true),
            &mut crate::record_log::CanonicalLogIds::default(),
            None,
            None,
        )
        .unwrap();
    drop(selected);
    fixture
}

#[test]
fn only_the_declared_instruction_file_is_read_and_missing_data_fails_closed() {
    let fixture = fixture();
    let selected = fixture.selected();
    let (account, state_root) = selected.tool_place();
    let place = crate::tool_runs::tools::Place {
        account: &account,
        state_root: &state_root,
        door: None,
        origin: None,
    };
    let workshop = crate::tool_runs::tools::shipped().unwrap();

    assert!(workshop.instruction_file(&place).is_some());

    let folder = fixture.root.join("workshop/tools/any-folder");
    fs::remove_file(folder.join("rows.json")).unwrap();
    assert!(workshop.instruction_file(&place).is_none());
    assert!(crate::mcp::instructions::Told::shipped_only(&|| workshop.instruction_file(&place)).is_err());
}

async fn response(
    app: axum::Router,
    bearer: &str,
    method: &str,
    params: Value,
) -> axum::response::Response {
    let method = if method == "discover" {
        "server/discover"
    } else {
        method
    };
    let protocol = if method == "initialize" {
        "2025-06-18"
    } else {
        "2026-07-28"
    };
    let mut body = json!({"jsonrpc":"2.0","id":method,"method":method,"params":params});
    body["params"]["_meta"] = json!({"io.modelcontextprotocol/protocolVersion":protocol,
        "io.modelcontextprotocol/clientInfo":{"name":"instruction-consumer","version":"1"},
        "io.modelcontextprotocol/clientCapabilities":{}});
    let mut request = axum::http::Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("Host", "127.0.0.1:28788")
        .header("Authorization", format!("Bearer {bearer}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", protocol)
        .header("Mcp-Method", method);
    if method == "tools/call" {
        request = request.header("Mcp-Name", "run_resource_operation");
    }
    app.oneshot(
        request
            .body(axum::body::Body::from(body.to_string()))
            .unwrap(),
    )
    .await
    .unwrap()
}

async fn ask(app: axum::Router, bearer: &str, method: &str, params: Value) -> Value {
    let response = response(app, bearer, method, params).await;
    let bytes = axum::body::to_bytes(response.into_body(), 65_536)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn observed_body(response: axum::response::Response) -> (Vec<u8>, bool) {
    let mut body = response.into_body();
    let mut delivered = Vec::new();
    while let Some(chunk) =
        std::future::poll_fn(|cx| http_body::Body::poll_frame(std::pin::Pin::new(&mut body), cx))
            .await
    {
        match chunk {
            Ok(chunk) => {
                if let Some(bytes) = chunk.data_ref() {
                    delivered.extend_from_slice(bytes);
                }
            }
            Err(_) => return (delivered, true),
        }
    }
    (delivered, false)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_discover_tool_description_and_continuation_use_the_same_account_overrides() {
    let fixture = fixture();
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    let initialized = ask(
        app.clone(),
        &issuer.bearer(),
        "initialize",
        json!({
            "protocolVersion":"2025-06-18", "capabilities":{},
            "clientInfo":{"name":"earlier-instruction-consumer","version":"1"}
        }),
    )
    .await;
    assert_eq!(
        initialized["result"]["instructions"], PRIVATE_WORDS,
        "{initialized}"
    );
    let discovered = ask(app.clone(), &issuer.bearer(), "discover", json!({})).await;
    assert_eq!(
        discovered["result"]["instructions"], PRIVATE_WORDS,
        "{discovered}"
    );
    let listed = ask(app.clone(), &issuer.bearer(), "tools/list", json!({})).await;
    let description = listed["result"]["tools"][0]["description"]
        .as_str()
        .unwrap();
    assert!(
        description.contains(&format!("Tool: {PRIVATE_WORDS}")),
        "{listed}"
    );
    assert!(!description.contains("SHIPPED_TOOL_FALLBACK"));
    let page = ask(app,&issuer.bearer(),"tools/call",json!({"name":"run_resource_operation","arguments":{
        "address":"@own-records","method":"instructions:read","request_key":"instruction-continuation","input":{}}})).await;
    assert_eq!(
        page["result"]["structuredContent"]["rows"][0]["text"], PRIVATE_WORDS,
        "{page}"
    );
    drop(gateway);
    mac.join().unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn withdrawn_oauth_grant_cannot_read_private_instructions() {
    let fixture = fixture();
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    issuer.revoke();
    let reply = ask(app, &issuer.bearer(), "discover", json!({})).await;
    assert!(!reply.to_string().contains(PRIVATE_WORDS));
    assert!(
        reply["error"].is_object() || reply["result"]["instructions"].is_null(),
        "{reply}"
    );
    drop(gateway);
    mac.join().unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_instruction_withdrawal_at_final_chunk_withholds_the_account_override() {
    let baseline = fixture();
    let calibration = Arc::new(SyntheticOAuthIssuer::new(&baseline));
    let (app, gateway, mac) = start_selected_gateway(&baseline, calibration.clone()).await;
    let ready = response(app, &calibration.bearer(), "discover", json!({})).await;
    // Calibrate the Mac's instruction release before the independent forwarder
    // HTTP-body authorization. The forwarder-specific test targets that boundary.
    let final_request = calibration.requests();
    let allowed: Value = {
        let bytes = axum::body::to_bytes(ready.into_body(), 65_536).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    };
    assert_eq!(
        allowed["result"]["instructions"], PRIVATE_WORDS,
        "{allowed}"
    );
    assert!(final_request > 1);
    drop(gateway);
    mac.join().unwrap().unwrap();
    let fixture = fixture();
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    issuer.revoke_on_request(final_request);
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    let withheld = response(app, &issuer.bearer(), "discover", json!({})).await;
    let (bytes, failed) = observed_body(withheld).await;
    assert!(!String::from_utf8_lossy(&bytes).contains(PRIVATE_WORDS));
    if !failed {
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(value["result"]["instructions"].is_null(), "{value}");
    }
    assert_eq!(issuer.requests(), final_request);
    drop(gateway);
    let _ = mac.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_local_discover_uses_the_same_installed_rows_and_private_override() {
    let fixture = fixture();
    let selected = Arc::new(std::sync::Mutex::new(fixture.selected()));
    let app = crate::native_boot::mcp_local::route_table(selected, "127.0.0.1:28788".into()).unwrap();
    let reply = ask(app, &fixture.token, "discover", json!({})).await;
    assert_eq!(reply["result"]["instructions"], PRIVATE_WORDS, "{reply}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forwarder_rechecks_oauth_before_http_instruction_release_after_mac_reply() {
    let fixture = fixture();
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    // The awaited HTTP handler already received the Mac's protected result;
    // the returned HTTP body has not yet released one byte to this AI.
    let ready = response(app, &issuer.bearer(), "discover", json!({})).await;
    let before_final = issuer.requests();
    issuer.revoke();
    let (delivered, failed) = observed_body(ready).await;
    assert!(failed);
    assert!(
        delivered.is_empty(),
        "the forwarder released no partial private chunk"
    );
    assert_eq!(
        issuer.requests(),
        before_final + 1,
        "the forwarder asks the original issuer again"
    );
    drop(gateway);
    let _ = mac.join().unwrap();
}
