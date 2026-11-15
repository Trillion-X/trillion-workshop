//! The account's own record write (`own-record-writes.json`) through the
//! browser door: POST /work/api/records { records } reaches the same one write
//! an agent's run_resource_operation reaches, once per request key. Record
//! words are synthetic fixture text.
use super::*;
use std::time::Duration;
use trillion_local::{
    records::Records,
    wake::Waker,
    storage::{
        record_store::{settings, RecordStore, RealClock},
        sqlite::{self, Bounds, Spend},
    },
};

/// The account's own records (record store), read as a fixture inspector.
fn store(f: &Fixture) -> RecordStore<sqlite::Supply<Connection>> {
    let bounds = Bounds {
        value_bytes: 2 * 1024 * 1024,
        work: u64::MAX / 2,
        deadline: Duration::MAX,
        spend: Spend::EachOperation,
        cancel: None,
        busy: Duration::from_secs(5),
    };
    let supply = sqlite::open_owned(&f.records, "record_store", bounds).unwrap();
    RecordStore::new(supply, Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap()
}
/// Version rows (history included) of the account's own records and of its command records.
fn counts(f: &Fixture) -> (i64, i64) {
    let db = Connection::open(&f.records).unwrap();
    let rows = |resource: &str| -> i64 {
        db.query_row("SELECT COUNT(*) FROM versions WHERE resource=?", [resource], |r| r.get(0)).unwrap()
    };
    (rows("own-records"), rows("own-commands"))
}
pub(super) fn post(key: &str, body: &Value) -> Request<Body> {
    let mut post = request("POST", "/work/api/records", Some(&body.to_string()));
    post.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    post.headers_mut().insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    post.headers_mut().insert("x-trillion-request-key", key.parse().unwrap());
    post
}
async fn send(f: &Fixture, key: &str, body: &Value) -> (StatusCode, Value) {
    let response = f.app.clone().oneshot(post(key, body)).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 65_536).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}
fn pursuit(now: &str) -> Value {
    json!({"records":[{"id":"pursuit:from-browser","type":"pursuit","value":{"title":"BROWSER_PURSUIT_CANARY","now":now,"after":"done"}}]})
}

/// A fixture whose own records are on record store after the first start (the migration's one retained page, the
/// own-record resource's identity header at generation 1).
pub(super) fn started_fixture() -> Fixture {
    started_fixture_for_owner(OWNER_ID)
}

fn started_fixture_for_owner(owner_id: &str) -> Fixture {
    let rows = if owner_id == OWNER_ID { vec![("saved-board", r#"{"items":["kept"]}"#)] } else { Vec::new() };
    let f = Fixture::new_with_profile_owner(&rows, None, owner_id);
    // The original records the first start migrates (one retained page) and
    // the own-record resource's identity header at generation 1.
    let db = Connection::open(&f.records).unwrap();
    db.execute_batch(&format!(
        "CREATE TABLE own_resource_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,resource TEXT NOT NULL,generation INTEGER NOT NULL,ready INTEGER NOT NULL);
         INSERT INTO own_resource_identity VALUES(1,'{owner_id}','@own-records',1,1);
         CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
         INSERT INTO record_keys_meta VALUES('engine','\"record-log\"');
         CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT);
         CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER);
         CREATE TABLE record_keys_big(ref TEXT,part INTEGER,body TEXT,PRIMARY KEY(ref,part)) WITHOUT ROWID;
         CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT NOT NULL);"
    )).unwrap();
    let key = "i\0root";
    let first = serde_json::to_string(key).unwrap();
    let value = r#"["page","retained-sequence",{"fixture":"kept"},{"at":"retained-stamp"}]"#;
    let page = format!("{}\n{value}", json!({"p":[0],"s":[key],"d":[value.encode_utf16().count()]}));
    db.execute("INSERT INTO record_keys_runs VALUES(1,1,1,?,0,1)", [&first]).unwrap();
    db.execute("INSERT INTO record_keys_run_1 VALUES(0,?,?)", rusqlite::params![first, page]).unwrap();
    drop(db);
    f.first_start();
    f
}

