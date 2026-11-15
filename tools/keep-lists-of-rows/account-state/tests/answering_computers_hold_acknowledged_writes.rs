//! Every computer that may answer holds every acknowledged write, and an expired writer term is taken in a bound.
//!
//! Measured by lane second-place on 2026-11-03 with two computers that may answer (A, B) and one that only keeps a copy
//! (C): an acknowledged write was held only by C, and killing the writer lost it from every computer that may answer.
//! After the writer's term ran out with the writer paused, no computer took it: 21 of 21 writes were refused.
//!
//! The setup is `tests/computer_copies.rs`'s: each computer has its own records store file, its own sign-in rows and its
//! own session to a forwarder that runs in this process and stores nothing; every message between computers goes through
//! that forwarder. The term clock is one shared simulated clock; the forwarder's clock and every proof are real time.
//!
//! (1) A writes `rows` rows (`tests/fixtures/answering-computers.json`), B replying a little slower than C. Each acknowledged write is held by every computer that may answer (A and B) before the
//!     write returns, with nobody pulling in between. A is killed; B takes the writer turn and every row reads back
//!     from it.
//! (2) A is paused while it holds the term: its session stays open but it answers nothing and runs no timer. Another
//!     voter takes the term within `term_ms + clock_margin_ms + renew_every_ms` of A's last renewal (each read from
//!     `src/account/computers/settings.json`), and its next write is acknowledged.

include!("answering_computers/fixture.rs");

#[test]
fn every_computer_that_may_answer_holds_every_acknowledged_write_and_the_next_writer_reads_them_back() {
    let world = world();
    world.start_with_a();
    let a = world.computer("A");
    assert_eq!(world.may_answer().iter().map(|computer| computer.name).collect::<Vec<_>>(), vec!["A", "B"]);

    // `rows` writes through A, with no computer pulling in between: what a computer that may answer holds when the write
    // returns is what the acknowledgement put there. B answers each message `slow_answer_ms` late, so C, which only keeps
    // a copy, answers A first: a bare majority (A and C) is not enough.
    world.computer("B").slow.store(fixture().slow_answer_ms, Ordering::Release);
    let mut missing = Vec::new();
    for n in 0..fixture().rows {
        let (id, value) = row(n);
        // The computers' timers renew the writer term while writes keep coming; each slow answer moves the clock on, so
        // the same renewal runs here before each write.
        world.tick(&NAMES);
        a.write(&id, value.clone()).unwrap_or_else(|refused| panic!("write {id} refused with every computer up: {refused:?}"));
        for computer in world.may_answer() {
            if computer.record(&id) != Some((1, value.clone())) {
                missing.push(format!("{id} at {}", computer.name));
            }
        }
    }
    assert_eq!(missing, Vec::<String>::new(),
        "every acknowledged write is held by every computer that may answer before the write returns ({} of {} missing)",
        missing.len(), fixture().rows * MAY_ANSWER);

    world.computer("B").slow.store(0, Ordering::Release);

    // The writer is killed. The next writer is a computer that may answer, and every acknowledged row reads back from it.
    a.kill();
    world.run(world.term_runs_out(), &["B", "C"]);
    assert_eq!(world.writers(&["B", "C"]), vec!["B"], "B, the other computer that may answer, takes the writer turn");
    let b = world.computer("B");
    let lost: Vec<String> = (0..fixture().rows).map(row).filter(|(id, value)| b.record(id) != Some((1, value.clone()))).map(|(id, _)| id).collect();
    assert_eq!(lost, Vec::<String>::new(), "{} of {} acknowledged rows lost at the next writer", lost.len(), fixture().rows);
    b.write("after-kill", json!({"kind": "note", "text": "after the kill"})).expect("the next writer's write is acknowledged");
}

#[test]
fn an_expired_term_of_a_paused_writer_is_taken_within_its_bound_and_the_next_write_is_acknowledged() {
    let world = world();
    world.start_with_a();
    let numbers = settings();
    // A renews once more, so its last renewal is at a known time, then writes, then pauses.
    world.advance(numbers.renew_every_ms);
    world.tick(&["A"]);
    let renewed_at = world.now();
    assert_eq!(world.writers(&NAMES), vec!["A"], "A renewed its term");
    world.tick(&["B", "C"]);
    world.computer("A").write("before-pause", json!({"kind": "note", "text": "before the pause"})).unwrap();
    world.computer("A").pause();

    // B and C run their timers every `renew_every_ms`; A runs none and answers nothing.
    let bound = renewed_at + numbers.term_ms + numbers.clock_margin_ms + numbers.renew_every_ms;
    let mut taken = None;
    let mut refused = Vec::new();
    while world.now() < bound + numbers.term_ms {
        world.advance(numbers.renew_every_ms);
        world.tick(&["B", "C"]);
        let writers = world.writers(&["B", "C"]);
        assert!(writers.len() <= 1, "two computers hold the writer turn: {writers:?}");
        if let Some(name) = writers.first() {
            taken = Some((*name, world.now()));
            break;
        }
        refused.push(world.now() - renewed_at);
    }
    let (writer, at) = taken.unwrap_or_else(|| panic!(
        "no computer took the expired term; steps without a writer, ms after A's last renewal: {refused:?}"));
    assert!(at <= bound, "{writer} took the term {} ms after A's last renewal, past term_ms + clock_margin_ms + renew_every_ms = {} ms",
        at - renewed_at, bound - renewed_at);
    assert_eq!(writer, "B", "the only other computer that may answer takes it");
    let b = world.computer("B");
    b.write("after-pause", json!({"kind": "note", "text": "after the pause"})).expect("the new writer's next write is acknowledged");
    assert_eq!(b.record("after-pause").map(|(version, _)| version), Some(1));
    assert_eq!(b.record("before-pause").map(|(version, _)| version), Some(1), "the write acknowledged before the pause is at the new writer");
}
