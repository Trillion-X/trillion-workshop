// src/storage/record_store/migrate.rs
//
// Purpose: The one-way migration from the old store to the record store, with its proof. The bulk of the records comes
// from the old store's checkpoint (the kept runs), read one bounded range page at a time; the records the journal
// changed after that checkpoint are then replayed once through the canonical reader and written as their next record store
// version, so the record store history holds the checkpoint state too. The proof reads every record back from record store and compares
// it with what the old store answers, record by record (BLAKE3 digest per stored form).
//
// Non-Negotiable Invariants:
// - The old store is reached only through `Source` (its checkpoint pages, its journal-tail ids, its canonical reader).
//   The one implementation, over the old store's public readers (`LegacyKept::range`/`point`,
//   `LegacyRecords::read_stored`, `CanonicalHead::affected_ids`), lives in the one-time tool `examples/record_store_migrate.rs`,
//   so this file, like every record store file, holds no SQL (`tests/record_store_storage_free.rs`). Writes go through `RecordStore::import` and
//   `RecordStore::mutate_local_with_check` (the same write as `Records::mutate`, also on a lent, non-`Send` supply) only.
// - The proof compares what the old store returned with what record store returns, never record store with itself.
// - The checkpoint decode is itself checked: sampled ids the journal did not change are read again through the
//   canonical reader and must match their checkpoint form.
// - Never pointed at live data: the caller opens a pinned readonly clone.
//
// Key Concepts:
// - Record digest: BLAKE3 over length-prefixed id, type, sequence, value JSON text, meta JSON text and the protected
//   flag. Each side digest hashes its record digests in id order.
// - The checkpoint stamp: the record store stamp just before the first replayed change. An as-of read at that stamp answers the
//   old store's checkpoint state; a current read answers the canonical reader's state.
// - Page cost: the old store's statements, rows and bytes for one checkpoint page, and the record store seeks and rows read
//   while that page was written.
//
// Security Considerations:
// - The report holds counts, digests and timings only; no id, value or key leaves it.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{
    native::{body, stored_form, CurrentRecords, RecordStoreCurrent},
    Work,
};
use content_crypto::advanced::blake3;
use crate::{
    legacy_records::StoredRecord,
    records::{Error, Mutation, MAX_PAGE_ITEMS},
    storage::Storage,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Instant,
};

/// What reading one checkpoint page cost the old store.
#[derive(Clone, Copy, Debug, Default)]
pub struct PageWork {
    pub statements: u64,
    pub rows: u64,
    pub bytes: u64,
}

/// One checkpoint page: its records in id order, its cost, and whether more pages follow.
pub struct Page {
    pub records: Vec<StoredRecord>,
    pub work: PageWork,
    pub more: bool,
}

/// The old store as the migration reads it.
pub trait Source {
    /// The ids the journal changed after the checkpoint covers them (their checkpoint form may be stale), and how many
    /// journal rows named them.
    fn tail(&mut self) -> Result<(BTreeSet<String>, u64), Error>;
    /// The next page of at most `limit` checkpoint records. A refused page leaves the position where it was, so the
    /// caller may ask again with a smaller `limit`.
    fn checkpoint_page(&mut self, limit: usize) -> Result<Page, Error>;
    /// The canonical reader's answer for one id (journal tail included).
    fn canonical(&mut self, id: &str) -> Result<Option<StoredRecord>, Error>;
}

