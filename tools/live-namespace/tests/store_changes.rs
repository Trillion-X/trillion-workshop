// tests/store_changes.rs
//
// Purpose: The store's change order, its minted ids and its wait, in SQLite and in a real Postgres server (`rows_in_both`): what a
// native folder's change feed and stable item ids stand on. Synthetic data only.

mod rows_in_both;

use live_namespace::store::{Error, Mutation, Rows, SqlStore};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn put(store: &SqlStore, scope: &str, id: &str, expected: i64, key: &str, value: Value) -> Result<live_namespace::store::Change, Error> {
    store.mutate(scope, Mutation { id: id.into(), expected_version: expected, request_key: key.into(), deleted: false, value })
}
fn remove(store: &SqlStore, scope: &str, id: &str, expected: i64, key: &str) -> Result<live_namespace::store::Change, Error> {
    store.mutate(scope, Mutation { id: id.into(), expected_version: expected, request_key: key.into(), deleted: true, value: Value::Null })
}
fn name(id: &str) -> Value {
    json!({ "kind": "namespace-name", "name": id, "file": "1f:aa", "identity": "1f:aa", "byte_length": 1 })
}

#[test]
fn every_change_takes_the_next_number_of_one_order_and_a_walk_after_a_cursor_sees_each_row_once_as_it_is_now() {
    for (database, store) in rows_in_both::both() {
        assert_eq!(store.order().unwrap(), 0, "{database}");
        put(&store, "@namespace/names/A", "/A/1", 0, "1", name("/A/1")).unwrap();
        let cursor = store.order().unwrap();
        put(&store, "@namespace/names/A", "/A/2", 0, "2", name("/A/2")).unwrap();
        put(&store, "@namespace/folders/", "/A", 0, "3", json!({ "kind": "namespace-folder", "folder": "/A" })).unwrap();
        put(&store, "@namespace/chunks", "c", 0, "4", json!({ "kind": "namespace-chunk", "byte_length": 1 })).unwrap();
        let mut again = name("/A/2");
        again["byte_length"] = json!(2);
        put(&store, "@namespace/names/A", "/A/2", 1, "5", again).unwrap();
        remove(&store, "@namespace/names/A", "/A/1", 1, "6").unwrap();
        // The same value again writes nothing and takes no number.
        let order = store.order().unwrap();
        put(&store, "@namespace/folders/", "/A", 1, "7", json!({ "kind": "namespace-folder", "folder": "/A" })).unwrap();
        assert_eq!(store.order().unwrap(), order, "{database}: an unchanged row takes no number");

        let page = store.changes(&["@namespace/names", "@namespace/folders"], cursor, 10).unwrap();
        let seen: Vec<(String, bool, i64)> = page.items.iter().map(|change| (change.id.clone(), change.record.is_some(), change.changed)).collect();
        assert_eq!(seen.iter().map(|(id, live, _)| (id.as_str(), *live)).collect::<Vec<_>>(), [("/A", true), ("/A/2", true), ("/A/1", false)], "{database}");
        assert!(seen.windows(2).all(|pair| pair[0].2 < pair[1].2), "{database}: in the order's own order");
        assert!(page.items.iter().all(|change| change.scope.starts_with("@namespace/names") || change.scope.starts_with("@namespace/folders")), "{database}: a chunk is not a name");
        assert_eq!(page.next, None, "{database}");
        assert_eq!(page.items[1].record.as_ref().unwrap().value["byte_length"], 2, "{database}: a row twice changed is seen once, as it is now");

        // A page at a time: the cursor is the last change's number, and nothing is seen twice or missed.
        let first = store.changes(&["@namespace/names", "@namespace/folders"], cursor, 2).unwrap();
        assert_eq!((first.items.len(), first.next), (2, Some(first.items[1].changed)), "{database}");
        let rest = store.changes(&["@namespace/names", "@namespace/folders"], first.next.unwrap(), 2).unwrap();
        assert_eq!(rest.items.iter().map(|change| change.id.as_str()).collect::<Vec<_>>(), ["/A/1"], "{database}");
        assert!(store.changes(&["@namespace/names"], store.order().unwrap(), 10).unwrap().items.is_empty(), "{database}");
    }
}

