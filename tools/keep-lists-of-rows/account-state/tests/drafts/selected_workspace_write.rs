// Selected producer controls over a synthetic original LocalAccount.
//
// The fixture uses only retained existing account, gate, RECORD_BOOK, record
// log and command-journal schemas. Its selected descriptor pins the local ICU
// profile and image closure. It creates no browser session or new authority.

mod supplied_connection {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/drafts/selected_workspace_connection.rs"
    ));
}

use super::*;
use content_crypto::advanced::blake3;
use crate::{
    account::SecretNativeKey,
    import::FilePin,
    local_account::SelectedLocalState,
    mcp::{Operation, Principal},
    record_log::{Context, LogIds, Request},
    resource_authority::Route,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REQUEST_KEY: &str = "selected-workspace-write-retry";

struct Fixture {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    receipt: FilePin,
    token: String,
    signin: String,
}

fn millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap()
}

fn iso(at: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(at.try_into().unwrap())
        .unwrap()
        .to_rfc3339()
}

fn directory(db: &Connection, name: &str, value: Value) {
    db.execute(
        "INSERT OR REPLACE INTO policy_directory VALUES(?,?)",
        [name, &value.to_string()],
    )
    .unwrap();
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
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let token = format!(
            "nm_{}",
            blake3::hash(b"SYNTHETIC_SELECTED_WORKSPACE_WRITE_KEY")
                .to_hex()
                .as_str()
        );
        let digest = SecretNativeKey::parse(&token).unwrap().identity();
        let signin = format!("key:{digest}");
        let browser_token = "b".repeat(64);
        let browser_session = blake3::hash(browser_token.as_bytes()).to_hex().to_string();
        fs::write(root.join("browser-session.key"), &browser_token).unwrap();
        fs::set_permissions(
            root.join("browser-session.key"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();

        let now = millis();
        let reach = json!({"private":true,"spaces":"all"});
        let row = json!({"made":reach,"ceiling":reach,"chosen":null,"last_used":iso(now)});
        let policy = Connection::open(root.join("policy.sqlite")).unwrap();
        policy
            .execute_batch(
                "CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)",
            )
            .unwrap();
        directory(&policy, "revision", json!(7));
        directory(&policy, "policy-source", json!({"from":"born","missing":[]}));
        directory(
            &policy,
            "policy-source:account",
            json!({"lifecycle":{},"access":{},"account_controls":{"owner_user_id":user}}),
        );
        directory(
            &policy,
            &format!("policy-source:sign-in:{signin}"),
            row.clone(),
        );
        drop(policy);

        let kv_folder = root.join("storage/kv/trillion-local-app");
        fs::create_dir_all(kv_folder.join("blobs")).unwrap();
        let kv_path = kv_folder.join("current.sqlite");
        let kv = Connection::open(&kv_path).unwrap();
        kv.execute_batch("CREATE TABLE _mf_entries(key TEXT PRIMARY KEY,blob_id TEXT NOT NULL,expiration INTEGER)")
            .unwrap();
        for (name, blob, value) in [
            (
                format!("session:{browser_session}"),
                "aa",
                json!({"userId":"synthetic-user"}),
            ),
            (
                format!("personal-key:{digest}"),
                "bb",
                json!({"userId":"synthetic-user","created_at":iso(now - 86_400_000),"reach":reach,"ceiling":reach}),
            ),
        ] {
            kv.execute(
                "INSERT INTO _mf_entries(key,blob_id) VALUES(?,?)",
                [&name, blob],
            )
            .unwrap();
            fs::write(kv_folder.join("blobs").join(blob), value.to_string()).unwrap();
        }
        drop(kv);

        let records = Connection::open(root.join("records.sqlite")).unwrap();
        records.execute_batch(
            "CREATE TABLE own_resource_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,resource TEXT NOT NULL,generation INTEGER NOT NULL,ready INTEGER NOT NULL);
             INSERT INTO own_resource_identity VALUES(1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','@own-records',1,1);
             CREATE TABLE workspace_records(label TEXT PRIMARY KEY,value TEXT NOT NULL,written_at TEXT NOT NULL);
             INSERT INTO workspace_records VALUES('saved-board','{\"items\":[\"kept\"]}','original-time');
             CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
             INSERT INTO record_keys_meta VALUES('engine','\"record-log\"');
             CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT);
             CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER);
             CREATE TABLE record_keys_big(ref TEXT,part INTEGER,body TEXT,PRIMARY KEY(ref,part)) WITHOUT ROWID;
             CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT NOT NULL);
             CREATE TABLE resource_behavior_commands(permit_id TEXT PRIMARY KEY,identity TEXT NOT NULL,operation TEXT NOT NULL,input TEXT NOT NULL,context TEXT NOT NULL,state TEXT NOT NULL,result TEXT,execution_ref TEXT);
             CREATE TABLE record_erasable_keys(record_id TEXT PRIMARY KEY,key BLOB,erased_at TEXT,erased_fields TEXT) WITHOUT ROWID;
             CREATE TRIGGER capture_before_command BEFORE INSERT ON resource_behavior_commands
             WHEN NOT EXISTS(SELECT 1 FROM record_log WHERE instr(envelopes,NEW.execution_ref)>0)
             BEGIN SELECT RAISE(ABORT,'execution must precede command'); END;",
        )
        .unwrap();
        let first = serde_json::to_string("i\0root").unwrap();
        let value =
            "[\"page\",\"retained-sequence\",{}, {\"at\":\"retained-stamp\"}]".replace(", {", ",{");
        let page = format!(
            "{}\n{value}",
            json!({"p":[0],"s":["i\0root"],"d":[value.encode_utf16().count()]})
        );
        records
            .execute("INSERT INTO record_keys_runs VALUES(1,1,1,?,0,1)", [&first])
            .unwrap();
        records
            .execute(
                "INSERT INTO record_keys_run_1 VALUES(0,?,?)",
                rusqlite::params![first, page],
            )
            .unwrap();
        drop(records);

        let mut entries = vec![
            json!({"binding":"ACCOUNT_CONTROL","originalId":"c".repeat(64),"names":[format!("policy:{OWNER}")],"sqlite":"policy.sqlite"}),
            json!({"binding":"RECORD_BOOK","originalId":"d".repeat(64),"names":[format!("own-record-resource:{}", serde_json::to_string(&[OWNER, "@own-records"]).unwrap())],"sqlite":"records.sqlite"}),
        ];
        for (resource, file, original) in [
            ("@own-records", "own.sqlite", "e"),
            ("@sign-in-use", "use.sqlite", "f"),
        ] {
            let db = Connection::open(root.join(file)).unwrap();
            db.execute_batch("CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE account_control_state(singleton INTEGER PRIMARY KEY,epoch INTEGER NOT NULL,state_json TEXT NOT NULL,updating_id TEXT); CREATE TABLE account_control_usage(key TEXT PRIMARY KEY,at_ms INTEGER)")
                .unwrap();
            directory(
                &db,
                "identity",
                json!({"owner":OWNER,"sign_in":signin,"resource":resource}),
            );
            db.execute(
                "INSERT INTO account_control_state VALUES(1,7,?,NULL)",
                [json!({"epoch":7,"lifecycle":{},"sign_ins":{signin.clone():row}}).to_string()],
            )
            .unwrap();
            if resource == "@sign-in-use" {
                db.execute(
                    "INSERT INTO account_control_usage VALUES(?,?)",
                    rusqlite::params![format!("sign-in:{signin}"), i64::try_from(now).unwrap()],
                )
                .unwrap();
            }
            drop(db);
            entries.push(json!({"binding":"ACCOUNT_CONTROL","originalId":original.repeat(64),"names":[gate_name(&signin, resource)],"sqlite":file}));
        }
        let index = entries
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(root.join("objects.jsonl"), &index).unwrap();
        let receipt_value = json!({"complete":true,"account":{"userId":"synthetic-user","ownerId":OWNER},"objects":{"path":"objects.jsonl","bytes":index.len(),"fileIdentity":blake3::hash(index.as_bytes()).to_hex().as_str(),"count":entries.len()}});
        let receipt_bytes = serde_json::to_vec(&receipt_value).unwrap();
        fs::write(root.join("restore-receipt.json"), &receipt_bytes).unwrap();
        let receipt = FilePin {
            bytes: receipt_bytes.len() as u64,
            blake3: blake3::hash(&receipt_bytes).to_hex().to_string(),
        };
        Self {
            _temporary: temporary,
            root,
            receipt,
            token,
            signin,
        }
    }

    fn new_with_oauth_grant() -> Self {
        let mut fixture = Self::new();
        fixture.prefill_oauth_grant_sources();
        fixture.prepare_current_own_records();
        fixture
    }

    /// Current consumers enter through the real first-start migration. Keep
    /// new() as the historical input fixture for migration/source controls.
    fn prepare_current_own_records(&self) {
        if crate::local_account::own_records::OwnRecords::source_ready(
            &self.root.join("records.sqlite"), OWNER, crate::sqlite_work::WorkMeter::new(),
        ).unwrap() {
            return;
        }
        let session = blake3::hash("b".repeat(64).as_bytes()).to_hex().to_string();
        let path = self.root.join("storage/kv/trillion-local-app/blobs/aa");
        let mut browser: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if browser["browser_generation"] != 1 {
            browser["created_at"] = json!(iso(millis() - 60_000));
            browser["browser_generation"] = json!(1);
            browser["method"] = json!("unknown");
            fs::write(&path, browser.to_string()).unwrap();
        }
        let policy = Connection::open(self.root.join("policy.sqlite")).unwrap();
        let text: String = policy.query_row(
            "SELECT value FROM policy_directory WHERE name='policy-source:account'", [],
            |row| row.get(0),
        ).unwrap();
        let mut account: Value = serde_json::from_str(&text).unwrap();
        if account["lifecycle"]["browser_session_generation"] != 1 {
            account["lifecycle"]["browser_session_generation"] = json!(1);
            directory(&policy, "policy-source:account", account);
        }
        drop(policy);
        let mut selected = self.selected();
        while selected.own_records_step(&session, Arc::new(AtomicBool::new(false))).unwrap()
            != crate::local_account::own_records::Step::Ready {}
    }

    fn prefill_oauth_grant_sources(&mut self) {
        self.prefill_named_oauth_grant_sources("grant:synthetic-oauth-grant", "oauth", "1", "2");
    }

    fn prefill_named_oauth_grant_sources(&mut self, grant: &str, prefix: &str, own_id: &str, use_id: &str) {
        let now = millis();
        let row = json!({
            "made":{"private":true,"spaces":"all"},
            "ceiling":{"private":true,"spaces":"all"},
            "chosen":null,
            "last_used":iso(now)
        });

        // The account policy directory, per-resource gate DB identities and
        // object index all name this exact OAuth sign-in. These use the same
        // retained source shapes as the personal-key fixture and are fully
        // enrolled before the selected descriptor is pinned.
        let policy = Connection::open(self.root.join("policy.sqlite")).unwrap();
        directory(&policy, &format!("policy-source:sign-in:{grant}"), row.clone());
        drop(policy);

        let mut entries = fs::read_to_string(self.root.join("objects.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        for (resource, file, original) in [
            ("@own-records", format!("{prefix}-own.sqlite"), own_id),
            ("@sign-in-use", format!("{prefix}-use.sqlite"), use_id),
        ] {
            let db = Connection::open(self.root.join(&file)).unwrap();
            db.execute_batch("CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE account_control_state(singleton INTEGER PRIMARY KEY,epoch INTEGER NOT NULL,state_json TEXT NOT NULL,updating_id TEXT); CREATE TABLE account_control_usage(key TEXT PRIMARY KEY,at_ms INTEGER)")
                .unwrap();
            directory(
                &db,
                "identity",
                json!({"owner":OWNER,"sign_in":grant,"resource":resource}),
            );
            db.execute(
                "INSERT INTO account_control_state VALUES(1,7,?,NULL)",
                [json!({"epoch":7,"lifecycle":{},"sign_ins":{grant:row.clone()}}).to_string()],
            )
            .unwrap();
            if resource == "@sign-in-use" {
                db.execute(
                    "INSERT INTO account_control_usage VALUES(?,?)",
                    rusqlite::params![format!("sign-in:{grant}"), i64::try_from(now).unwrap()],
                )
                .unwrap();
            }
            drop(db);
            entries.push(json!({
                "binding":"ACCOUNT_CONTROL",
                "originalId":original.repeat(64),
                "names":[gate_name(grant, resource)],
                "sqlite":file
            }));
        }
        let index = entries.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        fs::write(self.root.join("objects.jsonl"), &index).unwrap();
        let receipt_value = json!({
            "complete":true,
            "account":{"userId":"synthetic-user","ownerId":OWNER},
            "objects":{"path":"objects.jsonl","bytes":index.len(),
                "fileIdentity":blake3::hash(index.as_bytes()).to_hex().as_str(),
                "count":entries.len()}
        });
        let receipt_bytes = serde_json::to_vec(&receipt_value).unwrap();
        fs::write(self.root.join("restore-receipt.json"), &receipt_bytes).unwrap();
        self.receipt = FilePin {
            bytes: receipt_bytes.len() as u64,
            blake3: blake3::hash(&receipt_bytes).to_hex().to_string(),
        };
    }

    fn principal(&self) -> Principal {
        Principal {
            account_id: OWNER.into(),
            sign_in: self.signin.clone(),
            client_id: "synthetic-selected-write-client".into(),
        }
    }

    fn selected(&self) -> crate::native_boot::SelectedAccount {
        self.selected_at("127.0.0.1:28788".parse().unwrap())
    }

    fn selected_at(&self, address: std::net::SocketAddr) -> crate::native_boot::SelectedAccount {
        let rules_value = json!({"most_days":90,"idle_days_by_approval":{"unknown":7,"key":90},"use_noted_every_seconds":3600});
        let rules = pinned_data(&self.root, "rules.json", rules_value.clone());
        let reveal = pinned_data(
            &self.root,
            "reveal.json",
            json!({"reveal_window_minutes":10,"legacy_scrub_days":7}),
        );
        let inputs = pinned_data(&self.root, "inputs.json", json!({}));
        let first = pinned_data(&self.root, "first.json", json!({}));
        let profile = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/icu-collation/profile.json");
        let locale_path = self.root.join("tool-label-locale.json");
        fs::copy(profile, &locale_path).unwrap();
        let locale_bytes = fs::read(&locale_path).unwrap();
        let locale = json!({"path":locale_path,"pin":{"bytes":locale_bytes.len(),"blake3":blake3::hash(&locale_bytes).to_hex().as_str()}});
        let descriptor = self.root.join("adoption.json");
        let source = json!({
            "version":"trillion.local-runtime-adoption/v1",
            "state":self.root,
            "receipt_identity":self.receipt.blake3,
            "port":address.port(),
            "native":{
                "version":"trillion.native-selection/v1",
                "receipt_bytes":self.receipt.bytes,
                "app_kv":{"sqlite":"storage/kv/trillion-local-app/current.sqlite","namespace":"trillion-local-app"},
                "prior_processes":[],
                "sign_in_rules":rules,"reveal_policy":reveal,"root_source":null,
                "frontend":{
                    "root":self.root,
                    "manifest_identity":"1".repeat(64),
                    "tree_identity":"2".repeat(64),
                    "module_manifest_identity":"3".repeat(64),
                    "inputs":inputs,"first_answers":first,
                    "tool_label_locale":locale
                }
            }
        });
        let carried = carried_selection::write_selection(&descriptor, &source);
        let selection = crate::native_boot::Selection::from_descriptor(
            &descriptor,
            &carried,
            &self.root,
            address,
        )
        .unwrap();
        let local = LocalAccount::open_selected_after_handoff(
            SelectedLocalState {
                root: self.root.clone(),
                receipt: self.receipt.clone(),
                app_kv_sqlite: "storage/kv/trillion-local-app/current.sqlite".into(),
                app_kv_store: "trillion-local-app".into(),
                prior_processes: vec![],
            },
            crate::account::SignInRules::from_source_json(&rules_value).unwrap(),
        )
        .unwrap();
        crate::native_boot::SelectedAccount::new(local, selection).unwrap()
    }
}