/// The digest of one stored form.
pub fn digest(record: &StoredRecord) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    let mut field = |bytes: &[u8]| {
        hasher.update(&(bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    };
    field(record.id.as_bytes());
    field(record.record_type.as_bytes());
    field(record.sequence.as_bytes());
    field(record.value_json.as_bytes());
    match &record.meta_json {
        Some(meta) => field(meta.as_bytes()),
        None => field(b"\0absent"),
    }
    field(&[u8::from(record.protected_key_present)]);
    *hasher.finalize().as_bytes()
}

/// The most records one checkpoint page asks for.
const PAGE: usize = 4096;

/// What one checkpoint page cost on each side.
#[derive(Debug, Default, Serialize)]
pub struct PageCost {
    pub records: usize,
    /// The page size this page was read with, and how many larger tries the range allowances refused first.
    pub limit: usize,
    pub retries: u32,
    pub old_sql_statements: u64,
    pub old_rows_returned: u64,
    pub old_source_bytes: u64,
    #[serde(rename = "record_store_seeks")] pub record_store_seeks: u64,
    #[serde(rename = "record_store_rows_read")] pub record_store_rows_read: u64,
    pub ms: u128,
}

/// The journal tail past the checkpoint, and what its one-time replay wrote.
#[derive(Debug, Default, Serialize)]
pub struct Tail {
    pub journal_rows: u64,
    pub ids: usize,
    /// The canonical answer differs from the checkpoint form: written as version 2.
    pub changed: u64,
    /// No checkpoint form, a canonical answer: written as version 1.
    pub created: u64,
    /// A checkpoint form, no canonical answer: written as a deleted version 2.
    pub deleted: u64,
    pub unchanged: u64,
    pub absent: u64,
}

/// Sampled reads compared with the old store.
#[derive(Debug, Default, Serialize)]
pub struct Samples {
    pub checked: u64,
    pub matched: u64,
    #[serde(rename = "record_store_seeks")] pub record_store_seeks: u64,
    #[serde(rename = "record_store_rows_read")] pub record_store_rows_read: u64,
}

/// What one migration did and what its proof found.
#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub checkpoint_records: u64,
    pub tail: Tail,
    /// Current records on the old store's side after the replay.
    pub records: u64,
    pub records_read_back: u64,
    /// Current record store ids the old store does not have (0 when the proof holds).
    #[serde(rename = "extra_record_store_ids")] pub extra_record_store_ids: u64,
    /// Records whose record store stored form differs from the old store's or is missing (0 when the proof holds).
    pub mismatched: u64,
    pub stored_bytes: u64,
    /// The largest stored form (value and meta JSON text) the checkpoint held.
    pub largest_stored_bytes: u64,
    pub legacy_digest: String,
    #[serde(rename = "record_store_digest")] pub record_store_digest: String,
    /// Checkpoint forms of journal-untouched ids compared with the canonical reader.
    pub checkpoint_against_canonical: Samples,
    /// The record store stamp the checkpoint state ends at (every replayed write is later).
    pub checkpoint_stamp: i64,
    /// As-of reads at the checkpoint stamp compared with the old store's checkpoint forms (no form: no record).
    pub as_of_at_checkpoint: Samples,
    /// How many of those reads were of ids the replay wrote.
    pub as_of_tail_samples: u64,
    pub pages: Vec<PageCost>,
    pub migrate_ms: u128,
    pub verify_ms: u128,
}
impl Report {
    pub fn proved(&self) -> bool {
        self.records == self.records_read_back
            && self.mismatched == 0
            && self.extra_record_store_ids == 0
            && self.legacy_digest == self.record_store_digest
            && self.checkpoint_against_canonical.checked == self.checkpoint_against_canonical.matched
            && self.as_of_at_checkpoint.checked == self.as_of_at_checkpoint.matched
            && self.checkpoint_against_canonical.checked > 0
            && self.as_of_at_checkpoint.checked > 0
    }
}

/// `count` ids spread evenly over the `total` ids `ids` yields (all of them when there are no more than `count`).
fn spread<'a>(ids: impl Iterator<Item = &'a String>, total: usize, count: usize) -> Vec<String> {
    if count == 0 {
        return Vec::new();
    }
    let mut picks = (0..count.min(total)).map(|n| n * total / count.min(total)).peekable();
    let mut chosen = Vec::new();
    for (index, id) in ids.enumerate() {
        if picks.peek() == Some(&index) {
            chosen.push(id.clone());
            picks.next();
        }
    }
    chosen
}
fn delta(after: Work, before: Work) -> Work {
    Work { seeks: after.seeks - before.seeks, rows_read: after.rows_read - before.rows_read }
}

/// What bringing one id in step with the old store wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Absorbed {
    /// record store held no record; the canonical answer became its first version.
    Created,
    /// record store held another form; the canonical answer became its next version.
    Changed,
    /// record store held a record the old store no longer has; it became a deletion.
    Deleted,
    /// Both sides already held the same stored form.
    Unchanged,
    /// Neither side holds a record.
    Absent,
}

/// Bring one id's current record store record to the old store's canonical answer (`canonical`, None: no record): a first
/// version, a next version, a deletion, or nothing when both already hold the same stored form. The write names the
/// version record store holds (a deletion's tombstone included), so a concurrent writer surfaces as `Conflict`, never as an
/// overwrite. The one-time replay and the native account's journal follow both write through this one step.
pub fn absorb<S: Storage>(
    into: &mut RecordStoreCurrent<S>,
    id: &str,
    canonical: Option<&StoredRecord>,
    request_key: String,
) -> Result<Absorbed, Error> {
    absorb_with_request_key(into, id, canonical, |_| request_key)
}

