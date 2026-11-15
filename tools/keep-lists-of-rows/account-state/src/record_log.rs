//! Purpose: the compact grouped record-envelope journal over supplied SQLite
//! and kept-runs pages, sourced from record-log-store/record-requests.
//! Invariants: journal + current-record publication + retry state share the actual
//! transaction; no-op records append only a kept request result, no business
//! envelopes; rollback invalidates all
//! current-record memory; incomplete multipart replay never advances its checkpoint.
//! Key concepts: delta/prior envelopes, original identity, field-stamp joins,
//! bounded replay and packed current-record keys. This is a concrete storage supply,
//! not a universal SQLite requirement or a replacement for EEAF/model policy.
//! Security: injected fresh rights/model/sealing/erasure admission is mandatory;
//! keys never enter envelopes, no original database is automatically adopted,
//! and uncertain failures retain the original request identity for retry.

use crate::{
    kept_runs::{self, KeptRuns, Lookup, ReadBudget, Settings},
    storage::record_store::digest::Sums,
    record_stamps::{self as stamps, Envelope, EnvelopeBody, Fields, Kept, Meta, StampMap},
};
use content_crypto::advanced::blake3;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

pub mod original_setting;

pub const MAX_BATCH_RECORDS: usize = 256;
pub const MAX_BATCH_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_JOURNAL_BYTES: usize = 32 * 1024 * 1024;
pub const LOG_ROW_BYTES: usize = 512 * 1024;
pub const REQUEST_WINDOW_MS: i64 = 10 * 60 * 1000;
pub const MAX_REQUEST_KEYS: usize = 10_000;
const KEYS: &str = "record_keys";
const SEP: &str = "\0";

pub enum Error {
    Sql(rusqlite::Error, crate::refusal_cause::Cause),
    Kept(kept_runs::Error, crate::refusal_cause::Cause),
    Json(serde_json::Error, crate::refusal_cause::Cause),
    Invalid(&'static str, crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Refused(crate::refusal_cause::Cause),
    Conflict(crate::refusal_cause::Cause),
    StaleRequest(crate::refusal_cause::Cause),
    Corrupt(crate::refusal_cause::Cause),
    ReplayRequired(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Bounds(cause) => cause,
            Self::Conflict(cause) => cause,
            Self::Corrupt(cause) => cause,
            Self::Invalid(_, cause) => cause,
            Self::Json(_, cause) => cause,
            Self::Kept(_, cause) => cause,
            Self::Refused(cause) => cause,
            Self::ReplayRequired(cause) => cause,
            Self::Sql(_, cause) => cause,
            Self::StaleRequest(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);
impl From<rusqlite::Error> for Error {
    #[track_caller]
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e, crate::cause!(caller_site: Self::Sql))
    }
}
impl From<kept_runs::Error> for Error {
    fn from(e: kept_runs::Error) -> Self {
        { let cause = e.cause(); Self::Kept(e, cause) }
    }
}
impl From<serde_json::Error> for Error {
    #[track_caller]
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e, crate::cause!(caller_site: Self::Json))
    }
}
impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The underlying error's own text stays beside the cause; a cause never replaces it.
        let mut out = f.debug_struct("RecordLogError");
        match self {
            Self::Sql(source, _) => { out.field("source", source); }
            Self::Kept(source, _) => { out.field("source", source); }
            Self::Json(source, _) => { out.field("source", source); }
            _ => {}
        }
        out.field("cause", &self.cause()).finish()
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} cause={}", match self {
            Self::Sql(_, _) | Self::Kept(_, _) => {
                "record outcome unknown; preserve original request identity"
            }
            Self::Json(_, _) => "record encoding refused",
            Self::Invalid(s, _) => s,
            Self::Bounds(_) => "record journal work bound exceeded",
            Self::Refused(_) => "record operation not currently admitted",
            Self::Conflict(_) => "record request identity conflicts",
            Self::StaleRequest(_) => "request predates retained coverage; reread before new work",
            Self::Corrupt(_) => "record journal/projection is inconsistent",
            Self::ReplayRequired(_) => "bounded journal replay needs continuation",
        }, self.cause())
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Scope {
    pub account: String,
    pub resource: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordInput {
    pub id: String,
    /// The kind a put writes. `RecordLog::write` does not need it on a removal:
    /// the stored record supplies its own kind, and the request identity of a
    /// removal is its id alone, whatever label it carries.
    pub record_type: String,
    /// None removes; Some(empty) retains an empty object.
    pub value: Option<Fields>,
}
impl RecordInput {
    /// Removal named by id alone. A client that lost the reply to a removal can
    /// always build it again, because it never needs the record it removed.
    pub fn remove(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            record_type: String::new(),
            value: None,
        }
    }
}
/// What a record input changes, as the request identity sees it: a put is its
/// id, kind and value; a removal is its id only.
#[derive(Serialize)]
struct Change<'a> {
    id: &'a str,
    record_type: &'a str,
    value: &'a Option<Fields>,
}
impl<'a> From<&'a RecordInput> for Change<'a> {
    fn from(r: &'a RecordInput) -> Self {
        Self {
            id: &r.id,
            record_type: if r.value.is_some() { &r.record_type } else { "" },
            value: &r.value,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub key: String,
    pub sent_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Context {
    pub actor: Value,
    pub application_time: String,
    pub system_time: String,
    pub accepted_at_ms: i64,
}
/// Host-owned exact original JSON value text for source tie/equality semantics.
/// There is no implicit serde-vs-JavaScript byte compatibility assertion.
pub trait ValueText {
    fn encode(&self, value: &Value) -> Result<String>;
}
/// Synchronous authoritative policy inside the transaction. validate_prepared
/// must verify the actual final group model, required sealed fields, shared
/// ownership and erasure state; these are not supplied by a fixture boolean.
pub trait Admission {
    fn assert_current(&self, scope: &Scope, request: &Request, input_identity: &str) -> bool;
    fn validate_prepared(
        &self,
        scope: &Scope,
        records: &[RecordInput],
        before: &BTreeMap<String, Option<Projected>>,
    ) -> bool;
}
pub trait LogIds {
    fn next_log_id(&mut self) -> Option<String>;
}
mod canonical_ids;
pub(crate) use canonical_ids::CanonicalLogIds;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Projected {
    pub sequence: Option<String>,
    pub kept: Kept,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Receipt {
    pub transaction_id: String,
    pub written: Vec<String>,
    pub previous_types: BTreeMap<String, Option<String>>,
    pub log_id: Option<String>,
}
#[derive(Debug, Default, Clone, Serialize)]
pub struct Work {
    pub journal_sql_statements: u64,
    pub journal_rows_read: u64,
    pub journal_rows_appended: u64,
    pub request_only_rows_appended: u64,
    pub business_envelopes_appended: usize,
    /// SQLite total_changes delta for this successful transaction. Counts user
    /// table rows, including trigger/FK effects; excludes index/page writes and
    /// is neither a provider invoice nor a physical disk-write measurement.
    pub sqlite_user_rows_changed: u64,
    /// Subset spent by normal page/checkpoint publication, including its
    /// catalogue/filter/large-value rows, not just its payload pages.
    pub checkpoint_user_rows_changed: u64,
    pub logical_projection_updates: u64,
    pub flush_pages: usize,
    pub flush_keys: usize,
    pub pending_memtable_bytes_before: usize,
    pub pending_memtable_bytes_after: usize,
    pub selected: kept_runs::Work,
    /// This write's bounded share of merging kept runs (no alarm ever merges).
    pub maintenance: kept_runs::Maintained,
    /// SQLite total_changes spent by that share, including a refused step's.
    pub maintenance_user_rows_changed: u64,
    /// A merge step that failed is rolled back to its savepoint and named here;
    /// the save itself still commits. Debt waits for the next write.
    pub maintenance_refused: Option<String>,
    /// How many times a native command witnessed its sources in full (state lock, record book, the admitter's current
    /// rights, the selection): at the boundaries of its transaction, never per step or per record.
    pub source_witnesses: u64,
}
#[derive(Debug, Serialize)]
pub struct CheckpointResult {
    pub flush: kept_runs::Flush,
    pub sqlite_user_rows_changed: u64,
}
#[derive(Debug, Serialize)]
pub struct WriteResult {
    pub receipt: Receipt,
    pub duplicate: bool,
    pub work: Work,
}
#[derive(Debug, Serialize)]
pub struct ReadResult {
    pub record: Option<Projected>,
    pub work: Work,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Retried {
    identity: String,
    accepted_at_ms: i64,
    receipt: Receipt,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RequestChange {
    key: String,
    entry: Retried,
    removed: Vec<(String, Option<String>)>,
    checked_from: i64,
    count: usize,
    /// The greatest request-time key removed in window order. Every lower one
    /// is removed too, so the next save's window range starts after it and
    /// never walks the tombstones of requests that left the window. Journals
    /// written before this field replay with none (the range starts at "u\0").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    head: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prior {
    #[serde(rename = "type")]
    pub record_type: String,
    pub value: Fields,
}
#[derive(Debug, Clone)]
pub struct HistoryEnvelope {
    pub envelope: Envelope,
    pub prior: Option<Option<Prior>>,
    pub was: Option<Fields>,
    pub added: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireEnvelope {
    id: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    record_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<Fields>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    set: Option<Fields>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    unset: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    remove: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    floor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    floor_kind: Option<stamps::FloorKind>,
    #[serde(default, skip_serializing_if = "StampMap::is_empty")]
    stamps: StampMap,
    #[serde(default, skip_serializing_if = "StampMap::is_empty")]
    removed: StampMap,
    #[serde(
        default,
        deserialize_with = "present_prior",
        skip_serializing_if = "Option::is_none"
    )]
    prior: Option<Option<Prior>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    was: Option<Fields>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    added: Vec<String>,
}
fn is_false(value: &bool) -> bool {
    !*value
}
fn present_prior<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Option<Prior>>, D::Error> {
    Ok(Some(Option::<Prior>::deserialize(d)?))
}
impl Serialize for HistoryEnvelope {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let (value, set, unset, remove) = match &self.envelope.body {
            EnvelopeBody::Whole(v) => (Some(v.clone()), None, Vec::new(), false),
            EnvelopeBody::Patch { set, unset } => (
                None,
                (!set.is_empty()).then(|| set.clone()),
                unset.clone(),
                false,
            ),
            EnvelopeBody::Remove => (None, None, Vec::new(), true),
        };
        WireEnvelope {
            id: self.envelope.id.clone(),
            record_type: (!remove)
                .then(|| self.envelope.record_type.clone())
                .flatten(),
            value,
            set,
            unset,
            remove,
            at: self.envelope.at.clone(),
            floor: self.envelope.floor.clone(),
            floor_kind: self.envelope.floor_kind,
            stamps: self.envelope.stamps.clone(),
            removed: self.envelope.removed.clone(),
            prior: self.prior.clone(),
            was: self.was.clone(),
            added: self.added.clone(),
        }
        .serialize(s)
    }
}
impl<'de> Deserialize<'de> for HistoryEnvelope {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let wire = WireEnvelope::deserialize(d)?;
        if (wire.remove && (wire.value.is_some() || wire.set.is_some() || !wire.unset.is_empty()))
            || (wire.value.is_some() && (wire.set.is_some() || !wire.unset.is_empty()))
        {
            return Err(serde::de::Error::custom("ambiguous record envelope"));
        }
        let body = if wire.remove {
            EnvelopeBody::Remove
        } else if let Some(value) = wire.value {
            EnvelopeBody::Whole(value)
        } else {
            EnvelopeBody::Patch {
                set: wire.set.unwrap_or_default(),
                unset: wire.unset,
            }
        };
        Ok(Self {
            envelope: Envelope {
                id: wire.id,
                record_type: wire.record_type,
                body,
                at: wire.at,
                floor: wire.floor,
                floor_kind: wire.floor_kind,
                stamps: wire.stamps,
                removed: wire.removed,
            },
            prior: wire.prior,
            was: wire.was,
            added: wire.added,
        })
    }
}

/// The store's own options, beside the key space's `Settings` (old recordLogStore options and the store-side
/// kept-runs defaults it read).
#[derive(Debug, Clone)]
pub struct LogOptions {
    /// Log rows the memtable may hold before a write writes it out, which also bounds replay after a restart (old
    /// KEPT_RUNS_DEFAULTS.tail_rows, kept-runs.mjs:99; record-log-store.mjs writeOutWhenOverfull, :2375).
    pub tail_rows: usize,
    /// Who keeps the key space up. True, the Rust record log's rule (no idle wake runs it): each write writes out a full
    /// memtable and takes its own paced merge step. False, the old store's rule: a write writes out only an overfull
    /// memtable (`memtable_hold` times full) or a log tail past `tail_rows` (old writeOutWhenOverfull, :2375), and
    /// writing out a full memtable and merging are idle work, `maintain` (old maintain, :3939).
    pub upkeep_in_writes: bool,
    /// Records one call of the checksum build walks (old CHECKSUM_PAGE and `checksum_page`, record-log-store.mjs:111);
    /// idle `maintain` walks at most 256 a slice (old MODEL_PAGE).
    pub checksum_page: usize,
    /// Field indexes the host declares, as DATA (old invariant 5): the store names no kind or field of its own. A
    /// read over an index nobody declared is refused, never answered by a scan.
    pub indexes: Vec<Index>,
    /// Pages a selected-values read may bring in together before it reads each selected value on its own instead
    /// (old selected_scan_budget.pages). None: no bound.
    pub selected_scan_pages: Option<usize>,
    /// Which nested objects are kept once, as records of their own (old `contentId`, invariant 4). None: none are.
    pub shared: Option<Shared>,
}
/// The host's rule naming the nested objects kept once (old `contentId(type, value)`): an object at field `f` of a
/// record of kind `k` has kind `k/f`; when the rule gives it an id, it is kept as a record of that kind under that id,
/// linked from every record using it, and never removed by one record's change. Reads resolve the link.
pub trait ContentIds: Send + Sync {
    fn content_id(&self, kind: &str, value: &Value) -> Option<String>;
}
/// A `ContentIds` rule as an option.
#[derive(Clone)]
pub struct Shared(pub std::sync::Arc<dyn ContentIds>);
impl fmt::Debug for Shared {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Shared(content ids)")
    }
}
/// The link a record keeps in place of a shared object (old SHARED_MARK, :171): `{ "\u0000shared": id }`.
const SHARED_MARK: &str = "\u{0}shared";
/// The form a field takes when its exact JSON cannot be held as a `serde_json::Value`: a lone UTF-16 surrogate, or
/// object members in an order other than serde's (old values were JavaScript values, kept as JSON.stringify writes
/// them). `{ "\u0000ecma": text }` keeps the exact text (`crate::ecma_json`), answered as it is by
/// `read_own_field_json`; every other read sees the marked object.
const EXACT_MARK: &str = "\u{0}ecma";
/// The value to write for a field whose exact JSON text is `text` (JSON.parse then JSON.stringify, `crate::ecma_json`):
/// the plain value when serde holds that text exactly, else the marked exact text.
pub fn exact_json(text: &str) -> Result<Value> {
    let limits = crate::ecma_json::Limits { input_bytes: MAX_BATCH_BYTES, output_bytes: MAX_BATCH_BYTES, nodes: 1_000_000, container_entries: 1_000_000, total_string_units: MAX_BATCH_BYTES, ..crate::ecma_json::Limits::default() };
    let parsed = crate::ecma_json::parse(text.as_bytes(), limits).map_err(|error| Error::Invalid("exact JSON text refused", error.cause()))?;
    let exact = crate::ecma_json::stringify(&parsed, limits).map_err(|error| Error::Invalid("exact JSON text refused", error.cause()))?;
    if let Ok(plain) = serde_json::from_str::<Value>(&exact) {
        if serde_json::to_string(&plain)? == exact {
            return Ok(plain);
        }
    }
    Ok(json!({ EXACT_MARK: exact }))
}
fn exact_text_of(value: &Value) -> Option<&str> {
    let object = value.as_object()?;
    (object.len() == 1).then(|| object.get(EXACT_MARK)?.as_str()).flatten()
}
fn link_of(value: &Value) -> Option<&str> {
    let object = value.as_object()?;
    (object.len() == 1).then(|| object.get(SHARED_MARK)?.as_str()).flatten()
}
impl Default for LogOptions {
    fn default() -> Self {
        Self { tail_rows: 512, upkeep_in_writes: true, checksum_page: 5000, indexes: Vec::new(), selected_scan_pages: None, shared: None }
    }
}

/// One declared field index (old `{ type, name, paths }`): an entry `f|kind|name|value...|id` for each record of `kind`
/// that holds a value at every path, the values as JSON text in path order (old indexKeysOf, :1853). A path names a
/// top-level field, then fields inside it; a value that is an object, or a list of objects, is not indexed (old atPath,
/// :1790).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Index {
    pub kind: String,
    pub name: String,
    pub paths: Vec<Vec<String>>,
    /// A named build that gives records kept before this declaration their keys (old `backfill`, invariant 5): the
    /// idle maintainer walks them a bounded page at a time, and the index is ready only once the keys and the build's
    /// progress are committed together. Declarations sharing one name and kind share one walk. None: no build; the
    /// index holds only what was written since it was declared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backfill: Option<String>,
    /// Fields the index carries beside its keys, by path (old `carry`, :1812): each entry's value holds them as the
    /// record keeps them, so a read of the index answers them without reading the record. Empty: an entry's value is 1.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub carry: Vec<Vec<String>>,
}
/// One backfill group (old indexBuilds, :708): its progress key, kind, indexes and signature.
struct BuildGroup<'o> {
    key: String,
    kind: &'o str,
    indexes: Vec<&'o Index>,
    signature: String,
}
/// A backfill's kept progress (old `{ signature, after, through, ready }`): the ids of its kind up to `after` are
/// walked, up to the frontier `through` fixed when it began (later writes keep their own keys).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct BuildState {
    signature: String,
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    through: Option<String>,
    #[serde(default)]
    ready: bool,
}
/// Ids an index build slice walks (old INDEX_BUILD_PAGE, :2250).
const INDEX_BUILD_PAGE: usize = 32;
fn build_groups(options: &LogOptions) -> Vec<BuildGroup<'_>> {
    let mut groups: Vec<BuildGroup<'_>> = Vec::new();
    for index in &options.indexes {
        let Some(backfill) = &index.backfill else { continue };
        let key = format!("index-build:{}:{backfill}", index.kind);
        match groups.iter_mut().find(|g| g.key == key) {
            Some(group) => group.indexes.push(index),
            None => groups.push(BuildGroup { key, kind: &index.kind, indexes: vec![index], signature: String::new() }),
        }
    }
    for group in &mut groups {
        group.signature = serde_json::to_string(&group.indexes.iter().map(|i| if i.carry.is_empty() { json!({ "name": i.name, "paths": i.paths }) } else { json!({ "name": i.name, "paths": i.paths, "carry": i.carry }) }).collect::<Vec<_>>()).unwrap_or_default();
    }
    groups
}
/// Kept progress that names a different signature does not count: a changed declaration builds again (old
/// qualifiedBuildState, :734).
fn qualified(group: &BuildGroup<'_>, kept: Option<Value>) -> BuildState {
    kept.and_then(|v| serde_json::from_value::<BuildState>(v).ok()).filter(|s| s.signature == group.signature)
        .unwrap_or(BuildState { signature: group.signature.clone(), ..BuildState::default() })
}
/// One entry of a declared index: the record's id and its indexed values (old scan's `{ id, values }`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IndexEntry {
    pub id: String,
    pub values: Vec<Value>,
    /// With `Scan::carried` over an index that carries fields: each carried field by its dotted path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub carried: Option<serde_json::Map<String, Value>>,
}
/// What a scan reads (old scan's options, :2733): `equal` fixes the first values; `from`/`to` bound the next one
/// inclusively, `after`/`before` exclusively; `starts_with` keeps text values beginning with it; `reverse` walks down;
/// `limit` (None: every entry) bounds how many are answered.
#[derive(Debug, Clone, Default)]
pub struct Scan {
    pub equal: Vec<Value>,
    pub from: Option<Value>,
    pub to: Option<Value>,
    pub after: Option<Value>,
    pub before: Option<Value>,
    pub starts_with: Option<String>,
    pub reverse: bool,
    pub limit: Option<usize>,
    /// Answer the fields the index carries, read from its entries, never from the records (old scan's `carried`).
    pub carried: bool,
}
/// Several values after a fixed prefix, each with its own limit (old scanSelectedValues' options, :2822).
#[derive(Debug, Clone, Default)]
pub struct Selected {
    pub equal: Vec<Value>,
    pub values: Vec<Value>,
    pub from: Option<Value>,
    pub to: Option<Value>,
    pub after: Option<Value>,
    pub before: Option<Value>,
    pub reverse: bool,
    pub limit: Option<usize>,
}
/// A record `find` found: its id, kind and title (the first named field holding words).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Found {
    pub id: String,
    pub kind: String,
    pub title: String,
}

