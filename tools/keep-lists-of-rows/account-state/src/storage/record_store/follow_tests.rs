// src/storage/record_store/follow_tests.rs
//
// Purpose: a copy catches up from the writer's change feed; applying the same page twice is a no-op; a
// change from a stale writer term, out of order, or with a version that does not advance is refused; and after the
// writer dies the copy holds every acknowledged write exactly once.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{
    follow::{catch_up, Applied, FeedSource, HistoryPage, WriterPage},
    settings, RecordStore, RealClock,
};
use crate::{
    records::{Change, Error, Mutation, Records},
    storage::sqlite::{self, Bounds, Connection, Spend},
};
use std::{cell::Cell, path::Path, time::Duration};

const ACCOUNT: &str = "follow-account";
const RESOURCE: &str = "notes";

type Store = RecordStore<sqlite::Supply<Connection>>;

fn bounds() -> Bounds {
    Bounds { value_bytes: 64 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(5) }
}

fn owned(path: &Path) -> Store {
    let limits = settings::Limits::fixed(1 << 20, 10 << 30);
    RecordStore::new(sqlite::open_owned(path, "record_store", bounds()).unwrap(), Box::new(RealClock), limits).unwrap()
}

fn note(id: &str, expected_version: i64) -> Mutation {
    Mutation {
        id: id.into(),
        expected_version,
        request_key: format!("{id}-{expected_version}"),
        deleted: false,
        value: serde_json::json!({ "kind": "note", "text": format!("{id} at {expected_version}") }),
    }
}

/// The writer's computer as a copy sees it: its own store, its term number, and the stamp the copy reported. Its
/// pages carry at most `history` versions in between per change, as a computer's do (`feed_history_items`); a copy asks
/// for the rest with `history`, which answers at most `limit` versions a page. `fail_after` makes the writer stop
/// answering history pages after that many (it died in the middle).
struct Writer<'a> {
    store: &'a Store,
    term: u64,
    caught: Cell<Option<i64>>,
    history: usize,
    history_pages: Cell<usize>,
    largest_page: Cell<usize>,
    fail_after: Option<usize>,
}

impl FeedSource for Writer<'_> {
    fn page(&self, account: &str, resource: &str, after: i64, limit: usize) -> Result<WriterPage, Error> {
        let (changes, more) = self.store.carried_page(account, resource, after, limit, self.history)?;
        Ok(WriterPage { term: self.term, base: 0, changes, more })
    }

    fn caught_up(&self, _account: &str, _resource: &str, stamp: i64) -> Result<(), Error> {
        self.caught.set(Some(stamp));
        Ok(())
    }

    fn history(&self, account: &str, resource: &str, id: &str, version: i64, since: i64, before: i64, limit: usize) -> Result<HistoryPage, Error> {
        if self.fail_after.is_some_and(|after| self.history_pages.get() >= after) {
            return Err(crate::cause!(Error::Unavailable));
        }
        let (versions, more, kept) = self.store.history_page(account, resource, id, version, since, before, limit)?;
        self.history_pages.set(self.history_pages.get() + 1);
        self.largest_page.set(self.largest_page.get().max(versions.len()));
        Ok(HistoryPage { term: self.term, base: 0, versions, more, kept, sealed: false })
    }
}

fn writer_source(store: &Store, term: u64) -> Writer<'_> {
    Writer { store, term, caught: Cell::new(None), history: 0, history_pages: Cell::new(0), largest_page: Cell::new(0), fail_after: None }
}

#[test]
fn a_copy_catches_up_from_empty_in_pages() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let mut writer = owned(&base.join("writer.sqlite"));
    let mut copy = owned(&base.join("copy.sqlite"));
    writer.mutate(ACCOUNT, RESOURCE, note("n1", 0)).unwrap();
    writer.mutate(ACCOUNT, RESOURCE, note("n2", 0)).unwrap();
    writer.mutate(ACCOUNT, RESOURCE, note("n3", 0)).unwrap();
    writer.mutate(ACCOUNT, RESOURCE, note("n1", 1)).unwrap();

    let source = writer_source(&writer, 1);
    let stamp = catch_up(&mut copy, &source, ACCOUNT, RESOURCE, 2).unwrap();

    assert_eq!(stamp, writer.stamp(ACCOUNT, RESOURCE).unwrap());
    assert_eq!(copy.stamp(ACCOUNT, RESOURCE).unwrap(), stamp, "the copy's caught-up stamp is the writer's");
    assert_eq!(source.caught.get(), Some(stamp), "the copy reports its caught-up stamp to the writer");
    assert_eq!(copy.accepted_term(ACCOUNT, RESOURCE).unwrap(), 1);
    for id in ["n1", "n2", "n3"] {
        assert_eq!(
            copy.get(ACCOUNT, RESOURCE, id).unwrap().record,
            writer.get(ACCOUNT, RESOURCE, id).unwrap().record,
            "record {id} matches the writer"
        );
    }
    assert_eq!(copy.get(ACCOUNT, RESOURCE, "n1").unwrap().record.unwrap().version, 2);
}