/// Reconcile one canonical value while deriving the request key from the
/// version read in the same current-row seek. Selected preparation uses this
/// to retain its version-scoped retry identity without a separate lookup.
pub fn absorb_with_request_key<S: Storage>(
    into: &mut RecordStoreCurrent<S>,
    id: &str,
    canonical: Option<&StoredRecord>,
    request_key: impl FnOnce(i64) -> String,
) -> Result<Absorbed, Error> {
    let (expected_version, held) = into.stored_with_held_version(id)?;
    if held.is_none() && canonical.is_none() {
        return Ok(Absorbed::Absent);
    }
    if let (Some(held), Some(canonical)) = (&held, canonical) {
        if digest(held) == digest(canonical) {
            return Ok(Absorbed::Unchanged);
        }
    }
    let (account, resource) = (into.account.clone(), into.resource.clone());
    let value = canonical.map_or(serde_json::Value::Null, body);
    let mutation = Mutation { id: id.to_owned(), expected_version, request_key: request_key(expected_version), deleted: canonical.is_none(), value };
    into.store.mutate_local_with_check(&account, &resource, mutation, || Ok(()))?;
    Ok(match (held, canonical) {
        (_, None) => Absorbed::Deleted,
        (None, Some(_)) => Absorbed::Created,
        (Some(_), Some(_)) => Absorbed::Changed,
    })
}

