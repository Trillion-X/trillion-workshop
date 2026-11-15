//! The copy rule on one sign-in store in memory (the account's copies at several computers are
//! `membership_tests.rs`'s): `short_by` from the formula evaluator, the rule firing the workflow, the workflow adding the
//! first offered computer with room and making it a voter once it caught up, the computers list, and the refusal rule.
use super::*;
use crate::account::computers::{classify_booted, edit, keep_public_key, Change};
use crate::storage::memory::Memory;
use std::cell::Cell;

const ACCOUNT: &str = "person";

fn computer(at: u8) -> String {
    format!("{at:02x}").repeat(32)
}

struct World {
    memory: Memory,
    key: AccountKey,
    clock: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    _heard: std::sync::MutexGuard<'static, ()>,
}

impl World {
    /// An account on computer 1 alone, with the starting rows of src/account/rows/new-accounts.json.
    fn new() -> World {
        let memory = Memory::open("sign_in").unwrap();
        let key = AccountKey::generate().unwrap();
        let clock = crate::storage::time_source::fixed(1_000);
        let ids: Vec<String> = (1..=8).map(computer).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let heard = hear_for_test(&*clock, &refs);
        catch_up_for_test(&memory, ACCOUNT, &refs);
        let world = World { memory, key, clock, _heard: heard };
        let store = world.store();
        keep_public_key(&store, ACCOUNT, &world.key).unwrap();
        classify_booted(&store, ACCOUNT, &[&computer(1), &computer(2), &computer(3)]);
        let change = Change { pursuit: None, expected_revision: 0, copy_keepers: vec![computer(1)], may_answer: vec![computer(1)], voters: vec![] };
        edit(&store, ACCOUNT, &Subject::Account(world.key.address()), &change, &world.key, &Value::Null).unwrap();
        let (copies_row, rules_row) = for_tests();
        assert_eq!(write_missing(&store, ACCOUNT, &copies_row, &rules_row).unwrap(), 2);
        assert_eq!(write_missing(&store, ACCOUNT, &copies_row, &rules_row).unwrap(), 0, "the starting rows are written once");
        world
    }

    fn store(&self) -> Store<'_> {
        Store::new(&self.memory)
    }

    fn here<'a>(&'a self, caught_up: &'a dyn Fn(&str) -> bool) -> Here<'a> {
        self.here_with(caught_up, &[])
    }

    fn here_with<'a>(&'a self, caught_up: &'a dyn Fn(&str) -> bool, reports: &'a [Reported]) -> Here<'a> {
        Here { account: ACCOUNT, key: &self.key, access: &Value::Null, computer: None, always_on: false, reports, writer: None, caught_up, now_ms: 1_000, clock: &*self.clock }
    }

    fn row(&self) -> ComputersRow {
        super::super::read(&self.store(), ACCOUNT, &Subject::Account(self.key.address())).unwrap().unwrap().value
    }
}

#[test]
fn short_by_is_the_formula_over_the_least_counts_and_the_live_ones() {
    let (copies_row, rules_row) = for_tests();
    let live = |copy_keepers, voters, may_answer, always_on| Live { copy_keepers, voters, may_answer, always_on };
    assert_eq!(short_by(&rules_row, &copies_row, &live(1, 0, 1, 0)), Some(3), "three voters short");
    assert_eq!(short_by(&rules_row, &copies_row, &live(3, 2, 3, 2)), Some(1), "one voter short");
    assert_eq!(short_by(&rules_row, &copies_row, &live(3, 3, 2, 2)), Some(0));
    assert_eq!(short_by(&rules_row, &copies_row, &live(5, 5, 5, 5)), Some(0), "above the rule is not short");
    let mut broken = rules_row.clone();
    broken.short_by_each.insert("voters".into(), json!({"$kind": "binding", "select": {"from": "self", "path": ["least_voters"]}, "transform": [{"op": "op:core.no-such-op"}]}));
    assert_eq!(short_by(&broken, &copies_row, &live(1, 0, 1, 0)), None, "a formula that fails answers nothing");
}

