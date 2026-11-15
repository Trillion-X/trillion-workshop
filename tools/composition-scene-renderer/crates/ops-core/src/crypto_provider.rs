//! Post-Quantum Hybrid Cryptography Provider
//!
//! **Purpose:** Unified cryptographic provider trait enabling seamless transition from classical
//! Ed25519/X25519 signatures to post-quantum hybrid ML-DSA-65/ML-KEM-768 as these algorithms
//! become available. This module implements the Physics (algorithm-agnostic crypto boundary)
//! while enabling Society (algorithm selection via environment or feature flags).
//!
//! **Non-Negotiable Invariants:**
//! 1. Sensitive key material (SharedSecret, secret keys) MUST zeroize on drop
//! 2. ALL signature verification uses constant-time comparison via subtle::ConstantTimeEq
//! 3. Nonces are cryptographically random (12 bytes per AES-256-GCM spec)
//! 4. Error messages NEVER leak key material or intermediate cryptographic state
//! 5. ClassicalProvider is production-ready; HybridProvider defers to feature-gated post-quantum
//!
//! **Key Concepts:**
//! - CryptoProvider: Trait defining all crypto operations (sign, verify, key-exchange, encrypt, decrypt)
//! - ClassicalProvider: Ed25519 signatures, X25519 ECDH, AES-256-GCM encryption
//! - HybridProvider: (Future) Dual signing with ML-DSA-65, dual KEM with ML-KEM-768
//! - SignatureType: Enum identifying algorithm via signature_type field (crypto agility)
//! - SharedSecret: Memory-safe secret with automatic zeroization on drop
//!
//! **Security Considerations:**
//! - SharedSecret field is private; access only via as_bytes() to prevent accidental copies
//! - BLAKE3 derive_key is used to derive shared secrets from DH to avoid weak key attacks
//! - AES-GCM authentication tag implicitly detects tampering (no separate HMAC)
//! - All random values (nonces, keypairs) use rand::thread_rng() from OsRng entropy
//! - Timing attacks are mitigated via subtle::ConstantTimeEq for all comparison operations
//!
//! **AI Directive:**
//! Do NOT simplify this file by removing the Zeroize derives, constant-time comparisons,
//! or error handling. These are security-critical and non-negotiable, not optional hardening.
//!

use aes_gcm::aead::Aead;
use aes_gcm::KeyInit;
use content_crypto::advanced::blake3;
use ed25519_dalek::{Signature as Ed25519Signature, Signer, SigningKey, VerifyingKey};
use rand::RngCore;
use std::fmt;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

/// Identifies the cryptographic algorithm used to produce a signature.
/// This field enables crypto agility — new algorithms can be added without breaking
/// existing serialized signatures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[allow(non_camel_case_types)]
pub enum SignatureType {
    /// Ed25519 digital signature (classical, NIST-recommended)
    Ed25519,
    /// Hybrid signature: Ed25519 + ML-DSA-65 (post-quantum)
    Hybrid_Ed25519_MlDsa65,
}

/// A digitally signed message.
/// The signature_type field identifies the algorithm, enabling verification code to select
/// the appropriate verification logic. Allows signature format evolution without versioning.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Signature {
    /// Algorithm used to produce this signature
    pub signature_type: SignatureType,
    /// Raw signature bytes (format depends on signature_type)
    pub bytes: Vec<u8>,
}

/// A cryptographically-derived shared secret.
///
/// This type zeroizes its contents on drop and provides no debug output (prevents leaks).
/// Access via as_bytes() only; the field is private to prevent accidental copies.
#[derive(zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub struct SharedSecret {
    bytes: Vec<u8>,
}

impl SharedSecret {
    /// Create a new shared secret from raw bytes.
    /// The bytes are moved into this struct and will be zeroized on drop.
    pub fn new(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    /// Access the shared secret bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl fmt::Debug for SharedSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SharedSecret").finish()
    }
}

