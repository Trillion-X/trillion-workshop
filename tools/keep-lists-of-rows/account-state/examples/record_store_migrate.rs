// examples/record_store_migrate.rs
//
// Purpose: Run the one-way record store migration on a CLONE of a selected account state and print its proof.
// Invariants: never a live state (the caller passes a quiescent clone; a running owner's lock refuses it); the object is
// opened readonly in one read snapshot through the same reader the native account uses; the record store output is a new file that must not exist yet.
// Key concepts: `trillion_local::storage::record_store::{legacy, migrate, native}`.
// Security: stdout holds counts, digests and timings only; no id, value or key.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage: record_store_migrate STATE OBJECT_SQLITE_RELATIVE OUT_RECORD_STORE_SQLITE SAMPLES
// The new store runs with the shipped `native` host limits: the native record bound and a budget sized to the disk
// of OUT_RECORD_STORE_SQLITE.

use rusqlite::{types::Value, OpenFlags};
use serde_json::value::RawValue;
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
use trillion_local::{
    ecma_json::JsString,
    import::{ImportError, ImportResult, ReadLimits, SqlValue},
    legacy_kept::{
        range::{Cursor, RangeLimits, Request},
        Entry, LegacyKept, Limits,
    },
    legacy_records::{current_head::CanonicalHead, Bounds, LegacyRecords, StoredRecord},
    record_source::{BoundedRecordSql, SnapshotRecordSql},
    records::Error,
    sqlite_work::WorkMeter,
    storage::{
        record_store::{legacy::refused, migrate, native::RecordStoreCurrent, RecordStore},
        record_store_resources, Storage,
    },
};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [state, relative, out, samples] = args.as_slice() else {
        return Err("usage: record_store_migrate STATE OBJECT_SQLITE_RELATIVE OUT_RECORD_STORE_SQLITE SAMPLES".into());
    };
    let samples: usize = samples.parse()?;
    let state = std::fs::canonicalize(state)?;
    let out = PathBuf::from(out);
    // The record store supply refuses a path through a symbolic link, so name the real folder.
    let out = std::fs::canonicalize(out.parent().ok_or("output folder")?)?.join(out.file_name().ok_or("output name")?);
    if out.exists() {
        return Err("the record store output already exists; a migration writes a new store".into());
    }
    let receipt_path = state.join("restore-receipt.json");
    let receipt: serde_json::Value = serde_json::from_slice(&std::fs::read(&receipt_path)?)?;
    if state.join("local-runtime.lock").exists() {
        return Err("the state has a runtime ownership lock; migrate a quiescent clone".into());
    }
    let owner = receipt["account"]["ownerId"].as_str().ok_or("receipt account")?.to_owned();
    let limits = ReadLimits {
        rows: 4096,
        cell_bytes: 8 * 1024 * 1024,
        result_bytes: 32 * 1024 * 1024,
        vm_steps: 50_000_000,
        elapsed: Duration::from_secs(30),
        ..ReadLimits::default()
    };
    // The same reader the native account uses on its current file: a readonly handle in one read snapshot, whose
    // witness refuses any change to the file while the migration reads it.
    let path = state.join(relative);
    let seen = std::fs::metadata(&path)?;
    let witness = {
        let path = path.clone();
        move || -> ImportResult<()> {
            let now = std::fs::metadata(&path)?;
            if now.len() != seen.len() || now.modified()? != seen.modified()? {
                return Err(ImportError::Refused("the migrated source changed during the read", trillion_local::cause!()));
            }
            Ok(())
        }
    };
    let connection = rusqlite::Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    let original = SnapshotRecordSql::begin(connection, limits, witness, Arc::new(AtomicBool::new(false)))?;
    let kept = LegacyKept::new(Limits {
        statements: 65_536,
        rows: 131_072,
        source_bytes: 128 * 1024 * 1024,
        // The canonical reader's own per-record allowance (`Bounds::bytes` below), so no record it answers is refused here.
        value_bytes: 32 * 1024 * 1024,
        elapsed: Duration::from_secs(30),
        ..Limits::default()
    })
    .map_err(|_| "kept limits")?;
    // The range reader's largest allowances; a checkpoint page whose records do not fit is read again in halves.
    let ranges = RangeLimits { entries: 1_000_000, pages: 65_536, held_bytes: 64 * 1024 * 1024, output_bytes: 32 * 1024 * 1024 };
    // The largest per-read allowance the canonical reader accepts (it refuses more).
    let bounds = Bounds { statements: 4096, rows: 30_000, bytes: 32 * 1024 * 1024, elapsed: Duration::from_secs(30) };
    let mut new = RecordStoreCurrent::new(record_store_resources::open(&out, WorkMeter::new())?, &owner, "own-records");
    let mut old = OldEngine { kept: &kept, ranges, bounds, phase: Phase::Pages { source: original, cursor: None } };
    let report = migrate::migrate(&mut old, &mut new, samples, |read| {
        eprintln!("record_store_migrate: {read} checkpoint records read");
    })?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    if !report.proved() {
        return Err("the migration proof failed".into());
    }
    let workspace = copy_workspace(&path, &mut new.store, &owner)?;
    println!("{}", serde_json::to_string_pretty(&workspace)?);
    Ok(())
}

