// tests/local_account_cold.rs
//
// Purpose: Exercise cold account custody against synthetic existing schemas.
// Non-Negotiable Invariants: preserve existing sessions and source schemas;
// never replace another lock or bootstrap missing policy/account state.
// Key Concepts: real SQLite/WAL readers, existing lock protocol, fresh policy.
// Security Considerations: synthetic account/session material only; these tests
// prove source custody and reads, not installed account authorization or UI.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

#![cfg(unix)]
use rusqlite::Connection;
use content_crypto::advanced::blake3;
use serde_json::{json, Value};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};
use trillion_local::{
    account::{
        current_browser, NativeAccountOwner,
    },
    import::FilePin,
    local_account::{LocalAccount, ProcessIdentity, SelectedLocalState},
};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    pin: FilePin,
    session: String,
    kv: PathBuf,
    policy: PathBuf,
    blob: PathBuf,
    user: String,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        // The account's installed tools declare the record kinds these tests read and write.
        installed_tools::install(&root);
        let owner = "a".repeat(64);
        let token = "b".repeat(64);
        let session = blake3::hash(token.as_bytes()).to_hex().to_string();
        // An account of its own: open sign-ins of this process are found by account name.
        let user = format!("synthetic-user-{}", temp.path().file_name().unwrap().to_string_lossy());
        fs::write(root.join("browser-session.key"), &token).unwrap();
        fs::set_permissions(
            root.join("browser-session.key"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let policy = root.join("policy.sqlite");
        let db = Connection::open(&policy).unwrap();
        db.execute_batch(
            "CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL);",
        )
        .unwrap();
        for (name, value) in [
            ("revision", json!(1)),
            ("policy-source", json!({"from":"born","missing":[]})),
            ("policy-source:account", json!({"lifecycle":{},"access":{},"account_controls":{"owner_user_id":user}})),
        ] {
            db.execute(
                "INSERT INTO policy_directory VALUES(?,?)",
                [name, &value.to_string()],
            )
            .unwrap();
        }
        db.close().unwrap();
        let kv_folder = root.join("storage/kv/trillion-local-app");
        fs::create_dir_all(kv_folder.join("blobs")).unwrap();
        let kv = kv_folder.join("current.sqlite");
        let db = Connection::open(&kv).unwrap();
        db.execute_batch("CREATE TABLE _mf_entries(key TEXT PRIMARY KEY,blob_id TEXT NOT NULL,expiration INTEGER);").unwrap();
        db.close().unwrap();
        let blob = kv_folder.join("blobs/aa");
        fs::write(
            &blob,
            serde_json::to_vec(&json!({"userId":user,"preserved":true})).unwrap(),
        )
        .unwrap();
        let index = serde_json::to_vec(
            &json!({"binding":"ACCOUNT_CONTROL","originalId":"c".repeat(64),
            "names":[format!("policy:{owner}")],"sqlite":"policy.sqlite"}),
        )
        .unwrap();
        fs::write(root.join("objects.jsonl"), &index).unwrap();
        let receipt=serde_json::to_vec(&json!({"complete":true,"account":{"userId":user,"ownerId":owner},
            "objects":{"path":"objects.jsonl","bytes":index.len(),"fileIdentity":blake3::hash(&index).to_hex().as_str(),"count":1}})).unwrap();
        fs::write(root.join("restore-receipt.json"), &receipt).unwrap();
        let pin = FilePin {
            bytes: receipt.len() as u64,
            blake3: blake3::hash(&receipt).to_hex().to_string(),
        };
        Self {
            _temp: temp,
            root,
            pin,
            session,
            kv,
            policy,
            blob,
            user,
        }
    }
    fn selection(&self) -> SelectedLocalState {
        SelectedLocalState {
            root: self.root.clone(),
            receipt: self.pin.clone(),
            app_kv_sqlite: self.kv.strip_prefix(&self.root).unwrap().into(),
            app_kv_store: "trillion-local-app".into(),
            prior_processes: vec![],
        }
    }
    fn open(&self) -> Result<LocalAccount, trillion_local::account::AccountError> {
        LocalAccount::open_selected_after_handoff(self.selection())
    }
    fn lock(&self) -> PathBuf {
        self.root.join("local-runtime.lock")
    }
    fn with_workspace(mut self, resource: &str) -> Self {
        let db = Connection::open(self.root.join("records.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE workspace_records(label TEXT PRIMARY KEY,value TEXT NOT NULL,written_at TEXT NOT NULL); INSERT INTO workspace_records VALUES('saved-board','{\"items\":[\"kept\"]}','original-time');").unwrap();
        db.close().unwrap();
        let mut index = fs::read(self.root.join("objects.jsonl")).unwrap();
        index.push(b'\n');
        let name = format!(
            "own-record-resource:{}",
            serde_json::to_string(&["a".repeat(64), resource.into()]).unwrap()
        );
        index.extend(serde_json::to_vec(&json!({"binding":"RECORD_BOOK","originalId":"d".repeat(64),"names":[name],"sqlite":"records.sqlite"})).unwrap());
        fs::write(self.root.join("objects.jsonl"), &index).unwrap();
        let mut receipt: Value =
            serde_json::from_slice(&fs::read(self.root.join("restore-receipt.json")).unwrap())
                .unwrap();
        receipt["objects"]["bytes"] = json!(index.len());
        receipt["objects"]["fileIdentity"] = json!(blake3::hash(&index).to_hex().as_str());
        receipt["objects"]["count"] = json!(2);
        let bytes = serde_json::to_vec(&receipt).unwrap();
        fs::write(self.root.join("restore-receipt.json"), &bytes).unwrap();
        self.pin = FilePin {
            bytes: bytes.len() as u64,
            blake3: blake3::hash(&bytes).to_hex().to_string(),
        };
        self
    }
}

#[test]
fn cold_open_drop_restart_keeps_original_session_and_main_database_bytes() {
    let f = Fixture::new();
    let before = (fs::read(&f.policy).unwrap(), fs::read(&f.kv).unwrap());
    for _ in 0..2 {
        let mut owner = f.open().unwrap();
        assert!(f.lock().exists());
        assert_eq!(owner.session_identity().as_str(), f.session);
        owner.assert_source_current().unwrap();
        drop(owner);
        assert!(!f.lock().exists());
    }
    assert_eq!(fs::read(&f.policy).unwrap(), before.0);
    assert_eq!(fs::read(&f.kv).unwrap(), before.1);
}
#[test]
fn second_cold_open_refuses_and_never_removes_first_owners_lock() {
    let f = Fixture::new();
    let owner = f.open().unwrap();
    let bytes = fs::read(f.lock()).unwrap();
    assert!(f.open().is_err());
    assert_eq!(fs::read(f.lock()).unwrap(), bytes);
    drop(owner);
    assert!(!f.lock().exists());
}
#[test]
fn a_held_lock_refuses_unchanged_and_a_free_one_is_taken_over_whatever_it_holds() {
    use std::os::fd::AsRawFd;
    let f = Fixture::new();
    let bytes = b"unknown retained lock recovery state";
    fs::write(f.lock(), bytes).unwrap();
    fs::set_permissions(f.lock(), fs::Permissions::from_mode(0o600)).unwrap();
    // Held: another open file holds the lock's flock, as a live engine does.
    let holder = fs::File::open(f.lock()).unwrap();
    assert_eq!(unsafe { libc::flock(holder.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }, 0);
    assert!(f.open().is_err());
    assert_eq!(fs::read(f.lock()).unwrap(), bytes);
    drop(holder);
    // Free: no one holds it, whatever the file says, so the open takes it over in place. Another test's child holds a
    // copy of every open file between its fork and its exec, so the free lock is tried for up to 2 s.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let owner = loop {
        match f.open() {
            Ok(owner) => break owner,
            Err(_) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(10)),
            Err(error) => panic!("a free lock is taken over: {error}"),
        }
    };
    let record: Value = serde_json::from_slice(&fs::read(f.lock()).unwrap()).unwrap();
    assert_eq!(record["pid"], std::process::id());
    drop(owner);
    assert!(!f.lock().exists());
}
#[test]
fn live_prior_incarnation_refuses_before_creating_a_lock() {
    let f = Fixture::new();
    let mut selected = f.selection();
    selected.prior_processes.push(
        ProcessIdentity::observe(std::process::id())
            .unwrap()
            .unwrap(),
    );
    assert!(LocalAccount::open_selected_after_handoff(selected).is_err());
    assert!(!f.lock().exists());
}
#[test]
fn invalid_receipt_missing_policy_and_wrong_session_remove_only_their_new_state_lock() {
    let f = Fixture::new();
    let mut selected = f.selection();
    selected.receipt.blake3 = "0".repeat(64);
    assert!(LocalAccount::open_selected_after_handoff(selected).is_err());
    assert!(!f.lock().exists());
    fs::remove_file(&f.policy).unwrap();
    assert!(f.open().is_err());
    assert!(!f.lock().exists());
    // An app key-value blob that no row names is not read by the opener: a blob naming another user changes
    // nothing, the account opens, and dropping the owner removes only the state lock it made. (Before the opener could
    // read process start times off macOS this open always failed here, which hid that the blob is never read.)
    let f = Fixture::new();
    fs::write(&f.blob, b"{\"userId\":\"other-synthetic-user\"}").unwrap();
    let owner = f.open().expect("an unnamed blob is not read");
    assert!(f.lock().exists());
    drop(owner);
    assert!(!f.lock().exists());
}
#[test]
fn selected_source_removal_refuses_and_changed_lock_is_never_unlinked_on_drop() {
    let f = Fixture::new();
    let mut owner = f.open().unwrap();
    fs::remove_file(f.root.join("browser-session.key")).unwrap();
    assert!(owner.assert_source_current().is_err());
    fs::write(f.lock(), b"replacement owner or uncertain recovery").unwrap();
    drop(owner);
    assert_eq!(
        fs::read(f.lock()).unwrap(),
        b"replacement owner or uncertain recovery"
    );
}
#[test]
fn in_place_protected_token_replacement_withdraws_current_source() {
    let f = Fixture::new();
    let mut owner = f.open().unwrap();
    fs::write(f.root.join("browser-session.key"), "d".repeat(64)).unwrap();
    assert!(owner.assert_source_current().is_err());
    drop(owner);
    assert!(!f.lock().exists());
}
#[test]
fn receipt_and_index_changes_withdraw_mounted_selection_without_replacing_sources() {
    for name in ["restore-receipt.json", "objects.jsonl"] {
        let f = Fixture::new();
        let mut owner = f.open().unwrap();
        let path = f.root.join(name);
        let mut bytes = fs::read(&path).unwrap();
        bytes[0] = b' ';
        fs::write(&path, &bytes).unwrap();
        assert!(owner.assert_source_current().is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        drop(owner);
        assert!(!f.lock().exists());
    }
}
#[test]
fn sqlite_sidecar_aliases_refuse_before_touching_the_target() {
    use std::os::unix::fs::symlink;
    for suffix in ["-wal", "-shm"] {
        let f = Fixture::new();
        let target = f.root.join("outside-private-fixture");
        fs::write(&target, b"preserve me").unwrap();
        let mut alias = f.policy.as_os_str().to_os_string();
        alias.push(suffix);
        symlink(&target, PathBuf::from(alias)).unwrap();
        assert!(f.open().is_err());
        assert!(!f.lock().exists());
        assert_eq!(fs::read(target).unwrap(), b"preserve me");
    }
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn another_resource_never_supplies_workspace_labels_and_cancellation_returns_no_values() {
    use std::sync::{atomic::AtomicBool, Arc};
    let wrong = Fixture::new().with_workspace("@different-records");
    let mut owner = wrong.open().unwrap();
    assert!(owner
        .workspace_snapshot(&wrong.session, None, Arc::new(AtomicBool::new(false)))
        .is_err());
    drop(owner);
    let f = Fixture::new().with_workspace("@own-records");
    let mut owner = f.open().unwrap();
    assert!(owner
        .workspace_snapshot(&f.session, None, Arc::new(AtomicBool::new(true)))
        .is_err());
}

// These fixtures exercise the same LocalAccount mount as the workspace
// projection, but use the actual retained record-log/EEAF table vocabulary.
// The result is a stored representation; none of these fixtures asserts
// plaintext resolution, actual-account parity or the aggregate cloud bill.
fn add_current_record_log(f: &Fixture, value_json: &str) {
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
        INSERT INTO record_keys_meta VALUES('engine','\"record-log\"');
        CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT);
        CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER);
        CREATE TABLE record_keys_big(ref TEXT,part INTEGER,body TEXT,PRIMARY KEY(ref,part)) WITHOUT ROWID;
        CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT NOT NULL)").unwrap();
    let key = "i\0root";
    let first = serde_json::to_string(key).unwrap();
    db.execute("INSERT INTO record_keys_runs VALUES(1,1,1,?,0,1)", [&first])
        .unwrap();
    db.execute(
        "INSERT INTO record_keys_run_1 VALUES(0,?,?)",
        rusqlite::params![first, current_record_page(value_json)],
    )
    .unwrap();
}

