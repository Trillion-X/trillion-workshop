//! crates/composition-ast/src/binding/cache.rs
//!
//! Deterministic, minimal, and fast bounded LRU cache for pure evaluation paths.
//!
//! Used by the Binding Engine to memoize intermediate operator results and by
//! hosts to memoize compiled artifacts. No timers, no async. Pure semantics:
//! cache presence must never change correctness, only performance.
//!
//! Non-Negotiable Invariants:
//! - Bounded memory via capacity. Eviction is LRU, stable, and deterministic.
//! - No wall-clock TTL. Time is not consulted to preserve determinism.
//! - Keys are used by identity and must be stable strings.
//! - API returns cloned values; it never mutates stored entries.
//!
//! Key Concepts:
//! - LRUCache<V>: small-footprint implementation with O(1) get/set/delete.
//! - Stats: hit/miss/evict counters for observability. No external logging here.
//! - Snapshot: export for debugging or audit logs.
//!
//! Security Considerations:
//! - Not a security boundary. Do not store secrets here beyond a tick.
//! - Avoid using untrusted user input as keys without canonicalization.
//!
//! Ported from: frontends/web/composition-engine/binding/cache.ts

use std::collections::HashMap;

// ============================================================================
// Cache Statistics
// ============================================================================

/// Statistics for cache observability
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub sets: u64,
    pub evictions: u64,
    pub size: usize,
    pub capacity: usize,
}

// ============================================================================
// LRU Cache Implementation
// ============================================================================

/// Entry in the LRU cache with order tracking
struct CacheEntry<V> {
    value: V,
    order: u64,
}

/// Bounded LRU cache. Deterministic eviction order via insertion sequence.
///
/// Note: This is a simple implementation using HashMap with order tracking.
/// For production use with high throughput, consider using `lru` crate.
pub struct LRUCache<V> {
    map: HashMap<String, CacheEntry<V>>,
    capacity: usize,
    counter: u64,
    hits: u64,
    misses: u64,
    sets: u64,
    evictions: u64,
}

impl<V: Clone> LRUCache<V> {
    /// Create a new LRU cache with the given capacity.
    ///
    /// # Panics
    /// Panics if capacity is 0.
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "LRUCache capacity must be positive");
        Self {
            map: HashMap::with_capacity(capacity),
            capacity,
            counter: 0,
            hits: 0,
            misses: 0,
            sets: 0,
            evictions: 0,
        }
    }

    /// Get a value from the cache, updating its LRU position.
    pub fn get(&mut self, key: &str) -> Option<V> {
        if let Some(entry) = self.map.get_mut(key) {
            self.hits += 1;
            self.counter += 1;
            entry.order = self.counter;
            Some(entry.value.clone())
        } else {
            self.misses += 1;
            None
        }
    }

    /// Check if a key exists without updating LRU position or stats.
    pub fn contains(&self, key: &str) -> bool {
        self.map.contains_key(key)
    }

    /// Insert a value into the cache.
    pub fn set(&mut self, key: String, value: V) {
        self.sets += 1;
        self.counter += 1;

        if self.map.contains_key(&key) {
            // Update existing entry
            if let Some(entry) = self.map.get_mut(&key) {
                entry.value = value;
                entry.order = self.counter;
            }
            return;
        }

        // Evict if at capacity
        self.evict_if_needed();

        // Insert new entry
        self.map.insert(
            key,
            CacheEntry {
                value,
                order: self.counter,
            },
        );
    }

    /// Remove a key from the cache.
    pub fn delete(&mut self, key: &str) -> bool {
        self.map.remove(key).is_some()
    }

    /// Clear all entries and reset stats.
    pub fn clear(&mut self) {
        self.map.clear();
        self.hits = 0;
        self.misses = 0;
        self.sets = 0;
        self.evictions = 0;
        self.counter = 0;
    }

    /// Get the current number of entries.
    pub fn size(&self) -> usize {
        self.map.len()
    }

    /// Get the capacity.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Get all keys in the cache (order not guaranteed).
    pub fn keys(&self) -> Vec<&String> {
        self.map.keys().collect()
    }

    /// Get cache statistics.
    pub fn stats(&self) -> CacheStats {
        CacheStats {
            hits: self.hits,
            misses: self.misses,
            sets: self.sets,
            evictions: self.evictions,
            size: self.map.len(),
            capacity: self.capacity,
        }
    }

    /// Export a snapshot for debugging or audit.
    pub fn snapshot(&self) -> Vec<(String, V)> {
        self.map
            .iter()
            .map(|(k, v)| (k.clone(), v.value.clone()))
            .collect()
    }

    /// Evict the least recently used entry if at capacity.
    fn evict_if_needed(&mut self) {
        while self.map.len() >= self.capacity {
            // Find the entry with the lowest order
            let lru_key = self
                .map
                .iter()
                .min_by_key(|(_, entry)| entry.order)
                .map(|(k, _)| k.clone());

            if let Some(key) = lru_key {
                self.map.remove(&key);
                self.evictions += 1;
            } else {
                break;
            }
        }
    }
}

