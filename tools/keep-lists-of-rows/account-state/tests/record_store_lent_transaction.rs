//! record store on one connection: record store and a native command share the command's
//! already-open IMMEDIATE SQLite transaction (no second connection), and
//! `own_records::InCommand` writes the command's records and keys as the
//! account's current records inside it. Scratch data only, with current-rights,
//! version, migration-phase, key-custody and exact retry controls.

use rusqlite::Connection;
use serde_json::json;
use std::{collections::BTreeMap, time::Duration};
use trillion_local::{
    legacy_records::StoredRecord,
    local_account::own_records::InCommand,
    record_value::KeyState,
    records::{Error, Mutation},
    storage::{
        record_store::{native::body, settings, RecordStore, RealClock},
        sqlite::{self, Access, Bounds, Spend},
    },
};

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

fn stored(value: &str) -> StoredRecord {
    StoredRecord {
        id: "selected".into(), record_type: "setting".into(),
        sequence: "sequence-1".into(), value_json: value.into(),
        meta_json: None, protected_key_present: false,
    }
}

fn current(db: &Connection) -> RecordStore<sqlite::Supply<&Connection>> {
    let supply = sqlite::lend(db, "record_store", Access::Write).unwrap();
    let limits = settings::Limits::fixed(1 << 20, 10 << 30);
    RecordStore::new(supply, Box::new(RealClock), limits).unwrap()
}

fn mutation(expected_version: i64, key: &str, answer: &str) -> Mutation {
    Mutation {
        id: "selected".into(),
        expected_version,
        request_key: key.into(),
        deleted: false,
        value: json!({"answer":answer}),
    }
}

#[test]
fn command_and_record_store_value_commit_or_refuse_together_on_one_connection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("account.sqlite");
    // The existing owner installs record store's declared tables once. The pilot then
    // uses the same account file and the native writer's transaction shape.
    drop(sqlite::open_owned(&path, "record_store", bounds()).unwrap());
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE command_receipt(key TEXT PRIMARY KEY, answer TEXT NOT NULL)").unwrap();

    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    db.execute("INSERT INTO command_receipt VALUES(?1,?2)", ("save-1", "one")).unwrap();
    {
        let mut store = current(&db);
        let first = store.mutate_local_with_check("account", "own-records", mutation(0, "save-1", "one"), || Ok(())).unwrap();
        assert_eq!(first.version, 1);
        assert_eq!(store.get_many("account", "own-records", &["selected"]).unwrap()[0].as_ref().unwrap().value["answer"], "one");
    }
    db.execute_batch("COMMIT").unwrap();

    // The next independently opened reader sees the committed value.
    drop(db);
    let db = Connection::open(&path).unwrap();
    assert_eq!(current(&db).get_many("account", "own-records", &["selected"]).unwrap()[0].as_ref().unwrap().value["answer"], "one");
    assert_eq!(db.query_row("SELECT COUNT(*) FROM command_receipt", [], |row| row.get::<_, i64>(0)).unwrap(), 1);

    // An exact retry returns the first change and makes no second receipt.
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let before = db.total_changes();
    let mut store = current(&db);
    let replay = store.mutate_local_with_check("account", "own-records", mutation(0, "save-1", "one"), || Ok(())).unwrap();
    assert_eq!(replay.version, 1);
    drop(store);
    assert_eq!(db.total_changes(), before);
    db.execute_batch("COMMIT").unwrap();

    // Refused rights roll back the command and leave the value unchanged.
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    db.execute("INSERT INTO command_receipt VALUES(?1,?2)", ("save-2", "two")).unwrap();
    let denied = current(&db).mutate_local_with_check("account", "own-records", mutation(1, "save-2", "two"), || Err(trillion_local::cause!(Error::Unavailable)));
    assert!(matches!(denied, Err(Error::Unavailable(_))));
    db.execute_batch("ROLLBACK").unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM command_receipt", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(current(&db).get_many("account", "own-records", &["selected"]).unwrap()[0].as_ref().unwrap().value["answer"], "one");

    // An outer transaction that rolls back after record store's savepoint also rolls
    // back both the command receipt and the new current value.
    let mut rolled_back_store = current(&db);
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    db.execute("INSERT INTO command_receipt VALUES(?1,?2)", ("save-rollback", "temporary")).unwrap();
    let temporary = rolled_back_store.mutate_local_with_check("account", "own-records", mutation(1, "save-rollback", "temporary"), || Ok(())).unwrap();
    assert_eq!(temporary.version, 2);
    db.execute_batch("ROLLBACK").unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM command_receipt", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(rolled_back_store.get_many("account", "own-records", &["selected"]).unwrap()[0].as_ref().unwrap().value["answer"], "one");
    drop(rolled_back_store);

    // A stale version cannot create a new value or command receipt.
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    db.execute("INSERT INTO command_receipt VALUES(?1,?2)", ("save-3", "stale")).unwrap();
    let stale = current(&db).mutate_local_with_check("account", "own-records", mutation(0, "save-3", "stale"), || Ok(()));
    assert!(matches!(stale, Err(Error::Conflict(_))));
    db.execute_batch("ROLLBACK").unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM command_receipt", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(current(&db).get_many("account", "own-records", &["selected"]).unwrap()[0].as_ref().unwrap().value["answer"], "one");
}

