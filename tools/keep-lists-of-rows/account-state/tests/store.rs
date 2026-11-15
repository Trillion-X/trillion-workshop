// tests/store.rs
//
// Purpose: Tests SQLite record mutation, history, retry receipts, concurrent CAS, and read-scope limits.
//
// Non-Negotiable Invariants:
// - Expected versions and request keys protect atomic writes; retries after restart reuse one committed change.
//
// Key Concepts:
// - SQLite mutations use expected-version compare-and-swap and durable request-key receipts.
// - Records, tombstones, and change history retain exact versions; concurrent connections cannot both win one version.
//
// Security Considerations:
// - Uses local in-memory or temporary databases; scope and page-limit failures must not mutate state.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::{json, Value};
use trillion_local::store::{Error, Mutation, Store};
fn put(id: &str, version: i64, key: &str, value: Value) -> Mutation {
    Mutation {
        id: id.into(),
        expected_version: version,
        request_key: key.into(),
        deleted: false,
        value,
    }
}

#[test]
fn one_row_seek_has_one_actual_loop_visit_and_no_write_at_different_sizes() {
    let mut store = Store::open(":memory:").unwrap();
    for n in 0..10_000 {
        store
            .mutate(
                "owner",
                "records",
                put(
                    &format!("id-{n:08}"),
                    0,
                    &format!("create-{n}"),
                    json!({"number":n}),
                ),
            )
            .unwrap();
        if n == 999 || n == 9999 {
            let read = store.get("owner", "records", "id-00000500").unwrap();
            assert_eq!(read.record.unwrap().value, json!({"number":500}));
            assert_eq!(read.work.sql_statements, 1);
            assert_eq!(read.work.sqlite_scan_visits, 1);
            assert_eq!(read.work.fullscan_steps, 0);
            assert_eq!(read.work.rows_written, 0);
            println!("{}", serde_json::to_string(&read.work).unwrap());
        }
    }
    assert!(store
        .get("other-owner", "records", "id-00000500")
        .unwrap()
        .record
        .is_none());
    assert!(store
        .get("owner", "other-resource", "id-00000500")
        .unwrap()
        .record
        .is_none());
}
#[test]
fn create_edit_delete_restore_and_changes_preserve_exact_versions() {
    let mut store = Store::open(":memory:").unwrap();
    assert_eq!(
        store
            .mutate("a", "r", put("x", 0, "one", json!("old")))
            .unwrap()
            .version,
        1
    );
    assert!(matches!(
        store.mutate("a", "r", put("x", 0, "duplicate", json!("wrong"))),
        Err(Error::Conflict(_))
    ));
    store
        .mutate("a", "r", put("x", 1, "two", json!("new")))
        .unwrap();
    store
        .mutate(
            "a",
            "r",
            Mutation {
                id: "x".into(),
                expected_version: 2,
                request_key: "three".into(),
                deleted: true,
                value: Value::Null,
            },
        )
        .unwrap();
    assert!(store.get("a", "r", "x").unwrap().record.is_none());
    store
        .mutate("a", "r", put("x", 3, "four", Value::Null))
        .unwrap();
    let record = store.get("a", "r", "x").unwrap().record.unwrap();
    assert_eq!(record.value, Value::Null);
    assert_eq!(record.version, 4);
    let changes = store.changes("a", "r", 0, 100).unwrap();
    assert_eq!(changes.len(), 4);
    assert!(changes[2].deleted);
    assert!(!changes[3].deleted);
    assert_eq!(store.list("a", "r", "", 100).unwrap().len(), 1);
    assert!(store.changes("b", "r", 0, 100).unwrap().is_empty());
}
#[test]
fn uncertain_reply_retry_after_restart_reuses_one_committed_change() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let first = {
        let mut store = Store::open(&path).unwrap();
        store
            .mutate("a", "r", put("x", 0, "stable-request", json!({"x":1})))
            .unwrap()
    };
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(
        first,
        reopened
            .mutate("a", "r", put("x", 0, "stable-request", json!({"x":1})))
            .unwrap()
    );
    assert!(matches!(
        reopened.mutate("a", "r", put("x", 0, "stable-request", json!({"x":2}))),
        Err(Error::Conflict(_))
    ));
    assert_eq!(reopened.changes("a", "r", 0, 100).unwrap().len(), 1);
}
#[test]
fn competing_connections_cannot_overwrite_same_expected_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let mut a = Store::open(&path).unwrap();
    let mut b = Store::open(&path).unwrap();
    a.mutate("a", "r", put("x", 0, "first", json!(1))).unwrap();
    a.mutate("a", "r", put("x", 1, "second", json!(2))).unwrap();
    assert!(matches!(
        b.mutate("a", "r", put("x", 1, "stale", json!(3))),
        Err(Error::Conflict(_))
    ));
    assert_eq!(
        b.get("a", "r", "x").unwrap().record.unwrap().value,
        json!(2)
    );
    assert_eq!(b.changes("a", "r", 0, 100).unwrap().len(), 2);
}
#[test]
fn read_scope_and_page_limits_are_checked_without_mutation() {
    let store = Store::open(":memory:").unwrap();
    assert!(store.get("", "r", "x").is_err());
    assert!(store.get("a", "r", "x\0y").is_err());
    assert!(store.list("a", "r", "", 0).is_err());
    assert!(store.changes("a", "r", -1, 5).is_err());
}
