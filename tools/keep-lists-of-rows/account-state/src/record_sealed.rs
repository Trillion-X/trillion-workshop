// Purpose: Open the existing erasable.mjs version-one field envelope using
// RustCrypto XChaCha20-Poly1305, original record/field associated data and an
// explicitly supplied current key. No SQL, authority, key minting or fallback.
// Security: keys and decrypted byte buffers zeroize; errors/Debug are redacted.
// Authentication failure is a logical unavailable field, not source authority.
use crate::ecma_json::{self, JsString, Object, Value};
use base64::{
    alphabet,
    engine::{
        general_purpose::{GeneralPurpose, GeneralPurposeConfig},
        DecodePaddingMode,
    },
    Engine,
};
use chacha20poly1305::{
    aead::{AeadInPlace, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use std::fmt;
use zeroize::Zeroizing;

pub mod prepare;

pub const SEALED_MARK: &str = "\0sealed";
/// Key custody is separate from a record's ordinary stored value. There is no
/// material getter, Debug dump, serde implementation or persistence method.
pub struct SecretFieldKey(Zeroizing<[u8; 32]>);
impl SecretFieldKey {
    pub fn from_bytes(bytes: Zeroizing<[u8; 32]>) -> Self {
        Self(bytes)
    }
}
impl fmt::Debug for SecretFieldKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretFieldKey([redacted])")
    }
}
#[derive(Clone, Debug)]
pub enum Error {
    Bounds(crate::refusal_cause::Cause),
    InvalidLimits(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { match self {
        Self::Bounds(cause) => cause,
        Self::InvalidLimits(cause) => cause,
    } }
}
crate::impl_caused!(Error);

impl PartialEq for Error { fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) } }
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Bounds(_) => "sealed field exceeds bounds",
            Self::InvalidLimits(_) => "sealed field limits refused",
        })
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// Exactly the original shape: marker string, optional string k, no other keys.
/// An object merely containing a marker is not silently treated as ciphertext.
pub fn is_sealed(object: &Object) -> bool {
    matches!(
        object.get(&JsString::from(SEALED_MARK)),
        Some(Value::String(_))
    ) && object.insertion_entries().all(|(name, value)| {
        name == &JsString::from(SEALED_MARK)
            || (name == &JsString::from("k") && matches!(value, Value::String(_)))
    })
}
pub fn key_owner<'a>(id: &'a str, object: &Object) -> Result<String, Error> {
    match object.get(&JsString::from("k")) {
        Some(Value::String(owner)) => owner.to_rust_string().map_err(|error| Error::Bounds(error.cause())),
        _ => Ok(id.into()),
    }
}
/// Existing atob accepts ASCII whitespace and omitted padding. Bound the input
/// before allocating, and never retain decrypted bytes after JSON conversion.
pub fn open(
    key: &SecretFieldKey,
    id: &str,
    field: &JsString,
    object: &Object,
    json_limits: ecma_json::Limits,
) -> Result<Option<(Value, usize)>, Error> {
    json_limits.validate().map_err(|error| Error::InvalidLimits(error.cause()))?;
    if !is_sealed(object) {
        return Ok(None);
    }
    let Some(Value::String(text)) = object.get(&JsString::from(SEALED_MARK)) else {
        return Ok(None);
    };
    let max_cipher = json_limits
        .input_bytes
        .checked_add(41)
        .ok_or(crate::cause!(Error::Bounds))?;
    // Whitespace is legal, but not an unbounded alternate representation.
    if text.len() > max_cipher.saturating_mul(2).saturating_add(16) {
        return Err(crate::cause!(Error::Bounds));
    }
    let mut encoded = Zeroizing::new(Vec::with_capacity(text.len()));
    for &unit in text.units() {
        if unit > 127 {
            return Ok(None);
        }
        let byte = unit as u8;
        if matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 12) {
            continue;
        }
        encoded.push(byte);
    }
    if encoded.len() > max_cipher.saturating_add(2) / 3 * 4 + 4 {
        return Err(crate::cause!(Error::Bounds));
    }
    let codec = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let mut bytes = match codec.decode(encoded.as_slice()) {
        Ok(v) => Zeroizing::new(v),
        Err(_) => return Ok(None),
    };
    if bytes.len() < 41 || bytes[0] != 1 {
        return Ok(None);
    }
    if bytes.len() > max_cipher {
        return Err(crate::cause!(Error::Bounds));
    }
    let nonce: [u8; 24] = bytes[1..25].try_into().expect("fixed checked nonce length");
    // JS TextEncoder replaces lone surrogates in field names with U+FFFD.
    let field = Zeroizing::new(String::from_utf16_lossy(field.units()));
    let mut associated = Zeroizing::new(Vec::with_capacity(id.len() + 1 + field.len()));
    associated.extend_from_slice(id.as_bytes());
    associated.push(0);
    associated.extend_from_slice(field.as_bytes());
    let cipher =
        XChaCha20Poly1305::new_from_slice(key.0.as_ref()).map_err(|error| crate::carry_cause!(Error::InvalidLimits, error))?;
    let mut plaintext = Zeroizing::new(bytes.split_off(25));
    if cipher
        .decrypt_in_place(
            XNonce::from_slice(&nonce),
            associated.as_slice(),
            &mut *plaintext,
        )
        .is_err()
    {
        return Ok(None);
    }
    if plaintext.len() > json_limits.input_bytes {
        return Err(crate::cause!(Error::Bounds));
    }
    // Original TextDecoder uses replacement decoding and strips an initial BOM.
    let text = Zeroizing::new(String::from_utf8_lossy(&plaintext).into_owned());
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    if text.len() > json_limits.input_bytes {
        return Err(crate::cause!(Error::Bounds));
    }
    match ecma_json::parse(text.as_bytes(), json_limits) {
        Ok(value) => Ok(Some((value, text.len()))),
        Err(ecma_json::Error::InvalidJson(_)) => Ok(None),
        Err(error) => Err(Error::Bounds(error.cause())),
    }
}
