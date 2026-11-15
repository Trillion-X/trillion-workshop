//! The one clock of the engine: milliseconds, a wait, and a generation-counted event. Storage owns it because every
//! other layer already depends on storage; the record store, the forwarder and Copies all read this trait, and tests
//! supply their own clock (`RealClock` is the system's, the host's on a WebAssembly module).
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
    fn monotonic_ms(&self) -> i64 {
        self.now_ms()
    }
    /// Waits in real time; a virtual clock overrides it.
    fn wait(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
    /// Wake scheduled waits when the host is stopping; the real scheduler's existing poll bounds remain in force.
    fn wake(&self) {}
    /// A host scheduler may observe callback lifetime so virtual time advances only between completed turns.
    fn task_started(&self) -> u64 {
        0
    }
    fn task_enter(&self, _id: u64) {}
    fn task_finished(&self, _id: u64) {}
    fn wait_expiry(&self, duration: Duration) {
        self.wait(duration);
    }
    fn wait_changed(
        &self,
        event: &std::sync::Arc<Event>,
        generation: u64,
        bound: Option<Duration>,
    ) {
        event.wait(generation, bound);
    }
}

/// The system's milliseconds since the Unix epoch. A computer whose host runs this as a WebAssembly module has no system
/// clock: its host's clock is the one read.
#[cfg(all(hosted_records, target_arch = "wasm32"))]
fn system_now_ms() -> i64 {
    crate::host_clock::now_ms() as i64
}
#[cfg(not(all(hosted_records, target_arch = "wasm32")))]
fn system_now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

pub struct RealClock;

impl Clock for RealClock {
    fn monotonic_ms(&self) -> i64 {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_millis() as i64
    }
    fn now_ms(&self) -> i64 {
        system_now_ms()
    }
}

/// A clock that reads one time, for tests of code that takes a clock and never moves.
#[cfg(test)]
pub fn fixed(now_ms: i64) -> std::sync::Arc<dyn Clock> {
    std::sync::Arc::new(Fixed(now_ms))
}

#[cfg(test)]
struct Fixed(i64);

#[cfg(test)]
impl Clock for Fixed {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

/// A generation-counted event. Register before inspecting a condition, then
/// wait on that generation so a change between the check and wait is retained.
#[derive(Default)]
pub struct Event {
    generation: std::sync::Mutex<u64>,
    changed: std::sync::Condvar,
}

impl Event {
    pub fn generation(&self) -> u64 {
        *self.generation.lock().unwrap()
    }
    pub fn notify(&self) {
        *self.generation.lock().unwrap() += 1;
        self.changed.notify_all();
    }
    pub fn pulse(&self) {
        let _guard = self.generation.lock().unwrap();
        self.changed.notify_all();
    }
    pub fn wait_while(&self, generation: u64, pending: impl Fn() -> bool) {
        let mut guard = self.generation.lock().unwrap();
        while *guard == generation && pending() {
            guard = self.changed.wait(guard).unwrap();
        }
    }
    pub fn wait(&self, generation: u64, bound: Option<Duration>) {
        let guard = self.generation.lock().unwrap();
        match bound {
            Some(bound) => {
                drop(
                    self.changed
                        .wait_timeout_while(guard, bound, |value| *value == generation)
                        .unwrap(),
                );
            }
            None => {
                drop(
                    self.changed
                        .wait_while(guard, |value| *value == generation)
                        .unwrap(),
                );
            }
        }
    }
}

