// src/storage/record_store/segments.rs
//
// Purpose: The `segments` search layout of the record store (layout DATA in `search.rs`), ported from the simulation's
// `inverted` layout with `persist` (simulation/src/candidates/search.rs). Each account/resource scope keeps a memory
// tail of its records changed after its newest persisted segment; a write persists the tail as one packed segment
// (one meta row and parts of about `part_bytes`) once it holds `flush_records` records or its oldest change is
// `flush_seconds` old. A write never merges: `fan_in` segments of one level next to each other are merged into one
// segment of the next level by the account's idle upkeep, in resumable steps of about `merge_bytes` each committed
// alone (`search_merge`, old trillion record-log-store.mjs:112-119), so a write's time does not depend on how large the
// index has grown. There is no alarm; the work outside a write is those merge steps and the search walk over rows from
// before the index, one bounded step per idle upkeep (`search_walk`).
//
// Non-Negotiable Invariants:
// - Exact answers. The tail holds the newest version of every record changed after the newest segment (`hi`), so a
//   search sees every current version; a posting from a segment counts only when the record's current row still has
//   the posting's stamp (one current-row read), so stale, deleted and destroyed postings never reach a result.
// - Atomic with the record. Tail and segment changes happen inside the write's scope; every memory change has an
//   undo entry applied when the scope rolls back, and a commit whose outcome is unknown drops the scope's memory so
//   the next use rebuilds it from storage.
// - Bounded cold start. A scope's first use reads its segment meta rows and the current rows changed after `hi`
//   (the `changed` order): at most the unflushed tail, which a flush keeps under `flush_records`. A change whose stamp
//   is not above `hi` (a restore) cannot be recovered from that order, so it is persisted in its own write.
// - One terms rule. Every segment names the rule it was built under (`search.rs` `Layout::rule`). When any segment of
//   a scope names another rule (or none: segments written before segments named one), every segment of the scope is
//   stale: none is read and `hi` is 0, so the scope gets a new walk under the current rule (below): a cold start reads
//   at most `flush_records` + 1 of its rows, never all, and the walk indexes the rest a page per step. The scope's next
//   write (a change or an erasure) drops the stale segments inside its own scope. A rule change therefore needs no
//   operator step, and a row written before it is found by the words the current rule gives it once the walk reaches
//   it; until the walk is done the records:search answer names the lane pending.
// - Erasure. Destroying a record removes it from the tail and rewrites every segment that covers it, in the
//   destroying scope: no posting, term or covered id of it remains.
// - Rows from before the index are walked, never lost and never loaded at once. A scope's walk state (`search_walk`
//   family, one row per scope) holds the terms rule it was built under, its frontier (`from`, a stamp) and its
//   cursor (`after`, a record id). Every change above the frontier reaches the index through the write that made it;
//   every current row at or below it is indexed by the walk (`search_walk`), a page of `walk_rows` records in id
//   order per step, its page and its cursor committed together in one write scope, so a stopped walk starts at the
//   next record and never indexes a page twice. A cold start reads only the rows above the frontier: a store of
//   100,000 rows written before the index reads at most `flush_records` + 1 of them, never all.
//
// Key Concepts:
// - Walk (ported from old trillion parts/record-log/do-work/record-log-store.mjs `buildIndexes` and the idle
//   maintainer that calls it): a scope with no walk state under the current terms rule (a store written before the
//   index existed, or before its declared terms changed) gets one at its first load. Its frontier is the scope's
//   newest segment stamp when at most `flush_records` current rows changed after it (those rows load into the tail as
//   before), else the newest current stamp (the tail starts empty and the walk owns every older row). A walk with rows
//   left is saved by the first write; a ready one by the first flush or walk step (it is computed the same until then). A walk with nothing at or below its frontier is ready at once (old trillion: "A genuinely
//   empty type has nothing to backfill"). The account's idle upkeep runs the steps (native_boot/own_records_start.rs,
//   between wake passes), not a person.
// - Floor: the larger of the newest segment's `hi` and the walk's frontier. The tail holds only changes above it; a
//   change at or below it (a restore, or a walked page) is persisted in its own write, and a segment persisted while
//   a frontier stands ends no lower than the frontier.
// - Segment: every change with stamp in (lo, hi]; `firsts` is the first term of each part (a term's part is found
//   by halving); `covers` lists the records a segment holds a version of, so older postings of them are skipped
//   (and dropped by merges). A record with no terms is covered only when an older segment covers it.
// - Carried memory (`SearchMemory`, `SharedSearchMemory`): a native command's stores over one held transaction share one
//   memory, and the account's record book writer keeps it for the next command once the command commits. A store
//   with carried memory checks each scope against the file at every use (segment metas equal, then only the rows
//   changed after its newest known change), so a write by any other store is never missed.
// - Merge being built: a segment whose meta row holds `building` (its inputs and the first term not merged yet). No
//   search reads it; its inputs answer until the step that writes its last parts drops them and puts it in their place
//   (`Segment::seq`: a merged segment stands where its inputs stood in recency order, so segments flushed while it was
//   built stay newer). A scope keeps segments unmerged as long as no idle step runs: answers stay exact, a search reads
//   one part more per unmerged segment.
// - Families (DATA, `families.json` beside this file): `search_segments` (one meta row per segment) and
//   `search_parts` (one row per part, postings newest stamp first, in the packed form of `encode_part`: each posting
//   an index into the part's table of record id and stamp pairs).
//
// Security Considerations:
// - Postings hold record ids and stamps only; terms are the record's own words, under its own scope.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{
    exact, rows_by_key, search::Term, text, Batch, Bound, Error, Field, Found, Order, Range, Record, RecordStore, StorageError, Value,
    Version, Written, CURRENT, ROW, VERSIONS, WRITE_BATCH,
};
use super::clock_ms;
use crate::storage::Storage;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};

const SEGMENTS: &str = "search_segments";

/// Segment meta rows parsed on this thread (tests count them).
#[cfg(test)]
thread_local!(static METAS_PARSED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) });
const PARTS: &str = "search_parts";
const WALK: &str = "search_walk";

/// (account, resource).
pub(super) type Scope = (String, String);

/// One posting: a record version holding a term.
#[derive(Clone, Debug, Deserialize, Serialize)]
struct Post {
    /// The version's stamp.
    s: i64,
    /// The record id.
    k: String,
}

/// Terms of one part, sorted; postings newest stamp first.
type Part = Vec<(Term, Vec<Post>)>;

/// One persisted segment's meta row.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct Segment {
    id: i64,
    level: u32,
    lo: i64,
    hi: i64,
    firsts: Vec<Term>,
    covers: BTreeMap<String, i64>,
    /// The terms rule the segment was built under (`Layout::rule`); empty for a segment written before segments named
    /// one, which is therefore stale.
    #[serde(default)]
    rule: String,
    /// The segment's place in recency order (oldest first): its own id for a flushed segment (none: a segment written
    /// before segments named one), the newest input's for a merged one, so a merged segment stands exactly where its
    /// inputs stood even when newer segments were flushed while it was being built.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seq: Option<i64>,
    /// A merge being built (`RecordStore::search_merge`): never read by a search, and its parts are not yet whole.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    building: Option<Building>,
}
impl Segment {
    /// The part that would hold `term`.
    fn part_of(&self, term: &Term) -> Option<usize> {
        self.firsts.partition_point(|first| first <= term).checked_sub(1)
    }

    /// The segment's place in recency order.
    fn seq(&self) -> i64 {
        self.seq.unwrap_or(self.id)
    }
}

/// Where a merge being built stands: the segments it merges (ids, oldest first) and the first term it has not merged.
/// Every term below `next` is in the parts written so far (`Segment::firsts` names them); none at or above it is.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct Building {
    inputs: Vec<i64>,
    next: Option<Term>,
}

/// One step of the merges a scope owes (`RecordStore::search_merge`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Merged {
    /// Bytes of input parts this step read.
    pub bytes: usize,
    /// Whether no merge is owed now (none was, or this step finished the last one owed).
    pub done: bool,
}

/// Metas in recency order, oldest first (`Segment::seq`, then id).
fn in_order(segments: &mut [Segment]) {
    segments.sort_by_key(|segment| (segment.seq(), segment.id));
}

/// The newest version of one record changed after the newest segment.
#[derive(Clone, Debug)]
pub(super) struct Entry {
    stamp: i64,
    /// None: the record is deleted.
    terms: Option<BTreeSet<Term>>,
}

/// A scope's walk over the rows it held before its index (or its current terms) existed: one `search_walk` row.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub(super) struct Walk {
    /// The terms rule the walk indexes under (`Layout::rule`); a walk under another rule is walked again.
    rule: String,
    /// The frontier: changes above it reach the index by their own write, current rows at or below it by the walk.
    from: i64,
    /// The last record id walked (id order); none before the first page.
    after: Option<String>,
    /// Whether every row at or below the frontier is indexed.
    ready: bool,
    /// Whether this state is the scope's saved row (false: computed at load, saved by the next write or walk step).
    #[serde(skip)]
    saved: bool,
}

/// One step of the search walk (`RecordStore::search_walk`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Walked {
    /// Records this step indexed.
    pub indexed: usize,
    /// Whether every row from before the index is now indexed.
    pub done: bool,
}

/// One scope's search memory.
#[derive(Clone, Debug, Default)]
pub(super) struct Index {
    tail: BTreeMap<String, Entry>,
    /// Commit time (ms) of the oldest tail change since the scope was loaded.
    since: Option<u64>,
    /// Persisted segments of the current terms rule, oldest first.
    segments: Vec<Segment>,
    /// Merges being built (`Building`) of the current terms rule: never read by a search. At most one is continued;
    /// any other is dropped by the next merge step.
    merging: Vec<Segment>,
    /// Persisted segments of another terms rule, oldest first: never read, dropped by the scope's next write. When any
    /// is held, `segments` is empty.
    stale: Vec<Segment>,
    next: i64,
    /// The walk over the rows from before the index.
    walk: Walk,
    /// The segment meta rows' text as the file held them when `segments`, `merging` and `stale` were last known to be
    /// those rows' content: a carried index whose file rows are still this text needs no parse of them (`search_load`).
    raw: Vec<String>,
}
impl Index {
    fn hi(&self) -> i64 {
        self.segments.last().map_or(0, |segment| segment.hi)
    }

    /// The tail holds only changes above this stamp (the newest segment's `hi`, or the walk's frontier when higher).
    fn floor(&self) -> i64 {
        self.hi().max(self.walk.from)
    }
}

/// The undo of one memory change inside an open write scope, applied newest first on rollback.
pub(super) enum Undo {
    Tail(Scope, String, Option<Entry>),
    Since(Scope, Option<u64>),
    Segments(Scope, Vec<Segment>, i64),
    Stale(Scope, Vec<Segment>),
    Walk(Scope, Walk),
    Merging(Scope, Vec<Segment>),
}

/// The search memory of every scope a store loaded, carried to the next store over the same file
/// (`RecordStore::carry_search`, `RecordStore::take_search`), so a write does not read its scope's whole unflushed tail again. The
/// shared search memory keeps it only after the transaction it was used in committed: a rolled-back write leaves its changes in
/// memory, and only the shared search memory knows the outcome. Each scope is checked against the file at every use
/// (`search_load`).
#[derive(Default)]
pub struct SearchMemory(HashMap<Scope, Index>);

/// One transaction's search memory, lent to one store at a time (`lend`, `give_back`). A store opened while the
/// memory is out runs without it; the memory's next use reads that store's writes from the file (`search_load`).
pub struct SharedSearchMemory(std::cell::RefCell<Option<SearchMemory>>);
impl SharedSearchMemory {
    pub fn new(memory: SearchMemory) -> Self {
        Self(std::cell::RefCell::new(Some(memory)))
    }

    /// The memory for one store, or none while another store holds it.
    pub fn lend(&self) -> Option<SearchMemory> {
        self.0.borrow_mut().take()
    }

    /// The memory a store lent by `lend` gives back when it is done.
    pub fn give_back(&self, memory: SearchMemory) {
        *self.0.borrow_mut() = Some(memory);
    }

