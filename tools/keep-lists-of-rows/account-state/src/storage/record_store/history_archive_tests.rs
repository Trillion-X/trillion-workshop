// Purpose: `history_archive.rs` on a real SQLite record store: replaced versions of a resource the DATA names move out
// as chained JSONL files in bounded pages and leave the store only once kept and read back; pins hold history; a
// refused keep, readback or pin changes nothing; kept history goes back only after its chain checks; erasure rewrites
// kept files and the chain still checks. Ported from old trillion test/record-history.test.mjs and
// test/record-history-page-reclaim.test.mjs (tag old-trillion-before-worker-retire); each test names its old one.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::super::history_chain::{check_history_chain, decode_archive, history_identity, keep_archive, KeptObject, Keeper};
use super::super::{settings, Clock, RecordStore};
use super::*;
use crate::records::{Mutation, Records};
use crate::storage::sqlite::{self, Bounds, Spend};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{atomic::{AtomicU64, Ordering}, Arc},
    time::Duration,
};

const ACCOUNT: &str = "account";
const RESOURCE: &str = "notes";
const HOUR: u64 = 3_600_000;

#[derive(Clone)]
struct Moving(Arc<AtomicU64>);
impl Clock for Moving {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Acquire) as i64
    }
}
fn bounds() -> Bounds {
    Bounds { value_bytes: 64 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(5) }
}
/// The shipped settings with `notes` archived, `rows_per_file` versions and `bytes_per_file` bytes a file.
fn archived(rows_per_file: usize, bytes_per_file: usize) -> &'static settings::Settings {
    let mut chosen = settings::shipped().unwrap().clone();
    chosen.history_archive.resources = vec![RESOURCE.into()];
    chosen.history_archive.keep_ms = 2 * HOUR;
    chosen.history_archive.rows_per_file = rows_per_file;
    chosen.history_archive.bytes_per_file = bytes_per_file;
    Box::leak(Box::new(chosen))
}
fn store(path: &Path, clock: &Moving, chosen: &'static settings::Settings) -> RecordStore<sqlite::Supply<sqlite::Connection>> {
    RecordStore::with_settings(sqlite::open_owned(path, super::super::SCHEMA, bounds()).unwrap(), Box::new(clock.clone()), chosen, settings::Limits::fixed(1 << 20, 10 << 30)).unwrap()
}
fn write(store: &mut RecordStore<sqlite::Supply<sqlite::Connection>>, id: &str, expected: i64, text: &str) -> i64 {
    let value = serde_json::json!({ "kind": "note", "text": text });
    store.mutate(ACCOUNT, RESOURCE, Mutation { id: id.into(), expected_version: expected, request_key: format!("{id}-{expected}"), deleted: false, value }).unwrap().version
}
fn versions(store: &RecordStore<sqlite::Supply<sqlite::Connection>>, id: &str) -> usize {
    store.history(ACCOUNT, RESOURCE, id, None, 100_000).unwrap().versions.len()
}
/// A record written `n` times an hour apart, then the clock moved three hours on: `n - 1` replaced versions are due.
fn with_history(path: &Path, clock: &Moving, chosen: &'static settings::Settings, id: &str, n: usize) -> RecordStore<sqlite::Supply<sqlite::Connection>> {
    let mut opened = store(path, clock, chosen);
    let mut version = 0;
    for at in 0..n {
        version = write(&mut opened, id, version, &format!("{id} {at}"));
        clock.0.fetch_add(HOUR, Ordering::AcqRel);
    }
    clock.0.fetch_add(3 * HOUR, Ordering::AcqRel);
    opened
}
/// Files kept in memory by name, as the account's files would hold them.
#[derive(Default)]
struct Files(BTreeMap<String, Vec<u8>>);
impl Files {
    fn keep(&mut self) -> impl FnMut(&str, &[u8]) -> Result<(), HistoryError> + '_ {
        |name, bytes| {
            self.0.insert(name.to_string(), bytes.to_vec());
            Ok(())
        }
    }
}
fn clock() -> Moving {
    Moving(Arc::new(AtomicU64::new(1_800_000_000_000)))
}