#[test]
fn a_short_account_starts_the_workflow_that_adds_the_first_offered_computer_with_room_and_then_makes_it_a_voter() {
    let world = World::new();
    let store = world.store();
    let behind = |_: &str| false;

    // Nothing offered: the run starts and says why it waits; nothing else is written.
    let outcome = after_write(&store, &world.here(&behind)).unwrap();
    assert_eq!(outcome.short_by, Some(3));
    assert_eq!(outcome.started.len(), 1, "{outcome:?}");
    assert_eq!(outcome.runs[0].blocked.as_ref().map(|why| why.as_str()), Some("no_offered_computer_with_room"));
    let cause = outcome.runs[0].blocked.as_ref().expect("a blocked code retains its origin").cause();
    assert_eq!(cause.file(), "src/account/computers/copy_rule.rs");
    assert!(include_str!("copy_rule.rs").lines().nth(cause.line() as usize - 1).unwrap()
        .contains("no_offered_computer_with_room"));
    let kept_id = format!("{}:{}", row_id(&names().run_prefix, ACCOUNT), outcome.runs[0].run_id);
    let kept: Row<RunRow> = store.get(Family::Lists, &kept_id).unwrap().unwrap();
    assert_eq!(kept.value.blocked.as_ref().map(|why| why.as_str()), Some("no_offered_computer_with_room"));
    assert_eq!(kept.value.blocked.as_ref().unwrap().cause(), cause);

    assert_eq!(world.row().copy_keepers, vec![computer(1)]);
    // The same account again starts no second run while one works.
    assert!(after_write(&store, &world.here(&behind)).unwrap().started.is_empty());

    // Two computers offered, the first without room: the second is added as a copy keeper that may answer.
    let offered_list = vec![
        Offered { kind: None, computer: computer(2), has_room: false, always_on: true },
        Offered { kind: None, computer: computer(3), has_room: true, always_on: true },
    ];
    set_offered(&store, ACCOUNT, 0, offered_list).unwrap();
    let outcome = after_write(&store, &world.here(&behind)).unwrap();
    let run = &outcome.runs[0];
    assert_eq!(run.added.as_deref(), Some(computer(3).as_str()), "{run:?}");
    assert_eq!(run.blocked.as_ref().map(|why| why.as_str()), Some("waiting_for_caught_up"), "the voter step waits for it to catch up");
    assert_eq!(run.state, "working");
    let row = world.row();
    assert_eq!(row.copy_keepers, vec![computer(1), computer(3)]);
    assert_eq!(row.may_answer, vec![computer(1), computer(3)]);
    // The computer that answered alone became the first voter first, so the row never has two writers; the added one,
    // not caught up, does not vote.
    assert_eq!(row.voters, vec![computer(1)], "a computer that has not caught up never votes");

    // It reports caught up: the voter step is made and the run finishes.
    let caught_up = |named: &str| named == computer(3);
    let outcome = after_write(&store, &world.here(&caught_up)).unwrap();
    let finished = outcome.runs.iter().find(|run| run.state == "finished").expect("the run finished");
    assert_eq!(finished.status, json!("completed"), "{finished:?}");
    assert_eq!(world.row().voters, vec![computer(1), computer(3)], "one voter step");
    // Still short (one keeper and one voter to go, no offered computer with room left): the next run starts and waits.
    assert_eq!(outcome.short_by, Some(2), "short_by is read before the runs go on: {outcome:?}");
    let next = after_write(&store, &world.here(&caught_up)).unwrap();
    assert_eq!(next.short_by, Some(1), "{next:?}");
    assert_eq!(next.started.len(), 1, "a new revision of the computers row is a new send");
    assert_eq!(next.runs.iter().find(|run| run.state == "working").unwrap().blocked.as_ref().map(|why| why.as_str()), Some("no_offered_computer_with_room"));
}

#[test]
fn an_offer_with_no_kind_joins_as_a_copy_keeper_and_voter_but_never_answers() {
    // Not classified, so its kind is the offer's default (`offered_kind`, rented-host): it keeps copies and votes, and a
    // rented host does not answer.
    let world = World::new();
    let store = world.store();
    set_offered(&store, ACCOUNT, 0, vec![Offered { kind: None, computer: computer(4), has_room: true, always_on: false }]).unwrap();
    let caught_up = |_: &str| true;
    let outcome = after_write(&store, &world.here(&caught_up)).unwrap();
    assert_eq!(outcome.runs[0].added.as_deref(), Some(computer(4).as_str()), "{outcome:?}");
    assert_eq!(host_kind_row(&store, ACCOUNT, &computer(4)).unwrap().as_deref(), Some("rented-host"));
    let row = world.row();
    assert!(row.copy_keepers.contains(&computer(4)), "{row:?}");
    assert!(row.voters.contains(&computer(4)), "{row:?}");
    assert!(!row.may_answer.contains(&computer(4)), "{row:?}");
}

#[test]
fn an_offer_names_its_host_kind_and_that_kind_decides_the_roles() {
    // The offer names hosting-place, which allows answering: the computer is written with that kind (not the default
    // rented-host), and it is added as a copy keeper, a voter and a may-answer computer.
    let world = World::new();
    let store = world.store();
    set_offered(&store, ACCOUNT, 0, vec![Offered { kind: Some("hosting-place".into()), computer: computer(4), has_room: true, always_on: false }]).unwrap();
    let caught_up = |_: &str| true;
    let outcome = after_write(&store, &world.here(&caught_up)).unwrap();
    assert_eq!(outcome.runs[0].added.as_deref(), Some(computer(4).as_str()), "{outcome:?}");
    assert_eq!(host_kind_row(&store, ACCOUNT, &computer(4)).unwrap().as_deref(), Some("hosting-place"));
    let row = world.row();
    assert!(row.copy_keepers.contains(&computer(4)), "{row:?}");
    assert!(row.voters.contains(&computer(4)), "{row:?}");
    assert!(row.may_answer.contains(&computer(4)), "{row:?}");
}