#[test]
fn applying_the_same_page_again_is_a_no_op() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let mut writer = owned(&base.join("writer.sqlite"));
    let mut copy = owned(&base.join("copy.sqlite"));
    writer.mutate(ACCOUNT, RESOURCE, note("n1", 0)).unwrap();
    writer.mutate(ACCOUNT, RESOURCE, note("n2", 0)).unwrap();
    let page = writer.changes_page(ACCOUNT, RESOURCE, 0, 100).unwrap().items;

    let first = copy.apply_from_writer(ACCOUNT, RESOURCE, 1, &page).unwrap();
    assert_eq!(first.applied, 2);
    let second = copy.apply_from_writer(ACCOUNT, RESOURCE, 1, &page).unwrap();
    assert_eq!(second, Applied { applied: 0, held: 2, stamp: first.stamp }, "the same page writes nothing");
    assert_eq!(copy.stamp(ACCOUNT, RESOURCE).unwrap(), first.stamp);
}

#[test]
fn an_out_of_order_change_is_refused_and_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let mut writer = owned(&base.join("writer.sqlite"));
    let mut copy = owned(&base.join("copy.sqlite"));
    let early: Change = writer.mutate(ACCOUNT, RESOURCE, note("n1", 0)).unwrap();
    let late: Change = writer.mutate(ACCOUNT, RESOURCE, note("n2", 0)).unwrap();

    copy.apply_from_writer(ACCOUNT, RESOURCE, 1, std::slice::from_ref(&late)).unwrap();
    let refused = copy.apply_from_writer(ACCOUNT, RESOURCE, 1, std::slice::from_ref(&early)).unwrap_err();
    assert!(matches!(refused, Error::Invalid(_, _)), "an older change the copy does not hold is refused: {refused:?}");
    assert!(copy.get(ACCOUNT, RESOURCE, "n1").unwrap().record.is_none());
    assert_eq!(copy.stamp(ACCOUNT, RESOURCE).unwrap(), late.sequence);
}

#[test]
fn a_change_from_a_stale_writer_term_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let mut writer = owned(&base.join("writer.sqlite"));
    let mut copy = owned(&base.join("copy.sqlite"));
    let first: Change = writer.mutate(ACCOUNT, RESOURCE, note("n1", 0)).unwrap();
    let second: Change = writer.mutate(ACCOUNT, RESOURCE, note("n2", 0)).unwrap();

    copy.apply_from_writer(ACCOUNT, RESOURCE, 2, std::slice::from_ref(&first)).unwrap();
    let refused = copy.apply_from_writer(ACCOUNT, RESOURCE, 1, std::slice::from_ref(&second)).unwrap_err();
    assert!(matches!(refused, Error::Invalid(_, _)), "term 1 is behind term 2: {refused:?}");
    assert_eq!(copy.accepted_term(ACCOUNT, RESOURCE).unwrap(), 2);
    assert!(copy.get(ACCOUNT, RESOURCE, "n2").unwrap().record.is_none());

    copy.apply_from_writer(ACCOUNT, RESOURCE, 2, std::slice::from_ref(&second)).unwrap();
    assert!(copy.get(ACCOUNT, RESOURCE, "n2").unwrap().record.is_some(), "the current term carries on");
}