/// Migrate one account's records resource from the old store (`source`, over a readonly snapshot of its object) into
/// `into`, then prove it. `samples` is how many ids each sampled comparison reads; `progress` hears the checkpoint
/// records read so far.
pub fn migrate<S: Storage + Send>(
    source: &mut dyn Source,
    into: &mut RecordStoreCurrent<S>,
    samples: usize,
    mut progress: impl FnMut(u64),
) -> Result<Report, Error> {
    let mut report = Report::default();
    let (account, resource) = (into.account.clone(), into.resource.clone());
    let started = Instant::now();

    // 1. The ids the journal changed after the checkpoint.
    let (tail, journal_rows) = source.tail()?;
    report.tail.journal_rows = journal_rows;
    report.tail.ids = tail.len();

    // 2. The checkpoint, page by page, each page written as version 1 of its records.
    let mut checkpoint: BTreeMap<String, [u8; 32]> = BTreeMap::new();
    let mut tail_forms: BTreeMap<String, StoredRecord> = BTreeMap::new();
    let mut limit = PAGE;
    loop {
        let mut retries = 0;
        let page_started = Instant::now();
        let before = into.store.work();
        // A page whose records do not fit the range allowances is read again in halves; one record that alone does
        // not fit is a refusal.
        let Page { records, work, more } = loop {
            match source.checkpoint_page(limit) {
                Ok(page) => break page,
                Err(_) if limit > 1 => {
                    limit /= 2;
                    retries += 1;
                }
                Err(error) => return Err(error),
            }
        };
        let mut batch = Vec::with_capacity(records.len());
        for record in records {
            checkpoint.insert(record.id.clone(), digest(&record));
            let stored = (record.value_json.len() + record.meta_json.as_ref().map_or(0, String::len)) as u64;
            report.stored_bytes += stored;
            report.largest_stored_bytes = report.largest_stored_bytes.max(stored);
            batch.push((record.id.clone(), body(&record)));
            if tail.contains(&record.id) {
                tail_forms.insert(record.id.clone(), record);
            }
        }
        into.store.import(&account, &resource, &batch)?;
        let record_store = delta(into.store.work(), before);
        report.pages.push(PageCost {
            records: batch.len(),
            old_sql_statements: work.statements,
            old_rows_returned: work.rows,
            old_source_bytes: work.bytes,
            record_store_seeks: record_store.seeks,
            record_store_rows_read: record_store.rows_read,
            ms: page_started.elapsed().as_millis(),
            limit,
            retries,
        });
        limit = (limit * 2).min(PAGE);
        report.checkpoint_records += batch.len() as u64;
        progress(report.checkpoint_records);
        if !more {
            break;
        }
    }

    // The stamp the checkpoint state ends at: every replayed write below is later.
    let checkpoint_stamp = into.store.stamp(&account, &resource)?;
    report.checkpoint_stamp = checkpoint_stamp;

    // 3. The one-time replay: the canonical reader's answer for each tail id becomes its next record store version. `now`
    // holds each tail id's current digest (None: no record) over the checkpoint's.
    let mut now: BTreeMap<String, Option<[u8; 32]>> = BTreeMap::new();
    for (n, id) in tail.iter().enumerate() {
        let canonical = source.canonical(id)?;
        match absorb(into, id, canonical.as_ref(), format!("record-store-migrate-tail-{n}"))? {
            Absorbed::Created => report.tail.created += 1,
            Absorbed::Changed => report.tail.changed += 1,
            Absorbed::Deleted => report.tail.deleted += 1,
            Absorbed::Unchanged => report.tail.unchanged += 1,
            Absorbed::Absent => report.tail.absent += 1,
        }
        now.insert(id.clone(), canonical.as_ref().map(digest));
    }
    // Every declared order now holds the migrated records (`fill_order`, a bounded step at a time).
    for declared in &into.store.settings().orders {
        while !into.store.fill_order(&account, &resource, &declared.order, MAX_PAGE_ITEMS)? {}
    }
    report.migrate_ms = started.elapsed().as_millis();

    // 4. The proof: every old store record read back from record store, in id order (checkpoint ids with the replay's answer,
    // then ids only the replay created), and no record store record the old store lacks.
    let started = Instant::now();
    let (mut legacy_side, mut record_store_side) = (blake3::Hasher::new(), blake3::Hasher::new());
    let created = now.iter().filter(|(id, _)| !checkpoint.contains_key(*id)).map(|(id, one)| (id, *one));
    let expected = checkpoint.iter().map(|(id, one)| (id, now.get(id).copied().unwrap_or(Some(*one)))).chain(created);
    for (id, one) in expected {
        let Some(one) = one else { continue };
        report.records += 1;
        legacy_side.update(&one);
        match into.stored(id)? {
            Some(record) => {
                let read = digest(&record);
                report.records_read_back += 1;
                record_store_side.update(&read);
                report.mismatched += u64::from(read != one);
            }
            None => report.mismatched += 1,
        }
    }
    report.legacy_digest = legacy_side.finalize().to_hex().to_string();
    report.record_store_digest = record_store_side.finalize().to_hex().to_string();
    // Every live record store id, in id order and without values: any the old store lacks is an extra.
    let mut after: Option<String> = None;
    loop {
        let (ids, next) = into.store.ids(&account, &resource, after.as_deref(), MAX_PAGE_ITEMS)?;
        report.extra_record_store_ids += ids
            .iter()
            .filter(|id| match now.get(*id) {
                Some(one) => one.is_none(),
                None => !checkpoint.contains_key(*id),
            })
            .count() as u64;
        match next {
            Some(next) => after = Some(next),
            None => break,
        }
    }

    // 5. The checkpoint decode against the canonical reader, on ids the journal did not change.
    let untouched = checkpoint.len() - tail_forms.len();
    for id in spread(checkpoint.keys().filter(|id| !tail.contains(*id)), untouched, samples) {
        report.checkpoint_against_canonical.checked += 1;
        let canonical = source.canonical(&id)?;
        if canonical.as_ref().map(digest).as_ref() == checkpoint.get(&id) {
            report.checkpoint_against_canonical.matched += 1;
        }
    }

    // 6. As-of reads at the checkpoint stamp: half on ids the replay wrote (their checkpoint form, or no record when
    // the replay created them), the rest on untouched ids.
    let at = checkpoint_stamp;
    let mut ids = spread(tail.iter(), tail.len(), samples / 2);
    report.as_of_tail_samples = ids.len() as u64;
    ids.extend(spread(checkpoint.keys().filter(|id| !tail.contains(*id)), untouched, samples.saturating_sub(ids.len())));
    for id in ids {
        let before = into.store.work();
        let read = into.store.as_of(&account, &resource, &id, at)?;
        let cost = delta(into.store.work(), before);
        let answer = read.record.map(|record| stored_form(&id, &record.value)).transpose()?;
        report.as_of_at_checkpoint.checked += 1;
        report.as_of_at_checkpoint.record_store_seeks += cost.seeks;
        report.as_of_at_checkpoint.record_store_rows_read += cost.rows_read;
        if answer.as_ref().map(digest).as_ref() == checkpoint.get(&id) {
            report.as_of_at_checkpoint.matched += 1;
        }
    }
    report.verify_ms = started.elapsed().as_millis();
    Ok(report)
}

