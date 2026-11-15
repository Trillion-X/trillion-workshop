// Purpose: `RecordStore::record_at`, the point-in-time read ("the record as saved at a moment"), on a real SQLite record
// store with a clock the test moves. Ported from old trillion (tag old-trillion-before-worker-retire)
// parts/record-log/do-work/record-log-store.mjs:4203 `recordAt(id, { known })`: a moment before the record answers
// nothing, each moment answers the version current then (a deletion as a tombstone), and a moment the kept versions no
// longer reach answers incomplete with the earliest moment it is good for.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::*;
use crate::records::{Mutation, Records};
use crate::storage::record_store::{settings, Clock, SCHEMA};
use crate::storage::sqlite::{self, Bounds, Spend};
use serde_json::json;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

const ACCOUNT: &str = "account";
const RESOURCE: &str = "notes";

#[derive(Clone)]
struct Moving(Arc<AtomicU64>);
impl Clock for Moving {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Acquire) as i64
    }
}
type Store = RecordStore<sqlite::Supply<sqlite::Connection>>;
fn open(path: &std::path::Path, clock: &Moving) -> Store {
    let bounds = Bounds { value_bytes: 64 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(5) };
    RecordStore::with_settings(sqlite::open_owned(path, SCHEMA, bounds).unwrap(), Box::new(clock.clone()), settings::shipped().unwrap(), settings::Limits::fixed(1 << 22, 10 << 30)).unwrap()
}
fn write(store: &mut Store, clock: &Moving, at_ms: u64, value: Option<serde_json::Value>) {
    clock.0.store(at_ms, Ordering::Release);
    let expected = store.held_version(ACCOUNT, RESOURCE, "note:1").unwrap();
    let deleted = value.is_none();
    store.mutate(ACCOUNT, RESOURCE, Mutation { id: "note:1".into(), expected_version: expected, request_key: format!("k-{expected}"), deleted, value: value.unwrap_or(serde_json::Value::Null) }).unwrap();
}
fn text_at(store: &Store, at_ms: u64) -> Option<String> {
    let at = store.record_at(ACCOUNT, RESOURCE, "note:1", at_ms).unwrap();
    assert!(at.complete);
    at.version.and_then(|v| v.value).map(|value| value["text"].as_str().unwrap().to_owned())
}

#[test]
fn a_record_reads_as_it_was_saved_at_each_moment() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Moving(Arc::new(AtomicU64::new(1_000)));
    let mut store = open(&dir.path().join("a.sqlite"), &clock);
    write(&mut store, &clock, 1_000, Some(json!({ "kind": "note", "text": "one" })));
    write(&mut store, &clock, 2_000, Some(json!({ "kind": "note", "text": "two" })));
    write(&mut store, &clock, 3_000, None);
    write(&mut store, &clock, 4_000, Some(json!({ "kind": "note", "text": "four" })));
    assert_eq!(text_at(&store, 999), None, "before its first save there was no record");
    assert_eq!(text_at(&store, 1_000).as_deref(), Some("one"), "a moment includes what was saved in it");
    assert_eq!(text_at(&store, 1_999).as_deref(), Some("one"));
    assert_eq!(text_at(&store, 2_000).as_deref(), Some("two"));
    let deleted = store.record_at(ACCOUNT, RESOURCE, "note:1", 3_500).unwrap();
    assert!(deleted.complete && deleted.version.as_ref().unwrap().deleted, "a deletion reads as a tombstone");
    assert_eq!(text_at(&store, 4_000).as_deref(), Some("four"));
    assert_eq!(text_at(&store, u64::MAX).as_deref(), Some("four"), "any later moment reads the current version");
    let never = store.record_at(ACCOUNT, RESOURCE, "note:never", 5_000).unwrap();
    assert_eq!((never.version, never.complete), (None, true));
}

#[test]
fn a_moment_the_kept_versions_no_longer_reach_is_answered_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Moving(Arc::new(AtomicU64::new(1_000)));
    let path = dir.path().join("b.sqlite");
    let mut store = open(&path, &clock);
    write(&mut store, &clock, 1_000, Some(json!({ "kind": "note", "text": "one" })));
    write(&mut store, &clock, 2_000, Some(json!({ "kind": "note", "text": "two" })));
    drop(store);
    // The replaced first version leaves the store (as the exit step lets replaced versions go).
    let db = rusqlite::Connection::open(&path).unwrap();
    let gone = db.execute("DELETE FROM versions WHERE id = 'note:1' AND version = 1", []).unwrap();
    assert_eq!(gone, 1);
    drop(db);
    let store = open(&path, &clock);
    let at = store.record_at(ACCOUNT, RESOURCE, "note:1", 1_500).unwrap();
    assert_eq!(at.version, None);
    assert!(!at.complete, "a version that was current then is no longer in the store");
    assert_eq!(at.kept_from, Some(2_000));
    assert_eq!(text_at(&store, 2_000).as_deref(), Some("two"));
}