#[test]
fn a_version_that_does_not_advance_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let mut writer = owned(&base.join("writer.sqlite"));
    let mut copy = owned(&base.join("copy.sqlite"));
    writer.mutate(ACCOUNT, RESOURCE, note("n1", 0)).unwrap();
    let newer = writer.mutate(ACCOUNT, RESOURCE, note("n1", 1)).unwrap();
    copy.apply_from_writer(ACCOUNT, RESOURCE, 1, std::slice::from_ref(&newer)).unwrap();

    let older_version_later_stamp = Change {
        sequence: newer.sequence + 1,
        version: 1,
        value: Some(serde_json::json!({ "kind": "note", "text": "old" })),
        ..newer.clone()
    };
    let refused = copy.apply_from_writer(ACCOUNT, RESOURCE, 1, &[older_version_later_stamp]).unwrap_err();
    assert_eq!(refused, crate::cause!(Error::Conflict));
    assert_eq!(copy.get(ACCOUNT, RESOURCE, "n1").unwrap().record.unwrap().version, 2);
}

#[test]
fn after_the_writer_dies_the_copy_holds_every_acknowledged_write_once() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let mut writer = owned(&base.join("writer.sqlite"));
    let mut copy = owned(&base.join("copy.sqlite"));
    writer.mutate(ACCOUNT, RESOURCE, note("a", 0)).unwrap();
    writer.mutate(ACCOUNT, RESOURCE, note("b", 0)).unwrap();
    let acked_a = writer.mutate(ACCOUNT, RESOURCE, note("a", 1)).unwrap();
    let acked_b = writer.mutate(ACCOUNT, RESOURCE, note("b", 1)).unwrap();

    // The copy holds everything up to here, so these four writes are acknowledged. Then the writer takes one more
    // write that no copy holds yet, and dies.
    {
        let source = writer_source(&writer, 1);
        assert_eq!(catch_up(&mut copy, &source, ACCOUNT, RESOURCE, 1).unwrap(), acked_b.sequence);
    }
    writer.mutate(ACCOUNT, RESOURCE, note("c", 0)).unwrap();
    drop(writer);

    let a = copy.get(ACCOUNT, RESOURCE, "a").unwrap().record.unwrap();
    let b = copy.get(ACCOUNT, RESOURCE, "b").unwrap().record.unwrap();
    assert_eq!((a.version, a.value), (acked_a.version, acked_a.value.unwrap()));
    assert_eq!((b.version, b.value), (acked_b.version, acked_b.value.unwrap()));
    assert!(copy.get(ACCOUNT, RESOURCE, "c").unwrap().record.is_none(), "an unacknowledged write is not on the copy");
    let listed: Vec<String> = copy.list_page(ACCOUNT, RESOURCE, "", 100).unwrap().items.into_iter().map(|r| r.id).collect();
    assert_eq!(listed, ["a", "b"], "each acknowledged record appears exactly once");
    assert_eq!(copy.stamp(ACCOUNT, RESOURCE).unwrap(), acked_b.sequence);
}

/// Write version `expected + 1` of `id`: a delete when `delete`, else a note.
fn version_of(store: &mut Store, id: &str, expected: i64, delete: bool) -> Change {
    let mut write = note(id, expected);
    if delete {
        write.deleted = true;
        write.value = serde_json::Value::Null;
    }
    store.mutate(ACCOUNT, RESOURCE, write).unwrap()
}

/// Write `count` versions of `id` after `held`, every seventh a delete, with a write of `other` between some of them
/// (so the record's versions and other changes interleave). Answers each version's stamp, by version.
fn many_versions(store: &mut Store, id: &str, held: i64, count: i64, other: &str) -> Vec<(i64, i64)> {
    let mut stamps = Vec::new();
    let mut other_held = store.held_version(ACCOUNT, RESOURCE, other).unwrap();
    for version in held..held + count {
        let change = version_of(store, id, version, version % 7 == 6);
        stamps.push((change.version, change.sequence));
        if version % 5 == 0 {
            store.mutate(ACCOUNT, RESOURCE, note(other, other_held)).unwrap();
            other_held += 1;
        }
    }
    stamps
}

fn same_as_of(writer: &Store, copy: &Store, id: &str, stamps: &[(i64, i64)]) {
    for (version, stamp) in stamps {
        assert_eq!(
            copy.as_of(ACCOUNT, RESOURCE, id, *stamp).unwrap().record,
            writer.as_of(ACCOUNT, RESOURCE, id, *stamp).unwrap().record,
            "version {version} of {id} reads the same as of its stamp"
        );
    }
}

