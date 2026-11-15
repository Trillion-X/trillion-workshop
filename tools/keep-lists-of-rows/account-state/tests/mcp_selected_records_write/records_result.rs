// Native result reconciliation over the existing synthetic selected-account fixture.
// Every result read, including unknown outcomes, leaves records, keys and journal unchanged.
use crate::{
    records::{Mutation, Records},
    storage::{
        record_store::{settings, RecordStore, RealClock},
        sqlite::{self, Bounds, Spend},
    },
};
use content_crypto::advanced::blake3;

fn fixture_for(name: &str) -> (Fixture, String) {
    let owner = blake3::hash(format!("synthetic-record-result:{name}").as_bytes())
        .to_hex()
        .to_string();
    (Fixture::owned_by(&owner), owner)
}
fn original_input(id: &str) -> Value {
    json!({"records":[{"id":id,"type":"note","value":{"words":"SYNTHETIC_RESULT_CANARY"}}]})
}
fn result_input(key: &str, input: &Value) -> Value {
    json!({"request_key":key,"operation":"records:write","input":input})
}
fn result_request(
    token: &str,
    delivery: &str,
    key: &str,
    input: &Value,
) -> axum::http::Request<axum::body::Body> {
    door_request(token, delivery, "records:result", result_input(key, input))
}
fn snapshot(fixture: &Fixture) -> Vec<(String, String, String)> {
    let db = Connection::open(fixture.root.join("records.sqlite")).unwrap();
    let mut statement = db
        .prepare("SELECT resource,id,hex(body) FROM versions ORDER BY resource,id,hex(body)")
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            let body: String = row.get(2)?;
            Ok((
                row.get(0)?,
                row.get(1)?,
                blake3::hash(body.as_bytes()).to_hex().to_string(),
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    rows
}
fn store(fixture: &Fixture) -> RecordStore<sqlite::Supply<Connection>> {
    let supply = sqlite::open_owned(
        &fixture.root.join("records.sqlite"),
        "record_store",
        Bounds {
            value_bytes: 2 * 1024 * 1024,
            work: u64::MAX / 2,
            deadline: std::time::Duration::MAX,
            spend: Spend::EachOperation,
            cancel: None,
            busy: std::time::Duration::from_secs(5),
        },
    )
    .unwrap();
    RecordStore::new(
        supply,
        Box::new(RealClock),
        settings::Limits::fixed(1 << 20, 10 << 30),
    )
    .unwrap()
}
fn rewrite(fixture: &Fixture, owner: &str, resource: &str, id: &str, value: Option<Value>) {
    let mut store = store(fixture);
    let expected_version = store.held_version(owner, resource, id).unwrap();
    store
        .mutate(
            owner,
            resource,
            Mutation {
                id: id.into(),
                expected_version,
                request_key: format!("synthetic-result-change:{resource}:{id}:{expected_version}"),
                deleted: value.is_none(),
                value: value.unwrap_or(Value::Null),
            },
        )
        .unwrap();
}
fn permit(fixture: &Fixture, owner: &str, token: &str, key: &str, input: &Value) -> String {
    let sign_in = fixture.kept.borrow().clone().unwrap();
    let principal = sign_in.authenticate(token.as_bytes()).unwrap();
    let operation = crate::mcp::Operation {
        resource: "@own-records".into(),
        operation: "records:write".into(),
        request_key: key.into(),
        input: input.clone(),
        person_present: None,
    };
    crate::native_boot::mcp_selected_personal::original_command_ids_at_resource(
        owner,
        &principal.sign_in,
        "@own-records",
        &operation,
    )
    .unwrap()
    .permit_id
}
fn refused(answer: &Value) {
    assert_eq!(answer["result"]["isError"], true, "{answer}");
    assert!(
        answer["result"]["structuredContent"]
            .get("write_count")
            .is_none(),
        "a refusal invents no no-effect receipt: {answer}"
    );
}

#[tokio::test]
async fn records_result_reopens_exact_original_without_new_records_keys_or_journal() {
    let (fixture, _) = fixture_for("exact-original");
    let app = route_table(&fixture);
    let mut input = original_input("result-exact");
    input["records"][0]["expected"] = Value::Null;
    let (_, written) = reply(
        &app,
        door_request(
            &fixture.token,
            "original-exact",
            "records:write",
            input.clone(),
        ),
    )
    .await;
    assert_eq!(written["result"]["isError"], false, "{written}");
    let before = snapshot(&fixture);
    for delivery in ["delivery-one", "delivery-two", "original-exact"] {
        let (_, read) = reply(
            &app,
            result_request(&fixture.token, delivery, "original-exact", &input),
        )
        .await;
        assert_eq!(read["result"], written["result"], "{read}");
        assert_eq!(snapshot(&fixture), before);
    }
    let mut later = original_input("result-exact");
    later["records"][0]["value"]["words"] = json!("LATER_SYNTHETIC_STATE");
    let (_, updated) = reply(
        &app,
        door_request(&fixture.token, "later-exact", "records:write", later),
    )
    .await;
    assert_eq!(updated["result"]["isError"], false, "{updated}");
    let before = snapshot(&fixture);
    let (_, original) = reply(
        &app,
        result_request(
            &fixture.token,
            "historical-exact-result",
            "original-exact",
            &input,
        ),
    )
    .await;
    assert_eq!(original["result"], written["result"], "the original receipt survives a later root despite its now-stale absence condition: {original}");
    assert_eq!(snapshot(&fixture), before);
    let mut changed = input.clone();
    changed["records"][0]["value"]["words"] = json!("OTHER_INPUT");
    for (key, given) in [
        ("original-exact", changed),
        ("unknown-original", input.clone()),
    ] {
        let (_, read) = reply(
            &app,
            result_request(&fixture.token, "wrong-original", key, &given),
        )
        .await;
        refused(&read);
        if key == "unknown-original" {
            assert_eq!(read["result"]["structuredContent"]["outcome"], "unknown");
        }
        assert_eq!(snapshot(&fixture), before);
    }
    let mut unknown = result_input("original-exact", &input);
    unknown["operation"] = json!("unknown:write");
    let (_, read) = reply(
        &app,
        door_request(
            &fixture.token,
            "unknown-operation",
            "records:result",
            unknown,
        ),
    )
    .await;
    refused(&read);
    assert_eq!(
        snapshot(&fixture),
        before,
        "unknown operation has no write fallback"
    );
}

#[tokio::test]
async fn records_result_never_borrows_another_caller_or_account_binding() {
    let (fixture, _) = fixture_for("wrong-caller");
    let app = route_table(&fixture);
    let input = original_input("result-caller");
    let (_, written) = reply(
        &app,
        door_request(
            &fixture.token,
            "original-caller",
            "records:write",
            input.clone(),
        ),
    )
    .await;
    assert_eq!(written["result"]["isError"], false);
    let (another_account, _) = fixture_for("another-account");
    assert!(
        another_account
            .kept
            .borrow()
            .as_ref()
            .unwrap()
            .authenticate(another_account.token.as_bytes())
            .is_ok(),
        "the other account's key is current there"
    );
    let before = snapshot(&fixture);
    for token in [&another_account.token] {
        let (status, read) = reply(
            &app,
            result_request(token, "wrong-caller-result", "original-caller", &input),
        )
        .await;
        if status == axum::http::StatusCode::OK {
            refused(&read)
        } else {
            assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED)
        }
        assert_eq!(snapshot(&fixture), before);
    }
}

#[tokio::test]
async fn records_result_missing_partial_and_erased_originals_never_execute_effects() {
    for damage in ["missing", "partial", "erased-result", "erased-result-key"] {
        let (fixture, owner) = fixture_for(damage);
        let app = route_table(&fixture);
        let input = original_input(&format!("result-{damage}"));
        let key = "original-damaged";
        let (_, written) = reply(
            &app,
            door_request(&fixture.token, key, "records:write", input.clone()),
        )
        .await;
        assert_eq!(written["result"]["isError"], false, "{written}");
        let permit = permit(&fixture, &owner, &fixture.token, key, &input);
        match damage {
            "missing" => rewrite(&fixture, &owner, "own-commands", &permit, None),
            "partial" => {
                let mut kept = store(&fixture)
                    .get(&owner, "own-commands", &permit)
                    .unwrap()
                    .record
                    .unwrap()
                    .value;
                kept["state"] = json!("working");
                rewrite(&fixture, &owner, "own-commands", &permit, Some(kept));
            }
            "erased-result" => rewrite(
                &fixture,
                &owner,
                "own-records",
                &format!("resource-command-result:{permit}"),
                None,
            ),
            _ => rewrite(
                &fixture,
                &owner,
                "own-record-keys",
                &format!("resource-command-result:{permit}"),
                Some(json!({"erased":true})),
            ),
        }
        let before = snapshot(&fixture);
        let (_, read) = reply(
            &app,
            result_request(&fixture.token, "damaged-result", key, &input),
        )
        .await;
        refused(&read);
        if matches!(damage, "missing" | "partial") {
            assert_eq!(
                read["result"]["structuredContent"]["outcome"], "unknown",
                "{read}"
            );
        }
        assert_eq!(
            snapshot(&fixture),
            before,
            "{damage}: no effect, key or journal creation"
        );
    }
}

#[tokio::test]
async fn records_result_run_keeps_original_scope_cause_and_live_parent() {
    use crate::account_rights::run_capability::{mint, Rights};
    let (fixture, owner) = fixture_for("run");
    let app = route_table(&fixture);
    let rights = |id: &str, operation: &str| {
        Rights::declared(
            &json!({"fd":3,"rights":[{"kind":"note","id":id,"operations":[operation]}]}),
        )
        .unwrap()
    };
    let run = mint(
        &owner,
        fixture.token.as_bytes(),
        rights("result-run", "records:write"),
        Some("original-cause"),
        std::time::Duration::from_secs(60),
    )
    .unwrap();
    let input = original_input("result-run");
    let key = "original-run";
    let (_, written) = reply(
        &app,
        door_request(run.token(), key, "records:write", input.clone()),
    )
    .await;
    assert_eq!(written["result"]["isError"], false, "{written}");
    let before = snapshot(&fixture);
    let (_, read) = reply(&app, result_request(run.token(), "run-result", key, &input)).await;
    assert_eq!(read["result"], written["result"], "{read}");
    assert_eq!(snapshot(&fixture), before);
    let other_cause = mint(
        &owner,
        fixture.token.as_bytes(),
        rights("result-run", "records:write"),
        Some("another-cause"),
        std::time::Duration::from_secs(60),
    )
    .unwrap();
    let other_id = mint(
        &owner,
        fixture.token.as_bytes(),
        rights("sibling", "records:write"),
        Some("original-cause"),
        std::time::Duration::from_secs(60),
    )
    .unwrap();
    let reader = mint(
        &owner,
        fixture.token.as_bytes(),
        rights("result-run", "records:read"),
        Some("original-cause"),
        std::time::Duration::from_secs(60),
    )
    .unwrap();
    for token in [other_cause.token(), other_id.token(), reader.token()] {
        let (_, read) = reply(
            &app,
            result_request(token, "outside-run-result", key, &input),
        )
        .await;
        refused(&read);
        assert_eq!(snapshot(&fixture), before);
    }
    let response = app
        .clone()
        .oneshot(result_request(run.token(), "ended-run-result", key, &input))
        .await
        .unwrap();
    drop(run);
    assert!(
        axum::body::to_bytes(response.into_body(), 65_536)
            .await
            .is_err(),
        "ended run releases no result body"
    );
    assert_eq!(snapshot(&fixture), before);
}

#[tokio::test]
async fn records_result_erased_after_dispatch_is_withheld_before_final_chunk() {
    for damage in ["key", "result", "journal"] {
        let (fixture, owner) = fixture_for(&format!("delivery-erasure-{damage}"));
        let app = route_table(&fixture);
        let input = original_input("result-delivery");
        let key = "original-delivery";
        let (_, written) = reply(
            &app,
            door_request(&fixture.token, key, "records:write", input.clone()),
        )
        .await;
        assert_eq!(written["result"]["isError"], false, "{written}");
        let permit = permit(&fixture, &owner, &fixture.token, key, &input);
        let (_, readable) = reply(
            &app,
            result_request(&fixture.token, "before-delivery-erasure", key, &input),
        )
        .await;
        assert_eq!(
            readable["result"], written["result"],
            "the intact original must deliver before this opponent: {readable}"
        );
        let response = app
            .clone()
            .oneshot(result_request(&fixture.token, "held-delivery", key, &input))
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let result_id = format!("resource-command-result:{permit}");
        match damage {
            "key" => rewrite(
                &fixture,
                &owner,
                "own-record-keys",
                &result_id,
                Some(json!({"erased":true})),
            ),
            "result" => rewrite(&fixture, &owner, "own-records", &result_id, None),
            _ => rewrite(&fixture, &owner, "own-commands", &permit, None),
        }
        let before = snapshot(&fixture);
        let body = axum::body::to_bytes(response.into_body(), 65_536).await;
        assert!(
            body.is_err(),
            "{damage}: erased original cannot leave as stale body: {body:?}"
        );
        assert_eq!(
            snapshot(&fixture),
            before,
            "delivery never recreates erased original state"
        );
    }
}

#[tokio::test]
async fn records_result_changed_workspace_refuses_dispatch_and_body() {
    for change in ["workspace"] {
        let (fixture, owner) = fixture_for(&format!("current-{change}"));
        let app = route_table(&fixture);
        let input = original_input("result-current");
        let key = "original-current";
        let (_, written) = reply(
            &app,
            door_request(&fixture.token, key, "records:write", input.clone()),
        )
        .await;
        assert_eq!(written["result"]["isError"], false, "{written}");
        let response = app
            .clone()
            .oneshot(result_request(&fixture.token, "held-current", key, &input))
            .await
            .unwrap();
        // Commands now read this copied canonical header, not the retired source table.
        let resource = crate::local_account::own_records::IDENTITY;
        let mut header = store(&fixture)
            .held_record_with_version(&owner, resource, "1")
            .unwrap()
            .1
            .unwrap()
            .value;
        let generation = header["generation"].as_i64().unwrap();
        assert_eq!(
            crate::local_account::own_records::original_generation(
                &store(&fixture),
                &owner
            )
            .unwrap(),
            Some(generation)
        );
        header["generation"] = json!(generation + 1);
        rewrite(&fixture, &owner, resource, "1", Some(header));
        // Read through the proof's actual generation owner, so this
        // opponent cannot pass by changing only a retired import table.
        assert_eq!(
            crate::local_account::own_records::original_generation(
                &store(&fixture),
                &owner
            )
            .unwrap(),
            Some(generation + 1)
        );
        assert!(
            !crate::local_account::own_records::original_generation_matches(
                &store(&fixture),
                &owner,
                generation,
            )
            .unwrap()
        );
        let before = snapshot(&fixture);
        assert!(
            axum::body::to_bytes(response.into_body(), 65_536)
                .await
                .is_err(),
            "{change}: changed authority cannot release a stale result body"
        );
        let (status, read) = reply(
            &app,
            result_request(&fixture.token, "after-current-change", key, &input),
        )
        .await;
        if status == axum::http::StatusCode::OK {
            refused(&read);
        } else {
            assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
        }
        assert_eq!(snapshot(&fixture), before);
    }
}