    /// The memory to keep after the transaction committed; none while a store still holds it.
    pub fn committed(&self) -> Option<SearchMemory> {
        self.0.borrow_mut().take()
    }
}

/// The first byte of a part body in the packed form (`encode_part`). A body that starts with `[` is the earlier JSON
/// form (a JSON array of `[term, postings]`), still read so segments written before the packed form keep answering.
const PACKED: u8 = 1;

/// A part body in the packed form: `PACKED`; the part's table of distinct (record id, stamp) pairs (a varint count,
/// then each as a varint length, the id's bytes and the stamp as a varint); the terms (a varint count, then each as
/// its field and word, each a varint length and bytes, and its postings as a varint count and one varint table index
/// each, newest stamp first as held). A posting so costs one or two bytes instead of its id and stamp written out as
/// JSON: the per-arrival growth guard (`month_tests.rs`, `settings.json` `per_arrival`) holds the index to it.
fn encode_part(part: &Part) -> Vec<u8> {
    let mut table: Vec<(&str, i64)> = Vec::new();
    let mut at: HashMap<(&str, i64), u64> = HashMap::new();
    for (_, posts) in part {
        for post in posts {
            at.entry((post.k.as_str(), post.s)).or_insert_with(|| {
                table.push((post.k.as_str(), post.s));
                table.len() as u64 - 1
            });
        }
    }
    let mut body = vec![PACKED];
    put_varint(&mut body, table.len() as u64);
    for (id, stamp) in &table {
        put_bytes(&mut body, id.as_bytes());
        put_varint(&mut body, *stamp as u64);
    }
    put_varint(&mut body, part.len() as u64);
    for ((field, word), posts) in part {
        put_bytes(&mut body, field.as_bytes());
        put_bytes(&mut body, word.as_bytes());
        put_varint(&mut body, posts.len() as u64);
        for post in posts {
            put_varint(&mut body, at[&(post.k.as_str(), post.s)]);
        }
    }
    body
}

/// A part body as `encode_part` writes it, or in the earlier JSON form.
fn decode_part(body: &[u8]) -> Result<Part, StorageError> {
    match body.first() {
        Some(&PACKED) => {}
        Some(b'[') => return serde_json::from_slice(body).map_err(|error| crate::carry_cause!(StorageError::Invalid, error)),
        _ => return Err(crate::cause!(StorageError::Invalid)),
    }
    let mut at = 1;
    let mut table = Vec::new();
    for _ in 0..take_varint(body, &mut at)? {
        let id = take_text(body, &mut at)?;
        table.push(Post { s: take_varint(body, &mut at)? as i64, k: id });
    }
    let mut part = Vec::new();
    for _ in 0..take_varint(body, &mut at)? {
        let term = (take_text(body, &mut at)?, take_text(body, &mut at)?);
        let count = take_varint(body, &mut at)?;
        let mut posts = Vec::new();
        for _ in 0..count {
            let index = usize::try_from(take_varint(body, &mut at)?).map_err(|error| crate::carry_cause!(StorageError::Invalid, error))?;
            posts.push(table.get(index).cloned().ok_or(crate::cause!(StorageError::Invalid))?);
        }
        part.push((term, posts));
    }
    if at != body.len() {
        return Err(crate::cause!(StorageError::Invalid));
    }
    Ok(part)
}

fn put_varint(body: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        body.push(value as u8 | 0x80);
        value >>= 7;
    }
    body.push(value as u8);
}

fn put_bytes(body: &mut Vec<u8>, bytes: &[u8]) {
    put_varint(body, bytes.len() as u64);
    body.extend_from_slice(bytes);
}

fn take_varint(body: &[u8], at: &mut usize) -> Result<u64, StorageError> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *body.get(*at).ok_or(crate::cause!(StorageError::Invalid))?;
        *at += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(crate::cause!(StorageError::Invalid))
}

fn take_text(body: &[u8], at: &mut usize) -> Result<String, StorageError> {
    let len = usize::try_from(take_varint(body, at)?).map_err(|error| crate::carry_cause!(StorageError::Invalid, error))?;
    let end = at.checked_add(len).filter(|end| *end <= body.len()).ok_or(crate::cause!(StorageError::Invalid))?;
    let text = std::str::from_utf8(&body[*at..end]).map_err(|error| crate::carry_cause!(StorageError::Invalid, error))?.to_owned();
    *at = end;
    Ok(text)
}

fn scope_of(account: &str, resource: &str) -> Scope {
    (account.to_owned(), resource.to_owned())
}

impl<S: Storage> RecordStore<S> {
    /// Drop every scope's search memory when the storage mark moved since it was last checked (another handle
    /// committed: its changes may be in no tail and in no segment this memory knows). Carried memory is checked against
    /// the file at every use instead (`search_load`).
    pub(super) fn search_observe(&self, mark: i64) {
        if self.search_mark.get() == Some(mark) {
            return;
        }
        if !self.search_carried && self.search_undo.is_empty() {
            self.search.borrow_mut().clear();
        }
        self.search_mark.set(Some(mark));
    }

    /// Load a scope's search memory when it is not held: its segment meta rows, then the current rows changed after
    /// the newest segment. Called at the start of every write (before it changes anything) and by searches. Carried
    /// memory (`carry_search`) is checked against the file at every use instead, because another store may have
    /// written the scope since: the same segment metas keep its tail and only the rows changed after its newest known
    /// change are read; other metas (a flush, a merge or an erasure elsewhere) load the scope again.
    pub(super) fn search_load(&self, account: &str, resource: &str) -> Result<(), StorageError> {
        let scope = scope_of(account, resource);
        if !self.search_carried && self.search.borrow().contains_key(&scope) {
            return Ok(());
        }
        let carried = self.search.borrow_mut().remove(&scope);
        let rows = self.segment_meta_rows(account, resource)?;
        let saved = self.saved_walk(account, resource)?;
        // The carried memory's walk: the walk's saved row, or no row on either side (a frontier computed at load, still
        // above every row the file has changed since).
        let same_walk = |index: &Index| match (&saved, index.walk.saved) {
            (Some(walk), true) => *walk == index.walk,
            (None, false) => true,
            _ => false,
        };
        // Carried memory stands over the same segments (stale ones included). The meta rows of a big scope are megabytes
        // of JSON, so rows whose text is the text it was loaded from are the same segments without a parse: a write
        // parsed 27 MB of them at every use (the Mac engine at 100% CPU, 2026-11-13).
        let quick = carried.as_ref().is_some_and(|index| index.raw == rows && same_walk(index));
        let mut index = if quick {
            carried.unwrap_or_default()
        } else {
            let segments = Self::parse_segment_metas(&rows)?;
            let reused = carried.filter(|index| {
                let mut held: Vec<Segment> = index.stale.iter().chain(&index.segments).chain(&index.merging).cloned().collect();
                in_order(&mut held);
                held == segments && same_walk(index)
            });
            let mut index = match reused {
                Some(index) => index,
                None => {
                    let next = segments.iter().map(|segment| segment.id + 1).max().unwrap_or(1).max(1);
                    let rule = self.settings.search.rule();
                    let stale = segments.iter().any(|segment| segment.rule != rule);
                    // Another terms rule: no segment is read (`hi` is 0), and the walk owns every row they held. A saved
                    // walk does not stand beside stale segments: the scope is walked again under the current rule. A merge
                    // being built under another rule is stale with them.
                    let mut index = if stale {
                        Index { stale: segments, next, ..Index::default() }
                    } else {
                        let (merging, segments) = segments.into_iter().partition(|segment| segment.building.is_some());
                        Index { segments, merging, next, ..Index::default() }
                    };
                    match saved.filter(|_| !stale) {
                        Some(walk) => index.walk = walk,
                        None => self.new_walk(account, resource, &mut index)?,
                    }
                    index
                }
            };
            index.raw = rows;
            index
        };
        let known = index.tail.values().map(|entry| entry.stamp).max().unwrap_or(0).max(index.floor());
        let mut after = vec![text(account), text(resource)];
        after.push(Value::Integer(known));
        let range = Range {
            order: Order::Named("changed"),
            from: Bound::Excluded(after),
            to: Bound::Included(vec![text(account), text(resource)]),
            reverse: false,
            limit: None,
        };
        for row in self.scan_rows(VERSIONS, &range, &ROW)? {
            let version = Version::from_row(row, CURRENT).map_err(|error| crate::carry_cause!(StorageError::Invalid, error))?;
            let value = version.value().map_err(|error| crate::carry_cause!(StorageError::Invalid, error))?;
            let terms = value.filter(|_| !version.deleted).map(|value| self.settings.search.terms(&value));
            index.tail.insert(version.id, Entry { stamp: version.valid_from, terms });
        }
        self.search.borrow_mut().insert(scope, index);
        Ok(())
    }

    /// The scope's saved walk, when it was built under the current terms rule.
    fn saved_walk(&self, account: &str, resource: &str) -> Result<Option<Walk>, StorageError> {
        let row = self.storage.get(WALK, &[text(account), text(resource)], &[Field::whole("state")])?;
        self.count(1, usize::from(row.is_some()));
        let Some(mut row) = row else { return Ok(None) };
        let mut walk: Walk = serde_json::from_str(row.take(0).as_text().unwrap_or_default()).map_err(|error| crate::carry_cause!(StorageError::Invalid, error))?;
        walk.saved = true;
        Ok(Some(walk).filter(|walk| walk.rule == self.settings.search.rule()))
    }

    /// The walk of a scope that has none under the current terms rule (a store written before its index, or before its
    /// terms changed), computed at load and saved by the next write or walk step. At most `flush_records` + 1 current
    /// rows changed after the newest segment are read: when they are no more than `flush_records` they are the tail and
    /// the frontier is that segment's `hi`; otherwise the frontier is the scope's newest current stamp and the tail
    /// starts empty. Either way the walk owns every current row at or below the frontier, and is ready at once when there
    /// is none.
    fn new_walk(&self, account: &str, resource: &str, index: &mut Index) -> Result<(), StorageError> {
        let super::search::Layout::Segments { flush_records, .. } = &self.settings.search;
        let scope = vec![text(account), text(resource)];
        let hi = index.hi();
        let mut after = scope.clone();
        after.push(Value::Integer(hi));
        let probe = Range {
            order: Order::Named("changed"),
            from: Bound::Excluded(after),
            to: Bound::Included(scope.clone()),
            reverse: false,
            limit: Some(flush_records + 1),
        };
        let rows = self.scan_rows(VERSIONS, &probe, &ROW)?;
        let from = if rows.len() <= *flush_records {
            for row in rows {
                let version = Version::from_row(row, CURRENT).map_err(|error| crate::carry_cause!(StorageError::Invalid, error))?;
                let value = version.value().map_err(|error| crate::carry_cause!(StorageError::Invalid, error))?;
                let terms = value.filter(|_| !version.deleted).map(|value| self.settings.search.terms(&value));
                index.tail.insert(version.id, Entry { stamp: version.valid_from, terms });
            }
            hi
        } else {
            let newest = Range { order: Order::Named("changed"), from: Bound::Included(scope.clone()), to: Bound::Included(scope.clone()), reverse: false, limit: Some(1) }.reverse();
            let row = self.scan_rows(VERSIONS, &newest, &[Field::whole("valid_from")])?.pop();
            row.and_then(|mut row| row.take(0).as_integer()).unwrap_or(hi).max(hi)
        };
        // Anything at or below the frontier for the walk to index?
        let mut through = scope.clone();
        through.push(Value::Integer(from));
        let older = Range { order: Order::Named("changed"), from: Bound::Included(scope), to: Bound::Included(through), reverse: false, limit: Some(1) };
        let pending = from > 0 && !self.scan_rows(VERSIONS, &older, &[Field::whole("id")])?.is_empty();
        index.walk = Walk { rule: self.settings.search.rule(), from, after: None, ready: !pending, saved: false };
        Ok(())
    }

    /// Save the scope's walk inside the caller's write scope, when it is not saved yet.
    fn search_walk_save(&mut self, account: &str, resource: &str) -> Result<(), StorageError> {
        let scope = scope_of(account, resource);
        let index = self.search.get_mut().get_mut(&scope).ok_or(crate::cause!(StorageError::Invalid))?;
        if index.walk.saved {
            return Ok(());
        }
        let previous = index.walk.clone();
        index.walk.saved = true;
        let walk = index.walk.clone();
        self.search_undo.push(Undo::Walk(scope, previous));
        self.put_walk(account, resource, &walk)
    }

