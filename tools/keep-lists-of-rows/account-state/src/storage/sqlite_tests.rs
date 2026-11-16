//! Scenarios of the SQLite supply (the owner's tests). Each one states its verdict through the shared harness.

use super::*;
use crate::storage::{Error, Intent, Scope, Value, When};
use std::time::Duration;

/// Incident 12 (the Mac disk filled to 100%): a write into a file whose volume has no room left (SQLite's page limit
/// reached: SQLITE_FULL) must be reported as a full disk, so its owner can keep its space and say why. Reported as
/// `Unavailable` it reads as a broken store.
fn full_disk_write_is_reported_as_full_not_unavailable_body() -> std::result::Result<(), String> {
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let path = std::fs::canonicalize(dir.path()).map_err(|error| error.to_string())?.join("full.sqlite");
    let prefill = rusqlite::Connection::open(&path).map_err(|error| error.to_string())?;
    prefill
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)")
        .map_err(|error| error.to_string())?;
    drop(prefill);
    let bounds = Bounds { value_bytes: 1 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::WholeHandle, cancel: None, busy: Duration::ZERO };
    let store = open_selected(&path, "account_policy", Selected { access: Access::Write, bounds, meter: None, trusted_schema: false })
        .map_err(|error| format!("the file did not open: {error:?}"))?;
    let pages: i64 = store.db().query_row("PRAGMA page_count", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    store.db().execute_batch(&format!("PRAGMA max_page_count={pages}")).map_err(|error| error.to_string())?;
    let tx = Scope::begin(&store, Intent::Write).map_err(|error| format!("the write scope did not begin: {error:?}"))?;
    let big = "x".repeat(300_000);
    let outcome = tx
        .put("policy_directory", &[("name", Value::Text("too-big-for-the-disk".into())), ("value", Value::Text(big))], When::New)
        .and_then(|_| tx.commit());
    match outcome {
        Ok(()) => Err("the write fit a file whose page limit was already reached".into()),
        Err(Error::Unavailable(_)) => Err("a full disk is reported as Unavailable, which reads as a broken store".into()),
        Err(_) => Ok(()),
    }
}

#[test]
fn full_disk_write_is_reported_as_full_not_unavailable() {
    crate::simulation::verdict("full-disk-write-is-reported-as-full-not-unavailable", full_disk_write_is_reported_as_full_not_unavailable_body);
}

/// Incident 3 (power loss on the Mac; lane exports in /private/tmp wiped): a file the engine makes is synced with
/// `synchronous=FULL` before its first record is acknowledged, and a store placed under a temporary root is refused, so
/// nothing a power cut clears can hold a record.
fn power_cut_keeps_acknowledged_rows_and_refuses_a_temporary_root_body() -> std::result::Result<(), String> {
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let path = std::fs::canonicalize(dir.path()).map_err(|error| error.to_string())?.join("made.sqlite");
    let store = open_owned(&path, "record_store", Bounds { value_bytes: 1 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::ZERO })
        .map_err(|error| format!("the file did not open: {error:?}"))?;
    let sync: i64 = store.db().query_row("PRAGMA synchronous", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if sync != 2 {
        return Err(format!("the file's connection is synchronous={sync}, not FULL (2): an acknowledged row can be lost"));
    }
    let temporary = std::path::Path::new("/private/tmp/sim-scenario-temporary-root/records.sqlite");
    if crate::storage::record_store_resources::open(temporary, crate::sqlite_work::WorkMeter::new()).is_ok() {
        return Err("a placement file under /private/tmp opened: a power cut clears it".into());
    }
    Ok(())
}

#[test]
fn power_cut_keeps_acknowledged_rows_and_refuses_a_temporary_root() {
    crate::simulation::verdict("power-cut-keeps-acknowledged-rows-drops-unsynced", power_cut_keeps_acknowledged_rows_and_refuses_a_temporary_root_body);
}

// ---- incident 3 (power cut): an acknowledged commit is on disk at the moment of the acknowledgement ----

/// Incident 3: a commit the store has acknowledged must survive a power cut at that instant. The cut is modelled by copying
/// the file and its log exactly as they are when the commit returns (nothing after the acknowledgement is copied) and
/// reopening the copy: the acknowledged row must read back.
fn acknowledged_commit_survives_a_power_cut_at_its_acknowledgement_body() -> std::result::Result<(), String> {
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let path = std::fs::canonicalize(dir.path()).map_err(|error| error.to_string())?.join("acked.sqlite");
    let make = || Bounds { value_bytes: 1 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::WholeHandle, cancel: None, busy: Duration::ZERO };
    let prefill = rusqlite::Connection::open(&path).map_err(|error| error.to_string())?;
    prefill
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)")
        .map_err(|error| error.to_string())?;
    drop(prefill);
    let store = open_selected(&path, "account_policy", Selected { access: Access::Write, bounds: make(), meter: None, trusted_schema: false })
        .map_err(|error| format!("the file did not open: {error:?}"))?;
    let tx = Scope::begin(&store, Intent::Write).map_err(|error| format!("{error:?}"))?;
    tx.put("policy_directory", &[("name", Value::Text("acked".into())), ("value", Value::Text("durable".into()))], When::New)
        .and_then(|_| tx.commit())
        .map_err(|error| format!("the commit was not acknowledged: {error:?}"))?;
    let cut = tempfile::tempdir().map_err(|error| error.to_string())?;
    let copy = cut.path().join("acked.sqlite");
    std::fs::copy(&path, &copy).map_err(|error| error.to_string())?;
    let wal = std::path::PathBuf::from(format!("{}-wal", path.display()));
    if wal.exists() {
        std::fs::copy(&wal, format!("{}-wal", copy.display())).map_err(|error| error.to_string())?;
    }
    let reopened = rusqlite::Connection::open(&copy).map_err(|error| error.to_string())?;
    let value: String = reopened
        .query_row("SELECT value FROM policy_directory WHERE name = 'acked'", [], |row| row.get(0))
        .map_err(|error| format!("the acknowledged row is gone after the cut: {error}"))?;
    if value == "durable" { Ok(()) } else { Err(format!("the acknowledged row reads {value:?}")) }
}