// test/record-history.test.mjs: 'changes older than keep_days move out as files, a page at a time, and newer ones stay'
#[test]
fn replaced_versions_older_than_keep_move_out_as_files_a_page_at_a_time_and_newer_ones_stay() {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let mut opened = with_history(&dir.path().join("a.sqlite"), &clock, archived(3, 1 << 20), "n1", 8);
    // Two more versions inside keep_ms: they stay.
    let mut version = opened.held_version(ACCOUNT, RESOURCE, "n1").unwrap();
    for text in ["recent 1", "recent 2"] {
        version = write(&mut opened, "n1", version, text);
    }
    assert_eq!(versions(&opened, "n1"), 10);
    let mut files = Files::default();
    let mut moved = Vec::new();
    loop {
        let step = opened.archive_history_step(ACCOUNT, RESOURCE, &mut files.keep()).unwrap();
        if !step.more {
            break;
        }
        moved.push(step.moved);
    }
    assert_eq!(moved, [3, 3, 1], "three to a file, oldest first, every due version moved");
    assert_eq!(files.0.len(), 3);
    assert_eq!(versions(&opened, "n1"), 3, "the current version and the two recent replaced ones stay");
    let rows: usize = files.0.values().map(|bytes| String::from_utf8_lossy(bytes).trim().lines().skip(1).count()).sum();
    assert_eq!(rows, 7);
    assert!(files.0.keys().all(|name| name.starts_with("record-history/notes/")));
}

// test/record-history.test.mjs: 'the kept files are one chain: each names the one before it, and the head proves none
// was changed, dropped or reordered'
#[test]
fn the_kept_files_are_one_chain_and_the_head_proves_none_was_changed_dropped_or_reordered() {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let mut opened = with_history(&dir.path().join("b.sqlite"), &clock, archived(2, 1 << 20), "n1", 7);
    let mut files = Files::default();
    while opened.archive_history_step(ACCOUNT, RESOURCE, &mut files.keep()).unwrap().more {}
    let (head, kept) = opened.history_head(ACCOUNT, RESOURCE).unwrap().unwrap();
    assert_eq!(kept, 3);
    let all: Vec<(&str, &[u8])> = files.0.iter().map(|(name, bytes)| (name.as_str(), bytes.as_slice())).collect();
    assert!(check_history_chain(all.clone(), Some(&head), &[]).is_ok());
    let mut reordered = all.clone();
    reordered.swap(0, 1);
    assert!(check_history_chain(reordered, Some(&head), &[]).is_err(), "reordered");
    assert!(check_history_chain(all[1..].to_vec(), Some(&head), &[]).is_err(), "dropped");
    let mut changed = files.0.clone();
    let last = changed.keys().last().unwrap().clone();
    changed.get_mut(&last).unwrap().push(b' ');
    let changed: Vec<(&str, &[u8])> = changed.iter().map(|(name, bytes)| (name.as_str(), bytes.as_slice())).collect();
    assert!(check_history_chain(changed, Some(&head), &[]).is_err(), "changed");
}

// test/record-history.test.mjs: 'history pages stop at whole rows under the byte cap and retain every row'
#[test]
fn history_pages_stop_at_whole_rows_under_the_byte_cap_and_retain_every_row() {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let mut opened = with_history(&dir.path().join("c.sqlite"), &clock, archived(100, 700), "n1", 9);
    let mut files = Files::default();
    while opened.archive_history_step(ACCOUNT, RESOURCE, &mut files.keep()).unwrap().more {}
    assert!(files.0.len() > 1, "the byte cap split the history");
    let mut rows = 0;
    for bytes in files.0.values() {
        assert!(bytes.len() <= 700, "each file under its cap");
        let text = String::from_utf8(bytes.clone()).unwrap();
        for line in text.trim().lines().skip(1) {
            serde_json::from_str::<serde_json::Value>(line).expect("whole rows only");
            rows += 1;
        }
    }
    assert_eq!(rows, 8, "every row is kept");
    assert_eq!(versions(&opened, "n1"), 1);
}