    fn put_walk(&self, account: &str, resource: &str, walk: &Walk) -> Result<(), StorageError> {
        let state = serde_json::to_string(walk).map_err(|error| crate::carry_cause!(StorageError::Invalid, error))?;
        let mut batch = Batch::default();
        batch.put(WALK, vec![("account", text(account)), ("resource", text(resource)), ("state", Value::Text(state))], false);
        batch.send(&self.storage)?;
        Ok(())
    }

    /// One step of the walk over the rows a scope held before its index (or its current terms) existed, in one write
    /// scope: the next `rows` current records in id order past the saved cursor, those at or below the frontier
    /// persisted as one segment with the unflushed tail, and the cursor moved past them, all committed together (old
    /// trillion record-log-store.mjs `buildIndexes`: "Keys and progress commit together"). A record changed since the
    /// frontier is skipped: its own write indexed it. A step that rolls back leaves the cursor where it was, so the
    /// next step repeats that page and no other. Answers what the step indexed and whether the walk is done.
    pub fn search_walk(&mut self, account: &str, resource: &str, rows: usize) -> Result<Walked, Error> {
        super::validate(account, resource, "search_walk")?;
        if !(1..=crate::records::MAX_PAGE_ITEMS).contains(&rows) {
            return Err(Error::Invalid("invalid search walk page size", crate::cause!()));
        }
        self.write(account, resource, |store| {
            let scope = scope_of(account, resource);
            let walk = store.search.get_mut().get(&scope).ok_or(crate::cause!(Error::Unavailable))?.walk.clone();
            if walk.ready {
                if walk.saved {
                    return Ok(Written::Keep(Walked { indexed: 0, done: true }));
                }
                store.search_walk_save(account, resource).map_err(super::uncertain)?;
                return Ok(Written::Commit(Walked { indexed: 0, done: true }, None));
            }
            // The one walk step (`RecordStore::walk_page`), shared with the holders walk and the order fill.
            let (walked, next) = store.walk_page(account, resource, "live", vec![text(account), text(resource)], walk.after.as_deref(), rows)?;
            let ids: Vec<String> = walked.iter().map(|(id, _)| id.clone()).collect();
            let mut page = Vec::with_capacity(walked.len());
            for (id, version) in ids.iter().zip(walked.into_iter().map(|(_, version)| version)) {
                let Some(version) = version else { continue };
                if version.deleted || version.valid_from > walk.from {
                    continue;
                }
                let Some(value) = version.value()? else { continue };
                page.push((id.clone(), version.valid_from, store.settings.search.terms(&value)));
            }
            let indexed = page.len();
            let done = next.is_none();
            store.search_walked(account, resource, page, if done { None } else { ids.last().cloned() }).map_err(super::uncertain)?;
            Ok(Written::Commit(Walked { indexed, done }, None))
        })
    }

    /// Whether the scope's walk is done: every row from before its index is searchable.
    pub fn search_ready(&self, account: &str, resource: &str) -> Result<bool, Error> {
        super::validate(account, resource, "search_ready")?;
        self.search_observe(self.storage.mark().map_err(super::unavailable)?);
        self.search_load(account, resource).map_err(super::unavailable)?;
        let search = self.search.borrow();
        Ok(search.get(&scope_of(account, resource)).ok_or(crate::cause!(Error::Unavailable))?.walk.ready)
    }

    /// A walked page into the tail, persisted at once with whatever the tail held (a walked row is at or below the
    /// floor, so it cannot wait in the tail), then the walk's cursor (`after` none: done), inside the caller's write scope.
    fn search_walked(&mut self, account: &str, resource: &str, page: Vec<(String, i64, BTreeSet<Term>)>, after: Option<String>)
        -> Result<(), StorageError> {
        let scope = scope_of(account, resource);
        let mut index = self.search.get_mut().remove(&scope).ok_or(crate::cause!(StorageError::Invalid))?;
        let answer = (|| {
            for (id, stamp, terms) in page {
                // A record the tail holds changed after the frontier: its newer entry stands.
                if index.tail.contains_key(&id) {
                    continue;
                }
                self.search_undo.push(Undo::Tail(scope.clone(), id.clone(), None));
                index.tail.insert(id, Entry { stamp, terms: Some(terms) });
            }
            self.flush_index(account, resource, &scope, &mut index)?;
            self.search_undo.push(Undo::Walk(scope.clone(), index.walk.clone()));
            index.walk.ready = after.is_none();
            index.walk.after = after;
            index.walk.saved = true;
            self.put_walk(account, resource, &index.walk)
        })();
        self.search.get_mut().insert(scope, index);
        answer
    }

    /// A scope's persisted segment metas (merges being built included), in recency order, oldest first.
    fn segment_metas(&self, account: &str, resource: &str) -> Result<Vec<Segment>, StorageError> {
        Self::parse_segment_metas(&self.segment_meta_rows(account, resource)?)
    }

    /// The text of a scope's segment meta rows, in key order.
    fn segment_meta_rows(&self, account: &str, resource: &str) -> Result<Vec<String>, StorageError> {
        let mut rows = Vec::new();
        for mut row in self.scan_rows(SEGMENTS, &exact(vec![text(account), text(resource)]), &[Field::whole("meta")])? {
            rows.push(row.take(0).as_text().unwrap_or_default().to_owned());
        }
        Ok(rows)
    }

    fn parse_segment_metas(rows: &[String]) -> Result<Vec<Segment>, StorageError> {
        let mut segments = Vec::with_capacity(rows.len());
        for row in rows {
            #[cfg(test)]
            METAS_PARSED.with(|parsed| parsed.set(parsed.get() + 1));
            segments.push(serde_json::from_str(row).map_err(|error| crate::carry_cause!(StorageError::Invalid, error))?);
        }
        in_order(&mut segments);
        Ok(segments)
    }

    /// One version change of a record inside the caller's write scope (`after` None: deleted). Persists the tail when
    /// it is full or old, or when the change cannot be recovered from the `changed` order.
    pub(super) fn search_changed(
        &mut self,
        account: &str,
        resource: &str,
        id: &str,
        stamp: i64,
        after: Option<&serde_json::Value>,
    ) -> Result<(), StorageError> {
        // A walk with rows left is saved by the first write, so its frontier stands under every later load. A ready
        // walk computed at load (its frontier the newest segment's `hi`) is computed the same again until a flush,
        // which saves it: a store's first write costs no extra row.
        if self.search.get_mut().get(&scope_of(account, resource)).is_some_and(|index| !index.walk.ready) {
            self.search_walk_save(account, resource)?;
        }
        let scope = scope_of(account, resource);
        self.search_drop_stale(account, resource)?;
        let terms = after.map(|value| self.settings.search.terms(value));
        let now = clock_ms(&*self.clock);
        let super::search::Layout::Segments { flush_records, flush_seconds, .. } = &self.settings.search;
        let (flush_records, flush_ms) = (*flush_records, flush_seconds.saturating_mul(1000));
        let index = self.search.get_mut().get_mut(&scope).ok_or(crate::cause!(StorageError::Invalid))?;
        let previous = index.tail.insert(id.to_owned(), Entry { stamp, terms });
        self.search_undo.push(Undo::Tail(scope.clone(), id.to_owned(), previous));
        if index.since.is_none() {
            self.search_undo.push(Undo::Since(scope.clone(), None));
            index.since = Some(now);
        }
        let old = now.saturating_sub(index.since.unwrap_or(now)) >= flush_ms;
        if index.tail.len() >= flush_records || old || stamp <= index.floor() {
            self.search_flush(account, resource)?;
        }
        Ok(())
    }

    /// Destroy a record's search existence inside the destroying scope: its tail entry, and its postings and covered
    /// id in every segment (each touched segment is rewritten under the same id and range).
    pub(super) fn search_erase(&mut self, account: &str, resource: &str, id: &str) -> Result<(), StorageError> {
        let scope = scope_of(account, resource);
        // Stale segments may hold the record's postings: dropping them inside this scope removes those too.
        self.search_drop_stale(account, resource)?;
        let mut index = self.search.get_mut().remove(&scope).ok_or(crate::cause!(StorageError::Invalid))?;
        let answer = (|| {
            if let Some(previous) = index.tail.remove(id) {
                self.search_undo.push(Undo::Tail(scope.clone(), id.to_owned(), Some(previous)));
            }
            if !index.segments.iter().any(|segment| segment.covers.contains_key(id)) {
                return Ok(());
            }
            // A merge being built over a segment that holds the record may have copied its postings already: it is
            // dropped (the next merge step starts it again from the rewritten segments), so no posting of it remains.
            let abandoned = index.merging.iter().any(|building| {
                building.building.as_ref().is_some_and(|building| {
                    index.segments.iter().any(|segment| building.inputs.contains(&segment.id) && segment.covers.contains_key(id))
                })
            });
            if abandoned {
                let merging = std::mem::take(&mut index.merging);
                for building in &merging {
                    self.drop_meta(account, resource, building.id)?;
                }
                self.search_undo.push(Undo::Merging(scope.clone(), merging));
            }
            // Parts left by finished or dropped merges and stale segments may hold the record's postings too.
            self.retire_all(account, resource, &index)?;
            self.search_undo.push(Undo::Segments(scope.clone(), index.segments.clone(), index.next));
            for at in 0..index.segments.len() {
                if !index.segments[at].covers.contains_key(id) {
                    continue;
                }
                let old = index.segments[at].clone();
                let mut postings = self.postings(account, resource, &old)?;
                for posts in postings.values_mut() {
                    posts.retain(|post| post.k != id);
                }
                postings.retain(|_, posts| !posts.is_empty());
                let mut covers = old.covers.clone();
                covers.remove(id);
                self.drop_segment(account, resource, old.id)?;
                index.segments[at] = self.write_segment(account, resource, (old.id, old.level, old.seq), (old.lo, old.hi), postings, covers)?;
            }
            Ok(())
        })();
        self.search.get_mut().insert(scope, index);
        answer
    }

    /// Drop a scope's stale segments (another terms rule) inside the caller's write scope. Its tail already holds every
    /// current row, so nothing they held is lost; the write's own flush then persists the tail under the current rule.
    fn search_drop_stale(&mut self, account: &str, resource: &str) -> Result<(), StorageError> {
        let scope = scope_of(account, resource);
        let stale = match self.search.get_mut().get_mut(&scope) {
            Some(index) if !index.stale.is_empty() => std::mem::take(&mut index.stale),
            Some(_) => return Ok(()),
            None => return Err(crate::cause!(StorageError::Invalid)),
        };
        // Meta rows only: their parts are erased by the merge steps a bounded slice at a time, so the write stays small.
        for segment in &stale {
            self.drop_meta(account, resource, segment.id)?;
        }
        self.search_undo.push(Undo::Stale(scope, stale));
        Ok(())
    }

    /// Persist the tail as one level-0 segment. A write never merges: merges are owed to idle upkeep
    /// (`search_merge`), so a write's time does not depend on how large the index has grown.
    fn search_flush(&mut self, account: &str, resource: &str) -> Result<(), StorageError> {
        let scope = scope_of(account, resource);
        let mut index = self.search.get_mut().remove(&scope).ok_or(crate::cause!(StorageError::Invalid))?;
        let answer = self.flush_index(account, resource, &scope, &mut index);
        self.search.get_mut().insert(scope, index);
        answer
    }

