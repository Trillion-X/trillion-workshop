// src/storage/record_store/record_sync.rs
//
// TWO COPIES OF ONE RECORD STORE MADE EQUAL BY TRADING ONE ROOT, THEN ONLY THE NET CHANGES, THEN ONLY THE BUCKETS THAT
// STILL DIFFER, SETTLING EVERY CONFLICT THE SAME WAY ON BOTH SIDES AND KEEPING THE VERSION THAT DID NOT WIN.
//
// Purpose
//   A one to one port of old trillion `parts/record-log/do-work/record-sync.mjs` (Trillion-X/trillion origin/main,
//   carried from dev/architect `crates/envelope-engine/src/merge.rs` and `tests/sync_by_root.rs`). A computer keeps its
//   own copy of an account's records so it reads them locally and keeps working while it is out of reach. A copy
//   settles with the one it follows in bounded requests (`settle_with` asks, `answer_settle` answers): it sends its
//   root, how far it took, and the net change of its own rows since it last sent in acknowledged batches
//   (`net_changes`: one envelope per record in each batch); the other side applies each field only where it still
//   holds what the change replaced, and answers with its root, its net changes after that position and, when they can
//   be needed, its buckets. Only when the roots still differ (rows the other side no longer keeps) does the copy ask
//   for the records of exactly the buckets that differ, a bounded page per request. A field both sides changed
//   differently is settled by `by_content` on both sides (the same answer from the same two values, so neither side
//   leads), and both versions are kept in a `kept-apart` record beside it.
//
// Non-Negotiable Invariants
//   1. Both copies settle a conflict the same way without asking each other: `by_content` ranks a removal first (a
//      record one side removed stays removed) and then the lower JSON text; the version that lost is kept, never dropped.
//   2. Applying the same changes twice changes nothing (a field already holding the value is passed over), so a settle
//      cut off anywhere is simply sent again.
//   3. A settle sends bounded batches, advancing its send position only after each batch is acknowledged. A lost
//      acknowledgement safely replays the batch. A settle with nothing changed on either side writes no row anywhere.
//   4. The asking copy keeps its positions (`SettleState`) and the caller stores them; the replying side keeps one
//      position per copy beside the store (`SettleStore::move_position`, never a record, so it never travels), written
//      once per settle and only when it moved. A row a copy wrote while taking the other side's changes is never sent
//      back, and a copy's own rows are never answered back to it.
//   5. Two stores with no leader take from each other one way at a time with `take_from_peer`, each keeping one
//      position per peer; a computer's copy uses the one-request settle.
//   6. Nothing here names a host, a route or a computer: the asker is handed `send(request) -> answer` (in this process,
//      or a message through the forwarder: `src/account/computers/copies.rs`).
//   7. What crosses is the net change of each record, never every row, and every answer is bounded in rows and bytes
//      (`Bounds`, from `settings.json` `settle`: old trillion's 5,000 rows and 4,000,000 characters, here bytes).
//   8. Records taken by bucket are taken only when they add up to the buckets the other side said it holds: a group
//      of buckets is read whole (every page replying to the same requested bucket checksums), summed the way the store
//      sums itself, and compared before anything is taken. Records that arrived changed are refused (status 409) with
//      nothing taken; a group the other side changed while it was read is asked again, and left for the next settle if
//      it keeps moving. Corruption on the way never becomes this copy's records.
//   9. Buckets that differ are merged by stamps both ways (`stamps.rs`), never copied over: what the other side holds
//      later is taken here, and what this copy holds later, or the other side no longer holds at all, goes back to it
//      in the same settle. A settle never undoes a later change on either side, so a copy that lost everything is
//      filled again by its copies.
//
// Also ported (old record-sync.mjs:62, :262-283, :325-336, :372): the keys of erasable records travel beside the rows
// and records that need them, never as records (`keys_beside`: { id: key | None (erased there) }, taken with
// `SettleStore::take_erasure_keys`); a store that must prepare its shared collections first answers `preparing` while
// it does, in bounded steps (`SettleStore::share_fields`), and the asker sends the same request again; and the
// replying side's own rule on what a copy may change (`answer_settle_with`'s `apply`, by default `apply_changes`).
// A store that keeps no erasure keys and shares no fields answers neither (the trait's defaults): the record store's
// erasure takes the values out of its rows (`record_log.rs` `erase_values`) and its removal crosses as any removal.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::digest::{bucket_text, buckets_that_differ, Sums};
use super::stamps::{envelope_of_kept, js_less, kept_from, merge, same_kept, state_from, Envelope, Kept, Meta};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// The record kind conflicts are kept in, unless a caller names its own.
pub const KEPT_APART: &str = "kept-apart";
/// Log rows read per page while gathering net changes (old trillion `PAGE`).
pub const PAGE: usize = 200;
/// Log rows the first page of `changes_after` asks before it knows how large the rows are.
pub const FIRST_PAGE: usize = 8;
/// Buckets read and checked together before any is taken (1/16 of a store held at most).
pub const VERIFY_BUCKETS: usize = 16;
/// How often a group the other side changed during the read is asked again in one settle.
pub const MOVED_TRIES: usize = 3;

/// Who wrote a log row.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Actor {
    pub by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_copy: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub from_leader: bool,
}
impl Actor {
    pub fn by(by: &str) -> Self {
        Self { by: by.into(), ..Self::default() }
    }
}

/// One log row of a store: its id (a UUIDv7, so ids sort by when they were written), who wrote it, its envelopes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LogRow {
    pub id: String,
    #[serde(default)]
    pub actor: Actor,
    pub envelopes: Vec<Envelope>,
}

/// A run of net changes as it crosses: named for the last row it covers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChangeRow {
    pub id: String,
    pub envelopes: Vec<Envelope>,
}

/// A page of a store's log (old trillion `logAfter`).
#[derive(Clone, Debug, Default)]
pub struct LogPage {
    pub rows: Vec<LogRow>,
    /// The first row id the store still keeps.
    pub oldest: Option<String>,
    pub last: Option<String>,
    /// Rows remain after `last`.
    pub more: bool,
}

/// A record as a bucket page answers it: kept form with its id (a removal included: it carries stamps).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BucketRecord {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub value: Option<super::stamps::Fields>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Meta>,
}
impl BucketRecord {
    /// A record as its stamped state: one kept before stamps counts as stamped before every stamped write.
    pub fn stamped(&self) -> Kept {
        Kept { kind: self.kind.clone(), value: self.value.clone(), meta: self.meta.clone().unwrap_or_default() }
    }
}

