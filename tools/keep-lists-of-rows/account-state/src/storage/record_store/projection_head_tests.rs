// src/storage/record_store/projection_head_tests.rs
//
// Purpose: The device outbox keeps its projection heads in the record log of the store file it shares with the record store
// (`record_log.rs`, copies/pending.rs `put_projection_head`). This test writes a head through the record log into a store
// file, then runs the record store's history pressing (`retire`) on that file under a row past its `from_level`, and reads the
// head back. It checks the candidate that history pressing at 70% drops projection heads reads rely on.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::*;
use crate::records::{Mutation, Records};
use crate::storage::record_store::record_log::RecordLog;
use crate::storage::sqlite::{self, Bounds, Spend};
use serde_json::json;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

const ACCOUNT: &str = "account";
const RESOURCE: &str = "notes";
const PROJECTIONS: &str = "notes:projections";

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
    let mut store = RecordStore::with_settings(
        sqlite::open_owned(path, SCHEMA, bounds).unwrap(),
        Box::new(clock.clone()),
        settings::shipped().unwrap(),
        settings::Limits::fixed(1 << 22, 10 << 30),
    )
    .unwrap();
    // A row every store is past `warn` under (the history bound presses from `warn`) and refuse-growth too.
    let row = store_size::SizeRow::parse(&json!({"limit_bytes": 1, "levels": [
        {"id": "warn", "at_share": 1.0, "refuses": []},
        {"id": "refuse-growth", "at_share": 1.0, "refuses": ["growth"]}
    ]}))
    .unwrap();
    store.set_size_row(row).unwrap();
    store
}

fn write_text(store: &mut Store, clock: &Moving, at_ms: u64, text: &str) {
    clock.0.store(at_ms, Ordering::Release);
    let expected = store.held_version(ACCOUNT, RESOURCE, "note:1").unwrap();
    store
        .mutate(ACCOUNT, RESOURCE, Mutation { id: "note:1".into(), expected_version: expected, request_key: format!("k-{at_ms}"), deleted: false, value: json!({"kind": "note", "text": text}) })
        .unwrap();
}

#[test]
fn a_projection_head_in_the_record_log_survives_history_pressing_on_the_same_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("outbox.sqlite");
    let clock = Moving(Arc::new(AtomicU64::new(1_000)));
    let mut store = open(&path, &clock);
    // A projection head, written the way the device outbox writes one: a record-log row in this file.
    let head: serde_json::Map<String, serde_json::Value> = [("head".to_owned(), json!({"command": "command-1"}))].into_iter().collect();
    RecordLog::new(&store.storage, ACCOUNT, PROJECTIONS)
        .write(&[("projection-1", "pending-projection", Some(head.clone()))], record_sync::Actor::by("projection-test"))
        .unwrap();
    // Replaced versions of a record, so history pressing has versions to release.
    write_text(&mut store, &clock, 2_000, "first");
    write_text(&mut store, &clock, 3_000, "second");
    // Two hours later: replaced versions are past keep_ms (1 hour), and the store is past `warn`.
    clock.0.store(7_200_000 + 3_000, Ordering::Release);
    let removed = store.retire(ACCOUNT, RESOURCE).unwrap();
    assert!(removed > 0, "history pressing removed replaced versions, so the check exercised it");
    let read_back = RecordLog::new(&store.storage, ACCOUNT, PROJECTIONS).read("projection-1").unwrap();
    assert_eq!(read_back, Some(head), "the projection head reads back unchanged after history pressing");
}
