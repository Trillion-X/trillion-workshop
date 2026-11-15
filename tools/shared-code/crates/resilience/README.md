# crates/resilience

L069 generative primitive for infrastructure resilience: `BoundaryGuardEngine<S: GuardStrategy, St: GuardStorage<S, K>>` composes any guard strategy with any storage backend into a unified evaluation engine. Rate limiting, circuit breaking, revocation, AIMD, partition-scoped quotas, and priority shedding are all `impl GuardStrategy` — zero new infrastructure per strategy.

## Files

| File | Purpose |
|------|---------|
| `src/lib.rs` | Crate root — exports all public types and traits |
| `src/engine.rs` | `BoundaryGuardEngine<S, St, K>` — composition of strategy + storage |
| `src/strategy/mod.rs` | `GuardStrategy` trait — universal evaluation contract for all guard implementations |
| `src/strategy/token_bucket.rs` | `TokenBucketStrategy`, `TokenBucketState`, `TokenBucketConfig` — rate limiter keyed by peer or partition key |
| `src/strategy/circuit_breaker.rs` | `CircuitBreakerStrategy`: 3-state FSM (CLOSED/OPEN/HALF_OPEN) with bit-packed `AtomicU64` packed_state and sliding window failure rate |
| `src/strategy/revocation.rs` | `RevocationStrategy`: SP6 two-lever session revocation — `BinaryHeap<Reverse<(WallClockMs, String)>>` min-heap + `hashbrown::HashSet` for O(1) membership + automatic TTL eviction |
| `src/storage.rs` | `GuardStorage<S, K>` trait — per-key state lifecycle |
| `tests/circuit_breaker_tests.rs` | Integration tests for all FSM transitions, window amnesia fix, probe steal |
| `tests/revocation_tests.rs` | Integration tests for RevocationStrategy — 7 tests covering Allow/Deny, eviction, heap/set pairing invariant, HOL blocking, max_entries cap |
| `tests/aimd_tests.rs` | Integration tests for AimdStrategy — 7 tests: allow below limit, deny at limit, multiplicative decrease on deny, additive increase on success_window, min_limit floor, max_limit ceiling, complete() decrement |
| `src/strategy/aimd.rs` | `AimdStrategy`, `AimdState`, `AimdConfig` — AIMD concurrency limiter with fixed-point AtomicU64 limit and lock-free CAS updates |
| `src/types.rs` | `WallClockMs`, `MonotonicMs`, `PeerId`, `GuardDecision`, `GuardOutcome`, `GuardEvent`, `GuardInput` |
| `src/lock.rs` | `StateLock<T>` — `RefCell` (wasm32) / `parking_lot::RwLock` (std) |
| `src/config.rs` | `ServerConfig` — canonical daemon server configuration SSOT; replaces the old `hosts/headless/src/server_config.rs` |
| `src/identity.rs` | `TierA`, `TierB`, `TierC`, `ConnectionIdentity` — trust-tiered connection identity types |
| `tests/identity_tests.rs` | Unit tests for all three identity tiers and `ConnectionIdentity` enum |
| `tests/token_bucket_tests.rs` | Unit tests for TokenBucketStrategy (allow, deny, refill, max_tokens capping, wrapping overflow, concurrent access) |
| `src/strategy/quota.rs` | `WorkspaceQuotaStrategy`, `QuotaState`, `QuotaConfig` — partition-key-scoped resource quota enforcer: sliding window counters with lock-free CAS window reset |
| `tests/quota_tests.rs` | Integration tests for WorkspaceQuotaStrategy — 5 tests: allow under limit, deny at limit, window reset, partition isolation, concurrent CAS safety |
| `src/strategy/priority.rs` | `PriorityShedStrategy`, `PriorityState`, `PriorityConfig` — priority-based load shedding with hysteresis; high-priority always passes, low-priority shed under load |
| `tests/priority_tests.rs` | Integration tests for PriorityShedStrategy — 6 tests: high always passes, low shed under load, normal passes under load, hysteresis deactivation, no shed below threshold, complete() decrement |
| `Cargo.toml` | Package manifest — `parking_lot` conditional on non-wasm32 |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `BoundaryGuardEngine<S,St,K>` | `new(strategy: S, storage: St) -> Self`; `evaluate(key, input, config, wall, mono) -> GuardOutcome`; `on_disconnect(key)` | Composes strategy + storage into one evaluation entry point |
| `GuardStrategy` | trait: `State: Default + Send + Sync`, `Config: Send + Sync`, `evaluate(input, state, config, wall_clock_ms, monotonic_ms) -> GuardOutcome` | Pluggable guard implementation (rate limiter, circuit breaker, etc.) |
| `GuardStorage<S,K>` | trait: `get_or_insert_with(key, init) -> Arc<StateLock<S::State>>`, `remove(key)` | Pluggable per-key state backend |
| `StateLock<T>` | type alias: `RefCell<T>` (wasm32) or `parking_lot::RwLock<T>` (std) | Target-arch-conditional mutex — never a feature flag |
| `WallClockMs(u64)` | newtype | Calendar time for credential expiry and lease validation |
| `MonotonicMs(u64)` | newtype | Monotonic time for circuit FSM intervals and retry backoff |
| `GuardDecision` | `Allow` \| `Deny(&'static str)` | Evaluation result |
| `GuardOutcome` | `{ decision: GuardDecision, event: Option<GuardEvent> }` | Full evaluation output with optional observability event |
| `GuardEvent` | 7-variant enum | Observability events (bucket refill, circuit state transitions, revocation, custom) |
| `PeerId(String)` | newtype | Opaque peer identifier — format determined by host |
| `GuardInput` | `{ peer_id: PeerId, data: Vec<u8>, partition_key: Option<String>, priority: u8 }` | Request metadata passed to every evaluation — `partition_key` set for partition-scoped guard checks; `priority` used by PriorityShedStrategy |
| `ServerConfig` | `Default::default() -> Self`; `validate(&self) -> Result<(), ConfigError>` | Canonical SSOT for all daemon numeric thresholds (auth timeout, rate limits, keepalive intervals, write queue capacity, etc.) |
| `ConfigError` | `ZeroValue(&'static str)` \| `BelowMinimum { field: &'static str, min: u64, got: u64 }` | Validation error from `ServerConfig::validate()` |
| `TierA` | `peer_id, allowed_origins, bundle_id, device_key, persistence_key`; `.persist() -> PersistResult`; `.trust_level() -> u8`; `.peer_id() -> &PeerId` | Highest-trust UDS/local identity — ONLY tier with `.persist()` |
| `TierB` | `peer_id, allowed_origins, bundle_id, device_key, expires_at: u64`; `.trust_level() -> u8`; `.peer_id() -> &PeerId`; `.is_expired(wall_clock_ms: u64) -> bool` | Medium-trust authenticated relay identity |
| `TierC` | `peer_id, allowed_origins, bundle_id, device_key`; `.trust_level() -> u8`; `.peer_id() -> &PeerId` | Zero-trust unauthenticated identity |
| `ConnectionIdentity` | `TierA(TierA)` \| `TierB(TierB)` \| `TierC(TierC)`; `.trust_level() -> u8`; `.peer_id() -> &PeerId` | Enum wrapping all three trust tiers |
| `PersistResult` | `Ok(())` \| `StorageUnavailable` \| `StorageError(String)` | Result of `TierA::persist()` — `StorageUnavailable` until task-0515 wires storage |
| `RevocationStrategy` | zero-sized struct; `impl GuardStrategy<State=RevocationState, Config=RevocationConfig>` | SP6 permission-revocation lever (daemon scope): O(1) session membership check, TTL eviction via BinaryHeap min-heap |
| `WorkspaceQuotaStrategy` | zero-sized struct; `impl GuardStrategy<State=QuotaState, Config=QuotaConfig>` | Partition-key-scoped resource quota enforcer: sliding window counters (request count + byte volume) with lock-free CAS window reset; one partition's state cannot affect another partition's budget |
| `QuotaState` | `{ request_count: AtomicU64, byte_volume: AtomicU64, window_start_ms: AtomicU64 }` | Lock-free quota state — all fields AtomicU64; window reset via CAS on `window_start_ms` (AcqRel/Acquire); only one concurrent caller wins the reset |
| `QuotaConfig` | `{ max_requests_per_window: u64, max_bytes_per_window: u64, window_duration_ms: u64 }` | All Society data — billing tier limits sourced from EEAF config in Wave 5. Default: 10K requests, 100MB, 1-minute window |
| `RevocationState` | `{ heap: BinaryHeap<Reverse<(WallClockMs, String)>>, set: HashSet<String> }`; `.revoke(session_id, exp, max_entries)`; `.revoked_count() -> usize`; `.is_revoked(&str) -> bool` | Dual-structure revocation state — heap drives TTL eviction, set drives O(1) lookup. INVARIANT: every `heap.pop()` MUST be paired with `set.remove(&id)`. |
| `RevocationConfig` | `{ max_entries: usize }` | Society data — max revocation entries in memory; oldest ejected on overflow |
| `PriorityShedStrategy` | zero-sized struct; `impl GuardStrategy<State=PriorityState, Config=PriorityConfig>`; `PriorityShedStrategy::complete(state: &Arc<StateLock<PriorityState>>)` | Priority-based load shedding: high-priority (>= `high_priority_threshold`) always passes; low-priority (< `min_priority_under_load`) shed when `in_flight >= shed_threshold`; hysteresis clears shed at `shed_release_threshold`. Caller MUST call `complete()` after every allowed request. |
| `PriorityState` | `{ in_flight: AtomicU64, shed_active: AtomicBool }` | Two-atomic shedding state — zero lock contention on fast path; `shed_active` set/cleared via hysteresis on every `evaluate()` call |
| `PriorityConfig` | `{ shed_threshold: u64, min_priority_under_load: u8, high_priority_threshold: u8, shed_release_threshold: u64 }` | All Society values — operator-tuned from EEAF config in Wave 5. Default: shed at 512, release at 384, min=64, high=200 |
| `AimdStrategy` | zero-sized struct; `impl GuardStrategy<State=AimdState, Config=AimdConfig>`; `AimdStrategy::complete(state: &Arc<StateLock<AimdState>>)` | TCP congestion control semantics for concurrency limiting: additive increase on success, multiplicative decrease on denial. Caller MUST call `complete()` after every allowed request. |
| `AimdState` | `{ in_flight: AtomicU64, limit_fixed: AtomicU64, success_count: AtomicU64, drop_count: AtomicU64 }` | Lock-free state — all fields are AtomicU64. `limit_fixed` stores limit as `(f64 × 1000)` (fixed-point). CAS loop for updates, read lock suffices (no write lock needed). |
| `AimdConfig` | `{ additive_increase: f64, multiplicative_decrease: f64, min_limit: f64, max_limit: f64, success_window: u64 }` | All Society data — operator-tuned from EEAF config in Wave 5. `limit` clamped to `[min_limit, max_limit]` at all times. |
| `TokenBucketStrategy` | zero-sized struct; `impl GuardStrategy { type State = TokenBucketState, type Config = TokenBucketConfig }` | Rate limiter using bit-packed AtomicU64 (40-bit timestamp, 24-bit token count); callers choose whether the engine key is a peer or partition key |
| `TokenBucketState` | `{ packed: AtomicU64 }`; `pack(last_ms, tokens) -> u64`; `unpack(u64) -> (last_ms, tokens)` | Atomic state for token bucket — initialized with max token count to allow fresh bucket on first call |
| `TokenBucketConfig` | `{ max_tokens: u32, tokens_per_sec: u32 }` | Configuration for token bucket — sourced from `ServerConfig::rate_limit_connections_per_sec` (Society values, not hardcoded) |
| `CircuitBreakerStrategy` | `impl GuardStrategy<State=CircuitState, Config=CircuitBreakerConfig>` | 3-state FSM (CLOSED/OPEN/HALF_OPEN) with single-word CAS transitions; HALF_OPEN probe claim/steal |
| `CircuitBreakerConfig` | `{ failure_threshold: f32, window_size: usize, cooldown_ms: u64, probe_timeout_ms: u64 }` | Failure rate threshold and cooldown configuration |
| `CircuitState` | `{ packed_state: AtomicU64, window: StateLock<CircuitWindow> }` | EXACTLY TWO FIELDS — FSM state + sliding window; high 8 bits = FSM, low 56 bits = timestamp union |
| `CircuitWindow` | `{ queue: VecDeque<bool>, failure_count: u32 }` | Incremental O(1) failure tracking; failure_count maintained on push/pop, NOT via O(N) scan |

## Dependencies

**Depends on:** `parking_lot = "0.12"` (std targets only, for `StateLock`; absent on wasm32 builds); `hashbrown = "0.14"` (alloc + ahash features; no_std-compatible `HashSet` for `RevocationState` — `alloc::collections` has no HashSet)

**Depended on by:** `hosts/headless` (Wave 1 — uses `ServerConfig` via `resilience::ServerConfig`; Wave 2 — `MokaStorage` impl + `TokenBucketStrategy`/`CircuitBreakerStrategy` impls), WASM targets (Wave 2 — `LruStorage` impl), all future `impl GuardStrategy` types (Waves 2–4: TBD-6 through TBD-19)
