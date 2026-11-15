// crates/content-chunks/src/lib.rs
//
// Purpose: split any byte stream into content-defined chunks and name every chunk and the whole stream by BLAKE3, the
// same way on every holder. A device splits a file while it uploads it; the Worker checks each chunk's identity as
// it arrives. Because a boundary depends only on the bytes around it, an edit in the middle of a file changes only
// the chunks it touches, so a re-upload or a duplicate sends only the chunks the store does not already hold.
//
// Non-negotiable invariants:
// - Boundaries are a pure function of the bytes and the three sizes: the same input always gives the same chunks,
//   however it is fed (one call or many).
// - Every chunk is at least `min` and at most `max` bytes, except the last, which may be shorter than `min`.
// - An identity is standard BLAKE3 (`b3sum` gives the same hex), written as `1f:` + 64 hex by callers.
//
// Key concepts: the cut test is FastCDC's normalized chunking (a gear rolling hash, a stricter mask before the
// average size and a looser one after it), which keeps chunk sizes close to the average without a second pass.
use wasm_bindgen::prelude::*;

// 256 fixed 64-bit gear values, derived once from BLAKE3 so they are reproducible and need no table in the source.
fn gear_table() -> [u64; 256] {
    let mut table = [0u64; 256];
    let mut output = blake3::Hasher::new_derive_key("content-chunks gear table").finalize_xof();
    let mut bytes = [0u8; 8];
    for value in table.iter_mut() {
        output.fill(&mut bytes);
        *value = u64::from_le_bytes(bytes);
    }
    table
}

fn mask_with_bits(bits: u32) -> u64 {
    // Spread the one-bits over the high half of the word, where the gear hash mixes best.
    let mut mask = 0u64;
    let mut placed = 0;
    let mut position = 63i32;
    while placed < bits && position >= 0 {
        mask |= 1u64 << position;
        placed += 1;
        position -= 2;
    }
    mask
}

/// Streaming content-defined chunker. Feed bytes with `push`; each call returns the lengths of the chunks that
/// ended inside what was fed so far. `finish` returns the length of the last chunk (0 when nothing is left).
#[wasm_bindgen]
pub struct Chunker {
    gear: Box<[u64; 256]>,
    min: usize,
    average: usize,
    max: usize,
    strict: u64,
    loose: u64,
    hash: u64,
    length: usize,
}

#[wasm_bindgen]
impl Chunker {
    #[wasm_bindgen(constructor)]
    pub fn new(min: usize, average: usize, max: usize) -> Result<Chunker, JsError> {
        if !(min > 0 && min <= average && average <= max) {
            return Err(JsError::new("chunk sizes must satisfy 0 < min <= average <= max"));
        }
        let bits = (average as f64).log2().round() as u32;
        Ok(Chunker { gear: Box::new(gear_table()), min, average, max, strict: mask_with_bits(bits + 2), loose: mask_with_bits(bits.saturating_sub(2)), hash: 0, length: 0 })
    }

    /// Lengths of the chunks completed by `bytes` (a boundary falls after the last byte of each).
    pub fn push(&mut self, bytes: &[u8]) -> Vec<u32> {
        let mut cuts = Vec::new();
        for &byte in bytes {
            self.length += 1;
            self.hash = (self.hash << 1).wrapping_add(self.gear[byte as usize]);
            let cut = if self.length < self.min {
                false
            } else if self.length >= self.max {
                true
            } else if self.length < self.average {
                self.hash & self.strict == 0
            } else {
                self.hash & self.loose == 0
            };
            if cut {
                cuts.push(self.length as u32);
                self.length = 0;
                self.hash = 0;
            }
        }
        cuts
    }

    /// The length of the final chunk, which ends where the input ends.
    pub fn finish(&mut self) -> u32 {
        let last = self.length as u32;
        self.length = 0;
        self.hash = 0;
        last
    }
}

/// Streaming BLAKE3.
#[wasm_bindgen]
pub struct Identity {
    hasher: blake3::Hasher,
}

#[wasm_bindgen]
impl Identity {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Identity {
        Identity { hasher: blake3::Hasher::new() }
    }
    pub fn update(&mut self, bytes: &[u8]) {
        self.hasher.update(bytes);
    }
    /// The hex digest of everything fed so far; the hasher can keep being fed.
    pub fn hex(&self) -> String {
        self.hasher.finalize().to_hex().to_string()
    }
}

impl Default for Identity {
    fn default() -> Self {
        Self::new()
    }
}

/// The hex BLAKE3 digest of `bytes`.
#[wasm_bindgen]
pub fn digest_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(size: usize, seed: u64) -> Vec<u8> {
        let mut state = seed;
        (0..size).map(|_| { state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (state >> 33) as u8 }).collect()
    }

    fn cuts(bytes: &[u8], feed: usize) -> Vec<u32> {
        let mut chunker = Chunker::new(64 * 1024, 256 * 1024, 1024 * 1024).unwrap();
        let mut all = Vec::new();
        for piece in bytes.chunks(feed) { all.extend(chunker.push(piece)); }
        let last = chunker.finish();
        if last > 0 { all.push(last); }
        all
    }

    #[test]
    fn boundaries_do_not_depend_on_how_bytes_are_fed() {
        let bytes = sample(6 * 1024 * 1024, 1);
        assert_eq!(cuts(&bytes, bytes.len()), cuts(&bytes, 4093));
        assert_eq!(cuts(&bytes, 1), cuts(&bytes, 65536));
    }

    #[test]
    fn sizes_stay_within_bounds_and_cover_every_byte() {
        let bytes = sample(9 * 1024 * 1024 + 17, 2);
        let lengths = cuts(&bytes, 100_000);
        assert_eq!(lengths.iter().map(|&n| n as usize).sum::<usize>(), bytes.len());
        for &n in &lengths[..lengths.len() - 1] { assert!((64 * 1024..=1024 * 1024).contains(&(n as usize))); }
    }

    #[test]
    fn an_insertion_changes_only_the_chunks_around_it() {
        let bytes = sample(8 * 1024 * 1024, 3);
        let mut edited = bytes.clone();
        edited.splice(4 * 1024 * 1024..4 * 1024 * 1024, [1u8, 2, 3, 4, 5]);
        let ids = |data: &[u8]| { let mut at = 0; cuts(data, data.len()).into_iter().map(|n| { let id = digest_hex(&data[at..at + n as usize]); at += n as usize; id }).collect::<Vec<_>>() };
        let (before, after) = (ids(&bytes), ids(&edited));
        let shared = after.iter().filter(|id| before.contains(id)).count();
        assert!(shared + 3 >= before.len(), "only a few chunks change: {shared} of {} shared", before.len());
    }

    #[test]
    fn identity_is_standard_blake3() {
        let mut streaming = Identity::new();
        streaming.update(b"hello ");
        streaming.update(b"world");
        assert_eq!(streaming.hex(), digest_hex(b"hello world"));
        assert_eq!(digest_hex(b""), "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262");
    }
}
