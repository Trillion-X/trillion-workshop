// src/storage/record_store/reclaim_tests.rs
//
// Purpose: The erasure model on a SQLite file: a destroyed record leaves custody only on a handle whose removals
// overwrite the removed bytes (`secure_delete`), so its value is gone from the file's bytes as the exit step
// commits, and the space then goes back to the volume in bounded steps (`RecordStore::reclaim_step`, incremental auto-vacuum)
// with the file free between steps, never as a rewrite on a write.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{settings, Clock, Reclaim, RecordStore, RealClock, VacuumStep};
use crate::{
    records::{Mutation, Records},
    storage::{
        sqlite::{self, Access, Bounds, Spend},
        Storage,
    },
};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const ACCOUNT: &str = "account";
const RESOURCE: &str = "notes";
const MARKER: &str = "a-destroyed-value-Zq7";

/// The system clock moved one day past the undo window.
struct PastWindow;
impl Clock for PastWindow {
    fn now_ms(&self) -> i64 {
        RealClock.now_ms() + settings::shipped().unwrap().undo_windows.records as i64 + 24 * 60 * 60 * 1000
    }
}

fn bounds() -> Bounds {
    Bounds { value_bytes: 64 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(5) }
}

fn store(path: &Path, clock: Box<dyn Clock>) -> RecordStore<sqlite::Supply<sqlite::Connection>> {
    let limits = settings::Limits::fixed(1 << 20, 10 << 30);
    RecordStore::new(sqlite::open_owned(path, "record_store", bounds()).unwrap(), clock, limits).unwrap()
}

/// A new owned file holding `records` records of about 8 KiB each, every one carrying `MARKER`, all destroyed
/// (`RecordStore::erase`: their versions are in custody).
fn destroyed(records: usize) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("notes.sqlite");
    let mut writer = store(&path, Box::new(RealClock));
    let filler = format!("{MARKER} {}", "x".repeat(8000));
    for n in 0..records {
        let write = Mutation { id: format!("n{n:04}"), expected_version: 0, request_key: format!("w{n}"), deleted: false, value: serde_json::json!({ "text": filler }) };
        writer.mutate(ACCOUNT, RESOURCE, write).unwrap();
    }
    for n in 0..records {
        writer.erase(ACCOUNT, RESOURCE, &format!("n{n:04}")).unwrap().unwrap();
    }
    (dir, path)
}

fn holds(path: &Path, marker: &str) -> bool {
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    [std::fs::read(path).unwrap(), std::fs::read(PathBuf::from(wal)).unwrap_or_default()]
        .iter()
        .any(|bytes| bytes.windows(marker.len()).any(|window| window == marker.as_bytes()))
}

fn custody_rows(path: &Path) -> i64 {
    rusqlite::Connection::open(path).unwrap().query_row("SELECT count(*) FROM custody", [], |row| row.get(0)).unwrap()
}

/// Every exit step the window has released, until none is left.
fn exit_all<S: Storage>(store: &mut RecordStore<S>) {
    while store.retire(ACCOUNT, RESOURCE).unwrap() > 0 {}
}

#[test]
fn a_new_owned_file_gives_space_back_in_steps() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("notes.sqlite");
    drop(store(&path, Box::new(RealClock)));
    let mode: i64 = rusqlite::Connection::open(&path).unwrap().query_row("PRAGMA auto_vacuum", [], |row| row.get(0)).unwrap();
    assert_eq!(mode, 2, "incremental");
}