#[test]
fn a_keeper_that_answers_no_copies_here_does_not_count_and_the_rule_adds_a_holder() {
    let world = World::new();
    let store = world.store();
    // Computer 2 is named a copy keeper, but it answers no-copies-here and has not caught up: it holds nothing.
    apply(&store, ACCOUNT, &Operation::AddComputer { pursuit: None, computer: computer(2), may_answer: false, voter: false }, &world.key, &Value::Null, &*world.clock).unwrap();
    let row = world.row();
    assert_eq!(row.copy_keepers, vec![computer(1), computer(2)]);
    let behind = |named: &str| named != computer(2);
    note_keeper(ACCOUNT, &computer(2), true);
    let counted = live(Some(&row), &world.here(&behind));
    assert_eq!(counted.copy_keepers, 1, "a keeper that answers no_copies_here is not counted");
    note_keeper(ACCOUNT, &computer(2), false);
    let caught_up = |_: &str| true;
    assert_eq!(live(Some(&row), &world.here(&caught_up)).copy_keepers, 2, "a keeper that answers joined counts");
    note_keeper(ACCOUNT, &computer(2), true);
    // The rule sees one holder: it is short, so it starts the workflow that adds a holder.
    let outcome = after_write(&store, &world.here(&behind)).unwrap();
    note_keeper(ACCOUNT, &computer(2), false);
    assert!(outcome.short_by.unwrap_or(0) > 0, "{outcome:?}");
    assert_eq!(outcome.started.len(), 1, "the rule fired: {outcome:?}");
}

/// An account with neither row reads the shipped copies and rules, so the rule runs on them: it is not stopped for a missing row.
#[test]
fn an_account_without_its_rows_reads_the_shipped_rule() {
    let memory = Memory::open("sign_in").unwrap();
    let key = AccountKey::generate().unwrap();
    let never = |_: &str| false;
    let clock = crate::storage::time_source::fixed(0);
    let here = Here { account: ACCOUNT, key: &key, access: &Value::Null, computer: None, always_on: false, reports: &[], writer: None, caught_up: &never, now_ms: 0, clock: &*clock };
    let store = Store::new(&memory);
    assert!(matches!(copies_source(&store, ACCOUNT).unwrap(), Source::Defaulted(_)));
    assert!(matches!(rules_source(&store, ACCOUNT).unwrap(), Source::Defaulted(_)));
    let outcome = after_write(&store, &here).unwrap();
    assert_ne!(outcome.not_run, Some("copies_rows_missing"), "a missing row is no longer a stop");
}

#[test]
fn an_edit_below_the_rule_is_refused_unless_it_lowers_the_rule_or_climbs_back() {
    let world = World::new();
    let store = world.store();
    assert!(below_rule(&store, ACCOUNT, 3, 2, None).unwrap(), "three keepers to two is below three");
    assert!(!below_rule(&store, ACCOUNT, 1, 2, None).unwrap(), "climbing back is never refused");
    assert!(!below_rule(&store, ACCOUNT, 4, 3, None).unwrap(), "still at the rule");
    let lowered = CopySettings { least_copy_keepers: 2, least_voters: 2, least_may_answer: 2, least_always_on: 0 };
    assert!(!below_rule(&store, ACCOUNT, 3, 2, Some(&lowered)).unwrap(), "the same edit lowers the rule to two");
    assert!(below_rule(&store, ACCOUNT, 3, 1, Some(&lowered)).unwrap(), "lowered to two, one is still below");
}

#[test]
fn the_rows_change_only_from_the_revision_read_and_hold_together() {
    let world = World::new();
    let store = world.store();
    let mut lower = for_tests().0;
    lower.least_copy_keepers = 2;
    assert_eq!(set_copies(&store, ACCOUNT, 0, lower.clone()), Err(crate::cause!(Refused::Stale)));
    assert_eq!(set_copies(&store, ACCOUNT, 1, lower.clone()).unwrap().revision, 2);
    let mut backwards = lower.clone();
    backwards.least_may_answer = 5;
    assert_eq!(set_copies(&store, ACCOUNT, 2, backwards), Err(crate::cause!(Refused::Invalid)), "may-answer computers are keepers");
    let twice = vec![Offered { kind: None, computer: computer(2), has_room: true, always_on: false }; 2];
    assert_eq!(set_offered(&store, ACCOUNT, 0, twice), Err(crate::cause!(Refused::Invalid)));
    let mut no_workflow = for_tests().1;
    no_workflow.workflow = json!({"steps": []});
    assert_eq!(set_rules(&store, ACCOUNT, 1, no_workflow), Err(crate::cause!(Refused::Invalid)));
}

