//! Opposing current-key controls over synthetic file-backed SQLite snapshots.
//! Mounted by the native integration owner; fixture keys are synthetic only.
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{AeadInPlace, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value as Json};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tempfile::{tempdir, TempDir};
use trillion_local::{
    current_record_keys::{CurrentKeyReader, KeyLimits, SharedLimits, SharedRecordSql},
    ecma_json::{self, JsString, Object, Value},
    import::{ImportError, ImportResult, QueryRows, QueryTiming, ReadLimits, SqlValue},
    kept_runs::{KeptRuns, Settings as KeptSettings},
    legacy_kept::{LegacyKept, Limits as KeptLimits},
    record_sealed,
    record_source::{BoundedRecordSql, QueryBudget, RecordSourceWitness, SnapshotRecordSql},
    record_value::{CurrentKeys, Error as ValueError, KeyState},
};

struct Fixture {
    _dir: TempDir,
    path: PathBuf,
}
fn fixture(build: impl FnOnce(&mut Connection, &mut KeptRuns)) -> Fixture {
    let dir = tempdir().unwrap();
    let path = dir.path().join("current-records.sqlite");
    let mut db = Connection::open(&path).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE record_log(
           id TEXT, transaction_id TEXT, actor_context TEXT,
           application_time TEXT, system_time TEXT,
           part INTEGER, parts INTEGER, envelopes TEXT, keys TEXT
         );
         CREATE TABLE record_erasable_keys(
           record_id TEXT PRIMARY KEY, key BLOB, erased_at TEXT, erased_fields TEXT
         );",
    )
    .unwrap();
    let tx = db.transaction().unwrap();
    let mut runs = KeptRuns::create(&tx, "record_keys", KeptSettings::default()).unwrap();
    tx.commit().unwrap();
    db.execute(
        "INSERT INTO record_keys_meta(key,value) VALUES('engine','\"record-log\"')",
        [],
    )
    .unwrap();
    build(&mut db, &mut runs);
    let tx = db.transaction().unwrap();
    runs.flush(&tx, &json!(0)).unwrap();
    tx.commit().unwrap();
    drop(runs);
    drop(db);
    Fixture { _dir: dir, path }
}
fn key_json(key: &[u8; 32]) -> Json {
    json!({"key": STANDARD.encode(key)})
}
fn add_log_key(db: &Connection, owner: &str, key: &[u8; 32]) {
    let mut keys = serde_json::Map::new();
    keys.insert(owner.into(), json!(STANDARD.encode(key)));
    let encoded = Json::Object(keys).to_string();
    db.execute(
        "INSERT INTO record_log(id,transaction_id,part,parts,envelopes,keys) VALUES('synthetic-log','synthetic-tx',0,1,'[]',?)",
        [encoded],
    )
    .unwrap();
}
fn reader_source<W: RecordSourceWitness>(path: &Path, witness: W) -> SnapshotRecordSql<W> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    SnapshotRecordSql::begin(
        db,
        ReadLimits::default(),
        witness,
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap()
}
fn shared<W: RecordSourceWitness>(
    path: &Path,
    witness: W,
) -> SharedRecordSql<SnapshotRecordSql<W>> {
    SharedRecordSql::new(reader_source(path, witness), SharedLimits::default()).unwrap()
}
fn kept() -> LegacyKept {
    LegacyKept::new(KeptLimits::default()).unwrap()
}
fn sealed(id: &str, field: &str, key: &[u8; 32], raw_json: &str) -> Value {
    let cipher = XChaCha20Poly1305::new_from_slice(key).unwrap();
    let nonce = [7_u8; 24];
    let mut ciphertext = raw_json.as_bytes().to_vec();
    cipher
        .encrypt_in_place(
            XNonce::from_slice(&nonce),
            format!("{id}\0{field}").as_bytes(),
            &mut ciphertext,
        )
        .unwrap();
    let mut envelope = vec![1];
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    let mut object = Object::new();
    object.insert(
        JsString::from(record_sealed::SEALED_MARK),
        Value::String(STANDARD.encode(envelope).into()),
    );
    Value::Object(object)
}
fn assert_opens(state: KeyState, id: &str, key: &[u8; 32], raw_json: &str) {
    let KeyState::Present(secret) = state else {
        panic!("the current owner must return the selected key")
    };
    assert_eq!(format!("{secret:?}"), "SecretFieldKey([redacted])");
    let Value::Object(field) = sealed(id, "value", key, raw_json) else {
        unreachable!()
    };
    let opened = record_sealed::open(
        &secret,
        id,
        &JsString::from("value"),
        &field,
        ecma_json::Limits::default(),
    )
    .unwrap()
    .expect("fixture ciphertext must open only with the selected current key");
    assert_eq!(
        opened.0,
        ecma_json::parse(raw_json.as_bytes(), ecma_json::Limits::default()).unwrap()
    );
}

