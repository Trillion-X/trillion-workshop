//! Original password-record verification, independent of identity storage and
//! grants. The account door supplies its current KDF, allowed record bounds and
//! memory ceiling. This module never chooses an account, keeps a password,
//! counts sign-in attempts, issues a session, or grants access.
//!
//! Nonempty unknown or malformed records perform the current dummy KDF. Empty
//! and non-string inputs refuse without a KDF, as in the original verifier.
//! Scrypt, constant-time comparison and NFKC come from maintained libraries.
//! Output and normalized password buffers zeroize and never implement Debug.

use scrypt::{scrypt, Params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Kdf {
    pub name: String,
    pub n: u64,
    pub r: u32,
    pub p: u32,
    pub key_bytes: usize,
    pub salt_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct KdfBounds {
    pub name: Vec<String>,
    pub n: [u64; 2],
    pub r: [u32; 2],
    pub p: [u32; 2],
    pub key_bytes: [usize; 2],
    pub salt_bytes: [usize; 2],
}

/// Supplied by the declared door policy, never inferred from a kept record.
pub struct VerificationPolicy {
    current: Kdf,
    bounds: KdfBounds,
    max_memory_bytes: u64,
}

#[derive(Clone, Debug)]
pub enum VerificationError {
    InvalidPolicy(crate::refusal_cause::Cause),
    DerivationFailed(crate::refusal_cause::Cause),
}
impl VerificationError {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::InvalidPolicy(cause) => cause.clone(),
            Self::DerivationFailed(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(VerificationError);

impl PartialEq for VerificationError {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::InvalidPolicy(_), Self::InvalidPolicy(_)) => true,
            (Self::DerivationFailed(_), Self::DerivationFailed(_)) => true,
            _ => false,
        }
    }
}
impl Eq for VerificationError {}


#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verification {
    pub matches: bool,
    pub needs_rehash: bool,
}

impl VerificationPolicy {
    pub fn new(current: Kdf, bounds: KdfBounds, max_memory_bytes: u64) -> Result<Self, VerificationError> {
        let ordered = bounds.n[0] <= bounds.n[1]
            && bounds.r[0] <= bounds.r[1]
            && bounds.p[0] <= bounds.p[1]
            && bounds.key_bytes[0] <= bounds.key_bytes[1]
            && bounds.salt_bytes[0] <= bounds.salt_bytes[1];
        if !ordered || bounds.name.is_empty() || bounds.name.iter().any(|name| name != "scrypt") {
            return Err(crate::cause!(VerificationError::InvalidPolicy));
        }
        let policy = Self { current, bounds, max_memory_bytes };
        if !policy.allowed(&policy.current) || !policy.fits_work_limit(&policy.current) {
            return Err(crate::cause!(VerificationError::InvalidPolicy));
        }
        Ok(policy)
    }

    /// Reads only the existing KDF and bounds projection; words, rate limits
    /// and account storage remain with their original owners.
    pub fn from_settings(settings: &Value, max_memory_bytes: u64) -> Result<Self, VerificationError> {
        let current = parse_kdf(settings.get("kdf").ok_or(crate::cause!(VerificationError::InvalidPolicy))?)
            .ok_or(crate::cause!(VerificationError::InvalidPolicy))?;
        let bounds = serde_json::from_value(settings.get("kdf_bounds").cloned()
            .ok_or(crate::cause!(VerificationError::InvalidPolicy))?)
            .map_err(|error| crate::carry_cause!(VerificationError::InvalidPolicy, error))?;
        Self::new(current, bounds, max_memory_bytes)
    }

    fn allowed(&self, kdf: &Kdf) -> bool {
        self.bounds.name.contains(&kdf.name)
            && (self.bounds.n[0]..=self.bounds.n[1]).contains(&kdf.n)
            && (self.bounds.r[0]..=self.bounds.r[1]).contains(&kdf.r)
            && (self.bounds.p[0]..=self.bounds.p[1]).contains(&kdf.p)
            && (self.bounds.key_bytes[0]..=self.bounds.key_bytes[1]).contains(&kdf.key_bytes)
            && (self.bounds.salt_bytes[0]..=self.bounds.salt_bytes[1]).contains(&kdf.salt_bytes)
            && kdf.n >= 2 && kdf.n.is_power_of_two()
    }