#[test]
fn the_computers_row_is_a_list_and_a_list_row_write_is_a_computers_operation() {
    let world = World::new();
    let store = world.store();
    // What the list says of a computer's being always on and last seen is its own report, not the offered list.
    set_offered(&store, ACCOUNT, 0, vec![Offered { kind: None, computer: computer(1), has_room: true, always_on: false }]).unwrap();
    let asked = Cell::new(0);
    let caught_up = |_: &str| { asked.set(asked.get() + 1); true };
    let reports = [Reported { sealed_versions: None, unit: None, computer: computer(1), always_on: true, takes_new_accounts: false, has_room: true, last_seen: 777 }];
    let mut here = world.here_with(&caught_up, &reports);
    here.computer = Some("unused");
    let list = computers_list(&store, &here).unwrap();
    assert_eq!(list["list"], "computers");
    assert_eq!(list["rows"], json!([{
        "computer": computer(1), "keeps_copy": true, "may_answer": true, "votes": false, "writer": false,
        "always_on": true, "last_seen": 777, "caught_up": true,
    }]));

    let row = world.row();
    let add = ListRowWrite { computer: computer(2), keeps_copy: true, may_answer: false, votes: false, writer: false };
    assert_eq!(add.operation(Some(&row)), Operation::AddComputer { pursuit: None, computer: computer(2), may_answer: false, voter: false });
    let remove = ListRowWrite { keeps_copy: false, ..add.clone() };
    assert_eq!(remove.operation(Some(&row)), Operation::RemoveComputer { pursuit: None, computer: computer(2) });
    let writer = ListRowWrite { writer: true, ..add.clone() };
    assert_eq!(writer.operation(Some(&row)), Operation::MoveWriter { pursuit: None, computer: computer(2) });
    let vote = ListRowWrite { computer: computer(1), keeps_copy: true, may_answer: true, votes: true, writer: false };
    assert_eq!(vote.operation(Some(&row)), Operation::Set { pursuit: None, keeps_copy: vec![computer(1)], may_answer: vec![computer(1)], voters: vec![computer(1)] });
}


#[test]
fn short_only_of_always_on_computers_adds_only_one_that_reports_it_is_always_on() {
    let world = World::new();
    let store = world.store();
    set_copies(&store, ACCOUNT, 1, CopySettings { least_copy_keepers: 1, least_voters: 0, least_may_answer: 1, least_always_on: 1 }).unwrap();
    set_offered(&store, ACCOUNT, 0, vec![Offered { kind: None, computer: computer(2), has_room: true, always_on: false }]).unwrap();
    let behind = |_: &str| false;
    let outcome = after_write(&store, &world.here(&behind)).unwrap();
    assert_eq!(outcome.short_by, Some(1));
    assert_eq!(outcome.runs[0].blocked.as_ref().map(|why| why.as_str()), Some("no_offered_always_on_computer_with_room"), "{outcome:?}");
    assert_eq!(world.row().copy_keepers, vec![computer(1)], "a computer that cannot meet the rule is not added");
    set_offered(&store, ACCOUNT, 1, vec![
        Offered { kind: None, computer: computer(2), has_room: true, always_on: false },
        Offered { kind: None, computer: computer(3), has_room: true, always_on: true },
    ]).unwrap();
    let outcome = after_write(&store, &world.here(&behind)).unwrap();
    assert_eq!(outcome.runs[0].added.as_deref(), Some(computer(3).as_str()), "{outcome:?}");
}


#[test]
fn new_accounts_start_with_no_always_on_rule() {
    // Principle 4: no always-on rule or default. The field stays; the owner may raise it.
    let (copies_row, _) = for_tests();
    assert_eq!(copies_row.least_always_on, 0);
    let config: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/account/rows/new-accounts.json"))).unwrap();
    assert_eq!(config["copies"]["least_always_on"], 0);
}

#[test]
fn short_by_is_the_rules_rows_own_formula_and_the_largest_is_taken_there() {
    let (copies_row, rules_row) = for_tests();
    let live = Live { copy_keepers: 1, voters: 0, may_answer: 1, always_on: 0 };
    // The shipped formula: the largest of the counts' formulas and 0.
    assert_eq!(short_by_both(&rules_row, &copies_row, &live).map(|(short, _)| short), Some(3));
    assert_eq!(rules_row.short_by["transform"][0]["op"], "op:core.max", "the largest is taken in the row, not in code");
    // A row whose formula reads only the copy keepers answers only that: nothing in code takes the largest.
    let mut keepers_only = rules_row.clone();
    keepers_only.short_by = json!({"$kind": "binding", "select": {"from": "self", "path": ["short_by_each", "copy_keepers"]}});
    assert_eq!(short_by(&keepers_only, &copies_row, &live), Some(2));
    // A row with no formula of `short_by` does not hold together.
    let mut none = rules_row.clone();
    none.short_by = Value::Null;
    assert!(!none.valid());
}

