// tests/record_source.rs
//
// Purpose: Exercises the bounded physical SQLite record reader on synthetic files.
//
// Non-Negotiable Invariants:
// - Reads require an already-open readonly main handle and fresh source witness.
// - SQLite scalar bytes remain exact; unsafe statements and partial bounded results fail closed.
// - Each reader holds one snapshot and retires it when authority or cancellation changes.
//
// Key Concepts: Read-only SQLite flags, WAL snapshots, caller-owned witnesses, cancellation and bounded result materialization.
//
// Security Considerations: These tests use disposable synthetic SQLite fixtures only. No real account records or authority are represented.
//
// AI Assistant Directive: Keep fixtures synthetic and assertions tied to observable reader behavior.

use rusqlite::{types::Value, Connection, OpenFlags};
use content_crypto::advanced::blake3;
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tempfile::tempdir;
use trillion_local::{
    import::{ReadLimits, SqlValue},
    record_source::{BoundedRecordSql, QueryBudget, SnapshotRecordSql},
};

fn database() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE records(id INTEGER PRIMARY KEY, i INTEGER, r REAL, t TEXT, b BLOB, n);
         INSERT INTO records VALUES(1, -9223372036854775808, 1.2345678901234567, CAST(X'80FF00' AS TEXT), X'00FF80', NULL);
         INSERT INTO records VALUES(2, 9223372036854775807, 1.25, 'second', X'', 7);",
    ).unwrap();
    drop(writer);
    (dir, path)
}

fn readonly(path: &Path) -> Connection {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap()
}

fn reader<W: trillion_local::record_source::RecordSourceWitness>(
    path: &Path,
    limits: ReadLimits,
    witness: W,
    cancel: Arc<AtomicBool>,
) -> SnapshotRecordSql<W> {
    SnapshotRecordSql::begin(readonly(path), limits, witness, cancel).unwrap()
}

fn budget(rows: usize, source_bytes: usize, duration: Duration) -> QueryBudget {
    QueryBudget {
        rows,
        source_bytes,
        deadline: Instant::now() + duration,
    }
}

#[test]
fn caller_budget_exact_row_and_source_byte_boundaries_pass() {
    let (_dir, path) = database();
    let mut source = reader(
        &path,
        ReadLimits::default(),
        || Ok(()),
        Arc::new(AtomicBool::new(false)),
    );
    // "id" costs 2 bytes and each integer cell costs 8: 18 total.
    let rows = source
        .query_with_budget(
            "SELECT id FROM records ORDER BY id",
            &[],
            budget(2, 18, Duration::from_secs(2)),
        )
        .unwrap();
    assert_eq!(rows.rows.len(), 2);
    assert!(source.last_query_timing().is_some());
}

