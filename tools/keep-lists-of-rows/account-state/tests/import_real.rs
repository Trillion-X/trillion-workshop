// tests/import_real.rs
//
// Purpose: Exercises native catalog import against constructed real SQLite files and restore receipts.
//
// Non-Negotiable Invariants:
// - Source database bytes and sidecar state stay unchanged; import copies only to a fresh destination after identity, pin, scope, and query checks.
//
// Key Concepts:
// - FilePin byte counts and BLAKE3 identities bind receipt, index, and original SQLite bytes.
// - Read-only SQLite queries preserve scalar encodings; safe copying targets a fresh destination and accounts for WAL/SHM provenance.
//
// Security Considerations:
// - Fixtures are synthetic local data, not real-account proof; malformed receipts, mutation SQL, links, locks, and unproven WAL state must fail closed.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! These fixtures use actual SQLite files/schema/scalars, not a synthetic
//! records JSON substitute. Real-account proof requires a separate admitted run.
use rusqlite::{types::Value, Connection};
use content_crypto::advanced::blake3;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::{tempdir, TempDir};
use trillion_local::import::{AccountIdentity, FilePin, NativeCatalog, ReadLimits, SqlValue};
struct Fixture {
    _root: TempDir,
    state: PathBuf,
    database: PathBuf,
    destination: PathBuf,
    id: String,
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
fn account() -> AccountIdentity {
    AccountIdentity {
        user_id: "fixture-user".into(),
        owner_id: "b".repeat(64),
    }
}
fn fixture() -> Fixture {
    let root = tempdir().unwrap();
    let state = root.path().join("native original #? with space");
    fs::create_dir(&state).unwrap();
    let database = state.join("original.sqlite");
    let db = Connection::open(&database).unwrap();
    db.execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE actual_rows(id INTEGER PRIMARY KEY,integer_value INTEGER,real_value REAL,text_value TEXT,blob_value BLOB,nullable); CREATE INDEX actual_integer ON actual_rows(integer_value); CREATE VIEW actual_view AS SELECT id,text_value FROM actual_rows; CREATE TABLE _cf_KV(key TEXT PRIMARY KEY,value BLOB); CREATE TABLE with_sequence(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT); INSERT INTO with_sequence(value) VALUES('original'); INSERT INTO _cf_KV VALUES('encrypted-original',X'00FF80');").unwrap();
    db.execute(
        "INSERT INTO actual_rows VALUES(?,?,?,?,?,?)",
        rusqlite::params![
            1i64,
            i64::MAX,
            1.2345678901234567f64,
            "\u{feff}original\0🧪",
            vec![0u8, 128, 255],
            Option::<String>::None
        ],
    )
    .unwrap();
    // SQLite TEXT can retain invalid UTF-8. The adapter must return those bytes.
    db.execute(
        "INSERT INTO actual_rows VALUES(2,-9223372036854775808,?,CAST(X'80FF' AS TEXT),X'',NULL)",
        [f64::INFINITY],
    )
    .unwrap();
    db.close().unwrap();
    let sqlite = pin(&database);
    let id = "a".repeat(64);
    let descriptor = json!({"binding":"NETWORK","originalId":id,"localId":"c".repeat(64),"names":["actual-original"],"sqlite":"original.sqlite","rows":2,"hiddenIdentity":"d".repeat(64),"sourceIdentity":"e".repeat(64),"className":"Network"});
    let index = serde_json::to_string(&descriptor).unwrap() + "\n";
    fs::write(state.join("objects.ndjson"), index.as_bytes()).unwrap();
    let receipt = json!({"version":"trillion.local-restore-indexed/v1","complete":true,"account":{"userId":"fixture-user","ownerId":"b".repeat(64)},"proof":{"workerdStructuredClone":true,"userSQLIntegrity":true,"providerContacted":false},"replay":{"runtimeStarted":false,"alarmsRestored":false,"alarmsArmed":false},"source":{"bundleManifestIdentity":"f".repeat(64),"version":"trillion.local-transfer-bundle/v1"},"objects":{"path":"objects.ndjson","bytes":index.len(),"fileIdentity":blake3::hash(index.as_bytes()).to_hex().to_string(),"count":1},"accountSlices":{"partial_original":true,"complete_original":false,"objects":[{"sql":{"rows":0}}]}});
    fs::write(
        state.join("restore-receipt.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    let receipt = pin(&state.join("restore-receipt.json"));
    let destination = root.path().join("rust-data");
    fs::create_dir(&destination).unwrap();
    Fixture {
        _root: root,
        state,
        database,
        destination,
        id,
        receipt,
        sqlite,
    }
}
fn open(f: &Fixture, limits: ReadLimits) -> NativeCatalog {
    NativeCatalog::open(&f.state, f.receipt.clone(), account(), limits).unwrap()
}
fn change_receipt(f: &mut Fixture, mutate: impl FnOnce(&mut serde_json::Value)) {
    let path = f.state.join("restore-receipt.json");
    let mut value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    mutate(&mut value);
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    f.receipt = pin(&path);
}
#[test]
fn reads_actual_original_schema_and_exact_sqlite_types_without_source_writes() {
    let f = fixture();
    let before = fs::read(&f.database).unwrap();
    let catalog = open(&f, ReadLimits::default());
    assert_eq!(catalog.objects().count(), 1);
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    let rows = original
        .query("SELECT * FROM actual_rows WHERE id=?", &[Value::Integer(1)])
        .unwrap();
    assert_eq!(
        rows.rows[0],
        vec![
            SqlValue::Integer(1),
            SqlValue::Integer(i64::MAX),
            SqlValue::RealBits(1.2345678901234567f64.to_bits()),
            SqlValue::Text("\u{feff}original\0🧪".as_bytes().to_vec()),
            SqlValue::Blob(vec![0, 128, 255]),
            SqlValue::Null
        ]
    );
    let invalid = original
        .query(
            "SELECT text_value,real_value,integer_value FROM actual_rows WHERE id=2",
            &[],
        )
        .unwrap();
    assert_eq!(invalid.rows[0][0], SqlValue::Text(vec![128, 255]));
    assert_eq!(
        invalid.rows[0][1],
        SqlValue::RealBits(f64::INFINITY.to_bits())
    );
    assert_eq!(invalid.rows[0][2], SqlValue::Integer(i64::MIN));
    let schema = original.schema().unwrap();
    assert!(schema
        .rows
        .iter()
        .any(|row| row[1] == SqlValue::Text(b"actual_integer".to_vec())));
    let serialized = serde_json::to_value(SqlValue::Integer(i64::MAX)).unwrap();
    assert_eq!(serialized["value"], i64::MAX.to_string());
    assert_eq!(fs::read(&f.database).unwrap(), before);
    assert!(!f.state.join("original.sqlite-wal").exists());
    assert!(!f.state.join("original.sqlite-shm").exists());
}

#[test]
fn query_phase_timing_survives_sql_failure_and_resets_before_source_refusal() {
    let f = fixture();
    let catalog = open(&f, ReadLimits::default());
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    // Real preparation failure still traverses the post-query continuity check.
    assert!(original
        .query("SELECT missing_private_column", &[])
        .is_err());
    let timing = serde_json::to_value(original.last_query_timing()).unwrap();
    assert_eq!(timing.as_object().unwrap().len(), 3);
    assert!(timing["precheck_us"].is_u64());
    assert!(timing["sql_us"].is_u64());
    assert!(timing["postcheck_us"].is_u64());
    assert!(!timing.to_string().contains("missing_private_column"));

    // A source failure before SQL must not reuse the previous attempt's SQL or
    // postcheck timing. Removing the lock restores the unchanged source.
    fs::write(f.state.join("local-runtime.lock"), b"fixture-owner").unwrap();
    assert!(original.query("SELECT 1", &[]).is_err());
    let refused = original.last_query_timing();
    assert_eq!(refused.sql_us, 0);
    assert_eq!(refused.postcheck_us, 0);
    fs::remove_file(f.state.join("local-runtime.lock")).unwrap();
    assert_eq!(
        original.query("SELECT 1", &[]).unwrap().rows[0][0],
        SqlValue::Integer(1)
    );
    assert_eq!(pin(&f.database).blake3, f.sqlite.blake3);
}

#[test]
fn narrow_results_do_not_impose_their_column_limit_on_wider_original_tables() {
    let f = fixture();
    let before = fs::read(&f.database).unwrap();
    let limits = ReadLimits {
        columns: 2,
        ..ReadLimits::default()
    };
    let catalog = open(&f, limits);
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    let result = original
        .query("SELECT id,text_value FROM actual_rows ORDER BY id", &[])
        .unwrap();
    assert_eq!(result.columns.len(), 2);
    assert_eq!(result.rows.len(), 2);
    assert!(original.query("SELECT * FROM actual_rows", &[]).is_err());
    assert_eq!(fs::read(&f.database).unwrap(), before);
}
#[test]
fn copies_exact_original_snapshot_to_fresh_owner_with_schema_and_kv_provenance() {
    let f = fixture();
    let catalog = open(&f, ReadLimits::default());
    let original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    let destination = f.destination.join("imported.sqlite");
    let receipt = original.copy_to_new(&destination).unwrap();
    assert_eq!(pin(&destination), f.sqlite);
    assert_eq!(receipt.original_id, f.id);
    assert!(!receipt.hidden_storage_decoded);
    assert_eq!(receipt.native_descriptor["hiddenIdentity"], "d".repeat(64));
    let imported = Connection::open(&destination).unwrap();
    let kv: Vec<u8> = imported
        .query_row("SELECT value FROM _cf_KV", [], |row| row.get(0))
        .unwrap();
    assert_eq!(kv, [0, 255, 128]);
    assert!(original.copy_to_new(&destination).is_err());
    assert!(original
        .copy_to_new(f.state.join("must-not-exist.sqlite"))
        .is_err());
    assert!(!f.state.join("must-not-exist.sqlite").exists());
}
#[test]
fn refuses_wrong_account_runtime_partial_scope_or_wrong_receipt_pin() {
    let mut f = fixture();
    assert!(NativeCatalog::open(
        &f.state,
        f.receipt.clone(),
        AccountIdentity {
            user_id: "other".into(),
            owner_id: account().owner_id
        },
        ReadLimits::default()
    )
    .is_err());
    assert!(NativeCatalog::open(
        &f.state,
        FilePin {
            bytes: f.receipt.bytes,
            blake3: "0".repeat(64)
        },
        account(),
        ReadLimits::default()
    )
    .is_err());
    change_receipt(&mut f, |r| r["replay"]["runtimeStarted"] = json!(true));
    assert!(NativeCatalog::open(
        &f.state,
        f.receipt.clone(),
        account(),
        ReadLimits::default()
    )
    .is_err());
    change_receipt(&mut f, |r| {
        r["replay"]["runtimeStarted"] = json!(false);
        r["partial_original"] = json!(true)
    });
    assert!(NativeCatalog::open(
        &f.state,
        f.receipt.clone(),
        account(),
        ReadLimits::default()
    )
    .is_err());
}
#[test]
fn refuses_mutating_queries_attach_and_trailing_statements() {
    let f = fixture();
    let before = fs::read(&f.database).unwrap();
    let catalog = open(&f, ReadLimits::default());
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    for sql in [
        "DELETE FROM actual_rows RETURNING id",
        "PRAGMA query_only=OFF",
        "ATTACH ':memory:' AS extra",
        "CREATE TEMP TABLE unsafe(x)",
        "SELECT 1; SELECT 2",
        "SELECT load_extension('missing')",
    ] {
        assert!(original.query(sql, &[]).is_err(), "must refuse {sql}");
    }
    assert_eq!(fs::read(&f.database).unwrap(), before);
    assert!(original
        .query("SELECT id FROM actual_rows LIMIT 1", &[])
        .is_ok());
}
#[test]
fn bounds_result_rows_bytes_and_aggregate_vm_work_without_partial_success() {
    let f = fixture();
    let mut limits = ReadLimits::default();
    limits.rows = 1;
    let catalog = open(&f, limits);
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    assert!(original.query("SELECT id FROM actual_rows", &[]).is_err());
    let mut limits = ReadLimits::default();
    limits.result_bytes = 8;
    let catalog = open(&f, limits);
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    assert!(original
        .query("SELECT text_value FROM actual_rows", &[])
        .is_err());
    assert!(original
        .query(
            "SELECT id AS alias_longer_than_eight_bytes FROM actual_rows WHERE 0",
            &[]
        )
        .is_err());
    let mut limits = ReadLimits::default();
    limits.vm_steps = 1000;
    limits.elapsed = Duration::from_secs(1);
    let catalog = open(&f, limits);
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    assert!(original.query("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n",&[]).is_err());
    assert!(original
        .query("SELECT id FROM actual_rows LIMIT 1", &[])
        .is_ok());
    let mut limits = ReadLimits::default();
    limits.vm_steps = 1;
    let catalog = open(&f, limits);
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    assert!(original.query("SELECT 1", &[]).is_err());
}
#[test]
fn refuses_wrong_object_sqlite_pin_sidecars_and_changed_sources() {
    let f = fixture();
    let catalog = open(&f, ReadLimits::default());
    assert!(catalog
        .open_object("NETWORK", &"0".repeat(64), f.sqlite.clone())
        .is_err());
    assert!(catalog
        .open_object(
            "NETWORK",
            &f.id,
            FilePin {
                bytes: f.sqlite.bytes,
                blake3: "0".repeat(64)
            }
        )
        .is_err());
    fs::write(f.state.join("original.sqlite-wal"), b"outstanding").unwrap();
    assert!(catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .is_err());
    fs::remove_file(f.state.join("original.sqlite-wal")).unwrap();
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    let db = Connection::open(&f.database).unwrap();
    db.execute("INSERT INTO actual_rows(id) VALUES(3)", [])
        .unwrap();
    db.close().unwrap();
    assert!(original.query("SELECT id FROM actual_rows", &[]).is_err());
}
#[test]
fn refuses_index_tampering_and_symbolic_link_sources() {
    let f = fixture();
    fs::write(f.state.join("objects.ndjson"), b"{}\n").unwrap();
    assert!(NativeCatalog::open(
        &f.state,
        f.receipt.clone(),
        account(),
        ReadLimits::default()
    )
    .is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let f = fixture();
        fs::rename(&f.database, f.destination.join("source.sqlite")).unwrap();
        symlink(f.destination.join("source.sqlite"), &f.database).unwrap();
        assert!(NativeCatalog::open(
            &f.state,
            f.receipt.clone(),
            account(),
            ReadLimits::default()
        )
        .is_err());
    }
}

// Produce real SQLite WAL/SHM bytes, checkpoint to an empty WAL, then close the
// sole fixture writer. Restore only its retained quiescent sidecar bytes.
fn qualify_quiescent_fixture(f: &mut Fixture) {
    let db = Connection::open(&f.database).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; UPDATE actual_rows SET id=id WHERE id=1; PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    let wal_path = f.state.join("original.sqlite-wal");
    let shm_path = f.state.join("original.sqlite-shm");
    let wal = fs::read(&wal_path).unwrap();
    let shm = fs::read(&shm_path).unwrap();
    assert!(wal.is_empty());
    assert_eq!(shm.len(), 32768);
    let checkpointed = pin(&f.database);
    db.close().unwrap();
    assert_eq!(pin(&f.database), checkpointed);
    fs::write(&wal_path, &wal).unwrap();
    fs::write(&shm_path, &shm).unwrap();
    f.sqlite = checkpointed;
    let main = f.sqlite.clone();
    let wal = pin(&wal_path);
    let shm = pin(&shm_path);
    let id = f.id.clone();
    change_receipt(f, |receipt| {
        receipt["extension"] = json!({
            "version":"trillion.pristine-native-extension/v1",
            "capacity":{"localImportedFootprints":[{
                "binding":"NETWORK","id":id,
                "localImportedBytes":main.bytes+wal.bytes+shm.bytes,
                "files":[
                    {"path":"original.sqlite","bytes":main.bytes,"identity":main.blake3},
                    {"path":"original.sqlite-wal","bytes":wal.bytes,"identity":wal.blake3},
                    {"path":"original.sqlite-shm","bytes":shm.bytes,"identity":shm.blake3}
                ]
            }]}
        });
    });
}
#[test]
fn exact_importer_pinned_empty_wal_and_real_shm_allow_read_without_source_writes() {
    let mut f = fixture();
    qualify_quiescent_fixture(&mut f);
    let source_paths = [
        f.database.clone(),
        f.state.join("original.sqlite-wal"),
        f.state.join("original.sqlite-shm"),
    ];
    let before = source_paths
        .iter()
        .map(|path| fs::read(path).unwrap())
        .collect::<Vec<_>>();
    let catalog = open(&f, ReadLimits::default());
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    assert_eq!(
        original
            .query("SELECT id FROM actual_rows ORDER BY id", &[])
            .unwrap()
            .rows
            .len(),
        2
    );
    for _ in 0..3 {
        assert_eq!(
            original
                .query("SELECT count(*) FROM actual_rows", &[])
                .unwrap()
                .rows[0][0],
            SqlValue::Integer(2)
        );
    }
    let copied = f.destination.join("quiescent-copy.sqlite");
    let receipt = original.copy_to_new(&copied).unwrap();
    assert_eq!(pin(&copied), f.sqlite);
    assert_eq!(
        receipt
            .source_quiescent_sidecars
            .as_ref()
            .unwrap()
            .wal
            .bytes,
        0
    );
    assert_eq!(
        receipt
            .source_quiescent_sidecars
            .as_ref()
            .unwrap()
            .shm
            .as_ref()
            .unwrap()
            .bytes,
        32768
    );
    drop(original);
    for (path, bytes) in source_paths.iter().zip(before) {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}
#[test]
fn empty_wal_shm_refuse_unproven_changed_nonempty_or_wrong_original_footprints() {
    let mut f = fixture();
    qualify_quiescent_fixture(&mut f);
    let baseline = fs::read(f.state.join("restore-receipt.json")).unwrap();
    let baseline_receipt: serde_json::Value = serde_json::from_slice(&baseline).unwrap();
    for change in [
        "no-proof",
        "wrong-id",
        "wrong-binding",
        "wrong-main",
        "duplicate",
        "nonempty-wal",
    ] {
        fs::write(f.state.join("restore-receipt.json"), &baseline).unwrap();
        change_receipt(&mut f, |receipt| {
            if change == "no-proof" {
                receipt.as_object_mut().unwrap().remove("extension");
                return;
            }
            let footprint = &mut receipt["extension"]["capacity"]["localImportedFootprints"][0];
            match change {
                "wrong-id" => footprint["id"] = json!("0".repeat(64)),
                "wrong-binding" => footprint["binding"] = json!("OTHER"),
                "wrong-main" => footprint["files"][0]["identity"] = json!("0".repeat(64)),
                "duplicate" => {
                    let file = footprint["files"][1].clone();
                    footprint["files"][2] = file;
                }
                "nonempty-wal" => {
                    footprint["files"][1]["bytes"] = json!(1);
                    footprint["localImportedBytes"] =
                        json!(footprint["localImportedBytes"].as_u64().unwrap() + 1);
                }
                _ => unreachable!(),
            }
        });
        let catalog = open(&f, ReadLimits::default());
        assert!(
            catalog
                .open_object("NETWORK", &f.id, f.sqlite.clone())
                .is_err(),
            "must refuse {change}"
        );
    }
    fs::write(
        f.state.join("restore-receipt.json"),
        serde_json::to_vec(&baseline_receipt).unwrap(),
    )
    .unwrap();
    f.receipt = pin(&f.state.join("restore-receipt.json"));
    let catalog = open(&f, ReadLimits::default());
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    fs::write(
        f.state.join("original.sqlite-wal"),
        b"new uncheckpointed frame",
    )
    .unwrap();
    assert!(original.query("SELECT id FROM actual_rows", &[]).is_err());
    fs::write(f.state.join("original.sqlite-wal"), b"").unwrap();
    fs::write(f.state.join("original.sqlite-shm"), vec![0xA5u8; 32768]).unwrap();
    assert!(original.query("SELECT id FROM actual_rows", &[]).is_err());
    fs::remove_file(f.state.join("original.sqlite-wal")).unwrap();
    fs::remove_file(f.state.join("original.sqlite-shm")).unwrap();
    assert!(catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .is_err());
}
#[test]
fn quiescent_original_refuses_any_runtime_ownership_lock() {
    let mut f = fixture();
    qualify_quiescent_fixture(&mut f);
    let catalog = open(&f, ReadLimits::default());
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    fs::write(f.state.join("local-runtime.lock"), b"fixture runtime owner").unwrap();
    assert!(NativeCatalog::open(
        &f.state,
        f.receipt.clone(),
        account(),
        ReadLimits::default()
    )
    .is_err());
    assert!(original.query("SELECT id FROM actual_rows", &[]).is_err());
}

fn qualify_inherited_fixture(f: &mut Fixture) {
    qualify_quiescent_fixture(f);
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(f.state.join("restore-receipt.json")).unwrap()).unwrap();
    let files = receipt["extension"]["capacity"]["localImportedFootprints"][0]["files"]
        .as_array()
        .unwrap();
    let witness = files
        .iter()
        .map(|row| serde_json::to_string(row).unwrap() + "\n")
        .collect::<String>();
    fs::write(f.state.join("inherited-files.ndjson"), witness.as_bytes()).unwrap();
    let witness_pin = pin(&f.state.join("inherited-files.ndjson"));
    change_receipt(f, |receipt| {
        receipt["extension"] = json!({
            "version":"trillion.pristine-native-extension/v1", "stableSource":true,
            "independentCloneBytesVerified":true,"copyOnWriteRequired":true,
            "providerContacted":false,"applicationStarted":false,
            "files":{"path":"inherited-files.ndjson","bytes":witness_pin.bytes,"fileIdentity":witness_pin.blake3,"count":3}
        });
    });
}
fn replace_inherited_witness(f: &mut Fixture, mutate: impl FnOnce(&mut Vec<serde_json::Value>)) {
    let path = f.state.join("inherited-files.ndjson");
    let mut rows = fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect::<Vec<_>>();
    mutate(&mut rows);
    let text = rows
        .iter()
        .map(|row| serde_json::to_string(row).unwrap() + "\n")
        .collect::<String>();
    fs::write(&path, text.as_bytes()).unwrap();
    let witness = pin(&path);
    let count = rows.len();
    change_receipt(f, |receipt| {
        receipt["extension"]["files"]["bytes"] = json!(witness.bytes);
        receipt["extension"]["files"]["fileIdentity"] = json!(witness.blake3);
        receipt["extension"]["files"]["count"] = json!(count);
    });
}
#[test]
fn inherited_original_uses_exact_retained_file_witness_without_fabricating_delta_footprints() {
    let mut f = fixture();
    qualify_inherited_fixture(&mut f);
    let paths = [
        f.database.clone(),
        f.state.join("original.sqlite-wal"),
        f.state.join("original.sqlite-shm"),
        f.state.join("inherited-files.ndjson"),
        f.state.join("restore-receipt.json"),
    ];
    let before = paths
        .iter()
        .map(|path| fs::read(path).unwrap())
        .collect::<Vec<_>>();
    let catalog = open(&f, ReadLimits::default());
    assert!(catalog.receipt()["extension"].get("capacity").is_none());
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    assert_eq!(
        original
            .query("SELECT id FROM actual_rows ORDER BY id", &[])
            .unwrap()
            .rows
            .len(),
        2
    );
    for _ in 0..3 {
        assert_eq!(
            original
                .query("SELECT count(*) FROM actual_rows", &[])
                .unwrap()
                .rows[0][0],
            SqlValue::Integer(2)
        );
    }
    let copied = f.destination.join("inherited-copy.sqlite");
    assert_eq!(original.copy_to_new(&copied).unwrap().sqlite, f.sqlite);
    drop(original);
    for (path, bytes) in paths.iter().zip(before) {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}
#[test]
fn inherited_file_witness_refuses_wrong_pin_shape_count_native_path_and_nonempty_wal() {
    for change in [
        "raw-pin",
        "count",
        "clone-proof",
        "main-pin",
        "repeated-path",
        "wrong-native-path",
        "nonempty-wal",
        "missing-main",
        "traversal",
    ] {
        let mut f = fixture();
        qualify_inherited_fixture(&mut f);
        match change {
            "raw-pin" => {
                fs::write(f.state.join("inherited-files.ndjson"), b"changed witness").unwrap()
            }
            "count" => change_receipt(&mut f, |receipt| {
                receipt["extension"]["files"]["count"] = json!(2)
            }),
            "clone-proof" => change_receipt(&mut f, |receipt| {
                receipt["extension"]["stableSource"] = json!(false)
            }),
            "main-pin" => replace_inherited_witness(&mut f, |rows| {
                rows[0]["identity"] = json!("0".repeat(64))
            }),
            "repeated-path" => replace_inherited_witness(&mut f, |rows| rows.push(rows[0].clone())),
            "wrong-native-path" => replace_inherited_witness(&mut f, |rows| {
                rows[1]["path"] = json!("different.sqlite-wal")
            }),
            "nonempty-wal" => replace_inherited_witness(&mut f, |rows| rows[1]["bytes"] = json!(1)),
            "missing-main" => replace_inherited_witness(&mut f, |rows| {
                rows.remove(0);
            }),
            "traversal" => change_receipt(&mut f, |receipt| {
                receipt["extension"]["files"]["path"] = json!("../outside.ndjson")
            }),
            _ => unreachable!(),
        }
        let catalog = open(&f, ReadLimits::default());
        assert!(
            catalog
                .open_object("NETWORK", &f.id, f.sqlite.clone())
                .is_err(),
            "must refuse {change}"
        );
    }
}
#[test]
fn inherited_witness_stays_pinned_during_query_and_missing_sidecars_never_become_pristine() {
    let mut f = fixture();
    qualify_inherited_fixture(&mut f);
    let catalog = open(&f, ReadLimits::default());
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    fs::write(
        f.state.join("inherited-files.ndjson"),
        b"changed after verified opening",
    )
    .unwrap();
    assert!(original.query("SELECT id FROM actual_rows", &[]).is_err());
    let mut f = fixture();
    qualify_inherited_fixture(&mut f);
    let catalog = open(&f, ReadLimits::default());
    fs::remove_file(f.state.join("original.sqlite-wal")).unwrap();
    fs::remove_file(f.state.join("original.sqlite-shm")).unwrap();
    assert!(catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .is_err());
}

#[cfg(unix)]
fn restore_modified(path: &Path, metadata: &fs::Metadata) {
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
        .unwrap();
    assert_eq!(
        fs::metadata(path).unwrap().modified().unwrap(),
        metadata.modified().unwrap()
    );
}

#[cfg(unix)]
#[test]
fn held_inherited_proof_refuses_in_place_edit_even_with_same_length_and_restored_mtime() {
    use std::os::unix::fs::MetadataExt;
    use trillion_local::import::ImportError;
    let mut f = fixture();
    qualify_inherited_fixture(&mut f);
    let proof = f.state.join("inherited-files.ndjson");
    let before = fs::metadata(&proof).unwrap();
    let catalog = open(&f, ReadLimits::default());
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    let mut bytes = fs::read(&proof).unwrap();
    bytes[0] ^= 1;
    fs::write(&proof, bytes).unwrap();
    restore_modified(&proof, &before);
    let after = fs::metadata(&proof).unwrap();
    assert_eq!(after.ino(), before.ino());
    assert_eq!(after.len(), before.len());
    assert_eq!(
        (after.mtime(), after.mtime_nsec()),
        (before.mtime(), before.mtime_nsec())
    );
    assert!(matches!(
        original.query("SELECT id FROM actual_rows", &[]),
        Err(ImportError::Refused(
            "original proof file changed during use"
        , _))
    ));
    assert_eq!(original.last_query_timing().sql_us, 0);
    assert!(original
        .copy_to_new(f.destination.join("changed-proof.sqlite"))
        .is_err());
    assert!(!f.destination.join("changed-proof.sqlite").exists());
}

#[cfg(unix)]
#[test]
fn held_inherited_proof_refuses_identical_path_replacement_symlink_and_mode_change() {
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    for change in ["replacement", "symlink", "mode"] {
        let mut f = fixture();
        qualify_inherited_fixture(&mut f);
        let proof = f.state.join("inherited-files.ndjson");
        let before = fs::metadata(&proof).unwrap();
        let bytes = fs::read(&proof).unwrap();
        let catalog = open(&f, ReadLimits::default());
        let mut original = catalog
            .open_object("NETWORK", &f.id, f.sqlite.clone())
            .unwrap();
        match change {
            "mode" => {
                fs::set_permissions(&proof, fs::Permissions::from_mode(before.mode() ^ 0o200))
                    .unwrap()
            }
            _ => {
                let retained = f.state.join("retained-private-proof.ndjson");
                fs::rename(&proof, &retained).unwrap();
                if change == "symlink" {
                    symlink(&retained, &proof).unwrap();
                } else {
                    fs::write(&proof, &bytes).unwrap();
                    restore_modified(&proof, &before);
                    assert_ne!(fs::metadata(&proof).unwrap().ino(), before.ino());
                }
                assert_eq!(fs::read(&proof).unwrap(), bytes);
            }
        }
        let failure = original
            .query("SELECT id FROM actual_rows", &[])
            .unwrap_err();
        assert!(!failure.to_string().contains("retained-private-proof"));
        assert_eq!(
            original.last_query_timing().sql_us,
            0,
            "must refuse {change} before SQL"
        );
    }
}

#[cfg(unix)]
#[test]
fn held_inherited_proof_refuses_replaced_real_or_symlinked_parent_directory() {
    use std::os::unix::fs::{symlink, MetadataExt};
    for change in ["replacement", "symlink"] {
        let mut f = fixture();
        qualify_inherited_fixture(&mut f);
        let directory = f.state.join("proof-directory");
        fs::create_dir(&directory).unwrap();
        let proof = directory.join("inherited-files.ndjson");
        fs::rename(f.state.join("inherited-files.ndjson"), &proof).unwrap();
        change_receipt(&mut f, |receipt| {
            receipt["extension"]["files"]["path"] = json!("proof-directory/inherited-files.ndjson")
        });
        let bytes = fs::read(&proof).unwrap();
        let before = fs::metadata(&proof).unwrap();
        let catalog = open(&f, ReadLimits::default());
        let mut original = catalog
            .open_object("NETWORK", &f.id, f.sqlite.clone())
            .unwrap();
        let moved = f.state.join("retained-proof-directory");
        fs::rename(&directory, &moved).unwrap();
        if change == "symlink" {
            symlink(&moved, &directory).unwrap();
            // The file itself is unchanged; only its named ancestry changed.
            let after = fs::metadata(&proof).unwrap();
            assert_eq!(
                (before.ino(), before.ctime(), before.ctime_nsec()),
                (after.ino(), after.ctime(), after.ctime_nsec())
            );
        } else {
            fs::create_dir(&directory).unwrap();
            fs::write(&proof, &bytes).unwrap();
            restore_modified(&proof, &before);
        }
        assert_eq!(fs::read(&proof).unwrap(), bytes);
        assert!(
            original.query("SELECT id FROM actual_rows", &[]).is_err(),
            "must refuse parent {change}"
        );
        assert_eq!(original.last_query_timing().sql_us, 0);
    }
}

#[cfg(unix)]
#[test]
fn retained_proof_never_skips_fresh_sidecar_content_journal_or_runtime_checks() {
    for change in ["shm", "wal", "journal", "runtime-lock"] {
        let mut f = fixture();
        qualify_inherited_fixture(&mut f);
        let catalog = open(&f, ReadLimits::default());
        let mut original = catalog
            .open_object("NETWORK", &f.id, f.sqlite.clone())
            .unwrap();
        match change {
            "shm" => {
                let path = f.state.join("original.sqlite-shm");
                let before = fs::metadata(&path).unwrap();
                let mut bytes = fs::read(&path).unwrap();
                bytes[0] ^= 1;
                fs::write(&path, bytes).unwrap();
                restore_modified(&path, &before);
            }
            "wal" => fs::write(f.state.join("original.sqlite-wal"), b"nonempty frame").unwrap(),
            "journal" => {
                fs::write(f.state.join("original.sqlite-journal"), b"pending rollback").unwrap()
            }
            "runtime-lock" => {
                fs::write(f.state.join("local-runtime.lock"), b"fixture owner").unwrap()
            }
            _ => unreachable!(),
        }
        assert!(
            original.query("SELECT id FROM actual_rows", &[]).is_err(),
            "must refuse {change}"
        );
        assert_eq!(original.last_query_timing().sql_us, 0);
    }
}

#[test]
fn caller_query_budget_refuses_before_sql_without_bypassing_source_checks_or_widening_limits() {
    use std::time::Instant;
    use trillion_local::{import::ImportError, record_source::QueryBudget};
    let f = fixture();
    let catalog = open(&f, ReadLimits::default());
    let mut original = catalog
        .open_object("NETWORK", &f.id, f.sqlite.clone())
        .unwrap();
    for (rows, bytes) in [(0, 1024), (10, 0)] {
        assert!(matches!(
            original.query_with_budget(
                "SELECT private_missing_column",
                &[],
                QueryBudget {
                    rows,
                    source_bytes: bytes,
                    deadline: Instant::now() + Duration::from_secs(1)
                }
            ),
            Err(ImportError::Budget(_, _))
        ));
    }
    assert!(matches!(
        original.query_with_budget(
            "SELECT id FROM actual_rows",
            &[],
            QueryBudget {
                rows: 1,
                source_bytes: 1024,
                deadline: Instant::now() + Duration::from_secs(1)
            }
        ),
        Err(ImportError::Budget(_, _))
    ));
    assert_eq!(
        original
            .query("SELECT id FROM actual_rows", &[])
            .unwrap()
            .rows
            .len(),
        2
    );
    fs::write(&f.database, b"changed original source").unwrap();
    assert!(matches!(
        original.query_with_budget(
            "SELECT private_missing_column",
            &[],
            QueryBudget {
                rows: 0,
                source_bytes: 0,
                deadline: Instant::now()
            }
        ),
        Err(ImportError::Refused(_, _))
    ));
}
