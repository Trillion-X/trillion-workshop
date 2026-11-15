//! Canonical newtypes for identity fields.
//!
//! All identity fields use algorithm-agile content-addressed hashing via
//! `CryptoMultihash` — each value carries both the algorithm code and the
//! digest bytes, making algorithm identity a first-class property:
//! - `PartitionKey`: routing isolation boundary
//! - `FactAddress`: entity identity (stable, content-addressed)
//! - `PathSegment`: optional structural sub-address (opaque routing hint)
//! - `CapabilityHash`: authorization label (capability identity)
//! - `PrincipalId`: actor identity (who wrote this entry)
//!
//! Each newtype prevents accidental mixing of ID types at compile time (L041).
//! Serde serialization uses the `code:hex` format (e.g. `"1f:a1b2c3..."`) so
//! the algorithm is self-describing at every persistence boundary.

use content_crypto::Multihash as CryptoMultihash;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

macro_rules! multihash_newtype {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
        pub struct $name(CryptoMultihash);

        impl std::hash::Hash for $name {
            fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
                self.0.code.hash(state);
                self.0.as_bytes().hash(state);
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(&self.0.to_code_hex())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                CryptoMultihash::from_code_hex(&s)
                    .map(Self)
                    .map_err(serde::de::Error::custom)
            }
        }

        impl std::str::FromStr for $name {
            type Err = std::convert::Infallible;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self(CryptoMultihash::blake3(s.as_bytes())))
            }
        }

        impl $name {
            /// Content-addressed: deterministic Blake3-256 hash of the string.
            pub fn hash_from(s: &str) -> Self {
                Self(CryptoMultihash::blake3(s.as_bytes()))
            }

            /// Construct from any pre-built CryptoMultihash.
            ///
            /// This is the canonical constructor post-Task C1 (plan
            /// 2026-04-09-cas-log-and-runtime-registry). Callers that need to
            /// build an identity from raw parts must construct an explicit
            /// `CryptoMultihash` with a specific algorithm code and digest, then
            /// pass it through here. Algorithm choice is visible and auditable
            /// at every call site — the deleted `from_bytes([u8; 32])` baked
            /// Blake3-256 into Physics code as a hidden Society assumption.
            pub fn from_multihash(mh: CryptoMultihash) -> Self {
                Self(mh)
            }

            /// Borrow the inner CryptoMultihash.
            ///
            /// Canonical accessor name aligned with Rust conventions (`as_` for
            /// cheap borrow converters). Returns a reference into the newtype's
            /// owned multihash.
            pub fn as_multihash(&self) -> &CryptoMultihash {
                &self.0
            }

            /// Hex-encoded canonical wire bytes for exact-address protocols.
            ///
            /// This is intentionally different from serde/display `code:hex`.
            /// Serde/display is a self-describing persistence string; exact
            /// subscription and WIT frames carry the raw multihash bytes; text
            /// boundaries hex those bytes without changing their meaning.
            pub fn to_wire_hex(&self) -> String {
                hex::encode(self.0.encode())
            }

            /// Construct from any algorithm digest. Panics on empty digest.
            ///
            /// Preserved as a convenience for callers that have the raw code
            /// and digest bytes but don't already hold a `CryptoMultihash`.
            /// Equivalent to `Self::from_multihash(CryptoMultihash::from_digest(code, digest).unwrap())`.
            pub fn from_digest(code: u64, digest: Vec<u8>) -> Self {
                Self(CryptoMultihash::from_digest(code, digest)
                    .expect("caller provides a non-empty digest"))
            }

            /// Raw digest bytes. Length is algorithm-dependent.
            pub fn digest(&self) -> &[u8] {
                self.0.as_bytes()
            }

            /// Algorithm code (0x1F = Blake3-256, 0x12 = SHA-256, 0x13 = SHA-512).
            pub fn algo_code(&self) -> u64 {
                self.0.code
            }

            /// Best-effort UTF-8 view of the raw digest bytes.
            ///
            /// This is intentionally generic: some identities are opaque hash
            /// digests and will return `None`; others may carry raw text bytes
            /// in their digest field and can expose that text without the
            /// consumer importing any source-specific grammar.
            pub fn as_utf8_text(&self) -> Option<&str> {
                std::str::from_utf8(self.0.as_bytes()).ok()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0.to_code_hex())
            }
        }

        impl AsRef<[u8]> for $name {
            fn as_ref(&self) -> &[u8] {
                self.0.as_bytes()
            }
        }
    };
}

