// src/native_entry/module_computer/lib.rs
//
// Purpose: the entry of a computer whose host runs trillion-local as a WebAssembly module (wasm32-unknown-unknown) and gives
// each object its own durable SQL storage. One object holds one account: trillion-local's record store over that object's
// SQL storage (src/storage/hosted_sql.rs behind the one storage seam), the account's placement row as this computer last
// took it, and the routes below, all under `/a/<address>/`. Like every computer it is described only by what it reports
// (`report`); nothing in trillion-local knows what kind of machine this is. The old app kept every account the same way,
// one stored object per person over its own SQL storage (old trillion src/stored-object.mjs and the old host adapter's
// resource-host.mjs, which turned an address into one object by its name: `idFromName(key)`); `object_for` does the
// same here.
//
// Non-Negotiable Invariants:
// - Operations are trillion-local's own; this file is only their transport. A read is `Records::get`/`list_page` on this
//   computer's own copy; a write is `Records::mutate`, answered only while this computer is the writer the placement row names;
//   following is `RecordStore::apply_page_whole` on pages of the writer's feed (`carried_page`, `history_page`).
// - Moving, backup and failover are one path: the row names a writer and copy_keepers; a copy keeper catches up from the
//   writer's feed; moving the writer is one row edit. A row edit is a compare-and-set on its revision, and the revision
//   is the writer term every page is sent under, so a copy refuses a page from a writer the row no longer names.
// - A write this computer answers is on this computer's own copy before the answer leaves (the record store's own commit).
// - trillion-local's clock and randomness are the host's (src/storage/hosted_sql.rs `now_ms`, `fill_random`).
// - Numbers are in settings.json, words in words.json.
//
// Gaps, named and not hidden:
// - The placement row here is the row as the account's owner sends it, unsigned. Stage 1's row is signed by the
//   account's Ed25519 key (src/account/computers.rs); its check needs the sign-in modules, which do not build here yet.
// - A whole computer joins an account over its forwarder session (src/native_entry/computer/join.rs); this computer takes
//   the row over its own route instead, because the forwarder session needs tokio sockets and TLS this target lacks.
// - The writer's acknowledgement here is the record store's commit on the writer plus the copy keeper's pull; the
//   push-before-commit of src/account/computers/copies.rs is not ported to this computer.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

#![cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), allow(dead_code))]

/// trillion-local's own source tree (src/), so its files keep their own paths and `crate::storage`, `crate::records`,
/// `crate::record_sealed`, `crate::resource_authority` and `crate::ecma_json` name what they name there.
#[path = "../.."]
mod trillion {
    pub mod ecma_json;
    pub mod record_sealed;
    pub mod records;
    pub mod resource_authority;
    pub mod storage;
}
pub use trillion::{ecma_json, record_sealed, records, resource_authority, storage};
#[path = "../../mcp/cause.rs"]
pub mod refusal_cause;
#[path = "../../mcp/foreign_storage_causes.rs"]
mod foreign_storage_causes;
pub mod host_clock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod host;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod object;

/// The numbers of this computer (settings.json).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub about: String,
    pub storage_bytes: u64,
    pub max_record_bytes: usize,
    pub cost_per_month_cents: u64,
    pub follow_page: usize,
    pub follow_pages_per_request: usize,
    pub list_page: usize,
}

pub fn settings() -> &'static Settings {
    static LOADED: std::sync::OnceLock<Settings> = std::sync::OnceLock::new();
    LOADED.get_or_init(|| serde_json::from_str(include_str!("settings.json")).expect("settings.json is this computer's numbers"))
}

/// The words of this computer (words.json).
pub fn word(name: &str) -> String {
    static LOADED: std::sync::OnceLock<BTreeMap<String, String>> = std::sync::OnceLock::new();
    LOADED
        .get_or_init(|| serde_json::from_str(include_str!("words.json")).expect("words.json is this computer's words"))
        .get(name)
        .cloned()
        .unwrap_or_else(|| name.to_owned())
}

/// The computers that keep and answer for one account, as this computer last took it: the writer, the copy_keepers, and how
/// each computer is reached. `revision` only moves up, by one, and is the writer's term.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    pub revision: u64,
    pub writer: String,
    #[serde(default)]
    pub copy_keepers: Vec<String>,
    /// Each named computer's reach (the base its routes answer under).
    pub computers: BTreeMap<String, String>,
}
impl Placement {
    /// Whether this row names `computer` as holding the account.
    pub fn holds(&self, computer: &str) -> bool {
        self.writer == computer || self.copy_keepers.iter().any(|one| one == computer)
    }
    /// Whether this row is well formed: every named computer has a reach, and the writer is not also a copy keeper.
    pub fn valid(&self) -> bool {
        self.revision > 0
            && self.computers.contains_key(&self.writer)
            && self.copy_keepers.iter().all(|one| self.computers.contains_key(one) && one != &self.writer)
    }
}

/// An edit of the placement row: compare-and-set on `expected_revision` (0 for the first row).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlacementEdit {
    pub expected_revision: u64,
    pub row: Placement,
}

/// Whether `edit` may replace `held`: the revision moves up by exactly one from the one the edit names.
pub fn edit_allowed(held: Option<&Placement>, edit: &PlacementEdit) -> bool {
    let current = held.map_or(0, |row| row.revision);
    edit.expected_revision == current && edit.row.revision == current + 1 && edit.row.valid()
}

/// This computer's report, as every computer reports itself (src/account/computers.rs `ComputerReport`): its storage, its
/// reach, what it costs, whether it runs contained tools, whether it is on all the time and whether it takes new
/// accounts. It runs no tools and takes no sign-ups.
pub fn report(reach: &str, always_on: Option<bool>) -> Value {
    let settings = settings();
    json!({
        "storage": { "bytes": settings.storage_bytes },
        "reach": reach,
        "cost_per_month_cents": settings.cost_per_month_cents,
        "contained_tools": false,
        "always_on": always_on,
        "takes_new_accounts": false,
    })
}

/// The route of one request: `/a/<address>/<rest...>`.
pub fn route(path: &str) -> Option<(&str, Vec<&str>)> {
    let rest = path.strip_prefix("/a/")?;
    let mut parts = rest.split('/').filter(|part| !part.is_empty());
    let address = parts.next()?;
    if address.len() > 128 || !address.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return None;
    }
    Some((address, parts.collect()))
}
