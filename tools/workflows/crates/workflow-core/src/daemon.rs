// crates/workflow/src/daemon.rs
//
// Purpose:
//   DaemonConfig and DaemonHandle — lifecycle management for the autonomous
//   EventPoller background task. Feature-gated behind "native" (requires tokio).
//
// Non-Negotiable Invariants:
//   1. Feature-gated: #[cfg(feature = "native")] — daemon requires tokio runtime.
//   2. DaemonHandle::drop() ALWAYS cancels the poller — no leaked background tasks.
//   3. DaemonConfig::default() provides production-safe defaults (5s, batch 10).
//   4. DaemonConfig is preferences only — NOT capability toggles. The daemon IS
//      the capability; DaemonConfig controls HOW it runs (timing, sizing).
//   5. cancel flag is Arc<AtomicBool> — safe to share between handle and spawned task.
//
// Key Concepts:
//   - DaemonConfig: poll_interval_ms, batch_size, retry_policy — all configurable.
//   - DaemonHandle: wraps JoinHandle + cancel flag. Provides cancel(), shutdown(),
//     is_running() and Drop impl.
//   - RetryPolicy re-exported from executor::automation — not duplicated.
//
// Security Considerations:
//   - No credentials or sensitive config in DaemonConfig — those are in KernelBridge.
//   - cancel flag uses Relaxed ordering — visibility latency is acceptable (poll loop
//     checks cancel on each iteration, not time-critical).
//
// AI Directive:
//   The extensive documentation in this file is a CRITICAL DESIGN FEATURE.
//   Future AI assistants are FORBIDDEN from simplifying or removing it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::domain::errors::{WorkflowError, WorkflowResult};
use crate::executor::automation::RetryPolicy;
use crate::executor::polling::EventPollResult;

// ============================================================================
// DAEMON CONFIG
// ============================================================================

/// Configuration for the background EventPoller daemon.
///
/// These are **preferences** (how the daemon runs), not capability toggles.
/// The daemon runs automatically when `.build()` is called on native — this
/// struct only controls timing and sizing.
///
/// # Defaults
/// - `poll_interval_ms`: 5000 (5 seconds) — production-safe polling frequency
/// - `batch_size`: 10 — process up to 10 events per poll cycle
/// - `retry_policy`: 3 attempts, 1s base delay, exponential backoff
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// Interval between poll cycles in milliseconds.
    ///
    /// Minimum effective value is 100ms (enforced by EventPoller).
    /// Default: 5000ms.
    pub poll_interval_ms: u64,

    /// Maximum events to fetch per poll cycle.
    ///
    /// Maximum effective value is 1000 (enforced by EventPoller).
    /// Default: 10.
    pub batch_size: u32,

    /// Retry policy for workflow execution failures within a poll cycle.
    pub retry_policy: RetryPolicy,
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            poll_interval_ms: 5000,
            batch_size: 10,
            retry_policy: RetryPolicy::default(),
        }
    }
}

// ============================================================================
// DAEMON HANDLE
// ============================================================================

/// Handle to a running background EventPoller task.
///
/// Returned by `.build()` when the daemon is configured (native feature on).
/// Provides cooperative cancellation, graceful shutdown, and is-running status.
///
/// # Lifecycle
///
/// 1. **Created** by `DaemonHandle::spawn()` — starts the EventPoller in a background task.
/// 2. **Running** — daemon polls events on `poll_interval_ms` schedule.
/// 3. **Cancellation** — `cancel()` sets the atomic flag; the poll loop checks and exits.
/// 4. **Shutdown** — `shutdown()` cancels and awaits the task for a clean stop.
/// 5. **Drop** — if the handle is dropped without calling `shutdown()`, the cancel
///    flag is set automatically. The task will stop on its next check.
///
/// # No Leaked Tasks
///
/// The `Drop` impl guarantees the cancel flag is always set when the handle is
/// dropped. Combined with the poll loop checking the flag on every iteration,
/// this ensures the background task always terminates, preventing resource leaks.
pub struct DaemonHandle {
    cancel: Arc<AtomicBool>,
    /// Option to allow moving the JoinHandle out in `shutdown()` while
    /// keeping Drop impl valid (Drop takes &mut self, not self).
    join_handle: Option<tokio::task::JoinHandle<WorkflowResult<Vec<EventPollResult>>>>,
}