/// A conflict met while applying (old trillion's conflict object).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Conflict {
    pub id: String,
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub field: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub here: Value,
    #[serde(default)]
    pub there: Value,
    #[serde(default)]
    pub before: Value,
    #[serde(default)]
    pub kept: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

/// What applying changes did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Applied {
    pub applied: usize,
    pub conflicts: Vec<Conflict>,
}

/// A store's order-free checksum.
#[derive(Clone, Debug, PartialEq)]
pub struct Checksum {
    pub root: String,
    pub buckets: String,
}

/// A refusal, with the HTTP status old trillion gave it.
#[derive(Clone, Debug)]
pub struct SyncError {
    pub cause: crate::refusal_cause::Cause,
    pub status: u16,
    pub message: String,
    /// The buckets refused (409).
    pub refused: Vec<usize>,
}
impl SyncError {
    pub fn new(status: u16, message: impl Into<String>, cause: crate::refusal_cause::Cause) -> Self {
        Self { cause, status, message: message.into(), refused: Vec::new() }
    }
    pub fn storage(cause: crate::refusal_cause::Cause) -> Self {
        Self::new(503, "The record store is unavailable.", cause)
    }
}
impl SyncError {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { &self.cause }
}
crate::impl_caused!(SyncError);

impl PartialEq for SyncError {
    fn eq(&self, other: &Self) -> bool {
        self.status == other.status && self.message == other.message && self.refused == other.refused
    }
}
impl From<crate::storage::Error> for SyncError {
    fn from(error: crate::storage::Error) -> Self { Self::storage(error.cause()) }
}
impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.status, self.message)
    }
}
impl std::error::Error for SyncError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// What record sync asks of a store: its log, its checksum, its buckets, and the two ways of writing another copy's
/// state into it. `record_log.rs` implements it over the storage boundary.
pub trait SettleStore {
    fn log_after(&self, position: Option<&str>, limit: usize) -> Result<LogPage, SyncError>;
    fn last_log_id(&self) -> Result<Option<String>, SyncError>;
    fn checksum(&self) -> Result<Checksum, SyncError>;
    /// Applies another copy's changes (`apply_changes` of old trillion): conflicts settle by `by_content`; with
    /// `keep_apart`, every version a conflict met is kept in a record of that kind. One log row.
    fn apply_changes(&mut self, rows: &[ChangeRow], actor: Actor, keep_apart: Option<&str>) -> Result<Applied, SyncError>;
    /// Makes these records exactly as given (value None without meta removes). One log row.
    fn take_records(&mut self, records: &[BucketRecord], actor: Actor) -> Result<usize, SyncError>;
    fn records_in_buckets(&self, buckets: &[usize]) -> Result<Vec<BucketRecord>, SyncError>;
    /// One page of `records_in_buckets` after `after`: at most `limit` records and about `bytes` bytes of values.
    /// Answers the records and the cursor of the next page (None once every record was looked at).
    fn records_in_buckets_page(&self, buckets: &[usize], after: Option<&str>, limit: usize, bytes: usize) -> Result<(Vec<BucketRecord>, Option<String>), SyncError>;
    /// How far `copy` took (the replying side's one position per copy, beside the store).
    fn position(&self, copy: &str) -> Result<Option<String>, SyncError>;
    /// Moves `copy`'s position; false when it already stood there (nothing written).
    fn move_position(&mut self, copy: &str, took_through: Option<&str>, at: &str) -> Result<bool, SyncError>;
    fn forget_position(&mut self, copy: &str) -> Result<bool, SyncError>;
    /// The erasure keys of `ids` (old trillion `erasureKeys`): { id: key | None (erased here) } for the ids that have
    /// one, None when none does. `from_page`: the ids are those of a bucket page this store just answered.
    fn erasure_keys(&self, _ids: &[String], _from_page: bool) -> Result<Option<ErasureKeys>, SyncError> {
        Ok(None)
    }
    /// Keys and erasures another copy sent (old trillion `takeErasureKeys`): a record erased there is erased here too.
    /// Answers the ids erased here.
    fn take_erasure_keys(&mut self, _keys: &ErasureKeys) -> Result<Vec<String>, SyncError> {
        Ok(Vec::new())
    }
    /// One bounded step of preparing the shared collections of kind `kind` (old trillion `shareFields`): true while
    /// more remain.
    fn share_fields(&mut self, _kind: &str) -> Result<bool, SyncError> {
        Ok(false)
    }
}

/// The erasure keys that travel beside rows: { id: key | None (erased there) }.
pub type ErasureKeys = std::collections::BTreeMap<String, Option<String>>;

/// The keys of erasable records beside the rows and records that need them, never as records (old trillion
/// `keysBeside`): None when no id has one.
fn keys_beside(store: &dyn SettleStore, ids: &[String], from_page: bool) -> Result<Option<ErasureKeys>, SyncError> {
    if ids.is_empty() {
        return Ok(None);
    }
    Ok(store.erasure_keys(ids, from_page)?.filter(|keys| !keys.is_empty()))
}

fn ids_of(rows: &[ChangeRow]) -> Vec<String> {
    rows.iter().flat_map(|row| row.envelopes.iter().map(|envelope| envelope.id.clone())).collect()
}

/// The replying side's own rule on what a copy may change (old trillion `answerSettle`'s `apply`): handed the store,
/// the rows the copy sent and who sent them, it answers what it applied. None: `apply_changes`, conflicts settled by
/// `by_content` and kept apart.
pub type Apply<'a> = &'a mut dyn FnMut(&mut dyn SettleStore, &[ChangeRow], Actor) -> Result<Applied, SyncError>;