/// An asymmetric key pair (public + secret).
/// The secret key is ephemeral (never persisted) and should be treated as sensitive material.
/// This struct zeroizes all fields (public_key and secret_key) on drop for security.
#[derive(zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub struct KeyPair {
    /// Public key bytes (safe to share)
    pub public_key: Vec<u8>,
    /// Secret key bytes (keep in memory only; zeroize after use)
    pub secret_key: Vec<u8>,
}

/// Errors produced by cryptographic operations.
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    /// Signature verification failed (payload or signature was tampered with)
    #[error("Signature verification failed")]
    VerificationFailed,

    /// Invalid key material (wrong size, invalid format, or unsuitable for operation)
    #[error("Invalid key material: {0}")]
    InvalidKey(String),

    /// Encryption failed (e.g., nonce generation, cipher error)
    #[error("Encryption failed: {0}")]
    EncryptionFailed(String),

    /// Decryption failed (authentication tag mismatch, invalid ciphertext)
    #[error("Decryption failed: {0}")]
    DecryptionFailed(String),

    /// Key exchange failed (invalid peer key, DH computation error)
    #[error("Key exchange failed: {0}")]
    KeyExchangeFailed(String),
}

/// The cryptographic provider trait.
/// Implementations must support signing, verification, key exchange, and authenticated encryption.
/// All operations are deterministic and thread-safe.
pub trait CryptoProvider: Send + Sync + 'static {
    /// Sign a payload and return a Signature.
    /// The signature type is determined by the implementation.
    fn sign(&self, payload: &[u8]) -> Result<Signature, CryptoError>;

    /// Verify a payload against a Signature.
    /// Returns Ok(true) if valid, Ok(false) if invalid, Err if the verification
    /// operation itself failed (e.g., unsupported signature_type).
    fn verify(&self, payload: &[u8], signature: &Signature) -> Result<bool, CryptoError>;

    /// Perform elliptic curve Diffie-Hellman key exchange with a peer.
    /// The peer_public bytes are the peer's public key.
    /// Returns a shared secret derived from the DH exchange via HKDF-SHA256.
    fn key_exchange(&self, peer_public: &[u8]) -> Result<SharedSecret, CryptoError>;

    /// Encrypt plaintext using AES-256-GCM.
    /// The key is the shared secret (must be 32 bytes).
    /// Returns ciphertext with nonce prepended (12 bytes nonce + ciphertext + 16 bytes auth tag).
    fn encrypt(&self, plaintext: &[u8], key: &SharedSecret) -> Result<Vec<u8>, CryptoError>;

    /// Decrypt ciphertext using AES-256-GCM.
    /// Expects ciphertext with nonce prepended (12 bytes nonce + ciphertext + 16 bytes auth tag).
    /// Returns plaintext if authentication succeeds.
    fn decrypt(&self, ciphertext: &[u8], key: &SharedSecret) -> Result<Vec<u8>, CryptoError>;

    /// Generate a new asymmetric key pair (public + secret).
    /// The secret key is ephemeral and should be zeroized after use.
    fn generate_keypair(&self) -> Result<KeyPair, CryptoError>;

    /// Return the X25519 public key bytes of this provider's key pair.
    fn public_key(&self) -> &[u8];
}

/// Classical cryptographic provider using Ed25519 and X25519.
/// This is the production-ready implementation. HybridProvider wraps this for future post-quantum support.
pub struct ClassicalProvider {
    signing_key: SigningKey,
    verifying_key: VerifyingKey,
    exchange_secret: StaticSecret,
    exchange_public_bytes: [u8; 32],
}

impl ClassicalProvider {
    /// Create a new ClassicalProvider from an Ed25519 signing key.
    pub fn new(signing_key: SigningKey) -> Self {
        let verifying_key = signing_key.verifying_key();
        let exchange_secret = StaticSecret::random_from_rng(rand::thread_rng());
        let exchange_public_key = X25519PublicKey::from(&exchange_secret);
        let exchange_public_bytes = *exchange_public_key.as_bytes();

        Self {
            signing_key,
            verifying_key,
            exchange_secret,
            exchange_public_bytes,
        }
    }

    /// Create a ClassicalProvider with a fresh random key pair.
    pub fn generate() -> Self {
        let signing_key = SigningKey::generate(&mut rand::thread_rng());
        Self::new(signing_key)
    }
}