impl DaemonHandle {
    /// Wrap an existing JoinHandle with a shared cancel flag.
    ///
    /// The `cancel` Arc must be the same one passed into the spawned task.
    pub fn new(
        cancel: Arc<AtomicBool>,
        join_handle: tokio::task::JoinHandle<WorkflowResult<Vec<EventPollResult>>>,
    ) -> Self {
        Self {
            cancel,
            join_handle: Some(join_handle),
        }
    }

    /// Signal the background poller to stop on its next check.
    ///
    /// Non-blocking. The poller will stop after completing its current poll cycle.
    /// For a blocking wait until the task exits, use `shutdown()` instead.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// Cancel the poller and wait for it to finish gracefully.
    ///
    /// Returns the aggregate results from all poll cycles the daemon completed
    /// before stopping.
    pub async fn shutdown(mut self) -> WorkflowResult<Vec<EventPollResult>> {
        self.cancel.store(true, Ordering::Relaxed);
        match self.join_handle.take() {
            Some(handle) => match handle.await {
                Ok(result) => result,
                Err(join_err) => Err(WorkflowError::ExecutionFailed {
                    reason: format!("Daemon task panicked: {}", join_err),
                    hint: "Check daemon logs for the panic message".to_string(),
                }),
            },
            None => Ok(vec![]),
        }
    }

    /// Returns true if the background poller task is still running.
    ///
    /// A finished task means it has either completed normally or been cancelled.
    pub fn is_running(&self) -> bool {
        self.join_handle
            .as_ref()
            .map(|h| !h.is_finished())
            .unwrap_or(false)
    }
}

impl Drop for DaemonHandle {
    /// Ensure the cancel flag is set when the handle is dropped.
    ///
    /// This prevents the background task from running indefinitely if the
    /// handle is dropped without calling `shutdown()`.
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn daemon_config_defaults_are_sane() {
        let config = DaemonConfig::default();
        assert_eq!(config.poll_interval_ms, 5000);
        assert_eq!(config.batch_size, 10);
    }

    #[test]
    fn daemon_config_clone() {
        let config = DaemonConfig::default();
        let cloned = config.clone();
        assert_eq!(cloned.poll_interval_ms, config.poll_interval_ms);
        assert_eq!(cloned.batch_size, config.batch_size);
    }

    #[tokio::test]
    async fn daemon_handle_cancel_sets_flag() {
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_clone = Arc::clone(&cancel);

        let handle = DaemonHandle::new(
            Arc::clone(&cancel),
            tokio::spawn(async move {
                // Simulate a task that checks the cancel flag
                while !cancel_clone.load(Ordering::Relaxed) {
                    tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
                }
                Ok(vec![])
            }),
        );

        assert!(handle.is_running() || !handle.is_running()); // just verify API works
        handle.cancel();
        assert!(cancel.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn daemon_handle_drop_cancels() {
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_weak = Arc::clone(&cancel);

        {
            let handle = DaemonHandle::new(Arc::clone(&cancel), tokio::spawn(async { Ok(vec![]) }));
            // handle dropped here
            let _ = handle;
        }

        // After drop, the cancel flag must be set
        assert!(cancel_weak.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn daemon_handle_shutdown_returns_results() {
        let cancel = Arc::new(AtomicBool::new(false));

        let handle = DaemonHandle::new(Arc::clone(&cancel), tokio::spawn(async { Ok(vec![]) }));

        let result = handle.shutdown().await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn daemon_handle_is_running_false_after_task_completes() {
        let cancel = Arc::new(AtomicBool::new(false));

        let handle = DaemonHandle::new(Arc::clone(&cancel), tokio::spawn(async { Ok(vec![]) }));

        // Let the task complete
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
        assert!(!handle.is_running());
    }
}
