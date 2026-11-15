// The account's own record write (`own-record-writes.json`) through the
// account's declared agent routes: the same-process MCP listener (`run_resource_operation`,
// address `@own-records`) with a personal key, over a real retained
// LocalAccount + SelectedAccount on synthetic existing schemas. Schema,
// receipt and descriptor setup follow tests/local_account_cold.rs and
// tests/mcp_selected_private_view/controls.rs. No real customer files or
// authority are opened; every record word is synthetic.
use crate::{account::SecretNativeKey, import::FilePin, local_account::{LocalAccount, SelectedLocalState}};
use content_crypto::advanced::blake3;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tower::ServiceExt;

fn sign_in(owner: &Arc<Mutex<crate::native_boot::SelectedAccount>>) -> Arc<crate::account::account_routes::SignIn> {
    owner.lock().unwrap().sign_in().unwrap().clone()
}

const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

include!("../support/test_window.rs");

struct Fixture {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    receipt: FilePin,
    token: String,
    session: String,
    _window: TestWindow,
    /// The sign-in the latest `selected()` holds the key in.
    kept: std::cell::RefCell<Option<Arc<crate::account::account_routes::SignIn>>>,
}
fn millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis().try_into().unwrap()
}
fn iso(at: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(at.try_into().unwrap()).unwrap().to_rfc3339()
}
fn directory(db: &Connection, name: &str, value: Value) {
    db.execute("INSERT OR REPLACE INTO policy_directory VALUES(?,?)", [name, &value.to_string()]).unwrap();
}
fn gate_name(signin: &str, resource: &str) -> String {
    format!("gate:{}", json!([OWNER, signin, resource]))
}
fn pinned_data(root: &Path, name: &str, value: Value) -> Value {
    let path = root.join(name);
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(&path, &bytes).unwrap();
    json!({"path":path,"pin":{"bytes":bytes.len(),"blake3":blake3::hash(&bytes).to_hex().as_str()}})
}
impl Fixture {
    /// A selected account whose personal key reaches its private records, whose
    /// own records (the old record log the first start migrates) sit at
    /// resource generation 1, and whose own records (record store) are Ready.
    fn new() -> Self {
        Self::owned_by(OWNER)
    }

    /// The same fixture for the account `owner`: a test whose account routes must be the only ones of its account in this
    /// process (the account's resolver of standing grants) names an owner no other test uses.
    fn owned_by(owner: &str) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        // The account's installed tools declare the record kinds these tests write.
        crate::record_model_policy::install_test_tools(&root);
        // The person signed in (a JWT naming the account's address, which a door without a key answers as its owner):
        // the bearer every MCP call of these tests presents.
        let token = crate::account::signed_in::test_token(owner);
        let digest = SecretNativeKey::parse(&format!("nm_{owner}_{}", blake3::hash(b"SYNTHETIC_RECORDS_WRITE_KEY").to_hex())).unwrap().identity();
        let signin = format!("key:{digest}");
        // A name of its own: the open sign-ins of this process are found by account name.
        let user = format!("synthetic-user-{}", temporary.path().file_name().unwrap().to_string_lossy());
        // The window's session, opened by its verified sign-in token.
        let window = TestWindow::open(&user, owner);
        let session = window.session.clone();
        fs::write(root.join("browser-session.key"), &window.token).unwrap();
        fs::set_permissions(root.join("browser-session.key"), fs::Permissions::from_mode(0o600)).unwrap();

        let now = millis();
        let reach = json!({"private":true,"spaces":"all"});
        let row = json!({"made":reach,"ceiling":reach,"chosen":null,"last_used":iso(now)});
        let policy = Connection::open(root.join("policy.sqlite")).unwrap();
        policy.execute_batch("CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)").unwrap();
        directory(&policy, "revision", json!(7));
        directory(&policy, "policy-source", json!({"from":"born","missing":[]}));
        directory(&policy, "policy-source:account", json!({"lifecycle":{"browser_session_generation":1},"access":{},"account_controls":{"owner_user_id":user}}));
        directory(&policy, &format!("policy-source:sign-in:{signin}"), row.clone());
        drop(policy);

        let kv_folder = root.join("storage/kv/trillion-local-app");
        fs::create_dir_all(kv_folder.join("blobs")).unwrap();
        let kv = Connection::open(kv_folder.join("current.sqlite")).unwrap();
        kv.execute_batch("CREATE TABLE _mf_entries(key TEXT PRIMARY KEY,blob_id TEXT NOT NULL,expiration INTEGER)").unwrap();
        for (name, blob, value) in [
            (
                format!("session:{session}"),
                "aa",
                json!({"userId":user,"created_at":iso(now - 60_000),"browser_generation":1,"method":"unknown"}),
            ),
            (
                format!("personal-key:{digest}"),
                "bb",
                json!({"userId":user,"created_at":iso(now - 86_400_000),"reach":reach,"ceiling":reach}),
            ),
        ] {
            kv.execute("INSERT INTO _mf_entries(key,blob_id) VALUES(?,?)", [&name, blob]).unwrap();
            fs::write(kv_folder.join("blobs").join(blob), value.to_string()).unwrap();
        }
        drop(kv);

        let records = Connection::open(root.join("records.sqlite")).unwrap();
        records.execute_batch(&format!(
            "CREATE TABLE own_resource_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,resource TEXT NOT NULL,generation INTEGER NOT NULL,ready INTEGER NOT NULL);
             INSERT INTO own_resource_identity VALUES(1,'{owner}','@own-records',1,1);
             CREATE TABLE workspace_records(label TEXT PRIMARY KEY,value TEXT NOT NULL,written_at TEXT NOT NULL);
             INSERT INTO workspace_records VALUES('saved-board','{{\"items\":[\"kept\"]}}','original-time');
             CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
             INSERT INTO record_keys_meta VALUES('engine','\"record-log\"');
             CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT);
             CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER);
             CREATE TABLE record_keys_big(ref TEXT,part INTEGER,body TEXT,PRIMARY KEY(ref,part)) WITHOUT ROWID;
             CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT NOT NULL);
             CREATE TABLE record_erasable_keys(record_id TEXT PRIMARY KEY,key BLOB,erased_at TEXT,erased_fields TEXT) WITHOUT ROWID;"
        )).unwrap();
        let first = serde_json::to_string("i\0root").unwrap();
        let value = "[\"page\",\"retained-sequence\",{},{\"at\":\"retained-stamp\"}]";
        let page = format!("{}\n{value}", json!({"p":[0],"s":["i\0root"],"d":[value.encode_utf16().count()]}));
        records.execute("INSERT INTO record_keys_runs VALUES(1,1,1,?,0,1)", [&first]).unwrap();
        records.execute("INSERT INTO record_keys_run_1 VALUES(0,?,?)", rusqlite::params![first, page]).unwrap();
        drop(records);

        let mut entries = vec![
            json!({"binding":"ACCOUNT_CONTROL","originalId":"c".repeat(64),"names":[format!("policy:{owner}")],"sqlite":"policy.sqlite"}),
            json!({"binding":"RECORD_BOOK","originalId":"d".repeat(64),"names":[format!("own-record-resource:{}", serde_json::to_string(&[owner, "@own-records"]).unwrap())],"sqlite":"records.sqlite"}),
        ];
        for (resource, file, original) in [("@own-records", "own.sqlite", "e"), ("@sign-in-use", "use.sqlite", "f")] {
            let db = Connection::open(root.join(file)).unwrap();
            db.execute_batch("CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE account_control_state(singleton INTEGER PRIMARY KEY,epoch INTEGER NOT NULL,state_json TEXT NOT NULL,updating_id TEXT); CREATE TABLE account_control_usage(key TEXT PRIMARY KEY,at_ms INTEGER)").unwrap();
            directory(&db, "identity", json!({"owner":owner,"sign_in":signin,"resource":resource}));
            db.execute(
                "INSERT INTO account_control_state VALUES(1,7,?,NULL)",
                [json!({"epoch":7,"lifecycle":{},"sign_ins":{signin.clone():row}}).to_string()],
            ).unwrap();
            if resource == "@sign-in-use" {
                db.execute(
                    "INSERT INTO account_control_usage VALUES(?,?)",
                    rusqlite::params![format!("sign-in:{signin}"), i64::try_from(now).unwrap()],
                ).unwrap();
            }
            drop(db);
            entries.push(json!({"binding":"ACCOUNT_CONTROL","originalId":original.repeat(64),"names":[gate_name(&signin, resource)],"sqlite":file}));
        }
        let index = entries.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        fs::write(root.join("objects.jsonl"), &index).unwrap();
        let receipt_value = json!({"complete":true,"account":{"userId":user,"ownerId":owner},"objects":{"path":"objects.jsonl","bytes":index.len(),"fileIdentity":blake3::hash(index.as_bytes()).to_hex().as_str(),"count":entries.len()}});
        let receipt_bytes = serde_json::to_vec(&receipt_value).unwrap();
        fs::write(root.join("restore-receipt.json"), &receipt_bytes).unwrap();
        let receipt = FilePin { bytes: receipt_bytes.len() as u64, blake3: blake3::hash(&receipt_bytes).to_hex().to_string() };
        let fixture = Self { _temporary: temporary, root, receipt, token, session, _window: window, kept: std::cell::RefCell::new(None) };
        // The first start: the account's own records (record store) are Ready before any command.
        let mut selected = fixture.selected();
        while selected.own_records_step(&fixture.session, Arc::new(AtomicBool::new(false))).unwrap()
            != crate::local_account::own_records::Step::Ready
        {}
        fixture
    }

    fn selected(&self) -> crate::native_boot::SelectedAccount {
        let reveal = pinned_data(&self.root, "reveal.json", json!({"reveal_window_minutes":10,"legacy_scrub_days":7}));
        let inputs = pinned_data(&self.root, "inputs.json", json!({}));
        let first = pinned_data(&self.root, "first.json", json!({}));
        let descriptor = self.root.join("adoption.json");
        let source = json!({
            "version":"trillion.local-runtime-adoption/v1","state":self.root,"receipt_identity":self.receipt.blake3,"port":28788,
            "native":{"version":"trillion.native-selection/v1","receipt_bytes":self.receipt.bytes,
                "app_kv":{"sqlite":"storage/kv/trillion-local-app/current.sqlite","namespace":"trillion-local-app"},
                "prior_processes":[],"reveal_policy":reveal,"root_source":null,
                "frontend":{"root":self.root,"manifest_identity":"1".repeat(64),"tree_identity":"2".repeat(64),
                    "module_manifest_identity":"3".repeat(64),"inputs":inputs,"first_answers":first}}
        });
        let carried = carried_selection::write_selection(&descriptor, &source);
        let selection = crate::native_boot::Selection::from_descriptor(&descriptor, &carried, &self.root, "127.0.0.1:28788".parse().unwrap()).unwrap();
        let local = LocalAccount::open_selected_after_handoff(
            SelectedLocalState {
                root: self.root.clone(),
                receipt: self.receipt.clone(),
                app_kv_sqlite: "storage/kv/trillion-local-app/current.sqlite".into(),
                app_kv_store: "trillion-local-app".into(),
                prior_processes: vec![],
            },
        )
        .unwrap();
        let mut selected = crate::native_boot::SelectedAccount::new(local, selection).unwrap();
        // A synthetic store budget: the shipped record size, a fixed 1 GiB, and no volume reserve. The test then reads no
        // free space of the host (a computer's keep-free floor would make the budget follow the disk).
        let record_bytes = crate::storage::record_store::settings::shipped().expect("the shipped record store settings read").computer_record_bytes;
        selected.set_store_budget(crate::storage::record_store_resources::StoreBudget {
            limits: crate::storage::record_store::settings::Limits { max_record_bytes: record_bytes, byte_budget: 1 << 30 },
            reserve: None,
        });
        // The account's routes admit this fixture's key through the account's own sign-in.
        *self.kept.borrow_mut() = Some(selected.sign_in_in_memory());
        selected
    }
}

/// Version rows (history included) of the account's own records and of its
/// command records, and the workspace board a record write never touches.
fn state(fixture: &Fixture) -> (i64, i64, String) {
    let db = Connection::open(fixture.root.join("records.sqlite")).unwrap();
    let rows = |resource: &str| -> i64 {
        db.query_row("SELECT COUNT(*) FROM versions WHERE resource=?", [resource], |row| row.get(0)).unwrap()
    };
    let board = db.query_row("SELECT value FROM workspace_records WHERE label='saved-board'", [], |row| row.get(0)).unwrap();
    (rows("own-records"), rows("own-commands"), board)
}

fn records_request(bearer: Option<&str>, key: &str, records: Value) -> axum::http::Request<axum::body::Body> {
    let body = json!({"jsonrpc":"2.0","id":"records-write","method":"tools/call","params":{"name":"run_resource_operation",
        "arguments":{"address":"@own-records","method":crate::record_write_model::write_command::Command::shipped().unwrap().operation(),
            "request_key":key,"input":{"records":records}}}});
    let builder = axum::http::Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("Host", "127.0.0.1:28788")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2025-06-18");
    let builder = match bearer {
        Some(token) => builder.header("Authorization", format!("Bearer {token}")),
        None => builder,
    };
    builder.body(axum::body::Body::from(body.to_string())).unwrap()
}

/// A pre-existing large synthetic root, through the normal stored-form supplier rather than a larger command limit.
fn seed_compact_identity_root(fixture:&Fixture,owner:&str,id:&str,value:&Value,identity:&str) {
    use crate::{records::{Mutation,Records},storage::{record_store::{RecordStore,RealClock,settings,native},sqlite::{self,Bounds,Spend}}};
    let bounds=Bounds{value_bytes:2*1024*1024,work:u64::MAX/2,deadline:std::time::Duration::MAX,spend:Spend::EachOperation,cancel:None,busy:std::time::Duration::from_secs(5)};
    let supply=sqlite::open_owned(&fixture.root.join("records.sqlite"),"record_store",bounds).unwrap();
    let mut store=RecordStore::new(supply,Box::new(RealClock),settings::Limits::fixed(1<<20,10<<30)).unwrap();
    let stored=crate::legacy_records::StoredRecord{id:id.into(),record_type:"note".into(),sequence:identity.into(),value_json:value.to_string(),meta_json:None,protected_key_present:false};
    let expected_version=store.held_version(owner,"own-records",id).unwrap();
    store.mutate(owner,"own-records",Mutation{id:id.into(),expected_version,request_key:format!("seed-{id}"),deleted:false,value:native::body(&stored)}).unwrap();
}

async fn read_compact_identity_root(app:&axum::Router,token:&str,key:&str,id:&str)->Value {
    use base64::{engine::general_purpose::STANDARD,Engine};
    let(mut joined,mut after,mut first)=(Vec::new(),None::<u64>,None::<(u64,String)>);
    loop {
        let mut input=json!({"id":id,"type":"note"});if let Some(after)=after{input["after_byte"]=json!(after)}
        let (_,answer)=reply(app,door_request(token,key,"records:read",input)).await;
        assert_eq!(answer["result"]["isError"],false,"{answer}");
        let answer=&answer["result"]["structuredContent"];
        let Some(page)=answer.get("byte_page") else{return answer.clone()};
        let stamp=(page["total"].as_u64().unwrap(),page["blake3"].as_str().unwrap().to_owned());
        if let Some(first)=&first{assert_eq!(first,&stamp)}else{first=Some(stamp.clone())}
        assert_eq!(page["offset"].as_u64().unwrap() as usize,joined.len());
        joined.extend(STANDARD.decode(page["base64"].as_str().unwrap()).unwrap());
        after=page["next_after_byte"].as_u64();
        if after.is_none(){
            assert_eq!(joined.len(),stamp.0 as usize);assert_eq!(blake3::hash(&joined).to_hex().as_str(),stamp.1);
            return serde_json::from_slice(&joined).unwrap()
        }
    }
}

