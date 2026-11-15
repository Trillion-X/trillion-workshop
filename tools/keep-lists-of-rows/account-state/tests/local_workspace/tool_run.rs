//! The page's road to the tools owner (src/server/owner-routes.json, the row named after tool-runs.json
//! `address`): POST /work/api/door/<run> runs one tool for the page's own session and Origin, once per carried request
//! key, and GET /work/api/door/<list> lists them; nothing else at that owner is reachable from the page (no install,
//! pin, rollback, wake or trillion-local row), and a page in another origin gets no CORS allowance. The fixture listens on
//! no loopback account route, so a row that declares records does not start here (its pass, from the page's own session,
//! is proven in src/native_boot/mcp_local.rs `standing_tests`). Tool words are synthetic.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use content_crypto::advanced::blake3;

fn tool_runs() -> Value {
    serde_json::from_slice(
        &fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/tool_runs/tools/tool-runs.json"),
        )
        .unwrap(),
    )
    .unwrap()
}
/// A tools folder in the account's state folder (tool-runs.json place `state`): one row that declares no records and
/// answers JSON, and one that declares records.
fn workshop(f: &Fixture) {
    // Integration tests link the library without main's composition root.
    // Register the same real platform binding as the existing HTTP-response
    // fixture; all ordinary tool admission and execution checks still run.
    #[cfg(tool_sandbox = "sbpl")]
    if let Some(binding) = computer_sandbox_sbpl::binding() {
        trillion_local::tool_runs::os::register(binding);
    }
    #[cfg(tool_sandbox = "landlock")]
    if let Some(binding) = computer_sandbox_landlock::binding() {
        trillion_local::tool_runs::os::register(binding);
    }
    let state = f.records.parent().unwrap();
    let package = state.join("workshop/tools/page-probe");
    fs::create_dir_all(&package).unwrap();
    let records = json!({"fd": 3, "rights": [{"kind": "note", "operations": ["records:read"]}]});
    fs::write(package.join("tool-rows.json"), json!({"records": [
        {"payload": {"kind": "ai-tool-descriptor", "id": "say-what-was-asked", "label": "Synthetic", "job": "synthetic",
            "invoke": {"kind": "container", "stdout": "json", "argv": ["sh", "-c", "printf '{\"heard\":%s}' \"$(cat)\""],
                "stdin": {"fill": {"from": "input"}}}, "result_selector": "$"}},
        {"payload": {"kind": "ai-tool-descriptor", "id": "read-notes", "label": "Synthetic", "job": "synthetic",
            "invoke": {"kind": "container", "argv": ["true"], "records": records}}},
        {"payload": {"kind": "ai-tool-descriptor", "id": "say-where-it-started", "label": "Synthetic", "job": "synthetic",
            "invoke": {"kind": "container", "stdout": "json", "argv": ["sh", "-c", "printf '{\"origin\":\"%s\"}' \"$1\"", "sh",
                {"fill": {"from": "task", "field": "origin"}}]}, "result_selector": "$"}}
    ]}).to_string()).unwrap();
}
fn page(
    method: &str,
    path: &str,
    key: Option<&str>,
    origin: &str,
    body: Option<&Value>,
) -> Request<Body> {
    let mut asked = request(method, path, body.map(Value::to_string).as_deref());
    asked
        .headers_mut()
        .insert(header::ORIGIN, origin.parse().unwrap());
    if body.is_some() {
        asked
            .headers_mut()
            .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    }
    if let Some(key) = key {
        asked
            .headers_mut()
            .insert("x-trillion-request-key", key.parse().unwrap());
    }
    asked
}
async fn answer(f: &Fixture, asked: Request<Body>) -> (StatusCode, Value) {
    let response = f.app.clone().oneshot(asked).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn the_page_runs_a_listed_tool_once_per_request_key_and_reaches_nothing_else_at_the_workshop()
{
    let f = Fixture::new(&[]);
    workshop(&f);
    let data = tool_runs();
    let (run, list) = (
        data["run_method"].as_str().unwrap(),
        data["list_method"].as_str().unwrap(),
    );
    let at = |operation: &str| format!("/work/api/door/{operation}");
    let run_body = |input: Value| json!({"tool": "say-what-was-asked", "input": input});

    // Listed, and run: the answer is the run's own, and the same key answers the same run again.
    let listing = format!("{}?input={}", at(list), "%7B%7D");
    let (status, listed) = answer(&f, page("GET", &listing, None, ORIGIN, None)).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert!(
        listed["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == "say-what-was-asked"),
        "{listed}"
    );
    let (status, ran) = answer(
        &f,
        page(
            "POST",
            &at(run),
            Some("page-run-1"),
            ORIGIN,
            Some(&run_body(json!({"n": 1}))),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{ran}");
    assert_eq!(ran["exit_code"], 0, "{ran}");
    assert_eq!(ran["result"], json!({"heard": {"n": 1}}), "{ran}");
    let (status, again) = answer(
        &f,
        page(
            "POST",
            &at(run),
            Some("page-run-1"),
            ORIGIN,
            Some(&run_body(json!({"n": 1}))),
        ),
    )
    .await;
    assert_eq!(
        (status, &again["result"], &again["replayed"]),
        (StatusCode::OK, &ran["result"], &json!(true)),
        "a repeated key answers its first run, said as replayed: {again}"
    );
    let (status, reused) = answer(
        &f,
        page(
            "POST",
            &at(run),
            Some("page-run-1"),
            ORIGIN,
            Some(&run_body(json!({"n": 2}))),
        ),
    )
    .await;
    assert_eq!(
        (status, reused["failure_code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("workshop_run_key_reused")),
        "{reused}"
    );

    // The run's task says the page started it (tool-runs.json page_origin), whatever the input claims.
    let (status, started) = answer(
        &f,
        page(
            "POST",
            &at(run),
            Some("page-origin"),
            ORIGIN,
            Some(&json!({"tool": "say-where-it-started", "input": {"origin": "an-ai"}})),
        ),
    )
    .await;
    assert_eq!(
        (status, &started["result"]["origin"]),
        (StatusCode::OK, &data["page_origin"]),
        "{started}"
    );

    // A run needs its own key and the page's own Origin; a GET is not a run.
    let (status, keyless) = answer(
        &f,
        page("POST", &at(run), None, ORIGIN, Some(&run_body(json!({})))),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{keyless}");
    let (status, foreign) = answer(
        &f,
        page(
            "POST",
            &at(run),
            Some("page-run-foreign"),
            "http://elsewhere.example",
            Some(&run_body(json!({}))),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{foreign}");
    let (status, got) = answer(
        &f,
        page("GET", &at(run), Some("page-run-get"), ORIGIN, None),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{got}");

    // Nothing else at the tools' address, no extra field and none of trillion-local's own rows.
    for operation in [
        "update_method",
        "pin_method",
        "rollback_method",
    ] {
        let named = data[operation].as_str().unwrap();
        let (status, refused) = answer(
            &f,
            page(
                "POST",
                &at(named),
                Some("page-other"),
                ORIGIN,
                Some(&json!({"tool": "say-what-was-asked", "on": true})),
            ),
        )
        .await;
        // Under the tools' route it is refused; outside it (an install's own name) no route answers it at all.
        assert!(
            matches!(status, StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND),
            "{operation}: {status} {refused}"
        );
    }
    let (status, extra) = answer(
        &f,
        page(
            "POST",
            &at(run),
            Some("page-extra"),
            ORIGIN,
            Some(&json!({"tool": "say-what-was-asked", "input": {}, "also": true})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{extra}");
    // The engine declares no row of its own since 54bb100d3 deleted the keep-current wake row (tool-runs.json `engine_rows` is
    // empty), so there is no engine row for a page to be refused on; the refusal of a page's unlisted tool above still holds.
    let switch = trillion_local::record_value::account_routes::Door::shipped()
        .unwrap()
        .wake_switch_operation();
    let (status, wake) = answer(
        &f,
        page(
            "POST",
            &at(switch),
            Some("page-wake"),
            ORIGIN,
            Some(&json!({"tool": "say-what-was-asked", "id": "w", "on": true})),
        ),
    )
    .await;
    assert!(status.is_client_error(), "{status} {wake}");

    // A row that declares records starts only from the page's session through a loopback account route; there is none.
    let (status, notes) = answer(
        &f,
        page(
            "POST",
            &at(run),
            Some("page-notes"),
            ORIGIN,
            Some(&json!({"tool": "read-notes", "input": {}})),
        ),
    )
    .await;
    assert_eq!(
        (status, notes["failure_code"].as_str()),
        (
            StatusCode::BAD_REQUEST,
            Some("workshop_tool_not_runnable_here")
        ),
        "{notes}"
    );
}

#[tokio::test]
async fn a_preflight_from_another_origin_gets_no_cors_allowance() {
    let f = Fixture::new(&[]);
    let run = tool_runs()["run_method"].as_str().unwrap().to_owned();
    let mut asked = request("OPTIONS", &format!("/work/api/door/{run}"), None);
    asked
        .headers_mut()
        .insert(header::ORIGIN, "http://elsewhere.example".parse().unwrap());
    asked.headers_mut().insert(
        header::ACCESS_CONTROL_REQUEST_METHOD,
        "POST".parse().unwrap(),
    );
    asked.headers_mut().insert(
        header::ACCESS_CONTROL_REQUEST_HEADERS,
        "content-type, x-trillion-request-key".parse().unwrap(),
    );
    let response = f.app.clone().oneshot(asked).await.unwrap();
    for allowance in [
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::ACCESS_CONTROL_ALLOW_METHODS,
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
    ] {
        assert!(
            response.headers().get(&allowance).is_none(),
            "{allowance}: {:?}",
            response.headers()
        );
    }
}

// Recovery controls use the public Store reader to inspect the actual run
// journal, and the public account-erasure operation to withdraw its receipt.
// They do not reconstruct the private operation-key or erasure-mark formats.
fn run_journal(
    f: &Fixture,
) -> (
    Vec<trillion_local::store::Record>,
    Vec<trillion_local::store::Change>,
) {
    let data = tool_runs();
    let path = f
        .records
        .parent()
        .unwrap()
        .join(format!("{}.sqlite", data["receipts"].as_str().unwrap()));
    let store = trillion_local::store::Store::read_existing(path).unwrap();
    let address = data["address"].as_str().unwrap();
    let records = store.list_page(OWNER_ID, address, "", 64).unwrap();
    let changes = store.changes_page(OWNER_ID, address, 0, 64).unwrap();
    assert!(
        records.next.is_none() && changes.next.is_none(),
        "synthetic journal must fit the bounded inspection"
    );
    (records.items, changes.items)
}

fn primary_run(f: &Fixture) -> trillion_local::store::Record {
    let (records, changes) = run_journal(f);
    let mut primary = records
        .into_iter()
        .filter(|row| row.value["report"].is_object() && row.value["delivery"].is_object());
    let row = primary
        .next()
        .expect("the actual run left its terminal report and selected delivery");
    assert!(
        primary.next().is_none(),
        "one request key has one primary run"
    );
    assert_eq!(row.value["state"], "exited");
    assert_eq!(
        changes
            .iter()
            .filter(|change| change.id == row.id
                && change
                    .value
                    .as_ref()
                    .is_some_and(|value| value["state"] == "started"))
            .count(),
        1,
        "the actual process has one durable start claim"
    );
    row
}

fn run_journal_identity(f: &Fixture) -> String {
    blake3::hash(&serde_json::to_vec(&run_journal(f)).unwrap())
        .to_hex()
        .to_string()
}

fn recovery_request(key: &str, cursor: Value) -> Request<Body> {
    let data = tool_runs();
    page(
        "POST",
        &format!("/work/api/door/{}", data["run_method"].as_str().unwrap()),
        Some(key),
        ORIGIN,
        Some(
            &json!({"tool":"say-what-was-asked", "input":{"canary":"BROWSER_RECOVERY_CANARY"}, "after_byte":cursor}),
        ),
    )
}

async fn first_recovery_run(f: &Fixture, key: &str) -> Value {
    let data = tool_runs();
    let (status, ran) = answer(
        f,
        page(
            "POST",
            &format!("/work/api/door/{}", data["run_method"].as_str().unwrap()),
            Some(key),
            ORIGIN,
            Some(
                &json!({"tool":"say-what-was-asked", "input":{"canary":"BROWSER_RECOVERY_CANARY"}}),
            ),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{ran}");
    assert_eq!(ran["result"]["heard"]["canary"], "BROWSER_RECOVERY_CANARY");
    assert_eq!(ran["exit_code"], 0);
    primary_run(f);
    ran
}

fn page_bytes(answer: &Value) -> Vec<u8> {
    let page = &answer["byte_page"];
    let bytes = STANDARD.decode(page["base64"].as_str().unwrap()).unwrap();
    assert_eq!(page["length"].as_u64().unwrap(), bytes.len() as u64);
    bytes
}

fn erase_run_receipts(f: &Fixture) {
    let erased = trillion_local::tool_runs::tools::shipped()
        .unwrap()
        .erase_runs_page(OWNER_ID, f.records.parent().unwrap(), "")
        .unwrap();
    assert!(erased.erased > 0);
    assert!(erased.next.is_none());
}

/// The base fixture deliberately mounts only its small door inventory. Compose
/// the shipped route DATA over that same selected account and real adapter for
/// the direct screen consumer, as the existing tool-screen fixture does.
fn mount_screen_routes(f: &mut Fixture) {
    let bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/server/owner-routes.json"
    ));
    let routes = OwnerRoutes::from_source(bytes, blake3::hash(bytes).to_hex().as_str()).unwrap();
    let first = br#"{"paths":{},"workspace_records_path":"/work/api/records","startup_record_inputs":[],"startup_preferences":[],"screen_revision":"/work/api/screen-revision","screens":{},"item_reads":{"screens":{}}}"#;
    let inputs = b"{}";
    let startup = StartupContract::from_sources(
        first,
        blake3::hash(first).to_hex().as_str(),
        inputs,
        blake3::hash(inputs).to_hex().as_str(),
    )
    .unwrap();
    let canonical = Arc::new(CanonicalWorkspace::new(
        routes,
        startup,
        f.adapter.clone(),
        None,
    ));
    let settings =
        WorkspaceSessionSettings::from_source(SETTINGS, blake3::hash(SETTINGS).to_hex().as_str())
            .unwrap();
    let sessions = WorkspaceSessions::new(f.owner.clone(), ORIGIN, settings).unwrap();
    let assets = f._temp.path().join("assets");
    let manifest = fs::read(assets.join("workspace/files.json")).unwrap();
    let assets = Arc::new(
        WorkspaceAssets::open(
            &assets,
            blake3::hash(&manifest).to_hex().as_str(),
            &tree_pin(&assets),
        )
        .unwrap(),
    );
    let dom = WorkspaceDom::from_source(DOM, blake3::hash(DOM).to_hex().as_str()).unwrap();
    f.app = workspace::route_table(
        assets,
        WorkspaceSupplies {
            sessions: Some(Arc::new(sessions)),
            operations: Some(canonical),
            live: None,
            dom,
        },
        WorkspaceLimits::default(),
    )
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn browser_recovery_numeric_cursors_read_the_same_primary_without_another_execution() {
    let f = Fixture::new(&[]);
    workshop(&f);
    let ran = first_recovery_run(&f, "browser-recovery-positive").await;
    let primary = primary_run(&f);
    let before = run_journal_identity(&f);
    let (status, first) = answer(&f, recovery_request("browser-recovery-positive", json!(0))).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let whole = page_bytes(&first);
    assert_eq!(serde_json::from_slice::<Value>(&whole).unwrap(), ran);
    assert_eq!(first["byte_page"]["offset"], 0);
    assert_eq!(first["byte_page"]["total"], whole.len());
    assert!(first["byte_page"]["next_after_byte"].is_null());
    assert_eq!(
        first["byte_page"]["blake3"],
        blake3::hash(&whole).to_hex().as_str()
    );

    let (status, later) = answer(&f, recovery_request("browser-recovery-positive", json!(7))).await;
    assert_eq!(status, StatusCode::OK, "{later}");
    assert_eq!(page_bytes(&later), whole[7..]);
    assert_eq!(later["byte_page"]["offset"], 7);
    assert_eq!(later["byte_page"]["total"], first["byte_page"]["total"]);
    assert_eq!(later["byte_page"]["blake3"], first["byte_page"]["blake3"]);
    assert_eq!(primary_run(&f), primary);
    assert_eq!(
        run_journal_identity(&f),
        before,
        "only the tool journal is measured; browser session admission may renew auth state"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn browser_recovery_erased_after_dispatch_withholds_the_selected_bytes_and_never_reexecutes()
{
    let f = Fixture::new(&[]);
    workshop(&f);
    first_recovery_run(&f, "browser-recovery-erased").await;
    let (status, intact) = answer(&f, recovery_request("browser-recovery-erased", json!(0))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&page_bytes(&intact)).unwrap()["result"]["heard"]["canary"],
        "BROWSER_RECOVERY_CANARY"
    );
    let response = f
        .app
        .clone()
        .oneshot(recovery_request("browser-recovery-erased", json!(0)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    erase_run_receipts(&f);
    let erased = run_journal_identity(&f);
    assert!(
        to_bytes(response.into_body(), 1 << 20).await.is_err(),
        "erasure between dispatch and the first body poll must withhold the selected canary"
    );
    let (status, refused) = answer(&f, recovery_request("browser-recovery-erased", json!(0))).await;
    assert_eq!(status, StatusCode::GONE, "{refused}");
    assert_eq!(refused["failure_code"], "tool_run_erased");
    assert!(!refused.to_string().contains("BROWSER_RECOVERY_CANARY"));
    assert_eq!(
        run_journal_identity(&f),
        erased,
        "an erased continuation cannot claim or start another run"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn browser_recovery_source_changed_after_dispatch_withholds_the_selected_bytes() {
    let f = Fixture::new(&[]);
    workshop(&f);
    first_recovery_run(&f, "browser-recovery-source").await;
    let (status, intact) = answer(&f, recovery_request("browser-recovery-source", json!(0))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(String::from_utf8(page_bytes(&intact))
        .unwrap()
        .contains("BROWSER_RECOVERY_CANARY"));
    let before = run_journal_identity(&f);
    let response = f
        .app
        .clone()
        .oneshot(recovery_request("browser-recovery-source", json!(0)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let path = f
        .records
        .parent()
        .unwrap()
        .join("workshop/tools/page-probe/tool-rows.json");
    let mut rows: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    rows["records"][0]["payload"]["invoke"]["argv"] =
        json!(["sh", "-c", "printf '{\"changed\":true}'"]);
    fs::write(path, rows.to_string()).unwrap();
    assert!(
        to_bytes(response.into_body(), 1 << 20).await.is_err(),
        "changed native invoke source must withhold the already-selected canary"
    );
    let (status, refused) = answer(&f, recovery_request("browser-recovery-source", json!(0))).await;
    assert!(status.is_client_error(), "{status} {refused}");
    assert!(!refused.to_string().contains("BROWSER_RECOVERY_CANARY"));
    assert_eq!(run_journal_identity(&f), before);
    primary_run(&f);
}

#[tokio::test(flavor = "multi_thread")]
async fn browser_recovery_cancellation_and_invalid_or_missing_cursors_never_start_another_run() {
    let f = Fixture::new(&[]);
    workshop(&f);
    first_recovery_run(&f, "browser-recovery-cancel").await;
    let before = run_journal_identity(&f);
    let response = f
        .app
        .clone()
        .oneshot(recovery_request("browser-recovery-cancel", json!(0)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let context = f.adapter.head_context.lock().unwrap().take().unwrap();
    context.permit.cancel();
    assert!(
        to_bytes(response.into_body(), 1 << 20).await.is_err(),
        "cancellation after dispatch must withhold the selected canary"
    );
    for cursor in [json!("0"), json!(-1), json!(1.5), json!(u64::MAX)] {
        let (status, refused) =
            answer(&f, recovery_request("browser-recovery-cancel", cursor)).await;
        assert!(status.is_client_error(), "{status} {refused}");
        assert!(!refused.to_string().contains("BROWSER_RECOVERY_CANARY"));
        assert_eq!(run_journal_identity(&f), before);
    }
    let (status, refused) = answer(
        &f,
        recovery_request("browser-recovery-never-started", json!(0)),
    )
    .await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT, "{refused}");
    assert_eq!(refused["failure_code"], "workshop_run_outcome_unknown");
    assert!(!refused.to_string().contains("BROWSER_RECOVERY_CANARY"));
    assert_eq!(run_journal_identity(&f), before);
    primary_run(&f);
}

#[tokio::test(flavor = "multi_thread")]
async fn browser_recovery_direct_screen_replays_one_primary_and_erasure_withholds_its_layout() {
    let mut f = Fixture::new(&[]);
    mount_screen_routes(&mut f);
    workshop(&f);
    let path = f
        .records
        .parent()
        .unwrap()
        .join("workshop/tools/page-probe/tool-rows.json");
    let mut rows: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    rows["records"].as_array_mut().unwrap().push(json!({"payload":{
        "kind":"ai-tool-descriptor", "id":"tool:browser-recovery-screen", "label":"Synthetic", "job":"synthetic",
        "screen":{"kind":"reads", "reads":[{"id":"probe", "tool":"say-what-was-asked", "input":{"canary":"BROWSER_SCREEN_RECOVERY_CANARY"}}],
            "layout":{"canary":{"$kind":"binding", "select":{"from":"self", "path":["reads","probe","heard","canary"]}}}}
    }}));
    fs::write(path, rows.to_string()).unwrap();
    let screen = || {
        page(
            "GET",
            "/work/api/screens/browser-recovery-screen",
            Some("browser-screen-recovery"),
            ORIGIN,
            None,
        )
    };
    let (status, first) = answer(&f, screen()).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["canary"], "BROWSER_SCREEN_RECOVERY_CANARY");
    let primary = primary_run(&f);
    let before = run_journal_identity(&f);
    let (status, again) = answer(&f, screen()).await;
    assert_eq!((status, again), (StatusCode::OK, first));
    assert_eq!(primary_run(&f), primary);
    assert_eq!(run_journal_identity(&f), before);
    let response = f.app.clone().oneshot(screen()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    erase_run_receipts(&f);
    let erased = run_journal_identity(&f);
    assert!(to_bytes(response.into_body(), 1 << 20).await.is_err(), "the direct PageRuns screen consumer must retain custody of its primary until the actual body poll");
    assert_eq!(run_journal_identity(&f), erased);
}