#[test]
fn a_destroyed_records_bytes_leave_the_file_at_its_exit_and_its_space_comes_back_in_bounded_steps() {
    let (_dir, path) = destroyed(1200);
    assert!(holds(&path, MARKER));
    let size = std::fs::metadata(&path).unwrap().len();
    let mut later = store(&path, Box::new(PastWindow));
    exit_all(&mut later);
    assert_eq!(custody_rows(&path), 0);
    // The exit step committed nothing but removals, and no rewrite ran: the file is as large as before, yet with
    // secure_delete the destroyed values are gone from it once the WAL holding the old page images is reset.
    let first = later.reclaim_step().unwrap().left();
    assert!(first > 0, "free pages are left for later steps");
    let pages = settings::shipped().unwrap().reclaim_step_pages;
    let (mut left, mut steps, mut longest) = (first, 1, Duration::ZERO);
    while left > 0 {
        // Between steps the file is free: another writer begins at once, with no busy wait.
        let other = rusqlite::Connection::open(&path).unwrap();
        other.busy_timeout(Duration::ZERO).unwrap();
        other.execute_batch("BEGIN IMMEDIATE; ROLLBACK;").unwrap();
        drop(other);
        let started = Instant::now();
        let next = later.reclaim_step().unwrap().left();
        longest = longest.max(started.elapsed());
        assert!(left - next <= pages, "one step gives back at most reclaim_step_pages");
        left = next;
        steps += 1;
    }
    assert!(steps > 1, "the space came back in more than one step");
    assert!(longest < Duration::from_secs(1), "one step took {longest:?}");
    // The log beside the file is cleared beside the store, never in a step: copied, then reset. The steps'
    // truncations reach the file as the copy puts their pages in it.
    let log = sqlite::LogKeeper::open(&path).unwrap();
    assert!(log.copy().unwrap(), "nothing is left uncopied");
    assert!(log.reset().unwrap(), "the log is empty");
    assert!(std::fs::metadata(&path).unwrap().len() < size / 4, "the space went back to the volume");
    assert!(!holds(&path, MARKER), "a destroyed value is still in the file's bytes");
}

#[test]
fn the_log_is_copied_while_a_writer_holds_the_file_and_reset_only_after_a_copy_no_commit_came_after() {
    let (_dir, path) = destroyed(200);
    let mut later = store(&path, Box::new(PastWindow));
    exit_all(&mut later);
    while later.reclaim_step().unwrap().left() > 0 {}
    assert!(holds(&path, MARKER), "the log still holds the removed pages' earlier images");
    let log = sqlite::LogKeeper::open(&path).unwrap();
    assert!(!log.reset().unwrap(), "no reset before a copy");
    // A writer that never waits holds the write lock through the whole copy and commits after it. It copies nothing
    // itself (no automatic checkpoint), so its commit's pages stay in the log alone.
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.busy_timeout(Duration::ZERO).unwrap();
    writer.execute_batch("PRAGMA wal_autocheckpoint=0").unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert!(log.copy().unwrap(), "the copy takes no lock the writer holds");
    writer.execute_batch("CREATE TABLE written_during_the_copy(x); COMMIT").unwrap();
    assert!(!log.reset().unwrap(), "a commit came after the copy");
    assert!(holds(&path, MARKER));
    // A reader that began while the log held pages not yet in the file reads them from the log, and keeps it: the
    // reset neither waits for it nor empties the log under it. (A reader that begins once every page is copied
    // reads the file alone, and keeps nothing.)
    let reader = rusqlite::Connection::open(&path).unwrap();
    reader.execute_batch("BEGIN; SELECT count(*) FROM written_during_the_copy;").unwrap();
    assert!(log.copy().unwrap(), "the reader reads the newest state, so every log page can be copied");
    let started = Instant::now();
    assert!(!log.reset().unwrap(), "a reader is on the log");
    assert!(started.elapsed() < Duration::from_secs(1), "the reset waited {:?}", started.elapsed());
    reader.execute_batch("COMMIT").unwrap();
    assert!(log.copy().unwrap());
    assert!(log.reset().unwrap());
    assert!(!holds(&path, MARKER), "a destroyed value is still in the file's bytes");
    assert_eq!(std::fs::metadata(format!("{}-wal", path.display())).map(|meta| meta.len()).unwrap_or(0), 0);
}

#[test]
fn a_handle_that_does_not_overwrite_removed_bytes_keeps_a_destroyed_record_in_custody() {
    let (_dir, path) = destroyed(4);
    // A lent handle whose owner left secure_delete off (the supply never changes a lent handle's pragmas).
    let lent = rusqlite::Connection::open(&path).unwrap();
    lent.execute_batch("PRAGMA secure_delete=OFF;").unwrap();
    let limits = settings::Limits::fixed(1 << 20, 10 << 30);
    let mut on_lent = RecordStore::new(sqlite::lend(&lent, "record_store", Access::Write).unwrap(), Box::new(PastWindow), limits).unwrap();
    assert!(!on_lent.storage().overwrites_removed().unwrap());
    exit_all(&mut on_lent);
    assert_eq!(custody_rows(&path), 4, "each destroyed record's version stays in custody");
    drop(on_lent);
    drop(lent);
    // The account's own handle (secure_delete on) releases them.
    let mut own = store(&path, Box::new(PastWindow));
    exit_all(&mut own);
    assert_eq!(custody_rows(&path), 0);
}

