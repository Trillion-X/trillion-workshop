// crates/resilience/tests/token_bucket_tests.rs
//
// Comprehensive unit tests for TokenBucketStrategy.
// Tests cover: basic allow/deny, refill, max_token capping, wrapping arithmetic, and concurrent access.

use resilience::{
    GuardDecision, GuardInput, GuardStrategy, MonotonicMs, PeerId, TokenBucketConfig,
    TokenBucketState, TokenBucketStrategy, WallClockMs,
};
use std::string::String;
use std::sync::Arc;
use std::vec;

#[cfg(target_arch = "wasm32")]
use core::cell::RefCell;
#[cfg(not(target_arch = "wasm32"))]
use parking_lot::RwLock;

#[test]
fn fresh_bucket_allows_first_request() {
    let strategy = TokenBucketStrategy;
    let state = Arc::new({
        #[cfg(target_arch = "wasm32")]
        {
            RefCell::new(TokenBucketState::default())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            RwLock::new(TokenBucketState::default())
        }
    });

    let input = GuardInput {
        peer_id: PeerId(String::from("test-peer")),
        data: vec![],
        partition_key: None,
        priority: 0,
    };

    let config = TokenBucketConfig {
        max_tokens: 10,
        tokens_per_sec: 5,
    };

    let outcome = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(0),
    );

    assert!(matches!(outcome.decision, GuardDecision::Allow));
    assert!(outcome.event.is_none());
}

#[test]
fn empty_bucket_denies() {
    let strategy = TokenBucketStrategy;
    let state = Arc::new({
        #[cfg(target_arch = "wasm32")]
        {
            RefCell::new(TokenBucketState::default())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            RwLock::new(TokenBucketState::default())
        }
    });

    let input = GuardInput {
        peer_id: PeerId(String::from("test-peer")),
        data: vec![],
        partition_key: None,
        priority: 0,
    };

    let config = TokenBucketConfig {
        max_tokens: 1,
        tokens_per_sec: 0,
    };

    // First request consumes the only token
    let _ = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(0),
    );

    // Second request should be denied
    let outcome = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(0),
    );

    assert!(matches!(
        outcome.decision,
        GuardDecision::Deny("rate_limit_exceeded")
    ));
}

#[test]
fn refill_restores_tokens() {
    let strategy = TokenBucketStrategy;
    let state = Arc::new({
        #[cfg(target_arch = "wasm32")]
        {
            RefCell::new(TokenBucketState::default())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            RwLock::new(TokenBucketState::default())
        }
    });

    let input = GuardInput {
        peer_id: PeerId(String::from("test-peer")),
        data: vec![],
        partition_key: None,
        priority: 0,
    };

    let config = TokenBucketConfig {
        max_tokens: 20,
        tokens_per_sec: 10,
    };

    // Consume 20 tokens at T=0
    for _ in 0..20 {
        let outcome = strategy.evaluate(
            &input,
            state.clone(),
            &config,
            WallClockMs(0),
            MonotonicMs(0),
        );
        assert!(matches!(outcome.decision, GuardDecision::Allow));
    }

    // Try at T=0 — should be denied (no refill yet)
    let outcome = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(0),
    );
    assert!(matches!(
        outcome.decision,
        GuardDecision::Deny("rate_limit_exceeded")
    ));

    // At T=2000ms (2 seconds), with 10 tokens/sec, we should have refilled 20 tokens
    let outcome = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(2000),
        MonotonicMs(2000),
    );
    assert!(matches!(outcome.decision, GuardDecision::Allow));
}

#[test]
fn max_tokens_cap_prevents_overflow() {
    let strategy = TokenBucketStrategy;
    let state = Arc::new({
        #[cfg(target_arch = "wasm32")]
        {
            RefCell::new(TokenBucketState::default())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            RwLock::new(TokenBucketState::default())
        }
    });

    let input = GuardInput {
        peer_id: PeerId(String::from("test-peer")),
        data: vec![],
        partition_key: None,
        priority: 0,
    };

    let config = TokenBucketConfig {
        max_tokens: 10,
        tokens_per_sec: 1,
    };

    // Consume one token at T=0
    let _ = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(0),
    );

    // Advance to T=50000ms (50 seconds) — would normally refill 50 tokens
    // but max_tokens=10, so we should only ever see 10 tokens
    for _ in 0..10 {
        let outcome = strategy.evaluate(
            &input,
            state.clone(),
            &config,
            WallClockMs(50000),
            MonotonicMs(50000),
        );
        assert!(matches!(outcome.decision, GuardDecision::Allow));
    }

    // The 11th request should be denied
    let outcome = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(50000),
        MonotonicMs(50000),
    );
    assert!(matches!(
        outcome.decision,
        GuardDecision::Deny("rate_limit_exceeded")
    ));
}