#[cfg(test)]
mod power_cut_scenario_tests {
    use super::*;

    #[test]
    fn acknowledged_commit_survives_a_power_cut_at_its_acknowledgement() {
        crate::simulation::verdict("power-cut-keeps-acknowledged-rows-drops-unsynced", acknowledged_commit_survives_a_power_cut_at_its_acknowledgement_body);
    }
}

// ---- incident 3, seeded mid-commit power cut: a cut inside a commit's log frames loses that commit and nothing acknowledged ----

/// Writes one committed row into `path` with the owner's connection settings, and answers the file size after it.
fn commit_row(path: &std::path::Path, name: &str) -> std::result::Result<u64, String> {
    let bounds = Bounds { value_bytes: 1 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::WholeHandle, cancel: None, busy: Duration::ZERO };
    let store = open_selected(path, "account_policy", Selected { access: Access::Write, bounds, meter: None, trusted_schema: false })
        .map_err(|error| format!("open: {error:?}"))?;
    let tx = Scope::begin(&store, Intent::Write).map_err(|error| format!("{error:?}"))?;
    tx.put("policy_directory", &[("name", Value::Text(name.into())), ("value", Value::Text("v".repeat(6_000)))], When::New)
        .and_then(|_| tx.commit())
        .map_err(|error| format!("commit {name}: {error:?}"))?;
    drop(store);
    let wal = std::path::PathBuf::from(format!("{}-wal", path.display()));
    Ok(std::fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0))
}

/// Incident 3 (seeded): a power cut in the middle of the second commit's log frames is modelled by cutting the log at a
/// seeded byte inside those frames. The first commit was acknowledged and must read back; the second was not acknowledged
/// in full and must be absent, not half-applied. A cut after the last frame keeps both.
fn mid_commit_power_cut_keeps_acknowledged_rows_and_drops_the_unacknowledged_body() -> std::result::Result<(), String> {
    let mut world = crate::simulation::World::new(3);
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let path = std::fs::canonicalize(dir.path()).map_err(|error| error.to_string())?.join("cut.sqlite");
    let prefill = rusqlite::Connection::open(&path).map_err(|error| error.to_string())?;
    prefill.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)").map_err(|error| error.to_string())?;
    drop(prefill);
    let wal = std::path::PathBuf::from(format!("{}-wal", path.display()));
    let _first_end = commit_row(&path, "acked-first")?;
    let before = std::fs::read(&wal).map_err(|error| error.to_string())?;
    let after_second = commit_row(&path, "acked-second")?;
    let log = std::fs::read(&wal).map_err(|error| error.to_string())?;
    let db_bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    // The WAL header's page size is a big-endian u32 at byte 8 (a stored 1 means 65536).
    let stored = u32::from_be_bytes([log[8], log[9], log[10], log[11]]) as usize;
    let page_size = if stored == 1 { 65_536 } else { stored };
    let frame = 24 + page_size;
    let second_frames_start = before.len();
    let second_frames = (after_second as usize).saturating_sub(second_frames_start) / frame;
    if second_frames < 2 {
        return Err(format!("the second commit wrote {second_frames} frame(s): nothing to cut inside"));
    }
    let frame_index = world.random(0, second_frames as i64 - 2) as usize;
    let cut_at = second_frames_start + frame_index * frame + world.random(1, frame as i64 - 1) as usize;
    let cut_dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let cut_db = cut_dir.path().join("cut.sqlite");
    std::fs::write(&cut_db, &db_bytes).map_err(|error| error.to_string())?;
    std::fs::write(format!("{}-wal", cut_db.display()), &log[..cut_at]).map_err(|error| error.to_string())?;
    let reopened = rusqlite::Connection::open(&cut_db).map_err(|error| error.to_string())?;
    let count = |name: &str| -> std::result::Result<i64, String> {
        reopened.query_row("SELECT count(*) FROM policy_directory WHERE name = ?1", [name], |row| row.get(0)).map_err(|error| error.to_string())
    };
    if count("acked-first")? != 1 {
        return Err(format!("the acknowledged first commit is gone after a cut at byte {cut_at}"));
    }
    if count("acked-second")? != 0 {
        return Err(format!("the unacknowledged second commit is half-applied after a cut at byte {cut_at}"));
    }
    Ok(())
}