/// A scoped success uses a canonical synthetic policy, including its actual
/// account owner. Legacy/noncanonical controls retain started_fixture unchanged.
pub(super) fn canonical_started_fixture() -> Fixture {
    canonical_started_fixture_for_owner(OWNER_ID)
}

pub(super) fn canonical_started_fixture_for_owner(owner_id: &str) -> Fixture {
    let f = started_fixture_for_owner(owner_id);
    let policy = Connection::open(f.records.parent().unwrap().join("policy.sqlite")).unwrap();
    let tx = policy.unchecked_transaction().unwrap();
    let current: String = tx.query_row("SELECT value FROM policy_directory WHERE name='policy-source:account'", [], |row|row.get(0)).unwrap();
    let mut value: Value = serde_json::from_str(&current).unwrap();
    value["account_controls"]["owner_user_id"] = json!(f.user);
    tx.execute("UPDATE policy_directory SET value=? WHERE name='policy-source:account'", [value.to_string()]).unwrap();
    tx.execute("UPDATE policy_directory SET value=? WHERE name='policy-source'", [json!({"from":"born","missing":[]}).to_string()]).unwrap();
    tx.commit().unwrap();
    f
}

#[tokio::test]
async fn real_http_write_reports_its_complete_numeric_work_after_original_custody() {
    use http_body::Body as _;
    use std::pin::Pin;
    let f = started_fixture();
    // The first write of a new store makes its declared tables and indexes (`first_write.rs`), a schema change that
    // re-prepares the statements cached by the reads before it; that request is not counted complete. The counted
    // request is a steady-state write, after the schema exists.
    let warm = f.app.clone().oneshot(post("request-work-warm", &pursuit("warm"))).await.unwrap();
    assert_eq!(warm.status(), StatusCode::OK);
    let mut request = post("request-work-browser", &pursuit("counted"));
    request.headers_mut().insert("prefer", "storage-work".parse().unwrap());
    request.headers_mut().insert("te", "trailers".parse().unwrap());
    let response = f.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["storage-work"], "pending");
    assert!(response.headers()[header::TRAILER].to_str().unwrap().contains("storage-work"));
    let mut body = response.into_body(); let mut bytes = Vec::new(); let mut trailers = axum::http::HeaderMap::new();
    while let Some(frame) = std::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await {
        match frame.unwrap().into_data() {
            Ok(data) => bytes.extend_from_slice(&data),
            Err(frame) => if let Ok(held) = frame.into_trailers() { trailers.extend(held); },
        }
    }
    let observed = trailers["storage-work"].to_str().unwrap();
    assert!(observed.ends_with("complete=?1"), "{observed}");
    let read_count = observed.split(", ").find_map(|piece| piece.strip_prefix("read-queries=")).unwrap().parse::<u64>().unwrap();
    let statement_count = observed.split(", ").find_map(|piece| piece.strip_prefix("statements=")).unwrap().parse::<u64>().unwrap();
    assert!(read_count > 0 && statement_count > read_count, "admission, record reads and atomic effects all count: {observed}");
    let answer: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(answer, json!({"changed":true,"write_count":1}));
}

#[tokio::test]
async fn ordinary_browser_writes_keep_their_original_framing_and_unsupported_measurement_is_explicit() {
    let f = started_fixture();
    let response = f.app.clone().oneshot(post("ordinary-framing", &pursuit("ordinary"))).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get("storage-work").is_none());
    assert!(response.headers().get(header::TRAILER).is_none());
    let original = to_bytes(response.into_body(), 65_536).await.unwrap();
    let mut requested = post("ordinary-framing", &pursuit("ordinary"));
    requested.headers_mut().insert("prefer", "storage-work".parse().unwrap());
    let response = f.app.clone().oneshot(requested).await.unwrap();
    assert_eq!(response.headers()["storage-work"], "unavailable", "without TE: trailers no complete number is promised");
    assert!(response.headers().get(header::TRAILER).is_none());
    assert_eq!(to_bytes(response.into_body(), 65_536).await.unwrap(), original);
}

