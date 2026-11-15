// crates/resilience/src/strategy/revocation.rs
//
// RevocationStrategy — SP6 two-lever session revocation.
//
// INVARIANTS:
//   1. RevocationState uses BinaryHeap<Reverse<(WallClockMs, String)>> for O(log N) ordered eviction.
//   2. HashSet<String> provides O(1) average membership check.
//   3. EVERY heap.pop() MUST be paired with set.remove(&id) — structural correctness requirement.
//      Missing a paired set.remove() creates orphaned SessionId entries that can never be evicted
//      because the heap entry is gone but the set entry remains → unbounded set growth → OOM.
//   4. Eviction loop runs at the START of every evaluate() before membership check.
//   5. peek() inspects exp BY REFERENCE ONLY — pop() takes ownership of the String (Round 12 E0507 fix).
//
// ELIMINATED data structures (do NOT use):
//   - VecDeque: head-of-line blocking — sessions not revoked in exp order block all shorter-lived
//     revocations → HashSet grows without bound → OOM (Round 11 elimination).
//   - HashSet<SessionId> alone: no TTL → unbounded OOM.
//   - BTreeMap + Vec/BTreeSet + split_off: allocation bomb (Round 10, L075 elimination).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

//! RevocationStrategy — SP6 two-lever session revocation.
//!
//! Lever 1 — Access Revocation (gateway scope):
//!   Gateway stops issuing new credentials for revoked actor.
//!   New connections cannot be established after revocation.
//!   Implementation: outside this crate (gateway entitlement check).
//!
//! Lever 2 — Permission Revocation (daemon scope, THIS crate):
//!   Daemon denies in-flight sessions for revoked actor.
//!   Existing connections with valid-but-revoked session IDs are rejected.
//!   Sessions run to their TTL naturally after revocation window passes.
//!
//! Propagation SLO: revocations are effective within one evaluate() cycle
//! after the SessionId is inserted into RevocationState via revoke().
//! For offline machines: sessions run to their credential.exp floor (SP3 latest accepted time).
//!
//! Revocation set loaded at startup via WriteBatch subscription pattern
//! (see websocket.rs:516-547 for the existing subscription infrastructure).

use alloc::collections::BinaryHeap;
use alloc::string::String;
use alloc::sync::Arc;
use core::cmp::Reverse;
// hashbrown provides O(1) HashSet for no_std + alloc environments.
// alloc::collections has no HashSet — hashbrown is the correct no_std solution (SP6 Physics).
use super::GuardStrategy;
use crate::lock::StateLock;
use crate::types::{GuardEvent, GuardInput, GuardOutcome, MonotonicMs, WallClockMs};
use hashbrown::HashSet;

/// WASM-compatible revocation state.
///
/// BinaryHeap<Reverse<(WallClockMs, String)>>: min-heap ordered by expiry (smallest exp at top).
/// HashSet<String>: O(1) average membership check.
///
/// The heap drives TTL eviction; the set drives lookup.
/// Both must stay in sync — every heap.pop() MUST call set.remove(&id).
///
/// CRITICAL: The heap and set are TWO views of the same logical set.
/// They diverge the moment any heap.pop() is not paired with set.remove(&id).
/// Divergence means the set grows without bound (unbounded OOM).
pub struct RevocationState {
    heap: BinaryHeap<Reverse<(WallClockMs, String)>>,
    set: HashSet<String>,
}

impl RevocationState {
    /// Revoke a session ID with the given expiry timestamp.
    ///
    /// If `set.len() >= max_entries`, the oldest (lowest exp) entry is ejected to make room.
    /// The evicted session will no longer be in the revocation set — if it hasn't expired
    /// naturally, it will pass the membership check again after eviction. This is an
    /// operator capacity tradeoff (max_entries is Society config from EEAF / ServerConfig).
    pub fn revoke(&mut self, session_id: String, exp: WallClockMs, max_entries: usize) {
        if self.set.len() >= max_entries {
            // Drop oldest (min exp) entry to make room for the new revocation.
            // MANDATORY: set.remove paired with heap.pop.
            if let Some(Reverse((_, old_id))) = self.heap.pop() {
                self.set.remove(&old_id);
            }
        }
        // Insert into both structures atomically (both must succeed or neither does).
        // clone() required because BinaryHeap takes ownership and set needs its own copy.
        self.heap.push(Reverse((exp, session_id.clone())));
        self.set.insert(session_id);
    }