/// The workspace phase: every row of the old engine's `workspace_records` table (label -> JSON value text) becomes
/// version 1 of the record `label`, its value the same JSON text byte for byte, in the workspace store's record store resource (`trillion_local::workspace_store::resource`,
/// DATA in src/storage/families.json), then every record is read back and compared value for value.
fn copy_workspace<S: Storage + Send>(
    path: &std::path::Path,
    store: &mut RecordStore<S>,
    owner: &str,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let resource = trillion_local::workspace_store::resource().map_err(|_| "workspace resource DATA")?;
    let old = rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    let mut rows = Vec::new();
    let mut statement = old.prepare("SELECT label,value FROM main.workspace_records ORDER BY label")?;
    for row in statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))? {
        let (label, text) = row?;
        // The stored value is the exact original JSON text (key order kept); refuse a row that is not JSON.
        serde_json::from_str::<&serde_json::value::RawValue>(&text)?;
        rows.push((label, serde_json::Value::String(text)));
    }
    let mut copied = 0;
    for batch in rows.chunks(256) {
        copied += store.import(owner, resource, batch)?;
    }
    let mut matched = 0;
    for batch in rows.chunks(256) {
        let ids: Vec<&str> = batch.iter().map(|(label, _)| label.as_str()).collect();
        for ((_, value), held) in batch.iter().zip(store.get_many(owner, resource, &ids)?) {
            if held.is_some_and(|record| &record.value == value) {
                matched += 1;
            }
        }
    }
    if copied != rows.len() || matched != rows.len() {
        return Err("the workspace phase proof failed".into());
    }
    Ok(serde_json::json!({ "workspace": { "rows": rows.len(), "copied": copied, "read_back_equal": matched } }))
}

