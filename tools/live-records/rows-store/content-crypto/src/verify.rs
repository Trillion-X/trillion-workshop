// source-code-to-sign/content-crypto/src/verify.rs
//
//! Hash verification dispatch registry — generic verifier trait + algorithm lifecycle.
//!
//! GENERATIVE PRIMITIVE: DigestVerificationRegistry dispatches verification to registered
//! algorithm handlers without caring what they are. Adding post-quantum in 2040 = zero changes
//! to dispatcher, format, or parser — just register the new verifier.

use crate::Multihash;
use std::collections::HashMap;
use std::sync::Arc;

/// Error type for hash verification operations.
#[derive(Debug, thiserror::Error)]
pub enum HashError {
    #[error("unknown algorithm code: 0x{0:x}")]
    UnknownAlgorithm(u64),

    #[error("digest length mismatch: expected {expected}, got {got}")]
    DigestLengthMismatch { expected: usize, got: usize },

    #[error("empty digest")]
    EmptyDigest,

    #[error("invalid varint encoding")]
    InvalidVarint,

    #[error("verification failed for algorithm 0x{algorithm:x}")]
    VerificationFailed { algorithm: u64 },

    #[error("algorithm 0x{0:x} is retired")]
    AlgorithmRetired(u64),
}

/// Algorithm lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlgorithmStatus {
    Active,
    Deprecated,
    Retired,
}

/// Generic verifier trait — implement for each hash algorithm.
///
/// Parameter order: `data` FIRST, `digest` SECOND.
/// Returns `Result<(), HashError>` — success is `()`, not a boolean.
pub trait Verifier: Send + Sync {
    fn verify(&self, data: &[u8], digest: &[u8]) -> Result<(), HashError>;
}

/// Blake3 verifier — IETF multicodec code 0x1F.
pub struct Blake3Verifier;

impl Verifier for Blake3Verifier {
    fn verify(&self, data: &[u8], digest: &[u8]) -> Result<(), HashError> {
        let computed = blake3::hash(data);
        if computed.as_bytes() == digest {
            Ok(())
        } else {
            Err(HashError::VerificationFailed { algorithm: 0x1F })
        }
    }
}

/// SHA-256 verifier — IETF multicodec code 0x12.
pub struct Sha256Verifier;

impl Verifier for Sha256Verifier {
    fn verify(&self, data: &[u8], digest: &[u8]) -> Result<(), HashError> {
        use sha2::{Digest, Sha256};
        let computed = Sha256::digest(data);
        if computed.as_slice() == digest {
            Ok(())
        } else {
            Err(HashError::VerificationFailed { algorithm: 0x12 })
        }
    }
}

/// Generic hash verification registry — dispatches to algorithm-specific verifiers.
///
/// Uses `HashMap<u64, Arc<dyn Verifier>>` for O(1) dispatch.
/// Adding new algorithms requires zero changes to the dispatcher.
pub struct DigestVerificationRegistry {
    verifiers: HashMap<u64, Arc<dyn Verifier>>,
    status: HashMap<u64, AlgorithmStatus>,
}

impl DigestVerificationRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self {
            verifiers: HashMap::new(),
            status: HashMap::new(),
        }
    }

    /// Register a verifier for a specific algorithm code.
    pub fn register(&mut self, code: u64, verifier: Arc<dyn Verifier>) {
        self.verifiers.insert(code, verifier);
        // Default to Active — can be updated via set_status
        self.status.insert(code, AlgorithmStatus::Active);
    }

    /// Set the status of an algorithm (Active, Deprecated, Retired).
    pub fn set_status(&mut self, code: u64, status: AlgorithmStatus) {
        self.status.insert(code, status);
    }

    /// Query the lifecycle status of an algorithm code.
    ///
    /// Returns `None` if the algorithm is not registered.
    /// Use this when you have a hash but NOT the original data bytes
    /// (e.g., after streaming ingestion where data was consumed during write).
    pub fn algorithm_status(&self, code: u64) -> Option<AlgorithmStatus> {
        self.status.get(&code).copied()
    }

    /// Create a registry pre-loaded with Blake3 (0x1F) and SHA-256 (0x12) verifiers.
    /// Per plan §14.6 boot sequence — the standard platform configuration.
    pub fn with_defaults() -> Self {
        let mut registry = Self::new();
        registry.register(0x1F, Arc::new(Blake3Verifier));
        registry.register(0x12, Arc::new(Sha256Verifier));
        registry
    }

    /// Verify a Multihash against its data — dispatches to registered verifier.
    pub fn verify(&self, data: &[u8], hash: &Multihash) -> Result<(), HashError> {
        // Check if algorithm is retired before doing anything else
        if let Some(AlgorithmStatus::Retired) = self.status.get(&hash.code) {
            return Err(HashError::AlgorithmRetired(hash.code));
        }

        let verifier = self
            .verifiers
            .get(&hash.code)
            .ok_or(HashError::UnknownAlgorithm(hash.code))?;

        verifier.verify(data, hash.as_bytes())
    }
}

impl Default for DigestVerificationRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_verify_blake3() {
        let mut registry = DigestVerificationRegistry::new();
        registry.register(0x1F, Arc::new(Blake3Verifier));

