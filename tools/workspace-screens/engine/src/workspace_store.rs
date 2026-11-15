// Purpose: the account's workspace store (labelled JSON values: settings,
// preferences, screen state, open conflicts) as one record store resource of the
// account's own record store, inside the account's RECORD_BOOK file.
// Invariants: a record's id is its label; its record store value is the exact ECMA JSON
// text of the stored value (byte for byte, key order kept). record store version history
// is the revision history; a change names the version it replaces
// (compare-and-set) and costs one record store write; the scope stamp is the change
// clock. No SQL, no tables, no second copy: the record store is the only owner.
// Security: readers check `Source::assert_current` before and after every read
// and return nothing after the source stops being current. Writers run on the
// caller's own IMMEDIATE transaction (a lent handle), so a change commits or
// rolls back with the command that made it. Failures are redacted.
//! The workspace store: `Workspace` (one lent handle: get, change, stamp),
//! `Reader` (`read`, `read_checked` over the account's own record store).

use crate::{
    ecma_json,
    records::{Error, Mutation},
    scan::ReadWork,
    storage::{
        record_store::RecordStore,
        sqlite::{self, Access, Supply},
        Storage,
    },
};
use crate::storage::sqlite::Connection;
use std::{
    collections::BTreeSet,
    fmt,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub const MAX_SELECTION: usize = 64;
pub const MAX_LABEL_UNITS: usize = 300;
pub const MAX_READ_BYTES: usize = 4_194_304;
pub const MAX_EXPANDED_BYTES: usize = 16_777_216;

#[derive(Clone, Debug)]
pub enum Kind {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Cancelled(crate::refusal_cause::Cause),
    SourceUnavailable(crate::refusal_cause::Cause),
    SourceChanged(crate::refusal_cause::Cause),
    Schema(crate::refusal_cause::Cause),
    Corrupt(crate::refusal_cause::Cause),
}
impl Kind {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Bounds(cause) => cause.clone(),
            Self::Cancelled(cause) => cause.clone(),
            Self::Corrupt(cause) => cause.clone(),
            Self::Invalid(cause) => cause.clone(),
            Self::Schema(cause) => cause.clone(),
            Self::SourceChanged(cause) => cause.clone(),
            Self::SourceUnavailable(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Kind);

impl PartialEq for Kind {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for Kind {}

#[derive(Clone, Debug)]
pub struct Failure {
    pub kind: Kind,
    pub work: ReadWork,
    cause: crate::refusal_cause::Cause,
}
impl Failure {
    pub fn new(kind: Kind, work: ReadWork) -> Self {
        Self { cause: kind.cause(), kind, work }
    }
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { &self.cause }
}
crate::impl_caused!(Failure);

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self.kind {
            Kind::Invalid(_) => "workspace record selection or limits are invalid",
            Kind::Bounds(_) => "workspace record read exceeds its bound",
            Kind::Cancelled(_) => "workspace record read cancelled",
            Kind::SourceUnavailable(_) => "selected workspace record source unavailable",
            Kind::SourceChanged(_) => "selected workspace record source changed",
            Kind::Schema(_) => "selected workspace record schema differs",
            Kind::Corrupt(_) => "selected workspace record value is invalid",
        })
    }
}
impl std::error::Error for Failure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// A retained selected-account/resource owner, not a raw path or identity claim.
/// It must refuse after erasure, revocation, handoff or source replacement.
pub trait Source {
    fn assert_current(&self) -> Result<(), Kind>;
}
#[derive(Clone, Debug)]
pub struct Limits {
    pub rows: usize,
    pub elapsed: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            rows: 4096,
            elapsed: Duration::from_secs(2),
        }
    }
}
impl Limits {
    fn valid(&self) -> bool {
        self.rows > 0 && self.rows <= 4096 && !self.elapsed.is_zero() && self.elapsed <= Duration::from_secs(30)
    }
}
/// None selects every record; Some(empty) selects none. Labels are exact ids,
/// prefixes select every id that starts with them. Counted before de-duplication.
#[derive(Clone, Default)]
pub struct Selection {
    pub labels: Vec<String>,
    pub prefixes: Vec<String>,
}
impl fmt::Debug for Selection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Selection([redacted])")
    }
}
pub struct Snapshot {
    /// Labels in the asked order, then each prefix's ids ascending; each id once.
    pub records: Vec<(String, ecma_json::Value)>,
    pub input_bytes: usize,
    pub expanded_bytes: usize,
    /// With a page, the last record's label when more records follow it; else none.
    pub next: Option<String>,
    /// `rows_returned` is the rows the record store read for this snapshot.
    pub work: ReadWork,
}
impl fmt::Debug for Snapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Snapshot")
            .field("records", &self.records.len())
            .field("input_bytes", &self.input_bytes)
            .field("expanded_bytes", &self.expanded_bytes)
            .field("work", &self.work)
            .finish()
    }
}