struct Ids(u16);
impl LogIds for Ids {
    fn next_log_id(&mut self) -> Option<String> {
        self.0 += 1;
        Some(format!("01234567-89ab-7{:03x}-8f01-000000000001", self.0))
    }
}

fn route() -> Route {
    Route {
        account_id: OWNER.into(),
        device_id: "synthetic-selected-device".into(),
        resource_address: "@own-records".into(),
        generation: "synthetic-route-generation".into(),
    }
}

fn input() -> Value {
    json!({"writes":[{"address_label":"saved-board","payload":{"items":["written"]}}],"conflict_policy":"retry"})
}

fn operation(key: &str, input: Value) -> Operation {
    Operation { person_present: None,
        resource: "@own-records".into(),
        operation: "workspace:write".into(),
        request_key: key.into(),
        input,
    }
}

fn request(key: &str) -> Request {
    Request {
        key: key.into(),
        sent_at_ms: 1_790_000_000_000,
    }
}

fn context(request: &Request) -> Context {
    Context {
        actor: json!({"untrusted":"selected-workspace-write-control"}),
        application_time: "2026-10-27T00:00:00.000Z".into(),
        system_time: "2026-10-27T00:00:00.000Z".into(),
        accepted_at_ms: request.sent_at_ms,
    }
}

