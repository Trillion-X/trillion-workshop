// Purpose: `partial.rs` on a real SQLite record store. Ported from old trillion (tag old-trillion-before-worker-retire)
// test/eeaf-selected-fields.test.mjs (4), test/eeaf-scoped-list.test.mjs (the scoped read/write, oversized and list
// member tests: 5), test/eeaf-record-memory.test.mjs (6) and test/eeaf-memory-bounds.test.mjs (the bounded memory and
// the budget checked before parse: 3), onto the record store that is live for own records; each test names its old one.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::*;
use crate::storage::record_store::{settings, RealClock, SCHEMA};
use crate::storage::sqlite::{self, Bounds, Spend};
use serde_json::json;
use std::time::Duration;

const ACCOUNT: &str = "account";
const RESOURCE: &str = "notes";
const BIG: usize = 1 << 20;

fn bounds() -> Bounds {
    Bounds { value_bytes: 64 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(5) }
}
fn open(path: &std::path::Path) -> RecordStore<sqlite::Supply<sqlite::Connection>> {
    RecordStore::new(sqlite::open_owned(path, SCHEMA, bounds()).unwrap(), Box::new(RealClock), settings::Limits::fixed(1 << 22, 10 << 30)).unwrap()
}
fn put(store: &mut RecordStore<sqlite::Supply<sqlite::Connection>>, id: &str, value: serde_json::Value) -> i64 {
    let expected = store.held_version(ACCOUNT, RESOURCE, id).unwrap();
    store.mutate(ACCOUNT, RESOURCE, Mutation { id: id.into(), expected_version: expected, request_key: format!("{id}-{expected}"), deleted: false, value }).unwrap().version
}
fn object(value: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    value.as_object().unwrap().clone()
}

// test/eeaf-selected-fields.test.mjs: 'selected scalars admit aggregate size before fetching the refused value'
#[test]
fn selected_scalars_admit_their_aggregate_size_before_decoding_any() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("a.sqlite"));
    put(&mut store, "h", json!({ "a": "x".repeat(40), "b": "y".repeat(40) }));
    assert_eq!(store.read_selected(ACCOUNT, RESOURCE, "h", &["a", "b"], BIG, 64), Err(PartialError::TooLarge { cause: crate::cause!(), bytes: 84 }));
    assert_eq!(store.read_selected(ACCOUNT, RESOURCE, "h", &["a"], BIG, 64).unwrap().unwrap()["a"], "x".repeat(40), "one alone fits");
}

// test/eeaf-selected-fields.test.mjs: 'selected child assembly inherits the remaining parent allowance'
#[test]
fn selected_children_share_one_allowance_with_their_siblings() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("b.sqlite"));
    put(&mut store, "h", json!({ "a": { "text": "x".repeat(40) }, "b": { "text": "y".repeat(40) } }));
    assert!(matches!(store.read_selected(ACCOUNT, RESOURCE, "h", &["a", "b"], BIG, 64), Err(PartialError::TooLarge { .. })));
    assert!(store.read_selected(ACCOUNT, RESOURCE, "h", &["a", "b"], BIG, 128).is_ok());
}

// test/eeaf-selected-fields.test.mjs: 'selected shared siblings use the ordinary isolated-clone owner'
#[test]
fn selected_equal_siblings_are_separate_copies() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("c.sqlite"));
    let value = json!({ "shared": true, "text": "whole" });
    put(&mut store, "h", json!({ "a": value, "b": value }));
    put(&mut store, "other", json!({ "a": value }));
    let mut out = store.read_selected(ACCOUNT, RESOURCE, "h", &["a", "b"], BIG, BIG).unwrap().unwrap();
    assert_eq!(out["a"], value);
    out["a"]["text"] = json!("changed locally");
    assert_eq!(out["b"]["text"], "whole");
    assert_eq!(store.read_selected(ACCOUNT, RESOURCE, "other", &["a"], BIG, BIG).unwrap().unwrap()["a"]["text"], "whole");
}

