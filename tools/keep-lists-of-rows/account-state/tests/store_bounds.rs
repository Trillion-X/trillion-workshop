// tests/store_bounds.rs
//
// Purpose: Tests bounded SQLite paging, continuation, retained history, tombstones, and oversized stored values.
//
// Non-Negotiable Invariants:
// - Pages obey serialized-byte and work limits without losing ordered continuation, tombstones, null values, or retry history.
//
// Key Concepts:
// - Keyset continuation pages bound returned rows, serialized bytes, and SQLite scan work.
// - Live-row indexes skip tombstones while change cursors preserve history, nulls, and scope across continuation.
//
// Security Considerations:
// - Temporary fixture databases only; corrupt oversized rows and invalid bounds return explicit errors rather than truncated success.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Exercises actual Store page queries, retained history and bounded output.
use serde_json::{json, Value};
use trillion_local::store::{Error, Mutation, Store, MAX_PAGE_BYTES, MAX_RECORD_BYTES};

fn put(id: &str, expected_version: i64, request_key: &str, value: Value) -> Mutation {
    Mutation {
        id: id.into(),
        expected_version,
        request_key: request_key.into(),
        deleted: false,
        value,
    }
}
fn delete(id: &str, expected_version: i64, request_key: &str) -> Mutation {
    Mutation {
        deleted: true,
        ..put(id, expected_version, request_key, Value::Null)
    }
}

#[test]
fn live_limit_one_and_all_deleted_skip_growing_tombstone_prefixes() {
    for count in [100, 2000] {
        let mut store = Store::open(":memory:").unwrap();
        for n in 0..count {
            let id = format!("a-{n:06}");
            store
                .mutate("a", "r", put(&id, 0, &format!("create-{n}"), json!(n)))
                .unwrap();
            store
                .mutate("a", "r", delete(&id, 1, &format!("delete-{n}")))
                .unwrap();
        }
        let empty = store.list_page("a", "r", "", 1).unwrap();
        assert!(empty.items.is_empty());
        assert!(empty.next.is_none());
        assert_eq!(empty.work.sqlite_scan_visits, 0);
        assert_eq!(empty.work.fullscan_steps, 0);
        assert_eq!(empty.work.rows_written, 0);
        assert!(empty.work.vm_steps < 40, "{:#?}", empty.work);
        store
            .mutate("a", "r", put("z-live", 0, "create-live", json!("live")))
            .unwrap();
        let page = store.list_page("a", "r", "", 1).unwrap();
        assert_eq!(page.items[0].id, "z-live");
        assert_eq!(page.work.sql_statements, 1);
        assert_eq!(page.work.sqlite_scan_visits, 1);
        assert_eq!(page.work.fullscan_steps, 0);
        assert_eq!(page.work.rows_written, 0);
        assert!(page.work.vm_steps < 60, "{:#?}", page.work);
        println!(
            "tombstones={count} empty={} live={}",
            serde_json::to_string(&empty.work).unwrap(),
            serde_json::to_string(&page.work).unwrap()
        );
        // Restoration updates the same index transactionally without removing history.
        store
            .mutate("a", "r", put("a-000000", 2, "restore", Value::Null))
            .unwrap();
        let restored = store.list_page("a", "r", "", 1).unwrap();
        assert_eq!(restored.items[0].version, 3);
        assert_eq!(restored.items[0].value, Value::Null);
        assert_eq!(restored.next.as_deref(), Some("a-000000"));
        assert_eq!(
            store
                .list_page("a", "r", restored.next.as_ref().unwrap(), 1)
                .unwrap()
                .items[0]
                .id,
            "z-live"
        );
        assert!(store
            .list_page("other", "r", "", 1)
            .unwrap()
            .items
            .is_empty());
        assert!(store
            .list_page("a", "other", "", 1)
            .unwrap()
            .items
            .is_empty());
        assert_eq!(store.changes("a", "r", 0, 2).unwrap().len(), 2);
    }
}

#[test]
fn maximum_sized_records_page_completely_without_materializing_all_requested_rows() {
    let mut store = Store::open(":memory:").unwrap();
    let value = Value::String("x".repeat(MAX_RECORD_BYTES - 2));
    assert_eq!(serde_json::to_vec(&value).unwrap().len(), MAX_RECORD_BYTES);
    for n in 0..16 {
        store
            .mutate(
                "a",
                "r",
                put(
                    &format!("id-{n:03}"),
                    0,
                    &format!("create-{n}"),
                    value.clone(),
                ),
            )
            .unwrap();
    }
    let mut after = String::new();
    let mut ids = Vec::new();
    loop {
        let page = store.list_page("a", "r", &after, 1000).unwrap();
        assert!(!page.items.is_empty());
        let encoded = serde_json::to_vec(&page.items).unwrap();
        assert_eq!(encoded.len(), page.serialized_item_bytes);
        assert!(encoded.len() <= MAX_PAGE_BYTES);
        assert!(page.items.len() <= 3);
        assert!(page.work.rows_returned <= 4, "{:#?}", page.work);
        assert!(page.work.sqlite_scan_visits <= 4, "{:#?}", page.work);
        assert_eq!(page.work.rows_written, 0);
        for item in &page.items {
            assert_eq!(item.value, value);
            ids.push(item.id.clone());
        }
        match page.next {
            Some(next) => {
                assert_eq!(Some(&next), ids.last());
                after = next;
            }
            None => break,
        }
    }
    assert_eq!(
        ids,
        (0..16).map(|n| format!("id-{n:03}")).collect::<Vec<_>>()
    );
    let mut after = 0;
    let mut sequences = Vec::new();
    loop {
        let page = store.changes_page("a", "r", after, 1000).unwrap();
        assert!(!page.items.is_empty());
        assert_eq!(
            serde_json::to_vec(&page.items).unwrap().len(),
            page.serialized_item_bytes
        );
        assert!(page.serialized_item_bytes <= MAX_PAGE_BYTES);
        assert!(page.items.len() <= 3);
        assert!(page.work.rows_returned <= 4, "{:#?}", page.work);
        assert!(page.work.sqlite_scan_visits <= 4, "{:#?}", page.work);
        for item in &page.items {
            assert_eq!(item.value.as_ref(), Some(&value));
            sequences.push(item.sequence);
        }
        match page.next {
            Some(next) => {
                assert_eq!(Some(&next), sequences.last());
                after = next;
            }
            None => break,
        }
    }
    assert_eq!(sequences, (1..=16).collect::<Vec<_>>());
}