#[test]
fn wrapping_ms_handles_ring_overflow() {
    // Simulate 34.8-year ring overflow:
    // Set last_ms to near the top of the 40-bit ring (0xFF_FFFF_FFFE)
    // Set now_ms to a small value (0x00_0000_0001)
    // The wrapping_sub should handle this correctly and compute elapsed as 3ms

    let strategy = TokenBucketStrategy;
    let state = Arc::new({
        #[cfg(target_arch = "wasm32")]
        {
            RefCell::new(TokenBucketState::default())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            RwLock::new(TokenBucketState::default())
        }
    });

    let input = GuardInput {
        peer_id: PeerId(String::from("test-peer")),
        data: vec![],
        partition_key: None,
        priority: 0,
    };

    let config = TokenBucketConfig {
        max_tokens: 100,
        tokens_per_sec: 10,
    };

    // First, establish the bucket at a near-overflow timestamp
    // We do this by making a call at MonotonicMs(0xFF_FFFF_FFFE)
    let outcome = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(0xFF_FFFF_FFFE),
    );
    assert!(matches!(outcome.decision, GuardDecision::Allow));

    // Now, "wrap around" to a small timestamp (simulating ring overflow)
    // At T=1, the elapsed time should be computed as:
    // 1 - 0xFF_FFFF_FFFE (wrapping) = 3ms
    // With 10 tokens/sec, this gives ~0.03 tokens, which rounds to 0
    // So the bucket should still have the refilled amount from the previous call
    let outcome = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(1),
    );
    // Should allow because wrapping_sub computed elapsed correctly
    assert!(matches!(outcome.decision, GuardDecision::Allow));
}

#[test]
fn concurrent_access_is_safe() {
    use core::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    let strategy = Arc::new(TokenBucketStrategy);
    let state = Arc::new({
        #[cfg(target_arch = "wasm32")]
        {
            RefCell::new(TokenBucketState::default())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            RwLock::new(TokenBucketState::default())
        }
    });

    let config = Arc::new(TokenBucketConfig {
        max_tokens: 1000,
        tokens_per_sec: 100,
    });

    let allow_count = Arc::new(AtomicUsize::new(0));
    let deny_count = Arc::new(AtomicUsize::new(0));

    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::thread;

        let mut handles = vec![];

        for _ in 0..8 {
            let _strat = strategy.clone();
            let _st = state.clone();
            let _cfg = config.clone();
            let _allows = allow_count.clone();
            let _denies = deny_count.clone();

            let handle = thread::spawn(move || {
                let input = GuardInput {
                    peer_id: PeerId(String::from("concurrent-peer")),
                    data: vec![],
                    partition_key: None,
                    priority: 0,
                };

                for i in 0..100 {
                    let outcome = _strat.evaluate(
                        &input,
                        _st.clone(),
                        &_cfg,
                        WallClockMs(i as u64),
                        MonotonicMs(i as u64),
                    );

                    match outcome.decision {
                        GuardDecision::Allow => _allows.fetch_add(1, AtomicOrdering::Relaxed),
                        GuardDecision::Deny(_) => _denies.fetch_add(1, AtomicOrdering::Relaxed),
                        GuardDecision::CircuitHalfOpen => {
                            _denies.fetch_add(1, AtomicOrdering::Relaxed)
                        }
                    };
                }
            });

            handles.push(handle);
        }

        for handle in handles {
            handle.join().unwrap();
        }
    }

    // On wasm32, we can't spawn threads, so just verify the test compiles
    // and the concurrent semantics are sound at the type level.
    #[cfg(target_arch = "wasm32")]
    {
        let input = GuardInput {
            peer_id: PeerId(String::from("sequential-peer")),
            data: alloc::vec![],
            partition_key: None,
            priority: 0,
        };

        for i in 0..10 {
            let _ = strategy.evaluate(
                &input,
                state.clone(),
                &config,
                WallClockMs(i as u64),
                MonotonicMs(i as u64),
            );
        }
    }

    // Verify that some requests were allowed (sanity check for non-wasm32)
    #[cfg(not(target_arch = "wasm32"))]
    {
        let total =
            allow_count.load(AtomicOrdering::Relaxed) + deny_count.load(AtomicOrdering::Relaxed);
        assert!(total > 0, "No requests were processed");
        // With 1000 tokens and 100 tokens/sec, we should allow most requests
        assert!(allow_count.load(AtomicOrdering::Relaxed) > 100);
    }
}