#[tokio::test]
async fn compact_identity_fences_large_existing_roots_without_repeating_their_values() {
    for size in [70_000,300_000] {
        let owner="c".repeat(64);let fixture=Fixture::owned_by(&owner);let id=format!("compact-large-{size}");
        let old=json!({"words":"x".repeat(size)});let identity="900719925474099312345678901234567890";
        seed_compact_identity_root(&fixture,&owner,&id,&old,identity);
        let app=route_table(&fixture);
        let read=read_compact_identity_root(&app,&fixture.token,"large-read",&id).await;
        assert_eq!(read["identity"],identity);assert_eq!(read["value"],old);
        let input=json!([{"id":id,"type":"note","value":{"words":"small replacement"},"expected":{"type":"note","identity":read["identity"]}}]);
        assert!(input.to_string().len()<1024,"the old root is not repeated in the command");
        let (_,made)=reply(&app,records_request(Some(&fixture.token),"large-compact",input.clone())).await;
        assert_eq!(made["result"]["isError"],false,"{made}");
        let after=read_compact_identity_root(&app,&fixture.token,"large-changed",&id).await;
        assert_eq!(after["value"],json!({"words":"small replacement"}));
        assert_ne!(after["identity"],read["identity"],"a changed root must invalidate its previous fence");
        let (_,replay)=reply(&app,records_request(Some(&fixture.token),"large-compact",input.clone())).await;
        assert_eq!(made["result"],replay["result"],"retry replays its first result despite the now stale fence");
        let (_,stale)=reply(&app,records_request(Some(&fixture.token),"large-stale",input)).await;
        assert_eq!(stale["result"]["structuredContent"]["code"],"original_command_conflict","{stale}");
        assert_eq!(read_compact_identity_root(&app,&fixture.token,"large-after",&id).await["value"],json!({"words":"small replacement"}));
    }
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
async fn compact_identity_current_noop_rollback_delete_and_two_writers() {
    let fixture=Fixture::owned_by(&"b".repeat(64));let app=route_table(&fixture);let id="compact-race";
    let original=json!({"words":"before","nullable":null});
    let (_,made)=reply(&app,records_request(Some(&fixture.token),"compact-start",json!([{"id":id,"type":"note","value":original}]))).await;
    assert_eq!(made["result"]["isError"],false);
    let read=read_compact_identity_root(&app,&fixture.token,"compact-read",id).await;
    let expected=json!({"type":read["type"],"identity":read["identity"]});
    let change=|value:Value,given:Value|json!([{"id":id,"type":"note","value":value,"expected":given}]);
    let snapshot=json!({"type":read["type"],"value":read["value"],"identity":read["identity"]});
    let (_,noop)=reply(&app,records_request(Some(&fixture.token),"compact-noop",change(original.clone(),snapshot))).await;
    assert_eq!(noop["result"]["structuredContent"]["write_count"],0,"{noop}");
    assert_eq!(read_compact_identity_root(&app,&fixture.token,"compact-after-noop",id).await["identity"],read["identity"]);
    let before=state(&fixture);
    let (_,refused)=reply(&app,records_request(Some(&fixture.token),"compact-rollback",json!([
        {"id":"compact-other","type":"note","value":{},"expected":null},
        {"id":id,"type":"note","value":{},"expected":{"type":"wrong-kind","identity":read["identity"]}}
    ]))).await;
    assert_eq!(refused["result"]["structuredContent"]["code"],"original_command_conflict");assert_eq!(state(&fixture),before);
    let first=reply(&app,records_request(Some(&fixture.token),"compact-writer-a",change(json!({"winner":"a"}),expected.clone())));
    let second=reply(&app,records_request(Some(&fixture.token),"compact-writer-b",change(json!({"winner":"b"}),expected.clone())));
    let (first,second)=tokio::join!(first,second);
    let results=[first.1["result"].clone(),second.1["result"].clone()];
    assert_eq!(results.iter().filter(|r|r["isError"]==false).count(),1,"{results:?}");
    assert_eq!(results.iter().filter(|r|r["structuredContent"]["code"]=="original_command_conflict").count(),1,"{results:?}");
    let current=read_compact_identity_root(&app,&fixture.token,"compact-winner",id).await;
    let winner=current["value"].clone();
    for (key,value) in [("compact-aba-away",original.clone()),("compact-aba-back",winner.clone())] {
        let (_,made)=reply(&app,records_request(Some(&fixture.token),key,json!([{"id":id,"type":"note","value":value}]))).await;
        assert_eq!(made["result"]["isError"],false,"{made}");
    }
    let (_,aba)=reply(&app,records_request(Some(&fixture.token),"compact-aba-stale",change(json!({"wrong":"stale"}),json!({"type":current["type"],"identity":current["identity"]})))).await;
    assert_eq!(aba["result"]["structuredContent"]["code"],"original_command_conflict","returning to the same value must not revive an old root fence: {aba}");
    let current=read_compact_identity_root(&app,&fixture.token,"compact-aba-current",id).await;
    assert_eq!(current["value"],winner);
    let (_,deleted)=reply(&app,records_request(Some(&fixture.token),"compact-delete",change(Value::Null,json!({"type":current["type"],"identity":current["identity"]})))).await;
    assert_eq!(deleted["result"]["isError"],false,"{deleted}");
    let missing=read_compact_identity_root(&app,&fixture.token,"compact-missing",id).await;
    assert!(missing["value"].is_null()&&missing.get("identity").is_none());
    let (_,stale)=reply(&app,records_request(Some(&fixture.token),"compact-after-delete",change(original.clone(),expected))).await;
    assert_eq!(stale["result"]["structuredContent"]["code"],"original_command_conflict");
    let deleted_identity=json!({"type":current["type"],"identity":current["identity"]});
    let (_,recreated)=reply(&app,records_request(Some(&fixture.token),"compact-recreate",change(winner.clone(),Value::Null))).await;
    assert_eq!(recreated["result"]["isError"],false,"{recreated}");
    assert_eq!(read_compact_identity_root(&app,&fixture.token,"compact-recreated-read",id).await["value"],winner);
    let (_,old_incarnation)=reply(&app,records_request(Some(&fixture.token),"compact-recreated-stale",change(Value::Null,deleted_identity))).await;
    assert_eq!(old_incarnation["result"]["structuredContent"]["code"],"original_command_conflict","recreation of the same value must not revive a deleted root's token");
}

async fn reply(app: &axum::Router, request: axum::http::Request<axum::body::Body>) -> (axum::http::StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 65_536).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn route_table(fixture: &Fixture) -> axum::Router {
    crate::native_boot::mcp_local::route_table(Arc::new(Mutex::new(fixture.selected())), "127.0.0.1:28788".into()).unwrap()
}

fn pursuit(now: &str) -> Value {
    json!([{"id":"pursuit:private-canary","type":"pursuit","value":{"title":"PRIVATE_PURSUIT_CANARY","now":now,"after":"done"}}])
}

#[tokio::test]
async fn the_real_mcp_http_write_reports_request_local_numeric_completion() {
    use http_body::Body as _;
    use std::pin::Pin;
    let fixture = Fixture::owned_by(&"f".repeat(64));
    let app = route_table(&fixture);
    // The first write of a new store makes its declared tables and indexes (`first_write.rs`), a schema change that
    // re-prepares the statements cached by the reads before it; that request is not counted complete. The counted
    // request is a steady-state write, after the schema exists.
    let (_, warm) = reply(&app, records_request(Some(&fixture.token), "request-work-warm", pursuit("warm"))).await;
    assert_eq!(warm["result"]["isError"], false, "{warm}");
    let mut request = records_request(Some(&fixture.token), "request-work-agent", pursuit("counted"));
    request.headers_mut().insert("prefer", "storage-work".parse().unwrap());
    request.headers_mut().insert("te", "trailers".parse().unwrap());
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(response.headers()["storage-work"], "pending");
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
    assert!(read_count > 0, "the real request reaches admission, command and final-custody reads: {observed}");
    let answer: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(answer["result"]["isError"], false, "{answer}");
    assert_eq!(answer["result"]["structuredContent"], json!({"changed":true,"write_count":1}));
}

#[tokio::test]
async fn a_private_reach_key_creates_and_updates_a_private_pursuit_once_per_request_key() {
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let before = state(&fixture);
    let (status, created) = reply(&app, records_request(Some(&fixture.token), "agent-create", pursuit("starting"))).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(created["result"]["isError"], false, "{created}");
    assert_eq!(created["result"]["structuredContent"], json!({"changed":true,"write_count":1}));
    let after_create = state(&fixture);
    assert_eq!(after_create.1, before.1 + 1, "one command record");

    let (_, updated) = reply(&app, records_request(Some(&fixture.token), "agent-update", pursuit("halfway"))).await;
    assert_eq!(updated["result"]["structuredContent"], json!({"changed":true,"write_count":1}), "{updated}");
    let after_update = state(&fixture);

    let (_, again) = reply(&app, records_request(Some(&fixture.token), "agent-update", pursuit("halfway"))).await;
    assert_eq!(again["result"]["structuredContent"], updated["result"]["structuredContent"], "{again}");
    assert_eq!(state(&fixture), after_update, "a repeated request key writes nothing");

    let db = Connection::open(fixture.root.join("records.sqlite")).unwrap();
    let commands: Vec<String> = db
        .prepare("SELECT CAST(body AS TEXT) FROM versions WHERE resource='own-commands'").unwrap()
        .query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(commands.len(), 2);
    assert!(commands.iter().all(|kept| !kept.contains("CANARY") && !kept.contains("pursuit")), "{commands:?}");
    drop(db);
    // The account has one owner at a time: release the routes' before reading back.
    drop(app);
    let mut owner = fixture.selected();
    let read = owner.owner
        .current_logical_record(&fixture.session, "pursuit:private-canary", Default::default(), Arc::new(AtomicBool::new(false)))
        .unwrap()
        .unwrap();
    let words = crate::ecma_json::stringify(read.value(), Default::default()).unwrap();
    assert!(words.contains("halfway") && words.contains("PRIVATE_PURSUIT_CANARY"), "{words}");
    assert_eq!(state(&fixture).2, before.2, "the workspace board is untouched");
}

/// The generic records door used by an AI's self-card and a job's progress: actual native command capture,
/// protected result and journal, with synthetic identities only. Missing take history is preserved as unknown.
#[tokio::test]
async fn ai_card_and_job_progress_keep_exact_native_retry_and_cas_ownership() {
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let checkpoint = || {
        let db = Connection::open(fixture.root.join("records.sqlite")).unwrap();
        let keys: i64 = db.query_row("SELECT COUNT(*) FROM versions WHERE resource='own-record-keys'", [], |row| row.get(0)).unwrap();
        (state(&fixture), keys)
    };
    let card = json!({"kind":"cli","label":"Synthetic CLI","source_id":"fixture:synthetic-cli"});
    let job = json!({"kind":"ai-job","status":"taken","taker":"ai:synthetic-holder","job":"Keep the synthetic destination readable"});
    let initial = json!([
        {"id":"ai:synthetic-cli","type":"ai","value":card,"expected":null},
        {"id":"ai-job:synthetic-progress","type":"ai-job","value":job,"expected":null}
    ]);
    let (_, created) = reply(&app, records_request(Some(&fixture.token), "fixture-card-and-job", initial.clone())).await;
    assert_eq!(created["result"]["isError"], false, "{created}");
    assert_eq!(created["result"]["structuredContent"], json!({"changed":true,"write_count":2}));
    let after_create = checkpoint();
    let (_, repeated) = reply(&app, records_request(Some(&fixture.token), "fixture-card-and-job", initial)).await;
    assert_eq!(repeated["result"]["structuredContent"], created["result"]["structuredContent"], "{repeated}");
    assert_eq!(checkpoint(), after_create, "same native request key writes nothing again");

    let mut progressed = job.clone();
    progressed["progress"] = json!({"by":"ai:synthetic-cli","words":"The consumer is still being checked."});
    let progress = json!([{"id":"ai-job:synthetic-progress","type":"ai-job","value":progressed,
        "expected":{"type":"ai-job","value":job}}]);
    let (_, moved) = reply(&app, records_request(Some(&fixture.token), "fixture-job-progress", progress.clone())).await;
    assert_eq!(moved["result"]["isError"], false, "{moved}");
    let after_progress = checkpoint();
    let (_, repeated) = reply(&app, records_request(Some(&fixture.token), "fixture-job-progress", progress)).await;
    assert_eq!(repeated["result"]["structuredContent"], moved["result"]["structuredContent"], "{repeated}");
    assert_eq!(checkpoint(), after_progress);

    let (_, stale) = reply(&app, records_request(Some(&fixture.token), "fixture-stale-progress", json!([
        {"id":"ai-job:synthetic-progress","type":"ai-job","value":job,"expected":{"type":"ai-job","value":job}}
    ]))).await;
    assert_eq!(stale["result"]["isError"], true, "{stale}");
    assert_eq!(stale["result"]["structuredContent"]["code"], "original_command_conflict");
    assert_eq!(checkpoint(), after_progress, "a stale CAS changes no record, key or journal");
    drop(app);
    let mut selected = fixture.selected();
    for (id, expected) in [("ai:synthetic-cli", card), ("ai-job:synthetic-progress", progressed)] {
        let observed = selected.owner.current_logical_record(&fixture.session, id, Default::default(), Arc::new(AtomicBool::new(false))).unwrap().unwrap();
        let observed: Value = serde_json::from_str(&crate::ecma_json::stringify(observed.value(), Default::default()).unwrap()).unwrap();
        assert_eq!(observed, expected);
        if id.starts_with("ai-job:") { assert!(observed.get("taken_at").is_none(), "progress cannot invent the old claim's time"); }
    }
}

#[tokio::test]
async fn a_value_outside_a_fields_declared_choices_is_refused_naming_the_field_and_value() {
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let list = |choices: Value| json!([{"id":"list:tasks","type":"list","value":{"row_type":"task","fields":[
        {"id":"state","kind":"choice","choices":choices},{"id":"note","kind":"text"}]}}]);
    let row = |id: &str, state: &str, note: &str| json!([{"id":format!("record:task:{id}"),"type":"record:task","value":{"state":state,"note":note}}]);
    let write = |key: &'static str, records: Value| {
        let (app, token) = (app.clone(), fixture.token.clone());
        async move { reply(&app, records_request(Some(&token), key, records)).await.1["result"].clone() }
    };
    assert_eq!(write("choices-list", list(json!(["open", "done"]))).await["isError"], false);
    assert_eq!(write("choices-in", row("1", "open", "first")).await["structuredContent"], json!({"changed":true,"write_count":1}));
    // Outside the choices: an input refusal that names the record kind, the field and the value, and writes nothing.
    let before = state(&fixture);
    let refused = write("choices-out", row("2", "later", "second")).await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert_eq!(refused["structuredContent"]["code"], "value_outside_choices");
    assert_eq!(refused["structuredContent"]["detail"], json!({"kind":"record:task","field":"state","value":"later"}));
    assert_eq!(state(&fixture).0, before.0, "no record was written");
    // Narrowing the choices is not blocked, and the row that now holds an outside value keeps it while it is left
    // as it is; another value outside the choices is still refused.
    assert_eq!(write("choices-narrow", list(json!(["done"]))).await["isError"], false);
    assert_eq!(write("choices-legacy", row("1", "open", "edited")).await["isError"], false);
    let still = write("choices-still", row("1", "later", "edited")).await;
    assert_eq!(still["structuredContent"]["code"], "value_outside_choices");
}

#[tokio::test]
async fn a_move_a_fields_declared_moves_do_not_list_is_refused_naming_from_and_to() {
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let list = json!([{"id":"list:jobs","type":"list","value":{"row_type":"job","fields":[
        {"id":"status","kind":"choice","choices":["waiting","taken","done"],
         "moves":{"":["waiting"],"waiting":["taken"],"taken":["done","waiting"],"done":[]}},{"id":"note","kind":"text"}]}}]);
    let row = |status: &str, note: &str| json!([{"id":"record:job:1","type":"record:job","value":{"status":status,"note":note}}]);
    let write = |key: &'static str, records: Value| {
        let (app, token) = (app.clone(), fixture.token.clone());
        async move { reply(&app, records_request(Some(&token), key, records)).await.1["result"].clone() }
    };
    assert_eq!(write("moves-list", list).await["isError"], false);
    // A new row starts only in a start value.
    let refused = write("moves-start-out", row("taken", "first")).await;
    assert_eq!(refused["structuredContent"]["code"], "move_not_declared", "{refused}");
    assert_eq!(refused["structuredContent"]["detail"], json!({"kind":"record:job","field":"status","value":"taken","from":""}));
    assert_eq!(write("moves-start", row("waiting", "first")).await["isError"], false);
    // A listed move is admitted; an unchanged value with another field edited is admitted.
    assert_eq!(write("moves-take", row("taken", "first")).await["isError"], false);
    assert_eq!(write("moves-same", row("taken", "edited")).await["isError"], false);
    assert_eq!(write("moves-done", row("done", "edited")).await["isError"], false);
    // A final value moves nowhere: the refusal names from and to and writes nothing.
    let before = state(&fixture);
    let refused = write("moves-out", row("waiting", "edited")).await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert_eq!(refused["structuredContent"]["code"], "move_not_declared");
    assert_eq!(refused["structuredContent"]["detail"], json!({"kind":"record:job","field":"status","value":"waiting","from":"done"}));
    assert_eq!(state(&fixture).0, before.0, "no record was written");
    // Clearing or omitting a final field, or changing its kind, must not restart the row's lifecycle.
    for (key, records) in [
        ("moves-null",json!([{"id":"record:job:1","type":"record:job","value":{"status":null}}])),
        ("moves-omit",json!([{"id":"record:job:1","type":"record:job","value":{"note":"without state"}}])),
        ("moves-kind",json!([{"id":"record:job:1","type":"other","value":{"status":"done"}}])),
        ("moves-reset-batch",json!([
            {"id":"record:job:1","type":"record:job","value":{"status":null}},
            {"id":"record:job:1","type":"record:job","value":{"status":"waiting"}}])),
    ] {
        let refused=write(key,records.clone()).await;
        assert_eq!(refused["structuredContent"]["code"],"move_not_declared","{key}: {refused}");
        assert_eq!(refused["structuredContent"]["detail"],json!({"kind":"record:job","field":"status","value":"","from":"done"}),"{key}: {refused}");
        assert_eq!(state(&fixture).0,before.0,"{key} wrote nothing");
        assert_eq!(write(key,records).await,refused,"a refused retry returns the same result");
    }
    // Whole-record deletion is a separate authorized operation. A recreated row must still start as declared.
    let refused=write("moves-delete-recreate-invalid",json!([
        {"id":"record:job:1","type":"record:job","value":null},
        {"id":"record:job:1","type":"record:job","value":{"status":"done"}}])).await;
    assert_eq!(refused["structuredContent"]["code"],"move_not_declared","{refused}");
    assert_eq!(refused["structuredContent"]["detail"]["from"],"");
    assert_eq!(state(&fixture).0,before.0,"a refused recreation rolls back the deletion too");
    assert_eq!(write("moves-delete",json!([{"id":"record:job:1","type":"record:job","value":null}])).await["isError"],false);
    assert_eq!(write("moves-recreate-invalid",row("done","new")).await["structuredContent"]["code"],"move_not_declared");
    assert_eq!(write("moves-recreate-start",row("waiting","new")).await["isError"],false);
}

#[tokio::test]
async fn no_sign_in_free_door() {
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let before = state(&fixture);
    for bearer in [None, Some("nm_0000000000000000000000000000000000000000000000000000000000000000")] {
        let (status, _) = reply(&app, records_request(bearer, "no-key", pursuit("x"))).await;
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED, "{bearer:?}");
    }
    assert_eq!(state(&fixture), before);
}

/// One `run_resource_operation` call at @own-records.
fn door_request(bearer: &str, key: &str, operation: &str, input: Value) -> axum::http::Request<axum::body::Body> {
    let body = json!({"jsonrpc":"2.0","id":key,"method":"tools/call","params":{"name":"run_resource_operation",
        "arguments":{"address":"@own-records","method":operation,"request_key":key,"input":input}}});
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
}