#[test]
fn escaped_ids_and_values_are_counted_as_actual_serialized_bytes() {
    let mut store = Store::open(":memory:").unwrap();
    for n in 0..100 {
        let id = format!("{n:03}{}", "\n\t\\\"".repeat(1000));
        store
            .mutate(
                "a",
                "r",
                put(&id, 0, &format!("create-{n}"), json!("\n\\\"".repeat(8000))),
            )
            .unwrap();
    }
    let mut after = String::new();
    let mut total = 0;
    loop {
        let page = store.list_page("a", "r", &after, 1000).unwrap();
        assert!(!page.items.is_empty());
        assert_eq!(
            page.serialized_item_bytes,
            serde_json::to_vec(&page.items).unwrap().len()
        );
        assert!(page.serialized_item_bytes <= MAX_PAGE_BYTES);
        total += page.items.len();
        match page.next {
            Some(next) => after = next,
            None => break,
        }
    }
    assert_eq!(total, 100);
}

#[test]
fn oversized_stored_item_refuses_explicitly_instead_of_empty_or_truncated_success() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let mut store = Store::open(&path).unwrap();
    store
        .mutate("a", "r", put("x", 0, "one", json!("ok")))
        .unwrap();
    drop(store);
    let connection = rusqlite::Connection::open(&path).unwrap();
    let oversized = serde_json::to_vec(&Value::String("x".repeat(MAX_RECORD_BYTES))).unwrap();
    connection
        .execute("UPDATE records SET body=?", [&oversized])
        .unwrap();
    connection
        .execute("UPDATE changes SET body=?", [&oversized])
        .unwrap();
    drop(connection);
    let store = Store::open(path).unwrap();
    assert!(matches!(
        store.list_page("a", "r", "", 1000),
        Err(Error::Invalid(_, _))
    ));
    assert!(matches!(
        store.changes_page("a", "r", 0, 1000),
        Err(Error::Invalid(_, _))
    ));
}

#[test]
fn old_database_gets_live_index_without_losing_retry_cas_or_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let mut store = Store::open(&path).unwrap();
    let original = store
        .mutate("a", "r", put("x", 0, "one", json!(1)))
        .unwrap();
    store.mutate("a", "r", delete("x", 1, "two")).unwrap();
    drop(store);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("DROP INDEX records_live").unwrap();
    drop(connection);
    let mut store = Store::open(path).unwrap();
    assert_eq!(
        store
            .mutate("a", "r", put("x", 0, "one", json!(1)))
            .unwrap(),
        original
    );
    assert!(matches!(
        store.mutate("a", "r", put("x", 1, "stale", json!(9))),
        Err(Error::Conflict(_))
    ));
    let empty = store.list_page("a", "r", "", 1).unwrap();
    assert!(empty.items.is_empty());
    assert_eq!(empty.work.sqlite_scan_visits, 0);
    store
        .mutate("a", "r", put("x", 2, "restore", json!(2)))
        .unwrap();
    assert_eq!(store.list("a", "r", "", 1).unwrap()[0].version, 3);
    assert_eq!(store.changes("a", "r", 0, 100).unwrap().len(), 3);
}

#[test]
fn change_continuation_ignores_other_scopes_and_keeps_tombstones_and_nulls() {
    let mut store = Store::open(":memory:").unwrap();
    for n in 0..1000 {
        store
            .mutate(
                "other",
                "r",
                put(&format!("id-{n}"), 0, &format!("k-{n}"), json!(n)),
            )
            .unwrap();
    }
    store
        .mutate("a", "r", put("x", 0, "one", Value::Null))
        .unwrap();
    store.mutate("a", "r", delete("x", 1, "two")).unwrap();
    let first = store.changes_page("a", "r", 0, 1).unwrap();
    assert_eq!(first.items[0].value, Some(Value::Null));
    assert!(!first.items[0].deleted);
    assert_eq!(first.next, Some(first.items[0].sequence));
    assert!(first.work.sqlite_scan_visits <= 2, "{:#?}", first.work);
    let last = store
        .changes_page("a", "r", first.next.unwrap(), 1)
        .unwrap();
    assert!(last.items[0].deleted);
    assert_eq!(last.items[0].value, None);
    assert!(last.next.is_none());
    assert_eq!(last.work.sqlite_scan_visits, 1);
    assert_eq!(last.work.fullscan_steps, 0);
    assert_eq!(last.work.rows_written, 0);
    assert!(store.list_page("a", "r", &"x".repeat(4097), 1).is_err());
}