/// The system clock moved past the idle window of every commit a test makes.
struct LongIdle;
impl Clock for LongIdle {
    fn now_ms(&self) -> i64 {
        RealClock.now_ms() + settings::shipped().unwrap().vacuum.idle_ms as i64 + 60 * 1000
    }
}

/// A file made before the vacuum rule: `records` records, turned to auto_vacuum NONE, with a table of about as many pages
/// written and dropped beside them, so most of its pages are free and its records keep their stamps.
fn legacy_file(records: usize) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("legacy.sqlite");
    {
        let mut writer = store(&path, Box::new(RealClock));
        let filler = "x".repeat(8000);
        for n in 0..records {
            let write = Mutation { id: format!("n{n:04}"), expected_version: 0, request_key: format!("w{n}"), deleted: false, value: serde_json::json!({ "text": filler }) };
            writer.mutate(ACCOUNT, RESOURCE, write).unwrap();
        }
    }
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(&format!(
            "PRAGMA auto_vacuum=NONE; VACUUM; CREATE TABLE junk(x BLOB); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < {records} * 8) INSERT INTO junk SELECT randomblob(4000) FROM n; DROP TABLE junk;"
        ))
        .unwrap();
    (dir, path)
}

#[test]
fn a_legacy_file_is_vacuumed_once_when_due_and_then_gives_its_pages_back_in_steps() {
    let (_dir, path) = legacy_file(200);
    let store = store(&path, Box::new(LongIdle));
    let before = store.storage().vacuum_state().unwrap().unwrap();
    assert!(!before.incremental && before.free_pages * 4 >= before.pages, "a legacy file with a quarter of its pages free: {before:?}");
    let volume = 10 << 30;
    let VacuumStep::Vacuumed { before: file, after } = store.vacuum_if_due(ACCOUNT, RESOURCE, volume).unwrap() else { panic!("the vacuum is due") };
    assert!(after < file, "the vacuum gave the free pages back: {file} -> {after} bytes");
    let vacuumed = store.storage().vacuum_state().unwrap().unwrap();
    assert!(vacuumed.incremental, "the file is incremental auto-vacuum from now on");
    assert_eq!(store.vacuum_if_due(ACCOUNT, RESOURCE, volume).unwrap(), VacuumStep::NotDue("the file is already incremental auto-vacuum"));
    while store.reclaim_step().unwrap().left() > 0 {}
    assert_eq!(store.storage().vacuum_state().unwrap().unwrap().free_pages, 0, "every free page went back to the volume");
    assert_eq!(store.get(ACCOUNT, RESOURCE, "n0000").unwrap().record.unwrap().version, 1, "the records are unchanged");
}

#[test]
fn a_legacy_file_is_left_alone_when_the_volume_has_too_little_free_or_the_scope_is_busy() {
    let (_dir, path) = legacy_file(200);
    let before = {
        let busy = store(&path, Box::new(RealClock));
        assert_eq!(busy.vacuum_if_due(ACCOUNT, RESOURCE, 10 << 30).unwrap(), VacuumStep::NotDue("the scope has not been idle for the DATA window"));
        busy.storage().vacuum_state().unwrap().unwrap()
    };
    let store = store(&path, Box::new(LongIdle));
    let file = before.pages * before.page_size;
    assert_eq!(
        store.vacuum_if_due(ACCOUNT, RESOURCE, file).unwrap(),
        VacuumStep::NotDue("the volume has less free than the DATA factor times the file"),
        "a vacuum rewrites the file beside itself, so the volume needs 1.5 times its size free"
    );
    let after = store.storage().vacuum_state().unwrap().unwrap();
    assert_eq!((after.incremental, after.pages), (false, before.pages), "a refused vacuum leaves the file as it was");
}

