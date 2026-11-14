//! WebAuthn assertion verification for the account door, independent of its
//! HTTP route, account store and UI. The caller supplies a credential already
//! found under its current account and a one-use challenge it owns. A match
//! does not mint a session or grant: the caller must commit the counter and
//! recheck account rights with that original challenge before issuing either.
//!
//! Ports the assertion contract of @passwordless-id/webauthn server.js (MIT):
//! credential id, signature, type, origin, challenge, RP hash, user-present flag, optional
//! user verification and monotone nonzero counter. RustCrypto's DER/SPKI parser
//! and ring verify the original SPKI keys and assertion signatures; no custom
//! ASN.1 parser or cryptographic implementation is used.
//! Original copyright (c) 2022 Arnaud Dagnelies; the complete MIT notice is
//! retained in docs/licenses/passwordless-id-webauthn-MIT.txt.
use base64::{engine::general_purpose, Engine};
use der::Decode;
use ring::{digest, signature};
use serde_json::Value;
use spki::SubjectPublicKeyInfoRef;

pub(crate) struct AssertionPolicy<'a> {
    pub challenge: &'a str,
    pub origin: &'a str,
    pub relying_party: &'a str,
    pub user_verified: bool,
    pub previous_counter: u32,
    /// The door's admitted input budget, not a verifier-specific fixed limit.
    pub maximum_component_bytes: usize,
    pub client_json_limits: crate::ecma_json::Limits,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Assertion {
    pub counter: u32,
    pub user_verified: bool,
    /// Flag bits 3 and 4 of the verified authenticator data, which the original
    /// door reads after a sign-in as the passkey's `synced` state. Like the
    /// original library, BS without BE is reported, not refused.
    pub backup_eligible: bool,
    pub backup_state: bool,
}

#[derive(Clone, Debug)]
pub(crate) enum VerificationError {
    InvalidInput(crate::refusal_cause::Cause),
    UnsupportedAlgorithm(crate::refusal_cause::Cause),
    InvalidKey(crate::refusal_cause::Cause),
    InvalidSignature(crate::refusal_cause::Cause),
    CredentialMismatch(crate::refusal_cause::Cause),
    ChallengeMismatch(crate::refusal_cause::Cause),
    OriginMismatch(crate::refusal_cause::Cause),
    RelyingPartyMismatch(crate::refusal_cause::Cause),
    PresenceRequired(crate::refusal_cause::Cause),
    VerificationRequired(crate::refusal_cause::Cause),
    CounterNotAdvanced(crate::refusal_cause::Cause),
}
impl VerificationError {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::InvalidInput(cause) => cause.clone(),
            Self::UnsupportedAlgorithm(cause) => cause.clone(),
            Self::InvalidKey(cause) => cause.clone(),
            Self::InvalidSignature(cause) => cause.clone(),
            Self::CredentialMismatch(cause) => cause.clone(),
            Self::ChallengeMismatch(cause) => cause.clone(),
            Self::OriginMismatch(cause) => cause.clone(),
            Self::RelyingPartyMismatch(cause) => cause.clone(),
            Self::PresenceRequired(cause) => cause.clone(),
            Self::VerificationRequired(cause) => cause.clone(),
            Self::CounterNotAdvanced(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(VerificationError);

impl PartialEq for VerificationError {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::InvalidInput(_), Self::InvalidInput(_)) => true,
            (Self::UnsupportedAlgorithm(_), Self::UnsupportedAlgorithm(_)) => true,
            (Self::InvalidKey(_), Self::InvalidKey(_)) => true,
            (Self::InvalidSignature(_), Self::InvalidSignature(_)) => true,
            (Self::CredentialMismatch(_), Self::CredentialMismatch(_)) => true,
            (Self::ChallengeMismatch(_), Self::ChallengeMismatch(_)) => true,
            (Self::OriginMismatch(_), Self::OriginMismatch(_)) => true,
            (Self::RelyingPartyMismatch(_), Self::RelyingPartyMismatch(_)) => true,
            (Self::PresenceRequired(_), Self::PresenceRequired(_)) => true,
            (Self::VerificationRequired(_), Self::VerificationRequired(_)) => true,
            (Self::CounterNotAdvanced(_), Self::CounterNotAdvanced(_)) => true,
            _ => false,
        }
    }
}
impl Eq for VerificationError {}


