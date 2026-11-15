//! Event history tracking for the unified state graph.
//!
//! This module provides types for tracking event history, which enables
//! pattern matching for gestures like double-tap, triple-click, etc.
//!
//! The event history is a universal log that works for ALL event types
//! (keyboard, pointer, sensor, voice). Trigger queries filter by
//! event_type/key/pointer_id to detect specific patterns.

use serde::{Deserialize, Serialize};

/// Universal event record for history tracking.
/// Works for ALL event types (keyboard, pointer, sensor, voice).
/// Trigger queries pattern-match on this to detect any pattern.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventRecord {
    /// Event type: "key_down", "key_up", "pointer_down", "pointer_up", "pointer_move", etc.
    pub event_type: String,
    /// For keyboard events: the key name
    pub key: Option<String>,
    /// For pointer events: the pointer ID
    pub pointer_id: Option<u64>,
    /// For pointer events: position
    pub position: Option<(f32, f32)>,
    /// Timestamp of the event (milliseconds)
    pub timestamp: u64,
}

impl EventRecord {
    /// Create a new event record
    pub fn new(event_type: impl Into<String>, timestamp: u64) -> Self {
        Self {
            event_type: event_type.into(),
            key: None,
            pointer_id: None,
            position: None,
            timestamp,
        }
    }

    /// Create a keyboard event record
    pub fn key_event(event_type: impl Into<String>, key: &str, timestamp: u64) -> Self {
        Self {
            event_type: event_type.into(),
            key: Some(key.to_string()),
            pointer_id: None,
            position: None,
            timestamp,
        }
    }

    /// Create a pointer event record
    pub fn pointer_event(
        event_type: impl Into<String>,
        pointer_id: u64,
        position: (f32, f32),
        timestamp: u64,
    ) -> Self {
        Self {
            event_type: event_type.into(),
            key: None,
            pointer_id: Some(pointer_id),
            position: Some(position),
            timestamp,
        }
    }

    /// Check if this is a keyboard event
    pub fn is_key_event(&self) -> bool {
        self.key.is_some()
    }

    /// Check if this is a pointer event
    pub fn is_pointer_event(&self) -> bool {
        self.pointer_id.is_some()
    }
}

/// Configuration for event history pruning (Society-level policy).
/// Passed in from EEAF when creating the engine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventHistoryConfig {
    /// Maximum number of events to keep (None = unlimited by count)
    pub max_events: Option<usize>,
    /// Maximum age of events in milliseconds (None = unlimited by time)
    pub max_age_ms: Option<u64>,
}

impl Default for EventHistoryConfig {
    fn default() -> Self {
        // Default: keep last 32 events, no time limit
        // This is a reasonable default but can be overridden by EEAF config
        Self {
            max_events: Some(32),
            max_age_ms: None,
        }
    }
}

impl EventHistoryConfig {
    /// Create a config with max events only
    pub fn with_max_events(max: usize) -> Self {
        Self {
            max_events: Some(max),
            max_age_ms: None,
        }
    }

    /// Create a config with max age only
    pub fn with_max_age(max_ms: u64) -> Self {
        Self {
            max_events: None,
            max_age_ms: Some(max_ms),
        }
    }

    /// Create a config with both limits
    pub fn with_both(max_events: usize, max_age_ms: u64) -> Self {
        Self {
            max_events: Some(max_events),
            max_age_ms: Some(max_age_ms),
        }
    }

    /// Create an unlimited config (no pruning)
    pub fn unlimited() -> Self {
        Self {
            max_events: None,
            max_age_ms: None,
        }
    }
}

/// Event history manager - handles storage and pruning of event records.
///
/// **Serialization:** Serializes as a bare array of EventRecords (not an object with `events` field).
/// This allows trigger queries to access: `graph.recent_events[0]` directly.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EventHistory {
    /// Events ordered newest-first
    events: Vec<EventRecord>,
    /// Pruning configuration (not serialized - internal state only)
    config: EventHistoryConfig,
}

/// Custom serialization: EventHistory serializes as just the events array
impl Serialize for EventHistory {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // Serialize as just the events array, not an object
        self.events.serialize(serializer)
    }
}

/// Custom deserialization: EventHistory deserializes from just the events array
impl<'de> Deserialize<'de> for EventHistory {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let events = Vec::<EventRecord>::deserialize(deserializer)?;
        Ok(Self {
            events,
            config: EventHistoryConfig::default(),
        })
    }
}

impl EventHistory {
    /// Create a new event history with default config
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a new event history with custom config
    pub fn with_config(config: EventHistoryConfig) -> Self {
        Self {
            events: Vec::new(),
            config,
        }
    }

    /// Add an event to the history (at the front - newest first)
    pub fn push(&mut self, event: EventRecord) {
        self.events.insert(0, event);
    }

    /// Prune events based on configuration
    pub fn prune(&mut self, current_time: u64) {
        // Prune by count first
        if let Some(max) = self.config.max_events {
            if self.events.len() > max {
                self.events.truncate(max);
            }
        }

        // Then prune by age
        if let Some(max_age) = self.config.max_age_ms {
            self.events
                .retain(|e| current_time.saturating_sub(e.timestamp) <= max_age);
        }
    }