/// Exact counts of records per kind (old record-log-store.mjs counts, :1879-1890). `counts` is None while an older
/// projection is being counted: a count is then unknown, never a guess. `building` is that bounded build: the records
/// up to `after` (in id order) are counted in its `counts`, as of log row `at`.
#[derive(Debug, Default)]
struct Counting {
    /// Whether the heads directory holds every record (old bucketDirectory.ready).
    directory: bool,
    counts: Option<BTreeMap<String, i64>>,
    /// The order-free checksum of everything held (old invariant 10, record-digest.mjs), None until it is known: a
    /// store whose pages were written before it was kept builds it with the counts, a bounded page at a time.
    sums: Option<Sums>,
    building: Option<CountBuild>,
    /// The last log row of the group being replayed, while a replay runs (old `replaying`).
    replaying: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CountBuild {
    after: Option<String>,
    at: i64,
    counts: BTreeMap<String, i64>,
    #[serde(with = "sums_text")]
    sums: Sums,
}
/// Sums kept as their text (old `sums.text()`, `lanesFrom`).
mod sums_text {
    use crate::storage::record_store::digest::Sums;
    pub fn serialize<S: serde::Serializer>(sums: &Sums, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&sums.text())
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Sums, D::Error> {
        let text = <String as serde::Deserialize>::deserialize(d)?;
        Sums::from_text(&text).ok_or_else(|| serde::de::Error::custom("kept checksum text is not 256 buckets of hex"))
    }
}
/// The checksum and counts build's kept progress (old SUMS_BUILD, :158).
const COUNT_BUILD: &str = "sums_build";
/// What `checksum` answers (old `{ root, buckets }`): both None until the checksum is known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Checksum {
    pub root: Option<String>,
    pub buckets: Option<String>,
}
impl Counting {
    /// The counts a change of `id` moves (old countsFor, :1882): the exact counts, or the build's for a record it has
    /// passed and a log row it has not counted yet.
    fn counts_for(&mut self, id: &str) -> Option<&mut BTreeMap<String, i64>> {
        if self.counts.is_some() {
            return self.counts.as_mut();
        }
        let replaying = self.replaying;
        let build = self.building.as_mut()?;
        let passed = build.after.as_deref().is_some_and(|after| id <= after);
        (passed && replaying.is_none_or(|row| row > build.at)).then_some(&mut build.counts)
    }
    /// Old changeCount, :1884.
    fn change(&mut self, id: &str, before: Option<&str>, after: Option<&str>) {
        if before == after {
            return;
        }
        let Some(held) = self.counts_for(id) else { return };
        if let Some(kind) = before {
            *held.entry(kind.to_string()).or_insert(0) -= 1;
        }
        if let Some(kind) = after {
            *held.entry(kind.to_string()).or_insert(0) += 1;
        }
    }
    /// The checksum a change of `id` moves (old sumsFor, :1881).
    fn sums_for(&mut self, id: &str) -> Option<&mut Sums> {
        if self.sums.is_some() {
            return self.sums.as_mut();
        }
        let replaying = self.replaying;
        let build = self.building.as_mut()?;
        let passed = build.after.as_deref().is_some_and(|after| id <= after);
        (passed && replaying.is_none_or(|row| row > build.at)).then_some(&mut build.sums)
    }
    /// A record changed from `before` to `after`: its count and its checksum move (old setRecord/removeRecord, :1901-1907,
    /// :1948-1949). The checksum takes out what was held and puts in what is held, stamps included.
    fn record(&mut self, id: &str, before: Option<&Projected>, after: Option<&Projected>) {
        self.change(id, before.and_then(|p| p.kept.record_type.as_deref()), after.and_then(|p| p.kept.record_type.as_deref()));
        let Some(sums) = self.sums_for(id) else { return };
        fn live(p: Option<&Projected>) -> Option<(&str, serde_json::Map<String, Value>)> {
            p.and_then(|p| Some((p.kept.record_type.as_deref()?, fields_map(p.kept.value.as_ref()?))))
        }
        if let Some((kind, value)) = live(before) {
            sums.remove(id, kind, &value);
        }
        if let Some((kind, value)) = live(after) {
            sums.add(id, kind, &value);
        }
        let stamps = |p: Option<&Projected>| p.and_then(|p| p.kept.meta.as_ref()).map(|m| serde_json::to_string(m).unwrap_or_default());
        sums.stamps(id, stamps(before).as_deref(), stamps(after).as_deref());
    }
    fn count(&self, kind: &str) -> Option<u64> {
        self.counts.as_ref().map(|held| held.get(kind).copied().unwrap_or(0).max(0) as u64)
    }
}

/// One call's hold on the database: its own transaction, or a savepoint inside the host's (old recordLogStore ran in
/// the host's `transaction`; a nested call is one more step of it).
enum Call<'c> {
    Own(Transaction<'c>),
    Nested(&'c Connection),
}
const CALL_SAVEPOINT: &str = "record_log_call";
impl<'c> Call<'c> {
    fn begin(db: &'c Connection, behavior: TransactionBehavior) -> rusqlite::Result<Self> {
        if db.is_autocommit() {
            Ok(Self::Own(Transaction::new_unchecked(db, behavior)?))
        } else {
            db.execute_batch(&format!("SAVEPOINT {CALL_SAVEPOINT}"))?;
            Ok(Self::Nested(db))
        }
    }
    fn commit(self) -> rusqlite::Result<()> {
        match self {
            Self::Own(tx) => tx.commit(),
            Self::Nested(db) => db.execute_batch(&format!("RELEASE {CALL_SAVEPOINT}")),
        }
    }
    fn rollback(self) {
        match self {
            Self::Own(tx) => drop(tx),
            Self::Nested(db) => {
                let _ = db.execute_batch(&format!("ROLLBACK TO {CALL_SAVEPOINT}; RELEASE {CALL_SAVEPOINT}"));
            }
        }
    }
}
impl std::ops::Deref for Call<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        match self {
            Self::Own(tx) => tx,
            Self::Nested(db) => db,
        }
    }
}

/// What one bounded call of idle work did (old record-log-store.mjs maintain's answer, :4030-4048).
#[derive(Debug, Default, Clone, Serialize)]
pub struct Maintenance {
    /// More idle work is due: a merge, or the count build.
    pub more: bool,
    /// A merge finished in this call.
    pub merged: bool,
    /// Merge transactions started (old diagnostics.steps).
    pub steps: usize,
    /// Output pages the merges wrote (old diagnostics.pages).
    pub pages: usize,
    /// The memtable was full and was written out first.
    pub flushed: bool,
    /// Indexes whose build finished in this call, as (kind, name).
    pub indexes_ready: Vec<(String, String)>,
}

