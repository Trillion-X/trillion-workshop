//! Native finite hold state with real independent SQLite handles.
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Barrier,
};
use trillion_local::resource_authority::budget::{
    CapturedGrant, Error, HostPolicy, Owner, Payer, Reservation, State, Terms, View,
};
#[path = "support/resource_budget.rs"]
mod support;
use support::*;
#[test]
fn independent_sqlite_handles_cannot_overspend_and_reopen_preserves_holds() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("protected.sqlite");
    let policy = Policy::new();
    let original = open(&path, terms(40), policy.clone());
    let owners: Vec<_> = (0..12)
        .map(|_| open(&path, terms(40), policy.clone()))
        .collect();
    let barrier = Arc::new(Barrier::new(12));
    let threads: Vec<_> = owners
        .into_iter()
        .enumerate()
        .map(|(i, owner)| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                match owner.reserve(&format!("race-{i}"), "input", 10) {
                    Ok(Reservation::New(_)) => true,
                    Err(Error::Exhausted(_) | Error::Conflict(_)) => false,
                    _ => panic!("unexpected admission result"),
                }
            })
        })
        .collect();
    assert_eq!(
        threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|accepted| *accepted)
            .count(),
        4
    );
    assert_eq!(original.totals().unwrap().held, 40);
    drop(original);
    let reopened = open(&path, terms(40), policy);
    assert_eq!(reopened.totals().unwrap().held, 40);
    assert!(matches!(
        reopened.reserve("extra", "input", 1),
        Err(Error::Exhausted(_))
    ));
}
#[test]
fn duplicates_replay_without_second_dispatch_and_changed_identity_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let owner = open(&dir.path().join("book"), terms(100), Policy::new());
    let hold = fresh(&owner, "logical", 50);
    assert!(matches!(
        owner.reserve("logical", "exact-input", 50),
        Ok(Reservation::Existing(View {
            state: State::Reserved,
            ..
        }))
    ));
    assert!(matches!(
        owner.reserve("logical", "changed", 50),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        owner.reserve("logical", "exact-input", 51),
        Err(Error::Conflict(_))
    ));
    hold.start().unwrap();
    assert_eq!(hold.start(), Err(trillion_local::cause!(Error::Conflict)));
    hold.finish(Some(20), true, "receipt").unwrap();
    hold.finish(Some(20), true, "receipt").unwrap();
    assert_eq!(
        hold.finish(Some(21), true, "receipt"),
        Err(trillion_local::cause!(Error::Conflict))
    );
    assert!(matches!(
        owner.reserve("logical", "exact-input", 50),
        Ok(Reservation::Existing(View {
            state: State::Settled { units: 20, .. },
            ..
        }))
    ));
    assert_eq!(owner.totals().unwrap().used, 20);
}
#[test]
fn revoke_and_expiry_stop_dispatch_but_terminal_accounting_survives() {
    let dir = tempfile::tempdir().unwrap();
    let policy = Policy::new();
    let owner = open(&dir.path().join("book"), terms(100), policy.clone());
    let reserved = fresh(&owner, "reserved", 20);
    let running = fresh(&owner, "running", 30);
    running.start().unwrap();
    policy.live.store(false, Ordering::SeqCst);
    assert_eq!(reserved.start(), Err(trillion_local::cause!(Error::Authority)));
    assert!(matches!(
        owner.reserve("new", "input", 1),
        Err(Error::Authority(_))
    ));
    running.finish(Some(7), true, "after-revoke").unwrap();
    reserved.release_unstarted().unwrap();
    policy.live.store(true, Ordering::SeqCst);
    assert_eq!(owner.totals().unwrap().used, 7);
    let expiring = fresh(&owner, "expiring", 10);
    policy.now.store(1000, Ordering::SeqCst);
    assert_eq!(expiring.start(), Err(trillion_local::cause!(Error::Authority)));
    expiring.release_unstarted().unwrap();
    assert!(CapturedGrant::capture(terms(100), policy).is_err());
}
#[test]
fn editable_balance_and_included_plan_are_not_funding_and_byo_stays_distinct() {
    let policy = Policy::new();
    for funding in ["", "editable-balance:999999", "included-plan"] {
        let mut claimed = terms(100);
        claimed.payer = Payer::Funded {
            funding_identity: funding.into(),
        };
        assert!(matches!(
            CapturedGrant::capture(claimed, policy.clone()),
            Err(Error::Authority(_))
        ));
    }
    let dir = tempfile::tempdir().unwrap();
    let mut external = terms(100);
    external.payer = Payer::External;
    let owner = open(&dir.path().join("byo"), external, policy);
    assert_eq!(owner.terms().payer, Payer::External);
    let hold = fresh(&owner, "byo", 10);
    hold.start().unwrap();
    hold.finish(Some(4), true, "provider-direct").unwrap();
    assert_eq!(owner.totals().unwrap().used, 4);
}
#[test]
fn dropped_cancelled_partial_and_unknown_hold_until_trusted_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("book");
    let policy = Policy::new();
    let owner = open(&path, terms(100), policy.clone());
    drop(fresh(&owner, "dropped", 20));
    fresh(&owner, "released", 10).release_unstarted().unwrap();
    let partial = fresh(&owner, "partial", 30);
    partial.start().unwrap();
    partial.finish(Some(8), false, "interrupted").unwrap();
    let unknown = fresh(&owner, "unknown", 40);
    unknown.start().unwrap();
    drop(unknown);
    assert_eq!(owner.totals().unwrap().held, 90);
    drop(owner);
    let owner = open(&path, terms(100), policy.clone());
    assert!(matches!(
        owner.view("partial").unwrap().unwrap().state,
        State::Unknown {
            observed: Some(8),
            ..
        }
    ));
    assert_eq!(
        owner.view("unknown").unwrap().unwrap().state,
        State::Started
    );
    assert_eq!(
        owner.reconcile("partial", 8, "timeout"),
        Err(trillion_local::cause!(Error::Authority))
    );
    policy.recovery.store(true, Ordering::SeqCst);
    assert_eq!(
        owner.reconcile("partial", 7, "trusted-terminal-evidence"),
        Err(trillion_local::cause!(Error::Invalid))
    );
    owner
        .reconcile("partial", 8, "trusted-terminal-evidence")
        .unwrap();
    owner
        .reconcile("unknown", 15, "trusted-terminal-evidence")
        .unwrap();
    owner
        .reconcile("dropped", 0, "trusted-terminal-evidence")
        .unwrap();
    assert_eq!(owner.totals().unwrap().held, 0);
    assert_eq!(owner.totals().unwrap().used, 23);
}
#[test]
fn reopening_same_grant_with_different_terms_cannot_mint_capacity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("book");
    let policy = Policy::new();
    let owner = open(&path, terms(10), policy.clone());
    drop(fresh(&owner, "held", 10));
    let mut increased = terms(100);
    increased.basis = "other-origin".into();
    let impostor = open(&path, increased, policy);
    assert!(matches!(
        impostor.reserve("new", "input", 1),
        Err(Error::Conflict(_))
    ));
    assert_eq!(owner.totals().unwrap().held, 10);
}