multihash_newtype!(
    /// Partition-isolated causal boundary. Content-addressed Blake3-256.
    PartitionKey
);

multihash_newtype!(
    /// Entity identity. Content-addressed Blake3-256. Stable across all nodes.
    FactAddress
);

multihash_newtype!(
    /// Optional structural sub-address. Content-addressed Blake3-256.
    /// Opaque routing hint for granular subscriptions.
    PathSegment
);

multihash_newtype!(
    /// Authorization label. Content-addressed Blake3-256 of the capability's issuer+scope.
    CapabilityHash
);

multihash_newtype!(
    /// Actor identity. Content-addressed Blake3-256 of the principal's identity.
    PrincipalId
);

/// Crypto-agile hash — newtype wrapping `content_crypto::Multihash`.
///
/// Per plan §14.6 T-HASH: "Replace enum Hash with newtype wrapping Multihash.
/// The [u8; 32] assumption is removed — digest length comes from Multihash itself."
///
/// Algorithm agility: adding post-quantum (0x30, 64-byte digest) requires ZERO
/// changes to this type — just register the verifier in DigestVerificationRegistry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hash(pub CryptoMultihash);

impl std::hash::Hash for Hash {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.0.code.hash(state);
        self.0.as_bytes().hash(state);
    }
}

impl Hash {
    /// Return the raw digest bytes (variable length — not fixed to 32).
    pub fn digest(&self) -> &[u8] {
        self.0.as_bytes()
    }

    /// Return the raw digest bytes (variable length — not fixed to 32).
    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }

    /// Construct a Blake3-256 hash from a 32-byte array (canonical).
    pub fn blake3(bytes: [u8; 32]) -> Self {
        Hash(
            CryptoMultihash::from_digest(0x1F, bytes.to_vec()).expect("32-byte array is non-empty"),
        )
    }

    /// Construct from hashing a byte slice with Blake3 (canonical).
    pub fn blake3_hash(data: &[u8]) -> Self {
        Hash(CryptoMultihash::blake3(data))
    }

    /// Recompute this hash in place using Blake3 while preserving the
    /// multihash-owned `Vec<u8>` digest shape.
    ///
    /// This removes repeated digest-buffer allocation in hot loops without
    /// collapsing hash agility to a fixed-width stack buffer. The algorithm
    /// remains explicit in the stored multihash code.
    pub fn set_blake3(&mut self, data: &[u8]) {
        self.0.set_blake3(data);
    }

    /// Construct a SHA-256 hash from a 32-byte array.
    pub fn sha256(bytes: [u8; 32]) -> Self {
        Hash(
            CryptoMultihash::from_digest(0x12, bytes.to_vec()).expect("32-byte array is non-empty"),
        )
    }

    /// Construct from raw 32-byte array using the canonical algorithm (Blake3-256).
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Hash::blake3(bytes)
    }

    /// Get the multicodec algorithm code (0x1F = Blake3, 0x12 = SHA-256).
    pub fn algo_code(&self) -> u64 {
        self.0.code
    }

    /// Check if this hash is Blake3-256 (canonical).
    pub fn is_blake3(&self) -> bool {
        self.0.code == 0x1F
    }

    /// Check if this hash is SHA-256.
    pub fn is_sha256(&self) -> bool {
        self.0.code == 0x12
    }

    /// Borrow the inner CryptoMultihash.
    ///
    /// Canonical accessor name (matches `multihash_newtype!` macro's
    /// `as_multihash` on PartitionKey/FactAddress/etc) — same concept,
    /// same name across all CryptoMultihash-wrapping types.
    pub fn as_multihash(&self) -> &CryptoMultihash {
        &self.0
    }

    /// Consume into inner Multihash.
    pub fn into_multihash(self) -> CryptoMultihash {
        self.0
    }

    /// Create Hash from a Multihash.
    pub fn from_multihash(mh: CryptoMultihash) -> Self {
        Hash(mh)
    }
}

