//! The writer keeps writing after the old writer dies (stage 3 item 7, 2026-11-03).
//!
//! Measured on three computers that may answer, each under `serve COMPUTER_CONFIG`, with the writer killed (kill -9):
//! the writer moved every 45-64 s and 11 of 60 writes (one every 2 s) were refused. The cause was each computer's
//! session to the forwarder ending at its lifetime with the next one opened 5 s later (see the stage 3 notes in
//! docs/placement-decision, items 5-7): with the old writer dead, the two computers left need
//! each other for every renewal and every acknowledgement.
//!
//! Here A, B and C each run their own copies, stores and account rows (`move_tests.rs` `World`), A writes, and A is
//! killed. Every 2 s of the shared clock one call goes to the computer the forwarder chooses: the account's row is read
//! from its own copy there, then a record is written there. Once a new writer is chosen, over 5 minutes, not one call is refused and the writer number
//! moves once.

use super::{
    move_tests::{World, ACCOUNT, NAMES, OWNER, RESOURCE},
    rows_copy, ComputersRow,
};
use crate::{
    account::rows::store::Family,
    secrets::secrets_key,
    records::Mutation,
};
use serde_json::json;

/// One call: the account's row `row_id` is read from the copy of the computer the forwarder chooses, then a record is
/// written there. Answers the computer that answered, or why not.
fn call(world: &World, row_id: &str, n: usize) -> Result<String, String> {
    let chosen = world.net.forwarder.chosen_for_test(&world.account.address()).ok_or("503: no computer answers")?;
    let name = NAMES[NAMES.iter().position(|name| world.id(name) == chosen).unwrap()];
    let computer = world.at(name);
    if !rows_copy::holds_list_row(&*computer.raw, row_id) {
        return Err(format!("missing at {name}: the account's row is not in its copy"));
    }
    let mutation = Mutation { id: format!("w-{n}"), expected_version: 0, request_key: format!("w-{n}"), deleted: false,
        value: json!({"kind": "note", "n": n}) };
    computer.copies.write(|records| write_record!(records, OWNER, RESOURCE, mutation))
        .map(|_| name.to_owned())
        .map_err(|refused| format!("refused at {name}: {refused:?}"))
}

fn writing(world: &World) -> Option<&'static str> {
    NAMES.iter().copied().find(|name| world.at(name).copies.holding().is_some() && !world.net.down.lock().unwrap().contains(&world.id(name)))
}

#[test]
fn the_new_writer_keeps_writing_after_the_old_writer_is_killed() {
    let world = World::new();
    let account_root = secrets_key::generate().unwrap();
    let all = world.ids_of(&NAMES);
    let row = ComputersRow::sign_with_voters(&world.account.address(), 1, &all, &all, &all, &world.account).unwrap();
    let a = world.start(0, &row, false, Some(&account_root));
    let b = world.start(1, &row, false, Some(&account_root));
    let c = world.start(2, &row, false, Some(&account_root));
    a.raw_store().insert(Family::Lists, &rows_copy::test_list_row(ACCOUNT, "calls", "calls")).unwrap();
    let row_id = "calls";
    for _ in 0..60 {
        if a.copies.holding().is_some() && b.copies.answers_now() && c.copies.answers_now() {
            break;
        }
        world.step();
    }
    assert!(a.copies.holding().is_some() && b.copies.answers_now() && c.copies.answers_now(), "A writes, B and C answer");

    // Two minutes with A writing: every call is answered (A takes them).
    let mut n = 0;
    let mut failed = Vec::new();
    for second in 0..120 {
        world.step();
        if second % 2 == 0 {
            n += 1;
            if let Err(why) = call(&world, row_id, n) {
                failed.push(why);
            }
        }
    }
    assert_eq!(failed, Vec::<String>::new(), "A answers every call");

    // A is killed.
    world.net.down.lock().unwrap().insert(world.id("A"));
    let mut taken = None;
    for _ in 0..60 {
        world.step();
        if let Some(name) = writing(&world) {
            taken = Some(name);
            break;
        }
    }
    let taken = taken.expect("a new writer is chosen");
    let number = world.at(taken).copies.holding().unwrap();

    // Five minutes of a call every 2 s: none refused, and the writer stays where it went.
    let mut refused = Vec::new();
    let mut moves = 0;
    let mut writer = (taken, number);
    for second in 0..300 {
        world.step();
        if let Some(name) = writing(&world) {
            let now = (name, world.at(name).copies.holding().unwrap());
            if now != writer {
                moves += 1;
                writer = now;
            }
        }
        if second % 2 == 0 {
            n += 1;
            let answered = call(&world, row_id, n);
            if let Err(why) = answered {
                refused.push(format!("{}s: {why}", second));
            }
        }
    }
    let written = 150 - refused.len();
    assert_eq!((refused.clone(), moves), (Vec::<String>::new(), 0),
        "{written} of 150 calls answered after {taken} became the writer at {number}; now {writer:?}");
}

