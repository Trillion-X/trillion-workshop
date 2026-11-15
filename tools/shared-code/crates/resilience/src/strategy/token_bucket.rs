// crates/resilience/src/strategy/token_bucket.rs
//
// TokenBucketStrategy — rate limiter keyed by peer or partition key.
//
// PHYSICS: Single-word atomic (AtomicU64) with bit-packed timestamp (40 bits, 34.8-year ring)
// and token count (24 bits, max 16.7M tokens). wrapping_sub + mask for ring arithmetic.
// CAS loop for wait-free concurrent access.
//
// SOCIETY: max_tokens and tokens_per_sec from ServerConfig / EEAF data (never hardcoded).
//
// INVARIANTS:
//   1. TokenBucketState uses exactly ONE AtomicU64 (packed: high 40 bits = last_refill_ms, low 24 bits = tokens).
//   2. pack() uses explicit mask: (last_ms & 0xFF_FFFF_FFFF) << 24
//   3. Elapsed computation uses wrapping_sub + mask: now_ms.wrapping_sub(last_ms) & 0xFF_FFFF_FFFF
//   4. CAS loop retries on failure (no exponential backoff — bounded time).
//   5. Token count after refill is min(config.max_tokens, tokens + refill_rate * elapsed / 1000)
//   6. If new_tokens >= 1: decrement and allow. If new_tokens == 0: deny.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

use super::GuardStrategy;
use crate::lock::StateLock;
use crate::types::{GuardInput, GuardOutcome, MonotonicMs, WallClockMs};
use alloc::sync::Arc;
use core::sync::atomic::{AtomicU64, Ordering};

/// Bit-packed single AtomicU64: high 40 bits = last_refill_ms (MonotonicMs), low 24 bits = token_count.
///
/// 40-bit ring for timestamps (34.8-year overflow handled by wrapping_sub + 0xFF_FFFF_FFFF mask).
/// 24-bit token field: max 16,777,215 tokens per bucket.
///
/// CRITICAL: Use wrapping_sub + mask for elapsed computation, NOT saturating_sub.
/// saturating_sub in a masked ring yields 0 on wrap → freezes bucket for 34.8 years.
///
/// CRITICAL: explicit pack mask — use (new_last_ms & 0xFF_FFFF_FFFF) << 24, NOT implicit shift-truncation.
/// Implicit shift-truncation is undefined behavior for values exceeding the masked range.
pub struct TokenBucketState {
    packed: AtomicU64,
}

impl TokenBucketState {
    /// Pack (last_ms, tokens) into a single u64.
    /// High 40 bits = last_ms (masked to 40 bits).
    /// Low 24 bits = tokens.
    #[inline]
    fn pack(last_ms: u64, tokens: u32) -> u64 {
        ((last_ms & 0xFF_FFFF_FFFF) << 24) | (tokens as u64 & 0xFF_FFFF)
    }

    /// Unpack a u64 into (last_ms, tokens).
    #[inline]
    fn unpack(packed: u64) -> (u64, u32) {
        (packed >> 24, (packed & 0xFF_FFFF) as u32)
    }

    /// Evaluate the token bucket at `monotonic_ms`, consuming one token if available.
    /// Returns GuardOutcome with Allow (token consumed, now_ms updated) or Deny.
    fn evaluate_impl(&self, now_ms: u64, max_tokens: u32, tokens_per_sec: u32) -> GuardOutcome {
        loop {
            // Load current state with Relaxed ordering
            let packed = self.packed.load(Ordering::Relaxed);
            let (last_ms, tokens) = Self::unpack(packed);

            // Compute elapsed time using wrapping subtraction (handles 34.8-year ring wrap)
            let elapsed_ms = now_ms.wrapping_sub(last_ms) & 0xFF_FFFF_FFFF;

            // Compute tokens to add: (tokens_per_sec * elapsed_ms) / 1000
            // Cap at max_tokens
            let refill_amount = ((tokens_per_sec as u64) * elapsed_ms / 1000) as u32;
            let new_tokens = (tokens as u64 + refill_amount as u64).min(max_tokens as u64) as u32;

            if new_tokens >= 1 {
                // Try to consume one token
                let consumed_tokens = new_tokens - 1;
                let new_packed = Self::pack(now_ms & 0xFF_FFFF_FFFF, consumed_tokens);

                // CAS with AcqRel success, Relaxed failure
                match self.packed.compare_exchange_weak(
                    packed,
                    new_packed,
                    Ordering::AcqRel,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => return GuardOutcome::allow(),
                    Err(_) => {
                        // CAS failed, retry loop
                        continue;
                    }
                }
            } else {
                // No tokens available
                return GuardOutcome::deny("rate_limit_exceeded");
            }
        }
    }
}