#[test]
fn a_rules_row_of_the_older_shape_is_replaced_by_the_starting_row_once() {
    let world = World::new();
    let store = world.store();
    let id = format!("{}{ACCOUNT}", names().rules_prefix);
    let held = store.get::<Box<serde_json::value::RawValue>>(Family::Lists, &id).unwrap().unwrap();
    let mut older: Value = serde_json::from_str(held.value.get()).unwrap();
    let each = older["settings"]["short_by_each"].take();
    older["settings"].as_object_mut().unwrap().remove("short_by_each");
    older["settings"]["short_by"] = each;
    let older = Row { id: held.id.clone(), account: held.account.clone(), expires_at: held.expires_at, value: older };
    assert!(store.replace_if(Family::Lists, &held, &older).unwrap());
    assert!(rules(&store, ACCOUNT).is_err(), "the older shape does not read");
    let (copies_row, rules_row) = for_tests();
    assert_eq!(write_missing(&store, ACCOUNT, &copies_row, &rules_row).unwrap(), 1);
    let now = rules(&store, ACCOUNT).unwrap().unwrap();
    assert_eq!((now.revision, now.settings), (2, rules_row));
}

#[test]
fn the_offered_list_is_filled_from_the_computers_own_reports_and_keeps_what_was_offered_by_hand() {
    let world = World::new();
    let store = world.store();
    let never = |_: &str| false;
    set_offered(&store, ACCOUNT, 0, vec![Offered { kind: None, computer: computer(9), has_room: true, always_on: false }]).unwrap();
    let reports = [
        Reported { sealed_versions: None, unit: None, computer: computer(2), always_on: false, takes_new_accounts: false, has_room: true, last_seen: 5 },
        Reported { sealed_versions: None, unit: None, computer: computer(3), always_on: true, takes_new_accounts: true, has_room: true, last_seen: 5 },
        Reported { sealed_versions: None, unit: None, computer: computer(4), always_on: false, takes_new_accounts: true, has_room: false, last_seen: 5 },
    ];
    assert!(fill_offered(&store, &world.here_with(&never, &reports)).unwrap());
    let filled = offered(&store, ACCOUNT).unwrap().unwrap();
    assert_eq!(filled.revision, 2);
    assert_eq!(filled.settings, vec![
        Offered { kind: None, computer: computer(9), has_room: true, always_on: false },
        Offered { kind: None, computer: computer(3), has_room: true, always_on: true },
        Offered { kind: None, computer: computer(4), has_room: false, always_on: false },
    ], "a computer that does not take new accounts is not offered; one offered by hand stays");
    assert!(!fill_offered(&store, &world.here_with(&never, &reports)).unwrap(), "unchanged: not written again");
    // A report that changes changes the list: computer 3 has no room now.
    let fuller = [Reported { has_room: false, ..reports[1].clone() }];
    assert!(fill_offered(&store, &world.here_with(&never, &fuller)).unwrap());
    assert!(!offered(&store, ACCOUNT).unwrap().unwrap().settings[1].has_room);
}

#[test]
fn a_report_keeps_the_host_kind_its_offer_names() {
    let world = World::new();
    let store = world.store();
    set_offered(&store, ACCOUNT, 0, vec![Offered { kind: Some("my-device".into()), computer: computer(2), has_room: false, always_on: false }]).unwrap();
    let reports = [Reported { sealed_versions: None, unit: None, computer: computer(2), always_on: false, takes_new_accounts: true, has_room: true, last_seen: 1 }];
    let caught_up = |_: &str| true;
    fill_offered(&store, &world.here_with(&caught_up, &reports)).unwrap();
    let offered_row = offered(&store, ACCOUNT).unwrap().unwrap().settings;
    assert_eq!(offered_row, vec![Offered { kind: Some("my-device".into()), computer: computer(2), has_room: true, always_on: false }]);
}

#[test]
fn the_live_always_on_count_is_each_computers_own_report() {
    let world = World::new();
    let row = world.row();
    let never = |_: &str| false;
    let reports = [Reported { sealed_versions: None, unit: None, computer: computer(1), always_on: true, takes_new_accounts: false, has_room: true, last_seen: 9 }];
    assert_eq!(live(Some(&row), &world.here_with(&never, &[])).always_on, 0, "no report heard: not counted");
    assert_eq!(live(Some(&row), &world.here_with(&never, &reports)).always_on, 1);
}

#[test]
fn a_computer_that_reports_it_caught_up_wakes_the_copy_rule_at_once() {
    let owner = "caught-up-wakes-the-rule";
    run_soon(owner);
    run_soon("an-account-another-computer-holds");
    let woken = wait_run_soon(std::time::Duration::from_secs(5), &|named| named == owner);
    assert_eq!(wait_run_soon(std::time::Duration::from_millis(1), &|named| named == owner), Vec::<String>::new(), "taken once");
    assert!(woken.iter().any(|named| named == owner), "{woken:?}");
}

