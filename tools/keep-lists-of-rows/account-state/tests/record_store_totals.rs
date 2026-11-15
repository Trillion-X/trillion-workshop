// tests/record_store_totals.rs
//
// Purpose: record store declared totals (`src/storage/record_store/totals.rs`, DATA in `settings.json` `totals`) stay equal to the live
// records of their kind through every write path: import, create, an update that keeps the group, an update that
// moves the group, delete, erase and restore, across resource scopes of one account, and never across accounts.
// Key concepts: the shipped totals `namespace-file/origin` (group by origin, sum of byte_length) and
// `namespace-name/all` (count only).
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::{json, Value};
use trillion_local::{
    records::{Mutation, Records},
    storage::{
        memory::Memory,
        record_store::{settings, totals::Total, RecordStore, RealClock},
    },
};

fn store() -> RecordStore<Memory> {
    RecordStore::new(Memory::open("record_store").unwrap(), Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap()
}

fn file(origin: &str, bytes: i64) -> Value {
    json!({ "kind": "namespace-file", "origin": origin, "byte_length": bytes })
}

fn write(store: &mut RecordStore<Memory>, resource: &str, id: &str, version: i64, deleted: bool, value: Value) {
    let request_key = format!("{resource}:{id}:{version}");
    store.mutate("a", resource, Mutation { id: id.into(), expected_version: version, request_key, deleted, value }).unwrap();
}

fn of(store: &RecordStore<Memory>, account: &str, total: &str) -> Vec<(Option<String>, i64, i64)> {
    store
        .totals(account)
        .unwrap()
        .into_iter()
        .filter(|row: &Total| row.total == total)
        .map(|row| (row.group, row.count, row.sum))
        .filter(|(_, count, sum)| (*count, *sum) != (0, 0))
        .collect()
}

#[test]
fn totals_follow_every_write_path() {
    let mut store = store();
    store.import("a", "@namespace/files", &[("f1".into(), file("r2", 10)), ("f2".into(), file("r2", 5)), ("f3".into(), file("b2", 100))]).unwrap();
    assert_eq!(of(&store, "a", "namespace-file/origin"), [(Some("b2".into()), 1, 100), (Some("r2".into()), 2, 15)]);

    write(&mut store, "@namespace/files", "f4", 0, false, file("b2", 1));
    write(&mut store, "@namespace/files", "f1", 1, false, file("r2", 12));
    assert_eq!(of(&store, "a", "namespace-file/origin"), [(Some("b2".into()), 2, 101), (Some("r2".into()), 2, 17)], "an update keeps the count and moves the sum");

    write(&mut store, "@namespace/files", "f2", 1, false, file("b2", 5));
    assert_eq!(of(&store, "a", "namespace-file/origin"), [(Some("b2".into()), 3, 106), (Some("r2".into()), 1, 12)], "a group move moves the count");

    write(&mut store, "@namespace/files", "f3", 1, true, Value::Null);
    assert_eq!(of(&store, "a", "namespace-file/origin"), [(Some("b2".into()), 2, 6), (Some("r2".into()), 1, 12)], "a delete leaves its group");

    let erased = store.erase("a", "@namespace/files", "f1").unwrap().unwrap();
    assert_eq!(of(&store, "a", "namespace-file/origin"), [(Some("b2".into()), 2, 6)], "an erase leaves its group");
    assert!(store.restore(&erased, "a", "@namespace/files", "f1").unwrap());
    assert_eq!(of(&store, "a", "namespace-file/origin"), [(Some("b2".into()), 2, 6), (Some("r2".into()), 1, 12)], "a restore rejoins it");
}

#[test]
fn a_total_adds_up_every_scope_of_one_account_only() {
    let mut store = store();
    for folder in ["/a", "/b", "/c"] {
        let names: Vec<(String, Value)> = (0..3).map(|n| (format!("{folder}/{n}"), json!({ "kind": "namespace-name" }))).collect();
        store.import("a", &format!("@namespace/names{folder}"), &names).unwrap();
    }
    store.import("other", "@namespace/names/a", &[("/a/x".into(), json!({ "kind": "namespace-name" }))]).unwrap();
    store.import("a", "@namespace/names/a", &[("/a/note".into(), json!({ "kind": "something-else" }))]).unwrap();
    assert_eq!(of(&store, "a", "namespace-name/all"), [(None, 9, 0)]);
    assert_eq!(of(&store, "other", "namespace-name/all"), [(None, 1, 0)]);
}

#[test]
fn a_sum_that_is_not_an_integer_refuses_the_write() {
    let mut store = store();
    let refused = store.mutate("a", "@namespace/files", Mutation { id: "f".into(), expected_version: 0, request_key: "k".into(), deleted: false, value: file("r2", 1).as_object().cloned().map(|mut value| { value.insert("byte_length".into(), json!("1")); Value::Object(value) }).unwrap() });
    assert!(refused.is_err());
    assert!(of(&store, "a", "namespace-file/origin").is_empty());
}

/// The shipped settings with the shipped totals taken out: a store kept before its totals were declared.
fn without_totals(root: &Memory) -> RecordStore<Memory> {
    let mut chosen = settings::shipped().unwrap().clone();
    chosen.totals = Vec::new();
    RecordStore::with_settings(root.reopen(), Box::new(RealClock), Box::leak(Box::new(chosen)), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap()
}

// Old trillion test/record-log-store.test.mjs:1182 'exact type counts survive replay, rollback and a bounded
// old-projection upgrade' (its unknown half). For a person: a total declared after its records exist is unknown, never
// a guess, until its fill is done; the fill walks every scope of the account in bounded steps while writes arrive, and
// the total is then exact. A total counted from its declaration is adopted as it is.
#[test]
fn a_total_declared_after_its_records_is_unknown_until_filled_then_exact() {
    let root = Memory::open("record_store").unwrap();
    let mut plain = without_totals(&root);
    for n in 0..30 {
        write(&mut plain, "@namespace/files", &format!("f{n:02}"), 0, false, file(if n % 3 == 0 { "b2" } else { "r2" }, n));
    }
    for n in 0..5 {
        write(&mut plain, "own-records", &format!("o{n}"), 0, false, file("r2", 100));
    }
    drop(plain);
    let mut store = RecordStore::new(root.reopen(), Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap();
    let origin = "namespace-file/origin";
    assert!(store.total_known("a", origin).unwrap(), "no fill kept: taken as counted (the case of every store before fills)");
    // The first step finds no rows and no fill: the records were written before the total, so it fills.
    assert!(!store.fill_total("a", "own-records", origin, 4).unwrap());
    assert!(!store.total_known("a", origin).unwrap(), "unknown, never a guess, while it fills");
    let mut steps = 0;
    let mut wrote = false;
    while !store.fill_total("a", "own-records", origin, 4).unwrap() {
        steps += 1;
        assert!(steps < 100);
        if steps == 3 && !wrote {
            // Writes arrive during the fill: an edit, a new record and a removal, in both scopes.
            write(&mut store, "@namespace/files", "f00", 1, false, file("b2", 1000));
            write(&mut store, "@namespace/files", "f99", 0, false, file("b2", 7));
            write(&mut store, "@namespace/files", "f01", 1, true, Value::Null);
            write(&mut store, "own-records", "o0", 1, true, Value::Null);
            wrote = true;
        }
    }
    assert!(store.total_known("a", origin).unwrap());
    // Expected: files f00..f29 (f01 removed, f00 now b2/1000), f99 b2/7, own-records o1..o4 r2/100.
    let (mut b2, mut r2) = ((0, 0), (0, 0));
    for n in 0..30i64 {
        if n == 1 { continue; }
        let (origin, bytes) = if n == 0 { ("b2", 1000) } else if n % 3 == 0 { ("b2", n) } else { ("r2", n) };
        let at = if origin == "b2" { &mut b2 } else { &mut r2 };
        at.0 += 1;
        at.1 += bytes;
    }
    b2.0 += 1;
    b2.1 += 7;
    r2.0 += 4;
    r2.1 += 400;
    assert_eq!(of(&store, "a", origin), [(Some("b2".into()), b2.0, b2.1), (Some("r2".into()), r2.0, r2.1)], "exact after the fill, writes during it included once");
    assert!(store.fill_total("a", "own-records", origin, 4).unwrap(), "a filled total stays filled");
}

#[test]
fn a_total_counted_from_its_declaration_is_adopted_as_it_is() {
    let mut store = store();
    write(&mut store, "@namespace/files", "f1", 0, false, file("r2", 10));
    assert!(store.fill_total("a", "own-records", "namespace-file/origin", 4).unwrap(), "adopted in one step");
    assert_eq!(of(&store, "a", "namespace-file/origin"), [(Some("r2".into()), 1, 10)]);
}