fn execute(
    owner: &mut crate::native_boot::SelectedAccount,
    fixture: &Fixture,
    principal: &Principal,
    route: &Route,
    call: &Operation,
    request: &Request,
    ids: &mut dyn LogIds,
) -> record_writer::Result<NativeCommandResult> {
    let mut witness = owner
        .authorize_personal_mcp_call(fixture.token.as_bytes(), principal, route, call)
        .map_err(|_| trillion_local::cause!(record_writer::Error::Refused))?;
    let locale = witness
        .selection
        .selected_tool_label_locale()
        .map_err(|_| trillion_local::cause!(record_writer::Error::Source))?
        .ok_or(trillion_local::cause!(record_writer::Error::Source))?;
    witness.execute_workspace_write(
        &locale,
        request,
        &context(request),
        Arc::new(AtomicBool::new(false)),
        Instant::now() + Duration::from_secs(10),
        ids,
    )
}

fn state(fixture: &Fixture) -> (String, i64, i64) {
    let db = Connection::open(fixture.root.join("records.sqlite")).unwrap();
    let board = db
        .query_row(
            "SELECT value FROM workspace_records WHERE label='saved-board'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let log = db
        .query_row("SELECT COUNT(*) FROM record_log", [], |row| row.get(0))
        .unwrap();
    let commands = db
        .query_row(
            "SELECT COUNT(*) FROM resource_behavior_commands",
            [],
            |row| row.get(0),
        )
        .unwrap();
    (board, log, commands)
}

/// Read the actual record store workspace, envelope versions and committed command
/// records. OAuth/current-connection controls opt in explicitly; historical
/// controls above retain their original-table observer.
fn current_state(fixture: &Fixture) -> (String, i64, i64) {
    use crate::records::Records;
    let path = fixture.root.join("records.sqlite");
    let store = crate::storage::record_store_resources::open(&path, crate::sqlite_work::WorkMeter::new()).unwrap();
    let workspace = crate::workspace_store::resource().unwrap();
    let board = store.get(OWNER, workspace, "saved-board").unwrap().record.unwrap()
        .value.as_str().unwrap().to_owned();
    drop(store);
    let db = Connection::open(path).unwrap();
    let versions = db.query_row(
        "SELECT count(*) FROM versions WHERE account=? AND resource=?",
        [OWNER, crate::local_account::own_records::RESOURCE], |row| row.get(0),
    ).unwrap();
    let commands = db.query_row(
        "SELECT count(*) FROM versions WHERE account=? AND resource=? AND valid_to=?",
        rusqlite::params![OWNER, crate::local_account::own_records::COMMANDS, crate::storage::record_store::CURRENT], |row| row.get(0),
    ).unwrap();
    (board, versions, commands)
}

#[test]
fn selected_writer_commits_once_and_fresh_same_key_retry_returns_saved_result() {
    let fixture = Fixture::new();
    let mut owner = fixture.selected();
    let principal = fixture.principal();
    let route = route();
    let call = operation(REQUEST_KEY, input());
    let request = request(REQUEST_KEY);
    let mut ids = Ids(0);
    let first = execute(
        &mut owner, &fixture, &principal, &route, &call, &request, &mut ids,
    )
    .expect("selected original workspace write");
    assert!(!first.duplicate);
    assert_eq!(
        first.value,
        ecma_json::parse(br#"{"written":1}"#, Default::default()).unwrap()
    );
    let after_first = state(&fixture);
    assert!(after_first.0.contains("written"));
    assert!(
        after_first.1 > 0,
        "the original record log contains the committed write"
    );
    assert_eq!(after_first.2, 1);

    drop(owner);
    let mut fresh_owner = fixture.selected();
    let mut another_connection = route.clone();
    another_connection.generation = "another-carrier-label-same-original-workspace".into();
    let retry = execute(
        &mut fresh_owner,
        &fixture,
        &principal,
        &another_connection,
        &call,
        &request,
        &mut ids,
    )
    .expect("fresh selected witness for retry");
    assert!(retry.duplicate);
    assert_eq!(retry.value, first.value);
    assert_eq!(state(&fixture), after_first);
    let raw: String = Connection::open(fixture.root.join("records.sqlite"))
        .unwrap()
        .query_row("SELECT context FROM resource_behavior_commands", [], |r| {
            r.get(0)
        })
        .unwrap();
    let kept: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(kept["generation"], json!(1));
}

#[test]
fn explicit_null_expected_identity_preserves_existing_workspace_value() {
    let fixture = Fixture::new();
    let before = state(&fixture);
    let mut owner = fixture.selected();
    let principal = fixture.principal();
    let route = route();
    let mut conditional = input();
    conditional["writes"][0]["expected_identity"] = Value::Null;
    let call = operation("selected-null-is-absence", conditional);
    let request = request("selected-null-is-absence");
    let mut ids = Ids(0);
    let result = execute(
        &mut owner, &fixture, &principal, &route, &call, &request, &mut ids,
    )
    .expect("original conditional result");
    let encoded = ecma_json::stringify(&result.value, Default::default()).unwrap();
    assert!(encoded.contains("conflicts"));
    let after = state(&fixture);
    assert_eq!(after.0, before.0);
    assert_eq!(
        after.2, 1,
        "one original committed command, with no workspace overwrite"
    );
}

#[test]
fn producer_rejects_mismatched_request_before_record_or_journal_effects() {
    let fixture = Fixture::new();
    let mut owner = fixture.selected();
    let principal = fixture.principal();
    let route = route();
    let call = operation(REQUEST_KEY, input());
    let wrong_request = request("substituted-key");
    let before = state(&fixture);
    let mut ids = Ids(0);
    let result = execute(
        &mut owner,
        &fixture,
        &principal,
        &route,
        &call,
        &wrong_request,
        &mut ids,
    );
    assert!(matches!(result, Err(record_writer::Error::Invalid(_))));
    assert_eq!(state(&fixture), before);
    assert_eq!(ids.0, 0);
}

#[test]
fn producer_rejects_malformed_input_before_record_or_journal_effects() {
    let fixture = Fixture::new();
    let mut owner = fixture.selected();
    let principal = fixture.principal();
    let route = route();
    let call = operation(REQUEST_KEY, json!({"writes":[]}));
    let request = request(REQUEST_KEY);
    let before = state(&fixture);
    let mut ids = Ids(0);
    let result = execute(
        &mut owner, &fixture, &principal, &route, &call, &request, &mut ids,
    );
    assert!(matches!(result, Err(record_writer::Error::Invalid(_))));
    assert_eq!(state(&fixture), before);
    assert_eq!(ids.0, 0);
}

fn local_http_request(
    fixture: &Fixture,
    key: &str,
    protocol: &str,
) -> axum::http::Request<axum::body::Body> {
    local_http_request_for_input(fixture, key, protocol, input())
}
fn local_http_request_for_input(
    fixture: &Fixture,
    key: &str,
    protocol: &str,
    input: Value,
) -> axum::http::Request<axum::body::Body> {
    let mut body = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_resource_operation",
        "arguments":{"address":"@own-records","method":"workspace:write","request_key":key,"input":input}}});
    if protocol >= "2026-07-28" {
        body["params"]["_meta"] = json!({
            "io.modelcontextprotocol/protocolVersion":protocol,
            "io.modelcontextprotocol/clientInfo":{"name":"isolated-original-consumer","version":"1"},
            "io.modelcontextprotocol/clientCapabilities":{}
        });
    }
    axum::http::Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("Host", "127.0.0.1:28788")
        .header("Authorization", format!("Bearer {}", fixture.token))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", protocol)
        .header("Mcp-Method", "tools/call")
        .header("Mcp-Name", "run_resource_operation")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