// test/record-history.test.mjs: 'an oversized first history row stays in SQLite without a file or deletion'
#[test]
fn an_oversized_first_history_row_stays_without_a_file_or_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let mut opened = store(&dir.path().join("d.sqlite"), &clock, archived(10, 64));
    let big = "x".repeat(400);
    let version = write(&mut opened, "n1", 0, &big);
    clock.0.fetch_add(HOUR, Ordering::AcqRel);
    write(&mut opened, "n1", version, "small");
    clock.0.fetch_add(3 * HOUR, Ordering::AcqRel);
    let mut files = Files::default();
    assert_eq!(opened.archive_history_step(ACCOUNT, RESOURCE, &mut files.keep()), Err(crate::cause!(ArchiveError::TooLarge)));
    assert!(files.0.is_empty());
    assert_eq!(versions(&opened, "n1"), 2);
    assert_eq!(opened.history_head(ACCOUNT, RESOURCE).unwrap(), None);
}

// test/record-history.test.mjs: 'a row stays in the database when its file could not be kept', and 'a page kept again
// after a restart names the same previous file, so it is the same bytes'
#[test]
fn a_version_stays_when_its_file_could_not_be_kept_and_the_retry_writes_the_same_bytes_under_the_same_name() {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let path = dir.path().join("e.sqlite");
    let mut opened = with_history(&path, &clock, archived(2, 1 << 20), "n1", 5);
    let mut files = Files::default();
    assert!(opened.archive_history_step(ACCOUNT, RESOURCE, &mut files.keep()).unwrap().more);
    let mut tried = None;
    let refused = opened.archive_history_step(ACCOUNT, RESOURCE, &mut |name, bytes| {
        tried = Some((name.to_string(), bytes.to_vec()));
        Err(HistoryError::new("the files are not reachable".to_string()))
    });
    assert_eq!(refused, Err(ArchiveError::Keep("the files are not reachable".into(), crate::cause!())));
    assert_eq!(versions(&opened, "n1"), 3, "nothing left the store");
    assert_eq!(opened.history_head(ACCOUNT, RESOURCE).unwrap().unwrap().1, 1, "the head did not move");
    drop(opened);
    let mut reopened = store(&path, &clock, archived(2, 1 << 20));
    let step = reopened.archive_history_step(ACCOUNT, RESOURCE, &mut files.keep()).unwrap();
    let (name, bytes) = tried.unwrap();
    assert_eq!(step.file.as_deref(), Some(name.as_str()), "the same file name");
    assert_eq!(files.0[&name], bytes, "the same bytes");
}

