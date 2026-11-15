//! The account's own record write (`own-record-writes.json`) on the actual
//! selected account: one write over every declared record kind (a list, the
//! rows it declares, private and room pursuits), through the actual native
//! command parent, live record model, key owner, command journal and the
//! account's own records (record store), which are the only store a command writes.
//! Record words are synthetic fixture text.
use super::*;
use content_crypto::advanced::blake3;
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};
use trillion_local::{
    ecma_json::{self, Value as Ecma},
    local_account::record_writer::{
        native_command_context::{NativeCommandCall, NativeCommandResult},
        Error, Result as NativeResult,
    },
    record_log::{Context, LogIds, Request},
    records::{Mutation, Records},
    storage::{
        record_store::{settings, RecordStore, RealClock},
        sqlite::{self, Bounds, Spend},
    },
    workspace::WorkspaceSession,
    workspace_domain::DomainCommand,
};

/// The own-record resource's generation in its identity header.
const GENERATION: i64 = 1;

const COMMAND_DATA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/record_write_model/own-record-writes.json");
/// The shipped command DATA (src/record_write_model/own-record-writes.json).
fn command() -> Value {
    serde_json::from_slice(&fs::read(COMMAND_DATA).unwrap()).unwrap()
}
/// Its input schema in the DATA's own member order.
fn command_schema() -> Ecma {
    match ecma_json::parse(&fs::read(COMMAND_DATA).unwrap(), Default::default()).unwrap() {
        Ecma::Object(fields) => fields.get(&"input_schema".into()).unwrap().clone(),
        _ => unreachable!("the command DATA is an object"),
    }
}
fn ecma(raw: &str) -> Ecma {
    ecma_json::parse(raw.as_bytes(), Default::default()).unwrap()
}
fn encoded(value: &Ecma) -> String {
    ecma_json::stringify(value, Default::default()).unwrap()
}
fn bounds() -> Bounds {
    Bounds {
        value_bytes: 2 * 1024 * 1024,
        work: u64::MAX / 2,
        deadline: Duration::MAX,
        spend: Spend::EachOperation,
        cancel: None,
        busy: Duration::from_secs(5),
    }
}
fn account() -> String {
    "a".repeat(64)
}
fn store(f: &Fixture) -> RecordStore<sqlite::Supply<Connection>> {
    let supply = sqlite::open_owned(&f.root.join("records.sqlite"), "record_store", bounds()).unwrap();
    RecordStore::new(supply, Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap()
}
/// The current body of one record of one of the account's record store resources.
fn current(f: &Fixture, resource: &str, id: &str) -> Option<Value> {
    store(f).get(&account(), resource, id).unwrap().record.map(|record| record.value)
}
/// Set the generation of the resource-identity header in the account's record store, where a command checks it (the
/// first start copied it there from the old table).
fn set_generation(f: &Fixture, generation: i64) {
    let mut store = store(f);
    let held = store.get(&account(), "own-resource-identity", "1").unwrap().record.unwrap();
    let mut value = held.value;
    value["generation"] = json!(generation);
    let change = Mutation {
        id: "1".into(),
        expected_version: held.version,
        request_key: format!("identity-generation-{}", held.version + 1),
        deleted: false,
        value,
    };
    store.mutate(&account(), "own-resource-identity", change).unwrap();
}
/// The original records the first start migrates, the addressed resource's
/// identity at generation 1, then the first start itself: the account's own
/// records (record store) are Ready before any command, as the native startup task
/// leaves them before the app is served.
fn setup() -> (Fixture, LocalAccount) {
    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, "{}");
    Connection::open(f.root.join("records.sqlite")).unwrap().execute_batch(&format!(
        "ALTER TABLE record_log ADD COLUMN keys TEXT;
         CREATE TABLE record_erasable_keys(record_id TEXT PRIMARY KEY,key BLOB,erased_at TEXT,erased_fields TEXT) WITHOUT ROWID;
         CREATE TABLE own_resource_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,resource TEXT NOT NULL,generation INTEGER NOT NULL,ready INTEGER NOT NULL);
         INSERT INTO own_resource_identity VALUES(1,'{}','@own-records',{GENERATION},1);",
        account()
    )).unwrap();
    let mut owner = f.open().unwrap();
    first_start(&mut owner, &f.session);
    (f, owner)
}
/// Log ids unique across every command of the process, as the canonical log
/// identity owner issues them: a write's record store request key is named by its log id.
struct Ids;
impl LogIds for Ids {
    fn next_log_id(&mut self) -> Option<String> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Some(format!("01234567-89ab-7001-8f01-{n:012x}"))
    }
}
struct Parent {
    session: WorkspaceSession,
    command: DomainCommand,
    schema: Ecma,
    permit: String,
    identity: String,
    request: Request,
    context: Context,
}
impl Parent {
    fn new(owner: &mut LocalAccount, key: &str, records: Value) -> Self {
        let raw = owner.session_identity();
        let admission = current_browser(owner, &raw).unwrap();
        Self {
            session: WorkspaceSession {
                account_id: admission.account.user_id.clone(),
                session_id: raw.to_string(),
            },
            command: DomainCommand {
                operation: command()["operation"].as_str().unwrap().into(),
                input: json!({ "records": records }),
                request_key: key.into(),
                key_carried: true,
            },
            schema: command_schema(),
            permit: format!("resource-command:{}", blake3::hash(key.as_bytes()).to_hex()),
            identity: format!("1f:{}", blake3::hash(key.as_bytes()).to_hex()),
            request: Request { key: key.into(), sent_at_ms: 1 },
            context: Context {
                actor: json!({}),
                application_time: "2026-10-29T20:00:00.000Z".into(),
                system_time: "2026-10-29T20:00:00.000Z".into(),
                accepted_at_ms: 1,
            },
        }
    }
    fn write(&self, owner: &mut LocalAccount) -> NativeResult<NativeCommandResult> {
        owner.execute_native_records_write(
            &NativeCommandCall {
                session: &self.session,
                cancel: Arc::new(AtomicBool::new(false)),
                command: &self.command,
                input_schema: &self.schema,
                permit_id: &self.permit,
                original_identity: &self.identity,
                request: &self.request,
                log_context: &self.context,
                deadline: Instant::now() + Duration::from_secs(30),
            },
            GENERATION,
            &mut Ids,
        )
    }
}
/// Version rows (history included) of the account's own records, its command
/// records and its field keys: any write adds one.
fn counts(f: &Fixture) -> (i64, i64, i64) {
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    let rows = |resource: &str| -> i64 {
        db.query_row("SELECT COUNT(*) FROM versions WHERE resource=?", [resource], |r| r.get(0)).unwrap()
    };
    (rows("own-records"), rows("own-commands"), rows("own-record-keys"))
}
/// The old engine's tables the account still holds for the one-time migration: a command writes none of them.
fn old_rows(f: &Fixture) -> i64 {
    Connection::open(f.root.join("records.sqlite")).unwrap()
        .query_row("SELECT (SELECT COUNT(*) FROM record_log)+(SELECT COUNT(*) FROM record_erasable_keys)", [], |r| r.get(0))
        .unwrap()
}
/// The record as the account's own reader resolves it, in the original
/// ECMAScript text form; None when it does not exist.
fn read(owner: &mut LocalAccount, f: &Fixture, id: &str) -> Option<String> {
    owner
        .current_logical_record(&f.session, id, Default::default(), Arc::new(AtomicBool::new(false)))
        .unwrap()
        .map(|record| encoded(record.value()))
}
fn same(value: &Value) -> String {
    encoded(&ecma(&value.to_string()))
}