/// The record store resource of the workspace store: the account's own `record-book` resource this file reads (DATA in
/// src/storage/record_store_resources.json, which also names its old source and the startup phase that copies it).
pub fn resource() -> Result<&'static str, Kind> {
    crate::storage::record_store_resources::resource_of(file!())
        .ok_or(crate::cause!(Kind::Schema))
}

fn value_limits() -> ecma_json::Limits {
    ecma_json::Limits {
        input_bytes: MAX_READ_BYTES,
        output_bytes: MAX_EXPANDED_BYTES,
        depth: 256,
        nodes: 1_000_000,
        string_units: MAX_READ_BYTES,
        total_string_units: MAX_READ_BYTES,
        container_entries: 1_000_000,
        number_bytes: 4096,
    }
}
/// The stored text of a record value (`None` for a tombstone or another shape).
fn stored_text(value: &serde_json::Value) -> Option<&str> {
    value.as_str()
}
fn parse(text: &str) -> Result<ecma_json::Value, Kind> {
    ecma_json::parse(text.as_bytes(), value_limits()).map_err(|error| match error {
        ecma_json::Error::InvalidJson(cause) => Kind::Corrupt(cause),
        error => Kind::Bounds(error.cause()),
    })
}

/// The account's workspace store on one SQLite handle the caller owns (its
/// command transaction for writes, its readonly snapshot for reads).
pub struct Workspace<'db> {
    store: RecordStore<Supply<&'db Connection>>,
    account: String,
    resource: &'static str,
}
impl fmt::Debug for Workspace<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Workspace([redacted])")
    }
}
/// The account's own record store on a SQLite handle its owner keeps (a command
/// transaction or a retained readonly/readwrite handle on the RECORD_BOOK),
/// with the shipped `native` host limits for that file's volume.
pub fn lend_store(db: &Connection, access: Access) -> Result<RecordStore<Supply<&Connection>>, Kind> {
    let supply = sqlite::lend(db, "record_store", access).map_err(|error| Kind::SourceUnavailable(error.cause()))?;
    let path = db.path().filter(|path| !path.is_empty()).ok_or(crate::cause!(Kind::SourceUnavailable))?;
    crate::storage::record_store_resources::native(supply, Path::new(path)).map_err(|error| Kind::SourceUnavailable(error.cause()))
}