    fn flush_index(&mut self, account: &str, resource: &str, scope: &Scope, index: &mut Index) -> Result<(), StorageError> {
        if index.tail.is_empty() {
            return Ok(());
        }
        self.search_undo.push(Undo::Segments(scope.clone(), index.segments.clone(), index.next));
        let lo = index.hi();
        // A segment persisted while a frontier stands ends no lower than it: the rows below it are the walk's.
        let hi = index.tail.values().map(|entry| entry.stamp).max().unwrap_or(lo).max(lo).max(index.walk.from);
        let tail = std::mem::take(&mut index.tail);
        let mut postings: BTreeMap<Term, Vec<Post>> = BTreeMap::new();
        let mut covers = BTreeMap::new();
        for (id, entry) in &tail {
            let terms = entry.terms.iter().flatten();
            // A record without terms needs covering only to shadow an older segment's postings of it.
            if entry.terms.as_ref().is_some_and(|terms| !terms.is_empty())
                || index.segments.iter().any(|segment| segment.covers.contains_key(id))
            {
                covers.insert(id.clone(), entry.stamp);
            }
            for term in terms {
                postings.entry(term.clone()).or_default().push(Post { s: entry.stamp, k: id.clone() });
            }
        }
        for posts in postings.values_mut() {
            posts.sort_by(|a, b| b.s.cmp(&a.s));
        }
        for (id, entry) in tail {
            self.search_undo.push(Undo::Tail(scope.clone(), id, Some(entry)));
        }
        self.search_undo.push(Undo::Since(scope.clone(), index.since.take()));
        let id = index.next;
        index.next += 1;
        let segment = self.write_segment(account, resource, (id, 0, None), (lo, hi), postings, covers)?;
        index.segments.push(segment);
        // The walk is saved with the first segment it stands beside: a load after it reads the walk, not a new one.
        if !index.walk.saved {
            self.search_undo.push(Undo::Walk(scope.clone(), index.walk.clone()));
            index.walk.saved = true;
            self.put_walk(account, resource, &index.walk)?;
        }
        Ok(())
    }

    /// Write one segment's parts and meta row.
    fn write_segment(
        &self,
        account: &str,
        resource: &str,
        (id, level, seq): (i64, u32, Option<i64>),
        (lo, hi): (i64, i64),
        postings: BTreeMap<Term, Vec<Post>>,
        covers: BTreeMap<String, i64>,
    ) -> Result<Segment, StorageError> {
        let firsts = self.write_parts(account, resource, id, 0, postings)?;
        let segment = Segment { id, level, lo, hi, firsts, covers, rule: self.settings.search.rule(), seq, building: None };
        self.put_meta(account, resource, &segment, true)?;
        Ok(segment)
    }

    /// Write `postings` as parts of about `part_bytes` of segment `id`, numbered from `first`; answers the first term of
    /// each part written.
    fn write_parts(&self, account: &str, resource: &str, id: i64, first: usize, postings: BTreeMap<Term, Vec<Post>>)
        -> Result<Vec<Term>, StorageError> {
        let super::search::Layout::Segments { part_bytes, .. } = &self.settings.search;
        let mut parts: Vec<Part> = Vec::new();
        let (mut part, mut bytes): (Part, usize) = (Vec::new(), 0);
        // Bytes as `encode_part` writes them: a posting is an index into the part's table of (record id, stamp)
        // pairs, and each pair is written once per part.
        let mut listed: BTreeSet<(String, i64)> = BTreeSet::new();
        for (term, posts) in postings {
            bytes += term.0.len() + term.1.len() + 3;
            for post in &posts {
                bytes += 2;
                if listed.insert((post.k.clone(), post.s)) {
                    bytes += post.k.len() + 10;
                }
            }
            part.push((term, posts));
            if bytes >= *part_bytes {
                parts.push(std::mem::take(&mut part));
                listed.clear();
                bytes = 0;
            }
        }
        if !part.is_empty() {
            parts.push(part);
        }
        let mut firsts = Vec::with_capacity(parts.len());
        let mut batch = Batch::default();
        for (n, part) in parts.iter().enumerate() {
            firsts.push(part[0].0.clone());
            let body = encode_part(part);
            let row = vec![
                ("account", text(account)),
                ("resource", text(resource)),
                ("segment", Value::Integer(id)),
                ("part", Value::Integer((first + n) as i64)),
                ("body", Value::Blob(body)),
            ];
            batch.put(PARTS, row, true);
            if batch.len() >= WRITE_BATCH {
                batch.send(&self.storage)?;
            }
        }
        batch.send(&self.storage)?;
        Ok(firsts)
    }

    /// Write a segment's meta row (`new`: it must not exist yet; else it replaces the row a merge being built keeps).
    fn put_meta(&self, account: &str, resource: &str, segment: &Segment, new: bool) -> Result<(), StorageError> {
        let meta = serde_json::to_string(segment).map_err(|error| crate::carry_cause!(StorageError::Invalid, error))?;
        let row = vec![
            ("account", text(account)),
            ("resource", text(resource)),
            ("segment", Value::Integer(segment.id)),
            ("meta", Value::Text(meta)),
        ];
        let mut batch = Batch::default();
        batch.put(SEGMENTS, row, new);
        batch.send(&self.storage)?;
        Ok(())
    }

    /// One step of the merges a scope owes, in its own write scope, committed alone: the old trillion index merge in
    /// resumable turns (Trillion-X/trillion 4ffa1dc4a2^ parts/record-log/do-work/record-log-store.mjs:112-119, at most
    /// 4 MiB a turn, because one merge done at once held a 4 GB store for 4 to 12 seconds), ported onto this layout's
    /// tiers. A merge is owed where `fan_in` segments next to each other in recency order share a level (the lowest such
    /// level first, the newest run of it first); it is built as a new segment of the next level whose meta row says it
    /// is being built (`Building`), so no search reads it, while its inputs keep answering every search. Each step reads
    /// the inputs' parts for the next run of terms until about `bytes` of them are read (at least one run of terms, so a
    /// step always moves), merges their postings the way a whole merge does (a posting of a record a newer input covers
    /// is dropped), writes them as the new segment's next parts and moves `next` past them. The step that reaches the
    /// last term writes the covered ids, drops the inputs and makes the new segment readable in their place. A step that
    /// rolls back leaves the merge where the last committed step left it. Writes go on between steps: they only add
    /// newer segments, which never touch the inputs; an erasure that rewrites an input drops the merge being built
    /// (`search_erase`). Dropped from the whole merge: the covered ids of the oldest segment are kept whole (the whole
    /// merge kept only those with a posting, which needs every posting at once); a covered id with no posting only
    /// shadows older segments, and the oldest has none, so answers are the same and only its meta row is larger.
    pub fn search_merge(&mut self, account: &str, resource: &str, bytes: usize) -> Result<Merged, Error> {
        super::validate(account, resource, "search_merge")?;
        if bytes == 0 {
            return Err(Error::Invalid("invalid search merge step size", crate::cause!()));
        }
        self.write(account, resource, |store| {
            let scope = scope_of(account, resource);
            let mut index = store.search.get_mut().remove(&scope).ok_or(crate::cause!(Error::Unavailable))?;
            let answer = store.merge_step(account, resource, &scope, &mut index, bytes);
            store.search.get_mut().insert(scope, index);
            match answer.map_err(super::uncertain)? {
                None => Ok(Written::Keep(Merged { bytes: 0, done: true })),
                Some(merged) => Ok(Written::Commit(merged, None)),
            }
        })
    }

    /// The merge step inside the caller's write scope (`search_merge`); None when nothing is owed and nothing changed.
    fn merge_step(&mut self, account: &str, resource: &str, scope: &Scope, index: &mut Index, bytes: usize)
        -> Result<Option<Merged>, StorageError> {
        // Segments of another terms rule are never read and dropped by the scope's next write: nothing to merge.
        if !index.stale.is_empty() {
            return Ok(None);
        }
        let super::search::Layout::Segments { fan_in, .. } = &self.settings.search;
        let fan_in = *fan_in;
        // Whatever the step changes in memory is undone with its scope.
        self.search_undo.push(Undo::Merging(scope.clone(), index.merging.clone()));
        self.search_undo.push(Undo::Segments(scope.clone(), index.segments.clone(), index.next));
        // The merge being built stands while its inputs are still the scope's segments, next to each other, in order.
        let mut continued: Option<(usize, Segment)> = None;
        let mut dropped = Vec::new();
        for building in std::mem::take(&mut index.merging) {
            let at = building.building.as_ref().and_then(|state| {
                let first = index.segments.iter().position(|segment| Some(&segment.id) == state.inputs.first())?;
                let run = index.segments.get(first..first + state.inputs.len())?;
                run.iter().map(|segment| segment.id).eq(state.inputs.iter().copied()).then_some(first)
            });
            match at {
                Some(at) if continued.is_none() && building.rule == self.settings.search.rule() => continued = Some((at, building)),
                _ => dropped.push(building),
            }
        }
        for building in &dropped {
            self.drop_meta(account, resource, building.id)?;
        }
        // Parts no meta row names (the inputs of a finished merge, a dropped merge, stale segments) are erased first,
        // about `bytes` of them a step: a step of its own, so it stays bounded.
        let super::search::Layout::Segments { part_bytes, .. } = &self.settings.search;
        let most = (bytes / (*part_bytes).max(1)).max(1);
        index.merging.extend(continued.iter().map(|(_, building)| building.clone()));
        let retired = self.retire_step(account, resource, index, most)?;
        index.merging.clear();
        if retired {
            index.merging.extend(continued.map(|(_, building)| building));
            return Ok(Some(Merged { bytes: 0, done: false }));
        }
        let (at, mut building) = match continued {
            Some(found) => found,
            None => {
                // The lowest level with `fan_in` segments next to each other, its newest such run.
                let owed = (0..index.segments.len().saturating_sub(fan_in - 1))
                    .filter(|&at| {
                        let level = index.segments[at].level;
                        index.segments[at..at + fan_in].iter().all(|segment| segment.level == level)
                    })
                    .min_by_key(|&at| (index.segments[at].level, std::cmp::Reverse(at)));
                let Some(at) = owed else {
                    return Ok((!dropped.is_empty()).then_some(Merged { bytes: 0, done: true }));
                };
                let group = &index.segments[at..at + fan_in];
                let id = index.next;
                index.next += 1;
                let building = Segment {
                    id,
                    level: group[0].level + 1,
                    lo: group[0].lo,
                    hi: group[fan_in - 1].hi,
                    firsts: Vec::new(),
                    covers: BTreeMap::new(),
                    rule: self.settings.search.rule(),
                    seq: Some(group[fan_in - 1].seq()),
                    building: Some(Building { inputs: group.iter().map(|segment| segment.id).collect(), next: None }),
                };
                self.put_meta(account, resource, &building, true)?;
                (at, building)
            }
        };
        let count = building.building.as_ref().map_or(0, |state| state.inputs.len());
        let group: Vec<Segment> = index.segments[at..at + count].to_vec();
        let state = building.building.clone().ok_or(crate::cause!(StorageError::Invalid))?;
        let (merged, upper, read) = self.merge_terms(account, resource, &group, state.next.as_ref(), bytes)?;
        let firsts = self.write_parts(account, resource, building.id, building.firsts.len(), merged)?;
        building.firsts.extend(firsts);
        if upper.is_some() {
            building.building = Some(Building { next: upper, ..state });
            self.put_meta(account, resource, &building, false)?;
            index.merging = vec![building];
            return Ok(Some(Merged { bytes: read, done: false }));
        }
        // The last term is merged: the covered ids (newest input first), then the new segment in its inputs' place.
        let mut covers: BTreeMap<String, i64> = BTreeMap::new();
        for segment in group.iter().rev() {
            for (id, stamp) in &segment.covers {
                covers.entry(id.clone()).or_insert(*stamp);
            }
        }
        building.covers = covers;
        building.building = None;
        // The inputs' meta rows go now (one row each); their parts are erased by the next steps (`retire_step`).
        for segment in &group {
            self.drop_meta(account, resource, segment.id)?;
        }
        self.put_meta(account, resource, &building, false)?;
        index.segments.splice(at..at + count, [building]);
        // Not done: the inputs' parts are left to erase, so at least one more step is owed.
        Ok(Some(Merged { bytes: read, done: false }))
    }