fn text<'a>(value: &'a Value, name: &str, maximum: usize) -> Result<&'a str, VerificationError> {
    value.get(name).and_then(Value::as_str).filter(|s| s.len() <= maximum)
        .ok_or(crate::cause!(VerificationError::InvalidInput))
}

fn decoded(value: &str, maximum: usize) -> Result<Vec<u8>, VerificationError> {
    if value.len() > maximum { return Err(crate::cause!(VerificationError::InvalidInput)); }
    // The original verifier maps the URL alphabet and then calls browser atob,
    // whose WHATWG forgiving-base64 decode removes ASCII whitespace, strips one
    // or two '=' only from a length that is a multiple of four, then refuses a
    // remainder of one or any other '='. Trailing bits are discarded.
    let mut text: Vec<u8> = value.bytes().filter(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0c))
        .map(|b| match b { b'-' => b'+', b'_' => b'/', b => b }).collect();
    if text.len() % 4 == 0 {
        let padding = text.iter().rev().take(2).take_while(|&&b| b == b'=').count();
        text.truncate(text.len() - padding);
    }
    if text.len() % 4 == 1 || !text.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/')) {
        return Err(crate::cause!(VerificationError::InvalidInput));
    }
    let engine = general_purpose::GeneralPurpose::new(&base64::alphabet::STANDARD,
        general_purpose::GeneralPurposeConfig::new().with_decode_padding_mode(base64::engine::DecodePaddingMode::RequireNone)
            .with_decode_allow_trailing_bits(true));
    engine.decode(text).map_err(|error| crate::carry_cause!(VerificationError::InvalidInput, error))
}

fn public_key<'a>(algorithm: &str, spki: &'a [u8]) -> Result<(&'static dyn signature::VerificationAlgorithm, &'a [u8]), VerificationError> {
    let key = SubjectPublicKeyInfoRef::from_der(spki).map_err(|error| crate::carry_cause!(VerificationError::InvalidKey, error))?;
    let bits = key.subject_public_key.as_bytes().ok_or(crate::cause!(VerificationError::InvalidKey))?;
    match algorithm {
        "ES256" => {
            if key.algorithm.oid.to_string() != "1.2.840.10045.2.1"
                || key.algorithm.parameters.and_then(|p| p.decode_as::<der::asn1::ObjectIdentifier>().ok())
                    .is_none_or(|oid| oid.to_string() != "1.2.840.10045.3.1.7") {
                return Err(crate::cause!(VerificationError::InvalidKey));
            }
            Ok((&signature::ECDSA_P256_SHA256_ASN1, bits))
        }
        "RS256" => {
            if key.algorithm.oid.to_string() != "1.2.840.113549.1.1.1"
                || key.algorithm.parameters.is_some_and(|p| p.decode_as::<der::asn1::Null>().is_err()) {
                return Err(crate::cause!(VerificationError::InvalidKey));
            }
            // This is a verifier of existing credentials, including original
            // 1024-bit RSA keys. New enrollment strength is a separate policy.
            Ok((&signature::RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY, bits))
        }
        _ => Err(crate::cause!(VerificationError::UnsupportedAlgorithm)),
    }
}