#[test]
fn every_version_the_writer_keeps_reaches_the_copy_in_bounded_history_pages() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let mut writer = owned(&base.join("writer.sqlite"));
    let mut fresh = owned(&base.join("fresh.sqlite"));
    let mut behind = owned(&base.join("behind.sqlite"));
    let mut stamps = many_versions(&mut writer, "x", 0, 5, "y");
    {
        // `behind` holds x at version 5, then falls far behind.
        let source = Writer { history: 16, ..writer_source(&writer, 1) };
        catch_up(&mut behind, &source, ACCOUNT, RESOURCE, 4).unwrap();
    }
    stamps.extend(many_versions(&mut writer, "x", 5, 55, "y"));
    for (copy, name) in [(&mut fresh, "fresh"), (&mut behind, "behind")] {
        // Pages of two changes, each carrying at most 16 versions in between, and history pages of at most 4: the
        // change of x needs 50 or more versions in between, which no single page carries.
        let source = Writer { history: 16, ..writer_source(&writer, 1) };
        let stamp = catch_up(copy, &source, ACCOUNT, RESOURCE, 4).unwrap();
        assert_eq!(stamp, writer.stamp(ACCOUNT, RESOURCE).unwrap(), "{name} is caught up");
        assert!(source.history_pages.get() >= 10, "{name} took the versions in between in history pages");
        assert!(source.largest_page.get() <= 4, "a history page holds at most the page size");
        same_as_of(&writer, copy, "x", &stamps);
        assert_eq!(copy.get(ACCOUNT, RESOURCE, "y").unwrap().record, writer.get(ACCOUNT, RESOURCE, "y").unwrap().record);
    }
}

#[test]
fn a_writer_that_dies_in_the_middle_of_a_history_leaves_the_copy_below_the_change() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let mut writer = owned(&base.join("writer.sqlite"));
    let mut copy = owned(&base.join("copy.sqlite"));
    let stamps = many_versions(&mut writer, "x", 0, 40, "y");
    let x = writer.get(ACCOUNT, RESOURCE, "x").unwrap().record.unwrap();
    let dying = Writer { history: 16, fail_after: Some(2), ..writer_source(&writer, 1) };
    assert!(catch_up(&mut copy, &dying, ACCOUNT, RESOURCE, 4).is_err(), "the pull ends with the writer");
    assert_eq!(dying.caught.get(), None, "the copy never reports it caught up");
    let held = copy.stamp(ACCOUNT, RESOURCE).unwrap();
    let x_stamp = stamps.iter().find(|(version, _)| *version == x.version).unwrap().1;
    assert!(held < x_stamp, "the copy's stamp stays below the change it does not hold whole");
    // What the copy holds of x is a version the writer had, with every version before it.
    let at_copy = copy.get(ACCOUNT, RESOURCE, "x").unwrap().record;
    let version = copy.held_version(ACCOUNT, RESOURCE, "x").unwrap();
    assert!(version > 0 && version < x.version);
    let made = stamps.iter().find(|(held, _)| *held == version).unwrap().1;
    assert_eq!(at_copy, writer.as_of(ACCOUNT, RESOURCE, "x", made).unwrap().record);
    same_as_of(&writer, &copy, "x", &stamps.iter().copied().filter(|(held, _)| *held < version).collect::<Vec<_>>());

    // The writer back (or another computer that keeps all of it): the copy goes on from what it holds.
    let source = Writer { history: 16, ..writer_source(&writer, 1) };
    assert_eq!(catch_up(&mut copy, &source, ACCOUNT, RESOURCE, 4).unwrap(), writer.stamp(ACCOUNT, RESOURCE).unwrap());
    same_as_of(&writer, &copy, "x", &stamps);
}

/// The system clock moved one day past the undo window.
struct PastWindow;
impl super::Clock for PastWindow {
    fn now_ms(&self) -> i64 {
        use super::Clock as _;
        RealClock.now_ms() + settings::shipped().unwrap().undo_windows.records as i64 + 24 * 60 * 60 * 1000
    }
}