/// A tool run's capability at the same account routes: it reads and lists the kind its row declared, is refused another
/// kind, cannot replace a record of another kind by writing its id, is refused a write a read-only row was not
/// granted, and is unauthorized once its run ended. The person's own key reads the same records.
#[tokio::test]
async fn scoped_run_effect_and_protected_recovery_keep_the_exact_declared_history() {
    use crate::account_rights::run_capability::{mint, Rights};
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let door = crate::record_value::account_routes::Door::shipped().unwrap();
    let write = crate::record_write_model::write_command::Command::shipped().unwrap().operation();
    let read = door.read_operation();
    let scope = json!({"id":"synthetic-run-domain","incarnation":"first","generation":1});
    let mut create = scope.clone(); create["create"] = json!(true);
    let make = |scope: Value, words: &str| json!({"scope":scope,"records":[{"id":"note:scoped","type":"note","value":{"words":words}}]});
    let (_, created) = reply(&app, door_request(&fixture.token,"scope-create",write,make(create,"before"))).await;
    assert_eq!(created["result"]["isError"],false,"{created}");
    let rights = Rights::declared(&json!({"rights":[{"kind":"note","scope":scope,"operations":[read,write]}]})).unwrap();
    let capability = mint(OWNER,fixture.token.as_bytes(),rights,None,std::time::Duration::from_secs(60)).unwrap();
    let input = make(scope.clone(),"after");
    let (_, written) = reply(&app,door_request(capability.token(),"scoped-run-write",write,input.clone())).await;
    assert_eq!(written["result"]["isError"],false,"{written}");
    assert_eq!(written["result"]["structuredContent"]["write_count"],1);
    let original = json!({"request_key":"scoped-run-write","operation":write,"input":input});
    let (_, recovered) = reply(&app,door_request(capability.token(),"scoped-run-recover",door.result_operation().unwrap(),original)).await;
    assert_eq!(recovered["result"],written["result"],"same full-history original receipt");
    let (_, found) = reply(&app,door_request(capability.token(),"scoped-run-read",read,json!({"scope":scope,"id":"note:scoped","type":"note"}))).await;
    assert_eq!(found["result"]["isError"],false,"{found}");
    assert_eq!(found["result"]["structuredContent"]["value"]["words"],"after");
    assert_eq!(found["result"]["structuredContent"]["scope"],scope);
    for wrong in [None,Some(json!({"id":"other","incarnation":"first","generation":1})),
        Some(json!({"id":"synthetic-run-domain","incarnation":"next","generation":1}))] {
        let mut input = json!({"id":"note:scoped","type":"note"});
        if let Some(wrong) = wrong { input["scope"] = wrong; }
        let (_, refused) = reply(&app,door_request(capability.token(),"scoped-run-other",read,input)).await;
        assert_eq!(refused["result"]["isError"],true,"{refused}");
    }
}

#[tokio::test]
async fn a_run_capability_reaches_only_its_declared_kinds_and_ends_with_its_run() {
    use crate::account_rights::run_capability::{mint, Rights};
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let door = crate::record_value::account_routes::Door::shipped().unwrap();
    let (read, list) = (door.read_operation(), door.list_operation());
    let write = crate::record_write_model::write_command::Command::shipped().unwrap().operation();
    let note = |id: &str, words: &str| json!({"records":[{"id":id,"type":"note","value":{"words":words}}]});
    let answer = |reply: &Value| reply["result"]["structuredContent"].clone();
    let refused = |reply: &Value| reply["result"]["isError"] == true && reply.to_string().contains("current_workspace_rights_refused");

    let (_, made) = reply(&app, door_request(&fixture.token, "person-note", write, note("note-1", "NOTE_CANARY"))).await;
    assert_eq!(answer(&made), json!({"changed":true,"write_count":1}), "{made}");
    let (_, made) = reply(&app, records_request(Some(&fixture.token), "person-pursuit", pursuit("starting"))).await;
    assert_eq!(answer(&made), json!({"changed":true,"write_count":1}), "{made}");
    let (_, own) = reply(&app, door_request(&fixture.token, "person-read", read, json!({"id":"pursuit:private-canary"}))).await;
    assert_eq!(answer(&own)["type"], "pursuit", "{own}");

    let rights = |operations: &[&str]| Rights::declared(&json!({"fd":3,"rights":[{"kind":"note","operations":operations}]})).unwrap();
    let run = mint(OWNER, fixture.token.as_bytes(), rights(&[read, list, write]), None, std::time::Duration::from_secs(60)).unwrap();
    let token = run.token().to_owned();

    let (_, one) = reply(&app, door_request(&token, "run-read", read, json!({"id":"note-1","type":"note"}))).await;
    // The read also names the root's identity stamp and the snapshot generation (`identity`, `context`); this test is about
    // which record the run reads, so it compares the record's own id, type and value.
    let mut shown = answer(&one);
    shown.as_object_mut().unwrap().retain(|key, _| !matches!(key.as_str(), "identity" | "context"));
    assert_eq!(shown, json!({"id":"note-1","type":"note","value":{"words":"NOTE_CANARY"}}), "{one}");
    let (_, page) = reply(&app, door_request(&token, "run-list", list, json!({"type":"note"}))).await;
    assert_eq!(answer(&page)["records"][0]["id"], "note-1", "{page}");
    assert_eq!(answer(&page)["next"], Value::Null, "{page}");
    let (_, other) = reply(&app, door_request(&token, "run-other", read, json!({"id":"pursuit:private-canary","type":"pursuit"}))).await;
    assert!(refused(&other), "{other}");
    let (_, untyped) = reply(&app, door_request(&token, "run-untyped", read, json!({"id":"pursuit:private-canary"}))).await;
    assert!(refused(&untyped), "{untyped}");

    let (_, wrote) = reply(&app, door_request(&token, "run-write", write, note("note-2", "RUN_NOTE"))).await;
    assert_eq!(answer(&wrote), json!({"changed":true,"write_count":1}), "{wrote}");
    let before = state(&fixture);
    let (_, replaced) = reply(&app, door_request(&token, "run-replace", write, note("pursuit:private-canary", "TAKEN"))).await;
    assert_eq!(replaced["result"]["isError"], true, "{replaced}");
    assert_eq!(state(&fixture).0, before.0, "a run cannot replace a record of a kind it was not granted");

    let reader = mint(OWNER, fixture.token.as_bytes(), rights(&[read]), None, std::time::Duration::from_secs(60)).unwrap();
    let (_, write_refused) = reply(&app, door_request(reader.token(), "reader-write", write, note("note-3", "NO"))).await;
    assert!(refused(&write_refused), "{write_refused}");
    assert_eq!(state(&fixture).0, before.0);

    // Rights narrowed inside the kind: one id, or the ids under a prefix.
    let narrowed = |right: Value| {
        let rights = Rights::declared(&json!({"fd":3,"rights":[right]})).unwrap();
        mint(OWNER, fixture.token.as_bytes(), rights, None, std::time::Duration::from_secs(60)).unwrap()
    };
    let single = narrowed(json!({"kind":"note","id":"note-1","operations":[read, list]}));
    let (_, own_id) = reply(&app, door_request(single.token(), "id-own", read, json!({"id":"note-1","type":"note"}))).await;
    assert_eq!(answer(&own_id)["value"]["words"], "NOTE_CANARY", "{own_id}");
    let (_, sibling) = reply(&app, door_request(single.token(), "id-sibling", read, json!({"id":"note-2","type":"note"}))).await;
    assert!(refused(&sibling), "an id right cannot read a sibling id: {sibling}");
    let (_, id_list) = reply(&app, door_request(single.token(), "id-list", list, json!({"type":"note"}))).await;
    assert!(refused(&id_list), "an id right lists nothing: {id_list}");
    let under = narrowed(json!({"kind":"note","prefix":"note-2","operations":[list]}));
    let (_, inside) = reply(&app, door_request(under.token(), "prefix-in", list, json!({"type":"note","prefix":"note-2"}))).await;
    assert_eq!(answer(&inside)["records"].as_array().map(Vec::len), Some(1), "{inside}");
    assert_eq!(answer(&inside)["records"][0]["id"], "note-2", "{inside}");
    let (_, outside) = reply(&app, door_request(under.token(), "prefix-out", list, json!({"type":"note"}))).await;
    assert!(refused(&outside), "a prefix right cannot list outside its prefix: {outside}");

    drop(run);
    let (status, _) = reply(&app, door_request(&token, "run-ended", read, json!({"id":"note-1","type":"note"}))).await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
    assert!(!format!("{one}{page}{other}{wrote}{replaced}").contains(&token));
}