impl<'db> Workspace<'db> {
    pub fn lend(db: &'db Connection, account: &str, access: Access) -> Result<Self, Kind> {
        let resource = resource()?;
        let store = lend_store(db, access)?;
        Ok(Self { store, account: account.to_owned(), resource })
    }
    /// The held version (0 when never written; a deletion keeps its tombstone
    /// version) and the stored text and value, from one current-row seek.
    pub fn get(&self, label: &str) -> Result<(i64, Option<(String, ecma_json::Value)>), Kind> {
        let (version, record) =
            self.store.held_record_with_version(&self.account, self.resource, label).map_err(source_error)?;
        let held = match record {
            Some(record) => {
                let text = stored_text(&record.value).ok_or(crate::cause!(Kind::Corrupt))?.to_owned();
                let value = parse(&text)?;
                Some((text, value))
            }
            None => None,
        };
        Ok((version, held))
    }
    /// One change: one record store write, compare-and-set on `expected_version` (the
    /// version `get` returned in this same transaction). `value: None` removes
    /// the record. The replaced version stays in record store history as its revision.
    /// `request_key` is the change's stable retry identity.
    pub fn change(
        &mut self,
        label: &str,
        expected_version: i64,
        value: Option<&ecma_json::Value>,
        request_key: &str,
    ) -> Result<i64, Error> {
        if label.is_empty() || label.encode_utf16().count() > MAX_LABEL_UNITS {
            return Err(Error::Invalid("invalid workspace label", crate::cause!()));
        }
        let text = value
            .map(|value| ecma_json::stringify(value, Default::default()))
            .transpose()
            .map_err(|error| Error::Invalid("invalid workspace value", error.cause()))?;
        let change = self.store.mutate_local_with_check(
            &self.account,
            self.resource,
            Mutation {
                id: label.to_owned(),
                expected_version,
                request_key: request_key.to_owned(),
                deleted: text.is_none(),
                value: text.map_or(serde_json::Value::Null, serde_json::Value::String),
            },
            || Ok(()),
        )?;
        Ok(change.version)
    }
    /// The scope's newest committed stamp: it moves on every change and never
    /// moves back, so equal stamps mean nothing in the store changed.
    pub fn stamp(&self) -> Result<i64, Kind> {
        self.store.stamp(&self.account, self.resource).map_err(|error| Kind::SourceUnavailable(error.cause()))
    }
    /// Live labels, ascending, at most `most` (refused above it).
    pub fn labels(&self, most: usize) -> Result<BTreeSet<String>, Kind> {
        let mut labels = BTreeSet::new();
        let mut after: Option<String> = None;
        loop {
            let (found, next) = self
                .store
                .ids(&self.account, self.resource, after.as_deref(), (most + 1).min(crate::records::MAX_PAGE_ITEMS))
                .map_err(source_error)?;
            labels.extend(found);
            if labels.len() > most {
                return Err(crate::cause!(Kind::Bounds));
            }
            match next {
                Some(next) => after = Some(next),
                None => return Ok(labels),
            }
        }
    }
}

fn valid(selection: Option<&Selection>) -> Result<(), Kind> {
    let Some(selection) = selection else {
        return Ok(());
    };
    if selection.labels.len().saturating_add(selection.prefixes.len()) > MAX_SELECTION
        || selection
            .labels
            .iter()
            .chain(&selection.prefixes)
            .any(|s| s.is_empty() || s.encode_utf16().count() > MAX_LABEL_UNITS)
    {
        return Err(crate::cause!(Kind::Invalid));
    }
    Ok(())
}

/// One page of a read: the records after `after` in the read's order (the asked labels, then each prefix's ids
/// ascending; every id ascending when nothing is selected), as many as keep their labels and stored text within
/// `bytes`, and at least one. An `after` a selection does not reach refuses (`SourceChanged`): the caller reads again
/// from the start.
#[derive(Clone, Default)]
pub struct Page {
    pub after: Option<String>,
    pub bytes: usize,
}
impl fmt::Debug for Page {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Page").field("bytes", &self.bytes).finish_non_exhaustive()
    }
}

/// The records a page's read takes from the store at a time, so a page stops reading soon after it is full.
const PAGE_CHUNK: usize = 32;

/// Records, input bytes, expanded bytes and the next page's `after` of one read.
type Read = (Vec<(String, ecma_json::Value)>, usize, usize, Option<String>);

