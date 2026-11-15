// examples/old_tables_retire.rs
//
// Purpose: The operator's step that retires the old engine's tables from an account's RecordBook file
// (`local_account::own_records::retire_old_tables`, DATA `retire` in src/storage/record_store_resources.json), with the
// account's app quit, and its proof: the tables dropped, the file's bytes before and after, the time it took and the
// file's integrity check afterwards. `erase` and `past-window` are the clone-only rest of the erasure proof: `erase`
// destroys the account's own records whose ids a file lists (`RecordStore::erase`, the product's erase: every version into
// custody), and `past-window` runs the record store exit step on every scope with history as a clock past the undo window
// would (every replaced version, tombstone and custody row leaves), then rewrites the file. A value of an erased
// record is then gone from the file's bytes only once its old-table copies are retired too.
//
// Non-Negotiable Invariants:
// - `retire` refuses until the account's one-time migration is finished, and drops nothing when the volume has no
//   room to rewrite the file. A state with a running app's ownership lock is refused: the app must be quit.
// - `erase` and `past-window` destroy records and all history at once: a CLONE only.
// - The output holds counts, bytes and timings only, never an id or a value.
//
// Security Considerations:
// - Nothing of a record is printed or written; the step only drops tables and rewrites the file.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage: old_tables_retire STATE RECORDBOOK_SQLITE (retire | objects | erase IDS_JSON | past-window)
// `objects` carries, then empties, the account's own old object files DATA `retire.objects` lists
// (own_records::retire_old_objects): every row of a table an own-records `copy` names that record store never held goes into the
// account's own records first, then all but `retire.objects_keep` is dropped. The files are matched to the account by
// the restore receipt's user and owner ids; another account's objects stay. Refused unless the migration's first
// Ready is inside the undo window.

use serde_json::json;
use std::{path::PathBuf, time::Instant};
use trillion_local::{
    local_account::own_records,
    sqlite_work::WorkMeter,
    storage::{
        record_store::{settings, Clock, RecordStore, RealClock},
        record_store_resources,
        sqlite::{self, Spend},
        Storage,
    },
};

type Failure = Box<dyn std::error::Error>;

/// The newest stamp a version can carry: the current row's `valid_to`.
const CURRENT: i64 = i64::MAX;

/// The system clock moved one day past the undo window.
struct PastWindow(u64);
impl Clock for PastWindow {
    fn now_ms(&self) -> i64 {
        RealClock.now_ms() + self.0 as i64
    }
}

fn main() -> Result<(), Failure> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [state, book, mode, rest @ ..] = args.as_slice() else {
        return Err("usage: old_tables_retire STATE RECORDBOOK_SQLITE (retire | objects | erase IDS_JSON | past-window)".into());
    };
    let state = PathBuf::from(state).canonicalize()?;
    if state.join("local-runtime.lock").exists() {
        return Err("the state has a runtime ownership lock; quit the app first".into());
    }
    let book = PathBuf::from(book).canonicalize()?;
    if !book.starts_with(&state) {
        return Err("the RecordBook is not in the state folder".into());
    }
    let started = Instant::now();
    let owner: String = rusqlite::Connection::open_with_flags(&book, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?
        .query_row("SELECT account FROM versions WHERE resource = 'own-records-position' LIMIT 1", [], |row| row.get(0))?;
    let report = match (mode.as_str(), rest) {
        ("retire", []) => {
            let retired = own_records::retire_old_tables(&book, &owner, WorkMeter::new()).map_err(|error| format!("{error:?}"))?;
            json!({"mode": "retire", "retired": retired})
        }
        ("erase", [ids]) => {
            let ids: Vec<String> = serde_json::from_slice(&std::fs::read(ids)?)?;
            let mut store = record_store_resources::open(&book, WorkMeter::new()).map_err(|error| format!("{error:?}"))?;
            let mut versions = 0u64;
            for id in &ids {
                let erased = store.erase(&owner, "own-records", id).map_err(|error| format!("{error:?}"))?;
                versions += erased.ok_or("an id to erase is not a record")?.versions;
            }
            json!({"mode": "erase", "records": ids.len(), "versions": versions})
        }
        ("past-window", []) => past_window(&book)?,
        ("objects", []) => {
            let receipt: serde_json::Value = serde_json::from_slice(&std::fs::read(state.join("restore-receipt.json"))?)?;
            let ids: Vec<&str> =
                ["userId", "ownerId"].iter().filter_map(|field| receipt["account"][field].as_str()).collect();
            // The refusal names its deadline: the moment the carry is allowed until, in milliseconds since 1970
            // (`date -r <seconds>` shows it in this Mac's time).
            let until = own_records::old_objects_carry_until(&record_store_resources::open(&book, WorkMeter::new()).map_err(|error| format!("{error:?}"))?, &owner)
                .map_err(|error| format!("{error:?}"))?;
            let deadline = until.map_or_else(|| "no moment yet: the migration is not finished (a declared copy has not run; start the engine once)".to_owned(), |ms| format!("{ms} ms since 1970"));
            let emptied = own_records::retire_old_objects(&state, &book, &owner, &ids, WorkMeter::new())
                .map_err(|error| format!("{error:?}; the carry is allowed until {deadline}"))?;
            json!({"mode": "objects", "carry_allowed_until_ms": until, "emptied": emptied})
        }
        _ => return Err("mode is retire, objects, erase IDS_JSON or past-window".into()),
    };
    let seconds = started.elapsed().as_secs_f64();
    let check: String =
        rusqlite::Connection::open_with_flags(&book, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    println!("{}", json!({"report": report, "seconds": seconds, "integrity_check": check, "bytes": std::fs::metadata(&book)?.len()}));
    Ok(())
}

/// Every scope with history, its exit steps run until none is left, as a clock past the undo window; then the file is
/// rewritten.
fn past_window(book: &PathBuf) -> Result<serde_json::Value, Failure> {
    let scopes: Vec<(String, String)> = {
        let db = rusqlite::Connection::open_with_flags(book, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut statement = db.prepare(
            "SELECT DISTINCT account, resource FROM versions WHERE valid_to IS NOT ?1
             UNION SELECT DISTINCT account, resource FROM versions WHERE valid_to IS ?1 AND deleted IS 1
             UNION SELECT DISTINCT account, resource FROM custody",
        )?;
        let rows = statement.query_map([CURRENT], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let window = settings::shipped().ok_or("record store settings")?.undo_windows.records + 24 * 60 * 60 * 1000;
    let bounds = sqlite::Bounds {
        value_bytes: 64 * 1024 * 1024,
        work: u64::MAX / 2,
        deadline: std::time::Duration::MAX,
        spend: Spend::EachOperation,
        cancel: None,
        busy: std::time::Duration::from_secs(5),
    };
    let supply = sqlite::open_owned(book, "record_store", bounds)?;
    let limits = record_store_resources::computer_limits(&supply, book).map_err(|error| format!("{error:?}"))?;
    let mut store = RecordStore::new(supply, Box::new(PastWindow(window)), limits).map_err(|error| format!("{error:?}"))?;
    let mut removed = 0u64;
    for (account, resource) in &scopes {
        loop {
            let step = store.retire(account, resource).map_err(|error| format!("{error:?}"))?;
            removed += step;
            if step == 0 {
                break;
            }
        }
    }
    store.storage().reclaim().map_err(|error| format!("{error:?}"))?;
    Ok(json!({"mode": "past-window", "scopes": scopes.len(), "rows_removed": removed}))
}