fn local_read_http_request(
    fixture: &Fixture,
    key: &str,
    client: &str,
    resource: &str,
) -> axum::http::Request<axum::body::Body> {
    local_read_http_request_for_protocol(fixture, key, client, resource, "2026-07-28")
}

fn local_read_http_request_for_protocol(
    fixture: &Fixture,
    key: &str,
    client: &str,
    resource: &str,
    protocol: &str,
) -> axum::http::Request<axum::body::Body> {
    let body = json!({
        "jsonrpc":"2.0",
        "id":"second-ai-readback",
        "method":"tools/call",
        "params":{
            "name":"run_resource_operation",
            "arguments":{
                "address":resource,
                "method":"workspace:read",
                "request_key":key,
                "input":{}
            }
        }
    });
    let mut body = body;
    if protocol >= "2026-07-28" {
        body["params"]["_meta"] = json!({
            "io.modelcontextprotocol/protocolVersion":protocol,
            "io.modelcontextprotocol/clientInfo":{"name":client,"version":"1"},
            "io.modelcontextprotocol/clientCapabilities":{}
        });
    }
    axum::http::Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("Host", "127.0.0.1:28788")
        .header("Authorization", format!("Bearer {}", fixture.token))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", protocol)
        .header("Mcp-Method", "tools/call")
        .header("Mcp-Name", "run_resource_operation")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

fn change_gate(fixture: &Fixture, file: &str, update: impl FnOnce(&mut Value)) {
    let db = Connection::open(fixture.root.join(file)).unwrap();
    let raw: String = db
        .query_row(
            "SELECT state_json FROM account_control_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut state: Value = serde_json::from_str(&raw).unwrap();
    update(&mut state);
    db.execute(
        "UPDATE account_control_state SET state_json=? WHERE singleton=1",
        [state.to_string()],
    )
    .unwrap();
}

#[tokio::test]
async fn actual_local_mcp_write_then_second_client_reads_the_same_saved_record() {
    use std::sync::Mutex;
    use tower::ServiceExt;

    for protocol in ["2025-06-18", "2026-07-28"] {
        let fixture = Fixture::new();
        let app = crate::native_boot::mcp_local::route_table(
            Arc::new(Mutex::new(fixture.selected())),
            "127.0.0.1:28788".into(),
        )
        .unwrap();
        let write = app
            .clone()
            .oneshot(local_http_request(&fixture, "same-record-write", protocol))
            .await
            .unwrap();
        assert_eq!(write.status(), axum::http::StatusCode::OK, "{protocol}");
        let write_bytes = axum::body::to_bytes(write.into_body(), 65_536)
            .await
            .unwrap();
        let write_reply: Value = serde_json::from_slice(&write_bytes).unwrap();
        assert_eq!(write_reply["result"]["structuredContent"]["written"], 1);
        let committed = state(&fixture);
        assert!(committed.1 > 0);
        assert_eq!(committed.2, 1);

        let read = app
            .clone()
            .oneshot(local_read_http_request_for_protocol(
                &fixture,
                "same-record-read",
                "synthetic-second-ai",
                "@own-records",
                protocol,
            ))
            .await
            .unwrap();
        assert_eq!(read.status(), axum::http::StatusCode::OK, "{protocol}");
        let (read_parts, read_body) = read.into_parts();
        assert!(!read_parts.headers.contains_key(axum::http::header::CONTENT_LENGTH));
        let hint = http_body::Body::size_hint(&read_body);
        assert_eq!(hint.lower(), 0);
        assert!(hint.upper().is_none(), "length waits for the final source check");
        let read_bytes = axum::body::to_bytes(read_body, 65_536)
            .await
            .unwrap();
        let read_reply: Value = serde_json::from_slice(&read_bytes).unwrap();
        assert_eq!(read_reply["id"], "second-ai-readback");
        let structured = &read_reply["result"]["structuredContent"];
        assert_eq!(structured["status"], 200);
        assert_eq!(structured["content_type"], "application/json; charset=utf-8");
        assert_eq!(structured["request_key"], "same-record-read");
        let canonical = serde_json::from_str::<Value>(structured["text"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            canonical["records"]["saved-board"],
            json!({"items":["written"]})
        );
        assert!(!String::from_utf8_lossy(&read_bytes).contains(&fixture.token));
        assert_eq!(state(&fixture), committed, "the read adds no second record or journal row");
    }
}

#[tokio::test]
async fn actual_local_mcp_read_preserves_stored_lone_surrogate_through_canonical_wrapper() {
    use std::sync::Mutex;
    use tower::ServiceExt;

    let escaped_surrogate = r#"{"items":["\ud800"]}"#;
    assert!(serde_json::from_str::<Value>(escaped_surrogate).is_err());
    let ecma = crate::ecma_json::parse(escaped_surrogate.as_bytes(), Default::default()).unwrap();
    let crate::ecma_json::Value::Object(root) = ecma else {
        panic!("stored projection must be an object")
    };
    let crate::ecma_json::Value::Array(items) = root
        .get(&crate::ecma_json::JsString::from("items"))
        .unwrap()
    else {
        panic!("stored projection items must be an array")
    };
    let crate::ecma_json::Value::String(value) = &items[0] else {
        panic!("stored projection item must be an ECMAScript string")
    };
    assert_eq!(value.units(), &[0xd800]);

    for protocol in ["2025-06-18", "2026-07-28"] {
        let fixture = Fixture::new();
        let records = Connection::open(fixture.root.join("records.sqlite")).unwrap();
        records
            .execute(
                "UPDATE workspace_records SET value=? WHERE label='saved-board'",
                [escaped_surrogate],
            )
            .unwrap();
        drop(records);
        let before = state(&fixture);
        let app = crate::native_boot::mcp_local::route_table(
            Arc::new(Mutex::new(fixture.selected())),
            "127.0.0.1:28788".into(),
        )
        .unwrap();
        let response = app
            .oneshot(local_read_http_request_for_protocol(
                &fixture,
                "surrogate-read-key",
                "surrogate-client",
                "@own-records",
                protocol,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{protocol}");
        let (parts, body) = response.into_parts();
        assert!(!parts.headers.contains_key(axum::http::header::CONTENT_LENGTH));
        let read_bytes = axum::body::to_bytes(body, 65_536).await.unwrap();
        let reply: Value = serde_json::from_slice(&read_bytes).unwrap();
        let structured = &reply["result"]["structuredContent"];
        assert_eq!(structured["status"], 200, "{protocol}");
        assert_eq!(structured["content_type"], "application/json; charset=utf-8");
        assert_eq!(structured["request_key"], "surrogate-read-key");
        let canonical = structured["text"].as_str().unwrap();
        assert!(canonical.contains(r#""\ud800""#), "{protocol}");
        assert!(serde_json::from_str::<Value>(canonical).is_err(), "{protocol}");
        let parsed = crate::ecma_json::parse(canonical.as_bytes(), Default::default()).unwrap();
        let crate::ecma_json::Value::Object(root) = parsed else {
            panic!("canonical workspace answer must be an object")
        };
        let crate::ecma_json::Value::Object(records) = root
            .get(&crate::ecma_json::JsString::from("records"))
            .unwrap()
        else {
            panic!("canonical answer records must be an object")
        };
        let crate::ecma_json::Value::Object(board) = records
            .get(&crate::ecma_json::JsString::from("saved-board"))
            .unwrap()
        else {
            panic!("canonical saved board must be an object")
        };
        let crate::ecma_json::Value::Array(items) = board
            .get(&crate::ecma_json::JsString::from("items"))
            .unwrap()
        else {
            panic!("canonical board items must be an array")
        };
        let crate::ecma_json::Value::String(value) = &items[0] else {
            panic!("canonical board item must be a string")
        };
        assert_eq!(value.units(), &[0xd800], "{protocol}");
        assert_eq!(state(&fixture), before, "read must not write records or journal rows");
    }
}

#[tokio::test]
async fn actual_local_mcp_read_rejects_wrong_resource_and_late_source_rights_changes() {
    use std::sync::Mutex;
    use tower::ServiceExt;

    let fixture = Fixture::new();
    let app = crate::native_boot::mcp_local::route_table(
        Arc::new(Mutex::new(fixture.selected())),
        "127.0.0.1:28788".into(),
    )
    .unwrap();
    let wrong = app
        .clone()
        .oneshot(local_read_http_request(
            &fixture,
            "wrong-resource-read",
            "synthetic-second-ai",
            "@other-records",
        ))
        .await
        .unwrap();
    let wrong_bytes = axum::body::to_bytes(wrong.into_body(), 65_536)
        .await
        .unwrap();
    let wrong_reply: Value = serde_json::from_slice(&wrong_bytes).unwrap();
    assert_eq!(wrong_reply["result"]["isError"], true);
    assert!(!String::from_utf8_lossy(&wrong_bytes).contains("saved-board"));

    for withdrawal in ["projection", "key", "usage", "private-reach"] {
        let fixture = Fixture::new();
        let app = crate::native_boot::mcp_local::route_table(
            Arc::new(Mutex::new(fixture.selected())),
            "127.0.0.1:28788".into(),
        )
        .unwrap();
        let response = app
            .clone()
            .oneshot(local_read_http_request(
                &fixture,
                "late-withdrawal-read",
                "synthetic-second-ai",
                "@own-records",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{withdrawal}");
        let (parts, mut body) = response.into_parts();
        assert!(!parts.headers.contains_key(axum::http::header::CONTENT_LENGTH));
        let before = http_body::Body::size_hint(&body);
        assert_eq!(before.lower(), 0, "{withdrawal}");
        assert!(before.upper().is_none(), "{withdrawal}");
        match withdrawal {
            "projection" => {
                Connection::open(fixture.root.join("records.sqlite"))
                    .unwrap()
                    .execute(
                        "UPDATE workspace_records SET value='false' WHERE label='saved-board'",
                        [],
                    )
                    .unwrap();
            }
            "key" => {
                let digest = SecretNativeKey::parse(&fixture.token).unwrap().identity();
                Connection::open(fixture.root.join("storage/kv/trillion-local-app/current.sqlite"))
                    .unwrap()
                    .execute(
                        "DELETE FROM _mf_entries WHERE key=?",
                        [format!("personal-key:{digest}")],
                    )
                    .unwrap();
            }
            "usage" => change_gate(&fixture, "use.sqlite", |state| {
                state["sign_ins"][&fixture.signin]["ended_until_ms"] = json!(millis() + 60_000)
            }),
            "private-reach" => change_gate(&fixture, "own.sqlite", |state| {
                state["sign_ins"][&fixture.signin]["chosen"] =
                    json!({"private":false,"spaces":["team"]})
            }),
            _ => unreachable!(),
        }
        let chunk = std::future::poll_fn(|cx| {
            http_body::Body::poll_frame(std::pin::Pin::new(&mut body), cx)
        })
        .await;
        assert!(matches!(chunk, Some(Err(_))), "{withdrawal}");
        let after = http_body::Body::size_hint(&body);
        assert_eq!(after.lower(), 0, "{withdrawal}");
        assert!(after.upper().is_none(), "{withdrawal}");
    }
}

#[tokio::test]
async fn actual_local_sdk_commit_lost_reply_and_cold_legacy_retry_share_one_original_journal() {
    use std::sync::Mutex;
    use tower::ServiceExt;
    let fixture = Fixture::new();
    let app = crate::native_boot::mcp_local::route_table(
        Arc::new(Mutex::new(fixture.selected())),
        "127.0.0.1:28788".into(),
    )
    .unwrap();
    let response = app
        .clone()
        .oneshot(local_http_request(
            &fixture,
            "actual-sdk-lost-reply",
            "2026-07-28",
        ))
        .await
        .unwrap();
    if response.status() != axum::http::StatusCode::OK {
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 65536)
            .await
            .unwrap();
        panic!(
            "local SDK refusal {status}: {}",
            String::from_utf8_lossy(&body)
        );
    }
    // Discard the accepted response without reading its result.
    drop(response);
    let committed = state(&fixture);
    assert_eq!(committed.2, 1);
    assert!(committed.0.contains("written"));
    drop(app);
    let cold = crate::native_boot::mcp_local::route_table(
        Arc::new(Mutex::new(fixture.selected())),
        "127.0.0.1:28788".into(),
    )
    .unwrap();
    let response = cold
        .oneshot(local_http_request(
            &fixture,
            "actual-sdk-lost-reply",
            "2025-06-18",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .unwrap();
    let reply: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(reply["result"]["structuredContent"]["written"], 1);
    assert_eq!(state(&fixture), committed);
}

#[tokio::test]
async fn actual_local_sdk_scoped_key_does_not_get_private_workspace_rights() {
    use std::sync::Mutex;
    use tower::ServiceExt;
    let fixture = Fixture::new();
    let app = crate::native_boot::mcp_local::route_table(
        Arc::new(Mutex::new(fixture.selected())),
        "127.0.0.1:28788".into(),
    )
    .unwrap();
    let path = fixture.root.join("storage/kv/trillion-local-app/blobs/bb");
    let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["reach"] = json!({"private":false,"spaces":["synthetic-team"]});
    record["ceiling"] = record["reach"].clone();
    fs::write(path, record.to_string()).unwrap();
    let before = state(&fixture);
    let response = app
        .oneshot(local_http_request(
            &fixture,
            "actual-sdk-scoped-refusal",
            "2026-07-28",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .unwrap();
    let reply: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(reply["result"]["isError"], true);
    assert_eq!(state(&fixture), before);
}

#[tokio::test]
async fn actual_local_sdk_final_source_permit_withholds_old_workspace_words() {
    use std::sync::Mutex;
    use tower::ServiceExt;
    let fixture = Fixture::new();
    let app = crate::native_boot::mcp_local::route_table(
        Arc::new(Mutex::new(fixture.selected())),
        "127.0.0.1:28788".into(),
    )
    .unwrap();
    let mut conditional = input();
    conditional["writes"][0]["expected_identity"] = Value::Null;
    let request = || {
        local_http_request_for_input(
            &fixture,
            "actual-sdk-final-source",
            "2026-07-28",
            conditional.clone(),
        )
    };
    let response = app.clone().oneshot(request()).await.unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .unwrap();
    let initial = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(
        initial.contains("kept"),
        "positive source-bearing output control"
    );
    Connection::open(fixture.root.join("records.sqlite"))
        .unwrap()
        .execute(
            "UPDATE workspace_records SET value=? WHERE label='saved-board'",
            [r#"{"items":["replacement"]}"#],
        )
        .unwrap();
    let changed = state(&fixture);
    let response = app.oneshot(request()).await.unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .unwrap();
    let reply: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(reply["result"]["isError"], true);
    assert!(!String::from_utf8(bytes.to_vec()).unwrap().contains("kept"));
    assert_eq!(
        state(&fixture),
        changed,
        "withheld committed result never redispatches"
    );
}

#[tokio::test]
async fn actual_local_sdk_key_withdrawal_and_source_replacement_never_replay() {
    use std::sync::Mutex;
    use tower::ServiceExt;
    let fixture = Fixture::new();
    let app = crate::native_boot::mcp_local::route_table(
        Arc::new(Mutex::new(fixture.selected())),
        "127.0.0.1:28788".into(),
    )
    .unwrap();
    let response = app
        .clone()
        .oneshot(local_http_request(
            &fixture,
            "actual-sdk-withdrawal",
            "2026-07-28",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let committed = state(&fixture);
    assert_eq!(committed.2, 1);
    let kv = Connection::open(
        fixture
            .root
            .join("storage/kv/trillion-local-app/current.sqlite"),
    )
    .unwrap();
    kv.execute(
        "DELETE FROM _mf_entries WHERE key LIKE 'personal-key:%'",
        [],
    )
    .unwrap();
    let response = app
        .clone()
        .oneshot(local_http_request(
            &fixture,
            "actual-sdk-withdrawal",
            "2026-07-28",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
    assert!(response.headers().contains_key("WWW-Authenticate"));
    assert_eq!(state(&fixture), committed);
    fs::write(
        fixture.root.join("restore-receipt.json"),
        b"replaced selected source",
    )
    .unwrap();
    let response = app
        .oneshot(local_http_request(
            &fixture,
            "actual-sdk-withdrawal",
            "2026-07-28",
        ))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(!response.headers().contains_key("WWW-Authenticate"));
    assert_eq!(state(&fixture), committed);
}

#[cfg(feature = "sql-statement-attribution")]
mod whole_mcp_read_cost {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/mcp_read_cost.rs"));
}


mod gate_preflight_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/mcp_gate_preflight.rs"));
}

mod current_key_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/mcp_current_key_controls.rs"));
}

mod mac_consumer_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/mcp_mac_consumer.rs"));
}

mod selected_connection_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/mcp_selected_connection.rs"));
}

mod connection_registration_controls {
 include!(concat!(env!("CARGO_MANIFEST_DIR"),"/tests/drafts/mcp_connection_registration.rs"));
}

mod write_result_custody_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/mcp_write_result_custody.rs"));
}

mod oauth_test_support {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/oauth_test_support.rs"));
}
mod oauth_records_consumer_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/oauth_records_consumer.rs"));
}
mod oauth_records_erasure_consumer_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/oauth_records_erasure_consumer.rs"));
}

mod oauth_workshop_consumer_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/oauth_workshop_consumer.rs"));
}
mod oauth_instruction_consumer_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/oauth_instruction_consumer.rs"));
}

mod oauth_read_consumer_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/oauth_read_consumer.rs"));
}
mod oauth_write_consumer_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/oauth_write_consumer.rs"));
}
mod oauth_parent_connection_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/oauth_parent_connection_consumer.rs"));
}
mod oauth_rmcp_client_consumer_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/oauth_rmcp_client_consumer.rs"));
}
mod oauth_independent_grants_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/oauth_independent_grants.rs"));
}