fn assert_recreated_key(state: KeyState, old: &[u8; 32], fresh: &[u8; 32]) {
    let KeyState::Present(secret) = state else {
        panic!("the recreated current owner must supply its new key")
    };
    let field_name = JsString::from("value");
    for (key, should_open) in [(old, false), (fresh, true)] {
        let Value::Object(field) = sealed("owner", "value", key, r#"{"new":"words"}"#) else {
            unreachable!()
        };
        let opened = record_sealed::open(
            &secret,
            "owner",
            &field_name,
            &field,
            ecma_json::Limits::default(),
        )
        .unwrap();
        assert_eq!(opened.is_some(), should_open);
        if let Some(opened) = opened {
            assert_eq!(
                opened.0,
                ecma_json::parse(br#"{"new":"words"}"#, Default::default()).unwrap()
            );
        }
    }
}

fn erase_fixture_key(db: &Connection, runs: &mut KeptRuns, id: &str) {
    // Model the original erase transaction's current-root cleanup, rather
    // than leave an impossible positive old root beside the tombstone.
    runs.remove(&format!("e\0{id}")).unwrap();
    runs.put(&format!("i\0{id}"), json!(["kind", "sequence", null, null]))
        .unwrap();
    db.execute("UPDATE record_log SET keys=NULL", []).unwrap();
    db.execute(
        "INSERT INTO record_erasable_keys(record_id,key,erased_at,erased_fields) VALUES(?1,NULL,'synthetic-erasure','[]')",
        [id],
    )
    .unwrap();
}

#[test]
fn recreated_open_log_key_survives_retained_erasure_but_cannot_open_old_ciphertext() {
    let old = [19; 32];
    let fresh = [23; 32];
    let fixture = fixture(|db, runs| {
        runs.put("e\0owner", key_json(&old)).unwrap();
        erase_fixture_key(db, runs, "owner");
        add_log_key(db, "owner", &fresh);
    });
    let kept = kept();
    let mut keys =
        CurrentKeyReader::new(shared(&fixture.path, || Ok(())), &kept, Default::default()).unwrap();
    assert_recreated_key(keys.key("owner").unwrap(), &old, &fresh);
    keys.into_source().finish().unwrap();
}

#[test]
fn recreated_current_roots_survive_retained_erasure_after_raw_log_keys_are_cleared() {
    let old = [29; 32];
    let fresh = [37; 32];
    for (index_holder, sealed_generation) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let fixture = fixture(|db, runs| {
            runs.put("e\0owner", key_json(&old)).unwrap();
            erase_fixture_key(db, runs, "owner");
            add_log_key(db, "owner", &fresh);
            // Sealing clears raw keys and preserves the flushed current root.
            db.execute("UPDATE record_log SET keys=NULL", []).unwrap();
            if index_holder {
                // A tombstoned e entry must still fall through to i[4].
                runs.put(
                    "i\0owner",
                    json!(["kind", "sequence", null, null, key_json(&fresh)]),
                )
                .unwrap();
            } else {
                runs.put("e\0owner", key_json(&fresh)).unwrap();
            }
            if sealed_generation {
                db.execute_batch("ALTER TABLE record_log RENAME TO record_log_sealed_0123456789ab7cde8f01234567890abc;
                    CREATE TABLE record_log(id TEXT,transaction_id TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT)").unwrap();
            }
        });
        let kept = kept();
        let mut keys =
            CurrentKeyReader::new(shared(&fixture.path, || Ok(())), &kept, Default::default())
                .unwrap();
        assert_recreated_key(keys.key("owner").unwrap(), &old, &fresh);
        keys.into_source().finish().unwrap();
    }
}

#[test]
fn recreated_table_key_without_a_log_row_survives_tombstoned_current_roots() {
    let old = [43; 32];
    let fresh = [59; 32];
    let fixture = fixture(|db, runs| {
        erase_fixture_key(db, runs, "owner");
        runs.remove("i\0owner").unwrap();
        // Original ensureKept creates a new table key and clears erased_at;
        // it does not need a current record root or an appended log row.
        db.execute(
            "UPDATE record_erasable_keys SET key=?1,erased_at=NULL WHERE record_id='owner'",
            [fresh.as_slice()],
        )
        .unwrap();
    });
    let kept = kept();
    let mut keys =
        CurrentKeyReader::new(shared(&fixture.path, || Ok(())), &kept, Default::default()).unwrap();
    assert_recreated_key(keys.key("owner").unwrap(), &old, &fresh);
    keys.into_source().finish().unwrap();
}

#[test]
fn current_checkpoint_e_key_and_fifth_index_holder_open_only_with_their_selected_keys() {
    let e_key = [31_u8; 32];
    let index_key = [47_u8; 32];
    let fixture = fixture(|_, runs| {
        runs.put("e\0entity-e", key_json(&e_key)).unwrap();
        runs.put(
            "i\0entity-i",
            json!(["kind", "id", null, null, {"key": STANDARD.encode(index_key)}]),
        )
        .unwrap();
    });
    let source = shared(&fixture.path, || Ok(()));
    let kept = kept();
    let mut keys = CurrentKeyReader::new(source.clone(), &kept, KeyLimits::default()).unwrap();
    assert_opens(
        keys.key("entity-e").unwrap(),
        "entity-e",
        &e_key,
        r#"{"selected":"e-checkpoint"}"#,
    );
    assert_opens(
        keys.key("entity-i").unwrap(),
        "entity-i",
        &index_key,
        r#"{"selected":"fifth-slot"}"#,
    );
    let work = source.work().unwrap();
    assert!(work.sql_statements > 1);
    assert!(work.rows_returned > 0);
    drop(keys);
    source.finish().unwrap();
}

#[test]
fn newer_open_log_key_overrides_a_stale_checkpoint_in_the_same_snapshot() {
    let checkpoint = [53_u8; 32];
    let latest = [71_u8; 32];
    let fixture = fixture(|db, runs| {
        runs.put("e\0owner", key_json(&checkpoint)).unwrap();
        add_log_key(db, "owner", &latest);
    });
    let kept = kept();
    let mut keys = CurrentKeyReader::new(
        shared(&fixture.path, || Ok(())),
        &kept,
        KeyLimits::default(),
    )
    .unwrap();
    assert_opens(
        keys.key("owner").unwrap(),
        "owner",
        &latest,
        r#"{"selected":"newer-log"}"#,
    );
    keys.into_source().finish().unwrap();
}

#[test]
fn record_and_key_queries_share_one_wal_snapshot_and_one_global_statement_budget() {
    let checkpoint = [83_u8; 32];
    let later = [97_u8; 32];
    let fixture = fixture(|_, runs| {
        runs.put("e\0owner", key_json(&checkpoint)).unwrap();
    });
    let writer = Connection::open(&fixture.path).unwrap();
    let source = reader_source(&fixture.path, || Ok(()));
    let shared = SharedRecordSql::new(source, SharedLimits::default()).unwrap();
    let record_rows = shared
        .clone()
        .query("SELECT rowid FROM record_log ORDER BY rowid", &[])
        .unwrap();
    assert!(record_rows.rows.is_empty()); // Establishes the retained read snapshot.
    add_log_key(&writer, "owner", &later);

    let kept = kept();
    let mut keys = CurrentKeyReader::new(shared.clone(), &kept, KeyLimits::default()).unwrap();
    assert_opens(
        keys.key("owner").unwrap(),
        "owner",
        &checkpoint,
        r#"{"selected":"same-snapshot-checkpoint"}"#,
    );
    let work = shared.work().unwrap();
    assert!(
        work.sql_statements > 1,
        "record and key SQL are charged together"
    );
    let alias = keys.into_source();
    let extra = alias.clone();
    assert!(
        alias.finish().is_err(),
        "a live alias blocks exclusive retirement"
    );
    drop(shared);
    extra.finish().unwrap();
}

#[test]
fn shared_sql_statement_cap_applies_across_record_and_key_aliases() {
    let fixture = fixture(|_, _| {});
    let source = reader_source(&fixture.path, || Ok(()));
    let shared = SharedRecordSql::new(
        source,
        SharedLimits {
            statements: 1,
            ..SharedLimits::default()
        },
    )
    .unwrap();
    shared
        .clone()
        .query("SELECT rowid FROM record_log", &[])
        .unwrap();
    let kept = kept();
    let mut keys = CurrentKeyReader::new(shared.clone(), &kept, KeyLimits::default()).unwrap();
    assert!(matches!(keys.key("missing"), Err(ValueError::Bounds(_))));
    let work = shared.work().unwrap();
    assert_eq!(work.sql_statements, 1);
}

#[test]
fn current_missing_and_erased_are_distinct_but_unknown_schema_and_bad_keys_refuse() {
    let erased_key = [13_u8; 32];
    let fixture = fixture(|db, runs| {
        runs.put("e\0bad-key", json!({"key":"not-base64!"}))
            .unwrap();
        runs.put("e\0erased", key_json(&erased_key)).unwrap();
        erase_fixture_key(db, runs, "erased");
    });
    let kept = kept();
    let mut keys = CurrentKeyReader::new(
        shared(&fixture.path, || Ok(())),
        &kept,
        KeyLimits::default(),
    )
    .unwrap();
    assert!(matches!(keys.key("missing").unwrap(), KeyState::Missing));
    assert!(matches!(keys.key("erased").unwrap(), KeyState::Erased));
    assert!(matches!(keys.key("bad-key"), Err(ValueError::Source(_))));

    let no_schema = crate::fixture(|db, _| {
        db.execute_batch("DROP TABLE record_erasable_keys").unwrap();
    });
    let mut missing_schema = CurrentKeyReader::new(
        shared(&no_schema.path, || Ok(())),
        &kept,
        KeyLimits::default(),
    )
    .unwrap();
    assert!(matches!(
        missing_schema.key("missing"),
        Err(ValueError::Source(_))
    ));
}

#[test]
fn incomplete_multipart_tail_is_source_failure_not_a_missing_key() {
    let fixture = fixture(|db, _| {
        let valid_key = json!({"owner": STANDARD.encode([5_u8; 32])}).to_string();
        db.execute(
            "INSERT INTO record_log(id,transaction_id,part,parts,envelopes,keys) VALUES('synthetic-log','synthetic-tx',0,2,'[]',?)",
            [valid_key],
        )
        .unwrap();
    });
    let kept = kept();
    let mut keys = CurrentKeyReader::new(
        shared(&fixture.path, || Ok(())),
        &kept,
        KeyLimits::default(),
    )
    .unwrap();
    assert!(matches!(keys.key("owner"), Err(ValueError::Source(_))));
}

#[test]
fn current_witness_revocation_before_key_and_after_lookup_refuses_source() {
    let key = [101_u8; 32];
    let fixture = fixture(|_, runs| {
        runs.put("e\0owner", key_json(&key)).unwrap();
    });
    let kept = kept();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let mut keys = CurrentKeyReader::new(
        shared(&fixture.path, move || {
            observed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }),
        &kept,
        KeyLimits::default(),
    )
    .unwrap();
    assert!(keys.key("owner").is_ok());
    let complete_check_count = calls.load(Ordering::SeqCst);
    assert!(complete_check_count > 8);
    drop(keys);

    let before = Arc::new(AtomicUsize::new(0));
    let before_calls = before.clone();
    let mut revoked_before = CurrentKeyReader::new(
        shared(&fixture.path, move || {
            let call = before_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if call >= 3 {
                Err(ImportError::Refused("synthetic current source revoked", trillion_local::cause!()))
            } else {
                Ok(())
            }
        }),
        &kept,
        KeyLimits::default(),
    )
    .unwrap();
    assert!(matches!(
        revoked_before.key("owner"),
        Err(ValueError::Source(_))
    ));
    drop(revoked_before);

    let after = Arc::new(AtomicUsize::new(0));
    let after_calls = after.clone();
    let mut revoked_after = CurrentKeyReader::new(
        shared(&fixture.path, move || {
            let call = after_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if call >= complete_check_count - 1 {
                Err(ImportError::Refused("synthetic current source revoked", trillion_local::cause!()))
            } else {
                Ok(())
            }
        }),
        &kept,
        KeyLimits::default(),
    )
    .unwrap();
    assert!(matches!(
        revoked_after.key("owner"),
        Err(ValueError::Source(_))
    ));
}

#[test]
fn unsupported_supplier_limits_are_refused_without_fabricating_timing() {
    struct NoLimits;
    impl BoundedRecordSql for NoLimits {
        fn read_limits(&self) -> Option<&ReadLimits> {
            None
        }
        fn query(&mut self, _: &str, _: &[rusqlite::types::Value]) -> ImportResult<QueryRows> {
            Err(ImportError::Refused("synthetic unsupported supplier", trillion_local::cause!()))
        }
    }
    assert!(SharedRecordSql::new(NoLimits, SharedLimits::default()).is_err());

    struct Timingless {
        limits: ReadLimits,
    }
    impl BoundedRecordSql for Timingless {
        fn read_limits(&self) -> Option<&ReadLimits> {
            Some(&self.limits)
        }
        fn query(&mut self, _: &str, _: &[rusqlite::types::Value]) -> ImportResult<QueryRows> {
            Ok(QueryRows {
                columns: vec!["n".into()],
                rows: vec![vec![SqlValue::Integer(1)]],
                progress_callbacks: 0,
            })
        }
        fn query_with_budget(
            &mut self,
            sql: &str,
            params: &[rusqlite::types::Value],
            _: QueryBudget,
        ) -> ImportResult<QueryRows> {
            self.query(sql, params)
        }
        fn last_query_timing(&self) -> Option<QueryTiming> {
            None
        }
    }
    let fast = SharedRecordSql::new(
        Timingless {
            limits: ReadLimits::default(),
        },
        SharedLimits::default(),
    )
    .unwrap();
    let mut fast = fast;
    fast.query("SELECT 1", &[]).unwrap();
    assert!(fast.last_query_timing().is_none());

    let bounded = SharedRecordSql::new(
        Timingless {
            limits: ReadLimits::default(),
        },
        SharedLimits {
            elapsed: Duration::from_millis(100),
            ..SharedLimits::default()
        },
    )
    .unwrap();
    let mut bounded = bounded;
    bounded.query("SELECT 1", &[]).unwrap();
    thread::sleep(Duration::from_millis(110));
    assert!(matches!(
        bounded.query("SELECT 1", &[]),
        Err(ImportError::Deadline(_, _))
    ));
    assert!(bounded.last_query_timing().is_none());
}

#[test]
fn shared_byte_cap_counts_sqlite_column_names_across_alias_queries() {
    let fixture = fixture(|_, _| {});
    let source = reader_source(&fixture.path, || Ok(()));
    let shared = SharedRecordSql::new(
        source,
        SharedLimits {
            source_bytes: 17,
            ..SharedLimits::default()
        },
    )
    .unwrap();
    shared.clone().query("SELECT 1 AS a", &[]).unwrap(); // One header byte plus one eight-byte integer.
    assert_eq!(shared.work().unwrap().source_bytes, 9);
    assert!(matches!(
        shared.clone().query("SELECT 1 AS b", &[]),
        Err(ImportError::Budget(_, _))
    ));
    let work = shared.work().unwrap();
    assert_eq!(work.source_bytes, 9);
    assert_eq!(work.sql_statements, 2);
}

#[test]
fn readonly_snapshot_authorizer_rejects_write_sql_without_mutating_fixture() {
    let fixture = fixture(|_, _| {});
    let mut source = shared(&fixture.path, || Ok(()));
    assert!(source
        .query(
            "INSERT INTO record_log(id,transaction_id,part,parts,envelopes,keys) VALUES('bad','bad',0,1,'[]','{}')",
            &[],
        )
        .is_err());
    let inspect = Connection::open(&fixture.path).unwrap();
    let rows: i64 = inspect
        .query_row("SELECT count(*) FROM record_log", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn selected_log_tail_and_json_caps_refuse_instead_of_returning_missing() {
    let fixture = fixture(|db, _| {
        add_log_key(db, "owner", &[21_u8; 32]);
        add_log_key(db, "owner", &[22_u8; 32]);
    });
    let kept = kept();
    let mut row_bound = CurrentKeyReader::new(
        shared(&fixture.path, || Ok(())),
        &kept,
        KeyLimits {
            tail_rows: 1,
            ..KeyLimits::default()
        },
    )
    .unwrap();
    assert!(matches!(row_bound.key("owner"), Err(ValueError::Bounds(_))));

    let one_row = crate::fixture(|db, _| add_log_key(db, "owner", &[23_u8; 32]));
    let mut json_bound = CurrentKeyReader::new(
        shared(&one_row.path, || Ok(())),
        &kept,
        KeyLimits {
            key_json_bytes: 1,
            ..KeyLimits::default()
        },
    )
    .unwrap();
    assert!(matches!(json_bound.key("owner"), Err(ValueError::Bounds(_))));
}

#[test]
fn final_finish_checks_the_witness_before_classifying_a_late_deadline() {
    let fixture = fixture(|_, _| {});
    let late = Arc::new(AtomicUsize::new(0));
    let late_calls = late.clone();
    let source = reader_source(&fixture.path, move || {
        let call = late_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call == 3 {
            thread::sleep(Duration::from_millis(150));
        }
        Ok(())
    });
    let shared = SharedRecordSql::new(
        source,
        SharedLimits {
            elapsed: Duration::from_millis(100),
            ..SharedLimits::default()
        },
    )
    .unwrap();
    assert!(matches!(shared.finish(), Err(ImportError::Deadline(_, _))));
    assert_eq!(
        late.load(Ordering::SeqCst),
        3,
        "the final real witness ran before deadline refusal"
    );

    let revoked = Arc::new(AtomicUsize::new(0));
    let revoked_calls = revoked.clone();
    let source = reader_source(&fixture.path, move || {
        let call = revoked_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call == 3 {
            thread::sleep(Duration::from_millis(150));
            Err(ImportError::Refused("synthetic current rights withdrawn", trillion_local::cause!()))
        } else {
            Ok(())
        }
    });
    let shared = SharedRecordSql::new(
        source,
        SharedLimits {
            elapsed: Duration::from_millis(100),
            ..SharedLimits::default()
        },
    )
    .unwrap();
    assert!(matches!(
        shared.finish(),
        Err(ImportError::Refused("synthetic current rights withdrawn", _))
    ));
    assert_eq!(
        revoked.load(Ordering::SeqCst),
        3,
        "current-rights failure takes precedence over elapsed time"
    );
}

#[test]
fn unsupported_record_log_engines_and_legacy_entity_tables_never_become_missing() {
    let unsupported_engine = fixture(|db, _| {
        db.execute(
            "UPDATE record_keys_meta SET value='\"eeaf\"' WHERE key='engine'",
            [],
        )
        .unwrap();
        db.execute_batch("CREATE TABLE entity_types(entity_id TEXT,type_id TEXT); INSERT INTO entity_types VALUES('owner','legacy-type');").unwrap();
    });
    let kept = kept();
    let mut unsupported = CurrentKeyReader::new(
        shared(&unsupported_engine.path, || Ok(())),
        &kept,
        KeyLimits::default(),
    )
    .unwrap();
    assert!(matches!(unsupported.key("owner"), Err(ValueError::Source(_))));

    let legacy_without_engine = fixture(|db, _| {
        db.execute("DELETE FROM record_keys_meta WHERE key='engine'", [])
            .unwrap();
        db.execute_batch("DROP TABLE record_log; CREATE TABLE entity_types(entity_id TEXT,type_id TEXT); INSERT INTO entity_types VALUES('owner','legacy-type');").unwrap();
    });
    let mut legacy = CurrentKeyReader::new(
        shared(&legacy_without_engine.path, || Ok(())),
        &kept,
        KeyLimits::default(),
    )
    .unwrap();
    assert!(matches!(legacy.key("owner"), Err(ValueError::Source(_))));
}

// Reuse qualification uses the actual readonly snapshot and actual SQLite work
// observer. A reused result is provisional until the same source finishes; its
// physical counters are never synthesized from the returned rows.
fn reuse_fixture() -> Fixture {
    fixture(|db, _| {
        db.execute_batch(
            "CREATE TABLE reuse_items(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
            INSERT INTO reuse_items VALUES(1,'first'),(2,'second')",
        )
        .unwrap();
    })
}
fn observed_source<W: RecordSourceWitness>(
    path: &Path,
    witness: W,
    cancelled: Arc<AtomicBool>,
) -> (SnapshotRecordSql<W>, trillion_local::sqlite_work::WorkMeter) {
    use trillion_local::sqlite_work::{ObservedConnection, WorkMeter};
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    let meter = WorkMeter::new();
    // SAFETY: this freshly opened fixture connection owns a vacant trace slot;
    // no statement/handle escapes and the wrapper retains that slot throughout.
    let db = unsafe { ObservedConnection::attach_untraced(db, meter.clone()) }.unwrap();
    let source = SnapshotRecordSql::begin(db, ReadLimits::default(), witness, cancelled).unwrap();
    (source, meter)
}
fn reuse_budget() -> QueryBudget {
    QueryBudget {
        rows: 256,
        source_bytes: 4096,
        deadline: Instant::now() + Duration::from_secs(2),
    }
}
fn physical_fields(meter: &trillion_local::sqlite_work::WorkMeter) -> [u64; 6] {
    let work = meter.snapshot().unwrap().work;
    [
        work.sql_statements,
        work.sqlite_scan_visits,
        work.fullscan_steps,
        work.vm_steps,
        work.rows_returned,
        work.rows_written,
    ]
}
fn payload(rows: &QueryRows) -> &str {
    assert_eq!(rows.rows.len(), 1);
    assert_eq!(rows.rows[0].len(), 1);
    let SqlValue::Text(value) = &rows.rows[0][0] else {
        panic!("selected fixture payload must remain SQLite TEXT")
    };
    std::str::from_utf8(value).unwrap()
}
const POINT_PAYLOAD: &str = "SELECT payload FROM reuse_items WHERE id=?";

#[test]
fn charged_snapshot_answer_survives_exhausted_physical_rows_and_bytes_but_new_sql_does_not() {
    for bound in ["rows", "bytes"] {
        let fixture = reuse_fixture();
        let (source, meter) =
            observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
        let mut shared = SharedRecordSql::new_reusing_snapshot(
            source,
            SharedLimits {
                rows: if bound == "rows" { 1 } else { 4096 },
                source_bytes: if bound == "bytes" {
                    12
                } else {
                    8 * 1024 * 1024
                },
                ..Default::default()
            },
        )
        .unwrap();
        let params = [rusqlite::types::Value::Integer(1)];
        let first = shared
            .query_reusable_with_budget(POINT_PAYLOAD, &params, reuse_budget())
            .unwrap();
        assert_eq!(payload(&first), "first");
        let charged = shared.work().unwrap();
        let actual = physical_fields(&meter);
        let again = shared
            .query_reusable_with_budget(POINT_PAYLOAD, &params, reuse_budget())
            .unwrap();
        assert_eq!(payload(&again), "first");
        assert_eq!(
            physical_fields(&meter),
            actual,
            "reusing retained rows must add no SQL, visits or writes"
        );
        let reused = shared.work().unwrap();
        assert_eq!(reused.sql_statements, charged.sql_statements);
        assert_eq!(reused.rows_returned, charged.rows_returned);
        assert_eq!(reused.source_bytes, charged.source_bytes);
        assert_eq!(reused.reused_queries, 1);
        assert!(matches!(
            shared.query_reusable_with_budget(
                POINT_PAYLOAD,
                &[rusqlite::types::Value::Integer(2)],
                reuse_budget()
            ),
            Err(ImportError::Budget(_, _))
        ));
        assert_eq!(
            physical_fields(&meter),
            actual,
            "an uncached read cannot exceed the original physical cap"
        );
        assert!(shared.finish().is_err());
    }
}

#[test]
fn deterministic_snapshot_reuse_removes_actual_repeated_point_work_across_aliases() {
    let fixture = reuse_fixture();
    let checks = Arc::new(AtomicUsize::new(0));
    let checked = checks.clone();
    let (source, meter) = observed_source(
        &fixture.path,
        move || {
            checked.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        Arc::new(AtomicBool::new(false)),
    );
    let mut shared = SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap();
    let baseline = physical_fields(&meter);
    let first = shared
        .query_reusable_with_budget(
            POINT_PAYLOAD,
            &[rusqlite::types::Value::Integer(1)],
            reuse_budget(),
        )
        .unwrap();
    assert_eq!(payload(&first), "first");
    let after_first = physical_fields(&meter);
    assert_eq!(after_first[0] - baseline[0], 1);
    assert_eq!(
        after_first[1] - baseline[1],
        1,
        "the first indexed lookup visits one actual SQLite row"
    );
    let first_work = shared.work().unwrap();
    let checks_before_reuse = checks.load(Ordering::SeqCst);
    let mut alias = shared.clone();
    let reused = alias
        .query_reusable_with_budget(
            POINT_PAYLOAD,
            &[rusqlite::types::Value::Integer(1)],
            reuse_budget(),
        )
        .unwrap();
    assert_eq!(payload(&reused), "first");
    assert_eq!(
        reused.progress_callbacks, 0,
        "old execution steps must not be counted again"
    );
    assert_eq!(
        physical_fields(&meter),
        after_first,
        "exact repeated deterministic read performs no additional SQLite work"
    );
    assert!(
        checks.load(Ordering::SeqCst) > checks_before_reuse,
        "reuse must freshly check the actual source witness"
    );
    let reused_work = shared.work().unwrap();
    assert_eq!(reused_work.sql_statements, first_work.sql_statements);
    assert_eq!(reused_work.rows_returned, first_work.rows_returned);
    assert_eq!(reused_work.source_bytes, first_work.source_bytes);
    assert_eq!(reused_work.reused_queries, 1);
    drop(alias);
    shared.finish().unwrap();
}

#[test]
fn deterministic_snapshot_reuse_matches_exact_sql_and_exact_parameters() {
    let fixture = reuse_fixture();
    let (source, meter) =
        observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
    let mut shared = SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap();
    let baseline = physical_fields(&meter);
    for (id, expected) in [(1, "first"), (2, "second")] {
        let rows = shared
            .query_reusable_with_budget(
                POINT_PAYLOAD,
                &[rusqlite::types::Value::Integer(id)],
                reuse_budget(),
            )
            .unwrap();
        assert_eq!(payload(&rows), expected);
    }
    assert_eq!(shared.work().unwrap().sql_statements, 2);
    assert_eq!(shared.work().unwrap().reused_queries, 0);
    let again = shared
        .query_reusable_with_budget(
            POINT_PAYLOAD,
            &[rusqlite::types::Value::Integer(1)],
            reuse_budget(),
        )
        .unwrap();
    assert_eq!(payload(&again), "first");
    assert_eq!(shared.work().unwrap().reused_queries, 1);
    let different_sql = shared
        .query_reusable_with_budget(
            "SELECT payload AS other FROM reuse_items WHERE id=?",
            &[rusqlite::types::Value::Integer(1)],
            reuse_budget(),
        )
        .unwrap();
    assert_eq!(payload(&different_sql), "first");
    assert_eq!(shared.work().unwrap().sql_statements, 3);
    assert_eq!(physical_fields(&meter)[0] - baseline[0], 3);
    shared.finish().unwrap();
}

#[test]
fn ordinary_queries_stay_uncached_even_on_a_reusing_snapshot() {
    let fixture = reuse_fixture();
    let (source, meter) =
        observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
    let mut shared = SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap();
    let baseline = physical_fields(&meter);
    for _ in 0..2 {
        assert_eq!(
            payload(
                &shared
                    .query_with_budget(
                        POINT_PAYLOAD,
                        &[rusqlite::types::Value::Integer(1)],
                        reuse_budget()
                    )
                    .unwrap()
            ),
            "first"
        );
    }
    assert_eq!(physical_fields(&meter)[0] - baseline[0], 2);
    assert_eq!(shared.work().unwrap().reused_queries, 0);
    shared
        .query_reusable_with_budget(
            POINT_PAYLOAD,
            &[rusqlite::types::Value::Integer(1)],
            reuse_budget(),
        )
        .unwrap();
    let after_marked = physical_fields(&meter);
    shared
        .query_with_budget(
            POINT_PAYLOAD,
            &[rusqlite::types::Value::Integer(1)],
            reuse_budget(),
        )
        .unwrap();
    assert_eq!(
        physical_fields(&meter)[0] - after_marked[0],
        1,
        "ordinary read must execute even when an identical deterministic result was retained"
    );
    assert_eq!(shared.work().unwrap().sql_statements, 4);
    assert_eq!(shared.work().unwrap().reused_queries, 0);
    shared.finish().unwrap();
}

#[test]
fn default_shared_constructor_and_trait_default_execute_every_marked_read() {
    let fixture = reuse_fixture();
    let (source, meter) =
        observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
    let mut shared = SharedRecordSql::new(source, Default::default()).unwrap();
    let baseline = physical_fields(&meter);
    for _ in 0..2 {
        shared
            .query_reusable_with_budget(
                POINT_PAYLOAD,
                &[rusqlite::types::Value::Integer(1)],
                reuse_budget(),
            )
            .unwrap();
    }
    assert_eq!(physical_fields(&meter)[0] - baseline[0], 2);
    assert_eq!(shared.work().unwrap().reused_queries, 0);
    shared.finish().unwrap();

    // SnapshotRecordSql uses BoundedRecordSql's default reusable adapter. The
    // annotation alone never grants memoization to an ordinary supplier.
    let (mut source, meter) =
        observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
    let baseline = physical_fields(&meter);
    for _ in 0..2 {
        source
            .query_reusable_with_budget(
                POINT_PAYLOAD,
                &[rusqlite::types::Value::Integer(1)],
                reuse_budget(),
            )
            .unwrap();
    }
    assert_eq!(physical_fields(&meter)[0] - baseline[0], 2);
    source.finish().unwrap();
}

#[test]
fn deterministic_reuse_withholds_cached_rows_on_cancellation_or_current_revocation() {
    for cancelled in [false, true] {
        let fixture = reuse_fixture();
        let cancel = Arc::new(AtomicBool::new(false));
        let revoked = Arc::new(AtomicBool::new(false));
        let current = revoked.clone();
        let (source, _) = observed_source(
            &fixture.path,
            move || {
                if current.load(Ordering::SeqCst) {
                    Err(ImportError::Refused("synthetic current source revoked", trillion_local::cause!()))
                } else {
                    Ok(())
                }
            },
            cancel.clone(),
        );
        let mut shared = SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap();
        shared
            .query_reusable_with_budget(
                POINT_PAYLOAD,
                &[rusqlite::types::Value::Integer(1)],
                reuse_budget(),
            )
            .unwrap();
        if cancelled {
            cancel.store(true, Ordering::SeqCst)
        } else {
            revoked.store(true, Ordering::SeqCst)
        }
        assert!(
            shared
                .query_reusable_with_budget(
                    POINT_PAYLOAD,
                    &[rusqlite::types::Value::Integer(1)],
                    reuse_budget()
                )
                .is_err(),
            "cached rows must not escape after cancellation/revocation"
        );
        let work = shared.work().unwrap();
        assert_eq!(work.sql_statements, 1);
        assert_eq!(
            work.reused_queries, 0,
            "a withheld cache hit is not a successful reused answer"
        );
        assert!(shared.finish().is_err());
    }
}

#[test]
fn deterministic_reuse_retains_the_full_final_witness_before_disclosure() {
    struct FinalWitness {
        revoked: Arc<AtomicBool>,
        current: Arc<AtomicUsize>,
        custody: Arc<AtomicUsize>,
    }
    impl RecordSourceWitness for FinalWitness {
        fn assert_current(&mut self) -> ImportResult<()> {
            self.current.fetch_add(1, Ordering::SeqCst);
            if self.revoked.load(Ordering::SeqCst) {
                Err(ImportError::Refused("synthetic final rights withdrawn", trillion_local::cause!()))
            } else {
                Ok(())
            }
        }
        fn assert_query_source(&mut self) -> ImportResult<()> {
            self.custody.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    let fixture = reuse_fixture();
    let revoked = Arc::new(AtomicBool::new(false));
    let current = Arc::new(AtomicUsize::new(0));
    let custody = Arc::new(AtomicUsize::new(0));
    let witness = FinalWitness {
        revoked: revoked.clone(),
        current: current.clone(),
        custody: custody.clone(),
    };
    let (source, _) = observed_source(&fixture.path, witness, Arc::new(AtomicBool::new(false)));
    let mut shared = SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap();
    for _ in 0..2 {
        shared
            .query_reusable_with_budget(
                POINT_PAYLOAD,
                &[rusqlite::types::Value::Integer(1)],
                reuse_budget(),
            )
            .unwrap();
    }
    assert_eq!(shared.work().unwrap().reused_queries, 1);
    assert!(custody.load(Ordering::SeqCst) > 1);
    let before_finish = current.load(Ordering::SeqCst);
    revoked.store(true, Ordering::SeqCst);
    assert!(matches!(
        shared.finish(),
        Err(ImportError::Refused("synthetic final rights withdrawn", _))
    ));
    assert_eq!(
        current.load(Ordering::SeqCst),
        before_finish + 1,
        "successful source custody/reuse never substitutes for the final current-rights check"
    );
}

#[test]
fn deterministic_reuse_stays_in_held_wal_snapshot_and_new_operation_sees_commit() {
    let fixture = reuse_fixture();
    let writer = Connection::open(&fixture.path).unwrap();
    let (source, _) = observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
    let mut shared = SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap();
    assert_eq!(
        payload(
            &shared
                .query_reusable_with_budget(
                    POINT_PAYLOAD,
                    &[rusqlite::types::Value::Integer(1)],
                    reuse_budget()
                )
                .unwrap()
        ),
        "first"
    );
    writer
        .execute(
            "UPDATE reuse_items SET payload='committed-later' WHERE id=1",
            [],
        )
        .unwrap();
    assert_eq!(
        payload(
            &shared
                .query_reusable_with_budget(
                    POINT_PAYLOAD,
                    &[rusqlite::types::Value::Integer(1)],
                    reuse_budget()
                )
                .unwrap()
        ),
        "first"
    );
    assert_eq!(
        payload(
            &shared
                .query_with_budget(
                    POINT_PAYLOAD,
                    &[rusqlite::types::Value::Integer(1)],
                    reuse_budget()
                )
                .unwrap()
        ),
        "first",
        "an actual ordinary query confirms the same retained SQLite snapshot"
    );
    assert_eq!(shared.work().unwrap().reused_queries, 1);
    shared.finish().unwrap();
    let (source, _) = observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
    let mut next = SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap();
    assert_eq!(
        payload(
            &next
                .query_reusable_with_budget(
                    POINT_PAYLOAD,
                    &[rusqlite::types::Value::Integer(1)],
                    reuse_budget()
                )
                .unwrap()
        ),
        "committed-later"
    );
    assert_eq!(
        next.work().unwrap().reused_queries,
        0,
        "no retained answer survives into another operation"
    );
    next.finish().unwrap();
}

#[test]
fn narrowed_caller_row_byte_and_deadline_budgets_never_leak_cached_oversized_rows() {
    for narrowed in ["rows", "bytes", "deadline"] {
        let fixture = reuse_fixture();
        let (source, _) =
            observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
        let mut shared = SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap();
        let sql = "SELECT payload FROM reuse_items ORDER BY id";
        let first = shared
            .query_reusable_with_budget(sql, &[], reuse_budget())
            .unwrap();
        assert_eq!(first.rows.len(), 2);
        let mut budget = reuse_budget();
        match narrowed {
            "rows" => budget.rows = 1,
            // Column name payload is 7 bytes, first+second is 11: total18.
            "bytes" => budget.source_bytes = 17,
            "deadline" => budget.deadline = Instant::now() - Duration::from_secs(1),
            _ => unreachable!(),
        }
        let answer = shared.query_reusable_with_budget(sql, &[], budget);
        assert!(if narrowed == "deadline" {
            matches!(answer, Err(ImportError::Deadline(_, _)))
        } else {
            matches!(answer, Err(ImportError::Budget(_, _)))
        }, "a stricter {narrowed} budget must not expose any cached partial result");
        assert_eq!(shared.work().unwrap().reused_queries, 0);
        assert!(shared.finish().is_err());
    }
}

#[test]
fn deterministic_reuse_distinguishes_opposite_signed_zero_parameter_bits() {
    let fixture = reuse_fixture();
    let (source, meter) =
        observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
    let mut shared = SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap();
    let baseline = physical_fields(&meter);
    for parameter in [-0.0_f64, 0.0_f64] {
        let result = shared
            .query_reusable_with_budget(
                "SELECT ? AS exact_real",
                &[rusqlite::types::Value::Real(parameter)],
                reuse_budget(),
            )
            .unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0].len(), 1);
        assert!(
            matches!(result.rows[0][0], SqlValue::RealBits(bits) if bits == parameter.to_bits()),
            "SQLite real result must retain this parameter's exact sign bit"
        );
    }
    let after_both_signs = physical_fields(&meter);
    assert_eq!(
        after_both_signs[0] - baseline[0],
        2,
        "numerically equal signed zeros are distinct physical query parameters"
    );
    assert_eq!(shared.work().unwrap().sql_statements, 2);
    assert_eq!(shared.work().unwrap().reused_queries, 0);
    let repeated_negative = shared
        .query_reusable_with_budget(
            "SELECT ? AS exact_real",
            &[rusqlite::types::Value::Real(-0.0_f64)],
            reuse_budget(),
        )
        .unwrap();
    assert!(
        matches!(repeated_negative.rows[0][0], SqlValue::RealBits(bits) if bits == (-0.0_f64).to_bits()),
        "repeat must reuse the negative-zero entry, never the positive-zero entry"
    );
    assert_eq!(physical_fields(&meter), after_both_signs);
    assert_eq!(shared.work().unwrap().sql_statements, 2);
    assert_eq!(shared.work().unwrap().reused_queries, 1);
    shared.finish().unwrap();
}

#[test]
fn same_snapshot_table_exists_reuses_one_native_probe_without_raising_any_allowance() {
    let fixture = reuse_fixture();
    let (source, meter) =
        observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
    let mut shared = SharedRecordSql::new_reusing_snapshot(
        source,
        SharedLimits {
            statements: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let before = physical_fields(&meter);
    for index in 0..210 {
        let probe = shared.main_table_exists("reuse_items", reuse_budget());
        assert_eq!(probe.exists.unwrap(), Some(true));
        assert_eq!(probe.work.metadata_calls, u64::from(index == 0));
        assert_eq!(probe.work.reused_probes, u64::from(index != 0));
    }
    let work = shared.work().unwrap();
    assert_eq!(work.sql_statements, 1);
    assert_eq!(work.native_metadata.metadata_calls, 1);
    assert_eq!(work.native_metadata.origin_prepares, 1);
    assert_eq!(work.native_metadata.reused_probes, 209);
    assert_eq!(physical_fields(&meter)[0] - before[0], 1);
    // A true miss still consumes the unchanged physical allowance and refuses.
    assert!(shared
        .main_table_exists("another_table", reuse_budget())
        .exists
        .is_err());
    assert!(shared.finish().is_err());
}

#[test]
fn same_snapshot_table_exists_reuse_still_checks_cancellation_and_current_source() {
    for cancelled in [false, true] {
        let fixture = reuse_fixture();
        let stop = Arc::new(AtomicBool::new(false));
        let revoked = Arc::new(AtomicBool::new(false));
        let now = revoked.clone();
        let (source, _) = observed_source(
            &fixture.path,
            move || {
                if now.load(Ordering::Acquire) {
                    Err(ImportError::Refused("source withdrawn", trillion_local::cause!()))
                } else {
                    Ok(())
                }
            },
            stop.clone(),
        );
        let mut shared = SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap();
        assert_eq!(
            shared
                .main_table_exists("reuse_items", reuse_budget())
                .exists
                .unwrap(),
            Some(true)
        );
        if cancelled {
            stop.store(true, Ordering::Release);
        } else {
            revoked.store(true, Ordering::Release);
        }
        assert!(shared
            .main_table_exists("reuse_items", reuse_budget())
            .exists
            .is_err());
        assert_eq!(shared.work().unwrap().native_metadata.reused_probes, 0);
        assert!(shared.finish().is_err());
    }
}

#[test]
fn metadata_reuse_is_confined_to_the_original_held_schema_snapshot() {
    let fixture = reuse_fixture();
    let (source, _) = observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
    let mut shared = SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap();
    assert_eq!(
        shared
            .main_table_exists("reuse_items", reuse_budget())
            .exists
            .unwrap(),
        Some(true)
    );
    Connection::open(&fixture.path)
        .unwrap()
        .execute_batch("DROP TABLE reuse_items")
        .unwrap();
    assert_eq!(
        shared
            .main_table_exists("reuse_items", reuse_budget())
            .exists
            .unwrap(),
        Some(true)
    );
    shared.finish().unwrap();
    let (source, _) = observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
    let mut next = SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap();
    assert_eq!(
        next.main_table_exists("reuse_items", reuse_budget())
            .exists
            .unwrap(),
        None
    );
    assert_eq!(next.work().unwrap().native_metadata.metadata_calls, 1);
    assert_eq!(next.work().unwrap().native_metadata.reused_probes, 0);
    next.finish().unwrap();
}

#[test]
fn matched_metadata_workload_removes_duplicate_probes_instead_of_raising_the_limit() {
    let fixture = reuse_fixture();
    for reuse in [false, true] {
        let (source, _) =
            observed_source(&fixture.path, || Ok(()), Arc::new(AtomicBool::new(false)));
        let mut shared = if reuse {
            SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap()
        } else {
            SharedRecordSql::new(source, Default::default()).unwrap()
        };
        let mut completed = 0;
        for _ in 0..210 {
            match shared
                .main_table_exists("reuse_items", reuse_budget())
                .exists
            {
                Ok(Some(true)) => completed += 1,
                Err(ImportError::Budget(_, _)) => break,
                other => panic!("same table workload changed meaning: {other:?}"),
            }
        }
        let work = shared.work().unwrap();
        assert_eq!(completed, if reuse { 210 } else { 128 });
        assert_eq!(
            work.native_metadata.metadata_calls,
            if reuse { 1 } else { 128 }
        );
        assert_eq!(
            work.native_metadata.origin_prepares,
            if reuse { 1 } else { 128 }
        );
        assert_eq!(
            work.native_metadata.reused_probes,
            if reuse { 209 } else { 0 }
        );
        assert_eq!(work.sql_statements, 1);
        assert_eq!(shared.finish().is_ok(), reuse);
    }
}
