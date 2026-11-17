// src/serve/settings.rs
//
// Purpose: What one run of the Namespace tool reads once from its settings file (`settings.json` of the tool folder, or the file the
// run is told): which account the person's files are kept under, the WebDAV folder's port and path prefix, the folder the byte store's
// keys start in, and which fields of the person's `files-store` connection the engine attached on which file descriptor.
//
// Non-Negotiable Invariants:
// - No value of the connection is in this file: it names fields and descriptors only.
// - A file that holds a field it does not know, or a port, a prefix or a descriptor that cannot be used, is refused before anything starts.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde::Deserialize;
use std::path::Path;

/// The most bytes a settings file may hold.
const MOST_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    /// The name the person's files are kept under in the store file.
    pub account: String,
    pub dav: Dav,
    /// The folder in the byte store that every file's key starts in: empty, or ending with a slash.
    pub key_prefix: String,
    /// The fields of the `files-store` connection and the descriptor each is attached on.
    pub attached: Vec<Attached>,
}

/// The WebDAV folder.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dav {
    /// The loopback port it listens on.
    pub port: u16,
    /// The path every name sits under: empty, or starting with a slash and not ending with one.
    pub prefix: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attached {
    pub field: String,
    pub fd: i32,
}

/// Why a settings file was refused: the words only, never a value.
#[derive(Debug)]
pub struct Refused(pub &'static str);
impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Refused {}

impl Settings {
    pub fn read(path: &Path) -> Result<Self, Refused> {
        use std::io::Read as _;
        let file = std::fs::File::open(path).map_err(|_| Refused("the settings file does not open"))?;
        if !file.metadata().is_ok_and(|metadata| metadata.is_file() && metadata.len() <= MOST_BYTES) {
            return Err(Refused("the settings file is not a small regular file"));
        }
        let mut bytes = Vec::new();
        file.take(MOST_BYTES).read_to_end(&mut bytes).map_err(|_| Refused("the settings file does not read"))?;
        let settings: Self = serde_json::from_slice(&bytes).map_err(|_| Refused("the settings file is not the shape this tool reads"))?;
        settings.valid()?;
        Ok(settings)
    }

    fn valid(&self) -> Result<(), Refused> {
        let plain = |text: &str| !text.is_empty() && text.len() <= 256 && !text.chars().any(char::is_control) && !text.contains('/');
        if !plain(&self.account) {
            return Err(Refused("the account is a short name with no slash"));
        }
        if self.dav.port < 1024 {
            return Err(Refused("the WebDAV port is a user port, 1024 or more"));
        }
        let prefix = &self.dav.prefix;
        if !(prefix.is_empty() || (prefix.starts_with('/') && !prefix.ends_with('/') && !prefix.chars().any(char::is_control))) {
            return Err(Refused("the WebDAV prefix is empty or starts with a slash and does not end with one"));
        }
        let key_prefix = &self.key_prefix;
        if !(key_prefix.is_empty() || (key_prefix.ends_with('/') && !key_prefix.split('/').any(|part| part == "..") && !key_prefix.chars().any(char::is_control))) {
            return Err(Refused("the key prefix is empty or ends with a slash and has no .."));
        }
        let mut descriptors = std::collections::BTreeSet::new();
        let mut fields = std::collections::BTreeSet::new();
        for attached in &self.attached {
            if attached.fd < 3 || !descriptors.insert(attached.fd) {
                return Err(Refused("an attached descriptor is 3 or more and named once"));
            }
            if !fields.insert(attached.field.as_str()) {
                return Err(Refused("an attached field is named once"));
            }
        }
        Ok(())
    }
}
