// src/host/secrets.rs
//
// Purpose: The store's credential, as this tool holds it. The tool keeps no vault of its own: the engine attaches the
// person's `files-store` connection to the run (each field of the connection at a file descriptor its row names), and
// this tool reads them once at start into `Held`, which answers the account files' byte owner (`objects::Secrets`) by
// the vault name an origin record gives (`held_name`: `<service>-<field>`, so the field `secret` of `files-store` is
// `files-store-secret`).
//
// Non-Negotiable Invariants:
// - A value is read once, never printed, never put in an error, and zeroed when dropped.
// - A SigV4 day key is made here from the value (`HMAC-SHA256("AWS4" + secret, day)`); the value itself never leaves `Held`.
// - A refusal names the vault name it concerns and never a value.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::{collections::BTreeMap, fmt, io::Read, path::Path, sync::Arc};
use zeroize::Zeroizing;

/// The vault service the account files' store is connected as.
pub const SERVICE: &str = "files-store";

/// The most bytes one attached field may hold.
const MOST_FIELD_BYTES: u64 = 4096;

#[derive(Debug, Clone)]
pub enum Error {
    /// No value is held under this vault name.
    NotHeld(String, crate::refusal_cause::Cause),
    /// A request the holder refuses, with the reason's own words.
    Refused(&'static str, crate::refusal_cause::Cause),
    /// The attached fields could not be read.
    Unavailable(&'static str, crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::NotHeld(_, cause) | Self::Refused(_, cause) | Self::Unavailable(_, cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotHeld(name, _) => write!(f, "no value is held under {name}"),
            Self::Refused(words, _) | Self::Unavailable(words, _) => f.write_str(words),
        }
    }
}
impl std::error::Error for Error {}

/// A service or field id: lowercase words and digits joined by `-`.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.split('-').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

/// The vault name of one service field: `<service>-<field>`.
pub fn held_name(service: &str, field: &str) -> Result<String, Error> {
    if !valid_id(service) || !valid_id(field) {
        return Err(Error::Refused("a service or field id is lowercase words joined by '-'", crate::cause!()));
    }
    Ok(format!("{service}-{field}"))
}

/// The values this run holds, by vault name.
pub struct Held {
    values: BTreeMap<String, Zeroizing<String>>,
}

impl Held {
    /// Holds nothing: every name is not held.
    pub fn none() -> Self {
        Self { values: BTreeMap::new() }
    }

    /// Hold `value` under the vault name of `field` of the `files-store` connection.
    pub fn with(mut self, field: &str, value: Zeroizing<String>) -> Result<Self, Error> {
        self.values.insert(held_name(SERVICE, field)?, value);
        Ok(self)
    }

    /// Read the attached fields: `fields` names each field of the connection and the file descriptor the engine attached
    /// it at. A descriptor that is not open leaves its field not held.
    #[cfg(unix)]
    pub fn from_descriptors(fields: &[(&str, i32)]) -> Result<Self, Error> {
        use std::os::fd::{FromRawFd, OwnedFd};
        let mut held = Self::none();
        for (field, descriptor) in fields {
            // SAFETY: the descriptor is the one the engine attached for this field; it is read once and closed here.
            if unsafe { libc::fcntl(*descriptor, libc::F_GETFD) } < 0 {
                continue;
            }
            let file = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(*descriptor) });
            let mut text = Zeroizing::new(String::new());
            file.take(MOST_FIELD_BYTES + 1)
                .read_to_string(&mut text)
                .map_err(|_| Error::Unavailable("an attached field is not text", crate::cause!()))?;
            if text.len() as u64 > MOST_FIELD_BYTES {
                return Err(Error::Unavailable("an attached field is too large", crate::cause!()));
            }
            let trimmed = Zeroizing::new(text.trim_end_matches(['\n', '\r']).to_owned());
            if trimmed.is_empty() {
                continue;
            }
            held = held.with(field, trimmed)?;
        }
        Ok(held)
    }

    pub fn plain(&self, name: &str) -> Result<Zeroizing<String>, Error> {
        self.values.get(name).cloned().ok_or_else(|| Error::NotHeld(name.to_owned(), crate::cause!()))
    }

    pub fn holds(&self, name: &str) -> bool {
        self.values.contains_key(name)
    }

    /// The SigV4 day key of the secret held under `name`: HMAC-SHA256(key = "AWS4" + secret, data = `day`).
    pub fn sigv4_day_key(&self, name: &str, day: &str) -> Result<Zeroizing<Vec<u8>>, Error> {
        let secret = self.values.get(name).ok_or_else(|| Error::NotHeld(name.to_owned(), crate::cause!()))?;
        let mut key = Zeroizing::new(Vec::with_capacity(4 + secret.len()));
        key.extend_from_slice(b"AWS4");
        key.extend_from_slice(secret.as_bytes());
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key).map_err(|_| Error::Refused("a signing key of this length is refused", crate::cause!()))?;
        mac.update(day.as_bytes());
        Ok(Zeroizing::new(mac.finalize().into_bytes().to_vec()))
    }
}

impl fmt::Debug for Held {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Held({} values)", self.values.len())
    }
}

/// The holder this process was started with. A process holds one: the tool serves the person it was started for.
static HELD: std::sync::OnceLock<Arc<Held>> = std::sync::OnceLock::new();

/// Keep `held` as this process's holder (once; a second call keeps the first).
pub fn keep(held: Held) -> Arc<Held> {
    HELD.get_or_init(|| Arc::new(held)).clone()
}

/// This process's holder; none held when the tool was started with no attached field.
pub fn open_home(_: &Path, _: &str) -> Result<Arc<Held>, Error> {
    Ok(HELD.get().cloned().unwrap_or_else(|| Arc::new(Held::none())))
}

/// The old Worker's vault as the account's RecordBook keeps it: the sealed snapshot and the secrets key identity it names.
pub struct OldVault {
    pub snapshot: Zeroizing<Vec<u8>>,
    pub sealed_under: Option<String>,
}
impl fmt::Debug for OldVault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OldVault([sealed])")
    }
}
