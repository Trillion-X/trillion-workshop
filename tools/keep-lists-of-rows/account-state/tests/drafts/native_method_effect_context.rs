use super::*;
use crate::storage::{self, Intent, Scope, Storage};
use rusqlite::{Connection, OpenFlags};
use std::{
    path::Path,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};
use tempfile::TempDir;

const OWNER: &str = "acct/α";
const RESOURCE: &str = "records/primary";
const PERMIT: &str = "permit-α-17";
fn permit_input_identity() -> String {
    "a".repeat(64)
}

struct TestSource {
    store: storage::sqlite::Supply<storage::sqlite::Handle>,
    open: bool,
}

impl TestSource {
    fn as_storage(&self) -> &dyn Storage { &self.store }
    fn finish(mut self) -> storage::Result<()> {
        let result = self.store.close_scope(true);
        self.open = false;
        result
    }
}
impl Drop for TestSource {
    fn drop(&mut self) {
        if self.open {
            let _ = self.store.close_scope(false);
            self.open = false;
        }
    }
}

fn setup() -> (TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = std::fs::canonicalize(dir.path()).unwrap().join("isolated.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE workshop_facts(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity TEXT NOT NULL, value TEXT NOT NULL);
        CREATE INDEX workshop_facts_current ON workshop_facts(entity,seq);
        CREATE TABLE resource_capability_commands(permit_id TEXT PRIMARY KEY,input_identity TEXT NOT NULL,state TEXT NOT NULL,task_id TEXT,result TEXT,execution_ref TEXT,changed_at TEXT NOT NULL);").unwrap();
    (dir, path)
}

fn readonly(path: &Path) -> Connection {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap()
}

fn source(path: &Path) -> TestSource {
    let store = storage::sqlite::open_selected(
        path,
        "capability_task_source",
        storage::sqlite::Selected {
            access: storage::sqlite::Access::Read,
            bounds: storage::sqlite::Bounds {
                value_bytes: MAX_WORKSHOP_TASK_VALUE_BYTES,
                work: 2_000_000,
                deadline: Duration::from_secs(2),
                spend: storage::sqlite::Spend::WholeHandle,
                cancel: Some(std::sync::Arc::new(AtomicBool::new(false))),
                busy: Duration::ZERO,
            },
            meter: None,
            trusted_schema: false,
        },
    )
    .unwrap();
    store.open_scope(Intent::Read).unwrap();
    TestSource { store, open: true }
}

fn put_task(path: &Path, id: &str, json: &str) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row(
            "INSERT INTO workshop_facts(at,entity,value) VALUES('now',?1,?2) RETURNING seq",
            rusqlite::params![format!("task:{id}"), json],
            |row| row.get(0),
        )
        .unwrap()
}

fn task_json(id: &str, extra: &str) -> String {
    let permit_input_identity = permit_input_identity();
    format!(
        r#"{{"task_id":"{id}","tool_id":"native-record-log:read","input":{{"label":"café 🪴"}},"input_identity":"task-input-digest","state":"completed","resource_authorization":{{"command_claim":{{"owner":"{OWNER}","resource":"{RESOURCE}","permit_id":"{PERMIT}","input_identity":"{permit_input_identity}"}}}}{extra}}}"#
    )
}

fn put_permit(path: &Path, state: &str, task_id: Option<&str>) {
    Connection::open(path).unwrap().execute(
        "INSERT INTO resource_capability_commands(permit_id,input_identity,state,task_id,result,execution_ref,changed_at) VALUES(?1,?2,?3,?4,NULL,'execution-ref','now')",
        rusqlite::params![PERMIT, permit_input_identity(), state, task_id],
    ).unwrap();
}

