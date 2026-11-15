// src/storage/record_store/search.rs
//
// Purpose: The search port of the record store: its layout DATA (`settings.json` `search`) and how a record value becomes
// terms. The shipped layout is `segments` (the engine is `segments.rs`): changes wait in a memory tail at 0 rows per
// write; a write persists the tail as one packed segment once it holds `flush_records` records or its oldest change is
// `flush_seconds` old; full levels of `fan_in` segments are merged into the next level by idle upkeep in resumable steps of
// about `merge_bytes` (`segments.rs` `search_merge`), never inside a write.
//
// Non-Negotiable Invariants:
// - A term is (declared top-level text field, lowercased alphanumeric word); a record's terms are distinct.
// - A value that keeps its own fields as JSON text in the declared `within` field (the native seam's body,
//   `native.rs` `body`: `stored`) is searched by the fields of that text, the way an order reads `["stored", field]`.
// - With `every_text` declared, every top-level text field of the value (and each text of a list of texts) also gives
//   its words under that one field name, so a list row's own fields (named by its list, never here) are found too. A
//   sealed field is an object (`record_sealed`), never text, so no sealed word is ever a term.
// - Every bound of the layout is positive and `fan_in` is at least 2.
// - Every persisted segment names the terms rule it was built under (`Layout::rule`): the declared fields, `within`,
//   `every_text` and `WORDS` (how `words` splits a text). A segment built under another rule (or before segments named
//   one) is stale: it is never read, and the scope's search walk indexes its rows again under the current rule a bounded
//   page at a time (`segments.rs` `search_walk`), so changing the rule needs no operator step and misses no row written
//   before the change once the walk is done (the answer names the lane pending until then).
//
// Key Concepts:
// - Measured choice (simulation search-receipt report, October 27-28, 2026: "daily segments", 256 records or one day,
//   64 KiB parts, fan-in 4): +0.11 rows per create and +0 per edit above the floor, about 18 rows read per search, and
//   a bounded cold start (the unflushed tail), against +1 row per save and a read of every record per search for one
//   packed term row per record.
//
// Security Considerations:
// - Terms come from the record's own current value and live under the same account/resource scope; erasure removes
//   them (`segments.rs`).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

/// (declared field, word).
pub type Term = (String, String);

/// The search layout, as declared in the settings DATA.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "layout", rename_all = "snake_case", deny_unknown_fields)]
pub enum Layout {
    /// A memory tail persisted as packed segments inside writes (`segments.rs`).
    Segments {
        /// The top-level text fields searched.
        fields: Vec<String>,
        /// Records in the tail that make the next write persist it.
        flush_records: usize,
        /// Age of the oldest tail change that makes the next write persist it.
        flush_seconds: u64,
        /// Target encoded bytes of one part (one row of a segment).
        part_bytes: usize,
        /// Segments of one level merged into one of the next level.
        fan_in: usize,
        /// The field holding the value's own fields as JSON text (the native seam's `stored`), when it has one.
        #[serde(default)]
        within: Option<String>,
        /// The field name every top-level text of the value is searched under, when declared.
        #[serde(default)]
        every_text: Option<String>,
        /// Records one step of the search walk reads (`segments.rs` `search_walk`): the walk that indexes the rows a
        /// scope held before its index (or before its current terms rule, `rule`) existed, a bounded page at a time.
        walk_rows: usize,
        /// Bytes of input parts one merge step reads (`segments.rs` `search_merge`, old trillion record-log-store.mjs
        /// MERGE_STEP_BYTES, 4 MiB): a merge of any size runs in idle upkeep as resumable steps of about this many
        /// bytes, each committed alone, never inside a write.
        merge_bytes: usize,
    },
}

/// The version of `words`: raise it whenever `words` (or how `terms` reads a value) changes, so every segment built
/// before is rebuilt (`Layout::rule`).
pub const WORDS: u32 = 1;

impl Layout {
    /// The terms rule a segment is built under: what makes a value's terms, and nothing that only paces flushes or
    /// merges (those may change without making any segment stale).
    pub fn rule(&self) -> String {
        let Self::Segments { fields, within, every_text, .. } = self;
        serde_json::json!({ "fields": fields, "within": within, "every_text": every_text, "words": WORDS }).to_string()
    }

    pub fn valid(&self) -> bool {
        let Self::Segments { fields, flush_records, flush_seconds, part_bytes, fan_in, within, every_text, walk_rows, merge_bytes } = self;
        !fields.is_empty()
            && fields.iter().all(|field| !field.is_empty())
            && within.as_deref().is_none_or(|within| !within.is_empty())
            && every_text.as_deref().is_none_or(|every| !every.is_empty() && !fields.iter().any(|field| field == every))
            && *flush_records > 0
            && *flush_seconds > 0
            && *part_bytes > 0
            && *fan_in >= 2
            && (1..=crate::records::MAX_PAGE_ITEMS).contains(walk_rows)
            && *merge_bytes > 0
    }

    /// Bytes of input parts one merge step reads (`merge_bytes`).
    pub fn merge_bytes(&self) -> usize {
        let Self::Segments { merge_bytes, .. } = self;
        *merge_bytes
    }

    /// Records one search walk step reads (`walk_rows`).
    pub fn walk_rows(&self) -> usize {
        let Self::Segments { walk_rows, .. } = self;
        *walk_rows
    }


    /// The one field that holds every text's words, when declared: a search of any word asks only it.
    pub fn every_text(&self) -> Option<&str> {
        let Self::Segments { every_text, .. } = self;
        every_text.as_deref()
    }

    /// The fields a search may name: the declared ones, then `every_text` when declared.
    pub fn fields(&self) -> Vec<String> {
        let Self::Segments { fields, every_text, .. } = self;
        fields.iter().chain(every_text).cloned().collect()
    }

    /// The distinct terms of a record value: its own fields, read from the `within` text when it keeps them there.
    pub fn terms(&self, value: &Value) -> BTreeSet<Term> {
        let Self::Segments { fields, within, every_text, .. } = self;
        let inner = within
            .as_deref()
            .and_then(|within| value.get(within))
            .and_then(Value::as_str)
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .filter(Value::is_object);
        let held = inner.as_ref().unwrap_or(value);
        let mut terms = BTreeSet::new();
        for field in fields {
            let Some(text) = held.get(field).and_then(Value::as_str) else { continue };
            terms.extend(words(text).map(|word| (field.clone(), word)));
        }
        if let (Some(every), Some(object)) = (every_text, held.as_object()) {
            for item in object.values() {
                let texts: Vec<&str> = match item {
                    Value::String(text) => vec![text.as_str()],
                    Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
                    _ => Vec::new(),
                };
                for text in texts {
                    terms.extend(words(text).map(|word| (every.clone(), word)));
                }
            }
        }
        terms
    }
}

/// Lowercased alphanumeric words of a text.
pub fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric()).filter(|word| !word.is_empty()).map(str::to_lowercase)
}
