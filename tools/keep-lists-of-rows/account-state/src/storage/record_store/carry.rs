// src/storage/record_store/carry.rs
//
// FILLING ONE SETTLE STORE FROM ANOTHER IN BOUNDED PAGES, EACH READ BACK, AND THE WHOLE COUNTED AND COMPARED BEFORE THE
// SOURCE MAY RETIRE.
//
// Purpose
//   The filling step of old trillion `src/resource-state-carry.mjs` (Trillion-X/trillion origin/main), ported over
//   record sync's store (`record_sync::SettleStore`): a store that starts empty at a new computer or file is filled from
//   the store it replaces before the source stops replying. Old trillion carried SQL tables of one host; what is
//   ported here is its contract, over records:
//   - pages of at most `page_bytes` (old SOURCE_PAGE_BYTES, 1 MiB) and `page_rows` (old PAGE_ROWS_MOST, 1,000); a
//     destination takes a page up to `accept_bytes` (old KEYSET_PAGE_BYTES, 4 MiB); one record past a page travels as
//     a page of its own up to `row_bytes` (old ROW_BYTES, 16 MiB), and past that the carry refuses (413);
//   - the source is read first: its count of kept states and its identity (its root) are read before the first page;
//   - each page is taken exactly (`take_records`, stamps and removals included) and read back at the destination
//     before the next: a record that does not read back as it was sent refuses the carry (409);
//   - before the source may retire, the destination's count and identity are read back and compared with the first
//     source's, and the source's are read again: a source that moved during the carry refuses it (409), and the carry
//     is simply run again (taking a page twice changes nothing).
//
//   The record store itself is a carry source (`Versions`): its current rows, each as the settle state its write gave
//   it (`mod.rs` `mirror_settle`: the whole value or a removal at `mirror_stamp` of the row's stamp). `RecordStore::
//   fill_settle` carries a scope's records into its settle store once, when that store was written before every write
//   kept its settle state (a store file older than the mirror, or one carried in from elsewhere).
//
// Non-Negotiable Invariants
//   1. `Carried::may_retire` is true only when the destination holds exactly the source as first read: the same count of kept
//      states and the same root, with the source unchanged since it was first read.
//   2. Nothing here retires anything: the caller retires the source only on `may_retire`.
//   3. Every page is bounded; no side ever holds the whole store.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::digest::{json_text, BUCKETS};
use super::record_sync::{Actor, BucketRecord, SettleStore, SyncError};
use super::stamps::same_kept;
use serde_json::Value;

/// The bounds of one carry (old trillion's constants).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CarryBounds {
    pub page_bytes: usize,
    pub page_rows: usize,
    pub accept_bytes: usize,
    pub row_bytes: usize,
}
impl Default for CarryBounds {
    fn default() -> Self {
        Self { page_bytes: 1024 * 1024, page_rows: 1000, accept_bytes: 4 * 1024 * 1024, row_bytes: 16 * 1024 * 1024 }
    }
}

/// What a carry did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Carried {
    pub pages: usize,
    pub records: usize,
    pub bytes: usize,
    /// The source's first count of kept states and root.
    pub source_count: usize,
    pub source_root: String,
    /// What the destination read back at the end.
    pub destination_count: usize,
    pub destination_root: String,
    /// The destination holds exactly the source as first read, which did not move: the source may retire.
    pub may_retire: bool,
}

fn every_bucket() -> Vec<usize> {
    (0..BUCKETS).collect()
}

fn value_bytes(record: &BucketRecord) -> usize {
    record.value.as_ref().map_or(0, |value| json_text(&Value::Object(value.clone())).len())
}

/// Every kept state of a store, counted a bounded page at a time.
pub fn count(store: &dyn SettleStore, bounds: CarryBounds) -> Result<usize, SyncError> {
    let all = every_bucket();
    let mut counted = 0;
    let mut after: Option<String> = None;
    loop {
        let (records, next) = store.records_in_buckets_page(&all, after.as_deref(), bounds.page_rows, bounds.page_bytes)?;
        counted += records.len();
        match next {
            None => return Ok(counted),
            Some(cursor) => after = Some(cursor),
        }
    }
}