/// Removing a computer from the computers list fires the rule; its workflow adds a computer its own report offers, which
/// catches up and then votes, with no hand step (the offered list is never written by hand here).
#[test]
fn removing_a_computer_fires_the_rule_and_the_workflow_adds_a_reported_computer_that_catches_up_and_votes() {
    let world = World::new();
    let store = world.store();
    let subject = Subject::Account(world.key.address());
    // Computers 1 and 2 keep and vote; the rule asks one keeper and two voters.
    for (revision, voters) in [(1, vec![computer(1)]), (2, vec![computer(1), computer(2)])] {
        let change = Change { pursuit: None, expected_revision: revision, copy_keepers: vec![computer(1), computer(2)],
            may_answer: vec![computer(1)], voters };
        edit(&store, ACCOUNT, &subject, &change, &world.key, &Value::Null).unwrap();
    }
    set_copies(&store, ACCOUNT, 1, CopySettings { least_copy_keepers: 1, least_voters: 2, least_may_answer: 1, least_always_on: 0 }).unwrap();
    let all = |_: &str| true;
    assert_eq!(after_write(&store, &world.here(&all)).unwrap().short_by, Some(0));

    // The owner removes computer 2 from the computers list: one keeper is still the rule's least, so it is not refused.
    let remove = ListRowWrite { computer: computer(2), keeps_copy: false, may_answer: false, votes: false, writer: false };
    assert!(!below_rule(&store, ACCOUNT, 2, 1, None).unwrap());
    apply(&store, ACCOUNT, &remove.operation(Some(&world.row())), &world.key, &Value::Null, &*world.clock).unwrap();
    // Computer 3 reports it takes new accounts and has room.
    let reports = [Reported { sealed_versions: None, unit: None, computer: computer(3), always_on: false, takes_new_accounts: true, has_room: true, last_seen: 1 }];
    let behind = |_: &str| false;
    let outcome = after_write(&store, &world.here_with(&behind, &reports)).unwrap();
    assert_eq!(outcome.short_by, Some(1), "one voter short: {outcome:?}");
    assert_eq!(outcome.started.len(), 1, "the rule fired: {outcome:?}");
    assert_eq!(outcome.runs[0].added.as_deref(), Some(computer(3).as_str()), "{outcome:?}");
    assert_eq!(outcome.runs[0].blocked.as_ref().map(|why| why.as_str()), Some("waiting_for_caught_up"));
    assert_eq!(world.row().copy_keepers, vec![computer(1), computer(3)]);
    assert_eq!(world.row().voters, vec![computer(1)]);

    // It reports caught up: the voter step is made and the run finishes; the account meets its rule.
    let caught_up = |named: &str| named == computer(3);
    let outcome = after_write(&store, &world.here_with(&caught_up, &reports)).unwrap();
    assert!(outcome.runs.iter().any(|run| run.state == "finished"), "{outcome:?}");
    assert_eq!(world.row().voters, vec![computer(1), computer(3)]);
    assert_eq!(after_write(&store, &world.here_with(&caught_up, &reports)).unwrap().short_by, Some(0));
}

fn reported(at: u8, always_on: bool, last_seen: u64) -> Reported {
    Reported { sealed_versions: None, unit: None, computer: computer(at), always_on, takes_new_accounts: true, has_room: true, last_seen }
}

#[test]
fn a_report_the_forwarder_forgot_is_kept_for_the_held_while_and_then_dropped() {
    let held_ms = report_held_ms();
    assert!(held_ms > report_every_ms(), "a held report outlives at least one report round");
    let held = vec![reported(2, true, 1_000), reported(3, false, 1_000)];
    // The forwarder restarted: it answers only computer 3, which reported again.
    let fresh = vec![reported(3, true, 5_000)];
    let merged = merge_heard(&held, fresh, 5_000, held_ms);
    assert_eq!(merged, vec![reported(2, true, 1_000), reported(3, true, 5_000)]);
    // An empty answer (the forwarder holds nothing yet) keeps both.
    assert_eq!(merge_heard(&merged, vec![], 6_000, held_ms), merged);
    // Past the held while, a computer not heard again is dropped.
    let late = 1_000 + held_ms + 1;
    assert_eq!(merge_heard(&merged, vec![], late, held_ms), vec![reported(3, true, 5_000)]);
    // A computer named twice keeps its latest report.
    let twice = merge_heard(&[], vec![reported(4, false, 10), reported(4, true, 20)], 20, held_ms);
    assert_eq!(twice, vec![reported(4, true, 20)]);
}

#[test]
fn has_room_needs_under_the_limit_and_every_volume_above_its_floor() {
    let floor = 10;
    let roomy = Some(floor + room_bytes());
    const ROOMY_INODES: [Option<u64>; 1] = [Some(u64::MAX)];
    assert!(has_room(true, &[roomy], &ROOMY_INODES, floor));
    assert!(has_room(true, &[roomy, roomy], &ROOMY_INODES, floor), "the accounts volume and the releases volume both have room");
    assert!(!has_room(true, &[roomy, Some(floor + room_bytes() - 1)], &ROOMY_INODES, floor), "a nearly full releases volume has no room");
    assert!(!has_room(true, &[roomy, Some(0)], &ROOMY_INODES, floor), "a full releases volume has no room, though accounts are roomy");
    assert!(!has_room(true, &[Some(floor + room_bytes() - 1)], &ROOMY_INODES, floor), "a nearly full accounts volume has no room");
    assert!(!has_room(false, &[Some(u64::MAX)], &ROOMY_INODES, floor), "a computer at its accounts limit has no room");
    assert!(!has_room(true, &[roomy, None], &ROOMY_INODES, floor), "a volume that could not be read has no room");
    assert!(!has_room(true, &[Some(u64::MAX)], &ROOMY_INODES, u64::MAX), "the floor never wraps");
}


