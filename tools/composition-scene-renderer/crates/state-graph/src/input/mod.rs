//! Input state types for the unified state graph.
//!
//! This module provides types for tracking all forms of user input:
//! - Pointer (mouse, touch, stylus)
//! - Keyboard
//! - Device sensors (accelerometer, gyroscope, etc.)
//! - Audio/voice

mod keyboard;
mod pointer;

pub use keyboard::KeyboardState;
pub use pointer::{PointerState, PointerStatus, WelfordAccumulator};

use serde::{Deserialize, Serialize};

/// Current device sensor state.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct DeviceState {
    /// Kinetic energy computed from accelerometer (simplified)
    pub kinetic_energy: f32,
    /// Current orientation from gyroscope (pitch, roll, yaw in radians)
    pub orientation: (f32, f32, f32),
    /// Ambient light level (lux)
    pub ambient_light: f32,
    /// Proximity distance (cm)
    pub proximity: f32,
    /// Timestamp of last sensor update
    pub last_updated: u64,
}

impl DeviceState {
    /// Create a new device state
    pub fn new() -> Self {
        Self::default()
    }

    /// Update orientation from gyroscope
    pub fn update_orientation(&mut self, pitch: f32, roll: f32, yaw: f32, timestamp: u64) {
        self.orientation = (pitch, roll, yaw);
        self.last_updated = timestamp;
    }

    /// Update ambient light level
    pub fn update_ambient_light(&mut self, lux: f32, timestamp: u64) {
        self.ambient_light = lux;
        self.last_updated = timestamp;
    }

    /// Update proximity sensor
    pub fn update_proximity(&mut self, distance_cm: f32, timestamp: u64) {
        self.proximity = distance_cm;
        self.last_updated = timestamp;
    }

    /// Update kinetic energy from accelerometer
    pub fn update_kinetic_energy(&mut self, energy: f32, timestamp: u64) {
        self.kinetic_energy = energy;
        self.last_updated = timestamp;
    }
}

/// Current audio/voice state.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AudioState {
    /// Last recognized voice command
    pub last_command: Option<String>,
    /// Confidence of last command (0.0-1.0)
    pub last_confidence: f32,
    /// Whether audio permission has been granted
    pub audio_permitted: bool,
    /// Timestamp of last voice event
    pub last_updated: u64,
}

impl AudioState {
    /// Create a new audio state
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a recognized voice command
    pub fn record_command(&mut self, command: &str, confidence: f32, timestamp: u64) {
        self.last_command = Some(command.to_string());
        self.last_confidence = confidence;
        self.last_updated = timestamp;
    }

    /// Set audio permission status
    pub fn set_permitted(&mut self, permitted: bool) {
        self.audio_permitted = permitted;
    }

    /// Clear the last command
    pub fn clear_command(&mut self) {
        self.last_command = None;
        self.last_confidence = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_device_state() {
        let mut state = DeviceState::new();
        assert_eq!(state.orientation, (0.0, 0.0, 0.0));

        state.update_orientation(0.1, 0.2, 0.3, 100);
        assert_eq!(state.orientation, (0.1, 0.2, 0.3));
        assert_eq!(state.last_updated, 100);

        state.update_ambient_light(500.0, 200);
        assert_eq!(state.ambient_light, 500.0);
    }

    #[test]
    fn test_audio_state() {
        let mut state = AudioState::new();
        assert!(state.last_command.is_none());
        assert!(!state.audio_permitted);

        state.set_permitted(true);
        assert!(state.audio_permitted);

        state.record_command("play music", 0.95, 100);
        assert_eq!(state.last_command, Some("play music".to_string()));
        assert!((state.last_confidence - 0.95).abs() < 0.001);

        state.clear_command();
        assert!(state.last_command.is_none());
    }
}