#[tokio::test]
async fn post_records_creates_then_updates_a_record_once_per_request_key() {
    let f = started_fixture();
    let before = counts(&f);

    let (status, created) = send(&f, "browser-create", &pursuit("starting")).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created, json!({"changed":true,"write_count":1}));
    assert_eq!(counts(&f).1, before.1 + 1, "one command record");

    let (status, updated) = send(&f, "browser-update", &pursuit("halfway")).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated, json!({"changed":true,"write_count":1}));
    let after_update = counts(&f);
    let (status, again) = send(&f, "browser-update", &pursuit("halfway")).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again, updated, "the same request key answers the saved receipt");
    assert_eq!(counts(&f), after_update, "a repeated request key writes nothing");

    let stored = store(&f).get(OWNER_ID, "own-records", "pursuit:from-browser").unwrap().record.unwrap().value;
    let stored = stored["stored"].as_str().unwrap();
    assert!(stored.contains("halfway") && stored.contains("BROWSER_PURSUIT_CANARY"), "{stored}");

    let (status, refused) = send(&f, "browser-receipt", &json!({"records":[{"id":"execution:forged","type":"pursuit","value":{}}]})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(refused["error"], "original_input_refused");
    assert_eq!(counts(&f), after_update, "a refused write writes nothing");

    // The page reads the record back through the records door's generic read (GET /work/api/door/<operation>), the
    // read an AI's key reaches over MCP, admitted by the page's own session.
    let read = |operation: &str, input: Option<Value>| {
        let query = input.map(|input| {
            url::form_urlencoded::Serializer::new(String::new()).append_pair("input", &input.to_string()).finish()
        });
        let path = format!("/work/api/door/{operation}{}", query.map(|query| format!("?{query}")).unwrap_or_default());
        let app = f.app.clone();
        async move {
            let response = app.oneshot(request("GET", &path, None)).await.unwrap();
            let status = response.status();
            let bytes = to_bytes(response.into_body(), 65_536).await.unwrap();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null))
        }
    };
    let (status, page) = read("records:list", Some(json!({"type":"pursuit","reverse":true}))).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["records"][0]["id"], "pursuit:from-browser", "{page}");
    assert_eq!(page["records"][0]["value"]["now"], "halfway", "{page}");
    let (status, one) = read("records:read", Some(json!({"id":"pursuit:from-browser"}))).await;
    assert_eq!(status, StatusCode::OK, "{one}");
    assert_eq!(one["value"]["title"], "BROWSER_PURSUIT_CANARY", "{one}");
    // Only the door's reads: a write, a wake or a malformed input is refused, and nothing is written.
    for (operation, input) in [
        ("records:write", Some(json!({"records":[]}))),
        ("wake:causes", None),
        ("records:read", Some(json!(["not an object"]))),
    ] {
        let (status, refused) = read(operation, input).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{operation}: {refused}");
    }
    assert_eq!(counts(&f), after_update, "the page's reads write nothing");
    // A page's re-set copies the stored value, stamp included: no run caused this write, so the stamp is dropped and
    // the change feed will admit it.
    let stamp = Waker::shipped().unwrap().cause_field().to_owned();
    let stale = json!({"records":[{"id":"pursuit:from-browser","type":"pursuit","value":{"title":"BROWSER_PURSUIT_CANARY","now":"again",&stamp:"an-old-run"}}]});
    let (status, written) = send(&f, "browser-stale-stamp", &stale).await;
    assert_eq!(status, StatusCode::OK, "{written}");
    let (_, one) = read("records:read", Some(json!({"id":"pursuit:from-browser"}))).await;
    assert_eq!(one["value"]["now"], "again", "{one}");
    assert!(one["value"].get(&stamp).is_none(), "the stale run stamp was dropped: {one}");
}