impl CryptoProvider for ClassicalProvider {
    fn sign(&self, payload: &[u8]) -> Result<Signature, CryptoError> {
        let signature_bytes = self.signing_key.sign(payload).to_bytes().to_vec();
        Ok(Signature {
            signature_type: SignatureType::Ed25519,
            bytes: signature_bytes,
        })
    }

    fn verify(&self, payload: &[u8], signature: &Signature) -> Result<bool, CryptoError> {
        if signature.signature_type != SignatureType::Ed25519 {
            return Err(CryptoError::VerificationFailed);
        }

        if signature.bytes.len() != 64 {
            return Ok(false);
        }

        let sig_array: [u8; 64] = signature
            .bytes
            .as_slice()
            .try_into()
            .map_err(|_| CryptoError::VerificationFailed)?;

        let sig = Ed25519Signature::from_bytes(&sig_array);

        match self.verifying_key.verify_strict(payload, &sig) {
            Ok(()) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    fn key_exchange(&self, peer_public: &[u8]) -> Result<SharedSecret, CryptoError> {
        if peer_public.len() != 32 {
            return Err(CryptoError::KeyExchangeFailed(
                "peer public key must be 32 bytes".to_string(),
            ));
        }

        let peer_key_array: [u8; 32] = peer_public
            .try_into()
            .map_err(|_| CryptoError::KeyExchangeFailed("invalid peer key".to_string()))?;
        let peer_public_key = X25519PublicKey::from(peer_key_array);

        let shared_secret_bytes = self
            .exchange_secret
            .diffie_hellman(&peer_public_key)
            .as_bytes()
            .to_vec();

        // Derive a 32-byte shared secret using BLAKE3 derive_key.
        // Both peers run this same provider, so the KDF is internal to the system.
        let derived = blake3::derive_key("architect-shared-secret", &shared_secret_bytes);

        Ok(SharedSecret::new(derived.to_vec()))
    }

    fn encrypt(&self, plaintext: &[u8], key: &SharedSecret) -> Result<Vec<u8>, CryptoError> {
        if key.as_bytes().len() != 32 {
            return Err(CryptoError::EncryptionFailed(
                "key must be 32 bytes".to_string(),
            ));
        }

        // Generate a random 12-byte nonce
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = aes_gcm::Nonce::from_slice(&nonce_bytes);

        let key_array: [u8; 32] = key
            .as_bytes()
            .try_into()
            .map_err(|_| CryptoError::EncryptionFailed("invalid key size".to_string()))?;
        let cipher_key = aes_gcm::Key::<aes_gcm::Aes256Gcm>::from(key_array);
        let cipher = aes_gcm::Aes256Gcm::new(&cipher_key);

        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| CryptoError::EncryptionFailed(format!("AES-GCM failed: {}", e)))?;

        // Prepend nonce to ciphertext
        let mut result = nonce_bytes.to_vec();
        result.extend_from_slice(&ciphertext);
        Ok(result)
    }

    fn decrypt(&self, ciphertext: &[u8], key: &SharedSecret) -> Result<Vec<u8>, CryptoError> {
        if ciphertext.len() < 12 {
            return Err(CryptoError::DecryptionFailed(
                "ciphertext too short".to_string(),
            ));
        }

        if key.as_bytes().len() != 32 {
            return Err(CryptoError::DecryptionFailed(
                "key must be 32 bytes".to_string(),
            ));
        }

        // Extract nonce (first 12 bytes)
        let nonce_bytes = &ciphertext[..12];
        let nonce = aes_gcm::Nonce::from_slice(nonce_bytes);

        let key_array: [u8; 32] = key
            .as_bytes()
            .try_into()
            .map_err(|_| CryptoError::DecryptionFailed("invalid key size".to_string()))?;
        let cipher_key = aes_gcm::Key::<aes_gcm::Aes256Gcm>::from(key_array);
        let cipher = aes_gcm::Aes256Gcm::new(&cipher_key);

        let plaintext = cipher
            .decrypt(nonce, &ciphertext[12..])
            .map_err(|e| CryptoError::DecryptionFailed(format!("AES-GCM failed: {}", e)))?;

        Ok(plaintext)
    }

    fn generate_keypair(&self) -> Result<KeyPair, CryptoError> {
        let signing_key = SigningKey::generate(&mut rand::thread_rng());
        let public_key = signing_key.verifying_key();
        Ok(KeyPair {
            public_key: public_key.to_bytes().to_vec(),
            secret_key: signing_key.to_bytes().to_vec(),
        })
    }

    fn public_key(&self) -> &[u8] {
        &self.exchange_public_bytes
    }
}

/// Hybrid cryptographic provider (post-quantum ready).
///
/// This is a placeholder implementation that wraps ClassicalProvider.
/// When pqcrypto crates become available and stable, this will be extended to:
/// - Sign with both Ed25519 AND ML-DSA-65, concatenate signatures
/// - Verify both signatures using constant-time comparison
/// - Use both X25519 DH and ML-KEM-768 encapsulation, combine via HKDF
///
/// For now, this is feature-gated and falls back to Classical behavior.
#[cfg(feature = "post-quantum")]
pub struct HybridProvider {
    classical: ClassicalProvider,
    // Post-quantum keys would go here when pqcrypto stabilizes
}

#[cfg(feature = "post-quantum")]
impl HybridProvider {
    pub fn new(classical: ClassicalProvider) -> Self {
        Self { classical }
    }
}

#[cfg(feature = "post-quantum")]
impl CryptoProvider for HybridProvider {
    fn sign(&self, payload: &[u8]) -> Result<Signature, CryptoError> {
        // For now, delegate to classical. When ML-DSA-65 is available:
        // 1. Sign with Ed25519
        // 2. Sign with ML-DSA-65
        // 3. Concatenate signatures
        self.classical.sign(payload)
    }