/// The bounds of one settle (DATA: `settings.json` `settle`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    /// Most log rows one answer reads (old trillion `most_rows` 5,000).
    pub most_rows: usize,
    /// About how many bytes of envelopes one answer or one upload carries (old trillion `SETTLE_CHARS` 4,000,000).
    pub bytes: usize,
    /// Most envelopes one upload batch carries (old trillion `PAGE` 200).
    pub upload_rows: usize,
    /// Most records one bucket page carries (old trillion `recordsInBucketsPage` 500).
    pub bucket_page_records: usize,
    /// Buckets read and checked together.
    pub verify_buckets: usize,
    /// The largest single envelope that crosses alone when it is past `bytes`.
    pub record_bytes: usize,
}
impl Bounds {
    /// The shipped bounds (`settings.json` `settle`).
    pub fn shipped() -> Self {
        super::settings::shipped().map_or_else(Self::default, |settings| settings.settle)
    }
}
impl Default for Bounds {
    fn default() -> Self {
        Self { most_rows: 5000, bytes: 4 * 1024 * 1024, upload_rows: PAGE, bucket_page_records: 500, verify_buckets: VERIFY_BUCKETS, record_bytes: 16 * 1024 * 1024 }
    }
}

/// The JSON text of an optional value (`undefined` and `null` both "null": old trillion `rank`'s and `same`'s view).
fn text_of(value: Option<&Value>) -> Option<String> {
    value.map(super::digest::json_text)
}

/// `same(a, b)` of old trillion: equal JSON text, where None is `undefined` (equal only to `undefined`).
pub fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    text_of(a) == text_of(b)
}

/// Whether the other copy's value wins a conflict: the same answer on both copies. Absent (removed) ranks first, then
/// the lower JSON text. Deterministic and symmetric: `by_content(a, b)` and `by_content(b, a)` never both hold.
pub fn by_content(here: Option<&Value>, there: Option<&Value>) -> bool {
    let rank = |value: Option<&Value>| match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => format!("~{}", super::digest::json_text(value)),
    };
    js_less(&rank(there), &rank(here))
}

/// The time-ordered position of one envelope of a log row (old trillion `seqFrom`): its row's time and in-millisecond
/// count (15 hex digits of the UUIDv7) and its index among the row's envelopes.
pub fn seq_from(row_id: &str, index: usize) -> String {
    let part = |from: usize, to: usize| row_id.get(from..to).unwrap_or("");
    format!("{}{}{}{index:04x}", part(0, 8), part(9, 13), part(15, 18))
}

/// The stamp of one envelope of a log row: its own when it names one, else its position (old trillion `envelopeStamp`).
pub fn envelope_stamp(row_id: &str, envelope: &Envelope, index: usize) -> String {
    envelope.at.clone().or_else(|| envelope.seq.clone()).unwrap_or_else(|| seq_from(row_id, index))
}

#[derive(Default)]
struct Net {
    whole: bool,
    before: Option<super::stamps::Typed>,
    basis: bool,
    kind: Option<String>,
    set: super::stamps::Fields,
    unset: Vec<String>,
    was: super::stamps::Fields,
    added: Vec<String>,
    after: Option<super::stamps::Typed>,
}

/// The net change of a run of log rows (oldest first): one envelope per record, carrying the stamped state those rows
/// left it in (each field touched with the stamp of its last write, and the floor when a whole write or a removal was
/// among them), and what it held before the first of them (`was` or `prior`, when every row said), so a copy that
/// changed it from something else meets a conflict and keeps both versions. A record changed back to what it was still
/// crosses: its stamps moved. Answers [{ id, envelopes }] (one row named for the last row given), or [] when nothing
/// changed.
pub fn net_changes(rows: &[LogRow]) -> Vec<ChangeRow> {
    let mut order: Vec<String> = Vec::new();
    let mut states: HashMap<String, super::stamps::State> = HashMap::new();
    for row in rows {
        for (index, envelope) in row.envelopes.iter().enumerate() {
            // A purge (this copy let go of a record its leader never held) crosses as nothing.
            if envelope.purge {
                states.remove(&envelope.id);
                continue;
            }
            let given = state_from(envelope, &envelope_stamp(&row.id, envelope, index));
            let next = match states.get(&envelope.id) {
                Some(held) if !envelope.exact => merge(held, &given),
                _ => given,
            };
            states.insert(envelope.id.clone(), next);
        }
    }
    let mut by_id: HashMap<String, Net> = HashMap::new();
    for row in rows {
        for envelope in &row.envelopes {
            if envelope.purge {
                by_id.remove(&envelope.id);
                order.retain(|id| id != &envelope.id);
                continue;
            }
            let has_prior = envelope.prior.is_some();
            let prior = envelope.prior.clone().flatten();
            if envelope.whole_or_removal() {
                let after = if envelope.remove {
                    None
                } else {
                    Some(super::stamps::Typed { kind: envelope.kind.clone().unwrap_or_default(), value: envelope.value.clone().unwrap_or_default() })
                };
                match by_id.get_mut(&envelope.id) {
                    None => {
                        order.push(envelope.id.clone());
                        by_id.insert(envelope.id.clone(), Net { whole: true, before: prior, after, basis: has_prior, ..Net::default() });
                    }
                    Some(now) if now.whole => now.after = after,
                    Some(now) => {
                        // A run of field changes before a whole value: what the record held before them is the whole
                        // value's prior with those changes taken back.
                        let before = prior.map(|prior| {
                            let mut value = prior.value.clone();
                            for (field, item) in &now.was {
                                value.insert(field.clone(), item.clone());
                            }
                            for field in &now.added {
                                value.remove(field);
                            }
                            super::stamps::Typed { kind: prior.kind, value }
                        });
                        let basis = now.basis && has_prior;
                        *now = Net { whole: true, before, after, basis, ..Net::default() };
                    }
                }
                continue;
            }
            let set = envelope.set.clone().unwrap_or_default();
            let unset = envelope.unset.clone().unwrap_or_default();
            match by_id.get_mut(&envelope.id) {
                None => {
                    order.push(envelope.id.clone());
                    by_id.insert(
                        envelope.id.clone(),
                        Net {
                            whole: false,
                            kind: envelope.kind.clone(),
                            set,
                            unset,
                            was: envelope.was.clone().unwrap_or_default(),
                            added: envelope.added.clone().unwrap_or_default(),
                            basis: envelope.was.is_some(),
                            ..Net::default()
                        },
                    );
                }
                Some(now) if now.whole => {
                    let mut value = now.after.as_ref().map(|after| after.value.clone()).unwrap_or_default();
                    for field in &unset {
                        value.remove(field);
                    }
                    for (field, item) in &set {
                        value.insert(field.clone(), item.clone());
                    }
                    now.after = Some(super::stamps::Typed { kind: envelope.kind.clone().unwrap_or_default(), value });
                }
                Some(now) => {
                    for field in set.keys().chain(unset.iter()) {
                        let first = !now.was.contains_key(field) && !now.added.contains(field) && !now.set.contains_key(field) && !now.unset.contains(field);
                        if first {
                            match envelope.was.as_ref().and_then(|was| was.get(field)) {
                                Some(item) => {
                                    now.was.insert(field.clone(), item.clone());
                                }
                                None => now.added.push(field.clone()),
                            }
                        }
                    }
                    for field in &unset {
                        now.set.remove(field);
                        if !now.unset.contains(field) {
                            now.unset.push(field.clone());
                        }
                    }
                    for (field, item) in &set {
                        now.set.insert(field.clone(), item.clone());
                        now.unset.retain(|held| held != field);
                    }
                    now.basis = now.basis && envelope.was.is_some();
                }
            }
        }
    }
    let mut envelopes = Vec::new();
    for id in &order {
        let (Some(change), Some(state)) = (by_id.get(id), states.get(id)) else { continue };
        if !state.floor.is_empty() || change.whole {
            // A whole write or a removal among the rows: the state they left, whole, with what came before when known.
            let Some(kept) = kept_from(state) else { continue };
            let mut envelope = envelope_of_kept(id, &kept);
            if change.whole && change.basis {
                envelope.prior = Some(change.before.clone());
            }
            envelopes.push(envelope);
            continue;
        }
        // Field changes only: each field touched, with its stamp and (when every row said) what it held before.
        let mut set = super::stamps::Fields::new();
        let mut unset = Vec::new();
        let mut stamps = std::collections::BTreeMap::new();
        let mut at = String::new();
        for (field, cell) in &state.fields {
            match &cell.value {
                None => unset.push(field.clone()),
                Some(item) => {
                    set.insert(field.clone(), item.clone());
                }
            }
            stamps.insert(field.clone(), cell.stamp.clone());
            if js_less(&at, &cell.stamp) {
                at = cell.stamp.clone();
            }
        }
        stamps.retain(|_, stamp| *stamp != at);
        let was: super::stamps::Fields =
            change.was.iter().filter(|(field, _)| set.contains_key(*field) || unset.contains(field)).map(|(field, item)| (field.clone(), item.clone())).collect();
        let added: Vec<String> = change.added.iter().filter(|field| set.contains_key(*field)).cloned().collect();
        envelopes.push(Envelope {
            id: id.clone(),
            kind: state.kind_of_record.clone().or_else(|| change.kind.clone()),
            set: (!set.is_empty()).then_some(set),
            unset: (!unset.is_empty()).then_some(unset),
            at: Some(at),
            stamps: (!stamps.is_empty()).then_some(stamps),
            was: change.basis.then_some(was),
            added: (!added.is_empty()).then_some(added),
            ..Envelope::default()
        });
    }
    match (envelopes.is_empty(), rows.last()) {
        (false, Some(last)) => vec![ChangeRow { id: last.id.clone(), envelopes }],
        _ => Vec::new(),
    }
}