/// Prefill the migration's position record as the startup task leaves it.
fn prefill_position(db: &Connection, position: serde_json::Value) {
    current(db).mutate_local_with_check("account", "own-records-position", Mutation {
        id: "position".into(),
        expected_version: 0,
        request_key: "prefill-position".into(),
        deleted: false,
        value: position,
    }, || Ok(())).unwrap();
}

fn held(db: &Connection) -> Option<serde_json::Value> {
    current(db).get_many("account", "own-records", &["selected"]).unwrap().pop().unwrap().map(|record| record.value)
}

fn key_record(db: &Connection) -> Option<serde_json::Value> {
    current(db).get_many("account", "own-record-keys", &["selected"]).unwrap().pop().unwrap().map(|record| record.value)
}

fn limits() -> settings::Limits {
    settings::Limits::fixed(1 << 20, 10 << 30)
}

fn installed(dir: &tempfile::TempDir) -> std::path::PathBuf {
    let path = dir.path().canonicalize().unwrap().join("account.sqlite");
    drop(sqlite::open_owned(&path, "record_store", bounds()).unwrap());
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE original_command(id TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
    path
}

#[test]
fn a_ready_phase_without_the_required_copy_frontier_remains_unready() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(&dir);
    let db = Connection::open(&path).unwrap();
    prefill_position(&db, json!({"phase": "ready", "watermark": 0}));
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert!(!InCommand::lend(&db, "account", limits()).unwrap().ready().unwrap());
    db.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn a_commands_records_and_keys_commit_or_roll_back_with_the_command() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(&dir);
    let db = Connection::open(&path).unwrap();
    // Match the current startup producer: Ready includes every declared copy.
    let copied = trillion_local::storage::record_store_resources::copies()
        .map(|(row, copy)| copy.name(row))
        .collect::<Vec<_>>();
    prefill_position(&db, json!({"phase": "ready", "watermark": 0, "copied": copied}));
    let first = stored(r#"{"value":1}"#);
    let forms = BTreeMap::from([("selected".to_owned(), Some(first))]);
    let key = [7u8; 32];

    // The command rolls back after record store's savepoints closed: neither the form nor the key survives.
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    db.execute("INSERT INTO original_command VALUES ('one', '1')", []).unwrap();
    let mut records = InCommand::lend(&db, "account", limits()).unwrap();
    assert!(records.ready().unwrap());
    assert_eq!(records.write(&forms, &[("selected", &key)], "log-1", || Ok(())).unwrap(), 2);
    assert_eq!(records.stored("selected").unwrap().unwrap().value_json, r#"{"value":1}"#, "the command reads its own write");
    assert!(matches!(records.key("selected").unwrap(), KeyState::Present(_)));
    drop(records);
    db.execute_batch("ROLLBACK").unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM original_command", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert!(held(&db).is_none());
    assert!(key_record(&db).is_none());

    // The command commits: a fresh connection reads the stored form and its key.
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    db.execute("INSERT INTO original_command VALUES ('one', '1')", []).unwrap();
    InCommand::lend(&db, "account", limits()).unwrap().write(&forms, &[("selected", &key)], "log-1", || Ok(())).unwrap();
    db.execute_batch("COMMIT").unwrap();
    drop(db);
    let db = Connection::open(&path).unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM original_command", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(held(&db), Some(body(forms["selected"].as_ref().unwrap())));
    assert!(key_record(&db).is_some());

    // The same forms again write nothing; a second key for the record is a conflict, never a replacement.
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let before = db.total_changes();
    let mut records = InCommand::lend(&db, "account", limits()).unwrap();
    assert_eq!(records.write(&forms, &[], "log-2", || Ok(())).unwrap(), 0);
    assert_eq!(db.total_changes(), before);
    assert!(matches!(records.write(&forms, &[("selected", &[8u8; 32])], "log-3", || Ok(())), Err(Error::Conflict(_))));
    drop(records);
    db.execute_batch("ROLLBACK").unwrap();

    // A deletion by the next command removes the current record; the id is no longer fresh.
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut records = InCommand::lend(&db, "account", limits()).unwrap();
    records.write(&BTreeMap::from([("selected".to_owned(), None)]), &[], "log-4", || Ok(())).unwrap();
    assert!(records.stored("selected").unwrap().is_none());
    assert!(records.ever_held("selected").unwrap());
    drop(records);
    db.execute_batch("COMMIT").unwrap();
    assert!(held(&db).is_none());
}

#[test]
fn outside_a_write_transaction_refused_rights_or_a_misnamed_form_write_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(&dir);
    let db = Connection::open(&path).unwrap();
    let first = stored(r#"{"value":1}"#);
    let forms = BTreeMap::from([("selected".to_owned(), Some(first))]);

    // Outside the command's write transaction the store refuses to open; before Ready it says so.
    assert!(matches!(InCommand::lend(&db, "account", limits()), Err(Error::Unavailable(_))));
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert!(!InCommand::lend(&db, "account", limits()).unwrap().ready().unwrap());
    db.execute_batch("ROLLBACK").unwrap();
    prefill_position(&db, json!({"phase": "journal", "watermark": 0}));
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert!(!InCommand::lend(&db, "account", limits()).unwrap().ready().unwrap());

    // Refused rights roll back only the write's savepoint; the owner still decides its command.
    db.execute("INSERT INTO original_command VALUES ('one', '1')", []).unwrap();
    let refused = InCommand::lend(&db, "account", limits()).unwrap().write(&forms, &[], "log-1", || Err(trillion_local::cause!(Error::Unavailable)));
    assert!(matches!(refused, Err(Error::Unavailable(_))));
    db.execute_batch("COMMIT").unwrap();
    assert!(held(&db).is_none());
    assert_eq!(db.query_row("SELECT COUNT(*) FROM original_command", [], |row| row.get::<_, i64>(0)).unwrap(), 1);

    // A form under another id, or a key for a record this write does not name, refuses.
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut records = InCommand::lend(&db, "account", limits()).unwrap();
    let misnamed = BTreeMap::from([("other".to_owned(), Some(stored(r#"{"value":1}"#)))]);
    assert!(matches!(records.write(&misnamed, &[], "log-2", || Ok(())), Err(Error::Invalid(_, _))));
    assert!(matches!(records.write(&BTreeMap::new(), &[("selected", &[7u8; 32])], "log-3", || Ok(())), Err(Error::Invalid(_, _))));
    drop(records);
    db.execute_batch("ROLLBACK").unwrap();
}