// An `overwrite` resource (`record_store_resources.json` `history`) keeps no history, but the versions a copy of the
// store wrote before that rule still sit in its file. Each exit step releases them in bounded steps, and the current row
// is untouched.
const OVERWRITE: &str = "@held-values";
const LEGACY_ID: &str = "snapshot";
const LEGACY_VERSIONS: i64 = 3_000;

/// The replaced versions (valid_to before the current row's largest stamp) of one record, read from the file.
fn replaced_versions(path: &std::path::Path, resource: &str, id: &str) -> i64 {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT count(*) FROM versions WHERE account = ?1 AND resource = ?2 AND id = ?3 AND valid_to != 9223372036854775807",
            rusqlite::params![ACCOUNT, resource, id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn an_overwrite_resource_drains_its_legacy_versions_in_bounded_steps() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("vault.sqlite");
    let now_ms: u64 = 1_000_000_000_000;
    let clock = Moving(Arc::new(AtomicU64::new(now_ms)));
    {
        let mut store = open(&path, &clock);
        let write = Mutation { id: LEGACY_ID.into(), expected_version: 0, request_key: "current".into(), deleted: false, value: json!({ "text": "current" }) };
        store.mutate(ACCOUNT, OVERWRITE, write).unwrap();
    }
    // Versions replaced a day and a half ago, one second apart, as an overwrite-era file held them before the rule: past the
    // vault's one-day undo window (settings.json undo_windows.vault), so they are due to leave.
    let legacy = rusqlite::Connection::open(&path).unwrap();
    for k in 0..LEGACY_VERSIONS {
        let stamp = (((now_ms - 129_600_000) as i64) + k * 1_000) << 16;
        legacy.execute(
            "INSERT INTO versions (account, resource, id, valid_to, valid_from, version, deleted, body, ring, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, NULL, 'snapshot')",
            rusqlite::params![ACCOUNT, OVERWRITE, LEGACY_ID, stamp, stamp - (1_000 << 16), k + 1, br#"{"text":"old"}"#.to_vec()],
        ).unwrap();
    }
    drop(legacy);
    // A copy of the vault (no other computer takes its history), so only its undo window holds versions back.
    crate::storage::record_store::holders::set_guard(&path, crate::storage::record_store::HolderGuard::Copy);
    let mut store = open(&path, &clock);
    let step = store.settings().exit_step_rows;
    let mut steps = 0;
    loop {
        let removed = store.retire(ACCOUNT, OVERWRITE).unwrap();
        assert!(removed as usize <= step, "an exit step removes at most exit_step_rows versions");
        if removed == 0 { break; }
        steps += 1;
    }
    assert!(steps >= (LEGACY_VERSIONS as usize) / step, "the legacy versions leave over several steps, not one");
    assert_eq!(replaced_versions(&path, OVERWRITE, LEGACY_ID), 0, "no replaced version is left");
    assert_eq!(store.held_version(ACCOUNT, OVERWRITE, LEGACY_ID).unwrap(), 1, "the current version is kept");
    assert_eq!(store.get(ACCOUNT, OVERWRITE, LEGACY_ID).unwrap().record.unwrap().value["text"], "current");
}

#[test]
fn a_keep_resource_leaves_versions_inside_the_undo_window_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Moving(Arc::new(AtomicU64::new(1_000_000_000_000)));
    let path = dir.path().canonicalize().unwrap().join("notes.sqlite");
    let mut store = open(&path, &clock);
    for (n, value) in ["one", "two", "three"].iter().enumerate() {
        let expected = store.held_version(ACCOUNT, RESOURCE, "note:1").unwrap();
        clock.0.fetch_add(1_000, Ordering::AcqRel);
        store.mutate(ACCOUNT, RESOURCE, Mutation { id: "note:1".into(), expected_version: expected, request_key: format!("k{n}"), deleted: false, value: json!({ "kind": "note", "text": value }) }).unwrap();
    }
    assert_eq!(store.retire(ACCOUNT, RESOURCE).unwrap(), 0, "nothing has left the undo window");
    assert_eq!(replaced_versions(&path, RESOURCE, "note:1"), 2, "both replaced versions are still kept");
    assert_eq!(text_at(&store, 1_000_000_000_000 + 1_000).as_deref(), Some("one"));
}