// test/eeaf-selected-fields.test.mjs: 'selected keys preserve null false and encoded names, without unrelated fields'
#[test]
fn selected_keys_preserve_null_false_and_encoded_names_without_unrelated_fields() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("d.sqlite"));
    put(&mut store, "h", json!({ "nil": null, "no": false, "a/b": { "text": "whole" }, "omitted": { "text": "not selected" } }));
    let selected = store.read_selected(ACCOUNT, RESOURCE, "h", &["nil", "no", "a/b", "absent", "nil"], BIG, BIG).unwrap().unwrap();
    assert_eq!(serde_json::Value::Object(selected), json!({ "nil": null, "no": false, "a/b": { "text": "whole" } }));
    assert_eq!(store.read_selected(ACCOUNT, RESOURCE, "h", &[], BIG, BIG).unwrap().unwrap(), serde_json::Map::new());
    assert_eq!(store.read_selected(ACCOUNT, RESOURCE, "missing", &["nil"], BIG, BIG).unwrap(), None);
    assert!(matches!(store.read_selected(ACCOUNT, RESOURCE, "h", &[""], BIG, BIG), Err(PartialError::Shape(_, _))));
}

// test/eeaf-scoped-list.test.mjs: 'a scoped root read and write omit a large scalar and a large child list without
// changing either'
#[test]
fn a_scoped_read_and_write_omit_a_large_scalar_and_a_large_list_without_changing_either() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("e.sqlite"));
    let large = "z".repeat(5000);
    let list: Vec<serde_json::Value> = (0..200).map(|n| json!({ "n": n })).collect();
    let version = put(&mut store, "r", json!({ "title": "t", "blob": large, "items": list }));
    let own = store.read_own(ACCOUNT, RESOURCE, "r", &["blob", "items"], BIG, 64).unwrap().unwrap();
    assert_eq!(serde_json::Value::Object(own), json!({ "title": "t" }), "the omitted fields are not counted against the budget");
    store.write_own(ACCOUNT, RESOURCE, "r", &object(json!({ "title": "renamed", "blob": "ignored" })), &["blob", "items"], version, "rename", BIG).unwrap();
    let whole = store.read_selected(ACCOUNT, RESOURCE, "r", &["title", "blob", "items"], BIG, BIG).unwrap().unwrap();
    assert_eq!(whole["title"], "renamed");
    assert_eq!(whole["blob"], large, "the omitted scalar is as it was");
    assert_eq!(whole["items"].as_array().unwrap().len(), 200, "the omitted list is as it was");
}

// test/eeaf-scoped-list.test.mjs: 'an oversized value never crosses the SQLite cursor and keeps exact refusal details',
// and test/eeaf-memory-bounds.test.mjs: 'JSON array expansion is rejected before JSON.parse allocates the expanded value'
#[test]
fn an_oversized_body_never_leaves_storage_and_its_size_is_answered_without_reading_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("f.sqlite"));
    put(&mut store, "r", json!({ "items": vec![0; 3000] }));
    let size = store.record_size(ACCOUNT, RESOURCE, "r").unwrap().unwrap();
    assert!(size > 3000);
    assert_eq!(store.read_own(ACCOUNT, RESOURCE, "r", &[], 1024, BIG), Err(PartialError::TooLarge { cause: crate::cause!(), bytes: size }), "the exact stored size");
    let mut memory = RecordMemory::new(8, BIG);
    assert_eq!(memory.read(&store, ACCOUNT, RESOURCE, "r", 1024), Err(PartialError::TooLarge { cause: crate::cause!(), bytes: size }), "refused before it is parsed");
    assert_eq!(memory.held(), (0, 0));
    assert_eq!(store.record_size(ACCOUNT, RESOURCE, "none").unwrap(), None);
}