#[cfg(test)]
mod mid_commit_scenario_tests {
    use super::*;

    #[test]
    fn mid_commit_power_cut_keeps_acknowledged_rows() {
        crate::simulation::verdict("mid-commit-power-cut-keeps-acknowledged-rows", mid_commit_power_cut_keeps_acknowledged_rows_and_drops_the_unacknowledged_body);
    }
}

// ---- r5 (1): every store the sqlite supply opens for writing runs synchronous=FULL, so a committed transaction survives power loss ----

/// A store opened through the selected-write path (the path account files and the wake use, not only `open_owned`) must
/// report `synchronous=FULL` on its connection. NORMAL in WAL can lose a committed transaction on power loss.
fn every_writing_store_is_synchronous_full_body() -> std::result::Result<(), String> {
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let path = std::fs::canonicalize(dir.path()).map_err(|error| error.to_string())?.join("selected.sqlite");
    let prefill = rusqlite::Connection::open(&path).map_err(|error| error.to_string())?;
    prefill.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)").map_err(|error| error.to_string())?;
    drop(prefill);
    let bounds = Bounds { value_bytes: 1 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::WholeHandle, cancel: None, busy: Duration::ZERO };
    let store = open_selected(&path, "account_policy", Selected { access: Access::Write, bounds, meter: None, trusted_schema: false })
        .map_err(|error| format!("the selected write store did not open: {error:?}"))?;
    let sync: i64 = store.db().query_row("PRAGMA synchronous", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if sync == 2 { Ok(()) } else { Err(format!("the selected write store runs synchronous={sync}; a committed transaction can be lost on power loss")) }
}

#[test]
fn every_writing_store_is_synchronous_full() {
    crate::simulation::verdict("every-writing-store-is-synchronous-full", every_writing_store_is_synchronous_full_body);
}

/// Incident 2026-11-12 (hel1, account 0123456789abcdef): a joining computer holds its account's files but none of its store
/// folders, so catching up from the writer failed on every store (`catch-up-failed`, the store file had no folder to
/// open in). A store file opens in a folder that does not exist yet: the folder is made, private to the engine's user.
fn a_store_opens_in_a_folder_not_made_yet_body() -> std::result::Result<(), String> {
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let path = std::fs::canonicalize(dir.path()).map_err(|error| error.to_string())?.join("storage/do/trillion-local-RecordBook");
    open_owned(&path, "record_store", Bounds { value_bytes: 1 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::ZERO })
        .map_err(|error| format!("the store did not open in its missing folder: {error:?}"))?;
    if !path.parent().is_some_and(|folder| folder.is_dir()) {
        return Err("the store's folder was not made".into());
    }
    Ok(())
}

#[test]
fn a_store_opens_in_a_folder_not_made_yet() {
    crate::simulation::verdict("a-store-opens-in-a-folder-not-made-yet", a_store_opens_in_a_folder_not_made_yet_body);
}

/// The SQLite code of a store that cannot open travels in its cause: the cause names `CannotOpen` (SQLITE_CANTOPEN), not
/// only the caller that mapped it to `Unavailable` (the lossy `_ =>` arm of `failure`).
fn a_store_that_cannot_open_keeps_its_sqlite_code_body() -> std::result::Result<(), String> {
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let path = std::fs::canonicalize(dir.path()).map_err(|error| error.to_string())?;
    let bounds = Bounds { value_bytes: 1 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::ZERO };
    match open_owned(&path, "record_store", bounds) {
        Ok(_) => Err("a folder opened as a store file".into()),
        Err(error) => {
            let text = format!("{error:?}");
            if text.contains("CannotOpen (extended 14)") {
                Ok(())
            } else {
                Err(format!("the SQLite code was dropped from the cause: {text}"))
            }
        }
    }
}

#[test]
fn a_store_that_cannot_open_keeps_its_sqlite_code() {
    crate::simulation::verdict("a-store-that-cannot-open-keeps-its-sqlite-code", a_store_that_cannot_open_keeps_its_sqlite_code_body);
}
