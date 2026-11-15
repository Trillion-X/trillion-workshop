//! Opposing controls for live workspace heads over synthetic SQLite only.
//! These draft controls intentionally are not a Cargo target until the native
//! integration owner chooses the point at which to export workspace_heads.
use rusqlite::{Connection, OpenFlags};
use std::io::{self, Write};
use std::time::Duration;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use trillion_local::{
    ecma_json::{self, JsString, Limits, Value},
    records::{Mutation, Records},
    storage::{
        record_store::{settings, RecordStore, RealClock},
        sqlite::{self, Access},
    },
    workspace_store,
    workspace_heads::{
        told_tail, Binding, Heads, HeadsRead, LiveHeads, ResourceOwner,
    },
};

struct FixtureOwner {
    connection: *const Connection,
    current_checks: usize,
    fail_current_at: Option<usize>,
    read_allowed: bool,
    withdraw_read_at: Option<usize>,
    delivery_allowed: bool,
    head_error: bool,
    read_checks: usize,
    delivery_checks: usize,
}
impl FixtureOwner {
    fn on(db: &Connection) -> Self {
        Self {
            connection: db as *const Connection,
            current_checks: 0,
            fail_current_at: None,
            read_allowed: true,
            withdraw_read_at: None,
            delivery_allowed: true,
            head_error: false,
            read_checks: 0,
            delivery_checks: 0,
        }
    }
    fn assert_connection(
        &mut self,
        db: &Connection,
    ) -> trillion_local::workspace_heads::Result<()> {
        self.current_checks += 1;
        if self.connection != db as *const Connection
            || self.fail_current_at == Some(self.current_checks)
        {
            return Err(trillion_local::cause!(trillion_local::workspace_heads::Error::SourceChanged));
        }
        Ok(())
    }
}
impl ResourceOwner for FixtureOwner {
    fn assert_current(
        &mut self,
        _: &Binding,
        db: &Connection,
    ) -> trillion_local::workspace_heads::Result<()> {
        self.assert_connection(db)
    }
    fn heads(
        &mut self,
        _: &Binding,
        db: &Connection,
    ) -> trillion_local::workspace_heads::Result<Heads> {
        self.assert_connection(db)?;
        if self.head_error {
            return Err(trillion_local::cause!(trillion_local::workspace_heads::Error::Unavailable));
        }
        // A lone surrogate proves that the actual ECMAScript string survives
        // the real reply serializer rather than taking a lossy Rust String path.
        Heads::new(None, Some(JsString::from_units(vec![0xd800])))
    }
}
impl HeadsRead for FixtureOwner {
    fn assert_read(
        &mut self,
        binding: &Binding,
        db: &Connection,
    ) -> trillion_local::workspace_heads::Result<()> {
        self.read_checks += 1;
        if !self.read_allowed || self.withdraw_read_at == Some(self.read_checks) {
            return Err(trillion_local::cause!(trillion_local::workspace_heads::Error::NotAuthorized));
        }
        self.assert_current(binding, db)
    }
    fn assert_delivery(&mut self, _: &Binding) -> trillion_local::workspace_heads::Result<()> {
        self.delivery_checks += 1;
        if self.delivery_allowed {
            Ok(())
        } else {
            Err(trillion_local::cause!(trillion_local::workspace_heads::Error::NotAuthorized))
        }
    }
}