impl Default for TokenBucketState {
    fn default() -> Self {
        // Initialize with max_tokens in the bucket at time 0.
        // We use a packed value where last_ms=0 and tokens=max_tokens.
        // However, max_tokens is not known at Default time, so we initialize with a high token count.
        // The evaluate_impl will clamp it to config.max_tokens on first call.
        // To ensure fresh buckets allow the first request, we initialize with max possible tokens.
        Self {
            packed: AtomicU64::new(0xFF_FFFF), // max 24-bit value
        }
    }
}

/// Configuration for TokenBucketStrategy.
pub struct TokenBucketConfig {
    /// Maximum tokens in bucket (burst capacity).
    pub max_tokens: u32,
    /// Tokens added per second.
    pub tokens_per_sec: u32,
}

/// TokenBucketStrategy — rate limiter keyed by peer or partition key.
pub struct TokenBucketStrategy;

impl TokenBucketStrategy {
    /// Grant an immediate burst allowance for sleep-wake reconnect grace period.
    ///
    /// Adds `burst_tokens` to the current token count (capped at config.max_tokens).
    /// Called when sleep-wake is detected — mobile clients waking simultaneously
    /// should not be misidentified as a DDoS storm.
    ///
    /// This is a best-effort call — if state is unavailable, it is silently ignored.
    /// The CAS loop is wait-free: retries on contention, bounded by hardware CAS guarantees.
    pub fn grant_burst(
        state: Arc<StateLock<TokenBucketState>>,
        config: &TokenBucketConfig,
        burst_tokens: u32,
    ) {
        #[cfg(not(target_arch = "wasm32"))]
        let guard = state.read();
        #[cfg(target_arch = "wasm32")]
        let guard = state.borrow();

        loop {
            let packed = guard.packed.load(Ordering::Acquire);
            let (last_refill_ms, current_tokens) = TokenBucketState::unpack(packed);
            let new_tokens =
                (current_tokens as u64 + burst_tokens as u64).min(config.max_tokens as u64) as u32;
            let new_packed = TokenBucketState::pack(last_refill_ms, new_tokens);
            if guard
                .packed
                .compare_exchange(packed, new_packed, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                break;
            }
        }
    }
}

impl GuardStrategy for TokenBucketStrategy {
    type State = TokenBucketState;
    type Config = TokenBucketConfig;