    /// Push an event and immediately prune
    pub fn push_and_prune(&mut self, event: EventRecord, current_time: u64) {
        self.push(event);
        self.prune(current_time);
    }

    /// Get all events (newest first)
    pub fn events(&self) -> &[EventRecord] {
        &self.events
    }

    /// Get events as mutable slice
    pub fn events_mut(&mut self) -> &mut Vec<EventRecord> {
        &mut self.events
    }

    /// Get the most recent event
    pub fn most_recent(&self) -> Option<&EventRecord> {
        self.events.first()
    }

    /// Get the configuration
    pub fn config(&self) -> &EventHistoryConfig {
        &self.config
    }

    /// Update the configuration
    pub fn set_config(&mut self, config: EventHistoryConfig) {
        self.config = config;
    }

    /// Get the number of stored events
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// Check if history is empty
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// Clear all events
    pub fn clear(&mut self) {
        self.events.clear();
    }

    /// Find events matching a predicate
    pub fn find<P>(&self, predicate: P) -> impl Iterator<Item = &EventRecord>
    where
        P: Fn(&EventRecord) -> bool,
    {
        self.events.iter().filter(move |e| predicate(e))
    }

    /// Count events of a specific type within a time window
    pub fn count_events_in_window(
        &self,
        event_type: &str,
        window_ms: u64,
        current_time: u64,
    ) -> usize {
        self.events
            .iter()
            .filter(|e| {
                e.event_type == event_type && current_time.saturating_sub(e.timestamp) <= window_ms
            })
            .count()
    }

    /// Check for double-tap/double-click pattern
    pub fn is_double_tap(&self, event_type: &str, window_ms: u64, current_time: u64) -> bool {
        self.count_events_in_window(event_type, window_ms, current_time) >= 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_record_creation() {
        let event = EventRecord::new("custom", 1000);
        assert_eq!(event.event_type, "custom");
        assert_eq!(event.timestamp, 1000);
        assert!(event.key.is_none());
        assert!(event.pointer_id.is_none());
    }

    #[test]
    fn test_key_event() {
        let event = EventRecord::key_event("key_down", "Enter", 2000);
        assert!(event.is_key_event());
        assert!(!event.is_pointer_event());
        assert_eq!(event.key, Some("Enter".to_string()));
    }

    #[test]
    fn test_pointer_event() {
        let event = EventRecord::pointer_event("pointer_down", 1, (100.0, 200.0), 3000);
        assert!(event.is_pointer_event());
        assert!(!event.is_key_event());
        assert_eq!(event.pointer_id, Some(1));
        assert_eq!(event.position, Some((100.0, 200.0)));
    }

    #[test]
    fn test_history_pruning_by_count() {
        let config = EventHistoryConfig::with_max_events(3);
        let mut history = EventHistory::with_config(config);

        // Add 5 events
        for i in 0..5 {
            history.push(EventRecord::new("test", i as u64 * 100));
        }

        assert_eq!(history.len(), 5);

        // Prune should reduce to 3
        history.prune(1000);
        assert_eq!(history.len(), 3);

        // Most recent should be timestamp 400 (added last, at front)
        assert_eq!(history.most_recent().unwrap().timestamp, 400);
    }

    #[test]
    fn test_history_pruning_by_age() {
        let config = EventHistoryConfig::with_max_age(500); // 500ms max age
        let mut history = EventHistory::with_config(config);

        // Add events at different timestamps
        history.push(EventRecord::new("test", 100)); // oldest
        history.push(EventRecord::new("test", 300));
        history.push(EventRecord::new("test", 600));
        history.push(EventRecord::new("test", 900)); // newest

        // Current time is 1000ms - events older than 500ms (before 500) should be pruned
        history.prune(1000);

        // Should keep events at 600 and 900 (within 500ms of 1000)
        assert_eq!(history.len(), 2);
        assert_eq!(history.events()[0].timestamp, 900);
        assert_eq!(history.events()[1].timestamp, 600);
    }

    #[test]
    fn test_double_tap_detection() {
        let config = EventHistoryConfig::with_max_events(10);
        let mut history = EventHistory::with_config(config);

        // Add two clicks within 300ms
        history.push(EventRecord::new("click", 100));
        history.push(EventRecord::new("click", 250));

        // Should detect double click within 300ms window
        assert!(history.is_double_tap("click", 300, 300));

        // Should not detect if window is too small
        assert!(!history.is_double_tap("click", 100, 300));
    }

    #[test]
    fn test_count_events_in_window() {
        let mut history = EventHistory::new();
        history.push(EventRecord::new("click", 100));
        history.push(EventRecord::new("click", 200));
        history.push(EventRecord::new("move", 300));
        history.push(EventRecord::new("click", 400));

        // Count clicks in window
        let count = history.count_events_in_window("click", 500, 500);
        assert_eq!(count, 3);

        // Count moves
        let move_count = history.count_events_in_window("move", 500, 500);
        assert_eq!(move_count, 1);
    }
}