#[test]
fn versions_the_writer_no_longer_keeps_leave_the_copy_too() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let mut copy = owned(&base.join("copy.sqlite"));
    let path = base.join("writer.sqlite");
    let early = {
        let mut writer = owned(&path);
        let early = many_versions(&mut writer, "x", 0, 3, "y");
        catch_up(&mut copy, &Writer { history: 16, ..writer_source(&writer, 1) }, ACCOUNT, RESOURCE, 4).unwrap();
        many_versions(&mut writer, "x", 3, 20, "y");
        early
    };
    // A month later the writer's undo window has let every replaced version go; it writes on.
    let limits = settings::Limits::fixed(1 << 20, 10 << 30);
    let mut writer = RecordStore::new(sqlite::open_owned(&path, "record_store", bounds()).unwrap(), Box::new(PastWindow), limits).unwrap();
    while writer.retire(ACCOUNT, RESOURCE).unwrap() > 0 {}
    let late = many_versions(&mut writer, "x", 23, 30, "y");
    let source = Writer { history: 16, ..writer_source(&writer, 1) };
    assert_eq!(catch_up(&mut copy, &source, ACCOUNT, RESOURCE, 4).unwrap(), writer.stamp(ACCOUNT, RESOURCE).unwrap());
    same_as_of(&writer, &copy, "x", &late);
    // The versions the writer no longer keeps are not kept at the copy either: as of their stamps both answer none.
    for (version, stamp) in &early {
        assert!(writer.as_of(ACCOUNT, RESOURCE, "x", *stamp).unwrap().record.is_none());
        assert!(copy.as_of(ACCOUNT, RESOURCE, "x", *stamp).unwrap().record.is_none(), "version {version} left the copy");
    }
}

// An `overwrite` resource (`record_store_resources.json` `history`) keeps no history at the writer, but a copy can still hold
// the replaced versions it wrote before that rule. The copy must converge on the writer's current record and keep none of
// them (`apply_history` drops them when the writer no longer keeps the versions after the copy's own).
const OVERWRITE: &str = "@held-values";
const OVERWRITE_ID: &str = "snapshot";

fn overwrite_write(store: &mut Store, version: i64) {
    let write = Mutation { id: OVERWRITE_ID.into(), expected_version: version, request_key: format!("{OVERWRITE_ID}-{version}"), deleted: false, value: serde_json::json!({ "text": format!("v{}", version + 1) }) };
    store.mutate(ACCOUNT, OVERWRITE, write).unwrap();
}

/// A copy at version `held` whose file also holds the replaced versions 1..`held` (pre-rule history), written as rows.
fn copy_with_legacy_versions(path: &Path, held: i64) -> Store {
    let mut copy = owned(path);
    for version in 0..held {
        overwrite_write(&mut copy, version);
    }
    let current_from: i64 = rusqlite::Connection::open(path)
        .unwrap()
        .query_row("SELECT valid_from FROM versions WHERE id = ?1 AND valid_to = 9223372036854775807", [OVERWRITE_ID], |row| row.get(0))
        .unwrap();
    let legacy = rusqlite::Connection::open(path).unwrap();
    for version in 1..held {
        let valid_to = current_from - (held - version) * 1_000;
        legacy.execute(
            "INSERT INTO versions (account, resource, id, valid_to, valid_from, version, deleted, body, ring, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, NULL, 'snapshot')",
            rusqlite::params![ACCOUNT, OVERWRITE, OVERWRITE_ID, valid_to, valid_to - 500, version, br#"{"text":"old"}"#.to_vec()],
        ).unwrap();
    }
    copy
}

/// Moves every replaced version of the overwrite record back by `by` stamp units, so the vault's undo window can release it.
fn age_replaced_versions(path: &Path, by: i64) {
    rusqlite::Connection::open(path)
        .unwrap()
        .execute(
            "UPDATE versions SET valid_to = valid_to - ?2, valid_from = valid_from - ?2 WHERE id = ?1 AND valid_to != 9223372036854775807",
            rusqlite::params![OVERWRITE_ID, by],
        )
        .unwrap();
}

fn replaced_rows(path: &Path) -> i64 {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row("SELECT count(*) FROM versions WHERE id = ?1 AND valid_to != 9223372036854775807", [OVERWRITE_ID], |row| row.get(0))
        .unwrap()
}

#[test]
fn a_copy_far_behind_an_overwrite_writer_drops_its_legacy_versions_and_takes_the_writer_current() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let copy_path = base.join("copy.sqlite");
    let mut copy = copy_with_legacy_versions(&copy_path, 3);
    let mut writer = owned(&base.join("writer.sqlite"));
    for version in 0..6 {
        overwrite_write(&mut writer, version);
    }
    catch_up(&mut copy, &Writer { history: 16, ..writer_source(&writer, 1) }, ACCOUNT, OVERWRITE, 4).unwrap();
    assert_eq!(copy.get(ACCOUNT, OVERWRITE, OVERWRITE_ID).unwrap().record, writer.get(ACCOUNT, OVERWRITE, OVERWRITE_ID).unwrap().record, "the copy holds the writer's current record");
    assert_eq!(replaced_rows(&copy_path), 0, "no legacy replaced version is left at the copy");
}

