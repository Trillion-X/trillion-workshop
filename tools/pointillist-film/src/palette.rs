//! crates/pointillist-film-core/src/palette.rs
//!
//! Color primitives for deterministic square-cell film frames.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct Rgba8 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba8 {
    pub const fn new(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }

    pub fn lerp(self, other: Self, t: f32) -> Self {
        Self {
            r: lerp_channel(self.r, other.r, t),
            g: lerp_channel(self.g, other.g, t),
            b: lerp_channel(self.b, other.b, t),
            a: lerp_channel(self.a, other.a, t),
        }
    }
}

fn lerp_channel(a: u8, b: u8, t: f32) -> u8 {
    let t = t.clamp(0.0, 1.0);
    let value = a as f32 + (b as f32 - a as f32) * t;
    value.round().clamp(0.0, 255.0) as u8
}
