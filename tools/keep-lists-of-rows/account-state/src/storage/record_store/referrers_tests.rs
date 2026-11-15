// Purpose: `referrers.rs` on a real SQLite record store. Ported one to one from old trillion (tag
// old-trillion-before-worker-retire) test/record-model.test.mjs:27 'participation and sets are answered both ways, in
// order, and follow every change' (its holdersOf half; membersOf/partsOf are `parts_of` here), and
#[test]
fn long_reference_identities_are_lookup_keys_without_becoming_ordinary_record_ids() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("long-reference.sqlite"));
    let target = format!("future-kind:{}", "x".repeat(8192));
    write(
        &mut store,
        "holder",
        Some(json!({"kind":"basket","owner":target})),
    );
    let found = store
        .referrers_of(ACCOUNT, RESOURCE, &target, Some("owner"), None, Some(1))
        .unwrap();
    assert_eq!(ids(&found), ["holder"]);
    assert!(
        matches!(
            store.get(ACCOUNT, RESOURCE, &target),
            Err(Error::Invalid(_, _))
        ),
        "reverse lookup never widens the ordinary record id contract"
    );
}

// test/record-model-read-bounds.test.mjs:91 'wrong-role referrer candidates consume the raw budget and continue even when
// the page has no matches' and :115 'one large repeated-member referrer is finished without scanning every participation
// key'; plus `partsOf`'s own rules (record-model.mjs:224) and a rolled-back write; and record-model.test.mjs:114
// 'records kept before the model are walked once as idle work, and a kind whose parts change is walked again', :139 (its
// referrers half: a store opened empty has nothing to walk), :245 (its parts half) and :283 'an interaction set is a
// record of its own'.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::*;
use crate::records::{Mutation, Records};
use crate::storage::record_store::{settings, Intent, RealClock, SCHEMA};
use crate::storage::sqlite::{self, Bounds, Spend};
use serde_json::json;
use std::time::Duration;

const ACCOUNT: &str = "account";
const RESOURCE: &str = "notes";

fn part(kind: &str, role: &str, path: &[&str], each: Option<&[&str]>) -> ReferrerPart {
    ReferrerPart {
        kind: kind.into(),
        role: role.into(),
        path: path.iter().map(|s| s.to_string()).collect(),
        each: each.map(|each| each.iter().map(|s| s.to_string()).collect()),
        role_from: None,
        id_prefix: None,
        absolute_prefix: None,
        absolute_only: false,
    }
}
/// The old test's MODEL: basket (fruit, owner) and crate (items[].ref).
fn with_parts(parts: Vec<ReferrerPart>) -> &'static settings::Settings {
    let mut chosen = settings::shipped().unwrap().clone();
    chosen.referrer_parts = parts;
    assert!(chosen.valid());
    Box::leak(Box::new(chosen))
}
fn chosen() -> &'static settings::Settings {
    with_parts(vec![
        part("basket", "fruit", &["fruit"], None),
        part("basket", "owner", &["owner"], None),
        part("crate", "item", &["items"], Some(&["ref"])),
    ])
}
type Store = RecordStore<sqlite::Supply<sqlite::Connection>>;
fn open(path: &std::path::Path) -> Store {
    open_with(path, chosen())
}
fn open_with(path: &std::path::Path, chosen: &'static settings::Settings) -> Store {
    let bounds = Bounds {
        value_bytes: 64 << 20,
        work: u64::MAX / 2,
        deadline: Duration::MAX,
        spend: Spend::EachOperation,
        cancel: None,
        busy: Duration::from_secs(5),
    };
    let path = path
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap()
        .join(path.file_name().unwrap());
    RecordStore::with_settings(
        sqlite::open_owned(&path, SCHEMA, bounds).unwrap(),
        Box::new(RealClock),
        chosen,
        settings::Limits::fixed(1 << 22, 10 << 30),
    )
    .unwrap()
}
/// Idle steps until the walk is done (old `for (wakes...; store.maintain().more; ...)`), at most `most` of them.
fn walk_all(store: &mut Store, most: usize) -> usize {
    for wakes in 1..=most {
        if store.walk_referrers(ACCOUNT, RESOURCE, 64).unwrap().done {
            return wakes;
        }
    }
    panic!("the walk did not finish in {most} steps");
}
fn write(store: &mut Store, id: &str, value: Option<serde_json::Value>) {
    let expected = store.held_version(ACCOUNT, RESOURCE, id).unwrap();
    let deleted = value.is_none();
    store
        .mutate(
            ACCOUNT,
            RESOURCE,
            Mutation {
                id: id.into(),
                expected_version: expected,
                request_key: format!("{id}-{expected}"),
                deleted,
                value: value.unwrap_or(serde_json::Value::Null),
            },
        )
        .unwrap();
}
fn ids(page: &Referrers) -> Vec<&str> {
    page.referrers
        .iter()
        .map(|referrer| referrer.id.as_str())
        .collect()
}

