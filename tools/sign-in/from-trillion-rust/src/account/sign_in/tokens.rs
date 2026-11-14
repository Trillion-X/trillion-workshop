//! Secrets and their fingerprints. A secret is made here, shown once to its
//! owner, and stored only as its fingerprint: SHA-256 hex for OAuth codes and
//! tokens, BLAKE3 hex for sessions and personal keys. Comparisons of secret
//! material are constant time.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use content_crypto::advanced::blake3;
use ring::{digest, rand::{SecureRandom, SystemRandom}};
use subtle::ConstantTimeEq;

/// `bytes` random bytes from the operating system, as unpadded base64url.
pub(crate) fn random_text(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    SystemRandom::new().fill(&mut buffer).expect("the operating system's random source answers");
    URL_SAFE_NO_PAD.encode(buffer)
}

/// `bytes` random bytes from the operating system, as lowercase hex.
pub(crate) fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    SystemRandom::new().fill(&mut buffer).expect("the operating system's random source answers");
    buffer.iter().map(|b| format!("{b:02x}")).collect()
}

/// Lowercase hex SHA-256 of `text`'s UTF-8 bytes.
pub(crate) fn sha256_hex(text: &str) -> String {
    digest::digest(&digest::SHA256, text.as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Lowercase hex BLAKE3 of `text`'s UTF-8 bytes.
pub(crate) fn blake3_hex(text: &str) -> String {
    blake3::hash(text.as_bytes()).to_hex().to_string()
}

/// Whether `verifier` satisfies the S256 `challenge` (RFC 7636 §4.6). The
/// verifier must be 43–128 characters of the unreserved set (§4.1).
pub(crate) fn pkce_s256_matches(verifier: &str, challenge: &str) -> bool {
    let valid = (43..=128).contains(&verifier.len())
        && verifier.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'));
    if !valid {
        return false;
    }
    let computed = URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes()));
    same(&computed, challenge)
}

/// Whether `text` is an account address (or a computer id) as text: 64 lowercase hex characters.
pub(crate) fn owner_text_ok(text: &str) -> bool {
    text.len() == OWNER_HEX_LEN && text.bytes().all(is_lower_hex)
}

/// The account address a credential names (src/account/computers.rs `address_of`: derived from the account's public
/// signing key, never its internal owner id), read from its text with no lookup, or `None` when the text is not in the
/// current shape. Old-shape credentials (a personal key of `nm_` plus 64 hex, a bare OAuth token) are `None`, so
/// they are refused before any lookup. The secret part is not checked here; the sign-in checks it by its fingerprint.
///
/// - Personal key: `<personal_key_prefix><address hex>_<secret hex>` (`keys.rs`).
/// - OAuth access or refresh token: `<address hex>.<secret base64url>` (`oauth.rs`).
pub(crate) fn credential_address(text: &str) -> Option<&str> {
    if let Some(rest) = text.strip_prefix(super::contract().personal_key_prefix.as_str()) {
        let (owner, secret) = rest.split_at_checked(OWNER_HEX_LEN)?;
        let secret = secret.strip_prefix('_')?;
        return (owner_text_ok(owner) && secret.len() == SECRET_HEX_LEN && secret.bytes().all(is_lower_hex))
            .then_some(owner);
    }
    let (owner, secret) = text.split_at_checked(OWNER_HEX_LEN)?;
    let secret = secret.strip_prefix('.')?;
    (owner_text_ok(owner) && secret.len() == TOKEN_SECRET_LEN && secret.bytes().all(is_token_byte)).then_some(owner)
}

/// Length of an address as text.
pub(crate) const OWNER_HEX_LEN: usize = 64;
/// Length of a personal key's secret as hex (`random_hex(32)`).
const SECRET_HEX_LEN: usize = 64;
/// Length of an OAuth token's secret as base64url (`random_text(32)`, unpadded).
const TOKEN_SECRET_LEN: usize = 43;

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

/// Constant-time equality of two texts.
pub(crate) fn same(left: &str, right: &str) -> bool {
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_the_rfc_7636_example() {
        assert!(pkce_s256_matches("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(!pkce_s256_matches("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXl", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(!pkce_s256_matches("short", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
    }

    #[test]
    fn secrets_are_long_and_distinct() {
        let (a, b) = (random_text(32), random_text(32));
        assert_eq!(a.len(), 43);
        assert_ne!(a, b);
        assert_eq!(random_hex(32).len(), 64);
    }

    #[test]
    fn credential_address_reads_the_owner_of_either_shape_without_a_lookup() {
        let owner = "a".repeat(64);
        let key = format!("{}{owner}_{}", super::super::contract().personal_key_prefix, random_hex(32));
        assert_eq!(credential_address(&key), Some(owner.as_str()));
        let token = format!("{owner}.{}", random_text(32));
        assert_eq!(credential_address(&token), Some(owner.as_str()));
    }

    #[test]
    fn credential_address_refuses_old_and_malformed_shapes() {
        let owner = "a".repeat(64);
        let prefix = super::super::contract().personal_key_prefix.clone();
        let old_key = format!("{prefix}{}", random_hex(32));
        let old_token = random_text(32);
        let refused = [
            String::new(),
            old_key,
            old_token,
            format!("{prefix}{owner}{}", random_hex(32)),
            format!("{prefix}{owner}_{}", "A".repeat(64)),
            format!("{prefix}{owner}_{}0", random_hex(32)),
            format!("{prefix}{}_{}", "A".repeat(64), random_hex(32)),
            format!("{owner}_{}", random_text(32)),
            format!("{owner}.{}", "a".repeat(42)),
            format!("{owner}.{}+", "a".repeat(42)),
            format!("{}.{}", "g".repeat(64), random_text(32)),
            format!("{owner}.{}.", "a".repeat(42)),
        ];
        for presented in refused {
            assert_eq!(credential_address(&presented), None, "credential {presented:?}");
        }
    }

    #[test]
    fn fingerprints_are_lowercase_hex() {
        assert_eq!(sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(blake3_hex("abc").len(), 64);
    }
}