const ACCOUNT: &str = "synthetic-account";
fn binding() -> Binding {
    Binding::new(ACCOUNT, "synthetic-resource", "generation-1").unwrap()
}
/// A file holding the account's record store, as its RecordBook file holds it after the first start, with the saved
/// revision ceiling `revision` (the screen-revision record) when given.
fn database(revision: Option<i64>) -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    // The supply refuses a path through a symbolic link (the temporary folder's /var is one).
    let path = dir.path().canonicalize().unwrap().join("records.sqlite");
    let bounds = sqlite::Bounds {
        value_bytes: 2 * 1024 * 1024,
        work: u64::MAX / 2,
        deadline: Duration::MAX,
        spend: sqlite::Spend::EachOperation,
        cancel: None,
        busy: Duration::from_secs(5),
    };
    let supply = sqlite::open_owned(&path, "record_store", bounds).unwrap();
    let limits = settings::Limits::fixed(1 << 20, 10 << 30);
    let mut store = RecordStore::new(supply, Box::new(RealClock), limits).unwrap();
    if let Some(revision) = revision {
        let saved = Mutation {
            id: "1".into(),
            expected_version: 0,
            request_key: "saved-ceiling".into(),
            deleted: false,
            value: serde_json::json!({"id": 1, "revision": revision}),
        };
        store.mutate(ACCOUNT, "screen-revision", saved).unwrap();
    }
    drop(store);
    let db = Connection::open(&path).unwrap();
    (dir, db)
}
/// The saved revision ceiling, None when none is saved.
fn saved_ceiling(db: &Connection) -> Option<i64> {
    let store = workspace_store::lend_store(db, Access::Read).ok().unwrap();
    let (_, held) = store.held_record_with_version(ACCOUNT, "screen-revision", "1").unwrap();
    held.map(|record| record.value["revision"].as_i64().unwrap())
}
fn attach(db: &mut Connection, owner: &mut FixtureOwner) -> LiveHeads {
    LiveHeads::attach(binding(), db, owner).unwrap()
}
fn chunk(bytes: &[u8]) -> Value {
    ecma_json::parse(bytes, Limits::default()).unwrap()
}
fn revision(bytes: &[u8]) -> u64 {
    let Value::Object(chunk) = chunk(bytes) else {
        panic!("object chunk expected")
    };
    let Some(Value::Number(value)) = chunk.get(&JsString::from("revision")) else {
        panic!("revision expected")
    };
    *value as u64
}

#[test]
fn cold_and_reopened_heads_reserve_once_and_do_not_bump_on_an_unchanged_read() {
    let (_dir, mut db) = database(None);
    let mut owner = FixtureOwner::on(&db);
    let mut live = attach(&mut db, &mut owner);
    let first_reader = FixtureOwner::on(&db);
    let first = live.read(&mut db, first_reader).unwrap();
    assert_eq!(revision(first.as_ref()), 1);
    assert_eq!(first.work().reservation_rows_changed, 1);
    first.write_to(&mut Vec::new()).unwrap();
    let saved: i64 = saved_ceiling(&db).unwrap();
    assert_eq!(saved, 1025);

    let second_reader = FixtureOwner::on(&db);
    let second = live.read(&mut db, second_reader).unwrap();
    assert_eq!(revision(second.as_ref()), 1);
    assert_eq!(second.work().reservation_rows_changed, 0);
    second.write_to(&mut Vec::new()).unwrap();
    let saved_again: i64 = saved_ceiling(&db).unwrap();
    assert_eq!(saved_again, saved);

    drop(live);
    let mut reopened = attach(&mut db, &mut owner);
    let reopen_reader = FixtureOwner::on(&db);
    let after_reopen = reopened.read(&mut db, reopen_reader).unwrap();
    assert_eq!(revision(after_reopen.as_ref()), 1026);
    assert_eq!(after_reopen.work().reservation_rows_changed, 1);
}