    fn fits_work_limit(&self, kdf: &Kdf) -> bool {
        // Sequential RustCrypto uses the same B + V + scratch allocation as
        // noble: 128*r*(N+p+1). Do not enable its parallel feature, which
        // multiplies V allocations by p. Output/salt have their own bound.
        let memory = kdf.n.checked_add(u64::from(kdf.p)).and_then(|n| n.checked_add(1))
            .and_then(|n| n.checked_mul(u64::from(kdf.r)))
            .and_then(|n| n.checked_mul(128));
        memory.is_some_and(|bytes| bytes <= self.max_memory_bytes)
            && kdf.key_bytes > 0 && kdf.salt_bytes > 0
            && (kdf.key_bytes as u64) <= self.max_memory_bytes
            && (kdf.salt_bytes as u64) <= self.max_memory_bytes
            && kdf.r.checked_mul(kdf.p).is_some_and(|rp| rp < 0x4000_0000)
            && Params::new(kdf.n.trailing_zeros() as u8, kdf.r, kdf.p).is_ok()
    }
}

struct KeptRecord {
    kdf: Kdf,
    salt: Zeroizing<Vec<u8>>,
    verifier: Zeroizing<Vec<u8>>,
}

fn integer(value: &Value) -> Option<u64> {
    if let Some(value) = value.as_u64() { return Some(value); }
    // JSON 32768.0 is an integer in ECMAScript, too. Reject booleans,
    // fractions, negatives and values outside its exact integer range.
    let value = value.as_f64()?;
    (value.is_finite() && value >= 0.0 && value.fract() == 0.0
        && value <= 9_007_199_254_740_991.0).then_some(value as u64)
}

fn parse_kdf(value: &Value) -> Option<Kdf> {
    Some(Kdf {
        name: value.get("name")?.as_str()?.to_owned(),
        n: integer(value.get("n")?)?,
        r: integer(value.get("r")?)?.try_into().ok()?,
        p: integer(value.get("p")?)?.try_into().ok()?,
        key_bytes: integer(value.get("key_bytes")?)?.try_into().ok()?,
        salt_bytes: integer(value.get("salt_bytes")?)?.try_into().ok()?,
    })
}

fn kept_record(value: Option<&Value>, policy: &VerificationPolicy) -> Option<KeptRecord> {
    let value = value?;
    let kdf = parse_kdf(value.get("kdf")?)?;
    if !policy.allowed(&kdf) || !policy.fits_work_limit(&kdf) { return None; }
    let salt = value.get("salt")?.as_str()?;
    let verifier = value.get("verifier")?.as_str()?;
    if salt.len() != kdf.salt_bytes.checked_mul(2)?
        || verifier.len() != kdf.key_bytes.checked_mul(2)? { return None; }
    Some(KeptRecord {
        kdf,
        salt: Zeroizing::new(base16ct::lower::decode_vec(salt).ok()?),
        verifier: Zeroizing::new(base16ct::lower::decode_vec(verifier).ok()?),
    })
}

fn derive(password: &[u8], salt: &[u8], kdf: &Kdf) -> Result<Zeroizing<Vec<u8>>, VerificationError> {
    let params = Params::new(kdf.n.trailing_zeros() as u8, kdf.r, kdf.p)
        .map_err(|error| crate::carry_cause!(VerificationError::DerivationFailed, error))?;
    let mut output = Zeroizing::new(vec![0; kdf.key_bytes]);
    scrypt(password, salt, &params, &mut output).map_err(|error| crate::carry_cause!(VerificationError::DerivationFailed, error))?;
    Ok(output)
}