#[test]
fn expired_revoked_grant_can_restore_receipts_without_restoring_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recovery");
    let policy = Policy::new();
    let owner = open(&path, terms(100), policy.clone());
    let hold = fresh(&owner, "lost-process", 80);
    hold.start().unwrap();
    drop(hold);
    drop(owner);
    policy.now.store(2000, Ordering::SeqCst);
    policy.live.store(false, Ordering::SeqCst);
    policy.recovery.store(true, Ordering::SeqCst);
    let grant = CapturedGrant::restore(terms(100), policy.clone()).unwrap();
    let restored = Owner::new(store(&path), grant);
    let pending = restored.recovery_page("", 1).unwrap();
    assert_eq!(pending.holds[0].0, "lost-process");
    assert_eq!(pending.holds[0].1.state, State::Started);
    assert_eq!(pending.totals.held, 80);
    assert!(matches!(
        restored.reserve("again", "input", 1),
        Err(Error::Authority(_))
    ));
    restored
        .reconcile("lost-process", 35, "trusted-terminal-evidence")
        .unwrap();
    restored
        .reconcile("lost-process", 35, "trusted-terminal-evidence")
        .unwrap();
    assert_eq!(
        restored.reconcile("lost-process", 36, "trusted-terminal-evidence"),
        Err(trillion_local::cause!(Error::Conflict))
    );
    policy.now.store(100, Ordering::SeqCst);
    policy.live.store(true, Ordering::SeqCst);
    assert_eq!(restored.totals().unwrap().held, 0);
    assert_eq!(restored.totals().unwrap().used, 35);
}