#[test]
fn kept_run_refusals_are_paired_on_wire_and_legacy_origins_stay_explicitly_unknown() {
    let blocked_cause = crate::cause!(copy_rule synthetic_blocked);
    let error_cause = crate::cause!(copy_rule synthetic_error);
    let row = RunRow {
        run_id: "synthetic-run".into(), workflow_id: "synthetic-workflow".into(),
        request_key: "synthetic-request".into(), started_by: Value::Null,
        started_at: "synthetic-start".into(), input: json!({}), answers: Map::new(),
        state: "working".into(), status: Value::Null, waiting: json!([]), steps: Value::Null,
        added: None,
        blocked: Some(CodedError::with_cause("waiting_for_caught_up".into(), blocked_cause.clone())),
        error: Some(CodedError::with_cause(json!({"code": "synthetic_failure"}), error_cause.clone())),
    };
    let wire = serde_json::to_value(&row).unwrap();
    assert_eq!(wire["blocked"], "waiting_for_caught_up");
    assert_eq!(wire["error"], json!({"code": "synthetic_failure"}));
    assert_eq!(wire["blocked_cause"], blocked_cause.id());
    assert_eq!(wire["error_cause"], error_cause.id());
    let decoded: RunRow = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(decoded.blocked.as_ref().unwrap().cause(), blocked_cause);
    assert_eq!(decoded.error.as_ref().unwrap().cause(), error_cause);
    let mut observed_again = decoded.clone();
    observed_again.blocked = Some(CodedError::with_cause("waiting_for_caught_up".into(),
        crate::cause!(copy_rule another_blocked_origin)));
    assert_ne!(observed_again, decoded, "a changed source is a durable row change even with the same public code");

    for removed in ["blocked", "blocked_cause", "error", "error_cause"] {
        let mut broken = wire.clone();
        broken.as_object_mut().unwrap().remove(removed);
        assert!(serde_json::from_value::<RunRow>(broken).is_err(), "missing {removed} must refuse a new row");
    }
    let mut legacy = wire;
    for removed in ["_refusal_causes", "blocked_cause", "error_cause"] {
        legacy.as_object_mut().unwrap().remove(removed);
    }
    let historical: RunRow = serde_json::from_value(legacy).unwrap();
    assert_eq!(historical.blocked.as_ref().unwrap().code, "waiting_for_caught_up");
    assert_eq!(historical.error.as_ref().unwrap().code, json!({"code": "synthetic_failure"}));
    let blocked = historical.blocked.as_ref().unwrap().cause();
    let error = historical.error.as_ref().unwrap().cause();
    assert_eq!(blocked.condition(), "historical_origin_unrecorded blocked");
    assert_eq!(error.condition(), "historical_origin_unrecorded error");
    assert_eq!(blocked.file(), "src/account/computers/copy_rule.rs");
    assert_eq!(error.file(), "src/account/computers/copy_rule.rs");
    assert_ne!(blocked, blocked_cause);
    assert_ne!(error, error_cause);
    let upgraded = serde_json::to_value(historical).unwrap();
    assert_eq!(upgraded["_refusal_causes"], "paired");
    assert_eq!(upgraded["blocked_cause"], blocked.id());
    assert_eq!(upgraded["error_cause"], error.id());
}

// ---- incident 16 (fleet gaps nobody noticed: a silent computer leaves the rule with no signal) ----

/// Incident 16: a computer that stops reporting leaves the copy rule's counts after `report_held_ms`, and that raises one
/// `computer-absent` alert row with its age (`absent_alerts`), not a silent drop.
fn silent_computer_raises_one_alert_body() -> std::result::Result<(), String> {
    let held_ms = report_held_ms();
    let silent = reported(7, true, 1_000);
    let now = 1_000 + held_ms + 1;
    let held = vec![silent.clone()];
    let kept = merge_heard(&held, vec![], now, held_ms);
    match absent_alerts(&held, &kept, now).as_slice() {
        [alert] if alert.kind == "computer-absent" && alert.computer == silent.computer && alert.silent_ms == now - silent.last_seen => Ok(()),
        raised => Err(format!("a computer silent for {} ms should raise one computer-absent alert, raised {raised:?}", now - silent.last_seen)),
    }
}

#[test]
fn silent_computer_raises_one_alert() {
    crate::simulation::verdict("silent-computer-raises-one-alert", silent_computer_raises_one_alert_body);
}

