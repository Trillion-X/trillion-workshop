// src/serve/settings.rs
//
// Purpose: What one run of the Namespace tool reads once from its settings file (`settings.json` of the tool folder, or the file the
// run is told): which account the person's files are kept under, where the person's rows are kept (a SQLite file in the state folder,
// or the person's Postgres database), the folder the byte store's keys start in, and which
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

/// The address a share opens at.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Share {
    /// The https address the person's pages are served from; a share opens at `<origin>/share/<id>/<key>`.
    pub origin: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    /// The name the person's files are kept under in the rows.
    pub account: String,
    /// Where the person's rows are kept.
    pub store: Rows,
    /// The folder in the byte store that every file's key starts in: empty, or ending with a slash.
    pub key_prefix: String,
    /// How long one call may take before it answers where it stopped.
    pub call_seconds: u64,
    /// Where a share opens: the https address a share of a file is answered at. Without it `share_file` is refused.
    #[serde(default)]
    pub share: Option<Share>,
    /// The public byte route of a share (`serve-shares`): where it listens and its numbers.
    #[serde(default)]
    pub share_bytes: Option<live_namespace::share_bytes::Config>,
    /// The person's look (the `site` block every site of theirs wears: `name`, `theme`, `look_css`), laid here from their own `site`
    /// row; the share's page wears it.
    #[serde(default)]
    pub site: Option<serde_json::Value>,
    /// The fields of the connections (`files-store`: the byte store; the database's own) and the descriptor each is attached on.
    pub attached: Vec<Attached>,
}

/// Where the person's rows are kept.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase", deny_unknown_fields)]
pub enum Rows {
    /// A SQLite file of this name in the state folder (the first run makes it).
    Sqlite { file: String },
    /// The person's Postgres database. `connection` is the held name of the attached field that holds its connection string
    /// (`own-rows-postgres-connection`, the credential the person's other tools reach the same database with).
    Postgres { connection: String },
    /// The rows a session of another tool keeps (`live-namespace rows`, which holds the database login alone), reached by
    /// calls through this run's door (src/store/by_calls.rs, src/store/through_the_door.rs). `tool` is that tool's id, which
    /// the run's row names in `invoke.records.runs`; `fd` is the descriptor its row's `invoke.records.fd` names. A run that holds
    /// the byte store's key never holds the database's login this way: the engine lets one process reach only hosts every
    /// value it holds may go to.
    Run { tool: String, fd: i32 },
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
    /// The settings this program was built with (the tool folder's `settings.json`), so a run needs no file on the computer
    /// it runs on.
    pub fn shipped() -> Result<Self, Refused> {
        Self::from_bytes(include_bytes!("../../settings.json"))
    }

    /// The settings of `path`, or the shipped ones when none is named.
    pub fn read_or_shipped(path: Option<&Path>) -> Result<Self, Refused> {
        path.map_or_else(Self::shipped, Self::read)
    }

    fn from_bytes(bytes: &[u8]) -> Result<Self, Refused> {
        let settings: Self = serde_json::from_slice(bytes).map_err(|_| Refused("the settings file is not the shape this tool reads"))?;
        settings.valid()?;
        Ok(settings)
    }

    pub fn read(path: &Path) -> Result<Self, Refused> {
        use std::io::Read as _;
        let file = std::fs::File::open(path).map_err(|_| Refused("the settings file does not open"))?;
        if !file.metadata().is_ok_and(|metadata| metadata.is_file() && metadata.len() <= MOST_BYTES) {
            return Err(Refused("the settings file is not a small regular file"));
        }
        let mut bytes = Vec::new();
        file.take(MOST_BYTES).read_to_end(&mut bytes).map_err(|_| Refused("the settings file does not read"))?;
        Self::from_bytes(&bytes)
    }

    fn valid(&self) -> Result<(), Refused> {
        let plain = |text: &str| !text.is_empty() && text.len() <= 256 && !text.chars().any(char::is_control) && !text.contains('/');
        if !plain(&self.account) {
            return Err(Refused("the account is a short name with no slash"));
        }
        if !(1..=600).contains(&self.call_seconds) {
            return Err(Refused("a call takes 1 up to 600 seconds"));
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
            Rows::Postgres { connection } => {
                if !plain(connection) {
                    return Err(Refused("the database connection is a short held name with no slash"));
                }
                let held = self.attached.iter().any(|attached| {
                    held_name(&attached.service, &attached.field).as_deref() == Some(connection.as_str())
                });
                if !held {
                    return Err(Refused("the database connection is a field the run is attached"));
                }
            }
            Rows::Run { tool, fd } => {
                if tool.is_empty() || tool.len() > 256 || tool.chars().any(|c| c.is_control() || c.is_whitespace()) {
                    return Err(Refused("the tool that keeps the names is a short id"));
                }
                if *fd < 3 || self.attached.iter().any(|attached| attached.fd == *fd) {
                    return Err(Refused("the door's descriptor is 3 or more and no attached field's"));
                }
            }
        }
        if let Some(share) = &self.share {
            if !(share.origin.starts_with("https://") && url::Url::parse(&share.origin).is_ok_and(|url| url.host().is_some() && url.username().is_empty() && url.query().is_none() && url.fragment().is_none())) {
                return Err(Refused("the share's origin is an https address"));
            }
        }
        if let Some(route) = &self.share_bytes {
            route.check().map_err(Refused)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_settings_reach_the_names_through_the_tool_that_holds_the_login_and_attach_no_login() {
        let settings = Settings::shipped().unwrap();
        assert!(matches!(&settings.store, Rows::Run { tool, fd } if tool == "tool:your-files-names" && *fd == 9));
        assert!(settings.attached.iter().all(|attached| attached.service == "files-store"), "the files run holds the byte store's fields alone");
    }
}
