//! The numbers and words of the account files' byte release, name retirement and results.
//!
//! Numbers are `settings.json`, words are `words.json` (docs/PRINCIPLES.md rule 6), each read and checked once per
//! process. The numbers are the old trillion values (each module's contract in ports/): the byte release's settings
//! (`release`, ports/account-files-byte-release.json), the set-aside sweep's `items_per_request` (`retire`), the
//! results module's constants :38-57 (`results`, ports/account-files-results.json).

use serde::Deserialize;
use std::{collections::BTreeMap, sync::OnceLock};

const SETTINGS: &[u8] = include_bytes!("settings.json");
const WORDS: &[u8] = include_bytes!("words.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    pub read: Read,
    pub release: Release,
    pub retire: Retire,
    pub results: Results,
    pub chunks: Chunks,
    pub chunk_copies: super::chunk_copies::Settings,
    pub transfer: Transfer,
    pub described: Described,
    pub new_account_files: NewAccountFilesSettings,
    pub media_type: super::media_type::MediaTypes,
}

/// The chunk size of a known-length upload (`chunks-v1`, paged_spans.rs): the most bytes one stored chunk holds.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Chunks {
    pub bytes: u64,
}

/// How the described chunks of a growing upload are kept (`write_described_spans`) and how long an upload may stay open
/// (`expire_abandoned_upload`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Described {
    pub spans_per_page: u64,
    pub open_upload_expiry_days: u64,
}

/// How long a store request may wait for progress (`idle_seconds`, per socket read or write) and how long a stream call
/// may take in all (`outer_cap_seconds`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transfer {
    pub idle_seconds: u64,
    pub outer_cap_seconds: u64,
}

/// The response metadata room held aside when a read's answer is fit to its transport.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Read {
    pub response_metadata_reserve_bytes: usize,
}

/// The names and bound of the first byte store a computer gives a new account (bind.rs `make_new`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewAccountFilesSettings {
    pub origin_id: String,
    pub rank: u32,
    pub secret_service: String,
    pub secret_field: String,
}

/// The byte release (old trillion's byte release settings, ports/account-files-byte-release.json).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Release {
    pub candidates_per_page: usize,
    pub keys_per_page: usize,
    pub claim_walk: usize,
    pub recorded_margin_seconds: u64,
    pub claim_stale_minutes: u64,
}

/// Retiring names (old trillion's set-aside sweep settings, `items_per_request`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Retire {
    pub items_per_request: usize,
}

/// The results kept about files (old trillion's results module :38-57, ports/account-files-results.json).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Results {
    pub max_value_bytes: usize,
    pub page_bytes: usize,
    pub default_page_limit: usize,
    pub max_page_limit: usize,
    pub max_write: usize,
    pub max_many: usize,
    pub fields_most: usize,
    pub produced_by_chars: usize,
    pub reads_at_once_per_caller: usize,
    pub read_counts_for_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Words {
    #[serde(rename = "_what")]
    _what: String,
    words: BTreeMap<String, String>,
}

impl Settings {
    fn valid(&self) -> bool {
        let page = 1..=crate::store::MAX_PAGE_ITEMS;
        self.read.response_metadata_reserve_bytes > 0
            && self.read.response_metadata_reserve_bytes < crate::mcp::MAX_MESSAGE_BYTES
            && page.contains(&self.release.candidates_per_page)
            && page.contains(&self.release.keys_per_page)
            && page.contains(&self.release.claim_walk)
            && self.release.claim_stale_minutes > 0
            && self.retire.items_per_request > 0
            && self.media_type.valid()
            && self.results.max_value_bytes > 0
            && self.results.page_bytes >= self.results.max_value_bytes
            && (1..=self.results.max_page_limit).contains(&self.results.default_page_limit)
            && page.contains(&self.results.max_page_limit)
            && page.contains(&self.results.max_many)
            && self.results.max_write > 0
            && self.results.fields_most > 0
            && self.results.reads_at_once_per_caller > 0
            && (content_crypto::subtree::SUBTREE_BYTES as u64..=super::objects::MAX_RANGE_BYTES).contains(&self.chunks.bytes)
            && self.transfer.idle_seconds > 0
            && self.transfer.outer_cap_seconds >= self.transfer.idle_seconds
            && (1..=4096).contains(&self.described.spans_per_page)
            && self.described.open_upload_expiry_days > 0
    }
}