/// Verify an actual browser assertion against its already-admitted credential.
/// Secret assertions, keys or errors are never logged by this verifier.
pub(crate) fn verify_assertion(response: &Value, credential: &Value, policy: &AssertionPolicy<'_>) -> Result<Assertion, VerificationError> {
    let maximum = policy.maximum_component_bytes;
    if maximum == 0 || policy.client_json_limits.validate().is_err()
        || policy.challenge.is_empty() || policy.origin.is_empty() || policy.relying_party.is_empty()
        || [policy.challenge, policy.origin, policy.relying_party].iter().any(|v| v.len() > maximum) {
        return Err(crate::cause!(VerificationError::InvalidInput));
    }
    if text(response, "id", maximum)? != text(credential, "id", maximum)? { return Err(crate::cause!(VerificationError::CredentialMismatch)); }
    let answer = response.get("response").ok_or(crate::cause!(VerificationError::InvalidInput))?;
    let auth = decoded(text(answer, "authenticatorData", maximum)?, maximum)?;
    let client = decoded(text(answer, "clientDataJSON", maximum)?, maximum)?;
    let signed = decoded(text(answer, "signature", maximum)?, maximum)?;
    let spki = decoded(text(credential, "publicKey", maximum)?, maximum)?;
    let (algorithm, key) = public_key(text(credential, "algorithm", maximum)?, &spki)?;
    let mut message = auth.clone();
    message.extend_from_slice(digest::digest(&digest::SHA256, &client).as_ref());
    signature::UnparsedPublicKey::new(algorithm, key).verify(&message, &signed)
        .map_err(|error| crate::carry_cause!(VerificationError::InvalidSignature, error))?;
    // Match the original nonfatal TextDecoder (including its initial BOM)
    // followed by JSON.parse. The shared value model retains unused lone-surrogate
    // strings and duplicate-property semantics, rather than losing them through
    // serde_json before the authenticated fields are compared.
    let decoded_client = String::from_utf8_lossy(&client);
    let decoded_client = decoded_client.strip_prefix('\u{feff}').unwrap_or(&decoded_client);
    let crate::ecma_json::Value::Object(client) = crate::ecma_json::parse(decoded_client.as_bytes(), policy.client_json_limits)
        .map_err(|error| crate::carry_cause!(VerificationError::InvalidInput, error))? else { return Err(crate::cause!(VerificationError::InvalidInput)); };
    let matches = |name: &str, expected: &str| client.get(&name.into())
        == Some(&crate::ecma_json::Value::String(expected.into()));
    if !matches("type", "webauthn.get") { return Err(crate::cause!(VerificationError::InvalidInput)); }
    if !matches("origin", policy.origin) { return Err(crate::cause!(VerificationError::OriginMismatch)); }
    if !matches("challenge", policy.challenge) { return Err(crate::cause!(VerificationError::ChallengeMismatch)); }
    if auth.len() < 37 { return Err(crate::cause!(VerificationError::InvalidInput)); }
    // The original library's toBuffer truncates UTF-16 units to bytes. The
    // browser-facing caller normally supplies URL.hostname (ASCII/punycode).
    let relying_party: Vec<u8> = policy.relying_party.encode_utf16().map(|unit| unit as u8).collect();
    if auth[..32] != *digest::digest(&digest::SHA256, &relying_party).as_ref() {
        return Err(crate::cause!(VerificationError::RelyingPartyMismatch));
    }
    if auth[32] & 1 == 0 { return Err(crate::cause!(VerificationError::PresenceRequired)); }
    let user_verified = auth[32] & 4 != 0;
    if policy.user_verified && !user_verified { return Err(crate::cause!(VerificationError::VerificationRequired)); }
    let counter = u32::from_be_bytes(auth[33..37].try_into().map_err(|error| crate::carry_cause!(VerificationError::InvalidInput, error))?);
    if policy.previous_counter != 0 && counter <= policy.previous_counter { return Err(crate::cause!(VerificationError::CounterNotAdvanced)); }
    Ok(Assertion { counter, user_verified, backup_eligible: auth[32] & 8 != 0, backup_state: auth[32] & 16 != 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_assertion_vectors_match_without_loading_javascript() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../../tests/data/passkey-assertion-vectors.json")).unwrap();
        assert!(cases.len() >= 15);
        for case in cases {
            let p = &case["expected"];
            let policy = AssertionPolicy { challenge: p["challenge"].as_str().unwrap(), origin: p["origin"].as_str().unwrap(),
                relying_party: p["domain"].as_str().unwrap(), user_verified: p["userVerified"].as_bool().unwrap_or(false),
                previous_counter: p["counter"].as_u64().unwrap_or(0) as u32,
                maximum_component_bytes: 65_536, client_json_limits: Default::default() };
            let actual = verify_assertion(&case["response"], &case["credential"], &policy);
            assert_eq!(actual.is_ok(), case["accepted"].as_bool().unwrap(), "{}: {:?}", case["name"], actual);
            if let Ok(answer) = actual {
                assert_eq!(answer.counter, case["result"]["counter"].as_u64().unwrap() as u32);
                assert_eq!(answer.user_verified, case["result"]["userVerified"].as_bool().unwrap());
            }
        }
    }

    /// Independent vectors: fresh WebCrypto keys sign, and the unchanged
    /// original provider decides (generator embedded in the fixture). Every
    /// original success except the declared DER re-encodings stays a success.
    #[test]
    fn independent_original_provider_vectors_match_except_declared_der_strictness() {
        let data: Value = serde_json::from_str(include_str!("../../tests/data/passkey-assertion-parity-vectors.json")).unwrap();
        assert_eq!(data["synthetic_only"], true);
        assert!(data["generator"]["original_provider"].as_str().unwrap().contains("@passwordless-id/webauthn@2.4.0"));
        // Strict DER signature parsing (ring) instead of the original library's
        // index-based convertASN1toRaw. The first two are valid DER that real
        // authenticators emit for a short r or s, which the original refused; the
        // rest are non-DER re-encodings of a valid signature that the original
        // accepted because it ignores tags and lengths (WebAuthn requires DER).
        let declared: &[(&str, bool)] = &[
            ("ES256:der-short-r", true), ("ES256:der-short-s", true),
            ("ES256:der-nonminimal-r-pad", false), ("ES256:der-wrong-sequence-length", false),
            ("ES256:der-wrong-integer-tag", false),
        ];
        let cases = data["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 90);
        let (mut accepted, mut refused) = (0, 0);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let p = &case["expected"];
            let policy = AssertionPolicy { challenge: p["challenge"].as_str().unwrap(), origin: p["origin"].as_str().unwrap(),
                relying_party: p["domain"].as_str().unwrap(), user_verified: p["userVerified"].as_bool().unwrap(),
                previous_counter: u32::try_from(p["counter"].as_u64().unwrap()).unwrap(),
                maximum_component_bytes: 65_536, client_json_limits: Default::default() };
            let actual = verify_assertion(&case["response"], &case["credential"], &policy);
            let original = case["accepted"].as_bool().unwrap();
            match declared.iter().find(|(declared, _)| *declared == name) {
                Some((_, rust)) => {
                    assert_ne!(original, *rust, "{name} no longer diverges; remove its declaration");
                    assert_eq!(actual.is_ok(), *rust, "{name}: {actual:?}");
                    if !rust { assert_eq!(actual, Err(crate::cause!(VerificationError::InvalidSignature)), "{name}"); }
                    continue;
                }
                None => assert_eq!(actual.is_ok(), original, "{name}: original {original}, rust {actual:?}"),
            }
            if let Ok(answer) = actual {
                accepted += 1;
                let r = &case["result"];
                assert_eq!(u64::from(answer.counter), r["counter"].as_u64().unwrap(), "{name}");
                assert_eq!(answer.user_verified, r["userVerified"].as_bool().unwrap(), "{name}");
                assert_eq!(answer.backup_eligible, r["backupEligible"].as_bool().unwrap(), "{name}");
                assert_eq!(answer.backup_state, r["backupState"].as_bool().unwrap(), "{name}");
            } else { refused += 1; }
        }
        assert_eq!((accepted, refused), (35, 50), "compared successes and refusals");
    }

    /// atob refuses '=' unless it pads a length that is a multiple of four.
    /// Before this repair the indifferent-padding decoder accepted "QQ=".
    #[test]
    fn forgiving_base64_matches_browser_atob_padding_and_whitespace_rules() {
        for (text, bytes) in [("QQ==", &b"A"[..]), ("QQ", b"A"), ("QUI=", b"AB"), ("QUI", b"AB"), ("Q Q=\n=", b"A"),
            ("QR==", b"A"), ("-_8", &[0xfb, 0xff][..]), ("+/8=", &[0xfb, 0xff][..]), ("", b"")] {
            assert_eq!(decoded(text, 64).as_deref(), Ok(bytes), "{text:?}");
        }
        for text in ["QQ=", "QQ===", "Q===", "QUI==", "QQ==QQ==", "=QQ=", "Q", "QUJDR", "QQ\u{a0}==", ".QQ=", "QQ%3D"] {
            assert_eq!(decoded(text, 64), Err(crate::cause!(VerificationError::InvalidInput)), "{text:?}");
        }
    }
}