/// The owner's live window writes a real record and reads it back.
#[tokio::test]
async fn the_window_writes_a_record_and_reads_it_back() {
    let f = started_fixture();
    let (status, created) = send(&f, "window-write", &pursuit("written-by-window")).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created, json!({"changed":true,"write_count":1}));
    let read = || {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("input", &json!({"id":"pursuit:from-browser"}).to_string())
            .finish();
        let app = f.app.clone();
        async move {
            let response = app.oneshot(request("GET", &format!("/work/api/door/records:read?{query}"), None)).await.unwrap();
            let status = response.status();
            let bytes = to_bytes(response.into_body(), 65_536).await.unwrap();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null))
        }
    };
    let (status, one) = read().await;
    assert_eq!(status, StatusCode::OK, "{one}");
    assert_eq!(one["value"]["title"], "BROWSER_PURSUIT_CANARY", "{one}");
    assert_eq!(one["value"]["now"], "written-by-window", "{one}");
}

/// A page's boot makes about thirty-five writes while it reads records: a read that overlaps writes waits its turn at
/// the account and answers; none is refused as a conflict.
#[tokio::test]
async fn page_reads_that_overlap_a_boots_writes_all_answer() {
    let f = started_fixture();
    let (status, created) = send(&f, "boot-first", &pursuit("starting")).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let writes = (0..35).map(|n| {
        let f = &f;
        async move {
            let body = json!({"records":[{"id":format!("pursuit:boot-{n}"),"type":"pursuit","value":{"title":"BOOT_WRITE","now":n}}]});
            send(f, &format!("boot-write-{n}"), &body).await
        }
    });
    let reads = (0..35).map(|n| {
        let f = &f;
        async move {
            let label = if n % 2 == 0 { "pursuit:from-browser" } else { "pursuit:boot-1" };
            let response = f.app.clone().oneshot(request("GET", &format!("/work/api/records?label={label}"), None)).await.unwrap();
            let status = response.status();
            let delivered = to_bytes(response.into_body(), 1024 * 1024).await.is_ok();
            (status, delivered)
        }
    });
    let (written, read) = tokio::join!(futures::future::join_all(writes), futures::future::join_all(reads));
    // A write waits at most BEGIN_WAIT (one second) for the record file's write lock, then answers busy: under this many
    // writers on a loaded machine that answer is the product's, not a lost write. Any other refusal fails the test.
    let busy = |(status, answer): &(StatusCode, Value)| {
        *status == StatusCode::OK
            || (*status == StatusCode::SERVICE_UNAVAILABLE && answer["error"] == "original_workspace_source_unavailable")
    };
    assert!(written.iter().all(busy), "writes: {written:?}");
    let refused: Vec<_> = read.iter().filter(|(status, delivered)| *status != StatusCode::OK || !delivered).collect();
    assert!(refused.is_empty(), "{} of {} reads were refused: {refused:?}", refused.len(), read.len());
}

/// The page's records read never queues behind the account's writer: with a write holding the account for longer than
/// the read's own two seconds, the read is admitted, read and delivered on the admission owner and answers.
#[tokio::test]
async fn a_page_records_read_answers_while_a_write_holds_the_account() {
    ADMIT_APART.with(|apart| apart.set(true));
    let f = started_fixture();
    let (status, created) = send(&f, "held-first", &pursuit("starting")).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let held = f.owner.lock().unwrap();
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        f.app.clone().oneshot(request("GET", "/work/api/records?label=pursuit:from-browser", None)),
    )
    .await
    .expect("the read does not wait for the writer")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = tokio::time::timeout(Duration::from_secs(5), to_bytes(response.into_body(), 1024 * 1024))
        .await
        .expect("the body is delivered without the writer")
        .unwrap();
    assert!(serde_json::from_slice::<Value>(&body).unwrap()["records"].is_object(), "the page gets its records answer");
    drop(held);
}

