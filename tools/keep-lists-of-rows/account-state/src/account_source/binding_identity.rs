//! Protected named binding identities from the existing credential-file owner.
//! The current restore owner is local-restore-roots::loadRestoreBindingCredentials
//! over credential-file::readCredentialFile. No credential is created, copied,
//! logged or placed in argv; fixtures alone may select a temporary home.
use super::{check_named, credential_home, credential_name, open_regular, Generation};
use std::{
    fmt,
    fs::File,
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;
use crate::tool_runs::os::{OwnerFiles, This};

/// Whether the computer says this file is this process's own and only its owner may read or write it.
fn owner_only(metadata: &std::fs::Metadata) -> bool {
    let Ok(me) = This::this_owner() else { return false };
    This::facts(metadata).is_ok_and(|facts| facts.owner == me && facts.mode & 0o7777 == 0o600)
}

const MAX_BYTES: usize = 8192;
const MAX_UNITS: usize = 1024;
/// The exact historical local test identity the current restore owner refuses,
/// as the product's identity DATA names it.
pub(crate) fn restore_placeholder_identity() -> Option<&'static str> {
    crate::account_files::identity::identity()
        .ok()
        .map(|identity| identity.restore_placeholder_owner.as_str())
}

/// Whether `text` is the historical local test identity (exact bytes).
pub(crate) fn is_restore_placeholder(text: &str) -> bool {
    restore_placeholder_identity() == Some(text)
}
#[derive(Clone, Debug)]
pub(crate) enum Error {
    InvalidReference(crate::refusal_cause::Cause),
    Missing(crate::refusal_cause::Cause),
    Unavailable(crate::refusal_cause::Cause),
    Custody(crate::refusal_cause::Cause),
    Changed(crate::refusal_cause::Cause),
    InvalidValue(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::InvalidReference(cause) => cause.clone(),
            Self::Missing(cause) => cause.clone(),
            Self::Unavailable(cause) => cause.clone(),
            Self::Custody(cause) => cause.clone(),
            Self::Changed(cause) => cause.clone(),
            Self::InvalidValue(cause) => cause.clone(),
            Self::Bounds(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);

impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::InvalidReference(_), Self::InvalidReference(_)) => true,
            (Self::Missing(_), Self::Missing(_)) => true,
            (Self::Unavailable(_), Self::Unavailable(_)) => true,
            (Self::Custody(_), Self::Custody(_)) => true,
            (Self::Changed(_), Self::Changed(_)) => true,
            (Self::InvalidValue(_), Self::InvalidValue(_)) => true,
            (Self::Bounds(_), Self::Bounds(_)) => true,
            _ => false,
        }
    }
}
impl Eq for Error {}

fn trim(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
/// No raw getter or serialization. The internal consumer may derive its lookup
/// result only while the same original credential remains current.
pub(crate) struct ProtectedBindingIdentity {
    path: PathBuf,
    file: File,
    generation: Generation,
    value: Zeroizing<String>,
}
impl fmt::Debug for ProtectedBindingIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProtectedBindingIdentity([redacted])")
    }
}
impl ProtectedBindingIdentity {
    pub(crate) fn open_existing(reference: &str) -> Result<Self, Error> {
        if !credential_name(reference) {
            return Err(crate::cause!(Error::InvalidReference));
        }
        let home = credential_home().map_err(|error| Error::Unavailable(error.cause()))?;
        Self::open_in_home(reference, &home)
    }
    fn open_in_home(reference: &str, home: &Path) -> Result<Self, Error> {
        if !credential_name(reference) {
            return Err(crate::cause!(Error::InvalidReference));
        }
        // The reference is one safe component. Classify real absence before
        // contained()'s existing-file custody validation, which intentionally
        // collapses I/O failures for the root owner.
        let path = home.join(reference);
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(crate::cause!(Error::Missing))
            }
            Err(_) => return Err(crate::cause!(Error::Unavailable)),
            Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
                return Err(crate::cause!(Error::Custody))
            }
            Ok(_) => {}
        }
        let path = super::contained(home, reference).map_err(|error| Error::Custody(error.cause()))?;
        let (file, generation) = open_regular(&path).map_err(|error| Error::Unavailable(error.cause()))?;
        let metadata = file.metadata().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !owner_only(&metadata) {
            return Err(crate::cause!(Error::Custody));
        }
        if generation.bytes == 0 || generation.bytes > MAX_BYTES as u64 {
            return Err(crate::cause!(Error::Bounds));
        }
        let mut bytes = Zeroizing::new(vec![0u8; generation.bytes as usize]);
        This::read_exact_at(&file, &mut bytes, 0)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|error| crate::carry_cause!(Error::InvalidValue, error))?
            .trim_matches(trim);
        if text.is_empty()
            || is_restore_placeholder(text)
            || text.encode_utf16().count() > MAX_UNITS
            || text.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}')
        {
            return Err(crate::cause!(Error::InvalidValue));
        }
        let held = Self {
            path,
            file,
            generation,
            value: Zeroizing::new(text.to_owned()),
        };
        held.assert_current()?;
        Ok(held)
    }
    pub(crate) fn assert_current(&self) -> Result<(), Error> {
        let metadata = self.file.metadata().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !self.generation.matches(&metadata) {
            return Err(crate::cause!(Error::Changed));
        }
        if !owner_only(&metadata) {
            return Err(crate::cause!(Error::Custody));
        }
        check_named(&self.path, &self.generation).map_err(|error| Error::Changed(error.cause()))
    }
    pub(crate) fn with_current<T>(&self, consume: impl FnOnce(&str) -> T) -> Result<T, Error> {
        self.assert_current()?;
        let result = consume(&self.value);
        self.assert_current()?;
        Ok(result)
    }
    #[cfg(test)]
    pub(crate) fn fixture_in_home(reference: &str, home: &Path) -> Result<Self, Error> {
        Self::open_in_home(reference, home)
    }
}

