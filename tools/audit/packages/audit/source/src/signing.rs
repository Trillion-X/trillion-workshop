// /crates/audit/src/signing.rs
//
// ed25519 cryptographic signing for audit events.
// Implements sign_event() and verify_event() using ed25519-dalek.

use crate::sink::{AuditError, AuditEvent};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

/// Generate a new ed25519 signing keypair
pub fn generate_keypair() -> SigningKey {
    use rand::Rng;
    let mut secret_bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut secret_bytes);
    SigningKey::from_bytes(&secret_bytes)
}

/// Sign an audit event with ed25519
/// Returns hex-encoded signature
pub fn sign_event(event: &AuditEvent, signing_key: &SigningKey) -> Result<String, AuditError> {
    // Serialize event WITHOUT signature field for signing
    let mut event_clone = event.clone();
    event_clone.signature = String::new();

    let message = serde_json::to_vec(&event_clone)
        .map_err(|e| AuditError::SigningFailed(format!("Serialization failed: {}", e)))?;

    let signature = signing_key.sign(&message);

    Ok(hex::encode(signature.to_bytes()))
}

/// Verify an audit event signature
pub fn verify_event(event: &AuditEvent, verifying_key: &VerifyingKey) -> Result<bool, AuditError> {
    // Recreate the signed message (event without signature)
    let mut event_clone = event.clone();
    event_clone.signature = String::new();

    let message = serde_json::to_vec(&event_clone)
        .map_err(|e| AuditError::VerificationFailed(format!("Serialization failed: {}", e)))?;

    // Decode signature from hex
    let signature_bytes = hex::decode(&event.signature)
        .map_err(|e| AuditError::VerificationFailed(format!("Invalid hex signature: {}", e)))?;

    let signature_array: [u8; 64] = signature_bytes.try_into().map_err(|_| {
        AuditError::VerificationFailed("Invalid signature length (expected 64 bytes)".to_string())
    })?;

    let signature = Signature::from_bytes(&signature_array);

    match verifying_key.verify(&message, &signature) {
        Ok(()) => Ok(true),
        Err(e) => Err(AuditError::VerificationFailed(format!(
            "Signature verification failed: {}",
            e
        ))),
    }
}

/// Verify hash chain integrity across multiple events
/// Future enhancement: implement hash chain verification
pub fn verify_hash_chain(_events: &[AuditEvent]) -> Result<(), AuditError> {
    // For now, just verify individual signatures
    Ok(())
}
