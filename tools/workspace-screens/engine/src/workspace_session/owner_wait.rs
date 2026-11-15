//! Bounded borrowing of the EXISTING account mutex. Contention is not missing
//! authority. Callers check current source/session after acquisition and keep
//! their existing cancellation, operation deadline and response witnesses.
//!
//! A waiter sleeps until the owner is given back, never on a polling step: every
//! owner lent here is a [`Held`], and dropping it wakes the waiters. The count
//! of releases is read before each `try_lock`, so a release between a failed try
//! and the sleep is never missed. A waiter also wakes every `CANCEL_CHECK` to
//! read its cancel closure (a flag or a deadline carries no wake of its own) and
//! to try again after an owner taken with a plain `lock()`, which gives no
//! release signal.
use std::{
    future::Future,
    ops::{Deref, DerefMut},
    pin::Pin,
    sync::{
        atomic::{fence, AtomicUsize, Ordering},
        Condvar, Mutex, MutexGuard, TryLockError,
    },
    task::{Context, Poll, Waker},
    time::{Duration, Instant},
};
const LIMIT: Duration = Duration::from_secs(2);
const CANCEL_CHECK: Duration = Duration::from_millis(20);
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Error {
    Cancelled(crate::refusal_cause::Cause),
    Unavailable(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Cancelled(cause) => cause.clone(),
            Self::Unavailable(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);


/// Releases of any lent owner, and the asynchronous waiters to wake on the next one.
struct Releases {
    count: u64,
    wakers: Vec<Waker>,
}
static RELEASES: Mutex<Releases> = Mutex::new(Releases { count: 0, wakers: Vec::new() });
static RELEASED: Condvar = Condvar::new();
/// Waiters asleep or about to sleep; a release with none takes no lock.
static WAITERS: AtomicUsize = AtomicUsize::new(0);

fn releases() -> MutexGuard<'static, Releases> {
    RELEASES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A lent owner. Dropping it gives the owner back and wakes whoever waits for one.
pub(crate) struct Held<'a, T> {
    guard: Option<MutexGuard<'a, T>>,
}
impl<T> Deref for Held<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.guard.as_deref().expect("a held owner keeps its guard until drop")
    }
}
impl<T> DerefMut for Held<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        self.guard.as_deref_mut().expect("a held owner keeps its guard until drop")
    }
}
impl<T> Drop for Held<'_, T> {
    fn drop(&mut self) {
        drop(self.guard.take());
        fence(Ordering::SeqCst);
        if WAITERS.load(Ordering::SeqCst) == 0 {
            return;
        }
        let mut released = releases();
        released.count = released.count.wrapping_add(1);
        let wakers = std::mem::take(&mut released.wakers);
        WAITERS.fetch_sub(wakers.len(), Ordering::SeqCst);
        drop(released);
        RELEASED.notify_all();
        for waker in wakers {
            waker.wake();
        }
    }
}

/// One synchronous waiter counted in `WAITERS` for as long as it lives.
struct Waiting;
impl Waiting {
    fn new() -> Self {
        WAITERS.fetch_add(1, Ordering::SeqCst);
        fence(Ordering::SeqCst);
        Waiting
    }
    /// Sleep until a release after `seen`, or for at most `most`.
    fn sleep(&self, seen: u64, most: Duration) {
        let released = releases();
        if released.count != seen {
            return;
        }
        drop(RELEASED.wait_timeout(released, most));
    }
}
impl Drop for Waiting {
    fn drop(&mut self) {
        WAITERS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The owner at once, only when it is free and no one waits for any owner; else None. Idle upkeep takes it this way,
/// so it never goes ahead of a waiting request, and one that comes during it waits out only its own short step.
pub(crate) fn try_idle<T>(owner: &Mutex<T>) -> Option<Held<'_, T>> {
    if WAITERS.load(Ordering::SeqCst) != 0 {
        return None;
    }
    owner.try_lock().ok().map(|guard| Held { guard: Some(guard) })
}

pub(crate) fn acquire<T>(owner: &Mutex<T>, cancelled: impl Fn() -> bool) -> Result<Held<'_, T>, Error> {
    acquire_before(owner, cancelled, Instant::now() + LIMIT, CANCEL_CHECK)
}

