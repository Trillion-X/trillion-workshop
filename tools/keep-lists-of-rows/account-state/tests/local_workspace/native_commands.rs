//! Actual HTTP-authenticated context -> selected native owner -> same parent.
use super::*;
use std::time::{Duration, Instant};
use trillion_local::{
    ecma_json::{self, Value as Ecma},
    kept_runs::{KeptRuns, Settings as KeptSettings},
    local_account::record_writer::native_command_context::NativeCommandCall,
    record_log::{Context, LogIds, Request},
};
struct Ids(u16);
impl LogIds for Ids {
    fn next_log_id(&mut self) -> Option<String> {
        self.0 += 1;
        Some(format!("01234567-89ab-7{:03x}-8f01-000000000001", self.0))
    }
}
fn record_source(f: &Fixture) {
    let db = Connection::open(&f.records).unwrap();
    db.execute_batch("CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT);
        CREATE TABLE record_erasable_keys(record_id TEXT PRIMARY KEY,key BLOB,erased_at TEXT,erased_fields TEXT) WITHOUT ROWID;
        CREATE TABLE resource_behavior_commands(permit_id TEXT PRIMARY KEY,identity TEXT NOT NULL,operation TEXT NOT NULL,input TEXT NOT NULL,context TEXT NOT NULL,state TEXT NOT NULL,result TEXT,execution_ref TEXT);").unwrap();
    let tx = db.unchecked_transaction().unwrap();
    let _runs = KeptRuns::create(&tx, "record_keys", KeptSettings::default()).unwrap();
    tx.execute(
        "INSERT INTO record_keys_meta VALUES('engine','\"record-log\"')",
        [],
    )
    .unwrap();
    tx.commit().unwrap();
}
/// Version rows of the account's own records, command records and field keys, and the old engine's journal,
/// command and erasable-key rows: a command writes record store only.
fn rows(f: &Fixture) -> [i64; 6] {
    let db = Connection::open(&f.records).unwrap();
    let count = |sql: &str| -> i64 { db.query_row(sql, [], |r| r.get(0)).unwrap() };
    [
        count("SELECT COUNT(*) FROM versions WHERE resource='own-records'"),
        count("SELECT COUNT(*) FROM versions WHERE resource='own-commands'"),
        count("SELECT COUNT(*) FROM versions WHERE resource='own-record-keys'"),
        count("SELECT COUNT(*) FROM record_log"),
        count("SELECT COUNT(*) FROM resource_behavior_commands"),
        count("SELECT COUNT(*) FROM record_erasable_keys"),
    ]
}
async fn context(f: &Fixture) -> (axum::response::Response, DomainContext) {
    let response = f
        .app
        .clone()
        .oneshot(request("GET", "/work/api/records", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let context = f.adapter.head_context.lock().unwrap().take().unwrap();
    (response, context)
}
#[tokio::test]
async fn actual_http_context_reaches_selected_native_batch_once_for_two_settings() {
    let f = Fixture::new(&[]);
    record_source(&f);
    f.first_start();
    let before = rows(&f);
    let (_response, context) = context(&f).await;
    let command = DomainCommand {
        operation: "fixture:selected-setting-batch".into(),
        input: json!({}),
        request_key: "selected-parent".into(),
        key_carried: true,
    };
    let schema = ecma_json::parse(br#"{"type":"object"}"#, Default::default()).unwrap();
    let request = Request {
        key: command.request_key.clone(),
        sent_at_ms: 1,
    };
    let clock = Context {
        actor: json!({}),
        application_time: "fixture".into(),
        system_time: "fixture".into(),
        accepted_at_ms: 1,
    };
    let identity = format!("1f:{}", "a".repeat(64));
    let call = NativeCommandCall::from_domain(
        &context,
        &command,
        &schema,
        "fixture-selected-parent",
        &identity,
        &request,
        &clock,
        Instant::now() + Duration::from_secs(5),
    );
    let reached = std::cell::Cell::new(0usize);
    let answer = f
        .owner
        .lock()
        .unwrap()
        .native_setting_batch(&call, &mut Ids(0), |tx| {
            reached.set(1);
            tx.compare_and_set_setting(&"one".into(), None, &Ecma::Bool(true))?;
            reached.set(2);
            tx.compare_and_set_setting(&"two".into(), None, &Ecma::Bool(false))?;
            reached.set(3);
            Ok(())
        });
    assert_eq!(
        reached.get(),
        3,
        "native effect stopped at phase {} with {answer:?}",
        reached.get()
    );
    let answer = answer.unwrap();
    assert_eq!(
        ecma_json::stringify(&answer.value, Default::default()).unwrap(),
        r#"{"changed":true,"write_count":2}"#
    );
    let after = rows(&f);
    // Two settings, the execution and the result: four records; one command record; the result's key. One write
    // each, and none to the old engine's tables.
    assert_eq!(
        std::array::from_fn::<i64, 6, _>(|i| after[i] - before[i]),
        [4, 1, 1, 0, 0, 0]
    );
    let db = Connection::open(&f.records).unwrap();
    let state: String = db
        .query_row(
            &format!("SELECT json_extract(CAST(body AS TEXT),'$.state') FROM versions WHERE resource='own-commands' AND valid_to={}", i64::MAX),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, "committed");
}
#[tokio::test]
async fn boot_descriptor_withdrawal_inside_local_effect_rolls_back_all_parent_work() {
    let f = Fixture::new(&[]);
    record_source(&f);
    f.first_start();
    let before = rows(&f);
    let (_response, context) = context(&f).await;
    let command = DomainCommand {
        operation: "fixture:selected-setting-batch".into(),
        input: json!({}),
        request_key: "selection-withdraw".into(),
        key_carried: true,
    };
    let schema = ecma_json::parse(br#"{"type":"object"}"#, Default::default()).unwrap();
    let request = Request {
        key: command.request_key.clone(),
        sent_at_ms: 1,
    };
    let clock = Context {
        actor: json!({}),
        application_time: "fixture".into(),
        system_time: "fixture".into(),
        accepted_at_ms: 1,
    };
    let identity = format!("1f:{}", "a".repeat(64));
    let call = NativeCommandCall::from_domain(
        &context,
        &command,
        &schema,
        "fixture-selection-withdraw",
        &identity,
        &request,
        &clock,
        Instant::now() + Duration::from_secs(5),
    );
    let descriptor = f._temp.path().join("adoption.json");
    let reached = std::cell::Cell::new(false);
    let result = f
        .owner
        .lock()
        .unwrap()
        .native_setting_batch(&call, &mut Ids(0), |tx| {
            reached.set(true);
            tx.compare_and_set_setting(&"one".into(), None, &Ecma::Bool(true))?;
            let mut bytes = fs::read(&descriptor).unwrap();
            bytes.push(b' ');
            fs::write(&descriptor, bytes).unwrap();
            Ok(())
        });
    assert!(
        reached.get(),
        "descriptor withdrawal control did not reach its effect: {result:?}"
    );
    assert!(result.is_err());
    assert_eq!(rows(&f), before);
}