/// The real browser's records writer is independent of the primary account hold, including a duplicate receipt.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn browser_records_writes_and_retries_finish_with_the_primary_account_held() {
    ADMIT_APART.with(|flag| flag.set(true));
    let f = started_fixture();
    let (status, warm) = send(&f, "before-browser-owner-hold", &pursuit("warm")).await;
    assert_eq!(status, StatusCode::OK, "{warm}");
    let held = f.owner.lock().unwrap();
    let started = std::time::Instant::now();
    let body = pursuit("while-the-primary-is-held");
    let (status, written) = tokio::time::timeout(Duration::from_secs(2), send(&f, "browser-with-owner-held", &body))
        .await.expect("the browser's records writer waited for the primary account hold");
    assert_eq!(status, StatusCode::OK, "{written}");
    let after = counts(&f);
    let (status, duplicate) = send(&f, "browser-with-owner-held", &body).await;
    assert_eq!(status, StatusCode::OK, "{duplicate}");
    assert_eq!(written, duplicate);
    assert_eq!(counts(&f), after, "a duplicate writes nothing");
    let stored = store(&f).get(OWNER_ID, "own-records", "pursuit:from-browser").unwrap().record.unwrap().value;
    assert!(stored["stored"].as_str().unwrap().contains("while-the-primary-is-held"));
    println!("browser records primary-owner-held: committed=1 duplicate=1 readback=1 elapsed_ms={:.3}", started.elapsed().as_secs_f64()*1000.0);
    drop(held);
}

/// M08: the next request is always a new read, without retries or a caller token.
/// Creates, later updates and tombstones all cross the real browser adapter.
#[tokio::test]
async fn immediate_browser_reads_include_100_acknowledged_creates_updates_and_deletes() {
    ADMIT_APART.with(|apart| apart.set(true));
    let f = started_fixture();
    let id = "pursuit:from-browser";
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("input", &json!({"id":id}).to_string()).finish();
    let read_path = format!("/work/api/door/records:read?{query}");
    for n in 0..100 {
        for (phase, body, expected) in [
            ("create", pursuit(&format!("created-{n}")), Some(format!("created-{n}"))),
            ("update", pursuit(&format!("updated-{n}")), Some(format!("updated-{n}"))),
            ("delete", json!({"records":[{"id":id,"type":"pursuit","value":null}]}), None),
        ] {
            let (status, wrote) = send(&f, &format!("m08-{phase}-{n}"), &body).await;
            assert_eq!(status, StatusCode::OK, "{phase} {n}: {wrote}");
            assert_eq!(wrote, json!({"changed":true,"write_count":1}));
            let response = f.app.clone().oneshot(request("GET", &read_path, None)).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{phase} {n}");
            let bytes = to_bytes(response.into_body(), 65_536).await.unwrap();
            let one: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(one["id"], id, "{phase} {n}: {one}");
            match expected {
                Some(now) => assert_eq!(one["value"]["now"], now, "{phase} {n}: {one}"),
                None => assert_eq!(one.get("value"), Some(&Value::Null), "deleted {n}: {one}"),
            }
        }
    }
}

mod independent_domains {
    use super::*;
    use std::{sync::{atomic::AtomicBool, mpsc}, time::Instant};
    use trillion_local::storage::record_store_resources::{domains, StateResources};