/// Native background maintenance has no request deadline. A foreground owner
/// is contention, not a failed source: keep waiting until custody is available
/// or the parent lifetime is cancelled. Poisoning still refuses immediately.
pub(crate) fn acquire_background<T>(owner: &Mutex<T>, cancelled: impl Fn() -> bool) -> Result<Held<'_, T>, Error> {
    let waiting = Waiting::new();
    loop {
        if cancelled() {
            return Err(crate::cause!(Error::Cancelled));
        }
        let seen = releases().count;
        match owner.try_lock() {
            Ok(guard) => {
                let held = Held { guard: Some(guard) };
                if cancelled() {
                    return Err(crate::cause!(Error::Cancelled));
                }
                return Ok(held);
            }
            Err(TryLockError::Poisoned(_)) => return Err(crate::cause!(Error::Unavailable)),
            Err(TryLockError::WouldBlock) => waiting.sleep(seen, CANCEL_CHECK),
        }
    }
}

fn acquire_before<T>(
    owner: &Mutex<T>,
    cancelled: impl Fn() -> bool,
    deadline: Instant,
    check: Duration,
) -> Result<Held<'_, T>, Error> {
    let waiting = Waiting::new();
    loop {
        if cancelled() {
            return Err(crate::cause!(Error::Cancelled));
        }
        if Instant::now() >= deadline {
            return Err(crate::cause!(Error::Unavailable));
        }
        let seen = releases().count;
        match owner.try_lock() {
            Ok(guard) => {
                let held = Held { guard: Some(guard) };
                if cancelled() {
                    return Err(crate::cause!(Error::Cancelled));
                }
                if Instant::now() >= deadline {
                    return Err(crate::cause!(Error::Unavailable));
                }
                return Ok(held);
            }
            Err(TryLockError::Poisoned(_)) => return Err(crate::cause!(Error::Unavailable)),
            Err(TryLockError::WouldBlock) => {}
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(crate::cause!(Error::Unavailable));
        }
        waiting.sleep(seen, check.min(left));
    }
}