#[test]
fn a_copy_one_version_behind_an_overwrite_writer_takes_the_writer_current_and_writes_no_replaced_row() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let copy_path = base.join("copy.sqlite");
    let mut copy = copy_with_legacy_versions(&copy_path, 3);
    // The vault's replaced versions leave once they are older than its one-day window, and a copy holds no writer's match index
    // (the reclaim tests set the same): the legacy versions are two days old.
    crate::storage::record_store::holders::set_guard(&copy_path, crate::storage::record_store::HolderGuard::Copy);
    age_replaced_versions(&copy_path, (2 * 24 * 60 * 60 * 1000_i64) << 16);
    let mut writer = owned(&base.join("writer.sqlite"));
    for version in 0..4 {
        overwrite_write(&mut writer, version);
    }
    catch_up(&mut copy, &Writer { history: 16, ..writer_source(&writer, 1) }, ACCOUNT, OVERWRITE, 4).unwrap();
    assert_eq!(copy.get(ACCOUNT, OVERWRITE, OVERWRITE_ID).unwrap().record, writer.get(ACCOUNT, OVERWRITE, OVERWRITE_ID).unwrap().record, "the copy holds the writer's current record");
    // The change's exit step releases the legacy versions the copy holds, and the change writes no replaced version itself.
    assert_eq!(replaced_rows(&copy_path), 0, "no replaced version is left at the copy");
}

// A writer whose file still holds the replaced versions it wrote before the overwrite rule (its own pre-rule history): a copy
// behind it by more than one version takes those versions in between, and must write none of them as history.
fn overwrite_writer_with_legacy_history(path: &Path, current: i64) -> Store {
    let mut writer = owned(path);
    for version in 0..current {
        overwrite_write(&mut writer, version);
    }
    let current_from: i64 = rusqlite::Connection::open(path)
        .unwrap()
        .query_row("SELECT valid_from FROM versions WHERE id = ?1 AND valid_to = 9223372036854775807", [OVERWRITE_ID], |row| row.get(0))
        .unwrap();
    let legacy = rusqlite::Connection::open(path).unwrap();
    // Versions 1..current-1 chain up to the current row's valid_from, one second apart.
    for version in 1..current {
        let valid_to = current_from - (current - version - 1) * 1_000;
        legacy.execute(
            "INSERT INTO versions (account, resource, id, valid_to, valid_from, version, deleted, body, ring, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, NULL, 'snapshot')",
            rusqlite::params![ACCOUNT, OVERWRITE, OVERWRITE_ID, valid_to, valid_to - 1_000, version, br#"{"text":"old"}"#.to_vec()],
        ).unwrap();
    }
    writer
}

#[test]
fn a_multi_version_overwrite_page_writes_no_replaced_row_and_takes_the_writer_current() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let copy_path = base.join("copy.sqlite");
    let mut copy = copy_with_legacy_versions(&copy_path, 1);
    let writer_path = base.join("writer.sqlite");
    let writer = overwrite_writer_with_legacy_history(&writer_path, 5);
    catch_up(&mut copy, &Writer { history: 16, ..writer_source(&writer, 1) }, ACCOUNT, OVERWRITE, 4).unwrap();
    assert_eq!(copy.get(ACCOUNT, OVERWRITE, OVERWRITE_ID).unwrap().record, writer.get(ACCOUNT, OVERWRITE, OVERWRITE_ID).unwrap().record, "the copy holds the writer's current record");
    assert_eq!(replaced_rows(&copy_path), 0, "the versions in between were not written as history");
}

