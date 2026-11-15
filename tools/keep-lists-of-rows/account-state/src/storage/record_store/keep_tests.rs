// src/storage/record_store/keep_tests.rs
//
// Purpose: A kind's keep rule is a row the person edits and nothing else: the records a firing destroys, the records it keeps
// and the rows it refuses follow from the row's own columns and the condition its formula decides, on a real SQLite store,
// with every number a column and none in the code.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{
    keep::{Applied, Conditions, Row, Rule, Walks},
    settings, Clock, RecordStore,
};
use crate::{
    records::{Mutation, Records},
    storage::sqlite::{self, Bounds, Spend},
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
    time::Duration,
};

type Store = RecordStore<sqlite::Supply<sqlite::Connection>>;

const ACCOUNT: &str = "account";
const RESOURCE: &str = "notes";
const DAY: i64 = 86_400_000;

/// A clock the test moves.
#[derive(Clone)]
struct Moving(Arc<AtomicI64>);
impl Clock for Moving {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// The condition the tests' rows carry as `tree`: `{older_than_ms, status}`, decided here the way the formula engine decides a
/// real tree (that is `rule_bindings::keep_condition`'s own test): a record expires when its status is the tree's and it is
/// older than the tree's number.
struct Decides;
impl Conditions for Decides {
    fn compile(&self, when: &Value, _age_fact: &str) -> Option<Box<dyn FnMut(&Value, u64) -> bool>> {
        let older = when["tree"]["older_than_ms"].as_u64()?;
        let status = when["tree"]["status"].as_str()?.to_owned();
        Some(Box::new(move |value, age| value["status"] == status && age > older))
    }
}

fn bounds() -> Bounds {
    Bounds { value_bytes: 64 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(5) }
}

fn open(path: &Path, clock: &Moving) -> Store {
    let limits = settings::Limits::fixed(1 << 20, 10 << 30);
    RecordStore::new(sqlite::open_owned(path, "record_store", bounds()).unwrap(), Box::new(clock.clone()), limits).unwrap()
}

fn keep() -> &'static super::keep::Settings {
    &settings::shipped().unwrap().keep
}

/// Writes one record of `kind` with `status` at the clock's time.
fn put(store: &mut Store, id: &str, kind: &str, status: &str) {
    let write = Mutation { id: id.to_owned(), expected_version: 0, request_key: format!("w:{id}"), deleted: false, value: json!({"kind": kind, "status": status}) };
    store.mutate(ACCOUNT, RESOURCE, write).unwrap();
}

/// Writes a rule row of the rules kind with the given columns.
fn rule_row(store: &mut Store, id: &str, columns: Value) {
    let mut value = columns;
    value["kind"] = json!(keep().rule_kind);
    let write = Mutation { id: id.to_owned(), expected_version: 0, request_key: format!("r:{id}"), deleted: false, value };
    store.mutate(ACCOUNT, RESOURCE, write).unwrap();
}

fn alive(store: &Store, id: &str) -> bool {
    store.current_record(ACCOUNT, RESOURCE, id).unwrap().is_some()
}

/// A rule destroying `status` records older than `days`.
fn rule(kind: &str, status: &str, days: i64, page: usize, walk: usize) -> Rule {
    Rule { id: "rule".into(), kind: kind.into(), when: json!({"tree": {"older_than_ms": days * DAY, "status": status}, "fields": []}), page, walk }
}

fn decide(rule: &Rule) -> Box<dyn FnMut(&Value, u64) -> bool> {
    Decides.compile(&rule.when, "age_ms").unwrap()
}

fn complete() -> Value {
    json!({"enabled": true, "keeps_kind": "log", "expire_when": {"tree": {"older_than_ms": 7 * DAY, "status": "done"}, "fields": []}, "page": 50, "walk": 500})
}