    fn scope(id: &str, create: bool) -> Value {
        let mut value = json!({"id":id,"incarnation":"original","generation":1});
        if create { value["create"] = json!(true); }
        value
    }
    fn row(text: &str) -> Value {
        json!({"id":"record:proof:row","type":"record:proof","value":{"text":text}})
    }
    fn definition() -> Value {
        json!({"id":"list:proof","type":"list","value":{
            "id":"proof","label":"Synthetic proof","row_type":"proof","title_field":"text",
            "fields":[{"id":"text","label":"Text","kind":"text"}]
        }})
    }
    async fn write(f: &Fixture, key: &str, context: Value, records: Value) -> (StatusCode, Value) {
        send(f,key,&json!({"scope":context,"records":records})).await
    }
    async fn read(f: &Fixture, context: Value) -> (StatusCode, Value) {
        read_input(f, json!({"scope":context,"id":"record:proof:row"})).await
    }
    async fn read_input(f: &Fixture, input: Value) -> (StatusCode, Value) {
        let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("input", &input.to_string()).finish();
        let response = f.app.clone().oneshot(request("GET", &format!("/work/api/door/records:read?{query}"), None)).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn a_public_list_commit_and_new_read_finish_before_another_lists_hold_releases() {
        ADMIT_APART.with(|apart| apart.set(true));
        let f = canonical_started_fixture();
        for (id, value) in [("left","left-before"),("right","right-before")] {
            let (status, result) = write(&f, &format!("create-{id}"), scope(id,true), json!([definition(),row(value)])).await;
            assert_eq!(status, StatusCode::OK, "{result}");
        }
        let resources = Arc::new(StateResources::new(f.records.parent().unwrap(), trillion_local::sqlite_work::WorkMeter::new()).unwrap());
        let selected: domains::Selection = serde_json::from_value(scope("left",false)).unwrap();
        let held = domains::Bound::new(resources, OWNER_ID, selected, 1).unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let holder = std::thread::spawn(move || {
            let writer = held.writer().unwrap();
            let source = writer.lend(Arc::new(AtomicBool::new(false)), Instant::now()+Duration::from_secs(30)).unwrap();
            let transaction = source.begin(sqlite::TransactionBehavior::Immediate).unwrap();
            entered_tx.send(()).unwrap();
            // The channel establishes order; this is only a deadlock watchdog.
            let _ = release_rx.recv_timeout(Duration::from_secs(30));
            transaction.rollback().unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            let (status, value) = write(&f, "right-while-left-held", scope("right",false), json!([row("committed-before-release")])).await;
            assert_eq!(status, StatusCode::OK, "{value}");
            let (status, value) = read(&f, scope("right",false)).await;
            assert_eq!(status, StatusCode::OK, "{value}");
            assert_eq!(value["value"]["text"], "committed-before-release");
        }).await;
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        result.expect("B must commit and read before the channel releases A");
    }

    #[tokio::test]
    async fn scoped_versions_cannot_cross_histories_and_100_new_reads_include_the_acknowledged_write() {
        ADMIT_APART.with(|apart| apart.set(true));
        let f = canonical_started_fixture();
        for id in ["left","right"] {
            let (status, value) = write(&f, &format!("create-{id}"), scope(id,true), json!([definition(),row("initial")])).await;
            assert_eq!(status, StatusCode::OK, "{value}");
        }
        let (status, left) = read(&f, scope("left",false)).await;
        assert_eq!(status, StatusCode::OK, "{left}");
        assert_eq!(left["scope"], scope("left",false), "returned references retain their admitted history");
        let mut conditional = row("must-refuse");
        conditional["expected"] = json!({"type":"record:proof","identity":left["identity"]});
        assert_eq!(write(&f,"cross-history-version",scope("right",false),json!([conditional])).await.0, StatusCode::CONFLICT);
        let mut measured_statements = 0;
        let mut measured_visits = 0;
        for sequence in 0..100 {
            let expected = format!("value-{sequence}");
            let observation = f.owner.lock().unwrap().begin_sql_observation().unwrap();
            let (status, value) = write(&f,&format!("scope-write-{sequence}"),scope("right",false),json!([row(&expected)])).await;
            assert_eq!(status, StatusCode::OK, "{sequence}: {value}");
            let work = observation.finish().unwrap().work;
            assert!(work.sql_statements > 0);
            measured_statements += work.sql_statements;
            measured_visits += work.sqlite_scan_visits;
            let (status, value) = read(&f,scope("right",false)).await;
            assert_eq!(status, StatusCode::OK, "{sequence}: {value}");
            assert_eq!(value["value"]["text"],expected);
            assert_eq!(value["scope"],scope("right",false));
        }
        eprintln!("scoped-list-storage-summary writes=100 new_reads=100 correct=100 statements={measured_statements} scan_visits={measured_visits}");
        for context in [json!({"id":"right","incarnation":"other","generation":1}),
            json!({"id":"right","incarnation":"original","generation":2}), scope("missing",false)] {
            assert_ne!(read(&f,context).await.0,StatusCode::OK);
        }
        assert_ne!(read(&f,scope("right",true)).await.0,StatusCode::OK,"reads cannot create an empty replacement");
    }
    #[tokio::test]
    async fn list_creation_uses_returned_generation_and_catalog_reference_reads_the_scoped_definition() {
        ADMIT_APART.with(|apart| apart.set(true));
        let f = canonical_started_fixture();
        let (status, missing) = read_input(&f,json!({"id":"list:proof","type":"list"})).await;
        assert_eq!(status,StatusCode::OK,"{missing}");
        assert!(missing["value"].is_null());
        assert_eq!(missing["context"],json!({"generation":1}));
        let selected=json!({"id":"list:proof","incarnation":"list:proof","generation":missing["context"]["generation"]});
        let mut create=selected.clone();create["create"]=json!(true);
        let mut definition=definition();definition["expected"]=Value::Null;
        let (status,created)=write(&f,"list-scoped-definition",create,json!([definition])).await;
        assert_eq!(status,StatusCode::OK,"{created}");
        let reference=json!({"records":[{"id":"list:proof","type":"list","value":{"record_scope":selected},"expected":null}]});
        let (status,published)=send(&f,"list-catalog-reference",&reference).await;
        assert_eq!(status,StatusCode::OK,"{published}");
        let (_,catalog)=read_input(&f,json!({"id":"list:proof","type":"list"})).await;
        assert_eq!(catalog["value"]["record_scope"],selected);
        let (status,definition)=read_input(&f,json!({"id":"list:proof","type":"list","scope":catalog["value"]["record_scope"]})).await;
        assert_eq!(status,StatusCode::OK,"{definition}");
        assert_eq!(definition["value"]["row_type"],"proof");
        assert_eq!(definition["context"],json!({"generation":1}));
        assert_eq!(definition["scope"],selected);
    }

    #[tokio::test]
    async fn native_read_cannot_bypass_an_unmaterialized_zero_cut_map_using_its_old_ready_header() {
        use trillion_local::storage::{memory::Memory,sqlite};
        use trillion_local::storage::record_store_resources::carry::{live_adopt,commit_log::opaque_map};
        ADMIT_APART.with(|apart|apart.set(true));let f=canonical_started_fixture();
        let(status,result)=write(&f,"guard-domain-create",scope("guard",true),json!([definition(),row("old plaintext")])).await;
        assert_eq!(status,StatusCode::OK,"{result}");assert_eq!(read(&f,scope("guard",false)).await.0,StatusCode::OK);
        let resources=Arc::new(StateResources::new(f.records.parent().unwrap(),trillion_local::sqlite_work::WorkMeter::new()).unwrap());
        let selected:domains::Selection=serde_json::from_value(scope("guard",false)).unwrap();
        let domain=domains::Bound::new(resources,OWNER_ID,selected.clone(),1).unwrap();
        let stream=live_adopt::command_slot(OWNER_ID,&json!(selected.identity())).unwrap();
        let limits=live_adopt::Limits {page_rows:2,page_bytes:2048,commit_bytes:8192,capture_bytes:1<<20};
        let source=Memory::open("record_store").unwrap();
        let mut snapshot=opaque_map::PhysicalSnapshot::begin(&source,&stream,"synthetic-key","zero-cut",limits).unwrap();
        let page=snapshot.page(&mut |_,_|panic!("the cut-zero source has no physical rows")).unwrap();
        assert!(page.done&&page.rows.is_empty());let seal=snapshot.seal().unwrap();
        {let writer=domain.writer().unwrap();let held=writer.lend(Arc::new(AtomicBool::new(false)),Instant::now()+Duration::from_secs(20)).unwrap();
            let transaction=held.begin(sqlite::TransactionBehavior::Immediate).unwrap();
            let store=sqlite::lend(&transaction,"record_store",sqlite::Access::Write).unwrap();
            opaque_map::begin_map_bootstrap(&store,&stream,&seal.head,limits).unwrap();
            opaque_map::append_map_page(&store,&stream,&page,limits).unwrap();
            opaque_map::finish_map_bootstrap(&store,&stream,&seal,limits).unwrap();
            drop(store);transaction.commit().unwrap();
        }
        let(status,answer)=read(&f,scope("guard",false)).await;
        assert_ne!(status,StatusCode::OK,"an old ready row cannot disclose an unmaterialized history: {answer}");
        assert!(answer.get("value").is_none());
    }

}
