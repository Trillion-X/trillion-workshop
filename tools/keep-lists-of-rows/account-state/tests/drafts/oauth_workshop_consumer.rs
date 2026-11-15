// OAuth HTTP gateway -> admitted connection -> the selected account's own
// Workshop, actual process and retry journal. Synthetic account and tool only.
use super::oauth_read_consumer_controls::start_selected_gateway;
use super::oauth_records_consumer_controls::with_generic_records;
use super::oauth_test_support::SyntheticOAuthIssuer;
use super::*;
use tower::ServiceExt;

const TOOL: &str = "tool:synthetic-oauth-workshop";
const WORDS: &str = "SYNTHETIC_OAUTH_WORKSHOP_RAN";
const RECORD_TOOL: &str = "tool:synthetic-oauth-record-callback";
// The shared fixture uses one synthetic account identity, so only one of its
// actual local listeners runs at a time in these controls.
static TEST_ACCOUNT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn selected_with_service(
    fixture: &Fixture,
    origin: &str,
) -> Arc<std::sync::Mutex<crate::native_boot::SelectedAccount>> {
    let contents = fixture.root.join("parent-app/Contents");
    fs::create_dir_all(contents.join("Resources")).unwrap();
    fs::write(
        contents.join("Resources/device-notices.json"),
        json!({"origin":origin}).to_string(),
    )
    .unwrap();
    let mut selected = fixture.selected();
    Arc::get_mut(&mut selected.selection).expect("fresh unique selected source")
        .select_installed_service_configuration(&contents)
        .unwrap();
    Arc::new(std::sync::Mutex::new(selected))
}