fn tasks_list() -> Value {
    json!({"row_type":"tasks","label":"Tasks","fields":[{"id":"title","kind":"text"},{"id":"estimate","kind":"number"},{"id":"tags","kind":"tags"}]})
}

/// The first start copies the old resource-identity header into the account's record store (the generic copy phase), and
/// a store whose position was written Ready before that copy existed copies it at its next start, keeping a header
/// record store already holds.
/// The person's saved examples, kept by the old engine as workshop facts (the newest fact per example its value, a
/// removed one holding removed_at), become own records of kind saved-example at the first start: each one not
/// removed, as its newest value; a removed one and other workshop facts are not carried.
#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn first_start_carries_the_saved_examples_that_are_not_removed() {
    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, "{}");
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    db.execute_batch(
        "ALTER TABLE record_log ADD COLUMN keys TEXT;
         CREATE TABLE workshop_facts(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL);
         CREATE INDEX workshop_facts_entity ON workshop_facts(entity,seq);",
    ).unwrap();
    for (at, entity, value) in [
        ("2026-10-01T10:00:00.000Z", "saved-example:a", r#"{"id":"a","url":"https://example.com/a","title":"First"}"#),
        ("2026-10-02T10:00:00.000Z", "saved-example:b", r#"{"id":"b","url":"https://example.com/b"}"#),
        ("2026-10-03T10:00:00.000Z", "saved-example:a", r#"{"id":"a","url":"https://example.com/a","title":"Kept"}"#),
        ("2026-10-04T10:00:00.000Z", "saved-example:b", r#"{"id":"b","removed_at":"2026-10-04T10:00:00.000Z"}"#),
        ("2026-10-05T10:00:00.000Z", "tool:other", r#"{"id":"other"}"#),
    ] {
        db.execute("INSERT INTO workshop_facts(at,entity,value) VALUES(?,?,?)", [at, entity, value]).unwrap();
    }
    drop(db);
    let mut owner = f.open().unwrap();
    first_start(&mut owner, &f.session);
    let kept = current(&f, "own-records", "a").unwrap();
    assert_eq!(kept["kind"], "saved-example");
    assert_eq!(kept["stored"], r#"{"id":"a","url":"https://example.com/a","title":"Kept"}"#);
    assert_eq!(kept["sequence"].as_str().unwrap().len(), 19);
    assert_eq!(current(&f, "own-records", "b"), None, "a removed example is not carried");
    assert_eq!(current(&f, "own-records", "other"), None, "other workshop facts are not saved examples");
}

/// The old password manager's tables stay where they are at the first start: no saved login, grant or showing becomes
/// an own record until record-model.json declares their kinds stays_on_this_device (their copy rows, fce9e6c, are off
/// until then), so no road that carries a record off the Mac can carry one. The old tables are left whole.
#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn first_start_copies_no_saved_login_while_its_kinds_may_leave_the_device() {
    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, "{}");
    Connection::open(f.root.join("records.sqlite")).unwrap().execute_batch(
        r#"ALTER TABLE record_log ADD COLUMN keys TEXT;
         CREATE TABLE saved_logins (id TEXT PRIMARY KEY, title TEXT NOT NULL, site TEXT, user_name TEXT, fields TEXT NOT NULL, ai_can_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE saved_login_grants (id TEXT PRIMARY KEY, all_logins INTEGER NOT NULL, login_ids TEXT, message_id TEXT NOT NULL, quote TEXT NOT NULL, by_app TEXT, granted_at TEXT NOT NULL, ended_at TEXT);
         CREATE TABLE saved_login_reveals (seq INTEGER PRIMARY KEY AUTOINCREMENT, login_id TEXT NOT NULL, field_id TEXT NOT NULL, by_kind TEXT NOT NULL, by_name TEXT, at TEXT NOT NULL);
         CREATE TABLE saved_login_shown (login_id TEXT NOT NULL, field_id TEXT NOT NULL, count INTEGER NOT NULL, last_at TEXT NOT NULL, last_by_kind TEXT NOT NULL, last_by_name TEXT, PRIMARY KEY (login_id, field_id));
         INSERT INTO saved_logins VALUES ('0a1b2c3d4e5f6071', 'Example', 'example.com', 'sample@example.com', '[{"field_id":"f1","label":"Password"}]', 1, '2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z');
         INSERT INTO saved_logins VALUES ('1a2b3c4d5e6f7081', 'No site', NULL, NULL, '[]', 0, '2026-10-03T10:00:00.000Z', '2026-10-03T10:00:00.000Z');
         INSERT INTO saved_login_grants VALUES ('9f8e7d6c5b4a3921', 1, NULL, 'message-1', 'my AIs may use my logins', 'sample-app', '2026-10-04T10:00:00.000Z', NULL);
         INSERT INTO saved_login_reveals (login_id, field_id, by_kind, by_name, at) VALUES ('0a1b2c3d4e5f6071', 'f1', 'person', NULL, '2026-10-05T10:00:00.000Z');
         INSERT INTO saved_login_shown VALUES ('0a1b2c3d4e5f6071', 'f1', 1, '2026-10-05T10:00:00.000Z', 'person', NULL);"#,
    ).unwrap();
    let mut owner = f.open().unwrap();
    first_start(&mut owner, &f.session);
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    let copied: i64 = db.query_row(
        "SELECT COUNT(*) FROM versions WHERE resource='own-records' AND (id LIKE 'saved-login%' OR CAST(body AS TEXT) LIKE '%saved-login%')",
        [], |r| r.get(0)).unwrap();
    assert_eq!(copied, 0, "no saved-login kind is copied at first start");
    let kept = |table: &str| -> i64 { db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap() };
    assert_eq!((kept("saved_logins"), kept("saved_login_grants"), kept("saved_login_reveals")), (2, 1, 1), "the old tables are left whole");
}

/// The old billing and quota ledgers become own records at the first start, one per row: a table keyed by several
/// fields is named by all of them (a `:` in a value escaped), a day or a millisecond time orders the record, and a
/// table that keeps no time orders from the start of 1970.
#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn first_start_carries_the_old_ledgers_by_their_whole_key() {
    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, "{}");
    Connection::open(f.root.join("records.sqlite")).unwrap().execute_batch(
        r#"ALTER TABLE record_log ADD COLUMN keys TEXT;
         CREATE TABLE model_spend (day TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0, remembered INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, paid_by TEXT NOT NULL DEFAULT 'trillion', PRIMARY KEY (day, purpose, model));
         CREATE TABLE resource_quota_grant_sizes (owner TEXT NOT NULL,resource TEXT NOT NULL,basis TEXT NOT NULL,size INTEGER NOT NULL,full INTEGER NOT NULL,at_ms INTEGER NOT NULL,PRIMARY KEY(owner,resource,basis)) WITHOUT ROWID;
         CREATE TABLE resource_quota_credits (owner TEXT NOT NULL, resource TEXT NOT NULL, id TEXT NOT NULL, request_json TEXT NOT NULL, permit_json TEXT, used_json TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(owner, resource, id));
         INSERT INTO model_spend VALUES ('2026-10-02', 'judge:copy', 'sample-model', 3, 0, 1, 120, 40, 'trillion');
         INSERT INTO resource_quota_grant_sizes VALUES ('owner-1', 'models', 'day', 10, 0, 1759363200000);
         INSERT INTO resource_quota_credits VALUES ('owner-1', 'models', 'credit-1', '{"units":2}', NULL, '{"units":1}', 'open');"#,
    ).unwrap();
    let mut owner = f.open().unwrap();
    first_start(&mut owner, &f.session);
    let kept = |id: &str| current(&f, "own-records", id).unwrap_or_else(|| panic!("{id} was not copied"));
    let spend = kept("model-spend:2026-10-02:judge%3Acopy:sample-model");
    assert_eq!(spend["kind"], "record:model-spend");
    assert_eq!(spend["sequence"], "01a0f9e920000000000", "a day orders from its start in UTC");
    assert_eq!(serde_json::from_str::<Value>(spend["stored"].as_str().unwrap()).unwrap()["output_tokens"], 40);
    assert_eq!(kept("resource-quota-grant-size:owner-1:models:day")["sequence"], "0199a237f4000000000", "milliseconds order it");
    let credit = kept("resource-quota-credit:owner-1:models:credit-1");
    assert_eq!(credit["sequence"], "0000000000000000000", "a table that keeps no time");
    assert_eq!(serde_json::from_str::<Value>(credit["stored"].as_str().unwrap()).unwrap(), json!({"owner": "owner-1", "resource": "models",
        "id": "credit-1", "request_json": {"units": 2}, "permit_json": null, "used_json": {"units": 1}, "state": "open"}));
}

/// The saved live screen revision ceiling (the old screen_revision table) is copied with the other copied tables, so
/// live heads keep counting past it after the first start.
#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn first_start_copies_the_saved_screen_revision() {
    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, "{}");
    Connection::open(f.root.join("records.sqlite")).unwrap().execute_batch(
        "ALTER TABLE record_log ADD COLUMN keys TEXT;
         CREATE TABLE screen_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
         INSERT INTO screen_revision VALUES(1,5000);",
    ).unwrap();
    let mut owner = f.open().unwrap();
    first_start(&mut owner, &f.session);
    assert_eq!(current(&f, "screen-revision", "1"), Some(json!({"id": 1, "revision": 5000})));
}