    /// The merged postings of `group` (oldest first) for the terms from `from` (inclusive; none: the first) up to the
    /// answered upper term (exclusive; none: every term left), reading whole runs of terms between the inputs' part
    /// boundaries until about `bytes` of parts are read. Also answers the bytes read.
    #[allow(clippy::type_complexity)]
    fn merge_terms(&self, account: &str, resource: &str, group: &[Segment], from: Option<&Term>, bytes: usize)
        -> Result<(BTreeMap<Term, Vec<Post>>, Option<Term>, usize), StorageError> {
        // Every part boundary above `from`: between two of them each input holds its terms in one run of parts.
        let mut bounds: Vec<&Term> = group.iter().flat_map(|segment| &segment.firsts).filter(|first| from.is_none_or(|from| *first > from)).collect();
        bounds.sort();
        bounds.dedup();
        let mut bounds = bounds.into_iter().map(Some).chain([None]);
        // Parts read, per input: (first part number, parts).
        let mut held: Vec<(usize, Vec<Part>)> = vec![(0, Vec::new()); group.len()];
        let (mut read, mut upper): (usize, Option<Term>);
        read = 0;
        loop {
            let bound = bounds.next().flatten();
            for (at, segment) in group.iter().enumerate() {
                if segment.firsts.is_empty() {
                    continue;
                }
                let first = from.and_then(|from| segment.part_of(from)).unwrap_or(0);
                let last = match bound {
                    Some(bound) => match segment.firsts.partition_point(|first| first < bound).checked_sub(1) {
                        Some(last) => last,
                        None => continue,
                    },
                    None => segment.firsts.len() - 1,
                };
                let (start, parts) = &mut held[at];
                if parts.is_empty() {
                    *start = first;
                }
                let have = *start + parts.len();
                if last < have {
                    continue;
                }
                for (part, size) in self.parts_sized(account, resource, segment.id, have.max(first)..last + 1)? {
                    read += size;
                    parts.push(part);
                }
            }
            upper = bound.cloned();
            if upper.is_none() || read >= bytes {
                break;
            }
        }
        let within = |term: &Term| from.is_none_or(|from| term >= from) && upper.as_ref().is_none_or(|upper| term < upper);
        let mut merged: BTreeMap<Term, Vec<Post>> = BTreeMap::new();
        let mut newer: BTreeSet<&String> = BTreeSet::new();
        for (at, segment) in group.iter().enumerate().rev() {
            for (term, posts) in held[at].1.iter().flatten() {
                if !within(term) {
                    continue;
                }
                let keep: Vec<Post> = posts.iter().filter(|post| !newer.contains(&post.k)).cloned().collect();
                if !keep.is_empty() {
                    merged.entry(term.clone()).or_default().extend(keep);
                }
            }
            newer.extend(segment.covers.keys());
        }
        for posts in merged.values_mut() {
            posts.sort_by(|a, b| b.s.cmp(&a.s));
        }
        Ok((merged, upper, read))
    }

    /// Erase a segment's meta row only: no search reads it again, and its parts are left for the merge steps to erase a
    /// bounded slice at a time (`retire_step`), so dropping a segment of any size costs one row.
    fn drop_meta(&self, account: &str, resource: &str, id: i64) -> Result<(), StorageError> {
        let mut batch = Batch::default();
        batch.erase(SEGMENTS, vec![text(account), text(resource), Value::Integer(id)]);
        batch.send(&self.storage)?;
        Ok(())
    }

    /// The first segment id at or above `from` with parts but no meta row among `known`, and its highest part number:
    /// one seek per known segment passed, at most.
    fn orphan_parts(&self, account: &str, resource: &str, known: &BTreeSet<i64>) -> Result<Option<(i64, i64)>, StorageError> {
        let mut from = i64::MIN;
        loop {
            let range = Range {
                order: Order::Key,
                from: Bound::Included(vec![text(account), text(resource), Value::Integer(from)]),
                to: Bound::Included(vec![text(account), text(resource)]),
                reverse: false,
                limit: Some(1),
            };
            let Some(mut row) = self.scan_rows(PARTS, &range, &[Field::whole("segment")])?.pop() else { return Ok(None) };
            let id = row.take(0).as_integer().ok_or(crate::cause!(StorageError::Invalid))?;
            if known.contains(&id) {
                from = id.checked_add(1).ok_or(crate::cause!(StorageError::Invalid))?;
                continue;
            }
            let last = Range { reverse: true, ..exact(vec![text(account), text(resource), Value::Integer(id)]) };
            let last = Range { limit: Some(1), ..last };
            let mut row = self.scan_rows(PARTS, &last, &[Field::whole("part")])?.pop().ok_or(crate::cause!(StorageError::Invalid))?;
            return Ok(Some((id, row.take(0).as_integer().ok_or(crate::cause!(StorageError::Invalid))?)));
        }
    }

    /// Every segment id the scope's memory knows a meta row of (stale ones and merges being built included).
    fn known_segments(index: &Index) -> BTreeSet<i64> {
        index.segments.iter().chain(&index.merging).chain(&index.stale).map(|segment| segment.id).collect()
    }

    /// Erase the last `most` parts of the first orphan segment (parts with no meta row: inputs of a finished merge, a
    /// dropped merge being built, stale segments); answers whether there was one.
    fn retire_step(&self, account: &str, resource: &str, index: &Index, most: usize) -> Result<bool, StorageError> {
        let Some((id, last)) = self.orphan_parts(account, resource, &Self::known_segments(index))? else { return Ok(false) };
        let first = (last + 1).saturating_sub(most as i64).max(0);
        let range = Range {
            order: Order::Key,
            from: Bound::Included(vec![text(account), text(resource), Value::Integer(id), Value::Integer(first)]),
            to: Bound::Included(vec![text(account), text(resource), Value::Integer(id)]),
            reverse: false,
            limit: None,
        };
        self.storage.erase(PARTS, &range)?;
        Ok(true)
    }

    /// Erase every orphan part at once (`search_erase`: an orphan part may hold a posting of the record destroyed).
    fn retire_all(&self, account: &str, resource: &str, index: &Index) -> Result<(), StorageError> {
        while let Some((id, _)) = self.orphan_parts(account, resource, &Self::known_segments(index))? {
            self.storage.erase(PARTS, &exact(vec![text(account), text(resource), Value::Integer(id)]))?;
        }
        Ok(())
    }

    fn drop_segment(&self, account: &str, resource: &str, id: i64) -> Result<(), StorageError> {
        let key = vec![text(account), text(resource), Value::Integer(id)];
        let mut batch = Batch::default();
        batch.erase(PARTS, key.clone());
        batch.erase(SEGMENTS, key);
        batch.send(&self.storage)?;
        Ok(())
    }

    /// One part of a segment (one row read).
    fn part(&self, account: &str, resource: &str, segment: i64, n: usize) -> Result<Part, StorageError> {
        self.parts(account, resource, segment, n..n + 1)?.pop().ok_or(crate::cause!(StorageError::Invalid))
    }

    /// Parts `numbers` of a segment, in order, in one batch read (a row read each).
    fn parts(&self, account: &str, resource: &str, segment: i64, numbers: std::ops::Range<usize>) -> Result<Vec<Part>, StorageError> {
        Ok(self.parts_sized(account, resource, segment, numbers)?.into_iter().map(|(part, _)| part).collect())
    }

    /// Parts `numbers` of a segment with the stored bytes of each, in order, in one batch read (a row read each).
    fn parts_sized(&self, account: &str, resource: &str, segment: i64, numbers: std::ops::Range<usize>)
        -> Result<Vec<(Part, usize)>, StorageError> {
        let keys: Vec<Vec<Value>> = numbers
            .map(|n| vec![text(account), text(resource), Value::Integer(segment), Value::Integer(n as i64)])
            .collect();
        let rows = rows_by_key(&self.storage, PARTS, &keys, &[Field::whole("body")])?;
        self.count(rows.len(), rows.iter().flatten().count());
        rows.into_iter()
            .map(|row| match row.map(|mut row| row.take(0)) {
                Some(Value::Blob(body)) => Ok((decode_part(&body)?, body.len())),
                _ => Err(crate::cause!(StorageError::Invalid)),
            })
            .collect()
    }

    /// Every posting of a segment (merges and erasure read whole segments).
    fn postings(&self, account: &str, resource: &str, segment: &Segment) -> Result<BTreeMap<Term, Vec<Post>>, StorageError> {
        let mut all = BTreeMap::new();
        for part in self.parts(account, resource, segment.id, 0..segment.firsts.len())? {
            all.extend(part);
        }
        Ok(all)
    }

    /// Carry `memory` into this store (`SearchMemory`). A nested write's commit then keeps its memory changes (the
    /// shared search memory drops them if the transaction around it rolls back) instead of dropping the scope's memory.
    pub fn carry_search(&mut self, memory: SearchMemory) {
        *self.search.get_mut() = memory.0;
        self.search_carried = true;
    }

    /// The search memory this store holds, for the next store over the same file; none while a write scope is open.
    pub fn take_search(&mut self) -> SearchMemory {
        if !self.search_undo.is_empty() {
            return SearchMemory::default();
        }
        SearchMemory(std::mem::take(self.search.get_mut()))
    }

    /// The write committed: its memory changes stand.
    pub(super) fn search_commit(&mut self) {
        self.search_undo.clear();
    }

    /// The write rolled back: undo its memory changes, newest first.
    pub(super) fn search_rollback(&mut self) {
        let search = self.search.get_mut();
        while let Some(undo) = self.search_undo.pop() {
            match undo {
                Undo::Tail(scope, id, previous) => {
                    if let Some(index) = search.get_mut(&scope) {
                        match previous {
                            Some(entry) => index.tail.insert(id, entry),
                            None => index.tail.remove(&id),
                        };
                    }
                }
                Undo::Since(scope, since) => {
                    if let Some(index) = search.get_mut(&scope) {
                        index.since = since;
                    }
                }
                Undo::Segments(scope, segments, next) => {
                    if let Some(index) = search.get_mut(&scope) {
                        index.segments = segments;
                        index.next = next;
                    }
                }
                Undo::Stale(scope, stale) => {
                    if let Some(index) = search.get_mut(&scope) {
                        index.stale = stale;
                    }
                }
                Undo::Walk(scope, walk) => {
                    if let Some(index) = search.get_mut(&scope) {
                        index.walk = walk;
                    }
                }
                Undo::Merging(scope, merging) => {
                    if let Some(index) = search.get_mut(&scope) {
                        index.merging = merging;
                    }
                }
            }
        }
    }

    /// A commit whose outcome is unknown: forget the scope's memory so its next use rebuilds it from storage.
    pub(super) fn search_forget(&mut self, account: &str, resource: &str) {
        self.search_undo.clear();
        self.search.get_mut().remove(&scope_of(account, resource));
    }