/// A live run bearer may write only the workspace labels its row declared: a sibling label, a mix, and a conflict's
/// resolution (it names no label) are refused before the selected owner is asked, and the sibling's record is left
/// as it was. A run that ended can write nothing.
#[tokio::test]
async fn a_run_capability_writes_only_its_declared_workspace_labels() {
    use crate::account_rights::run_capability::{mint, Rights};
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let own = "workspace-probe:own";
    let sibling = "workspace-probe:sibling";
    shared_fixture_record(&fixture, sibling, Some(json!({"sibling":"PRIVATE_SIBLING"})));
    let capability = mint(OWNER, fixture.token.as_bytes(),
        Rights::declared(&json!({"fd":3,"rights":[{"kind":"@own-records","id":own,"operations":["workspace:write"]}]})).unwrap(),
        None, std::time::Duration::from_secs(60)).unwrap();
    let token = capability.token().to_owned();
    let write = |label: &str| json!({"address_label": label, "payload": {"tokens": {"surface": "ink"}}});
    for (key, input) in [
        ("run-write-sibling", json!({"writes":[write(sibling)]})),
        ("run-write-mixed", json!({"writes":[write(own), write(sibling)]})),
        ("run-write-resolve", json!({"resolve_conflict":{"id":"conflict-1","branch_identity":"b"}})),
    ] {
        let (_, refused) = reply(&app, door_request(&token, key, "workspace:write", input)).await;
        assert_eq!(refused["result"]["isError"], true, "{key}: {refused}");
        assert!(refused.to_string().contains("current_workspace_rights_refused"), "{key}: {refused}");
    }
    // Its declared label is written; the same request key again answers the same receipt (the command journal owns
    // whether it is the first write's; this test does not tell the two apart).
    let (_, wrote) = reply(&app, door_request(&token, "run-write-own", "workspace:write", json!({"writes":[write(own)]}))).await;
    assert_eq!(wrote["result"]["structuredContent"], json!({"written":1}), "{wrote}");
    let (_, again) = reply(&app, door_request(&token, "run-write-own", "workspace:write", json!({"writes":[write(own)]}))).await;
    assert_eq!(again["result"]["structuredContent"], json!({"written":1}), "{again}");
    let (_, read) = reply(&app, door_request(&fixture.token, "owner-read-own", "workspace:read",
        json!({"selection":{"labels":[own],"prefixes":[]}}))).await;
    let body: Value = serde_json::from_str(read["result"]["structuredContent"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(body["records"][own], json!({"tokens":{"surface":"ink"}}), "{read}");
    // The person's own key reads the sibling as it was.
    let (_, kept) = reply(&app, door_request(&fixture.token, "owner-read-sibling", "workspace:read",
        json!({"selection":{"labels":[sibling],"prefixes":[]}}))).await;
    assert!(kept.to_string().contains("PRIVATE_SIBLING"), "{kept}");
    drop(capability);
    let (status, _) = reply(&app, door_request(&token, "run-write-ended", "workspace:write", json!({"writes":[write(own)]}))).await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
}

/// A live run bearer reaches one exact workspace label through the existing selected-account owner. The selected
/// owner still rechecks the parent's current private-view right on every call; neither a whole-workspace fallback nor
/// a sibling label is added by the run capability.
#[tokio::test]
async fn a_run_capability_reads_only_exact_workspace_labels_through_the_selected_owner() {
    use crate::account_rights::run_capability::{mint, Rights};
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let own = "workspace-probe:own";
    let sibling = "workspace-probe:sibling";
    let raw = json!([{"id":"theme-a","tokens":{"surface":"paper"}}, {"retained":true}]);
    shared_fixture_record(&fixture, own, Some(raw.clone()));
    shared_fixture_record(&fixture, sibling, Some(json!({"sibling":"PRIVATE_SIBLING"})));

    let capability = mint(OWNER, fixture.token.as_bytes(),
        Rights::declared(&json!({"fd":3,"rights":[{"kind":"@own-records","id":own,"operations":["workspace:read"]}]})).unwrap(),
        None, std::time::Duration::from_secs(60)).unwrap();
    let token = capability.token().to_owned();
    let selection = |labels: Value| json!({"selection":{"labels":labels,"prefixes":[]}});
    let (_, read) = reply(&app, door_request(&token, "run-workspace-own", "workspace:read", selection(json!([own])))).await;
    let answer = &read["result"]["structuredContent"];
    assert_eq!(answer["status"], 200, "{read}");
    assert_eq!(answer["content_type"], "application/json; charset=utf-8", "{read}");
    let body: Value = serde_json::from_str(answer["text"].as_str().unwrap()).unwrap();
    assert_eq!(body, json!({"records": {own: raw}}));
    assert!(!read.to_string().contains("PRIVATE_SIBLING"), "{read}");

    for (key, input) in [
        ("run-workspace-sibling", selection(json!([sibling]))),
        ("run-workspace-mixed", selection(json!([own, sibling]))),
        ("run-workspace-empty", selection(json!([]))),
        ("run-workspace-prefix", json!({"selection":{"labels":[own],"prefixes":["workspace-probe:"]}})),
        ("run-workspace-omitted", json!({})),
    ] {
        let (_, refused) = reply(&app, door_request(&token, key, "workspace:read", input)).await;
        assert_eq!(refused["result"]["isError"], true, "{key}: {refused}");
        assert!(refused.to_string().contains("current_workspace_rights_refused"), "{key}: {refused}");
        assert!(!refused.to_string().contains("PRIVATE_SIBLING"), "{key}: {refused}");
    }

    // Admit a second request but pause before its last chunk. Ending that
    // run after admission must still withhold its private workspace bytes.
    let final_chunk = mint(OWNER, fixture.token.as_bytes(),
        Rights::declared(&json!({"fd":3,"rights":[{"kind":"@own-records","id":own,"operations":["workspace:read"]}]})).unwrap(),
        None, std::time::Duration::from_secs(60)).unwrap();
    let final_token = final_chunk.token().to_owned();
    let response = app.clone().oneshot(door_request(&final_token, "run-workspace-final-frame-revoke", "workspace:read", selection(json!([own]))))
        .await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    drop(final_chunk);
    let withheld = axum::body::to_bytes(response.into_body(), 65_536).await;
    assert!(withheld.is_err(), "a run revoked after admission cannot release a prepared workspace response");

    drop(capability);
    let (status, _) = reply(&app, door_request(&token, "run-workspace-run-ended", "workspace:read", selection(json!([own])))).await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
    assert!(!format!("{read}").contains(&token));
}

/// A kind the model flags `stays_on_this_device`: the person's own key at the account's routes (an AI app's, which can carry the
/// answer off this computer) is refused it by name on a read, a list and a history, and the refusal is not "unknown";
/// a tool run's capability (held to its row when it started) and a kind the model does not flag read as before.
#[tokio::test]
async fn a_kind_that_stays_on_this_computer_is_refused_to_an_app_key_and_read_by_a_local_run() {
    use crate::account_rights::run_capability::{mint, Rights};
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let door = crate::record_value::account_routes::Door::shipped().unwrap();
    let (read, list, history) = (door.read_operation(), door.list_operation(), door.history_operation());
    let write = crate::record_write_model::write_command::Command::shipped().unwrap().operation();
    let flagged = "kept-here";
    let answer = |reply: &Value| reply["result"]["structuredContent"].clone();
    let stays = |reply: &Value| reply["result"]["isError"] == true && reply.to_string().contains("kind_stays_on_this_computer");

    let kept = json!({"records":[{"id":"print-1","type":flagged,"value":{}},{"id":"note-1","type":"note","value":{"words":"PLAIN"}}]});
    let (_, made) = reply(&app, door_request(&fixture.token, "person-kept", write, kept)).await;
    assert_eq!(answer(&made), json!({"changed":true,"write_count":2}), "{made}");

    let (_, one) = reply(&app, door_request(&fixture.token, "key-read", read, json!({"id":"print-1","type":flagged}))).await;
    assert!(stays(&one), "{one}");
    let (_, page) = reply(&app, door_request(&fixture.token, "key-list", list, json!({"type":flagged}))).await;
    assert!(stays(&page), "{page}");
    let (_, past) = reply(&app, door_request(&fixture.token, "key-history", history, json!({"id":"print-1","limit":5}))).await;
    assert!(stays(&past), "{past}");
    assert!(!format!("{one}{page}{past}").contains("unknown"), "a read has no effect to be unsure of");
    // A call refused for its input says which field and what it must be, from the one parse, never the value.
    let (_, bad) = reply(&app, door_request(&fixture.token, "bad-history", history, json!({"id":"note-1","kept":"VALUE_CANARY"}))).await;
    assert_eq!(bad["result"]["structuredContent"]["code"], "original_input_refused", "{bad}");
    assert_eq!(bad["result"]["structuredContent"]["detail"]["field"], "kept", "{bad}");
    assert!(!bad.to_string().contains("VALUE_CANARY"), "{bad}");
    let (_, no_limit) = reply(&app, door_request(&fixture.token, "no-limit", history, json!({"id":"note-1"}))).await;
    assert_eq!(no_limit["result"]["structuredContent"]["detail"]["field"], "limit", "{no_limit}");
    let (_, plain) = reply(&app, door_request(&fixture.token, "key-plain", read, json!({"id":"note-1","type":"note"}))).await;
    assert_eq!(answer(&plain)["value"]["words"], "PLAIN", "{plain}");

    let rights = Rights::declared(&json!({"fd":3,"rights":[{"kind":flagged,"operations":[read, list]}]})).unwrap();
    let run = mint(OWNER, fixture.token.as_bytes(), rights, None, std::time::Duration::from_secs(60)).unwrap();
    let (_, local) = reply(&app, door_request(run.token(), "run-read", read, json!({"id":"print-1","type":flagged}))).await;
    assert_eq!(answer(&local)["type"], flagged, "{local}");
    let (_, listed) = reply(&app, door_request(run.token(), "run-list", list, json!({"type":flagged}))).await;
    assert_eq!(answer(&listed)["records"][0]["id"], "print-1", "{listed}");
}

/// First-start tools may still be installing when an account's MCP opens. No record bytes leave before its privacy
/// policy can be read; the same authenticated route recovers once installation publishes the tools folder.
#[tokio::test]
async fn a_remote_read_waits_for_its_installed_policy_without_claiming_the_kind_is_local_only() {
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let note = json!({"records":[{"id":"first-note","type":"note","value":{"words":"AFTER_INSTALL"}}]});
    let (_, made) = reply(&app, door_request(&fixture.token, "before-install-gap", "records:write", note)).await;
    assert_eq!(made["result"]["structuredContent"], json!({"changed":true,"write_count":1}), "{made}");

    let tools = fixture.root.join("workshop");
    let unpublished = fixture.root.join("workshop-installing");
    fs::rename(&tools, &unpublished).unwrap();
    let (_, absent) = reply(&app, door_request(&fixture.token, "absent-before-install", "records:read", json!({"id":"never-written"}))).await;
    assert_eq!(absent["result"]["isError"], false, "{absent}");
    assert!(absent["result"]["structuredContent"]["value"].is_null(), "{absent}");
    for (method, input) in [
        ("records:read", json!({"id":"first-note"})),
        ("records:list", json!({"type":"note"})),
        ("records:history", json!({"id":"first-note","limit":5})),
    ] {
        let (_, refused) = reply(&app, door_request(&fixture.token, method, method, input)).await;
        assert_eq!(refused["result"]["isError"], true, "{refused}");
        assert_eq!(refused["result"]["structuredContent"]["code"], "original_workspace_source_unavailable", "{refused}");
        assert!(!refused.to_string().contains("AFTER_INSTALL"), "{refused}");
        assert!(!refused.to_string().contains("kind_stays_on_this_computer"), "{refused}");
    }
    fs::rename(&unpublished, &tools).unwrap();
    let (_, read) = reply(&app, door_request(&fixture.token, "after-install-gap", "records:read", json!({"id":"first-note"}))).await;
    assert_eq!(read["result"]["isError"], false, "{read}");
    assert_eq!(read["result"]["structuredContent"]["value"]["words"], "AFTER_INSTALL", "{read}");
}

/// The account routes' records reads are verified, admitted and confirmed on the admission owner: with the account's own owner
/// held (as a long write holds it) past a read's whole deadline, an app key's read still answers, its first call (the
/// sign-in use not noted yet) is admitted on the account's own owner before that, and a key never used is still refused.
#[tokio::test]
async fn a_records_read_by_a_key_does_not_wait_on_the_account_owner() {
    let fixture = Fixture::new();
    let owner = Arc::new(Mutex::new(fixture.selected()));
    let admission = Arc::new(Mutex::new(owner.lock().unwrap().admission_owner().unwrap()));
    let app = crate::native_boot::mcp_local::route_table_with_admission(owner.clone(), admission, sign_in(&owner), "127.0.0.1:28788".into()).unwrap();
    let door = crate::record_value::account_routes::Door::shipped().unwrap();
    let (read, list) = (door.read_operation(), door.list_operation());
    let write = crate::record_write_model::write_command::Command::shipped().unwrap().operation();
    let answer = |reply: &Value| reply["result"]["structuredContent"].clone();

    let note = json!({"records":[{"id":"note-1","type":"note","value":{"words":"HELD"}}]});
    let (_, made) = reply(&app, door_request(&fixture.token, "kept", write, note)).await;
    assert_eq!(answer(&made), json!({"changed":true,"write_count":1}), "{made}");
    // The first read notes the key's use on the account's own owner.
    let (_, first) = reply(&app, door_request(&fixture.token, "first", read, json!({"id":"note-1","type":"note"}))).await;
    assert_eq!(answer(&first)["value"]["words"], "HELD", "{first}");

    let held = owner.lock().unwrap();
    let started = std::time::Instant::now();
    let (_, one) = reply(&app, door_request(&fixture.token, "held-read", read, json!({"id":"note-1","type":"note"}))).await;
    assert_eq!(answer(&one)["value"]["words"], "HELD", "{one}");
    let (_, page) = reply(&app, door_request(&fixture.token, "held-list", list, json!({"type":"note"}))).await;
    assert_eq!(answer(&page)["records"][0]["id"], "note-1", "{page}");
    assert!(started.elapsed() < std::time::Duration::from_millis(1_500), "a read waited on the account owner: {:?}", started.elapsed());
    let (status, _) = reply(&app, door_request("not-a-key", "held-bad", read, json!({"id":"note-1"}))).await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
    drop(held);
}

/// A run a signed-in page started stands while the page's party does (`party:<account address>`), and that is asked of
/// the account's routes alone (`account_routes::cause_stands`, as `local_workspace::page_task_context` asks it), never of
/// the account's owner: a records call of the run holds the owner while it checks its caller, so a check that took the
/// owner too could never be answered and every records call of the run was refused (Nov 13 2026: a new account's
/// get-started screen read answered 502, workspace_read.rs `admit_door_instruction_read` RightsRefused). A run whose
/// party stands nowhere on the account reads nothing.
#[tokio::test]
async fn a_page_runs_standing_is_answered_while_a_call_holds_the_account() {
    use crate::account_rights::run_capability::{issue_from, Issued, Issuer, ParentKey, Refusal, RunOf};
    use crate::tool_runs::tools::task_context::Context;
    struct PageCause { token: String, sign_in: Arc<crate::account::account_routes::SignIn>, cause: String }
    impl Issuer for PageCause {
        fn issue(&self, records: &Value, lifetime: std::time::Duration) -> Result<Issued, Refusal> {
            issue_from(&ParentKey { account: OWNER, address: "synthetic-address", bearer: self.token.as_bytes(),
                door: "127.0.0.1:28788".parse().unwrap(), cause: None }, records, None, lifetime)
        }
        fn task_context(&self) -> Option<Context> {
            // As `cause_stands` asks it: of the account's routes alone, never of the account's owner.
            let (sign_in, cause) = (self.sign_in.clone(), self.cause.clone());
            Some(Context::account_at(OWNER, Arc::new(move || sign_in.standing(&cause).is_ok_and(|found| found.is_some()))))
        }
    }
    let fixture = Fixture::new();
    let owner = Arc::new(Mutex::new(fixture.selected()));
    let admission = Arc::new(Mutex::new(owner.lock().unwrap().admission_owner().unwrap()));
    let app = crate::native_boot::mcp_local::route_table_with_admission(owner.clone(), admission, sign_in(&owner), "127.0.0.1:28788".into()).unwrap();
    let door = crate::record_value::account_routes::Door::shipped().unwrap();
    let read = door.read_operation();
    let write = crate::record_write_model::write_command::Command::shipped().unwrap().operation();
    let note = json!({"records":[{"id":"note-1","type":"note","value":{"words":"RELEASED"}}]});
    let (_, made) = reply(&app, door_request(&fixture.token, "kept", write, note)).await;
    assert_eq!(made["result"]["structuredContent"], json!({"changed":true,"write_count":1}), "{made}");

    let records = json!({"fd":3,"rights":[{"kind":"note","operations":[read]}]});
    let routes = sign_in(&owner);
    let cause = format!("{}{}", crate::account::account_routes::PARTY_SIGN_IN, routes.address());
    let run = PageCause { token: fixture.token.clone(), sign_in: routes.clone(), cause }
        .issue_run(&records, std::time::Duration::from_secs(60), RunOf { tool: "tool:synthetic-page".into(), request_key: "page-run".into() })
        .unwrap();
    let (_, one) = reply(&app, door_request(run.capability.token(), "page-run-read", read, json!({"id":"note-1","type":"note"}))).await;
    assert_eq!(one["result"]["structuredContent"]["value"]["words"], "RELEASED", "{one}");

    // A cause whose party stands nowhere here is refused when its run is issued, so no token for it ever reaches the door.
    let other = PageCause { token: fixture.token.clone(), sign_in: routes.clone(), cause: format!("{}another", crate::account::account_routes::PARTY_SIGN_IN) }
        .issue_run(&records, std::time::Duration::from_secs(60), RunOf { tool: "tool:synthetic-page".into(), request_key: "other-run".into() });
    assert!(other.is_err(), "a run whose party stands nowhere here is not issued");
}

fn admission_factory_now() -> i64 { i64::try_from(millis()).unwrap() }

fn admission_factory_message(fixture: &Fixture, route: &crate::resource_authority::Route,
    key: &str, deadline: i64) -> Vec<u8> {
    serde_json::to_vec(&crate::resource_authority::InvokeMessage {
        request_id: key.into(), account_id: route.account_id.clone(), device_id: route.device_id.clone(),
        resource_address: route.resource_address.clone(), generation: route.generation.clone(),
        operation_resource: Some("@workshop-tools".into()), operation: "tools:list".into(),
        input: json!({"tool":"held-owner-probe"}), request_key: key.into(), person_present: None,
        client_authorization: fixture.token.clone(), deadline_at_ms: deadline,
    }).unwrap()
}

fn admission_factory(fixture: &Fixture, current: crate::account::account_routes::Current)
    -> (Arc<Mutex<crate::native_boot::SelectedAccount>>, crate::resource_authority::Route,
        crate::native_boot::forwarder_connection::SelectedMacDispatcher) {
    let package = fixture.root.join("workshop/tools/admission-probe");
    fs::create_dir_all(&package).unwrap();
    fs::write(package.join("tool-rows.json"), json!({"records":[{"payload":{
        "kind":"ai-tool-descriptor","id":"held-owner-probe","label":"Synthetic admission probe",
        "job":"Read synthetic tool metadata","input_schema":{"type":"object"},
        "invoke":{"kind":"container","argv":["true"]}
    }}]}).to_string()).unwrap();
    let owner = Arc::new(Mutex::new(fixture.selected()));
    let route = crate::resource_authority::Route { account_id: OWNER.into(), device_id: "synthetic-computer".into(),
        resource_address: "@own-records".into(), generation: "1".into() };
    let dispatcher = crate::native_boot::forwarder_connection::SelectedMacDispatcher::new_with_parent_current(
        owner.clone(), route.clone(), current, std::sync::Arc::new(crate::storage::time_source::RealClock)).unwrap();
    (owner, route, dispatcher)
}

/// Exercise the outbound connection's actual factory, credential authentication, tool admission and final body,
/// rather than injecting a separately constructed admission owner into the HTTP test adapter.
#[tokio::test]
async fn selected_factory_tool_read_answers_while_its_writer_is_held() {
    let fixture = Fixture::new();
    let (owner, route, dispatcher) = admission_factory(&fixture, Arc::new(|| true));
    let held = owner.lock().unwrap();
    let answer = dispatcher.dispatch(&admission_factory_message(&fixture, &route, "held-factory-read",
        admission_factory_now() + 1_000)).await.unwrap();
    let answer: Value = serde_json::from_slice(answer.as_ref()).unwrap();
    assert_eq!(answer["state"], "completed", "{answer}");
    assert_eq!(answer["value"]["id"], "held-owner-probe", "{answer}");
    drop(held);
}

#[tokio::test]
async fn selected_factory_tool_read_still_refuses_withdrawn_parent_and_expired_deadline() {
    let fixture = Fixture::new();
    let current = Arc::new(AtomicBool::new(true));
    let check = current.clone();
    let (owner, route, dispatcher) = admission_factory(&fixture,
        Arc::new(move || check.load(std::sync::atomic::Ordering::Acquire)));
    let held = owner.lock().unwrap();
    current.store(false, std::sync::atomic::Ordering::Release);
    let reply = dispatcher.dispatch(&admission_factory_message(&fixture, &route, "held-factory-withdrawn",
        admission_factory_now() + 1_000)).await.unwrap();
    let answer: Value = serde_json::from_slice(reply.as_ref()).unwrap();
    assert_eq!(answer["code"], "resource_connection_withdrawn", "{answer}");
    current.store(true, std::sync::atomic::Ordering::Release);
    let reply = dispatcher.dispatch(&admission_factory_message(&fixture, &route, "held-factory-expired",
        admission_factory_now() - 1)).await.unwrap();
    let answer: Value = serde_json::from_slice(reply.as_ref()).unwrap();
    assert_eq!(answer["state"], "refused", "{answer}");
    assert_ne!(answer["code"], "selected_owner_unavailable", "{answer}");
    drop(held);
}

#[tokio::test]
async fn selected_factory_tool_read_still_refuses_changed_selection() {
    let fixture = Fixture::new();
    let (owner, route, dispatcher) = admission_factory(&fixture, Arc::new(|| true));
    let held = owner.lock().unwrap();
    fs::write(fixture.root.join("adoption.json"), b"{}").unwrap();
    if let Ok(reply) = dispatcher.dispatch(&admission_factory_message(&fixture, &route, "held-factory-source-changed",
        admission_factory_now() + 1_000)).await {
        let answer: Value = serde_json::from_slice(reply.as_ref()).unwrap();
        assert!(matches!(answer["state"].as_str(), Some("refused" | "outcome_unknown")), "{answer}");
        assert_ne!(answer["code"], "selected_owner_unavailable", "{answer}");
        assert!(answer.get("value").is_none(), "{answer}");
    }
    drop(held);
}

#[tokio::test]
async fn selected_factory_tool_read_withholds_its_body_when_parent_ends_at_final_custody() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let fixture = Fixture::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let stop_at = Arc::new(AtomicUsize::new(usize::MAX));
    let counted = calls.clone();
    let stop = stop_at.clone();
    let (owner, route, dispatcher) = admission_factory(&fixture, Arc::new(move || {
        counted.fetch_add(1, Ordering::AcqRel) + 1 < stop.load(Ordering::Acquire)
    }));
    let held = owner.lock().unwrap();
    let reply = dispatcher.dispatch(&admission_factory_message(&fixture, &route, "held-factory-body-calibration",
        admission_factory_now() + 1_000)).await.unwrap();
    let answer: Value = serde_json::from_slice(reply.as_ref()).unwrap();
    assert_eq!(answer["state"], "completed", "{answer}");
    let checks = calls.swap(0, Ordering::AcqRel);
    assert!(checks > 2, "parent checks must span admission and output custody");
    stop_at.store(checks, Ordering::Release);
    let withheld = dispatcher.dispatch(&admission_factory_message(&fixture, &route, "held-factory-body-withdrawn",
        admission_factory_now() + 1_000)).await;
    assert!(withheld.is_err(), "final parent withdrawal must withhold the protected body");
    assert_eq!(calls.load(Ordering::Acquire), checks);
    drop(held);
}

#[test]
fn selected_factory_tool_read_never_constructs_from_a_poisoned_source_owner() {
    let fixture = Fixture::new();
    let (owner, route, dispatcher) = admission_factory(&fixture, Arc::new(|| true));
    drop(dispatcher);
    let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _held = owner.lock().unwrap();
        panic!("synthetic source-owner poison");
    }));
    assert!(poisoned.is_err());
    assert!(crate::native_boot::forwarder_connection::SelectedMacDispatcher::new_with_parent_current(
        owner, route, Arc::new(|| true), std::sync::Arc::new(crate::storage::time_source::RealClock)).is_err());
}

#[test]
fn selected_factory_tool_read_retains_request_cancellation_before_admission() {
    let fixture = Fixture::new();
    let (owner, _, dispatcher) = admission_factory(&fixture, Arc::new(|| true));
    drop(dispatcher);
    let sign_in = sign_in(&owner);
    let principal = sign_in.authenticate(fixture.token.as_bytes()).unwrap();
    let endpoint = crate::native_boot::mcp_local::LocalSelectedMcp::new(owner.clone()).unwrap();
    let disclosure = crate::mcp::RequestDisclosure::default();
    disclosure.cancellation_flag().store(true, std::sync::atomic::Ordering::Release);
    let held = owner.lock().unwrap();
    let answer = endpoint.invoke_at(&principal, fixture.token.as_bytes(), crate::mcp::Operation {
        resource: "@workshop-tools".into(), operation: "tools:list".into(), request_key: "held-factory-cancelled".into(),
        input: json!({"tool":"held-owner-probe"}), person_present: None,
    }, &disclosure, Arc::new(|| true), None);
    let failure = answer.unwrap_err();
    assert!(!failure.outcome_unknown, "cancelled admission cannot have started work");
    drop(held);
}

/// The account's own records store as wake's record source, holding the selected account for each read or write
/// alone (as the host's ticker does).
struct OwnSource<'a> {
    selected: &'a Mutex<crate::native_boot::SelectedAccount>,
    session: &'a str,
}
impl OwnSource<'_> {
    fn with<T>(&self, operation: impl FnOnce(&mut crate::local_account::own_records::OwnStore) -> Result<T, crate::records::Error>)
        -> Result<T, crate::records::Error> {
        let mut selected = self.selected.lock().unwrap();
        selected.with_own_store(self.session, Arc::new(AtomicBool::new(false)), |store, _| operation(store))
    }
}
impl crate::records::Records for OwnSource<'_> {
    fn get(&self, account: &str, resource: &str, id: &str) -> Result<crate::records::Read, crate::records::Error> {
        self.with(|store| store.get(account, resource, id))
    }
    fn mutate(&mut self, account: &str, resource: &str, input: crate::records::Mutation)
        -> Result<crate::records::Change, crate::records::Error> {
        self.with(|store| store.mutate(account, resource, input))
    }
    fn list_page(&self, account: &str, resource: &str, after: &str, limit: usize)
        -> Result<crate::records::Page<crate::records::Record, String>, crate::records::Error> {
        self.with(|store| store.list_page(account, resource, after, limit))
    }
    fn changes_page(&self, account: &str, resource: &str, after: i64, limit: usize)
        -> Result<crate::records::Page<crate::records::Change, i64>, crate::records::Error> {
        self.with(|store| store.changes_page(account, resource, after, limit))
    }
    fn mutate_admitted(&mut self, call: &crate::resource_authority::AdmittedCall, context: &dyn crate::records::CommitContext)
        -> Result<crate::records::Change, crate::records::Error> {
        self.with(|store| store.mutate_admitted(call, context))
    }
}
impl crate::wake::Source for OwnSource<'_> {
    fn stamp(&self, account: &str, resource: &str) -> Result<i64, crate::records::Error> {
        self.with(|store| store.stamp(account, resource))
    }
    fn ids_of_kind(&self, account: &str, resource: &str, kind: &str, before: Option<&str>, limit: usize)
        -> Result<(Vec<String>, Option<String>), crate::records::Error> {
        self.with(|store| store.ids_of_kind(account, resource, kind, before, limit))
    }
}