#[test]
fn release_and_unknown_receipts_have_immutable_retry_identity() {
    let dir = tempfile::tempdir().unwrap();
    let owner = open(&dir.path().join("book"), terms(100), Policy::new());
    let unstarted = fresh(&owner, "not-dispatched", 30);
    unstarted.release_unstarted().unwrap();
    unstarted.release_unstarted().unwrap();
    assert_eq!(unstarted.start(), Err(trillion_local::cause!(Error::Conflict)));
    let hold = fresh(&owner, "started", 70);
    hold.start().unwrap();
    assert_eq!(hold.release_unstarted(), Err(trillion_local::cause!(Error::Conflict)));
    hold.finish(Some(9), false, "first-observation").unwrap();
    hold.finish(Some(9), false, "first-observation").unwrap();
    assert_eq!(
        hold.finish(Some(9), false, "changed-observation"),
        Err(trillion_local::cause!(Error::Conflict))
    );
    assert_eq!(owner.totals().unwrap().held, 70);
    assert_eq!(
        hold.finish(Some(71), true, "over-bound"),
        Err(trillion_local::cause!(Error::Invalid))
    );
    assert_eq!(owner.totals().unwrap().held, 70);
}

#[test]
fn authority_revoked_at_storage_commit_leaves_no_reserved_credit() {
    struct CheckPolicy(AtomicUsize);
    impl HostPolicy for CheckPolicy {
        fn now_ms(&self) -> i64 {
            100
        }
        fn capture(&self, _: &Terms) -> bool {
            true
        }
        fn current(&self, _: &Terms) -> bool {
            // capture and optimistic preflight succeed; the actual storage
            // transaction sees the revocation, then future inspection works.
            self.0.fetch_add(1, Ordering::SeqCst) != 2
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let policy = Arc::new(CheckPolicy(AtomicUsize::new(0)));
    let grant = CapturedGrant::capture(terms(100), policy).unwrap();
    let owner = Owner::new(store(&dir.path().join("fence")), grant);
    assert!(matches!(
        owner.reserve("commit-revoked", "input", 30),
        Err(Error::Authority(_))
    ));
    assert_eq!(owner.totals().unwrap().held, 0);
    assert!(owner.view("commit-revoked").unwrap().is_none());
}

#[test]
fn unit_arithmetic_cannot_wrap_and_make_more_capacity() {
    let dir = tempfile::tempdir().unwrap();
    let owner = open(&dir.path().join("overflow"), terms(u64::MAX), Policy::new());
    let hold = fresh(&owner, "maximum", u64::MAX);
    assert!(matches!(
        owner.reserve("overflow", "input", 1),
        Err(Error::Exhausted(_))
    ));
    hold.start().unwrap();
    hold.finish(Some(u64::MAX), true, "maximum-used").unwrap();
    assert!(matches!(
        owner.reserve("overflow", "input", 1),
        Err(Error::Exhausted(_))
    ));
}