/// Reads of the workspace store of `account` in the account's own record store.
pub struct Reader<'a, S: Storage, W: Source> {
    store: &'a RecordStore<S>,
    account: &'a str,
    resource: &'static str,
    source: W,
    limits: Limits,
}
impl<S: Storage, W: Source> fmt::Debug for Reader<'_, S, W> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WorkspaceStoreReader([redacted selected source])")
    }
}
impl<'a, S: Storage, W: Source> Reader<'a, S, W> {
    pub fn new(store: &'a RecordStore<S>, account: &'a str, source: W, limits: Limits) -> Result<Self, Failure> {
        let refuse = |kind| Failure::new(kind, ReadWork::default());
        if !limits.valid() || account.is_empty() {
            return Err(refuse(crate::cause!(Kind::Invalid)));
        }
        let resource = resource().map_err(refuse)?;
        source.assert_current().map_err(refuse)?;
        Ok(Self { store, account, resource, source, limits })
    }

    pub fn read(&mut self, selection: Option<&Selection>, page: Option<&Page>, cancel: Arc<AtomicBool>)
        -> Result<Snapshot, Failure> {
        let started = self.store.work().rows_read;
        let result = self.walk(selection, page, &cancel);
        let work = ReadWork { rows_returned: self.store.work().rows_read.saturating_sub(started), ..ReadWork::default() };
        // Covers even empty selections and failures without returning stale data.
        if let Err(kind) = self.source.assert_current() {
            return Err(Failure::new(kind, work));
        }
        match result {
            Ok((records, input_bytes, expanded_bytes, next)) => {
                Ok(Snapshot { records, input_bytes, expanded_bytes, next, work })
            }
            Err(kind) => Err(Failure::new(kind, work)),
        }
    }

    /// `read`, plus the scope stamp before and after it: a change committed
    /// during the read refuses the snapshot.
    pub fn read_checked(mut self, selection: Option<&Selection>, page: Option<&Page>, cancel: Arc<AtomicBool>)
        -> Result<Snapshot, Failure> {
        let (store, account, resource) = (self.store, self.account, self.resource);
        let stamp = |work: &ReadWork| {
            store.stamp(account, resource).map_err(|error| Failure::new(Kind::SourceUnavailable(error.cause()), work.clone()))
        };
        let before = stamp(&ReadWork::default())?;
        let snapshot = self.read(selection, page, cancel)?;
        if stamp(&snapshot.work)? != before {
            return Err(Failure::new(crate::cause!(Kind::SourceChanged), snapshot.work));
        }
        Ok(snapshot)
    }