/// The deadline of one account files call: a stream call (one whose input carries a piece's bytes, `content_base64` or
/// `content_file`, or asks a `raw` span, written on as it comes) gets the outer cap, because its store request is bounded by
/// progress (`idle`) and not by a total; any other call keeps `base` from its start.
pub fn call_deadline(started: std::time::Instant, base: std::time::Duration, input: &serde_json::Value) -> std::time::Instant {
    if input.get("content_base64").is_some() || input.get("content_file").is_some() || input.get("raw") == Some(&serde_json::Value::Bool(true)) {
        stream_deadline(started)
    } else {
        started + base
    }
}

/// The outer cap of a stream call (DATA `transfer.outer_cap_seconds`): the most time it may take in all.
pub fn stream_deadline(started: std::time::Instant) -> std::time::Instant {
    started + std::time::Duration::from_secs(settings().transfer.outer_cap_seconds)
}

/// The longest one store socket read or write may wait for progress (DATA `transfer.idle_seconds`).
pub fn idle() -> std::time::Duration {
    std::time::Duration::from_secs(settings().transfer.idle_seconds)
}

/// The shipped numbers. A file that does not read, or holds a number outside its bound, stops the process at its
/// first use: shipped DATA is checked by this module's tests.
pub fn settings() -> &'static Settings {
    static SHIPPED: OnceLock<Settings> = OnceLock::new();
    SHIPPED.get_or_init(|| {
        let settings: Settings = serde_json::from_slice(SETTINGS).expect("src/account_files/settings.json reads");
        assert!(settings.valid(), "src/account_files/settings.json holds a number outside its bound");
        settings
    })
}

/// The words said for `key` (`words.json`); the key itself when the file names none, so a missing word is visible.
pub fn word(key: &'static str) -> &'static str {
    static SHIPPED: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    let words = SHIPPED.get_or_init(|| serde_json::from_slice::<Words>(WORDS).map(|words| words.words).unwrap_or_default());
    words.get(key).map_or(key, String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_numbers_and_words_read_and_hold_inside_their_bounds() {
        assert!(settings().valid());
        let words: Words = serde_json::from_slice(WORDS).unwrap();
        assert!(words.words.values().all(|said| !said.is_empty()));
        assert_eq!(word("retire_once"), "Retire each name once.");
        assert_eq!(word("no_such_word"), "no_such_word");
    }

    /// A stream call gets the outer cap and every other call its base; the idle bound is DATA's.
    #[test]
    fn a_stream_call_gets_the_outer_cap_and_other_calls_the_base() {
        let started = std::time::Instant::now();
        let base = std::time::Duration::from_secs(5);
        assert_eq!(stream_deadline(started), started + std::time::Duration::from_secs(settings().transfer.outer_cap_seconds));
        let piece = serde_json::json!({"content_base64": "AAAA"});
        assert_eq!(call_deadline(started, base, &piece), stream_deadline(started));
        for stream in [serde_json::json!({"content_file": {"path": "p", "length": 1}}), serde_json::json!({"raw": true})] {
            assert_eq!(call_deadline(started, base, &stream), stream_deadline(started));
        }
        assert_eq!(call_deadline(started, base, &serde_json::json!({"raw": false})), started + base);
        assert_eq!(call_deadline(started, base, &serde_json::json!({"name": "/a"})), started + base);
        assert!(idle() < std::time::Duration::from_secs(settings().transfer.outer_cap_seconds));
    }
}