#[test]
fn a_rows_columns_are_the_whole_rule_and_a_missing_column_is_refused_by_name() {
    let settings = keep();
    let read = |value: Value| Row::read(settings, "r1", &value);
    assert_eq!(
        read(complete()),
        Row::On(Rule { id: "r1".into(), kind: "log".into(), when: complete()["expire_when"].clone(), page: 50, walk: 500 })
    );
    let without = |field: &str| {
        let mut value = complete();
        value.as_object_mut().unwrap().remove(field);
        read(value)
    };
    for field in ["keeps_kind", "expire_when", "page", "walk"] {
        assert!(matches!(without(field), Row::Refused { field: named, .. } if named == field), "{field} left out is refused by its name");
    }
    let mut text_form = complete();
    text_form["expire_when"] = json!(complete()["expire_when"].to_string());
    assert!(matches!(read(text_form), Row::On(_)), "the condition kept as the text of its object is read");
    let mut no_tree = complete();
    no_tree["expire_when"] = json!({"fields": []});
    assert!(matches!(read(no_tree), Row::Refused { field, .. } if field == "expire_when"), "a condition with no tree is refused");
    let mut off = complete();
    off["enabled"] = json!(false);
    assert_eq!(read(off), Row::Off, "a rule the person turned off applies nothing");
    let mut chosen = complete();
    chosen["enabled"] = json!(settings.on_word);
    assert!(matches!(read(chosen), Row::On(_)), "a choice column holding the on word is on");
    let mut other = complete();
    other["enabled"] = json!("off");
    assert_eq!(read(other), Row::Off, "any other word is off");
    let mut walk = complete();
    walk["walk"] = json!(10);
    assert!(matches!(read(walk), Row::Refused { field, .. } if field == "walk"), "a walk shorter than the page is refused");
    let mut itself = complete();
    itself["keeps_kind"] = json!(settings.rule_kind);
    assert!(matches!(read(itself), Row::Refused { .. }), "a rule never keeps the rules themselves");
}

#[test]
fn the_records_the_condition_decides_go_and_the_others_and_other_kinds_stay() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("keep.sqlite");
    let clock = Moving(Arc::new(AtomicI64::new(1_000 * DAY)));
    let mut store = open(&path, &clock);
    for n in 0..3 {
        put(&mut store, &format!("log-done-old-{n}"), "log", "done");
        put(&mut store, &format!("log-waiting-old-{n}"), "log", "waiting");
        put(&mut store, &format!("note-done-old-{n}"), "note", "done");
    }
    clock.0.store(1_010 * DAY, Ordering::SeqCst);
    put(&mut store, "log-done-new", "log", "done");
    let rule = rule("log", "done", 7, 100, 1000);
    let mut walks = Walks::default();
    let step = store.keep_step(ACCOUNT, RESOURCE, &rule, 1_010 * DAY, &mut *decide(&rule), &mut walks).unwrap();
    assert_eq!(step.erased, 3);
    assert!(step.done);
    for n in 0..3 {
        assert!(!alive(&store, &format!("log-done-old-{n}")), "an old done record of the kind is destroyed");
        assert!(alive(&store, &format!("log-waiting-old-{n}")), "an old record the condition does not decide stays");
        assert!(alive(&store, &format!("note-done-old-{n}")), "an old record of another kind stays");
    }
    assert!(alive(&store, "log-done-new"), "a record inside the window stays");
}

#[test]
fn a_step_destroys_at_most_the_rows_page_and_the_sweep_resumes_until_it_reaches_the_end() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("keep.sqlite");
    let clock = Moving(Arc::new(AtomicI64::new(1_000 * DAY)));
    let mut store = open(&path, &clock);
    for n in 0..10 {
        put(&mut store, &format!("log-{n}"), "log", "done");
        clock.0.fetch_add(1, Ordering::SeqCst);
    }
    clock.0.store(1_100 * DAY, Ordering::SeqCst);
    put(&mut store, "log-fresh", "log", "done");
    let rule = rule("log", "done", 7, 4, 100);
    let mut walks = Walks::default();
    let mut expired = decide(&rule);
    let first = store.keep_step(ACCOUNT, RESOURCE, &rule, 1_100 * DAY, &mut *expired, &mut walks).unwrap();
    assert_eq!((first.erased, first.done), (4, false), "one step destroys the page and the sweep is not done");
    let second = store.keep_step(ACCOUNT, RESOURCE, &rule, 1_100 * DAY, &mut *expired, &mut walks).unwrap();
    assert_eq!((second.erased, second.done), (4, false));
    let third = store.keep_step(ACCOUNT, RESOURCE, &rule, 1_100 * DAY, &mut *expired, &mut walks).unwrap();
    assert_eq!((third.erased, third.done), (2, true), "the step that reaches the end of the store ends the sweep");
    assert!(alive(&store, "log-fresh"));
}

#[test]
fn a_walk_past_many_records_of_other_kinds_still_reaches_the_kind() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("keep.sqlite");
    let clock = Moving(Arc::new(AtomicI64::new(1_000 * DAY)));
    let mut store = open(&path, &clock);
    for n in 0..20 {
        put(&mut store, &format!("other-{n}"), "other", "done");
        clock.0.fetch_add(1, Ordering::SeqCst);
    }
    put(&mut store, "log-a", "log", "done");
    clock.0.store(1_100 * DAY, Ordering::SeqCst);
    let rule = rule("log", "done", 7, 5, 5);
    let mut walks = Walks::default();
    let mut expired = decide(&rule);
    let mut erased = 0;
    for _ in 0..10 {
        let step = store.keep_step(ACCOUNT, RESOURCE, &rule, 1_100 * DAY, &mut *expired, &mut walks).unwrap();
        erased += step.erased;
        if step.done {
            break;
        }
    }
    assert_eq!(erased, 1, "a walk of five records at a time finds the record behind twenty others");
    assert!(!alive(&store, "log-a"));
    assert!((0..20).all(|n| alive(&store, &format!("other-{n}"))));
}

