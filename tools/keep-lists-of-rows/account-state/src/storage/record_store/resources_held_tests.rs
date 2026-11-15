// src/storage/record_store/resources_held_tests.rs
//
// Purpose: `resources_held` names the resources an account holds records of by one seek each. SQLite reads a row-value
// `>` over a key prefix by stepping through every row of the prefix, so a bound "after resource X" took 83 s past one
// resource of the Mac's 48 GB record book, and the copies timer (`Copies::tick` -> `carry_own_files`) sat in that read
// at 106% CPU (sample /tmp/copies-ack-sample7.txt, 2026-11-13). The work of the call must not grow with the rows a
// resource holds.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{RealClock, RecordStore};
use crate::{
    sqlite_work::WorkMeter,
    storage::{record_store::settings::Limits, sqlite},
};
use serde_json::json;

fn records(count: usize) -> Vec<(String, serde_json::Value)> {
    (0..count).map(|at| (format!("row-{at:06}"), json!({"kind": "record:library", "stored": "{}"}))).collect()
}

/// The vm steps of `resources_held` over a store whose middle resource holds `rows` records.
fn steps_with(rows: usize) -> (Vec<String>, u64) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("held.sqlite");
    let meter = WorkMeter::new();
    let supply = sqlite::open_owned_observed_paged(&path, "record_store", crate::storage::record_store_resources::bounds(), meter.clone(), None).unwrap();
    let mut store = RecordStore::new(supply, Box::new(RealClock), Limits::fixed(1 << 20, 1 << 40)).unwrap();
    store.import("account", "@list/a", &records(2)).unwrap();
    for page in records(rows).chunks(500) {
        store.import("account", "@list/big", page).unwrap();
    }
    store.import("account", "@list/z", &records(2)).unwrap();
    store.import("other", "@list/other", &records(2)).unwrap();
    let window = meter.begin_observation().unwrap();
    let held = store.resources_held("account", usize::MAX >> 1).unwrap();
    (held, window.finish().unwrap().work.vm_steps)
}

/// A resource of 3,000 records costs `resources_held` no more than a resource of 3 do, and the answer is the same.
#[test]
fn resources_held_does_not_step_through_the_rows_of_a_resource() {
    let (small_held, small) = steps_with(3);
    let (big_held, big) = steps_with(3_000);
    let names = vec!["@list/a".to_string(), "@list/big".to_string(), "@list/z".to_string()];
    assert_eq!(small_held, names);
    assert_eq!(big_held, names);
    assert!(big < small * 2 + 200, "the call stepped through the big resource's rows: {big} vm steps against {small}");
}