// ============================================================================
// Memoization Helpers
// ============================================================================

/// Options for memoization
#[derive(Clone)]
pub struct MemoOptions {
    /// Maximum entries retained. Default 512.
    pub capacity: usize,
}

impl Default for MemoOptions {
    fn default() -> Self {
        Self { capacity: 512 }
    }
}

/// A memoized function wrapper
pub struct Memoized<A, V>
where
    V: Clone,
{
    cache: LRUCache<V>,
    key_fn: Box<dyn Fn(&A) -> String>,
    compute_fn: Box<dyn Fn(&A) -> V>,
}

impl<A, V> Memoized<A, V>
where
    V: Clone,
{
    /// Create a new memoized function.
    ///
    /// # Arguments
    /// * `compute_fn` - The function to memoize
    /// * `key_fn` - Function to generate cache key from arguments
    /// * `options` - Memoization options (capacity, etc.)
    pub fn new<F, K>(compute_fn: F, key_fn: K, options: Option<MemoOptions>) -> Self
    where
        F: Fn(&A) -> V + 'static,
        K: Fn(&A) -> String + 'static,
    {
        let opts = options.unwrap_or_default();
        Self {
            cache: LRUCache::new(opts.capacity),
            key_fn: Box::new(key_fn),
            compute_fn: Box::new(compute_fn),
        }
    }

    /// Call the memoized function.
    pub fn call(&mut self, args: &A) -> V {
        let key = (self.key_fn)(args);

        if let Some(cached) = self.cache.get(&key) {
            return cached;
        }

        let value = (self.compute_fn)(args);
        self.cache.set(key, value.clone());
        value
    }

    /// Get cache statistics.
    pub fn stats(&self) -> CacheStats {
        self.cache.stats()
    }

    /// Clear the memoization cache.
    pub fn clear(&mut self) {
        self.cache.clear();
    }
}