/// A wake-started run that removes the record its own wake listens to, through the account's routes with its run capability.
struct Remover<'a> {
    app: &'a axum::Router,
    token: &'a str,
    runs: std::cell::Cell<usize>,
}
impl crate::wake::Runner for Remover<'_> {
    fn deadline_ms(&self, _tool: &str) -> u64 {
        1_000
    }
    fn run(&self, request_key: &str, _: &str, _: &Value, _: &Value) -> Result<Value, crate::wake::RunFailure> {
        use crate::account_rights::run_capability::{mint, Rights};
        self.runs.set(self.runs.get() + 1);
        let write = crate::record_write_model::write_command::Command::shipped().unwrap().operation();
        let rights = Rights::declared(&json!({"fd":3,"rights":[{"kind":"note","operations":[write]}]})).unwrap();
        // The runner hands the cause key as the run's request key.
        let run = mint(OWNER, self.token.as_bytes(), rights, Some(request_key), std::time::Duration::from_secs(60)).unwrap();
        let removal = json!({"records":[{"id":"note-woken","type":"note","value":null}]});
        let (_, removed) = tokio::runtime::Handle::current()
            .block_on(reply(self.app, door_request(run.token(), &format!("{request_key}-remove"), write, removal)));
        assert_eq!(removed["result"]["isError"], false, "{removed}");
        Ok(json!({}))
    }
}

/// A run wake started removes the record its own wake listens to, through the account's routes: they name the removal's
/// change to wake (`Waker::own_change`), so that removal starts nothing; the same removal by the person's own key
/// starts a run.
#[tokio::test(flavor = "multi_thread")]
async fn a_caused_runs_removal_through_the_door_wakes_nothing() {
    let fixture = Fixture::new();
    let selected = Arc::new(Mutex::new(fixture.selected()));
    let app = crate::native_boot::mcp_local::route_table(selected.clone(), "127.0.0.1:28788".into()).unwrap();
    let write = crate::record_write_model::write_command::Command::shipped().unwrap().operation();
    let note = |id: &str| json!({"records":[{"id":id,"type":"note","value":{"words":"synthetic"}}]});
    let removal = |id: &str| json!({"records":[{"id":id,"type":"note","value":null}]});
    let answer = |reply: &Value| reply["result"]["structuredContent"].clone();
    // A record the wake will watch, written before the wake exists.
    let (_, made) = reply(&app, door_request(&fixture.token, "person-earlier", write, note("note-woken-earlier"))).await;
    assert_eq!(answer(&made), json!({"changed":true,"write_count":1}), "{made}");

    let waker = crate::wake::Waker::shipped().unwrap();
    // Declared as a trillion-local row's wake, so it is on without a switch (the switch is wake's own test).
    let rows = vec![crate::wake::Row { origin: crate::wake::Origin::Engine, tool: "remover".to_owned(),
        wakes: json!([{"id":"on-woken","on":{"record":{"resource":"own-records","prefix":"note-woken"}},
            "budget":{"steps":10,"wall_ms":60_000}}]) }];
    let wakes = waker.declared(&rows).unwrap();
    let remover = Remover { app: &app, token: &fixture.token, runs: std::cell::Cell::new(0) };
    let session = fixture.session.clone();
    let tick = || tokio::task::block_in_place(|| {
        let mut source = OwnSource { selected: &selected, session: &session };
        waker.tick(OWNER, &mut source, &crate::storage::record_store::RealClock, &remover, &wakes).unwrap()
    });
    assert_eq!(tick().admitted, 0, "a new wake starts after the changes already there");
    let (_, made) = reply(&app, door_request(&fixture.token, "person-woken", write, note("note-woken"))).await;
    assert_eq!(answer(&made), json!({"changed":true,"write_count":1}), "{made}");
    let woke = tick();
    assert_eq!((woke.admitted, remover.runs.get()), (1, 1), "the person's write starts one run, which removes it: {woke:?}");
    let after = tick();
    assert_eq!((after.admitted, remover.runs.get()), (0, 1), "the run's own removal starts nothing: {after:?}");

    // A removal by the person's own key is an outside change: it starts a run.
    let (_, removed) = reply(&app, door_request(&fixture.token, "person-removes", write, removal("note-woken-earlier"))).await;
    assert_eq!(answer(&removed), json!({"changed":true,"write_count":1}), "{removed}");
    let again = tick();
    assert_eq!((again.admitted, remover.runs.get()), (1, 2), "the person's removal starts a run: {again:?}");
}

/// A wake call holds the account only for its admission and the wake book's record operations: reading 300 tool
/// rows (every tenth declaring a wake) is prepared before, so the hold stays under 50 ms however many rows there are.
#[tokio::test(flavor = "multi_thread")]
async fn a_wake_call_holds_the_account_only_for_the_book_not_the_workshop_rows() {
    let fixture = Fixture::new();
    let package = fixture.root.join("workshop/tools/many-wakes");
    fs::create_dir_all(&package).unwrap();
    let rows: Vec<Value> = (0..300)
        .map(|n| {
            let mut row = json!({"kind":"ai-tool-descriptor","id":format!("tool-{n:03}"),"label":"synthetic","job":"synthetic",
                "invoke":{"kind":"container","argv":["true"]}});
            if n % 10 == 0 {
                row["wakes"] = json!([{"id":"on-note","on":{"record":{"resource":"own-records","prefix":format!("note-{n:03}")}},
                    "budget":{"steps":1,"wall_ms":200000}}]);
            }
            json!({"payload": row})
        })
        .collect();
    fs::write(package.join("tool-rows.json"), json!({"records": rows}).to_string()).unwrap();
    let selected = Arc::new(Mutex::new(fixture.selected()));
    let app = crate::native_boot::mcp_local::route_table(selected.clone(), "127.0.0.1:28788".into()).unwrap();
    let causes = crate::record_value::account_routes::Door::shipped().unwrap().wake_causes_operation();
    // Through the account's routes once: the key's first use is admitted and the book is read.
    let (_, first) = reply(&app, door_request(&fixture.token, "causes-first", causes, json!({}))).await;
    assert_eq!(first["result"]["structuredContent"]["wakes"].as_array().map(Vec::len), Some(30), "{first}");

    let sign_in = sign_in(&selected);
    let principal = sign_in.authenticate(fixture.token.as_bytes()).unwrap();
    let operation = crate::mcp::Operation { person_present: None,
        resource: "@own-records".into(), operation: causes.into(), input: json!({}), request_key: "causes-held".into(),
    };
    let (account, state_root) = selected.lock().unwrap().tool_place();
    let prepared = crate::native_boot::mcp_selected_personal::workspace_read::prepare_wake_call(&operation, account, state_root)
        .unwrap();
    // The least of five holds, so a busy machine's pause in one call does not decide it.
    let mut holds = Vec::new();
    for _ in 0..5 {
        let mut held = selected.lock().unwrap();
        let start = std::time::Instant::now();
        let answer = held
            .door_wake_call(&sign_in.caller(fixture.token.as_bytes(), &principal, &operation).unwrap(), &principal.sign_in, &prepared,
                Arc::new(AtomicBool::new(false)), std::time::Instant::now() + std::time::Duration::from_secs(5))
            .unwrap();
        holds.push(start.elapsed());
        drop(held);
        assert_eq!(answer["wakes"].as_array().map(Vec::len), Some(30), "the 30 rows' wakes");
    }
    let hold = *holds.iter().min().unwrap();
    assert!(hold < std::time::Duration::from_millis(50), "the account was held {holds:?}");
}

/// One workspace record of the fixture account, written as the store keeps it (null removes it).
fn shared_fixture_record(fixture: &Fixture, label: &str, value: Option<Value>) {
    let db = Connection::open(fixture.root.join("records.sqlite")).unwrap();
    let mut workspace = crate::workspace_store::Workspace::lend(&db, OWNER, crate::storage::sqlite::Access::Write).unwrap();
    let (version, _) = workspace.get(label).unwrap();
    let value = value.map(|value| crate::ecma_json::parse(value.to_string().as_bytes(), Default::default()).unwrap());
    workspace.change(label, version, value.as_ref(), &format!("fixture:{label}:{version}")).unwrap();
}

/// A share honored at the sharer's account routes (`account_rights::share_grant`, share-grant.json `door_grant`): the
/// bearer the sharer handed out reads exactly the record its sharing record names, is refused every other record and
/// every other operation, reaches nothing once the sharer takes the person out of the grant, and a bearer nobody was
/// given reads nothing. No person key is used by the reader.
#[tokio::test]
async fn a_share_bearer_reads_only_what_the_sharers_grant_names_now() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let grants = crate::account_rights::share_grant::Grants::shipped().unwrap();
    let fixture = Fixture::new();
    let prefix = grants.record_prefix().to_owned();
    let bearer = |byte: u8| format!("shr_{}", URL_SAFE_NO_PAD.encode([byte; 32]));
    let (given, stranger) = (bearer(7), bearer(9));
    let grant = |people: Value| json!({"record": "shared-preset", "people": people, "changed_at": "fixture-time"});
    shared_fixture_record(&fixture, "shared-preset", Some(json!({"types": [{"id": "simple", "words": "SHARED_CANARY"}]})));
    shared_fixture_record(&fixture, "kept-private", Some(json!({"words": "PRIVATE_CANARY"})));
    shared_fixture_record(&fixture, &format!("{prefix}shared-preset"),
        Some(grant(json!([{"principal": "fixture-person", "key_blake3": grants.digest(given.as_bytes()).unwrap()}]))));
    let app = route_table(&fixture);
    let read = |bearer: &str, key: &str, labels: Value| door_request(bearer, key, "workspace:read", json!({"selection": labels}));
    let refused = |reply: &Value| reply["result"]["isError"] == true && reply.to_string().contains("current_workspace_rights_refused");

    let (status, shared) = reply(&app, read(&given, "share-read", json!(["shared-preset"]))).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{shared}");
    assert!(shared.to_string().contains("SHARED_CANARY"), "{shared}");
    assert!(!shared.to_string().contains("PRIVATE_CANARY"), "{shared}");
    let (_, private) = reply(&app, read(&given, "share-private", json!(["kept-private"]))).await;
    assert!(refused(&private), "{private}");
    let (_, both) = reply(&app, read(&given, "share-both", json!(["shared-preset", "kept-private"]))).await;
    assert!(refused(&both) && !both.to_string().contains("PRIVATE_CANARY"), "{both}");
    let (_, grants_read) = reply(&app, read(&given, "share-grant-itself", json!([format!("{prefix}shared-preset")]))).await;
    assert!(refused(&grants_read), "a grant never shares grants: {grants_read}");
    let (_, by_prefix) = reply(&app, door_request(&given, "share-prefix", "workspace:read", json!({"selection": {"prefixes": ["shared"]}}))).await;
    assert!(refused(&by_prefix), "{by_prefix}");
    let (_, other_operation) = reply(&app, door_request(&given, "share-records-read", crate::record_value::account_routes::Door::shipped().unwrap().read_operation(),
        json!({"id": "shared-preset"}))).await;
    assert!(refused(&other_operation), "{other_operation}");
    let (_, unknown) = reply(&app, read(&stranger, "share-stranger", json!(["shared-preset"]))).await;
    assert!(refused(&unknown), "{unknown}");
    let (status, _) = reply(&app, read("shr_not-a-bearer", "share-malformed", json!(["shared-preset"]))).await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);

    shared_fixture_record(&fixture, &format!("{prefix}shared-preset"), Some(grant(json!([]))));
    let (_, withdrawn) = reply(&app, read(&given, "share-withdrawn", json!(["shared-preset"]))).await;
    assert!(refused(&withdrawn), "taking the person out of the grant ends their reads: {withdrawn}");
    assert!(!format!("{shared}{private}{both}{withdrawn}").contains(&given));
}

/// A public link's read: `GET /share/<code>.json` at the account's own routes, with no credential (the code is the bearer).
fn public_get(code: &str) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::builder()
        .method("GET")
        .uri(format!("/share/{code}.json"))
        .header("Host", "127.0.0.1:28788")
        .body(axum::body::Body::empty())
        .unwrap()
}

#[tokio::test]
async fn a_public_link_answers_its_list_only_while_its_grant_stands() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let grants = crate::account_rights::share_grant::Grants::shipped().unwrap();
    let fixture = Fixture::new();
    let prefix = grants.record_prefix().to_owned();
    let code = |byte: u8| format!("shr_{}", URL_SAFE_NO_PAD.encode([byte; 32]));
    let (link, private, stranger) = (code(21), code(22), code(23));
    let list = json!({"kind": "list", "title": "Week plan", "body": {
        "about": "PUBLIC_ABOUT",
        "fields": [{"id": "day", "kind": "date"}, {"id": "note", "kind": "text"}],
        "rows": [
            {"id": "row-1", "title": "First", "values": {"day": "2026-11-02", "note": "PUBLIC_NOTE"}},
            {"id": "row-2", "title": "Second", "values": {"day": "2026-11-09T10:00:00Z", "note": "later"}}],
        "files": [],
        "secret": "PRIVATE_CANARY"}});
    // The link's sharing record: one person, the code's digest, public scope; `patch` changes one part of it.
    let link_record = |patch: Value| {
        let mut record = json!({"record": "public-list", "scope": "public", "can": ["view"], "published": true,
            "revoked_at": null, "expires_at": null, "changed_at": "fixture-time",
            "people": [{"principal": "public", "key_blake3": grants.digest(link.as_bytes()).unwrap()}]});
        record.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
        record
    };
    shared_fixture_record(&fixture, "public-list", Some(list));
    shared_fixture_record(&fixture, "private-list", Some(json!({"kind": "list", "title": "Private", "body": {"secret": "PRIVATE_CANARY"}})));
    shared_fixture_record(&fixture, &format!("{prefix}public-list"), Some(link_record(json!({}))));
    shared_fixture_record(&fixture, &format!("{prefix}private-list"), Some(json!({"record": "private-list", "changed_at": "fixture-time",
        "people": [{"principal": "fixture-person", "key_blake3": grants.digest(private.as_bytes()).unwrap()}]})));
    let app = route_table(&fixture);

    let (status, answer) = reply(&app, public_get(&link)).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{answer}");
    let mut keys: Vec<&String> = answer.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["about", "changed", "fields", "files", "kind", "rows", "title"], "{answer}");
    assert_eq!(answer["kind"], "list");
    assert_eq!(answer["title"], "Week plan");
    assert_eq!(answer["about"], "PUBLIC_ABOUT");
    assert_eq!(answer["changed"], "2026-11-09", "the latest day a date field holds: {answer}");
    assert_eq!(answer["rows"].as_array().unwrap().len(), 2, "{answer}");
    assert_eq!(answer["rows"][0]["address"], "first", "{answer}");
    assert_eq!(answer["rows"][0]["url"], format!("https://127.0.0.1:28788/share/{link}/first"), "{answer}");
    assert_eq!(answer["rows"][1]["address"], "second", "{answer}");
    assert!(!answer.to_string().contains("PRIVATE_CANARY"), "{answer}");

    let (status, _) = reply(&app, public_get(&private)).await;
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND, "a private share never answers as a link");
    let (status, _) = reply(&app, public_get(&stranger)).await;
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND, "a code no record names");
    let (status, _) = reply(&app, public_get("shr_not-a-bearer")).await;
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND, "a malformed code");

    let closed = [
        ("revoked", json!({"revoked_at": "2026-11-02T00:00:00Z"})),
        ("expired", json!({"expires_at": "2020-01-01T00:00:00Z"})),
        ("unpublished", json!({"published": false})),
        ("without view", json!({"can": []})),
        ("with no person", json!({"people": []})),
    ];
    for (why, patch) in closed {
        shared_fixture_record(&fixture, &format!("{prefix}public-list"), Some(link_record(patch)));
        let (status, closed_answer) = reply(&app, public_get(&link)).await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND, "a {why} link answers nothing: {closed_answer}");
    }
    shared_fixture_record(&fixture, &format!("{prefix}public-list"), Some(link_record(json!({"expires_at": "2999-01-01T00:00:00Z"}))));
    let (status, _) = reply(&app, public_get(&link)).await;
    assert_eq!(status, axum::http::StatusCode::OK, "a link expiring later still answers");
}

/// A page of a share at the account's own routes (`GET /share/<code>`): status, headers and the body as text.
async fn share_page(app: &axum::Router, code: &str) -> (axum::http::StatusCode, axum::http::HeaderMap, String) {
    let request = axum::http::Request::builder().method("GET").uri(format!("/share/{code}"))
        .header("Host", "127.0.0.1:28788").body(axum::body::Body::empty()).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, headers, String::from_utf8_lossy(&bytes).into_owned())
}