    fn evaluate(
        &self,
        _input: &GuardInput,
        state: Arc<StateLock<Self::State>>,
        config: &Self::Config,
        _wall_clock_ms: WallClockMs,
        monotonic_ms: MonotonicMs,
    ) -> GuardOutcome {
        // Acquire lock on the state
        #[cfg(target_arch = "wasm32")]
        {
            let state_ref = state.borrow();
            state_ref.evaluate_impl(monotonic_ms.0, config.max_tokens, config.tokens_per_sec)
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            let state_ref = state.read();
            state_ref.evaluate_impl(monotonic_ms.0, config.max_tokens, config.tokens_per_sec)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_unpack_roundtrip() {
        let last_ms = 1000u64;
        let tokens = 500u32;
        let packed = TokenBucketState::pack(last_ms, tokens);
        let (last_ms_out, tokens_out) = TokenBucketState::unpack(packed);
        assert_eq!(last_ms_out, last_ms);
        assert_eq!(tokens_out, tokens);
    }

    #[test]
    fn pack_masks_timestamp() {
        // Test that values beyond 40 bits are masked
        let last_ms = 0x1_FFFF_FFFF_FFFFu64; // More than 40 bits
        let tokens = 100u32;
        let packed = TokenBucketState::pack(last_ms, tokens);
        let (last_ms_out, tokens_out) = TokenBucketState::unpack(packed);
        assert_eq!(last_ms_out, last_ms & 0xFF_FFFF_FFFF);
        assert_eq!(tokens_out, tokens);
    }

    #[test]
    fn elapsed_wraps_correctly() {
        // Simulate ring wrap: last_ms at the top, now_ms at the bottom
        let last_ms = 0xFF_FFFF_FFFEu64; // Near top of 40-bit ring
        let now_ms = 1u64; // Near bottom
        let elapsed = now_ms.wrapping_sub(last_ms) & 0xFF_FFFF_FFFF;
        // Should compute as (1 - 0xFF_FFFF_FFFE) wrapping = 3 ms (since the ring is 40-bit)
        assert_eq!(elapsed, 3);
    }

    // -------------------------------------------------------------------------
    // grant_burst() tests
    // -------------------------------------------------------------------------

    /// grant_burst() adds burst_tokens to current count, capped at max_tokens.
    #[test]
    fn grant_burst_adds_tokens_up_to_max() {
        let config = TokenBucketConfig {
            max_tokens: 100,
            tokens_per_sec: 10,
        };
        // Start with 50 tokens
        let initial = TokenBucketState::pack(0, 50);
        let state = Arc::new(StateLock::new(TokenBucketState {
            packed: AtomicU64::new(initial),
        }));

        TokenBucketStrategy::grant_burst(Arc::clone(&state), &config, 30);

        #[cfg(not(target_arch = "wasm32"))]
        let guard = state.read();
        #[cfg(target_arch = "wasm32")]
        let guard = state.borrow();

        let (_, tokens) = TokenBucketState::unpack(guard.packed.load(Ordering::Relaxed));
        assert_eq!(tokens, 80, "50 + 30 = 80 tokens");
    }

    /// grant_burst() does not exceed max_tokens (burst is capped).
    #[test]
    fn grant_burst_caps_at_max_tokens() {
        let config = TokenBucketConfig {
            max_tokens: 100,
            tokens_per_sec: 10,
        };
        // Start with 90 tokens — burst of 50 should cap at 100
        let initial = TokenBucketState::pack(0, 90);
        let state = Arc::new(StateLock::new(TokenBucketState {
            packed: AtomicU64::new(initial),
        }));

        TokenBucketStrategy::grant_burst(Arc::clone(&state), &config, 50);

        #[cfg(not(target_arch = "wasm32"))]
        let guard = state.read();
        #[cfg(target_arch = "wasm32")]
        let guard = state.borrow();

        let (_, tokens) = TokenBucketState::unpack(guard.packed.load(Ordering::Relaxed));
        assert_eq!(tokens, 100, "90 + 50 capped at max_tokens=100");
    }

    /// grant_burst() from empty bucket grants exactly burst_tokens (up to max).
    #[test]
    fn grant_burst_from_empty_bucket() {
        let config = TokenBucketConfig {
            max_tokens: 100,
            tokens_per_sec: 10,
        };
        // Start with 0 tokens (depleted bucket)
        let initial = TokenBucketState::pack(0, 0);
        let state = Arc::new(StateLock::new(TokenBucketState {
            packed: AtomicU64::new(initial),
        }));

        TokenBucketStrategy::grant_burst(Arc::clone(&state), &config, 20);

        #[cfg(not(target_arch = "wasm32"))]
        let guard = state.read();
        #[cfg(target_arch = "wasm32")]
        let guard = state.borrow();

        let (_, tokens) = TokenBucketState::unpack(guard.packed.load(Ordering::Relaxed));
        assert_eq!(tokens, 20, "0 + 20 = 20 tokens from empty bucket");
    }

    /// Concurrent standing approval_burst() calls do not exceed max_tokens (CAS correctness).
    #[test]
    fn grant_burst_concurrent_does_not_exceed_max() {
        use std::thread;

        let config = Arc::new(TokenBucketConfig {
            max_tokens: 100,
            tokens_per_sec: 10,
        });
        // Start with 0 tokens
        let initial = TokenBucketState::pack(0, 0);
        let state = Arc::new(StateLock::new(TokenBucketState {
            packed: AtomicU64::new(initial),
        }));

        // Spawn 10 threads each granting 20 tokens — total attempted: 200, max: 100
        let handles: Vec<_> = (0..10)
            .map(|_| {
                let state_clone = Arc::clone(&state);
                let config_clone = Arc::clone(&config);
                thread::spawn(move || {
                    TokenBucketStrategy::grant_burst(state_clone, &config_clone, 20);
                })
            })
            .collect();

        for h in handles {
            h.join().expect("thread panicked");
        }

        let guard = state.read();
        let (_, tokens) = TokenBucketState::unpack(guard.packed.load(Ordering::Relaxed));
        assert!(
            tokens <= 100,
            "concurrent standing approvals must not exceed max_tokens=100, got {}",
            tokens
        );
    }
}