impl fmt::Display for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", hex::encode(self.0.as_bytes()))
    }
}

impl Serialize for Hash {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(self.0.as_bytes()))
    }
}

impl<'de> Deserialize<'de> for Hash {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        let bytes = hex::decode(&s).map_err(serde::de::Error::custom)?;
        // Default to Blake3 for deserialization (canonical algorithm)
        CryptoMultihash::from_digest(0x1F, bytes)
            .map(Hash)
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_string_produces_same_hash() {
        let pk1 = PartitionKey::hash_from("price");
        let pk2 = PartitionKey::hash_from("price");
        assert_eq!(pk1, pk2);
    }

    #[test]
    fn different_strings_produce_different_hashes() {
        let pk1 = PartitionKey::hash_from("price");
        let pk2 = PartitionKey::hash_from("color");
        assert_ne!(pk1, pk2);
    }

    #[test]
    fn newtype_safety_compile_time() {
        let pk = PartitionKey::hash_from("test");
        let fa = FactAddress::hash_from("test");
        // Same string → same digest bytes, but different types (type safety confirmed)
        assert_eq!(pk.digest(), fa.digest());
        // Cannot pass PartitionKey where FactAddress is expected — compile-time enforcement
    }

    #[test]
    fn code_hex_serialization_roundtrip() {
        let pk = PartitionKey::hash_from("hello");
        let json = serde_json::to_string(&pk).unwrap();
        // Should be a quoted "1f:hexstring" — "1f:" (3) + 64 hex + 2 quotes = 69
        assert!(json.starts_with('"'));
        assert_eq!(json.len(), 69); // "1f:" prefix + 64 hex chars + 2 quotes
        let pk2: PartitionKey = serde_json::from_str(&json).unwrap();
        assert_eq!(pk, pk2);
    }

    #[test]
    fn hash_blake3_construction() {
        let h = Hash::blake3([2; 32]);
        assert_eq!(h.as_bytes(), &[2; 32]);
        assert!(h.is_blake3());
        assert_eq!(h.algo_code(), 0x1F);
    }

    #[test]
    fn hash_sha256_construction() {
        let h = Hash::sha256([3; 32]);
        assert_eq!(h.as_bytes(), &[3; 32]);
        assert!(h.is_sha256());
        assert_eq!(h.algo_code(), 0x12);
    }

    #[test]
    fn hash_from_data() {
        let h1 = Hash::blake3_hash(b"test");
        let h2 = Hash::blake3_hash(b"test");
        assert_eq!(h1, h2);
        assert!(h1.is_blake3());
    }

    #[test]
    fn display_is_code_hex() {
        let pk = PartitionKey::from_digest(0x1F, vec![0xff; 32]);
        assert_eq!(pk.to_string(), format!("1f:{}", "f".repeat(64)));
    }

    #[test]
    fn algo_code_is_blake3_for_hash_from() {
        let pk = PartitionKey::hash_from("anything");
        assert_eq!(pk.algo_code(), 0x1F);
    }

    #[test]
    fn from_digest_constructs_any_algorithm() {
        let pk = PartitionKey::from_digest(0x12, vec![0xab; 32]);
        assert_eq!(pk.algo_code(), 0x12);
        assert_eq!(pk.digest(), &[0xab; 32]);
    }

    #[test]
    fn as_multihash_accessor() {
        let pk = PartitionKey::hash_from("x");
        let mh = pk.as_multihash();
        assert_eq!(mh.code, 0x1F);
        assert_eq!(mh.as_bytes().len(), 32);
    }

    #[test]
    fn utf8_text_exposes_textual_digest_bytes() {
        let address =
            FactAddress::from_digest(0x1F, b"entity|ws:genesis|component:app-shell".to_vec());
        assert_eq!(
            address.as_utf8_text(),
            Some("entity|ws:genesis|component:app-shell")
        );
    }