#[test]
fn a_firing_reads_the_row_and_an_edit_of_the_row_changes_the_next_firing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("keep.sqlite");
    let clock = Moving(Arc::new(AtomicI64::new(1_000 * DAY)));
    let mut store = open(&path, &clock);
    for n in 0..6 {
        put(&mut store, &format!("log-{n}"), "log", "done");
    }
    rule_row(&mut store, "keep:logs", json!({"enabled": true, "keeps_kind": "log", "expire_when": {"tree": {"older_than_ms": 30 * DAY, "status": "done"}, "fields": []}, "page": 50, "walk": 500}));
    let mut broken = complete();
    broken.as_object_mut().unwrap().remove("page");
    rule_row(&mut store, "keep:broken", broken);
    let mut off = complete();
    off["enabled"] = json!(false);
    rule_row(&mut store, "keep:off", off);
    clock.0.store(1_010 * DAY, Ordering::SeqCst);
    let now = 1_010 * DAY;
    let fire = |store: &mut Store, rule: &str| store.keep_rule(ACCOUNT, RESOURCE, rule, now, &Decides).unwrap();
    match fire(&mut store, "keep:logs") {
        Applied::Stepped(step) => assert_eq!(step.erased, 0, "ten days old is inside the thirty the row says"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(fire(&mut store, "keep:broken"), Applied::Refused(Row::Refused { field, .. }) if field == "page"), "a row that left a column out is refused by name");
    assert_eq!(fire(&mut store, "keep:off"), Applied::Idle, "a rule the person turned off destroys nothing");
    assert_eq!(fire(&mut store, "keep:gone"), Applied::Idle, "a rule whose row is gone destroys nothing");
    assert_eq!(fire(&mut store, "log-0"), Applied::Idle, "a row of another kind is not a rule");
    // The person edits the row: older than 5 days. The next firing reads it and applies it.
    let current = store.current_record(ACCOUNT, RESOURCE, "keep:logs").unwrap().unwrap();
    let mut edited = current.value.clone();
    edited["expire_when"]["tree"]["older_than_ms"] = json!(5 * DAY);
    let write = Mutation { id: "keep:logs".into(), expected_version: current.version, request_key: "edit".into(), deleted: false, value: edited };
    store.mutate(ACCOUNT, RESOURCE, write).unwrap();
    match fire(&mut store, "keep:logs") {
        Applied::Stepped(step) => assert_eq!(step.erased, 6, "the edited number applies at once"),
        other => panic!("{other:?}"),
    }
    assert!((0..6).all(|n| !alive(&store, &format!("log-{n}"))));
    assert!(alive(&store, "keep:logs"), "the rules are never destroyed by a rule");
}

#[test]
fn a_condition_the_formula_engine_cannot_compile_refuses_the_rule_and_destroys_nothing() {
    struct Cannot;
    impl Conditions for Cannot {
        fn compile(&self, _when: &Value, _age_fact: &str) -> Option<Box<dyn FnMut(&Value, u64) -> bool>> {
            None
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("keep.sqlite");
    let clock = Moving(Arc::new(AtomicI64::new(1_000 * DAY)));
    let mut store = open(&path, &clock);
    put(&mut store, "log-a", "log", "done");
    rule_row(&mut store, "keep:logs", complete());
    let applied = store.keep_rule(ACCOUNT, RESOURCE, "keep:logs", 1_100 * DAY, &Cannot).unwrap();
    assert!(matches!(applied, Applied::Refused(Row::Refused { field, .. }) if field == "expire_when"));
    assert!(alive(&store, "log-a"));
}

#[test]
fn a_destroyed_record_stays_restorable_until_the_undo_window_ends() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("keep.sqlite");
    let clock = Moving(Arc::new(AtomicI64::new(1_000 * DAY)));
    let mut store = open(&path, &clock);
    put(&mut store, "log-a", "log", "done");
    clock.0.store(1_010 * DAY, Ordering::SeqCst);
    let rule = rule("log", "done", 7, 10, 100);
    let mut walks = Walks::default();
    store.keep_step(ACCOUNT, RESOURCE, &rule, 1_010 * DAY, &mut *decide(&rule), &mut walks).unwrap();
    let custody: i64 = rusqlite::Connection::open(&path).unwrap().query_row("SELECT count(*) FROM custody WHERE id = 'log-a'", [], |row| row.get(0)).unwrap();
    assert!(custody > 0, "the record went to custody through the store's one destruction, not out of the file");
}