/// Fills `destination` from `source` (see the file's purpose).
pub fn carry(source: &dyn SettleStore, destination: &mut dyn SettleStore, bounds: CarryBounds) -> Result<Carried, SyncError> {
    let start_root = source.checksum()?.root;
    let start_count = count(source, bounds)?;
    let all = every_bucket();
    let mut report = Carried { source_count: start_count, source_root: start_root.clone(), ..Carried::default() };
    let mut after: Option<String> = None;
    loop {
        let (page, next) = source.records_in_buckets_page(&all, after.as_deref(), bounds.page_rows, bounds.page_bytes)?;
        let bytes: usize = page.iter().map(value_bytes).sum();
        if let Some(record) = page.iter().find(|record| value_bytes(record) > bounds.row_bytes) {
            return Err(SyncError::new(413, format!("Record {} exceeds the {}-byte carry row bound.", record.id, bounds.row_bytes), crate::cause!()));
        }
        if page.len() > 1 && bytes > bounds.accept_bytes {
            return Err(SyncError::new(413, format!("A carry page of {bytes} bytes exceeds the {}-byte page a destination takes.", bounds.accept_bytes), crate::cause!()));
        }
        if !page.is_empty() {
            destination.take_records(&page, Actor::by("carry"))?;
            // Read back: every record of the page is at the destination exactly as it was sent.
            let ids: std::collections::HashSet<&str> = page.iter().map(|record| record.id.as_str()).collect();
            let buckets: Vec<usize> = {
                let mut buckets: Vec<usize> = page.iter().map(|record| super::digest::bucket_of(&record.id)).collect();
                buckets.sort_unstable();
                buckets.dedup();
                buckets
            };
            let held: std::collections::HashMap<String, BucketRecord> =
                destination.records_in_buckets(&buckets)?.into_iter().filter(|record| ids.contains(record.id.as_str())).map(|record| (record.id.clone(), record)).collect();
            for record in &page {
                let back = held.get(&record.id).map(BucketRecord::stamped);
                if !same_kept(back.as_ref(), Some(&record.stamped())) {
                    return Err(SyncError::new(409, format!("Record {} did not read back at the destination as it was carried.", record.id), crate::cause!()));
                }
            }
            report.pages += 1;
            report.records += page.len();
            report.bytes += bytes;
        }
        match next {
            None => break,
            Some(cursor) => after = Some(cursor),
        }
    }
    report.destination_count = count(&*destination, bounds)?;
    report.destination_root = destination.checksum()?.root;
    let source_now = (source.checksum()?.root, count(source, bounds)?);
    if source_now != (start_root.clone(), start_count) {
        return Err(SyncError::new(409, "The source moved while it was carried: carry it again.", crate::cause!()));
    }
    if report.destination_count != start_count || report.destination_root != start_root {
        return Err(SyncError::new(409, "The destination's counts or identity differ from the source as first read.", crate::cause!()));
    }
    report.may_retire = true;
    Ok(report)
}

/// The record store's current rows of one scope as a carry source (read only): each record as the settle state its
/// write gave it (`record_log.rs` `mirror`: the whole value at `mirror_stamp` of the row's stamp, or a removal), so a
/// settle store carried from it holds exactly what it would hold had every write been mirrored. Its pages walk the
/// scope's current rows by stamp (`changes_page_readonly`, the `changed` order); the cursor is the last stamp looked at.
/// It keeps no log and takes nothing (405).
pub struct Versions<'a, S: crate::storage::Storage> {
    pub store: &'a super::RecordStore<S>,
    pub account: &'a str,
    pub resource: &'a str,
}

#[track_caller]
fn refused() -> SyncError {
    SyncError::new(405, "The record store's rows are a carry source: they take nothing from a settle.", crate::cause!(caller_site: refusal))
}