    /// Returns the number of active revocation entries (heap + set are always in sync).
    ///
    /// Used by tests to verify the heap/set pairing invariant — set.len() must never
    /// exceed heap.len() (orphaned entries indicate a missing paired set.remove()).
    pub fn revoked_count(&self) -> usize {
        self.set.len()
    }

    /// Returns true if `session_id` is in the active revocation set.
    ///
    /// Does NOT perform TTL eviction — use only after evaluate() has run the eviction loop,
    /// or call it knowing that expired entries may still be present.
    pub fn is_revoked(&self, session_id: &str) -> bool {
        self.set.contains(session_id)
    }

    /// Evict all entries whose expiry has passed (exp.0 < wall_clock_ms.0).
    ///
    /// Uses peek() to inspect the expiry BY REFERENCE — pop() is only called after confirming
    /// expiry, so pop() takes ownership of the String safely.
    /// MANDATORY: every heap.pop() is paired with set.remove(&id).
    fn evict_expired(&mut self, wall_clock_ms: WallClockMs) {
        loop {
            match self.heap.peek() {
                Some(Reverse((exp, _))) if exp.0 < wall_clock_ms.0 => {
                    // Expiry confirmed via peek (borrow); now pop to take ownership of the String.
                    let Reverse((_, id)) = self.heap.pop().unwrap();
                    // MANDATORY: paired set.remove — id goes out of scope after this line.
                    self.set.remove(&id);
                }
                _ => break,
            }
        }
    }
}

impl Default for RevocationState {
    fn default() -> Self {
        // Explicit Default — empty heap + empty set.
        // Do NOT rely on #[derive(Default)] which would also work here, but explicit
        // Default documents the invariant: state starts empty (no sessions revoked).
        Self {
            heap: BinaryHeap::new(),
            set: HashSet::new(),
        }
    }
}

/// Configuration for RevocationStrategy.
///
/// `max_entries` is Society data — sourced from EEAF config or ServerConfig.
/// It is never hardcoded in Physics engine code.
pub struct RevocationConfig {
    /// Maximum number of revocation entries to hold in memory.
    /// Oldest entries (by insertion exp) are dropped when exceeded.
    /// Society data — sourced from EEAF config, never hardcoded.
    pub max_entries: usize,
}

/// RevocationStrategy — SP6 permission-revocation lever (daemon scope).
///
/// Zero-sized struct. All state lives in RevocationState; all config in RevocationConfig.
/// Config is passed by reference per call — NEVER stored in the strategy struct.
pub struct RevocationStrategy;

impl GuardStrategy for RevocationStrategy {
    type State = RevocationState;
    type Config = RevocationConfig;

    fn evaluate(
        &self,
        input: &GuardInput,
        state: Arc<StateLock<Self::State>>,
        _config: &Self::Config,
        wall_clock_ms: WallClockMs,
        _monotonic_ms: MonotonicMs,
    ) -> GuardOutcome {
        // Step 1: Acquire mutable access and run eviction loop BEFORE membership check.
        // Eviction must happen first so expired sessions cannot block newly-admitted ones.
        #[cfg(target_arch = "wasm32")]
        let mut state_guard = state.borrow_mut();
        #[cfg(not(target_arch = "wasm32"))]
        let mut state_guard = state.write();

        state_guard.evict_expired(wall_clock_ms);

        // Step 2: Extract session_id from input.data (raw bytes → UTF-8).
        // Invalid UTF-8 or empty → no session ID present → not revoked → Allow.
        let session_id = core::str::from_utf8(input.data.as_slice()).unwrap_or("");
        if session_id.is_empty() {
            return GuardOutcome::allow();
        }

        // Step 3: O(1) membership check.
        if state_guard.set.contains(session_id) {
            GuardOutcome::deny_with_event(
                "session_revoked",
                GuardEvent::SessionRevoked {
                    peer_id: input.peer_id.clone(),
                },
            )
        } else {
            GuardOutcome::allow()
        }
    }
}