/// Convenience function to create a memoized function using hash-based keys.
pub fn memoize_by_hash<A, V, F>(compute_fn: F, options: Option<MemoOptions>) -> Memoized<A, V>
where
    A: serde::Serialize,
    V: Clone,
    F: Fn(&A) -> V + 'static,
{
    Memoized::new(
        compute_fn,
        |args: &A| super::hash::hash_data(args, Some("memo:v1")),
        options,
    )
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lru_cache_basic() {
        let mut cache: LRUCache<i32> = LRUCache::new(3);

        cache.set("a".to_string(), 1);
        cache.set("b".to_string(), 2);
        cache.set("c".to_string(), 3);

        assert_eq!(cache.get("a"), Some(1));
        assert_eq!(cache.get("b"), Some(2));
        assert_eq!(cache.get("c"), Some(3));
        assert_eq!(cache.size(), 3);
    }

    #[test]
    fn test_lru_cache_eviction() {
        let mut cache: LRUCache<i32> = LRUCache::new(2);

        cache.set("a".to_string(), 1);
        cache.set("b".to_string(), 2);
        // This should evict "a" (least recently used)
        cache.set("c".to_string(), 3);

        assert_eq!(cache.get("a"), None);
        assert_eq!(cache.get("b"), Some(2));
        assert_eq!(cache.get("c"), Some(3));
        assert_eq!(cache.size(), 2);
    }

    #[test]
    fn test_lru_cache_access_updates_order() {
        let mut cache: LRUCache<i32> = LRUCache::new(2);

        cache.set("a".to_string(), 1);
        cache.set("b".to_string(), 2);

        // Access "a" to make it recently used
        cache.get("a");

        // This should evict "b" (now least recently used)
        cache.set("c".to_string(), 3);

        assert_eq!(cache.get("a"), Some(1)); // "a" should still be there
        assert_eq!(cache.get("b"), None); // "b" should be evicted
        assert_eq!(cache.get("c"), Some(3));
    }

    #[test]
    fn test_lru_cache_update_existing() {
        let mut cache: LRUCache<i32> = LRUCache::new(2);

        cache.set("a".to_string(), 1);
        cache.set("a".to_string(), 10);

        assert_eq!(cache.get("a"), Some(10));
        assert_eq!(cache.size(), 1);
    }

    #[test]
    fn test_lru_cache_stats() {
        let mut cache: LRUCache<i32> = LRUCache::new(2);

        cache.set("a".to_string(), 1);
        cache.get("a"); // hit
        cache.get("b"); // miss
        cache.set("b".to_string(), 2);
        cache.set("c".to_string(), 3); // eviction

        let stats = cache.stats();
        assert_eq!(stats.hits, 1);
        assert_eq!(stats.misses, 1);
        assert_eq!(stats.sets, 3);
        assert_eq!(stats.evictions, 1);
        assert_eq!(stats.size, 2);
        assert_eq!(stats.capacity, 2);
    }

    #[test]
    fn test_lru_cache_delete() {
        let mut cache: LRUCache<i32> = LRUCache::new(3);

        cache.set("a".to_string(), 1);
        cache.set("b".to_string(), 2);

        assert!(cache.delete("a"));
        assert!(!cache.delete("nonexistent"));
        assert_eq!(cache.get("a"), None);
        assert_eq!(cache.size(), 1);
    }

    #[test]
    fn test_lru_cache_clear() {
        let mut cache: LRUCache<i32> = LRUCache::new(3);

        cache.set("a".to_string(), 1);
        cache.set("b".to_string(), 2);
        cache.get("a");

        cache.clear();

        assert_eq!(cache.size(), 0);
        let stats = cache.stats();
        assert_eq!(stats.hits, 0);
        assert_eq!(stats.misses, 0);
    }

    #[test]
    fn test_lru_cache_contains() {
        let mut cache: LRUCache<i32> = LRUCache::new(2);

        cache.set("a".to_string(), 1);

        assert!(cache.contains("a"));
        assert!(!cache.contains("b"));
    }

    #[test]
    fn test_memoized_function() {
        let compute = |x: &i32| *x * 2;

        let mut memo = Memoized::new(
            compute,
            |x: &i32| x.to_string(),
            Some(MemoOptions { capacity: 10 }),
        );

        // First call - computes
        let r1 = memo.call(&5);
        assert_eq!(r1, 10);

        // Second call - cached
        let r2 = memo.call(&5);
        assert_eq!(r2, 10);

        // Different argument - computes
        let r3 = memo.call(&7);
        assert_eq!(r3, 14);

        let stats = memo.stats();
        assert_eq!(stats.sets, 2);
        assert_eq!(stats.hits, 1);
    }

    #[test]
    fn test_snapshot() {
        let mut cache: LRUCache<String> = LRUCache::new(3);

        cache.set("a".to_string(), "one".to_string());
        cache.set("b".to_string(), "two".to_string());

        let snapshot = cache.snapshot();
        assert_eq!(snapshot.len(), 2);

        let keys: Vec<&String> = snapshot.iter().map(|(k, _)| k).collect();
        assert!(keys.contains(&&"a".to_string()));
        assert!(keys.contains(&&"b".to_string()));
    }

    #[test]
    #[should_panic(expected = "LRUCache capacity must be positive")]
    fn test_zero_capacity_panics() {
        let _cache: LRUCache<i32> = LRUCache::new(0);
    }
}