#[test]
fn parts_of_follows_the_old_part_rules() {
    let basket =
        json!({ "kind": "basket", "fruit": ["apple", "pear", "a/b", 7, "apple2"], "owner": "ann" });
    let parts = parts_of(&chosen().referrer_parts, Some("basket"), &basket);
    let got: Vec<(&str, &str, Option<usize>)> = parts
        .iter()
        .map(|p| (p.role.as_str(), p.id.as_str(), p.ordinal))
        .collect();
    assert_eq!(
        got,
        [
            ("fruit", "apple", Some(0)),
            ("fruit", "pear", Some(1)),
            ("fruit", "apple2", Some(4)),
            ("owner", "ann", None)
        ],
        "an id with '/' or a number is no part; ordinals stay the list's"
    );
    assert!(
        parts_of(&chosen().referrer_parts, Some("note"), &basket).is_empty(),
        "a kind no row names holds no parts"
    );
    let mut prefixed = part("row", "related", &["to"], None);
    prefixed.id_prefix = Some("row:".into());
    prefixed.absolute_prefix = Some("file:".into());
    prefixed.role_from = Some(vec!["as".into()]);
    let row = json!({ "kind": "row", "to": ["one", "row:two", "file:three"], "as": "  dad " });
    let got: Vec<(String, String)> = parts_of(&[prefixed.clone()], Some("row"), &row)
        .into_iter()
        .map(|p| (p.role, p.id))
        .collect();
    assert_eq!(
        got,
        [
            ("dad".into(), "row:one".into()),
            ("dad".into(), "row:two".into()),
            ("dad".into(), "file:three".into())
        ]
    );
    prefixed.absolute_only = true;
    let got: Vec<String> = parts_of(&[prefixed], Some("row"), &row)
        .into_iter()
        .map(|p| p.id)
        .collect();
    assert_eq!(got, ["file:three"], "absolute_only keeps only absolute ids");
}

// test/record-model.test.mjs:27 (holdersOf)
#[test]
fn referrers_are_answered_in_order_and_follow_every_change() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.sqlite");
    let mut store = open(&path);
    write(
        &mut store,
        "b1",
        Some(
            json!({ "kind": "basket", "label": "one", "fruit": ["apple", "pear", "apple2"], "owner": "ann" }),
        ),
    );
    write(
        &mut store,
        "b2",
        Some(json!({ "kind": "basket", "label": "two", "fruit": ["pear"] })),
    );
    write(
        &mut store,
        "c1",
        Some(
            json!({ "kind": "crate", "items": [{ "ref": "pear", "n": 2 }, { "ref": "fig" }, { "other": 1 }] }),
        ),
    );
    let pear = store
        .referrers_of(ACCOUNT, RESOURCE, "pear", None, None, None)
        .unwrap();
    let got: Vec<(&str, Option<&str>, &str, Option<usize>)> = pear
        .referrers
        .iter()
        .map(|h| (h.id.as_str(), h.kind.as_deref(), h.role.as_str(), h.ordinal))
        .collect();
    assert_eq!(
        got,
        [
            ("b1", Some("basket"), "fruit", Some(1)),
            ("b2", Some("basket"), "fruit", Some(0)),
            ("c1", Some("crate"), "item", Some(0))
        ]
    );
    assert_eq!(
        ids(&store
            .referrers_of(ACCOUNT, RESOURCE, "pear", Some("item"), None, None)
            .unwrap()),
        ["c1"]
    );
    // A change moves the entries; a removal takes them away; a reopened store answers the same.
    write(
        &mut store,
        "b1",
        Some(json!({ "kind": "basket", "label": "one", "fruit": ["fig"] })),
    );
    write(&mut store, "b2", None);
    assert_eq!(
        ids(&store
            .referrers_of(ACCOUNT, RESOURCE, "pear", None, None, None)
            .unwrap()),
        ["c1"]
    );
    let fig = store
        .referrers_of(ACCOUNT, RESOURCE, "fig", None, None, None)
        .unwrap();
    assert_eq!(
        fig.referrers
            .iter()
            .map(|h| (h.id.as_str(), h.ordinal))
            .collect::<Vec<_>>(),
        [("b1", Some(0)), ("c1", Some(1))]
    );
    write(
        &mut store,
        "b3",
        Some(json!({ "kind": "basket", "fruit": ["fig"] })),
    );
    drop(store);
    let again = open(&path);
    assert_eq!(
        ids(&again
            .referrers_of(ACCOUNT, RESOURCE, "fig", None, None, None)
            .unwrap()),
        ["b1", "b3", "c1"]
    );
    assert!(again
        .referrers_of(ACCOUNT, RESOURCE, "ann", None, None, None)
        .unwrap()
        .referrers
        .is_empty());
    // Pages of referrers never split one referrer's entries.
    let first = again
        .referrers_of(ACCOUNT, RESOURCE, "fig", None, None, Some(1))
        .unwrap();
    assert_eq!(
        (ids(&first), first.next.as_deref()),
        (vec!["b1"], Some("b1"))
    );
    assert_eq!(
        ids(&again
            .referrers_of(ACCOUNT, RESOURCE, "fig", None, first.next.as_deref(), None)
            .unwrap()),
        ["b3", "c1"]
    );
}

