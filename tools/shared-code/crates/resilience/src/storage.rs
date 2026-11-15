// crates/resilience/src/storage.rs
//
// GuardStorage<S, K> trait — per-key state lifecycle management.
//
// INVARIANTS:
//   1. get_or_insert_with() creates state ONCE per key on first access (no thundering herd).
//   2. remove() is O(1): removes state for a disconnected peer.
//   3. K is the key type — for example PeerId or a partition key.
//   4. Implementations (MokaStorage, LruStorage) live in hosts, NOT in this crate.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

use crate::lock::StateLock;
use crate::strategy::GuardStrategy;
use alloc::sync::Arc;

#[cfg(not(target_arch = "wasm32"))]
pub trait GuardStorage<S: GuardStrategy, K: Eq + core::hash::Hash + Send + Sync + 'static>:
    Send + Sync + 'static
{
    fn get_or_insert_with(
        &self,
        key: &K,
        init: impl FnOnce() -> S::State,
    ) -> Arc<StateLock<S::State>>;
    fn remove(&self, key: &K);
}

#[cfg(target_arch = "wasm32")]
pub trait GuardStorage<S: GuardStrategy, K: Eq + core::hash::Hash + 'static> {
    fn get_or_insert_with(
        &self,
        key: &K,
        init: impl FnOnce() -> S::State,
    ) -> Arc<StateLock<S::State>>;
    fn remove(&self, key: &K);
}