    #[test]
    fn utf8_text_rejects_non_utf8_digests() {
        let address = FactAddress::from_digest(0x1F, vec![0xff, 0xfe, 0xfd]);
        assert_eq!(address.as_utf8_text(), None);
    }

    #[test]
    fn from_multihash_roundtrip_32_bytes() {
        let mh = CryptoMultihash::from_digest(0x1F, vec![0xAA; 32]).unwrap();
        let pk = PartitionKey::from_multihash(mh.clone());
        assert_eq!(pk.as_multihash(), &mh);
        assert_eq!(pk.as_multihash().encode(), mh.encode());
        assert_eq!(pk.to_wire_hex(), hex::encode(mh.encode()));
    }

    #[test]
    fn from_multihash_accepts_64_byte_digest() {
        // SHA-512 = 64 bytes. Post-C0 Multihash has no length cap.
        let mh = CryptoMultihash::from_digest(0x13, vec![0xBB; 64]).unwrap();
        let fa = FactAddress::from_multihash(mh.clone());
        assert_eq!(fa.algo_code(), 0x13);
        assert_eq!(fa.digest().len(), 64);
        assert_eq!(fa.as_multihash(), &mh);
    }

    #[test]
    fn from_multihash_accepts_128_byte_digest_arbitrary_code() {
        // Hypothetical post-quantum algorithm — 128 bytes, arbitrary multicodec.
        let mh = CryptoMultihash::from_digest(0x42, vec![0xCC; 128]).unwrap();
        let pk = PartitionKey::from_multihash(mh.clone());
        assert_eq!(pk.algo_code(), 0x42);
        assert_eq!(pk.digest().len(), 128);
        assert_eq!(pk.as_multihash().encode(), mh.encode());
    }

    #[test]
    fn from_multihash_sha256_non_blake3() {
        // Adversarial: a non-Blake3 algorithm must work without any
        // special-casing in the newtype — proof that the macro never
        // assumed Blake3.
        let mh = CryptoMultihash::from_digest(0x12, vec![0xDD; 32]).unwrap();
        let pk = PartitionKey::from_multihash(mh);
        assert_eq!(pk.algo_code(), 0x12);
    }

    #[test]
    fn from_multihash_all_newtypes_type_safety() {
        // Same Multihash, five different newtypes — they must not be
        // interchangeable (compile-time enforcement).
        let mh = CryptoMultihash::from_digest(0x1F, vec![0xEE; 32]).unwrap();
        let pk = PartitionKey::from_multihash(mh.clone());
        let fa = FactAddress::from_multihash(mh.clone());
        let ps = PathSegment::from_multihash(mh.clone());
        let ch = CapabilityHash::from_multihash(mh.clone());
        let pi = PrincipalId::from_multihash(mh.clone());
        assert_eq!(pk.digest(), fa.digest());
        assert_eq!(fa.digest(), ps.digest());
        assert_eq!(ps.digest(), ch.digest());
        assert_eq!(ch.digest(), pi.digest());
        // Type system prevents: let _: PartitionKey = fa; // would not compile
    }

    #[test]
    fn hash_multihash_roundtrip() {
        let data = b"roundtrip test";
        let h1 = Hash::blake3_hash(data);

        // Convert to Multihash and back
        let mh = h1.as_multihash();
        assert_eq!(mh.code, 0x1F); // Blake3
        assert_eq!(mh.as_bytes().len(), 32);

        let h2 = Hash::from_multihash(mh.clone());
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_serialization_roundtrip_json() {
        let h1 = Hash::blake3([0x01; 32]);
        let json = serde_json::to_string(&h1).unwrap();
        // Should serialize as hex string
        assert!(json.starts_with('"'));
        assert!(json.ends_with('"'));

        let h2: Hash = serde_json::from_str(&json).unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_clone_semantics() {
        let h1 = Hash::blake3([0x42; 32]);
        let h2 = h1.clone();
        assert_eq!(h1, h2);
        assert_eq!(h1, h1); // Original still accessible
    }
}