#[test]
fn a_multi_version_overwrite_history_page_writes_no_replaced_row_and_takes_the_writer_current() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let copy_path = base.join("copy.sqlite");
    let mut copy = copy_with_legacy_versions(&copy_path, 1);
    let writer_path = base.join("writer.sqlite");
    let writer = overwrite_writer_with_legacy_history(&writer_path, 5);
    // No history carried with the change: the copy pulls the versions in between from history pages (apply_history).
    catch_up(&mut copy, &Writer { history: 0, ..writer_source(&writer, 1) }, ACCOUNT, OVERWRITE, 4).unwrap();
    assert_eq!(copy.get(ACCOUNT, OVERWRITE, OVERWRITE_ID).unwrap().record, writer.get(ACCOUNT, OVERWRITE, OVERWRITE_ID).unwrap().record);
    assert_eq!(replaced_rows(&copy_path), 0, "no fresh version was written as history");
}

// A copy's exit step runs at every change it applies, so the replaced versions a copy holds from before the overwrite rule
// leave while it follows the writer, and the pages they held go back to the file.
#[test]
fn a_copy_drains_its_legacy_versions_while_it_applies_changes_and_gives_the_pages_back() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let copy_path = base.join("copy.sqlite");
    let mut copy = copy_with_legacy_versions(&copy_path, 1);
    // A copy prunes a vault's replaced versions older than the vault's one-day window (holders.rs; the reclaim tests do the same),
    // so the legacy versions are two days old and the copy says it holds no writer's match index.
    crate::storage::record_store::holders::set_guard(&copy_path, crate::storage::record_store::HolderGuard::Copy);
    // Stamps are milliseconds shifted left 16 bits (exit_ranges' `to_stamp`).
    let two_days = (2 * 24 * 60 * 60 * 1000_i64) << 16;
    let legacy = 3_000;
    let current_from: i64 = rusqlite::Connection::open(&copy_path)
        .unwrap()
        .query_row("SELECT valid_from FROM versions WHERE id = ?1 AND valid_to = 9223372036854775807", [OVERWRITE_ID], |row| row.get(0))
        .unwrap();
    {
        let rows = rusqlite::Connection::open(&copy_path).unwrap();
        for k in 1..=legacy {
            let valid_to = current_from - two_days - k;
            rows.execute(
                "INSERT INTO versions (account, resource, id, valid_to, valid_from, version, deleted, body, ring, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, NULL, 'snapshot')",
                rusqlite::params![ACCOUNT, OVERWRITE, OVERWRITE_ID, valid_to, valid_to - 500, k + 1, br#"{"text":"old"}"#.to_vec()],
            ).unwrap();
        }
    }
    assert_eq!(replaced_rows(&copy_path), legacy + 0, "the copy starts with its legacy versions");
    let mut writer = owned(&base.join("writer.sqlite"));
    overwrite_write(&mut writer, 0);
    overwrite_write(&mut writer, 1);
    // One change at a time: each applied change is one exit step (64 replaced versions), so 60 changes release all 3,000.
    catch_up(&mut copy, &Writer { history: 16, ..writer_source(&writer, 1) }, ACCOUNT, OVERWRITE, 4).unwrap();
    assert_eq!(replaced_rows(&copy_path), legacy - 64, "the first applied change released one exit step");
    for version in 2..60 {
        overwrite_write(&mut writer, version);
        catch_up(&mut copy, &Writer { history: 16, ..writer_source(&writer, 1) }, ACCOUNT, OVERWRITE, 4).unwrap();
    }
    assert_eq!(copy.get(ACCOUNT, OVERWRITE, OVERWRITE_ID).unwrap().record, writer.get(ACCOUNT, OVERWRITE, OVERWRITE_ID).unwrap().record);
    assert_eq!(replaced_rows(&copy_path), 0, "the legacy versions left at the copy's changes, not only at its next retire");
    let pages = |query: &str| -> i64 { rusqlite::Connection::open(&copy_path).unwrap().query_row(query, [], |row| row.get(0)).unwrap() };
    let (free_before, total_before) = (pages("PRAGMA freelist_count"), pages("PRAGMA page_count"));
    assert!(free_before > 0, "the removed versions left free pages behind");
    let mut steps = 0;
    while copy.reclaim_step().unwrap().left() > 0 && steps < 10_000 {
        steps += 1;
    }
    let (free_after, total_after) = (pages("PRAGMA freelist_count"), pages("PRAGMA page_count"));
    assert_eq!(free_after, 0, "every free page went back to the volume");
    assert!(total_after < total_before, "the file shrank: {total_before} -> {total_after} pages");
}