// test/eeaf-scoped-list.test.mjs: 'an empty scalar list becomes a member set and fresh readers see append and replacement'
#[test]
fn an_empty_list_takes_members_and_fresh_readers_see_append_and_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("g.sqlite");
    let mut store = open(&path);
    put(&mut store, "r", json!({ "title": "t", "steps": [] }));
    assert_eq!(store.member_count(ACCOUNT, RESOURCE, "r", "steps", BIG).unwrap(), 0);
    store.write_member(ACCOUNT, RESOURCE, "r", "steps", 0, &json!({ "text": "one", "done": false }), "m0", BIG).unwrap();
    store.write_member(ACCOUNT, RESOURCE, "r", "steps", 1, &json!({ "text": "two", "done": true }), "m1", BIG).unwrap();
    store.write_member(ACCOUNT, RESOURCE, "r", "steps", 0, &json!({ "text": "first", "done": true }), "m0b", BIG).unwrap();
    let fresh = open(&path);
    assert_eq!(fresh.member_count(ACCOUNT, RESOURCE, "r", "steps", BIG).unwrap(), 2);
    assert_eq!(fresh.read_member(ACCOUNT, RESOURCE, "r", "steps", 0, BIG).unwrap(), Some(json!({ "text": "first", "done": true })));
    assert_eq!(fresh.read_member(ACCOUNT, RESOURCE, "r", "steps", 2, BIG).unwrap(), None);
    assert_eq!(fresh.members_where(ACCOUNT, RESOURCE, "r", "steps", "done", &json!(true), BIG).unwrap(), [0, 1]);
    assert_eq!(fresh.members_where(ACCOUNT, RESOURCE, "r", "steps", "text", &json!("two"), BIG).unwrap(), [1]);
    assert_eq!(fresh.read_selected(ACCOUNT, RESOURCE, "r", &["title"], BIG, BIG).unwrap().unwrap()["title"], "t", "the other fields stay");
}

// test/eeaf-scoped-list.test.mjs: 'append refuses an existing scalar or object field and an ordinal gap without writing
// history'
#[test]
fn append_refuses_a_scalar_or_object_field_and_an_ordinal_gap_without_writing_history() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("h.sqlite"));
    put(&mut store, "r", json!({ "title": "t", "meta": { "a": 1 }, "steps": [] }));
    let before = store.history(ACCOUNT, RESOURCE, "r", None, 100).unwrap().versions.len();
    for (field, ordinal) in [("title", 0), ("meta", 0), ("steps", 1)] {
        assert!(matches!(store.write_member(ACCOUNT, RESOURCE, "r", field, ordinal, &json!({ "x": 1 }), "no", BIG), Err(PartialError::Shape(_, _))), "{field}");
    }
    assert!(matches!(store.write_member(ACCOUNT, RESOURCE, "r", "steps", 0, &json!("not an object"), "no", BIG), Err(PartialError::Shape(_, _))));
    assert_eq!(store.history(ACCOUNT, RESOURCE, "r", None, 100).unwrap().versions.len(), before, "no version was written");
}

// test/eeaf-record-memory.test.mjs: 'an unchanged record is read again with no statement, and a write makes the next
// read fresh'
#[test]
fn an_unchanged_record_is_answered_from_memory_without_reading_its_body_and_a_write_makes_the_next_read_fresh() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("i.sqlite"));
    put(&mut store, "r", json!({ "n": 1 }));
    let mut memory = RecordMemory::new(8, BIG);
    assert_eq!(memory.read(&store, ACCOUNT, RESOURCE, "r", BIG).unwrap(), Some(json!({ "n": 1 })));
    let before = store.work();
    assert_eq!(memory.read(&store, ACCOUNT, RESOURCE, "r", BIG).unwrap(), Some(json!({ "n": 1 })));
    let after = store.work();
    assert_eq!(after.rows_read, before.rows_read + 1, "only the scope's stamp is read, never the body: {before:?} -> {after:?}");
    put(&mut store, "r", json!({ "n": 2 }));
    assert_eq!(memory.read(&store, ACCOUNT, RESOURCE, "r", BIG).unwrap(), Some(json!({ "n": 2 })));
}