#[test]
fn a_rolled_back_write_leaves_the_referrers_index_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("b.sqlite"));
    write(
        &mut store,
        "b1",
        Some(json!({ "kind": "basket", "fruit": ["pear"] })),
    );
    store.storage.open_scope(Intent::Write).unwrap();
    write(
        &mut store,
        "b1",
        Some(json!({ "kind": "basket", "fruit": ["fig"] })),
    );
    write(
        &mut store,
        "b2",
        Some(json!({ "kind": "basket", "fruit": ["fig"] })),
    );
    store.storage.close_scope(false).unwrap();
    assert_eq!(
        ids(&store
            .referrers_of(ACCOUNT, RESOURCE, "pear", None, None, None)
            .unwrap()),
        ["b1"]
    );
    assert!(store
        .referrers_of(ACCOUNT, RESOURCE, "fig", None, None, None)
        .unwrap()
        .referrers
        .is_empty());
}

// test/record-model-read-bounds.test.mjs:91
#[test]
fn wrong_role_candidates_consume_the_raw_budget_and_every_empty_page_advances() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("c.sqlite"));
    for index in 0..1200 {
        write(
            &mut store,
            &format!("b{index:04}"),
            Some(json!({ "kind": "basket", "owner": "target" })),
        );
    }
    write(
        &mut store,
        "zz-matching",
        Some(json!({ "kind": "basket", "fruit": ["target"] })),
    );
    let (mut after, mut pages, mut found) = (None::<String>, 0, Vec::new());
    loop {
        let page = store
            .referrers_of(
                ACCOUNT,
                RESOURCE,
                "target",
                Some("fruit"),
                after.as_deref(),
                Some(2),
            )
            .unwrap();
        assert!(page.examined <= 256);
        if pages == 0 {
            assert!(page.referrers.is_empty());
            assert!(page.next.is_some());
        }
        if let (Some(next), Some(after)) = (&page.next, &after) {
            assert!(next > after, "every empty candidate page advances");
        }
        found.extend(page.referrers.into_iter().map(|h| h.id));
        pages += 1;
        assert!(pages < 10);
        match page.next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    assert_eq!(found, ["zz-matching"]);
}

// test/record-model-read-bounds.test.mjs:115
#[test]
fn one_large_repeated_member_referrer_is_finished_without_scanning_every_key() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("d.sqlite"));
    write(
        &mut store,
        "a",
        Some(json!({ "kind": "basket", "fruit": vec!["target"; 1600] })),
    );
    write(
        &mut store,
        "b",
        Some(json!({ "kind": "basket", "fruit": ["target"] })),
    );
    let first = store
        .referrers_of(ACCOUNT, RESOURCE, "target", None, None, Some(1))
        .unwrap();
    assert_eq!(first.examined, 256);
    assert_eq!(first.referrers.len(), 1600);
    assert_eq!(
        first
            .referrers
            .iter()
            .map(|h| h.ordinal)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        1600
    );
    assert_eq!(first.next.as_deref(), Some("a"));
    let last = store
        .referrers_of(
            ACCOUNT,
            RESOURCE,
            "target",
            None,
            first.next.as_deref(),
            Some(1),
        )
        .unwrap();
    assert_eq!(ids(&last), ["b"]);
    assert_eq!(last.next, None);
}