/// Every copy's name, in the order the copy phase runs them (src/storage/record_store_resources.json).
fn copied_names() -> Value {
    json!(["saved-examples", "metered-use-days", "model-spend", "resource-quota-completions", "resource-quota-credits", "resource-quota-debits", "resource-quota-grant-children", "resource-quota-grant-sizes", "resource-quota-grants", "resource-quota-ready", "resource-quota-ready-walk", "tool-charge-billing-state", "tool-charge-history", "tool-charge-totals", "tool-charges", "own-resource-identity", "screen-revision"])
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn first_start_copies_the_identity_header_and_a_store_ready_before_the_copy_copies_it_next() {
    let (f, owner) = setup();
    let header = json!({"singleton":1,"owner":account(),"resource":"@own-records","generation":GENERATION,"ready":1});
    assert_eq!(current(&f, "own-resource-identity", "1"), Some(header));
    drop(owner);
    let mut store = store(&f);
    let held = store.get(&account(), "own-records-position", "position").unwrap().record.unwrap();
    assert_eq!(held.value["copied"], copied_names());
    let before = json!({"phase":"ready","watermark":held.value["watermark"].clone()});
    let ready_before_copy = Mutation {
        id: "position".into(),
        expected_version: held.version,
        request_key: "ready-before-the-copy".into(),
        deleted: false,
        value: before,
    };
    store.mutate(&account(), "own-records-position", ready_before_copy).unwrap();
    drop(store);
    set_generation(&f, 7);
    let mut owner = f.open().unwrap();
    first_start(&mut owner, &f.session);
    let position = current(&f, "own-records-position", "position").unwrap();
    assert_eq!(position["phase"], "ready");
    assert_eq!(position["copied"], copied_names());
    assert_eq!(current(&f, "own-resource-identity", "1").unwrap()["generation"], 7, "a header record store holds stays");
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn one_command_creates_and_updates_every_declared_kind_and_reads_back_byte_identical() {
    let (f, mut owner) = setup();
    let old = old_rows(&f);
    let row = json!({"title":"Write the tests","estimate":3,"tags":["rust","\u{e9}t\u{e9}"],"nested":{"b":1,"a":[2.5,null]}});
    let private = json!({"title":"Quiet plan","now":"Drafting","after":"Shipped","status":"active"});
    let room = json!({"title":"Team plan","now":"Planning","after":"Launched","status":"active","space_id":"space-one"});
    let created = Parent::new(&mut owner, "create-every-kind", json!([
        {"id":"list:tasks","type":"list","value":tasks_list()},
        {"id":"tasks:1","type":"record:tasks","value":row},
        {"id":"pursuit:quiet-plan","type":"pursuit","value":private},
        {"id":"pursuit:team-plan","type":"pursuit","value":room},
    ])).write(&mut owner).unwrap();
    assert!(!created.duplicate);
    assert_eq!(encoded(&created.value), r#"{"changed":true,"write_count":4}"#);
    assert_eq!(read(&mut owner, &f, "list:tasks"), Some(same(&tasks_list())));
    assert_eq!(read(&mut owner, &f, "tasks:1"), Some(same(&row)));
    assert_eq!(read(&mut owner, &f, "pursuit:quiet-plan"), Some(same(&private)));
    assert_eq!(read(&mut owner, &f, "pursuit:team-plan"), Some(same(&room)));

    let row = json!({"title":"Write the tests","estimate":5,"tags":["rust"]});
    let private = json!({"title":"Quiet plan","now":"Testing","after":"Shipped","status":"done"});
    let updated = Parent::new(&mut owner, "update-two-kinds", json!([
        {"id":"tasks:1","type":"record:tasks","value":row},
        {"id":"pursuit:quiet-plan","type":"pursuit","value":private},
    ])).write(&mut owner).unwrap();
    assert_eq!(encoded(&updated.value), r#"{"changed":true,"write_count":2}"#);
    assert_eq!(read(&mut owner, &f, "tasks:1"), Some(same(&row)));
    assert_eq!(read(&mut owner, &f, "pursuit:quiet-plan"), Some(same(&private)));
    assert_eq!(read(&mut owner, &f, "pursuit:team-plan"), Some(same(&room)), "an unnamed record is untouched");

    // A removal may omit the type: it removes whatever kind the record holds.
    let removed = Parent::new(&mut owner, "remove-row", json!([{"id":"tasks:1","value":null}]))
        .write(&mut owner).unwrap();
    assert_eq!(encoded(&removed.value), r#"{"changed":true,"write_count":1}"#);
    assert_eq!(read(&mut owner, &f, "tasks:1"), None);
    let absent = Parent::new(&mut owner, "remove-absent", json!([{"id":"tasks:404","value":null}]))
        .write(&mut owner).unwrap();
    assert_eq!(encoded(&absent.value), r#"{"changed":false,"write_count":0}"#);
    assert_eq!(old_rows(&f), old, "no command writes the old engine's tables");
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn conditional_create_update_and_remove_use_the_logical_root_snapshot() {
    let (f, mut owner) = setup();
    let first = json!({"title":"First","now":"Draft","after":"Done","status":"active"});
    let created = Parent::new(&mut owner, "cas-create", json!([
        {"id":"pursuit:cas","type":"pursuit","value":first,"expected":null}
    ])).write(&mut owner).unwrap();
    assert_eq!(encoded(&created.value), r#"{"changed":true,"write_count":1}"#);
    assert_eq!(read(&mut owner, &f, "pursuit:cas"), Some(same(&first)));

    let second = json!({"title":"Second","now":"Review","after":"Done","status":"active"});
    let updated = Parent::new(&mut owner, "cas-update", json!([
        {"id":"pursuit:cas","type":"pursuit","value":second,"expected":{"type":"pursuit","value":first}}
    ])).write(&mut owner).unwrap();
    assert_eq!(encoded(&updated.value), r#"{"changed":true,"write_count":1}"#);
    assert_eq!(read(&mut owner, &f, "pursuit:cas"), Some(same(&second)));

    let removed = Parent::new(&mut owner, "cas-remove", json!([
        {"id":"pursuit:cas","value":null,"expected":{"type":"pursuit","value":second}}
    ])).write(&mut owner).unwrap();
    assert_eq!(encoded(&removed.value), r#"{"changed":true,"write_count":1}"#);
    assert_eq!(read(&mut owner, &f, "pursuit:cas"), None);

    let absent_remove = Parent::new(&mut owner, "cas-absent-remove", json!([
        {"id":"pursuit:cas","value":null,"expected":null}
    ])).write(&mut owner).unwrap();
    assert_eq!(encoded(&absent_remove.value), r#"{"changed":false,"write_count":0}"#);
    assert_eq!(read(&mut owner, &f, "pursuit:cas"), None);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn stale_conditional_batch_has_zero_effects_and_same_key_can_retry() {
    let (f, mut owner) = setup();
    let before_a = json!({"title":"A before","now":"Draft","after":"Done","status":"active"});
    let before_b = json!({"title":"B before","now":"Draft","after":"Done","status":"active"});
    Parent::new(&mut owner, "cas-prefill", json!([
        {"id":"pursuit:cas-a","type":"pursuit","value":before_a},
        {"id":"pursuit:cas-b","type":"pursuit","value":before_b}
    ])).write(&mut owner).unwrap();

    let concurrent_b = json!({"title":"B newer","now":"Review","after":"Done","status":"active"});
    Parent::new(&mut owner, "cas-concurrent-b", json!([
        {"id":"pursuit:cas-b","type":"pursuit","value":concurrent_b}
    ])).write(&mut owner).unwrap();

    let before_conflict = counts(&f);
    let first_a = json!({"title":"A proposed","now":"Review","after":"Done","status":"active"});
    let stale_b = json!({"title":"B proposed","now":"Publish","after":"Done","status":"active"});
    let retry_key = "cas-conflict-then-retry";
    let stale = Parent::new(&mut owner, retry_key, json!([
        {"id":"pursuit:cas-a","type":"pursuit","value":first_a,"expected":{"type":"pursuit","value":before_a}},
        {"id":"pursuit:cas-b","type":"pursuit","value":stale_b,"expected":{"type":"pursuit","value":before_b}}
    ])).write(&mut owner);
    assert!(matches!(stale, Err(Error::Conflict(_))), "stale second item conflicts: {stale:?}");
    assert_eq!(counts(&f), before_conflict, "mismatch stores no records, keys or receipts");
    assert_eq!(read(&mut owner, &f, "pursuit:cas-a"), Some(same(&before_a)), "the valid first item also rolls back");
    assert_eq!(read(&mut owner, &f, "pursuit:cas-b"), Some(same(&concurrent_b)));

    // The failed command left no receipt under this request key, so a corrected
    // snapshot condition can safely use that same key and complete once.
    let final_a = json!({"title":"A final","now":"Review","after":"Done","status":"active"});
    let final_b = json!({"title":"B final","now":"Publish","after":"Done","status":"active"});
    let retried = Parent::new(&mut owner, retry_key, json!([
        {"id":"pursuit:cas-a","type":"pursuit","value":final_a,"expected":{"type":"pursuit","value":before_a}},
        {"id":"pursuit:cas-b","type":"pursuit","value":final_b,"expected":{"type":"pursuit","value":concurrent_b}}
    ])).write(&mut owner).unwrap();
    assert!(!retried.duplicate);
    assert_eq!(encoded(&retried.value), r#"{"changed":true,"write_count":2}"#);
    assert_eq!(read(&mut owner, &f, "pursuit:cas-a"), Some(same(&final_a)));
    assert_eq!(read(&mut owner, &f, "pursuit:cas-b"), Some(same(&final_b)));
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn conditional_input_preserves_the_existing_duplicate_id_refusal() {
    let (f, mut owner) = setup();
    let before = json!({"title":"Before","now":"Draft","after":"Done","status":"active"});
    Parent::new(&mut owner, "cas-duplicate-prefill", json!([
        {"id":"pursuit:cas-duplicate","type":"pursuit","value":before}
    ])).write(&mut owner).unwrap();
    let counts_before = counts(&f);
    let first = json!({"title":"First","now":"Review","after":"Done","status":"active"});
    let second = json!({"title":"Second","now":"Publish","after":"Done","status":"active"});
    let duplicate = Parent::new(&mut owner, "cas-duplicate", json!([
        {"id":"pursuit:cas-duplicate","type":"pursuit","value":first,"expected":{"type":"pursuit","value":before}},
        {"id":"pursuit:cas-duplicate","type":"pursuit","value":second,"expected":{"type":"pursuit","value":before}}
    ])).write(&mut owner);
    assert!(matches!(duplicate, Err(Error::Refused(_))), "duplicate identity remains refused: {duplicate:?}");
    assert_eq!(counts(&f), counts_before, "duplicate refusal adds no record, key or receipt");
    assert_eq!(read(&mut owner, &f, "pursuit:cas-duplicate"), Some(same(&before)));
}

/// A condition names the value the account holds, whatever order its fields were written in: after a write adds a
/// field that sorts before fields the record already held (`probe` before `status`, `to`, `sent_at`), the next write
/// conditioned on exactly that value is admitted, and one conditioned on the earlier value is refused. Found live
/// 2026-11-02: every third change of a job (take, then finish) was refused as changed though nothing had changed.
#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn a_condition_holds_after_a_write_added_a_field_that_sorts_before_held_ones() {
    let (f, mut owner) = setup();
    let first = json!({"status":"waiting","to":"ai:one","sent_at":"2026-11-02T08:58:55.977Z"});
    let mut second = first.clone();
    second["probe"] = json!(1);
    let mut third = first.clone();
    third["probe"] = json!(2);
    let write = |owner: &mut LocalAccount, key: &str, value: &Value, expected: Value| Parent::new(owner, key, json!([
        {"id":"ai-job:order","type":"ai-job","value":value,"expected":expected}
    ])).write(owner);
    write(&mut owner, "order-1", &first, Value::Null).unwrap();
    write(&mut owner, "order-2", &second, json!({"type":"ai-job","value":first})).unwrap();
    let stale = write(&mut owner, "order-stale", &third, json!({"type":"ai-job","value":first}));
    assert!(matches!(stale, Err(Error::Conflict(_))), "the earlier value no longer holds: {stale:?}");
    let held = write(&mut owner, "order-3", &third, json!({"type":"ai-job","value":second})).unwrap();
    assert_eq!(encoded(&held.value), r#"{"changed":true,"write_count":1}"#);
    let now = read(&mut owner, &f, "ai-job:order").map(|text| serde_json::from_str::<Value>(&text).unwrap());
    assert_eq!(now, Some(third));
}

/// Two AIs take the same waiting job (the Workshop's hand-work-to-ais tool): both read it waiting and each writes
/// itself as the taker on condition that it is still that waiting value. Whichever write the account's one
/// transaction admits first wins; the other is refused whole and leaves nothing, and the job names the winner. A
/// create on condition of absence is refused while the record exists, and a write with no condition still replaces
/// whatever is there, as before conditions existed.
#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn two_takers_of_one_waiting_job_exactly_one_wins() {
    let (f, mut owner) = setup();
    // The job as the account reads it, compared as JSON: a later write keeps the first write's property order.
    let job = |owner: &mut LocalAccount| read(owner, &f, "ai-job:take-race").map(|text| serde_json::from_str::<Value>(&text).unwrap());
    let waiting = json!({"status":"waiting","to":"any","job":"Synthetic job"});
    Parent::new(&mut owner, "job-handed", json!([
        {"id":"ai-job:take-race","type":"ai-job","value":waiting,"expected":null}
    ])).write(&mut owner).unwrap();

    let taken_by = |taker: &str| json!({"status":"taken","to":"any","job":"Synthetic job","taker":taker,"taken_at":"2026-11-01T20:00:00.000Z"});
    let mut take = |taker: &str| Parent::new(&mut owner, &format!("take-{taker}"), json!([
        {"id":"ai-job:take-race","type":"ai-job","value":taken_by(taker),"expected":{"type":"ai-job","value":waiting}}
    ]));
    let first = take("ai:first");
    let second = take("ai:second");
    let before = counts(&f);
    let won = first.write(&mut owner).unwrap();
    assert_eq!(encoded(&won.value), r#"{"changed":true,"write_count":1}"#);
    let after_win = counts(&f);
    let lost = second.write(&mut owner);
    assert!(matches!(lost, Err(Error::Conflict(_))), "the second taker read a value that changed: {lost:?}");
    assert_eq!(counts(&f), after_win, "the refused take stores no record, key or receipt");
    assert!(after_win.0 > before.0);
    assert_eq!(job(&mut owner), Some(taken_by("ai:first")));

    let recreated = Parent::new(&mut owner, "job-handed-again", json!([
        {"id":"ai-job:take-race","type":"ai-job","value":waiting,"expected":null}
    ])).write(&mut owner);
    assert!(matches!(recreated, Err(Error::Conflict(_))), "a create on condition of absence is refused: {recreated:?}");
    assert_eq!(job(&mut owner), Some(taken_by("ai:first")));

    let released = Parent::new(&mut owner, "job-released", json!([
        {"id":"ai-job:take-race","type":"ai-job","value":waiting,"expected":{"type":"ai-job","value":taken_by("ai:first")}}
    ])).write(&mut owner).unwrap();
    assert_eq!(encoded(&released.value), r#"{"changed":true,"write_count":1}"#);
    let unconditional = Parent::new(&mut owner, "job-overwritten", json!([
        {"id":"ai-job:take-race","type":"ai-job","value":taken_by("ai:second")}
    ])).write(&mut owner).unwrap();
    assert_eq!(encoded(&unconditional.value), r#"{"changed":true,"write_count":1}"#);
    assert_eq!(job(&mut owner), Some(taken_by("ai:second")));
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn each_change_is_one_current_record_write_and_an_unchanged_write_is_none() {
    let (f, mut owner) = setup();
    Parent::new(&mut owner, "declare", json!([{"id":"list:tasks","type":"list","value":tasks_list()}]))
        .write(&mut owner).unwrap();
    let rows = |n: usize| (0..n).map(|i| json!({"id":format!("tasks:{i}"),"type":"record:tasks","value":{"title":format!("row {i}")}})).collect::<Vec<_>>();
    let before = counts(&f);
    Parent::new(&mut owner, "one-row", json!(rows(1))).write(&mut owner).unwrap();
    let one = counts(&f);
    Parent::new(&mut owner, "three-rows", json!(rows(4)[1..].to_vec())).write(&mut owner).unwrap();
    let three = counts(&f);
    let one_records = one.0 - before.0;
    let three_records = three.0 - one.0;
    eprintln!("records-write-cost {}", json!({
        "one_change":{"own_records":one_records,"commands":one.1-before.1,"keys":one.2-before.2},
        "three_changes":{"own_records":three_records,"commands":three.1-one.1,"keys":three.2-one.2}}));
    // The command's own receipt (its execution, sealed result, result key and
    // command record) is fixed; each further changed record adds one write.
    assert_eq!(three_records - one_records, 2, "one record write per changed record");
    assert_eq!((one.1 - before.1, three.1 - one.1), (1, 1), "one command record per command");
    let unchanged = Parent::new(&mut owner, "same-again", json!(rows(1))).write(&mut owner).unwrap();
    assert_eq!(encoded(&unchanged.value), r#"{"changed":false,"write_count":0}"#);
    let after = counts(&f);
    assert_eq!(after.0 - three.0, one_records - 1, "an unchanged record adds no record write, only the receipt");
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn a_declared_property_of_the_wrong_kind_or_a_receipt_id_writes_nothing() {
    let (f, mut owner) = setup();
    Parent::new(&mut owner, "declare", json!([{"id":"list:tasks","type":"list","value":tasks_list()}]))
        .write(&mut owner).unwrap();
    let before = counts(&f);
    for (key, records) in [
        ("number-as-text", json!([{"id":"tasks:1","type":"record:tasks","value":{"estimate":"three"}}])),
        ("parents-not-ids", json!([{"id":"pursuit:a","type":"pursuit","value":{"title":"A","parents":"pursuit:b"}}])),
        ("room-not-an-id", json!([{"id":"pursuit:a","type":"pursuit","value":{"title":"A","space_id":"a/b"}}])),
        ("receipt-id", json!([{"id":"execution:forged","type":"pursuit","value":{}}])),
        ("receipt-type", json!([{"id":"forged","type":"resource-command-result","value":{}}])),
        ("whole-batch", json!([{"id":"tasks:2","type":"record:tasks","value":{"title":"kept?"}},{"id":"tasks:3","type":"record:tasks","value":{"estimate":"x"}}])),
    ] {
        let refused = Parent::new(&mut owner, key, records).write(&mut owner);
        assert!(matches!(refused, Err(Error::Invalid(_))), "{key}: {refused:?}");
        assert_eq!(counts(&f), before, "{key} wrote nothing");
    }
    assert_eq!(read(&mut owner, &f, "tasks:2"), None, "a refused batch keeps none of its records");
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn input_outside_the_declared_shape_writes_nothing() {
    let (f, mut owner) = setup();
    let before = counts(&f);
    // One record over the engine's write limit, as the command DATA declares it.
    let most = command()["input_schema"]["properties"]["records"]["maxItems"].as_u64().unwrap();
    let too_many = (0..=most).map(|i| json!({"id":format!("p{i}"),"type":"pursuit","value":{}})).collect::<Vec<_>>();
    for (key, records) in [
        ("no-records", json!([])),
        ("slash-id", json!([{"id":"a/b","type":"pursuit","value":{}}])),
        ("empty-id", json!([{"id":"","type":"pursuit","value":{}}])),
        ("value-without-type", json!([{"id":"a","value":{}}])),
        ("no-value", json!([{"id":"a","type":"pursuit"}])),
        ("list-value", json!([{"id":"a","type":"pursuit","value":[1]}])),
        ("empty-type", json!([{"id":"a","type":"","value":{}}])),
        ("invalid-expected", json!([{"id":"a","type":"pursuit","value":{},"expected":false}])),
        ("expected-without-value", json!([{"id":"a","type":"pursuit","value":{},"expected":{"type":"pursuit"}}])),
        ("expected-without-type", json!([{"id":"a","type":"pursuit","value":{},"expected":{"value":{}}}])),
        ("expected-value-not-object", json!([{"id":"a","type":"pursuit","value":{},"expected":{"type":"pursuit","value":null}}])),
        ("expected-extra-field", json!([{"id":"a","type":"pursuit","value":{},"expected":{"type":"pursuit","value":{},"extra":true}}])),
        ("not-an-object", json!(["a"])),
        ("too-many", json!(too_many)),
    ] {
        let refused = Parent::new(&mut owner, key, records).write(&mut owner);
        assert!(matches!(refused, Err(Error::Invalid(_))), "{key}: {refused:?}");
    }
    assert_eq!(counts(&f), before);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn receipts_keep_digests_and_references_never_record_words() {
    let (f, mut owner) = setup();
    let parent = Parent::new(&mut owner, "private-words", json!([
        {"id":"pursuit:CANARY_PRIVATE_ID","type":"pursuit","value":{"title":"CANARY_PRIVATE_TITLE","now":"n","after":"a"}},
    ]));
    parent.write(&mut owner).unwrap();
    let command = current(&f, "own-commands", &parent.permit).unwrap();
    assert_eq!(command["state"], "committed");
    assert!(command["input"].as_str().unwrap().contains("[write-only]"));
    assert!(command["result"]["result_identity"].as_str().unwrap().starts_with("1f:"));
    let execution = current(&f, "own-records", &format!("execution:{}", parent.permit)).unwrap();
    let result = current(&f, "own-records", &format!("resource-command-result:{}", parent.permit)).unwrap();
    for kept in [&command, &execution, &result] {
        assert!(!kept.to_string().contains("CANARY_PRIVATE"), "{kept}");
    }
    assert!(read(&mut owner, &f, "pursuit:CANARY_PRIVATE_ID").unwrap().contains("CANARY_PRIVATE_TITLE"));
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn a_retry_returns_the_saved_counts_without_a_second_write() {
    let (f, mut owner) = setup();
    let parent = Parent::new(&mut owner, "retry", json!([{"id":"pursuit:a","type":"pursuit","value":{"title":"A"}}]));
    let first = parent.write(&mut owner).unwrap();
    let before = counts(&f);
    drop(owner);
    let mut owner = f.open().unwrap();
    let again = parent.write(&mut owner).unwrap();
    assert!(again.duplicate);
    assert_eq!(encoded(&again.value), encoded(&first.value));
    assert_eq!(counts(&f), before);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn a_changed_resource_generation_writes_nothing() {
    let (f, mut owner) = setup();
    let parent = Parent::new(&mut owner, "withdrawn", json!([{"id":"pursuit:a","type":"pursuit","value":{"title":"A"}}]));
    let before = counts(&f);
    set_generation(&f, 2);
    assert!(parent.write(&mut owner).is_err());
    assert_eq!(counts(&f), before);
}

/// Filing a document into a pursuit is the old app's own choice record
/// (`record-scope:<record>`, record-scope.mjs set_record_scope): it names the
/// pursuits and no room, so filing into a private pursuit shares nothing.
#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn a_document_filed_into_a_private_pursuit_stays_private() {
    let (f, mut owner) = setup();
    let private = json!({"title":"Private pursuit","now":"Collecting","after":"Filed"});
    let filed = json!({"record":"research-notes.md","pursuits":["pursuit:private"],"kind":"own","changed_at":"2026-10-29T21:00:00.000Z"});
    let answer = Parent::new(&mut owner, "file-into-private", json!([
        {"id":"pursuit:private","type":"pursuit","value":private},
        {"id":"record-scope:research-notes.md","type":"record-scope","value":filed},
    ])).write(&mut owner).unwrap();
    assert_eq!(encoded(&answer.value), r#"{"changed":true,"write_count":2}"#);
    assert_eq!(read(&mut owner, &f, "record-scope:research-notes.md"), Some(same(&filed)));
    let pursuit = read(&mut owner, &f, "pursuit:private").unwrap();
    assert!(!pursuit.contains("space_id"), "a private pursuit gains no room by being filed into");
}

/// A command witnesses its sources in full (state lock, record book, the session's
/// current rights, the selection) only at the boundaries of its one
/// transaction: right after it begins, right before COMMIT and in the delivery
/// read. A write of the most records one command takes is witnessed as often
/// as a write of one, so its cost grows with its rows, not with re-proving the
/// account at every row.
#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn a_command_witnesses_its_sources_at_its_boundaries_never_per_record() {
    let (f, mut owner) = setup();
    let one = Parent::new(&mut owner, "witness-one", json!([{"id":"list:tasks","type":"list","value":tasks_list()}]))
        .write(&mut owner).unwrap();
    let rows: Vec<Value> = (0..256)
        .map(|n| json!({"id":format!("tasks:{n}"),"type":"record:tasks","value":{"title":format!("Row {n}"),"estimate":n}}))
        .collect();
    let many = Parent::new(&mut owner, "witness-many", Value::Array(rows)).write(&mut owner).unwrap();
    assert_eq!(encoded(&many.value), r#"{"changed":true,"write_count":256}"#);
    assert_eq!(one.work.source_witnesses, 3, "after BEGIN, before COMMIT, at delivery");
    assert_eq!(many.work.source_witnesses, one.work.source_witnesses);
    assert_eq!(read(&mut owner, &f, "tasks:255"), Some(same(&json!({"title":"Row 255","estimate":255}))));
}