        let data = b"hello world";
        let hash = Multihash::blake3(data);

        assert!(registry.verify(data, &hash).is_ok());
    }

    #[test]
    fn registry_verify_sha256() {
        let mut registry = DigestVerificationRegistry::new();
        registry.register(0x12, Arc::new(Sha256Verifier));

        let data = b"hello world";
        let hash = Multihash::sha256(data);

        assert!(registry.verify(data, &hash).is_ok());
    }

    #[test]
    fn registry_unknown_algorithm() {
        let registry = DigestVerificationRegistry::new();

        let data = b"test";
        let hash = Multihash::from_digest(0xFF, vec![0; 32]).expect("32 bytes fits");

        let result = registry.verify(data, &hash);
        assert!(result.is_err());
        match result {
            Err(HashError::UnknownAlgorithm(code)) => {
                assert_eq!(code, 0xFF);
            }
            _ => panic!("expected UnknownAlgorithm error"),
        }
    }

    #[test]
    fn registry_100_algorithms() {
        let mut registry = DigestVerificationRegistry::new();

        // Register 100 dummy verifiers
        for i in 0..100u64 {
            let code = i + 1000;
            registry.register(code, Arc::new(Blake3Verifier));
        }

        let data = b"test";

        // Verify that each algorithm code is found
        for i in 0..100u64 {
            let code = i + 1000;
            let hash = Multihash::from_digest(code, blake3::hash(data).as_bytes().to_vec())
                .expect("32 bytes fits");
            assert!(registry.verify(data, &hash).is_ok());
        }

        // Verify that unregistered codes are rejected
        let hash = Multihash::from_digest(999, blake3::hash(data).as_bytes().to_vec())
            .expect("32 bytes fits");
        match registry.verify(data, &hash) {
            Err(HashError::UnknownAlgorithm(999)) => {}
            _ => panic!("expected UnknownAlgorithm error for code 999"),
        }
    }

    #[test]
    fn empty_digest_rejected() {
        // Empty digest is now rejected at construction time (from_digest returns Err(EmptyDigest))
        // rather than at verification time — the invariant is preserved, rejection happens earlier.
        let result = Multihash::from_digest(0x1F, vec![]);
        assert!(result.is_err());
    }

    #[test]
    fn length_mismatch_rejected() {
        let mut registry = DigestVerificationRegistry::new();
        registry.register(0x1F, Arc::new(Blake3Verifier));

        let data = b"test";
        let hash = Multihash::from_digest(0x1F, vec![0u8; 16]).expect("16 bytes fits"); // Wrong length (Blake3 expects 32)

        let result = registry.verify(data, &hash);
        assert!(result.is_err());
        match result {
            Err(HashError::VerificationFailed { algorithm }) => {
                assert_eq!(algorithm, 0x1F);
            }
            _ => panic!("expected VerificationFailed error"),
        }
    }

    #[test]
    fn algorithm_status_retired() {
        let mut registry = DigestVerificationRegistry::new();
        registry.register(0x1F, Arc::new(Blake3Verifier));

        let data = b"test";
        let hash = Multihash::blake3(data);

        // Verify works when Active
        assert!(registry.verify(data, &hash).is_ok());

        // Set to Retired
        registry.set_status(0x1F, AlgorithmStatus::Retired);

        // Now verification should fail with AlgorithmRetired
        let result = registry.verify(data, &hash);
        assert!(result.is_err());
        match result {
            Err(HashError::AlgorithmRetired(code)) => {
                assert_eq!(code, 0x1F);
            }
            _ => panic!("expected AlgorithmRetired error"),
        }
    }

    #[test]
    fn algorithm_status_deprecated() {
        let mut registry = DigestVerificationRegistry::new();
        registry.register(0x1F, Arc::new(Blake3Verifier));
        registry.set_status(0x1F, AlgorithmStatus::Deprecated);

        let data = b"test";
        let hash = Multihash::blake3(data);

        // Deprecated algorithms still verify — status is informational
        assert!(registry.verify(data, &hash).is_ok());
    }

    #[test]
    fn verify_blake3_wrong_data() {
        let mut registry = DigestVerificationRegistry::new();
        registry.register(0x1F, Arc::new(Blake3Verifier));

        let data = b"hello world";
        let hash = Multihash::blake3(data);

        // Verify with different data should fail
        let result = registry.verify(b"different data", &hash);
        assert!(result.is_err());
        match result {
            Err(HashError::VerificationFailed { algorithm }) => {
                assert_eq!(algorithm, 0x1F);
            }
            _ => panic!("expected VerificationFailed error"),
        }
    }

    #[test]
    fn verify_sha256_wrong_data() {
        let mut registry = DigestVerificationRegistry::new();
        registry.register(0x12, Arc::new(Sha256Verifier));

        let data = b"hello world";
        let hash = Multihash::sha256(data);

        // Verify with different data should fail
        let result = registry.verify(b"different data", &hash);
        assert!(result.is_err());
        match result {
            Err(HashError::VerificationFailed { algorithm }) => {
                assert_eq!(algorithm, 0x12);
            }
            _ => panic!("expected VerificationFailed error"),
        }
    }
}