#[test]
fn counted_noop_and_multiple_writes_settle_by_the_actual_sqlite_counter() {
    let (_dir, mut db) = database(None);
    db.execute_batch(
        "CREATE TABLE rows(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO rows VALUES(1,'a');",
    )
    .unwrap();
    let mut owner = FixtureOwner::on(&db);
    let mut live = attach(&mut db, &mut owner);
    let unchanged: String = db
        .query_row("SELECT value FROM rows WHERE id=1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(unchanged, "a");
    db.execute("UPDATE rows SET value='z' WHERE id=99", [])
        .unwrap();
    live.notice_write();
    assert!(
        !live.settle(&db, &mut owner).unwrap(),
        "SQLite no-op UPDATE has no changed row"
    );

    db.execute("UPDATE rows SET value='b' WHERE id=1", [])
        .unwrap();
    db.execute("INSERT INTO rows VALUES(2,'c')", []).unwrap();
    live.notice_write();
    assert!(live.settle(&db, &mut owner).unwrap());
    let reader = FixtureOwner::on(&db);
    let reply = live.read(&mut db, reader).unwrap();
    assert_eq!(
        revision(reply.as_ref()),
        2,
        "one revision covers the entire write turn"
    );
}

#[test]
fn quiet_nested_error_and_rollback_absorb_only_their_counter_delta_and_keep_prior_work() {
    let (_dir, mut db) = database(None);
    db.execute_batch("CREATE TABLE rows(id INTEGER PRIMARY KEY, value TEXT);")
        .unwrap();
    let mut owner = FixtureOwner::on(&db);
    let mut live = attach(&mut db, &mut owner);

    db.execute("INSERT INTO rows VALUES(1,'counted')", [])
        .unwrap();
    live.notice_write();
    let result = live.quietly(&db, &mut owner, |live, db| {
        live.notice_write(); // Neutral scopes must not erase earlier counted work.
        let mut nested_owner = FixtureOwner::on(db);
        db.execute_batch("SAVEPOINT neutral; INSERT INTO rows VALUES(2,'rolled back'); ROLLBACK TO neutral; RELEASE neutral;")
            .map_err(|_| trillion_local::cause!(trillion_local::workspace_heads::Error::Unavailable))?;
        live.quietly(db, &mut nested_owner, |_, db| {
            db.execute("INSERT INTO rows VALUES(3,'neutral')", [])
                .map_err(|_| trillion_local::cause!(trillion_local::workspace_heads::Error::Unavailable))?;
            Err::<(), _>(trillion_local::cause!(trillion_local::workspace_heads::Error::Unavailable))
        })?;
        Ok(())
    });
    assert!(result.is_err());
    assert!(
        live.settle(&db, &mut owner).unwrap(),
        "pre-scope counted change remains pending"
    );

    let mut fresh = attach(&mut db, &mut owner);
    let quiet_error = fresh.quietly(&db, &mut owner, |_, db| {
        db.execute_batch("SAVEPOINT neutral2; INSERT INTO rows VALUES(4,'rolled back'); ROLLBACK TO neutral2; RELEASE neutral2;")
            .map_err(|_| trillion_local::cause!(trillion_local::workspace_heads::Error::Unavailable))?;
        Err::<(), _>(trillion_local::cause!(trillion_local::workspace_heads::Error::Unavailable))
    });
    assert!(quiet_error.is_err());
    fresh.notice_write();
    assert!(
        !fresh.settle(&db, &mut owner).unwrap(),
        "rollback-only neutral delta must not create a revision"
    );
}

#[test]
fn coalescing_defers_a_batch_even_when_a_read_would_otherwise_reserve() {
    let (_dir, mut db) = database(None);
    db.execute_batch("CREATE TABLE rows(id INTEGER PRIMARY KEY);")
        .unwrap();
    let mut owner = FixtureOwner::on(&db);
    let mut live = attach(&mut db, &mut owner);
    live.begin_coalesce().unwrap();
    db.execute("INSERT INTO rows VALUES(1)", []).unwrap();
    live.notice_write();
    // A first read may reserve the cold range during coalescing, but it must
    // defer the counted revision until the outermost release.
    let reader = FixtureOwner::on(&db);
    let first = live.read(&mut db, reader).unwrap();
    assert_eq!(revision(first.as_ref()), 1);
    assert_eq!(first.work().reservation_rows_changed, 1);
    first.write_to(&mut Vec::new()).unwrap();
    live.end_coalesce().unwrap();
    assert!(live.settle(&db, &mut owner).unwrap());
    let reader = FixtureOwner::on(&db);
    let reply = live.read(&mut db, reader).unwrap();
    assert_eq!(revision(reply.as_ref()), 2);
}

#[test]
fn external_change_and_changed_for_report_current_reads_without_losing_revision_semantics() {
    let (_dir, mut db) = database(None);
    db.execute_batch("CREATE TABLE rows(id INTEGER PRIMARY KEY);")
        .unwrap();
    let mut owner = FixtureOwner::on(&db);
    let mut live = attach(&mut db, &mut owner);
    let names = vec![
        "/work/api/records".to_owned(),
        "/work/api/revision".to_owned(),
    ];
    live.changed_for(&names, &db, &mut owner, |_, db| {
        db.execute("INSERT INTO rows VALUES(1)", [])
            .map(|_| ())
            .map_err(|_| trillion_local::cause!(trillion_local::workspace_heads::Error::Unavailable))
    })
    .unwrap();
    assert_eq!(live.take_changed_reads(), names);
    assert!(live.take_changed_reads().is_empty());
    live.changed_elsewhere();
    assert!(
        live.settle(&db, &mut owner).unwrap(),
        "external notification bumps even without a local SQL delta"
    );
    let reader = FixtureOwner::on(&db);
    let reply = live.read(&mut db, reader).unwrap();
    assert_eq!(revision(reply.as_ref()), 2);
}

#[test]
fn stale_physical_source_and_withdrawn_read_or_delivery_rights_refuse_disclosure() {
    let (_dir, mut db) = database(None);
    let mut owner = FixtureOwner::on(&db);
    let mut live = attach(&mut db, &mut owner);
    let (_other_dir, mut other) = database(None);
    let wrong_source_witness = FixtureOwner::on(&db);
    assert!(
        live.read(&mut other, wrong_source_witness).is_err(),
        "a fresh connection is not the admitted resource"
    );

    let mut withdrawn = FixtureOwner::on(&db);
    withdrawn.withdraw_read_at = Some(3); // Withdraw after SQL reservation and head lookup, before commit.
    assert!(live.read(&mut db, withdrawn).is_err());
    let rolled_back: Option<i64> = saved_ceiling(&db);
    assert_eq!(
        rolled_back, None,
        "withdrawal before commit rolls the reservation back"
    );
    let mut unavailable_heads = FixtureOwner::on(&db);
    unavailable_heads.head_error = true;
    assert!(
        live.read(&mut db, unavailable_heads).is_err(),
        "unknown current head decode refuses instead of returning an empty head"
    );
    let after_decode_error: Option<i64> = saved_ceiling(&db);
    assert_eq!(
        after_decode_error, None,
        "head read failure rolls back the uncommitted reservation"
    );

    let mut delivery = FixtureOwner::on(&db);
    delivery.delivery_allowed = false;
    assert!(
        live.read(&mut db, delivery).is_err(),
        "delivery rights are checked before bytes escape"
    );
    let saved: Option<i64> = saved_ceiling(&db);
    assert_eq!(
        saved,
        Some(1025),
        "delivery withdrawal refuses disclosure after the committed reservation"
    );
}

#[test]
fn reply_retains_admission_through_write_and_flush_and_keeps_utf16_payload() {
    struct Guard {
        owner: FixtureOwner,
        dropped: Arc<AtomicBool>,
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }
    impl ResourceOwner for Guard {
        fn assert_current(
            &mut self,
            b: &Binding,
            db: &Connection,
        ) -> trillion_local::workspace_heads::Result<()> {
            self.owner.assert_current(b, db)
        }
        fn heads(
            &mut self,
            b: &Binding,
            db: &Connection,
        ) -> trillion_local::workspace_heads::Result<Heads> {
            self.owner.heads(b, db)
        }
    }
    impl HeadsRead for Guard {
        fn assert_read(
            &mut self,
            b: &Binding,
            db: &Connection,
        ) -> trillion_local::workspace_heads::Result<()> {
            self.owner.assert_read(b, db)
        }
        fn assert_delivery(&mut self, b: &Binding) -> trillion_local::workspace_heads::Result<()> {
            self.owner.assert_delivery(b)
        }
    }
    struct Output {
        flushed: bool,
        bytes: Vec<u8>,
        dropped: Arc<AtomicBool>,
    }
    impl Write for Output {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            assert!(
                !self.dropped.load(Ordering::SeqCst),
                "the reply guard must remain live during write"
            );
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            assert!(
                !self.dropped.load(Ordering::SeqCst),
                "the reply guard must remain live through flush"
            );
            self.flushed = true;
            Ok(())
        }
    }

    let (_dir, mut db) = database(None);
    let mut owner = FixtureOwner::on(&db);
    let mut live = attach(&mut db, &mut owner);
    let dropped = Arc::new(AtomicBool::new(false));
    let guard = Guard {
        owner: FixtureOwner::on(&db),
        dropped: dropped.clone(),
    };
    let reply = live.read(&mut db, guard).unwrap();
    assert!(!dropped.load(Ordering::SeqCst));
    let Value::Object(chunk) = chunk(reply.as_ref()) else {
        panic!("object chunk expected")
    };
    let Some(Value::Object(heads)) = chunk.get(&JsString::from("heads")) else {
        panic!("heads object expected")
    };
    let Some(Value::String(records)) = heads.get(&JsString::from("records")) else {
        panic!("records string expected")
    };
    assert_eq!(records.units(), [0xd800]);
    let mut output = Output {
        flushed: false,
        bytes: Vec::new(),
        dropped: dropped.clone(),
    };
    reply.write_to(&mut output).unwrap();
    assert!(output.flushed);
    assert!(
        dropped.load(Ordering::SeqCst),
        "the consumed reply releases its real guard after flush"
    );
    assert!(output.bytes.windows(6).any(|w| w == br"\ud800"));
}