/// A key-free share of a mixed collection (`account_rights::share_grant` `reach`): a list's definition, its rows by prefix and
/// one text record are read at the public data address, as a read-only page and by a second bearer at the records door, only
/// inside the reach and only while the sharing record stands (a person taken out, revoked, expired, unpublished, a
/// kind that stays on this computer, or a record that is also another shape reach nothing).
#[tokio::test]
async fn a_reach_share_reads_a_mixed_collection_only_inside_its_reach_and_only_while_it_stands() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let grants = crate::account_rights::share_grant::Grants::shipped().unwrap();
    let fixture = Fixture::new();
    let prefix = grants.record_prefix().to_owned();
    let code = |byte: u8| format!("shr_{}", URL_SAFE_NO_PAD.encode([byte; 32]));
    let (person, assistant, stranger) = (code(31), code(32), code(33));
    let door = crate::record_value::account_routes::Door::shipped().unwrap();
    let (read, list) = (door.read_operation(), door.list_operation());
    let write = crate::record_write_model::write_command::Command::shipped().unwrap().operation();
    let app = route_table(&fixture);
    let records = json!({"records": [
        {"id": "list:plan", "type": "list", "value": {"label": "Week plan", "row_type": "plan-row",
            "fields": [{"id": "day", "kind": "text", "label": "Day"}, {"id": "note", "kind": "text", "label": "Note"},
                {"id": "when", "kind": "date", "label": "When"}, {"id": "state", "kind": "choice", "label": "State"}],
            "views": [{"id": "open", "label": "Open by state", "rules": {"kind": "group", "combinator": "and", "negate": false,
                    "rules": [{"kind": "rule", "field": "state", "operator": "is_any_of", "params": {"values": ["open"]}}]},
                "groups": [{"field": "state"}], "sort": [{"field": "when", "direction": "desc"}],
                "display": {"as": "table", "settings": {"totals": {"group_by": "state", "measures": [{"op": "count"}]}}}}]}},
        {"id": "record:plan-row:r1", "type": "record:plan-row", "value": {"day": "Mon", "note": "<script>HOSTILE</script>", "when": "2026-11-02T09:30:00.000Z", "state": "open"}},
        {"id": "record:plan-row:r2", "type": "record:plan-row", "value": {"day": "Tue", "note": "second", "when": "2026-11-03", "state": "open"}},
        {"id": "record:plan-row:r3", "type": "record:plan-row", "value": {"day": "Wed", "note": "third", "when": "2026-11-04", "state": "done"}},
        {"id": "text:blessing", "type": "text", "value": {"text": "hello"}},
        {"id": "text:private", "type": "text", "value": {"text": "PRIVATE_CANARY"}},
        {"id": "print-1", "type": "kept-here", "value": {"words": "LOCAL_CANARY"}}]});
    let (_, made) = reply(&app, door_request(&fixture.token, "reach-seed", write, records)).await;
    assert_eq!(made["result"]["structuredContent"]["write_count"], 7, "{made}");
    let people = |keys: &[&str]| keys.iter().enumerate().map(|(n, key)|
        json!({"principal": format!("person-{n}"), "key_blake3": grants.digest(key.as_bytes()).unwrap(), "added_at": "2026-11-12T00:00:00Z"})).collect::<Vec<_>>();
    let share = |patch: Value, keys: &[&str]| {
        let mut record = json!({"reach": [{"type": "list", "id": "list:plan"}, {"type": "record:plan-row", "prefix": "record:plan-row:"},
            {"type": "text", "id": "text:blessing"}], "title": "Week", "about": "ABOUT_WORDS", "can": ["view"], "published": true,
            "revoked_at": null, "expires_at": null, "changed_at": "2026-11-12T00:00:00Z", "people": people(keys)});
        record.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
        record
    };
    let keep = |record: Value| shared_fixture_record(&fixture, &format!("{prefix}week"), Some(record));
    let refused = |reply: &Value| reply["result"]["isError"] == true && reply.to_string().contains("current_workspace_rights_refused");
    keep(share(json!({}), &[&person, &assistant]));

    // The data address: the whole collection, nothing of the sharing record, nothing outside the reach.
    let (status, answer) = reply(&app, public_get(&person)).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{answer}");
    assert_eq!(answer["kind"], "collection", "{answer}");
    assert_eq!((answer["title"].as_str(), answer["about"].as_str(), answer["truncated"].as_bool()), (Some("Week"), Some("ABOUT_WORDS"), Some(false)), "{answer}");
    let mut ids: Vec<&str> = answer["items"].as_array().unwrap().iter().filter_map(|item| item["id"].as_str()).collect();
    ids.sort();
    assert_eq!(ids, ["list:plan", "record:plan-row:r1", "record:plan-row:r2", "record:plan-row:r3", "text:blessing"], "{answer}");
    let text = answer.to_string();
    for canary in ["PRIVATE_CANARY", "LOCAL_CANARY", "key_blake3", "person-0", "sharing"] {
        assert!(!text.contains(canary), "{canary}: {answer}");
    }
    // The same collection as a read-only page: escaped, labelled by the list's own fields, under a nonce policy.
    let (status, headers, page) = share_page(&app, &person).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{page}");
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"), "{headers:?}");
    assert_eq!(headers["cache-control"], "no-store");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    let policy = headers["content-security-policy"].to_str().unwrap();
    assert!(policy.starts_with("default-src 'none'"), "{policy}");
    let nonce = policy.split("'nonce-").nth(1).unwrap().split('\'').next().unwrap();
    assert!(page.contains(&format!("nonce=\"{nonce}\"")), "{page}");
    assert!(page.contains("Week plan") && page.contains("<th>Day</th>") && page.contains("<td>Tue</td>") && page.contains("hello"), "{page}");
    assert!(page.contains("&lt;script&gt;HOSTILE&lt;/script&gt;") && !page.contains("<script"), "{page}");
    assert!(!page.contains("PRIVATE_CANARY") && !page.contains("LOCAL_CANARY"), "{page}");
    // A date is a plain date. Without the Workshop's operator DATA the engine cannot apply the view's rules: a notice, no rows.
    assert!(page.contains("<td>2026-11-02</td>") && !page.contains("T09:30:00") && page.contains(&grants.page_words().view_unsupported_notice), "{page}");
    // With the installed Workshop's operator DATA (the engine's own compiler and evaluator): the view is its own table, the
    // rows its rules let through, grouped by state with a count, newest first, and no total.
    let operators = fixture.root.join("workshop/tools/formula-engine/rules");
    std::fs::create_dir_all(&operators).unwrap();
    std::fs::write(operators.join("rule-operators.json"), json!({"schema": "formula-engine.rule-operators", "description": "synthetic",
        "combinators": [{"id": "and", "label": "All", "sentence": "and", "op": "op:core.and"}, {"id": "or", "label": "Any", "sentence": "or", "op": "op:core.or"}],
        "operators": [{"id": "is_any_of", "label": "is any of", "chip": "is", "icon": "list-checks", "input": "values", "applies_to": ["choice"],
            "binding": {"$kind": "binding", "select": {"from": "self", "path": {"$field": "path"}},
                "transform": [{"op": "op:core.in_list", "args": {"values": {"$param": "values"}}}]}}]}).to_string()).unwrap();
    let (_, _, viewed) = share_page(&app, &person).await;
    let view = viewed.split("Open by state").nth(1).unwrap_or_else(|| panic!("the view's own section: {viewed}"));
    assert!(view.contains("<h4>open</h4>") && view.contains("2 rows") && view.contains("2026-11-03") && !view.contains("2026-11-04"), "{view}");
    assert!(view.find("2026-11-03").unwrap() < view.find("2026-11-02").unwrap(), "newest first: {view}");
    assert!(view.contains(&grants.page_words().view_totals_notice) && !view.contains(&grants.page_words().view_unsupported_notice), "{view}");
    assert!(viewed.contains("<td>Wed</td>"), "the list's own table still draws every row: {viewed}");
    for code in [&stranger, "shr_not-a-bearer"] {
        assert_eq!(reply(&app, public_get(code)).await.0, axum::http::StatusCode::NOT_FOUND, "{code}");
        assert_eq!(share_page(&app, code).await.0, axum::http::StatusCode::NOT_FOUND, "{code}");
    }

    // The second bearer at the records door: inside the reach it reads, outside it is refused.
    let (_, one) = reply(&app, door_request(&assistant, "reach-read", read, json!({"id": "text:blessing", "type": "text"}))).await;
    assert_eq!(one["result"]["structuredContent"]["value"]["text"], "hello", "{one}");
    let (_, rows) = reply(&app, door_request(&assistant, "reach-list", list, json!({"type": "record:plan-row", "prefix": "record:plan-row:"}))).await;
    assert_eq!(rows["result"]["structuredContent"]["records"].as_array().map(Vec::len), Some(3), "{rows}");
    let outside = [
        ("private id", read, json!({"id": "text:private", "type": "text"})),
        ("wrong kind for an id", read, json!({"id": "text:blessing", "type": "list"})),
        ("an id outside a prefix", read, json!({"id": "record:other:r1", "type": "record:plan-row"})),
        ("a read without its kind", read, json!({"id": "text:blessing"})),
        ("a read with a time", read, json!({"id": "text:blessing", "type": "text", "at": 1})),
        ("a kind outside the reach", list, json!({"type": "kept-here"})),
        ("a list of an exact-id kind", list, json!({"type": "text"})),
        ("a list outside a prefix", list, json!({"type": "record:plan-row", "prefix": "record:other:"})),
        ("a whole kind where a prefix is reached", list, json!({"type": "record:plan-row"})),
        ("a filter", list, json!({"type": "record:plan-row", "prefix": "record:plan-row:", "where": {"day": "Mon"}})),
        ("the sharing records", "workspace:read", json!({"selection": [format!("{prefix}week")]})),
        ("a write", write, json!({"records": [{"id": "text:blessing", "type": "text", "value": {"text": "changed"}}]})),
    ];
    for (n, (why, operation, input)) in outside.into_iter().enumerate() {
        let (_, answer) = reply(&app, door_request(&assistant, &format!("reach-outside-{n}"), operation, input)).await;
        assert!(refused(&answer), "{why}: {answer}");
        assert!(!answer.to_string().contains("PRIVATE_CANARY") && !answer.to_string().contains("LOCAL_CANARY"), "{why}: {answer}");
    }

    // Each way a share stops: the next read, at both addresses, answers nothing. A person taken out ends only theirs.
    let stopped = [
        ("a person taken out", json!({"people": people(&[&assistant])}), false),
        ("revoked", json!({"revoked_at": "2026-11-12T00:00:00Z"}), true),
        ("expired", json!({"expires_at": "2020-01-01T00:00:00Z"}), true),
        ("unpublished", json!({"published": false}), true),
        ("without view", json!({"can": []}), true),
        ("also a record share", json!({"record": "text:blessing"}), true),
        ("an empty reach", json!({"reach": []}), true),
        ("an entry naming an id and a prefix", json!({"reach": [{"type": "text", "id": "text:blessing", "prefix": "text:"}]}), true),
        ("a kind that stays on this computer", json!({"reach": [{"type": "kept-here"}]}), true),
    ];
    for (why, patch, ends_assistant) in stopped {
        keep(share(patch, &[&person, &assistant]));
        let (status, closed) = reply(&app, public_get(&person)).await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND, "{why}: {closed}");
        assert_eq!(share_page(&app, &person).await.0, axum::http::StatusCode::NOT_FOUND, "{why}");
        let (_, after) = reply(&app, door_request(&assistant, &format!("reach-after-{why}"), read, json!({"id": "text:blessing", "type": "text"}))).await;
        if ends_assistant {
            assert!(refused(&after), "{why}: {after}");
        } else {
            assert_eq!(after["result"]["structuredContent"]["value"]["text"], "hello", "{why}: {after}");
        }
    }
    keep(share(json!({"expires_at": "2999-01-01T00:00:00Z"}), &[&person, &assistant]));
    assert_eq!(reply(&app, public_get(&person)).await.0, axum::http::StatusCode::OK, "a share expiring later still answers");
}

/// One `run_resource_operation` call at any address of the account's routes.
fn door_call(bearer: &str, key: &str, address: &str, operation: &str, input: Value) -> axum::http::Request<axum::body::Body> {
    let body = json!({"jsonrpc":"2.0","id":key,"method":"tools/call","params":{"name":"run_resource_operation",
        "arguments":{"address":address,"method":operation,"request_key":key,"input":input}}});
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
}