pub(crate) struct OwnerWait {
    deadline: Option<Instant>,
    delay: Option<Pin<Box<tokio::time::Sleep>>>,
}
impl OwnerWait {
    pub(crate) fn new() -> Self {
        Self {
            deadline: None,
            delay: None,
        }
    }
    /// Ready with the owner, or pending until its release (the task's waker is woken by it), the next
    /// `CANCEL_CHECK` or the deadline.
    pub(crate) fn poll<'a, T>(
        &mut self,
        owner: &'a Mutex<T>,
        cancelled: bool,
        cx: &mut Context<'_>,
    ) -> Poll<Result<Held<'a, T>, Error>> {
        if cancelled {
            return Poll::Ready(Err(crate::cause!(Error::Cancelled)));
        }
        let deadline = *self.deadline.get_or_insert_with(|| Instant::now() + LIMIT);
        if Instant::now() >= deadline {
            return Poll::Ready(Err(crate::cause!(Error::Unavailable)));
        }
        let seen = releases().count;
        match owner.try_lock() {
            Ok(guard) => {
                let held = Held { guard: Some(guard) };
                if Instant::now() < deadline {
                    self.delay = None;
                    Poll::Ready(Ok(held))
                } else {
                    Poll::Ready(Err(crate::cause!(Error::Unavailable)))
                }
            }
            Err(TryLockError::Poisoned(_)) => Poll::Ready(Err(crate::cause!(Error::Unavailable))),
            Err(TryLockError::WouldBlock) => {
                let mut released = releases();
                if released.count != seen {
                    drop(released);
                    cx.waker().wake_by_ref();
                    return Poll::Pending;
                }
                if !released.wakers.iter().any(|waker| waker.will_wake(cx.waker())) {
                    released.wakers.push(cx.waker().clone());
                    WAITERS.fetch_add(1, Ordering::SeqCst);
                }
                drop(released);
                let check = CANCEL_CHECK.min(deadline.saturating_duration_since(Instant::now()));
                let mut delay = Box::pin(tokio::time::sleep(check));
                if delay.as_mut().poll(cx).is_ready() {
                    cx.waker().wake_by_ref();
                }
                self.delay = Some(delay);
                Poll::Pending
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn elapsed_wait_refuses_even_when_owner_is_free() {
        let owner = Mutex::new(7);
        assert!(matches!(acquire_before(&owner, || false, Instant::now(), CANCEL_CHECK).err(), Some(Error::Unavailable(_))));
        assert_eq!(*owner.lock().unwrap(), 7);
    }

    #[test]
    fn cancellation_before_and_after_acquisition_releases_owner() {
        let owner = Mutex::new(7);
        assert!(matches!(acquire(&owner, || true).err(), Some(Error::Cancelled(_))));
        let calls = AtomicUsize::new(0);
        assert!(matches!(acquire(&owner, || calls.fetch_add(1, Ordering::SeqCst) > 0).err(), Some(Error::Cancelled(_))));
        assert_eq!(*owner.try_lock().unwrap(), 7);
    }

    #[test]
    fn poisoned_owner_is_unavailable() {
        let owner = Arc::new(Mutex::new(7));
        let other = owner.clone();
        assert!(std::thread::spawn(move || {
            let _held = other.lock().unwrap();
            panic!("fixture poison");
        })
        .join()
        .is_err());
        assert!(matches!(acquire(&owner, || false).err(), Some(Error::Unavailable(_))));
    }

    #[test]
    fn completed_wait_observes_latest_owner_value() {
        let owner = Arc::new(Mutex::new(7));
        let held = acquire(&owner, || false).unwrap();
        let other = owner.clone();
        let waiting = std::thread::spawn(move || *acquire(&other, || false).unwrap());
        let mut held = held;
        *held = 9;
        drop(held);
        assert_eq!(waiting.join().unwrap(), 9);
    }

    /// The waiter's own re-check is ten seconds away, so taking the owner well before it proves the release
    /// woke the waiter.
    #[test]
    fn a_release_wakes_the_waiter_without_a_polling_step() {
        let owner = Arc::new(Mutex::new(7));
        let held = acquire(&owner, || false).unwrap();
        let other = owner.clone();
        let waiting = std::thread::spawn(move || {
            let got = acquire_before(&other, || false, Instant::now() + Duration::from_secs(20), Duration::from_secs(10))
                .map(|guard| *guard);
            (got, Instant::now())
        });
        std::thread::sleep(Duration::from_millis(100));
        let released = Instant::now();
        drop(held);
        let (got, at) = waiting.join().unwrap();
        assert_eq!(got, Ok(7));
        assert!(at.duration_since(released) < Duration::from_secs(5));
    }

    #[test]
    fn background_contention_waits_beyond_request_limit_and_remains_cancellable() {
        let owner = Arc::new(Mutex::new(7));
        let held = owner.lock().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let other = owner.clone();
        let stop = cancelled.clone();
        let waiting = std::thread::spawn(move || {
            acquire_background(&other, || stop.load(Ordering::Acquire)).map(|guard| *guard)
        });
        std::thread::sleep(LIMIT + CANCEL_CHECK);
        cancelled.store(true, Ordering::Release);
        assert!(matches!(waiting.join().unwrap(), Err(Error::Cancelled(_))));
        drop(held);
        assert_eq!(*owner.try_lock().unwrap(), 7);
    }

    #[tokio::test]
    async fn asynchronous_elapsed_wait_refuses_a_free_owner() {
        let owner = Mutex::new(7);
        let mut wait = OwnerWait::new();
        wait.deadline = Some(Instant::now());
        let result = std::future::poll_fn(|cx| wait.poll(&owner, false, cx)).await;
        assert!(matches!(result.err(), Some(Error::Unavailable(_))));
        assert_eq!(*owner.try_lock().unwrap(), 7);
    }

    #[tokio::test]
    async fn asynchronous_wait_is_woken_by_the_release() {
        let owner = Arc::new(Mutex::new(7));
        let held = acquire(&owner, || false).unwrap();
        let other = owner.clone();
        let waiting = tokio::spawn(async move {
            let mut wait = OwnerWait::new();
            std::future::poll_fn(|cx| wait.poll(&other, false, cx).map(|got| got.map(|guard| *guard))).await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(held);
        assert_eq!(waiting.await.unwrap(), Ok(7));
    }
}

// ---- incident 7 (busy write answers 503; a fixed 2 s owner wait expires under load) ----

#[cfg(test)]
mod scenario_tests {
    use super::*;

    /// Incident 7: a foreground request that waits on an owner which another request holds for 2.5 s is contention, not a
    /// failed source. It must be granted once the owner is released. Today the wait stops at the fixed `LIMIT` (2 s) and the
    /// request answers source unavailable, so this scenario fails until the wait is a DATA row with its own bound (D31).
    fn busy_owner_is_granted_when_released_not_unavailable_body() -> std::result::Result<(), String> {
        let owner = std::sync::Arc::new(Mutex::new(0_u8));
        let held = std::sync::Arc::clone(&owner);
        let release = std::thread::spawn(move || {
            let _guard = held.lock().unwrap();
            std::thread::sleep(Duration::from_millis(2_500));
        });
        std::thread::sleep(Duration::from_millis(50));
        let granted = acquire(&owner, || false);
        release.join().unwrap();
        match granted {
            Ok(_) => Ok(()),
            Err(error) => Err(format!("a busy owner released after 2.5 s was refused: {error:?}")),
        }
    }

    #[test]
    fn busy_owner_is_granted_when_released_not_unavailable() {
        crate::simulation::verdict("busy-owner-is-granted-when-released-not-unavailable", busy_owner_is_granted_when_released_not_unavailable_body);
    }
}