    /// Records of a scope whose declared text fields hold `word` (in any field, or only in `field`), newest change
    /// first. Reads the tail (memory), one part per segment and searched field until `limit` results are confirmed,
    /// one current row per confirmation, and one current row per tail result.
    pub fn search(&self, account: &str, resource: &str, field: Option<&str>, word: &str, limit: usize) -> Result<Found, Error> {
        super::validate(account, resource, "search")?;
        if word.is_empty() || !(1..=crate::records::MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid search word or limit", crate::cause!()));
        }
        let fields = self.settings.search.fields();
        if field.is_some_and(|field| !fields.iter().any(|declared| declared == field)) {
            return Err(Error::Invalid("the field is not searchable", crate::cause!()));
        }
        let word = word.to_lowercase();
        let terms: Vec<Term> =
            fields.iter().filter(|name| field.is_none_or(|field| field == *name)).map(|name| (name.clone(), word.clone())).collect();
        let start = self.work.get();
        self.search_observe(self.storage.mark().map_err(super::unavailable)?);
        self.search_load(account, resource).map_err(super::unavailable)?;
        let search = self.search.borrow();
        let index = search.get(&scope_of(account, resource)).ok_or(crate::cause!(Error::Unavailable))?;
        let mut hits: Vec<(i64, String, Option<Record>)> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for (id, entry) in &index.tail {
            seen.insert(id.clone());
            if entry.terms.as_ref().is_some_and(|held| terms.iter().any(|term| held.contains(term))) {
                hits.push((entry.stamp, id.clone(), None));
            }
        }
        'segments: for segment in index.segments.iter().rev() {
            if hits.len() >= limit {
                break;
            }
            for term in &terms {
                let Some(n) = segment.part_of(term) else { continue };
                let part = self.part(account, resource, segment.id, n).map_err(super::unavailable)?;
                let Ok(at) = part.binary_search_by(|(held, _)| held.cmp(term)) else { continue };
                let mut posts = part[at].1.iter();
                // Candidates are read as many at a time as hits are still wanted: a read that finds them all is one
                // batch, and a stale posting only asks for the next batch. The reads are the ones one at a time would make.
                while hits.len() < limit {
                    let mut chunk = Vec::new();
                    while chunk.len() < limit - hits.len() {
                        let Some(post) = posts.next() else { break };
                        if seen.insert(post.k.clone()) {
                            chunk.push(post);
                        }
                    }
                    if chunk.is_empty() {
                        break;
                    }
                    let current = self.currents(account, resource, &chunk.iter().map(|post| post.k.as_str()).collect::<Vec<_>>())?;
                    for (post, current) in chunk.into_iter().zip(current) {
                        if let Some(version) = current.filter(|version| version.valid_from == post.s) {
                            if let Some(record) = version.record()? {
                                hits.push((post.s, post.k.clone(), Some(record)));
                                if hits.len() >= limit {
                                    break 'segments;
                                }
                            }
                        }
                    }
                }
            }
            seen.extend(segment.covers.keys().cloned());
        }
        drop(search);
        hits.sort_by(|a, b| b.0.cmp(&a.0));
        hits.truncate(limit);
        // Hits found in the unflushed tail carry no record yet: they are read in one batch.
        let unread: Vec<&str> = hits.iter().filter(|hit| hit.2.is_none()).map(|hit| hit.1.as_str()).collect();
        let mut fetched = self.currents(account, resource, &unread)?.into_iter();
        let mut records = Vec::with_capacity(hits.len());
        for (_, _, record) in &mut hits {
            let record = match record.take() {
                Some(record) => Some(record),
                None => fetched.next().ok_or(crate::cause!(Error::Unavailable))?.map(|version| version.record()).transpose()?.flatten(),
            };
            records.extend(record);
        }
        Ok(Found { records, work: self.since(start) })
    }
}

/// What the walk tests need of a store: a store written before its index existed, and the size of its memory tail.
#[cfg(test)]
impl<S: Storage> RecordStore<S> {
    /// Remove a scope's whole word index and walk (its segments, parts and walk row) and forget its memory: the store a
    /// scope was before records:search existed, with every row it holds still there.
    pub(super) fn forget_search_index(&mut self, account: &str, resource: &str) -> Result<(), Error> {
        self.write(account, resource, |store| {
            let mut batch = Batch::default();
            for family in [SEGMENTS, PARTS, WALK] {
                batch.erase(family, vec![text(account), text(resource)]);
            }
            batch.send(&store.storage).map_err(super::uncertain)?;
            Ok(Written::Commit((), None))
        })?;
        self.search.get_mut().clear();
        Ok(())
    }

    /// Records the scope's memory tail holds now (0 when the scope is not loaded).
    pub(super) fn search_tail_len(&self, account: &str, resource: &str) -> usize {
        self.search.borrow().get(&scope_of(account, resource)).map_or(0, |index| index.tail.len())
    }
}

#[cfg(test)]
mod walk_tests {
    use super::carry_tests::{store_with, Store};
    use super::*;
    use crate::records::{Mutation, Records};
    use std::path::Path;

    const ACCOUNT: &str = "account";
    const RESOURCE: &str = "notes";

    /// A segment's meta row lists every record it covers, so the top segment of 100,000 rows is past 1 MiB (a named
    /// gap of the segments layout, not of the walk): these stores take values up to 64 MiB.
    fn store(path: &Path) -> Store {
        store_with(path, 64 << 20)
    }
    fn id(n: usize) -> String {
        format!("r{n:06}")
    }
    /// A store of `rows` notes written with the index off: written, then their whole index removed, as a store that
    /// existed before records:search. Each note holds the shared word `common` and its own word `markerN`.
    fn written_before_the_index(path: &Path, rows: usize) -> Store {
        let mut store = store(path);
        let mut n = 0;
        while n < rows {
            let page: Vec<(String, serde_json::Value)> = (n..(n + 1000).min(rows))
                .map(|n| (id(n), serde_json::json!({ "text": format!("common note marker{n}") })))
                .collect();
            n += page.len();
            store.import(ACCOUNT, RESOURCE, &page).unwrap();
        }
        store.forget_search_index(ACCOUNT, RESOURCE).unwrap();
        drop(store);
        self::store(path)
    }
    fn found(store: &Store, word: &str) -> Vec<String> {
        store.search(ACCOUNT, RESOURCE, None, word, 10).unwrap().records.into_iter().map(|record| record.id).collect()
    }
    fn walk_to_the_end(store: &mut Store, rows: usize) -> (usize, usize) {
        let (mut indexed, mut steps) = (0, 0);
        loop {
            let walked = store.search_walk(ACCOUNT, RESOURCE, rows).unwrap();
            indexed += walked.indexed;
            steps += 1;
            if walked.done {
                return (indexed, steps);
            }
        }
    }

    /// A store of N rows written with the index off, then turned on, finds row N-7 once the walk is done, and not
    /// before: until then its walk is not ready.
    #[test]
    fn rows_written_before_the_index_are_found_after_the_walk() {
        const N: usize = 1000;
        let dir = tempfile::tempdir().unwrap();
        let mut store = written_before_the_index(&dir.path().canonicalize().unwrap().join("notes.sqlite"), N);
        let word = format!("marker{}", N - 7);
        assert!(found(&store, &word).is_empty(), "the index holds nothing of the rows written before it");
        assert!(!store.search_ready(ACCOUNT, RESOURCE).unwrap());
        let (indexed, steps) = walk_to_the_end(&mut store, 64);
        assert_eq!(indexed, N, "the walk indexed every row once");
        assert_eq!(steps, N.div_ceil(64), "a page per step");
        assert_eq!(found(&store, &word), vec![id(N - 7)]);
        assert!(store.search_ready(ACCOUNT, RESOURCE).unwrap());
        assert_eq!(found(&store, "common").len(), 10);
        // A further step has nothing to do and writes nothing.
        let changes = store.storage().changes();
        assert_eq!(store.search_walk(ACCOUNT, RESOURCE, 64).unwrap(), Walked { indexed: 0, done: true });
        assert_eq!(store.storage().changes(), changes);
    }

    /// A walk stopped half way (its store dropped) starts at the next record in a new store: no page is indexed twice.
    #[test]
    fn a_walk_stopped_half_way_resumes_without_re_indexing() {
        const N: usize = 1000;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("notes.sqlite");
        let mut first = written_before_the_index(&path, N);
        let mut indexed = 0;
        for _ in 0..8 {
            let walked = first.search_walk(ACCOUNT, RESOURCE, 64).unwrap();
            assert!(!walked.done);
            indexed += walked.indexed;
        }
        assert_eq!(indexed, 512);
        assert_eq!(found(&first, "marker100"), vec![id(100)], "a walked row is found at once");
        assert!(found(&first, &format!("marker{}", N - 7)).is_empty(), "a row past the cursor is not yet");
        drop(first);

        let mut second = store(&path);
        let rows_before = second.work().rows_read;
        let walked = second.search_walk(ACCOUNT, RESOURCE, 64).unwrap();
        assert_eq!(walked.indexed, 64);
        // The step read its segment metas, its walk row and one page of ids and rows past the cursor, never the first half.
        assert!(second.work().rows_read - rows_before < 3 * 64, "read {}", second.work().rows_read - rows_before);
        let (rest, _) = walk_to_the_end(&mut second, 64);
        assert_eq!(indexed + walked.indexed + rest, N, "every row indexed exactly once across the stop");
        assert_eq!(found(&second, &format!("marker{}", N - 7)), vec![id(N - 7)]);
        assert_eq!(found(&second, "marker100"), vec![id(100)]);
    }

    /// A write during the walk is found at once, whether a new record or a change to a row the walk has not reached; a
    /// walked page never brings back the changed row's older words.
    #[test]
    fn a_write_during_the_walk_is_found() {
        const N: usize = 1000;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("notes.sqlite");
        let mut store = written_before_the_index(&path, N);
        assert!(!store.search_walk(ACCOUNT, RESOURCE, 64).unwrap().done);
        let put = |id: &str, expected_version: i64, text: &str| Mutation {
            id: id.to_owned(), expected_version, request_key: format!("w-{id}-{expected_version}"), deleted: false,
            value: serde_json::json!({ "text": text }),
        };
        store.mutate(ACCOUNT, RESOURCE, put("fresh", 0, "written during the walk")).unwrap();
        store.mutate(ACCOUNT, RESOURCE, put(&id(N - 7), 1, "changed during the walk")).unwrap();
        assert_eq!(found(&store, "written"), vec!["fresh".to_owned()]);
        assert_eq!(found(&store, "changed"), vec![id(N - 7)]);
        // The same from a new store, before the walk is done: a cold start loads the writes above the frontier.
        drop(store);
        let mut store = self::store(&path);
        assert_eq!(found(&store, "written"), vec!["fresh".to_owned()]);
        assert_eq!(found(&store, "changed"), vec![id(N - 7)]);
        let (indexed, _) = walk_to_the_end(&mut store, 64);
        assert_eq!(indexed, N - 64 - 1, "the changed row was skipped: its own write indexed it");
        assert_eq!(found(&store, "changed"), vec![id(N - 7)]);
        assert!(found(&store, &format!("marker{}", N - 7)).is_empty(), "the changed row's older words are gone");
        assert_eq!(found(&store, "written"), vec!["fresh".to_owned()]);
        assert_eq!(found(&store, &format!("marker{}", N - 8)), vec![id(N - 8)]);
    }

    /// At 100,000 rows written before the index, a cold start reads and holds at most `flush_records` + 1 of them (not
    /// the whole store, as it did before the walk), and no walk step holds more than its page and the unflushed tail.
    #[test]
    fn memory_stays_bounded_at_100000_rows() {
        const N: usize = 100_000;
        let dir = tempfile::tempdir().unwrap();
        let mut store = written_before_the_index(&dir.path().canonicalize().unwrap().join("notes.sqlite"), N);
        let super::super::search::Layout::Segments { flush_records, .. } = &store.settings.search;
        let flush_records = *flush_records;
        let walk_rows = store.settings.search.walk_rows();
        let before = store.work().rows_read;
        assert!(found(&store, &format!("marker{}", N - 7)).is_empty());
        let read = store.work().rows_read - before;
        assert!(read <= flush_records as u64 + 8, "a cold start read {read} rows");
        assert_eq!(store.search_tail_len(ACCOUNT, RESOURCE), 0, "the tail starts empty: the walk owns every older row");
        let (mut indexed, mut most) = (0, 0);
        loop {
            let walked = store.search_walk(ACCOUNT, RESOURCE, walk_rows).unwrap();
            most = most.max(store.search_tail_len(ACCOUNT, RESOURCE));
            indexed += walked.indexed;
            if walked.done {
                break;
            }
        }
        assert_eq!(indexed, N);
        assert!(most <= walk_rows + flush_records, "the tail held {most} records");
        assert_eq!(found(&store, &format!("marker{}", N - 7)), vec![id(N - 7)]);
    }
}

#[cfg(test)]
mod carry_tests {
    use super::super::{settings, RealClock};
    use super::*;
    use crate::{
        records::{Mutation, Records},
        storage::sqlite::{self, Bounds, Spend},
    };
    use std::{path::Path, time::Duration};

    const ACCOUNT: &str = "account";
    const RESOURCE: &str = "notes";

    /// A record store over a SQLite file (the walk tests' stores too: `walk_tests`).
    pub(super) type Store = RecordStore<sqlite::Supply<sqlite::Connection>>;
    fn store(path: &Path) -> Store {
        store_with(path, 1 << 20)
    }
    pub(super) fn store_with(path: &Path, value_bytes: usize) -> Store {
        let bounds = Bounds { value_bytes, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(5) };
        let limits = settings::Limits::fixed(1 << 20, 10 << 30);
        RecordStore::new(sqlite::open_owned(path, "record_store", bounds).unwrap(), Box::new(RealClock), limits).unwrap()
    }
    fn note(store: &mut Store, id: &str, text: &str) {
        let write = Mutation { id: id.to_owned(), expected_version: 0, request_key: format!("w-{id}"), deleted: false, value: serde_json::json!({ "text": text }) };
        store.mutate(ACCOUNT, RESOURCE, write).unwrap();
    }
    fn rows_to_load<S: Storage>(store: &RecordStore<S>) -> u64 {
        let before = store.work().rows_read;
        store.search_load(ACCOUNT, RESOURCE).unwrap();
        store.work().rows_read - before
    }