fn current_record_page(value_json: &str) -> String {
    let value =
        format!("[\"page\",\"retained-sequence\",{value_json},{{\"at\":\"retained-stamp\"}}]");
    format!(
        "{}\n{value}",
        json!({"p":[0],"s":["i\0root"],"d":[value.encode_utf16().count()]})
    )
}

/// One later write of `root`, the way the record log records it: a journal row whose envelope sets the value, with a
/// later time and sequence than the checkpoint's. The account's own records follow the journal; a checkpoint page is
/// never rewritten by a write.
fn journal_current_record(db: &Connection, log_id: &str, value_json: &str, sequence: &str) {
    let envelopes = format!(
        "[{{\"id\":\"root\",\"type\":\"page\",\"value\":{value_json},\"at\":\"z\",\"seq\":\"{sequence}\"}}]"
    );
    db.execute(
        "INSERT INTO record_log(id,transaction_id,actor_context,application_time,system_time,part,parts,envelopes) VALUES(?1,'retained-transaction','retained-actor','valid-time','system-time',0,1,?2)",
        rusqlite::params![log_id, envelopes],
    )
    .unwrap();
}

/// The account's first start: fill its own records (record store) from the original records, as the native startup task
/// does before the app is served. A read's write count is measured after it.
fn first_start(owner: &mut LocalAccount, session: &str) {
    use trillion_local::local_account::own_records::Step;
    loop {
        let step = owner
            .own_records_step(session, std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)))
            .unwrap();
        if step == Step::Ready {
            return;
        }
    }
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn first_start_carries_the_original_workspace_records_into_the_workspace_store() {
    use std::sync::{atomic::AtomicBool, Arc};
    use trillion_local::{ecma_json, workspace_store::Selection};

    let fixture = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&fixture, r#"{"answer":"one"}"#);
    let mut owner = fixture.open().unwrap();
    first_start(&mut owner, &fixture.session);
    let selection = Selection { labels: vec!["saved-board".into()], prefixes: vec![] };
    let snapshot = owner
        .workspace_snapshot(&fixture.session, Some(&selection), Arc::new(AtomicBool::new(false)))
        .unwrap();
    assert_eq!(snapshot.records.len(), 1);
    assert_eq!(snapshot.records[0].0, "saved-board");
    assert_eq!(
        ecma_json::stringify(&snapshot.records[0].1, ecma_json::Limits::default()).unwrap(),
        r#"{"items":["kept"]}"#
    );
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn one_current_record_separates_first_repeat_restart_and_old_write_work() {
    use std::sync::{atomic::AtomicBool, Arc};

    let fixture = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&fixture, r#"{"answer":"one"}"#);
    let mut owner = fixture.open().unwrap();
    let opened = owner.sql_work().unwrap();
    let first = owner
        .current_stored_record(&fixture.session, "root", Arc::new(AtomicBool::new(false)))
        .unwrap()
        .unwrap();
    let after_first = owner.sql_work().unwrap();
    assert_eq!(first.id, "root");
    assert_eq!(first.value_json, r#"{"answer":"one"}"#);
    assert!(after_first.work.rows_written > opened.work.rows_written, "the first read finishes the small account's migration");

    let repeat = owner
        .current_stored_record(&fixture.session, "root", Arc::new(AtomicBool::new(false)))
        .unwrap()
        .unwrap();
    let after_repeat = owner.sql_work().unwrap();
    assert_eq!(repeat.id, first.id);
    assert_eq!(repeat.record_type, first.record_type);
    assert_eq!(repeat.sequence, first.sequence);
    assert_eq!(repeat.value_json, first.value_json);
    assert_eq!(repeat.meta_json, first.meta_json);
    assert_eq!(repeat.protected_key_present, first.protected_key_present);
    assert_eq!(after_repeat.work.rows_written, after_first.work.rows_written);

    drop(owner);
    let mut owner = fixture.open().unwrap();
    let before_restart = owner.sql_work().unwrap();
    let restarted = owner
        .current_stored_record(&fixture.session, "root", Arc::new(AtomicBool::new(false)))
        .unwrap().unwrap();
    let after_restart = owner.sql_work().unwrap();
    assert_eq!(restarted.value_json, first.value_json);
    assert_eq!(after_restart.work.rows_written, before_restart.work.rows_written, "a restart reads the ready store without writing");

    // Nothing writes the retired journal any more; a row appended there after Ready is not the account's record.
    let writer = Connection::open(fixture.root.join("records.sqlite")).unwrap();
    journal_current_record(&writer, "01234567-89ab-7cde-8f01-234567890ab1", r#"{"answer":"two"}"#, "z-revision-2");
    drop(writer);
    let before_old_write = owner.sql_work().unwrap();
    let unchanged = owner
        .current_stored_record(&fixture.session, "root", Arc::new(AtomicBool::new(false)))
        .unwrap().unwrap();
    let after_old_write = owner.sql_work().unwrap();
    assert_eq!(unchanged.value_json, first.value_json);
    assert_eq!(after_old_write.work.rows_written, before_old_write.work.rows_written, "a read follows no journal");

    for (phase, before, after) in [
        ("first", &opened, &after_first),
        ("repeat", &after_first, &after_repeat),
        ("restart", &before_restart, &after_restart),
        ("old-write", &before_old_write, &after_old_write),
    ] {
        eprintln!(
            "one-current-record-work phase={phase} statements={} visits={} writes={} rows_returned={} unattributed_rows={}",
            after.work.sql_statements - before.work.sql_statements,
            after.work.sqlite_scan_visits - before.work.sqlite_scan_visits,
            after.work.rows_written - before.work.rows_written,
            after.work.rows_returned - before.work.rows_returned,
            after.unattributed_row_events - before.unattributed_row_events,
        );
        for (previous, current) in before.families.iter().zip(after.families.iter()) {
            let sql = current.work.sql_statements - previous.work.sql_statements;
            let visits = current.work.sqlite_scan_visits - previous.work.sqlite_scan_visits;
            if sql != 0 || visits != 0 {
                eprintln!("one-current-record-family phase={phase} family={} sql={sql} visits={visits}", current.family.label());
            }
        }
    }
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn current_account_record_mount_preserves_stored_lexical_bytes_and_restart() {
    use std::sync::{atomic::AtomicBool, Arc};
    let f = Fixture::new().with_workspace("@own-records");
    let value = r#"{"z":1.00,"a":1e2,"z":3}"#;
    add_current_record_log(&f, value);
    let path = f.root.join("records.sqlite");
    // The first read fills the account's own records (record store) in the same file; every read after it writes nothing.
    let mut before = None;
    for _ in 0..2 {
        let mut owner = f.open().unwrap();
        let record = owner
            .current_stored_record(
                &f.session,
                "root",
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap()
            .unwrap();
        assert_eq!(record.id, "root");
        assert_eq!(record.record_type, "page");
        assert_eq!(record.sequence, "retained-sequence");
        assert_eq!(record.value_json, value);
        assert_eq!(
            record.meta_json.as_deref(),
            Some(r#"{"at":"retained-stamp"}"#)
        );
        assert!(!record.protected_key_present);
        assert!(owner
            .current_stored_record(
                &f.session,
                "absent",
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap()
            .is_none());
        // Closing the owner folds its write-ahead log into the file, so the bytes compared are the whole store's.
        drop(owner);
        let now = fs::read(&path).unwrap();
        assert!(
            before.replace(now.clone()).is_none_or(|filled| filled == now),
            "a read of a filled store must not rewrite the selected source"
        );
    }
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn current_account_record_mount_observes_later_wal_commit_on_next_operation() {
    use std::sync::{atomic::AtomicBool, Arc};
    use trillion_local::{legacy_records::StoredRecord, local_account::own_records::InCommand, storage::record_store::settings::Limits};
    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, r#"{"revision":1}"#);
    let writer = Connection::open(f.root.join("records.sqlite")).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    let mut owner = f.open().unwrap();
    let a = owner
        .current_stored_record(
            &f.session,
            "root",
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap()
        .unwrap();
    assert_eq!(a.value_json, r#"{"revision":1}"#);
    // Another connection commits the next version of the record to the account's own records (record store).
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let next = StoredRecord { value_json: r#"{"revision":2}"#.into(), sequence: "z-revision-2".into(), ..a };
    let limits = Limits { max_record_bytes: 1024 * 1024, byte_budget: 1 << 30 };
    InCommand::lend(&writer, &"a".repeat(64), limits).unwrap()
        .write(&std::collections::BTreeMap::from([("root".to_owned(), Some(next))]), &[], "revision-2", || Ok(())).unwrap();
    writer.execute_batch("COMMIT").unwrap();
    let b = owner
        .current_stored_record(
            &f.session,
            "root",
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap()
        .unwrap();
    assert_eq!(b.value_json, r#"{"revision":2}"#);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn current_account_record_mount_refuses_wrong_missing_resource_and_cancelled_work() {
    use std::sync::{atomic::AtomicBool, Arc};
    let wrong = Fixture::new().with_workspace("@different-records");
    add_current_record_log(&wrong, r#"{"private":"other-resource"}"#);
    let mut owner = wrong.open().unwrap();
    assert!(owner
        .current_stored_record(
            &wrong.session,
            "root",
            Arc::new(AtomicBool::new(false)),
        )
        .is_err());
    let absent = Fixture::new();
    let mut owner = absent.open().unwrap();
    assert!(owner
        .current_stored_record(
            &absent.session,
            "root",
            Arc::new(AtomicBool::new(false)),
        )
        .is_err());
    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, r#"{"private":"selected"}"#);
    let mut owner = f.open().unwrap();
    assert!(owner
        .current_stored_record(
            &f.session,
            "root",
            Arc::new(AtomicBool::new(true)),
        )
        .is_err());
    assert!(
        owner
            .current_stored_record(
                &f.session,
                "root",
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap()
            .is_some(),
        "cancelled operation must not poison the mounted account"
    );
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn current_account_record_mount_refuses_selected_source_symlink_substitution() {
    use std::{
        os::unix::fs::symlink,
        sync::{atomic::AtomicBool, Arc},
    };
    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, r#"{"private":"selected"}"#);
    let mut owner = f.open().unwrap();
    let path = f.root.join("records.sqlite");
    let saved = f.root.join("retained-records.sqlite");
    let before = fs::read(&path).unwrap();
    fs::rename(&path, &saved).unwrap();
    symlink(&saved, &path).unwrap();
    assert!(owner
        .current_stored_record(
            &f.session,
            "root",
            Arc::new(AtomicBool::new(false)),
        )
        .is_err());
    assert_eq!(fs::read(saved).unwrap(), before);
}

fn sealed_current_field(key: &[u8; 32], plaintext: &str) -> Value {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use chacha20poly1305::{
        aead::{AeadInPlace, KeyInit},
        XChaCha20Poly1305, XNonce,
    };
    let nonce = [7; 24];
    let cipher = XChaCha20Poly1305::new_from_slice(key).unwrap();
    let mut bytes = plaintext.as_bytes().to_vec();
    cipher
        .encrypt_in_place(XNonce::from_slice(&nonce), b"root\0text", &mut bytes)
        .unwrap();
    let mut envelope = vec![1];
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&bytes);
    json!({"text":{"\u{0}sealed":STANDARD.encode(envelope)},"visible":true})
}

fn add_current_key_schema(f: &Fixture, value_json: &str, key: &[u8; 32]) {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    db.execute_batch("ALTER TABLE record_log ADD COLUMN keys TEXT;
        CREATE TABLE record_erasable_keys(record_id TEXT PRIMARY KEY,key BLOB,erased_at TEXT,erased_fields TEXT)").unwrap();
    let index = format!(
        "[\"page\",\"retained-sequence\",{value_json},{{\"at\":\"retained-stamp\"}},{}]",
        json!({"key":STANDARD.encode(key)})
    );
    let body = format!(
        "{}\n{index}",
        json!({"p":[0],"s":["i\0root"],"d":[index.encode_utf16().count()]})
    );
    db.execute("UPDATE record_keys_run_1 SET body=? WHERE page=0", [body])
        .unwrap();
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn current_account_logical_read_uses_canonical_ecmascript_value_and_shared_work() {
    use std::sync::{atomic::AtomicBool, Arc};
    use trillion_local::ecma_json;
    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, r#"{"z":1.00,"a":"\ud800","__proto__":{"ok":true}}"#);
    let mut owner = f.open().unwrap();
    let record = owner
        .current_logical_record(
            &f.session,
            "root",
            Default::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
    let record = record.unwrap();
    assert_eq!(record.id(), "root");
    assert_eq!(record.record_type(), "page");
    assert_eq!(record.sequence(), "retained-sequence");
    assert_eq!(
        ecma_json::stringify(record.value(), Default::default()).unwrap(),
        r#"{"z":1,"a":"\ud800","__proto__":{"ok":true}}"#
    );
    assert_eq!(record.work.stored_reads, 1);
    assert_eq!(record.work.key_reads, 0);
    let missing = owner
        .current_logical_record(
            &f.session,
            "missing",
            Default::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
    assert!(missing.is_none());
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn current_account_logical_field_opens_current_checkpoint_key_and_later_log_key() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::sync::{atomic::AtomicBool, Arc};
    use trillion_local::ecma_json;
    for use_log_key in [false, true] {
        let f = Fixture::new().with_workspace("@own-records");
        let value =
            sealed_current_field(&[42; 32], r#"{"private":"retained","number":1.00}"#).to_string();
        add_current_record_log(&f, &value);
        add_current_key_schema(&f, &value, if use_log_key { &[41; 32] } else { &[42; 32] });
        if use_log_key {
            Connection::open(f.root.join("records.sqlite")).unwrap().execute(
                "INSERT INTO record_log(id,transaction_id,actor_context,application_time,system_time,part,parts,envelopes,keys) VALUES('01234567-89ab-7cde-8f01-234567890abc','retained-transaction','retained-actor','valid-time','system-time',0,1,'[]',?)",
                [json!({"root":STANDARD.encode([42_u8; 32])}).to_string()],
            ).unwrap();
        }
        let mut owner = f.open().unwrap();
        // The first read fills the account's own records (record store) in the same file; the reads after it write nothing.
        let mut before = None;
        for _ in 0..2 {
            let record = owner
                .current_logical_record(
                    &f.session,
                    "root",
                    Default::default(),
                    Arc::new(AtomicBool::new(false)),
                )
                .unwrap();
            let record = record.unwrap();
            assert_eq!(
                ecma_json::stringify(record.value(), Default::default()).unwrap(),
                r#"{"text":{"private":"retained","number":1},"visible":true}"#
            );
            assert_eq!(record.work.key_reads, 1);
            let now = fs::read(f.root.join("records.sqlite")).unwrap();
            assert!(before.replace(now.clone()).is_none_or(|filled| filled == now));
        }
    }
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn current_logical_owner_uses_compiled_nested_model_declaration() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use chacha20poly1305::{
        aead::{AeadInPlace, KeyInit},
        XChaCha20Poly1305, XNonce,
    };
    use std::sync::{atomic::AtomicBool, Arc};
    use trillion_local::ecma_json;

    // A nested path an installed tool declares: agent-handoff.erasable contains ["input", "said"]
    // (tools/hand-work-to-ais; the fixture's tool, support/installed_tools.rs).
    let key = [42_u8; 32];
    let cipher = XChaCha20Poly1305::new_from_slice(&key).unwrap();
    let mut sealed_bytes = br#""private nested value""#.to_vec();
    cipher
        .encrypt_in_place(
            XNonce::from_slice(&[7; 24]),
            b"root\0input.said",
            &mut sealed_bytes,
        )
        .unwrap();
    let mut envelope = vec![1];
    envelope.extend_from_slice(&[7; 24]);
    envelope.extend_from_slice(&sealed_bytes);
    let value = json!({
        "input": {"said": {"\u{0}sealed": STANDARD.encode(envelope)}},
        "visible": true
    })
    .to_string();

    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, &value);
    add_current_key_schema(&f, &value, &key);
    let mut owner = f.open().unwrap();
    let record = owner
        .current_logical_record(
            &f.session,
            "root",
            Default::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        ecma_json::stringify(record.value(), Default::default()).unwrap(),
        r#"{"input":{"said":"private nested value"},"visible":true}"#
    );
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn a_nested_sealed_path_refuses_before_the_first_install_and_reads_after_it() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use chacha20poly1305::{
        aead::{AeadInPlace, KeyInit},
        XChaCha20Poly1305, XNonce,
    };
    use std::sync::{atomic::AtomicBool, Arc};
    use trillion_local::ecma_json;

    // Sealed at input.said, a nested path only an installed tool declares (agent-handoff of tools/hand-work-to-ais).
    let key = [42_u8; 32];
    let cipher = XChaCha20Poly1305::new_from_slice(&key).unwrap();
    let mut sealed_bytes = br#""private nested value""#.to_vec();
    cipher.encrypt_in_place(XNonce::from_slice(&[7; 24]), b"root\0input.said", &mut sealed_bytes).unwrap();
    let mut envelope = vec![1];
    envelope.extend_from_slice(&[7; 24]);
    envelope.extend_from_slice(&sealed_bytes);
    let value = json!({"input": {"said": {"\u{0}sealed": STANDARD.encode(envelope)}}, "visible": true}).to_string();

    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, &value);
    add_current_key_schema(&f, &value, &key);
    // No tool installed yet: the model is the own part alone, which declares no nested path, so the read refuses
    // rather than hand back a sealed value as if it were the person's words.
    fs::remove_dir_all(f.root.join("workshop")).unwrap();
    let mut owner = f.open().unwrap();
    let read = |owner: &mut LocalAccount| owner.current_logical_record(&f.session, "root", Default::default(), Arc::new(AtomicBool::new(false)));
    assert!(read(&mut owner).is_err(), "a nested sealed path no installed tool declares is refused");
    // The first install (the first start installs the pinned commit) declares the path; the same owner reads it.
    installed_tools::install(&f.root);
    let record = read(&mut owner).unwrap().unwrap();
    assert_eq!(ecma_json::stringify(record.value(), Default::default()).unwrap(), r#"{"input":{"said":"private nested value"},"visible":true}"#);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn current_account_logical_erasure_is_null_but_unknown_key_schema_refuses() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::sync::{atomic::AtomicBool, Arc};
    use trillion_local::{ecma_json, record_value::Error};
    for schema_state in [
        "erased",
        "recreated-checkpoint",
        "recreated-log",
        "recreated-table",
        "absent-key-table",
        "absent-log-key-column",
    ] {
        let f = Fixture::new().with_workspace("@own-records");
        let value = sealed_current_field(&[42; 32], r#""retained-private""#).to_string();
        add_current_record_log(&f, &value);
        if schema_state != "absent-key-table" {
            add_current_key_schema(&f, &value, &[41; 32]);
            let db = Connection::open(f.root.join("records.sqlite")).unwrap();
            if schema_state != "absent-log-key-column" {
                // Original eraseHere scrubs the current i[4] key and the
                // producer-row keys atomically with its retained tombstone.
                // Keep ciphertext here solely to exercise logical nulling.
                let index = format!(
                    "[\"page\",\"retained-sequence\",{value},{{\"at\":\"retained-stamp\"}}]"
                );
                let body = format!(
                    "{}\n{index}",
                    json!({"p":[0],"s":["i\0root"],"d":[index.encode_utf16().count()]})
                );
                let tx = db.unchecked_transaction().unwrap();
                tx.execute("UPDATE record_keys_run_1 SET body=? WHERE page=0", [body])
                    .unwrap();
                tx.execute("UPDATE record_log SET keys=NULL", []).unwrap();
                tx.execute(
                    "INSERT INTO record_erasable_keys VALUES('root',NULL,'retained-erasure','[]')",
                    [],
                )
                .unwrap();
                if schema_state == "recreated-checkpoint" {
                    // Recreation uses a distinct key. The old key was removed
                    // above before this new current i[4] root was installed.
                    let index = format!(
                        "[\"page\",\"retained-sequence\",{value},{{\"at\":\"retained-stamp\"}},{}]",
                        json!({"key":STANDARD.encode([42_u8;32])})
                    );
                    let body = format!(
                        "{}\n{index}",
                        json!({"p":[0],"s":["i\0root"],"d":[index.encode_utf16().count()]})
                    );
                    tx.execute("UPDATE record_keys_run_1 SET body=? WHERE page=0", [body])
                        .unwrap();
                } else if schema_state == "recreated-log" {
                    tx.execute(
                        "INSERT INTO record_log(id,transaction_id,actor_context,application_time,system_time,part,parts,envelopes,keys) VALUES('01234567-89ab-7cde-8f01-234567890abc','retained-transaction','retained-actor','valid-time','system-time',0,1,'[]',?)",
                        [json!({"root":STANDARD.encode([42_u8;32])}).to_string()],
                    ).unwrap();
                } else if schema_state == "recreated-table" {
                    tx.execute("UPDATE record_erasable_keys SET key=?1,erased_at=NULL WHERE record_id='root'", [[42_u8;32].as_slice()]).unwrap();
                }
                tx.commit().unwrap();
            } else {
                db.execute_batch("ALTER TABLE record_log DROP COLUMN keys")
                    .unwrap();
            }
        }
        let mut owner = f.open().unwrap();
        let result = owner.current_logical_record(
            &f.session,
            "root",
            Default::default(),
            Arc::new(AtomicBool::new(false)),
        );
        if schema_state == "erased" {
            let record = result.unwrap().unwrap();
            assert_eq!(
                ecma_json::stringify(record.value(), Default::default()).unwrap(),
                r#"{"text":null,"visible":true}"#
            );
        } else if schema_state.starts_with("recreated-") {
            let record = result.unwrap();
            assert_eq!(
                ecma_json::stringify(record.unwrap().value(), Default::default()).unwrap(),
                r#"{"text":"retained-private","visible":true}"#
            );
        } else {
            assert!(matches!(result.map_err(|failure| failure.kind), Err(Error::Source(_))), "unknown current schema {schema_state} must not be reported as an erased or missing key");
        }
    }
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn current_account_logical_read_refuses_cancelled_work() {
    use std::sync::{atomic::AtomicBool, Arc};
    use trillion_local::record_value::Error;
    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, r#"{"private":"selected"}"#);
    let mut owner = f.open().unwrap();
    assert!(matches!(
        owner.current_logical_record(
            &f.session,
            "root",
            Default::default(),
            Arc::new(AtomicBool::new(true)),
        ).map_err(|failure| failure.kind),
        Err(Error::Source(_))
    ));
    assert!(owner
        .current_logical_record(
            &f.session,
            "root",
            Default::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap()
        .is_some());
}

fn add_current_type_checkpoint(f: &Fixture, records: &[(&str, &str)]) {
    add_current_record_log(f, r#"{"fixture":"checkpoint"}"#);
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    db.execute_batch("DELETE FROM record_keys_run_1; DELETE FROM record_keys_runs")
        .unwrap();
    let mut entries = Vec::new();
    for (id, kind) in records {
        entries.push((
            format!("i\0{id}"),
            json!([kind,"checkpoint-sequence",{"kept":true},{"at":"a"}]).to_string(),
        ));
        // A type locator is a key. Its bytes must not be mistaken for stored
        // record JSON or opened while merging current membership.
        entries.push((
            format!("t\0{kind}\0{id}"),
            "UNOPENED-TYPE-LOCATOR".to_string(),
        ));
    }
    entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    db.execute(
        "INSERT INTO record_keys_runs VALUES(1,1,?,?,0,1)",
        rusqlite::params![
            entries.len() as i64,
            serde_json::to_string(&entries.last().unwrap().0).unwrap()
        ],
    )
    .unwrap();
    for (page, (key, value)) in entries.into_iter().enumerate() {
        let body = format!(
            "{}\n{value}",
            json!({"p":[0],"s":[key],"d":[value.encode_utf16().count()]})
        );
        db.execute(
            "INSERT INTO record_keys_run_1 VALUES(?,?,?)",
            rusqlite::params![page as i64, serde_json::to_string(&key).unwrap(), body],
        )
        .unwrap();
    }
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn current_account_record_ids_merge_selected_checkpoint_with_dirty_retype_and_deletion() {
    use std::sync::{atomic::AtomicBool, Arc};
    let f = Fixture::new().with_workspace("@own-records");
    add_current_type_checkpoint(&f, &[("root", "page"), ("gone", "page"), ("stay", "page")]);
    let path = f.root.join("records.sqlite");
    let mut owner = f.open().unwrap();
    let checkpoint = owner
        .current_record_ids(&f.session, "page", "", None, 20, Arc::new(AtomicBool::new(false)))
        .unwrap();
    assert_eq!(checkpoint.ids, vec!["stay", "root", "gone"]);
    assert!(checkpoint.next.is_none());
    // A later change retypes one record and deletes another in the account's own records (record store), the way a command writes.
    {
        use trillion_local::{legacy_records::StoredRecord, local_account::own_records::InCommand, storage::record_store::settings::Limits};
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let retyped = StoredRecord {
            id: "root".into(), record_type: "other".into(), sequence: "retyped".into(),
            value_json: "{}".into(), meta_json: Some(r#"{"at":"z"}"#.into()), protected_key_present: false,
        };
        let forms = std::collections::BTreeMap::from([("root".to_owned(), Some(retyped)), ("gone".to_owned(), None)]);
        InCommand::lend(&writer, &"a".repeat(64), Limits { max_record_bytes: 1024 * 1024, byte_budget: 1 << 30 }).unwrap()
            .write(&forms, &[], "dirty-membership", || Ok(())).unwrap();
        writer.execute_batch("COMMIT").unwrap();
    }
    let current = owner
        .current_record_ids(&f.session, "page", "", None, 20, Arc::new(AtomicBool::new(false)))
        .unwrap();
    assert_eq!(
        current.ids,
        vec!["stay"],
        "dirty retype and deletion must shadow checkpoint type locators"
    );
    assert!(current.next.is_none());
    let moved = owner
        .current_record_ids(&f.session, "other", "", None, 20, Arc::new(AtomicBool::new(false)))
        .unwrap();
    assert_eq!(moved.ids,vec!["root"],"a retyped record must be visible in its current type even without a checkpoint locator for that type");
    assert!(moved.next.is_none());
    // The first read filled the account's own records (record store); enumerating membership writes nothing.
    let settled = fs::read(&path).unwrap();
    let again = owner
        .current_record_ids(&f.session, "other", "", None, 20, Arc::new(AtomicBool::new(false)))
        .unwrap();
    assert_eq!(again.ids, vec!["root"]);
    assert_eq!(fs::read(path).unwrap(), settled, "a read of an in-step store must not rewrite the selected source");
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn current_account_record_ids_refuse_cancelled_work_and_wrong_resource() {
    use std::sync::{atomic::AtomicBool, Arc};
    let f = Fixture::new().with_workspace("@own-records");
    add_current_type_checkpoint(&f, &[("root", "page")]);
    let mut owner = f.open().unwrap();
    assert_eq!(
        owner
            .current_record_ids(&f.session, "page", "", None, 20, Arc::new(AtomicBool::new(false)))
            .unwrap()
            .ids,
        vec!["root"]
    );
    // The first read filled the account's own records; the refusals below must write nothing more.
    let before_bytes = fs::read(f.root.join("records.sqlite")).unwrap();
    assert!(owner
        .current_record_ids(&f.session, "page", "", None, 20, Arc::new(AtomicBool::new(true)))
        .is_err());
    assert_eq!(
        fs::read(f.root.join("records.sqlite")).unwrap(),
        before_bytes
    );
    let wrong = Fixture::new().with_workspace("@different-records");
    add_current_type_checkpoint(&wrong, &[("root", "page")]);
    let mut wrong_owner = wrong.open().unwrap();
    assert!(
        wrong_owner
            .current_record_ids(&wrong.session, "page", "", None, 20, Arc::new(AtomicBool::new(false)))
            .is_err(),
        "current type IDs must come from the exact selected own-record resource"
    );
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn current_account_routes_point_reads_and_catalogue_pages_under_current_browser_rights() {
    use std::sync::{atomic::AtomicBool, Arc};
    use trillion_local::{
        legacy_records::StoredRecord,
        local_account::resource_affinity::{Identity, ResolveRequest},
        records::{Mutation, Records},
        storage::{record_store::native::body, record_store_resources},
        sqlite_work::WorkMeter,
    };

    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, r#"{"private":"legacy"}"#);
    let mut account = f.open().unwrap();
    first_start(&mut account, &f.session);

    let owner_id = "a".repeat(64);
    let meter = WorkMeter::new();
    let base_path = f.root.join("records.sqlite");
    let mut base = record_store_resources::open(&base_path, meter.clone()).unwrap();
    let (version, _) = base
        .held_record_with_version(&owner_id, "own-resource-identity", "1")
        .unwrap();
    base.mutate(&owner_id, "own-resource-identity", Mutation {
        id: "1".into(),
        expected_version: version,
        request_key: "routed-read-base-identity".into(),
        deleted: false,
        value: json!({"singleton":1,"owner":owner_id,"resource":"@own-records","generation":1,"ready":1}),
    }).unwrap();

    let identity = Identity { kind: "own-record".into(), id: "routed".into() };
    let request = ResolveRequest {
        owner: owner_id.clone(),
        generation: "1".into(),
        identities: vec![identity],
        group: Some("account-test:routed-read".into()),
    };
    let route = trillion_local::local_account::resource_affinity::store::AffinityDirectory::new(
        &f.root, meter.clone(), &owner_id, "1",
    ).unwrap().install_and_resolve(&request, || Ok(())).unwrap();
    let (_, mut routed) = record_store_resources::open_state_resource(&route.resource, &f.root, meter.clone()).unwrap();
    let stored = StoredRecord {
        id: "routed".into(), record_type: "page".into(), sequence: "routed-sequence".into(),
        value_json: r#"{"private":"routed"}"#.into(), meta_json: None, protected_key_present: false,
    };
    routed.mutate(&owner_id, "own-records", Mutation {
        id: stored.id.clone(), expected_version: 0, request_key: "routed-read-record".into(),
        deleted: false, value: body(&stored),
    }).unwrap();

    let point = account.current_stored_record(&f.session, "routed", Arc::new(AtomicBool::new(false))).unwrap().unwrap();
    assert_eq!(point.value_json, r#"{"private":"routed"}"#);
    let page = account.current_record_ids(&f.session, "page", "", None, 10, Arc::new(AtomicBool::new(false))).unwrap();
    assert_eq!(page.ids, vec!["routed", "root"], "the catalogue page merges the routed file and original RecordBook");
}

// Viewer integration uses actual cold LocalAccount + retained SelectedAccount;
// no alternate ViewerSource fixture can invent its browser/config authority.
fn edit_fixture_receipt(f: &mut Fixture, change: impl FnOnce(&mut Value)) {
    let path = f.root.join("restore-receipt.json");
    let mut receipt: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    change(&mut receipt);
    let bytes = serde_json::to_vec(&receipt).unwrap();
    fs::write(path, &bytes).unwrap();
    f.pin = FilePin {
        bytes: bytes.len() as u64,
        blake3: blake3::hash(&bytes).to_hex().to_string(),
    };
}
fn viewer_fixture() -> Fixture {
    let mut f = Fixture::new();
    let user = f.user.clone();
    edit_fixture_receipt(
        &mut f,
        |r| {
            r["environment"] = json!({"OPERATOR_ACCOUNT_ID":user,"WORKSHOP_IDENTITY":"fixture-workshop"})
        },
    );
    set_viewer_policy(
        &f,
        json!({"lifecycle":{"browser_session_generation":1},"access":{},"account_controls":{"client_programs":{"programs":[{"id":"held","host":{"account":{"setting":"OPERATOR_ACCOUNT_ID"},"audience":"audience:held"},"unrelated_private":"not-a-viewer-field"}]},"unrelated_private":"never-projected"}}),
    );
    f
}
fn set_viewer_policy(f: &Fixture, part: Value) {
    Connection::open(&f.policy)
        .unwrap()
        .execute(
            "UPDATE policy_directory SET value=? WHERE name='policy-source:account'",
            [part.to_string()],
        )
        .unwrap();
}
fn selected_viewer(
    f: &Fixture,
) -> (
    trillion_local::native_boot::SelectedAccount,
    trillion_local::workspace_startup::ProgramData,
    PathBuf,
) {
    let (mut owner, path) = selected_viewer_owner(f, true);
    let data = owner.viewer_program_data().unwrap();
    (owner, data, path)
}
fn selected_viewer_owner(
    f: &Fixture,
    select_program: bool,
) -> (trillion_local::native_boot::SelectedAccount, PathBuf) {
    fn data(f: &Fixture, name: &str, value: Value) -> Value {
        let path = f.root.join(name);
        let bytes = serde_json::to_vec(&value).unwrap();
        fs::write(&path, &bytes).unwrap();
        json!({"path":path,"pin":{"bytes":bytes.len(),"blake3":blake3::hash(&bytes).to_hex().as_str()}})
    }
    let rules = data(
        f,
        "viewer-rules.json",
        json!({"most_days":90,"idle_days_by_approval":{"unknown":7}}),
    );
    let reveal = data(
        f,
        "viewer-reveal.json",
        json!({"reveal_window_minutes":10,"legacy_scrub_days":7}),
    );
    let inputs = data(f, "viewer-inputs.json", json!({}));
    let first = data(f, "viewer-first.json", json!({}));
    // The program sits at its carried path, as an app holds it, so a change to this file is a change to the carried file.
    fs::create_dir_all(f.root.join("data")).unwrap();
    let program_path = f.root.join("data/client_program.json");
    let program = data(
        f,
        "data/client_program.json",
        json!({"programs":[{"id":"shipped","host":{"account":{"setting":"OPERATOR_ACCOUNT_ID"},"audience":"audience:shipped"}}]}),
    );
    let descriptor = f.root.join("viewer-adoption.json");
    let mut source = json!({"version":"trillion.local-runtime-adoption/v1","state":f.root,"receipt_identity":f.pin.blake3,"port":28788,
        "native":{"version":"trillion.native-selection/v1","receipt_bytes":f.pin.bytes,
        "app_kv":{"sqlite":f.kv.strip_prefix(&f.root).unwrap(),"namespace":"trillion-local-app"},"prior_processes":[],
        "sign_in_rules":rules,"reveal_policy":reveal,"root_source":null,
        "frontend":{"root":f.root,"manifest_identity":"1".repeat(64),"tree_identity":"2".repeat(64),"module_manifest_identity":"3".repeat(64),
        "inputs":inputs,"first_answers":first,"client_program":program}}});
    if !select_program {
        source["native"]["frontend"]
            .as_object_mut()
            .unwrap()
            .remove("client_program");
    }
    let carried = carried_selection::write_selection(&descriptor, &source);
    let selected = trillion_local::native_boot::Selection::from_descriptor(
        &descriptor,
        &carried,
        &f.root,
        "127.0.0.1:28788".parse().unwrap(),
    )
    .unwrap();
    let owner =
        trillion_local::native_boot::SelectedAccount::new(f.open().unwrap(), selected).unwrap();
    (owner, program_path)
}
fn read_selected_viewer(
    owner: &mut trillion_local::native_boot::SelectedAccount,
    data: &trillion_local::workspace_startup::ProgramData,
    f: &Fixture,
) -> Result<Value, trillion_local::account::AccountError> {
    trillion_local::workspace_startup::viewer(
        owner,
        data,
        &f.session,
        &std::sync::atomic::AtomicBool::new(false),
    )
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn actual_selected_viewer_uses_same_browser_policy_and_public_receipt_source() {
    use trillion_local::workspace_startup::ViewerSource;
    let f = viewer_fixture();
    let (mut owner, data, _) = selected_viewer(&f);
    let state = owner.current_viewer(&f.session).unwrap();
    assert_eq!(state.admission.account.user_id, f.user);
    assert!(state.admission.still());
    assert!(state.client_programs.unwrap().get("programs").is_some());
    assert_eq!(
        read_selected_viewer(&mut owner, &data, &f),
        Ok(
            json!({"access_refs":["audience:operator","audience:shipped","audience:held"],"throwaway":false})
        )
    );
    assert!(owner.service_setting("UNKNOWN_EFFECTIVE_SETTING").is_err());
    assert!(
        owner.service_setting("HELD_VALUES_ROOT_KEY").is_err(),
        "public config is not a credential reader"
    );
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn viewer_missing_control_remains_optional_for_nonoperator_and_required_for_operator() {
    use trillion_local::{account::AccountError, workspace_startup::ViewerSource};
    let mut f = viewer_fixture();
    set_viewer_policy(
        &f,
        json!({"lifecycle":{"browser_session_generation":1},"access":{}}),
    );
    let (mut owner, data, _) = selected_viewer(&f);
    assert!(owner
        .current_viewer(&f.session)
        .unwrap()
        .client_programs
        .is_none());
    assert!(matches!(read_selected_viewer(&mut owner, &data, &f), Err(AccountError::SourceUnavailable(_))));
    drop(owner);
    edit_fixture_receipt(&mut f, |r| {
        r["environment"]["OPERATOR_ACCOUNT_ID"] = json!("other-synthetic-account")
    });
    let (mut owner, data, _) = selected_viewer(&f);
    assert_eq!(
        read_selected_viewer(&mut owner, &data, &f),
        Ok(json!({"access_refs":[],"throwaway":false}))
    );
    set_viewer_policy(
        &f,
        json!({"lifecycle":{"browser_session_generation":1},"access":{},"account_controls":{"client_programs":null}}),
    );
    assert_eq!(
        owner.current_viewer(&f.session).unwrap().client_programs,
        Some(Value::Null)
    );
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn invalid_unused_public_configuration_does_not_break_account_admission_or_invent_absence() {
    use trillion_local::{account::AccountError, workspace_startup::ViewerSource};
    for case in ["missing", "wrong-type", "unknown-name", "private-conflict"] {
        let mut f = viewer_fixture();
        edit_fixture_receipt(&mut f, |r| match case {
            "missing" => {
                r.as_object_mut().unwrap().remove("environment");
            }
            "wrong-type" => r["environment"] = json!({"OPERATOR_ACCOUNT_ID":false}),
            "unknown-name" => r["environment"]["UNKNOWN_PUBLIC_BINDING"] = json!("unqualified"),
            "private-conflict" => {
                r["environment"]["MARKETPLACE_PUBLISHER_ACCOUNT_ID"] = json!("fixture-publisher");
                r["bindingCredentials"] =
                    json!({"MARKETPLACE_PUBLISHER_ACCOUNT_ID":"fixture-publisher-ref"});
            }
            _ => unreachable!(),
        });
        let (mut owner, data, _) = selected_viewer(&f);
        assert!(
            current_browser(&mut owner, &f.session).is_ok(),
            "unused config does not blanket-refuse account: {case}"
        );
        assert!(owner.service_setting("OPERATOR_ACCOUNT_ID").is_err());
        assert!(matches!(read_selected_viewer(&mut owner, &data, &f), Err(AccountError::SourceUnavailable(_))), "{case}");
    }
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn selected_viewer_withdraws_on_a_receipt_change() {
    let f = viewer_fixture();
    let (mut owner, data, _) = selected_viewer(&f);
    assert!(read_selected_viewer(&mut owner, &data, &f).is_ok());
    let path = f.root.join("restore-receipt.json");
    let mut receipt: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    receipt["environment"]["OPERATOR_ACCOUNT_ID"] = json!("other-synthetic-account");
    fs::write(path, receipt.to_string()).unwrap();
    assert!(read_selected_viewer(&mut owner, &data, &f).is_err());
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn selected_optional_program_source_changes_withdraw_the_viewer_selection() {
    use trillion_local::workspace_startup::ViewerSource;
    let f = viewer_fixture();
    let (mut owner, data, path) = selected_viewer(&f);
    assert!(read_selected_viewer(&mut owner, &data, &f).is_ok());
    fs::write(path, b"changed-source").unwrap();
    assert!(owner.assert_current().is_err());
    assert!(owner.viewer_program_data().is_err());
    assert!(read_selected_viewer(&mut owner, &data, &f).is_err());
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn viewer_program_loader_requires_selected_source_without_breaking_account_admission() {
    use trillion_local::account::AccountError;
    let f = viewer_fixture();
    let (mut owner, _) = selected_viewer_owner(&f, false);
    assert!(current_browser(&mut owner, &f.session).is_ok());
    assert!(matches!(
        owner.viewer_program_data(),
        Err(AccountError::SourceUnavailable(_))
    ));
}

#[path = "support/carried_selection.rs"]
mod carried_selection;
#[path = "support/installed_tools.rs"]
mod installed_tools;
#[path = "local_account/native_command_context.rs"]
mod native_command_context_controls;

#[path = "local_account/records_write.rs"]
mod records_write_controls;

#[cfg(feature = "exact-native-locale")]
#[path = "support/workshop_data.rs"]
mod workshop_data;

#[cfg(feature = "exact-native-locale")]
#[path = "local_account_cold/show_rules.rs"]
mod show_rule_controls;