impl<S: crate::storage::Storage> Versions<'_, S> {
    fn record_of(&self, change: crate::records::Change) -> BucketRecord {
        let at = super::record_log::mirror_stamp(change.sequence);
        match change.value.filter(|_| !change.deleted) {
            Some(value) => BucketRecord {
                id: change.id,
                kind: Some(self.store.kind_of(&value).unwrap_or_default()),
                value: Some(super::settle_fields(value)),
                meta: Some(super::stamps::Meta { at, ..super::stamps::Meta::default() }),
            },
            None => BucketRecord { id: change.id, kind: None, value: None, meta: Some(super::stamps::Meta { at, k: Some("removed".into()), ..super::stamps::Meta::default() }) },
        }
    }

    /// One page of the scope's current rows after stamp `after`: the records in `buckets` and the next cursor.
    fn page(&self, buckets: &[usize], after: Option<&str>, limit: usize, bytes: usize) -> Result<(Vec<BucketRecord>, Option<String>), SyncError> {
        let wanted: std::collections::HashSet<usize> = buckets.iter().copied().collect();
        let mut cursor: i64 = match after {
            Some(after) => after.parse().map_err(|_| SyncError::new(400, "A carry cursor is a stamp.", crate::cause!()))?,
            None => 0,
        };
        let mut records = Vec::new();
        let mut size = 0usize;
        loop {
            let asked = limit.clamp(1, crate::records::MAX_PAGE_ITEMS);
            let page = self.store.changes_page_readonly(self.account, self.resource, cursor, asked).map_err(|error| SyncError::storage(error.cause()))?;
            let done = page.next.is_none();
            for change in page.items {
                cursor = change.sequence;
                if !wanted.contains(&super::digest::bucket_of(&change.id)) {
                    continue;
                }
                let record = self.record_of(change);
                size += value_bytes(&record);
                records.push(record);
                if records.len() >= limit || size >= bytes {
                    return Ok((records, Some(cursor.to_string())));
                }
            }
            if done {
                return Ok((records, None));
            }
        }
    }
}

impl<S: crate::storage::Storage> SettleStore for Versions<'_, S> {
    fn log_after(&self, position: Option<&str>, _limit: usize) -> Result<super::record_sync::LogPage, SyncError> {
        Ok(super::record_sync::LogPage { rows: Vec::new(), oldest: None, last: position.map(str::to_string), more: false })
    }
    fn last_log_id(&self) -> Result<Option<String>, SyncError> {
        Ok(None)
    }
    fn checksum(&self) -> Result<super::record_sync::Checksum, SyncError> {
        let mut sums = super::digest::Sums::new();
        let all = every_bucket();
        let mut after: Option<String> = None;
        loop {
            let (records, next) = self.page(&all, after.as_deref(), crate::records::MAX_PAGE_ITEMS, usize::MAX)?;
            for record in &records {
                if let (Some(kind), Some(value)) = (&record.kind, &record.value) {
                    sums.add(&record.id, kind, value);
                }
                sums.stamps(&record.id, None, record.meta.as_ref().map(super::stamps::Meta::text).as_deref());
            }
            match next {
                None => return Ok(super::record_sync::Checksum { root: sums.root(), buckets: sums.text() }),
                Some(cursor) => after = Some(cursor),
            }
        }
    }
    fn apply_changes(&mut self, _rows: &[super::record_sync::ChangeRow], _actor: Actor, _keep_apart: Option<&str>) -> Result<super::record_sync::Applied, SyncError> {
        Err(refused())
    }
    fn take_records(&mut self, _records: &[BucketRecord], _actor: Actor) -> Result<usize, SyncError> {
        Err(refused())
    }
    fn records_in_buckets(&self, buckets: &[usize]) -> Result<Vec<BucketRecord>, SyncError> {
        let mut records = Vec::new();
        let mut after: Option<String> = None;
        loop {
            let (page, next) = self.page(buckets, after.as_deref(), crate::records::MAX_PAGE_ITEMS, usize::MAX)?;
            records.extend(page);
            match next {
                None => return Ok(records),
                Some(cursor) => after = Some(cursor),
            }
        }
    }
    fn records_in_buckets_page(&self, buckets: &[usize], after: Option<&str>, limit: usize, bytes: usize) -> Result<(Vec<BucketRecord>, Option<String>), SyncError> {
        self.page(buckets, after, limit, bytes)
    }
    fn position(&self, _copy: &str) -> Result<Option<String>, SyncError> {
        Ok(None)
    }
    fn move_position(&mut self, _copy: &str, _took_through: Option<&str>, _at: &str) -> Result<bool, SyncError> {
        Err(refused())
    }
    fn forget_position(&mut self, _copy: &str) -> Result<bool, SyncError> {
        Err(refused())
    }
}