/// An act grant of a share in its two shapes, at the sharer's account routes (`account_rights::share_grant::Act`, share-grant.json
/// `door_grant.act`). A members' grant lets each member write only rows under their own prefix, named there: a
/// member writes their own answer, is refused another member's, another prefix and every read, and nothing is
/// granted before the sharer keeps the grant with their key, after the grant changes, or after it is withdrawn. A
/// pool's grant lets anyone run only its declared tool, unnamed: an undeclared tool, the tool list and every records
/// call are refused, the tool never sees who called (an identity the caller forged is removed), and the run's journal
/// keeps no digest of the input (the same request key with another input answers the first run).
#[tokio::test]
#[ignore = "an act grant runs only by re-admitting the key that kept it; standing grants stay refused until Better Auth gives each party its own tr_ key to keep (cutover step 2), then this runs as that key"]
async fn an_act_grant_writes_only_under_the_persons_prefix_or_runs_only_the_pools_tools_unnamed() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let grants = crate::account_rights::share_grant::Grants::shipped().unwrap();
    let sharing: Value = serde_json::from_slice(&fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/account_rights/share-grant.json")).unwrap()).unwrap();
    let act = &sharing["door_grant"]["act"];
    let tool_runs: Value = serde_json::from_slice(&fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tool_runs/tools/tool-runs.json")).unwrap()).unwrap();
    let door = crate::record_value::account_routes::Door::shipped().unwrap();
    let write = crate::record_write_model::write_command::Command::shipped().unwrap().operation();
    let fixture = Fixture::new();
    // The pool's one tool: it answers the input it was given, so the test sees exactly what reached it.
    let package = fixture.root.join("workshop/tools/pool-probe");
    fs::create_dir_all(&package).unwrap();
    fs::write(package.join("tool-rows.json"), json!({"records":[
        {"payload":{"kind":"ai-tool-descriptor","id":"add-a-result","label":"synthetic","job":"synthetic",
            "invoke":{"kind":"container","internet":false,"stdout":"json","argv":["sh","-c","cat"],"stdin":{"fill":{"from":"input"}}}}},
        {"payload":{"kind":"ai-tool-descriptor","id":"read-every-result","label":"synthetic","job":"synthetic",
            "invoke":{"kind":"container","internet":false,"stdout":"json","argv":["sh","-c","cat"],"stdin":{"fill":{"from":"input"}}}}},
        {"payload":{"kind":"ai-tool-descriptor","id":"answer-in-a-community","label":"synthetic","job":"synthetic",
            "invoke":{"kind":"container","internet":false,"stdout":"json","argv":["sh","-c","cat"],"stdin":{"fill":{"from":"input"}}}}}]}).to_string()).unwrap();
    let prefix = grants.record_prefix().to_owned();
    let bearer = |byte: u8| format!("shr_{}", URL_SAFE_NO_PAD.encode([byte; 32]));
    let (member_a, member_b, anyone) = (bearer(51), bearer(52), bearer(53));
    let person = |principal: &str, key: &str| json!({"principal": principal, "key_blake3": grants.digest(key.as_bytes()).unwrap()});
    let answers = json!({"records": {"rights": [{"kind": "record:match-answer", "operations": [write],
        "prefix": format!("record:match-answer:c1:{}:", act["self_mark"].as_str().unwrap())}]}, "identity": "self", "journal": "input"});
    let pool = json!({"tools": ["add-a-result"], "identity": "none", "journal": "none"});
    // A matchmaker's shape: its members run its one tool as themselves, and the tool learns who from trillion-local alone.
    let community = json!({"tools": ["answer-in-a-community"], "identity": "self", "journal": "input"});
    shared_fixture_record(&fixture, &format!("{prefix}community"), Some(json!({"grant": community,
        "people": [person("member-a", &member_a), person("member-b", &member_b)]})));
    shared_fixture_record(&fixture, &format!("{prefix}answers"), Some(json!({"grant": answers,
        "people": [person("member-a", &member_a), person("member-b", &member_b)]})));
    shared_fixture_record(&fixture, &format!("{prefix}pool"), Some(json!({"grant": pool, "people": [person("anyone-1", &anyone)]})));
    let app = route_table(&fixture);
    let at_records = |bearer: &str, key: &str, operation: &str, input: Value| door_call(bearer, key, "@own-records", operation, input);
    let answer = |id: &str| json!({"records": [{"id": id, "type": "record:match-answer", "value": {"answer": "yes"}}]});
    let keep = |key: &str, label: &str, on: bool| door_call(&fixture.token, key, act["keep_resource"].as_str().unwrap(),
        act["keep_operation"].as_str().unwrap(), json!({"label": label, "on": on}));
    let run = |bearer: &str, key: &str, tool: &str, input: Value| door_call(bearer, key, tool_runs["address"].as_str().unwrap(),
        tool_runs["run_method"].as_str().unwrap(), json!({"tool": tool, "input": input}));
    let refused = |reply: &Value| reply["result"]["isError"] == true && reply.to_string().contains("current_workspace_rights_refused");
    let wrote = |reply: &Value| reply["result"]["isError"] == false && reply["result"]["structuredContent"]["changed"] == true;

    // The list the answers are rows of, written by the sharer.
    let (_, listed) = reply(&app, records_request(Some(&fixture.token), "list-answers",
        json!([{"id":"list:match-answer","type":"list","value":{"row_type":"match-answer","fields":[{"id":"answer","kind":"text"}]}}]))).await;
    assert_eq!(listed["result"]["isError"], false, "{listed}");

    // Not kept yet: the grant acts as no key.
    let (_, early) = reply(&app, at_records(&member_a, "early", write, answer("record:match-answer:c1:member-a:q1"))).await;
    assert!(refused(&early), "{early}");
    // A run capability (or a share bearer) can never keep a grant: only the sharer's own key.
    let (_, by_member) = reply(&app, door_call(&member_a, "keep-by-member", act["keep_resource"].as_str().unwrap(),
        act["keep_operation"].as_str().unwrap(), json!({"label": "answers", "on": true}))).await;
    assert!(refused(&by_member), "{by_member}");
    let (_, kept) = reply(&app, keep("keep-answers", "answers", true)).await;
    assert_eq!(kept["result"]["structuredContent"], json!({"label": "answers", "on": true}), "{kept}");

    let (_, own) = reply(&app, at_records(&member_a, "own", write, answer("record:match-answer:c1:member-a:q1"))).await;
    assert!(wrote(&own), "a member writes their own answer: {own}");
    for (key, id) in [("other-member", "record:match-answer:c1:member-b:q1"), ("other-match", "record:match-answer:c2:member-a:q1"),
        ("bare-prefix", "record:match-answer:c1:member-a")] {
        let (_, outside) = reply(&app, at_records(&member_a, key, write, answer(id))).await;
        assert!(refused(&outside), "{key}: an undeclared prefix is refused: {outside}");
    }
    let (_, read) = reply(&app, at_records(&member_a, "read-own", door.read_operation(), json!({"id": "record:match-answer:c1:member-a:q1"}))).await;
    assert!(refused(&read), "a write grant reads nothing: {read}");
    let (_, listing) = reply(&app, at_records(&member_a, "list-all", door.list_operation(), json!({"type": "record:match-answer"}))).await;
    assert!(refused(&listing), "{listing}");
    let (_, b_own) = reply(&app, at_records(&member_b, "b-own", write, answer("record:match-answer:c1:member-b:q1"))).await;
    assert!(wrote(&b_own), "{b_own}");

    // The pool: kept, its one tool runs unnamed; nothing else does.
    let (_, pool_kept) = reply(&app, keep("keep-pool", "pool", true)).await;
    assert_eq!(pool_kept["result"]["structuredContent"]["on"], true, "{pool_kept}");
    let mut forged = json!({"worked": 1, "situation": "s-1"});
    forged[act["identity_field"].as_str().unwrap()] = json!("someone-else");
    let (_, added) = reply(&app, run(&anyone, "pool-add", "add-a-result", forged)).await;
    let result = &added["result"]["structuredContent"]["result"]["result"];
    assert_eq!(result["worked"], 1, "{added}");
    assert!(result.get(act["identity_field"].as_str().unwrap()).is_none() && !added.to_string().contains("anyone-1"),
        "the pool's side learns nothing of who acts: {added}");
    let (_, again) = reply(&app, run(&anyone, "pool-add", "add-a-result", json!({"worked": 0, "situation": "s-2"}))).await;
    assert_eq!(again["result"]["structuredContent"]["result"]["result"]["worked"], 1,
        "the journal keeps no digest of the input: the same key answers its first run: {again}");
    let (_, undeclared) = reply(&app, run(&anyone, "pool-undeclared", "read-every-result", json!({}))).await;
    assert!(refused(&undeclared), "an undeclared tool is refused: {undeclared}");
    let (_, tool_list) = reply(&app, door_call(&anyone, "pool-list", tool_runs["address"].as_str().unwrap(),
        tool_runs["list_method"].as_str().unwrap(), json!({}))).await;
    assert!(refused(&tool_list), "{tool_list}");
    let (_, rows) = reply(&app, at_records(&anyone, "pool-rows", door.list_operation(), json!({"type": "record:match-answer"}))).await;
    assert!(refused(&rows), "a pool caller can't read rows: {rows}");
    let (_, member_runs) = reply(&app, run(&member_a, "member-run", "add-a-result", json!({}))).await;
    assert!(refused(&member_runs), "a grant reaches only its own people: {member_runs}");

    // The tools shape with identity self: a member runs only the declared tool, as the person the grant names them,
    // whatever person the input claims; the journal keeps the input, so the same key with other input is refused.
    let identity_field = act["identity_field"].as_str().unwrap();
    let (_, early_member) = reply(&app, run(&member_a, "community-early", "answer-in-a-community", json!({"answer": "yes"}))).await;
    assert!(refused(&early_member), "{early_member}");
    let (_, community_kept) = reply(&app, keep("keep-community", "community", true)).await;
    assert_eq!(community_kept["result"]["structuredContent"]["on"], true, "{community_kept}");
    let mut claimed = json!({"answer": "yes"});
    claimed[identity_field] = json!("member-b");
    let (_, as_a) = reply(&app, run(&member_a, "community-a", "answer-in-a-community", claimed.clone())).await;
    let seen = &as_a["result"]["structuredContent"]["result"]["result"];
    let mut named = json!({"answer": "yes"});
    named[identity_field] = json!("member-a");
    assert_eq!(seen, &named, "the engine names the person: {as_a}");
    let (_, as_b) = reply(&app, run(&member_b, "community-b", "answer-in-a-community", json!({"answer": "no"}))).await;
    assert_eq!(as_b["result"]["structuredContent"]["result"]["result"][identity_field], "member-b", "{as_b}");
    let (_, replayed) = reply(&app, run(&member_a, "community-a", "answer-in-a-community", claimed)).await;
    assert_eq!(replayed["result"]["structuredContent"]["result"]["result"], *seen, "{replayed}");
    let (_, other_input) = reply(&app, run(&member_a, "community-a", "answer-in-a-community", json!({"answer": "no"}))).await;
    assert_eq!(other_input["result"]["isError"], true, "the journal kept this key's input: {other_input}");
    for (key, tool) in [("community-pool-tool", "add-a-result"), ("community-undeclared", "read-every-result")] {
        let (_, outside) = reply(&app, run(&member_a, key, tool, json!({}))).await;
        assert!(refused(&outside), "{key}: {outside}");
    }
    let (_, community_rows) = reply(&app, at_records(&member_a, "community-rows", door.list_operation(), json!({"type": "record:match-answer"}))).await;
    assert!(refused(&community_rows), "a tools grant reaches no records directly: {community_rows}");
    let (_, revoked) = reply(&app, keep("withdraw-community", "community", false)).await;
    assert_eq!(revoked["result"]["structuredContent"]["was_kept"], true, "{revoked}");
    let (_, after_revoke) = reply(&app, run(&member_a, "community-after", "answer-in-a-community", json!({"answer": "yes"}))).await;
    assert!(refused(&after_revoke), "{after_revoke}");

    // Changed after the keep: nothing until it is kept again. Withdrawn: nothing.
    let widened = json!({"tools": ["add-a-result", "read-every-result"], "identity": "none", "journal": "none"});
    shared_fixture_record(&fixture, &format!("{prefix}pool"), Some(json!({"grant": widened, "people": [person("anyone-1", &anyone)]})));
    let (_, changed) = reply(&app, run(&anyone, "pool-after-change", "read-every-result", json!({}))).await;
    assert!(refused(&changed), "{changed}");
    let (_, withdrawn) = reply(&app, keep("withdraw-answers", "answers", false)).await;
    assert_eq!(withdrawn["result"]["structuredContent"]["was_kept"], true, "{withdrawn}");
    let (_, after) = reply(&app, at_records(&member_a, "after-withdraw", write, answer("record:match-answer:c1:member-a:q2"))).await;
    assert!(refused(&after), "{after}");
    assert!(!format!("{own}{added}{again}{after}").contains(&member_a) && !format!("{added}").contains(&anyone));
}

/// An act grant withdrawn while its run is going withholds that run's answer: the run was admitted with the grant kept,
/// the withdrawal lands before the answer is ready to leave, and the currency check at delivery then refuses it. The
/// same run with no withdrawal answers, so the refusal is the withdrawal's.
#[test]
#[ignore = "an act grant runs only by re-admitting the key that kept it; standing grants stay refused until Better Auth gives each party its own tr_ key to keep (cutover step 2), then this runs as that key"]
fn a_withdrawn_act_grant_withholds_the_answer_of_a_run_already_going() {
    crate::test_bound::within("a_withdrawn_act_grant_withholds_the_answer_of_a_run_already_going", std::time::Duration::from_secs(240), || {
        tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap().block_on(a_withdrawn_act_grant_withholds_the_answer_of_a_run_already_going_body());
    });
}

async fn a_withdrawn_act_grant_withholds_the_answer_of_a_run_already_going_body() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let grants = crate::account_rights::share_grant::Grants::shipped().unwrap();
    let sharing: Value = serde_json::from_slice(&fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/account_rights/share-grant.json")).unwrap()).unwrap();
    let act = &sharing["door_grant"]["act"];
    let tool_runs: Value = serde_json::from_slice(&fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tool_runs/tools/tool-runs.json")).unwrap()).unwrap();
    let fixture = Fixture::new();
    // The gated tool reports its start through one named pipe and waits on another until the test releases it, so the
    // withdrawal lands while the run is in flight, with no timing.
    let started = fixture.root.join("gated-started").display().to_string();
    let gate = fixture.root.join("gated-gate").display().to_string();
    for pipe in [&started, &gate] {
        assert!(std::process::Command::new("mkfifo").arg(pipe).status().unwrap().success());
    }
    // A tool that answers after a second, so a withdrawal can land while it runs.
    let package = fixture.root.join("workshop/tools/slow-probe");
    fs::create_dir_all(&package).unwrap();
    fs::write(package.join("tool-rows.json"), json!({"records":[
        {"payload":{"kind":"ai-tool-descriptor","id":"answer-slowly","label":"synthetic","job":"synthetic",
            "invoke":{"kind":"container","internet":false,"stdout":"json","argv":["sh","-c","sleep 1; cat"],"stdin":{"fill":{"from":"input"}}}}},
        {"payload":{"kind":"ai-tool-descriptor","id":"answer-gated","label":"synthetic","job":"synthetic",
            "invoke":{"kind":"container","internet":false,"stdout":"json","argv":["sh","-c",format!("echo started > {started}; read _ < {gate}; cat")],"stdin":{"fill":{"from":"input"}}}}}]}).to_string()).unwrap();
    let prefix = grants.record_prefix().to_owned();
    let member = format!("shr_{}", URL_SAFE_NO_PAD.encode([71u8; 32]));
    let person = json!({"principal": "member-a", "key_blake3": grants.digest(member.as_bytes()).unwrap()});
    shared_fixture_record(&fixture, &format!("{prefix}slow"), Some(json!({"grant": {"tools": ["answer-slowly", "answer-gated"], "identity": "self", "journal": "input"},
        "people": [person]})));
    let app = route_table(&fixture);
    let keep = |key: &str, on: bool| door_call(&fixture.token, key, act["keep_resource"].as_str().unwrap(),
        act["keep_operation"].as_str().unwrap(), json!({"label": "slow", "on": on}));
    let run = |key: &str| door_call(&member, key, tool_runs["address"].as_str().unwrap(), tool_runs["run_method"].as_str().unwrap(),
        json!({"tool": "answer-slowly", "input": {"answer": "yes"}}));
    let refused = |reply: &Value| reply["result"]["isError"] == true && reply.to_string().contains("current_workspace_rights_refused");

    let (_, kept) = reply(&app, keep("keep-slow", true)).await;
    assert_eq!(kept["result"]["structuredContent"]["on"], true, "{kept}");
    let (status, control) = reply(&app, run("slow-undisturbed")).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(control["result"]["isError"], false, "a run with its grant kept answers: {control}");

    let running = tokio::spawn({
        let app = app.clone();
        let request = door_call(&member, "slow-withdrawn", tool_runs["address"].as_str().unwrap(), tool_runs["run_method"].as_str().unwrap(),
            json!({"tool": "answer-gated", "input": {"answer": "yes"}}));
        async move { reply(&app, request).await }
    });
    // The run is admitted and its tool has started once it opens the started pipe (a read waits for that writer).
    let begun = started.clone();
    tokio::task::spawn_blocking(move || std::fs::File::open(begun)).await.unwrap().unwrap();
    let (_, withdrawn) = reply(&app, keep("withdraw-slow", false)).await;
    assert_eq!(withdrawn["result"]["structuredContent"]["was_kept"], true, "{withdrawn}");
    // Release the tool: it answers only now, after the withdrawal.
    let release = gate.clone();
    tokio::task::spawn_blocking(move || std::fs::OpenOptions::new().write(true).open(release)).await.unwrap().unwrap();
    let (_, answer) = running.await.unwrap();
    // Withdrawn mid-run, the answer is withheld: as the grant refusal, or as an outcome the run cannot vouch for when the
    // withdrawal cancels it between its tool's exit and its reply. Either way no output is disclosed.
    let withheld = answer["result"]["isError"] == true
        && (refused(&answer) || answer.to_string().contains("workshop_run_outcome_unknown"));
    assert!(withheld, "the run admitted before the withdrawal is withheld: {answer}");
}

/// Run `step` right after the next command on the fixture's record book commits, before its answer is delivered.
fn after_commit(fixture: &Fixture, step: impl FnOnce() + Send + 'static) {
    crate::local_account::record_writer::native_command_context::AFTER_COMMIT
        .lock()
        .unwrap()
        .push((fixture.root.join("records.sqlite"), Box::new(step)));
}

/// A committed write always answers with its receipt, whatever holds the file while its answer is delivered: another
/// connection holding the write lock, or the command's own deadline spent at its commit.
#[tokio::test]
async fn a_committed_write_answers_its_receipt_while_another_writer_holds_the_file_or_its_deadline_has_passed() {
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let book = fixture.root.join("records.sqlite");
    // Another connection takes the write lock right after the commit and keeps it while the answer is delivered.
    let (locked, release) = (std::sync::mpsc::channel::<()>(), std::sync::mpsc::channel::<()>());
    let (locked_send, locked_wait) = locked;
    let (release_send, release_wait) = release;
    let holder = std::thread::spawn({
        let book = book.clone();
        move || {
            release_wait.recv().unwrap();
            let db = Connection::open(&book).unwrap();
            db.execute_batch("BEGIN IMMEDIATE").unwrap();
            locked_send.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(600));
            db.execute_batch("ROLLBACK").unwrap();
        }
    });
    after_commit(&fixture, move || {
        release_send.send(()).unwrap();
        locked_wait.recv().unwrap();
    });
    let before = state(&fixture);
    let (_, held) = reply(&app, records_request(Some(&fixture.token), "held-lock", pursuit("held"))).await;
    holder.join().unwrap();
    assert_eq!(held["result"]["isError"], false, "{held}");
    assert_eq!(held["result"]["structuredContent"], json!({"changed":true,"write_count":1}));
    assert_eq!(state(&fixture).1, before.1 + 1, "written once");

    // The command's deadline passes right after its commit: the delivery has its own bound.
    after_commit(&fixture, || std::thread::sleep(std::time::Duration::from_millis(5_200)));
    let before = state(&fixture);
    let (_, late) = reply(&app, records_request(Some(&fixture.token), "late", pursuit("late"))).await;
    assert_eq!(late["result"]["isError"], false, "{late}");
    assert_eq!(late["result"]["structuredContent"], json!({"changed":true,"write_count":1}));
    assert_eq!(state(&fixture).1, before.1 + 1, "written once");
}

/// One AI harness hook event at the same account (src/account/hooks.json), with the person's key: a session start keeps
/// its registration, a turn end keeps each message once, and every step is an ordinary records operation of that key.
#[tokio::test]
async fn a_harness_hook_event_keeps_its_records_through_the_accounts_own_records_operations() {
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let hook = |key: &str, input: Value| {
        let body = json!({"jsonrpc":"2.0","id":key,"method":"tools/call","params":{"name":"run_resource_operation",
            "arguments":{"resource":"@harness-hooks","operation":"hooks:receive","request_key":key,"input":input}}});
        axum::http::Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("Host", "127.0.0.1:28788")
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-06-18")
            .header("Authorization", format!("Bearer {}", fixture.token))
            .body(axum::body::Body::from(body.to_string()))
            .unwrap()
    };
    let (status, started) = reply(&app, hook("hook-start", json!({"harness": "codex", "event": "sessionStart",
        "payload": {"session_id": "0199aaaa-bbbb", "cwd": "/work/sample"}}))).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(started["result"]["structuredContent"]["refused"], json!([]), "{started}");
    let (_, card) = reply(&app, door_request(&fixture.token, "read-card", "records:read",
        json!({"id": "session-card:session-codex-0199aaaa-bbbb"}))).await;
    assert_eq!(card["result"]["structuredContent"]["value"]["source_id"], "codex:0199aaaa-bbbb", "{card}");
    assert_eq!(card["result"]["structuredContent"]["value"]["description"], "A Codex session on this computer, in sample.");

    let message = json!({"conversation_id": "codex:0199aaaa-bbbb", "app": "Codex", "speaker": "ai", "text": "SYNTHETIC_REPLY",
        "at": "2026-09-28T03:00:00.000Z", "final_reply": true});
    for key in ["hook-stop-1", "hook-stop-2"] {
        let (_, kept) = reply(&app, hook(key, json!({"harness": "codex", "event": "stop", "payload": {"session_id": "0199aaaa-bbbb"},
            "messages": [message]}))).await;
        assert_eq!(kept["result"]["structuredContent"]["accepted"], 1, "{kept}");
        assert_eq!(kept["result"]["structuredContent"]["refused"], json!([]), "{kept}");
    }
    let (_, listed) = reply(&app, door_request(&fixture.token, "list-messages", "records:list", json!({"type": "message"}))).await;
    let rows = listed["result"]["structuredContent"]["records"].as_array().cloned().unwrap_or_default();
    assert_eq!(rows.len(), 1, "a resend is the message already kept: {listed}");
    assert_eq!(rows[0]["value"]["text"], "SYNTHETIC_REPLY");
    assert!(rows[0]["id"].as_str().unwrap().starts_with("message:2026-09-28T03:00:00.000Z:"));

    // An input the hook operation does not take is refused by field, and a key it does not know is refused before any step.
    let (_, wrong) = reply(&app, hook("hook-wrong", json!({"harness": "codex", "event": "stop", "payload": {}, "colour": "red"}))).await;
    assert_eq!(wrong["result"]["isError"], true, "{wrong}");
}

/// The command's own loopback call (src/account/hooks.rs `call_account`) reaches the account as a served listener answers
/// it, and the answer it reads is the account's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hook_commands_loopback_call_is_answered_by_the_served_account_routes() {
    let fixture = Fixture::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = crate::native_boot::mcp_local::route_table(Arc::new(Mutex::new(fixture.selected())), address.to_string()).unwrap();
    let served = tokio::spawn(async move { axum::serve(listener, app).await });
    let token = fixture.token.clone();
    let answer = tokio::task::spawn_blocking(move || {
        let account = crate::account::hooks::HookRoutes::shipped().unwrap();
        let input = json!({"harness": "claude-code", "event": "SessionStart", "payload": {"session_id": "abcdef12-3456"}});
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        crate::account::hooks::call_account(account, address.port(), &token, &input, "hook-loopback", deadline)
    }).await.unwrap();
    served.abort();
    let answer = answer.expect("the account routes answered");
    assert_eq!(answer["refused"], json!([]), "{answer}");
    assert_eq!(answer["said"], "");
}

