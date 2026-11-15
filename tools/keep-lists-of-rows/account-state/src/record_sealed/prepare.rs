//! Prepare the existing version-one erasable field envelope, without storage.
//!
//! The original `erasable.mjs::seal` deliberately derives the 24-byte nonce
//! from keyed BLAKE3(AD || zero || JSON bytes). Identical value/key/AD produces
//! identical ciphertext, preserving original unchanged-write behavior. Keys
//! are supplied by the actual owner; this primitive never creates or persists
//! them, chooses erasure rights, opens a resource, or asserts a transaction.
use super::{Error, SecretFieldKey, SEALED_MARK};
use content_crypto::advanced::blake3;
use crate::ecma_json::{self, JsString, Object, Value};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{AeadInPlace, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use zeroize::Zeroizing;

/// Seal one already prepared JSON-origin value using its actual current key.
///
/// `key_owner` is the original `keyId` metadata: omit `k` for the record's own
/// key, emit it for another owner's key. The associated data still names `id`,
/// never `key_owner`. This function does not prove that the caller may use a
/// supplied key or persist the resulting value. The caller owns model checks,
/// key custody/persistence, erasure, the original transaction and disclosure.
///
/// JSON limits apply to plaintext and its same-limit reopening. AD and owner
/// identities also have the existing absolute JSON byte/unit ceiling, checked
/// before allocating their encoded copies. No ordinary serde bridge is used.
pub fn seal(
    key: &SecretFieldKey,
    id: &str,
    field: &JsString,
    value: &Value,
    key_owner: Option<&str>,
    json_limits: ecma_json::Limits,
) -> Result<Object, Error> {
    json_limits.validate().map_err(|error| Error::InvalidLimits(error.cause()))?;
    let owner = key_owner.unwrap_or(id);
    if id.len() > ecma_json::HARD_BYTES
        || owner.len() > ecma_json::HARD_BYTES
        || field.len() > ecma_json::HARD_BYTES
    {
        return Err(crate::cause!(Error::Bounds));
    }
    // TextEncoder's replacement of unpaired UTF-16 units is part of the old
    // wire AD. Count before constructing the lossy UTF-8 field name.
    let field_bytes = char::decode_utf16(field.units().iter().copied())
        .try_fold(0usize, |length, next| {
            length.checked_add(next.unwrap_or(char::REPLACEMENT_CHARACTER).len_utf8())
        })
        .ok_or(crate::cause!(Error::Bounds))?;
    let associated_len = id
        .len()
        .checked_add(1)
        .and_then(|length| length.checked_add(field_bytes))
        .filter(|length| *length <= ecma_json::HARD_BYTES)
        .ok_or(crate::cause!(Error::Bounds))?;
    let field = Zeroizing::new(String::from_utf16_lossy(field.units()));
    let mut associated = Zeroizing::new(Vec::with_capacity(associated_len));
    associated.extend_from_slice(id.as_bytes());
    associated.push(0);
    associated.extend_from_slice(field.as_bytes());

    let plain = Zeroizing::new(ecma_json::stringify(value, json_limits).map_err(
        |error| match error {
            ecma_json::Error::InvalidLimits(cause) => Error::InvalidLimits(cause),
            _ => Error::Bounds(error.cause()),
        },
    )?);
    if plain.len() > json_limits.input_bytes {
        return Err(crate::cause!(Error::Bounds));
    }
    // Streaming these three fragments is the exact original concatenation;
    // no second plaintext-bearing material allocation is needed.
    let mut hasher = Zeroizing::new(blake3::Hasher::new_keyed(&*key.0));
    hasher.update(associated.as_slice());
    hasher.update(&[0]);
    hasher.update(plain.as_bytes());
    let mut nonce = Zeroizing::new([0u8; 24]);
    let mut digest = Zeroizing::new(hasher.finalize_xof());
    digest.fill(&mut *nonce);

    let cipher =
        XChaCha20Poly1305::new_from_slice(key.0.as_ref()).map_err(|error| crate::carry_cause!(Error::InvalidLimits, error))?;
    // Reserve tag space before copying plaintext: encrypt_in_place must not
    // reallocate a plaintext-bearing buffer while appending the 16-byte tag.
    let cipher_len = plain.len().checked_add(16).ok_or(crate::cause!(Error::Bounds))?;
    let mut ciphertext = Zeroizing::new(Vec::with_capacity(cipher_len));
    ciphertext.extend_from_slice(plain.as_bytes());
    cipher
        .encrypt_in_place(
            XNonce::from_slice(nonce.as_ref()),
            associated.as_slice(),
            &mut *ciphertext,
        )
        .map_err(|error| crate::carry_cause!(Error::Bounds, error))?;
    let wire_len = cipher_len.checked_add(25).ok_or(crate::cause!(Error::Bounds))?;
    let mut wire = Zeroizing::new(Vec::with_capacity(wire_len));
    wire.push(1);
    wire.extend_from_slice(nonce.as_ref());
    wire.extend_from_slice(ciphertext.as_slice());

    let mut result = Object::new();
    result.insert(
        JsString::from(SEALED_MARK),
        Value::String(STANDARD.encode(wire.as_slice()).into()),
    );
    if owner != id {
        result.insert(JsString::from("k"), Value::String(owner.into()));
    }
    Ok(result)
}
