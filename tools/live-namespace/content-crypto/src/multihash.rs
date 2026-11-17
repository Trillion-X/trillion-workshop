// source-code-to-sign/content-crypto/src/multihash.rs
//
//! Multihash: self-describing hash type with algorithm code and raw digest.
//!
//! Supports multiple hash algorithms (Blake3, SHA-256, SHA-512, post-quantum, ...)
//! with IETF multicodec codes.
//!
//! Wire format: varint(code) + varint(digest.len()) + digest_bytes
//!
//! ## Shape: variable-length Vec<u8> digest
//!
//! Per plan `2026-04-09-cas-log-and-runtime-registry` §8 (Task C0), the digest
//! is a variable-length `Vec<u8>`. The previous `[u8; 64] + size: u8` cap was
//! removed because:
//!   1. The cap was a Society assumption (fixed 64-byte max) incompatible with
//!      hash algorithms whose digests exceed 64 bytes (e.g., SHA-3-512 family
//!      or post-quantum digests).
//!   2. The cap was justified by malloc-in-hot-path pressure; that pressure is
//!      eliminated by the CAS log architecture (Task C3) — the hot set no
//!      longer owns the digest bytes, so malloc frequency is irrelevant.
//!
//! `Multihash` is therefore NOT `Copy`. Call sites that previously relied on
//! implicit copy semantics must now choose `&mh` (borrow) or `mh.clone()`
//! (explicit ownership). This is a load-bearing architectural choice — each
//! site expresses its actual ownership intent.

use crate::varint::{decode_varint, encode_varint, encode_varint_into, encoded_varint_len};
use serde::{Deserialize, Serialize};
use sha2::Digest;

/// Error type for Multihash encoding/decoding.
#[derive(Debug, thiserror::Error)]
pub enum MultihashError {
    #[error("empty digest")]
    EmptyDigest,

    #[error("invalid varint encoding")]
    InvalidVarint,

    #[error("digest length mismatch: expected {expected}, got {got}")]
    DigestLengthMismatch { expected: usize, got: usize },
}

/// Self-describing hash: algorithm code + raw digest bytes.
///
/// IETF multicodec codes (examples):
/// - `0x12` = SHA-256
/// - `0x13` = SHA-512
/// - `0x1F` = Blake3-256
///
/// The `digest` field is variable-length. There is no maximum — callers may
/// store any byte length the underlying algorithm produces. Empty digests
/// (`Vec::new()`) are rejected because a hash without bytes has no identity.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Multihash {
    /// IETF multicodec algorithm code.
    pub code: u64,
    /// Raw digest bytes. Length is whatever the algorithm produces.
    pub digest: Vec<u8>,
}

// ── Default ───────────────────────────────────────────────────────────────────

impl Default for Multihash {
    fn default() -> Self {
        // Blake3-256 of empty input (stable, deterministic default).
        Self {
            code: Self::BLAKE3_CODE,
            digest: blake3::hash(&[]).as_bytes().to_vec(),
        }
    }
}

// ── Algorithm codes (IETF multicodec) ────────────────────────────────────────

impl Multihash {
    /// IETF multicodec code for Blake3-256.
    /// CSSOT for this constant — never hardcode 0x1F elsewhere.
    pub const BLAKE3_CODE: u64 = 0x1F;

    /// IETF multicodec code for SHA-256.
    pub const SHA256_CODE: u64 = 0x12;

    /// IETF multicodec code for SHA-512.
    pub const SHA512_CODE: u64 = 0x13;
}

// ── Core constructors and methods ─────────────────────────────────────────────

impl Multihash {
    /// Internal: build from a borrowed slice. Rejects empty digests only.
    fn from_slice(code: u64, bytes: &[u8]) -> Result<Self, MultihashError> {
        if bytes.is_empty() {
            return Err(MultihashError::EmptyDigest);
        }
        Ok(Self {
            code,
            digest: bytes.to_vec(),
        })
    }

