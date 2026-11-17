//! What the link to the account's computers measures, and every amount derived from it.
//!
//! The core holds no timing or size of its own. The round trip is the shortest one seen (the path's floor); the rate
//! is the latest answer's bytes over its transfer time (the link as it is now). Before a first answer nothing is
//! derived: the core asks exactly what the OS asked.

use crate::data::Bounds;

#[derive(Default, Clone, Copy, Debug)]
pub struct Link {
    round_trip_ms: Option<u64>,
    /// Bytes per millisecond of the latest answer that took time to arrive.
    rate: Option<f64>,
}

impl Link {
    /// One answer: when it was sent, when its first byte came, when it was complete, and its bytes.
    pub fn sample(&mut self, sent_ms: u64, first_byte_ms: u64, done_ms: u64, bytes: u64) {
        if first_byte_ms >= sent_ms {
            let round_trip = first_byte_ms - sent_ms;
            self.round_trip_ms = Some(self.round_trip_ms.map_or(round_trip, |known| known.min(round_trip)));
        }
        if done_ms > first_byte_ms && bytes > 0 {
            self.rate = Some(bytes as f64 / (done_ms - first_byte_ms) as f64);
        }
    }

    pub fn round_trip_ms(&self) -> Option<u64> {
        self.round_trip_ms
    }

    pub fn rate(&self) -> Option<f64> {
        self.rate
    }

    /// The bytes the link carries in one round trip, its bandwidth-delay product.
    pub fn bytes_per_round_trip(&self) -> Option<u64> {
        Some((self.rate? * self.round_trip_ms? as f64) as u64)
    }

    /// The most bytes one request may carry: the contract's bound for it (`most`), and no more than the link carries
    /// in the contract's idle bound, so every answer arrives inside it and a stall is a real stall.
    pub fn request_most(&self, bounds: &Bounds, most: u64) -> u64 {
        let within_idle = self.rate.map(|rate| (rate * bounds.idle_ms as f64) as u64);
        within_idle.map_or(most, |within| within.clamp(1, most))
    }

    /// When a request of `bytes` sent at `sent_ms` has stalled: the contract's idle bound past its expected arrival.
    pub fn deadline_ms(&self, bounds: &Bounds, sent_ms: u64, bytes: u64) -> u64 {
        let expected = self.round_trip_ms.unwrap_or_default()
            + self.rate.map_or(0, |rate| (bytes as f64 / rate) as u64);
        sent_ms + expected + bounds.idle_ms
    }

    /// Whether a file is small enough that asking for it whole costs no more than one round trip (f2 rule 6: at high
    /// latency the first request takes the whole file).
    pub fn take_whole(&self, size: u64) -> bool {
        self.bytes_per_round_trip().is_some_and(|carried| size <= carried)
    }

    /// How far ahead of a sequential reader the bytes must be so that it never waits. Ahead bytes are asked in pieces
    /// the size of the reader's own reads (`read`), so the next bytes it needs are never queued behind a larger piece.
    /// A piece arrives one round trip plus `read / rate` after it is asked, while the reader eats `consumption` per
    /// ms, so it must still hold that much plus the piece being filled: `ahead = consumption x (round trip + read /
    /// rate) + read`. A reader is never counted faster than the link: what it reads past the link's rate it waits for
    /// regardless.
    pub fn ahead_bytes(&self, consumption: f64, read: u64) -> Option<u64> {
        let rate = self.rate?;
        let round_trip = self.round_trip_ms? as f64;
        let reader = consumption.min(rate);
        Some((reader * (round_trip + read as f64 / rate)).ceil() as u64 + read)
    }
}
