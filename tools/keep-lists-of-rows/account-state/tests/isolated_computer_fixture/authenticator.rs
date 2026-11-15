//! Synthetic WebAuthn registration, adapted from tests/computer_forwarder.rs:412-471.
//! This is only the fixture smoke test's simulated authenticator; the Apps adapter still uses a browser ceremony.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{
    digest,
    rand::SystemRandom,
    signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING},
};
use serde_json::{json, Value};

pub fn registration(origin: &str, challenge: &str) -> Value {
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
    let key =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng).unwrap();
    let mut spki = vec![
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
        0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ];
    spki.extend_from_slice(key.public_key().as_ref());
    let id = [7u8; 16];
    let client =
        json!({"type":"webauthn.create","challenge":challenge,"origin":origin,"crossOrigin":false});
    // SHA-256 is WebAuthn's required rpIdHash, not an internal content identity.
    let mut data = digest::digest(&digest::SHA256, b"localhost")
        .as_ref()
        .to_vec();
    data.push(0x45);
    data.extend_from_slice(&0u32.to_be_bytes());
    data.extend_from_slice(&[0u8; 16]);
    data.extend_from_slice(&(id.len() as u16).to_be_bytes());
    data.extend_from_slice(&id);
    data.extend_from_slice(&[0xa5, 0x01, 0x02]);
    json!({"name":"Isolated synthetic passkey","id":URL_SAFE_NO_PAD.encode(id),"rawId":URL_SAFE_NO_PAD.encode(id),"type":"public-key",
        "response":{"clientDataJSON":URL_SAFE_NO_PAD.encode(client.to_string()),"authenticatorData":URL_SAFE_NO_PAD.encode(data),
        "publicKey":URL_SAFE_NO_PAD.encode(spki),"publicKeyAlgorithm":-7}})
}