// test/eeaf-record-memory.test.mjs: 'a copy handed out never changes what the store remembers'
#[test]
fn a_copy_handed_out_never_changes_what_the_memory_holds() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("j.sqlite"));
    put(&mut store, "r", json!({ "list": [1, 2] }));
    let mut memory = RecordMemory::new(8, BIG);
    let mut copy = memory.read(&store, ACCOUNT, RESOURCE, "r", BIG).unwrap().unwrap();
    copy["list"] = json!([]);
    assert_eq!(memory.read(&store, ACCOUNT, RESOURCE, "r", BIG).unwrap(), Some(json!({ "list": [1, 2] })));
}

// test/eeaf-record-memory.test.mjs: 'a write rolled back by the host leaves no remembered value behind'
#[test]
fn a_refused_write_leaves_the_remembered_value_as_committed() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("k.sqlite"));
    let version = put(&mut store, "r", json!({ "n": 1 }));
    let mut memory = RecordMemory::new(8, BIG);
    memory.read(&store, ACCOUNT, RESOURCE, "r", BIG).unwrap();
    let stale = store.mutate(ACCOUNT, RESOURCE, Mutation { id: "r".into(), expected_version: version + 5, request_key: "stale".into(), deleted: false, value: json!({ "n": 9 }) });
    assert!(stale.is_err());
    assert_eq!(memory.read(&store, ACCOUNT, RESOURCE, "r", BIG).unwrap(), Some(json!({ "n": 1 })));
}

// test/eeaf-record-memory.test.mjs: 'a member written into a list makes its record read fresh, and a second store over
// the same database shares the memory'
#[test]
fn a_member_written_makes_its_record_read_fresh_and_another_store_over_the_same_file_is_seen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("l.sqlite");
    let mut store = open(&path);
    put(&mut store, "r", json!({ "steps": [] }));
    let mut memory = RecordMemory::new(8, BIG);
    memory.read(&store, ACCOUNT, RESOURCE, "r", BIG).unwrap();
    store.write_member(ACCOUNT, RESOURCE, "r", "steps", 0, &json!({ "t": 1 }), "m", BIG).unwrap();
    assert_eq!(memory.read(&store, ACCOUNT, RESOURCE, "r", BIG).unwrap(), Some(json!({ "steps": [{ "t": 1 }] })));
    let mut other = open(&path);
    put(&mut other, "r", json!({ "steps": [] }));
    assert_eq!(memory.read(&store, ACCOUNT, RESOURCE, "r", BIG).unwrap(), Some(json!({ "steps": [] })), "another handle's commit is seen");
}

// test/eeaf-record-memory.test.mjs: 'the remembered records stay bounded in count and bytes, and a record too big to
// keep is read every time', and test/eeaf-memory-bounds.test.mjs: 'what a store remembers stays bounded however many
// records are written, and writes stay correct'
#[test]
fn the_memory_stays_bounded_in_count_and_bytes_and_a_record_too_big_to_keep_is_read_every_time() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("m.sqlite"));
    for n in 0..50 {
        put(&mut store, &format!("r{n}"), json!({ "n": n, "pad": "p".repeat(20) }));
    }
    put(&mut store, "huge", json!({ "pad": "h".repeat(2000) }));
    let mut memory = RecordMemory::new(10, 400);
    for n in 0..50 {
        assert_eq!(memory.read(&store, ACCOUNT, RESOURCE, &format!("r{n}"), BIG).unwrap().unwrap()["n"], n);
        let (count, bytes) = memory.held();
        assert!(count <= 10 && bytes <= 400, "{count} records, {bytes} bytes");
    }
    assert!(memory.held().0 > 0);
    memory.read(&store, ACCOUNT, RESOURCE, "huge", BIG).unwrap();
    assert!(memory.held().1 <= 400, "the huge record is not kept");
    let before = store.work();
    memory.read(&store, ACCOUNT, RESOURCE, "huge", BIG).unwrap();
    assert!(store.work().rows_read >= before.rows_read + 2, "it is read again: the stamp and the body");
    put(&mut store, "r49", json!({ "n": 490 }));
    assert_eq!(memory.read(&store, ACCOUNT, RESOURCE, "r49", BIG).unwrap().unwrap()["n"], 490, "writes stay correct");
}
