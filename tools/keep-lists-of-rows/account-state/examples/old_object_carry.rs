// examples/old_object_carry.rs
//
// Purpose: The one-time carry of an account's records that live only in another of its old object files (an old
// PersonWork journal, for instance) into its own record store records, before that file's tables are retired. For each record
// id asked, the old engine's canonical reader (`LegacyRecords::read_stored`, the same reader the own-records
// migration uses, journal tail and multipart rows included) answers the record in the object file, and the answer
// becomes the record's first version in the account's own records (`migrate::absorb`); every written record is then
// read back and compared by its digest.
//
// Non-Negotiable Invariants:
// - A CLONE only, with the app quit: a state whose state lock is held is refused.
// - Only ids the account's own records never held are carried. An id record store holds or ever held (a version or a
//   tombstone) is refused before anything is written, so a carry never replaces newer data.
// - A sealed record (its field key present in the old engine) is not carried here; it is counted, since its key has
//   its own carry (own-record-keys).
// - The output holds counts only, never an id or a value.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage: old_object_carry STATE RECORDBOOK_SQLITE OBJECT_SQLITE IDS_JSON

use rusqlite::OpenFlags;
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
use trillion_local::{
    import::{ImportError, ImportResult, ReadLimits},
    legacy_kept::{LegacyKept, Limits},
    legacy_records::{Bounds, LegacyRecords},
    record_source::SnapshotRecordSql,
    sqlite_work::WorkMeter,
    storage::{
        record_store::{
            migrate::{self, Absorbed},
            native::{CurrentRecords, RecordStoreCurrent},
        },
        record_store_resources,
    },
};

const RESOURCE: &str = "own-records";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [state, book, object, ids] = args.as_slice() else {
        return Err("usage: old_object_carry STATE RECORDBOOK_SQLITE OBJECT_SQLITE IDS_JSON".into());
    };
    let state = PathBuf::from(state).canonicalize()?;
    if state.join("local-runtime.lock").exists() {
        return Err("the state has a runtime ownership lock; carry on a quiescent clone".into());
    }
    let (book, object) = (PathBuf::from(book).canonicalize()?, PathBuf::from(object).canonicalize()?);
    if !book.starts_with(&state) || !object.starts_with(&state) {
        return Err("both files must be in the state folder".into());
    }
    let ids: Vec<String> = serde_json::from_slice(&std::fs::read(ids)?)?;
    let owner: String = rusqlite::Connection::open_with_flags(&book, OpenFlags::SQLITE_OPEN_READ_ONLY)?
        .query_row("SELECT account FROM versions WHERE resource = 'own-records-position' LIMIT 1", [], |row| row.get(0))?;

    // Refuse before writing anything when record store ever held one of the ids.
    {
        let db = rusqlite::Connection::open_with_flags(&book, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut held = db.prepare("SELECT 1 FROM versions WHERE account = ?1 AND resource = ?2 AND id = ?3 LIMIT 1")?;
        let mut custody = db.prepare("SELECT 1 FROM custody WHERE account = ?1 AND resource = ?2 AND id = ?3 LIMIT 1")?;
        for id in &ids {
            if held.exists((&owner, RESOURCE, id))? || custody.exists((&owner, RESOURCE, id))? {
                return Err("an id to carry is one the account's own records hold or held; nothing was written".into());
            }
        }
    }

    // The object file read the way the native account reads its current file: one read snapshot, witnessed.
    let limits = ReadLimits {
        rows: 4096,
        cell_bytes: 8 * 1024 * 1024,
        result_bytes: 32 * 1024 * 1024,
        vm_steps: 50_000_000,
        elapsed: Duration::from_secs(30),
        ..ReadLimits::default()
    };
    let seen = std::fs::metadata(&object)?;
    let witness = {
        let object = object.clone();
        move || -> ImportResult<()> {
            let now = std::fs::metadata(&object)?;
            if now.len() != seen.len() || now.modified()? != seen.modified()? {
                return Err(ImportError::Refused("the object file changed during the read", trillion_local::cause!()));
            }
            Ok(())
        }
    };
    let connection = rusqlite::Connection::open_with_flags(&object, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    let source = SnapshotRecordSql::begin(connection, limits, witness, Arc::new(AtomicBool::new(false)))?;
    let kept = LegacyKept::new(Limits {
        statements: 65_536,
        rows: 131_072,
        source_bytes: 128 * 1024 * 1024,
        value_bytes: 32 * 1024 * 1024,
        // An old object's journal may have more key runs than the default 64 (a PersonWork had 122); the reader's
        // own bound is 4096.
        runs: 4096,
        elapsed: Duration::from_secs(30),
        ..Limits::default()
    })
    .map_err(|_| "kept limits")?;
    let bounds = Bounds { statements: 4096, rows: 30_000, bytes: 32 * 1024 * 1024, elapsed: Duration::from_secs(30) };
    let mut old = LegacyRecords::open_source(source, bounds).map_err(|error| format!("the old reader did not open the object file: {error:?}"))?;
    let mut own = RecordStoreCurrent::new(record_store_resources::open(&book, WorkMeter::new())?, &owner, RESOURCE);

    let (mut absent, mut sealed, mut created, mut matched) = (0u64, 0u64, 0u64, 0u64);
    for id in &ids {
        let read = old.read_stored(id, &kept).map_err(|error| {
            // The reader's own stage and reason words name where it refused; they hold no id or value.
            let at = old.last_read_diagnostic().map(|diagnostic| format!(" at {} ({})", diagnostic.stage, diagnostic.reason));
            format!("the old reader refused: {error:?}{}", at.unwrap_or_default())
        })?;
        let Some(record) = read else {
            absent += 1;
            continue;
        };
        if record.protected_key_present {
            sealed += 1;
            continue;
        }
        match migrate::absorb(&mut own, id, Some(&record), format!("old-object-carry-{id}"))? {
            Absorbed::Created => created += 1,
            _ => return Err("a carried id was held after all; stopped".into()),
        }
        if own.stored(id)?.is_some_and(|back| migrate::digest(&back) == migrate::digest(&record)) {
            matched += 1;
        }
    }
    println!("{}", json!({ "asked": ids.len(), "absent_in_object": absent, "sealed_not_carried": sealed, "created": created, "read_back_equal": matched }));
    if matched != created {
        return Err("a carried record reads back different".into());
    }
    Ok(())
}
