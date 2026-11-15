// src/record_value/account_routes_paging_tests.rs
//
// Purpose: Prove the door's list paging (`Door::answer` with `records:list`) returns every row of a large store
// exactly once, in order, in every mode a caller pages by: by id greatest first, by a declared order either way
// (with many equal order values, so ties are broken by id), with an id prefix and an order-value prefix, with a
// `where` filter (one that picks an order, one that reads row by row), with an empty `fields` projection, at the
// door's own page size and at others, and with each page cut to the real MCP answer bound or to a much smaller one.
//
// Non-Negotiable Invariants:
// - The cursor is the exact position of the last row shown (the order value and the id, or the id alone), and the
//   next page starts strictly after it: the rows of all pages joined are exactly the rows the store holds, once each.
// - The store is a sandbox (`list::tests::Prefilled`): 50,000 rows of three kinds, ids that share prefixes
//   (`n1`, `n10`, `n100`, ... and `check:7`, `check:7:a`, `check:70`), and order values most rows share.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::*;
use crate::record_value::list::tests::Prefilled;
use std::collections::BTreeSet;

const NOTES: usize = 20_000;
const TASKS: usize = 15_000;
const CHECKS: usize = 7_500;
const BY_PARENT: &str = "test order by parent";
const BY_OPEN_THEN_TIME: &str = "test order by open then time";

/// One row the sandbox holds: its id, kind and value.
struct Row {
    id: String,
    kind: &'static str,
    value: Value,
}

/// The sandbox rows: 20,000 notes, 15,000 tasks and 15,000 checks (7,500 ids, each also with a `:a` id under it).
fn rows() -> Vec<Row> {
    let mut rows = Vec::with_capacity(NOTES + TASKS + 2 * CHECKS);
    for n in 0..NOTES {
        // 13 parents: `p1`, `p10`, `p11`, `p12` share a text start, and about 1,540 rows share each value.
        rows.push(Row { id: format!("n{n}"), kind: "note", value: json!({"parent": format!("p{}", n % 13), "n": n}) });
    }
    for n in 0..TASKS {
        // Two open values, and a time 100 tasks share: the order's ties run past several pages.
        rows.push(Row { id: format!("t{n}"), kind: "task",
            value: json!({"time": (n / 100) as u64, "facts": {"open": (n % 2) as u64}}) });
    }
    for n in 0..CHECKS {
        for id in [format!("check:{n}"), format!("check:{n}:a")] {
            rows.push(Row { id, kind: "check", value: json!({"list": "list:checks", "n": n, "half": n % 2 == 0}) });
        }
    }
    rows
}

/// The sandbox `prefilled` holding every row of `rows()`.
fn filled<S: crate::storage::Storage + Send>(mut prefilled: Prefilled<S>) -> (Prefilled<S>, Vec<Row>) {
    let rows = rows();
    assert_eq!(rows.len(), 50_000);
    for row in &rows {
        prefilled.put(&row.id, row.kind, row.value.clone());
    }
    (prefilled, rows)
}

/// Every id the list answers over all its pages (each page within `fits`), and how many pages it took.
fn page_through<S: crate::storage::Storage + Send>(prefilled: &mut Prefilled<S>, mut input: Value, fits: &dyn Fn(&Value) -> bool) -> (Vec<String>, usize) {
    let door = Door::shipped().unwrap();
    let model = crate::record_model_policy::list_rule_model();
    let (mut ids, mut pages) = (Vec::new(), 0usize);
    loop {
        let page = door.answer(door.list_operation(), &input, prefilled, model, Limits::default(), fits).unwrap();
        assert!(fits(&page), "every page fits its bound");
        pages += 1;
        assert!(pages <= 200_000, "the paging ends");
        ids.extend(page["records"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap().to_owned()));
        match page["next"].as_str() {
            Some(next) => input["after"] = json!(next),
            None => return (ids, pages),
        }
    }
}

/// `got` holds exactly `expected`, once each and in that order; the message names what went missing or came twice.
fn exactly_once(what: &str, got: &[String], expected: &[String]) {
    let distinct: BTreeSet<&String> = got.iter().collect();
    let wanted: BTreeSet<&String> = expected.iter().collect();
    let missing: Vec<_> = wanted.difference(&distinct).take(5).collect();
    let extra: Vec<_> = distinct.difference(&wanted).take(5).collect();
    assert_eq!((got.len(), distinct.len(), missing.len(), extra.len()), (expected.len(), expected.len(), 0, 0),
        "{what}: {} rows, {} distinct, of {} (missing e.g. {missing:?}, extra e.g. {extra:?})",
        got.len(), distinct.len(), expected.len());
    let at = got.iter().zip(expected).position(|(got, wanted)| got != wanted);
    assert!(at.is_none(), "{what}: every row once, but out of order from row {at:?}: got {:?}, expected {:?}",
        at.map(|at| &got[at.saturating_sub(2)..(at + 3).min(got.len())]),
        at.map(|at| &expected[at.saturating_sub(2)..(at + 3).min(expected.len())]));
}

