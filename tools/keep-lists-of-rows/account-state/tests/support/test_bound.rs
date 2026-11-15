//! A bound for a test that could stall the whole suite: its body runs on its own thread, and the test fails by its
//! name if the body has not finished in time. A body that panics fails the test with its own panic message.
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::Duration;

/// Run `body` and fail the test named `name` if it does not finish within `limit`.
pub fn within<F: FnOnce() + Send + 'static>(name: &str, limit: Duration, body: F) {
    let (done, finished) = channel();
    std::thread::spawn(move || {
        body();
        let _ = done.send(());
    });
    match finished.recv_timeout(limit) {
        Ok(()) => {}
        Err(RecvTimeoutError::Disconnected) => panic!("{name}: its body panicked"),
        Err(RecvTimeoutError::Timeout) => panic!("{name} did not finish within {limit:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::within;
    use std::time::Duration;

    #[test]
    fn a_body_that_stalls_fails_by_name_and_one_that_finishes_passes() {
        within("finishes", Duration::from_secs(5), || {});
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let stalled = std::panic::catch_unwind(move || within("stalls", Duration::from_millis(50), move || {
            let _ = gate.recv();
        }));
        drop(release);
        let message = stalled.unwrap_err().downcast::<String>().unwrap();
        assert!(message.contains("stalls did not finish within"), "{message}");
    }
}