#[test]
fn told_tail_uses_legacy_items_precedence_and_never_synthesizes_maximum() {
    let parse = |s: &str| ecma_json::parse(s.as_bytes(), Limits::default()).unwrap();
    assert_eq!(
        told_tail(Some(&parse(r#"{"items":[{"seq":9}],"seqs":[100]}"#))).unwrap(),
        Some(9)
    );
    assert_eq!(
        told_tail(Some(&parse(r#"{"items":[],"seqs":[100]}"#))).unwrap(),
        None
    );
    assert_eq!(
        told_tail(Some(&parse(r#"{"seqs":[7,11]}"#))).unwrap(),
        Some(11)
    );
    assert_eq!(told_tail(Some(&parse(r#"{"seqs":[]}"#))).unwrap(), None);
    assert_eq!(told_tail(None).unwrap(), None);
    assert!(told_tail(Some(&parse(r#"{"items":[{"seq":"bad"}]}"#))).is_err());
    assert!(told_tail(Some(&parse(r#"{"seqs":[9007199254740992]}"#))).is_err());
}

#[test]
fn revision_ceiling_overflow_refuses_instead_of_wrapping() {
    let (_dir, mut db) = database(Some(9_007_199_254_740_990));
    let mut owner = FixtureOwner::on(&db);
    let mut live = attach(&mut db, &mut owner);
    let reader = FixtureOwner::on(&db);
    assert!(
        live.read(&mut db, reader).is_err(),
        "reservation cannot exceed the ECMAScript safe integer ceiling"
    );
    let saved: i64 = saved_ceiling(&db).unwrap();
    assert_eq!(
        saved, 9_007_199_254_740_990_i64,
        "overflow leaves the saved ceiling untouched"
    );
}

#[test]
fn made_again_reloads_the_saved_ceiling_and_clears_pending_live_state() {
    let (_dir, mut db) = database(None);
    let mut owner = FixtureOwner::on(&db);
    let mut live = attach(&mut db, &mut owner);
    let first_reader = FixtureOwner::on(&db);
    let first = live.read(&mut db, first_reader).unwrap();
    assert_eq!(revision(first.as_ref()), 1);
    first.write_to(&mut Vec::new()).unwrap();

    db.execute_batch("CREATE TABLE rows(id INTEGER PRIMARY KEY); INSERT INTO rows VALUES(1);")
        .unwrap();
    live.notice_write();
    assert!(live.made_again(&mut db, &mut owner).is_ok());
    assert!(
        !live.settle(&db, &mut owner).unwrap(),
        "reconstruction adopts the actual current counter and clears stale pending work"
    );
    let reader = FixtureOwner::on(&db);
    let current = live.read(&mut db, reader).unwrap();
    assert_eq!(
        revision(current.as_ref()),
        1026,
        "cold current after the saved 1025 ceiling"
    );
    assert_eq!(current.work().reservation_rows_changed, 1);
}

#[test]
fn readonly_existing_database_is_refused_before_attach_or_disclosure() {
    let (dir, writable) = database(None);
    drop(writable);
    let mut db = Connection::open_with_flags(dir.path().join("records.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap();
    let mut owner = FixtureOwner::on(&db);
    assert!(LiveHeads::attach(binding(), &mut db, &mut owner).is_err());
    assert_eq!(saved_ceiling(&db), None, "read-only attach does not write the saved revision");
}

#[test]
fn ambiguous_commit_poison_requires_owner_confirmed_reconstruction_before_retry() {
    let (_dir, mut db) = database(None);
    db.execute_batch(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE parent(id INTEGER PRIMARY KEY);
         CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
         CREATE TRIGGER fail_revision_commit AFTER INSERT ON versions
         BEGIN INSERT INTO child(parent_id) VALUES(999); END;",
    )
    .unwrap();
    let mut owner = FixtureOwner::on(&db);
    let mut live = LiveHeads::attach(binding(), &mut db, &mut owner).unwrap();
    let reader = FixtureOwner::on(&db);
    assert!(
        live.read(&mut db, reader).is_err(),
        "deferred foreign-key failure is reported at COMMIT"
    );
    let retry = FixtureOwner::on(&db);
    assert!(
        live.read(&mut db, retry).is_err(),
        "ambiguous commit poisons this state until the owner reconstructs it"
    );

    db.execute_batch("DROP TRIGGER fail_revision_commit;")
        .unwrap();
    live.made_again(&mut db, &mut owner).unwrap();
    let reader = FixtureOwner::on(&db);
    let reply = live.read(&mut db, reader).unwrap();
    assert_eq!(revision(reply.as_ref()), 1);
}
