// Synthetic end-to-end hook ingestion. A child test process owns a temporary
// home, so its real source reader cannot reach the person's transcripts.
#[tokio::test]
async fn verified_hook_ingestion_keeps_source_claims_without_opening_ordinary_receipt_writes() {
    if std::env::var_os("TRILLION_SYNTHETIC_HOOK_HOME").is_none() {
        let home = tempfile::tempdir().unwrap();
        let output=std::process::Command::new(std::env::current_exe().unwrap())
            .arg("verified_hook_ingestion_keeps_source_claims_without_opening_ordinary_receipt_writes").arg("--nocapture")
            .env("HOME",home.path()).env("TRILLION_SYNTHETIC_HOOK_HOME","1").output().unwrap();
        assert!(
            output.status.success(),
            "synthetic native consumer failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let home = fs::canonicalize(std::env::var_os("HOME").unwrap()).unwrap();
    let folder = home.join(".codex/sessions/2026/11/07");
    fs::create_dir_all(&folder).unwrap();
    let session = "fixture-native-observation-session";
    let path = folder.join(format!("rollout-fixture-{session}.jsonl"));
    let file = format!("1f:{}", "c".repeat(64));
    let declared_references = json!([
        {"ref":format!("file:{file}"),"role":"consulted source"},
        {"ref":file,"role":"another declared role"},
        {"ref":"list:fixture-sources:rows:first","role":"named example"},
        {"ref":"future-resource:audience-preference","role":"contextual preference"}
    ]);
    let rows = vec![
        json!({"type":"session_meta","timestamp":"2026-11-07T12:00:00Z","payload":{"id":session,"session_id":session,"originator":"Codex Desktop","source":"vscode"}}),
        json!({"type":"response_item","timestamp":"2026-11-07T12:00:01Z","payload":{"type":"function_call","call_id":"fixture-native-call","name":"read_source","arguments":json!({"item":"record:fixture:input","references":declared_references,"token":"SYNTHETIC_SECRET_NOT_TO_KEEP","body":"SYNTHETIC_SECRET_NOT_TO_KEEP"}).to_string()}}),
        json!({"type":"response_item","timestamp":"2026-11-07T12:00:02Z","payload":{"type":"function_call_output","call_id":"fixture-native-call","output":json!({"id":"record:fixture:output","body":"SYNTHETIC_SECRET_NOT_TO_KEEP"}).to_string()}}),
    ];
    fs::write(
        &path,
        rows.iter()
            .map(|v| v.to_string() + "\n")
            .collect::<String>(),
    )
    .unwrap();
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let (_, declaration) = reply(&app, records_request(Some(&fixture.token), "fixture-source-declaration", json!([
        {"id":"list:fixture-sources","type":"list","value":{"row_type":"arbitrary-source-kind","fields":[]},"expected":null}
    ]))).await;
    assert_eq!(declaration["result"]["isError"], false, "{declaration}");
    let hook = |bearer: &str, key: &str, input: Value| {
        let body = json!({"jsonrpc":"2.0","id":key,"method":"tools/call","params":{"name":"run_resource_operation","arguments":{"address":"@harness-hooks","method":"hooks:receive","request_key":key,"input":input}}});
        axum::http::Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("Host", "127.0.0.1:28788")
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-06-18")
            .header("Authorization", format!("Bearer {bearer}"))
            .body(axum::body::Body::from(body.to_string()))
            .unwrap()
    };
    let routes = crate::account::hooks::HookRoutes::shipped().unwrap();
    let env = |name: &str| std::env::var(name).ok();
    let computer = crate::account::hooks::Computer {
        env: &env,
        home: Some(home),
        now_ms: chrono::Utc::now().timestamp_millis(),
    };
    let prepared = routes
        .prepare(
            "codex",
            "stop",
            &json!({"session_id":session,"transcript_path":path}),
            &computer,
        )
        .unwrap();
    let executions = prepared.input["executions"].as_array().unwrap();
    assert_eq!(executions.len(), 2);
    assert_eq!(
        executions[0]["receipt"]["call_id"],
        executions[1]["receipt"]["call_id"]
    );
    let id = format!(
        "execution:{}",
        executions[0]["receipt"]["call_id"].as_str().unwrap()
    );
    let (_, unregistered) = reply(
        &app,
        hook(&fixture.token, "unregistered", prepared.input.clone()),
    )
    .await;
    assert_eq!(unregistered["result"]["isError"], true, "{unregistered}");
    let (_, missing) = reply(
        &app,
        door_request(
            &fixture.token,
            "read-unregistered",
            "records:read",
            json!({"id":id}),
        ),
    )
    .await;
    assert_eq!(
        missing["result"]["structuredContent"]["value"],
        Value::Null,
        "{missing}"
    );
    let (_, started) = reply(
        &app,
        hook(
            &fixture.token,
            "register-source",
            json!({"harness":"codex","event":"sessionStart","payload":{"session_id":session}}),
        ),
    )
    .await;
    assert_eq!(
        started["result"]["structuredContent"]["refused"],
        json!([]),
        "{started}"
    );
    let mut forged = prepared.input.clone();
    forged["executions"][0]["receipt"]["actor"] = json!({"basis":"managed_dispatch"});
    let before = state(&fixture);
    let (_, refused) = reply(&app, hook(&fixture.token, "forged-actor", forged)).await;
    assert_eq!(refused["result"]["isError"], true, "{refused}");
    assert_eq!(state(&fixture), before);
    let (_, kept) = reply(
        &app,
        hook(&fixture.token, "actual-source", prepared.input.clone()),
    )
    .await;
    assert_eq!(
        kept["result"]["structuredContent"]["executions_accepted"]
            .as_array()
            .map(Vec::len),
        Some(2),
        "{kept}"
    );
    let read = |key: &str| {
        door_request(
            &fixture.token,
            key,
            "records:read",
            json!({"id":id,"type":"execution"}),
        )
    };
    let (_, record) = reply(&app, read("read-source")).await;
    let value = &record["result"]["structuredContent"]["value"];
    assert_eq!(value["call_id"], executions[0]["receipt"]["call_id"]);
    assert_eq!(value["capture_kind"], "host_transcript");
    assert_eq!(value["event_phase"], "returned");
    assert_eq!(value["actor"]["basis"], "unknown");
    assert_eq!(value["recorder"]["basis"], "authenticated");
    assert_eq!(value["coverage"]["before_dispatch"], false);
    assert_eq!(
        value["coverage"]["native_host"],
        "verified_transcript_occurrence"
    );
    assert_eq!(
        value["claimed"]["conversation_id"],
        format!("codex:{session}")
    );
    assert_eq!(
        value["links"]["record_refs"],
        json!(["record:fixture:input", file, "record:arbitrary-source-kind:first", "future-resource:audience-preference", "record:fixture:output"])
    );
    let expected_references: Vec<Value> = executions.iter()
        .flat_map(|observation| observation["receipt"]["references"].as_array().unwrap().iter().cloned()).collect();
    assert_eq!(value["references"], json!(expected_references), "lookup normalization must not rewrite exact source identities, paths or roles");
    assert!(value["references"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["basis"] == "claimed"));
    assert!(!record.to_string().contains("SYNTHETIC_SECRET_NOT_TO_KEEP"));
    assert!(!record.to_string().contains(path.to_str().unwrap()));
    let reverse = crate::record_value::account_routes::Door::shipped().unwrap().references_operation();
    assert!(!crate::record_value::account_routes::Door::shipped().unwrap().run_rules().grantable(reverse),
        "a tool-run rule must cover both target and holders before this read may be granted");
    let index_state = || {
        let db = Connection::open(fixture.root.join("records.sqlite")).unwrap();
        let mut kept = Vec::new();
        for (table, query) in [
            ("kept_holders", "SELECT * FROM kept_holders ORDER BY account,resource,participant,holder,role,ordinal"),
            ("kept_sets", "SELECT * FROM kept_sets ORDER BY account,resource,\"set\",holder,role"),
            ("kept_holders_walk", "SELECT * FROM kept_holders_walk ORDER BY account,resource,kind"),
        ] {
            let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)", [table], |row| row.get(0)).unwrap();
            let rows = if exists {
                Some(db.prepare(query).unwrap().query_map([], |row| {
                    (0..row.as_ref().column_count()).map(|column| row.get::<_, rusqlite::types::Value>(column)).collect::<Result<Vec<_>, _>>()
                }).unwrap().collect::<Result<Vec<_>, _>>().unwrap())
            } else { None };
            kept.push((table, rows));
        }
        kept
    };
    let before_reverse = state(&fixture);
    let before_reverse_index = index_state();
    for (key, target) in [("source-file-referrers", file.as_str()), ("source-row-referrers", "record:arbitrary-source-kind:first")] {
        let (_, reverse) = reply(&app, door_request(&fixture.token, key, reverse,
            json!({"id":target,"type":"execution","role":"record_refs","limit":3}))).await;
        assert_eq!(reverse["result"]["isError"], false, "{reverse}");
        let found = &reverse["result"]["structuredContent"]["records"];
        assert_eq!(found.as_array().unwrap().len(), 1, "{reverse}");
        assert_eq!(found[0]["id"], id, "{reverse}");
        assert_eq!(found[0]["via"][0]["role"], "record_refs", "{reverse}");
        assert!(found[0]["via"].as_array().unwrap().iter().all(|part| part["role"] == "record_refs"), "{reverse}");
    }
    assert_eq!(state(&fixture), before_reverse, "reverse inspection writes no record, journal receipt or index entry");
    assert_eq!(index_state(), before_reverse_index, "reverse inspection changes no index bytes or backfill state");
    let history = crate::record_value::account_routes::Door::shipped()
        .unwrap()
        .history_operation()
        .to_owned();
    let (_, prior) = reply(
        &app,
        door_request(
            &fixture.token,
            "history-before-retry",
            &history,
            json!({"id":id,"limit":10}),
        ),
    )
    .await;
    let (_, retry) = reply(
        &app,
        hook(&fixture.token, "actual-source", prepared.input.clone()),
    )
    .await;
    assert_eq!(
        retry["result"]["structuredContent"]["executions_accepted"],
        kept["result"]["structuredContent"]["executions_accepted"],
        "{retry}"
    );
    let (_, after) = reply(
        &app,
        door_request(
            &fixture.token,
            "history-after-retry",
            &history,
            json!({"id":id,"limit":10}),
        ),
    )
    .await;
    assert_eq!(
        after["result"]["structuredContent"], prior["result"]["structuredContent"],
        "a replay made no new source version"
    );
    let (_, ordinary) = reply(
        &app,
        door_request(
            &fixture.token,
            "ordinary-forgery",
            "records:write",
            json!({"records":[{"id":id,"type":"execution","value":{"actor":{"basis":"forged"}}}]}),
        ),
    )
    .await;
    assert_eq!(ordinary["result"]["isError"], true, "{ordinary}");
    let (_, again) = reply(&app, read("source-after-forgery")).await;
    assert_eq!(again["result"]["structuredContent"]["value"], *value);
    let (status, _) = reply(&app, hook("unissued", "wrong-key", prepared.input.clone())).await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
    let mut wrong = prepared.input.clone();
    wrong["executions"][0]["source"]["offset"] = json!(1);
    let (_, bad_offset) = reply(&app, hook(&fixture.token, "wrong-occurrence", wrong)).await;
    assert_eq!(bad_offset["result"]["isError"], true, "{bad_offset}");
    let mut manual = prepared.input.clone();
    manual["executions"][0]["receipt"]["capture_kind"] = json!("explicit_recording");
    let (_, manual) = reply(&app, hook(&fixture.token, "manual-is-not-native", manual)).await;
    assert_eq!(manual["result"]["isError"], true, "{manual}");

    // Canonicalization can expand a valid source alias. Preserve the original
    // per-key bound after resolution too, with the whole native transaction
    // refusing instead of keeping partial references or a partial phase.
    let rules: Value = serde_json::from_slice(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/account/hooks.json"))).unwrap();
    let max_id = rules["execution_references"]["max_id_chars"].as_u64().unwrap() as usize;
    let alias_prefix = "list:fixture-sources:rows:";
    let alias = format!("{alias_prefix}{}", "r".repeat(max_id - alias_prefix.len()));
    assert!(format!("record:arbitrary-source-kind:{}", &alias[alias_prefix.len()..]).len() > max_id);
    let oversized = json!({"type":"response_item","timestamp":"2026-11-07T12:00:03Z","payload":{
        "type":"function_call","call_id":"fixture-canonical-overflow","name":"read_source","arguments":json!({"item":alias}).to_string()}});
    use std::io::Write as _;
    fs::OpenOptions::new().append(true).open(&path).unwrap().write_all((oversized.to_string() + "\n").as_bytes()).unwrap();
    let expanded = routes.prepare("codex", "stop", &json!({"session_id":session,"transcript_path":path}), &computer).unwrap();
    assert!(expanded.input["executions"].as_array().unwrap().iter().any(|observation|
        observation["receipt"]["references"][0]["ref"] == alias));
    let before_overflow = (state(&fixture), index_state());
    let (_, overflow) = reply(&app, hook(&fixture.token, "canonical-source-key-overflow", expanded.input)).await;
    assert_eq!(overflow["result"]["isError"], true, "{overflow}");
    assert_eq!((state(&fixture), index_state()), before_overflow, "a canonical key overflow keeps no partial native phase, receipt, or index write");
}