/// Ids of `kind` whose row `keep` admits, sorted by `key` (then id), greatest first when `reverse`.
fn expected<K: Ord>(rows: &[Row], kind: &str, keep: impl Fn(&Row) -> bool, key: impl Fn(&Row) -> K, reverse: bool) -> Vec<String> {
    let mut kept: Vec<(K, &str)> = rows.iter().filter(|row| row.kind == kind && keep(row)).map(|row| (key(row), row.id.as_str())).collect();
    kept.sort();
    if reverse {
        kept.reverse();
    }
    kept.into_iter().map(|(_, id)| id.to_owned()).collect()
}

/// The answer bound of one MCP message, and one about 20 times smaller, so pages are cut by bytes far below `limit`.
fn bounds() -> [(&'static str, Box<dyn Fn(&Value) -> bool>); 2] {
    [("mcp", Box::new(crate::mcp::tool_answer_fits)), ("3 KB", Box::new(|page: &Value| page.to_string().len() <= 3_000))]
}

#[test]
fn every_row_of_fifty_thousand_comes_exactly_once_in_every_paging_mode_in_memory() {
    every_row_comes_exactly_once(Prefilled::new());
}

/// The same rows over the SQLite supply an account keeps its records in (`storage::sqlite`, one file).
#[test]
fn every_row_of_fifty_thousand_comes_exactly_once_in_every_paging_mode_over_sqlite() {
    crate::test_bound::within("every_row_of_fifty_thousand_comes_exactly_once_in_every_paging_mode_over_sqlite", std::time::Duration::from_secs(240), every_row_of_fifty_thousand_comes_exactly_once_in_every_paging_mode_over_sqlite_body);
}

fn every_row_of_fifty_thousand_comes_exactly_once_in_every_paging_mode_over_sqlite_body() {
    let folder = tempfile::tempdir().unwrap();
    let supply = crate::storage::sqlite::open_owned(&folder.path().join("records.sqlite"), "record_store",
        crate::storage::record_store_resources::bounds()).unwrap();
    every_row_comes_exactly_once(Prefilled::with_supply(supply));
}

fn every_row_comes_exactly_once<S: crate::storage::Storage + Send>(prefilled: Prefilled<S>) {
    let (mut prefilled, rows) = filled(prefilled);
    let parent = |row: &Row| row.value["parent"].as_str().unwrap().to_owned();
    // The order value of a task: the ECMA JSON text of [open, time], compared as text (UTF-16 code units), as the store
    // keys it: `[0,100]` sorts before `[0,12]`.
    let open_time = |row: &Row| format!("[{},{}]", row.value["facts"]["open"], row.value["time"]);
    let none = |_: &Row| true;
    let by_id = |row: &Row| row.id.clone();
    let cases: Vec<(&str, Value, Vec<String>)> = vec![
        ("notes by id", json!({"type": "note"}), expected(&rows, "note", none, by_id, true)),
        ("notes by id, 999 a page", json!({"type": "note", "limit": 999}), expected(&rows, "note", none, by_id, true)),
        ("notes by id, 37 a page, ids only", json!({"type": "note", "limit": 37, "fields": []}),
            expected(&rows, "note", none, by_id, true)),
        ("notes under the id prefix n1", json!({"type": "note", "prefix": "n1"}),
            expected(&rows, "note", |row| row.id.starts_with("n1"), by_id, true)),
        ("notes by parent", json!({"type": "note", "order": BY_PARENT}),
            expected(&rows, "note", none, |row| (parent(row), row.id.clone()), false)),
        ("notes by parent, greatest first", json!({"type": "note", "order": BY_PARENT, "reverse": true}),
            expected(&rows, "note", none, |row| (parent(row), row.id.clone()), true)),
        ("notes by parent starting \"p1", json!({"type": "note", "order": BY_PARENT, "prefix": "\"p1"}),
            expected(&rows, "note", |row| parent(row).starts_with("p1"), |row| (parent(row), row.id.clone()), false)),
        ("notes where parent is p3 (by its order)", json!({"type": "note", "where": {"parent": "p3"}, "limit": 999}),
            // A `where` keeps the list's default direction (greatest first) in the order it borrows: one run of equal
            // values, so greatest id first.
            expected(&rows, "note", |row| parent(row) == "p3", by_id, true)),
        ("tasks by open then time", json!({"type": "task", "order": BY_OPEN_THEN_TIME}),
            expected(&rows, "task", none, |row| (open_time(row), row.id.clone()), false)),
        ("tasks by open then time, greatest first", json!({"type": "task", "order": BY_OPEN_THEN_TIME, "reverse": true}),
            expected(&rows, "task", none, |row| (open_time(row), row.id.clone()), true)),
        ("checks by id", json!({"type": "check"}), expected(&rows, "check", none, by_id, true)),
        ("checks under check:7", json!({"type": "check", "prefix": "check:7"}),
            expected(&rows, "check", |row| row.id.starts_with("check:7"), by_id, true)),
        ("checks where half (row by row)", json!({"type": "check", "where": {"half": true}, "limit": 500}),
            expected(&rows, "check", |row| row.value["half"] == json!(true), by_id, true)),
    ];
    for (what, input, wanted) in &cases {
        assert!(!wanted.is_empty(), "{what} names rows");
        for (bound, fits) in bounds() {
            let (got, pages) = page_through(&mut prefilled, input.clone(), fits.as_ref());
            exactly_once(&format!("{what} ({bound}, {pages} pages)"), &got, wanted);
            eprintln!("door-paging {what} bound={bound} rows={} pages={pages}", got.len());
        }
    }
    // Every row of the store, read kind by kind, once.
    let mut all: Vec<String> = Vec::new();
    for kind in ["note", "task", "check"] {
        all.extend(page_through(&mut prefilled, json!({"type": kind}), &crate::mcp::tool_answer_fits).0);
    }
    assert_eq!(all.iter().collect::<BTreeSet<_>>().len(), 50_000);
    assert_eq!(all.len(), 50_000);
}

/// The rows that tie on an order value are one run, broken by id: a cursor inside a run continues inside it, even
/// when the page boundary falls between two rows of the same value at every page.
#[test]
fn a_page_that_ends_inside_a_run_of_equal_order_values_continues_inside_it() {
    let mut prefilled = Prefilled::new();
    // ids sharing prefixes inside one run of equal parents.
    let mut ids: Vec<String> = ["a", "a0", "a00", "a1", "a10", "a2", "b", "b:", "b:0", "b0"].iter().map(|id| (*id).to_owned()).collect();
    // Byte order: `b0` sorts before `b:` (0x30 < 0x3A).
    ids.sort();
    for id in &ids {
        prefilled.put(id, "note", json!({"parent": "same"}));
    }
    for limit in 1..=ids.len() {
        for reverse in [false, true] {
            let fits: &dyn Fn(&Value) -> bool = &|_| true;
            let (got, _) = page_through(&mut prefilled,
                json!({"type": "note", "order": BY_PARENT, "reverse": reverse, "limit": limit}), fits);
            let mut wanted = ids.clone();
            if reverse {
                wanted.reverse();
            }
            exactly_once(&format!("limit {limit} reverse {reverse}"), &got, &wanted);
            let (got, _) = page_through(&mut prefilled, json!({"type": "note", "limit": limit}), fits);
            let mut wanted = ids.clone();
            wanted.reverse();
            exactly_once(&format!("by id, limit {limit}"), &got, &wanted);
        }
    }
}

/// A row the walk lists but the read does not find (a routed account whose route directory names another computer for
/// it) refuses the page: it is never left out while the cursor moves past it, so no count made from the pages is short.
/// Before, such a row vanished from every page by id and by order, and the paging ended as if the kind had one row less.
#[test]
fn a_listed_row_the_read_cannot_find_refuses_the_page_rather_than_vanish() {
    let mut prefilled = Prefilled::new();
    for n in 0..120 {
        prefilled.put(&format!("check:{n}"), "check", json!({"n": n}));
        prefilled.put(&format!("n{n}"), "note", json!({"parent": "same"}));
    }
    let fits: &dyn Fn(&Value) -> bool = &|_| true;
    let (whole, _) = page_through(&mut prefilled, json!({"type": "check", "limit": 7}), fits);
    assert_eq!(whole.len(), 120);
    prefilled.hide("check:42");
    prefilled.hide("n42");
    let door = Door::shipped().unwrap();
    let model = crate::record_model_policy::list_rule_model();
    for input in [json!({"type": "check", "limit": 7}), json!({"type": "check"}), json!({"type": "check", "prefix": "check:4"}),
        json!({"type": "note", "order": BY_PARENT}), json!({"type": "note", "order": BY_PARENT, "reverse": true}),
        json!({"type": "note", "where": {"parent": "same"}})] {
        let mut call = input.clone();
        let refused = loop {
            match door.answer(door.list_operation(), &call, &mut prefilled, model, Limits::default(), fits) {
                Ok(page) => {
                    let ids: Vec<&str> = page["records"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap()).collect();
                    assert!(!ids.contains(&"check:42") && !ids.contains(&"n42"));
                    match page["next"].as_str() {
                        Some(next) => call["after"] = json!(next),
                        None => break None,
                    }
                }
                Err(error) => break Some(error),
            }
        };
        assert_eq!(refused, Some(crate::cause!(Error::Source)), "{input}: the paging refuses at the row it cannot read, never ends without it");
    }
}
