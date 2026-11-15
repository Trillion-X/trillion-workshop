// crates/resilience/src/lib.rs
//
// BoundaryGuardEngine<S: GuardStrategy, St: GuardStorage> — L069 generative primitive.
//
// INVARIANTS:
//   1. This crate requires alloc, NOT std. `extern crate alloc` is mandatory.
//   2. GuardStrategy is PURE: sync, panic-safe, bounded-time.
//   3. GuardStorage owns all mutable state. Engine is immutable after construction.
//   4. StateLock is the ONLY sync primitive — conditional by target_arch, never by feature.
//   5. Two clocks (WallClockMs, MonotonicMs) are passed in by caller — never read here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

pub mod config;
mod engine;
mod identity;
mod lock;
mod storage;
mod strategy;
mod types;

pub use config::{ConfigError, ServerConfig};
pub use engine::BoundaryGuardEngine;
pub use identity::{ConnectionIdentity, PersistResult, TierA, TierB, TierC};
pub use lock::StateLock;
pub use storage::GuardStorage;
pub use strategy::{
    AimdConfig, AimdState, AimdStrategy, CircuitBreakerConfig, CircuitBreakerStrategy,
    CircuitState, CircuitWindow, GuardStrategy, PriorityConfig, PriorityShedStrategy,
    PriorityState, QuotaConfig, QuotaState, RevocationConfig, RevocationState, RevocationStrategy,
    TokenBucketConfig, TokenBucketState, TokenBucketStrategy, WorkspaceQuotaStrategy,
};
pub use types::{
    GuardDecision, GuardEvent, GuardInput, GuardOutcome, MonotonicMs, PeerId, WallClockMs,
};