    /// Hash data with Blake3, wrap in Multihash with code 0x1F.
    #[inline]
    pub fn blake3(data: &[u8]) -> Self {
        Self {
            code: Self::BLAKE3_CODE,
            digest: blake3::hash(data).as_bytes().to_vec(),
        }
    }

    /// Recompute this multihash as Blake3-256 in place, reusing the digest
    /// vector's existing capacity when possible. Preserves the `Vec<u8>`
    /// representation required for hash agility while eliminating repeated
    /// heap allocation on hot paths that hash many same-width Blake3 values.
    #[inline]
    pub fn set_blake3(&mut self, data: &[u8]) {
        self.code = Self::BLAKE3_CODE;
        if self.digest.len() != 32 {
            self.digest.resize(32, 0);
        }
        self.digest.copy_from_slice(blake3::hash(data).as_bytes());
    }

    /// Hash data with SHA-256, wrap in Multihash with code 0x12.
    pub fn sha256(data: &[u8]) -> Self {
        use sha2::Sha256;
        Self {
            code: Self::SHA256_CODE,
            digest: Sha256::digest(data).to_vec(),
        }
    }

    /// Wrap a pre-computed digest (raw constructor).
    ///
    /// Returns error if the digest is empty.
    pub fn from_digest(code: u64, digest: Vec<u8>) -> Result<Self, MultihashError> {
        if digest.is_empty() {
            return Err(MultihashError::EmptyDigest);
        }
        Ok(Self { code, digest })
    }

    /// Access the digest bytes.
    #[inline]
    pub fn as_bytes(&self) -> &[u8] {
        &self.digest
    }

    /// Parse from "code:hex" display format (e.g., "1f:abcd..." for Blake3).
    ///
    /// CSSOT: This is the ONE place that parses the "code:hex" string format.
    pub fn from_code_hex(s: &str) -> Result<Self, MultihashError> {
        let colon_idx = s.find(':').ok_or(MultihashError::InvalidVarint)?;
        let code =
            u64::from_str_radix(&s[..colon_idx], 16).map_err(|_| MultihashError::InvalidVarint)?;
        let bytes = hex::decode(&s[colon_idx + 1..]).map_err(|_| MultihashError::InvalidVarint)?;
        Self::from_slice(code, &bytes)
    }

    /// Format as "code:hex" display string (e.g., "1f:abcd..." for Blake3).
    ///
    /// Inverse of from_code_hex(). CSSOT for the string representation.
    pub fn to_code_hex(&self) -> String {
        format!("{:x}:{}", self.code, hex::encode(&self.digest))
    }

    /// Default hash — calls blake3().
    ///
    /// NO algorithm parameter. The algorithm choice is in ONE place — this function.
    pub fn hash(data: &[u8]) -> Self {
        Self::blake3(data)
    }

