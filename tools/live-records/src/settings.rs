// src/settings.rs
//
// Purpose: What one run of the records tool reads once from its settings file (`settings.json` of the tool folder, or the file the run
// is told): where the person's rows are kept (a SQLite file in the state folder, or the person's Postgres database), which scope of
// those rows keeps each thing (records, workspace labels, write receipts), which fields of which connections the engine attached on which
// file descriptor, and the bounds of the door's contract.
//
// Non-Negotiable Invariants:
// - No value of the connection is in this file: it names fields and descriptors only.
// - A file that holds a field it does not know, a bound that is zero or out of order, or a descriptor that cannot be used, is refused
//   before anything starts.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path};

/// The most bytes a settings file may hold.
const MOST_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    /// Where the person's rows are kept.
    pub store: Rows,
    /// The fields of the connections and the descriptor each is attached on.
    pub attached: Vec<Attached>,
    pub scopes: Scopes,
    /// The fields the engine adds to a call's arguments.
    pub call_fields: CallFields,
    /// The door address a search result's `address` names.
    pub address: String,
    /// The top-level text fields a search result shows as its title.
    pub title_fields: Vec<String>,
    pub bounds: Bounds,
    #[serde(rename = "bounds_why")]
    bounds_why: std::collections::BTreeMap<String, String>,
}

/// Where the person's rows are kept.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase", deny_unknown_fields)]
pub enum Rows {
    /// A SQLite file of this name in the state folder (the first run makes it).
    Sqlite { file: String },
    /// The person's Postgres database; `connection` is the held name of the attached field that holds its connection string.
    Postgres { connection: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attached {
    pub service: String,
    pub field: String,
    pub fd: i32,
}

impl Attached {
    /// The held name of the field: `<service>-<field>`.
    pub fn name(&self) -> String {
        format!("{}-{}", self.service, self.field)
    }
}

/// The names of the fields the engine adds to a call's arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallFields {
    /// Holds the call's request key.
    pub request_key: String,
    /// Holds where the next byte page of an answer starts.
    pub after_byte: String,
}

/// The scopes of the rows each thing is kept in.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scopes {
    /// A record of type T is a row of the scope `<records>T`.
    pub records: String,
    /// The workspace labels, one row each.
    pub workspace: String,
    /// The write receipts, one row for each request key.
    pub receipts: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    pub answer_bytes: usize,
    pub message_bytes: usize,
    pub byte_page_bytes: usize,
    pub list_page: usize,
    pub list_most: usize,
    pub list_walk: usize,
    pub where_walk_most: usize,
    pub walk_seconds: u64,
    pub names_most: usize,
    pub writes_most: usize,
    pub labels_most: usize,
    pub request_key_bytes: usize,
    pub id_bytes: usize,
    pub name_bytes: usize,
    pub search_limit: usize,
    pub search_most: usize,
    pub search_question_chars: usize,
    pub search_min_word_length: usize,
    pub search_said_characters: usize,
    pub search_candidates: usize,
    pub search_k: usize,
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
                if !self.attached.iter().any(|attached| attached.name() == *connection) {
                    return Err(Refused("the database connection is a field the run is attached"));
                }
            }
        }
        let (mut descriptors, mut fields) = (BTreeSet::new(), BTreeSet::new());
        for attached in &self.attached {
            if attached.fd < 3 || !descriptors.insert(attached.fd) {
                return Err(Refused("an attached descriptor is 3 or more and named once"));
            }
            if !fields.insert((attached.service.as_str(), attached.field.as_str())) {
                return Err(Refused("an attached field is named once"));
            }
        }
        let scopes = &self.scopes;
        if scopes.records.is_empty() || !scopes.records.ends_with('/') || [&scopes.workspace, &scopes.receipts].iter().any(|scope| scope.is_empty())
            || scopes.workspace == scopes.receipts
            || scopes.workspace.starts_with(&scopes.records) || scopes.receipts.starts_with(&scopes.records) {
            return Err(Refused("the scopes are three names: records ends with a slash and no other starts with it"));
        }
        let fields = &self.call_fields;
        if fields.request_key.is_empty() || fields.after_byte.is_empty() || fields.request_key == fields.after_byte {
            return Err(Refused("the two call fields are named, and differently"));
        }
        if self.address.is_empty() || self.title_fields.is_empty() {
            return Err(Refused("an address and the title fields are named"));
        }
        let bounds = &self.bounds;
        let numbers = [bounds.answer_bytes, bounds.message_bytes, bounds.byte_page_bytes, bounds.list_page, bounds.list_most, bounds.list_walk, bounds.where_walk_most,
            bounds.walk_seconds as usize, bounds.names_most, bounds.writes_most, bounds.labels_most, bounds.request_key_bytes, bounds.id_bytes,
            bounds.name_bytes, bounds.search_limit, bounds.search_most, bounds.search_question_chars, bounds.search_min_word_length,
            bounds.search_said_characters, bounds.search_candidates, bounds.search_k];
        if numbers.contains(&0) || bounds.byte_page_bytes / 3 * 4 + 1024 > bounds.answer_bytes || bounds.list_page > bounds.list_most
            || bounds.list_walk > rows_store::store::MAX_PAGE_ITEMS || bounds.search_limit > bounds.search_most {
            return Err(Refused("a bound is zero or out of order"));
        }
        let named: BTreeSet<&str> = self.bounds_why.keys().map(String::as_str).collect();
        let spelled = serde_json::to_value(&self.bounds).map_err(|_| Refused("the bounds do not name themselves"))?;
        let spelled: BTreeSet<&str> = spelled.as_object().map(|object| object.keys().map(String::as_str).collect()).unwrap_or_default();
        if named != spelled {
            return Err(Refused("each bound carries its why, and no why is left over"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_settings_name_the_persons_postgres_by_its_held_connection_and_every_bound_says_why() {
        let settings = Settings::read(Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/settings.json"))).unwrap();
        assert!(matches!(&settings.store, Rows::Postgres { connection } if connection == "own-rows-postgres-connection"));
        assert!(settings.attached.iter().any(|attached| attached.service == "own-rows-postgres" && attached.field == "connection" && attached.fd == 8));
    }

    #[test]
    fn a_bound_without_its_why_or_out_of_order_is_refused() {
        let mut text: serde_json::Value = serde_json::from_slice(&std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/settings.json")).unwrap()).unwrap();
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("settings.json");
        text["bounds_why"].as_object_mut().unwrap().remove("list_walk");
        std::fs::write(&file, text.to_string()).unwrap();
        assert!(Settings::read(&file).is_err());
        text["bounds_why"]["list_walk"] = "why".into();
        text["bounds"]["byte_page_bytes"] = 47000.into();
        std::fs::write(&file, text.to_string()).unwrap();
        assert!(Settings::read(&file).is_err());
    }
}