    /// Memory carried to the next store reads only what changed since, and still sees a write made by a store that
    /// never held it.
    #[test]
    fn carried_memory_reads_only_the_rows_changed_since_and_misses_no_other_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("notes.sqlite");
        let mut first = store(&path);
        for n in 0..100 {
            note(&mut first, &format!("a{n:03}"), "alpha");
        }
        let memory = first.take_search();
        drop(first);
        note(&mut store(&path), "b000", "beta");

        assert!(rows_to_load(&store(&path)) >= 101, "a store without memory reads the whole unflushed tail");
        let mut carried = store(&path);
        carried.carry_search(memory);
        // The row changed since, and the scope's walk row (checked at every use, like the segment metas).
        assert!(rows_to_load(&carried) <= 2, "a carried store reads only the row changed since its memory and its walk row");
        assert_eq!(carried.search(ACCOUNT, RESOURCE, None, "beta", 10).unwrap().records.len(), 1);
        assert_eq!(carried.search(ACCOUNT, RESOURCE, None, "alpha", 10).unwrap().records.len(), 10);
    }

    /// A carried store whose segment meta rows are as its memory loaded them parses none of them: every write used to
    /// parse every meta row of its scope (27 MB on the Mac's own records), and a change to a row is still seen.
    #[test]
    fn carried_memory_does_not_parse_unchanged_segment_metas() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("notes.sqlite");
        let mut first = store(&path);
        let super::super::search::Layout::Segments { flush_records, .. } = &first.settings.search;
        for n in 0..(*flush_records as usize * 2 + 5) {
            note(&mut first, &format!("a{n:05}"), "alpha");
        }
        assert!(!first.segment_metas(ACCOUNT, RESOURCE).unwrap().is_empty(), "the scope has persisted segments");
        let memory = first.take_search();
        drop(first);

        let mut carried = store(&path);
        carried.carry_search(memory);
        carried.search_load(ACCOUNT, RESOURCE).unwrap();
        let parsed = METAS_PARSED.with(|parsed| parsed.replace(0));
        assert!(parsed > 0, "the first use of memory carried from a store that flushed settles it against the file");
        carried.search_load(ACCOUNT, RESOURCE).unwrap();
        note(&mut carried, "b00000", "beta");
        let again = METAS_PARSED.with(|parsed| parsed.get());
        assert_eq!(again, 0, "unchanged meta rows were parsed {again} times");
        assert_eq!(carried.search(ACCOUNT, RESOURCE, None, "beta", 10).unwrap().records.len(), 1);
    }

    /// A shared search memory is lent to one store at a time and keeps what that store gives back.
    #[test]
    fn shared_search_memory_is_lent_to_one_store_at_a_time() {
        let shared = SharedSearchMemory::new(SearchMemory::default());
        let lent = shared.lend().expect("the memory is here");
        assert!(shared.lend().is_none(), "a second store runs without it");
        assert!(shared.committed().is_none(), "nothing to keep while it is out");
        shared.give_back(lent);
        assert!(shared.committed().is_some());
    }

    /// Segments built under another terms rule (here: only `title` searched, the way segments were built before
    /// `within` and `every_text`) are stale: a store under the current rule reads none of them and gets a new walk, so
    /// its cold start reads at most `flush_records` + 1 rows (never every row), the scope's next write drops the stale
    /// segments and is found at once, and the walk finds every row written before the rule changed by its words; after
    /// the walk a cold start reads only the unflushed tail again.
    #[test]
    fn segments_of_another_terms_rule_are_walked_again_and_miss_no_older_row() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("notes.sqlite");
        let mut before = store(&path);
        let mut old = before.settings.clone();
        let super::super::search::Layout::Segments { fields, within, every_text, .. } = &mut old.search;
        (*fields, *within, *every_text) = (vec!["title".into()], None, None);
        before.settings = Box::leak(Box::new(old));
        for n in 0..300 {
            note(&mut before, &format!("a{n:03}"), if n == 150 { "quartz beacon at the dock" } else { "alpha" });
        }
        assert!(!before.segment_metas(ACCOUNT, RESOURCE).unwrap().is_empty(), "the old rule persisted a segment");
        assert!(before.search(ACCOUNT, RESOURCE, None, "quartz", 10).unwrap().records.is_empty(), "the old rule never held `text`");
        drop(before);

        let now = store(&path);
        let super::super::search::Layout::Segments { flush_records, .. } = &now.settings.search;
        let read = rows_to_load(&now);
        assert!(read <= *flush_records as u64 + 8, "a stale scope's cold start read {read} rows, not every row");
        assert!(!now.search_ready(ACCOUNT, RESOURCE).unwrap(), "the rows from before the rule change wait for the walk");
        drop(now);

        let mut writer = store(&path);
        note(&mut writer, "b000", "beta");
        let rule = writer.settings.search.rule();
        let metas = writer.segment_metas(ACCOUNT, RESOURCE).unwrap();
        assert!(metas.iter().all(|segment| segment.rule == rule), "the write dropped every stale segment");
        assert_eq!(writer.search(ACCOUNT, RESOURCE, None, "beta", 10).unwrap().records.len(), 1, "a write during the walk is found");
        let walk_rows = writer.settings.search.walk_rows();
        while !writer.search_walk(ACCOUNT, RESOURCE, walk_rows).unwrap().done {}
        let found = writer.search(ACCOUNT, RESOURCE, None, "quartz", 10).unwrap().records;
        assert_eq!(found.iter().map(|record| record.id.as_str()).collect::<Vec<_>>(), ["a150"], "a row written before the change is found");
        drop(writer);

        let after = store(&path);
        assert!(rows_to_load(&after) < 10, "after the walk a cold start reads only the unflushed tail");
        assert!(after.search_ready(ACCOUNT, RESOURCE).unwrap());
        assert_eq!(after.search(ACCOUNT, RESOURCE, None, "quartz", 10).unwrap().records.len(), 1);
        assert_eq!(after.search(ACCOUNT, RESOURCE, None, "beta", 10).unwrap().records.len(), 1);
        assert_eq!(after.search(ACCOUNT, RESOURCE, None, "alpha", 300).unwrap().records.len(), 299);
    }

    /// A segment meta written before segments named their rule reads back with an empty rule, so it is stale.
    #[test]
    fn a_segment_meta_without_a_rule_is_stale() {
        let meta = r#"{"id":1,"level":0,"lo":0,"hi":5,"firsts":[],"covers":{}}"#;
        let segment: Segment = serde_json::from_str(meta).unwrap();
        assert!(segment.rule.is_empty());
        assert_ne!(segment.rule, settings::shipped().unwrap().search.rule());
    }

    /// A part keeps its terms and postings, in order, through the packed form; a body in the earlier JSON form is
    /// still read; a cut or unknown body is refused.
    #[test]
    fn a_part_reads_back_from_the_packed_form_and_the_earlier_json_form() {
        let post = |s: i64, k: &str| Post { s, k: k.to_owned() };
        let part: Part = vec![
            (("*".into(), "plan".into()), vec![post(9 << 40, "m-2"), post(3 << 40, "m-1")]),
            (("text".into(), "plan".into()), vec![post(9 << 40, "m-2")]),
            (("text".into(), "zürich".into()), vec![post(3 << 40, "m-1"), post(1, "m-1")]),
        ];
        let same = |a: &Part, b: &Part| serde_json::to_value(a).unwrap() == serde_json::to_value(b).unwrap();
        let packed = encode_part(&part);
        assert!(same(&decode_part(&packed).unwrap(), &part));
        assert!(packed.len() * 2 < serde_json::to_vec(&part).unwrap().len(), "the packed form is the smaller one");
        assert!(same(&decode_part(&serde_json::to_vec(&part).unwrap()).unwrap(), &part));
        assert!(decode_part(&packed[..packed.len() - 1]).is_err());
        assert!(decode_part(&[9, 0, 0]).is_err());
    }

    /// Ported from old trillion test/search-catch-up-writes-changes.test.mjs (tag old-trillion-before-worker-retire,
    /// b6ae0ebf81), deleted by Trillion-X/trillion #243: "a record written again with the same text writes no word
    /// rows; a changed text is found by its new words". The old word index (src/record-search-index.mjs) caught up from
    /// the log a wake at a time; this index is kept inside the write (this file's header), so the old catch-up calls are
    /// the writes themselves. 300 messages (past one flush), 260 written again with the same text and a field that is no
    /// text: the index's own rows (`search_segments`, `search_parts`) grow by at most the old one row per write (the old
    /// log position; here the one segment a flush of the tail persists); a message whose text changed is found by its new
    /// words and no longer by its old ones. The old "legacy hex text comparisons" and "steady writes are not a backlog"
    /// tests have no owner: no hex comparison column and no per-wake catch-up exist (record_value/search.rs: "per-wake
    /// catch-up ... dropped").
    #[test]
    fn old_search_catch_up_writes_changes_a_same_text_rewrite_writes_no_word_rows_and_a_changed_text_is_found_by_its_new_words() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store(&dir.path().canonicalize().unwrap().join("messages.sqlite"));
        let write = |store: &mut Store, id: &str, value: serde_json::Value| {
            let expected = store.held_version(ACCOUNT, RESOURCE, id).unwrap();
            let request_key = format!("w-{id}-{expected}");
            store.mutate(ACCOUNT, RESOURCE, Mutation { id: id.to_owned(), expected_version: expected, request_key, deleted: false, value }).unwrap();
        };
        for n in 0..300 {
            write(&mut store, &format!("m{n}"), serde_json::json!({ "text": format!("hello world {n}") }));
        }
        let index_rows = |store: &Store| -> u64 {
            ["search_segments", "search_parts"].iter().map(|family| store.storage().count(family, &crate::storage::Range::all()).unwrap()).sum()
        };
        let before = index_rows(&store);
        assert!(before > 0, "the first writes were persisted");
        const AGAIN: u64 = 260;
        for n in 0..AGAIN {
            write(&mut store, &format!("m{n}"), serde_json::json!({ "text": format!("hello world {n}"), "reworded": true }));
        }
        let written = index_rows(&store) - before;
        assert!(written <= AGAIN,
            "a record written again with the same text writes at most the old one row per write: {written} index rows for {AGAIN} writes");
        write(&mut store, "m3", serde_json::json!({ "text": "something brand new" }));
        let found = |word: &str| -> Vec<String> {
            store.search(ACCOUNT, RESOURCE, None, word, 100).unwrap().records.into_iter().map(|record| record.id).collect()
        };
        assert_eq!(found("brand"), ["m3"]);
        assert!(!found("hello").contains(&"m3".to_owned()), "its old words no longer find it");
    }
}

/// What the merge tests need of a store: a scope seeded with segments of chosen levels, the way a store of the engine
/// before idle merges was left (the person's Mac, 2026-11-05: tiers of 3+3+3 and an unflushed tail just under a flush).
#[cfg(test)]
impl<S: Storage> RecordStore<S> {
    /// Persist one segment of `level` over (lo, hi] holding `postings` and covering `covers`, and a ready walk, in one
    /// write; forgets the scope's memory so the next use loads it from the file.
    fn seed_segment(&mut self, account: &str, resource: &str, level: u32, (lo, hi): (i64, i64), postings: BTreeMap<Term, Vec<Post>>,
        covers: BTreeMap<String, i64>) -> Result<(), Error> {
        self.write(account, resource, |store| {
            let next = store.segment_metas(account, resource).map_err(super::uncertain)?.iter().map(|segment| segment.id + 1).max().unwrap_or(1);
            store.write_segment(account, resource, (next, level, None), (lo, hi), postings, covers).map_err(super::uncertain)?;
            let walk = Walk { rule: store.settings.search.rule(), from: 0, after: None, ready: true, saved: true };
            store.put_walk(account, resource, &walk).map_err(super::uncertain)?;
            Ok(Written::Commit((), None))
        })?;
        self.search.get_mut().clear();
        Ok(())
    }