    fn walk(&self, selection: Option<&Selection>, page: Option<&Page>, cancel: &AtomicBool) -> Result<Read, Kind> {
        valid(selection)?;
        self.source.assert_current()?;
        let deadline = Instant::now() + self.limits.elapsed;
        let check = || {
            if cancel.load(Ordering::Relaxed) {
                Err(crate::cause!(Kind::Cancelled))
            } else if Instant::now() >= deadline {
                Err(crate::cause!(Kind::Bounds))
            } else {
                Ok(())
            }
        };
        check()?;
        let (store, account, resource) = (self.store, self.account, self.resource);
        let mut ids: Vec<String> = Vec::new();
        let mut seen = BTreeSet::new();
        // A selection's page continues after the label its `after` names: ids before it are walked, not taken.
        let mut skipping = selection.and(page).and_then(|page| page.after.as_deref());
        // A page takes at most `rows` ids; one more id after them is more to read in a later page.
        let mut more = false;
        let paged = page.is_some();
        // Whether to go on taking ids.
        let mut take = |id: String, ids: &mut Vec<String>| -> Result<bool, Kind> {
            if !seen.insert(id.clone()) {
                return Ok(true);
            }
            if let Some(after) = skipping {
                if id == after {
                    skipping = None;
                }
                return Ok(true);
            }
            if ids.len() >= self.limits.rows {
                more = paged;
                return if paged { Ok(false) } else { Err(crate::cause!(Kind::Bounds)) };
            }
            ids.push(id);
            Ok(true)
        };
        let chunk = self.limits.rows.min(crate::records::MAX_PAGE_ITEMS);
        'collect: {
            match selection {
                Some(selection) => {
                    for label in &selection.labels {
                        if !take(label.clone(), &mut ids)? {
                            break 'collect;
                        }
                    }
                    // Ids walk ascending in byte order, so every id starting with a
                    // prefix follows the prefix itself, contiguously.
                    for prefix in &selection.prefixes {
                        if !take(prefix.clone(), &mut ids)? {
                            break 'collect;
                        }
                        let mut after = Some(prefix.clone());
                        while let Some(cursor) = after {
                            check()?;
                            let (found, next) =
                                store.ids(account, resource, Some(&cursor), chunk).map_err(source_error)?;
                            let mut ended = next.is_none();
                            for id in found {
                                if !id.starts_with(prefix.as_str()) {
                                    ended = true;
                                    break;
                                }
                                if !take(id, &mut ids)? {
                                    break 'collect;
                                }
                            }
                            after = if ended { None } else { next };
                        }
                    }
                }
                None => {
                    // Every id ascending: a page continues in the store's own order, after its cursor.
                    let mut after: Option<String> = page.and_then(|page| page.after.clone());
                    loop {
                        check()?;
                        let (found, next) =
                            store.ids(account, resource, after.as_deref(), chunk).map_err(source_error)?;
                        for id in found {
                            if !take(id, &mut ids)? {
                                break 'collect;
                            }
                        }
                        match next {
                            Some(next) => after = Some(next),
                            None => break,
                        }
                    }
                }
            }
        }
        if skipping.is_some() {
            return Err(crate::cause!(Kind::SourceChanged));
        }
        let budget = page.map(|page| page.bytes);
        let chunk_size = if budget.is_some() { chunk.min(PAGE_CHUNK) } else { chunk };
        let mut records: Vec<(String, ecma_json::Value)> = Vec::new();
        let mut input_bytes = 0usize;
        let mut expanded = 0usize;
        for asked in ids.chunks(chunk_size) {
            check()?;
            let asked_ids: Vec<&str> = asked.iter().map(String::as_str).collect();
            let found = store.get_many(account, resource, &asked_ids).map_err(source_error)?;
            for (label, record) in asked.iter().zip(found) {
                let Some(record) = record else { continue };
                let text = stored_text(&record.value).ok_or(crate::cause!(Kind::Corrupt))?;
                if budget.is_some_and(|budget| {
                    !records.is_empty() && input_bytes.saturating_add(label.len() + text.len()) > budget
                }) {
                    let next = records.last().map(|(label, _)| label.clone());
                    check()?;
                    return Ok((records, input_bytes, expanded, next));
                }
                input_bytes = input_bytes
                    .checked_add(label.len())
                    .and_then(|n| n.checked_add(text.len()))
                    .filter(|n| *n <= MAX_READ_BYTES)
                    .ok_or(crate::cause!(Kind::Bounds))?;
                let value = parse(text)?;
                expanded = expanded
                    .checked_add(32 + label.encode_utf16().count() * 2 + text.len())
                    .filter(|n| *n <= MAX_EXPANDED_BYTES)
                    .ok_or(crate::cause!(Kind::Bounds))?;
                records.push((label.clone(), value));
            }
        }
        check()?;
        // Ids past the page's row limit are for the page after this one.
        let next = if more { ids.last().cloned() } else { None };
        Ok((records, input_bytes, expanded, next))
    }
}