#[test]
fn one_too_small_budget_refuses_without_partial_success_and_retires_snapshot() {
    let (_dir, path) = database();
    let mut source = reader(
        &path,
        ReadLimits::default(),
        || Ok(()),
        Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(
        source
            .query_with_budget(
                "SELECT id FROM records ORDER BY id",
                &[],
                budget(2, 18, Duration::from_secs(2)),
            )
            .unwrap()
            .rows
            .len(),
        2
    );
    let byte_short = source.query_with_budget(
        "SELECT id FROM records ORDER BY id",
        &[],
        budget(2, 17, Duration::from_secs(2)),
    );
    assert!(matches!(
        byte_short,
        Err(trillion_local::import::ImportError::Budget(_, _))
    ));
    assert!(source.query("SELECT id FROM records", &[]).is_err());

    let mut source = reader(
        &path,
        ReadLimits::default(),
        || Ok(()),
        Arc::new(AtomicBool::new(false)),
    );
    let row_short = source.query_with_budget(
        "SELECT id FROM records ORDER BY id",
        &[],
        budget(1, 18, Duration::from_secs(2)),
    );
    assert!(matches!(
        row_short,
        Err(trillion_local::import::ImportError::Budget(_, _))
    ));
    assert!(source.query("SELECT id FROM records", &[]).is_err());
}

#[test]
fn zero_and_expired_budgets_refuse_before_sql_is_dispatched() {
    let (_dir, path) = database();
    for budget in [
        QueryBudget {
            rows: 0,
            source_bytes: usize::MAX,
            deadline: Instant::now() + Duration::from_secs(1),
        },
        QueryBudget {
            rows: 1,
            source_bytes: 1,
            deadline: Instant::now() - Duration::from_millis(1),
        },
        QueryBudget {
            rows: 1,
            source_bytes: 0,
            deadline: Instant::now() + Duration::from_secs(1),
        },
    ] {
        let mut source = reader(
            &path,
            ReadLimits::default(),
            || Ok(()),
            Arc::new(AtomicBool::new(false)),
        );
        // If preparation were reached, this missing table would return a SQLite error.
        assert!(matches!(
            source.query_with_budget("SELECT * FROM no_such_table", &[], budget),
            Err(trillion_local::import::ImportError::Budget(_, _))
        ));
    }
}

#[test]
fn delayed_witness_does_not_extend_absolute_caller_deadline() {
    let (_dir, path) = database();
    let mut source = reader(
        &path,
        ReadLimits::default(),
        || {
            thread::sleep(Duration::from_millis(30));
            Ok(())
        },
        Arc::new(AtomicBool::new(false)),
    );
    let result = source.query_with_budget(
        "SELECT * FROM no_such_table",
        &[],
        budget(10, 1024, Duration::from_millis(10)),
    );
    assert!(matches!(
        result,
        Err(trillion_local::import::ImportError::Budget(_, _))
    ));
}

#[test]
fn caller_caps_cannot_raise_original_read_limits() {
    let (_dir, path) = database();
    let limits = ReadLimits {
        rows: 1,
        ..ReadLimits::default()
    };
    let mut source = reader(&path, limits, || Ok(()), Arc::new(AtomicBool::new(false)));
    assert!(matches!(
        source.query_with_budget(
            "SELECT id FROM records ORDER BY id",
            &[],
            budget(100, 10_000, Duration::from_secs(2)),
        ),
        Err(trillion_local::import::ImportError::Refused(_, _))
    ));
}

#[derive(Default)]
struct UnsupportedSupplier {
    query_called: bool,
}
impl BoundedRecordSql for UnsupportedSupplier {
    fn query(
        &mut self,
        _sql: &str,
        _params: &[Value],
    ) -> trillion_local::import::ImportResult<trillion_local::import::QueryRows> {
        self.query_called = true;
        Ok(trillion_local::import::QueryRows {
            columns: vec![],
            rows: vec![],
            progress_callbacks: 0,
        })
    }
}

#[test]
fn unsupported_adapter_budget_refuses_without_dispatch_or_fabricated_timing() {
    let mut supplier = UnsupportedSupplier::default();
    assert!(matches!(
        supplier.query_with_budget("SELECT 1", &[], budget(1, 8, Duration::from_secs(1))),
        Err(trillion_local::import::ImportError::Budget(_, _))
    ));
    assert!(!supplier.query_called);
    assert!(supplier.last_query_timing().is_none());
}

#[test]
fn preserves_exact_integer_real_text_blob_and_null_values() {
    let (_dir, path) = database();
    let mut source = reader(
        &path,
        ReadLimits::default(),
        || Ok(()),
        Arc::new(AtomicBool::new(false)),
    );
    let rows = source
        .query(
            "SELECT i,r,t,b,n FROM records WHERE id=?",
            &[Value::Integer(1)],
        )
        .unwrap();
    assert_eq!(
        rows.rows,
        vec![vec![
            SqlValue::Integer(i64::MIN),
            SqlValue::RealBits(1.2345678901234567f64.to_bits()),
            SqlValue::Text(vec![0x80, 0xff, 0]),
            SqlValue::Blob(vec![0, 0xff, 0x80]),
            SqlValue::Null,
        ]]
    );
    source.finish().unwrap();
}

#[test]
fn refuses_writable_memory_and_already_transactional_connections() {
    let (_dir, path) = database();
    let cancel = Arc::new(AtomicBool::new(false));
    assert!(SnapshotRecordSql::begin(
        Connection::open(&path).unwrap(),
        ReadLimits::default(),
        || Ok(()),
        cancel.clone()
    )
    .is_err());
    assert!(SnapshotRecordSql::begin(
        Connection::open_in_memory().unwrap(),
        ReadLimits::default(),
        || Ok(()),
        cancel.clone()
    )
    .is_err());
    let active = readonly(&path);
    active.execute_batch("BEGIN").unwrap();
    assert!(SnapshotRecordSql::begin(active, ReadLimits::default(), || Ok(()), cancel).is_err());
}

#[test]
fn denies_mutation_attach_unsafe_functions_and_mutating_pragmas_but_allows_reads() {
    let (_dir, path) = database();
    let mut source = reader(
        &path,
        ReadLimits::default(),
        || Ok(()),
        Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(
        source
            .query("SELECT count(*) FROM records", &[])
            .unwrap()
            .rows
            .len(),
        1
    );
    assert!(source.query("PRAGMA table_info(records)", &[]).is_ok());
    for sql in [
        "DELETE FROM records WHERE id=1",
        "ATTACH DATABASE ':memory:' AS other",
        "SELECT load_extension('x')",
        "PRAGMA journal_mode=DELETE",
        "SELECT 1; SELECT 2",
    ] {
        let mut source = reader(
            &path,
            ReadLimits::default(),
            || Ok(()),
            Arc::new(AtomicBool::new(false)),
        );
        assert!(source.query(sql, &[]).is_err(), "accepted {sql}");
    }
}

#[test]
fn every_output_budget_refuses_without_returning_partial_rows() {
    let (_dir, path) = database();
    let cases = [
        ReadLimits {
            sql_bytes: 1,
            ..ReadLimits::default()
        },
        ReadLimits {
            columns: 1,
            ..ReadLimits::default()
        },
        ReadLimits {
            rows: 1,
            ..ReadLimits::default()
        },
        ReadLimits {
            cell_bytes: 2,
            ..ReadLimits::default()
        },
        ReadLimits {
            result_bytes: 2,
            ..ReadLimits::default()
        },
        ReadLimits {
            vm_steps: 1,
            ..ReadLimits::default()
        },
        ReadLimits {
            elapsed: Duration::from_nanos(1),
            ..ReadLimits::default()
        },
    ];
    for limits in cases {
        let mut source = reader(&path, limits, || Ok(()), Arc::new(AtomicBool::new(false)));
        assert!(source
            .query("SELECT id,t FROM records ORDER BY id", &[])
            .is_err());
    }
}

#[test]
fn stale_witness_before_query_or_after_query_withholds_result_and_retires_reader() {
    let (_dir, path) = database();
    let current = Arc::new(AtomicBool::new(false));
    let witness = {
        let current = current.clone();
        move || {
            if current.load(Ordering::Acquire) {
                Err(trillion_local::import::ImportError::Refused(
                    "stale test witness",
                 trillion_local::cause!()))
            } else {
                Ok(())
            }
        }
    };
    let mut source = reader(
        &path,
        ReadLimits::default(),
        witness,
        Arc::new(AtomicBool::new(false)),
    );
    current.store(true, Ordering::Release);
    assert!(source.query("SELECT id FROM records", &[]).is_err());
    current.store(false, Ordering::Release);
    assert!(
        source.query("SELECT id FROM records", &[]).is_err(),
        "restored rights cannot revive a retired read snapshot"
    );

    let current = Arc::new(AtomicBool::new(false));
    let checks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let witness = {
        let current = current.clone();
        let checks = checks.clone();
        move || {
            if checks.fetch_add(1, Ordering::SeqCst) >= 3 {
                current.store(true, Ordering::Release);
            }
            if current.load(Ordering::Acquire) {
                Err(trillion_local::import::ImportError::Refused(
                    "stale test witness",
                 trillion_local::cause!()))
            } else {
                Ok(())
            }
        }
    };
    let mut source = reader(
        &path,
        ReadLimits::default(),
        witness,
        Arc::new(AtomicBool::new(false)),
    );
    assert!(source.query("SELECT id FROM records", &[]).is_err());
}

#[test]
fn cancellation_before_begin_and_during_sqlite_work_refuses() {
    let (_dir, path) = database();
    let cancelled = Arc::new(AtomicBool::new(true));
    assert!(SnapshotRecordSql::begin(
        readonly(&path),
        ReadLimits::default(),
        || Ok(()),
        cancelled.clone()
    )
    .is_err());
    cancelled.store(false, Ordering::Release);
    let mut before_query = reader(&path, ReadLimits::default(), || Ok(()), cancelled.clone());
    cancelled.store(true, Ordering::Release);
    assert!(before_query.query("SELECT id FROM records", &[]).is_err());
    cancelled.store(false, Ordering::Release);
    let mut limits = ReadLimits::default();
    limits.vm_steps = 100_000_000;
    limits.elapsed = Duration::from_secs(10);
    let mut source = reader(&path, limits, || Ok(()), cancelled.clone());
    let signal = cancelled.clone();
    let canceller = thread::spawn(move || {
        thread::sleep(Duration::from_millis(10));
        signal.store(true, Ordering::Release);
    });
    let result = source.query(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n",
        &[],
    );
    canceller.join().unwrap();
    assert!(matches!(
        result,
        Err(trillion_local::import::ImportError::Refused(
            "record read was cancelled"
        , _))
    ));
}

#[test]
fn wal_reader_keeps_one_snapshot_and_finish_rechecks_authority() {
    let (_dir, path) = database();
    let current = Arc::new(AtomicBool::new(true));
    let witness = {
        let current = current.clone();
        move || {
            if current.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err(trillion_local::import::ImportError::Refused(
                    "authority withdrawn",
                 trillion_local::cause!()))
            }
        }
    };
    let mut source = reader(
        &path,
        ReadLimits::default(),
        witness,
        Arc::new(AtomicBool::new(false)),
    );
    let first = source.query("SELECT count(*) FROM records", &[]).unwrap();
    assert_eq!(first.rows[0][0], SqlValue::Integer(2));
    let writer = Connection::open(&path).unwrap();
    writer
        .execute(
            "INSERT INTO records(id,i,r,t,b,n) VALUES(3,3,3.0,'third',X'03',3)",
            [],
        )
        .unwrap();
    let same_snapshot = source.query("SELECT count(*) FROM records", &[]).unwrap();
    assert_eq!(same_snapshot.rows[0][0], SqlValue::Integer(2));
    drop(writer);
    current.store(false, Ordering::Release);
    assert!(source.finish().is_err());
    let checkpoint = Connection::open(&path).unwrap();
    let (busy, _, _): (i64, i64, i64) = checkpoint
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!(busy, 0, "finished reader must release its WAL snapshot");
    drop(checkpoint);
    let check = readonly(&path);
    assert_eq!(
        check
            .query_row("SELECT count(*) FROM records", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[cfg(unix)]
#[test]
fn restored_directory_metadata_cannot_admit_a_different_open_sqlite_handle() {
    use std::os::unix::fs::MetadataExt;
    let root = tempdir().unwrap();
    let selected = root.path().join("selected");
    let replacement = root.path().join("replacement");
    let held = root.path().join("held");
    for (directory, value) in [(&selected, 1), (&replacement, 2)] {
        fs::create_dir(directory).unwrap();
        let db = Connection::open(directory.join("records.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE item(value INTEGER NOT NULL)")
            .unwrap();
        db.execute("INSERT INTO item VALUES(?)", [value]).unwrap();
        db.close().unwrap();
    }
    let path = selected.join("records.sqlite");
    let stamp = |metadata: fs::Metadata| {
        (
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        )
    };
    let before = stamp(fs::metadata(&path).unwrap());
    let pin = blake3::hash(&fs::read(&path).unwrap());
    // Model the physical verify -> SQLite open interval with real directory
    // renames. This does not inject or claim an exploited original-account read.
    fs::rename(&selected, &held).unwrap();
    fs::rename(&replacement, &selected).unwrap();
    let wrong_handle = readonly(&path);
    assert_eq!(
        wrong_handle
            .query_row("SELECT value FROM item", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    fs::rename(&selected, &replacement).unwrap();
    fs::rename(&held, &selected).unwrap();
    assert_eq!(
        before,
        stamp(fs::metadata(&path).unwrap()),
        "named-file metadata alone sees the restored original"
    );
    assert_eq!(pin, blake3::hash(&fs::read(&path).unwrap()));
    assert!(
        SnapshotRecordSql::begin(
            wrong_handle,
            ReadLimits::default(),
            || Ok(()),
            Arc::new(AtomicBool::new(false))
        )
        .is_err(),
        "the actual SQLite handle must also match its current named path"
    );
    let mut correct = reader(
        &path,
        ReadLimits::default(),
        || Ok(()),
        Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(
        correct.query("SELECT value FROM item", &[]).unwrap().rows[0][0],
        SqlValue::Integer(1)
    );
    correct.finish().unwrap();
}

#[test]
fn caller_deadline_interrupts_sqlite_and_retires_snapshot() {
    let (_dir, path) = database();
    let mut source = reader(
        &path,
        ReadLimits {
            vm_steps: 100_000_000,
            elapsed: Duration::from_secs(2),
            ..ReadLimits::default()
        },
        || Ok(()),
        Arc::new(AtomicBool::new(false)),
    );
    let result = source.query_with_budget("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n", &[], budget(1,1024,Duration::from_millis(10)));
    assert!(matches!(
        result,
        Err(trillion_local::import::ImportError::Budget(_, _))
    ));
    assert!(source.query("SELECT 1", &[]).is_err());
}

#[test]
fn caller_deadline_withholds_result_when_post_query_witness_is_slow() {
    let (_dir, path) = database();
    let mut checks = 0;
    let mut source = reader(
        &path,
        ReadLimits::default(),
        move || {
            checks += 1;
            // begin checks twice, then one pre-query and one post-query witness.
            if checks == 4 {
                thread::sleep(Duration::from_millis(30));
            }
            Ok(())
        },
        Arc::new(AtomicBool::new(false)),
    );
    assert!(matches!(
        source.query_with_budget(
            "SELECT id FROM records",
            &[],
            budget(2, 18, Duration::from_millis(10))
        ),
        Err(trillion_local::import::ImportError::Budget(_, _))
    ));
    assert!(source.query("SELECT 1", &[]).is_err());
}

#[test]
fn source_reports_its_actual_ceilings_without_inventing_supported_defaults() {
    let (_dir, path) = database();
    let mut limits = ReadLimits::default();
    limits.rows = 17;
    limits.result_bytes = 4096;
    let source = reader(&path, limits, || Ok(()), Arc::new(AtomicBool::new(false)));
    let actual = source.read_limits().unwrap();
    assert_eq!(actual.rows, 17);
    assert_eq!(actual.result_bytes, 4096);
    source.finish().unwrap();
    struct Unsupported;
    impl BoundedRecordSql for Unsupported {
        fn query(
            &mut self,
            _: &str,
            _: &[Value],
        ) -> trillion_local::import::ImportResult<trillion_local::import::QueryRows> {
            panic!("no SQL for a ceiling probe")
        }
    }
    assert!(Unsupported.read_limits().is_none());
}


#[test]
fn ordered_prefix_packet_admits_exact_rows_and_resumes_same_snapshot() {
    let (_dir,path)=database();
    let mut limits=ReadLimits::default();limits.result_bytes=10;
    let mut source=reader(&path,limits,||Ok(()),Arc::new(AtomicBool::new(false)));
    assert!(source.supports_ordered_prefix());
    let one=source.query_ordered_prefix_with_budget("SELECT id FROM records WHERE id>? ORDER BY id",&[Value::Integer(0)],budget(2,100,Duration::from_secs(2))).unwrap();
    assert_eq!(one.rows,vec![vec![SqlValue::Integer(1)]]);
    let two=source.query_ordered_prefix_with_budget("SELECT id FROM records WHERE id>? ORDER BY id",&[Value::Integer(1)],budget(2,100,Duration::from_secs(2))).unwrap();
    assert_eq!(two.rows,vec![vec![SqlValue::Integer(2)]]);
    source.finish().unwrap();
}
#[test]
fn ordered_prefix_never_truncates_caller_aggregate_bound() {
    let (_dir,path)=database();let mut limits=ReadLimits::default();limits.result_bytes=18;
    let mut source=reader(&path,limits,||Ok(()),Arc::new(AtomicBool::new(false)));
    assert!(matches!(source.query_ordered_prefix_with_budget("SELECT id FROM records ORDER BY id",&[],budget(2,10,Duration::from_secs(2))),Err(trillion_local::import::ImportError::Budget(_, _))));
    assert!(source.query("SELECT 1",&[]).is_err());
}
#[test]
fn ordered_prefix_empty_packet_has_no_oversize_row_and_remains_provisional() {
    let (_dir,path)=database();let mut limits=ReadLimits::default();limits.result_bytes=9;
    let mut source=reader(&path,limits,||Ok(()),Arc::new(AtomicBool::new(false)));
    let empty=source.query_ordered_prefix_with_budget("SELECT id FROM records ORDER BY id",&[],budget(2,100,Duration::from_secs(2))).unwrap();
    assert!(empty.rows.is_empty());
    assert_eq!(source.query("SELECT 1",&[]).unwrap().rows,vec![vec![SqlValue::Integer(1)]]);
    source.finish().unwrap();
}
#[test]
fn ordered_prefix_cell_overflow_retires_instead_of_returning_prior_rows() {
    let (_dir,path)=database();let db=Connection::open(&path).unwrap();
    db.execute("UPDATE records SET t=? WHERE id=2",["x".repeat(101)]).unwrap();drop(db);
    let mut limits=ReadLimits::default();limits.cell_bytes=100;limits.result_bytes=200;
    let mut source=reader(&path,limits,||Ok(()),Arc::new(AtomicBool::new(false)));
    assert!(source.query_ordered_prefix_with_budget("SELECT t FROM records ORDER BY id",&[],budget(2,1000,Duration::from_secs(2))).is_err());
    assert!(source.finish().is_err());
}
#[test]
fn ordered_prefix_cancellation_and_withdrawal_between_packets_retire() {
    for cancel in [false,true] {
        let (_dir,path)=database();let mut limits=ReadLimits::default();limits.result_bytes=10;
        let stopped=Arc::new(AtomicBool::new(false));let revoked=Arc::new(AtomicBool::new(false));let rights=revoked.clone();
        let mut source=reader(&path,limits,move||if rights.load(Ordering::Acquire){Err(trillion_local::import::ImportError::Refused("synthetic withdrawal", trillion_local::cause!()))}else{Ok(())},stopped.clone());
        assert_eq!(source.query_ordered_prefix_with_budget("SELECT id FROM records ORDER BY id",&[],budget(2,100,Duration::from_secs(2))).unwrap().rows.len(),1);
        if cancel {stopped.store(true,Ordering::Release)} else {revoked.store(true,Ordering::Release)}
        assert!(source.query_ordered_prefix_with_budget("SELECT id FROM records WHERE id>1 ORDER BY id",&[],budget(2,100,Duration::from_secs(2))).is_err());
        assert!(source.finish().is_err());
    }
}


#[test]
fn ordered_prefix_borrowed_overpacket_row_remains_in_actual_work() {
    use trillion_local::sqlite_work::{ObservedConnection,WorkMeter};
    let (_dir,path)=database();let mut limits=ReadLimits::default();limits.result_bytes=10;
    let meter=WorkMeter::new();
    // SAFETY: exclusively owned fresh synthetic handle with no trace hook.
    let observed=unsafe{ObservedConnection::attach_untraced(readonly(&path),meter.clone())}.unwrap();
    let mut source=SnapshotRecordSql::begin(observed,limits,||Ok(()),Arc::new(AtomicBool::new(false))).unwrap();
    let before_observation=meter.snapshot().unwrap();let before=before_observation.work;
    let one=source.query_ordered_prefix_with_budget("SELECT id FROM records WHERE id>? ORDER BY id",&[Value::Integer(0)],budget(2,100,Duration::from_secs(2))).unwrap();
    let first_observation=meter.snapshot().unwrap();let first=first_observation.work;
    assert_eq!(one.rows.len(),1);
    assert_eq!(first.sqlite_scan_visits-before.sqlite_scan_visits,2);
    assert_eq!(first.rows_returned-before.rows_returned-(first_observation.unattributed_row_events-before_observation.unattributed_row_events),2);
    let two=source.query_ordered_prefix_with_budget("SELECT id FROM records WHERE id>? ORDER BY id",&[Value::Integer(1)],budget(2,100,Duration::from_secs(2))).unwrap();
    let second_observation=meter.snapshot().unwrap();let second=second_observation.work;
    assert_eq!(two.rows.len(),1);
    assert_eq!(second.sqlite_scan_visits-first.sqlite_scan_visits,1);
    assert_eq!(second.rows_returned-first.rows_returned,1);
    eprintln!("PREFIX_PACKET_ACTUAL {}",serde_json::json!({"first":{"copied_rows":1,"sql":first.sql_statements-before.sql_statements,"sqlite_visits":first.sqlite_scan_visits-before.sqlite_scan_visits,"sqlite_returned_rows":first.rows_returned-before.rows_returned,"unattributed_row_events":first_observation.unattributed_row_events-before_observation.unattributed_row_events,"vm_steps":first.vm_steps-before.vm_steps},"continuation":{"copied_rows":1,"sql":second.sql_statements-first.sql_statements,"sqlite_visits":second.sqlite_scan_visits-first.sqlite_scan_visits,"sqlite_returned_rows":second.rows_returned-first.rows_returned,"unattributed_row_events":second_observation.unattributed_row_events-first_observation.unattributed_row_events,"vm_steps":second.vm_steps-first.vm_steps}}));
    source.finish().unwrap();
}


#[test]
fn ordered_prefix_shared_owner_keeps_packet_and_total_allowances_distinct() {
    use trillion_local::current_record_keys::{SharedRecordSql,SharedLimits};
    for total in [15,100] {
        let (_dir,path)=database();let mut limits=ReadLimits::default();limits.result_bytes=10;
        let source=reader(&path,limits,||Ok(()),Arc::new(AtomicBool::new(false)));
        let mut shared=SharedRecordSql::new(source,SharedLimits{source_bytes:total,..Default::default()}).unwrap();
        assert!(shared.supports_ordered_prefix());
        let first=shared.query_ordered_prefix_with_budget("SELECT id FROM records WHERE id>? ORDER BY id",&[Value::Integer(0)],budget(2,100,Duration::from_secs(2))).unwrap();
        assert_eq!(first.rows,vec![vec![SqlValue::Integer(1)]]);
        assert_eq!(shared.work().unwrap().source_bytes,10);
        let second=shared.query_ordered_prefix_with_budget("SELECT id FROM records WHERE id>? ORDER BY id",&[Value::Integer(1)],budget(2,100,Duration::from_secs(2)));
        if total==15 {
            assert!(matches!(second,Err(trillion_local::import::ImportError::Budget(_, _))));
            assert!(shared.query("SELECT 1",&[]).is_err());
        } else {
            assert_eq!(second.unwrap().rows,vec![vec![SqlValue::Integer(2)]]);
            let work=shared.work().unwrap();assert_eq!(work.rows_returned,2);assert_eq!(work.source_bytes,20);assert_eq!(work.sql_statements,2);
            shared.try_into_source().unwrap().finish().unwrap();
        }
    }
}


#[test]
fn late_postcheck_clock_cannot_relabel_hard_sql_or_vm_exhaustion() {
    for work_failure in [false, true] {
        let (_dir, path) = database();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = calls.clone();
        let witness = move || {
            if observed.fetch_add(1, Ordering::SeqCst) == 3 {
                thread::sleep(Duration::from_millis(30));
            }
            Ok(())
        };
        let mut limits = ReadLimits::default();
        if work_failure { limits.vm_steps = 1000; }
        let mut source = reader(&path, limits, witness, Arc::new(AtomicBool::new(false)));
        let sql = if work_failure {
            "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n"
        } else { "SELECT value FROM absent_hard_source_table" };
        let result = source.query_with_budget(sql, &[], budget(1,1024,Duration::from_millis(10)));
        assert!(matches!(result, Err(trillion_local::import::ImportError::Sqlite(_, _))));
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        assert!(source.query("SELECT 1", &[]).is_err());
    }
}