#[test]
fn sealed_oauth_standing_parent_reopens_with_original_issuer_route_and_native_gate() {
    use crate::account_rights::{
        run_capability::{self, Issuer},
        wake_grant::{self, GrantIssuer, Purpose},
    };
    use crate::secrets::{SecretsKey, Secrets, VaultIdentity};
    use crate::native_boot::mcp_selected_personal::oauth_capabilities::Resolver;
    use zeroize::Zeroizing;
    let _serial = TEST_ACCOUNT.blocking_lock();
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let route = super::connection_registration_controls::enroll_for_parent_test(&fixture);
    assert!(route.generation.starts_with("connection:"));
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let origin = issuer.authority.test_origin();
    let bearer = issuer.bearer();
    let principal = issuer
        .authority
        .principal_from_bearer(
            bearer.as_bytes(),
            millis() as i64,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    let selected = selected_with_service(&fixture, &origin);
    let door = "127.0.0.1:28811".parse().unwrap();
    let resolver = Arc::new(
        Resolver::new_with_test_authority(&selected, &selected, door, issuer.authority.clone())
            .unwrap(),
    );
    let registered = wake_grant::register_resolver(OWNER, resolver.clone()).unwrap();
    let vault_file = fixture.root.join("held-values.sqlite");
    let root = SecretsKey::new(Zeroizing::new(fixture.token.clone())).unwrap();
    let open_vault = || {
        Secrets::open(
            crate::secrets::open_store(&vault_file).unwrap(),
            OWNER,
            &root,
            VaultIdentity::new("standing_oauth_test").unwrap(),
        )
        .unwrap()
    };
    let vault = open_vault();
    let row = json!({"fd":3,"rights":[{"kind":"note","id":"oauth-note-a","operations":["records:read"]}]});
    let descriptor = json!({"version":"trillion.oauth-run-parent/v1","origin":origin,"route":route,
        "sign_in":principal.sign_in,"client_id":principal.client_id});
    wake_grant::grant_with_authority(
        &vault,
        TOOL,
        Purpose::Wake("record-arrived"),
        bearer.as_bytes(),
        &row,
        &descriptor,
    )
    .unwrap();
    assert_eq!(
        wake_grant::granted_parent_current(&vault, OWNER, TOOL, Purpose::Wake("record-arrived")),
        Ok(Some(true))
    );
    drop(vault);
    drop(registered);
    drop(resolver);
    drop(selected);
    // The actual selected account and vault are reopened; no first-process
    // callback or in-memory token stands in for the sealed original grant.
    let selected = selected_with_service(&fixture, &origin);
    let resolver = Arc::new(
        Resolver::new_with_test_authority(&selected, &selected, door, issuer.authority.clone())
            .unwrap(),
    );
    let _registered = wake_grant::register_resolver(OWNER, resolver).unwrap();
    let vault = open_vault();
    assert_eq!(
        wake_grant::granted_parent_current(&vault, OWNER, TOOL, Purpose::Wake("record-arrived")),
        Ok(Some(true))
    );
    let issue = || {
        GrantIssuer {
            vault: &vault,
            account: OWNER,
            tool: TOOL,
            purpose: Some(Purpose::Wake("record-arrived")),
            grant_from: None,
            cause: Some("standing-test-cause"),
            door,
        }
        .issue(&row, Duration::from_secs(60))
    };
    let issued = issue().unwrap();
    let run = run_capability::held(issued.capability.token().as_bytes())
        .unwrap()
        .unwrap();
    assert_eq!(run.authenticate_parent().unwrap(), Ok(principal.clone()));
    drop(run);
    drop(issued);
    let service = fixture
        .root
        .join("parent-app/Contents/Resources/device-notices.json");
    let kept_service = fs::read(&service).unwrap();
    fs::write(
        &service,
        json!({"origin":"https://temporary-source-mismatch.example"}).to_string(),
    )
    .unwrap();
    assert_eq!(
        wake_grant::granted_parent_current(&vault, OWNER, TOOL, Purpose::Wake("record-arrived")),
        Err(trillion_local::cause!(run_capability::Refusal::Unavailable)),
        "a changed signed-origin source is unavailable, not grant withdrawal"
    );
    assert!(
        wake_grant::granted_key(&vault, TOOL, Purpose::Wake("record-arrived"))
            .unwrap()
            .is_some()
    );
    fs::write(&service, &kept_service).unwrap();
    assert_eq!(
        wake_grant::granted_parent_current(&vault, OWNER, TOOL, Purpose::Wake("record-arrived")),
        Ok(Some(true))
    );
    let before = issuer.requests();
    let mut wrong = descriptor.clone();
    wrong["origin"] = json!("https://another-issuer.example");
    wake_grant::grant_with_authority(
        &vault,
        TOOL,
        Purpose::Wake("wrong-origin"),
        bearer.as_bytes(),
        &row,
        &wrong,
    )
    .unwrap();
    assert_eq!(
        wake_grant::granted_parent_current(&vault, OWNER, TOOL, Purpose::Wake("wrong-origin")),
        Ok(Some(false))
    );
    assert_eq!(
        issuer.requests(),
        before,
        "a descriptor for another issuer never reaches the original issuer"
    );
    issuer.revoke();
    assert_eq!(
        wake_grant::granted_parent_current(&vault, OWNER, TOOL, Purpose::Wake("record-arrived")),
        Ok(Some(false))
    );
    assert!(
        issue().is_err(),
        "issuer withdrawal starts no standing run after restart"
    );
    assert!(
        wake_grant::granted_key(&vault, TOOL, Purpose::Wake("record-arrived"))
            .unwrap()
            .is_some(),
        "currentness inspection does not silently rewrite or erase the sealed grant"
    );
}

#[test]
fn original_oauth_run_parent_refuses_local_gate_withdrawal_while_issuer_stays_current() {
    use crate::account_rights::run_capability::{self, ParentAuthority, Rights};
    use crate::native_boot::mcp_selected_personal::oauth_capabilities::Parent;
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let bearer = issuer.bearer();
    let principal = issuer
        .authority
        .principal_from_bearer(
            bearer.as_bytes(),
            millis() as i64,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    let selected = Arc::new(std::sync::Mutex::new(fixture.selected()));
    let parent = Arc::new(Parent::new(
        &selected,
        issuer.authority.clone(),
        &route(),
        &principal,
        bearer.as_bytes(),
        Arc::new(|| true),
        None,
    ));
    assert_eq!(parent.authenticate(), Ok(principal.clone()));
    let rights =
        Rights::declared(&json!({"rights":[{"kind":"note","operations":["records:read"]}]}))
            .unwrap();
    let issued = run_capability::mint_with_authority(
        OWNER,
        bearer.as_bytes(),
        rights.clone(),
        None,
        Duration::from_secs(60),
        parent.clone(),
    )
    .unwrap();
    let current = run_capability::held(issued.token().as_bytes())
        .unwrap()
        .unwrap();
    assert_eq!(
        current.authenticate_parent().unwrap(),
        Ok(principal.clone())
    );
    let db = Connection::open(fixture.root.join("oauth-use.sqlite")).unwrap();
    let text: String = db
        .query_row(
            "SELECT state_json FROM account_control_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut gate: Value = serde_json::from_str(&text).unwrap();
    gate["sign_ins"]["grant:synthetic-oauth-grant"]["ended_until_ms"] = json!(millis() + 60_000);
    db.execute(
        "UPDATE account_control_state SET state_json=? WHERE singleton=1",
        [gate.to_string()],
    )
    .unwrap();
    // The original remote grant still validates, isolating withdrawal at the
    // native gate that must govern an already-kept run parent.
    assert_eq!(
        issuer
            .authority
            .principal_from_bearer(
                bearer.as_bytes(),
                millis() as i64,
                Instant::now() + Duration::from_secs(5)
            )
            .unwrap(),
        principal
    );
    assert!(
        current.authenticate_parent().unwrap().is_err(),
        "a local withdrawal must stop an existing run's next callback"
    );
    assert!(
        run_capability::mint_with_authority(
            OWNER,
            bearer.as_bytes(),
            rights,
            None,
            Duration::from_secs(60),
            parent
        )
        .is_err(),
        "a local withdrawal must stop a new standing-parent run before it starts"
    );
}

fn with_record_tool(fixture: Fixture) -> Fixture {
    let package = fixture.root.join("workshop/tools/oauth-record-callback");
    fs::create_dir_all(package.join("do-work")).unwrap();
    // Only the child's private descriptor contains its run token. Neither the
    // source, stdout nor any request argument contains an account credential.
    let script = r#"import json, os, urllib.request
with os.fdopen(3) as private:
    door = json.load(private)
def read(record, key):
    body = {"jsonrpc":"2.0","id":key,"method":"tools/call","params":{
        "name":"run_resource_operation","arguments":{"address":door["resource"],
        "method":"records:read","request_key":key,"input":{"id":record,"type":"note"}},
        "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientInfo":{"name":"synthetic-tool-child","version":"1"},
        "io.modelcontextprotocol/clientCapabilities":{}}}}
    req = urllib.request.Request(door["url"], data=json.dumps(body).encode(), method="POST", headers={
        "Authorization":"Bearer " + door["capability"],"Content-Type":"application/json",
        "Accept":"application/json, text/event-stream","MCP-Protocol-Version":"2026-07-28",
        "Mcp-Method":"tools/call","Mcp-Name":"run_resource_operation"})
    with urllib.request.urlopen(req, timeout=15) as answer:
        raw = answer.read().decode()
        if raw.lstrip().startswith("{"):
            return json.loads(raw)
        return next(json.loads(line[5:]) for line in raw.splitlines() if line.startswith("data:"))
allowed = read("oauth-note-a", "synthetic-child-allowed")
outside = read("oauth-note-b", "synthetic-child-outside")
print(json.dumps({"words":allowed["result"]["structuredContent"]["value"]["words"],
    "outside_refused":outside["result"].get("isError") is True,
    "outside_disclosed": "second synthetic note" in json.dumps(outside)}))
"#;
    fs::write(package.join("do-work/read.py"), script).unwrap();
    let row = json!({"records":[{"payload":{
        "kind":"ai-tool-descriptor","id":RECORD_TOOL,"label":"Synthetic OAuth record callback",
        "job":"Read exactly one synthetic note through this run's private narrowed capability",
        "result_selector":"$","invoke":{"kind":"container",
            "argv":["python3","/opt/oauth-record-callback/do-work/read.py"],
            "workdir":"/opt/oauth-record-callback","stdout":"json",
            "files":{"package_files":{"package":"oauth-record-callback","paths":["do-work"],"at":"/opt/oauth-record-callback"}},
            "records":{"fd":3,"rights":[{"kind":"note","id":"oauth-note-a","operations":["records:read"]}]}}
    }}]});
    fs::write(package.join("tool-rows.json"), row.to_string()).unwrap();
    fixture
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn oauth_workshop_child_reads_same_account_through_narrowed_capability_on_actual_local_http()
{
    let _serial = TEST_ACCOUNT.lock().await;
    let fixture = with_record_tool(with_workshop(with_generic_records(
        Fixture::new_with_oauth_grant(),
    )));
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let (app, gateway, mac, owner) =
        super::oauth_read_consumer_controls::start_selected_gateway_and_owner(
            &fixture,
            issuer.clone(),
            Arc::new(|| true),
        )
        .await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let local = crate::native_boot::mcp_local::route_table(owner, address.to_string()).unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, local)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    let answer = reply(
        app.clone(),
        &issuer.bearer(),
        "tools:run",
        "oauth-workshop-record-child",
        json!({"tool":RECORD_TOOL,"input":{}}),
    )
    .await;
    assert_eq!(answer["result"]["isError"], false, "{answer}");
    let ran = &answer["result"]["structuredContent"];
    assert_eq!(ran["exit_code"], 0, "{ran}");
    assert_eq!(
        ran["result"]["words"], "OAUTH_GENERIC_RECORDS_PRIVATE_CANARY",
        "{ran}"
    );
    assert_eq!(ran["result"]["outside_refused"], true, "{ran}");
    assert_eq!(ran["result"]["outside_disclosed"], false, "{ran}");
    let _ = stop.send(());
    server.await.unwrap().unwrap();
    drop(app);
    drop(gateway);
    mac.join().unwrap().unwrap();
}

fn with_workshop(fixture: Fixture) -> Fixture {
    // The production owner deliberately gives a maker's launch setting
    // priority over the account's installed copy. This fixture reaches only
    // its own account copy, never an unrelated developer tree.
    assert!(std::env::var_os("WORKSHOP_MODULE_ROOT").is_none());
    let package = fixture.root.join("workshop/tools/oauth-proof");
    fs::create_dir_all(package.join("do-work")).unwrap();
    let script = format!(
        "input=$(cat)\nnonce=$(/usr/bin/uuidgen)\nprintf '%s\\n' \"{{\\\"words\\\":\\\"{WORDS}\\\",\\\"nonce\\\":\\\"$nonce\\\",\\\"input\\\":$input}}\"\n"
    );
    fs::write(package.join("do-work/run.sh"), script).unwrap();
    let row = json!({"records":[{"payload":{
        "kind":"ai-tool-descriptor","id":TOOL,"label":"Synthetic OAuth Workshop proof",
        "job":"Run one synthetic local process to prove the admitted OAuth connection",
        "input_schema":{"type":"object"},"result_selector":"$",
        "invoke":{"kind":"container","argv":["sh","/opt/oauth-proof/do-work/run.sh"],
            "workdir":"/opt/oauth-proof","stdout":"json","stdin":{"fill":{"from":"input"}},
            "files":{"package_files":{"package":"oauth-proof","paths":["do-work"],"at":"/opt/oauth-proof"}}}
    }}]});
    fs::write(package.join("tool-rows.json"), row.to_string()).unwrap();
    fixture
}

fn run_receipt(fixture: &Fixture) -> (i64, Vec<u8>, i64) {
    let db = Connection::open(fixture.root.join("workshop-tool-runs.sqlite")).unwrap();
    let (id, _, _) = crate::tool_runs::operation_keys("oauth-workshop-run");
    let (version, body) = db
        .query_row(
            "SELECT version,body FROM records WHERE account=? AND resource=? AND id=?",
            rusqlite::params![OWNER, "@workshop-tools", id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let changes = db
        .query_row(
            "SELECT count(*) FROM changes WHERE account=? AND resource=? AND id=?",
            rusqlite::params![OWNER, "@workshop-tools", id],
            |row| row.get(0),
        )
        .unwrap();
    (version, body, changes)
}

fn request(
    bearer: &str,
    method: &str,
    key: &str,
    input: Value,
) -> axum::http::Request<axum::body::Body> {
    let body = json!({"jsonrpc":"2.0","id":key,"method":"tools/call","params":{
        "name":"run_resource_operation","arguments":{"address":"@workshop-tools","method":method,
            "request_key":key,"input":input},"_meta":{
            "io.modelcontextprotocol/protocolVersion":"2026-07-28",
            "io.modelcontextprotocol/clientInfo":{"name":"synthetic-oauth-workshop-client","version":"1"},
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_fixture_local_workshop_gate_withdrawal_after_handler_withholds_without_replay() {
    let _serial = TEST_ACCOUNT.lock().await;
    for withdrawal in ["none", "private-reach", "usage"] {
        let fixture = with_workshop(with_generic_records(Fixture::new()));
        let owner = Arc::new(std::sync::Mutex::new(fixture.selected()));
        let app = crate::native_boot::mcp_local::route_table(owner, "127.0.0.1:28788".into()).unwrap();
        let ready = app.oneshot(request(
            &fixture.token, "tools:run", "oauth-workshop-run",
            json!({"tool":TOOL,"input":{"n":7}}),
        )).await.unwrap();
        assert_eq!(ready.status(), axum::http::StatusCode::OK);
        let ran = run_receipt(&fixture);
        match withdrawal {
            "private-reach" => change_gate(&fixture, "own.sqlite", |state| {
                state["sign_ins"][&fixture.signin]["chosen"] = json!({"private":false,"spaces":[]});
            }),
            "usage" => change_gate(&fixture, "use.sqlite", |state| {
                state["sign_ins"][&fixture.signin]["ended_until_ms"] = json!(millis() + 60_000);
            }),
            _ => {}
        }
        let mut body = ready.into_body();
        let mut delivered = Vec::new();
        let mut failed = false;
        while let Some(chunk) = std::future::poll_fn(|cx| {
            http_body::Body::poll_frame(std::pin::Pin::new(&mut body), cx)
        }).await {
            match chunk {
                Ok(chunk) => if let Some(bytes) = chunk.data_ref() { delivered.extend_from_slice(bytes); },
                Err(_) => { failed = true; break; }
            }
        }
        if withdrawal == "none" {
            assert!(!failed);
            let reply: Value = serde_json::from_slice(&delivered).unwrap();
            assert_eq!(reply["result"]["structuredContent"]["result"]["words"], WORDS, "{reply}");
        } else {
            assert!(failed, "{withdrawal}");
            assert!(delivered.is_empty(), "{withdrawal}: no partial private result");
        }
        assert_eq!(run_receipt(&fixture), ran, "{withdrawal}: final disclosure never reruns the process");
    }
}

async fn reply(app: axum::Router, bearer: &str, method: &str, key: &str, input: Value) -> Value {
    let response = app
        .oneshot(request(bearer, method, key, input))
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 65_536)
        .await
        .unwrap();
    assert_eq!(
        status,
        axum::http::StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_gateway_lists_and_runs_the_selected_workshop_once_on_same_key_retry() {
    let _serial = TEST_ACCOUNT.lock().await;
    let fixture = with_workshop(with_generic_records(Fixture::new_with_oauth_grant()));
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    let list = reply(
        app.clone(),
        &issuer.bearer(),
        "tools:list",
        "oauth-workshop-list",
        json!({}),
    )
    .await;
    assert_eq!(list["result"]["isError"], false, "{list}");
    let tools = list["result"]["structuredContent"]["tools"]
        .as_array()
        .unwrap();
    assert!(tools
        .iter()
        .any(|row| row["id"] == TOOL && row["runs_here"] == true));
    let input = json!({"tool":TOOL,"input":{"n":7}});
    let first = reply(
        app.clone(),
        &issuer.bearer(),
        "tools:run",
        "oauth-workshop-run",
        input.clone(),
    )
    .await;
    assert_eq!(first["result"]["isError"], false, "{first}");
    let answer = &first["result"]["structuredContent"];
    assert_eq!(answer["exit_code"], 0, "{answer}");
    assert_eq!(answer["result"]["words"], WORDS);
    assert_eq!(answer["result"]["input"], json!({"n":7}));
    assert!(!answer["result"]["nonce"].as_str().unwrap().is_empty());
    assert_eq!(answer["replayed"], false);
    let receipt = run_receipt(&fixture);
    assert_eq!(
        (receipt.0, receipt.2),
        (2, 2),
        "one start and one terminal receipt"
    );
    let again = reply(
        app.clone(),
        &issuer.bearer(),
        "tools:run",
        "oauth-workshop-run",
        input,
    )
    .await;
    assert_eq!(again["result"]["isError"], false, "{again}");
    assert_eq!(
        again["result"]["structuredContent"]["result"],
        answer["result"]
    );
    assert_eq!(again["result"]["structuredContent"]["replayed"], true);
    assert_eq!(
        run_receipt(&fixture),
        receipt,
        "the retry returns the same process nonce and unchanged run journal"
    );
    let conflict = reply(
        app.clone(),
        &issuer.bearer(),
        "tools:run",
        "oauth-workshop-run",
        json!({"tool":TOOL,"input":{"n":8}}),
    )
    .await;
    assert_eq!(conflict["result"]["isError"], true, "{conflict}");
    assert_eq!(
        run_receipt(&fixture),
        receipt,
        "changed-input retry cannot start another process"
    );
    drop(app);
    drop(gateway);
    mac.join().unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_gateway_refuses_workshop_after_original_grant_withdrawal_without_starting_a_process()
{
    let _serial = TEST_ACCOUNT.lock().await;
    let fixture = with_workshop(with_generic_records(Fixture::new_with_oauth_grant()));
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let (app, gateway, mac) = start_selected_gateway(&fixture, issuer.clone()).await;
    // Withdraw at the gateway's first issuer check. No tool may run from a
    // previous successful connection or from its saved row alone.
    issuer.revoke_on_request(1);
    let response = app
        .clone()
        .oneshot(request(
            &issuer.bearer(),
            "tools:run",
            "oauth-workshop-withdrawn",
            json!({"tool":TOOL,"input":{"n":7}}),
        ))
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 65_536)
        .await
        .unwrap();
    let parsed: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(
        status == axum::http::StatusCode::UNAUTHORIZED
            || parsed["result"]["isError"] == true
            || parsed["error"].is_object()
    );
    assert!(!String::from_utf8_lossy(&bytes).contains(WORDS));
    assert!(!fixture.root.join("workshop-tool-runs.sqlite").exists());
    drop(app);
    drop(gateway);
    mac.join().unwrap().unwrap();
}