/// Concrete local storage supplier. logical policy and canonical stamp algebra
/// remain injected/separate; installation behind admitted resources is a host job.
pub struct RecordLog {
    db: Connection,
    keys: KeptRuns,
    scope: Scope,
    applied: i64,
    version: i64,
    stale: bool,
    options: LogOptions,
    counting: Counting,
    /// Log rows applied since the memtable was last written out (old tailRows).
    tail: usize,
    /// The sealed log generations, remembered until a seal, a drop or a forgotten projection changes them (old
    /// sealedLogNames, :3066-3068).
    sealed: Option<Vec<String>>,
    /// Statements that listed the sealed generations (a diagnostic).
    catalog_scans: u64,
}
/// One page of a sealed log generation (old sealedLogPage's answer): its rows, the last rowid read, each row's rowid.
#[derive(Debug, Clone, Serialize)]
pub struct SealedPage {
    pub rows: Vec<LogRow>,
    pub last: i64,
    pub rowids: Vec<i64>,
}
/// One log row as kept.
#[derive(Debug, Clone, Serialize)]
pub struct LogRow {
    pub id: String,
    pub transaction_id: String,
    pub actor_context: String,
    pub application_time: String,
    pub system_time: String,
    pub part: i64,
    pub parts: i64,
    pub envelopes: String,
}
/// A record a bucket page answers (old `{ id, type, value }`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BucketRecord {
    pub id: String,
    pub kind: String,
    pub value: Value,
}
/// One page of records in some buckets (old recordsInBucketsPage's `{ records, next }`): `next` is None once every id
/// was looked at.
#[derive(Debug, Clone, Serialize)]
pub struct BucketPage {
    pub records: Vec<BucketRecord>,
    pub next: Option<String>,
}
const SEALED_LOG: &str = "record_log_sealed_";
/// The heads directory: one `z|epoch|bucket|id` key per record held (old bucket directory, :583-596), so a page of a
/// few buckets seeks their heads and never reads another bucket's record. A store begins with it ready; a store
/// written before it was kept answers bucket pages by walking every head instead.
const DIRECTORY_EPOCH: &str = "record-bucket-heads-v1";
fn directory_prefix(bucket: usize) -> String {
    format!("z{SEP}{DIRECTORY_EPOCH}{SEP}{bucket:02x}{SEP}")
}
fn directory_key(id: &str) -> String {
    format!("{}{id}", directory_prefix(crate::storage::record_store::digest::bucket_of(id)))
}
impl RecordLog {
    pub fn create(db: Connection, scope: Scope, settings: Settings) -> Result<Self> {
        Self::create_with(db, scope, settings, LogOptions::default())
    }
    pub fn create_with(mut db: Connection, scope: Scope, settings: Settings, options: LogOptions) -> Result<Self> {
        validate_scope(&scope)?;
        let occupied:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%')",[],|r|r.get(0))?;
        if occupied {
            return Err(Error::Invalid(
                "compact journal target must be new or explicitly reopened",
             crate::cause!()));
        }
        db.execute_batch(
            "PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;",
        )?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(SCHEMA)?;
        tx.execute("INSERT INTO record_log_binding(singleton,account,resource,packed_format)VALUES(1,?,?,'ordered-fields')",params![scope.account,scope.resource])?;
        let keys = KeptRuns::create(&tx, KEYS, settings)?;
        // A new store holds no record: every declared build has nothing to walk (old: a genuinely empty type is marked
        // ready once, :2163-2178).
        for group in build_groups(&options) {
            keys.meta_set(&tx, &group.key, &serde_json::to_value(BuildState { signature: group.signature.clone(), ready: true, ..BuildState::default() })?)?;
        }
        tx.commit()?;
        let version = data_version(&db)?;
        Ok(Self {
            db,
            keys,
            scope,
            applied: 0,
            version,
            stale: false,
            options,
            // A new store holds no record: its counts are exact from the first write.
            counting: Counting { counts: Some(BTreeMap::new()), sums: Some(Sums::new()), directory: true, ..Counting::default() },
            tail: 0,
            sealed: None,
            catalog_scans: 0,
        })
    }
    pub fn reopen(db: Connection, scope: Scope, settings: Settings) -> Result<Self> {
        Self::reopen_with(db, scope, settings, LogOptions::default())
    }
    pub fn reopen_with(db: Connection, scope: Scope, settings: Settings, options: LogOptions) -> Result<Self> {
        validate_scope(&scope)?;
        let bound: (String, String, String) = db.query_row(
            "SELECT account,resource,packed_format FROM record_log_binding WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if bound
            != (
                scope.account.clone(),
                scope.resource.clone(),
                "ordered-fields".into(),
            )
        {
            return Err(crate::cause!(Error::Refused));
        }
        db.execute_batch("PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;")?;
        let keys = KeptRuns::open(&db, KEYS, settings)?;
        let version = data_version(&db)?;
        Ok(Self {
            db,
            keys,
            scope,
            applied: 0,
            version,
            stale: true,
            options,
            counting: Counting::default(),
            tail: 0,
            sealed: None,
            catalog_scans: 0,
        })
    }
    /// The connection this log keeps its tables in, for the host that owns it: to begin and end its own transaction
    /// around calls (old recordLogStore ran in the host's), or to read what it wrote. A rollback done here without
    /// `transaction` is caught by the next call, which finds the log ending before where its projection stands and
    /// rebuilds it (old invariant 1).
    pub fn connection(&self) -> &Connection {
        &self.db
    }
    /// Forget everything held in memory; the next call rebuilds it from the pages and the log (old forgetCached).
    pub fn forget_cached(&mut self) {
        self.stale = true;
        self.sealed = None;
    }
    /// Runs `work` in one transaction of the host's: every call inside it is a savepoint of that transaction, and a
    /// failure (or a failed commit) rolls all of it back and forgets what memory held (old `host.transaction` around
    /// store calls, then forgetCached).
    pub fn transaction<T>(&mut self, work: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        // Inside the host's own transaction this is one more savepoint of it.
        let outer = !self.db.is_autocommit();
        self.db.execute_batch(if outer { "SAVEPOINT record_log_transaction" } else { "BEGIN IMMEDIATE" })?;
        let (commit, rollback) = if outer {
            ("RELEASE record_log_transaction", "ROLLBACK TO record_log_transaction; RELEASE record_log_transaction")
        } else {
            ("COMMIT", "ROLLBACK")
        };
        match work(self) {
            Ok(value) => match self.db.execute_batch(commit) {
                Ok(()) => Ok(value),
                Err(e) => {
                    let _ = self.db.execute_batch(rollback);
                    self.stale = true;
                    self.sealed = None;
                    Err(e.into())
                }
            },
            Err(e) => {
                if !self.db.is_autocommit() {
                    let _ = self.db.execute_batch(rollback);
                }
                self.stale = true;
                self.sealed = None;
                Err(e)
            }
        }
    }
    /// Memtable, cache, filter and run counts the current-record index holds now.
    pub fn held(&self) -> kept_runs::Held {
        self.keys.held()
    }
    /// Bounded replay is resumable across calls. It never exposes a partly
    /// synchronized current-record state as a completed read or new write.
    pub fn recover(&mut self, text: &dyn ValueText) -> Result<bool> {
        self.recover_measured(text).map(|(done, _)| done)
    }
    /// `recover`, answering the work this step of the replay spent too.
    pub fn recover_measured(&mut self, text: &dyn ValueText) -> Result<(bool, Work)> {
        let tx = Call::begin(&self.db, TransactionBehavior::Deferred)?;
        let mut work = Work::default();
        let mut state = State { indexes: &self.options.indexes, keys: &mut self.keys, applied: &mut self.applied, version: &mut self.version, stale: &mut self.stale, counting: &mut self.counting, tail: &mut self.tail };
        let result = synchronize(&tx, &mut state, text, &mut work);
        match result {
            Ok(done) => {
                tx.commit()?;
                Ok((done, work))
            }
            Err(e) => {
                tx.rollback();
                self.stale = !matches!(e, Error::ReplayRequired(_));
                Err(e)
            }
        }
    }
    pub fn read(
        &mut self,
        id: &str,
        request: &Request,
        admission: &dyn Admission,
        text: &dyn ValueText,
    ) -> Result<ReadResult> {
        validate_id(id)?;
        let (record, work) = self.current("record.read", &json!(id), request, admission, text, |db, keys, _, _, _, work| {
            let Some(mut record) = read_projected(db, keys, id, work)? else { return Ok(None) };
            if let Some(fields) = record.kept.value.take() {
                record.kept.value = Some(resolve_fields(db, keys, fields, work)?);
            }
            Ok(Some(record))
        })?;
        Ok(ReadResult { record, work })
    }
    /// The kind of the record `id` holds now, None when it holds none (old typeOf).
    pub fn type_of(&mut self, id: &str, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<Option<String>> {
        validate_id(id)?;
        let (kind, _) = self.current("record.type_of", &json!(id), request, admission, text, |db, keys, _, _, _, work| {
            Ok(read_projected(db, keys, id, work)?.and_then(|p| p.kept.record_type))
        })?;
        Ok(kind)
    }
    /// The ids of a kind (old idsOfType, record-log-store.mjs:2700): with a limit, the last `limit` in id order, the
    /// greatest first; without one, every id in id order. A kind whose exact count is zero reads nothing.
    pub fn ids(&mut self, kind: &str, limit: Option<usize>, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<(Vec<String>, Work)> {
        validate_kind(kind)?;
        self.current("record.ids", &json!([kind, limit]), request, admission, text, |db, keys, counting, _, _, work| {
            let base = type_key(kind, "");
            let end = format!("t{SEP}{kind}\u{1}");
            match limit {
                Some(limit) => {
                    let page = keys.range(db, kept_runs::Range { lo: &base, hi: &end, after: None, reverse: true, limit: limit.clamp(1, 4096) }, ReadBudget::default())?;
                    add_work(&mut work.selected, &page.work);
                    Ok(page.entries.into_iter().map(|(key, _)| key[base.len()..].to_string()).collect())
                }
                None => {
                    if counting.count(kind) == Some(0) {
                        return Ok(Vec::new());
                    }
                    let mut ids = Vec::new();
                    let read = keys.walk(db, &base, &end, ReadBudget { rows: usize::MAX, entries: usize::MAX, ..ReadBudget::default() }, &mut |_| false, &mut |key, _| {
                        ids.push(key[base.len()..].to_string());
                        Ok(true)
                    })?;
                    add_work(&mut work.selected, &read);
                    Ok(ids)
                }
            }
        })
    }
    /// How many records of `kind` are held, exactly; None while an older projection is still being counted, never a
    /// guess (old count, :3909).
    pub fn count(&mut self, kind: &str, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<Option<u64>> {
        validate_kind(kind)?;
        Ok(self.current("record.count", &json!(kind), request, admission, text, |_, _, counting, _, _, _| Ok(counting.count(kind)))?.0)
    }
    /// The counts of several kinds at one log position (old countMany, :3911). Repeated kinds answer once.
    pub fn count_many(&mut self, kinds: &[&str], request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<(BTreeMap<String, Option<u64>>, Work)> {
        for kind in kinds {
            validate_kind(kind)?;
        }
        self.current("record.count_many", &json!(kinds), request, admission, text, |_, _, counting, _, _, _| {
            Ok(kinds.iter().map(|kind| (kind.to_string(), counting.count(kind))).collect())
        })
    }
    /// One admitted read at the current log position: rights checked before and after, the projection brought up to
    /// the log first.
    fn current<T>(
        &mut self,
        operation: &str,
        arguments: &Value,
        request: &Request,
        admission: &dyn Admission,
        text: &dyn ValueText,
        read: impl FnOnce(&Connection, &mut KeptRuns, &Counting, &LogOptions, &dyn ValueText, &mut Work) -> Result<T>,
    ) -> Result<(T, Work)> {
        validate_request(request)?;
        let identity = blake3::hash(&serde_json::to_vec(&(&self.scope, operation, arguments))?).to_hex().to_string();
        let tx = Call::begin(&self.db, TransactionBehavior::Deferred)?;
        let mut work = Work::default();
        let result = (|| {
            require(admission, &self.scope, request, &identity)?;
            let mut state = State { indexes: &self.options.indexes, keys: &mut self.keys, applied: &mut self.applied, version: &mut self.version, stale: &mut self.stale, counting: &mut self.counting, tail: &mut self.tail };
            if !synchronize(&tx, &mut state, text, &mut work)? {
                return Err(crate::cause!(Error::ReplayRequired));
            }
            let value = read(&tx, &mut self.keys, &self.counting, &self.options, text, &mut work)?;
            require(admission, &self.scope, request, &identity)?;
            Ok(value)
        })();
        match result {
            Ok(value) => {
                tx.commit()?;
                Ok((value, work))
            }
            Err(e) => {
                tx.rollback();
                self.stale = !matches!(e, Error::ReplayRequired(_));
                Err(e)
            }
        }
    }
    /// Entries of one declared index (old scan, :2733).
    pub fn scan(&mut self, kind: &str, name: &str, scan: &Scan, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<(Vec<IndexEntry>, Work)> {
        validate_kind(kind)?;
        self.current("record.scan", &json!([kind, name]), request, admission, text, |db, keys, _, options, text, work| scan_index(db, keys, options, text, kind, name, scan, work))
    }
    /// Every entry under each of several first values of a declared index, in key order (old scanFirstValues, :2797).
    /// Parent selections commonly have none: one existence read over the range enclosing them all proves that first,
    /// so many empty parents cost what two do; populated selections are read together (`KeptRuns::ranges`).
    pub fn scan_first_values(&mut self, kind: &str, name: &str, values: &[Value], request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<(Vec<IndexEntry>, Work)> {
        validate_kind(kind)?;
        self.current("record.scan_first_values", &json!([kind, name, values]), request, admission, text, |db, keys, _, options, text, work| {
            let index = declared(options, kind, name)?;
            if index.paths.is_empty() || values.is_empty() {
                return Ok(Vec::new());
            }
            let prefix = index_prefix(kind, name);
            let mut bounds: Vec<(String, String)> = Vec::new();
            for value in values {
                let lo = format!("{prefix}{}{SEP}", text.encode(value)?);
                let hi = format!("{}{AFTER}", &lo[..lo.len() - 1]);
                if !bounds.iter().any(|(l, _)| *l == lo) {
                    bounds.push((lo, hi));
                }
            }
            if bounds.len() > 1 {
                let lo = bounds.iter().map(|(l, _)| l.clone()).min_by(|a, b| a.encode_utf16().cmp(b.encode_utf16())).unwrap();
                let hi = bounds.iter().map(|(_, h)| h.clone()).max_by(|a, b| a.encode_utf16().cmp(b.encode_utf16())).unwrap();
                let read = keys.has_range(db, &lo, &hi, ReadBudget::default())?;
                add_work(&mut work.selected, &read.work);
                if !read.result {
                    return Ok(Vec::new());
                }
            }
            let (found, read) = keys.ranges(db, &bounds, false, usize::MAX, None, ReadBudget::default())?;
            add_work(&mut work.selected, &read);
            let mut entries: Vec<(String, IndexEntry)> = Vec::new();
            for (key, _) in found.into_iter().flatten() {
                entries.push((key.clone(), entry_of(&key, prefix.len())?));
            }
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            Ok(entries.into_iter().map(|(_, entry)| entry).collect())
        })
    }
    /// Several selected values after a fixed prefix, each with its own limit, read together (old scanSelectedValues,
    /// :2822). A read that would bring in more pages together than `LogOptions::selected_scan_pages` reads each value on
    /// its own instead, with the same answer.
    pub fn scan_selected_values(&mut self, kind: &str, name: &str, selected: &Selected, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<(Vec<IndexEntry>, Work)> {
        validate_kind(kind)?;
        self.current("record.scan_selected_values", &json!([kind, name]), request, admission, text, |db, keys, _, options, text, work| {
            let index = declared(options, kind, name)?;
            if selected.equal.len() >= index.paths.len() {
                return Err(Error::Invalid("that index has no value after its fixed prefix", crate::cause!()));
            }
            let mut values: Vec<(String, Value)> = Vec::new();
            for value in &selected.values {
                let encoded = text.encode(value)?;
                if !values.iter().any(|(e, _)| *e == encoded) {
                    values.push((encoded, value.clone()));
                }
            }
            let count = selected.limit.unwrap_or(usize::MAX);
            if values.is_empty() || count == 0 {
                return Ok(Vec::new());
            }
            let bounded = [&selected.from, &selected.to, &selected.after, &selected.before].iter().any(|v| v.is_some());
            if selected.equal.len() + 1 == index.paths.len() && bounded {
                return Err(Error::Invalid("that index has no value after its selected prefix to bound", crate::cause!()));
            }
            let compare = |left: &IndexEntry, right: &IndexEntry, text: &dyn ValueText| -> Result<std::cmp::Ordering> {
                for at in 0..index.paths.len() {
                    let (a, b) = (left.values.get(at).map(|v| text.encode(v)).transpose()?, right.values.get(at).map(|v| text.encode(v)).transpose()?);
                    if a != b {
                        return Ok(a.cmp(&b));
                    }
                }
                Ok(left.id.cmp(&right.id))
            };
            let separately = |db: &Connection, keys: &mut KeptRuns, work: &mut Work| -> Result<Vec<IndexEntry>> {
                let mut all = Vec::new();
                for (_, value) in &values {
                    let mut equal = selected.equal.clone();
                    equal.push(value.clone());
                    let scan = Scan { equal, from: selected.from.clone(), to: selected.to.clone(), after: selected.after.clone(), before: selected.before.clone(), starts_with: None, reverse: selected.reverse, limit: selected.limit, carried: false };
                    all.extend(scan_index(db, keys, options, text, kind, name, &scan, work)?);
                }
                let mut failed = None;
                all.sort_by(|a, b| match compare(a, b, text) {
                    Ok(order) => if selected.reverse { order.reverse() } else { order },
                    Err(e) => { failed.get_or_insert(e); std::cmp::Ordering::Equal }
                });
                failed.map_or(Ok(all), Err)
            };
            if selected.limit.is_none() {
                return separately(db, keys, work);
            }
            let prefix = index_prefix(kind, name);
            let fixed: String = selected.equal.iter().map(|v| text.encode(v).map(|t| format!("{t}{SEP}"))).collect::<Result<String>>()?;
            let mut bounds = Vec::new();
            for (encoded, _) in &values {
                let base = format!("{prefix}{fixed}{encoded}{SEP}");
                let (lo, hi) = bounds_of(&base, selected.from.as_ref(), selected.to.as_ref(), selected.after.as_ref(), selected.before.as_ref(), None, text)?;
                bounds.push((lo, hi));
            }
            let found = match keys.ranges(db, &bounds, selected.reverse, count, options.selected_scan_pages, ReadBudget::default()) {
                Ok((found, read)) => {
                    add_work(&mut work.selected, &read);
                    found
                }
                Err(kept_runs::Error::Bounds("kept ranges exceed their page budget", _)) => return separately(db, keys, work),
                Err(e) => return Err(e.into()),
            };
            let mut answer: Vec<(String, IndexEntry)> = Vec::new();
            for (key, _) in found.into_iter().flatten() {
                answer.push((key.clone(), entry_of(&key, prefix.len())?));
            }
            answer.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            if selected.reverse {
                answer.reverse();
            }
            Ok(answer.into_iter().map(|(_, entry)| entry).collect())
        })
    }
    /// The ids whose `field` holds `value`, through the index declared on that one field (old fields.idsWhere, :3058).
    pub fn ids_where(&mut self, kind: &str, field: &str, value: &Value, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<Vec<String>> {
        validate_kind(kind)?;
        Ok(self.current("record.ids_where", &json!([kind, field, value]), request, admission, text, |db, keys, _, options, text, work| {
            let index = index_on(options, kind, &[vec![field.to_string()]])?;
            let scan = Scan { equal: vec![value.clone()], ..Scan::default() };
            Ok(scan_index(db, keys, options, text, kind, &index.name, &scan, work)?.into_iter().map(|e| e.id).collect())
        })?.0)
    }
    /// Records whose `field` comes after `after` in its index, with that field and `names` (old fields.after, :3043).
    pub fn fields_after(&mut self, kind: &str, field: &str, after: &Value, names: &[&str], limit: Option<usize>, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<Vec<Value>> {
        validate_kind(kind)?;
        Ok(self.current("record.fields_after", &json!([kind, field, after, names, limit]), request, admission, text, |db, keys, _, options, text, work| {
            let index = index_on(options, kind, &[vec![field.to_string()]])?;
            let scan = Scan { after: Some(after.clone()), limit, ..Scan::default() };
            let ids: Vec<String> = scan_index(db, keys, options, text, kind, &index.name, &scan, work)?.into_iter().map(|e| e.id).collect();
            let mut wanted = vec![field];
            wanted.extend(names.iter().copied().filter(|n| *n != field));
            let found = fields_from_records(db, keys, kind, &ids, &wanted, work)?;
            Ok(ids.iter().filter_map(|id| found.get(id).cloned()).collect())
        })?.0)
    }
    /// The newest record of each group, through the index declared on [group, order], with those fields and `names`
    /// (old fields.newestPerGroup, :3051, over lastPerGroup, :2884: one reverse read a group, each skipping the rest
    /// of its group).
    pub fn newest_per_group(&mut self, kind: &str, group: &str, order: &str, names: &[&str], request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<Vec<Value>> {
        validate_kind(kind)?;
        Ok(self.current("record.newest_per_group", &json!([kind, group, order, names]), request, admission, text, |db, keys, _, options, _, work| {
            let index = index_on(options, kind, &[vec![group.to_string()], vec![order.to_string()]])?;
            let prefix = index_prefix(kind, &index.name);
            let mut hi = format!("{}{AFTER}", &prefix[..prefix.len() - 1]);
            let mut ids = Vec::new();
            loop {
                let page = keys.range(db, kept_runs::Range { lo: &prefix, hi: &hi, after: None, reverse: true, limit: 1 }, ReadBudget::default())?;
                add_work(&mut work.selected, &page.work);
                let Some((key, _)) = page.entries.into_iter().next() else { break };
                let first = key[prefix.len()..].split(SEP).next().unwrap_or_default().to_string();
                ids.push(entry_of(&key, prefix.len())?.id);
                hi = format!("{prefix}{first}{SEP}");
            }
            let mut wanted = vec![group, order];
            wanted.extend(names.iter().copied().filter(|n| *n != group && *n != order));
            let found = fields_from_records(db, keys, kind, &ids, &wanted, work)?;
            Ok(ids.iter().filter_map(|id| found.get(id).cloned()).collect())
        })?.0)
    }
    /// The named top-level fields of records of `kind`, with their id: only fields holding a value of their own (a
    /// scalar or a list of scalars) are answered, and ids of another kind or none are left out (old fields.fieldsOf,
    /// :3003, over fieldsFromRecords, :2921).
    pub fn fields_of(&mut self, kind: &str, ids: &[&str], names: &[&str], request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<BTreeMap<String, Value>> {
        validate_kind(kind)?;
        for id in ids {
            validate_id(id)?;
        }
        Ok(self.current("record.fields_of", &json!([kind, ids, names]), request, admission, text, |db, keys, _, _, _, work| {
            let ids: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
            fields_from_records(db, keys, kind, &ids, names, work)
        })?.0)
    }
    /// Records holding every word, newest first across kinds (old find, :3691): each kind's records are walked newest
    /// first by when each was first written, and the newest head across kinds is taken each time. A record matches
    /// when a named field (a path) holds text containing every word, ignoring case; its title is the first named field
    /// holding words. Kinds named with "/" (stored parts) are never answered.
    pub fn find(&mut self, words: &[&str], paths: &[Vec<String>], kinds: Option<&[&str]>, limit: usize, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<Vec<Found>> {
        if paths.is_empty() || paths.iter().any(|p| p.is_empty() || p.iter().any(String::is_empty)) {
            return Err(Error::Invalid("find needs fields: a list of field-name paths", crate::cause!()));
        }
        Ok(self.current("record.find", &json!([words, paths, kinds, limit]), request, admission, text, |db, keys, _, _, _, work| {
            let held = keys.range(db, kept_runs::Range { lo: &format!("y{SEP}"), hi: "y\u{1}", after: None, reverse: false, limit: 4096 }, ReadBudget::default())?;
            add_work(&mut work.selected, &held.work);
            let chosen: Vec<String> = held.entries.into_iter().map(|(key, _)| key[2..].to_string())
                .filter(|kind| !kind.contains('/') && kinds.is_none_or(|only| only.contains(&kind.as_str()))).collect();
            let terms: Vec<String> = words.iter().map(|w| w.to_lowercase()).filter(|w| !w.is_empty()).collect();
            let page = limit.clamp(1, 200);
            struct Cursor { kind: String, prefix: String, hi: Option<String>, buffer: std::collections::VecDeque<String> }
            let mut cursors: Vec<Cursor> = chosen.into_iter().map(|kind| Cursor { prefix: format!("r{SEP}{kind}{SEP}"), hi: Some(format!("r{SEP}{kind}\u{1}")), kind, buffer: Default::default() }).collect();
            let mut out = Vec::new();
            loop {
                let mut best: Option<(usize, String)> = None;
                for (at, cursor) in cursors.iter_mut().enumerate() {
                    if cursor.buffer.is_empty() {
                        if let Some(hi) = cursor.hi.take() {
                            let read = keys.range(db, kept_runs::Range { lo: &cursor.prefix, hi: &hi, after: None, reverse: true, limit: 64 }, ReadBudget::default())?;
                            add_work(&mut work.selected, &read.work);
                            cursor.hi = if read.entries.len() == 64 { read.entries.last().map(|(k, _)| k.clone()) } else { None };
                            cursor.buffer.extend(read.entries.into_iter().map(|(k, _)| k));
                        }
                    }
                    if let Some(head) = cursor.buffer.front() {
                        let seq = head.split(SEP).nth(2).unwrap_or_default();
                        if best.as_ref().is_none_or(|(_, b)| seq > b.split(SEP).nth(2).unwrap_or_default()) {
                            best = Some((at, head.clone()));
                        }
                    }
                }
                let Some((at, key)) = best else { break };
                cursors[at].buffer.pop_front();
                let id = key.split(SEP).nth(3).unwrap_or_default().to_string();
                let Some(fields) = read_projected(db, keys, &id, work)?.and_then(|p| p.kept.value) else { continue };
                let mut texts: Vec<Option<String>> = Vec::new();
                for path in paths {
                    let mut lookup = |shared: &str| -> Result<Option<Fields>> { Ok(read_projected(db, keys, shared, work)?.and_then(|p| p.kept.value)) };
                    texts.push(at_path_linked(&fields, path, &mut lookup)?.and_then(|v| v.as_str().map(str::to_owned)));
                }
                let matches = texts.iter().flatten().any(|t| !t.trim().is_empty() && {
                    let quoted = serde_json::to_string(t).unwrap_or_default().to_lowercase();
                    terms.iter().all(|term| quoted.contains(term.as_str()))
                });
                if !matches {
                    continue;
                }
                let title = texts.iter().flatten().find(|t| !t.trim().is_empty()).cloned().unwrap_or_default();
                out.push(Found { id, kind: cursors[at].kind.clone(), title: title.split_whitespace().collect::<Vec<_>>().join(" ") });
                if out.len() >= page {
                    break;
                }
            }
            Ok(out)
        })?.0)
    }
    /// A record's list field as kept: its members, an empty list for a field that is not a list of objects (old listOf,
    /// :2676).
    fn stored_list(db: &Connection, keys: &mut KeptRuns, id: &str, field: &str, work: &mut Work) -> Result<(Option<Projected>, Vec<Value>)> {
        let record = read_projected(db, keys, id, work)?;
        let list = record.as_ref().and_then(|r| r.kept.value.as_ref()).and_then(|f| f.get(field)).and_then(Value::as_array)
            .filter(|items| !items.is_empty() && items.iter().all(Value::is_object)).cloned().unwrap_or_default();
        Ok((record, list))
    }
    /// How many members a record's list field holds (old memberCount, :3127).
    pub fn member_count(&mut self, id: &str, field: &str, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<usize> {
        validate_id(id)?;
        Ok(self.current("record.member_count", &json!([id, field]), request, admission, text, |db, keys, _, _, _, work| Ok(Self::stored_list(db, keys, id, field, work)?.1.len()))?.0)
    }
    /// One member of a record's list field, its shared objects resolved (old readMember, :3128).
    pub fn read_member(&mut self, id: &str, field: &str, ordinal: usize, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<Option<Value>> {
        validate_id(id)?;
        Ok(self.current("record.read_member", &json!([id, field, ordinal]), request, admission, text, |db, keys, _, _, _, work| {
            let (_, list) = Self::stored_list(db, keys, id, field, work)?;
            list.get(ordinal).map(|member| resolve_value(db, keys, member, &mut Vec::new(), work)).transpose()
        })?.0)
    }
    /// Named fields of a list's members, each with its ordinal; a member holding none of them is left out, and only
    /// values of their own (scalars, lists of scalars) are answered (old memberFields and projectMemberFields, :2683,
    /// :3135).
    pub fn member_fields(&mut self, id: &str, field: &str, names: &[&str], ordinals: Option<&[usize]>, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<Vec<Value>> {
        validate_id(id)?;
        Ok(self.current("record.member_fields", &json!([id, field, names, ordinals]), request, admission, text, |db, keys, _, _, _, work| {
            if names.is_empty() || ordinals.is_some_and(<[usize]>::is_empty) {
                return Ok(Vec::new());
            }
            let (_, list) = Self::stored_list(db, keys, id, field, work)?;
            Ok(list.iter().enumerate().filter(|(n, _)| ordinals.is_none_or(|o| o.contains(n))).filter_map(|(ordinal, member)| {
                let mut out = serde_json::Map::new();
                out.insert("ordinal".into(), json!(ordinal));
                for name in names {
                    if let Some(value) = member.get(*name).filter(|v| is_scalar_field(v)) {
                        out.insert(name.to_string(), value.clone());
                    }
                }
                (out.len() > 1).then_some(Value::Object(out))
            }).collect())
        })?.0)
    }
    /// The ordinals of a list's members whose `name` holds `value` (old membersWhere, :3170).
    pub fn members_where(&mut self, id: &str, field: &str, name: &str, value: &Value, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<Vec<usize>> {
        validate_id(id)?;
        Ok(self.current("record.members_where", &json!([id, field, name, value]), request, admission, text, |db, keys, _, _, text, work| {
            let wanted = text.encode(value)?;
            let (_, list) = Self::stored_list(db, keys, id, field, work)?;
            let mut out = Vec::new();
            for (ordinal, member) in list.iter().enumerate() {
                if let Some(held) = member.get(name).filter(|v| is_scalar_field(v)) {
                    if text.encode(held)? == wanted {
                        out.push(ordinal);
                    }
                }
            }
            Ok(out)
        })?.0)
    }
    /// A record's value without the `omit` fields, its shared objects resolved (old readOwn, :3118).
    pub fn read_own(&mut self, id: &str, omit: &[&str], request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<Option<Value>> {
        validate_id(id)?;
        Ok(self.current("record.read_own", &json!([id, omit]), request, admission, text, |db, keys, _, _, _, work| {
            let Some(fields) = read_projected(db, keys, id, work)?.and_then(|p| p.kept.value) else { return Ok(None) };
            let own: Fields = fields.iter().filter(|(f, _)| !omit.contains(f)).map(|(f, v)| (f.to_string(), v.clone())).collect();
            Ok(Some(Value::Object(fields_map(&resolve_fields(db, keys, own, work)?))))
        })?.0)
    }
    /// Writes a record's fields except `omit`, which keep what they hold (old writeOwn, :3174): one write, in the
    /// host's transaction when there is one. The record must be of `kind`.
    #[allow(clippy::too_many_arguments)]
    pub fn write_own(&mut self, id: &str, kind: &str, value: &Value, omit: &[&str], context: &Context, admission: &dyn Admission, text: &dyn ValueText, ids: &mut dyn LogIds) -> Result<WriteResult> {
        validate_id(id)?;
        let object = value.as_object().ok_or(Error::Invalid("write_own needs an object", crate::cause!()))?.clone();
        let rights = Request { key: format!("write_own:{id}"), sent_at_ms: context.accepted_at_ms };
        self.transaction(|log| {
            let held = log.current("record.write_own", &json!([id]), &rights, admission, text, |db, keys, _, _, _, work| read_projected(db, keys, id, work))?.0;
            let held = held.filter(|p| p.kept.record_type.as_deref() == Some(kind)).ok_or(Error::Invalid("that record is not of that kind", crate::cause!()))?;
            let before = held.kept.value.unwrap_or_default();
            let mut fields: Fields = object.iter().filter(|(f, _)| !omit.contains(&f.as_str())).map(|(f, v)| (f.clone(), v.clone())).collect();
            for (field, kept) in before.iter().filter(|(f, _)| omit.contains(f)) {
                fields.insert(field, kept.clone());
            }
            log.write_unrequested(&[RecordInput { id: id.into(), record_type: kind.into(), value: Some(fields) }], context, admission, text, ids)
        })
    }
    /// The exact JSON text one own field holds as kept, links and all (old readOwnFieldJson, :3074): None when the
    /// record is missing, of another kind, or lacks the field.
    pub fn read_own_field_json(&mut self, id: &str, kind: &str, field: &str, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<Option<String>> {
        validate_id(id)?;
        if field.is_empty() {
            return Err(Error::Invalid("own-field JSON needs a field name", crate::cause!()));
        }
        Ok(self.current("record.read_own_field_json", &json!([id, kind, field]), request, admission, text, |db, keys, _, _, text, work| {
            let Some(record) = read_projected(db, keys, id, work)? else { return Ok(None) };
            if record.kept.record_type.as_deref() != Some(kind) {
                return Ok(None);
            }
            record.kept.value.as_ref().and_then(|f| f.get(field)).map(|v| match exact_text_of(v) { Some(exact) => Ok(exact.to_string()), None => text.encode(v) }).transpose()
        })?.0)
    }
    /// Replaces one own field with `replacement`'s fields only while it still holds exactly `expected_json`, the other
    /// fields kept, in one transaction (old rewriteOwnFieldJsonIfEqual, :3102). Answers whether it matched.
    #[allow(clippy::too_many_arguments)]
    pub fn rewrite_own_field_json_if_equal(&mut self, id: &str, kind: &str, field: &str, expected_json: &str, replacement: &Value, context: &Context, admission: &dyn Admission, text: &dyn ValueText, ids: &mut dyn LogIds) -> Result<bool> {
        let fields = replacement.as_object().filter(|o| !o.is_empty() && !o.contains_key(field)).ok_or(Error::Invalid("field recovery needs a replacement object without the old field", crate::cause!()))?.clone();
        let rights = Request { key: format!("rewrite_own_field:{id}"), sent_at_ms: context.accepted_at_ms };
        self.transaction(|log| {
            if log.read_own_field_json(id, kind, field, &rights, admission, text)?.as_deref() != Some(expected_json) {
                return Ok(false);
            }
            let held = log.current("record.rewrite_own_field", &json!([id]), &rights, admission, text, |db, keys, _, _, _, work| read_projected(db, keys, id, work))?.0;
            let before = held.and_then(|p| p.kept.value).unwrap_or_default();
            let omit: Vec<String> = before.keys().filter(|name| *name != field && !fields.contains_key(*name)).map(str::to_owned).collect();
            let omit: Vec<&str> = omit.iter().map(String::as_str).collect();
            log.write_own(id, kind, &Value::Object(fields.clone()), &omit, context, admission, text, ids)?;
            Ok(true)
        })
    }
    /// Writes one member of a record's list field, at an ordinal it holds or the next one (old writeMember, :3185).
    #[allow(clippy::too_many_arguments)]
    pub fn write_member(&mut self, id: &str, kind: &str, field: &str, ordinal: usize, value: &Value, context: &Context, admission: &dyn Admission, text: &dyn ValueText, ids: &mut dyn LogIds) -> Result<WriteResult> {
        validate_id(id)?;
        if !value.is_object() {
            return Err(Error::Invalid("write_member needs an object", crate::cause!()));
        }
        let rights = Request { key: format!("write_member:{id}"), sent_at_ms: context.accepted_at_ms };
        self.transaction(|log| {
            let held = log.current("record.write_member", &json!([id]), &rights, admission, text, |db, keys, _, _, _, work| read_projected(db, keys, id, work))?.0;
            let held = held.filter(|p| p.kept.record_type.as_deref() == Some(kind)).ok_or(Error::Invalid("that record is not of that kind", crate::cause!()))?;
            let mut fields = held.kept.value.unwrap_or_default();
            let list = match fields.get(field) {
                None => Vec::new(),
                Some(Value::Array(items)) if items.iter().all(Value::is_object) => items.clone(),
                Some(_) => return Err(Error::Invalid("that field is not a list", crate::cause!())),
            };
            if ordinal > list.len() {
                return Err(Error::Invalid("a list cannot skip an ordinal", crate::cause!()));
            }
            let mut list = list;
            if ordinal == list.len() {
                list.push(value.clone());
            } else {
                list[ordinal] = value.clone();
            }
            fields.insert(field, Value::Array(list));
            log.write_unrequested(&[RecordInput { id: id.into(), record_type: kind.into(), value: Some(fields) }], context, admission, text, ids)
        })
    }
    pub fn write(
        &mut self,
        records: &[RecordInput],
        request: &Request,
        context: &Context,
        admission: &dyn Admission,
        text: &dyn ValueText,
        ids: &mut dyn LogIds,
    ) -> Result<WriteResult> {
        validate_request(request)?;
        self.write_inner(records, Some(request), context, admission, text, ids)
    }
    /// A write without a request key: an ordinary write (old record-requests.mjs, "a write without a request key is an
    /// ordinary write"). It keeps no receipt, so it cannot be answered again from one, and a write that changes nothing
    /// appends nothing (old record-log-store.mjs commit, :2421, invariant 2). Rights are still checked, against the
    /// write's own identity.
    pub fn write_unrequested(
        &mut self,
        records: &[RecordInput],
        context: &Context,
        admission: &dyn Admission,
        text: &dyn ValueText,
        ids: &mut dyn LogIds,
    ) -> Result<WriteResult> {
        self.write_inner(records, None, context, admission, text, ids)
    }
    fn write_inner(
        &mut self,
        records: &[RecordInput],
        request: Option<&Request>,
        context: &Context,
        admission: &dyn Admission,
        text: &dyn ValueText,
        ids: &mut dyn LogIds,
    ) -> Result<WriteResult> {
        validate_batch(records)?;
        validate_context(context)?;
        let changes: Vec<Change<'_>> = records.iter().map(Change::from).collect();
        let sent_at = request.map(|r| r.sent_at_ms).unwrap_or(context.accepted_at_ms);
        let identity = blake3::hash(&serde_json::to_vec(&(
            &self.scope,
            &changes,
            sent_at,
        ))?)
        .to_hex()
        .to_string();
        // What the rights check sees for a write with no request: the write's own identity as its key.
        let unrequested = Request { key: format!("unrequested:{identity}"), sent_at_ms: context.accepted_at_ms };
        let rights = request.unwrap_or(&unrequested);
        let tx = Call::begin(&self.db, TransactionBehavior::Immediate)?;
        let changed_before = tx.total_changes();
        let mut work = Work::default();
        let result = (|| {
            require(admission, &self.scope, rights, &identity)?;
            let mut state = State { indexes: &self.options.indexes, keys: &mut self.keys, applied: &mut self.applied, version: &mut self.version, stale: &mut self.stale, counting: &mut self.counting, tail: &mut self.tail };
            if !synchronize(&tx, &mut state, text, &mut work)? {
                return Err(crate::cause!(Error::ReplayRequired));
            }
            work.pending_memtable_bytes_before = self.keys.held().memtable_bytes;
            let checked_from = match request {
                Some(request) => {
                    let checked_from = lookup(&tx, &mut self.keys, "Q\0from", &mut work)?
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0)
                        .max(context.accepted_at_ms.saturating_sub(REQUEST_WINDOW_MS));
                    if request.sent_at_ms < checked_from {
                        return Err(crate::cause!(Error::StaleRequest));
                    }
                    if let Some(value) = lookup(&tx, &mut self.keys, &request_key(&request.key), &mut work)? {
                        let prior: Retried = serde_json::from_value(value)?;
                        if prior.accepted_at_ms >= checked_from {
                            if prior.identity != identity {
                                return Err(crate::cause!(Error::Conflict));
                            }
                            require(admission, &self.scope, request, &identity)?;
                            return Ok(WriteResult {
                                receipt: prior.receipt,
                                duplicate: true,
                                work: work.clone(),
                            });
                        }
                    }
                    checked_from
                }
                None => 0,
            };
            // The value as kept: shared objects become links, and those not held yet are written first, as records of
            // their own (old writing and commit, :2478-2500).
            let mut stored: Vec<RecordInput> = Vec::with_capacity(records.len());
            let mut objects: Vec<RecordInput> = Vec::new();
            for record in records {
                match &record.value {
                    Some(fields) => {
                        let (form, shared) = stored_form(&self.options, &record.record_type, fields);
                        for (id, kind, value) in shared {
                            if !objects.iter().any(|o| o.id == id) && read_projected(&tx, &mut self.keys, &id, &mut work)?.is_none() {
                                objects.push(RecordInput { id, record_type: kind, value: Some(value) });
                            }
                        }
                        stored.push(RecordInput { id: record.id.clone(), record_type: record.record_type.clone(), value: Some(form) });
                    }
                    None => stored.push(record.clone()),
                }
            }
            objects.extend(stored);
            let records = &objects[..];
            let mut before = BTreeMap::new();
            let mut prior_bytes = 0usize;
            for record in records {
                if !before.contains_key(&record.id) {
                    let held = read_projected(&tx, &mut self.keys, &record.id, &mut work)?;
                    prior_bytes = prior_bytes.saturating_add(serde_json::to_vec(&held)?.len());
                    if prior_bytes > MAX_BATCH_BYTES {
                        return Err(crate::cause!(Error::Bounds));
                    }
                    before.insert(record.id.clone(), held);
                }
            }
            if !admission.validate_prepared(&self.scope, records, &before) {
                return Err(crate::cause!(Error::Refused));
            }
            let mut envelopes = Vec::new();
            for record in records {
                if let Some(envelope) = envelope_for(record, before[&record.id].as_ref(), text)? {
                    envelopes.push(envelope);
                }
            }
            if request.is_none() && envelopes.is_empty() {
                // Nothing changed and no receipt is kept: nothing is appended (old commit, :2421).
                require(admission, &self.scope, rights, &identity)?;
                return Ok(WriteResult {
                    receipt: Receipt { transaction_id: String::new(), written: Vec::new(), previous_types: BTreeMap::new(), log_id: None },
                    duplicate: false,
                    work: work.clone(),
                });
            }
            let log_id = if envelopes.is_empty() {
                None
            } else {
                Some(
                    ids.next_log_id()
                        .ok_or(Error::Invalid("canonical log identity unavailable", crate::cause!()))?,
                )
            };
            if let Some(id) = &log_id {
                validate_log_id(id)?;
            }
            let mut history = Vec::new();
            let mut previous_types = BTreeMap::new();
            let mut written = Vec::new();
            if let Some(log_id) = &log_id {
                for (index, mut envelope) in envelopes.into_iter().enumerate() {
                    let held = before.remove(&envelope.id).flatten();
                    let event = annotate(&envelope, held.as_ref());
                    let stamp = sequence(log_id, index)?;
                    let previous = held
                        .as_ref()
                        .and_then(|p| p.kept.meta.as_ref())
                        .map(|m| m.at.as_str())
                        .unwrap_or("");
                    let moved = stamps::stamp_after(&stamp, previous)
                        .map_err(|error| Error::Invalid("invalid canonical field stamp", error.cause()))?;
                    if moved != stamp {
                        envelope.at = Some(moved);
                    }
                    let next = apply_envelope(held.as_ref(), &envelope, &stamp, text)?;
                    update_projection(
                        &tx,
                        &mut self.keys,
                        &mut self.counting,
                        &self.options.indexes,
                        text,
                        &envelope.id,
                        held.as_ref(),
                        next.as_ref(),
                        &mut work,
                    )?;
                    if !written.contains(&envelope.id) {
                        written.push(envelope.id.clone());
                        previous_types.insert(
                            envelope.id.clone(),
                            held.as_ref().and_then(|p| p.kept.record_type.clone()),
                        );
                    }
                    before.insert(envelope.id.clone(), next);
                    history.push(HistoryEnvelope { envelope, ..event });
                }
            }
            let receipt = Receipt {
                transaction_id: request.map(|r| r.key.clone()).or_else(|| log_id.clone()).unwrap_or_default(),
                written,
                previous_types,
                log_id: log_id.clone(),
            };
            let change = match request {
                Some(request) => {
                    let change = prepare_request_change(
                        &tx,
                        &mut self.keys,
                        request,
                        Retried {
                            identity: identity.clone(),
                            accepted_at_ms: context.accepted_at_ms,
                            receipt: receipt.clone(),
                        },
                        checked_from,
                        &mut work,
                    )?;
                    if request.sent_at_ms < change.checked_from {
                        return Err(crate::cause!(Error::StaleRequest));
                    }
                    Some(change)
                }
                None => None,
            };
            // A no-op still needs a durable exact receipt, but does not need
            // to publish unrelated pending pages. Its one request-only row
            // uses this SAME authoritative journal and replay path. Keep the
            // original business receipt's log_id=None / written=[] intact.
            let request_only = log_id.is_none();
            let journal_id = match log_id {
                Some(id) => id,
                None => ids
                    .next_log_id()
                    .ok_or(Error::Invalid("canonical log identity unavailable", crate::cause!()))?,
            };
            validate_log_id(&journal_id)?;
            let transaction_id = request.map(|r| r.key.clone()).unwrap_or_else(|| journal_id.clone());
            {
                let serialized = serde_json::to_string(&history)?;
                if serialized.len() > MAX_JOURNAL_BYTES {
                    return Err(crate::cause!(Error::Bounds));
                }
                let chunks = utf8_chunks(&serialized, LOG_ROW_BYTES);
                let parts = chunks.len();
                for (part, body) in chunks.into_iter().enumerate() {
                    let id = if part == 0 {
                        journal_id.clone()
                    } else {
                        format!("{journal_id}.{part}")
                    };
                    // Part zero always says what it does to the request window: a change, or JSON null for a write
                    // that keeps no receipt. A missing value is a damaged row, never an unrequested write.
                    let requests = if part == 0 {
                        Some(serde_json::to_string(&change)?)
                    } else {
                        None
                    };
                    tx.execute("INSERT INTO record_log(id,transaction_id,actor_context,application_time,system_time,part,parts,envelopes,keys,requests)VALUES(?,?,?,?,?,?,?,?,NULL,?)",params![id,transaction_id,serde_json::to_string(&context.actor)?,context.application_time,context.system_time,part as i64,parts as i64,body,requests])?;
                    work.journal_sql_statements += 1;
                    work.journal_rows_appended += 1;
                }
                self.applied = tx.last_insert_rowid();
                self.tail = self.tail.saturating_add(parts);
            }
            work.request_only_rows_appended = u64::from(request_only);
            work.business_envelopes_appended = history.len();
            if let Some(change) = &change {
                apply_request_change(&mut self.keys, change, &mut work)?;
            }
            let debt = self
                .keys
                .held()
                .memtable_bytes
                .saturating_sub(work.pending_memtable_bytes_before);
            // Preserve ordinary memtable-capacity maintenance. A no-op does
            // not itself force a flush below that shared capacity threshold.
            // The log tail is bounded too: past `tail_rows` rows the memtable is written out, so replay after a
            // restart reads at most that many rows (old writeOutWhenOverfull, :2375).
            let full = if self.options.upkeep_in_writes { self.keys.full() } else { self.keys.overfull() };
            if full || self.tail >= self.options.tail_rows {
                let checkpoint_before = tx.total_changes();
                let flushed = write_out(&tx, &mut self.keys, &mut self.counting, self.applied, &mut self.tail)?;
                work.flush_pages += flushed.pages;
                work.flush_keys += flushed.keys;
                work.checkpoint_user_rows_changed +=
                    tx.total_changes().saturating_sub(checkpoint_before);
            }
            if self.options.upkeep_in_writes {
                maintain(&tx, &mut self.keys, debt, &mut work)?;
            }
            require(admission, &self.scope, rights, &identity)?;
            Ok(WriteResult {
                receipt,
                duplicate: false,
                work: work.clone(),
            })
        })();
        match result {
            Ok(mut value) => {
                value.work.sqlite_user_rows_changed =
                    tx.total_changes().saturating_sub(changed_before);
                value.work.pending_memtable_bytes_after = self.keys.held().memtable_bytes;
                match tx.commit() {
                    Ok(()) => Ok(value),
                    Err(e) => {
                        self.stale = true;
                        Err(Error::Sql(e, crate::cause!()))
                    }
                }
            }
            Err(e) => {
                tx.rollback();
                self.stale = !matches!(e, Error::ReplayRequired(_));
                Err(e)
            }
        }
    }
    /// Explicit packed-page checkpoint. Publication and log coverage are atomic;
    /// callers must account for its actual page/catalogue writes separately.
    pub fn checkpoint(&mut self, text: &dyn ValueText) -> Result<kept_runs::Flush> {
        self.checkpoint_measured(text).map(|result| result.flush)
    }
    /// Same checkpoint owner with the complete SQLite user-row delta exposed.
    pub fn checkpoint_measured(&mut self, text: &dyn ValueText) -> Result<CheckpointResult> {
        let tx = Call::begin(&self.db, TransactionBehavior::Immediate)?;
        let mut work = Work::default();
        let changed_before = tx.total_changes();
        let result = (|| {
            let mut state = State { indexes: &self.options.indexes, keys: &mut self.keys, applied: &mut self.applied, version: &mut self.version, stale: &mut self.stale, counting: &mut self.counting, tail: &mut self.tail };
            if !synchronize(&tx, &mut state, text, &mut work)? {
                return Err(crate::cause!(Error::ReplayRequired));
            }
            let flush = write_out(&tx, &mut self.keys, &mut self.counting, self.applied, &mut self.tail)?;
            Ok(CheckpointResult {
                flush,
                sqlite_user_rows_changed: tx.total_changes().saturating_sub(changed_before),
            })
        })();
        match result {
            Ok(value) => match tx.commit() {
                Ok(()) => Ok(value),
                Err(e) => {
                    self.stale = true;
                    Err(e.into())
                }
            },
            Err(e) => {
                tx.rollback();
                self.stale = !matches!(e, Error::ReplayRequired(_));
                Err(e)
            }
        }
    }
    /// The checksum of everything held (old checksum, :4269): `build` walks one page of a build still under way first
    /// (`LogOptions::checksum_page` records), never every record in one call; both parts are None until it is known.
    pub fn checksum(&mut self, build: bool, text: &dyn ValueText) -> Result<Checksum> {
        if build {
            let page = self.options.checksum_page.max(1);
            self.in_call(text, |tx, log| build_counts(tx, log.keys, log.counting, *log.applied, log.tail, page))?;
        } else {
            self.in_call(text, |_, _| Ok(()))?;
        }
        Ok(match &self.counting.sums {
            Some(sums) => Checksum { root: Some(sums.root()), buckets: Some(sums.text()) },
            None => Checksum { root: None, buckets: None },
        })
    }
    /// The sealed log generations, by name in order (old sealedLogs, :3068); listed once until a seal, a drop or a
    /// forgotten projection.
    pub fn sealed_logs(&mut self) -> Result<Vec<String>> {
        if self.sealed.is_none() {
            self.catalog_scans += 1;
            let mut statement = self.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB ? ORDER BY name")?;
            let names = statement.query_map([format!("{SEALED_LOG}*")], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            self.sealed = Some(names);
        }
        Ok(self.sealed.clone().unwrap_or_default())
    }
    /// Statements that listed the sealed generations since this log opened.
    pub fn catalog_scans(&self) -> u64 {
        self.catalog_scans
    }
    /// Seals the open log once everything in it is written out: renames it after its first row and opens a fresh one,
    /// in one transaction (old sealLog, :4091). None when the log is empty.
    pub fn seal_log(&mut self, text: &dyn ValueText) -> Result<Option<String>> {
        let first: Option<String> = self.db.query_row("SELECT id FROM record_log ORDER BY rowid LIMIT 1", [], |r| r.get(0)).optional()?;
        let Some(first) = first else { return Ok(None) };
        let name = format!("{SEALED_LOG}{}", first.chars().filter(char::is_ascii_hexdigit).collect::<String>().to_lowercase());
        let sealed = name.clone();
        self.in_call(text, |tx, log| {
            write_out(tx, log.keys, log.counting, 0, log.tail)?;
            tx.execute_batch(&format!("ALTER TABLE record_log RENAME TO {sealed}; {LOG_TABLE}"))?;
            *log.applied = 0;
            Ok(())
        })?;
        self.sealed = None;
        Ok(Some(name))
    }
    /// Rows of a sealed generation after `after`, at most `limit` (old sealedLogPage, :4109).
    pub fn sealed_log_page(&mut self, table: &str, after: i64, limit: usize) -> Result<SealedPage> {
        if !self.sealed_logs()?.iter().any(|t| t == table) {
            return Err(Error::Invalid("that is not a sealed log", crate::cause!()));
        }
        let mut statement = self.db.prepare(&format!("SELECT rowid, id, transaction_id, actor_context, application_time, system_time, part, parts, envelopes FROM {table} WHERE rowid > ? ORDER BY rowid LIMIT ?"))?;
        let mut rows = statement.query(params![after, limit as i64])?;
        let mut page = SealedPage { rows: Vec::new(), last: after, rowids: Vec::new() };
        while let Some(row) = rows.next()? {
            let rowid: i64 = row.get(0)?;
            page.rows.push(LogRow { id: row.get(1)?, transaction_id: row.get(2)?, actor_context: row.get(3)?, application_time: row.get(4)?, system_time: row.get(5)?, part: row.get(6)?, parts: row.get(7)?, envelopes: row.get(8)? });
            page.rowids.push(rowid);
            page.last = rowid;
        }
        Ok(page)
    }
    /// How far a sealed generation is kept elsewhere (old sealedLogKept).
    pub fn sealed_log_kept(&self, table: &str) -> Result<i64> {
        Ok(self.keys.meta_get(&self.db, &format!("kept:{table}"))?.and_then(|v| v.as_i64()).unwrap_or(0))
    }
    /// Notes that a sealed generation is kept elsewhere through `rowid`; with `reclaim`, its rows through there leave
    /// this database in the same transaction (old keepSealedLogThrough, :4149).
    pub fn keep_sealed_log_through(&mut self, table: &str, rowid: i64, reclaim: bool, text: &dyn ValueText) -> Result<()> {
        if reclaim && !self.sealed_logs()?.iter().any(|t| t == table) {
            return Err(Error::Invalid("that is not a sealed log", crate::cause!()));
        }
        let table = table.to_string();
        self.in_call(text, |tx, log| {
            let key = format!("kept:{table}");
            if reclaim {
                let after = log.keys.meta_get(tx, &key)?.and_then(|v| v.as_i64()).unwrap_or(0);
                if rowid < after {
                    return Err(Error::Invalid("a kept history page must advance its sealed rowid", crate::cause!()));
                }
                tx.execute(&format!("DELETE FROM {table} WHERE rowid > ? AND rowid <= ?"), params![after, rowid])?;
            }
            Ok(log.keys.meta_set(tx, &key, &json!(rowid))?)
        })
    }
    /// Drops a sealed generation (old dropSealedLog, :4164).
    pub fn drop_sealed_log(&mut self, table: &str, text: &dyn ValueText) -> Result<()> {
        if !self.sealed_logs()?.iter().any(|t| t == table) {
            return Err(Error::Invalid("that is not a sealed log", crate::cause!()));
        }
        let table = table.to_string();
        self.in_call(text, |tx, log| {
            tx.execute_batch(&format!("DROP TABLE {table}"))?;
            Ok(log.keys.meta_remove(tx, &format!("kept:{table}"))?)
        })?;
        self.sealed = None;
        Ok(())
    }
    /// One page of the records whose ids fall in `buckets`, in id order after `after` (old recordsInBucketsPage,
    /// :4284): at most `limit` records, `chars` characters of their values and `examine` ids looked at. Asking for every
    /// bucket walks every head in order (old everyRecord, :3215); a few buckets seek their heads in the directory and
    /// open only those records (old recordsFromDirectory, :3229); a store without a ready directory walks every head and
    /// passes over the others before reading their values.
    pub fn records_in_buckets_page(&mut self, buckets: &[usize], after: Option<&str>, limit: usize, chars: usize, examine: usize, request: &Request, admission: &dyn Admission, text: &dyn ValueText) -> Result<(BucketPage, Work)> {
        let wanted: BTreeSet<usize> = buckets.iter().copied().filter(|b| *b < crate::storage::record_store::digest::BUCKETS).collect();
        self.current("record.records_in_buckets_page", &json!([buckets, after, limit, chars, examine]), request, admission, text, |db, keys, counting, _, _, work| {
            let mut page = BucketPage { records: Vec::new(), next: None };
            let (mut size, mut looked) = (0usize, 0usize);
            let mut take = |id: String, record: Option<Projected>, page: &mut BucketPage| -> bool {
                looked += 1;
                if let Some(record) = record {
                    if let (Some(kind), Some(fields)) = (record.kept.record_type, record.kept.value) {
                        let value = Value::Object(fields_map(&fields));
                        size += serde_json::to_string(&value).map(|t| t.len()).unwrap_or(0);
                        page.records.push(BucketRecord { id: id.clone(), kind, value });
                    }
                }
                if page.records.len() >= limit || size >= chars || looked >= examine {
                    page.next = Some(id);
                    return false;
                }
                true
            };
            if wanted.len() < crate::storage::record_store::digest::BUCKETS && counting.directory {
                // Each bucket's heads in id order; the smallest id across the buckets is taken each time.
                let mut lanes: Vec<(String, Option<String>, std::collections::VecDeque<String>, bool)> =
                    wanted.iter().map(|b| (directory_prefix(*b), after.map(str::to_owned), Default::default(), false)).collect();
                loop {
                    let empty: Vec<usize> = (0..lanes.len()).filter(|i| !lanes[*i].3 && lanes[*i].2.is_empty()).collect();
                    if !empty.is_empty() {
                        let bounds: Vec<(String, String)> = empty.iter().map(|i| {
                            let (prefix, after, _, _) = &lanes[*i];
                            (after.as_ref().map(|a| format!("{prefix}{a}{SEP}")).unwrap_or_else(|| prefix.clone()), format!("{}{AFTER}", &prefix[..prefix.len() - 1]))
                        }).collect();
                        let (found, read) = keys.ranges(db, &bounds, false, 32, None, ReadBudget::default())?;
                        add_work(&mut work.selected, &read);
                        for (i, entries) in empty.iter().zip(found) {
                            let length = lanes[*i].0.len();
                            lanes[*i].3 = entries.len() < 32;
                            lanes[*i].2.extend(entries.into_iter().map(|(k, _)| k[length..].to_string()));
                        }
                    }
                    let Some(best) = (0..lanes.len()).filter(|i| !lanes[*i].2.is_empty()).min_by(|a, b| lanes[*a].2[0].cmp(&lanes[*b].2[0])) else { break };
                    let id = lanes[best].2.pop_front().expect("a lane with a head");
                    lanes[best].1 = Some(id.clone());
                    let record = read_projected(db, keys, &id, work)?;
                    if !take(id, record, &mut page) {
                        return Ok(page);
                    }
                }
                return Ok(page);
            }
            let every = wanted.len() >= crate::storage::record_store::digest::BUCKETS;
            let lo = after.map(|a| format!("{}{SEP}", id_key(a))).unwrap_or_else(|| format!("i{SEP}"));
            let mut failed = None;
            let read = keys.walk(db, &lo, "i\u{1}", ReadBudget { rows: usize::MAX, entries: usize::MAX, ..ReadBudget::default() },
                &mut |key| every || wanted.contains(&crate::storage::record_store::digest::bucket_of(&key[2..])),
                &mut |key, value| {
                    let id = key[2..].to_string();
                    let record = match value.map(unpack).transpose() { Ok(r) => r, Err(e) => { failed = Some(e); return Ok(false) } };
                    Ok(take(id, record, &mut page))
                })?;
            add_work(&mut work.selected, &read);
            if let Some(e) = failed {
                return Err(e);
            }
            Ok(page)
        })
    }
    /// Whether idle work is due now: a full memtable, a merge, the count build or an index build (old maintenanceAt,
    /// :4052). Every build's progress is read in one statement and nothing is remembered of it, so a rolled-back or
    /// changed progress is seen at once.
    pub fn maintenance_due(&self) -> Result<bool> {
        Ok(self.keys.full() || self.keys.merge_due(&self.db)? || self.counting.sums.is_none() || self.indexes_pending()?)
    }
    /// Whether a declared index answers every record (old indexReady, :763): one without a backfill always does; one
    /// with a backfill once its build is committed ready.
    pub fn index_ready(&self, kind: &str, name: &str) -> Result<bool> {
        let index = self.options.indexes.iter().find(|i| i.kind == kind && i.name == name).ok_or(Error::Invalid("no index of that name is declared for that kind", crate::cause!()))?;
        let Some(backfill) = &index.backfill else { return Ok(true) };
        let groups = build_groups(&self.options);
        let group = groups.iter().find(|g| g.key == format!("index-build:{kind}:{backfill}")).ok_or(crate::cause!(Error::Corrupt))?;
        Ok(qualified(group, self.keys.meta_get(&self.db, &group.key)?).ready)
    }
    fn indexes_pending(&self) -> Result<bool> {
        let groups = build_groups(&self.options);
        if groups.is_empty() {
            return Ok(false);
        }
        let kept = self.keys.meta_get_many(&self.db, &groups.iter().map(|g| g.key.clone()).collect::<Vec<_>>())?;
        Ok(groups.iter().any(|g| !qualified(g, kept.get(&g.key).cloned()).ready))
    }
    /// Idle work, bounded (old record-log-store.mjs maintain, :3939): writes a full memtable out, then merges written
    /// runs until `max_pages` output pages are written, one transaction a merge step, and takes one bounded step of
    /// the count build once no merge is due (every record it walks is a read through every run). `has_time` is the
    /// scheduler's clock: no transaction starts once it says no. The two phases take turns going first, and which goes
    /// next is kept, so a long merge cannot starve the build across short wakes.
    pub fn maintain(&mut self, max_pages: usize, has_time: &mut dyn FnMut() -> bool, text: &dyn ValueText) -> Result<Maintenance> {
        let mut done = Maintenance { more: true, ..Maintenance::default() };
        if has_time() && self.keys.full() {
            self.in_call(text, |tx, log| {
                write_out(tx, log.keys, log.counting, *log.applied, log.tail)?;
                Ok(())
            })?;
            done.flushed = true;
        }
        let first_merge = self.keys.meta_get(&self.db, "maintenance_phase_next")?.and_then(|v| v.as_str().map(str::to_owned)).as_deref() != Some("projections");
        let mut left = max_pages;
        let mut merging = kept_runs::Stepped { more: true, ..kept_runs::Stepped::default() };
        let mut counted = self.counting.sums.is_some();
        for phase in if first_merge { ["merge", "projections"] } else { ["projections", "merge"] } {
            if !has_time() {
                break;
            }
            let next = if phase == "merge" { "projections" } else { "merge" };
            self.in_call(text, |tx, log| Ok(log.keys.meta_set(tx, "maintenance_phase_next", &json!(next))?))?;
            if phase == "merge" {
                // A transaction a step, each at most 64 pages when a clock is watching, so the clock is checked
                // between them (old maintain stepPages, :3968).
                loop {
                    if left == 0 || !has_time() {
                        break;
                    }
                    let pages = left.min(64);
                    merging = self.in_call(text, |tx, log| Ok(log.keys.step(tx, pages, ReadBudget::default())?))?;
                    done.steps += 1;
                    done.pages += merging.pages;
                    done.merged |= merging.merged;
                    left = left.saturating_sub(merging.pages);
                    if !(merging.more && (merging.merged || merging.pages > 0)) {
                        break;
                    }
                }
            } else {
                // The projections are independent: each due one gets one bounded slice, starting from the one after
                // the last to start, so a failing or long one cannot starve the rest (old maintain tasks, :3985-4013).
                const TASKS: usize = 2;
                let saved = self.keys.meta_get(&self.db, "maintenance_next")?.and_then(|v| v.as_u64()).map(|v| v as usize).filter(|v| *v < TASKS).unwrap_or(0);
                for offset in 0..TASKS {
                    if !has_time() {
                        break;
                    }
                    let position = (saved + offset) % TASKS;
                    let due = match position {
                        0 => !counted && !self.keys.merge_due(&self.db)?,
                        _ => self.indexes_pending()?,
                    };
                    if !due {
                        continue;
                    }
                    self.in_call(text, |tx, log| Ok(log.keys.meta_set(tx, "maintenance_next", &json!((position + 1) % TASKS))?))?;
                    match position {
                        0 => {
                            let page = self.options.checksum_page.clamp(1, 256);
                            counted = self.in_call(text, |tx, log| build_counts(tx, log.keys, log.counting, *log.applied, log.tail, page))?;
                        }
                        _ => {
                            if let Some(ready) = self.build_next_index(text)? {
                                done.indexes_ready.extend(ready);
                            }
                        }
                    }
                }
            }
        }
        done.more = merging.more || !counted || self.indexes_pending()?;
        Ok(done)
    }
    /// One bounded slice of the next index build due (old nextIndexBuild, :753, and buildIndexes, :2280). Which group
    /// is next is kept before its slice starts, in a transaction of its own, so a slice that fails cannot be first
    /// again on every later wake. Answers the indexes it made ready, None when none was due.
    fn build_next_index(&mut self, text: &dyn ValueText) -> Result<Option<Vec<(String, String)>>> {
        let groups = build_groups(&self.options);
        let last = self.keys.meta_get(&self.db, "index_build_last")?.and_then(|v| v.as_str().map(str::to_owned));
        let start = last.and_then(|l| groups.iter().position(|g| g.key == l)).map(|p| p + 1).unwrap_or(0);
        let kept = self.keys.meta_get_many(&self.db, &groups.iter().map(|g| g.key.clone()).collect::<Vec<_>>())?;
        let Some(group) = (0..groups.len()).map(|o| &groups[(start + o) % groups.len()]).find(|g| !qualified(g, kept.get(&g.key).cloned()).ready) else { return Ok(None) };
        let (key, kind, signature) = (group.key.clone(), group.kind.to_string(), group.signature.clone());
        let names: Vec<String> = group.indexes.iter().map(|i| i.name.clone()).collect();
        self.in_call(text, |tx, log| Ok(log.keys.meta_set(tx, "index_build_last", &json!(key))?))?;
        let ready = self.in_call(text, |tx, log| {
            let state = qualified(&BuildGroup { key: key.clone(), kind: &kind, indexes: Vec::new(), signature: signature.clone() }, log.keys.meta_get(tx, &key)?);
            let prefix = type_key(&kind, "");
            let end = format!("t{SEP}{kind}\u{1}");
            let mut spent = Work::default();
            // New writes already keep every declared index: the old data's frontier is fixed once, so a busy writer
            // cannot grow the build faster than its slices.
            let through = match &state.through {
                Some(through) => Some(through.clone()),
                None => {
                    let last = log.keys.range(tx, kept_runs::Range { lo: &prefix, hi: &end, after: None, reverse: true, limit: 1 }, ReadBudget::default())?;
                    last.entries.first().map(|(k, _)| k[prefix.len()..].to_string())
                }
            };
            let lo = state.after.as_deref().map(|a| format!("{}{SEP}", type_key(&kind, a))).unwrap_or_else(|| prefix.clone());
            let page = match &through {
                Some(through) => log.keys.range(tx, kept_runs::Range { lo: &lo, hi: &format!("{}{SEP}", type_key(&kind, through)), after: None, reverse: false, limit: INDEX_BUILD_PAGE }, ReadBudget::default())?.entries,
                None => Vec::new(),
            };
            let indexes: Vec<Index> = log.indexes.iter().filter(|i| i.kind == kind && names.contains(&i.name)).cloned().collect();
            let mut after = state.after.clone();
            for (key, _) in &page {
                let id = key[prefix.len()..].to_string();
                let current = read_projected(tx, log.keys, &id, &mut spent)?;
                if current.as_ref().and_then(|p| p.kept.record_type.as_deref()) == Some(kind.as_str()) {
                    let entries = {
                        let mut lookup = |shared: &str| -> Result<Option<Fields>> { Ok(read_projected(tx, log.keys, shared, &mut spent)?.and_then(|p| p.kept.value)) };
                        index_entries_of(&indexes, current.as_ref(), &id, text, &mut lookup)?
                    };
                    for (entry, value) in entries {
                        match log.keys.get(tx, &entry, ReadBudget::default())?.result {
                            Lookup::Value(prior) if prior == value => {}
                            Lookup::Value(prior) => log.keys.put_replacing(&entry, value, obsolete_entry_bytes(&entry, &prior))?,
                            _ => log.keys.put(&entry, value)?,
                        }
                    }
                }
                after = Some(id);
            }
            let ready = page.len() < INDEX_BUILD_PAGE || matches!((&through, &after), (Some(t), Some(a)) if a >= t);
            write_out(tx, log.keys, log.counting, *log.applied, log.tail)?;
            log.keys.meta_set(tx, &key, &serde_json::to_value(BuildState { signature: signature.clone(), after, through, ready })?)?;
            Ok(ready)
        })?;
        Ok(Some(if ready { names.into_iter().map(|n| (kind.clone(), n)).collect() } else { Vec::new() }))
    }
    /// One call's transaction (or savepoint), the projection brought up to the log first. `work` gets the log's
    /// memory, never the connection's transaction itself.
    fn in_call<T>(&mut self, text: &dyn ValueText, work: impl FnOnce(&Connection, &mut State<'_>) -> Result<T>) -> Result<T> {
        let tx = Call::begin(&self.db, TransactionBehavior::Immediate)?;
        let mut spent = Work::default();
        let mut state = State { indexes: &self.options.indexes, keys: &mut self.keys, applied: &mut self.applied, version: &mut self.version, stale: &mut self.stale, counting: &mut self.counting, tail: &mut self.tail };
        let result = (|| {
            if !synchronize(&tx, &mut state, text, &mut spent)? {
                return Err(crate::cause!(Error::ReplayRequired));
            }
            work(&tx, &mut state)
        })();
        match result {
            Ok(value) => match tx.commit() {
                Ok(()) => Ok(value),
                Err(e) => {
                    self.stale = true;
                    Err(e.into())
                }
            },
            Err(e) => {
                tx.rollback();
                self.stale = !matches!(e, Error::ReplayRequired(_));
                Err(e)
            }
        }
    }
}

/// The log's memory a replay brings up to date.
struct State<'a> {
    indexes: &'a [Index],
    keys: &'a mut KeptRuns,
    applied: &'a mut i64,
    version: &'a mut i64,
    stale: &'a mut bool,
    counting: &'a mut Counting,
    tail: &'a mut usize,
}

/// Writes the memtable out with how far the log it covers and the exact counts at that position; while the counts are
/// still being built, the build's progress is kept beside it (old writeOut, :2187).
fn write_out(tx: &Connection, keys: &mut KeptRuns, counting: &mut Counting, applied: i64, tail: &mut usize) -> Result<kept_runs::Flush> {
    if counting.sums.is_none() {
        if let Some(build) = counting.building.as_mut() {
            build.at = applied;
            keys.meta_set(tx, COUNT_BUILD, &serde_json::to_value(&*build)?)?;
        }
    }
    let mut covered = json!({ "record_log_row": applied });
    if let Some(counts) = &counting.counts {
        covered["counts"] = json!(counts);
    }
    if let Some(sums) = &counting.sums {
        covered["sums"] = json!(sums.text());
    }
    covered["bucket_directory"] = json!({ "signature": DIRECTORY_EPOCH, "ready": counting.directory });
    let flushed = keys.flush(tx, &covered)?;
    *tail = 0;
    Ok(flushed)
}

/// One page of the checksum build (old buildSums, :3311): walks at most `page` records past where the build stopped,
/// then keeps where it is, or, once every record is walked, the checksum and the counts themselves with the pages.
/// Answers whether the checksum is known.
fn build_counts(tx: &Connection, keys: &mut KeptRuns, counting: &mut Counting, applied: i64, tail: &mut usize, page: usize) -> Result<bool> {
    if counting.sums.is_some() {
        return Ok(true);
    }
    let mut build = counting.building.take().unwrap_or(CountBuild { after: None, at: applied, counts: BTreeMap::new(), sums: Sums::new() });
    let lo = build.after.as_deref().map(|after| format!("{}{SEP}", id_key(after))).unwrap_or_else(|| format!("i{SEP}"));
    let mut walked = 0usize;
    let mut finished = true;
    keys.walk(tx, &lo, "i\u{1}", ReadBudget { rows: usize::MAX, entries: usize::MAX, ..ReadBudget::default() }, &mut |_| true, &mut |key, value| {
        if walked >= page {
            finished = false;
            return Ok(false);
        }
        let id = key[2..].to_string();
        let record = value.map(unpack).transpose().map_err(|error| kept_runs::Error::Corrupt("kept record is not a packed record", error.cause()))?;
        if let Some(record) = &record {
            if let (Some(kind), Some(fields)) = (&record.kept.record_type, &record.kept.value) {
                *build.counts.entry(kind.clone()).or_insert(0) += 1;
                build.sums.add(&id, kind, &fields_map(fields));
            }
            if let Some(meta) = &record.kept.meta {
                build.sums.stamps(&id, None, Some(&serde_json::to_string(meta).unwrap_or_default()));
            }
        }
        build.after = Some(id);
        walked += 1;
        Ok(true)
    })?;
    build.at = applied;
    if !finished {
        keys.meta_set(tx, COUNT_BUILD, &serde_json::to_value(&build)?)?;
        counting.building = Some(build);
        return Ok(false);
    }
    counting.counts = Some(build.counts);
    counting.sums = Some(build.sums);
    keys.meta_remove(tx, COUNT_BUILD)?;
    write_out(tx, keys, counting, applied, tail)?;
    Ok(true)
}

const SCHEMA:&str="CREATE TABLE record_log_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1),account TEXT NOT NULL,resource TEXT NOT NULL,packed_format TEXT NOT NULL);
CREATE TABLE record_log(id TEXT NOT NULL,transaction_id TEXT NOT NULL,actor_context TEXT NOT NULL,application_time TEXT NOT NULL,system_time TEXT NOT NULL,part INTEGER NOT NULL,parts INTEGER NOT NULL,envelopes TEXT NOT NULL,keys TEXT,requests TEXT);";
/// The open log's table, made again when a generation is sealed (old LOG_TABLE_SQL).
const LOG_TABLE:&str="CREATE TABLE record_log(id TEXT NOT NULL,transaction_id TEXT NOT NULL,actor_context TEXT NOT NULL,application_time TEXT NOT NULL,system_time TEXT NOT NULL,part INTEGER NOT NULL,parts INTEGER NOT NULL,envelopes TEXT NOT NULL,keys TEXT,requests TEXT);";
fn validate_scope(scope: &Scope) -> Result<()> {
    for s in [&scope.account, &scope.resource] {
        if s.is_empty() || s.len() > 4096 || s.contains('\0') {
            return Err(Error::Invalid("invalid compact record scope", crate::cause!()));
        }
    }
    Ok(())
}
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 4096 || id.contains('/') || id.contains('\0') {
        Err(Error::Invalid("invalid root record identity", crate::cause!()))
    } else {
        Ok(())
    }
}
fn validate_request(request: &Request) -> Result<()> {
    if request.key.is_empty()
        || request.key.len() > 512
        || request.key.contains('\0')
        || request.sent_at_ms < 0
    {
        Err(Error::Invalid("invalid stable record request", crate::cause!()))
    } else {
        Ok(())
    }
}
fn validate_context(context: &Context) -> Result<()> {
    if !context.actor.is_object()
        || serde_json::to_vec(&context.actor)?.len() > 16 * 1024
        || context.application_time.is_empty()
        || context.system_time.is_empty()
        || context.application_time.len() > 128
        || context.system_time.len() > 128
        || context.accepted_at_ms < 0
    {
        Err(Error::Invalid("invalid record write context", crate::cause!()))
    } else {
        Ok(())
    }
}
fn validate_batch(records: &[RecordInput]) -> Result<()> {
    if records.len() > MAX_BATCH_RECORDS || serde_json::to_vec(records)?.len() > MAX_BATCH_BYTES {
        return Err(crate::cause!(Error::Bounds));
    }
    for r in records {
        validate_id(&r.id)?;
        if r.value.is_some()
            && (r.record_type.is_empty()
                || r.record_type.len() > 4096
                || r.record_type.contains('\0'))
        {
            return Err(Error::Invalid("invalid record type", crate::cause!()));
        }
    }
    Ok(())
}
fn validate_log_id(id: &str) -> Result<()> {
    if id.len() != 36
        || id.as_bytes()[14] != b'7'
        || ![b'8', b'9', b'a', b'b'].contains(&id.as_bytes()[19])
        || !id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
            }
        })
    {
        Err(Error::Invalid("canonical UUIDv7 log ID required", crate::cause!()))
    } else {
        Ok(())
    }
}
fn sequence(id: &str, index: usize) -> Result<String> {
    validate_log_id(id)?;
    if index > 65535 {
        return Err(crate::cause!(Error::Bounds));
    }
    Ok(format!(
        "{}{}{}{:04x}",
        &id[0..8],
        &id[9..13],
        &id[15..18],
        index
    ))
}
fn require(
    admission: &dyn Admission,
    scope: &Scope,
    request: &Request,
    identity: &str,
) -> Result<()> {
    if admission.assert_current(scope, request, identity) {
        Ok(())
    } else {
        Err(crate::cause!(Error::Refused))
    }
}
fn data_version(db: &Connection) -> Result<i64> {
    Ok(db.query_row("PRAGMA data_version", [], |r| r.get(0))?)
}
fn id_key(id: &str) -> String {
    format!("i{SEP}{id}")
}
fn type_key(kind: &str, id: &str) -> String {
    format!("t{SEP}{kind}{SEP}{id}")
}
fn record_key(kind: &str, seq: &str, id: &str) -> String {
    format!("r{SEP}{kind}{SEP}{seq}{SEP}{id}")
}
fn request_key(key: &str) -> String {
    format!("q{SEP}{}", blake3::hash(key.as_bytes()).to_hex())
}
fn request_time(at: i64, key: &str) -> String {
    format!(
        "u{SEP}{at:016x}{SEP}{}",
        blake3::hash(key.as_bytes()).to_hex()
    )
}
fn add_work(total: &mut kept_runs::Work, part: &kept_runs::Work) {
    total.add(part);
}
fn lookup(
    db: &Connection,
    keys: &mut KeptRuns,
    key: &str,
    work: &mut Work,
) -> Result<Option<Value>> {
    let read = keys.get(db, key, ReadBudget::default())?;
    add_work(&mut work.selected, &read.work);
    Ok(match read.result {
        Lookup::Value(v) => Some(v),
        Lookup::Absent | Lookup::Tombstone => None,
    })
}
#[derive(Serialize, Deserialize)]
struct Packed {
    kind: Option<String>,
    sequence: Option<String>,
    fields: Option<Vec<(String, Value)>>,
    meta: Option<PackedMeta>,
}
#[derive(Serialize, Deserialize)]
struct PackedMeta {
    at: String,
    f: Option<String>,
    k: Option<stamps::FloorKind>,
    s: Vec<(String, String)>,
    d: Vec<(String, String)>,
}
fn pack(value: &Projected) -> Result<Value> {
    Ok(serde_json::to_value(Packed {
        kind: value.kept.record_type.clone(),
        sequence: value.sequence.clone(),
        fields: value
            .kept
            .value
            .as_ref()
            .map(|f| f.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect()),
        meta: value.kept.meta.as_ref().map(|m| PackedMeta {
            at: m.at.clone(),
            f: m.f.clone(),
            k: m.k,
            s: m.s.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect(),
            d: m.d.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect(),
        }),
    })?)
}
fn unpack(value: Value) -> Result<Projected> {
    let v: Packed = serde_json::from_value(value)?;
    Ok(Projected {
        sequence: v.sequence,
        kept: Kept {
            record_type: v.kind,
            value: v.fields.map(|v| v.into_iter().collect()),
            meta: v.meta.map(|m| Meta {
                at: m.at,
                f: m.f,
                k: m.k,
                s: m.s.into_iter().collect(),
                d: m.d.into_iter().collect(),
            }),
        },
    })
}
fn read_projected(
    db: &Connection,
    keys: &mut KeptRuns,
    id: &str,
    work: &mut Work,
) -> Result<Option<Projected>> {
    lookup(db, keys, &id_key(id), work)?.map(unpack).transpose()
}
fn fields_equal(a: &Value, b: &Value, text: &dyn ValueText) -> Result<bool> {
    Ok(text.encode(a)? == text.encode(b)?)
}
fn envelope_for(
    record: &RecordInput,
    before: Option<&Projected>,
    text: &dyn ValueText,
) -> Result<Option<Envelope>> {
    let live = before.filter(|p| p.kept.record_type.is_some());
    let body = match &record.value {
        None => {
            if live.is_none() {
                return Ok(None);
            }
            EnvelopeBody::Remove
        }
        Some(value) => {
            if live.is_none()
                || live.and_then(|p| p.kept.record_type.as_deref())
                    != Some(record.record_type.as_str())
            {
                EnvelopeBody::Whole(value.clone())
            } else {
                let old = live
                    .and_then(|p| p.kept.value.as_ref())
                    .ok_or(crate::cause!(Error::Corrupt))?;
                let mut set = Fields::new();
                let mut unset = Vec::new();
                for (field, value) in value.iter() {
                    if match old.get(field) {
                        None => true,
                        Some(old) => !fields_equal(old, value, text)?,
                    } {
                        set.insert(field, value.clone());
                    }
                }
                for field in old.keys() {
                    if value.get(field).is_none() {
                        unset.push(field.to_string());
                    }
                }
                if set.is_empty() && unset.is_empty() {
                    return Ok(None);
                }
                EnvelopeBody::Patch { set, unset }
            }
        }
    };
    Ok(Some(Envelope {
        id: record.id.clone(),
        record_type: Some(record.record_type.clone()),
        body,
        at: None,
        floor: None,
        floor_kind: None,
        stamps: StampMap::new(),
        removed: StampMap::new(),
    }))
}
fn annotate(envelope: &Envelope, before: Option<&Projected>) -> HistoryEnvelope {
    let before = before.filter(|p| p.kept.record_type.is_some());
    let (mut prior, mut was, mut added) = (None, None, Vec::new());
    match &envelope.body {
        EnvelopeBody::Whole(_) | EnvelopeBody::Remove => {
            prior = Some(before.and_then(|p| {
                Some(Prior {
                    record_type: p.kept.record_type.clone()?,
                    value: p.kept.value.clone()?,
                })
            }))
        }
        EnvelopeBody::Patch { set, unset } => {
            let mut old = Fields::new();
            for field in set.keys().chain(unset.iter().map(String::as_str)) {
                if let Some(value) = before
                    .and_then(|p| p.kept.value.as_ref())
                    .and_then(|v| v.get(field))
                {
                    old.insert(field, value.clone());
                } else if !unset.iter().any(|v| v == field) {
                    added.push(field.to_string());
                }
            }
            was = Some(old);
        }
    }
    HistoryEnvelope {
        envelope: envelope.clone(),
        prior,
        was,
        added,
    }
}
fn apply_envelope(
    before: Option<&Projected>,
    envelope: &Envelope,
    stamp: &str,
    text: &dyn ValueText,
) -> Result<Option<Projected>> {
    let current = stamps::state_of(before.map(|p| &p.kept));
    let incoming = stamps::state_from(envelope, stamp);
    let joined = stamps::merge(&current, &incoming, &|value: &Value| text.encode(value))?;
    Ok(stamps::kept_from(&joined).map(|kept| {
        let sequence = if kept.record_type.is_some() {
            before
                .filter(|p| p.kept.record_type == kept.record_type)
                .and_then(|p| p.sequence.clone())
                .or_else(|| Some(stamp.to_string()))
        } else {
            None
        };
        Projected { sequence, kept }
    }))
}
/// Bytes a replaced record leaves behind in written-out runs, charged once as compaction debt (old
/// obsoleteRecordBytes, record-log-store.mjs:1893). The packed record's JSON stands for the old size estimate.
fn obsolete_record_bytes(id: &str, before: Option<&Projected>) -> Result<usize> {
    Ok(match before {
        Some(before) => 32 + id_key(id).encode_utf16().count() * 2 + 2 * serde_json::to_string(&pack(before)?)?.encode_utf16().count(),
        None => 0,
    })
}
/// Bytes a retired index key leaves behind (old obsoleteIndexBytes, :1896); its entry is `1`.
fn obsolete_index_bytes(key: &str) -> usize {
    32 + key.encode_utf16().count() * 2 + 2
}
/// Bytes a retired index entry leaves behind, its entry's JSON included (old obsoleteIndexBytes(key, entry)).
fn obsolete_entry_bytes(key: &str, entry: &Value) -> usize {
    32 + key.encode_utf16().count() * 2 + serde_json::to_string(entry).map(|t| t.encode_utf16().count()).unwrap_or(1) * 2
}
fn update_projection(
    db: &Connection,
    keys: &mut KeptRuns,
    counting: &mut Counting,
    indexes: &[Index],
    text: &dyn ValueText,
    id: &str,
    before: Option<&Projected>,
    after: Option<&Projected>,
    work: &mut Work,
) -> Result<()> {
    // Index entries the record held and holds: those it no longer holds are retired, new ones put (old setRecord,
    // :1919-1936, and removeRecord, :1960-1963).
    let (had, now): (BTreeMap<String, Value>, BTreeMap<String, Value>) = {
        let mut spent = Work::default();
        let mut lookup = |shared: &str| -> Result<Option<Fields>> { Ok(read_projected(db, keys, shared, &mut spent)?.and_then(|p| p.kept.value)) };
        (index_entries_of(indexes, before, id, text, &mut lookup)?.into_iter().collect(), index_entries_of(indexes, after, id, text, &mut lookup)?.into_iter().collect())
    };
    for (key, entry) in had.iter().filter(|(k, _)| !now.contains_key(*k)) {
        keys.remove_replacing(key, obsolete_entry_bytes(key, entry))?;
        work.logical_projection_updates += 1;
    }
    // An entry carrying fields is put again when what it carries changed, its key the same (old setRecord, :1928-1936).
    for (key, entry) in &now {
        match had.get(key) {
            None => keys.put(key, entry.clone())?,
            Some(prior) if prior != entry => keys.put_replacing(key, entry.clone(), obsolete_entry_bytes(key, prior))?,
            Some(_) => continue,
        }
        work.logical_projection_updates += 1;
    }
    counting.record(id, before, after);
    let old_address =
        before.and_then(|p| Some((p.kept.record_type.as_deref()?, p.sequence.as_deref()?)));
    let new_address =
        after.and_then(|p| Some((p.kept.record_type.as_deref()?, p.sequence.as_deref()?)));
    if let Some(before) = before {
        if old_address != new_address {
            if let (Some(kind), Some(seq)) = (&before.kept.record_type, &before.sequence) {
                let (record, kind_key) = (record_key(kind, seq, id), type_key(kind, id));
                keys.remove_replacing(&record, obsolete_index_bytes(&record))?;
                keys.remove_replacing(&kind_key, obsolete_index_bytes(&kind_key))?;
                work.logical_projection_updates += 2;
            }
        }
    }
    // Every record held has its directory head; a record that leaves entirely leaves it (old keepDirectoryHead and
    // dropDirectoryHead, :589-595).
    match (before.is_some(), after.is_some()) {
        (false, true) => keys.put(&directory_key(id), json!(1))?,
        (true, false) => {
            let key = directory_key(id);
            keys.remove_replacing(&key, obsolete_index_bytes(&key))?;
        }
        _ => {}
    }
    let replaced = obsolete_record_bytes(id, before)?;
    match after {
        Some(after) => {
            keys.put_replacing(&id_key(id), pack(after)?, replaced)?;
            work.logical_projection_updates += 1;
            if old_address != new_address {
                if let (Some(kind), Some(seq)) = (&after.kept.record_type, &after.sequence) {
                    keys.put(&record_key(kind, seq, id), json!(1))?;
                    keys.put(&type_key(kind, id), json!(1))?;
                    keys.put(&format!("y{SEP}{kind}"), json!(1))?;
                    work.logical_projection_updates += 3;
                }
            }
        }
        None => {
            keys.remove_replacing(&id_key(id), replaced)?;
            work.logical_projection_updates += 1;
        }
    }
    Ok(())
}
fn prepare_request_change(
    db: &Connection,
    keys: &mut KeptRuns,
    request: &Request,
    entry: Retried,
    from: i64,
    work: &mut Work,
) -> Result<RequestChange> {
    let mut count = lookup(db, keys, "Q\0count", work)?
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let mut floor = from;
    let mut head = lookup(db, keys, "Q\0head", work)?
        .map(serde_json::from_value::<String>)
        .transpose()?;
    let page = keys.range(
        db,
        kept_runs::Range {
            lo: "u\0",
            hi: "u\u{1}",
            after: head.as_deref(),
            reverse: false,
            limit: 64,
        },
        ReadBudget::default(),
    )?;
    add_work(&mut work.selected, &page.work);
    let mut removed = Vec::new();
    let mut taken = BTreeSet::new();
    if let Some(existing) = lookup(db, keys, &request_key(&request.key), work)? {
        let old: Retried = serde_json::from_value(existing)?;
        let time = request_time(old.accepted_at_ms, &request.key);
        if lookup(db, keys, &time, work)?.is_some() {
            taken.insert(time.clone());
            removed.push((time, Some(request_key(&request.key))));
            count = count.saturating_sub(1);
        }
    }
    for (time, value) in page.entries {
        let entry: (String, i64) = serde_json::from_value(value)?;
        if taken.contains(&time) {
            continue;
        }
        if entry.1 >= floor && count < MAX_REQUEST_KEYS {
            break;
        }
        let live = lookup(db, keys, &request_key(&entry.0), work)?
            .map(serde_json::from_value::<Retried>)
            .transpose()?;
        let key = live
            .filter(|v| v.accepted_at_ms == entry.1)
            .map(|_| request_key(&entry.0));
        removed.push((time.clone(), key));
        head = Some(time);
        count = count.saturating_sub(1);
        if entry.1 >= floor {
            floor = entry.1.saturating_add(1);
        }
    }
    if count >= MAX_REQUEST_KEYS {
        return Err(crate::cause!(Error::Bounds));
    }
    Ok(RequestChange {
        key: request.key.clone(),
        entry,
        removed,
        checked_from: floor,
        count: count + 1,
        head,
    })
}
fn apply_request_change(
    keys: &mut KeptRuns,
    change: &RequestChange,
    work: &mut Work,
) -> Result<()> {
    for (time, key) in &change.removed {
        keys.remove(time)?;
        work.logical_projection_updates += 1;
        if let Some(key) = key {
            keys.remove(key)?;
            work.logical_projection_updates += 1;
        }
    }
    keys.put(
        &request_key(&change.key),
        serde_json::to_value(&change.entry)?,
    )?;
    keys.put(
        &request_time(change.entry.accepted_at_ms, &change.key),
        json!([change.key, change.entry.accepted_at_ms]),
    )?;
    keys.put("Q\0from", json!(change.checked_from))?;
    keys.put("Q\0count", json!(change.count))?;
    work.logical_projection_updates += 4;
    if let Some(head) = &change.head {
        keys.put("Q\0head", json!(head))?;
        work.logical_projection_updates += 1;
    }
    Ok(())
}
/// The write's merge step, paid by the bytes it added. It runs under its own
/// savepoint: a step that fails is undone and recorded, never a refused save,
/// because a maintenance defect that blocked every save is the failure this
/// replaces. Only a failed savepoint or catalogue reload fails the write.
fn maintain(tx: &Connection, keys: &mut KeptRuns, debt: usize, work: &mut Work) -> Result<()> {
    let before = tx.total_changes();
    tx.execute_batch("SAVEPOINT kept_maintenance")?;
    match keys.maintain(tx, debt, ReadBudget::default()) {
        Ok(done) => {
            tx.execute_batch("RELEASE kept_maintenance")?;
            work.maintenance = done;
        }
        Err(e) => {
            tx.execute_batch("ROLLBACK TO kept_maintenance; RELEASE kept_maintenance")?;
            keys.reload_catalog(tx)?;
            work.maintenance_refused = Some(format!("{e:?}"));
        }
    }
    work.maintenance_user_rows_changed = tx.total_changes().saturating_sub(before);
    Ok(())
}
fn utf8_chunks(text: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + max).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        out.push(&text[start..end]);
        start = end;
    }
    out
}

/// rowid, id, transaction id, part, parts, envelopes, requests of a group's first row.
type JournalHead = (i64, String, String, i64, i64, String, Option<String>);
fn synchronize(
    db: &Connection,
    state: &mut State<'_>,
    text: &dyn ValueText,
    work: &mut Work,
) -> Result<bool> {
    let State { keys, applied, version, stale, counting, tail, indexes } = state;
    let current_version = data_version(db)?;
    work.journal_sql_statements += 1;
    let end: i64 = db.query_row("SELECT COALESCE(MAX(rowid),0)FROM record_log", [], |r| {
        r.get(0)
    })?;
    work.journal_sql_statements += 1;
    work.journal_rows_read += 1;
    // A log that ends before where this projection stands lost rows to a rollback nobody reported: rebuild before
    // anything is built on it (old invariant 1).
    if **stale || current_version != **version || end < **applied {
        keys.reset_after_rollback(db)?;
        let covered = keys.covered(db)?;
        **applied = covered
            .as_ref()
            .and_then(|v| v.get("record_log_row").and_then(Value::as_i64))
            .unwrap_or(0);
        // Counts are exact from the checkpoint that kept them. A store never written out holds no record yet, so its
        // counts are exact too; a checkpoint written before counts were kept leaves them unknown until the build ends.
        counting.counts = match &covered {
            None => Some(BTreeMap::new()),
            Some(covered) => covered.get("counts").map(|c| serde_json::from_value(c.clone())).transpose()?,
        };
        // The checksum is known only beside its counts (old replay, :2063-2069).
        counting.sums = match &covered {
            None => Some(Sums::new()),
            Some(covered) => match (covered.get("sums").and_then(Value::as_str), &counting.counts) {
                (Some(text), Some(_)) => Some(Sums::from_text(text).ok_or(crate::cause!(Error::Corrupt))?),
                _ => None,
            },
        };
        counting.building = if counting.sums.is_none() {
            keys.meta_get(db, COUNT_BUILD)?.map(serde_json::from_value).transpose()?
        } else {
            None
        };
        counting.directory = match &covered {
            None => true,
            Some(covered) => covered.get("bucket_directory").is_some_and(|d| d.get("signature").and_then(Value::as_str) == Some(DIRECTORY_EPOCH) && d.get("ready") == Some(&json!(true))),
        };
        counting.replaying = None;
        **tail = 0;
        **version = current_version;
        **stale = false;
    }
    if **applied > end {
        return Err(crate::cause!(Error::Corrupt));
    }
    let mut groups = 0usize;
    let mut replay_bytes = 0usize;
    // Groups wait in a batch of at most 256 envelopes or 2 MiB of their text, whose prior records are read together
    // (old replayLogBatches, :262, and applyBatch); each group is still applied whole and in order.
    let mut batch: Vec<(i64, String, usize, Vec<HistoryEnvelope>, Option<RequestChange>)> = Vec::new();
    let (mut queued, mut queued_bytes) = (0usize, 0usize);
    let mut position = **applied;
    while position < end && groups < 256 {
        let first:Option<JournalHead>=db.query_row("SELECT rowid,id,transaction_id,part,parts,CASE WHEN length(CAST(envelopes AS BLOB))<=33554432 THEN envelopes ELSE NULL END,CASE WHEN requests IS NULL OR length(CAST(requests AS BLOB))<=33554432 THEN requests ELSE NULL END FROM record_log WHERE rowid>? ORDER BY rowid LIMIT 1",[position],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
        work.journal_sql_statements += 1;
        let Some((at, id, transaction, part, parts, body, request)) = first else {
            return Err(crate::cause!(Error::Corrupt));
        };
        work.journal_rows_read += 1;
        // This explicitly bound Rust format journals every changed request in
        // part zero. Missing/oversized metadata cannot silently lose retry
        // identity and turn a recovered command into a fresh effect.
        let request = request.ok_or(crate::cause!(Error::Corrupt))?;
        if part != 0 || parts < 1 || parts as usize > MAX_JOURNAL_BYTES / LOG_ROW_BYTES + 1 {
            return Err(crate::cause!(Error::Corrupt));
        }
        validate_log_id(&id)?;
        let mut whole = body;
        if whole.len() > MAX_JOURNAL_BYTES {
            return Err(crate::cause!(Error::Bounds));
        }
        let mut final_at = at;
        for index in 1..parts {
            let row:Option<(i64,String,String,i64,i64,String)>=db.query_row("SELECT rowid,id,transaction_id,part,parts,CASE WHEN length(CAST(envelopes AS BLOB))<=33554432 THEN envelopes ELSE NULL END FROM record_log WHERE rowid>? ORDER BY rowid LIMIT 1",[final_at],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
            work.journal_sql_statements += 1;
            let Some((next, next_id, tx, part, all, body)) = row else {
                return Err(crate::cause!(Error::Corrupt));
            };
            work.journal_rows_read += 1;
            if next_id != format!("{id}.{index}")
                || tx != transaction
                || part != index
                || all != parts
                || body.len() > MAX_JOURNAL_BYTES - whole.len()
            {
                return Err(crate::cause!(Error::Corrupt));
            }
            whole.push_str(&body);
            final_at = next;
        }
        replay_bytes = replay_bytes.saturating_add(whole.len());
        if replay_bytes > MAX_JOURNAL_BYTES && groups > 0 {
            apply_batch(db, keys, counting, indexes, text, applied, tail, &mut batch, work)?;
            return Ok(false);
        }
        let events: Vec<HistoryEnvelope> = serde_json::from_str(&whole)?;
        if events.len() > MAX_BATCH_RECORDS {
            return Err(crate::cause!(Error::Bounds));
        }
        // Parse the complete group before changing any current-record key.
        let change: Option<RequestChange> = serde_json::from_str(&request)?;
        let size = whole.len();
        if !batch.is_empty() && (queued + events.len() > 256 || queued_bytes + size > 2 * 1024 * 1024) {
            apply_batch(db, keys, counting, indexes, text, applied, tail, &mut batch, work)?;
            (queued, queued_bytes) = (0, 0);
        }
        queued += events.len();
        queued_bytes += size;
        batch.push((final_at, id, parts as usize, events, change));
        position = final_at;
        groups += 1;
    }
    apply_batch(db, keys, counting, indexes, text, applied, tail, &mut batch, work)?;
    Ok(**applied == end)
}

const AFTER: &str = "\u{1}";
fn index_prefix(kind: &str, name: &str) -> String {
    format!("f{SEP}{kind}{SEP}{name}{SEP}")
}
/// Old isScalarField, :231: a value of its own, not an object or a list of objects.
fn is_scalar_field(value: &Value) -> bool {
    !value.is_object() && !value.as_array().is_some_and(|items| !items.is_empty() && items.iter().all(Value::is_object))
}
/// The index entries a record holds (old indexEntriesOf/indexKeysOf, :1850-1878): each key, and its value, `1` or
/// the carried fields (old carriedOf, :1823, `{ carry: [...] }`, a missing field null).
fn index_entries_of(indexes: &[Index], record: Option<&Projected>, id: &str, text: &dyn ValueText, lookup: &mut dyn FnMut(&str) -> Result<Option<Fields>>) -> Result<Vec<(String, Value)>> {
    let Some(record) = record else { return Ok(Vec::new()) };
    let (Some(kind), Some(fields)) = (record.kept.record_type.as_deref(), record.kept.value.as_ref()) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    'index: for index in indexes.iter().filter(|i| i.kind == kind) {
        let mut parts = Vec::with_capacity(index.paths.len());
        for path in &index.paths {
            let Some(found) = at_path_linked(fields, path, lookup)? else { continue 'index };
            parts.push(text.encode(&found)?);
        }
        let entry = if index.carry.is_empty() {
            json!(1)
        } else {
            json!({ "carry": index.carry.iter().map(|path| field_at(fields, path).cloned().unwrap_or(Value::Null)).collect::<Vec<_>>() })
        };
        out.push((format!("{}{}{SEP}{id}", index_prefix(kind, &index.name), parts.join(SEP)), entry));
    }
    Ok(out)
}

/// The value at `path` as the record keeps it, whatever it is (old fieldAt, :825).
fn field_at<'v>(fields: &'v Fields, path: &[String]) -> Option<&'v Value> {
    let (first, rest) = path.split_first()?;
    let mut at = fields.get(first)?;
    for field in rest {
        at = at.as_object()?.get(field)?;
    }
    Some(at)
}
/// A record's fields as a JSON object map.
fn fields_map(fields: &Fields) -> serde_json::Map<String, Value> {
    fields.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}
fn declared<'o>(options: &'o LogOptions, kind: &str, name: &str) -> Result<&'o Index> {
    options.indexes.iter().find(|i| i.kind == kind && i.name == name).ok_or(Error::Invalid("no index of that name is declared for that kind", crate::cause!()))
}
/// The index declared on exactly these paths (old indexOnPaths, :705).
fn index_on<'o>(options: &'o LogOptions, kind: &str, paths: &[Vec<String>]) -> Result<&'o Index> {
    options.indexes.iter().find(|i| i.kind == kind && i.paths == paths).ok_or(Error::Invalid("no index on that field is declared for that kind", crate::cause!()))
}
/// An index key's id and decoded values.
fn entry_of(key: &str, prefix: usize) -> Result<IndexEntry> {
    let mut parts: Vec<&str> = key.get(prefix..).ok_or(crate::cause!(Error::Corrupt))?.split(SEP).collect();
    let id = parts.pop().ok_or(crate::cause!(Error::Corrupt))?.to_string();
    Ok(IndexEntry { id, values: parts.into_iter().map(serde_json::from_str).collect::<std::result::Result<_, _>>()?, carried: None })
}
/// The key range a scan reads below a base prefix (old scan, :2752-2770).
fn bounds_of(base: &str, from: Option<&Value>, to: Option<&Value>, after: Option<&Value>, before: Option<&Value>, starts_with: Option<&str>, text: &dyn ValueText) -> Result<(String, String)> {
    let mut lo = base.to_string();
    let mut hi = format!("{}{AFTER}", &base[..base.len() - 1]);
    if let Some(from) = from {
        lo = format!("{base}{}", text.encode(from)?);
    }
    if let Some(after) = after {
        lo = format!("{base}{}{AFTER}", text.encode(after)?);
    }
    if let Some(to) = to {
        hi = format!("{base}{}{AFTER}", text.encode(to)?);
    }
    if let Some(before) = before {
        hi = format!("{base}{}{SEP}", text.encode(before)?);
    }
    if let Some(starts) = starts_with {
        let quoted = serde_json::to_string(starts)?;
        lo = format!("{base}{}", &quoted[..quoted.len() - 1]);
        let mut units: Vec<u16> = lo.encode_utf16().collect();
        let last = units.pop().ok_or(crate::cause!(Error::Corrupt))?;
        units.push(last + 1);
        hi = String::from_utf16(&units).map_err(|_| Error::Invalid("starts_with cannot end in half a character", crate::cause!()))?;
    }
    Ok((lo, hi))
}
fn scan_index(db: &Connection, keys: &mut KeptRuns, options: &LogOptions, text: &dyn ValueText, kind: &str, name: &str, scan: &Scan, work: &mut Work) -> Result<Vec<IndexEntry>> {
    let index = declared(options, kind, name)?;
    let root = index_prefix(kind, name);
    let base = format!("{root}{}", scan.equal.iter().map(|v| text.encode(v).map(|t| format!("{t}{SEP}"))).collect::<Result<String>>()?);
    let (lo, hi) = if scan.equal.is_empty() {
        let (lo, _) = bounds_of(&base, scan.from.as_ref(), None, scan.after.as_ref(), None, scan.starts_with.as_deref(), text)?;
        let (_, hi) = bounds_of(&base, None, scan.to.as_ref(), None, scan.before.as_ref(), scan.starts_with.as_deref(), text)?;
        let hi = if scan.to.is_none() && scan.before.is_none() && scan.starts_with.is_none() { format!("{}{AFTER}", &root[..root.len() - 1]) } else { hi };
        (lo, hi)
    } else if scan.equal.len() >= index.paths.len() {
        (base.clone(), format!("{}{AFTER}", &base[..base.len() - 1]))
    } else {
        bounds_of(&base, scan.from.as_ref(), scan.to.as_ref(), scan.after.as_ref(), scan.before.as_ref(), scan.starts_with.as_deref(), text)?
    };
    let limit = scan.limit.unwrap_or(usize::MAX);
    let mut out = Vec::new();
    if limit == 0 || lo.encode_utf16().cmp(hi.encode_utf16()) != std::cmp::Ordering::Less {
        return Ok(out);
    }
    let mut after: Option<String> = None;
    loop {
        let want = (limit - out.len()).min(4096);
        let page = keys.range(db, kept_runs::Range { lo: &lo, hi: &hi, after: after.as_deref(), reverse: scan.reverse, limit: want }, ReadBudget::default())?;
        add_work(&mut work.selected, &page.work);
        for (key, value) in &page.entries {
            let mut entry = entry_of(key, root.len())?;
            if scan.carried && !index.carry.is_empty() {
                let held = value.get("carry").and_then(Value::as_array);
                entry.carried = Some(index.carry.iter().enumerate().map(|(at, path)| (path.join("."), held.and_then(|h| h.get(at)).cloned().unwrap_or(Value::Null))).collect());
            }
            out.push(entry);
        }
        if page.complete || out.len() >= limit {
            return Ok(out);
        }
        after = page.next;
    }
}
/// Selected top-level fields of records of one kind, each with its id (old fieldsFromRecords, :2921).
fn fields_from_records(db: &Connection, keys: &mut KeptRuns, kind: &str, ids: &[String], names: &[&str], work: &mut Work) -> Result<BTreeMap<String, Value>> {
    let mut found = BTreeMap::new();
    for id in ids {
        if found.contains_key(id) {
            continue;
        }
        let Some(record) = read_projected(db, keys, id, work)? else { continue };
        if record.kept.record_type.as_deref() != Some(kind) {
            continue;
        }
        let Some(fields) = record.kept.value else { continue };
        let mut out = serde_json::Map::new();
        out.insert("id".into(), json!(id));
        for name in names {
            if let Some(value) = fields.get(name).filter(|v| is_scalar_field(v)) {
                out.insert(name.to_string(), value.clone());
            }
        }
        found.insert(id.clone(), Value::Object(out));
    }
    Ok(found)
}

/// The value as kept (old storedForm, :1726): every nested object the host's rule names becomes a link, and the
/// objects to keep once are answered as (id, kind, value). An object that is already a link stays one, so a stored
/// value written back is unchanged.
fn stored_form(options: &LogOptions, kind: &str, fields: &Fields) -> (Fields, Vec<(String, String, Fields)>) {
    fn walk(rule: &dyn ContentIds, kind: &str, object: &serde_json::Map<String, Value>, shared: &mut Vec<(String, String, Fields)>) -> serde_json::Map<String, Value> {
        object.iter().map(|(field, item)| (field.clone(), member(rule, kind, field, item, shared))).collect()
    }
    fn member(rule: &dyn ContentIds, kind: &str, field: &str, item: &Value, shared: &mut Vec<(String, String, Fields)>) -> Value {
        let child = format!("{kind}/{field}");
        match item {
            Value::Object(object) if link_of(item).is_none() => {
                let inner = walk(rule, &child, object, shared);
                match rule.content_id(&child, item) {
                    Some(id) => {
                        if !shared.iter().any(|(s, _, _)| *s == id) {
                            shared.push((id.clone(), child, inner.into_iter().collect()));
                        }
                        json!({ SHARED_MARK: id })
                    }
                    None => Value::Object(inner),
                }
            }
            Value::Array(items) if !items.is_empty() && items.iter().all(Value::is_object) => Value::Array(
                items.iter().map(|m| match m { Value::Object(o) if link_of(m).is_none() => Value::Object(walk(rule, &child, o, shared)), other => other.clone() }).collect(),
            ),
            other => other.clone(),
        }
    }
    let Some(Shared(rule)) = &options.shared else { return (fields.clone(), Vec::new()) };
    let mut shared = Vec::new();
    let out = fields.iter().map(|(field, item)| (field.to_string(), member(rule.as_ref(), kind, field, item, &mut shared))).collect();
    (out, shared)
}
/// A value with every link replaced by the object it names, read from the store (old resolve and readShared,
/// :1666-1716); a record that contains itself is refused.
fn resolve_value(db: &Connection, keys: &mut KeptRuns, value: &Value, opening: &mut Vec<String>, work: &mut Work) -> Result<Value> {
    if let Some(id) = link_of(value) {
        if opening.iter().any(|o| o == id) {
            return Err(Error::Invalid("a record contains itself", crate::cause!()));
        }
        opening.push(id.to_string());
        let held = read_projected(db, keys, id, work)?.and_then(|p| p.kept.value);
        let resolved = match held {
            Some(fields) => resolve_value(db, keys, &Value::Object(fields_map(&fields)), opening, work)?,
            None => Value::Null,
        };
        opening.pop();
        return Ok(resolved);
    }
    Ok(match value {
        Value::Object(object) => Value::Object(object.iter().map(|(k, v)| Ok((k.clone(), resolve_value(db, keys, v, opening, work)?))).collect::<Result<_>>()?),
        Value::Array(items) => Value::Array(items.iter().map(|v| resolve_value(db, keys, v, opening, work)).collect::<Result<_>>()?),
        other => other.clone(),
    })
}
fn holds_link(value: &Value) -> bool {
    link_of(value).is_some() || match value {
        Value::Object(o) => o.values().any(holds_link),
        Value::Array(a) => a.iter().any(holds_link),
        _ => false,
    }
}
fn resolve_fields(db: &Connection, keys: &mut KeptRuns, fields: Fields, work: &mut Work) -> Result<Fields> {
    if !fields.iter().any(|(_, v)| holds_link(v)) {
        return Ok(fields);
    }
    let mut opening = Vec::new();
    fields.iter().map(|(k, v)| Ok((k.to_string(), resolve_value(db, keys, v, &mut opening, work)?))).collect()
}
/// The value at `path`, following links (old atPath, :1790).
fn at_path_linked(fields: &Fields, path: &[String], lookup: &mut dyn FnMut(&str) -> Result<Option<Fields>>) -> Result<Option<Value>> {
    let Some((first, rest)) = path.split_first() else { return Ok(None) };
    let Some(mut at) = fields.get(first).cloned() else { return Ok(None) };
    let mut steps = rest.iter();
    loop {
        let mut guard = 0;
        while let Some(id) = link_of(&at).map(str::to_owned) {
            guard += 1;
            if guard > 64 {
                return Err(Error::Invalid("a record contains itself", crate::cause!()));
            }
            at = match lookup(&id)? { Some(f) => Value::Object(fields_map(&f)), None => return Ok(None) };
        }
        let Some(field) = steps.next() else { break };
        let Some(next) = at.as_object().and_then(|o| o.get(field)).cloned() else { return Ok(None) };
        at = next;
    }
    Ok(is_scalar_field(&at).then_some(at))
}

/// The records `ids` hold now, read together through `KeptRuns::ranges` (exact keys).
fn prior_states<'i>(db: &Connection, keys: &mut KeptRuns, ids: impl Iterator<Item = &'i str>, work: &mut Work) -> Result<BTreeMap<String, Option<Projected>>> {
    let mut unique: Vec<&str> = Vec::new();
    for id in ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    if unique.is_empty() {
        return Ok(BTreeMap::new());
    }
    let bounds: Vec<(String, String)> = unique.iter().map(|id| (id_key(id), format!("{}{SEP}", id_key(id)))).collect();
    let (found, read) = keys.ranges(db, &bounds, false, 1, None, ReadBudget::default())?;
    add_work(&mut work.selected, &read);
    let mut out = BTreeMap::new();
    for (id, entries) in unique.into_iter().zip(found) {
        out.insert(id.to_string(), entries.into_iter().next().map(|(_, v)| unpack(v)).transpose()?);
    }
    Ok(out)
}

/// Applies a batch of replayed groups in order, their records' prior states read together first.
#[allow(clippy::too_many_arguments)]
fn apply_batch(
    db: &Connection,
    keys: &mut KeptRuns,
    counting: &mut Counting,
    indexes: &[Index],
    text: &dyn ValueText,
    applied: &mut i64,
    tail: &mut usize,
    batch: &mut Vec<(i64, String, usize, Vec<HistoryEnvelope>, Option<RequestChange>)>,
    work: &mut Work,
) -> Result<()> {
    if batch.is_empty() {
        return Ok(());
    }
    let mut prior = prior_states(db, keys, batch.iter().flat_map(|(_, _, _, events, _)| events.iter().map(|e| e.envelope.id.as_str())), work)?;
    for (final_at, id, parts, events, change) in batch.drain(..) {
        counting.replaying = Some(final_at);
        for (index, event) in events.into_iter().enumerate() {
            let held = match prior.get(&event.envelope.id) {
                Some(held) => held.clone(),
                None => read_projected(db, keys, &event.envelope.id, work)?,
            };
            let next = apply_envelope(held.as_ref(), &event.envelope, &sequence(&id, index)?, text)?;
            update_projection(db, keys, counting, indexes, text, &event.envelope.id, held.as_ref(), next.as_ref(), work)?;
            prior.insert(event.envelope.id.clone(), next);
        }
        counting.replaying = None;
        if let Some(change) = &change {
            apply_request_change(keys, change, work)?;
        }
        *applied = final_at;
        *tail = tail.saturating_add(parts);
    }
    Ok(())
}

/// A kind's name: what `RecordInput::record_type` accepts.
fn validate_kind(kind: &str) -> Result<()> {
    if kind.is_empty() || kind.len() > 4096 || kind.contains('\0') {
        Err(Error::Invalid("invalid record type", crate::cause!()))
    } else {
        Ok(())
    }
}