/// A host stop releases a turn, not membership. On its next launch the former writer follows the live writer;
/// it takes a later turn only after that writer releases it. This is the rejoin rule in answer-risk.md, not a
/// preference for the computer that first held the account (old trillion src/record-copies.mjs:3-24 follows the
/// hosted leader; here the leader is the current voted writer, as docs/PRINCIPLES.md requires).
#[test]
fn a_restarted_computer_keeps_its_membership_and_follows_the_live_writer_until_that_writer_releases() {
    let world = World::new();
    let root = secrets_key::generate().unwrap();
    let all = world.ids_of(&NAMES);
    let answering = world.ids_of(&NAMES[..2]);
    let row = ComputersRow::sign_with_voters(&world.account.address(), 1, &all, &answering, &all, &world.account).unwrap();
    let a = world.start(0, &row, false, Some(&root));
    world.start(1, &row, false, Some(&root));
    world.start(2, &row, false, Some(&root));
    for _ in 0..60 {
        world.step();
        if a.copies.holding().is_some() { break; }
    }
    let original_term = a.copies.holding().expect("the first computer holds the first turn");
    a.write("before-stop", "kept before the host stops");

    assert_eq!(a.copies.hand_over_held(), Some(original_term));
    assert_eq!(a.copies.row(), row, "a host stop changes no signed membership or rights");
    world.net.down.lock().unwrap().insert(a.id.clone());
    let mut successor = None;
    for _ in 0..60 {
        world.step();
        if let Some(name) = writing(&world) { successor = Some(name); break; }
    }
    let successor = successor.expect("another eligible computer takes the released turn");
    assert_ne!(successor, "A");
    let live = world.at(successor);
    let live_term = live.copies.holding().unwrap();
    assert!(live_term > original_term);
    live.write("while-stopped", "kept while the first computer is stopped");

    // A new Copies instance opens the same durable local stores, as another app launch does.
    let restarted = world.start(0, &row, false, Some(&root));
    world.net.down.lock().unwrap().remove(&restarted.id);
    for _ in 0..30 { world.step(); }
    assert_eq!(restarted.copies.row(), row, "rejoin retains the account's signed membership");
    assert!(restarted.copies.holding().is_none(), "rejoin must not take a healthy writer's turn");
    assert_eq!(live.copies.holding(), Some(live_term));
    assert_eq!(restarted.copies.read(RESOURCE, "while-stopped").unwrap().record.unwrap().value,
        json!({"kind": "note", "text": "kept while the first computer is stopped"}));

    // When the next holder stops, the first computer remains eligible to win through the same voters.
    assert_eq!(live.copies.hand_over_held(), Some(live_term));
    world.net.down.lock().unwrap().insert(live.id.clone());
    for _ in 0..60 {
        world.step();
        if restarted.copies.holding().is_some() { break; }
    }
    assert!(restarted.copies.holding().is_some_and(|term| term > live_term),
        "the first computer can regain a released turn without rewriting membership");
    restarted.write("after-return", "kept after the first computer wins again");
}