// test/record-history.test.mjs: 'archive rejects missing, corrupt, truncated and mislabeled readbacks before history
// advances, then retries'
#[test]
fn archive_rejects_missing_corrupt_truncated_and_mislabeled_readbacks_before_history_advances_then_retries() {
    for failure in ["missing", "corrupt", "truncated", "identity", "encoding", "size", "overflow", "stream"] {
        struct Broken {
            failure: &'static str,
            broken: bool,
            archived: Vec<u8>,
            labels: (String, String),
        }
        impl Keeper for Broken {
            fn put(&mut self, _: &str, bytes: &[u8], blake3_hex: &str, encoding: &str) -> Result<(), HistoryError> {
                self.archived = bytes.to_vec();
                self.labels = (blake3_hex.into(), encoding.into());
                Ok(())
            }
            fn get(&mut self, _: &str) -> Result<Option<KeptObject<'_>>, HistoryError> {
                let broken = |which: &str| self.broken && self.failure == which;
                if broken("missing") {
                    return Ok(None);
                }
                let mut bytes = self.archived.clone();
                if broken("corrupt") {
                    bytes[0] ^= 1;
                }
                if broken("truncated") {
                    bytes.pop();
                }
                if broken("overflow") {
                    bytes = vec![0; self.archived.len() + 1];
                }
                let chunk: Result<Vec<u8>, HistoryError> = if broken("stream") { Err(HistoryError::new("bucket stream failed".to_string())) } else { Ok(bytes) };
                Ok(Some(KeptObject {
                    size: self.archived.len() as u64 + u64::from(broken("size")),
                    blake3: Some(if broken("identity") { "wrong".into() } else { self.labels.0.clone() }),
                    encoding: Some(if broken("encoding") { "plain".into() } else { self.labels.1.clone() }),
                    body: Box::new(std::iter::once(chunk)),
                }))
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let clock = clock();
        let mut opened = with_history(&dir.path().join("f.sqlite"), &clock, archived(10, 1 << 20), "note:retry", 2);
        let mut bucket = Broken { failure, broken: true, archived: Vec::new(), labels: Default::default() };
        let mut observed = Vec::new();
        let refused = opened.archive_history_step(ACCOUNT, RESOURCE, &mut |name, bytes| {
            keep_archive(&mut bucket, name, bytes, &mut |stage, _, _, ok| observed.push((stage.to_string(), ok)), &mut || 0.0).map(|_| ())
        });
        let Err(ArchiveError::Keep(why, _)) = refused else { panic!("{failure}: {refused:?}") };
        assert!(why.contains(if failure == "stream" { "bucket stream failed" } else { "did not" }), "{failure}: {why}");
        assert_eq!(opened.history_head(ACCOUNT, RESOURCE).unwrap(), None, "failed verification cannot advance the chain");
        assert_eq!(versions(&opened, "note:retry"), 2, "failed verification cannot remove a version");
        assert!(!observed.last().unwrap().1);
        bucket.broken = false;
        let moved = opened.archive_history_step(ACCOUNT, RESOURCE, &mut |name, bytes| keep_archive(&mut bucket, name, bytes, &mut |_, _, _, _| {}, &mut || 0.0).map(|_| ())).unwrap();
        assert!(moved.moved > 0, "the same unadvanced page can be retried");
        assert!(opened.history_head(ACCOUNT, RESOURCE).unwrap().is_some());
        assert_eq!(decode_archive(&bucket.archived).map(|plain| history_identity(&plain)).unwrap(), opened.history_head(ACCOUNT, RESOURCE).unwrap().unwrap().0);
    }
}

// test/record-history.test.mjs: 'a large history backlog moves in bounded turns and keeps every row', and 'what one wake
// costs does not grow with the history that is waiting: 4x the backlog moves the same pages'
#[test]
fn a_large_history_backlog_moves_in_bounded_turns_and_keeps_every_row() {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let mut opened = store(&dir.path().join("g.sqlite"), &clock, archived(16, 1 << 20));
    for id in 0..12 {
        let mut version = 0;
        for at in 0..9 {
            version = write(&mut opened, &format!("n{id}"), version, &format!("v{at}"));
            clock.0.fetch_add(60_000, Ordering::AcqRel);
        }
    }
    clock.0.fetch_add(3 * HOUR, Ordering::AcqRel);
    let mut files = Files::default();
    let mut turns = Vec::new();
    loop {
        let step = opened.archive_history_step(ACCOUNT, RESOURCE, &mut files.keep()).unwrap();
        if !step.more {
            break;
        }
        turns.push(step.moved);
    }
    assert!(turns.iter().all(|moved| *moved <= 16), "every turn is bounded");
    assert_eq!(turns.iter().sum::<usize>(), 12 * 8, "every replaced version moved");
    assert_eq!(turns[0], 16, "a turn moves a whole page whatever the backlog");
    for id in 0..12 {
        assert_eq!(versions(&opened, &format!("n{id}")), 1);
    }
}

// test/record-history.test.mjs: 'a pin keeps every change from its place on in the store until it is released'
#[test]
fn a_pin_keeps_every_version_from_its_place_on_in_the_store_until_it_is_released() {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let mut opened = with_history(&dir.path().join("h.sqlite"), &clock, archived(100, 1 << 20), "n1", 7);
    let history = opened.history(ACCOUNT, RESOURCE, "n1", None, 100).unwrap().versions;
    // Pin from the stamp that replaced version 3: versions 3 and newer stay.
    let pin_at = history.iter().find(|version| version.version == 4).unwrap().valid_from;
    opened.pin_history(ACCOUNT, RESOURCE, "audit", pin_at).unwrap();
    assert_eq!(opened.oldest_history_pin(ACCOUNT, RESOURCE).unwrap(), Some(pin_at));
    let mut files = Files::default();
    let step = opened.archive_history_step(ACCOUNT, RESOURCE, &mut files.keep()).unwrap();
    assert_eq!(step.moved, 2, "versions 1 and 2 moved");
    assert!(!opened.archive_history_step(ACCOUNT, RESOURCE, &mut files.keep()).unwrap().more, "the pin holds the rest");
    assert_eq!(versions(&opened, "n1"), 5);
    assert!(opened.release_history_pin(ACCOUNT, RESOURCE, "audit").unwrap());
    assert_eq!(opened.archive_history_step(ACCOUNT, RESOURCE, &mut files.keep()).unwrap().moved, 4);
    assert_eq!(versions(&opened, "n1"), 1);
}

// test/record-history-page-reclaim.test.mjs: 'a pin arriving during verified remote storage refuses reclamation and
// cursor advance'
#[test]
fn a_pin_arriving_while_a_file_is_kept_refuses_the_removal_and_the_head_advance() {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let path = dir.path().join("i.sqlite");
    let mut opened = with_history(&path, &clock, archived(100, 1 << 20), "n1", 4);
    let other = store(&path, &clock, archived(100, 1 << 20));
    let other = std::cell::RefCell::new(other);
    let refused = opened.archive_history_step(ACCOUNT, RESOURCE, &mut |_, _| {
        other.borrow_mut().pin_history(ACCOUNT, RESOURCE, "late", 0).map_err(|error| HistoryError::with_cause(format!("{error:?}"), error.cause()))
    });
    assert_eq!(refused, Err(crate::cause!(ArchiveError::Pinned)));
    assert_eq!(versions(&opened, "n1"), 4);
    assert_eq!(opened.history_head(ACCOUNT, RESOURCE).unwrap(), None);
}

// test/record-history-page-reclaim.test.mjs: 'full recovery leaves every pinned history row and its successors in
// SQLite': the exit step of an archived resource never removes a replaced version, even under the history bound.
#[test]
fn the_exit_step_of_an_archived_resource_leaves_its_replaced_versions_for_the_archive() {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let mut opened = with_history(&dir.path().join("j.sqlite"), &clock, archived(100, 1 << 20), "n1", 4);
    clock.0.fetch_add(settings::shipped().unwrap().undo_windows.records * 2, Ordering::AcqRel);
    opened.retire(ACCOUNT, RESOURCE).unwrap();
    assert_eq!(versions(&opened, "n1"), 4, "past the undo window, still kept: only a kept file lets them leave");
    // A resource the DATA does not name keeps today's rule.
    let mut version = 0;
    for at in 0..3 {
        let value = serde_json::json!({ "kind": "note", "text": at });
        version = opened.mutate(ACCOUNT, "test-ordinary-records", Mutation { id: "o".into(), expected_version: version, request_key: format!("o{at}"), deleted: false, value }).unwrap().version;
    }
    clock.0.fetch_add(settings::shipped().unwrap().undo_windows.records * 2, Ordering::AcqRel);
    opened.retire(ACCOUNT, "test-ordinary-records").unwrap();
    assert_eq!(opened.history(ACCOUNT, "test-ordinary-records", "o", None, 100).unwrap().versions.len(), 1);
    assert_eq!(opened.archive_history_step(ACCOUNT, "test-ordinary-records", &mut |_, _| Ok(())), Err(crate::cause!(ArchiveError::NotArchived)));
}

// restoreRecordHistory (src/record-history.mjs:226): kept history goes back only after its chain checks.
#[test]
fn kept_history_goes_back_only_after_its_chain_checks_and_files_after_the_head_are_left_out() {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let mut opened = with_history(&dir.path().join("k.sqlite"), &clock, archived(2, 1 << 20), "n1", 6);
    let mut files = Files::default();
    while opened.archive_history_step(ACCOUNT, RESOURCE, &mut files.keep()).unwrap().more {}
    assert_eq!(versions(&opened, "n1"), 1);
    let mut names: Vec<String> = files.0.keys().cloned().collect();
    // A changed file: refused with nothing applied.
    let mut changed = files.0.clone();
    changed.get_mut(&names[1]).unwrap().extend_from_slice(b"{}\n");
    let refused = opened.restore_history(ACCOUNT, RESOURCE, &names, &mut |name| Ok(changed.get(name).cloned())).unwrap();
    assert!(refused.is_err());
    assert_eq!(versions(&opened, "n1"), 1, "nothing applied");
    // A file kept after the head (kept, then the store reset before it recorded the page): left out.
    let mut extra = files.0.clone();
    extra.insert("record-history/notes/~after-the-head.jsonl".into(), b"{\"history_chain\":{\"previous\":null}}\n".to_vec());
    names.push("record-history/notes/~after-the-head.jsonl".into());
    let restored = opened.restore_history(ACCOUNT, RESOURCE, &names, &mut |name| Ok(extra.get(name).cloned())).unwrap().unwrap();
    assert_eq!(restored, Restored { files: 3, left_out: 1, rows: 5, applied: 5 });
    assert_eq!(versions(&opened, "n1"), 6, "every version is back");
    let again = opened.restore_history(ACCOUNT, RESOURCE, &names, &mut |name| Ok(extra.get(name).cloned())).unwrap().unwrap();
    assert_eq!(again.applied, 0, "a version the store holds is never replaced");
}

// eraseFromKeptHistory (src/record-history.mjs:262): a rewritten file keeps its name and link; the chain still checks.
#[test]
fn erasure_rewrites_kept_files_without_the_words_and_the_chain_still_checks_through_its_substitutions() {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let mut opened = with_history(&dir.path().join("l.sqlite"), &clock, archived(2, 1 << 20), "secret", 5);
    let mut files = Files::default();
    while opened.archive_history_step(ACCOUNT, RESOURCE, &mut files.keep()).unwrap().more {}
    let (head, _) = opened.history_head(ACCOUNT, RESOURCE).unwrap().unwrap();
    let fields = BTreeMap::from([("secret".to_string(), vec![vec!["text".to_string()]])]);
    let names: Vec<String> = files.0.keys().cloned().collect();
    let kept = std::cell::RefCell::new(files.0.clone());
    let (cursor, substitutions) = erase_from_kept_history(
        &mut |_| Ok((names.clone(), None)),
        &mut |name| Ok(kept.borrow()[name].clone()),
        &mut |name, bytes, substitution| {
            opened.keep_history_substitution(ACCOUNT, RESOURCE, substitution).map_err(|error| HistoryError::with_cause(format!("{error:?}"), error.cause()))?;
            kept.borrow_mut().insert(name.to_string(), bytes.to_vec());
            Ok(())
        },
        &fields,
        None,
    )
    .unwrap();
    assert_eq!(cursor, None);
    assert_eq!(substitutions.len(), 2, "both files held the record");
    let kept = kept.into_inner();
    assert!(kept.values().all(|bytes| !String::from_utf8_lossy(bytes).contains("secret 1")), "the words are gone");
    let stored = opened.history_substitutions(ACCOUNT, RESOURCE).unwrap();
    let all: Vec<(&str, &[u8])> = kept.iter().map(|(name, bytes)| (name.as_str(), bytes.as_slice())).collect();
    assert!(check_history_chain(all.clone(), Some(&head), &[]).is_err(), "without the substitutions the chain breaks");
    assert!(check_history_chain(all, Some(&head), &stored).is_ok(), "with them it holds");
}
