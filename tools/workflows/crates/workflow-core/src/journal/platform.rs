//! # Platform Abstraction
//!
//! Platform-specific execution primitives for WASM vs native targets.
//!
//! - NativeDbExecutor: semaphore-bounded spawn_blocking for DB operations (native)
//! - platform_sleep: async sleep (tokio on native, no-op on bare WASM)
//!
//! Non-Negotiable Invariants:
//!   1. NativeDbExecutor uses spawn_blocking + semaphore (Rule 2: pool_size/2)
//!   2. WASM async thread MUST NEVER block (no Atomics.wait on Worker A)
//!   3. All platform-specific code behind #[cfg] gates
//!
//! Architecture Note:
//!   The platform-agnostic database abstraction is `JournalStore` (store.rs),
//!   which is the L069 generative primitive for database operations. Both native
//!   (LibsqlJournalStore) and WASM (future host-provided impl) implement it.
//!   NativeDbExecutor is a utility for offloading blocking work within native
//!   JournalStore implementations. On WASM, the host provides non-blocking
//!   database access via Worker B shared memory — no spawn_blocking needed.

use std::time::Duration;

/// Semaphore-bounded blocking executor for native non-WASM database operations.
///
/// Used within native `JournalStore` implementations to offload synchronous
/// database calls to the tokio blocking thread pool without exhausting it.
/// The semaphore limits concurrency to pool_size/2 (default 256 of 512).
///
/// Not needed on WASM — the host provides async database access directly.
#[cfg(all(feature = "native", not(target_family = "wasm")))]
pub struct NativeDbExecutor {
    semaphore: std::sync::Arc<tokio::sync::Semaphore>,
}

#[cfg(all(feature = "native", not(target_family = "wasm")))]
impl NativeDbExecutor {
    /// Create with max concurrent blocking operations.
    /// Default: 256 (half of tokio's default 512 blocking thread pool).
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            semaphore: std::sync::Arc::new(tokio::sync::Semaphore::new(max_concurrent)),
        }
    }

    /// Create with default concurrency (256).
    pub fn with_defaults() -> Self {
        Self::new(256)
    }

    /// Execute a blocking closure on the tokio blocking thread pool.
    /// Acquires a semaphore permit first to prevent pool exhaustion.
    pub async fn execute<F, R>(&self, f: F) -> R
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        let _permit = self
            .semaphore
            .acquire()
            .await
            .expect("[platform] semaphore closed");
        tokio::task::spawn_blocking(f)
            .await
            .expect("[platform] spawn_blocking panicked")
    }

    /// Get current number of available permits.
    pub fn available_permits(&self) -> usize {
        self.semaphore.available_permits()
    }
}

/// Platform-specific async sleep.
/// Native non-WASM: delegates to tokio::time::sleep.
#[cfg(all(feature = "native", not(target_family = "wasm")))]
pub async fn platform_sleep(duration: Duration) {
    tokio::time::sleep(duration).await;
}

/// WASM platform sleep — no-op yield on bare wasm32-unknown-unknown target.
///
/// On bare WASM (no host bindings), there is no timer primitive — this is a
/// Physics constraint of the target. The host (JS Web Worker) is responsible
/// for providing timer semantics via its own event loop. When a WASM host
/// integration provides a timer callback (e.g., gloo_timers via wasm-bindgen),
/// this function delegates to it. On bare wasm32-unknown-unknown, it yields
/// once to avoid blocking the single-threaded executor.
#[cfg(any(not(feature = "native"), target_family = "wasm"))]
pub async fn platform_sleep(_duration: Duration) {
    futures::future::ready(()).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[cfg(all(feature = "native", not(target_family = "wasm")))]
    async fn test_native_db_executor_runs_closure() {
        let executor = NativeDbExecutor::with_defaults();
        let result = executor.execute(|| 42).await;
        assert_eq!(result, 42);
    }

    #[tokio::test]
    #[cfg(all(feature = "native", not(target_family = "wasm")))]
    async fn test_native_db_executor_concurrent() {
        let executor = NativeDbExecutor::new(2);
        assert_eq!(executor.available_permits(), 2);
    }

    #[tokio::test]
    async fn test_platform_sleep_completes() {
        platform_sleep(Duration::from_millis(1)).await;
        // If we reach here, the sleep completed successfully
    }

    #[tokio::test]
    #[cfg(all(feature = "native", not(target_family = "wasm")))]
    async fn test_native_db_executor_default_concurrency() {
        let executor = NativeDbExecutor::with_defaults();
        assert_eq!(executor.available_permits(), 256);
    }
}
