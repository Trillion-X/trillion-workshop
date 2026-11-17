// src/serve/settings.rs
//
// Purpose: What one run of the Namespace tool reads once from its settings file (`settings.json` of the tool folder, or the file the
// run is told): which account the person's files are kept under, where the person's rows are kept (a SQLite file in the state folder,
// or the person's Postgres database), the WebDAV folder's port and path prefix, the folder the byte store's keys start in, and which
// fields of which connections the engine attached on which file descriptor.
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

/// The vault name of an attached field (`<service>-<field>`), or none when either is not a valid id.
fn held_name(service: &str, field: &str) -> Option<String> {
    live_namespace::secrets::held_name(service, field).ok()
}

/// The most bytes a settings file may hold.
const MOST_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    /// The name the person's files are kept under in the rows.
    pub account: String,
    /// Where the person's rows are kept.
    pub store: Rows,
    pub dav: Dav,
    /// The folder in the byte store that every file's key starts in: empty, or ending with a slash.
    pub key_prefix: String,
    /// How long one call may take before it answers where it stopped.
    pub call_seconds: u64,
    /// The fields of the connections (`files-store`: the byte store; the database's own) and the descriptor each is attached on.
    pub attached: Vec<Attached>,
}

/// Where the person's rows are kept.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase", deny_unknown_fields)]
pub enum Rows {
    /// A SQLite file of this name in the state folder (the first run makes it).
    Sqlite { file: String },
    /// The person's Postgres database. `password` is the held name of the attached field that holds its password.
    Postgres { host: String, port: u16, database: String, user: String, encrypted: bool, password: String },
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
    /// The connection the field belongs to.
    pub service: String,
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
        if !(1..=600).contains(&self.call_seconds) {
            return Err(Refused("a call takes 1 up to 600 seconds"));
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
        match &self.store {
            Rows::Sqlite { file } => {
                if !plain(file) {
                    return Err(Refused("the rows file is a short name with no slash"));
                }
            }
            Rows::Postgres { host, database, user, password, .. } => {
                if ![host, database, user, password].into_iter().all(|text| plain(text)) {
                    return Err(Refused("the database host, name, user and password field are short names with no slash"));
                }
                let held = self.attached.iter().any(|attached| {
                    held_name(&attached.service, &attached.field).as_deref() == Some(password.as_str())
                });
                if !held {
                    return Err(Refused("the database password is a field the run is attached"));
                }
            }
        }
        let mut descriptors = std::collections::BTreeSet::new();
        let mut fields = std::collections::BTreeSet::new();
        for attached in &self.attached {
            if attached.fd < 3 || !descriptors.insert(attached.fd) {
                return Err(Refused("an attached descriptor is 3 or more and named once"));
            }
            if !fields.insert((attached.service.as_str(), attached.field.as_str())) {
                return Err(Refused("an attached field is named once"));
            }
        }
        Ok(())
    }
}