/// What a store wrote after a position, as net changes (old trillion `changesAfter`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Changes {
    pub rows: Vec<ChangeRow>,
    pub oldest: Option<String>,
    pub last: Option<String>,
    pub rows_read: usize,
    pub more: bool,
}

/// What `store` wrote after `position` (one of its log row ids, or None), as the net change of up to `most_rows` rows
/// and about `bytes` bytes of them. Rows `leave_out(row)` names (an asking copy's own, already held there) are passed
/// over but still move `last`. What crosses to a peer is this, so a record changed a thousand times crosses once.
/// `more`: rows remain after `last`.
pub fn changes_after(store: &dyn SettleStore, position: Option<&str>, most_rows: usize, bytes: usize, leave_out: &dyn Fn(&LogRow) -> bool) -> Result<Changes, SyncError> {
    let mut rows = Vec::new();
    let mut oldest = None;
    let mut last = position.map(str::to_string);
    let mut more = true;
    let mut read = 0;
    let mut size = 0;
    // How many rows the next page asks: what still fits `bytes` at the rows' mean size so far (a first page asks
    // few). A page of PAGE rows of large writes (200 envelopes of 4 KB each, about 800 KB a row) decoded about 160 MB
    // to send the 5 rows that fit 4 MB, on every answer: catch-up from a 256 MB store spent half its time there
    // (measured by `settle_catch_up_measured`: 10 MB/s at 256 MB against 19 MB/s at 16 MB).
    let mut next_ask = FIRST_PAGE;
    let mut kept_rows = 0usize;
    while more && read < most_rows && size < bytes {
        let asked = next_ask.min(PAGE).min(most_rows - read).max(1);
        let page = store.log_after(last.as_deref(), asked)?;
        oldest = page.oldest.clone();
        more = false;
        let count = page.rows.len();
        for (at, row) in page.rows.into_iter().enumerate() {
            read += 1;
            last = Some(row.id.clone());
            if leave_out(&row) {
                continue;
            }
            size += serde_json::to_vec(&row.envelopes).map_or(0, |text| text.len());
            kept_rows += 1;
            rows.push(row);
            if size >= bytes {
                more = at + 1 < count || page.more;
                break;
            }
        }
        if size < bytes {
            more = page.more;
        }
        next_ask = match size.checked_div(kept_rows) {
            Some(mean) if mean > 0 => bytes.saturating_sub(size).div_ceil(mean).saturating_add(1),
            _ => PAGE,
        };
    }
    Ok(Changes { rows: net_changes(&rows), oldest, last, rows_read: read, more })
}

/// What `take_from_peer` did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Taken {
    pub seen: Option<String>,
    pub took: usize,
    pub rows_read: usize,
    pub conflicts: Vec<Conflict>,
    /// The peer no longer keeps every row since `seen`.
    pub gap: bool,
}

