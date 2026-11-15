// Purpose: qualify original engine selection and bounded logical row reads.
// Invariants: real pinned SQLite fixtures, original bytes unchanged, exact IDs,
// raw JSON/sequence/history retained. Fixtures are not actual-account parity.
use rusqlite::{params, Connection};
use content_crypto::advanced::blake3;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::{tempdir, TempDir};
use trillion_local::{
    import::{AccountIdentity, FilePin, NativeCatalog, ReadLimits, ReadonlyOriginal},
    legacy_kept::{LegacyKept, Limits},
    legacy_records::{Bounds, Engine, Error, LegacyRecords},
};
struct Fixture {
    _root: TempDir,
    state: PathBuf,
    database: PathBuf,
    receipt: FilePin,
    sqlite: FilePin,
}
fn pin(path: &Path) -> FilePin {
    let bytes = fs::read(path).unwrap();
    FilePin {
        bytes: bytes.len() as u64,
        blake3: blake3::hash(&bytes).to_hex().to_string(),
    }
}
fn fixture(build: impl FnOnce(&Connection)) -> Fixture {
    let root = tempdir().unwrap();
    let state = root.path().join("original");
    fs::create_dir(&state).unwrap();
    let database = state.join("original.sqlite");
    let db = Connection::open(&database).unwrap();
    // Even an empty-vocabulary control must be an actual SQLite database file,
    // rather than SQLite's zero-byte not-yet-created connection placeholder.
    db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA user_version=1")
        .unwrap();
    build(&db);
    db.close().unwrap();
    let sqlite = pin(&database);
    let descriptor = json!({"binding":"PERSON","originalId":"a".repeat(64),"className":"PersonStore","sqlite":"original.sqlite","names":["fixture-original"]});
    let index = format!("{descriptor}\n");
    fs::write(state.join("objects.ndjson"), &index).unwrap();
    let receipt = json!({"version":"trillion.local-restore-indexed/v1","complete":true,"account":{"userId":"fixture-user","ownerId":"b".repeat(64)},"proof":{"workerdStructuredClone":true,"userSQLIntegrity":true,"providerContacted":false},"replay":{"runtimeStarted":false,"alarmsRestored":false,"alarmsArmed":false},"source":{"bundleManifestIdentity":"f".repeat(64)},"objects":{"path":"objects.ndjson","bytes":index.len(),"fileIdentity":blake3::hash(index.as_bytes()).to_hex().to_string(),"count":1}});
    fs::write(
        state.join("restore-receipt.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    let receipt = pin(&state.join("restore-receipt.json"));
    Fixture {
        _root: root,
        state,
        database,
        receipt,
        sqlite,
    }
}
fn original(f: &Fixture) -> ReadonlyOriginal {
    NativeCatalog::open(
        &f.state,
        f.receipt.clone(),
        AccountIdentity {
            user_id: "fixture-user".into(),
            owner_id: "b".repeat(64),
        },
        ReadLimits::default(),
    )
    .unwrap()
    .open_object("PERSON", &"a".repeat(64), f.sqlite.clone())
    .unwrap()
}
fn reader(f: &Fixture) -> LegacyRecords {
    LegacyRecords::open(original(f), Bounds::default()).unwrap()
}
// Keep source schema setup independent from data so malformed-row controls can
// exercise a genuine original table without mutating any admitted source.
fn eeaf_schema(db: &Connection) {
    db.execute_batch("CREATE TABLE entity(id TEXT PRIMARY KEY);CREATE TABLE entity_types(entity_id TEXT,type_id TEXT,PRIMARY KEY(entity_id,type_id));CREATE TABLE attribute_fact(subject_id TEXT,property_id TEXT,type_id TEXT,value_json TEXT,PRIMARY KEY(subject_id,property_id,type_id));CREATE TABLE participation(id TEXT PRIMARY KEY,interaction_id TEXT,participant_id TEXT,role_id TEXT,counterpart_id TEXT);CREATE TABLE interaction_set_members(set_id TEXT,member_id TEXT,ordinal INTEGER,PRIMARY KEY(set_id,member_id));CREATE TABLE bitemporal_facts(id TEXT,record_id TEXT,table_name TEXT,patch TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT)").unwrap();
}
fn eeaf_data(db: &Connection) {
    eeaf_schema(db);
    db.execute_batch("INSERT INTO entity VALUES('root'),('root/child'),('root/set'),('root/member'),('root/edge#part'),('rootish'),('root0'),('untyped');INSERT INTO entity_types VALUES('root','type:page'),('root/child','type:page/child'),('root/set','type:set'),('root/member','type:page/member');INSERT INTO participation VALUES('root/edge#part','root','shared:original','role:external','counterpart:original');INSERT INTO interaction_set_members VALUES('root/set','root/member',3)").unwrap();
    db.execute(
        "INSERT INTO attribute_fact VALUES(?,?,?,?)",
        params![
            "root",
            "prop:page:title",
            "type:page",
            r#"{"z":1.00,"a":"original"}"#
        ],
    )
    .unwrap();
}
fn meta(db: &Connection, engine: &str) {
    db.execute_batch(
        "CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID",
    )
    .unwrap();
    db.execute(
        "INSERT INTO record_keys_meta VALUES('engine',?)",
        [serde_json::to_string(engine).unwrap()],
    )
    .unwrap();
}
fn keys(db: &Connection, entries: Vec<(&str, String)>) {
    db.execute_batch("CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT);CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER);CREATE TABLE record_keys_big(ref TEXT,part INTEGER,body TEXT,PRIMARY KEY(ref,part)) WITHOUT ROWID;CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT NOT NULL)").unwrap();
    let mut entries = entries;
    entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    db.execute(
        "INSERT INTO record_keys_runs VALUES(1,1,?, ?,0,1)",
        params![
            entries.len() as i64,
            serde_json::to_string(entries.last().unwrap().0).unwrap()
        ],
    )
    .unwrap();
    for (i, (key, value)) in entries.into_iter().enumerate() {
        let body = format!(
            "{}\n{value}",
            json!({"p":[0],"s":[key],"d":[value.encode_utf16().count()]})
        );
        db.execute(
            "INSERT INTO record_keys_run_1 VALUES(?,?,?)",
            params![i as i64, serde_json::to_string(key).unwrap(), body],
        )
        .unwrap();
    }
}
fn kept() -> LegacyKept {
    LegacyKept::new(Limits::default()).unwrap()
}
#[test]
fn original_marker_wins_and_unknown_markers_never_guess() {
    let f = fixture(|db| {
        eeaf_data(db);
        meta(db, "record-log");
    });
    assert_eq!(reader(&f).engine().unwrap(), Engine::RecordLog);
    let f = fixture(|db| {
        meta(db, "eeaf");
    });
    assert_eq!(reader(&f).engine().unwrap(), Engine::Eeaf);
    assert!(reader(&f).own_rows("root").is_err());
    let f = fixture(|db| meta(db, "foreign-engine"));
    assert!(matches!(
        LegacyRecords::open(original(&f), Bounds::default()),
        Err(Error::UnsupportedEngine(_))
    ));
}
#[test]
fn unmarked_empty_vocabulary_and_populated_source_selection_match_canonical() {
    let f = fixture(|_| {});
    assert_eq!(reader(&f).engine().unwrap(), Engine::RecordLog);
    let f = fixture(|db| {
        eeaf_schema(db);
        db.execute_batch("INSERT INTO entity VALUES('type:page');INSERT INTO entity_types VALUES('type:page','type:type')").unwrap();
    });
    assert_eq!(reader(&f).engine().unwrap(), Engine::RecordLog);
    let f = fixture(eeaf_data);
    assert_eq!(reader(&f).engine().unwrap(), Engine::Eeaf);
}
#[test]
fn eeaf_rows_preserve_ids_types_fact_text_part_roles_and_set_order() {
    let f = fixture(eeaf_data);
    let before = fs::read(&f.database).unwrap();
    let mut r = reader(&f);
    let rows = r.own_rows("root").unwrap();
    assert_eq!(rows.root_id, "root");
    assert!(rows
        .entities
        .iter()
        .any(|(id, kind)| id == "root" && kind.as_deref() == Some("type:page")));
    assert!(!rows
        .entities
        .iter()
        .any(|(id, _)| id == "rootish" || id == "root0"));
    assert!(rows.entities.iter().any(|(id, _)| id == "root/edge#part"));
    assert_eq!(
        rows.facts[0].value_json.as_deref(),
        Some(r#"{"z":1.00,"a":"original"}"#)
    );
    assert_eq!(rows.participations[0].participant_id, "shared:original");
    assert_eq!(
        rows.participations[0].counterpart_id.as_deref(),
        Some("counterpart:original")
    );
    assert_eq!(rows.members[0].ordinal, Some(3));
    assert!(r.own_rows("missing").unwrap().entities.is_empty());
    assert_eq!(fs::read(&f.database).unwrap(), before);
}
#[test]
fn untyped_and_multiple_type_entity_rows_are_retained() {
    let f = fixture(|db| {
        eeaf_data(db);
        db.execute("INSERT INTO entity_types VALUES('root','type:second')", [])
            .unwrap();
    });
    let mut r = reader(&f);
    assert_eq!(
        r.own_rows("root")
            .unwrap()
            .entities
            .iter()
            .filter(|(id, _)| id == "root")
            .count(),
        2
    );
    assert_eq!(r.own_rows("untyped").unwrap().entities[0].1, None);
}
#[test]
fn stored_inline_value_keeps_exact_lexical_json_sequence_and_metadata() {
    let f = fixture(|db| {
        meta(db, "record-log");
        keys(db,vec![("i\0root",r#"["page","original-sequence", {"z":1.00,"a":1e2,"z":3}, {"at":"original-stamp"}, {"key":"fixture-private-key"}]"#.into())]);
    });
    let before = fs::read(&f.database).unwrap();
    let got = reader(&f).read_stored("root", &kept()).unwrap().unwrap();
    assert_eq!(got.id, "root");
    assert_eq!(got.record_type, "page");
    assert_eq!(got.sequence, "original-sequence");
    assert_eq!(got.value_json, r#"{"z":1.00,"a":1e2,"z":3}"#);
    assert_eq!(got.meta_json.as_deref(), Some(r#"{"at":"original-stamp"}"#));
    assert!(got.protected_key_present);
    assert!(!format!("{got:?}").contains("fixture-private-key"));
    assert_eq!(fs::read(&f.database).unwrap(), before);
}
#[test]
fn noninline_nul_record_key_is_followed_without_new_binding() {
    let f = fixture(|db| {
        meta(db, "record-log");
        keys(
            db,
            vec![
                ("i\0root", r#"["page","s"]"#.into()),
                ("r\0page\0s\0root", r#"{"original":1.000}"#.into()),
            ],
        );
    });
    let got = reader(&f).read_stored("root", &kept()).unwrap().unwrap();
    assert_eq!(got.value_json, r#"{"original":1.000}"#);
    assert!(!got.protected_key_present);
}
#[test]
fn absent_removed_and_invalid_pointers_remain_distinct_from_values() {
    let f = fixture(|db| {
        meta(db, "record-log");
        keys(
            db,
            vec![
                ("i\0gone", r#"[null,"s",null]"#.into()),
                ("i\0bad", r#"{"replacement":true}"#.into()),
            ],
        );
    });
    let mut r = reader(&f);
    assert!(r.read_stored("gone", &kept()).unwrap().is_none());
    assert!(r.read_stored("missing", &kept()).unwrap().is_none());
    assert!(matches!(r.read_stored("bad", &kept()), Err(Error::Corrupt(_))));
    assert!(r.read_stored("bad\0id", &kept()).is_err());
}
#[test]
fn exact_physical_history_identity_stamps_and_continuation_survive() {
    let f = fixture(|db| {
        eeaf_data(db);
        for index in 1..=3 {
            db.execute(
                "INSERT INTO bitemporal_facts VALUES(?,?,?,?,?,?,?,?)",
                params![
                    format!("original-id-{index}"),
                    "physical|record|identity",
                    "attribute_fact",
                    format!("patch-{index}"),
                    "transaction-original",
                    "actor-original",
                    "valid-original",
                    "system-original"
                ],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO bitemporal_facts VALUES('other','other','entity','{}','t','a','v','s')",
            [],
        )
        .unwrap();
    });
    let mut r = reader(&f);
    let a = r
        .history("bitemporal_facts", "physical|record|identity", 0, 2)
        .unwrap();
    assert_eq!(a.rows.len(), 2);
    assert_eq!(a.rows[0].record_id, "physical|record|identity");
    assert_eq!(a.rows[0].system_time, "system-original");
    let b = r
        .history(
            "bitemporal_facts",
            "physical|record|identity",
            a.next.unwrap(),
            2,
        )
        .unwrap();
    assert_eq!(b.rows.len(), 1);
    assert!(b.next.is_none());
    assert!(r
        .history(
            "bitemporal_facts;DROP TABLE entity",
            "physical|record|identity",
            0,
            2
        )
        .is_err());
}
#[test]
fn aggregate_read_budget_refuses_partial_rows_and_changed_source() {
    let f = fixture(eeaf_data);
    let before = fs::read(&f.database).unwrap();
    let mut bounds = Bounds::default();
    // Detection returns 5 rows, schema probes 15, and this root's data 8.
    // Exercise the exact opposing boundary, including metadata work.
    bounds.rows = 27;
    let mut r = LegacyRecords::open(original(&f), bounds.clone()).unwrap();
    assert!(matches!(r.own_rows("root"), Err(Error::Bounds(_))));
    bounds.rows = 28;
    let mut r = LegacyRecords::open(original(&f), bounds).unwrap();
    let complete = r.own_rows("root").unwrap();
    assert_eq!(complete.entities.len(), 5);
    assert_eq!(complete.facts.len(), 1);
    assert_eq!(complete.participations.len(), 1);
    assert_eq!(complete.members.len(), 1);
    assert_eq!(fs::read(&f.database).unwrap(), before);
    let mut r = reader(&f);
    fs::write(&f.database, b"changed-source").unwrap();
    assert!(matches!(r.engine(), Err(Error::Source(_))));
}
#[test]
fn empty_complete_log_tail_and_covered_checkpoint_preserve_original_value() {
    for covered in [false, true] {
        let f = fixture(|db| {
            meta(db, "record-log");
            keys(
                db,
                vec![(
                    "i\0root",
                    r#"["page","s",{"checkpoint":"original"}]"#.into(),
                )],
            );
            db.execute(
                "INSERT INTO record_log VALUES('original-log-id','t','a','v','s',0,1,'[]')",
                [],
            )
            .unwrap();
            if covered {
                db.execute(
                    "INSERT INTO record_keys_meta VALUES('covered',?)",
                    [r#"{"at":1,"counts":{}}"#],
                )
                .unwrap();
            }
        });
        let result = reader(&f).read_stored("root", &kept());
        assert_eq!(result.unwrap().unwrap().sequence, "s");
    }
}
const LOG_ID: &str = "01234567-89ab-7cde-8f01-234567890abc";
fn tail(
    db: &Connection,
    rowid: i64,
    id: &str,
    transaction: &str,
    part: i64,
    parts: i64,
    body: &str,
) {
    db.execute("INSERT INTO record_log(rowid,id,transaction_id,actor_context,application_time,system_time,part,parts,envelopes) VALUES(?,?,?,'actor-original','valid-original','system-original',?,?,?)",params![rowid,id,transaction,part,parts,body]).unwrap();
}
fn checkpoint_fixture(db: &Connection) {
    meta(db, "record-log");
    keys(
        db,
        vec![(
            "i\0root",
            r#"["page","original-order",{"old":1.00,"remove":"original"},{"at":"a"}]"#.into(),
        )],
    );
}

#[test]
fn selected_stored_batch_shares_one_snapshot_frontier_across_roots() {
    use std::{
        sync::{atomic::AtomicBool, Arc},
        time::{Duration, Instant},
    };
    use trillion_local::{
        current_record_keys::{SharedLimits, SharedRecordSql},
        kept_runs::{KeptRuns, Settings},
    };

    const ROOTS: usize = 100;
    let f = fixture(|db| {
        db.execute_batch("CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT)")
            .unwrap();
        let tx = db.unchecked_transaction().unwrap();
        let mut settings = Settings::default();
        settings.merge_backlog_runs = 128;
        let mut index = KeptRuns::create(&tx, "record_keys", settings).unwrap();
        tx.execute(
            "INSERT INTO record_keys_meta(key,value) VALUES('engine','\"record-log\"')",
            [],
        )
        .unwrap();
        let mut next = 0usize;
        for run in 0..48 {
            let entries = if run < 44 { 2 } else { 3 };
            for index_in_run in next..next + entries {
                let id = format!("root-{index_in_run:03}");
                let sequence = format!("seq-{index_in_run:03}");
                index
                    .put(
                        &format!("i\0{id}"),
                        json!(["decision", sequence, {"at":"a"}]),
                    )
                    .unwrap();
                index
                    .put(
                        &format!("r\0decision\0seq-{index_in_run:03}\0{id}"),
                        json!({"title": index_in_run}),
                    )
                    .unwrap();
            }
            index.flush(&tx, &json!(0)).unwrap();
            next += entries;
        }
        assert_eq!(next, ROOTS);
        tx.commit().unwrap();
        tail(
            db,
            1,
            LOG_ID,
            "decision-batch-tail",
            0,
            1,
            r#"[{"id":"root-000","type":"decision","set":{"replayed":true},"at":"b"}]"#,
        );
        db.execute(
            "UPDATE record_log SET keys=? WHERE rowid=1",
            [r#"{"root-000":{"slot":"synthetic"}}"#],
        )
        .unwrap();
    });

    let ids = (0..ROOTS)
        .map(|index| format!("root-{index:03}"))
        .collect::<Vec<_>>();
    let source_before = fs::read(&f.database).unwrap();
    let started = Instant::now();
    let shared = SharedRecordSql::new_reusing_snapshot(
        current_source(&f, || Ok(()), Arc::new(AtomicBool::new(false))),
        SharedLimits::default(),
    )
    .unwrap();
    let mut batch_reader =
        LegacyRecords::open_for_current_head(shared.clone(), Bounds::default()).unwrap();
    let batch = match batch_reader.read_stored_batch(&ids, &kept()) {
        Ok(batch) => batch,
        Err(error) => {
            eprintln!(
                "selected-batch-refusal error={error:?} shared_work={:?} record_diagnostic={}",
                shared.work().unwrap(),
                batch_reader
                    .last_read_diagnostic()
                    .map_or_else(|| "none".into(), |diagnostic| diagnostic.to_string()),
            );
            panic!("selected root batch refused under unchanged shared limits");
        }
    };
    let work = shared.work().unwrap();
    assert_eq!(batch.len(), ROOTS);
    assert!(batch[0]
        .as_ref()
        .unwrap()
        .value_json
        .contains("\"replayed\":true"));
    assert!(batch[0].as_ref().unwrap().protected_key_present);
    assert!(batch.iter().all(Option::is_some));
    assert!(work.sql_statements <= SharedLimits::default().statements);
    assert!(work.rows_returned <= SharedLimits::default().rows);
    assert!(work.source_bytes <= SharedLimits::default().source_bytes);
    let elapsed = started.elapsed();
    assert!(elapsed <= Duration::from_secs(5));
    eprintln!(
        "selected-stored-batch roots={ROOTS} runs=48 sql={} rows={} source_bytes={} elapsed_us={} changed_rows=0",
        work.sql_statements,
        work.rows_returned,
        work.source_bytes,
        elapsed.as_micros(),
    );
    let source = batch_reader.into_source();
    drop(shared);
    source.finish().unwrap();
    assert_eq!(fs::read(&f.database).unwrap(), source_before);

    let mut canonical = reader(&f);
    for (id, actual) in ids.iter().zip(batch) {
        let expected = canonical.read_stored(id, &kept()).unwrap();
        match (actual, expected) {
            (Some(actual), Some(expected)) => assert_eq!(
                (
                    actual.id,
                    actual.record_type,
                    actual.sequence,
                    actual.value_json,
                    actual.meta_json,
                    actual.protected_key_present,
                ),
                (
                    expected.id,
                    expected.record_type,
                    expected.sequence,
                    expected.value_json,
                    expected.meta_json,
                    expected.protected_key_present,
                )
            ),
            (None, None) => {}
            _ => panic!("batch and canonical selected-record answers differ"),
        }
    }
}

#[test]
fn selected_stored_batch_external_values_preserve_absence_and_duplicates() {
    use trillion_local::kept_runs::{KeptRuns, Settings};

    let f = fixture(|db| {
        db.execute_batch("CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT)")
            .unwrap();
        let tx = db.unchecked_transaction().unwrap();
        let mut index = KeptRuns::create(&tx, "record_keys", Settings::default()).unwrap();
        tx.execute(
            "INSERT INTO record_keys_meta(key,value) VALUES('engine','\"record-log\"')",
            [],
        )
        .unwrap();
        for id in ["present", "missing", "tombstone"] {
            index
                .put(&format!("i\0{id}"), json!(["decision", format!("seq-{id}")]))
                .unwrap();
        }
        index
            .put("r\0decision\0seq-present\0present", json!({"title":"present"}))
            .unwrap();
        index
            .put("r\0decision\0seq-tombstone\0tombstone", json!({"title":"old"}))
            .unwrap();
        index.remove("r\0decision\0seq-tombstone\0tombstone").unwrap();
        index.flush(&tx, &json!(0)).unwrap();
        tx.commit().unwrap();
    });
    let ids = vec!["present".into(), "missing".into(), "tombstone".into(), "present".into()];
    let mut batch_reader = reader(&f);
    let records = batch_reader.read_stored_batch(&ids, &kept()).unwrap();
    assert_eq!(records.len(), 4);
    assert_eq!(records[0].as_ref().unwrap().value_json, r#"{"title":"present"}"#);
    assert!(records[1].is_none());
    assert!(records[2].is_none());
    assert_eq!(records[0].as_ref().unwrap().value_json, records[3].as_ref().unwrap().value_json);
}

#[test]
fn selected_stored_batch_rejects_malformed_external_value_pointer() {
    use trillion_local::kept_runs::{KeptRuns, Settings};

    let f = fixture(|db| {
        db.execute_batch("CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT)")
            .unwrap();
        let tx = db.unchecked_transaction().unwrap();
        let mut index = KeptRuns::create(&tx, "record_keys", Settings::default()).unwrap();
        tx.execute(
            "INSERT INTO record_keys_meta(key,value) VALUES('engine','\"record-log\"')",
            [],
        )
        .unwrap();
        index.put("i\0bad", json!([7, "sequence"])).unwrap();
        index.flush(&tx, &json!(0)).unwrap();
        tx.commit().unwrap();
    });
    let mut batch_reader = reader(&f);
    assert!(matches!(
        batch_reader.read_stored_batch(&["bad".into()], &kept()),
        Err(Error::Corrupt(_))
    ));
}

#[test]
fn readonly_tail_whole_patch_unset_and_metadata_use_original_stamp_owner() {
    let f = fixture(|db| {
        checkpoint_fixture(db);
        tail(
            db,
            1,
            LOG_ID,
            "tx",
            0,
            1,
            r#"[{"id":"root","type":"page","value":{"old":2,"gone":3},"at":"b","seq":"new-order"},{"id":"root","type":"page","set":{"latest":{"z":1.00,"a":2},"one":1e2},"unset":["gone"],"at":"c","seq":"patch-order"}]"#,
        );
    });
    let before = fs::read(&f.database).unwrap();
    let got = reader(&f).read_stored("root", &kept()).unwrap().unwrap();
    assert_eq!(got.sequence, "original-order");
    assert_eq!(
        got.value_json,
        r#"{"old":2,"latest":{"z":1,"a":2},"one":100}"#
    );
    let meta: serde_json::Value = serde_json::from_str(got.meta_json.as_deref().unwrap()).unwrap();
    assert_eq!(meta["at"], "c");
    assert_eq!(meta["d"]["gone"], "c");
    assert_eq!(fs::read(&f.database).unwrap(), before);
}
#[test]
fn latest_removal_floor_prevents_stale_resurrection_and_later_patch_can_recreate() {
    for recreate in [false, true] {
        let f = fixture(|db| {
            checkpoint_fixture(db);
            let mut rows = vec![
                json!({"id":"root","remove":true,"at":"z","seq":"remove-order"}),
                json!({"id":"root","type":"page","value":{"stale":true},"at":"b","seq":"stale-order"}),
            ];
            if recreate {
                rows.push(json!({"id":"root","type":"page","set":{"fresh":true},"at":"zz","seq":"recreated-order"}));
            }
            tail(
                db,
                1,
                LOG_ID,
                "tx",
                0,
                1,
                &serde_json::to_string(&rows).unwrap(),
            );
        });
        let got = reader(&f).read_stored("root", &kept()).unwrap();
        if recreate {
            let got = got.unwrap();
            assert_eq!(got.sequence, "recreated-order");
            assert_eq!(got.value_json, r#"{"fresh":true}"#);
        } else {
            assert!(got.is_none());
        }
    }
}
#[test]
fn exact_and_purge_tail_semantics_do_not_merge_in_old_fields() {
    for operation in ["exact", "purge"] {
        let f = fixture(|db| {
            checkpoint_fixture(db);
            let rows = if operation == "exact" {
                json!([{"id":"root","type":"other","value":{"only":true},"at":"0","seq":"exact-order","exact":true}])
            } else {
                json!([{"id":"root","purge":true},{"id":"root","type":"other","value":{"only":true},"at":"b","seq":"after-purge-order"}])
            };
            tail(db, 1, LOG_ID, "tx", 0, 1, &rows.to_string());
        });
        let got = reader(&f).read_stored("root", &kept()).unwrap().unwrap();
        assert_eq!(got.record_type, "other");
        assert_eq!(got.value_json, r#"{"only":true}"#);
        assert_eq!(
            got.sequence,
            if operation == "exact" {
                "exact-order"
            } else {
                "after-purge-order"
            }
        );
    }
}
#[test]
fn multipart_tail_is_complete_before_apply_and_accepts_original_rowid_gaps() {
    let f = fixture(|db| {
        checkpoint_fixture(db);
        let body = r#"[{"id":"root","type":"page","value":{"latest":"whole transaction"},"at":"b","seq":"source-order"}]"#;
        let at = 37;
        tail(db, 1, LOG_ID, "tx", 0, 2, &body[..at]);
        tail(db, 3, &format!("{LOG_ID}.1"), "tx", 1, 2, &body[at..]);
    });
    let got = reader(&f).read_stored("root", &kept()).unwrap().unwrap();
    assert_eq!(got.value_json, r#"{"latest":"whole transaction"}"#);
    assert_eq!(got.sequence, "original-order");
}
#[test]
fn invalid_or_incomplete_tail_never_returns_checkpoint_as_current() {
    for change in [
        "missing-part",
        "wrong-transaction",
        "wrong-id",
        "bad-json",
        "stray-part",
        "too-many-parts",
    ] {
        let f = fixture(|db| {
            checkpoint_fixture(db);
            match change {
                "missing-part" => tail(db, 1, LOG_ID, "tx", 0, 2, "["),
                "wrong-transaction" => {
                    tail(db, 1, LOG_ID, "tx", 0, 2, "[");
                    tail(db, 2, &format!("{LOG_ID}.1"), "foreign-tx", 1, 2, "]");
                }
                "wrong-id" => {
                    tail(db, 1, LOG_ID, "tx", 0, 2, "[");
                    tail(db, 2, "foreign-row-id", "tx", 1, 2, "]");
                }
                "bad-json" => tail(db, 1, LOG_ID, "tx", 0, 1, "[{invalid-json}]"),
                "stray-part" => tail(db, 1, &format!("{LOG_ID}.1"), "tx", 1, 2, "]"),
                _ => tail(db, 1, LOG_ID, "tx", 0, 33, "[]"),
            }
        });
        assert!(
            reader(&f).read_stored("root", &kept()).is_err(),
            "must refuse {change}"
        );
    }
}
#[test]
fn new_tail_record_uses_original_uuid_sequence_and_keeps_key_material_private() {
    let f = fixture(|db| {
        meta(db, "record-log");
        keys(db, vec![("i\0unrelated", r#"["page","s",{}]"#.into())]);
        db.execute_batch("ALTER TABLE record_log ADD COLUMN keys TEXT")
            .unwrap();
        tail(
            db,
            1,
            LOG_ID,
            "tx",
            0,
            1,
            r#"[{"id":"root","type":"page","value":{"source":true}}]"#,
        );
        db.execute(
            "UPDATE record_log SET keys=? WHERE rowid=1",
            [r#"{"root":"fixture-private-erasure-key"}"#],
        )
        .unwrap();
    });
    let got = reader(&f).read_stored("root", &kept()).unwrap().unwrap();
    assert_eq!(got.sequence, "0123456789abcde0000");
    assert!(got.protected_key_present);
    assert_eq!(got.value_json, r#"{"source":true}"#);
    assert!(!format!("{got:?}").contains("fixture-private-erasure-key"));
}
#[test]
fn aggregate_tail_bytes_refuse_before_returning_any_selected_state() {
    let f = fixture(|db| {
        checkpoint_fixture(db);
        tail(
            db,
            1,
            LOG_ID,
            "tx",
            0,
            1,
            &json!([{"id":"unrelated","type":"page","value":{"large":"x".repeat(4096)}}])
                .to_string(),
        );
    });
    let mut bounds = Bounds::default();
    bounds.bytes = 2048;
    let mut small = LegacyRecords::open(original(&f), bounds).unwrap();
    assert!(matches!(
        small.read_stored("root", &kept()),
        Err(Error::Bounds(_))
    ));
    let diagnostic = small.last_read_diagnostic().unwrap();
    assert!(diagnostic.reason.contains("byte"));
    assert!(diagnostic.outer_source_bytes <= diagnostic.limits.bytes);
    assert_eq!(diagnostic.limits.bytes, 2048);
    let output = diagnostic.to_string();
    assert!(output.contains("limit_bytes=2048"));
    assert!(!output.contains("unrelated"));
    assert!(!output.contains(&"x".repeat(100)));
    let got = reader(&f).read_stored("root", &kept()).unwrap().unwrap();
    assert_eq!(got.sequence, "original-order");
    assert_eq!(got.value_json, r#"{"old":1.00,"remove":"original"}"#);
}
#[test]
fn remaining_statement_budget_refuses_before_nested_sql_and_preserves_reset() {
    let f = fixture(checkpoint_fixture);
    let before = fs::read(&f.database).unwrap();
    let mut bounds = Bounds::default();
    bounds.statements = 6;
    let mut r = LegacyRecords::open(original(&f), bounds).unwrap();
    assert!(matches!(r.read_stored("root", &kept()), Err(Error::Bounds(_))));
    let diagnostic = r.last_read_diagnostic().unwrap();
    assert_eq!(diagnostic.stage, "kept-point-budget");
    assert_eq!(diagnostic.reason, "original kept SQL budget exhausted");
    assert_eq!(
        diagnostic.outer_sql_statements,
        diagnostic.limits.statements
    );
    assert_eq!(diagnostic.limits.statements, 6);
    assert_eq!(diagnostic.limits.rows, 4096);
    assert_eq!(diagnostic.limits.bytes, 8 * 1024 * 1024);
    assert_eq!(diagnostic.limits.elapsed, std::time::Duration::from_secs(5));
    let point = diagnostic.kept_work.as_ref().unwrap();
    assert_eq!(point.sql_statements, 0);
    assert_eq!(point.rows_returned, 0);
    let output = diagnostic.to_string();
    assert!(output.contains("outer_elapsed_us="));
    assert!(output.contains("limit_sql=6"));
    assert!(output.contains("limit_elapsed_us=5000000"));
    assert!(!output.contains("original-order"));
    assert!(!output.contains("remove"));
    assert!(!output.contains("SELECT"));
    assert!(reader(&f).read_stored("root", &kept()).unwrap().is_some());
    assert!(matches!(
        r.read_stored("bad\0id", &kept()),
        Err(Error::Invalid(_))
    ));
    assert!(r.last_read_diagnostic().is_none());
    assert_eq!(fs::read(&f.database).unwrap(), before);
}

#[test]
fn remaining_row_budget_reaches_nested_sql_before_materialization_and_returns_no_partial_answer() {
    let f = fixture(checkpoint_fixture);
    let mut bounds = Bounds::default();
    bounds.rows = 16;
    let mut r = LegacyRecords::open(original(&f), bounds).unwrap();
    assert!(matches!(r.read_stored("root", &kept()), Err(Error::Bounds(_))));
    let diagnostic = r.last_read_diagnostic().unwrap();
    assert_eq!(diagnostic.stage, "kept-point-budget");
    assert!(diagnostic.reason.contains("row"));
    assert!(diagnostic.outer_rows_returned <= diagnostic.limits.rows);
    assert_eq!(diagnostic.limits.rows, 16);
    assert!(diagnostic.kept_work.is_some());
    assert!(reader(&f).read_stored("root", &kept()).unwrap().is_some());
}
#[test]
fn equal_stamp_ties_use_ecmascript_nested_property_order_and_utf16_values() {
    let f = fixture(|db| {
        meta(db, "record-log");
        keys(
            db,
            vec![(
                "i\0root",
                r#"["page","source-order",{"f":{"z":1.00,"a":2},"surrogate":"\ud800"},{"at":"m"}]"#
                    .into(),
            )],
        );
        tail(
            db,
            1,
            LOG_ID,
            "tx",
            0,
            1,
            r#"[{"id":"root","type":"page","set":{"f":{"a":2,"z":1}},"at":"m","seq":"tie-order"}]"#,
        );
    });
    let got = reader(&f).read_stored("root", &kept()).unwrap().unwrap();
    assert_eq!(got.sequence, "source-order");
    assert_eq!(
        got.value_json,
        r#"{"f":{"a":2,"z":1},"surrogate":"\ud800"}"#
    );
}
#[test]
fn nested_kept_sql_failure_retains_codes_and_work_without_sql_or_values() {
    use trillion_local::legacy_kept::SourceFailure;
    let f = fixture(|db| {
        checkpoint_fixture(db);
        db.execute_batch("DROP TABLE record_keys_run_1").unwrap();
    });
    let mut r = reader(&f);
    assert!(matches!(r.read_stored("root", &kept()), Err(Error::Source(_))));
    let diagnostic = r.last_read_diagnostic().unwrap();
    assert_eq!(diagnostic.stage, "kept-point");
    assert_eq!(
        diagnostic.reason,
        "original kept source query refused or failed"
    );
    assert!(matches!(
        diagnostic.source,
        Some(SourceFailure::Sqlite {
            primary: 1,
            extended: 1,
            ..
        })
    ));
    let work = diagnostic.kept_work.as_ref().unwrap();
    assert!(work.sql_statements > 0 && work.rows_returned > 0);
    assert!(
        work.elapsed_us
            >= work.source_precheck_us
                + work.source_sql_us
                + work.source_postcheck_us
                + work.head_decode_us
                + work.page_decode_us
    );
    let output = diagnostic.to_string();
    assert!(output.contains("primary=1 extended=1"));
    assert!(output.contains("kept_precheck_us="));
    assert!(output.contains("kept_sql_us="));
    assert!(output.contains("kept_postcheck_us="));
    assert!(output.contains("kept_head_decode_us="));
    assert!(output.contains("kept_page_decode_us="));
    assert!(output.contains("kept_elapsed_us="));
    assert!(!output.contains("record_keys_run_1"));
    assert!(!output.contains("original-order"));
    assert!(!output.contains("SELECT"));
    let timing = r.last_read_timing();
    assert!(timing.elapsed_us >= work.elapsed_us);
    assert!(timing.source_sql_us >= work.source_sql_us);
    assert!(timing.source_precheck_us >= work.source_precheck_us);
    assert!(timing.source_postcheck_us >= work.source_postcheck_us);
    // An independent good source has no stale failure attached to its answer.
    let good = fixture(checkpoint_fixture);
    let mut good = reader(&good);
    assert!(good.read_stored("root", &kept()).unwrap().is_some());
    assert!(good.last_read_diagnostic().is_none());
    assert!(good.read_stored("bad\0id", &kept()).is_err());
    assert!(good.last_read_diagnostic().is_none());
    let invalid_timing = good.last_read_timing();
    assert_eq!(invalid_timing.elapsed_us, 0);
    assert_eq!(invalid_timing.source_precheck_us, 0);
    assert_eq!(invalid_timing.source_sql_us, 0);
    assert_eq!(invalid_timing.source_postcheck_us, 0);
    assert_eq!(invalid_timing.head_decode_us, 0);
    assert_eq!(invalid_timing.page_decode_us, 0);
}
#[test]
fn direct_changed_source_refusal_keeps_static_reason_and_attempt_count() {
    use trillion_local::legacy_kept::SourceFailure;
    let f = fixture(checkpoint_fixture);
    let mut r = reader(&f);
    fs::write(&f.database, b"private-changed-source-sentinel").unwrap();
    assert!(matches!(r.read_stored("root", &kept()), Err(Error::Source(_))));
    let diagnostic = r.last_read_diagnostic().unwrap();
    assert_eq!(diagnostic.stage, "original-query");
    assert!(matches!(diagnostic.source, Some(SourceFailure::Refused(_, _))));
    assert_eq!(diagnostic.outer_sql_statements, 1);
    assert_eq!(diagnostic.outer_rows_returned, 0);
    assert!(diagnostic.kept_work.is_none());
    assert!(!diagnostic
        .to_string()
        .contains("private-changed-source-sentinel"));
}

#[test]
fn adaptive_tail_window_spans_multipart_and_validates_later_rows_within_statement_budget() {
    for malformed_later in [false, true] {
        let f = fixture(|db| {
            db.execute_batch("BEGIN").unwrap();
            checkpoint_fixture(db);
            for n in 1..=255 {
                tail(
                    db,
                    n,
                    &format!("00000000-0000-7000-8000-{n:012x}"),
                    "empty",
                    0,
                    1,
                    "[]",
                );
            }
            let raw = r#"[{"id":"root","type":"page","set":{"chunked":true},"at":"z"}]"#;
            let middle = raw.len() / 2;
            tail(db, 256, LOG_ID, "split", 0, 2, &raw[..middle]);
            tail(
                db,
                257,
                &format!("{LOG_ID}.1"),
                "split",
                1,
                2,
                &raw[middle..],
            );
            for n in 258..=500 {
                tail(
                    db,
                    n,
                    &format!("00000000-0000-7000-8000-{n:012x}"),
                    "empty",
                    0,
                    1,
                    "[]",
                );
            }
            if malformed_later {
                tail(db, 501, "missing-initial.1", "broken", 1, 2, "[]");
            }
            db.execute_batch("COMMIT").unwrap();
        });
        let before = fs::read(&f.database).unwrap();
        let mut bounds = Bounds::default();
        bounds.statements = 20;
        let mut r = LegacyRecords::open(original(&f), bounds).unwrap();
        let result = r.read_stored("root", &kept());
        if malformed_later {
            assert!(matches!(result, Err(Error::ReplayRequired(_))));
        } else {
            let record = result.unwrap().unwrap();
            assert!(record.value_json.contains("\"chunked\":true"));
            assert_eq!(record.sequence, "original-order");
        }
        assert_eq!(fs::read(&f.database).unwrap(), before);
    }
}
#[test]
fn adaptive_tail_preserves_smaller_supplier_packets_and_never_returns_a_partial_prefix() {
    for oversized_last in [false, true] {
        let f = fixture(|db| {
            db.execute_batch("BEGIN").unwrap();
            checkpoint_fixture(db);
            let raw =
                json!([{"id":"other","type":"page","value":{"pad":"x".repeat(80)}}]).to_string();
            for n in 1..=100 {
                tail(
                    db,
                    n,
                    &format!("00000000-0000-7000-8000-{n:012x}"),
                    "tx",
                    0,
                    1,
                    &raw,
                );
            }
            let raw = if oversized_last {
                json!([{"id":"root","type":"page","set":{"pad":"x".repeat(5000)},"at":"z"}])
                    .to_string()
            } else {
                r#"[{"id":"root","type":"page","set":{"seen":true},"at":"z"}]"#.into()
            };
            tail(db, 101, LOG_ID, "final", 0, 1, &raw);
            db.execute_batch("COMMIT").unwrap();
        });
        let before = fs::read(&f.database).unwrap();
        let mut limits = ReadLimits::default();
        limits.result_bytes = 4096;
        let original = NativeCatalog::open(
            &f.state,
            f.receipt.clone(),
            AccountIdentity {
                user_id: "fixture-user".into(),
                owner_id: "b".repeat(64),
            },
            limits,
        )
        .unwrap()
        .open_object("PERSON", &"a".repeat(64), f.sqlite.clone())
        .unwrap();
        assert_eq!(original.read_limits().result_bytes, 4096);
        let mut bounds = Bounds::default();
        bounds.statements = 20;
        let mut r = LegacyRecords::open(original, bounds).unwrap();
        let result = r.read_stored("root", &kept());
        if oversized_last {
            assert!(matches!(result, Err(Error::Source(_))));
            assert_eq!(r.last_read_diagnostic().unwrap().stage, "log-replay-query");
        } else {
            assert!(result
                .unwrap()
                .unwrap()
                .value_json
                .contains("\"seen\":true"));
        }
        assert_eq!(fs::read(&f.database).unwrap(), before);
    }
}

fn current_source<W: trillion_local::record_source::RecordSourceWitness>(
    f: &Fixture,
    witness: W,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> trillion_local::record_source::SnapshotRecordSql<W> {
    use rusqlite::OpenFlags;
    let connection = Connection::open_with_flags(
        &f.database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    trillion_local::record_source::SnapshotRecordSql::begin(
        connection,
        ReadLimits::default(),
        witness,
        cancelled,
    )
    .unwrap()
}

#[test]
fn same_decoder_reads_current_snapshot_tail_and_new_snapshot_sees_later_commit() {
    use std::sync::{atomic::AtomicBool, Arc};
    let f = fixture(checkpoint_fixture);
    let writer = Connection::open(&f.database).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    let source = current_source(&f, || Ok(()), Arc::new(AtomicBool::new(false)));
    let mut current = LegacyRecords::open_source(source, Bounds::default()).unwrap();
    // open_source's real detection establishes the held SQLite read snapshot.
    tail(
        &writer,
        1,
        LOG_ID,
        "current",
        0,
        1,
        r#"[{"id":"root","type":"page","set":{"new":true},"at":"z"}]"#,
    );
    let old = current.read_stored("root", &kept()).unwrap().unwrap();
    assert_eq!(old.sequence, "original-order");
    assert_eq!(old.value_json, r#"{"old":1.00,"remove":"original"}"#);
    assert!(current.last_read_timing().source_timing_complete);
    current.into_source().finish().unwrap();
    let source = current_source(&f, || Ok(()), Arc::new(AtomicBool::new(false)));
    let mut current = LegacyRecords::open_source(source, Bounds::default()).unwrap();
    let latest = current.read_stored("root", &kept()).unwrap().unwrap();
    assert!(latest.value_json.contains("\"new\":true"));
    assert_eq!(latest.sequence, "original-order");
    current.into_source().finish().unwrap();
}

#[test]
fn same_decoder_reads_current_eeaf_rows_and_exact_history() {
    use std::sync::{atomic::AtomicBool, Arc};
    let f = fixture(|db| {
        eeaf_data(db);
        db.execute(
            "INSERT INTO bitemporal_facts VALUES(?,?,?,?,?,?,?,?)",
            params![
                "history-id",
                "physical-record",
                "entity",
                "{\"raw\":1.00}",
                "tx",
                "actor",
                "app",
                "sys"
            ],
        )
        .unwrap();
    });
    let source = current_source(&f, || Ok(()), Arc::new(AtomicBool::new(false)));
    let mut current = LegacyRecords::open_source(source, Bounds::default()).unwrap();
    assert_eq!(current.engine().unwrap(), Engine::Eeaf);
    let rows = current.own_rows("root").unwrap();
    assert_eq!(rows.entities.len(), 5);
    assert_eq!(
        rows.facts[0].value_json.as_deref(),
        Some(r#"{"z":1.00,"a":"original"}"#)
    );
    assert_eq!(
        rows.participations[0].counterpart_id.as_deref(),
        Some("counterpart:original")
    );
    let history = current
        .history("bitemporal_facts", "physical-record", 0, 1)
        .unwrap();
    assert_eq!(history.rows.len(), 1);
    assert_eq!(history.rows[0].patch, r#"{"raw":1.00}"#);
    current.into_source().finish().unwrap();
}

#[test]
fn current_witness_revocation_before_or_after_sql_withholds_the_canonical_record() {
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    for revoke_after_sql in [false, true] {
        let f = fixture(checkpoint_fixture);
        let calls = Arc::new(AtomicUsize::new(0));
        let revoke_at = Arc::new(AtomicUsize::new(usize::MAX));
        let count = calls.clone();
        let limit = revoke_at.clone();
        let source = current_source(
            &f,
            move || {
                let call = count.fetch_add(1, Ordering::SeqCst) + 1;
                if call >= limit.load(Ordering::SeqCst) {
                    Err(trillion_local::import::ImportError::Refused(
                        "fixture current rights revoked",
                     trillion_local::cause!()))
                } else {
                    Ok(())
                }
            },
            Arc::new(AtomicBool::new(false)),
        );
        let mut current = LegacyRecords::open_source(source, Bounds::default()).unwrap();
        let now = calls.load(Ordering::SeqCst);
        revoke_at.store(now + if revoke_after_sql { 2 } else { 1 }, Ordering::SeqCst);
        assert!(matches!(
            current.read_stored("root", &kept()),
            Err(Error::Source(_))
        ));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            now + if revoke_after_sql { 2 } else { 1 }
        );
        // Retirement persists: no stale readable snapshot can produce a retry.
        assert!(matches!(
            current.read_stored("root", &kept()),
            Err(Error::Source(_))
        ));
    }
}

#[test]
fn current_cancellation_withholds_record_and_retires_supplier() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let f = fixture(checkpoint_fixture);
    let cancelled = Arc::new(AtomicBool::new(false));
    let source = current_source(&f, || Ok(()), cancelled.clone());
    let mut current = LegacyRecords::open_source(source, Bounds::default()).unwrap();
    cancelled.store(true, Ordering::SeqCst);
    assert!(matches!(
        current.read_stored("root", &kept()),
        Err(Error::Source(_))
    ));
    cancelled.store(false, Ordering::SeqCst);
    assert!(matches!(
        current.read_stored("root", &kept()),
        Err(Error::Source(_))
    ));
}

#[test]
fn generic_reader_refuses_unreported_ceilings_before_query() {
    struct NoCeilings;
    impl trillion_local::record_source::BoundedRecordSql for NoCeilings {
        fn query(
            &mut self,
            _: &str,
            _: &[rusqlite::types::Value],
        ) -> trillion_local::import::ImportResult<trillion_local::import::QueryRows> {
            panic!("unsupported source must refuse before SQL")
        }
    }
    assert!(matches!(
        LegacyRecords::open_source(NoCeilings, Bounds::default()),
        Err(Error::Source(_))
    ));
}

#[test]
fn generic_reader_does_not_label_unsupported_timing_as_measured_zero() {
    use trillion_local::{
        import::{ImportResult, QueryRows},
        record_source::{BoundedRecordSql, QueryBudget},
    };
    struct Unmeasured<S> {
        source: S,
        limits: ReadLimits,
    }
    impl<S: BoundedRecordSql> BoundedRecordSql for Unmeasured<S> {
        fn read_limits(&self) -> Option<&ReadLimits> {
            Some(&self.limits)
        }
        fn query(
            &mut self,
            sql: &str,
            params: &[rusqlite::types::Value],
        ) -> ImportResult<QueryRows> {
            self.source.query(sql, params)
        }
        fn query_with_budget(
            &mut self,
            sql: &str,
            params: &[rusqlite::types::Value],
            budget: QueryBudget,
        ) -> ImportResult<QueryRows> {
            self.source.query_with_budget(sql, params, budget)
        }
    }
    let f = fixture(checkpoint_fixture);
    let original = original(&f);
    let limits = original.read_limits().clone();
    let mut reader = LegacyRecords::open_source(
        Unmeasured {
            source: original,
            limits,
        },
        Bounds::default(),
    )
    .unwrap();
    assert!(reader.read_stored("root", &kept()).unwrap().is_some());
    assert!(!reader.last_read_timing().source_timing_complete);
}