/// Verify a Unicode scalar string. An unusable kept record always substitutes
/// the current-policy dummy, so it cannot select a weaker or excessive KDF.
pub fn verify_password(password: Option<&str>, record: Option<&Value>, policy: &VerificationPolicy)
    -> Result<Verification, VerificationError>
{
    verify_with(password, record, policy, derive)
}

/// Match TextEncoder's replacement of unpaired ECMAScript UTF-16 surrogates.
/// JSON/string parsing remains with the caller; this adapter keeps that
/// representation boundary explicit rather than rejecting an old password.
pub fn verify_password_utf16(password: Option<&[u16]>, record: Option<&Value>, policy: &VerificationPolicy)
    -> Result<Verification, VerificationError>
{
    verify_utf16_with(password, record, policy, derive)
}

/// Keep a new password under the declared current policy: its scrypt key from a fresh random salt, in the same
/// record shape `verify_password` reads. The caller owns the account, attempt counting and storage. No password or
/// salt enters diagnostics.
pub(crate) fn make_password_record(password: &str, policy: &VerificationPolicy) -> Result<Value, VerificationError> {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut salt = Zeroizing::new(vec![0; policy.current.salt_bytes]);
    SystemRandom::new().fill(&mut salt).map_err(|error| crate::carry_cause!(VerificationError::DerivationFailed, error))?;
    make_record_with_salt(password, &salt, policy)
}

fn make_record_with_salt(password: &str, salt: &[u8], policy: &VerificationPolicy) -> Result<Value, VerificationError> {
    if salt.len() != policy.current.salt_bytes {
        return Err(crate::cause!(VerificationError::InvalidPolicy));
    }
    let normalized = Zeroizing::new(password.nfkc().collect::<String>());
    let made = derive(normalized.as_bytes(), salt, &policy.current)?;
    Ok(serde_json::json!({
        "verifier": base16ct::lower::encode_string(&made),
        "salt": base16ct::lower::encode_string(salt),
        "kdf": policy.current,
    }))
}

fn verify_utf16_with(
    password: Option<&[u16]>, record: Option<&Value>, policy: &VerificationPolicy,
    derive_key: impl FnMut(&[u8], &[u8], &Kdf) -> Result<Zeroizing<Vec<u8>>, VerificationError>,
) -> Result<Verification, VerificationError> {
    let password = password.map(|units| Zeroizing::new(String::from_utf16_lossy(units)));
    verify_with(password.as_ref().map(|text| text.as_str()), record, policy, derive_key)
}

fn verify_with(
    password: Option<&str>, record: Option<&Value>, policy: &VerificationPolicy,
    mut derive_key: impl FnMut(&[u8], &[u8], &Kdf) -> Result<Zeroizing<Vec<u8>>, VerificationError>,
) -> Result<Verification, VerificationError> {
    let refused = Verification { matches: false, needs_rehash: false };
    let Some(password) = password.filter(|password| !password.is_empty()) else { return Ok(refused); };
    let usable = kept_record(record, policy);
    let kept = usable.as_ref();
    let dummy_salt = Zeroizing::new(vec![0; policy.current.salt_bytes]);
    let dummy_verifier = Zeroizing::new(vec![0; policy.current.key_bytes]);
    let (kdf, salt, expected) = kept.map(|kept| (&kept.kdf, kept.salt.as_slice(), kept.verifier.as_slice()))
        .unwrap_or((&policy.current, dummy_salt.as_slice(), dummy_verifier.as_slice()));
    let normalized = Zeroizing::new(password.nfkc().collect::<String>());
    let made = derive_key(normalized.as_bytes(), salt, kdf)?;
    let matches = bool::from(made.as_slice().ct_eq(expected)) && kept.is_some();
    // The original rehash predicate deliberately excludes salt length.
    let needs_rehash = matches && (kdf.name != policy.current.name || kdf.n != policy.current.n
        || kdf.r != policy.current.r || kdf.p != policy.current.p || kdf.key_bytes != policy.current.key_bytes);
    Ok(Verification { matches, needs_rehash })
}

#[cfg(test)]
#[path = "../../tests/drafts/credential_verification.rs"]
mod tests;