    /// Encode to wire format: varint(code) + varint(digest.len()) + digest_bytes.
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(self.encoded_len());
        buf.extend(encode_varint(self.code));
        buf.extend(encode_varint(self.digest.len() as u64));
        buf.extend_from_slice(&self.digest);
        buf
    }

    /// Return the encoded wire length without allocating.
    #[inline]
    pub fn encoded_len(&self) -> usize {
        encoded_varint_len(self.code)
            + encoded_varint_len(self.digest.len() as u64)
            + self.digest.len()
    }

    /// Return the encoded multihash header length (algorithm code + digest
    /// length varints) without the digest bytes.
    #[inline]
    pub fn encoded_header_len(&self) -> usize {
        encoded_varint_len(self.code) + encoded_varint_len(self.digest.len() as u64)
    }

    /// Encode just the multihash header into a caller-provided buffer.
    /// Returns the number of bytes written.
    #[inline]
    pub fn encode_header_into(&self, buf: &mut [u8]) -> usize {
        let mut pos = 0usize;
        pos += encode_varint_into(self.code, &mut buf[pos..]);
        pos += encode_varint_into(self.digest.len() as u64, &mut buf[pos..]);
        pos
    }

    /// Encode to wire format into a caller-provided buffer.
    /// Returns the number of bytes written.
    #[inline]
    pub fn encode_into(&self, buf: &mut [u8]) -> usize {
        let mut pos = 0usize;
        pos += encode_varint_into(self.code, &mut buf[pos..]);
        pos += encode_varint_into(self.digest.len() as u64, &mut buf[pos..]);
        buf[pos..pos + self.digest.len()].copy_from_slice(&self.digest);
        pos + self.digest.len()
    }

    /// Decode from wire format: varint(code) + varint(digest.len()) + digest_bytes.
    pub fn decode(bytes: &[u8]) -> Result<Self, MultihashError> {
        if bytes.is_empty() {
            return Err(MultihashError::InvalidVarint);
        }

        let (code, mut pos) = decode_varint(bytes)?;

        let (digest_len, len_bytes) = decode_varint(&bytes[pos..])?;
        pos += len_bytes;

        let digest_len = usize::try_from(digest_len).map_err(|_| MultihashError::InvalidVarint)?;
        let digest_end = match pos.checked_add(digest_len) {
            Some(end) if end <= bytes.len() => end,
            // Leaf crate — no tracing dep. Error carries the diagnostic.
            _ => {
                return Err(MultihashError::DigestLengthMismatch {
                    expected: digest_len,
                    got: bytes.len() - pos,
                })
            }
        };

        let digest_bytes = &bytes[pos..digest_end];

        if digest_bytes.is_empty() {
            return Err(MultihashError::EmptyDigest);
        }

        Self::from_slice(code, digest_bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_multihash_blake3_constructor() {
        let data = b"test data";
        let m = Multihash::blake3(data);
        assert_eq!(m.code, 0x1F);
        assert_eq!(m.digest.len(), 32);
        assert_eq!(m.digest.as_slice(), blake3::hash(data).as_bytes().as_ref());
    }

    #[test]
    fn test_set_blake3_reuses_digest_buffer() {
        let mut m = Multihash::blake3(b"first");
        let before_ptr = m.digest.as_ptr();
        let before_cap = m.digest.capacity();

        m.set_blake3(b"second");

        assert_eq!(m.code, 0x1F);
        assert_eq!(m.digest.len(), 32);
        assert_eq!(
            m.digest.as_slice(),
            blake3::hash(b"second").as_bytes().as_ref()
        );
        assert_eq!(m.digest.as_ptr(), before_ptr);
        assert_eq!(m.digest.capacity(), before_cap);
    }

    #[test]
    fn test_encode_header_into_matches_full_encoding_prefix() {
        let m = Multihash::blake3(b"header-prefix");
        let mut header = [0u8; 16];
        let header_len = m.encode_header_into(&mut header);
        let mut full = vec![0u8; m.encoded_len()];
        m.encode_into(&mut full);

        assert_eq!(header_len, m.encoded_header_len());
        assert_eq!(&header[..header_len], &full[..header_len]);
        assert_eq!(&full[header_len..], m.as_bytes());
    }

    #[test]
    fn test_multihash_sha256_constructor() {
        let data = b"test data";
        let m = Multihash::sha256(data);
        assert_eq!(m.code, 0x12);
        assert_eq!(m.digest.len(), 32);
    }

    #[test]
    fn test_multihash_hash_default() {
        let data = b"test data";
        let m = Multihash::hash(data);
        assert_eq!(m, Multihash::blake3(data));
    }

    #[test]
    fn test_clone_semantics() {
        let a = Multihash::blake3(b"hello");
        let b = a.clone();
        assert_eq!(a, b);
        assert_eq!(a.code, b.code);
        assert_eq!(a.digest, b.digest);
    }

    #[test]
    fn test_as_bytes_returns_digest() {
        let m = Multihash::blake3(b"test");
        assert_eq!(m.as_bytes().len(), 32);
        assert_eq!(m.as_bytes(), blake3::hash(b"test").as_bytes().as_ref());
    }

    #[test]
    fn test_multihash_roundtrip_blake3() {
        let data = b"the quick brown fox jumps over the lazy dog";
        let original = Multihash::blake3(data);
        let encoded = original.encode();
        let decoded = Multihash::decode(&encoded).expect("failed to decode");
        assert_eq!(original, decoded);
    }

    #[test]
    fn test_multihash_roundtrip_sha256() {
        let data = b"hello world";
        let original = Multihash::sha256(data);
        let encoded = original.encode();
        let decoded = Multihash::decode(&encoded).expect("failed to decode");
        assert_eq!(original, decoded);
    }

    #[test]
    fn test_varint_roundtrip() {
        for value in &[0u64, 1, 127, 128, 300, u32::MAX as u64, u64::MAX] {
            let encoded = encode_varint(*value);
            let (decoded, _) = decode_varint(&encoded).expect("failed to decode varint");
            assert_eq!(*value, decoded);
        }
    }

    #[test]
    fn test_cross_algorithm_not_equal() {
        let data = b"test";
        let blake3 = Multihash::blake3(data);
        let sha256 = Multihash::sha256(data);
        assert_ne!(blake3, sha256);
        assert_ne!(blake3.code, sha256.code);
    }

    #[test]
    fn test_same_algorithm_dedup() {
        let data = b"test";
        assert_eq!(Multihash::blake3(data), Multihash::blake3(data));
        assert_eq!(Multihash::sha256(data), Multihash::sha256(data));
    }

    #[test]
    fn test_empty_digest_rejected() {
        let result = Multihash::from_digest(0x1F, vec![]);
        assert!(matches!(result, Err(MultihashError::EmptyDigest)));
    }

    // ── Uncap acceptance tests (C0) ──────────────────────────────────────────

    #[test]
    fn test_digest_32_bytes_accepted() {
        let result = Multihash::from_digest(0x1F, vec![0u8; 32]);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().digest.len(), 32);
    }

    #[test]
    fn test_digest_64_bytes_accepted() {
        // Previously the max allowed — must still work post-uncap.
        let result = Multihash::from_digest(0x13, vec![0u8; 64]);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().digest.len(), 64);
    }

    #[test]
    fn test_digest_128_bytes_accepted() {
        // Previously rejected — must now work (hypothetical post-quantum).
        let result = Multihash::from_digest(0x20, vec![0xABu8; 128]);
        assert!(result.is_ok());
        let m = result.unwrap();
        assert_eq!(m.digest.len(), 128);
        assert_eq!(m.as_bytes().len(), 128);
    }

    #[test]
    fn test_digest_256_bytes_accepted_via_from_slice_path() {
        // Exercise the from_slice path (used by decode + from_code_hex).
        // Empty is the only rejection; 256 bytes must round-trip.
        let original = Multihash::from_digest(0x21, vec![0xCDu8; 256]).unwrap();
        let encoded = original.encode();
        let decoded = Multihash::decode(&encoded).expect("256-byte digest must decode");
        assert_eq!(original, decoded);
        assert_eq!(decoded.digest.len(), 256);
    }

    #[test]
    fn test_roundtrip_variable_lengths_bit_for_bit() {
        for len in [1usize, 32, 64, 128, 256, 512, 1024] {
            let digest: Vec<u8> = (0..len).map(|i| (i & 0xFF) as u8).collect();
            let original = Multihash::from_digest(0x1F, digest).unwrap();
            let encoded = original.encode();
            let decoded = Multihash::decode(&encoded)
                .unwrap_or_else(|e| panic!("decode failed at len={}: {:?}", len, e));
            assert_eq!(original, decoded, "mismatch at digest length {}", len);
            // Re-encode the decoded form — bit-for-bit identical.
            assert_eq!(
                encoded,
                decoded.encode(),
                "re-encode mismatch at len={}",
                len
            );
        }
    }

    #[test]
    fn test_from_multihash_accepts_arbitrary_codes() {
        // Algorithm-agnostic: any code is valid (caller's responsibility).
        for code in [0x12u64, 0x13, 0x14, 0x1F, 0x20, 0xDEADBEEF] {
            let m = Multihash::from_digest(code, vec![0u8; 32]).unwrap();
            assert_eq!(m.code, code);
        }
    }

    // ── End uncap acceptance tests ───────────────────────────────────────────

    #[test]
    fn test_decode_invalid_varint() {
        let result =
            Multihash::decode(&[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        assert!(result.is_err());
        assert!(matches!(result, Err(MultihashError::InvalidVarint)));
    }

    #[test]
    fn test_decode_empty_buffer() {
        let result = Multihash::decode(&[]);
        assert!(result.is_err());
    }

    #[test]
    fn test_decode_digest_len_u64_max_rejected_without_panic() {
        let bytes = [
            0x1F, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
        ];
        let result = Multihash::decode(&bytes);
        assert!(matches!(
            result,
            Err(MultihashError::DigestLengthMismatch { .. })
        ));
    }

    #[test]
    fn test_wire_format_three_components() {
        let data = b"test";
        let m = Multihash::blake3(data);
        let encoded = m.encode();

        let (code, pos1) = decode_varint(&encoded).expect("failed to decode code");
        let (digest_len, pos2) = decode_varint(&encoded[pos1..]).expect("failed to decode length");
        let digest = &encoded[pos1 + pos2..];

        assert_eq!(code, 0x1F);
        assert_eq!(digest_len, 32);
        assert_eq!(digest.len(), 32);
    }

    #[test]
    fn test_code_hex_roundtrip_blake3() {
        let original = Multihash::blake3(b"roundtrip test");
        let s = original.to_code_hex();
        assert!(s.starts_with("1f:"));
        let parsed = Multihash::from_code_hex(&s).expect("failed to parse");
        assert_eq!(original, parsed);
    }

    #[test]
    fn test_code_hex_roundtrip_sha256() {
        let original = Multihash::sha256(b"roundtrip test");
        let s = original.to_code_hex();
        assert!(s.starts_with("12:"));
        let parsed = Multihash::from_code_hex(&s).expect("failed to parse");
        assert_eq!(original, parsed);
    }

    #[test]
    fn test_code_hex_rejects_no_colon() {
        let result = Multihash::from_code_hex("abc123");
        assert!(result.is_err());
    }

    #[test]
    fn test_code_hex_rejects_empty_digest() {
        let result = Multihash::from_code_hex("1f:");
        assert!(matches!(result, Err(MultihashError::EmptyDigest)));
    }

    #[test]
    fn test_serde_json_roundtrip() {
        let original = Multihash::blake3(b"serde test");
        let json = serde_json::to_string(&original).expect("serialize");
        let decoded: Multihash = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(original, decoded);
    }

    #[test]
    fn test_hash_trait_consistent_with_eq() {
        use std::collections::HashMap;
        let m1 = Multihash::blake3(b"key");
        let m2 = Multihash::blake3(b"key");
        assert_eq!(m1, m2);

        let mut map = HashMap::new();
        map.insert(m1.clone(), "value");
        assert_eq!(map.get(&m2), Some(&"value"));
    }

    #[test]
    fn test_ord_on_digest_bytes() {
        let a = Multihash::from_digest(0x1F, vec![0x01; 32]).unwrap();
        let b = Multihash::from_digest(0x1F, vec![0x02; 32]).unwrap();
        assert!(a < b);
        assert!(b > a);
    }
}