#[test]
fn reads_latest_complete_task_and_keeps_raw_identity_separate_from_task_identity() {
    let (_dir, path) = setup();
    put_task(
        &path,
        "α-not-task-prefixed",
        r#"{"task_id":"α-not-task-prefixed","state":"old"}"#,
    );
    let latest = task_json(
        "α-not-task-prefixed",
        ",\"custom\":{\"nested\":[1,true,null]}",
    );
    let seq = put_task(&path, "α-not-task-prefixed", &latest);
    let mut db = source(&path);
    let got = read_task(
        db.as_storage(),
        "α-not-task-prefixed",
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    assert_eq!(got.identity.seq, seq);
    assert_eq!(
        got.identity.raw_blake3,
        content_crypto::advanced::blake3::hash(latest.as_bytes())
            .to_hex()
            .to_string()
    );
    assert_ne!(got.identity.raw_blake3, "task-input-digest");
    assert!(matches!(got.task, JsonValue::Object(_)));
    assert_eq!(
        string_property(&got.task, "tool_id")
            .unwrap()
            .to_rust_string()
            .unwrap(),
        "native-record-log:read"
    );
    assert_eq!(
        string_property(&got.task, "input_identity")
            .unwrap()
            .to_rust_string()
            .unwrap(),
        "task-input-digest"
    );
    assert!(property(&got.task, "input").is_some());
    assert!(property(&got.task, "resource_authorization").is_some());
    assert!(property(&got.task, "custom").is_some());
    assert!(format!("{got:?}").contains("redacted"));
    db.finish().unwrap();
}

#[test]
fn latest_order_uses_entity_prefix_and_accepts_maximum_positive_sequence() {
    let (_dir, path) = setup();
    let max = i64::MAX;
    let target = task_json("edge", "");
    let neighbor = task_json("other", "");
    Connection::open(&path)
        .unwrap()
        .execute(
            "INSERT INTO workshop_facts(seq,at,entity,value) VALUES(?1,'now','task:edge',?2), (?3,'now','task:other',?4)",
            rusqlite::params![max - 1, target, max, neighbor],
        )
        .unwrap();
    let db = source(&path);
    let got = read_task(
        db.as_storage(),
        "edge",
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    assert_eq!(got.identity.seq, max - 1);
}

#[test]
fn absent_malformed_and_mismatched_tasks_remain_distinct() {
    let (_dir, path) = setup();
    let mut db = source(&path);
    assert!(matches!(read_task(
            db.as_storage(),
            "missing",
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Missing(_)));
    drop(db);
    put_task(&path, "broken", "not-json");
    put_task(&path, "wrong-key", r#"{"task_id":"different"}"#);
    let mut db = source(&path);
    assert!(matches!(read_task(
            db.as_storage(),
            "broken",
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Malformed(_)));
    assert!(matches!(read_task(
            db.as_storage(),
            "wrong-key",
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Mismatch(_)));
}

#[test]
fn unreadable_source_is_not_reported_as_missing() {
    let (_dir, path) = setup();
    Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE workshop_facts;")
        .unwrap();
    let mut db = source(&path);
    assert!(matches!(read_task(
            db.as_storage(),
            "missing",
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Source(_)));
}

#[test]
fn budget_cancel_deadline_and_supplier_support_are_explicit() {
    let (_dir, path) = setup();
    let too_large = format!(
        r#"{{"task_id":"large","payload":"{}"}}"#,
        "x".repeat(MAX_WORKSHOP_TASK_VALUE_BYTES)
    );
    put_task(&path, "large", &too_large);
    let mut db = source(&path);
    assert!(matches!(read_task(
            db.as_storage(),
            "large",
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Budget(_)));
    assert!(matches!(read_task(
            db.as_storage(),
            "large",
            &AtomicBool::new(true),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Cancelled(_)));
    assert!(matches!(read_task(
            db.as_storage(),
            "large",
            &AtomicBool::new(false),
            Instant::now() - Duration::from_secs(1)
        )
        .unwrap_err(), ReadError::Deadline(_)));
}

#[test]
fn unscoped_storage_is_refused_before_reading() {
    let (_dir, path) = setup();
    let db = readonly(&path);
    let store = storage::sqlite::lend(&db, "capability_task_source", storage::sqlite::Access::Read).unwrap();
    assert!(matches!(read_task(
            &store as &dyn Storage,
            "missing",
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Source(_)));
}

#[test]
fn undeclared_family_is_reported_as_unsupported() {
    let (_dir, path) = setup();
    let db = readonly(&path);
    let store = storage::sqlite::lend(&db, "account_policy", storage::sqlite::Access::Read).unwrap();
    let scope = Scope::begin(&store, Intent::Read).unwrap();
    assert!(matches!(read_task(
            &*scope,
            "missing",
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Unsupported(_)));
}

#[test]
fn moved_storage_custody_is_not_reported_as_a_task_read() {
    let (_dir, path) = setup();
    let db = readonly(&path);
    let store = storage::sqlite::lend(&db, "capability_task_source", storage::sqlite::Access::Read).unwrap();
    let scope = Scope::begin(&store, Intent::Read).unwrap();
    std::fs::rename(&path, path.with_extension("moved")).unwrap();
    assert!(matches!(read_task(
            &*scope,
            "missing",
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Source(_)));
}

#[test]
fn currentness_requires_fresh_snapshot_and_detects_row_replacement() {
    let (_dir, path) = setup();
    let first = task_json("drift", "");
    put_task(&path, "drift", &first);
    let mut old = source(&path);
    let snapshot = read_task(
        old.as_storage(),
        "drift",
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    put_task(
        &path,
        "drift",
        &task_json("drift", ",\"state\":\"changed\""),
    );
    assert!(
        matches_snapshot(
            old.as_storage(),
            "drift",
            &snapshot.identity,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap(),
        "a held SQLite snapshot cannot see later commits"
    );
    let mut fresh = source(&path);
    assert!(!matches_snapshot(
        fresh.as_storage(),
        "drift",
        &snapshot.identity,
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(2)
    )
    .unwrap());
}

#[test]
fn exact_resource_permit_claim_associates_task_without_inventing_effect() {
    let (_dir, path) = setup();
    let json = task_json("cap-task", "");
    put_task(&path, "cap-task", &json);
    put_permit(&path, "committed", Some("cap-task"));
    let mut db = source(&path);
    let task = read_permitted_task(
        db.as_storage(),
        OWNER,
        RESOURCE,
        PERMIT,
        &permit_input_identity(),
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap();
    assert_eq!(
        string_property(&task.task, "task_id")
            .unwrap()
            .to_rust_string()
            .unwrap(),
        "cap-task"
    );
    assert!(property(&task.task, "effect").is_none());
    db.finish().unwrap();
}

#[test]
fn changed_current_input_cannot_reuse_old_permit_and_task() {
    let (_dir, path) = setup();
    put_task(&path, "cap-task", &task_json("cap-task", ""));
    put_permit(&path, "admitted", Some("cap-task"));
    let mut db = source(&path);
    assert!(matches!(read_permitted_task(
            db.as_storage(),
            OWNER,
            RESOURCE,
            PERMIT,
            &"b".repeat(64),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::NotLinked(_)));
    // Restoring the exact current original input permits the physical join.
    assert!(read_permitted_task(
        db.as_storage(),
        OWNER,
        RESOURCE,
        PERMIT,
        &permit_input_identity(),
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(2)
    )
    .is_ok());
    db.finish().unwrap();
}

#[test]
fn unknown_permit_state_and_wrong_store_remain_unavailable() {
    let (_dir, path) = setup();
    put_task(&path, "cap-task", &task_json("cap-task", ""));
    put_permit(&path, "unknown", Some("cap-task"));
    let mut db = source(&path);
    assert!(matches!(read_permitted_task(
            db.as_storage(),
            OWNER,
            RESOURCE,
            PERMIT,
            &permit_input_identity(),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Unsupported(_)));
    drop(db);
    Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE resource_capability_commands;")
        .unwrap();
    let mut db = source(&path);
    assert!(matches!(read_permitted_task(
            db.as_storage(),
            OWNER,
            RESOURCE,
            PERMIT,
            &permit_input_identity(),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Source(_)));
}

#[test]
fn maximum_supported_permit_retains_exact_claim_without_lower_row_budget() {
    let (_dir, path) = setup();
    let permit = "p".repeat(MAX_RESOURCE_CLAIM_BYTES);
    let task = task_json("cap-task", "").replace(PERMIT, &permit);
    put_task(&path, "cap-task", &task);
    let db = Connection::open(&path).unwrap();
    db.execute("INSERT INTO resource_capability_commands(permit_id,input_identity,state,task_id,changed_at) VALUES(?1,?2,'admitted','cap-task','now')", rusqlite::params![permit, permit_input_identity()]).unwrap();
    drop(db);
    let mut source = source(&path);
    assert!(read_permitted_task(
        source.as_storage(),
        OWNER,
        RESOURCE,
        &permit,
        &permit_input_identity(),
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(2)
    )
    .is_ok());
    source.finish().unwrap();
}

#[test]
fn parser_resource_limit_is_a_budget_refusal_with_useful_resumption() {
    let (_dir, path) = setup();
    let deep = format!(
        r#"{{"task_id":"deep","data":{}0{}}}"#,
        "[".repeat(200),
        "]".repeat(200)
    );
    put_task(&path, "deep", &deep);
    let mut db = source(&path);
    assert!(matches!(read_task(
            db.as_storage(),
            "deep",
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Budget(_)));
    drop(db);
    put_task(&path, "deep", &task_json("deep", ""));
    let mut db = source(&path);
    assert!(read_task(
        db.as_storage(),
        "deep",
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(2)
    )
    .is_ok());
    db.finish().unwrap();
}

#[test]
fn permit_absence_abort_and_unassociated_task_are_not_success() {
    let (_dir, path) = setup();
    let mut db = source(&path);
    assert!(matches!(read_permitted_task(
            db.as_storage(),
            OWNER,
            RESOURCE,
            PERMIT,
            &permit_input_identity(),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::NoPermit(_)));
    drop(db);
    put_permit(&path, "aborted", None);
    let mut db = source(&path);
    assert!(matches!(read_permitted_task(
            db.as_storage(),
            OWNER,
            RESOURCE,
            PERMIT,
            &permit_input_identity(),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Aborted(_)));
    drop(db);
    let (_dir, path) = setup();
    put_permit(&path, "admitted", None);
    let mut db = source(&path);
    assert!(matches!(read_permitted_task(
            db.as_storage(),
            OWNER,
            RESOURCE,
            PERMIT,
            &permit_input_identity(),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::Unassociated(_)));
}

#[test]
fn mismatched_claim_cannot_associate_another_resource_task() {
    let (_dir, path) = setup();
    let json = task_json("cap-task", "").replace(RESOURCE, "records/other");
    put_task(&path, "cap-task", &json);
    put_permit(&path, "committed", Some("cap-task"));
    let mut db = source(&path);
    assert!(matches!(read_permitted_task(
            db.as_storage(),
            OWNER,
            RESOURCE,
            PERMIT,
            &permit_input_identity(),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(2)
        )
        .unwrap_err(), ReadError::NotLinked(_)));
}
