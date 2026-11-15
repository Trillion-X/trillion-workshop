//! Pointer state tracking for the unified state graph.
//!
//! This module provides types for tracking pointer (mouse, touch, stylus) state.
//! These are Physics-layer types - they track raw state without Society-level interpretation.

use serde::{Deserialize, Serialize};

/// State of a single pointer (finger, stylus, mouse).
/// Updated from pointer events.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PointerState {
    /// Pointer identifier
    pub pointer_id: u64,
    /// Current status
    pub status: PointerStatus,
    /// Current position (x, y)
    pub position: (f32, f32),
    /// Current pressure (0.0-1.0)
    pub pressure: f32,
    /// Total distance traveled since Down
    pub distance_traveled: f32,
    /// Current velocity (pixels per second) - calculated using Welford algorithm
    pub velocity: f32,
    /// Variance accumulator for Welford algorithm
    pub velocity_variance: WelfordAccumulator,
    /// Whether this pointer is currently dragging
    pub is_dragging: bool,
    /// Timestamp of last update (for TTL pruning)
    pub last_updated: u64,
    /// Position at Down event (for gesture detection)
    pub start_position: Option<(f32, f32)>,
    /// Timestamp at Down event
    pub start_time: Option<u64>,
}

impl Default for PointerState {
    fn default() -> Self {
        Self {
            pointer_id: 0,
            status: PointerStatus::Up,
            position: (0.0, 0.0),
            pressure: 0.0,
            distance_traveled: 0.0,
            velocity: 0.0,
            velocity_variance: WelfordAccumulator::default(),
            is_dragging: false,
            last_updated: 0,
            start_position: None,
            start_time: None,
        }
    }
}

impl PointerState {
    /// Create a new pointer state with the given ID
    pub fn new(pointer_id: u64) -> Self {
        Self {
            pointer_id,
            ..Default::default()
        }
    }

    /// Record a pointer down event
    pub fn down(&mut self, x: f32, y: f32, timestamp: u64, pressure: f32) {
        self.status = PointerStatus::Down;
        self.position = (x, y);
        self.start_position = Some((x, y));
        self.start_time = Some(timestamp);
        self.pressure = pressure;
        self.distance_traveled = 0.0;
        self.velocity = 0.0;
        self.velocity_variance.reset();
        self.is_dragging = false;
        self.last_updated = timestamp;
    }

    /// Record a pointer move event
    pub fn move_to(&mut self, x: f32, y: f32, timestamp: u64, pressure: f32) {
        let (prev_x, prev_y) = self.position;
        let dx = x - prev_x;
        let dy = y - prev_y;
        let dist = (dx * dx + dy * dy).sqrt();

        self.distance_traveled += dist;
        self.position = (x, y);
        self.pressure = pressure;

        // Calculate velocity
        if self.last_updated > 0 && timestamp > self.last_updated {
            let dt_ms = (timestamp - self.last_updated) as f64;
            if dt_ms > 0.0 {
                let instant_velocity = (dist as f64 / dt_ms) * 1000.0; // px/sec
                self.velocity_variance.update(instant_velocity);
                self.velocity = self.velocity_variance.mean as f32;
            }
        }

        if self.status == PointerStatus::Down {
            self.status = PointerStatus::Moving;
        }

        self.last_updated = timestamp;
    }

    /// Record a pointer up event
    pub fn up(&mut self, timestamp: u64) {
        self.status = PointerStatus::Up;
        self.is_dragging = false;
        self.last_updated = timestamp;
    }

    /// Record a pointer cancel event
    pub fn cancel(&mut self, timestamp: u64) {
        self.status = PointerStatus::Canceled;
        self.is_dragging = false;
        self.last_updated = timestamp;
    }

    /// Start dragging
    pub fn start_drag(&mut self) {
        self.is_dragging = true;
    }

    /// Check if the pointer has moved beyond a threshold from start position
    pub fn has_moved_beyond(&self, threshold: f32) -> bool {
        self.distance_traveled > threshold
    }
}

/// Pointer status enum
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum PointerStatus {
    Down,
    Moving,
    #[default]
    Up,
    Canceled,
}

/// Welford's online algorithm accumulator for computing running variance.
/// Used for efficient velocity calculation without storing history.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WelfordAccumulator {
    pub count: u64,
    pub mean: f64,
    pub m2: f64, // Sum of squares of differences from the mean
}

impl WelfordAccumulator {
    /// Create a new accumulator
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a new sample to the accumulator
    pub fn update(&mut self, value: f64) {
        self.count += 1;
        let delta = value - self.mean;
        self.mean += delta / self.count as f64;
        let delta2 = value - self.mean;
        self.m2 += delta * delta2;
    }

    /// Get the current variance (population variance)
    pub fn variance(&self) -> f64 {
        if self.count < 2 {
            0.0
        } else {
            self.m2 / self.count as f64
        }
    }

    /// Get the current standard deviation
    pub fn std_dev(&self) -> f64 {
        self.variance().sqrt()
    }

    /// Reset the accumulator
    pub fn reset(&mut self) {
        self.count = 0;
        self.mean = 0.0;
        self.m2 = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pointer_state_new() {
        let state = PointerState::new(42);
        assert_eq!(state.pointer_id, 42);
        assert_eq!(state.status, PointerStatus::Up);
    }

    #[test]
    fn test_pointer_down_move_up() {
        let mut state = PointerState::new(1);

        // Down
        state.down(100.0, 100.0, 1000, 0.5);
        assert_eq!(state.status, PointerStatus::Down);
        assert_eq!(state.position, (100.0, 100.0));
        assert_eq!(state.start_position, Some((100.0, 100.0)));

        // Move
        state.move_to(110.0, 100.0, 1016, 0.6);
        assert_eq!(state.status, PointerStatus::Moving);
        assert_eq!(state.position, (110.0, 100.0));
        assert!(state.distance_traveled > 9.0 && state.distance_traveled < 11.0);

        // Up
        state.up(1032);
        assert_eq!(state.status, PointerStatus::Up);
    }

    #[test]
    fn test_pointer_dragging() {
        let mut state = PointerState::new(1);
        state.down(0.0, 0.0, 0, 1.0);
        assert!(!state.is_dragging);

        state.start_drag();
        assert!(state.is_dragging);

        state.up(100);
        assert!(!state.is_dragging);
    }

    #[test]
    fn test_welford_accumulator() {
        let mut acc = WelfordAccumulator::new();
        assert_eq!(acc.variance(), 0.0);

        // Add some values: 2, 4, 6 - mean should be 4, variance ~2.67
        acc.update(2.0);
        acc.update(4.0);
        acc.update(6.0);

        assert!((acc.mean - 4.0).abs() < 0.001);
        assert!((acc.variance() - 2.6666).abs() < 0.01);

        acc.reset();
        assert_eq!(acc.count, 0);
        assert_eq!(acc.mean, 0.0);
    }
}