#[test]
fn a_minted_id_is_given_by_the_store_kept_through_changes_and_its_tombstone_and_carried_by_a_value_that_holds_it() {
    for (database, store) in rows_in_both::both() {
        let made = put(&store, "@namespace/names/A", "/A/a", 0, "1", name("/A/a")).unwrap();
        let item = made.value.as_ref().unwrap()["item"].as_i64().unwrap();
        assert_eq!(item, made.changed, "{database}: a new row's item is the number of the change that made it");
        // A value without the item replaces the row and keeps it.
        let mut changed = name("/A/a");
        changed["byte_length"] = json!(9);
        let kept = put(&store, "@namespace/names/A", "/A/a", 1, "2", changed).unwrap();
        assert_eq!(kept.value.as_ref().unwrap()["item"], item, "{database}");
        // A rename: the value carried to a new id holds the item; the old id's tombstone keeps it too.
        let carried = store.get("@namespace/names/A", "/A/a").unwrap().record.unwrap().value;
        put(&store, "@namespace/names/B", "/B/a", 0, "3", carried).unwrap();
        remove(&store, "@namespace/names/A", "/A/a", 2, "4").unwrap();
        let (scope, held) = store.minted(&["@namespace/names"], item).unwrap().unwrap();
        assert_eq!((scope.as_str(), held.id.as_str()), ("@namespace/names/B", "/B/a"), "{database}");
        let tombstone = store.changes(&["@namespace/names/A"], 0, 10).unwrap().items.pop().unwrap();
        assert_eq!((tombstone.record.is_none(), tombstone.minted), (true, Some(item)), "{database}");
        // A row made again at an id that was removed is a new row with its own item.
        let again = put(&store, "@namespace/names/A", "/A/a", 3, "5", name("/A/a")).unwrap();
        assert_ne!(again.value.unwrap()["item"], item, "{database}");
        assert!(store.minted(&["@namespace/set-aside/names"], item).unwrap().is_none(), "{database}: only the scopes asked");
        // The retry of a change answers it again, item and all.
        let replay = put(&store, "@namespace/names/A", "/A/a", 3, "5", name("/A/a")).unwrap();
        assert_eq!(replay.version, 4, "{database}");
    }
}

#[test]
fn a_wait_ends_at_once_when_the_order_is_past_the_cursor_at_a_commit_while_it_waits_and_at_its_time_otherwise() {
    for (database, store) in rows_in_both::both() {
        put(&store, "@namespace/names/A", "/A/a", 0, "1", name("/A/a")).unwrap();
        let now = store.order().unwrap();
        assert_eq!(store.wait_for_order(now - 1, Instant::now() + Duration::from_secs(60)).unwrap(), now, "{database}");
        let started = Instant::now();
        assert_eq!(store.wait_for_order(now, started + Duration::from_millis(200)).unwrap(), now, "{database}");
        assert!(started.elapsed() >= Duration::from_millis(200), "{database}: nothing changed, so it waited its time");
        let writer = store.same_database();
        let wrote = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            put(&writer, "@namespace/names/A", "/A/b", 0, "2", name("/A/b")).unwrap();
        });
        let started = Instant::now();
        let woke = store.wait_for_order(now, started + Duration::from_secs(60)).unwrap();
        wrote.join().unwrap();
        assert!(woke > now && started.elapsed() < Duration::from_secs(30), "{database}: a commit wakes the wait");
    }
}

#[test]
fn on_postgres_a_commit_through_another_connection_wakes_a_wait() {
    let (one, two) = rows_in_both::postgres_pair();
    let now = one.order().unwrap();
    let wrote = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        put(&two, "@namespace/names/A", "/A/a", 0, "1", name("/A/a")).unwrap();
    });
    let started = Instant::now();
    let woke = one.wait_for_order(now, started + Duration::from_secs(60)).unwrap();
    wrote.join().unwrap();
    assert!(woke > now && started.elapsed() < Duration::from_secs(30), "the other connection's NOTIFY reached this store");
}

#[test]
fn a_sqlite_store_refuses_a_listening_connection() {
    let store = SqlStore::memory().unwrap();
    assert!(matches!(store.hearing(live_namespace::store::link::Link::memory().unwrap()), Err(Error::Invalid(..))));
}

