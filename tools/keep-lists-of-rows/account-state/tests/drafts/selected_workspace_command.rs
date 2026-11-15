// Source controls for the unmounted selected-personal-key workspace writer.
//
// The fixture uses the existing LocalAccount restore receipt, account-policy
// directory, app KV entries and RECORD_BOOK address, with the old engine's
// record-log tables migrated once into the account's record store. A command
// writes its effect (the workspace store), its execution and sealed result
// (own records and their keys) and its command record to record store only, in its one
// transaction. It creates no browser WorkspaceSession.

use super::*;
use content_crypto::advanced::blake3;
use crate::{
    account::{AccountError, SecretNativeKey},
    ecma_json::{self, JsString, Value as EcmaValue},
    import::FilePin,
    local_account::{
        command_journal::CommandBinding, record_writer, LocalAccount, SelectedLocalState,
    },
    record_log::{Context, LogIds, Request},
    records::{Mutation, Records},
    storage::{
        record_store::{settings, RecordStore, RealClock},
        sqlite,
    },
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const RESOURCE: &str = "@own-records";
const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SIGN_IN_SECRET: &[u8] = b"SYNTHETIC_SELECTED_WORKSPACE_KEY";
const CURRENT: i64 = i64::MAX;

struct Fixture {
    // These fixtures intentionally share OWNER and its process-wide notifier.
    // Isolate their lifetimes; each test still runs its real concurrent actors.
    _owner_serial: std::sync::MutexGuard<'static, ()>,
    _temp: tempfile::TempDir,
    root: PathBuf,
    receipt_pin: FilePin,
    receipt_bytes: Vec<u8>,
    index_bytes: Vec<u8>,
    records: PathBuf,
    kv: PathBuf,
    key: SecretNativeKey,
    _window: TestWindow,
}

include!("../support/test_window.rs");

fn created_at() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_millis();
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(i64::try_from(millis).unwrap())
        .unwrap()
        .to_rfc3339()
}