/// Takes what `peer` (`changes_after` over the peer's store, through any transport) wrote since `seen` (the last of
/// its log rows this store took, or None) into `store`, settling conflicts with `by_content` and keeping both versions
/// apart. The one thing a store keeps per peer is `seen`.
pub fn take_from_peer(
    store: &mut dyn SettleStore,
    peer: &mut dyn FnMut(Option<&str>) -> Result<Changes, SyncError>,
    seen: Option<String>,
    actor: Actor,
    kept_apart: &str,
) -> Result<Taken, SyncError> {
    let mut report = Taken { seen, ..Taken::default() };
    let mut more = true;
    while more {
        let answer = peer(report.seen.as_deref())?;
        if report.seen.is_none() || answer.oldest.as_deref().zip(report.seen.as_deref()).is_some_and(|(oldest, seen)| js_less(seen, oldest)) {
            report.gap = true;
        }
        report.rows_read += answer.rows_read;
        report.seen = answer.last.clone();
        more = answer.more;
        if answer.rows.is_empty() {
            continue;
        }
        let result = store.apply_changes(&answer.rows, actor.clone(), Some(kept_apart))?;
        report.took += answer.rows[0].envelopes.len();
        report.conflicts.extend(result.conflicts);
    }
    Ok(report)
}

/// A copy names itself with letters, digits, dots, dashes, colons or underscores, at most 80.
fn copy_id_ok(copy: &str) -> bool {
    !copy.is_empty() && copy.len() <= 80 && copy.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

/// One settle request (old trillion's three shapes in one: changes, a bucket page, or a forget).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SettleRequest {
    pub copy: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub took_through: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<ChangeRow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub want_buckets: Option<Vec<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub forget: bool,
    /// Erasure keys beside the rows (`keys_beside`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<ErasureKeys>,
    /// Only stamps are asked (`compare_stamps`): the stamp checksum, or, with `want_buckets`, records without values.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stamps: bool,
    /// The asker waits while the other side prepares its shared collections: answer `preparing`, not a refusal.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bounded_shared_fields: bool,
}

/// One settle answer.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SettleAnswer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<ChangeRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub more: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub gap: bool,
    #[serde(default)]
    pub applied: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<Conflict>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buckets: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub records: Option<Vec<BucketRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forgotten: Option<bool>,
    /// Erasure keys beside the rows or records answered (`keys_beside`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<ErasureKeys>,
    /// The checksum of this side's stamps alone (`stamp_sums`), for a `stamps` request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stamp_buckets: Option<String>,
    /// This side is still preparing its shared collections: ask again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub preparing: bool,
}

/// Answers one settle request against `store`, the copy the asker follows. The request is either
///   { copy, root, took_through, rows }  the asker's own net changes (applied here, conflicts settled by `by_content`
///                                       and kept apart), answered with this side's root and its net changes after
///                                       took_through, its buckets when the asker may need them (roots differed, or
///                                       its position is gone)
///   { copy, want_buckets, after }       a bounded page of the records in those buckets, with this side's root and
///                                       buckets as they stood when it was read
///   { copy, forget: true }              the copy is gone: its position is taken away ({ forgotten })
/// The store keeps how far each copy took, written once a settle has taken everything there was.
pub fn answer_settle(store: &mut dyn SettleStore, request: &SettleRequest, bounds: Bounds, now: &str, kept_apart: &str) -> Result<SettleAnswer, SyncError> {
    answer_settle_with(store, request, bounds, now, kept_apart, None)
}

/// `answer_settle`, with the replying side's own rule on what a copy may change (`Apply`, old trillion's `apply`).
pub fn answer_settle_with(store: &mut dyn SettleStore, request: &SettleRequest, bounds: Bounds, now: &str, kept_apart: &str, apply: Option<Apply<'_>>) -> Result<SettleAnswer, SyncError> {
    let copy = request.copy.as_str();
    if !copy_id_ok(copy) {
        return Err(SyncError::new(400, "A copy names itself with letters, digits, dots, dashes, colons or underscores.", crate::cause!()));
    }
    if request.forget {
        return Ok(SettleAnswer { forgotten: Some(store.forget_position(copy)?), ..SettleAnswer::default() });
    }
    if request.stamps {
        return answer_stamps(&*store, request, bounds);
    }
    if store.share_fields(kept_apart)? {
        if request.bounded_shared_fields {
            return Ok(SettleAnswer { preparing: true, ..SettleAnswer::default() });
        }
        return Err(SyncError::new(503, "Your records are being prepared. Try again in a moment.", crate::cause!()));
    }
    if let Some(wanted) = &request.want_buckets {
        let wanted: Vec<usize> = wanted.iter().filter_map(|bucket| usize::try_from(*bucket).ok()).filter(|bucket| *bucket < super::digest::BUCKETS).collect();
        let Checksum { root, buckets } = store.checksum()?;
        let (records, next) = store.records_in_buckets_page(&wanted, request.after.as_deref(), bounds.bucket_page_records, bounds.bytes)?;
        let keys = keys_beside(&*store, &records.iter().map(|record| record.id.clone()).collect::<Vec<_>>(), true)?;
        return Ok(SettleAnswer { root: Some(root), buckets: Some(buckets), records: Some(records), next, keys, ..SettleAnswer::default() });
    }
    let rows = request.rows.clone().unwrap_or_default();
    let actor = Actor { by: "settle".into(), from_copy: Some(copy.to_string()), from_leader: false };
    if let Some(keys) = &request.keys {
        store.take_erasure_keys(keys)?;
    }
    let result = match (rows.is_empty(), apply) {
        (true, _) => Applied::default(),
        (false, Some(apply)) => apply(&mut *store, &rows, actor)?,
        (false, None) => store.apply_changes(&rows, actor, Some(kept_apart))?,
    };
    let took_through = request.took_through.clone();
    // A known equal root already proves that the asker holds the same values and stamps; its log position can be
    // older or absent after a restore, and decoding that already-held history adds no state.
    if rows.is_empty() {
        if let Some(asked) = &request.root {
            let equal = store.checksum()?;
            if &equal.root == asked {
                let last = store.last_log_id()?.or_else(|| took_through.clone());
                let oldest = store.log_after(None, 0)?.oldest;
                let gap = took_through.is_none() || oldest.as_deref().zip(took_through.as_deref()).is_some_and(|(oldest, took)| js_less(took, oldest));
                if last != took_through {
                    store.move_position(copy, last.as_deref(), now)?;
                }
                return Ok(SettleAnswer {
                    root: Some(equal.root),
                    last,
                    gap,
                    applied: result.applied,
                    conflicts: result.conflicts,
                    buckets: gap.then_some(equal.buckets),
                    ..SettleAnswer::default()
                });
            }
        }
    }
    let from_copy = copy.to_string();
    let taken = changes_after(&*store, took_through.as_deref(), bounds.most_rows, bounds.bytes, &|row: &LogRow| row.actor.from_copy.as_deref() == Some(from_copy.as_str()))?;
    let gap = took_through.is_none() || taken.oldest.as_deref().zip(took_through.as_deref()).is_some_and(|(oldest, took)| js_less(took, oldest));
    let Checksum { root, buckets } = store.checksum()?;
    // How far we have taken this copy's changes: its own key, so position(copy) keeps one meaning, how far the copy
    // has taken ours (the move above at the same settle). The two-position conflict rule reads both (record_log.rs).
    let taken_from = format!("from:{copy}");
    if !taken.more && taken.last != took_through {
        store.move_position(&taken_from, taken.last.as_deref(), now)?;
    }
    let send_buckets = gap || request.root.as_deref() != Some(root.as_str()) || !rows.is_empty();
    let keys = keys_beside(&*store, &ids_of(&taken.rows), false)?;
    Ok(SettleAnswer {
        keys,
        root: Some(root),
        rows: taken.rows,
        last: taken.last,
        more: taken.more,
        gap,
        applied: result.applied,
        conflicts: result.conflicts,
        buckets: send_buckets.then_some(buckets),
        ..SettleAnswer::default()
    })
}

