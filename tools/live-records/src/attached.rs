// src/attached.rs
//
// Purpose: The connection of the person's database, as this tool holds it. The tool keeps no vault of its own: the engine attaches the
// field to the run on a file descriptor its row names (credential_mounts), and this reads it once at start into `Held`, by the held name
// `<service>-<field>`.
//
// Non-Negotiable Invariants:
// - A value is read once, never printed, never put in an error, and zeroed when dropped.
// - A refusal names what was wrong with the run and never a value.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::settings::Attached;
use std::{collections::BTreeMap, fmt, io::Read};
use zeroize::Zeroizing;

/// The most bytes one attached field may hold.
const MOST_FIELD_BYTES: u64 = 4096;

/// The values this run holds, by held name.
pub struct Held {
    values: BTreeMap<String, Zeroizing<String>>,
}

impl Held {
    /// Read the attached fields: each descriptor is the one the engine attached for its field; it is read once and closed here. A
    /// descriptor that is not open leaves its field not held.
    #[cfg(unix)]
    pub fn from_descriptors(fields: &[Attached]) -> Result<Self, &'static str> {
        use std::os::fd::{FromRawFd, OwnedFd};
        let mut values = BTreeMap::new();
        for field in fields {
            // SAFETY: the descriptor is the one the engine attached for this field; it is read once and closed here.
            if unsafe { libc::fcntl(field.fd, libc::F_GETFD) } < 0 {
                continue;
            }
            let file = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(field.fd) });
            let mut text = Zeroizing::new(String::new());
            file.take(MOST_FIELD_BYTES + 1).read_to_string(&mut text).map_err(|_| "an attached field is not text")?;
            if text.len() as u64 > MOST_FIELD_BYTES {
                return Err("an attached field is too large");
            }
            let trimmed = Zeroizing::new(text.trim_end_matches(['\n', '\r']).to_owned());
            if !trimmed.is_empty() {
                values.insert(field.name(), trimmed);
            }
        }
        Ok(Self { values })
    }

    /// The value held under `name`, when there is one.
    pub fn plain(&self, name: &str) -> Option<&Zeroizing<String>> {
        self.values.get(name)
    }
}

impl fmt::Debug for Held {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Held({} values)", self.values.len())
    }
}