#[test]
fn a_registered_held_values_style_store_is_vacuumed_once_by_the_idle_pass_and_stays_incremental() {
    use crate::storage::record_store::maintenance::{self, Registered};
    let (_dir, path) = legacy_file(200);
    let resource = "@held-values";
    maintenance::register(&path, ACCOUNT, resource);
    assert!(maintenance::registered().contains(&Registered { path: path.canonicalize().unwrap(), account: ACCOUNT.into(), resource: resource.into() }));
    let mut store = RecordStore::new(sqlite::open_owned(&path, "record_store", bounds()).unwrap(), Box::new(LongIdle), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap();
    let volume = 10 << 30;
    let longest = Duration::from_secs(60);
    let first = maintenance::maintain(&mut store, ACCOUNT, resource, volume, longest).unwrap();
    assert!(matches!(first, VacuumStep::Vacuumed { .. }), "the first idle pass vacuums the legacy file: {first:?}");
    assert_eq!(maintenance::maintain(&mut store, ACCOUNT, resource, volume, longest).unwrap(), VacuumStep::NotDue("the file is already incremental auto-vacuum"));
    assert!(store.storage().vacuum_state().unwrap().unwrap().incremental, "the file stays incremental");
}

#[test]
fn the_idle_pass_gives_each_registered_store_its_turn_in_path_order() {
    use crate::storage::record_store::maintenance::Registry;
    let (_first_dir, first) = legacy_file(20);
    let (_second_dir, second) = legacy_file(20);
    let registry = Registry::default();
    registry.register(&second, ACCOUNT, "@held-values");
    registry.register(&first, ACCOUNT, RESOURCE);
    let order: Vec<PathBuf> = registry.registered().into_iter().map(|one| one.path).collect();
    let turns: Vec<PathBuf> = (0..3).map(|_| registry.run_next(Duration::from_secs(60)).unwrap().0.path).collect();
    assert_eq!(turns, vec![order[0].clone(), order[1].clone(), order[0].clone()], "each store takes its turn, round-robin, whatever the others answered");
}

#[test]
fn a_vault_file_already_on_disk_at_boot_joins_the_idle_upkeep_and_a_missing_one_does_not() {
    use crate::storage::record_store::{maintenance, settings::Limits};
    let present = tempfile::tempdir().unwrap();
    let state = present.path().canonicalize().unwrap();
    drop(RecordStore::new(sqlite::open_owned(&state.join("held-values.sqlite"), "record_store", bounds()).unwrap(), Box::new(RealClock), Limits::fixed(1 << 20, 10 << 30)).unwrap());
    crate::secrets::register_held_values(&state, ACCOUNT).unwrap();
    let file = state.join("held-values.sqlite").canonicalize().unwrap();
    assert!(maintenance::registered().iter().any(|one| one.path == file && one.account == ACCOUNT), "a vault file on disk at boot is registered before any vault call");
    let missing = tempfile::tempdir().unwrap();
    let absent = missing.path().canonicalize().unwrap();
    crate::secrets::register_held_values(&absent, ACCOUNT).unwrap();
    assert!(!maintenance::registered().iter().any(|one| one.path.starts_with(&absent)), "a state folder with no vault file registers nothing and creates none");
    assert!(!absent.join("held-values.sqlite").exists());
}

#[test]
fn a_vacuum_yields_with_a_typed_busy_outcome_while_a_writer_holds_the_file_and_runs_once_it_is_free() {
    let (_dir, path) = legacy_file(200);
    let store = store(&path, Box::new(LongIdle));
    let volume = 10 << 30;
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert_eq!(store.vacuum_if_due(ACCOUNT, RESOURCE, volume).unwrap(), VacuumStep::Busy, "the VACUUM yields to the writer's reservation");
    assert!(!store.storage().vacuum_state().unwrap().unwrap().incremental, "a yielded vacuum leaves the file as it was");
    writer.execute_batch("ROLLBACK").unwrap();
    drop(writer);
    assert!(matches!(store.vacuum_if_due(ACCOUNT, RESOURCE, volume).unwrap(), VacuumStep::Vacuumed { .. }), "the next turn vacuums the free store");
}

#[test]
fn every_turn_logs_its_typed_outcome_and_the_reason_a_vacuum_did_not_run() {
    use crate::storage::record_store::maintenance::{turn_line, Registered};
    let one = Registered { path: PathBuf::from("/state/held-values.sqlite"), account: ACCOUNT.into(), resource: "@held-values".into() };
    let not_due = turn_line(&one, &Ok(VacuumStep::NotDue("the free pages are below the DATA share of the file")));
    assert_eq!(not_due["store_maintenance"]["vacuum"], "not_due");
    assert_eq!(not_due["store_maintenance"]["reason"], "the free pages are below the DATA share of the file");
    let busy = turn_line(&one, &Ok(VacuumStep::Busy));
    assert_eq!(busy["store_maintenance"]["vacuum"], "busy");
    let done = turn_line(&one, &Ok(VacuumStep::Vacuumed { before: 10, after: 4 }));
    assert_eq!(done["store_maintenance"]["vacuum"], "vacuumed");
    assert!(done["store_maintenance"]["reason"].is_null());
}

#[test]
fn an_idle_pass_drains_the_replaced_versions_a_vault_backlog_holds_and_frees_their_pages() {
    use crate::storage::record_store::maintenance;
    const VAULT: &str = "@held-values";
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("held-values.sqlite");
    {
        let mut writer = store(&path, Box::new(RealClock));
        for n in 0..2 {
            let write = Mutation { id: "snapshot".into(), expected_version: n, request_key: format!("w{n}"), deleted: false, value: serde_json::json!({ "text": "x".repeat(8000) }) };
            writer.mutate(ACCOUNT, VAULT, write).unwrap();
        }
    }
    let ending = |path: &Path| -> i64 {
        rusqlite::Connection::open(path).unwrap().query_row("SELECT count(*) FROM versions WHERE valid_to <> 9223372036854775807", [], |row| row.get(0)).unwrap()
    };
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(&format!(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 300) \
             INSERT INTO versions SELECT account, resource, id || '-' || i, valid_from - (2 * 86400000 << 16) - i - 1, valid_from - (2 * 86400000 << 16) - 2 * (i + 1), version, deleted, body, ring, kind \
             FROM (SELECT * FROM versions WHERE valid_to = 9223372036854775807 LIMIT 1), n"
        ))
        .unwrap();
    let backlog = ending(&path);
    assert!(backlog >= 300, "the backlog is in the file: {backlog}");
    let mut store = RecordStore::new(sqlite::open_owned(&path, "record_store", bounds()).unwrap(), Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap();
    let current = store.get(ACCOUNT, VAULT, "snapshot").unwrap().record.unwrap().version;
    crate::storage::record_store::holders::set_guard(&path, crate::storage::record_store::HolderGuard::Copy);
    maintenance::maintain(&mut store, ACCOUNT, VAULT, 10 << 30, Duration::from_secs(60)).unwrap();
    assert_eq!(ending(&path), 0, "the idle pass drains every replaced version, not 64 a write");
    assert_eq!(store.get(ACCOUNT, VAULT, "snapshot").unwrap().record.unwrap().version, current, "the current version is unchanged");
}

#[test]
fn a_vault_replaced_version_younger_than_its_undo_window_is_kept_by_the_idle_drain() {
    use crate::storage::record_store::maintenance;
    const VAULT: &str = "@held-values";
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("held-values.sqlite");
    {
        let mut writer = store(&path, Box::new(RealClock));
        for n in 0..2 {
            let write = Mutation { id: "snapshot".into(), expected_version: n, request_key: format!("w{n}"), deleted: false, value: serde_json::json!({ "text": "x".repeat(8000) }) };
            writer.mutate(ACCOUNT, VAULT, write).unwrap();
        }
    }
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 50) \
             INSERT INTO versions SELECT account, resource, id || '-' || i, valid_from - i - 1, valid_from - 2 * (i + 1), version, deleted, body, ring, kind \
             FROM (SELECT * FROM versions WHERE valid_to = 9223372036854775807 LIMIT 1), n",
        )
        .unwrap();
    let replaced = |path: &Path| -> i64 {
        rusqlite::Connection::open(path).unwrap().query_row("SELECT count(*) FROM versions WHERE valid_to <> 9223372036854775807", [], |row| row.get(0)).unwrap()
    };
    let before = replaced(&path);
    assert!(before >= 50, "the replaced versions are in the file: {before}");
    let mut store = RecordStore::new(sqlite::open_owned(&path, "record_store", bounds()).unwrap(), Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap();
    crate::storage::record_store::holders::set_guard(&path, crate::storage::record_store::HolderGuard::Copy);
    maintenance::maintain(&mut store, ACCOUNT, VAULT, 10 << 30, Duration::from_secs(60)).unwrap();
    assert_eq!(replaced(&path), before, "a replaced version younger than the vault's one-day window stays");
}