    /// The scope's persisted segments (merges being built included) as (level, building) pairs, in recency order.
    fn seeded_levels(&self, account: &str, resource: &str) -> Vec<(u32, bool)> {
        self.segment_metas(account, resource).unwrap().iter().map(|segment| (segment.level, segment.building.is_some())).collect()
    }

    /// The scope's current stamp of `id`.
    fn current_stamp(&self, account: &str, resource: &str, id: &str) -> i64 {
        self.currents(account, resource, &[id]).unwrap().pop().flatten().unwrap().valid_from
    }
}

#[cfg(test)]
mod merge_tests {
    use super::carry_tests::{store_with, Store};
    use super::*;
    use crate::records::{Mutation, Records};
    use std::path::Path;

    const ACCOUNT: &str = "account";
    const RESOURCE: &str = "notes";
    /// Records written for real, then put in the seeded segments at their own stamps: the answers every check compares.
    const REAL: usize = 36;

    fn store(path: &Path) -> Store {
        store_with(path, 64 << 20)
    }
    fn put(store: &mut Store, id: &str, text: &str) {
        let expected_version = store.held_version(ACCOUNT, RESOURCE, id).unwrap();
        let write = Mutation { id: id.to_owned(), expected_version, request_key: format!("w-{id}-{expected_version}"), deleted: false,
            value: serde_json::json!({ "text": text }) };
        store.mutate(ACCOUNT, RESOURCE, write).unwrap();
    }
    fn found(store: &Store, word: &str) -> Vec<String> {
        let mut ids: Vec<String> = store.search(ACCOUNT, RESOURCE, None, word, 100).unwrap().records.into_iter().map(|record| record.id).collect();
        ids.sort();
        ids
    }
    fn term(word: &str) -> Term {
        ("text".to_owned(), word.to_owned())
    }

    /// The store as the person's Mac had it at engine fc7319f1 (2026-11-05 9:31 PM MST): segment tiers of 3+3+3 (levels 2, 1
    /// and 0, oldest first) holding about 260 MB of parts, and 255 changes waiting in the tail, so the next write flushes
    /// and, before this change, cascaded into a merge of every segment inside that write. Each real record `real{n}` is in
    /// segment n % 9 under `needle{n}` and `common`; `real0` also has an older posting under `stale` in segment 0, at a
    /// stamp that is no longer its current one. The filler terms belong to ids with no current row (never an answer).
    fn seeded(path: &Path) -> (Store, usize) {
        let mut store = store(path);
        for n in 0..REAL {
            put(&mut store, &format!("real{n}"), &format!("common needle{n}"));
        }
        let stamps: Vec<i64> = (0..REAL).map(|n| store.current_stamp(ACCOUNT, RESOURCE, &format!("real{n}"))).collect();
        let newest = *stamps.iter().max().unwrap();
        // Bytes of filler terms per segment, oldest first: 3 of 75 MB, 3 of 9 MB, 3 of 2 MB.
        let sizes = [75_000_000usize, 75_000_000, 75_000_000, 9_000_000, 9_000_000, 9_000_000, 2_000_000, 2_000_000, 2_000_000];
        let levels = [2u32, 2, 2, 1, 1, 1, 0, 0, 0];
        let pad = "x".repeat(1000);
        for (at, (size, level)) in sizes.iter().zip(levels).enumerate() {
            let (lo, hi) = if at == 0 { (0, newest / 9) } else { (newest / 9 * at as i64, if at == 8 { newest } else { newest / 9 * (at as i64 + 1) }) };
            let mut postings: BTreeMap<Term, Vec<Post>> = BTreeMap::new();
            let mut covers = BTreeMap::new();
            for n in (0..*size / 1024).map(|n| n as i64) {
                let ghost = format!("ghost{at}-{n}");
                postings.insert(term(&format!("fill{at}w{n:07}{pad}")), vec![Post { s: lo + 1, k: ghost.clone() }]);
                covers.insert(ghost, lo + 1);
            }
            for n in (at..REAL).step_by(9) {
                let id = format!("real{n}");
                for word in [format!("needle{n}"), "common".to_owned()] {
                    postings.entry(term(&word)).or_default().push(Post { s: stamps[n], k: id.clone() });
                }
                covers.insert(id, stamps[n]);
            }
            if at == 0 {
                postings.insert(term("stale"), vec![Post { s: 1, k: "real0".to_owned() }]);
            }
            for posts in postings.values_mut() {
                posts.sort_by(|a, b| b.s.cmp(&a.s));
            }
            store.seed_segment(ACCOUNT, RESOURCE, level, (lo, hi), postings, covers).unwrap();
        }
        assert_eq!(store.seeded_levels(ACCOUNT, RESOURCE).iter().map(|(level, _)| *level).collect::<Vec<_>>(), levels);
        let parts = store.storage().count(PARTS, &crate::storage::Range::all()).unwrap() as usize;
        // 255 changes wait in the tail: the next write is the one that flushes.
        let super::super::search::Layout::Segments { flush_records, .. } = &store.settings.search;
        for n in 0..flush_records - 1 {
            put(&mut store, &format!("tail{n}"), &format!("pending tailword{n}"));
        }
        assert_eq!(store.search_tail_len(ACCOUNT, RESOURCE), flush_records - 1, "the seeded writes did not flush");
        drop(store);
        (self::store(path), parts)
    }

    fn answers_hold(store: &Store, when: &str) {
        let real: Vec<String> = {
            let mut ids: Vec<String> = (0..REAL).map(|n| format!("real{n}")).collect();
            ids.sort();
            ids
        };
        assert_eq!(found(store, "common"), real, "{when}: every real record by its shared word");
        for n in [0, 4, 8, 17, REAL - 1] {
            assert_eq!(found(store, &format!("needle{n}")), vec![format!("real{n}")], "{when}: needle{n}");
        }
        assert!(found(store, "stale").is_empty(), "{when}: an older posting never answers");
        assert_eq!(found(store, "tailword7"), vec!["tail7".to_owned()], "{when}: a tail change");
        assert_eq!(found(store, "fresh"), vec!["fresh".to_owned()], "{when}: the write that flushed");
    }

    /// Seeded 3+3+3 tiers (about 260 MB of parts) with 255 changes waiting: after a restart the next write flushes and
    /// commits by appending its one segment and merging none, so no wall-clock bound is needed; idle merge steps then work the
    /// backlog down to one segment, each step reading about `merge_bytes` (4 MiB) of parts and committed alone, while every
    /// search answers the same before, during and after, and from a cold start.
    #[test]
    fn a_store_left_with_full_tiers_writes_at_once_and_idle_steps_drain_the_merge() {
        crate::test_bound::within("a_store_left_with_full_tiers_writes_at_once_and_idle_steps_drain_the_merge", std::time::Duration::from_secs(240), a_store_left_with_full_tiers_writes_at_once_and_idle_steps_drain_the_merge_body);
    }

    fn a_store_left_with_full_tiers_writes_at_once_and_idle_steps_drain_the_merge_body() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("notes.sqlite");
        let (mut store, parts) = seeded(&path);
        let bytes = std::fs::metadata(&path).unwrap().len();
        let segments_before = store.seeded_levels(ACCOUNT, RESOURCE).len();

        put(&mut store, "fresh", "fresh write");
        crate::quiet_println!("seeded store: {parts} parts in {segments_before} segments, file {bytes} bytes");
        let levels = store.seeded_levels(ACCOUNT, RESOURCE);
        assert_eq!(levels.len(), segments_before + 1, "the write appended one segment and merged none");
        assert!(levels.iter().all(|(_, building)| !building));
        answers_hold(&store, "before any merge");

        let merge_bytes = store.settings.search.merge_bytes();
        let (mut steps, mut read, mut most) = (0usize, 0usize, 0usize);
        loop {
            let merged = store.search_merge(ACCOUNT, RESOURCE, merge_bytes).unwrap();
            steps += 1;
            read += merged.bytes;
            most = most.max(merged.bytes);
            if steps % 25 == 0 {
                answers_hold(&store, &format!("after merge step {steps}"));
                // A write between steps commits at once and leaves the merge being built where it was.
                put(&mut store, &format!("between{steps}"), "between steps");
            }
            if steps == 40 {
                // A restart in the middle: the merge being built is taken up where its last step left it.
                drop(store);
                store = self::store(&path);
                assert!(store.seeded_levels(ACCOUNT, RESOURCE).iter().any(|(_, building)| *building), "a merge is being built");
                answers_hold(&store, "after a restart mid-merge");
            }
            if merged.done {
                break;
            }
            assert!(steps < 1000, "the merges never ended");
        }
        crate::quiet_println!("drained in {steps} merge steps, {read} bytes read, at most {most} in one step");
        assert!(most <= merge_bytes + (1 << 20), "a step read {most} bytes");
        assert!(steps > 60, "the 260 MB merge ran as many bounded steps, not one: {steps}");
        let levels = store.seeded_levels(ACCOUNT, RESOURCE);
        let fan_in = match &store.settings.search { super::super::search::Layout::Segments { fan_in, .. } => *fan_in };
        assert!(levels.iter().all(|(_, building)| !building), "no merge is left half built");
        assert!(!levels.windows(fan_in).any(|run| run.iter().all(|(level, _)| *level == run[0].0)), "no merge is owed: {levels:?}");
        assert_eq!(store.search_merge(ACCOUNT, RESOURCE, merge_bytes).unwrap(), Merged { bytes: 0, done: true });
        answers_hold(&store, "after the merges");
        assert_eq!(found(&store, "between").len(), steps / 25, "the writes between steps");
        drop(store);
        let store = self::store(&path);
        answers_hold(&store, "after the merges, from a cold start");
        // The merged segments hold every filler posting once: the parts of the inputs are gone.
        let left = store.storage().count(PARTS, &crate::storage::Range::all()).unwrap() as usize;
        assert!(left <= parts + 64, "{left} parts left of {parts}");
    }

    /// An erasure of a record a merge being built has already copied drops that merge, so no posting of the record is
    /// left in any part; the next steps build the merge again from the rewritten segments.
    #[test]
    fn an_erasure_during_a_merge_leaves_no_posting_of_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("notes.sqlite");
        let mut store = store(&path);
        for n in 0..4 * 256 {
            let own: Vec<String> = (0..60).map(|k| format!("u{n}x{k}")).collect();
            put(&mut store, &format!("m{n:04}"), &format!("alpha w{n} {}", own.join(" ")));
        }
        assert_eq!(store.seeded_levels(ACCOUNT, RESOURCE).len(), 4, "four flushes, no merge in the writes");
        // A step small enough that the merge takes several.
        let merged = store.search_merge(ACCOUNT, RESOURCE, 1).unwrap();
        assert!(!merged.done && merged.bytes > 0);
        assert!(store.seeded_levels(ACCOUNT, RESOURCE).iter().any(|(_, building)| *building));
        // `alpha` is the first term, so the record's postings are in the parts already written.
        store.erase(ACCOUNT, RESOURCE, "m0003").unwrap().unwrap();
        let mentions = |store: &Store| -> bool {
            store.storage().scan(PARTS, &crate::storage::Range::all(), &[Field::whole("body")]).unwrap().into_iter().any(|mut row| match row.take(0) {
                Value::Blob(body) => decode_part(&body).unwrap().iter().flat_map(|(_, posts)| posts).any(|post| post.k == "m0003"),
                _ => false,
            })
        };
        assert!(!mentions(&store), "no part holds the erased record");
        while !store.search_merge(ACCOUNT, RESOURCE, 1).unwrap().done {}
        assert_eq!(store.seeded_levels(ACCOUNT, RESOURCE), vec![(1, false)]);
        assert!(!mentions(&store));
        assert_eq!(found(&store, "w3"), Vec::<String>::new());
        assert_eq!(found(&store, "w4"), vec!["m0004".to_owned()]);
        assert_eq!(store.search(ACCOUNT, RESOURCE, None, "alpha", 100).unwrap().records.len(), 100);
    }
}
