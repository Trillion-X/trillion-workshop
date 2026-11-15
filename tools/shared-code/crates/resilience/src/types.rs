// crates/resilience/src/types.rs
// See task file for full documentation of each type.

use alloc::string::String;
use alloc::vec::Vec;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WallClockMs(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MonotonicMs(pub u64);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PeerId(pub String);

#[derive(Debug, Clone)]
pub struct GuardInput {
    pub peer_id: PeerId,
    pub data: Vec<u8>,
    /// Workspace context — set for post-auth guard checks, None for pre-auth.
    pub partition_key: Option<String>,
    /// Request priority level (0=lowest, 255=highest) — used by PriorityShedStrategy (task-0526).
    /// Society: priority assignment is operator policy, sourced from EEAF config.
    pub priority: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardDecision {
    Allow,
    Deny(&'static str),
    /// Circuit is in HALF_OPEN state and a probe is already in flight.
    /// Callers MUST NOT spin — yield to orchestrator (task-0517 handles retry integration).
    CircuitHalfOpen,
}

#[derive(Debug, Clone)]
pub enum GuardEvent {
    BucketRefilled { peer_id: PeerId, tokens: u32 },
    RateLimitExceeded { peer_id: PeerId },
    CircuitOpened { peer_id: PeerId, failure_rate: f32 },
    CircuitHalfOpen { peer_id: PeerId },
    CircuitClosed { peer_id: PeerId },
    SessionRevoked { peer_id: PeerId },
    Custom { peer_id: PeerId, kind: &'static str },
}

#[derive(Debug, Clone)]
pub struct GuardOutcome {
    pub decision: GuardDecision,
    pub event: Option<GuardEvent>,
}

impl GuardOutcome {
    pub fn allow() -> Self {
        Self {
            decision: GuardDecision::Allow,
            event: None,
        }
    }
    pub fn deny(reason: &'static str) -> Self {
        Self {
            decision: GuardDecision::Deny(reason),
            event: None,
        }
    }
    pub fn allow_with_event(event: GuardEvent) -> Self {
        Self {
            decision: GuardDecision::Allow,
            event: Some(event),
        }
    }
    pub fn deny_with_event(reason: &'static str, event: GuardEvent) -> Self {
        Self {
            decision: GuardDecision::Deny(reason),
            event: Some(event),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_clock_and_monotonic_are_distinct() {
        let wall = WallClockMs(1000);
        let mono = MonotonicMs(1000);
        assert_eq!(wall.0, 1000);
        assert_eq!(mono.0, 1000);
        // Type system prevents mixing — these are distinct newtypes
    }

    #[test]
    fn guard_outcome_constructors() {
        let allow = GuardOutcome::allow();
        assert!(matches!(allow.decision, GuardDecision::Allow));
        assert!(allow.event.is_none());

        let deny = GuardOutcome::deny("rate_limit");
        assert!(matches!(deny.decision, GuardDecision::Deny("rate_limit")));
        assert!(deny.event.is_none());
    }
}
