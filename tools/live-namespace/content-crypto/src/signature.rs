use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

#[derive(Debug, thiserror::Error)]
pub enum SignatureError {
    #[error("invalid private key hex")]
    InvalidPrivateKeyHex,

    #[error("private key must be 32 bytes")]
    InvalidPrivateKeyLength,

    #[error("invalid public key hex")]
    InvalidPublicKeyHex,

    #[error("public key must be 32 bytes")]
    InvalidPublicKeyLength,

    #[error("invalid public key bytes")]
    InvalidPublicKeyBytes,

    #[error("invalid signature hex")]
    InvalidSignatureHex,

    #[error("signature must be 64 bytes")]
    InvalidSignatureLength,

    #[error("signature verification failed")]
    VerificationFailed,
}

/// Ed25519 signing and verification over caller-provided canonical bytes.
///
/// This leaf type contains no platform or product vocabulary. Callers own the
/// bytes being signed; this module only validates key/signature mechanics.
pub struct Ed25519Signature;

impl Ed25519Signature {
    pub fn sign(message: &[u8], private_key_hex: &str) -> Result<String, SignatureError> {
        let key = signing_key(private_key_hex)?;
        Ok(hex::encode(key.sign(message).to_bytes()))
    }

    pub fn verify(
        message: &[u8],
        signature_hex: &str,
        public_key_hex: &str,
    ) -> Result<(), SignatureError> {
        let signature_bytes =
            hex::decode(signature_hex).map_err(|_| SignatureError::InvalidSignatureHex)?;
        if signature_bytes.len() != 64 {
            return Err(SignatureError::InvalidSignatureLength);
        }
        let mut signature_array = [0u8; 64];
        signature_array.copy_from_slice(&signature_bytes);
        let signature = Signature::from_bytes(&signature_array);

        let public_key_bytes =
            hex::decode(public_key_hex).map_err(|_| SignatureError::InvalidPublicKeyHex)?;
        if public_key_bytes.len() != 32 {
            return Err(SignatureError::InvalidPublicKeyLength);
        }
        let mut public_key_array = [0u8; 32];
        public_key_array.copy_from_slice(&public_key_bytes);
        let verifying_key = VerifyingKey::from_bytes(&public_key_array)
            .map_err(|_| SignatureError::InvalidPublicKeyBytes)?;

        verifying_key
            .verify_strict(message, &signature)
            .map_err(|_| SignatureError::VerificationFailed)
    }

    pub fn public_key_from_private(private_key_hex: &str) -> Result<String, SignatureError> {
        Ok(hex::encode(
            signing_key(private_key_hex)?.verifying_key().to_bytes(),
        ))
    }
}

fn signing_key(private_key_hex: &str) -> Result<SigningKey, SignatureError> {
    let key_bytes =
        hex::decode(private_key_hex).map_err(|_| SignatureError::InvalidPrivateKeyHex)?;
    if key_bytes.len() != 32 {
        return Err(SignatureError::InvalidPrivateKeyLength);
    }
    let mut key_array = [0u8; 32];
    key_array.copy_from_slice(&key_bytes);
    Ok(SigningKey::from_bytes(&key_array))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn private_key() -> String {
        hex::encode([7u8; 32])
    }

    #[test]
    fn ed25519_signature_round_trips() {
        let message = b"canonical bytes";
        let private_key = private_key();
        let public_key = Ed25519Signature::public_key_from_private(&private_key).unwrap();
        let signature = Ed25519Signature::sign(message, &private_key).unwrap();

        Ed25519Signature::verify(message, &signature, &public_key).unwrap();
    }

    #[test]
    fn ed25519_signature_rejects_mutated_message() {
        let private_key = private_key();
        let public_key = Ed25519Signature::public_key_from_private(&private_key).unwrap();
        let signature = Ed25519Signature::sign(b"first", &private_key).unwrap();

        assert!(matches!(
            Ed25519Signature::verify(b"second", &signature, &public_key),
            Err(SignatureError::VerificationFailed)
        ));
    }
}