/// The old engine as the migration reads it (`migrate::Source`): its checkpoint pages and journal tail read through
/// the kept-run readers on the pinned snapshot, then, once the checkpoint is read, its canonical reader over the same
/// snapshot (the reader takes the snapshot over, so the phases run in that order). This is the only place the
/// migration reads the old engine's tables; the record store itself holds no SQL.
enum Phase<S: BoundedRecordSql> {
    Pages { source: S, cursor: Option<Cursor> },
    Canonical(Box<LegacyRecords<S>>),
    /// Only between phases; a refused change of phase leaves the source unusable.
    Moving,
}
struct OldEngine<'a, S: BoundedRecordSql> {
    kept: &'a LegacyKept,
    ranges: RangeLimits,
    bounds: Bounds,
    phase: Phase<S>,
}
impl<S: BoundedRecordSql> OldEngine<'_, S> {
    fn pages(&mut self) -> Result<(&mut S, &mut Option<Cursor>), Error> {
        match &mut self.phase {
            Phase::Pages { source, cursor } => Ok((source, cursor)),
            _ => Err(Error::Invalid("the checkpoint is read before the canonical replay", trillion_local::cause!())),
        }
    }
}
impl<S: BoundedRecordSql> migrate::Source for OldEngine<'_, S> {
    /// The ids the journal changed after the checkpoint covers them (`record_keys_meta.covered.at`): their checkpoint
    /// value may be stale, so the canonical reader (`read_stored`, which replays that tail) answers them. Each journal
    /// row's envelopes name the records it changes (`CanonicalHead::affected_ids`, the existing decoder).
    fn tail(&mut self) -> Result<(BTreeSet<String>, u64), Error> {
        let (source, _) = self.pages()?;
        let unavailable = |_| trillion_local::cause!(Error::Unavailable);
        let covered = source
            .query("SELECT value FROM record_keys_meta WHERE key=? LIMIT 1", &[Value::Text("covered".into())])
            .map_err(unavailable)?;
        let covered = match covered.rows.first().and_then(|row| row.first()) {
            Some(SqlValue::Text(text)) => {
                let value: serde_json::Value = serde_json::from_slice(text).map_err(|_| trillion_local::cause!(Error::Unavailable))?;
                value.get("at").unwrap_or(&value).as_i64().unwrap_or(0)
            }
            _ => 0,
        };
        let mut ids = BTreeSet::new();
        let mut after = covered;
        let mut rows = 0;
        loop {
            let page = source
                .query(
                    "SELECT rowid,parts,envelopes FROM record_log WHERE rowid>? ORDER BY rowid LIMIT 256",
                    &[Value::Integer(after)],
                )
                .map_err(unavailable)?;
            if page.rows.is_empty() {
                return Ok((ids, rows));
            }
            for row in &page.rows {
                let (Some(SqlValue::Integer(rowid)), Some(SqlValue::Integer(parts)), Some(SqlValue::Text(envelopes))) =
                    (row.first(), row.get(1), row.get(2))
                else {
                    return Err(trillion_local::cause!(Error::Unavailable));
                };
                if *parts != 1 {
                    // A multipart transaction spans rows; the canonical reader assembles it. Refuse rather than guess.
                    return Err(Error::Invalid("a multipart journal row past the checkpoint needs the canonical replay", trillion_local::cause!()));
                }
                let body = std::str::from_utf8(envelopes).map_err(|_| trillion_local::cause!(Error::Unavailable))?;
                ids.extend(CanonicalHead::affected_ids(body).map_err(refused)?);
                after = *rowid;
                rows += 1;
            }
        }
    }

    /// One page of at most `limit` of the checkpoint's current records (`i\0<id>` keys, newest run wins), decoded into
    /// stored forms exactly as the canonical reader's checkpoint step does (`legacy_records::checkpoint`): the pointer
    /// array is `[type, sequence, value?, meta?, protected?]`; a value kept apart is the `r\0<type>\0<sequence>\0<id>`
    /// key; a null type or a tombstone is no record. Ids the journal tail changed (`tail`) still need the canonical
    /// reader. The cursor moves only when the whole page decoded.
    fn checkpoint_page(&mut self, limit: usize) -> Result<migrate::Page, Error> {
        let (kept, ranges) = (self.kept, self.ranges);
        let (source, cursor) = self.pages()?;
        let (lo, hi) = (JsString::from("i\0"), JsString::from("i\u{1}"));
        let request = Request { lo: &lo, hi: &hi, reverse: false, keys_only: false, limit, cursor: cursor.as_ref() };
        let page = kept.range(source, request, ranges).map_err(|error| Error::Invalid(error.reason, trillion_local::cause!()))?;
        let mut work = page.work.clone();
        let mut records = Vec::with_capacity(page.items.len());
        for item in &page.items {
            let id = item.key.strip_prefix("i\0").ok_or(trillion_local::cause!(Error::Unavailable))?;
            let Some(raw) = &item.value else { continue };
            let pointer: Vec<&RawValue> = serde_json::from_str(raw).map_err(|_| trillion_local::cause!(Error::Unavailable))?;
            if !(2..=5).contains(&pointer.len()) {
                return Err(Error::Invalid("checkpoint pointer has an unexpected shape", trillion_local::cause!()));
            }
            if pointer[0].get() == "null" {
                continue;
            }
            let record_type: String = serde_json::from_str(pointer[0].get()).map_err(|_| trillion_local::cause!(Error::Unavailable))?;
            let sequence: String = serde_json::from_str(pointer[1].get()).map_err(|_| trillion_local::cause!(Error::Unavailable))?;
            let meta_json = pointer.get(3).filter(|raw| raw.get() != "null").map(|raw| raw.get().to_owned());
            let protected_key_present = pointer.get(4).is_some_and(|raw| raw.get() != "null");
            let value_json = if pointer.len() >= 3 {
                pointer[2].get().to_owned()
            } else {
                let point = kept
                    .point(source, &format!("r\0{record_type}\0{sequence}\0{id}"))
                    .map_err(|error| Error::Invalid(error.reason, trillion_local::cause!()))?;
                work.sql_statements += point.work.sql_statements;
                work.rows_returned += point.work.rows_returned;
                work.source_bytes += point.work.source_bytes;
                match point.entry {
                    Entry::Json(text) => text,
                    Entry::Absent | Entry::Tombstone => continue,
                }
            };
            records.push(StoredRecord { id: id.to_owned(), record_type, sequence, value_json, meta_json, protected_key_present });
        }
        let more = page.next.is_some();
        *cursor = page.next;
        let work = migrate::PageWork { statements: work.sql_statements, rows: work.rows_returned, bytes: work.source_bytes };
        Ok(migrate::Page { records, work, more })
    }

    /// The canonical reader's answer; the first call hands the snapshot over to it.
    fn canonical(&mut self, id: &str) -> Result<Option<StoredRecord>, Error> {
        if matches!(self.phase, Phase::Pages { .. }) {
            let Phase::Pages { source, .. } = std::mem::replace(&mut self.phase, Phase::Moving) else {
                return Err(trillion_local::cause!(Error::Unavailable));
            };
            self.phase = Phase::Canonical(Box::new(LegacyRecords::open_source(source, self.bounds.clone()).map_err(refused)?));
        }
        match &mut self.phase {
            Phase::Canonical(records) => records.read_stored(id, self.kept).map_err(refused),
            _ => Err(trillion_local::cause!(Error::Unavailable)),
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("record_store_migrate refused: {error}");
        std::process::exit(1);
    }
}