/// A run starts another Workshop tool (Round 2 contract A, tool-runs.json `runs`): a run whose row names
/// `invoke.records.runs` calls the tool run at the Workshop's address with its own capability, for exactly those tools,
/// never itself; the nested run's key is derived from the parent run's key, the tool and the key its call gave, so the
/// same parent and given key answer the first run again, and the nested run's records are the started row's met with
/// the parent's (a parent with no records right starts no tool that needs one).
#[tokio::test]
async fn a_run_starts_only_the_tools_its_row_names_under_a_key_derived_from_its_own() {
    use crate::account_rights::run_capability::{mint, RunOf, Rights};
    let fixture = Fixture::new();
    let package = fixture.root.join("workshop/tools/nested-probe");
    fs::create_dir_all(&package).unwrap();
    let echo = json!({"kind":"container","internet":false,"stdout":"json","argv":["sh","-c","cat"],"stdin":{"fill":{"from":"input"}}});
    let mut reader = echo.clone();
    reader["records"] = json!({"fd": 3, "rights": [{"kind": "note", "operations": ["records:read"]}]});
    let row = |id: &str, invoke: &Value| json!({"payload":{"kind":"ai-tool-descriptor","id":id,"label":"synthetic","job":"synthetic","invoke":invoke}});
    fs::write(package.join("tool-rows.json"), json!({"records":[row("tool:nested-parent", &echo), row("tool:nested-child", &echo),
        row("tool:nested-other", &echo), row("tool:nested-reader", &reader)]}).to_string()).unwrap();
    let tool_runs: Value = serde_json::from_slice(&fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tool_runs/tools/tool-runs.json")).unwrap()).unwrap();
    let (address, run_method) = (tool_runs["address"].as_str().unwrap(), tool_runs["run_method"].as_str().unwrap());
    let app = route_table(&fixture);
    let declared = json!({"fd": 3, "runs": ["tool:nested-child", "tool:nested-reader"]});
    let parent_run = |key: &str| {
        let capability = mint(OWNER, fixture.token.as_bytes(), Rights::declared(&declared).unwrap(), None, std::time::Duration::from_secs(60)).unwrap();
        capability.bind_run(RunOf { tool: "tool:nested-parent".into(), request_key: key.into() }).unwrap();
        capability
    };
    let start = |bearer: &str, given: &str, tool: &str, input: Value| door_call(bearer, given, address, run_method, json!({"tool": tool, "input": input}));
    let refused = |reply: &Value| reply["result"]["isError"] == true;
    let result = |reply: &Value| reply["result"]["structuredContent"]["result"]["result"].clone();

    let first = parent_run("parent-1");
    let second = parent_run("parent-2");
    // A named tool passes the parent's capability and reaches the runner. Running a container needs this computer's
    // own sandbox (macOS); elsewhere the runner answers that it cannot run here, which is past every rights check.
    let (_, ran) = reply(&app, start(first.token(), "given-1", "tool:nested-child", json!({"n": 1}))).await;
    assert!(!ran.to_string().contains("current_workspace_rights_refused"), "{ran}");
    if cfg!(target_os = "macos") {
        assert_eq!(result(&ran), json!({"n": 1}), "{ran}");
        let (_, again) = reply(&app, start(first.token(), "given-1", "tool:nested-child", json!({"n": 1}))).await;
        assert_eq!(result(&again), json!({"n": 1}), "the same parent and given key answer the first run: {again}");
        let (_, reused) = reply(&app, start(first.token(), "given-1", "tool:nested-child", json!({"n": 2}))).await;
        assert!(refused(&reused) && reused.to_string().contains("workshop_run_key_reused"), "one derived key, one input: {reused}");
        // Another parent run: its own derived keys.
        let (_, other_parent) = reply(&app, start(second.token(), "given-1", "tool:nested-child", json!({"n": 2}))).await;
        assert_eq!(result(&other_parent), json!({"n": 2}), "{other_parent}");
        // The started row asks for records the parent holds none of: it gets nothing, so it does not start.
        let (_, wider) = reply(&app, start(first.token(), "reader", "tool:nested-reader", json!({}))).await;
        assert!(refused(&wider) && wider.to_string().contains("not_granted"), "{wider}");
    }
    // Only the named tools, never the parent itself, never the list, never an engine row (the engine declares none now).
    let engine = tool_runs["engine_rows"].as_array().unwrap().iter().map(|row| ("engine", row["id"].as_str().unwrap()));
    for (given, tool) in [("other", "tool:nested-other"), ("itself", "tool:nested-parent")].into_iter().chain(engine) {
        let (_, no) = reply(&app, start(first.token(), given, tool, json!({}))).await;
        assert!(refused(&no) && no.to_string().contains("current_workspace_rights_refused"), "{given}: {no}");
    }
    let (_, listing) = reply(&app, door_call(first.token(), "list", address, tool_runs["list_method"].as_str().unwrap(), json!({}))).await;
    assert!(refused(&listing) && listing.to_string().contains("current_workspace_rights_refused"), "{listing}");
    // A capability no run was bound to starts nothing; nor does one after its run ended.
    let unbound = mint(OWNER, fixture.token.as_bytes(), Rights::declared(&declared).unwrap(), None, std::time::Duration::from_secs(60)).unwrap();
    let (_, no_run) = reply(&app, start(unbound.token(), "unbound", "tool:nested-child", json!({}))).await;
    assert!(refused(&no_run), "{no_run}");
    let token = first.token().to_owned();
    drop(first);
    let (status, ended) = reply(&app, start(&token, "ended", "tool:nested-child", json!({}))).await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED, "a capability whose run ended is no bearer: {ended}");
}

/// Get started's facts at the account files door (Round 2 contract C, account-files-routes.json `setup_facts`): the
/// person's key reads them; a run reaches them only with a files right that names the operation; the input is only
/// the asking browser's {user_agent, origin}; no fact the engine cannot answer is sent as known.
#[tokio::test]
async fn setup_facts_answer_the_accounts_own_mechanics_at_the_files_door() {
    use crate::account_rights::run_capability::{mint, Rights};
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let files = crate::account_files::account_routes::AccountFilesDoor::shipped().unwrap();
    let at_files = |bearer: &str, key: &str, input: Value| door_call(bearer, key, files.resource(), "setup_facts", input);
    let (_, read) = reply(&app, at_files(&fixture.token, "facts", json!({"user_agent": "Mozilla/5.0 (Macintosh)", "origin": "https://app.example"}))).await;
    let answer = &read["result"]["structuredContent"];
    assert_eq!(read["result"]["isError"], false, "{read}");
    assert_eq!(answer["facts"], json!({}), "only facts the engine answers one to one: {read}");
    // Who is signed in and how is the Better Auth Workshop tool's to answer (Nov 13 2026); the engine holds no sign-in rows.
    assert!(answer.get("signed_in").is_none(), "{read}");
    assert_eq!(answer["origin"], "https://app.example");
    for (key, input) in [("extra", json!({"user_agent": "x", "account": "other"})), ("shape", json!({"origin": 7}))] {
        let (_, refused) = reply(&app, at_files(&fixture.token, key, input)).await;
        assert_eq!(refused["result"]["isError"], true, "{key}: {refused}");
    }
    let run = |rights: Value| mint(OWNER, fixture.token.as_bytes(), Rights::declared(&json!({"fd": 3, "rights": rights})).unwrap(),
        None, std::time::Duration::from_secs(60)).unwrap();
    let granted = run(json!([{"files": "/", "operations": ["setup_facts"]}]));
    let (_, by_run) = reply(&app, at_files(granted.token(), "run-facts", json!({}))).await;
    assert_eq!(by_run["result"]["structuredContent"]["signed_in"], answer["signed_in"], "{by_run}");
    let other = run(json!([{"files": "/", "operations": ["list_files"]}]));
    let (_, refused) = reply(&app, at_files(other.token(), "run-no-facts", json!({}))).await;
    assert!(refused["result"]["isError"] == true && refused.to_string().contains("current_workspace_rights_refused"), "{refused}");
}

/// Which connected accounts hold values in the account's vault, at the account files door (account-files-routes.json
/// `held_connections`): it takes no input, a run reaches it only with a files right that names the operation, and a vault
/// that cannot be opened is refused by its code, never answered as holding no connections. A separate process with a
/// synthetic hosting-app key opens a synthetic vault through `open_home`; the route then answers its names without any
/// value. What it names from the vault's names is src/tool_runs/tools/tests.rs
/// held_connections_are_read_from_the_names_held_name_gives.
#[tokio::test]
async fn held_connections_are_the_vaults_and_refused_when_it_cannot_be_opened() {
    use crate::account_rights::run_capability::{mint, Rights};
    const CHILD: &str = "TRILLION_HELD_CONNECTIONS_TEST_CHILD";
    const NAME: &str = "held_connections_are_the_vaults_and_refused_when_it_cannot_be_opened";
    let child_mode = std::env::var(CHILD).ok();
    if child_mode.is_none() {
        let module = module_path!().split_once("::").map_or(module_path!(), |(_, rest)| rest);
        let exact = format!("{module}::{NAME}");
        let home: Value = serde_json::from_slice(crate::secrets::CREDENTIAL_HOME).unwrap();
        let store_setting = home.get("store_setting").and_then(Value::as_str);
        let sentinel_dir = tempfile::tempdir().unwrap();
        let sentinel = sentinel_dir.path().join("inherited-store-is-not-a-vault.sqlite");
        let sentinel_bytes = b"SYNTHETIC_NOT_A_VAULT";
        fs::write(&sentinel, sentinel_bytes).unwrap();
        for mode in ["missing", "positive"] {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child.args(["--exact", &exact, "--test-threads=1", "--nocapture"]).env(CHILD, mode);
            if let Some(setting) = store_setting {
                // If removal regresses, the child sees only this invalid synthetic store, never a caller's real store.
                child.env(setting, &sentinel).env_remove(setting);
            }
            let output = child.output().unwrap();
            assert_eq!(fs::read(&sentinel).unwrap(), sentinel_bytes, "the child must not touch the fake inherited store");
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(output.status.success(), "{mode} child failed\nstdout: {}\nstderr: {}",
                stdout, String::from_utf8_lossy(&output.stderr));
            assert!(stdout.contains("running 1 test") && stdout.contains(&format!("test {exact} ... ok"))
                && stdout.contains("1 passed; 0 failed") && !stdout.contains("0 tests"),
                "{mode} child did not run exactly the intended test\nstdout: {stdout}");
        }
        return;
    }

    match child_mode.as_deref().unwrap() {
        "missing" => crate::secrets::secrets_key::choose_source(crate::secrets::secrets_key::SecretsKeySource::HostingApp).unwrap(),
        "positive" => {
            let key = crate::secrets::SecretsKey::new(zeroize::Zeroizing::new(format!("nm_{OWNER}_{}", "a".repeat(64)))).unwrap();
            crate::secrets::secrets_key::give(key).unwrap();
        }
        other => panic!("unknown child mode {other}"),
    }

    // Choose the source before the fixture can open anything. Seed through `open_home` at the fixture's declared vault
    // placement so the seed and the route share the production identity and store paths.
    let fixture = Fixture::new();
    if child_mode.as_deref() == Some("positive") {
        let vault = crate::secrets::open_home(&fixture.root, OWNER).unwrap();
        let hex = |text: &str| text.bytes().map(|byte| format!("{byte:02x}")).collect::<String>();
        let connection = "synthetic-connection";
        let id = hex(connection);
        let whole = format!("service-connection-{id}");
        let api_field = "api-key";
        let refresh_field = "refresh-token";
        for name in [whole, format!("service-connection-{id}-field-{}", hex(api_field)),
            format!("service-connection-{id}-field-{}", hex(refresh_field)), "unrelated-canary".to_owned()] {
            vault.put(&name, zeroize::Zeroizing::new("SYNTHETIC_CONNECTION_CANARY".into())).unwrap();
        }
    }

    let app = route_table(&fixture);
    let files = crate::account_files::account_routes::AccountFilesDoor::shipped().unwrap();
    let at_files = |bearer: &str, key: &str, input: Value| door_call(bearer, key, files.resource(), "held_connections", input);
    let code = |answer: &Value| answer["result"]["structuredContent"]["code"].as_str().map(str::to_owned);
    let (_, read) = reply(&app, at_files(&fixture.token, "held", json!({}))).await;
    if child_mode.as_deref() == Some("missing") {
        assert_eq!(read["result"]["isError"], true, "{read}");
        assert_eq!(code(&read).as_deref(), Some("current_source_unavailable"), "an unopened vault is not an empty one: {read}");
        assert!(read["result"]["structuredContent"].get("connections").is_none(), "{read}");
    } else {
        let expected = json!({"connections":[{"connection_id":"synthetic-connection","fields":["api-key","refresh-token"]}]});
        assert_eq!(read["result"]["isError"], false, "{read}");
        assert_eq!(read["result"]["structuredContent"], expected, "whole and field names identify only their connection: {read}");
        assert!(!read.to_string().contains("SYNTHETIC_CONNECTION_CANARY"), "the route returns names, never a vault value: {read}");
    }
    let (_, refused) = reply(&app, at_files(&fixture.token, "held-input", json!({"vendor": "stripe"}))).await;
    assert_eq!(code(&refused).as_deref(), Some("original_input_refused"), "{refused}");
    let run = |rights: Value| mint(OWNER, fixture.token.as_bytes(), Rights::declared(&json!({"fd": 3, "rights": rights})).unwrap(),
        None, std::time::Duration::from_secs(60)).unwrap();
    let granted = run(json!([{"files": "/", "operations": ["held_connections"]}]));
    let (_, by_run) = reply(&app, at_files(granted.token(), "run-held", json!({}))).await;
    if child_mode.as_deref() == Some("missing") {
        assert_eq!(code(&by_run).as_deref(), Some("current_source_unavailable"), "the run is let in and reaches the vault: {by_run}");
    } else {
        assert_eq!(by_run["result"]["structuredContent"], read["result"]["structuredContent"], "the authorized run sees the same route answer: {by_run}");
    }
    let other = run(json!([{"files": "/", "operations": ["setup_facts"]}]));
    let (_, refused) = reply(&app, at_files(other.token(), "run-no-held", json!({}))).await;
    assert!(refused["result"]["isError"] == true && refused.to_string().contains("current_workspace_rights_refused"), "{refused}");
}

/// `check_only: true` in a records:write input runs every check and refusal of the write and commits nothing: the account's
/// version rows, its command rows and its records are the same after it, its request key is not kept, and the real write
/// that follows (even under the same key) is the first.
#[tokio::test]
async fn a_check_only_write_answers_what_the_write_would_do_and_commits_nothing() {
    let fixture = Fixture::owned_by(&"e".repeat(64));
    let app = route_table(&fixture);
    let write = records_request(Some(&fixture.token), "check-made", json!([{"id":"check-note","type":"note","value":{"words":"kept","price":9900}}]));
    let (_, made) = reply(&app, write).await;
    assert_eq!(made["result"]["isError"], false, "{made}");
    let identity = {
        let (_, read) = reply(&app, door_request(&fixture.token, "check-read", "records:read", json!({"id":"check-note"}))).await;
        read["result"]["structuredContent"]["identity"].clone()
    };
    let before = state(&fixture);

    // A removal and a replacement, checked: the counts the write would have, and nothing stored.
    for (key, records) in [
        ("check-remove", json!([{"id":"check-note","value":null}])),
        ("check-replace", json!([{"id":"check-note","type":"note","value":{"words":"new"}},{"id":"check-other","type":"note","value":{"a":1}}])),
    ] {
        let (_, checked) = reply(&app, door_request(&fixture.token, key, "records:write", json!({"records":records,"check_only":true}))).await;
        assert_eq!(checked["result"]["isError"], false, "{checked}");
        assert_eq!(checked["result"]["structuredContent"]["check_only"], true, "{checked}");
        assert_eq!(checked["result"]["structuredContent"]["changed"], true, "{checked}");
        assert_eq!(checked["result"]["structuredContent"]["write_count"], records.as_array().unwrap().len(), "{checked}");
        assert_eq!(state(&fixture), before, "a check_only write leaves every version row and command row as it was ({key})");
    }
    let (_, read) = reply(&app, door_request(&fixture.token, "check-read-2", "records:read", json!({"id":"check-note"}))).await;
    assert_eq!(read["result"]["structuredContent"]["value"], json!({"words":"kept","price":9900}), "{read}");
    assert_eq!(read["result"]["structuredContent"]["identity"], identity);
    let (_, absent) = reply(&app, door_request(&fixture.token, "check-read-3", "records:read", json!({"id":"check-other"}))).await;
    assert!(absent["result"]["structuredContent"]["value"].is_null(), "{absent}");

    // The refusals the real write would meet are the check's: a stale fence, and a check_only that is not a boolean.
    let stale = json!({"records":[{"id":"check-note","type":"note","value":{"words":"x"},"expected":{"type":"note","identity":"1"}}],"check_only":true});
    let (_, refused) = reply(&app, door_request(&fixture.token, "check-stale", "records:write", stale)).await;
    assert_eq!(refused["result"]["structuredContent"]["code"], "original_command_conflict", "{refused}");
    let (_, wrong) = reply(&app, door_request(&fixture.token, "check-wrong", "records:write", json!({"records":[{"id":"check-note","value":null}],"check_only":"yes"}))).await;
    assert_eq!(wrong["result"]["isError"], true, "{wrong}");
    assert_eq!(state(&fixture), before, "a refused check changes nothing either");

    // The same key and records, without check_only, is the first write under that key: the check kept nothing.
    let (_, real) = reply(&app, door_request(&fixture.token, "check-remove", "records:write", json!({"records":[{"id":"check-note","value":null}]}))).await;
    assert_eq!(real["result"]["isError"], false, "{real}");
    assert_eq!(real["result"]["structuredContent"], json!({"changed":true,"write_count":1}), "{real}");
    let (_, gone) = reply(&app, door_request(&fixture.token, "check-read-4", "records:read", json!({"id":"check-note"}))).await;
    assert!(gone["result"]["structuredContent"]["value"].is_null(), "{gone}");
}