// test/record-model.test.mjs:114
#[test]
fn records_kept_before_their_kind_are_walked_once_as_idle_work_and_a_changed_kind_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("e.sqlite");
    let mut plain = open_with(&path, with_parts(Vec::new()));
    for i in 0..600 {
        write(
            &mut plain,
            &format!("b{i:04}"),
            Some(json!({ "kind": "basket", "fruit": [format!("f{}", i % 3)], "kind_of": i })),
        );
    }
    drop(plain);
    let mut store = open(&path);
    let before = store
        .referrers_of(ACCOUNT, RESOURCE, "f1", None, None, None)
        .unwrap();
    assert!(!before.complete);
    assert!(
        before.referrers.is_empty(),
        "unknown, not absent, until walked"
    );
    assert!(store.referrers_pending(ACCOUNT, RESOURCE).unwrap());
    let wakes = walk_all(&mut store, 50);
    assert!(wakes >= 600 / 64, "one bounded page a step");
    let walked = store
        .referrers_of(ACCOUNT, RESOURCE, "f1", None, None, Some(1000))
        .unwrap();
    assert!(walked.complete);
    assert_eq!(walked.referrers.len(), 200);
    drop(store);
    assert!(
        open(&path)
            .referrers_of(ACCOUNT, RESOURCE, "f1", None, None, None)
            .unwrap()
            .complete,
        "the walk is kept across a restart"
    );
    // A kind whose parts change has its records walked again.
    let mut store = open(&path);
    for i in 0..300 {
        write(
            &mut store,
            &format!("row:jars:{i}"),
            Some(json!({ "kind": "jar", "title": "t", "next": ["row:jars:0"] })),
        );
    }
    assert!(store
        .referrers_of(ACCOUNT, RESOURCE, "row:jars:0", None, None, None)
        .unwrap()
        .referrers
        .is_empty());
    drop(store);
    let mut parts = chosen().referrer_parts.clone();
    parts.push(part("jar", "next", &["next"], None));
    let mut store = open_with(&path, with_parts(parts));
    assert!(
        !store
            .referrers_of(ACCOUNT, RESOURCE, "row:jars:0", None, None, None)
            .unwrap()
            .complete
    );
    walk_all(&mut store, 50);
    assert_eq!(
        store
            .referrers_of(ACCOUNT, RESOURCE, "row:jars:0", None, None, Some(1000))
            .unwrap()
            .referrers
            .len(),
        300
    );
    assert!(
        store
            .referrers_of(ACCOUNT, RESOURCE, "f1", None, None, None)
            .unwrap()
            .complete,
        "the unchanged basket kind is not walked again"
    );
}

// test/record-model.test.mjs:139 (referrers half) and :245 (parts half)
#[test]
fn a_store_opened_empty_has_nothing_to_walk_and_a_stopped_walk_resumes_where_it_stood() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("f.sqlite");
    let mut store = open(&path);
    assert!(
        !store.referrers_pending(ACCOUNT, RESOURCE).unwrap(),
        "nothing written, nothing to walk"
    );
    write(
        &mut store,
        "b1",
        Some(json!({ "kind": "basket", "fruit": ["kiwi"] })),
    );
    assert_eq!(
        ids(&store
            .referrers_of(ACCOUNT, RESOURCE, "kiwi", None, None, None)
            .unwrap()),
        ["b1"],
        "a live write is indexed by itself"
    );
    assert!(
        !store.referrers_pending(ACCOUNT, RESOURCE).unwrap(),
        "a kind's first record, written while it is named, leaves nothing to walk"
    );
    drop(store);
    // As a store kept before the kind was named.
    let path = dir.path().join("f2.sqlite");
    let mut plain = open_with(&path, with_parts(Vec::new()));
    for i in 0..3000 {
        write(
            &mut plain,
            &format!("note{i:05}"),
            Some(json!({ "kind": "note", "words": format!("w{i}") })),
        );
    }
    write(
        &mut plain,
        "zy-basket",
        Some(json!({ "kind": "basket", "fruit": ["plum"] })),
    );
    write(
        &mut plain,
        "zz-basket",
        Some(json!({ "kind": "basket", "fruit": ["plum"] })),
    );
    drop(plain);
    let mut store = open(&path);
    // The walk goes over the kinds with parts along their own lists, never over the 3,000 notes.
    let first = store.walk_referrers(ACCOUNT, RESOURCE, 1).unwrap();
    assert_eq!(
        (first.kind.as_deref(), first.walked, first.done),
        (Some("basket"), 1, false)
    );
    drop(store);
    let mut store = open(&path);
    let second = store.walk_referrers(ACCOUNT, RESOURCE, 1).unwrap();
    assert_eq!(
        (second.walked, second.done),
        (1, true),
        "a reopened store walks on from the record after its cursor"
    );
    assert_eq!(
        ids(&store
            .referrers_of(ACCOUNT, RESOURCE, "plum", None, None, None)
            .unwrap()),
        ["zy-basket", "zz-basket"]
    );
}