#[cfg(test)]
mod controls {
    use super::*;

    #[test]
    fn missing_and_invalid_credential_references_keep_their_source_without_the_reference() {
        let home = tempfile::tempdir().unwrap();
        let private_reference = "private-reference-with/no-access";
        let missing = ProtectedBindingIdentity::open_in_home("missing-reference", home.path()).unwrap_err();
        let invalid = ProtectedBindingIdentity::open_in_home(private_reference, home.path()).unwrap_err();
        assert!(matches!(missing, Error::Missing(_)));
        assert!(matches!(invalid, Error::InvalidReference(_)));
        assert_ne!(missing.cause(), invalid.cause());
        for error in [missing, invalid] {
            assert_eq!(error.cause().file(), "src/account_source/binding_identity.rs");
            assert!(!error.cause().id().contains(private_reference));
            assert!(!error.cause().id().contains("missing-reference"));
            assert!(!format!("{error:?}").contains(private_reference));
        }
    }

    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
    };
    fn kept(home: &Path, name: &str, value: &str) {
        fs::write(home.join(name), value).unwrap();
        fs::set_permissions(home.join(name), fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[test]
    fn original_named_value_is_bounded_trimmed_and_not_debugged() {
        let home = tempfile::tempdir().unwrap();
        kept(home.path(), "fixture-ref", "\u{feff}  original-account  \n");
        let identity = ProtectedBindingIdentity::open_in_home("fixture-ref", home.path()).unwrap();
        assert_eq!(
            identity.with_current(|v| v == "original-account").unwrap(),
            true
        );
        assert_eq!(
            format!("{identity:?}"),
            "ProtectedBindingIdentity([redacted])"
        );
    }
    #[test]
    fn missing_and_invalid_custody_are_not_an_empty_identity() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            ProtectedBindingIdentity::open_in_home("absent", home.path()).unwrap_err(),
            crate::cause!(Error::Missing)
        );
        assert_eq!(
            ProtectedBindingIdentity::open_in_home("../escape", home.path()).unwrap_err(),
            crate::cause!(Error::InvalidReference)
        );
        kept(home.path(), "fixture-ref", "original-account");
        fs::set_permissions(
            home.path().join("fixture-ref"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert_eq!(
            ProtectedBindingIdentity::open_in_home("fixture-ref", home.path()).unwrap_err(),
            crate::cause!(Error::Custody)
        );
        symlink(
            home.path().join("fixture-ref"),
            home.path().join("linked-ref"),
        )
        .unwrap();
        assert!(ProtectedBindingIdentity::open_in_home("linked-ref", home.path()).is_err());
    }
    #[test]
    fn replacement_and_mid_consumer_changes_withhold_result() {
        let home = tempfile::tempdir().unwrap();
        kept(home.path(), "fixture-ref", "original-account");
        let identity = ProtectedBindingIdentity::open_in_home("fixture-ref", home.path()).unwrap();
        assert_eq!(
            identity.with_current(|_| {
                kept(home.path(), "fixture-ref", "other-account");
                true
            }),
            Err(crate::cause!(Error::Changed))
        );
        let fresh = ProtectedBindingIdentity::open_in_home("fixture-ref", home.path()).unwrap();
        fs::rename(home.path().join("fixture-ref"), home.path().join("prior")).unwrap();
        kept(home.path(), "fixture-ref", "other-account");
        assert_eq!(fresh.with_current(|_| true), Err(crate::cause!(Error::Changed)));
    }
    #[test]
    fn malformed_empty_and_oversized_values_refuse() {
        let home = tempfile::tempdir().unwrap();
        for value in [
            "  ".to_owned(),
            "account\nother".to_owned(),
            restore_placeholder_identity().unwrap().to_owned(),
            "a".repeat(MAX_UNITS + 1),
            "a".repeat(MAX_BYTES + 1),
        ] {
            kept(home.path(), "fixture-ref", &value);
            assert!(ProtectedBindingIdentity::open_in_home("fixture-ref", home.path()).is_err());
        }
    }
    #[test]
    fn utf16_limit_and_invalid_utf8_match_original_text_contract() {
        let home = tempfile::tempdir().unwrap();
        let boundary = "\u{10000}".repeat(MAX_UNITS / 2);
        kept(home.path(), "fixture-ref", &boundary);
        let identity = ProtectedBindingIdentity::open_in_home("fixture-ref", home.path()).unwrap();
        assert!(identity.with_current(|value| value == boundary).unwrap());
        kept(home.path(), "fixture-ref", &(boundary + "a"));
        assert_eq!(
            ProtectedBindingIdentity::open_in_home("fixture-ref", home.path()).unwrap_err(),
            crate::cause!(Error::InvalidValue)
        );
        fs::write(home.path().join("fixture-ref"), [0xff]).unwrap();
        assert_eq!(
            ProtectedBindingIdentity::open_in_home("fixture-ref", home.path()).unwrap_err(),
            crate::cause!(Error::InvalidValue)
        );
    }
}
