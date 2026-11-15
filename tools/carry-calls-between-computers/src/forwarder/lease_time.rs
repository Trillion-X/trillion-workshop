//! The computer's lease time and scheduled waits. Transport readiness remains
//! an event; it must never be inferred from time passing.
//!
//! The existing Copies clock is an injected millisecond reader. This extends
//! that seam to the wait for a grant's end and the computer's retry scheduler.
use crate::storage::time_source::Clock;

/// Retain callback lifetime without changing which executor runs it.
pub fn tracked<T>(
    clock: std::sync::Arc<dyn Clock>,
    work: impl FnOnce() -> T + Send + 'static,
) -> impl FnOnce() -> T + Send + 'static {
    struct Finished(std::sync::Arc<dyn Clock>, u64);
    impl Drop for Finished {
        fn drop(&mut self) {
            self.0.task_finished(self.1);
        }
    }
    let id = clock.task_started();
    let finished = Finished(clock, id);
    move || {
        finished.0.task_enter(id);
        let _finished = finished;
        work()
    }
}

/// A scheduled computer callback, using the same native thread as the real host.
pub fn spawn<T: Send + 'static>(
    clock: std::sync::Arc<dyn Clock>,
    work: impl FnOnce() -> T + Send + 'static,
) -> std::thread::JoinHandle<T> {
    std::thread::spawn(tracked(clock, work))
}
