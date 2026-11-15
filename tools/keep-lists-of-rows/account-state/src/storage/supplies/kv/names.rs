// src/storage/supplies/kv/names.rs
//
// Purpose: Name a key in a store whose ids are text. A key is the lowercase hex of its bytes, so the store's text order
// is byte order; a reverse index names the same key by its hex digits flipped, so ascending order of those names is
// descending key order.
//
// Non-Negotiable Invariants:
// - `hex` is order-preserving: for byte strings a and b, a < b exactly when hex(a) < hex(b).
// - `reversed` is order-reversing, including between a key and a key that extends it: the name ends in `~`, which sorts
//   above every hex digit, so a key sorts after every key that extends it.
//
// Key Concepts:
// - Used by every `Backend` that keys by text id (Mongo, CouchDB, SurrealDB) and by S3, which also needs the reverse
//   index because it cannot list backwards.
//
// Security Considerations:
// - Pure functions over bytes.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use std::fmt::Write as _;

/// The lowercase hex of a key.
pub fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

/// The key a hex name stands for; None when the text is not an even run of hex digits.
pub fn unhex(text: &str) -> Option<Vec<u8>> {
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok()).collect()
}

/// A hex digit read as a value, reversed (`0` becomes `f`), so a larger digit sorts first.
fn flip(digit: char) -> char {
    char::from_digit(15 - digit.to_digit(16).unwrap_or(0), 16).unwrap_or('0')
}

/// The name of a key in the reverse index.
pub fn reversed(key: &[u8]) -> String {
    let mut name: String = hex(key).chars().map(flip).collect();
    name.push('~');
    name
}

/// The key a reverse-index name stands for.
pub fn unreversed(name: &str) -> Option<Vec<u8>> {
    let digits: String = name.strip_suffix('~')?.chars().map(flip).collect();
    unhex(&digits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_keep_or_reverse_byte_order() {
        let keys: Vec<Vec<u8>> = vec![vec![], vec![0], vec![0, 0], vec![0, 1], vec![1], vec![0x0f], vec![0x10], vec![0xff], vec![0xff, 0]];
        for a in &keys {
            for b in &keys {
                assert_eq!(a < b, hex(a) < hex(b), "{a:?} {b:?}");
                assert_eq!(a < b, reversed(a) > reversed(b), "{a:?} {b:?}");
            }
            assert_eq!(unhex(&hex(a)).as_deref(), Some(a.as_slice()));
            assert_eq!(unreversed(&reversed(a)).as_deref(), Some(a.as_slice()));
        }
    }
}