/// A clock two hours past the system clock: a holder pulled now has run its one-hour lease out.
struct TwoHoursLater;
impl Clock for TwoHoursLater {
    fn now_ms(&self) -> i64 {
        RealClock.now_ms() + 2 * 60 * 60 * 1000
    }
}

/// A vault file with 50 replaced versions two days old, as the Mac's backlog was (the undo window is one day).
fn vault_backlog() -> (tempfile::TempDir, PathBuf) {
    const VAULT: &str = "@held-values";
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("held-values.sqlite");
    {
        let mut writer = store(&path, Box::new(RealClock));
        for n in 0..2 {
            let write = Mutation { id: "snapshot".into(), expected_version: n, request_key: format!("w{n}"), deleted: false, value: serde_json::json!({ "text": "x".repeat(8000) }) };
            writer.mutate(ACCOUNT, VAULT, write).unwrap();
        }
    }
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 50) \
             INSERT INTO versions SELECT account, resource, id || '-' || i, valid_from - (2 * 86400000 << 16) - i - 1, valid_from - (2 * 86400000 << 16) - 2 * (i + 1), version, deleted, body, ring, kind \
             FROM (SELECT * FROM versions WHERE valid_to = 9223372036854775807 LIMIT 1), n",
        )
        .unwrap();
    (dir, path)
}