// ---- the table copy (old trillion `resourceStateSource` / `resourceStateDestination`) over the storage boundary ----
//
// Old trillion carried an object's SQL tables to a new object in bounded keyset pages (src/resource-state-carry.mjs
// `keysetRows`, `readBackRows`, `bindSourceManifest`): each table's rows in key order after the last key carried, at
// most PAGE_ROWS_MOST rows and SOURCE_PAGE_BYTES a page (one row larger than a page as a page of its own, up to
// ROW_BYTES), each page written and read back at the destination before the next, and the source's per-table counts and
// identity read first and compared with the destination's at the end, with the source unchanged since (a frozen source).
// Here a store's tables are families of the storage boundary (`crate::storage::Storage`), so the same code carries a
// store on the memory supply, a SQLite file or a host's lent store. `carry_scope` carries the rows of one key prefix
// (one account's resource: every family whose key starts with it), the unit a store's file holds for a resource.

use crate::storage::{Bound, Intent, Order, Range, Read, Row, Storage, Value as Stored, When};

/// What a table copy did, per family: the rows it carried and their identity.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScopeCarried {
    /// (family, rows carried) in the order carried.
    pub families: Vec<(String, usize)>,
    pub pages: usize,
    pub bytes: usize,
    /// Every family's count and identity at the destination equal the source's as first read, and the source did not
    /// move since: the source's rows of the scope may retire (the caller retires them; nothing here does).
    pub may_retire: bool,
}

// The bytes one stored value takes on the way (old trillion measured a page by its rows' JSON).
fn stored_bytes(value: &Stored) -> usize {
    match value {
        Stored::Null => 4,
        Stored::Integer(_) | Stored::Real(_) => 8,
        Stored::Text(text) => text.len(),
        Stored::Blob(bytes) => bytes.len(),
        Stored::Oversized(bytes) => usize::try_from(*bytes).unwrap_or(usize::MAX),
    }
}

// One canonical encoding of a row, for its identity: a tag and a length before each value.
fn row_bytes_into(row: &Row, into: &mut Vec<u8>) {
    for value in &row.0 {
        let (tag, bytes): (u8, Vec<u8>) = match value {
            Stored::Null => (0, Vec::new()),
            Stored::Integer(number) => (1, number.to_be_bytes().to_vec()),
            Stored::Real(number) => (2, number.to_bits().to_be_bytes().to_vec()),
            Stored::Text(text) => (3, text.as_bytes().to_vec()),
            Stored::Blob(bytes) => (4, bytes.clone()),
            Stored::Oversized(length) => (5, length.to_be_bytes().to_vec()),
        };
        into.push(tag);
        into.extend((bytes.len() as u64).to_be_bytes());
        into.extend(bytes);
    }
}

fn storage_error(error: crate::storage::Error) -> SyncError {
    SyncError::storage(error.cause())
}