// test/record-model.test.mjs:283
#[test]
fn an_interaction_set_is_named_by_its_members_in_order_and_read_by_name() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("g.sqlite");
    let mut store = open(&path);
    write(
        &mut store,
        "b1",
        Some(json!({ "kind": "basket", "fruit": ["apple", "pear"] })),
    );
    write(
        &mut store,
        "b2",
        Some(json!({ "kind": "basket", "fruit": ["apple", "pear"] })),
    );
    write(
        &mut store,
        "b3",
        Some(json!({ "kind": "basket", "fruit": ["pear", "apple"] })),
    );
    let one = store
        .sets_of(ACCOUNT, RESOURCE, "b1")
        .unwrap()
        .unwrap()
        .remove(0);
    assert_eq!(
        (one.role.as_str(), one.members.clone()),
        ("fruit", vec!["apple".to_string(), "pear".to_string()])
    );
    assert_eq!(
        store.sets_of(ACCOUNT, RESOURCE, "b2").unwrap().unwrap()[0].set,
        one.set,
        "the same members in the same order are one set"
    );
    assert_ne!(
        store.sets_of(ACCOUNT, RESOURCE, "b3").unwrap().unwrap()[0].set,
        one.set,
        "order is part of a set"
    );
    let named = store
        .set(ACCOUNT, RESOURCE, &one.set, None)
        .unwrap()
        .unwrap();
    assert_eq!(named.members, ["apple", "pear"]);
    assert_eq!(
        named.referrers,
        [
            ("b1".into(), Some("basket".into()), "fruit".into()),
            ("b2".into(), Some("basket".into()), "fruit".into())
        ]
    );
    assert!(named.complete);
    let pear = store
        .referrers_of(ACCOUNT, RESOURCE, "pear", None, None, None)
        .unwrap();
    assert_eq!(
        pear.referrers
            .iter()
            .map(|h| (h.id.as_str(), h.set.as_deref() == Some(one.set.as_str())))
            .collect::<Vec<_>>(),
        [("b1", true), ("b2", true), ("b3", false)]
    );
    // A referrer that changes its members leaves the set; a set nobody holds is no set; a reopened store answers the same.
    write(
        &mut store,
        "b1",
        Some(json!({ "kind": "basket", "fruit": ["fig"] })),
    );
    assert_eq!(
        store
            .set(ACCOUNT, RESOURCE, &one.set, None)
            .unwrap()
            .unwrap()
            .referrers
            .iter()
            .map(|h| h.0.as_str())
            .collect::<Vec<_>>(),
        ["b2"]
    );
    write(&mut store, "b2", None);
    assert_eq!(store.set(ACCOUNT, RESOURCE, &one.set, None).unwrap(), None);
    drop(store);
    let again = open(&path);
    let fig = again
        .sets_of(ACCOUNT, RESOURCE, "b1")
        .unwrap()
        .unwrap()
        .remove(0);
    assert_eq!(
        again
            .set(ACCOUNT, RESOURCE, &fig.set, None)
            .unwrap()
            .unwrap()
            .members,
        ["fig"]
    );
    assert_eq!(
        set_name(&["apple".into(), "pear".into()]).len(),
        "set:".len() + 32
    );
}