fn replaced_versions(path: &Path) -> i64 {
    rusqlite::Connection::open(path).unwrap().query_row("SELECT count(*) FROM versions WHERE valid_to <> 9223372036854775807", [], |row| row.get(0)).unwrap()
}

#[test]
fn a_vault_with_unknown_holders_keeps_every_replaced_version_and_a_copy_prunes_by_its_window() {
    use crate::storage::record_store::{holders, maintenance, HolderGuard};
    const VAULT: &str = "@held-values";
    let (_dir, path) = vault_backlog();
    let before = replaced_versions(&path);
    let mut unknown = RecordStore::new(sqlite::open_owned(&path, "record_store", bounds()).unwrap(), Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap();
    holders::set_guard(&path, HolderGuard::Unknown);
    maintenance::maintain(&mut unknown, ACCOUNT, VAULT, 10 << 30, Duration::from_secs(60)).unwrap();
    assert_eq!(replaced_versions(&path), before, "with holders unknown nothing is pruned (fail closed)");
    let mut copy = RecordStore::new(sqlite::open_owned(&path, "record_store", bounds()).unwrap(), Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap();
    holders::set_guard(&path, HolderGuard::Copy);
    maintenance::maintain(&mut copy, ACCOUNT, VAULT, 10 << 30, Duration::from_secs(60)).unwrap();
    assert_eq!(replaced_versions(&path), 0, "a copy prunes the two-day-old versions by its one-day window");
}

#[test]
fn a_lagging_holder_holds_the_vault_prune_back() {
    use crate::storage::record_store::{holders, maintenance, HolderGuard};
    const VAULT: &str = "@held-values";
    let (_dir, path) = vault_backlog();
    let before = replaced_versions(&path);
    let mut writer = RecordStore::new(sqlite::open_owned(&path, "record_store", bounds()).unwrap(), Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap();
    writer.record_holder_pull(ACCOUNT, VAULT, "lagging", 1).unwrap();
    holders::set_guard(&path, HolderGuard::Writer(vec!["lagging".into()]));
    maintenance::maintain(&mut writer, ACCOUNT, VAULT, 10 << 30, Duration::from_secs(60)).unwrap();
    assert_eq!(replaced_versions(&path), before, "a holder pulled now at stamp 1 has not pulled past the versions, so none is pruned");
}

#[test]
fn an_expired_holder_does_not_hold_the_vault_prune_back() {
    use crate::storage::record_store::{holders, maintenance, HolderGuard};
    const VAULT: &str = "@held-values";
    let (_dir, path) = vault_backlog();
    {
        let pull = RecordStore::new(sqlite::open_owned(&path, "record_store", bounds()).unwrap(), Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap();
        pull.record_holder_pull(ACCOUNT, VAULT, "expired", 1).unwrap();
    }
    let mut writer = RecordStore::new(sqlite::open_owned(&path, "record_store", bounds()).unwrap(), Box::new(TwoHoursLater), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap();
    holders::set_guard(&path, HolderGuard::Writer(vec!["expired".into()]));
    maintenance::maintain(&mut writer, ACCOUNT, VAULT, 10 << 30, Duration::from_secs(60)).unwrap();
    assert_eq!(replaced_versions(&path), 0, "a holder whose one-hour lease ran out is not waited for; its versions go by the window");
}

// ---- incident 10 (held-values vault grew to 3.6 GB): an idle pass compacts a registered store, and a step that cannot give space back says so ----

/// Incident 10: a registered held-values store that grew with removed rows is compacted by the idle pass, and then holds
/// no free page, so its file stops growing with rows it no longer keeps.
fn held_values_store_bounded_after_compaction_for_every_store_body() -> std::result::Result<(), String> {
    use crate::storage::record_store::maintenance::{self, Registered};
    let (_dir, path) = legacy_file(200);
    let resource = "@held-values";
    maintenance::register(&path, ACCOUNT, resource);
    if !maintenance::registered().contains(&Registered { path: path.canonicalize().unwrap(), account: ACCOUNT.into(), resource: resource.into() }) {
        return Err("the held-values store is not registered for the idle pass".into());
    }
    let mut store = RecordStore::new(sqlite::open_owned(&path, "record_store", bounds()).unwrap(), Box::new(LongIdle), settings::Limits::fixed(1 << 20, 10 << 30))
        .unwrap();
    let before = store.storage().vacuum_state().unwrap().unwrap();
    let longest = Duration::from_secs(60);
    maintenance::maintain(&mut store, ACCOUNT, resource, 10 << 30, longest).map_err(|error| format!("the idle pass failed: {error:?}"))?;
    while store.reclaim_step().map_err(|error| format!("a step failed: {error:?}"))?.left() > 0 {}
    let after = store.storage().vacuum_state().unwrap().unwrap();
    if after.free_pages != 0 {
        return Err(format!("{} free pages stay after compaction", after.free_pages));
    }
    if after.pages * after.page_size >= before.pages * before.page_size {
        return Err("the compacted file is not smaller than before".into());
    }
    Ok(())
}

#[test]
fn held_values_store_bounded_after_compaction_for_every_store() {
    crate::simulation::verdict("held-values-store-bounded-after-compaction-for-every-store", held_values_store_bounded_after_compaction_for_every_store_body);
}

/// Incident 10 (step that gives nothing back): a file made before the vacuum rule has free pages, and one `reclaim_step`
/// on it returns `Ok(0)`, which reads as "nothing more to give back" while the pages stay. It must say it made no progress.
fn reclaim_step_on_a_legacy_file_says_it_made_no_progress_body() -> std::result::Result<(), String> {
    let (_dir, path) = legacy_file(200);
    let store = store(&path, Box::new(LongIdle));
    let before = store.storage().vacuum_state().unwrap().unwrap();
    if before.free_pages == 0 {
        return Err("the legacy file has no free pages to give back".into());
    }
    match store.reclaim_step() {
        Ok(Reclaim::Freed(0)) => Err(format!("returned Ok(0) with {} free pages still in the file: no progress is reported", before.free_pages)),
        Ok(_) => Ok(()),
        Err(_) => Ok(()),
    }
}

#[test]
fn reclaim_step_on_a_legacy_file_says_it_made_no_progress() {
    crate::simulation::verdict("reclaim-step-on-a-legacy-file-says-it-made-no-progress", reclaim_step_on_a_legacy_file_says_it_made_no_progress_body);
}

#[test]
fn a_writer_whose_two_holders_have_pulled_past_the_vault_versions_prunes_them() {
    use crate::storage::record_store::{holders, maintenance, HolderGuard};
    const VAULT: &str = "@held-values";
    let (_dir, path) = vault_backlog();
    let mut writer = RecordStore::new(sqlite::open_owned(&path, "record_store", bounds()).unwrap(), Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap();
    let newest: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row("SELECT max(valid_from) FROM versions WHERE valid_to = 9223372036854775807", [], |row| row.get(0))
        .unwrap();
    writer.record_holder_pull(ACCOUNT, VAULT, "a", newest).unwrap();
    writer.record_holder_pull(ACCOUNT, VAULT, "b", newest).unwrap();
    holders::set_guard(&path, HolderGuard::Writer(vec!["a".into(), "b".into()]));
    maintenance::maintain(&mut writer, ACCOUNT, VAULT, 10 << 30, Duration::from_secs(60)).unwrap();
    assert_eq!(replaced_versions(&path), 0, "both holders have pulled past every old version, so the writer prunes them");
}

#[test]
fn a_write_is_refused_before_any_sql_while_its_volume_has_less_free_than_the_computer_keeps() {
    let (_dir, path) = legacy_file(4);
    let rows = |path: &Path| -> i64 {
        rusqlite::Connection::open(path).unwrap().query_row("SELECT count(*) FROM versions", [], |row| row.get(0)).unwrap()
    };
    let before = rows(&path);
    let mut full = store(&path, Box::new(RealClock)).with_volume_reserve(u64::MAX);
    let write = Mutation { id: "refused".into(), expected_version: 0, request_key: "refused".into(), deleted: false, value: serde_json::json!({ "text": "x" }) };
    match full.mutate(ACCOUNT, RESOURCE, write) {
        Err(crate::records::Error::Refused(crate::resource_authority::Refusal::DiskPressure(_), _)) => {}
        other => panic!("a volume below its keep-free reserve refuses the write as disk pressure: {other:?}"),
    }
    assert_eq!(rows(&path), before, "the refused write runs no SQL and leaves the file as it was");
    let mut roomy = store(&path, Box::new(RealClock)).with_volume_reserve(0);
    let write = Mutation { id: "accepted".into(), expected_version: 0, request_key: "accepted".into(), deleted: false, value: serde_json::json!({ "text": "x" }) };
    roomy.mutate(ACCOUNT, RESOURCE, write).unwrap();
    assert_eq!(rows(&path), before + 1, "a volume with room writes");
}

// ---- incident 12, the disk fills to 0 during writes: the store refuses writes as DiskPressure and keeps serving reads ----

/// The volume has no room left: its free bytes are under the reserve the computer keeps. A write must be refused as
/// `disk_pressure` before any SQL, a record written before the disk filled must still read back, and the store must keep
/// serving reads after the refusal.
fn disk_full_during_writes_refuses_as_disk_pressure_and_keeps_reads_body() -> std::result::Result<(), String> {
    use crate::resource_authority::Refusal;
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let path = dir.path().canonicalize().map_err(|error| error.to_string())?.join("full.sqlite");
    let mut writer = store(&path, Box::new(RealClock));
    let first = Mutation { id: "kept".into(), expected_version: 0, request_key: "kept".into(), deleted: false, value: serde_json::json!({ "text": "still-readable" }) };
    writer.mutate(ACCOUNT, RESOURCE, first).map_err(|error| format!("the first write failed: {error:?}"))?;
    let mut full = writer.with_volume_reserve(u64::MAX);
    let write = Mutation { id: "after-full".into(), expected_version: 0, request_key: "after-full".into(), deleted: false, value: serde_json::json!({ "text": "refused" }) };
    match full.mutate(ACCOUNT, RESOURCE, write) {
        Err(crate::records::Error::Refused(Refusal::DiskPressure(_), _)) => {}
        Err(error) => return Err(format!("a full disk is refused as {error:?}, not as disk_pressure")),
        Ok(_) => return Err("a write went through on a volume with no room left".into()),
    }
    let read = full.get(ACCOUNT, RESOURCE, "kept").map_err(|error| format!("a read after the refusal failed: {error:?}"))?;
    match read.record {
        Some(record) if record.value["text"] == "still-readable" => Ok(()),
        _ => Err("the record written before the disk filled does not read back".into()),
    }
}

#[test]
fn disk_full_during_writes_refuses_as_disk_pressure_and_keeps_reads() {
    crate::simulation::verdict("disk-full-during-writes-refuses-as-disk-pressure", disk_full_during_writes_refuses_as_disk_pressure_and_keeps_reads_body);
}

// ---- r5 (2): the idle driver that boot uses (run_next over every registered store) compacts the held-values vault ----

/// The idle driver the boot runs (`maintenance::run_next`, which walks every registered store, the vault included) must
/// compact a registered held-values file that holds free pages. The existing scenario calls `maintain` directly; this one
/// goes through the driver itself.
fn idle_driver_compacts_registered_held_values_store_body() -> std::result::Result<(), String> {
    use crate::storage::record_store::maintenance::{self, Registered};
    let (_dir, path) = legacy_file(200);
    let resource = "@held-values";
    maintenance::register(&path, ACCOUNT, resource);
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    if !maintenance::registered().contains(&Registered { path: canonical, account: ACCOUNT.into(), resource: resource.into() }) {
        return Err("the held-values store is not registered for the idle driver".into());
    }
    let before = rusqlite::Connection::open(&path)
        .and_then(|db| db.query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0)))
        .map_err(|error| error.to_string())?;
    if before == 0 {
        return Err("the legacy file has no free pages for the driver to return".into());
    }
    let mut turns = 0;
    while let Some((one, outcome)) = maintenance::run_next(Duration::from_secs(60)) {
        if one.path == path.canonicalize().map_err(|error| error.to_string())? {
            turns += 1;
            outcome.map_err(|error| format!("the driver failed on the vault: {error:?}"))?;
        }
        if turns >= 4 {
            break;
        }
    }
    let after = rusqlite::Connection::open(&path)
        .and_then(|db| db.query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0)))
        .map_err(|error| error.to_string())?;
    if after == 2 { Ok(()) } else { Err(format!("after the idle driver's turns the vault is auto_vacuum {after}, not incremental")) }
}

#[test]
fn idle_driver_compacts_registered_held_values_store() {
    crate::simulation::verdict("idle-driver-compacts-registered-held-values-store", idle_driver_compacts_registered_held_values_store_body);
}
