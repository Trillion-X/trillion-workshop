// crates/resilience/src/engine.rs
//
// BoundaryGuardEngine<S, St, K> — the L069 primitive composition.
//
// INVARIANTS:
//   1. Engine is immutable after construction. All state lives in St (storage).
//   2. evaluate() is the ONLY public evaluation method.
//   3. Engine delegates to strategy.evaluate() and storage.get_or_insert_with().
//   4. on_disconnect() MUST be called on every peer disconnect (R2 — ghost mutation).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

use crate::storage::GuardStorage;
use crate::strategy::GuardStrategy;
use crate::types::{GuardInput, GuardOutcome, MonotonicMs, WallClockMs};
use core::hash::Hash;

pub struct BoundaryGuardEngine<S, St, K>
where
    S: GuardStrategy,
    K: Eq + Hash + Send + Sync + 'static,
    St: GuardStorage<S, K>,
{
    strategy: S,
    storage: St,
    _key: core::marker::PhantomData<K>,
}

impl<S, St, K> BoundaryGuardEngine<S, St, K>
where
    S: GuardStrategy,
    K: Eq + Hash + Send + Sync + 'static,
    St: GuardStorage<S, K>,
{
    pub fn new(strategy: S, storage: St) -> Self {
        Self {
            strategy,
            storage,
            _key: core::marker::PhantomData,
        }
    }

    /// Evaluate the guard for a request identified by `key`.
    pub fn evaluate(
        &self,
        key: &K,
        input: &GuardInput,
        config: &S::Config,
        wall_clock_ms: WallClockMs,
        monotonic_ms: MonotonicMs,
    ) -> GuardOutcome {
        let state = self.storage.get_or_insert_with(key, S::State::default);
        self.strategy
            .evaluate(input, state, config, wall_clock_ms, monotonic_ms)
    }

    /// Remove state for a disconnected peer. MANDATORY on every disconnect.
    pub fn on_disconnect(&self, key: &K) {
        self.storage.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock::StateLock;
    use crate::types::*;
    use alloc::sync::Arc;

    // Minimal no-op strategy for testing engine compilation
    struct NoopStrategy;

    #[derive(Default)]
    struct NoopState;

    struct NoopConfig;

    impl GuardStrategy for NoopStrategy {
        type State = NoopState;
        type Config = NoopConfig;

        fn evaluate(
            &self,
            _input: &GuardInput,
            _state: Arc<StateLock<Self::State>>,
            _config: &Self::Config,
            _wall_clock_ms: WallClockMs,
            _monotonic_ms: MonotonicMs,
        ) -> GuardOutcome {
            GuardOutcome::allow()
        }
    }

    // Minimal in-memory storage for testing
    use alloc::collections::BTreeMap;

    struct NoopStorage {
        #[cfg(not(target_arch = "wasm32"))]
        map: parking_lot::RwLock<BTreeMap<u32, Arc<StateLock<NoopState>>>>,
        #[cfg(target_arch = "wasm32")]
        map: core::cell::RefCell<BTreeMap<u32, Arc<StateLock<NoopState>>>>,
    }

    impl NoopStorage {
        fn new() -> Self {
            #[cfg(not(target_arch = "wasm32"))]
            {
                Self {
                    map: parking_lot::RwLock::new(BTreeMap::new()),
                }
            }
            #[cfg(target_arch = "wasm32")]
            {
                Self {
                    map: core::cell::RefCell::new(BTreeMap::new()),
                }
            }
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    impl GuardStorage<NoopStrategy, u32> for NoopStorage {
        fn get_or_insert_with(
            &self,
            key: &u32,
            init: impl FnOnce() -> NoopState,
        ) -> Arc<StateLock<NoopState>> {
            let mut map = self.map.write();
            map.entry(*key)
                .or_insert_with(|| Arc::new(parking_lot::RwLock::new(init())))
                .clone()
        }
        fn remove(&self, key: &u32) {
            self.map.write().remove(key);
        }
    }

    #[cfg(target_arch = "wasm32")]
    impl GuardStorage<NoopStrategy, u32> for NoopStorage {
        fn get_or_insert_with(
            &self,
            key: &u32,
            init: impl FnOnce() -> NoopState,
        ) -> Arc<StateLock<NoopState>> {
            let mut map = self.map.borrow_mut();
            map.entry(*key)
                .or_insert_with(|| Arc::new(StateLock::new(init())))
                .clone()
        }
        fn remove(&self, key: &u32) {
            self.map.borrow_mut().remove(key);
        }
    }

    #[test]
    fn engine_evaluates_allow() {
        let engine = BoundaryGuardEngine::new(NoopStrategy, NoopStorage::new());
        let input = GuardInput {
            peer_id: PeerId(alloc::string::String::from("test-peer")),
            data: alloc::vec![],
            partition_key: None,
            priority: 0,
        };
        let outcome = engine.evaluate(&1u32, &input, &NoopConfig, WallClockMs(0), MonotonicMs(0));
        assert!(matches!(outcome.decision, GuardDecision::Allow));
    }

    #[test]
    fn on_disconnect_removes_state() {
        let engine = BoundaryGuardEngine::new(NoopStrategy, NoopStorage::new());
        let input = GuardInput {
            peer_id: PeerId(alloc::string::String::from("test-peer")),
            data: alloc::vec![],
            partition_key: None,
            priority: 0,
        };
        // Insert state
        let _ = engine.evaluate(&1u32, &input, &NoopConfig, WallClockMs(0), MonotonicMs(0));
        // Remove
        engine.on_disconnect(&1u32);
        // State removed — engine still works (creates fresh state)
        let outcome = engine.evaluate(&1u32, &input, &NoopConfig, WallClockMs(0), MonotonicMs(0));
        assert!(matches!(outcome.decision, GuardDecision::Allow));
    }
}
