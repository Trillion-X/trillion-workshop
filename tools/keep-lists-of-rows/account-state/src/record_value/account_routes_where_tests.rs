// src/record_value/account_routes_where_tests.rs
//
// Purpose: Prove a door list with a field-equality `where` on the person's one Checks list (`record:check`) costs the
// rows that match, not the rows the list holds. The Workshop reads that list only this way: tool:start-a-decision's
// methods are `where {kind: "branch"}`, a step's checks `where {step}` and `where {id}`
// (trillion-workshop tools/decide-with-a-method/read-data/decisions.mjs methodsOf, catalogueAt), and a branch's lineage
// `where {part_of}`, `{extends}` or `{method}` (tools/check-against-a-persons-rules-and-verdicts/do-work/check-a-branch.mjs).
// Measured 2026-11-05 on the person's Mac engine: about 40,707 check rows (12 branch, 965 step, 642 check, 39,088 piece),
// and `where {kind: "branch"}` walked the whole list for 8.2 s while holding the account, so the next call waited past
// its deadline and was answered `selected_owner_unavailable`.
//
// Non-Negotiable Invariants:
// - Each of those fields has a declared record store order over `record:check` (src/storage/record_store/settings.json
//   `orders`, the old engine's src/record-indexes.json way: one declared index per question, never a scan), so a filtered
//   page is one range scan of the run of equal values plus one get per row shown.
// - A filtered read of 50,000 rows answers exactly the rows a brute-force filter finds, opening no more records than it
//   shows (plus the few the row's list fields cost), and in time close to the same read of an empty store.
// - While an order is still being filled for rows kept before it was declared (idle upkeep, `RecordStore::fill_order`),
//   the same read answers the same rows by the row walk instead of being refused; a page continued from a row-walk
//   page continues the row walk even once the order is filled, so a caller paging across the fill sees every row once.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::*;
use crate::record_value::list::tests::Prefilled;
use std::time::{Duration, Instant};

const KIND: &str = "record:check";
const ROWS: usize = 50_000;
const BRANCHES: usize = 12;
const STEPS: usize = 1_200;
const CHECKS: usize = 800;

/// The seeded list, in the person's proportions scaled to 50,000: 12 branches, 1,200 steps (100 a branch), 800 checks (two
/// thirds of the steps hold one), and pieces for the rest, each piece part of a step.
fn rows() -> Vec<(String, Value)> {
    let mut rows = Vec::with_capacity(ROWS);
    for b in 0..BRANCHES {
        let extends = if b == 0 { Value::Null } else { json!("branch:0") };
        rows.push((format!("check:branch:{b}"), json!({"id": format!("branch:{b}"), "kind": "branch", "name": format!("Method {b}"),
            "part_of": extends.clone(), "extends": extends, "steps": []})));
    }
    for s in 0..STEPS {
        rows.push((format!("check:step:{s}"), json!({"id": format!("step:{s}"), "kind": "step", "part_of": format!("branch:{}", s % BRANCHES),
            "ask": format!("Step {s}?")})));
    }
    for c in 0..CHECKS {
        rows.push((format!("check:check:{c}"), json!({"id": format!("check:{c}"), "kind": "check", "step": format!("step:{}", c % STEPS),
            "method": format!("branch:{}", c % BRANCHES), "question": format!("Does check {c} hold?"), "on": "On"})));
    }
    for p in 0..ROWS - rows.len() {
        rows.push((format!("check:piece:{p}"), json!({"id": format!("piece:{p}"), "kind": "piece", "part_of": format!("step:{}", p % STEPS),
            "part": "w".repeat(80)})));
    }
    assert_eq!(rows.len(), ROWS);
    rows
}

fn seeded(rows: &[(String, Value)]) -> Prefilled {
    seeded_into(Prefilled::new(), rows)
}

fn seeded_into<S: crate::storage::Storage + Send>(mut prefilled: Prefilled<S>, rows: &[(String, Value)]) -> Prefilled<S> {
    for (id, value) in rows {
        prefilled.put(id, KIND, value.clone());
    }
    prefilled
}

/// Every row of every page of `input`, the records opened and the wall time it took, every order filled beforehand.
fn read_all<S: crate::storage::Storage + Send>(prefilled: &mut Prefilled<S>, mut input: Value) -> (Vec<String>, usize, Duration) {
    let door = Door::shipped().unwrap();
    let model = crate::record_model_policy::list_rule_model();
    let (opened, started) = (prefilled.opened, Instant::now());
    let mut ids = Vec::new();
    for _ in 0..10_000 {
        let page = door.answer(door.list_operation(), &input, prefilled, model, Limits::default(), &crate::mcp::tool_answer_fits).unwrap();
        ids.extend(page["records"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap().to_owned()));
        match page["next"].as_str() {
            Some(next) => input["after"] = json!(next),
            None => return (ids, prefilled.opened - opened, started.elapsed()),
        }
    }
    panic!("the paging ends");
}

