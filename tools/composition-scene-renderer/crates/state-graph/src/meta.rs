//! Meta state for timing and session information.
//!
//! This module provides types for tracking timing and session metadata,
//! which can be used by trigger queries for time-based patterns.

use serde::{Deserialize, Serialize};

/// Meta state for timing and session info.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct MetaState {
    /// Time since last event (milliseconds)
    pub time_since_last_event_ms: u64,
    /// Timestamp of the most recent event
    pub last_event_time: u64,
    /// Session start timestamp
    pub session_start: u64,
    /// Total event count in session
    pub event_count: u64,
}

impl MetaState {
    /// Create a new meta state
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a meta state with session start time
    pub fn with_session_start(session_start: u64) -> Self {
        Self {
            session_start,
            ..Default::default()
        }
    }

    /// Record that an event occurred
    pub fn record_event(&mut self, timestamp: u64) {
        if self.last_event_time > 0 {
            self.time_since_last_event_ms = timestamp.saturating_sub(self.last_event_time);
        }
        self.last_event_time = timestamp;
        self.event_count += 1;
    }

    /// Get the session duration in milliseconds
    pub fn session_duration(&self, current_time: u64) -> u64 {
        current_time.saturating_sub(self.session_start)
    }

    /// Get the event rate (events per second)
    pub fn event_rate(&self, current_time: u64) -> f64 {
        let duration_sec = self.session_duration(current_time) as f64 / 1000.0;
        if duration_sec > 0.0 {
            self.event_count as f64 / duration_sec
        } else {
            0.0
        }
    }

    /// Check if the session has been idle for a given duration
    pub fn is_idle(&self, current_time: u64, idle_threshold_ms: u64) -> bool {
        if self.last_event_time == 0 {
            return true;
        }
        current_time.saturating_sub(self.last_event_time) >= idle_threshold_ms
    }

    /// Reset the meta state for a new session
    pub fn reset(&mut self, session_start: u64) {
        self.time_since_last_event_ms = 0;
        self.last_event_time = 0;
        self.session_start = session_start;
        self.event_count = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_meta_state_default() {
        let state = MetaState::new();
        assert_eq!(state.event_count, 0);
        assert_eq!(state.last_event_time, 0);
    }

    #[test]
    fn test_record_event() {
        let mut state = MetaState::with_session_start(0);

        state.record_event(100);
        assert_eq!(state.event_count, 1);
        assert_eq!(state.last_event_time, 100);
        assert_eq!(state.time_since_last_event_ms, 0); // First event

        state.record_event(250);
        assert_eq!(state.event_count, 2);
        assert_eq!(state.last_event_time, 250);
        assert_eq!(state.time_since_last_event_ms, 150);
    }

    #[test]
    fn test_session_duration() {
        let state = MetaState::with_session_start(1000);
        assert_eq!(state.session_duration(5000), 4000);
    }

    #[test]
    fn test_is_idle() {
        let mut state = MetaState::with_session_start(0);

        // No events yet - should be idle
        assert!(state.is_idle(1000, 500));

        state.record_event(500);
        // Just recorded an event at 500, current time 600 - not idle (100ms < 500ms threshold)
        assert!(!state.is_idle(600, 500));

        // Current time 1100 - idle (600ms > 500ms threshold)
        assert!(state.is_idle(1100, 500));
    }

    #[test]
    fn test_event_rate() {
        let mut state = MetaState::with_session_start(0);

        // 10 events over 2 seconds = 5 events/sec
        for i in 0..10 {
            state.record_event(i * 200); // Events at 0, 200, 400, ...1800ms
        }

        let rate = state.event_rate(2000);
        assert!((rate - 5.0).abs() < 0.1);
    }

    #[test]
    fn test_reset() {
        let mut state = MetaState::with_session_start(0);
        state.record_event(100);
        state.record_event(200);
        assert_eq!(state.event_count, 2);

        state.reset(1000);
        assert_eq!(state.event_count, 0);
        assert_eq!(state.session_start, 1000);
        assert_eq!(state.last_event_time, 0);
    }
}