// The count and identity of a family's rows under `prefix`, read in bounded pages in key order.
fn family_identity(store: &dyn Storage, family: &str, prefix: &[Stored], reads: &[Read<'_>], key_at: &[usize], bounds: CarryBounds) -> Result<(usize, [u8; 32]), SyncError> {
    let mut hasher = content_crypto::advanced::blake3::Hasher::new();
    let mut count = 0usize;
    let mut after: Option<Vec<Stored>> = None;
    loop {
        let from = after.clone().map_or_else(|| Bound::Included(prefix.to_vec()), Bound::Excluded);
        let range = Range { order: Order::Key, from, to: Bound::Included(prefix.to_vec()), reverse: false, limit: Some(bounds.page_rows) };
        let rows = store.scan(family, &range, reads).map_err(storage_error)?;
        let full = rows.len() >= bounds.page_rows;
        for row in &rows {
            let mut bytes = Vec::new();
            row_bytes_into(row, &mut bytes);
            hasher.update(&bytes);
            count += 1;
        }
        match rows.last() {
            Some(last) if full => after = Some(key_at.iter().map(|at| last.0[*at].clone()).collect()),
            _ => return Ok((count, *hasher.finalize().as_bytes())),
        }
    }
}

/// Carries every row under key `prefix` of each of `families` from `source` to `destination` (see above): pages in key
/// order of at most `page_rows` rows and about `page_bytes` bytes (one row past it alone, up to `row_bytes`; past that
/// the carry refuses, 413), each written in one scope and read back before the next (a row that does not read back as
/// it was carried refuses, 409); at the end every family's count and identity at the destination must equal the
/// source's as first read, and the source must still hold them (one that moved refuses, 409: carry it again, which
/// takes nothing twice). A family `source` does not declare is refused (400).
pub fn carry_scope(source: &dyn Storage, destination: &dyn Storage, prefix: &[Stored], families: &[&str], bounds: CarryBounds) -> Result<ScopeCarried, SyncError> {
    let schema = source.schema();
    let mut report = ScopeCarried::default();
    let mut firsts = Vec::new();
    let mut shapes = Vec::new();
    for family in families {
        let declared = schema.family(family).map_err(|error| SyncError::new(400, format!("The store declares no family {family}."), error.cause()))?;
        if declared.key.len() < prefix.len() {
            return Err(SyncError::new(400, format!("The family {family} is not keyed by the carried scope."), crate::cause!()));
        }
        let names: Vec<&str> = declared.fields.iter().map(String::as_str).collect();
        let key_at: Vec<usize> = declared.key.iter().map(|key| names.iter().position(|name| name == key).unwrap_or(0)).collect();
        shapes.push((*family, names, key_at));
    }
    for (family, names, key_at) in &shapes {
        let reads: Vec<Read<'_>> = names.iter().map(|name| Read::whole(name)).collect();
        firsts.push(family_identity(source, family, prefix, &reads, key_at, bounds)?);
    }
    for (family, names, key_at) in &shapes {
        let reads: Vec<Read<'_>> = names.iter().map(|name| Read::whole(name)).collect();
        let mut carried = 0usize;
        let mut after: Option<Vec<Stored>> = None;
        loop {
            let from = after.clone().map_or_else(|| Bound::Included(prefix.to_vec()), Bound::Excluded);
            let range = Range { order: Order::Key, from, to: Bound::Included(prefix.to_vec()), reverse: false, limit: Some(bounds.page_rows) };
            let rows = source.scan(family, &range, &reads).map_err(storage_error)?;
            let full = rows.len() >= bounds.page_rows;
            // Cut the page to its bytes: a row past `page_bytes` goes alone, up to `row_bytes`.
            let mut page: Vec<&Row> = Vec::new();
            let mut bytes = 0usize;
            for row in &rows {
                let own: usize = row.0.iter().map(stored_bytes).sum();
                if row.0.iter().any(|value| matches!(value, Stored::Oversized(_))) || own > bounds.row_bytes {
                    return Err(SyncError::new(413, format!("A row of {family} exceeds the {}-byte carry row bound.", bounds.row_bytes), crate::cause!()));
                }
                if !page.is_empty() && bytes + own > bounds.page_bytes {
                    break;
                }
                bytes += own;
                page.push(row);
            }
            if page.is_empty() {
                break;
            }
            let scope = crate::storage::Scope::begin(destination, if destination.scoped() { Intent::Nested } else { Intent::Write }).map_err(storage_error)?;
            for row in &page {
                let fields: Vec<(&str, Stored)> = names.iter().copied().zip(row.0.iter().cloned()).collect();
                destination.put(family, &fields, When::Always).map_err(storage_error)?;
            }
            scope.commit().map_err(storage_error)?;
            // Read back: every row of the page is at the destination exactly as it was carried.
            for row in &page {
                let key: Vec<Stored> = key_at.iter().map(|at| row.0[*at].clone()).collect();
                let back = destination.get(family, &key, &reads).map_err(storage_error)?;
                if back.as_ref() != Some(*row) {
                    return Err(SyncError::new(409, format!("A row of {family} did not read back at the destination as it was carried."), crate::cause!()));
                }
            }
            carried += page.len();
            report.pages += 1;
            report.bytes += bytes;
            let last = page[page.len() - 1];
            if !full && page.len() == rows.len() {
                break;
            }
            after = Some(key_at.iter().map(|at| last.0[*at].clone()).collect());
        }
        report.families.push((family.to_string(), carried));
    }
    for ((family, names, key_at), first) in shapes.iter().zip(&firsts) {
        let reads: Vec<Read<'_>> = names.iter().map(|name| Read::whole(name)).collect();
        if family_identity(source, family, prefix, &reads, key_at, bounds)? != *first {
            return Err(SyncError::new(409, "The source moved while it was carried: carry it again.", crate::cause!()));
        }
        if family_identity(destination, family, prefix, &reads, key_at, bounds)? != *first {
            return Err(SyncError::new(409, format!("The destination's count or identity of {family} differs from the source as first read."), crate::cause!()));
        }
    }
    report.may_retire = true;
    Ok(report)
}