/// What the asking copy keeps between settles (the caller stores it).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettleState {
    /// The last of the other side's log rows this copy took.
    pub took_through: Option<String>,
    /// The last of this copy's own log rows the other side acknowledged.
    pub sent_through: Option<String>,
}

/// What one settle did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Settled {
    pub state: SettleState,
    pub root: String,
    pub equal: bool,
    pub sent: usize,
    pub took: usize,
    pub buckets_taken: usize,
    pub records_taken: usize,
    pub buckets_moved: usize,
    pub conflicts: Vec<Conflict>,
    pub gap: bool,
    pub requests: usize,
    /// Bytes of requests and answers that crossed (as JSON).
    pub bytes: usize,
}

/// Splits net changes into upload batches of at most `rows` envelopes and `bytes` bytes. A single envelope past
/// `bytes` crosses alone in its own batch up to `record_bytes`; past that the settle refuses (413).
fn upload_batches(changes: &[ChangeRow], rows: usize, bytes: usize, record_bytes: usize) -> Result<Vec<Vec<ChangeRow>>, SyncError> {
    let Some(first) = changes.first() else { return Ok(Vec::new()) };
    let name = first.id.clone();
    let mut batches = Vec::new();
    let mut envelopes: Vec<Envelope> = Vec::new();
    let mut size = 0usize;
    for row in changes {
        for envelope in &row.envelopes {
            let own = serde_json::to_vec(envelope).map_or(usize::MAX, |text| text.len()) + 1;
            if own > record_bytes {
                return Err(SyncError::new(413, format!("Record {} exceeds the {record_bytes}-byte sync limit.", envelope.id), crate::cause!()));
            }
            if !envelopes.is_empty() && (envelopes.len() >= rows || size + own > bytes) {
                batches.push(vec![ChangeRow { id: name.clone(), envelopes: std::mem::take(&mut envelopes) }]);
                size = 0;
            }
            size += own;
            envelopes.push(envelope.clone());
            if envelopes.len() >= rows || size > bytes {
                batches.push(vec![ChangeRow { id: name.clone(), envelopes: std::mem::take(&mut envelopes) }]);
                size = 0;
            }
        }
    }
    if !envelopes.is_empty() {
        batches.push(vec![ChangeRow { id: name, envelopes }]);
    }
    Ok(batches)
}