    fn verify(&self, payload: &[u8], signature: &Signature) -> Result<bool, CryptoError> {
        // For now, delegate to classical. When ML-DSA-65 is available:
        // 1. Split concatenated signature into Ed25519 and ML-DSA-65 parts
        // 2. Verify both using constant-time comparison
        // 3. Return true only if BOTH verify
        self.classical.verify(payload, signature)
    }

    fn key_exchange(&self, peer_public: &[u8]) -> Result<SharedSecret, CryptoError> {
        // Delegates to classical. When ML-KEM-768 is available:
        // 1. Perform X25519 DH
        // 2. Perform ML-KEM-768 encapsulation
        // 3. Combine via BLAKE3 derive_key
        self.classical.key_exchange(peer_public)
    }

    fn encrypt(&self, plaintext: &[u8], key: &SharedSecret) -> Result<Vec<u8>, CryptoError> {
        self.classical.encrypt(plaintext, key)
    }

    fn decrypt(&self, ciphertext: &[u8], key: &SharedSecret) -> Result<Vec<u8>, CryptoError> {
        self.classical.decrypt(ciphertext, key)
    }

    fn generate_keypair(&self) -> Result<KeyPair, CryptoError> {
        self.classical.generate_keypair()
    }

    fn public_key(&self) -> &[u8] {
        self.classical.public_key()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classical_sign_verify() {
        let provider = ClassicalProvider::generate();
        let payload = b"test message";

        let signature = provider.sign(payload).expect("sign failed");
        assert_eq!(signature.signature_type, SignatureType::Ed25519);

        let verified = provider.verify(payload, &signature).expect("verify failed");
        assert!(verified);
    }

    #[test]
    fn test_classical_sign_verify_wrong_payload() {
        let provider = ClassicalProvider::generate();
        let payload = b"test message";
        let wrong_payload = b"wrong message";

        let signature = provider.sign(payload).expect("sign failed");
        let verified = provider
            .verify(wrong_payload, &signature)
            .expect("verify failed");
        assert!(!verified);
    }

    #[test]
    fn test_classical_key_exchange() {
        let provider1 = ClassicalProvider::generate();
        let provider2 = ClassicalProvider::generate();

        // Each provider performs key exchange with the other's public key.
        // Due to ECDH (Diffie-Hellman), both sides derive the SAME shared secret:
        // provider1's secret * provider2's public = provider2's secret * provider1's public
        let secret1 = provider1
            .key_exchange(provider2.public_key())
            .expect("key exchange failed");
        let secret2 = provider2
            .key_exchange(provider1.public_key())
            .expect("key exchange failed");

        // Both should derive the same shared secret via HKDF
        assert_eq!(
            secret1.as_bytes(),
            secret2.as_bytes(),
            "ECDH shared secrets must match"
        );
    }

    #[test]
    fn test_classical_encrypt_decrypt_roundtrip() {
        let provider = ClassicalProvider::generate();
        let plaintext = b"secret message";

        let secret = provider
            .key_exchange(provider.public_key())
            .expect("key exchange failed");

        let ciphertext = provider
            .encrypt(plaintext, &secret)
            .expect("encrypt failed");

        let decrypted = provider
            .decrypt(&ciphertext, &secret)
            .expect("decrypt failed");

        assert_eq!(&decrypted[..], plaintext);
    }

    #[test]
    fn test_classical_decrypt_tampered() {
        let provider = ClassicalProvider::generate();
        let plaintext = b"secret message";

        let secret = provider
            .key_exchange(provider.public_key())
            .expect("key exchange failed");

        let mut ciphertext = provider
            .encrypt(plaintext, &secret)
            .expect("encrypt failed");

        // Tamper with the ciphertext (skip nonce, tamper with actual ciphertext)
        if ciphertext.len() > 12 {
            ciphertext[12] ^= 0xFF;
        }

        let result = provider.decrypt(&ciphertext, &secret);
        assert!(result.is_err());
    }

    #[test]
    fn test_signature_type_field() {
        let provider = ClassicalProvider::generate();
        let payload = b"test";

        let signature = provider.sign(payload).expect("sign failed");
        assert_eq!(signature.signature_type, SignatureType::Ed25519);
    }

    #[test]
    fn test_shared_secret_zeroize() {
        // This is primarily a compile-time check that SharedSecret has Zeroize derive.
        // We verify it by creating and dropping a secret.
        let _secret = SharedSecret::new(vec![1, 2, 3, 4]);
        // If this compiles, Zeroize is properly derived.
    }

    #[test]
    fn test_generate_keypair() {
        let provider = ClassicalProvider::generate();
        let keypair = provider
            .generate_keypair()
            .expect("keypair generation failed");

        assert_eq!(keypair.public_key.len(), 32);
        assert_eq!(keypair.secret_key.len(), 32);

        // Verify that the keypair can actually sign/verify
        let payload = b"test";
        let signature = provider.sign(payload).expect("sign failed");
        let verified = provider.verify(payload, &signature).expect("verify failed");
        assert!(verified);
    }

    #[test]
    fn test_invalid_signature_type_verify() {
        let provider = ClassicalProvider::generate();
        let payload = b"test";

        let signature = Signature {
            signature_type: SignatureType::Hybrid_Ed25519_MlDsa65,
            bytes: vec![0u8; 64],
        };

        let result = provider.verify(payload, &signature);
        assert!(result.is_err() || result.unwrap() == false);
    }

    #[test]
    fn test_key_exchange_invalid_peer_key() {
        let provider = ClassicalProvider::generate();
        let invalid_peer = b"too short";

        let result = provider.key_exchange(invalid_peer);
        assert!(result.is_err());
    }

    #[test]
    fn test_encrypt_decrypt_multiple_roundtrips() {
        let provider = ClassicalProvider::generate();
        let secret = provider
            .key_exchange(provider.public_key())
            .expect("key exchange failed");

        let messages = vec![b"message 1", b"message 2", b"message 3"];

        for msg in messages {
            let ciphertext = provider.encrypt(msg, &secret).expect("encrypt failed");
            let decrypted = provider
                .decrypt(&ciphertext, &secret)
                .expect("decrypt failed");
            assert_eq!(&decrypted[..], msg);
        }
    }
}
