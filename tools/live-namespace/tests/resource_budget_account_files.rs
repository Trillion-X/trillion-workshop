//! The account files byte allowance holds its chunks from the native finite budget: one hold per chunk, never per read;
//! a chunk never settled (a crash) stays held, and a dropped handle settles what it holds as consumed.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use trillion_local::{
    account_files::{
        counters::Registry,
        source_reads::{Admission, Allowance, SourceRead, Supply},
    },
    resource_authority::budget::account_files::{Chunks, UNIT},
};
#[path = "support/resource_budget.rs"]
mod support;
use support::*;

fn byte_terms(limit: u64) -> trillion_local::resource_authority::budget::Terms {
    let mut terms = terms(limit);
    terms.unit = UNIT.into();
    terms
}
fn read(bytes: u64) -> SourceRead {
    SourceRead { origin: "origin".into(), offset: 0, requested_bytes: bytes }
}
/// Wait (off the asserting thread's request path) for the allowance's own thread to reach `done`.
fn eventually(owner: &Budget, done: impl Fn(&trillion_local::resource_authority::budget::Totals) -> bool) {
    let started = Instant::now();
    loop {
        let totals = owner.totals().unwrap();
        if done(&totals) { return; }
        assert!(started.elapsed() < Duration::from_secs(5), "{totals:?}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn a_grant_of_another_unit_is_not_a_byte_supply() {
    let dir = tempfile::tempdir().unwrap();
    assert!(Chunks::new(open(&dir.path().join("book"), terms(4096), Policy::new())).is_err());
}

#[test]
fn many_reads_hold_one_hold_per_chunk_and_a_used_up_chunk_settles_whole() {
    let dir = tempfile::tempdir().unwrap();
    let owner = open(&dir.path().join("book"), byte_terms(10_000), Policy::new());
    let allowance = Allowance::open(Arc::new(Chunks::new(owner.clone()).unwrap()), 1000, 200, &Registry::default()).unwrap();
    let admission = Admission::from(allowance.clone());
    for _ in 0..70 {
        admission.admit_read(&read(10)).unwrap();
    }
    assert_eq!(owner.totals().unwrap().held, 1000, "seventy reads, one durable hold");
    assert_eq!(owner.totals().unwrap().used, 0);
    // Past the low-water mark the next chunk is held off the path; the first, once used up, settles as 1000.
    for _ in 0..30 {
        admission.admit_read(&read(10)).unwrap();
    }
    eventually(&owner, |totals| totals.used == 1000 && totals.held == 1000);
    assert_eq!(allowance.resident(), 1000);
}

#[test]
fn a_dropped_handle_with_remaining_allowance_settles_as_consumed_never_unused() {
    let dir = tempfile::tempdir().unwrap();
    let owner = open(&dir.path().join("book"), byte_terms(4096), Policy::new());
    let allowance = Allowance::open(Arc::new(Chunks::new(owner.clone()).unwrap()), 1000, 0, &Registry::default()).unwrap();
    Admission::from(allowance.clone()).admit_read(&read(10)).unwrap();
    assert_eq!(allowance.resident(), 990);
    drop(allowance);
    eventually(&owner, |totals| totals.held == 0);
    assert_eq!(owner.totals().unwrap().used, 1000, "the 990 unused bytes count as consumed");
}

#[test]
fn an_unsettled_chunk_after_a_crash_stays_held_and_counts_against_the_grant() {
    let dir = tempfile::tempdir().unwrap();
    let owner = open(&dir.path().join("book"), byte_terms(1500), Policy::new());
    let chunks = Chunks::new(owner.clone()).unwrap();
    // A process that stops with a held chunk never settles it.
    std::mem::forget(chunks.hold(1000).unwrap());
    assert_eq!(owner.totals().unwrap().held, 1000);
    assert_eq!(owner.totals().unwrap().used, 0);
    // After a restart, a new supply of the same grant cannot spend the crashed chunk again.
    let restarted = Chunks::new(owner.clone()).unwrap();
    assert!(restarted.hold(1000).is_err(), "the unsettled remainder is not available");
    assert!(restarted.hold(500).is_ok());
}