impl Fixture {
    fn new() -> Self {
        static FIXTURE_OWNER: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let owner_serial = FIXTURE_OWNER.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        // The account's installed tools declare the record kinds these tests write.
        crate::record_model_policy::install_test_tools(&root);
        // A name of its own: the open sign-ins of this process are found by account name.
        let user = format!("synthetic-user-{}", temp.path().file_name().unwrap().to_string_lossy());
        // The window's session, opened by its verified sign-in token.
        let window = TestWindow::open(&user, OWNER);
        let session_id = window.session.clone();
        fs::write(root.join("browser-session.key"), &window.token).unwrap();
        fs::set_permissions(
            root.join("browser-session.key"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();

        let policy_path = root.join("policy.sqlite");
        let policy = Connection::open(&policy_path).unwrap();
        policy
            .execute_batch(
                "CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL);",
            )
            .unwrap();
        for (name, value) in [
            ("revision", json!(1)),
            ("policy-source", json!({"from":"born","missing":[]})),
            (
                "policy-source:account",
                json!({"lifecycle":{"browser_session_generation":1},"access":{},"account_controls":{"owner_user_id":user}}),
            ),
        ] {
            policy
                .execute(
                    "INSERT INTO policy_directory VALUES(?,?)",
                    [name, &value.to_string()],
                )
                .unwrap();
        }
        drop(policy);

        let kv_folder = root.join("storage/kv/trillion-local-app");
        fs::create_dir_all(kv_folder.join("blobs")).unwrap();
        let kv = kv_folder.join("current.sqlite");
        let key_text = format!("nm_{}", blake3::hash(SIGN_IN_SECRET).to_hex());
        let key = SecretNativeKey::parse(&key_text).unwrap();
        let key_created = created_at();
        let app_kv = Connection::open(&kv).unwrap();
        app_kv.execute_batch("CREATE TABLE _mf_entries(key TEXT PRIMARY KEY,blob_id TEXT NOT NULL,expiration INTEGER);").unwrap();
        for (entry, blob, value) in [
            (
                format!("session:{session_id}"),
                "aa",
                json!({"userId":user,"created_at":key_created,"browser_generation":1}),
            ),
            (
                format!("personal-key:{}", key.identity()),
                "bb",
                json!({"userId":user,"created_at":key_created}),
            ),
        ] {
            app_kv
                .execute(
                    "INSERT INTO _mf_entries(key,blob_id) VALUES(?,?)",
                    [&entry, blob],
                )
                .unwrap();
            fs::write(kv_folder.join("blobs").join(blob), value.to_string()).unwrap();
        }
        drop(app_kv);

        let records = root.join("records.sqlite");
        let db = Connection::open(&records).unwrap();
        db.execute_batch(
            "CREATE TABLE own_resource_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,resource TEXT NOT NULL,generation INTEGER NOT NULL,ready INTEGER NOT NULL);
             INSERT INTO own_resource_identity VALUES(1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','@own-records',1,1);",
        )
        .unwrap();
        drop(db);

        let index_path = root.join("objects.jsonl");
        let mut index = serde_json::to_vec(&json!({
            "binding":"ACCOUNT_CONTROL",
            "originalId":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "names":[format!("policy:{OWNER}")],
            "sqlite":"policy.sqlite"
        }))
        .unwrap();
        index.push(b'\n');
        let record_address = format!(
            "own-record-resource:{}",
            serde_json::to_string(&[OWNER, RESOURCE]).unwrap()
        );
        index.extend(
            serde_json::to_vec(&json!({
                "binding":"RECORD_BOOK",
                "originalId":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                "names":[record_address],
                "sqlite":"records.sqlite"
            }))
            .unwrap(),
        );
        fs::write(&index_path, &index).unwrap();
        let receipt = serde_json::to_vec(&json!({
            "complete":true,
            "account":{"userId":user,"ownerId":OWNER},
            "objects":{
                "path":"objects.jsonl",
                "bytes":index.len(),
                "fileIdentity":blake3::hash(&index).to_hex().as_str(),
                "count":2
            }
        }))
        .unwrap();
        fs::write(root.join("restore-receipt.json"), &receipt).unwrap();
        let receipt_pin = FilePin {
            bytes: receipt.len() as u64,
            blake3: blake3::hash(&receipt).to_hex().to_string(),
        };

        Self {
            _temp: temp,
            root,
            receipt_pin,
            receipt_bytes: receipt,
            index_bytes: index,
            records,
            kv,
            key,
            _owner_serial: owner_serial,
            _window: window,
        }
    }

    fn open(&self) -> LocalAccount {
        let mut owner = LocalAccount::open_selected_after_handoff(
            SelectedLocalState {
                root: self.root.clone(),
                receipt: self.receipt_pin.clone(),
                app_kv_sqlite: "storage/kv/trillion-local-app/current.sqlite".into(),
                app_kv_store: "trillion-local-app".into(),
                prior_processes: vec![],
            },
        )
        .unwrap();
        // A command runs only on the migrated own records (record store); the startup task migrates before the app is served.
        let session = owner.session_identity().to_string();
        while owner.own_records_step(&session, Arc::new(AtomicBool::new(false))).unwrap()
            != crate::local_account::own_records::Step::Ready
        {}
        owner
    }

    fn assert_source_pin(&self) -> record_writer::Result<()> {
        let path = self.root.join("restore-receipt.json");
        let actual = fs::read(path).map_err(|_| trillion_local::cause!(record_writer::Error::Source))?;
        if actual != self.receipt_bytes
            || actual.len() as u64 != self.receipt_pin.bytes
            || blake3::hash(&actual).to_hex().as_str() != self.receipt_pin.blake3
        {
            return Err(trillion_local::cause!(record_writer::Error::Source));
        }
        let index =
            fs::read(self.root.join("objects.jsonl")).map_err(|_| trillion_local::cause!(record_writer::Error::Source))?;
        if index != self.index_bytes {
            return Err(trillion_local::cause!(record_writer::Error::Source));
        }
        Ok(())
    }

    /// Version rows (history included) of the account's own records, command records and field keys, and of its
    /// workspace store: any write adds one.
    fn counts(&self) -> (i64, i64, i64, i64) {
        let db = Connection::open(&self.records).unwrap();
        let rows = |resource: &str| -> i64 {
            db.query_row("SELECT COUNT(*) FROM versions WHERE resource=?", [resource], |r| r.get(0)).unwrap()
        };
        (
            rows("own-records"),
            rows("own-commands"),
            rows("own-record-keys"),
            rows(crate::workspace_store::resource().unwrap()),
        )
    }

    /// The old engine's tables the account keeps after its one migration: a command writes none of them.
    fn old_rows(&self) -> (i64, i64, i64) {
        let db = Connection::open(&self.records).unwrap();
        let rows = |table: &str| -> i64 {
            db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
        };
        (rows("record_log"), rows("resource_behavior_commands"), rows("record_erasable_keys"))
    }

    fn store(&self) -> RecordStore<sqlite::Supply<Connection>> {
        let bounds = sqlite::Bounds {
            value_bytes: 2 * 1024 * 1024,
            work: u64::MAX / 2,
            deadline: Duration::MAX,
            spend: sqlite::Spend::EachOperation,
            cancel: None,
            busy: Duration::from_secs(5),
        };
        let supply = sqlite::open_owned(&self.records, "record_store", bounds).unwrap();
        RecordStore::new(supply, Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap()
    }

    /// The current body of one record of one of the account's record store resources.
    fn current(&self, resource: &str, id: &str) -> Option<Value> {
        self.store().get(OWNER, resource, id).unwrap().record.map(|record| record.value)
    }

    /// Replace (or delete, for None) one current record of one of the account's record store resources, as another writer
    /// or a hostile one would.
    fn rewrite(&self, resource: &str, id: &str, next: Option<Value>) {
        let mut store = self.store();
        let (version, _) = store.held_record_with_version(OWNER, resource, id).unwrap();
        store
            .mutate(OWNER, resource, Mutation {
                id: id.into(),
                expected_version: version,
                request_key: format!("fixture-rewrite-{resource}-{id}-{version}"),
                deleted: next.is_none(),
                value: next.unwrap_or(Value::Null),
            })
            .unwrap();
    }

    /// The saved board's stored JSON text in the workspace store.
    fn board(&self) -> String {
        self.current(crate::workspace_store::resource().unwrap(), "saved-board")
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap()
    }

    fn set_board(&self, text: &str) {
        self.rewrite(crate::workspace_store::resource().unwrap(), "saved-board", Some(Value::String(text.into())));
    }

    fn add_original_command_tables(&self) {
        let db = Connection::open(&self.records).unwrap();
        db.execute_batch(
            "CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
             INSERT INTO record_keys_meta VALUES('engine','\"record-log\"');
             CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT);
             CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER);
             CREATE TABLE record_keys_big(ref TEXT,part INTEGER,body TEXT,PRIMARY KEY(ref,part)) WITHOUT ROWID;
             CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT NOT NULL);
             CREATE TABLE resource_behavior_commands(permit_id TEXT PRIMARY KEY,identity TEXT NOT NULL,operation TEXT NOT NULL,input TEXT NOT NULL,context TEXT NOT NULL,state TEXT NOT NULL,result TEXT,execution_ref TEXT);
             CREATE TABLE record_erasable_keys(record_id TEXT PRIMARY KEY,key BLOB,erased_at TEXT,erased_fields TEXT) WITHOUT ROWID;",
        )
        .unwrap();
        let key = "i\0root";
        let first = serde_json::to_string(key).unwrap();
        db.execute("INSERT INTO record_keys_runs VALUES(1,1,1,?,0,1)", [&first])
            .unwrap();
        let page = current_record_page("{}");
        db.execute(
            "INSERT INTO record_keys_run_1 VALUES(0,?,?)",
            params![first, page],
        )
        .unwrap();
    }

    /// Run on the migrated account (`open` migrates): a command record needs its execution record before it, and
    /// record store writes both in the command's one transaction, in that order.
    fn add_capture_order_check(&self) {
        Connection::open(&self.records).unwrap().execute_batch(&format!(
            "CREATE TRIGGER capture_before_command BEFORE INSERT ON versions
             WHEN NEW.resource='own-commands' AND NOT EXISTS(SELECT 1 FROM versions WHERE resource='own-records' AND id='execution:'||NEW.id AND valid_to={CURRENT})
             BEGIN SELECT RAISE(ABORT,'execution must precede command'); END;"
        ))
        .unwrap();
    }
}

fn current_record_page(value_json: &str) -> String {
    let value =
        format!("[\"page\",\"retained-sequence\",{value_json},{{\"at\":\"retained-stamp\"}}]");
    format!(
        "{}\n{value}",
        json!({"p":[0],"s":["i\0root"],"d":[value.encode_utf16().count()]})
    )
}

fn ecma(raw: &str) -> EcmaValue {
    ecma_json::parse(raw.as_bytes(), Default::default()).unwrap()
}

fn database_identity(value: &EcmaValue) -> String {
    crate::record_canonical::identity(
        value,
        Default::default(),
        &mut |left: &JsString, right: &JsString| Ok::<_, ()>(left.units().cmp(right.units())),
    )
    .unwrap()
}

fn input(label: &str, payload: Value, expected_identity: Option<&str>) -> EcmaValue {
    let expected = expected_identity
        .map(|identity| {
            format!(
                ",\"expected_identity\":{}",
                serde_json::to_string(identity).unwrap()
            )
        })
        .unwrap_or_default();
    ecma(&format!(
        "{{\"writes\":[{{\"address_label\":{},\"payload\":{}{} }}]}}",
        serde_json::to_string(label).unwrap(),
        payload,
        expected
    ))
}

fn binding(fixture: &Fixture, input: &EcmaValue, request_key: &str) -> CommandBinding {
    let sign_in = format!("key:{}", fixture.key.identity());
    let permit_parts = EcmaValue::Array(
        [OWNER, sign_in.as_str(), RESOURCE, request_key]
            .into_iter()
            .map(|part| EcmaValue::String(part.into()))
            .collect(),
    );
    let identity_input = EcmaValue::Array(vec![
        EcmaValue::String("workspace:write".into()),
        input.clone(),
        EcmaValue::String(request_key.into()),
    ]);
    CommandBinding {
        permit_id: format!(
            "resource-command:{}",
            database_identity(&permit_parts).trim_start_matches("1f:")
        ),
        identity: database_identity(&identity_input),
        owner: OWNER.into(),
        resource: RESOURCE.into(),
        generation: json!(1),
        operation: "workspace:write".into(),
        request_key: request_key.into(),
        input_identity: database_identity(input)
            .strip_prefix("1f:")
            .expect("canonical input identity has the record-log prefix")
            .to_owned(),
    }
}

struct Ids {
    next: u16,
    trigger_at: Option<u16>,
    trigger: Option<Box<dyn FnMut()>>,
}
impl Ids {
    fn ordinary() -> Self {
        Self {
            next: 0,
            trigger_at: None,
            trigger: None,
        }
    }
    fn on_id(number: u16, trigger: impl FnMut() + 'static) -> Self {
        Self {
            next: 0,
            trigger_at: Some(number),
            trigger: Some(Box::new(trigger)),
        }
    }
}
impl LogIds for Ids {
    fn next_log_id(&mut self) -> Option<String> {
        self.next += 1;
        if self.trigger_at == Some(self.next) {
            self.trigger_at = None;
            self.trigger.as_mut().expect("one trigger")();
        }
        Some(format!(
            "01234567-89ab-7{:03x}-8f01-000000000001",
            self.next
        ))
    }
}

fn execute(
    fixture: &Fixture,
    owner: &mut LocalAccount,
    call_input: &EcmaValue,
    request_key: &str,
    cancel: Arc<AtomicBool>,
    ids: &mut dyn LogIds,
) -> record_writer::Result<record_writer::native_command_context::NativeCommandResult> {
    let binding = binding(fixture, call_input, request_key);
    let sign_in = format!("key:{}", fixture.key.identity());
    let request = Request {
        key: request_key.into(),
        sent_at_ms: 1_790_000_000_000,
    };
    let context = Context {
        actor: json!({"untrusted":"selected-key-control"}),
        application_time: "2026-10-27T00:00:00.000Z".into(),
        system_time: "2026-10-27T00:00:00.000Z".into(),
        accepted_at_ms: request.sent_at_ms,
    };
    let selected = || fixture.assert_source_pin();
    // The caller's admission check stands in for the door's: it refuses once the fixture's key row is withdrawn.
    let digest = fixture.key.identity();
    let mut current = |owner: &mut LocalAccount| -> AccountResult<()> {
        owner.personal_key(&digest)?.map(|_| ()).ok_or(trillion_local::cause!(AccountError::KeyWithdrawn))
    };
    current(owner).map_err(|_| trillion_local::cause!(record_writer::Error::Refused))?;
    owner.execute_selected_workspace_write_checked(
        &SelectedWorkspaceWriteCall {
            binding: &binding,
            sign_in: &sign_in,
            input: call_input,
            request: &request,
            context: &context,
            cancel,
            deadline: Instant::now() + Duration::from_secs(10),
        },
        ids,
        &selected,
        &mut current,
        &mut |left, right| Ok(left.units().cmp(right.units())),
    )
}

/// An account migrated once from the old engine's tables, holding one saved board.
fn setup() -> Fixture {
    setup_with(|_| {})
}

/// `setup` with the policy of an account nothing made: its source is not born, so no scoped history may be enrolled.
/// The negative control of the original policy's canonical contract; every positive control uses `setup`.
fn noncanonical_setup() -> Fixture {
    let fixture = setup();
    Connection::open(fixture.root.join("policy.sqlite"))
        .unwrap()
        .execute(
            "UPDATE policy_directory SET value=? WHERE name='policy-source'",
            [json!({"from":"synthetic-fixture","missing":[]}).to_string()],
        )
        .unwrap();
    fixture
}

/// `setup`, with `prefill` writing the old engine's tables before the one migration reads them.
fn setup_with(prefill: impl FnOnce(&Connection)) -> Fixture {
    let fixture = Fixture::new();
    fixture.add_original_command_tables();
    prefill(&Connection::open(&fixture.records).unwrap());
    drop(fixture.open());
    fixture.set_board(r#"{"items":["kept"]}"#);
    fixture.add_capture_order_check();
    fixture
}

/// The current bodies of the account's own records, as one text.
fn own_records_text(fixture: &Fixture) -> String {
    Connection::open(&fixture.records)
        .unwrap()
        .query_row(
            &format!("SELECT group_concat(CAST(body AS TEXT),'') FROM versions WHERE resource='own-records' AND valid_to={CURRENT}"),
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn original_effect_journal_and_sealed_result_survive_cold_retry_once() {
    let fixture = setup();
    let before = fixture.counts();
    let old = fixture.old_rows();
    let input = input("saved-board", json!({"items":["written"]}), None);
    let mut ids = Ids::ordinary();
    let first = {
        let mut owner = fixture.open();
        execute(
            &fixture,
            &mut owner,
            &input,
            "selected-write-retry",
            Arc::new(AtomicBool::new(false)),
            &mut ids,
        )
        .unwrap()
    };
    assert!(!first.duplicate);
    assert_eq!(first.value, ecma(r#"{"written":1}"#));
    assert!(fixture.board().contains("written"));
    let after_first = fixture.counts();
    // One write per record: the execution and the sealed result, one command record, the result's key, the board.
    assert_eq!(
        (after_first.0 - before.0, after_first.1 - before.1, after_first.2 - before.2, after_first.3 - before.3),
        (2, 1, 1, 1)
    );
    assert_eq!(fixture.old_rows(), old, "a command writes none of the old engine's tables");
    let permit = binding(&fixture, &input, "selected-write-retry").permit_id;
    let command = fixture.current("own-commands", &permit).unwrap();
    assert_eq!(command["state"], "committed");
    assert!(command["input"].as_str().unwrap().contains("[write-only]"));
    assert!(!command["input"].as_str().unwrap().contains("written"));
    assert!(!command["context"].as_str().unwrap().contains("selected-key-control"));
    assert_eq!(command["result"]["result_ref"], permit);
    assert!(command["result"]["result_identity"]
        .as_str()
        .unwrap()
        .starts_with("1f:"));
    assert_eq!(command["execution_ref"], format!("execution:{permit}"));
    assert!(fixture
        .current("own-records", &format!("execution:{permit}"))
        .unwrap()
        .to_string()
        .contains("returned"));
    assert!(fixture
        .current("own-records", &format!("resource-command-result:{permit}"))
        .unwrap()
        .to_string()
        .contains("sealed"));
    assert!(fixture
        .current("own-record-keys", &format!("resource-command-result:{permit}"))
        .unwrap()
        .get("key")
        .is_some());
    assert!(!own_records_text(&fixture).contains("selected-key-control"));

    let retry = {
        let mut owner = fixture.open();
        execute(
            &fixture,
            &mut owner,
            &input,
            "selected-write-retry",
            Arc::new(AtomicBool::new(false)),
            &mut ids,
        )
        .unwrap()
    };
    assert!(retry.duplicate);
    assert_eq!(retry.value, first.value);
    assert_eq!(fixture.counts(), after_first);
}

#[test]
fn changed_input_under_same_key_conflicts_without_another_effect() {
    let fixture = setup();
    let first_input = input("saved-board", json!({"items":["first"]}), None);
    let mut ids = Ids::ordinary();
    {
        let mut owner = fixture.open();
        execute(
            &fixture,
            &mut owner,
            &first_input,
            "selected-write-conflict",
            Arc::new(AtomicBool::new(false)),
            &mut ids,
        )
        .unwrap();
    }
    let before = fixture.counts();
    let changed = input("saved-board", json!({"items":["different"]}), None);
    let mut owner = fixture.open();
    let result = execute(
        &fixture,
        &mut owner,
        &changed,
        "selected-write-conflict",
        Arc::new(AtomicBool::new(false)),
        &mut ids,
    );
    assert!(matches!(result, Err(record_writer::Error::Conflict(_))));
    assert_eq!(fixture.board(), r#"{"items":["first"]}"#);
    assert_eq!(fixture.counts(), before);
}

#[test]
fn key_withdrawal_at_terminal_append_rolls_back_effect_and_original_capture() {
    let fixture = setup();
    let input = input("saved-board", json!({"items":["must-rollback"]}), None);
    // The synchronous writer publishes its internal event batch after the
    // actual workspace effect. Revoke the key at that publication boundary;
    // the enclosing transaction must roll the completed effect back.
    let key_path = fixture.kv.clone();
    let key_id = fixture.key.identity();
    let mut ids = Ids::on_id(1, move || {
        let db = Connection::open(&key_path).unwrap();
        db.execute(
            "DELETE FROM _mf_entries WHERE key=?",
            [format!("personal-key:{key_id}")],
        )
        .unwrap();
    });
    let before_board = fixture.board();
    let before = fixture.counts();
    let mut owner = fixture.open();
    let result = execute(
        &fixture,
        &mut owner,
        &input,
        "selected-write-key-withdrawal",
        Arc::new(AtomicBool::new(false)),
        &mut ids,
    );
    assert!(result.is_err());
    assert_eq!(
        ids.next, 1,
        "withdrawal hook ran on actual internal batch publication"
    );
    assert_eq!(fixture.board(), before_board);
    assert_eq!(fixture.counts(), before);
}

#[test]
fn erased_committed_result_is_withheld_and_never_replayed() {
    let fixture = setup();
    let input = input("saved-board", json!({"items":["kept"]}), None);
    let mut ids = Ids::ordinary();
    let mut owner = fixture.open();
    execute(
        &fixture,
        &mut owner,
        &input,
        "selected-write-erased-result",
        Arc::new(AtomicBool::new(false)),
        &mut ids,
    )
    .unwrap();
    let before_erasure = fixture.counts();
    let permit = binding(&fixture, &input, "selected-write-erased-result").permit_id;
    let result_id = format!("resource-command-result:{permit}");
    fixture.rewrite("own-record-keys", &result_id, Some(json!({"erased": true})));
    let after_erasure = fixture.counts();
    assert_eq!(after_erasure.0, before_erasure.0);
    assert_eq!(after_erasure.1, before_erasure.1);
    assert_eq!(after_erasure.2, before_erasure.2 + 1);
    assert_eq!(after_erasure.3, before_erasure.3);
    let result = execute(
        &fixture,
        &mut owner,
        &input,
        "selected-write-erased-result",
        Arc::new(AtomicBool::new(false)),
        &mut ids,
    );
    assert!(matches!(
        result,
        Err(record_writer::Error::ProtectedResultUnavailable(_))
    ));
    assert_eq!(fixture.counts(), after_erasure);
    assert_eq!(
        fixture.current("own-record-keys", &result_id).unwrap(),
        json!({"erased": true}),
        "retry did not recreate protected-result key material",
    );
    assert_eq!(fixture.current("own-commands", &permit).unwrap()["state"], "committed");
}

#[test]
fn workspace_dependent_result_is_withheld_after_source_epoch_changes() {
    let fixture = setup();
    let input = input(
        "saved-board",
        json!({"items":["challenger"]}),
        Some("1f:deliberately-not-current"),
    );
    let mut ids = Ids::ordinary();
    let mut owner = fixture.open();
    let first = execute(
        &fixture,
        &mut owner,
        &input,
        "selected-write-source-change",
        Arc::new(AtomicBool::new(false)),
        &mut ids,
    )
    .unwrap();
    assert!(!first.duplicate);
    let result_text = ecma_json::stringify(&first.value, Default::default()).unwrap();
    assert!(result_text.contains("conflicts"));
    let before = fixture.counts();
    fixture.set_board(r#"{"items":["changed-after-result"]}"#);
    let after_source_change = fixture.counts();
    let result = execute(
        &fixture,
        &mut owner,
        &input,
        "selected-write-source-change",
        Arc::new(AtomicBool::new(false)),
        &mut ids,
    );
    assert!(matches!(
        result,
        Err(record_writer::Error::ProtectedResultUnavailable(_))
    ));
    assert_eq!(after_source_change.0, before.0);
    assert_eq!(after_source_change.1, before.1);
    assert_eq!(after_source_change.2, before.2);
    assert_eq!(fixture.board(), r#"{"items":["changed-after-result"]}"#);
    assert_eq!(fixture.counts(), after_source_change);
}

#[test]
fn cancellation_while_finalizing_rolls_back_effect_journal_and_sealed_output() {
    let fixture = setup();
    let input = input("saved-board", json!({"items":["cancelled"]}), None);
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_from_append = cancelled.clone();
    let mut ids = Ids::on_id(1, move || {
        cancel_from_append.store(true, Ordering::Release);
    });
    let before_board = fixture.board();
    let before = fixture.counts();
    let mut owner = fixture.open();
    assert!(execute(
        &fixture,
        &mut owner,
        &input,
        "selected-write-cancelled",
        cancelled,
        &mut ids,
    )
    .is_err());
    assert_eq!(
        ids.next, 1,
        "cancellation hook ran on actual internal batch publication"
    );
    assert_eq!(fixture.board(), before_board);
    assert_eq!(fixture.counts(), before);
}

#[test]
fn original_header_proof_reuses_unchanged_write_snapshot_and_rejects_handle_switch() {
    let fixture = setup();
    let binding = binding(
        &fixture,
        &input("saved-board", json!({}), None),
        "header-proof",
    );
    let db = Connection::open(&fixture.records).unwrap();
    let guard = workspace_generation::Guard::new(1);
    let tx = rusqlite::Transaction::new_unchecked(&db, rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    for _ in 0..100 {
        guard.assert_current(&tx, &binding).unwrap();
    }
    assert_eq!(guard.lookups(), 1, "unchanged guards do not repeat SQL");
    tx.execute(
        "UPDATE versions SET kind=kind WHERE resource='own-records'",
        [],
    )
    .unwrap();
    guard.assert_current(&tx, &binding).unwrap();
    assert_eq!(
        guard.lookups(),
        2,
        "a real write invalidates the header proof"
    );
    tx.commit().unwrap();
    guard.reset_transaction();
    let delivery =
        rusqlite::Transaction::new_unchecked(&db, rusqlite::TransactionBehavior::Immediate)
            .unwrap();
    guard.assert_current(&delivery, &binding).unwrap();
    assert_eq!(
        guard.lookups(),
        3,
        "new delivery snapshot gets a fresh proof"
    );
    crate::local_account::own_records::identity_fixture::change(&delivery, OWNER, crate::local_account::own_records::identity_fixture::header(OWNER, 2, 1));
    assert!(guard.assert_current(&delivery, &binding).is_err());
    assert_eq!(guard.lookups(), 4);
    delivery.rollback().unwrap();
    guard.reset_transaction();
    let other = Connection::open(&fixture.records).unwrap();
    let switched =
        rusqlite::Transaction::new_unchecked(&other, rusqlite::TransactionBehavior::Immediate)
            .unwrap();
    assert!(guard.assert_current(&switched, &binding).is_err());
    assert_eq!(
        guard.lookups(),
        4,
        "foreign handle refuses before header SQL"
    );
    switched.rollback().unwrap();
}

#[test]
fn original_resource_withdrawal_during_terminal_append_rolls_back_every_effect() {
    let fixture = setup();
    Connection::open(&fixture.records).unwrap().execute_batch(
        "CREATE TRIGGER withdraw_original_resource AFTER INSERT ON versions
         WHEN NEW.resource='own-records' AND instr(CAST(NEW.body AS TEXT),'returned')>0
         BEGIN UPDATE versions SET body=replace(CAST(body AS TEXT),'\"ready\":1','\"ready\":0')
             WHERE resource='own-resource-identity' AND valid_to=9223372036854775807; END"
    ).unwrap();
    let before = fixture.board();
    let counts = fixture.counts();
    let mut owner = fixture.open();
    let mut ids = Ids::ordinary();
    assert!(execute(
        &fixture,
        &mut owner,
        &input("saved-board", json!({"items":["must-rollback"]}), None),
        "original-header-withdrawal",
        Arc::new(AtomicBool::new(false)),
        &mut ids
    )
    .is_err());
    assert_eq!(fixture.board(), before);
    assert_eq!(fixture.counts(), counts);
    let header = crate::local_account::own_records::identity(&Connection::open(&fixture.records).unwrap(), OWNER)
        .unwrap()
        .unwrap();
    assert_eq!(header.ready, 1, "header withdrawal shares the actual rollback");
}

#[test]
fn pinned_source_change_is_refused_before_effect() {
    let fixture = setup();
    let before = fixture.counts();
    // Opening selects and pins the original restored source. Change the
    // receipt only after that selection so this exercises the writer's source
    // check, rather than LocalAccount's initial restore validation.
    let mut owner = fixture.open();
    fs::write(
        fixture.root.join("restore-receipt.json"),
        b"changed selected source",
    )
    .unwrap();
    let input = input("saved-board", json!({"items":["must-not-write"]}), None);
    let mut ids = Ids::ordinary();
    assert!(execute(
        &fixture,
        &mut owner,
        &input,
        "selected-write-source-fence",
        Arc::new(AtomicBool::new(false)),
        &mut ids,
    )
    .is_err());
    assert_eq!(ids.next, 0, "changed selection refuses before any append");
    assert_eq!(fixture.board(), r#"{"items":["kept"]}"#);
    assert_eq!(fixture.counts(), before);
}

#[test]
fn result_key_erasure_during_internal_batch_publication_rolls_back_workspace_effect() {
    let fixture = setup();
    Connection::open(&fixture.records).unwrap().execute_batch(
        "CREATE TRIGGER erase_published_workspace_result AFTER INSERT ON versions
         WHEN NEW.resource='own-record-keys' AND NEW.id LIKE 'resource-command-result:%'
         BEGIN UPDATE versions SET body=CAST('{\"erased\":true}' AS BLOB)
           WHERE account=NEW.account AND resource=NEW.resource AND id=NEW.id AND valid_to=NEW.valid_to; END;"
    ).unwrap();
    let before = fixture.board();
    let counts = fixture.counts();
    let mut owner = fixture.open();
    let mut ids = Ids::ordinary();
    assert!(execute(&fixture, &mut owner,
        &input("saved-board", json!({"items":["erased-batch"]}), None),
        "selected-batch-erasure", Arc::new(AtomicBool::new(false)), &mut ids,
    ).is_err());
    assert_eq!(ids.next, 1, "actual batch publication was reached");
    assert_eq!(fixture.board(), before);
    assert_eq!(fixture.counts(), counts);
}

#[test]
fn terminal_command_insert_cannot_hide_a_result_key_erased_by_its_trigger() {
    let fixture = setup();
    Connection::open(&fixture.records).unwrap().execute_batch(&format!(
        "CREATE TRIGGER erase_workspace_result_after_command AFTER INSERT ON versions
         WHEN NEW.resource='own-commands'
         BEGIN UPDATE versions SET body=CAST('{{\"erased\":true}}' AS BLOB)
           WHERE resource='own-record-keys' AND valid_to={CURRENT}; END;"
    )).unwrap();
    let before = fixture.board();
    let counts = fixture.counts();
    let mut owner = fixture.open();
    let mut ids = Ids::ordinary();
    assert!(execute(&fixture, &mut owner,
        &input("saved-board", json!({"items":["erased-terminal"]}), None),
        "selected-terminal-erasure", Arc::new(AtomicBool::new(false)), &mut ids,
    ).is_err());
    assert_eq!(ids.next, 1, "actual batch publication was reached");
    assert_eq!(fixture.board(), before);
    assert_eq!(fixture.counts(), counts);
}

