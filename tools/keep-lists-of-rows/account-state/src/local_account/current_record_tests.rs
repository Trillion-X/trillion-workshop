#![cfg(target_os = "macos")]
#![cfg(test)]

//! Actual private mount controls. Synthetic selected account data exercises the
//! production admission/witness/decoder/finish composition; these tests do not
//! qualify the real account, decryption, installed UI or whole-workload costs.

mod connection_management_controls {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/mcp_connection_management.rs"));
}

use super::{LocalAccount, SelectedLocalState, EXISTING_APP_KV_STORE};
use content_crypto::advanced::blake3;
use crate::{
    import::FilePin,
};
use rusqlite::Connection;
use serde_json::json;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

struct Fixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    receipt: FilePin,
    session: String,
    user: String,
    kv: PathBuf,
    sign_in: Arc<crate::account::account_routes::SignIn>,
    _registration: crate::account::account_routes::Registration,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        // The window's sign-in token: a JWT naming the account's address (here its owner, as `SignIn::address` falls back).
        let token = crate::account::signed_in::test_token(&"a".repeat(64));
        let session = blake3::hash(token.as_bytes()).to_hex().to_string();
        // A account name of its own: the open sign-ins of this process are found by account name.
        let user = format!("synthetic-user-{}", temporary.path().file_name().unwrap().to_string_lossy());
        fs::write(root.join("browser-session.key"), &token).unwrap();
        fs::set_permissions(
            root.join("browser-session.key"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let policy = Connection::open(root.join("policy.sqlite")).unwrap();
        policy
            .execute_batch(
                "CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)",
            )
            .unwrap();
        for (name, value) in [
            ("revision", json!(1)),
            ("policy-source", json!({"from":"born","missing":[]})),
            ("policy-source:account", json!({"lifecycle":{},"access":{},"account_controls":{"owner_user_id":user}})),
        ] {
            policy
                .execute(
                    "INSERT INTO policy_directory VALUES(?,?)",
                    [name, &value.to_string()],
                )
                .unwrap();
        }
        drop(policy);
        let kv_folder = root.join("storage/kv").join(EXISTING_APP_KV_STORE);
        fs::create_dir_all(kv_folder.join("blobs")).unwrap();
        let kv = kv_folder.join("current.sqlite");
        let database = Connection::open(&kv).unwrap();
        database.execute_batch("CREATE TABLE _mf_entries(key TEXT PRIMARY KEY,blob_id TEXT NOT NULL,expiration INTEGER)").unwrap();
        drop(database);
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let created_at =
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(i64::try_from(millis).unwrap())
                .unwrap()
                .to_rfc3339();
        let _ = created_at;
        let records = Connection::open(root.join("records.sqlite")).unwrap();
        records.execute_batch("CREATE TABLE entity(id TEXT PRIMARY KEY);
            CREATE TABLE entity_types(entity_id TEXT,type_id TEXT,PRIMARY KEY(entity_id,type_id));
            CREATE TABLE attribute_fact(subject_id TEXT,property_id TEXT,type_id TEXT,value_json TEXT,PRIMARY KEY(subject_id,property_id,type_id));
            CREATE TABLE participation(id TEXT PRIMARY KEY,interaction_id TEXT,participant_id TEXT,role_id TEXT,counterpart_id TEXT);
            CREATE TABLE interaction_set_members(set_id TEXT,member_id TEXT,ordinal INTEGER,PRIMARY KEY(set_id,member_id));
            INSERT INTO entity VALUES('root');
            INSERT INTO entity_types VALUES('root','type:page');
            INSERT INTO attribute_fact VALUES('root','prop:title','type:page','{\"version\":1}')").unwrap();
        drop(records);
        let owner = "a".repeat(64);
        let record_name = format!(
            "own-record-resource:{}",
            serde_json::to_string(&[owner.as_str(), "@own-records"]).unwrap()
        );
        let index = format!(
            "{}\n{}",
            json!({"binding":"ACCOUNT_CONTROL","originalId":"c".repeat(64),"names":[format!("policy:{owner}")],"sqlite":"policy.sqlite"}),
            json!({"binding":"RECORD_BOOK","originalId":"d".repeat(64),"names":[record_name],"sqlite":"records.sqlite"})
        );
        fs::write(root.join("objects.jsonl"), &index).unwrap();
        let receipt = serde_json::to_vec(&json!({"complete":true,"account":{"userId":user,"ownerId":owner},
            "objects":{"path":"objects.jsonl","bytes":index.len(),"fileIdentity":blake3::hash(index.as_bytes()).to_hex().as_str(),"count":2}})).unwrap();
        fs::write(root.join("restore-receipt.json"), &receipt).unwrap();
        // The window's session, opened by its verified sign-in token.
        let storage: crate::account::rows::Shared = std::sync::Arc::new(
            crate::account::rows::Locked::new(crate::storage::memory::Memory::open("sign_in").unwrap()),
        );
        let sign_in = Arc::new(crate::account::account_routes::SignIn::new(storage, &user, &owner, None));
        assert_eq!(crate::account::admit_browser_token(&token).unwrap(), session);
        let registration = crate::account::account_routes::register(&sign_in);
        Self {
            _root: temporary,
            root,
            receipt: FilePin {
                bytes: receipt.len() as u64,
                blake3: blake3::hash(&receipt).to_hex().to_string(),
            },
            session,
            user,
            kv,
            sign_in,
            _registration: registration,
        }
    }

    fn set_policy(&self, name: &str, value: serde_json::Value) {
        Connection::open(self.root.join("policy.sqlite"))
            .unwrap()
            .execute(
                "UPDATE policy_directory SET value=? WHERE name=?",
                [value.to_string(), name.into()],
            )
            .unwrap();
    }

    /// The window's session ends, as when its token expires.
    fn end_window(&self) {
        crate::account::end_browser_session_for_tests(&self.session);
    }

    fn open(&self) -> LocalAccount {
        LocalAccount::open_selected_after_handoff(
            SelectedLocalState {
                root: self.root.clone(),
                receipt: self.receipt.clone(),
                app_kv_sqlite: self.kv.strip_prefix(&self.root).unwrap().into(),
                app_kv_store: EXISTING_APP_KV_STORE.into(),
                prior_processes: vec![],
            },
        )
        .unwrap()
    }

}

#[test]
fn private_provisional_queries_do_not_repeat_policy_sql_and_finish_still_withholds_revocation() {
    use crate::record_source::BoundedRecordSql;
    let fixture = Fixture::new();
    let mut owner = fixture.open();
    let meter = owner.source.sql_work.clone();
    let mut source = owner
        .current_record_source(&fixture.session, Arc::new(AtomicBool::new(false)))
        .unwrap();
    let before = meter.snapshot().unwrap().work.sql_statements;
    for _ in 0..12 {
        source.query("SELECT 1", &[]).unwrap();
    }
    assert_eq!(
        meter.snapshot().unwrap().work.sql_statements - before,
        12,
        "private internal SQL must not multiply into repeated policy/session SQL"
    );
    fixture.end_window();
    // Even a completed provisional query after the window's session ends cannot
    // authorize the held result: the mandatory finish asks the sign-in again.
    source.query("SELECT 1", &[]).unwrap();
    assert!(source.finish().is_err());
}

#[test]
fn raw_kv_parts_keep_exact_bytes_and_expiry_without_changing_json_consumers() {
    let fixture = Fixture::new();
    let root = fixture
        .root
        .join("storage/kv")
        .join(EXISTING_APP_KV_STORE)
        .join("blobs");
    fs::write(root.join("bb"), b"{\"split").unwrap();
    let writer = Connection::open(&fixture.kv).unwrap();
    writer
        .execute("INSERT INTO _mf_entries VALUES('part','bb',NULL)", [])
        .unwrap();
    writer
        .execute("INSERT INTO _mf_entries VALUES('expired','bb',1)", [])
        .unwrap();
    let mut owner = fixture.open();
    let now = owner.source.clock().unwrap();
    let raw = owner.source.read_kv_bytes("part", now).unwrap().unwrap();
    assert_eq!(raw.as_slice(), b"{\"split");
    assert!(owner.source.read_kv("part", now).is_err());
    assert!(owner
        .source
        .read_kv_bytes("expired", now)
        .unwrap()
        .is_none());
    assert!(owner.source.read_kv_bytes("absent", now).unwrap().is_none());
}

#[test]
fn partial_state_lock_write_failure_removes_only_its_own_file() {
    use std::io::{Error as IoError, ErrorKind, Write};
    for phase in ["partial-write", "sync", "replaced"] {
        let fixture = Fixture::new();
        let path = fixture.root.join("local-runtime.lock");
        let result = super::ExistingStateLock::write_new(
            super::state_lock_recovery::StateLockFile::open(&path).unwrap(),
            zeroize::Zeroizing::new(b"private fixture state lock bytes".to_vec()),
            |file, bytes| {
                file.write_all(if phase == "partial-write" {
                    &bytes[..4]
                } else {
                    bytes
                })?;
                if phase == "replaced" {
                    fs::rename(&path, fixture.root.join("retained-partial-marker"))?;
                    fs::write(&path, b"replacement must survive")?;
                }
                Err(IoError::new(
                    ErrorKind::Other,
                    "injected write/sync refusal",
                ))
            },
        );
        assert!(result.is_err());
        if phase == "replaced" {
            assert_eq!(fs::read(path).unwrap(), b"replacement must survive");
        } else {
            assert!(!path.exists(), "partial new marker stranded after {phase}");
        }
    }
}

#[test]
fn finish_withholds_completed_decode_on_late_current_account_change() {
    for change in [
        "window",
        "cancellation",
        "source",
        "lease",
    ] {
        let fixture = Fixture::new();
        let mut owner = fixture.open();
        let cancel = Arc::new(AtomicBool::new(false));
        let source = owner.current_record_source(&fixture.session, cancel.clone()).unwrap();
        match change {
            "window" => fixture.end_window(),
            "cancellation" => cancel.store(true, Ordering::Release),
            "source" => {
                fs::rename(
                    fixture.root.join("records.sqlite"),
                    fixture.root.join("retained-records.sqlite"),
                )
                .unwrap();
                Connection::open(fixture.root.join("records.sqlite"))
                    .unwrap()
                    .execute_batch("CREATE TABLE decoy(id INTEGER)")
                    .unwrap();
            }
            "lease" => fs::write(
                fixture.root.join("local-runtime.lock"),
                b"a changed state lock must remain retained",
            )
            .unwrap(),
            _ => unreachable!(),
        }
        let result = source.finish();
        assert!(result.is_err(), "finish must withhold a completed value after {change}");
    }
}






// Same selected LocalAccount, actual interrupted SQLite work, then a cold
// logical operation. No account/source rights or observation history is reset.
fn interrupt_observed_union(meter: crate::sqlite_work::WorkMeter) {
    use crate::sqlite_work::{ObservedConnection, Error as MeterError};
    assert!(meter.snapshot().is_ok(), "history is complete before the failed SQL");
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE interrupted_rows(id INTEGER PRIMARY KEY); INSERT INTO interrupted_rows VALUES(1),(2),(3),(4)").unwrap();
    let db = unsafe { ObservedConnection::attach_untraced(db, meter.clone()) }.unwrap();
    let sql = std::iter::repeat_n("SELECT id FROM interrupted_rows", 257).collect::<Vec<_>>().join(" UNION ALL ");
    let mut statement = db.connection().prepare(&sql).unwrap();
    assert!(meter.snapshot().is_ok(), "prepare alone does not lose measurement history");
    db.connection().progress_handler(1, Some(|| true));
    let result = (|| {
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? { let _: i64 = row.get(0)?; }
        Ok::<_, rusqlite::Error>(())
    })();
    assert!(matches!(&result, Err(rusqlite::Error::SqliteFailure(error, _)) if error.code == rusqlite::ErrorCode::OperationInterrupted), "the previous SQL operation must actually interrupt");
    db.connection().progress_handler(0, None::<fn() -> bool>);
    drop(statement);
    drop(db);
    assert_eq!(meter.snapshot().unwrap_err(), crate::cause!(MeterError::Incomplete),
        "the interrupted observer has genuinely incomplete history, never zero");
}
fn prefill_observer_recovery(f: &Fixture) {
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID; INSERT INTO record_keys_meta VALUES('engine','\"record-log\"'),('covered','1'); CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT); CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER); CREATE TABLE record_keys_big(ref TEXT,part INTEGER,body TEXT,PRIMARY KEY(ref,part)) WITHOUT ROWID; CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT)").unwrap();
    let key = "i\0setting:needs_you_hold";
    let value = r#"["setting","retained",{"value":{"kept":true}},{"at":"retained"}]"#;
    let page = format!("{}\n{value}", json!({"p":[0],"s":[key],"d":[value.encode_utf16().count()]}));
    db.execute("INSERT INTO record_keys_runs VALUES(1,1,1,?,0,1)", [serde_json::to_string(key).unwrap()]).unwrap();
    db.execute("INSERT INTO record_keys_run_1 VALUES(0,?,?)", rusqlite::params![serde_json::to_string(key).unwrap(), page]).unwrap();
    db.execute("INSERT INTO record_log VALUES('01234567-89ab-7cde-8f01-234567890abc','tx','fixture','a','a',0,1,'[]',NULL)", []).unwrap();
}
#[test]
fn incomplete_prior_sql_observation_does_not_block_cold_logical_source() {
    let f = Fixture::new(); prefill_observer_recovery(&f);
    let mut owner = f.open();
    let meter = owner.source.sql_work.clone();
    interrupt_observed_union(meter.clone());
    let result = owner.current_logical_record(&f.session, &crate::record_log::original_setting::setting_id("needs_you_hold").unwrap(), Default::default(), Arc::new(AtomicBool::new(false)));
    match &result {
        Err(error) => eprintln!("OBSERVER_RECOVERY_FAILURE {error}"),
        Ok(record) => assert_eq!(crate::ecma_json::stringify(record.as_ref().unwrap().value(), Default::default()).unwrap(), r#"{"value":{"kept":true}}"#),
    }
    assert!(result.is_ok(), "measurement history cannot revoke the still-current source");
    assert_eq!(meter.snapshot().unwrap_err(), crate::cause!(crate::sqlite_work::Error::Incomplete));
}

#[test]
fn incomplete_observation_remains_unknown_and_cannot_bypass_current_revocation() {
    for revoke in [false, true] {
        let f = Fixture::new(); prefill_observer_recovery(&f);
        let mut owner = f.open(); let meter = owner.source.sql_work.clone();
        interrupt_observed_union(meter.clone());
        if revoke {
            f.end_window();
        }
        let result = owner.current_logical_record(&f.session, &crate::record_log::original_setting::setting_id("needs_you_hold").unwrap(), Default::default(), Arc::new(AtomicBool::new(!revoke)));
        assert!(result.is_err(), "current cancellation or withdrawal must still refuse");
        assert_eq!(meter.snapshot().unwrap_err(), crate::cause!(crate::sqlite_work::Error::Incomplete));
    }
}
#[test]
// It clones its inputs; a computer without file clones (src/tool_runs/os.rs `FileClone`) still builds the suite.
#[cfg(file_clone = "clonefile")]
#[ignore = "requires TRILLION_HEAD_LIFECYCLE_INPUT and TRILLION_HEAD_LIFECYCLE_SOURCE_ROOT"]
fn copied_one_logical_record_first_repeat_reopen_work() {
    use std::{os::unix::fs::MetadataExt, path::Path};
    fn pin(path: &Path) -> Option<(u64,u64,u64,i64,i64)> {
        fs::metadata(path).ok().map(|m|(m.dev(),m.ino(),m.len(),m.mtime(),m.mtime_nsec()))
    }
    fn clone_file(source: &Path, target: &Path) {
        use crate::tool_runs::os::{FileClone, This};
        assert_eq!(This::clone_path(source, target), Ok(true));
    }
    let input = PathBuf::from(std::env::var_os("TRILLION_HEAD_LIFECYCLE_INPUT").unwrap());
    assert_eq!(fs::metadata(&input).unwrap().permissions().mode() & 0o777, 0o600);
    let config: serde_json::Value = serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
    let source = fs::canonicalize(config["database"].as_str().unwrap()).unwrap();
    let allowed = fs::canonicalize(std::env::var_os("TRILLION_HEAD_LIFECYCLE_SOURCE_ROOT").unwrap()).unwrap();
    assert!(source.starts_with(allowed));
    let id = config["record_id"].as_str().unwrap();
    let wal = PathBuf::from(format!("{}-wal", source.display()));
    let before_source = pin(&source);
    let before_wal = pin(&wal);
    let f = Fixture::new();
    let target = f.root.join("records.sqlite");
    fs::remove_file(&target).unwrap();
    clone_file(&source, &target);
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    if wal.exists() {
        let copy = PathBuf::from(format!("{}-wal", target.display()));
        clone_file(&wal, &copy);
        fs::set_permissions(copy, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let default_kept = crate::legacy_kept::LegacyKept::new(Default::default()).unwrap();
    // Explain a refusal from the exact original reader without logging a
    // private record or silently widening the production consumer's limits.
    {
        let mut diagnostic_owner = f.open();
        let admission = crate::account::current_browser(&mut diagnostic_owner, &f.session).unwrap();
        let source = diagnostic_owner.current_record_source_limited(&f.session, target.clone(), admission,
            crate::import::ReadLimits {
                rows: 4096, cell_bytes: 8 * 1024 * 1024, result_bytes: 32 * 1024 * 1024,
                sql_bytes: 256 * 1024, vm_steps: 50_000_000,
                elapsed: std::time::Duration::from_secs(30), ..Default::default()
            }, Arc::new(AtomicBool::new(false))).unwrap();
        let mut original = crate::legacy_records::LegacyRecords::open_for_current_head(source, Default::default()).unwrap();
        let outcome = original.read_stored(id, &default_kept);
        eprintln!("copied-logical-original outcome={} diagnostic={}",
            if outcome.is_ok() { "ok" } else { "refused" },
            original.last_read_diagnostic().map_or_else(|| "none".to_owned(), ToString::to_string));
        original.into_source().finish().unwrap();
    }
    let mut owner = f.open();
    let mut previous = owner.sql_work().unwrap();
    #[cfg(feature = "sql-statement-attribution")]
    let mut trace = unsafe { owner.enable_fixture_sql_attribution(512).unwrap() };
    let mut digest = None;
    for phase in ["first", "repeat", "reopen"] {
        if phase == "reopen" {
            #[cfg(feature = "sql-statement-attribution")]
            drop(trace);
            drop(owner);
            owner = f.open();
            previous = owner.sql_work().unwrap();
            #[cfg(feature = "sql-statement-attribution")]
            { trace = unsafe { owner.enable_fixture_sql_attribution(512).unwrap() }; }
        }
        #[cfg(feature = "sql-statement-attribution")]
        let templates_before = trace.fixture_statement_snapshot().unwrap();
        let read = owner.current_logical_record(&f.session, id, Default::default(), Arc::new(AtomicBool::new(false)));
        let current = owner.sql_work().unwrap();
        eprintln!("copied-logical-get phase={phase} outcome={} statements={} visits={} writes={}",
            if read.is_ok() { "ok" } else { "refused" },
            current.work.sql_statements - previous.work.sql_statements,
            current.work.sqlite_scan_visits - previous.work.sqlite_scan_visits,
            current.work.rows_written - previous.work.rows_written);
        #[cfg(feature = "sql-statement-attribution")]
        {
            let templates_after = trace.fixture_statement_snapshot().unwrap();
            assert!(templates_after.complete, "copied logical SQL attribution incomplete");
            let mut by_template = templates_after.statements.iter().filter_map(|row| {
                let before = templates_before.statements.iter().find(|old| old.sql_template == row.sql_template);
                let calls = row.work.sql_statements - before.map_or(0, |old| old.work.sql_statements);
                let visits = row.work.sqlite_scan_visits - before.map_or(0, |old| old.work.sqlite_scan_visits);
                let returned = row.work.rows_returned - before.map_or(0, |old| old.work.rows_returned);
                if calls == 0 && visits == 0 && returned == 0 { return None; }
                let sql = row.sql_template.to_ascii_lowercase();
                let family = if sql.contains("record_keys_runs") { "record-key-runs" }
                    else if sql.contains("record_keys_run_") { "record-key-pages" }
                    else if sql.contains("record_keys_big") { "record-key-big" }
                    else if sql.contains("record_log") { "record-journal" }
                    else if sql.contains("sqlite_schema") || sql.contains("sqlite_master") { "schema-catalogue" }
                    else if sql.contains("pragma_table_info") || sql.contains("pragma_table_list") { "schema-columns" }
                    else if sql.contains("policy_directory") { "policy-directory" }
                    else if sql.contains("_mf_entries") { "session-kv" }
                    else if sql.contains("current_record_heads") { "current-heads" }
                    else if sql.contains("versions") { "versions" }
                    else { "other" };
                Some((visits, calls, returned, family, blake3::hash(row.sql_template.as_bytes())))
            }).collect::<Vec<_>>();
            by_template.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
            for (visits, calls, returned, family, hash) in by_template {
                eprintln!("copied-logical-template phase={phase} family={family} sql={calls} visits={visits} returned={returned} template_b3={hash}");
            }
            eprintln!("copied-logical-unattributed phase={phase} visits={} rows={}",
                templates_after.unattributed_work.sqlite_scan_visits,
                templates_after.unattributed_row_events);
        }
        let value = read.unwrap().expect("selected real record must be present");
        let encoded = crate::ecma_json::stringify(value.value(), Default::default()).unwrap();
        let now = blake3::hash(encoded.as_bytes());
        if let Some(previous_digest) = digest { assert_eq!(now, previous_digest); }
        digest = Some(now);
        previous = current;
    }
    drop(owner);
    assert_eq!(pin(&source), before_source);
    assert_eq!(pin(&wal), before_wal);
}

#[test]
fn the_window_token_is_admitted_after_start_and_refused_once_its_session_ends() {
    let fixture = Fixture::new();
    let mut owner = fixture.open();
    let admitted = crate::account::current_browser(&mut owner, &fixture.session).unwrap();
    assert!(admitted.still(), "the window's session is live after start");
    fixture.end_window();
    assert!(!admitted.still(), "an ended session refuses at the next check");
    assert!(crate::account::current_browser(&mut owner, &fixture.session).is_err());
}

#[test]
fn an_expired_window_token_refuses_at_the_next_check() {
    let fixture = Fixture::new();
    let mut owner = fixture.open();
    let admitted = crate::account::current_browser(&mut owner, &fixture.session).unwrap();
    crate::account::expire_browser_session_for_tests(&fixture.session);
    assert!(!admitted.still(), "an expired token refuses at the next check");
    assert!(crate::account::current_browser(&mut owner, &fixture.session).is_err());
}

#[test]
fn an_old_session_row_is_not_read_for_the_window() {
    let fixture = Fixture::new();
    let mut owner = fixture.open();
    fixture.end_window();
    let blob = fixture.root.join("storage/kv").join(EXISTING_APP_KV_STORE).join("blobs/aa");
    fs::write(&blob, json!({"userId": "synthetic-user", "created_at": "2026-10-25T00:00:00.000Z", "method": "unknown"}).to_string()).unwrap();
    Connection::open(&fixture.kv)
        .unwrap()
        .execute("INSERT INTO _mf_entries VALUES(?,'aa',NULL)", [format!("session:{}", fixture.session)])
        .unwrap();
    assert!(
        crate::account::current_browser(&mut owner, &fixture.session).is_err(),
        "a session row in the old account's KV is not the window's session"
    );
}