/// Settles `copy` with the copy it follows, reached through `send(request) -> answer` (`answer_settle` on the other
/// side: in this process or through the forwarder). Local changes cross in bounded, acknowledged net-change batches; then
/// a bounded page per request is used only for buckets that still differ. Conflicts here settle as there
/// (`by_content`) and keep both versions apart. Records taken by bucket are checked against the other side's buckets
/// first (invariant 8). `progress(state)` durably keeps each acknowledged cursor before the next request.
pub fn settle_with(
    copy: &mut dyn SettleStore,
    send: &mut dyn FnMut(&SettleRequest) -> Result<SettleAnswer, SyncError>,
    id: &str,
    state: SettleState,
    bounds: Bounds,
    kept_apart: &str,
    progress: &mut dyn FnMut(&SettleState),
) -> Result<Settled, SyncError> {
    while copy.share_fields(kept_apart)? {}
    let mut next = state;
    let mut saved = next.clone();
    let mut report = Settled::default();
    let mut bytes = 0usize;
    let mut transmit = |request: &SettleRequest, report: &mut Settled| -> Result<SettleAnswer, SyncError> {
        // The other side may still be preparing its shared collections: the same bounded request goes again until it
        // answers (old trillion's `bounded_shared_fields`).
        let request = SettleRequest { bounded_shared_fields: true, ..request.clone() };
        loop {
            report.requests += 1;
            let answer = send(&request)?;
            bytes += serde_json::to_vec(&request).map_or(0, |text| text.len()) + serde_json::to_vec(&answer).map_or(0, |text| text.len());
            if !answer.preparing {
                return Ok(answer);
            }
        }
    };
    let mut keep = |next: &SettleState, saved: &mut SettleState| {
        if next != saved {
            progress(next);
            *saved = next.clone();
        }
    };
    let take_answer = |copy: &mut dyn SettleStore, answer: &SettleAnswer, report: &mut Settled, next: &mut SettleState| -> Result<(), SyncError> {
        report.gap |= answer.gap;
        if let Some(keys) = &answer.keys {
            copy.take_erasure_keys(keys)?;
        }
        report.conflicts.extend(answer.conflicts.iter().cloned());
        if !answer.rows.is_empty() {
            let result = copy.apply_changes(&answer.rows, Actor { by: "settle".into(), from_copy: None, from_leader: true }, Some(kept_apart))?;
            report.took += answer.rows.iter().map(|row| row.envelopes.len()).sum::<usize>();
            report.conflicts.extend(result.conflicts);
        }
        next.took_through = answer.last.clone();
        Ok(())
    };
    let request = |copy: &dyn SettleStore, next: &SettleState, rows: Vec<ChangeRow>| -> Result<SettleRequest, SyncError> {
        let keys = keys_beside(copy, &ids_of(&rows), false)?;
        Ok(SettleRequest { copy: id.to_string(), root: Some(copy.checksum()?.root), took_through: next.took_through.clone(), rows: Some(rows), keys, ..SettleRequest::default() })
    };
    let mut answer: Option<SettleAnswer> = None;
    let mut first = true;
    let mut more_local = true;
    while more_local {
        let page = changes_after(&*copy, next.sent_through.as_deref(), bounds.upload_rows, bounds.bytes, &|row: &LogRow| row.actor.from_leader)?;
        let mut batches = upload_batches(&page.rows, bounds.upload_rows, bounds.bytes, bounds.record_bytes)?;
        if batches.is_empty() && first {
            batches.push(Vec::new());
        }
        for rows in batches {
            let sent: usize = rows.iter().map(|row| row.envelopes.len()).sum();
            let asked = request(&*copy, &next, rows)?;
            let got = transmit(&asked, &mut report)?;
            report.sent += sent;
            first = false;
            take_answer(copy, &got, &mut report, &mut next)?;
            keep(&next, &mut saved);
            answer = Some(got);
        }
        if page.last.is_some() {
            next.sent_through = page.last.clone();
        }
        keep(&next, &mut saved);
        more_local = page.more;
    }
    while answer.as_ref().is_some_and(|answer| answer.more) {
        let asked = request(&*copy, &next, Vec::new())?;
        let got = transmit(&asked, &mut report)?;
        take_answer(copy, &got, &mut report, &mut next)?;
        keep(&next, &mut saved);
        answer = Some(got);
    }
    let mut answer = answer.unwrap_or_default();
    let mut mine = copy.checksum()?;
    if answer.root.as_deref() != Some(mine.root.as_str()) {
        if let Some(theirs) = answer.buckets.clone() {
            let differ = buckets_that_differ(&mine.buckets, &theirs);
            for group in differ.chunks(bounds.verify_buckets.max(1)) {
                let Some(records) = read_group(copy, &mut transmit, &mut report, id, group)? else { continue };
                let theirs: HashMap<&str, Kept> = records.iter().map(|record| (record.id.as_str(), record.stamped())).collect();
                if !records.is_empty() {
                    let envelopes = records.iter().map(|record| envelope_of_kept(&record.id, &record.stamped())).collect();
                    let merged = copy.apply_changes(&[ChangeRow { id: "settle".into(), envelopes }], Actor { by: "settle".into(), from_copy: None, from_leader: true }, None)?;
                    report.records_taken += merged.applied;
                }
                let back: Vec<Envelope> = copy
                    .records_in_buckets(group)?
                    .into_iter()
                    .filter(|record| !same_kept(Some(&record.stamped()), theirs.get(record.id.as_str())))
                    .map(|record| envelope_of_kept(&record.id, &record.stamped()))
                    .collect();
                let name = copy.last_log_id()?.unwrap_or_default();
                for rows in upload_batches(&[ChangeRow { id: name, envelopes: back.clone() }], bounds.upload_rows, bounds.bytes, bounds.record_bytes)? {
                    let sent = rows[0].envelopes.len();
                    let asked = request(&*copy, &next, rows)?;
                    let got = transmit(&asked, &mut report)?;
                    report.sent += sent;
                    take_answer(copy, &got, &mut report, &mut next)?;
                    keep(&next, &mut saved);
                    answer = got;
                }
                // What the other side would not take stays as it holds it: those buckets are taken from it exactly.
                let kept = copy.checksum()?.buckets;
                let given = answer.buckets.clone().unwrap_or_default();
                let refused: Vec<usize> = if back.is_empty() { Vec::new() } else { group.iter().copied().filter(|bucket| bucket_text(&kept, *bucket) != bucket_text(&given, *bucket)).collect() };
                if !refused.is_empty() {
                    if let Some(exact) = read_group(copy, &mut transmit, &mut report, id, &refused)? {
                        let held: HashSet<&str> = exact.iter().map(|record| record.id.as_str()).collect();
                        if !exact.is_empty() {
                            copy.take_records(&exact, Actor { by: "settle".into(), from_copy: None, from_leader: true })?;
                        }
                        let gone: Vec<BucketRecord> = copy
                            .records_in_buckets(&refused)?
                            .into_iter()
                            .filter(|record| !held.contains(record.id.as_str()))
                            .map(|record| BucketRecord { id: record.id, kind: record.kind, value: None, meta: None })
                            .collect();
                        if !gone.is_empty() {
                            copy.take_records(&gone, Actor { by: "settle".into(), from_copy: None, from_leader: true })?;
                        }
                        report.records_taken += exact.len() + gone.len();
                    }
                }
                report.buckets_taken += group.len();
            }
            if let Some(last) = copy.last_log_id()? {
                next.sent_through = Some(last);
            }
            keep(&next, &mut saved);
            mine = copy.checksum()?;
        }
    }
    report.equal = answer.root.as_deref() == Some(mine.root.as_str());
    report.root = mine.root;
    report.state = next;
    report.bytes = bytes;
    Ok(report)
}

/// One group read whole and checked (invariant 8): the records when every page answered the same group checksums and
/// the records add up to the buckets the other side gave, None when it moved while being read; a 409 when they do not.
fn read_group(
    copy: &mut dyn SettleStore,
    transmit: &mut dyn FnMut(&SettleRequest, &mut Settled) -> Result<SettleAnswer, SyncError>,
    report: &mut Settled,
    id: &str,
    group: &[usize],
) -> Result<Option<Vec<BucketRecord>>, SyncError> {
    for _ in 0..MOVED_TRIES {
        let mut records = Vec::new();
        let mut seen: Option<String> = None;
        let mut moved = false;
        let mut after: Option<String> = None;
        loop {
            let asked = SettleRequest { copy: id.to_string(), want_buckets: Some(group.iter().map(|bucket| *bucket as i64).collect()), after: after.clone(), ..SettleRequest::default() };
            let page = transmit(&asked, report)?;
            let buckets = page.buckets.clone().unwrap_or_default();
            if let Some(seen) = &seen {
                if group.iter().any(|bucket| bucket_text(&buckets, *bucket) != bucket_text(seen, *bucket)) {
                    moved = true;
                    break;
                }
            }
            seen.get_or_insert(buckets);
            if let Some(keys) = &page.keys {
                copy.take_erasure_keys(keys)?;
            }
            records.extend(page.records.unwrap_or_default());
            match page.next {
                None => break,
                Some(cursor) => after = Some(cursor),
            }
        }
        if moved {
            continue;
        }
        let seen = seen.unwrap_or_default();
        let mut sums = Sums::new();
        for record in &records {
            if let (Some(kind), Some(value)) = (&record.kind, &record.value) {
                sums.add(&record.id, kind, value);
            }
            sums.stamps(&record.id, None, record.meta.as_ref().map(Meta::text).as_deref());
        }
        let summed = sums.text();
        let wrong: Vec<usize> = group.iter().copied().filter(|bucket| bucket_text(&summed, *bucket) != bucket_text(&seen, *bucket)).collect();
        if !wrong.is_empty() {
            let plural = if wrong.len() == 1 { "" } else { "s" };
            return Err(SyncError { cause: crate::cause!(),
                status: 409,
                message: format!("The records of {} bucket{plural} arrived changed: they do not add up to what the other copy holds, so none were taken.", wrong.len()),
                refused: wrong,
            });
        }
        return Ok(Some(records));
    }
    report.buckets_moved += group.len();
    Ok(None)
}

