//! The same pause with the term clock running in real time (test 3 of tests/answering_computers_hold_acknowledged_writes.rs).
//! The real-time suite: it reads wall time on purpose, so it runs apart from the virtual-time tests.

include!("answering_computers/fixture.rs");

use std::time::Instant;

/// (3) The same pause with the term clock running in real time, as on a real computer: every message to the paused A
/// costs the new writer `message_wait_ms`, and a claim or renewal spends that time on the clock its term is counted on.
/// Measured on 2026-11-03 in the real multi-computer setup: after the term ran out, 21 of 21 writes were refused.
/// Here the writes come after the bound `term_ms + clock_margin_ms + renew_every_ms` of A's last renewal, each a
/// request at B (`wake`, then `write`), while B's and C's timers run every `renew_every_ms` as the engine's do.
#[test]
fn with_a_real_term_clock_the_writes_after_a_paused_writers_term_are_acknowledged() {
    let world = world();
    world.start_with_a();
    let numbers = settings();
    world.computer("A").write("before-pause", json!({"kind": "note", "text": "before the pause"})).unwrap();

    // From here the term clock is real time.
    let stop = Arc::new(AtomicBool::new(false));
    let clock = world.clock.clone();
    let started = Instant::now();
    let base = world.now();
    let running = stop.clone();
    let clock_thread = std::thread::spawn(move || while !running.load(Ordering::Acquire) {
        clock.store(base + started.elapsed().as_millis() as i64, Ordering::Release);
        std::thread::sleep(Duration::from_millis(2));
    });
    world.computer("A").copies.tick();
    let renewed_at = world.now();
    assert_eq!(world.writers(&NAMES), vec!["A"], "A renewed its term");
    world.computer("A").pause();

    std::thread::scope(|scope| {
        for name in ["B", "C"] {
            let copies = world.computer(name).copies.clone();
            let running = stop.clone();
            scope.spawn(move || while !running.load(Ordering::Acquire) {
                copies.step_if_active();
                std::thread::sleep(Duration::from_millis(numbers.renew_every_ms as u64));
            });
        }
        let bound = renewed_at + numbers.term_ms + numbers.clock_margin_ms + numbers.renew_every_ms;
        let b = world.computer("B");
        while world.now() < bound {
            b.copies.wake();
            std::thread::sleep(Duration::from_millis(100));
        }
        let writes = 21;
        let mut refused = Vec::new();
        for n in 0..writes {
            b.copies.wake();
            let id = format!("after-pause-{n:02}");
            let at = world.now() - renewed_at;
            if let Err(error) = b.write(&id, json!({"kind": "note", "text": "after the pause"})) {
                refused.push(format!("{id} at {at} ms: {error:?}"));
            }
        }
        stop.store(true, Ordering::Release);
        assert!(refused.is_empty(), "{} of {writes} writes at B refused after A's term ran out: {refused:#?}", refused.len());
        assert_eq!(b.record("before-pause").map(|(version, _)| version), Some(1), "the write acknowledged before the pause is at the new writer");
    });
    let _ = clock_thread.join();
}
