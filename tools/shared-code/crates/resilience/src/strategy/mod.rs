// crates/resilience/src/strategy/mod.rs
//
// GuardStrategy trait and all concrete implementations.
//
// INVARIANTS:
//   1. GuardStrategy trait is the L069 generative primitive interface.
//   2. Concrete implementations (TokenBucketStrategy, CircuitBreakerStrategy, etc.) live in submodules.
//   3. Config is passed by reference per call — NEVER stored in the strategy struct.
//   4. Two-clock contract enforced at type level: WallClockMs (calendar) vs MonotonicMs (interval).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

mod aimd;
mod circuit_breaker;
mod priority;
mod quota;
pub mod revocation;
mod token_bucket;

pub use aimd::{AimdConfig, AimdState, AimdStrategy};
pub use circuit_breaker::{
    CircuitBreakerConfig, CircuitBreakerStrategy, CircuitState, CircuitWindow,
};
pub use priority::{PriorityConfig, PriorityShedStrategy, PriorityState};
pub use quota::{QuotaConfig, QuotaState, WorkspaceQuotaStrategy};
pub use revocation::{RevocationConfig, RevocationState, RevocationStrategy};
pub use token_bucket::{TokenBucketConfig, TokenBucketState, TokenBucketStrategy};

use crate::lock::StateLock;
use crate::types::{GuardInput, GuardOutcome, MonotonicMs, WallClockMs};
use alloc::sync::Arc;

pub trait GuardStrategy: Send + Sync + 'static {
    type State: Default + Send + Sync + 'static;
    type Config: Send + Sync + 'static;

    fn evaluate(
        &self,
        input: &GuardInput,
        state: Arc<StateLock<Self::State>>,
        config: &Self::Config,
        wall_clock_ms: WallClockMs,
        monotonic_ms: MonotonicMs,
    ) -> GuardOutcome;
}