/// The ids a brute-force filter of `rows` finds for `field` = `wanted`, sorted.
fn matching(rows: &[(String, Value)], field: &str, wanted: &Value) -> Vec<String> {
    let mut ids: Vec<String> = rows.iter().filter(|(_, value)| &value[field] == wanted).map(|(id, _)| id.clone()).collect();
    ids.sort();
    ids
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

/// The six `where`s the Workshop reads the Checks list by, with the value each asks for.
fn questions() -> [(&'static str, Value); 6] {
    [("kind", json!("branch")), ("step", json!("step:17")), ("id", json!("check:42")), ("part_of", json!("branch:3")),
        ("extends", json!("branch:0")), ("method", json!("branch:5"))]
}

#[test]
fn a_where_on_fifty_thousand_check_rows_costs_the_rows_that_match_not_the_list() {
    let rows = rows();
    costs_the_rows_that_match(seeded(&rows), Prefilled::new(), &rows);
}

/// The same over the SQLite supply an account keeps its records in on the Mac (`storage::sqlite`, one file).
#[test]
fn a_where_on_fifty_thousand_check_rows_over_sqlite_costs_the_rows_that_match_not_the_list() {
    let folder = tempfile::tempdir().unwrap();
    let open = |name: &str| crate::storage::sqlite::open_owned(&folder.path().join(name), "record_store",
        crate::storage::record_store_resources::bounds()).unwrap();
    let rows = rows();
    costs_the_rows_that_match(seeded_into(Prefilled::with_supply(open("full.sqlite")), &rows),
        Prefilled::with_supply(open("empty.sqlite")), &rows);
}

fn costs_the_rows_that_match<S: crate::storage::Storage + Send>(mut full: Prefilled<S>, mut empty: Prefilled<S>, rows: &[(String, Value)]) {
    for (field, wanted) in questions() {
        let input = json!({"type": KIND, "where": {field: wanted.clone()}, "limit": 999});
        // The first read of each fills its order for the seeded rows (what idle upkeep does once, in bounded steps);
        // what is measured is a read of a filled order, as every read after the fill is.
        let _ = read_all(&mut full, input.clone());
        let _ = read_all(&mut empty, input.clone());
        let (ids, opened, took) = read_all(&mut full, input.clone());
        let (none, _, took_empty) = read_all(&mut empty, input.clone());
        let expected = matching(rows, field, &wanted);
        eprintln!("where {{{field}: {wanted}}}: {} of {ROWS} rows, {opened} records opened, {took:?} (empty store {took_empty:?})",
            expected.len());
        assert!(none.is_empty());
        assert_eq!(sorted(ids), expected, "where {{{field}: {wanted}}} answers exactly the matching rows");
        // The rows shown, plus at most a few reads the answer's computed list fields make: never the list.
        assert!(opened <= expected.len() + 8, "where {{{field}: {wanted}}} opened {opened} records for {} matches", expected.len());
        // Bounded by the matches: the largest run here is a few hundred rows, so a read of 50,000 stays well inside a
        // second even unoptimized (a walk of the whole list took seconds), whatever this machine's speed.
        assert!(took < took_empty + Duration::from_millis(500), "where {{{field}: {wanted}}} took {took:?} (empty {took_empty:?})");
    }
}

/// A store kept before these orders were declared answers the same rows while idle upkeep fills them, by the row
/// walk; a caller that started paging by the row walk keeps paging by it once the order is filled, so no row is lost.
#[test]
fn a_where_answers_the_same_rows_while_its_order_is_still_being_filled() {
    let rows: Vec<(String, Value)> = rows().into_iter().take(3_000).collect();
    let mut prefilled = seeded(&rows);
    prefilled.fills_orders = false;
    let wanted = json!("branch:4");
    let expected = matching(&rows, "part_of", &wanted);
    assert!(expected.len() > 40);
    let (walked, opened, _) = read_all(&mut prefilled, json!({"type": KIND, "where": {"part_of": wanted.clone()}, "limit": 999}));
    assert_eq!(sorted(walked), expected, "an order not yet filled answers by the row walk");
    assert!(opened >= rows.len(), "the row walk opens every row ({opened})");
    // A first page by the row walk, then the order fills, then the rest: every row once.
    let door = Door::shipped().unwrap();
    let model = crate::record_model_policy::list_rule_model();
    let mut input = json!({"type": KIND, "where": {"part_of": wanted}, "limit": 10});
    let first = door.answer(door.list_operation(), &input, &mut prefilled, model, Limits::default(), &crate::mcp::tool_answer_fits).unwrap();
    let mut ids: Vec<String> = first["records"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids.len(), 10);
    prefilled.fills_orders = true;
    input["after"] = first["next"].clone();
    let (rest, _, _) = read_all(&mut prefilled, input);
    ids.extend(rest);
    assert_eq!(sorted(ids), expected, "a row-walk page continues by the row walk once the order is filled");
}
