// source-code-to-sign/content-crypto/src/lib.rs
//
//! # Content Crypto
//!
//! Shared cryptographic primitives — leaf crate with zero Architect dependencies.
//! Runs anywhere: WASM sandbox, browser, native, embedded.
//!
//! Supports:
//! - Blake3-256 hashing (fast, modern)
//! - SHA-256 hashing (standard, compatible)
//! - Multihash self-describing hashes with IETF multicodec codes
//! - LEB128 varint encoding for compact wire format
//!
//! ## Standard API (Multihash)
//!
//! For all standard hashing (ETags, content addressing, integrity checks),
//! use self-describing `Multihash`:
//!
//! ```
//! use content_crypto::Multihash;
//!
//! let m = Multihash::blake3(b"test data");
//! let encoded = m.encode();
//! let decoded = Multihash::decode(&encoded).unwrap();
//! assert_eq!(m, decoded);
//!
//! // SHA-256 variant
//! let s = Multihash::sha256(b"test data");
//! assert_ne!(m.code, s.code); // self-describing — algorithm is in the hash
//! ```
//!
//! ## Advanced API (Re-exports)
//!
//! For specialized cryptography (keyed MACs, KDFs, streaming, SHA-512),
//! use the re-exported underlying crates. This avoids O(n) wrapper tax
//! while maintaining Cargo.toml quarantine — blake3 and sha2 appear in
//! exactly ONE Cargo.toml (this crate's).
//!
//! ```ignore
//! use content_crypto::advanced::blake3;
//! let key_material = blake3::derive_key("my-context", b"secret");
//!
//! use content_crypto::advanced::sha2::{Digest, Sha512};
//! let hash = Sha512::digest(b"data");
//! ```

pub mod multihash;
pub mod signature;
pub mod varint;
pub mod verify;
pub mod subtree;

pub use multihash::{Multihash, MultihashError};
pub use signature::{Ed25519Signature, SignatureError};
pub use verify::{AlgorithmStatus, DigestVerificationRegistry, HashError, Verifier};

// ============================================================================
// ADVANCED RE-EXPORTS — Facade pattern for specialized crypto
// ============================================================================
//
// Crates needing advanced primitives (keyed MAC, KDF, SHA-512, streaming)
// import via `content_crypto::advanced::{blake3, sha2}`.
//
// This maintains Cargo.toml quarantine (blake3/sha2 in ONE place) without
// forcing O(n) manual wrappers for every specialized function.

/// Re-exported underlying crypto crates for advanced use cases.
/// Standard hashing should use `Multihash` — use these only for
/// keyed MACs, KDFs, SHA-512, or streaming that Multihash doesn't cover.
pub mod advanced {
    pub use blake3;
    pub use sha2;
}

// ============================================================================
// CONVENIENCE — Blake3 one-shot (most common operation)
// ============================================================================

/// Compute Blake3-256 hash of the complete input.
#[inline]
pub fn hash(bytes: &[u8]) -> [u8; 32] {
    *blake3::hash(bytes).as_bytes()
}

/// Incremental Blake3 hasher for large payloads — hash-while-streaming.
pub struct StreamingHasher {
    inner: blake3::Hasher,
}

impl StreamingHasher {
    /// Create a new streaming hasher.
    #[inline]
    pub fn new() -> Self {
        Self {
            inner: blake3::Hasher::new(),
        }
    }

    /// Feed more bytes into the hasher.
    #[inline]
    pub fn update(&mut self, bytes: &[u8]) {
        self.inner.update(bytes);
    }

    /// Finalize and return the Blake3-256 digest.
    #[inline]
    pub fn finalize(&self) -> [u8; 32] {
        *self.inner.finalize().as_bytes()
    }

    /// Finalize and wrap in a Multihash with Blake3 code (0x1F).
    #[inline]
    pub fn finalize_multihash(&self) -> Multihash {
        let digest = self.finalize();
        Multihash::from_digest(0x1F, digest.to_vec())
            .expect("Blake3 produces 32 bytes which fits in [u8;64]")
    }
}

impl Default for StreamingHasher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_known_input() {
        let digest = hash(b"hello world");
        // Blake3 deterministic — same input always produces same output
        assert_eq!(digest.len(), 32);
        assert_eq!(digest, hash(b"hello world"));
    }

    #[test]
    fn hash_empty_input() {
        let digest = hash(b"");
        assert_eq!(digest.len(), 32);
        // Empty input still produces a valid 32-byte hash
        assert_ne!(digest, [0u8; 32]);
    }

    #[test]
    fn streaming_matches_oneshot() {
        let input = b"the quick brown fox jumps over the lazy dog";
        let oneshot = hash(input);

        let mut hasher = StreamingHasher::new();
        hasher.update(&input[..10]);
        hasher.update(&input[10..20]);
        hasher.update(&input[20..]);
        assert_eq!(hasher.finalize(), oneshot);
    }

    #[test]
    fn streaming_empty() {
        let hasher = StreamingHasher::new();
        assert_eq!(hasher.finalize(), hash(b""));
    }

    #[test]
    fn streaming_single_byte_updates() {
        let input = b"abcdef";
        let oneshot = hash(input);

        let mut hasher = StreamingHasher::new();
        for byte in input {
            hasher.update(std::slice::from_ref(byte));
        }
        assert_eq!(hasher.finalize(), oneshot);
    }

    #[test]
    fn conformance_matches_blake3_directly() {
        let inputs: &[&[u8]] = &[b"", b"a", b"hello world", &[0u8; 1024], &[0xFF; 65536]];
        for input in inputs {
            let ours = hash(input);
            let direct = *blake3::hash(input).as_bytes();
            assert_eq!(ours, direct, "mismatch for input of len {}", input.len());
        }
    }

    #[test]
    fn different_inputs_different_hashes() {
        assert_ne!(hash(b"hello"), hash(b"world"));
        assert_ne!(hash(b""), hash(b"a"));
    }

    #[test]
    fn advanced_blake3_reexport_works() {
        let direct = advanced::blake3::hash(b"test");
        assert_eq!(*direct.as_bytes(), hash(b"test"));
    }

    #[test]
    fn advanced_sha2_reexport_works() {
        use advanced::sha2::Digest;
        let result = advanced::sha2::Sha256::digest(b"test");
        let mh = Multihash::sha256(b"test");
        assert_eq!(&result[..], mh.as_bytes());
    }

    #[test]
    fn advanced_blake3_keyed_hash_works() {
        let key = [0x42u8; 32];
        let mac = advanced::blake3::keyed_hash(&key, b"message");
        assert_eq!(mac.as_bytes().len(), 32);
    }

    #[test]
    fn advanced_blake3_derive_key_works() {
        let derived = advanced::blake3::derive_key("test context", b"key material");
        assert_eq!(derived.len(), 32);
    }
}