#[test]
fn a_silent_computer_is_recorded_once_as_a_sign_in_row() {
    let mem = crate::storage::memory::Memory::open("sign_in").expect("the sign_in schema opens");
    let store = Store::new(&mem);
    let held_ms = report_held_ms();
    let silent = reported(7, true, 1_000);
    let now = 1_000 + held_ms + 1;
    let alerts = absent_alerts(std::slice::from_ref(&silent), &[], now);
    assert_eq!(record_absences(&store, "account-a", &alerts).expect("the alert is written"), 1);
    assert_eq!(record_absences(&store, "account-a", &alerts).expect("the same alert is not written again"), 0);
    let row = store.get::<AbsentAlert>(Family::Lists, &format!("alert:computer-absent:{}:{now}", silent.computer)).expect("the row reads").expect("the alert row exists");
    assert_eq!((row.value.kind.as_str(), row.value.silent_ms), ("computer-absent", held_ms + 1));
}

/// Incident 16, zero holders: an account with no computer holding it raises a `want` row that every computer following the
/// feed evaluates. No such row exists yet (plan D14, and the signed desired-state rows of plan C), so this body names that gap.
fn zero_holders_raise_a_want_body() -> std::result::Result<(), String> {
    Err("an account with zero holders raises no want row: no want row or feed evaluation exists yet (plan D14, C)".to_string())
}

#[test]
fn zero_holders_raise_a_want() {
    crate::simulation::verdict("zero-holders-raise-a-want", zero_holders_raise_a_want_body);
}

#[test]
fn a_volume_short_of_free_inodes_has_no_room_though_its_bytes_are_free() {
    let floor = 0;
    let roomy = Some(floor + room_bytes());
    assert!(has_room(true, &[roomy], &[Some(room_inodes())], floor), "the inode floor is met");
    assert!(!has_room(true, &[roomy], &[Some(room_inodes() - 1)], floor), "a volume with bytes free but too few inodes has no room");
    assert!(!has_room(true, &[roomy], &[None], floor), "an inode count that could not be read is no room");
}

#[test]
fn a_report_reader_keeps_and_ignores_a_key_it_does_not_know() {
    use super::{OwnReport, ReportsAnswer, Reported};
    let own: OwnReport = serde_json::from_str(r#"{"always_on":true,"takes_new_accounts":false,"has_room":true,"unit":{"active":"active","sub":"running","restarts":0},"future":1}"#).unwrap();
    assert!(own.always_on && own.has_room);
    let reported: Reported = serde_json::from_str(r#"{"computer":"c","always_on":true,"takes_new_accounts":false,"has_room":true,"last_seen":5,"unit":{"active":"active","sub":"running","restarts":0},"future":1}"#).unwrap();
    assert_eq!(reported.last_seen, 5);
    let answer: ReportsAnswer = serde_json::from_str(r#"{"reports":[],"future":1}"#).unwrap();
    assert!(answer.reports.is_empty());
}

/// An account with no copies row reads the shipped copies default, `Defaulted`, and writes nothing for it on open.
#[test]
fn a_missing_copies_row_reads_the_shipped_default_and_no_open_writes_it() {
    let mem = Memory::open("sign_in").unwrap();
    let store = Store::new(&mem);
    assert_eq!(copies_source(&store, ACCOUNT).unwrap(), Source::Defaulted(crate::account::rows::shipped().copies.clone()));
    let (_, rules_row) = for_tests();
    assert_eq!(repair_on_open(&store, ACCOUNT, &rules_row).unwrap(), 0);
    assert!(copies(&store, ACCOUNT).unwrap().is_none(), "an open start writes no copies row");
}

/// An account whose copies row was pinned at creation reads its own values, `Stored`, and keeps them through an open.
#[test]
fn a_pinned_copies_row_is_stored_and_an_open_keeps_it() {
    let mem = Memory::open("sign_in").unwrap();
    let store = Store::new(&mem);
    let (copies_row, rules_row) = for_tests();
    write_missing(&store, ACCOUNT, &copies_row, &rules_row).unwrap();
    let pinned = CopySettings { least_copy_keepers: copies_row.least_copy_keepers + 2, ..copies_row.clone() };
    set_copies(&store, ACCOUNT, 1, pinned.clone()).unwrap();
    assert_eq!(copies_source(&store, ACCOUNT).unwrap(), Source::Stored(pinned.clone()));
    repair_on_open(&store, ACCOUNT, &rules_row).unwrap();
    assert_eq!(copies_source(&store, ACCOUNT).unwrap(), Source::Stored(pinned), "a start never replaces a pinned row");
}

#[test]
fn an_own_report_without_a_unit_still_parses_and_a_unit_round_trips() {
    use super::{OwnReport, UnitState};
    let old: OwnReport = serde_json::from_str(r#"{"always_on":true,"takes_new_accounts":false,"has_room":true}"#).unwrap();
    assert_eq!(old.unit, None, "a peer that reports no unit is not read as one with a state");
    let report = OwnReport { unit: Some(UnitState { active: "active".into(), sub: "running".into(), restarts: 3 }), ..old };
    let text = serde_json::to_string(&report).unwrap();
    assert_eq!(serde_json::from_str::<OwnReport>(&text).unwrap(), report);
    assert!(!serde_json::to_string(&OwnReport { unit: None, ..report }).unwrap().contains("unit"), "no unit is not sent");
}