/// The checksum of a store's stamps alone: each kept state's stamps (`Meta`, a removal's included) summed by bucket
/// the way the store sums itself, without its values. Two copies hold the same records at the same stamps exactly when
/// their stamp sums are equal, whatever form their values are kept in: a computer that only holds a copy keeps each
/// value sealed under a fresh nonce (`src/account/computers/sealed.rs`), so its values never sum like any other
/// copy's, while its stamps are the writer's (`record_log.rs` `mirror_stamp`). A pass over every kept state, a bounded
/// page at a time.
pub fn stamp_sums(store: &dyn SettleStore, bounds: Bounds) -> Result<Sums, SyncError> {
    let all: Vec<usize> = (0..super::digest::BUCKETS).collect();
    let mut sums = Sums::new();
    let mut after: Option<String> = None;
    loop {
        let (records, next) = store.records_in_buckets_page(&all, after.as_deref(), bounds.bucket_page_records, bounds.bytes)?;
        for record in &records {
            sums.stamps(&record.id, None, record.meta.as_ref().map(Meta::text).as_deref());
        }
        match next {
            None => return Ok(sums),
            Some(cursor) => after = Some(cursor),
        }
    }
}

/// A stamps request answered: the stamp checksum, or a page of the records of the wanted buckets with their stamps only.
fn answer_stamps(store: &dyn SettleStore, request: &SettleRequest, bounds: Bounds) -> Result<SettleAnswer, SyncError> {
    let Some(wanted) = &request.want_buckets else {
        return Ok(SettleAnswer { stamp_buckets: Some(stamp_sums(store, bounds)?.text()), ..SettleAnswer::default() });
    };
    let wanted: Vec<usize> = wanted.iter().filter_map(|bucket| usize::try_from(*bucket).ok()).filter(|bucket| *bucket < super::digest::BUCKETS).collect();
    let (records, next) = store.records_in_buckets_page(&wanted, request.after.as_deref(), bounds.bucket_page_records, bounds.bytes)?;
    let records = records.into_iter().map(|record| BucketRecord { id: record.id, kind: None, value: None, meta: record.meta }).collect();
    Ok(SettleAnswer { records: Some(records), next, ..SettleAnswer::default() })
}

/// What comparing two copies' stamps found (`compare_stamps`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StampsCompared {
    /// Both hold every record at the same stamps.
    pub equal: bool,
    /// Records the other side holds at an earlier stamp than this one, or not at all.
    pub they_lack: Vec<String>,
    /// Records this side holds at an earlier stamp than the other, or not at all.
    pub we_lack: Vec<String>,
    pub buckets: usize,
    pub requests: usize,
}

/// Compares this copy's stamps with the other side's (`answer_settle` with `stamps`), the form every copy keeps alike:
/// the stamp checksums first, then, for the buckets that differ only, the stamps of their records, a bounded page per
/// request. Nothing is taken either way: which side holds a later change of which record is answered, and the copy
/// that lacks one takes it the way it takes every change (a computer that only holds a copy, from the writer's feed,
/// sealed for it). A stamp `at` of a removal counts as any stamp.
pub fn compare_stamps(copy: &dyn SettleStore, send: &mut dyn FnMut(&SettleRequest) -> Result<SettleAnswer, SyncError>, id: &str, bounds: Bounds) -> Result<StampsCompared, SyncError> {
    let mut report = StampsCompared::default();
    report.requests += 1;
    let theirs = send(&SettleRequest { copy: id.to_string(), stamps: true, ..SettleRequest::default() })?.stamp_buckets.unwrap_or_default();
    let mine = stamp_sums(copy, bounds)?.text();
    let differ = buckets_that_differ(&mine, &theirs);
    report.buckets = differ.len();
    for group in differ.chunks(bounds.verify_buckets.max(1)) {
        let mut held: HashMap<String, String> = HashMap::new();
        let mut after: Option<String> = None;
        loop {
            report.requests += 1;
            let asked = SettleRequest { copy: id.to_string(), stamps: true, want_buckets: Some(group.iter().map(|bucket| *bucket as i64).collect()), after: after.clone(), ..SettleRequest::default() };
            let page = send(&asked)?;
            for record in page.records.unwrap_or_default() {
                held.insert(record.id, record.meta.map(|meta| meta.at).unwrap_or_default());
            }
            match page.next {
                None => break,
                Some(cursor) => after = Some(cursor),
            }
        }
        let mut seen = HashSet::new();
        for record in copy.records_in_buckets(group)? {
            let at = record.meta.map(|meta| meta.at).unwrap_or_default();
            match held.get(&record.id) {
                Some(there) if js_less(&at, there) => report.we_lack.push(record.id.clone()),
                Some(there) if js_less(there, &at) => report.they_lack.push(record.id.clone()),
                Some(_) => {}
                None => report.they_lack.push(record.id.clone()),
            }
            seen.insert(record.id);
        }
        report.we_lack.extend(held.into_keys().filter(|there| !seen.contains(there)));
    }
    report.we_lack.sort();
    report.they_lack.sort();
    report.equal = report.buckets == 0;
    Ok(report)
}