fn source_error(error: Error) -> Kind {
    match error {
        Error::Invalid(_, cause) => Kind::Invalid(cause),
        Error::Conflict(cause) => Kind::SourceChanged(cause),
        Error::Refused(_, cause) | Error::Unavailable(cause) | Error::OutcomeUnknown(cause) => Kind::SourceUnavailable(cause),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::atomic::AtomicBool, time::Duration};

    const ACCOUNT: &str = "owner-fixture";

    struct Current;
    impl Source for Current {
        fn assert_current(&self) -> Result<(), Kind> {
            Ok(())
        }
    }

    /// A record book file with the workspace store's families, as the account's own file holds it.
    fn book(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("record-book.sqlite");
        drop(
            sqlite::open_owned(
                &path,
                "record_store",
                sqlite::Bounds {
                    value_bytes: 64 * 1024 * 1024,
                    work: u64::MAX / 2,
                    deadline: Duration::MAX,
                    spend: sqlite::Spend::EachOperation,
                    cancel: None,
                    busy: Duration::from_secs(5),
                },
            )
            .unwrap(),
        );
        path
    }

    fn put(path: &Path, label: &str, text: &str) {
        let db = Connection::open(path).unwrap();
        let mut workspace = Workspace::lend(&db, ACCOUNT, Access::Write).unwrap();
        let (version, _) = workspace.get(label).unwrap();
        let value = ecma_json::parse(text.as_bytes(), Default::default()).unwrap();
        workspace.change(label, version, Some(&value), &format!("fixture:{label}:{version}")).unwrap();
    }

    #[test]
    fn a_read_pages_records_by_row_limit_and_each_record_comes_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = book(dir.path());
        let labels: Vec<String> = (1..=12).map(|n| format!("r{n:02}")).collect();
        for label in &labels {
            put(&path, label, "{\"n\":1}");
        }
        let db = Connection::open(&path).unwrap();
        let store = lend_store(&db, Access::Read).unwrap();
        let limits = Limits { rows: 5, elapsed: Duration::from_secs(2) };
        let cancel = Arc::new(AtomicBool::new(false));
        let mut reader = Reader::new(&store, ACCOUNT, Current, limits.clone()).unwrap();

        // Every record, ascending: five a page, each page's `next` the last label it shows.
        let (mut seen, mut sizes, mut after) = (Vec::new(), Vec::new(), None::<String>);
        loop {
            let page = Page { after: after.clone(), bytes: 1 << 20 };
            let snapshot = reader.read(None, Some(&page), cancel.clone()).unwrap();
            sizes.push(snapshot.records.len());
            seen.extend(snapshot.records.iter().map(|(label, _)| label.clone()));
            match snapshot.next {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        assert_eq!(seen, labels);
        assert_eq!(sizes, [5, 5, 2]);

        // A selection of labels pages the same way. A prefix counts as one row of its page too (its own id is
        // walked before the ids it starts), so a page of a prefix holds one record fewer at its start.
        let by_labels = Selection { labels: labels.clone(), prefixes: vec![] };
        let by_prefix = Selection { labels: vec![], prefixes: vec!["r".into()] };
        for (selection, sizes_wanted) in [(&by_labels, vec![5, 5, 2]), (&by_prefix, vec![4, 5, 3])] {
            let (mut seen, mut sizes, mut after) = (Vec::new(), Vec::new(), None::<String>);
            loop {
                let page = Page { after: after.clone(), bytes: 1 << 20 };
                let snapshot = reader.read(Some(selection), Some(&page), cancel.clone()).unwrap();
                sizes.push(snapshot.records.len());
                seen.extend(snapshot.records.iter().map(|(label, _)| label.clone()));
                match snapshot.next {
                    Some(next) => after = Some(next),
                    None => break,
                }
            }
            assert_eq!(seen, labels);
            assert_eq!(sizes, sizes_wanted);
        }

        // An `after` the selection does not reach refuses: the caller reads again from the start.
        let gone = Page { after: Some("no-such-label".into()), bytes: 1 << 20 };
        let refused = reader.read(Some(&by_labels), Some(&gone), cancel.clone()).unwrap_err();
        assert_eq!(refused.kind, crate::cause!(Kind::SourceChanged));

        // Without a page, more records than the row limit is a bound, as before paging existed.
        let unpaged = reader.read(None, None, cancel.clone()).unwrap_err();
        assert_eq!(unpaged.kind, crate::cause!(Kind::Bounds));
    }
}
