// src/storage/record_store/mod.rs
//
// Purpose: The record store (storage-convergence plan section 5a): one current row per record, one history row
// written only when a version is replaced, kept replies in a bounded ring inside the current row, a segments search port (`segments.rs`),
// and destruction that is unreachable at once and physically removed when the undo window ends. It speaks only the
// storage boundary (`crate::storage::Storage`), so it runs unchanged on the in-memory and SQLite supplies.
//
// Non-Negotiable Invariants:
// - Rows per change: a create writes 1 row plus its order entries (live, changed); an update writes 2 rows (the
//   replaced version under the stamp that replaced it, and the new current row) plus its order entries. Each declared
//   field order that covers the record adds 1 row on create and 2 (erase + put) on an update that changes its value,
//   0 otherwise. A read writes nothing.
// - The current version is one row (valid_to = MAX). The version live at stamp T is the first `versions` row of the
//   record after (id, T): one ordered seek returning one row, whatever the record's history size.
// - Stamps are hybrid logical clock values (milliseconds << 16 | counter) minted inside the write, increasing per
//   account/resource scope; a cold scope recovers its newest stamp from its two orders (2 rows, once per open).
// - Record, history, kept reply, order rows, search changes and the fresh admission check commit in one scope; a refused check leaves no
//   durable effect.
// - Destruction (`erase`) moves every row of the record into custody in one scope: unreachable by every read at
//   once; restorable only through the operator's `restore` until the undo window ends; then the exit step removes it,
//   only on a supply whose removals overwrite the removed bytes as they commit (`Storage::overwrites_removed`), so
//   nothing of it survives in free space. Its space goes back to the volume later, in short steps between requests
//   (`reclaim_step`), never as a rewrite on a write path.
// - The store refuses a change that leaves it above its byte budget.
//
// Key Concepts:
// - Families (DATA, `src/storage/families.json` schema `record_store`): `versions` (orders live, changed, ending,
//   gone), `custody`, `search_segments` and `search_parts` (the search port's segments: `segments.rs`), `ordered` (one row per record per declared field order that covers it: `orders.rs`;
//   written on create, moved only when the ordered value changes, removed on delete and erase; `ordered_page`).
// - The exit step: each write removes at most `exit_step_rows` history rows, tombstones and custody rows older than
//   the undo window; a host timer may call `retire` for scopes nobody writes. A change reads the exit step's three
//   ranges in the same batch as the record's current row (the horizon is the stamp the change mints minus the window, so
//   no row the change itself writes falls inside them) and stages the removals into the batch that carries its writes.
// - The change feed lists each changed record once, at its newest version (the CouchDB rule); a cursor older than
//   the undo window may miss a deletion whose tombstone already left and must start again.
//
// Security Considerations:
// - Local methods assume an already trusted fixed-scope host; `mutate_admitted` checks fresh admission inside the
//   write scope, again before a recovered kept reply is disclosed and again before commit.
// - Storage failures leave as record-contract errors; nothing about the supply is disclosed.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub mod carry;
pub mod digest;
pub mod follow;
pub mod full_store;
pub mod holders;
pub use holders::HolderGuard;
pub mod history;
pub mod history_archive;
pub mod history_chain;
pub mod keep;
pub mod maintenance;
pub mod referrers;
pub use referrers::{Referrer, ReferrerPart, Referrers};
pub mod cascade;
pub mod find;
#[cfg(not(hosted_records))]
pub mod legacy;
#[cfg(not(hosted_records))]
pub mod migrate;
#[cfg(not(hosted_records))]
pub mod native;
pub mod order_reads;
pub mod orders;
pub mod partial;
pub mod record_log;
pub mod record_sync;
pub mod ring;
pub mod search;
mod segments;
pub mod shared;
pub use segments::{Merged, SearchMemory, SharedSearchMemory, Walked};
#[cfg(test)]
mod changes_tests;
#[cfg(test)]
mod follow_tests;
#[cfg(test)]
mod keep_tests;
#[cfg(test)]
mod projection_head_tests;
#[cfg(test)]
mod full_store_tests;
#[cfg(test)]
mod month_tests;
#[cfg(test)]
mod page_tests;
#[cfg(test)]
mod reclaim_tests;
#[cfg(test)]
mod resources_held_tests;
#[cfg(test)]
mod record_sync_tests;
pub mod settings;
pub mod stamps;
pub mod store_size;
pub mod totals;

use self::{
    ring::{Receipt, Ring},
    settings::{Limits, Settings},
};
use super::{
    Bound, Error as StorageError, Intent, Order, Query, Range, Read as Field, Reply, Row, Storage,
    Value, When, Write,
};
use crate::{
    records::{
        changes::{self, Changed},
        Change, CommitContext, Error, Mutation, Page, Read, Record, Records, MAX_PAGE_BYTES,
        MAX_PAGE_ITEMS, MAX_RECORD_BYTES,
    },
    resource_authority::{AdmittedCall, Refusal},
};
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use serde_json::json;
#[cfg_attr(all(hosted_records, target_arch = "wasm32"), allow(unused_imports))]
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap, HashSet},
    io,
    time::{SystemTime, UNIX_EPOCH},
};

/// The schema of the record store families in `families.json`.
pub const SCHEMA: &str = "record_store";
/// `valid_to` of a current row: no stamp replaced it.
pub const CURRENT: i64 = i64::MAX;
const VERSIONS: &str = "versions";
const CUSTODY: &str = "custody";
const ORDERED: &str = "ordered";
const ORDER_STATE: &str = "order_state";
const ORDER_SIGNATURES: &str = "order_signatures";
const ORDER_CARRY: &str = "order_carry";
const TOTALS: &str = "totals";
const TOTALS_FILL: &str = "totals_fill";
/// Exact-current-key existence reads only `deleted`; callers do not materialize the record body to test a point key.
const CURRENT_EXISTS: [Field<'static>; 1] = [Field::whole("deleted")];
const ROW: [Field<'static>; 7] = [
    Field::whole("id"),
    Field::whole("valid_from"),
    Field::whole("version"),
    Field::whole("deleted"),
    Field::whole("body"),
    Field::whole("ring"),
    Field::whole("kind"),
];
const ROW_TO: Field<'static> = Field::whole("valid_to");
/// What an exit step reads of the versions it removes: the id and `valid_to` complete their key.
const EXIT_VERSIONS: [Field<'static>; 2] = [Field::whole("id"), ROW_TO];
/// What it reads of the custody rows it removes: their whole key.
const EXIT_CUSTODY: [Field<'static>; 5] = [
    Field::whole("erased_at"),
    Field::whole("account"),
    Field::whole("resource"),
    Field::whole("id"),
    Field::whole("valid_to"),
];
/// The most keys one batch read asks for; a longer list is asked in several.
const READ_BATCH: usize = 1000;
/// The most writes one batch holds before it is sent; a long bulk write goes in several.
const WRITE_BATCH: usize = 256;
/// A row with its `valid_to` (history and custody reads).
const FULL_ROW: [Field<'static>; 8] = [
    ROW[0], ROW[1], ROW[2], ROW[3], ROW[4], ROW[5], ROW[6], ROW_TO,
];

/// The milliseconds of a stamp.
pub fn stamp_ms(stamp: i64) -> u64 {
    (stamp.max(0) >> 16) as u64
}

/// The settle position that marks a scope's settle store as carried from its records (`fill_settle`): never a copy's
/// name (a copy names itself with letters, digits, dots, dashes, colons or underscores; this has a space).
const FILLED: &str = "seeded from records";

/// The fields a settle store keeps for a record value (`mirror_settle`): an object's own fields, any other value whole
/// under the field `value`.
pub(crate) fn settle_fields(value: serde_json::Value) -> stamps::Fields {
    match value {
        serde_json::Value::Object(fields) => fields,
        other => stamps::Fields::from_iter([("value".to_string(), other)]),
    }
}

/// The store's clock is the one `Clock` (storage/time_source.rs); tests supply their own, the system's is `RealClock`.
pub use crate::storage::time_source::{Clock, RealClock};

/// The clock's milliseconds as the store counts them: a clock that reads before the epoch reads as 0.
pub fn clock_ms(clock: &dyn Clock) -> u64 {
    u64::try_from(clock.now_ms()).unwrap_or(0)
}

/// Rows the store has read and ordered seeks it has made through the boundary since it was opened (core units of
/// plan CP11: point reads and range rows). Each read reports its own counts in `work`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Work {
    pub seeks: u64,
    pub rows_read: u64,
}

/// One stored version of a record.
#[derive(Clone, Debug)]
struct Version {
    id: String,
    valid_from: i64,
    valid_to: i64,
    version: i64,
    deleted: bool,
    body: Option<Vec<u8>>,
    ring: Option<String>,
    /// The record's kind: the value's `kind_field` (settings DATA) when it is text.
    kind: Option<String>,
}

/// Where a total's fill stands (`fill_total`).
struct TotalFill {
    signature: String,
    after: Option<(String, String)>,
    complete: bool,
}

/// Dependencies that record mutations cannot change, held only for one atomic command.
/// The settings bound the number of entries; no record values, rights, current rows or
/// range results are cached. Absence is a witness of this same write scope too.
#[derive(Default)]
struct MutationPlan {
    total_fills: BTreeMap<(String, String), Option<TotalFill>>,
}

/// What a destruction keeps: where the record waits in custody until the undo window ends.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Erased {
    pub erased_at: i64,
    pub versions: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AdmittedMutation {
    id: String,
    expected_version: i64,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    value: serde_json::Value,
}

/// The record store over one storage supply.
pub struct RecordStore<S: Storage> {
    storage: S,
    clock: Box<dyn Clock>,
    /// The free bytes the computer keeps on this store's volume (its `keep_free_bytes`), when the owner sets it: a write
    /// is refused before any SQL while the volume has less (`check_room`).
    volume_reserve: Option<u64>,
    settings: &'static Settings,
    /// The current installed model's parts, supplied by the composition owner. None uses shipped DATA.
    referrer_parts: Option<std::sync::Arc<[referrers::ReferrerPart]>>,
    /// The composition's exact value envelope, decoded once before logical model paths are read.
    referrer_value_path: Option<Vec<String>>,
    /// The limits of the host this store runs on (`Settings::limits`).
    limits: Limits,
    /// Newest committed stamp per (account, resource), recovered on first use.
    stamps: HashMap<(String, String), i64>,
    /// Where each keep rule's sweep stands (`keep.rs`), for as long as this store is held open.
    keep_walks: RefCell<keep::Walks>,
    /// The storage mark (`Storage::mark`) the stamp cache was last checked against: when another handle commits,
    /// the mark moves and the cache is dropped, so a stamp is never minted at or below one another store minted.
    stamps_mark: Option<i64>,
    /// The storage mark the search memory was last checked against (`segments.rs`, `search_observe`).
    search_mark: Cell<Option<i64>>,
    work: Cell<Work>,
    /// (account, resource, order) scopes whose declared order is known filled (`fill_order`); only ever grows.
    filled: RefCell<HashSet<(String, String, String)>>,
    /// Each loaded scope's search memory (`segments.rs`): its unflushed tail and segment metas.
    search: RefCell<HashMap<segments::Scope, segments::Index>>,
    /// Undo of the open write scope's search memory changes.
    search_undo: Vec<segments::Undo>,
    /// Whether this store's memory came from a shared search memory (`carry_search`), which settles it after the transaction.
    search_carried: bool,
    /// The changes the open write scope made, published to the account's notifier once they are durable
    /// (`records::changes`): after this store's own commit, or held for the owner of a lent transaction.
    written: Vec<Changed>,
    /// The size row this store runs under (`store_size.rs`): the account's plan or contract row, the computer's own row,
    /// or, when none was given (`set_size_row`), the shipped default.
    size: Option<std::sync::Arc<store_size::SizeRow>>,
    /// The bytes the store held at its last write's budget check: the exit step reads the store's level from it, so a
    /// store under pressure lets replaced versions leave sooner (`settings.json` `history`) at no extra read.
    measured: Cell<u64>,
    /// The recovery of this store's file once it is full (`full_store.rs`), when its owner gave one (`with_recovery`).
    recovery: Option<std::sync::Arc<full_store::FullStoreRecovery>>,
    /// Whether every write also keeps its records in the settle store (`mirror_settle`): the owner's choice
    /// (`mirrored`), else the settings' `settle_mirror`.
    mirror: Option<bool>,
}

/// The writes of one step of a write, collected and sent together (`Storage::write_many`): one request on a supply
/// over a network. A step ends where the next read begins, so every read sees what the step wrote.
#[derive(Default)]
struct Batch {
    owed: Vec<Owed>,
    /// The step's changes to declared totals, by (account, total, group): count and sum added. `send` reads the
    /// touched rows once and writes each once.
    totals: BTreeMap<(String, String, String), (i64, i64)>,
}
/// One write a `Batch` holds: a put (`true`: only a key nobody holds, `false`: replace) or an erase of one key.
enum Owed {
    Put(&'static str, Vec<(&'static str, Value)>, bool),
    Erase(&'static str, Range<'static>),
}
impl Batch {
    fn put(&mut self, family: &'static str, row: Vec<(&'static str, Value)>, new: bool) {
        self.owed.push(Owed::Put(family, row, new));
    }
    fn erase(&mut self, family: &'static str, key: Vec<Value>) {
        self.owed.push(Owed::Erase(family, exact(key)));
    }
    fn len(&self) -> usize {
        self.owed.len()
    }
    /// Add `count` and `sum` to one declared total's group.
    fn total(&mut self, account: &str, total: &str, group: String, count: i64, sum: i64) {
        let held = self
            .totals
            .entry((account.to_owned(), total.to_owned(), group))
            .or_default();
        held.0 += count;
        held.1 += sum;
    }
    /// Send everything collected, in order, then the step's total rows (one batch read of the rows it touches, one
    /// write each); returns the rows the batch changed. The batch is empty afterwards.
    fn send<S: Storage>(&mut self, storage: &S) -> Result<u64, StorageError> {
        let mut owed = std::mem::take(&mut self.owed);
        let totals: Vec<_> = std::mem::take(&mut self.totals)
            .into_iter()
            .filter(|(_, delta)| *delta != (0, 0))
            .collect();
        if !totals.is_empty() {
            let keys: Vec<Vec<Value>> = totals
                .iter()
                .map(|((account, total, group), _)| vec![text(account), text(total), text(group)])
                .collect();
            let held = rows_by_key(
                storage,
                TOTALS,
                &keys,
                &[Field::whole("count"), Field::whole("sum")],
            )?;
            for (((account, total, group), (count, sum)), row) in totals.into_iter().zip(held) {
                let (before_count, before_sum) = match row {
                    Some(mut row) => (
                        row.take(0).as_integer().unwrap_or(0),
                        row.take(1).as_integer().unwrap_or(0),
                    ),
                    None => (0, 0),
                };
                let fields = vec![
                    ("account", text(&account)),
                    ("total", text(&total)),
                    ("group", text(&group)),
                    ("count", Value::Integer(before_count + count)),
                    ("sum", Value::Integer(before_sum + sum)),
                ];
                owed.push(Owed::Put(TOTALS, fields, false));
            }
        }
        if owed.is_empty() {
            return Ok(0);
        }
        let writes: Vec<Write<'_>> = owed
            .iter()
            .map(|one| match one {
                Owed::Put(family, row, new) => Write::Put {
                    family,
                    row,
                    when: if *new { When::New } else { When::Always },
                },
                Owed::Erase(family, range) => Write::Erase { family, range },
            })
            .collect();
        Ok(storage.write_many(&writes)?.into_iter().sum())
    }
}

fn unavailable(error: StorageError) -> Error {
    match error {
        // A full volume is the owner's disk pressure (the same refusal as the keep-free check), not a broken store.
        StorageError::DiskFull(cause) => Error::Refused(crate::resource_authority::Refusal::DiskPressure(cause.clone()), cause),
        other => Error::Unavailable(other.cause()),
    }
}
/// A failure inside a write scope may follow a commit the supply could not confirm.
fn uncertain(error: StorageError) -> Error {
    match error {
        StorageError::Conflict(cause) => Error::Conflict(cause),
        StorageError::TooBig(cause) => Error::Invalid("record exceeds the store's value bound", cause),
        error => Error::OutcomeUnknown(error.cause()),
    }
}
fn text(value: &str) -> Value {
    Value::Text(value.into())
}
fn validate(account: &str, resource: &str, id: &str) -> Result<(), Error> {
    if [account, resource, id]
        .iter()
        .any(|s| s.is_empty() || s.len() > 4096 || s.contains('\0'))
    {
        return Err(Error::Invalid(
            "record scope and ID must be nonempty, NUL-free and bounded",
         crate::cause!()));
    }
    // Every resource is declared, with its old source, in src/storage/record_store_resources.json; any other name is refused
    // before it is read or written, and named on stderr (resource names are code names, never values; the line
    // keeps at most 128 printable characters of it).
    if !crate::storage::record_store_resources::declares(resource) {
        let shown: String = resource
            .chars()
            .filter(|c| !c.is_control())
            .take(128)
            .collect();
        crate::quiet_eprintln!("record-store-undeclared-resource resource={shown:?} (no row in src/storage/record_store_resources.json)");
        return Err(Error::Invalid(
            "record store resource has no row in src/storage/record_store_resources.json",
         crate::cause!()));
    }
    Ok(())
}

impl Version {
    fn from_row(mut row: Row, valid_to: i64) -> Result<Self, Error> {
        let id = row
            .take(0)
            .as_text()
            .map(str::to_owned)
            .ok_or(crate::cause!(Error::Unavailable))?;
        let valid_from = row.take(1).as_integer().ok_or(crate::cause!(Error::Unavailable))?;
        let version = row.take(2).as_integer().ok_or(crate::cause!(Error::Unavailable))?;
        let deleted = row.take(3).as_integer().ok_or(crate::cause!(Error::Unavailable))? != 0;
        let body = match row.take(4) {
            Value::Blob(bytes) => Some(bytes),
            Value::Null => None,
            _ => return Err(crate::cause!(Error::Unavailable)),
        };
        let ring = row.take(5).as_text().map(str::to_owned);
        let kind = row.take(6).as_text().map(str::to_owned);
        let valid_to = match row.0.get(7) {
            Some(Value::Integer(to)) => *to,
            _ => valid_to,
        };
        Ok(Self {
            id,
            valid_from,
            valid_to,
            version,
            deleted,
            body,
            ring,
            kind,
        })
    }
    fn value(&self) -> Result<Option<serde_json::Value>, Error> {
        self.body
            .as_deref()
            .map(serde_json::from_slice)
            .transpose()
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }
    fn record(&self) -> Result<Option<Record>, Error> {
        if self.deleted {
            return Ok(None);
        }
        Ok(Some(Record {
            id: self.id.clone(),
            version: self.version,
            value: self.value()?.ok_or(crate::cause!(Error::Unavailable))?,
        }))
    }
    fn fields(&self, account: &str, resource: &str) -> Vec<(&'static str, Value)> {
        vec![
            ("account", text(account)),
            ("resource", text(resource)),
            ("id", text(&self.id)),
            ("valid_to", Value::Integer(self.valid_to)),
            ("valid_from", Value::Integer(self.valid_from)),
            ("version", Value::Integer(self.version)),
            ("deleted", Value::Integer(i64::from(self.deleted))),
            ("body", self.body.clone().map_or(Value::Null, Value::Blob)),
            ("ring", self.ring.clone().map_or(Value::Null, Value::Text)),
            ("kind", self.kind.clone().map_or(Value::Null, Value::Text)),
        ]
    }
}

/// Counts serialization without allocating another copy of a record body.
struct SerializedBytes(usize);
impl io::Write for SerializedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = crate::io_operation!((self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("serialized page length overflow"))).map_err(std::io::Error::from))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
/// Append one item while the serialized item array stays within `MAX_PAGE_BYTES` (a first item alone may be larger, up
/// to `one_item_page_bytes`); false when it would not fit.
fn append_bounded<T: Serialize>(
    items: &mut Vec<T>,
    total: &mut usize,
    item: T,
) -> Result<bool, Error> {
    let mut count = SerializedBytes(0);
    serde_json::to_writer(&mut count, &item).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let added = count.0 + usize::from(!items.is_empty());
    // One item larger than a page is a page of its own, up to `one_item_page_bytes` (old trillion
    // src/resource-state-carry.mjs:322-328: "A row larger than a page travels alone, as the first row of its own page").
    let alone = settings::shipped().map_or(MAX_PAGE_BYTES, |shipped| shipped.one_item_page_bytes);
    if added > MAX_PAGE_BYTES - *total && !(items.is_empty() && added <= alone) {
        if items.is_empty() {
            return Err(Error::Invalid(
                "one complete item exceeds the page byte bound",
             crate::cause!()));
        }
        return Ok(false);
    }
    *total += added;
    items.push(item);
    Ok(true)
}

impl<S: Storage> RecordStore<S> {
    /// The store over a supply opened for schema `record_store`, with the shipped settings and its host's `limits`
    /// (`settings::shipped()?.limits(host, volume)`).
    pub fn new(storage: S, clock: Box<dyn Clock>, limits: Limits) -> Result<Self, Error> {
        let settings =
            settings::shipped().ok_or(Error::Invalid("record store settings DATA is invalid", crate::cause!()))?;
        Self::with_settings(storage, clock, settings, limits)
    }

    /// The store with other settings DATA (a host's own, or a test's windows and budget).
    pub fn with_settings(
        storage: S,
        clock: Box<dyn Clock>,
        settings: &'static Settings,
        limits: Limits,
    ) -> Result<Self, Error> {
        if !settings.valid() || limits.max_record_bytes == 0 || limits.byte_budget == 0 {
            return Err(Error::Invalid("record store settings DATA is invalid", crate::cause!()));
        }
        if storage.schema().schema != SCHEMA {
            return Err(Error::Invalid(
                "the record store needs a supply of schema record_store",
             crate::cause!()));
        }
        Ok(Self {
            storage,
            clock,
            settings,
            referrer_parts: None,
            referrer_value_path: None,
            limits,
            stamps: HashMap::new(),
            keep_walks: RefCell::default(),
            stamps_mark: None,
            search_mark: Cell::new(None),
            work: Cell::new(Work::default()),
            filled: RefCell::default(),
            search: RefCell::default(),
            search_undo: Vec::new(),
            search_carried: false,
            written: Vec::new(),
            size: None,
            volume_reserve: None,
            measured: Cell::new(0),
            recovery: None,
            mirror: None,
        })
    }

    /// Use the current model's parts without changing the store's static bounds or other declarations. This is
    /// model DATA, not an index rebuild: same-write indexing and the existing signature-bound idle walk use it.
    pub fn set_referrer_parts(&mut self, parts: Vec<referrers::ReferrerPart>) -> Result<(), Error> {
        if !parts.iter().all(referrers::ReferrerPart::valid) {
            return Err(Error::Invalid("the model's referrer parts are invalid", crate::cause!()));
        }
        self.referrer_parts = Some(parts.into());
        self.referrer_value_path = None;
        Ok(())
    }

    /// Use logical model parts through one explicit value envelope. Only this composition-declared leaf may
    /// hold exact JSON text; ordinary logical part paths still require objects, as old partsOf did.
    pub fn set_referrer_model(
        &mut self,
        parts: Vec<referrers::ReferrerPart>,
        value_path: Option<Vec<String>>,
    ) -> Result<(), Error> {
        if value_path.as_ref().is_some_and(|path| {
            path.is_empty()
                || path
                    .iter()
                    .any(|step| step.is_empty() || step.contains('\0'))
        }) {
            return Err(Error::Invalid("the model's value envelope is invalid", crate::cause!()));
        }
        self.set_referrer_parts(parts)?;
        self.referrer_value_path = value_path;
        Ok(())
    }

    /// The explicit value-envelope path, when this store holds exact logical JSON inside an envelope.
    pub fn referrer_value_path(&self) -> Option<&[String]> {
        self.referrer_value_path.as_deref()
    }

    /// The current model's parts, or the store's declared parts when no composition supplied a model.
    pub fn referrer_parts(&self) -> &[referrers::ReferrerPart] {
        self.referrer_parts
            .as_deref()
            .unwrap_or(&self.settings.referrer_parts)
    }

    /// Run under `row` (an account's plan or contract row, or the computer's own; `store_size::resolve`) instead of the
    /// shipped default. A row that does not hold is refused and the store keeps the row it had.
    pub fn set_size_row(&mut self, row: store_size::SizeRow) -> Result<(), Error> {
        if !row.valid() {
            return Err(Error::Invalid("the store size row is invalid", crate::cause!()));
        }
        self.size = Some(std::sync::Arc::new(row));
        Ok(())
    }

    /// The resources of `account` this store holds records of (any version, a tombstone included), in order, at most
    /// `most`: one seek each, skipping every row of the resource before.
    pub fn resources_held(&self, account: &str, most: usize) -> Result<Vec<String>, Error> {
        let mut held: Vec<String> = Vec::new();
        while held.len() < most {
            let from = match held.last() {
                // The first key after every row of `last`: SQLite reads a row-value `>` over a key prefix by stepping
                // through each row of that prefix (83 s past one resource of 48 GB), and seeks a `>=` one. A resource
                // name is text, so `last` and a NUL is the next name after it.
                Some(last) => Bound::Included(vec![text(account), text(&format!("{last}\0"))]),
                None => Bound::Included(vec![text(account)]),
            };
            let range = Range {
                order: Order::Key,
                from,
                to: Bound::Included(vec![text(account)]),
                reverse: false,
                limit: Some(1),
            };
            let Some(mut row) = self
                .scan_rows(VERSIONS, &range, &[Field::whole("resource")])
                .map_err(unavailable)?
                .pop()
            else {
                break;
            };
            match row.take(0).as_text() {
                Some(resource) => held.push(resource.to_string()),
                None => return Err(crate::cause!(Error::Unavailable)),
            }
        }
        Ok(held)
    }

    /// Every write keeps its records in the settle store of its scope too (`mirror_settle`), whatever the settings
    /// say: the copies turn it on for every store they open (`src/account/computers/copies.rs`), so the account's
    /// replicated records keep their settle state, while any other store writes only its own rows (one row per create
    /// plus its orders, `tests/records_conformance.rs`).
    pub fn mirrored(mut self, on: bool) -> Self {
        self.mirror = Some(on);
        self
    }

    fn mirrors(&self) -> bool {
        self.mirror.unwrap_or(self.settings.settle_mirror)
    }

    /// Run with `recovery` (one per store file, `FullStoreRecovery::for_store`): a write at a level that waits for
    /// recovery runs it first (`recover_full`).
    pub fn with_recovery(
        mut self,
        recovery: std::sync::Arc<full_store::FullStoreRecovery>,
    ) -> Self {
        self.recovery = Some(recovery);
        self
    }

    /// The full-store recovery of this store (old trillion src/full-store-recovery.mjs, `nativeStoreRecovery`), for the
    /// scope `account`/`resource` a call is in: when the store's level waits for recovery, run its steps once, each one
    /// bounded page of derived or expired space: the size report, the scope's expired history, tombstones and custody
    /// (one exit step, `retire`: replaced versions past `keep_ms` at most `full_store_rows_per_step`, the rest past the
    /// undo window), and free pages back to the volume (`reclaim_step`). The current version of every record stays.
    /// `None` when the store has no recovery, is not full, or a recovery that freed nothing ran within `idle_ms`.
    pub fn recover_full(
        &mut self,
        account: &str,
        resource: &str,
        reason: &str,
    ) -> Result<Option<full_store::Recovered>, Error> {
        use full_store::{Freed, Step};
        let Some(recovery) = self.recovery.clone() else {
            return Ok(None);
        };
        let (full, bytes, level) = {
            let level = self.level()?;
            (
                level.waits_for_recovery(),
                level.bytes,
                level.id().map(str::to_owned),
            )
        };
        let now = self.clock.now_ms();
        let history_rows = self
            .settings
            .history
            .full_store_rows_per_step
            .max(self.settings.exit_step_rows);
        let said = (bytes, level.clone());
        let cell = RefCell::new(self);
        let recovered = recovery.recover(full, reason, now, || (Some(bytes), level), || vec![
            Step { id: "size-report", run: Box::new(|| {
                crate::quiet_eprintln!("{}", serde_json::json!({"full_store_inventory": {"bytes": said.0, "level": said.1}}));
                Ok(Freed::default())
            }) },
            Step { id: "expired-history", run: Box::new(|| {
                let removed = cell.borrow_mut().retire(account, resource)?;
                Ok(Freed { freed: removed > 0, more: removed >= history_rows as u64 })
            }) },
            Step { id: "free-pages", run: Box::new(|| {
                // Pages given back to the volume lower the store's measured size, but they free no room inside it (a
                // write already reuses a free page), and the exit step's own write may take the page back: this step
                // never counts as freed, so a store whose only gain is free pages goes idle like one full of records.
                let store = cell.borrow();
                let left = store.reclaim_step()?.left();
                store.measured.set(store.storage.allocated_bytes().map_err(unavailable)?);
                Ok(Freed { freed: false, more: left > 0 })
            }) },
        ]);
        Ok(recovered)
    }

    /// The size row this store runs under.
    pub fn size_row(&self) -> &store_size::SizeRow {
        self.size
            .as_deref()
            .unwrap_or(&self.settings.store_size.default)
    }

    /// Where the store stands on its size row now (one read of its allocated bytes): its level, whether it refuses
    /// growth (a host refuses a growth command, or sends it to the next store, `record_store_resources::Books`), and whether
    /// calls wait for recovery.
    pub fn level(&self) -> Result<store_size::Level<'_>, Error> {
        let bytes = self.storage.allocated_bytes().map_err(unavailable)?;
        self.measured.set(bytes);
        Ok(self.size_row().level(bytes))
    }

    /// Rows read and seeks made since the store was opened.
    pub fn work(&self) -> Work {
        self.work.get()
    }
    /// Count `seeks` point reads or ordered seeks that together returned `rows` rows. Work is counted in logical
    /// reads, so a batch read of k keys counts k seeks whatever the supply's network cost.
    fn count(&self, seeks: usize, rows: usize) {
        let mut work = self.work.get();
        work.seeks += seeks as u64;
        work.rows_read += rows as u64;
        self.work.set(work);
    }
    /// The work of one read, as its supplier-labelled observation.
    fn since(&self, start: Work) -> serde_json::Value {
        let now = self.work.get();
        json!({"supplier": "record_store", "seeks": now.seeks - start.seeks, "rows_read": now.rows_read - start.rows_read})
    }
    pub fn storage(&self) -> &S {
        &self.storage
    }
    pub fn settings(&self) -> &'static Settings {
        self.settings
    }
    pub fn limits(&self) -> Limits {
        self.limits
    }

    fn get_row(&self, key: &[Value], read: &[Field<'_>]) -> Result<Option<Row>, StorageError> {
        let row = self.storage.get(VERSIONS, key, read)?;
        self.count(1, usize::from(row.is_some()));
        Ok(row)
    }
    fn scan_rows(
        &self,
        family: &str,
        range: &Range<'_>,
        read: &[Field<'_>],
    ) -> Result<Vec<Row>, StorageError> {
        let rows = self.storage.scan(family, range, read)?;
        self.count(1, rows.len());
        Ok(rows)
    }

    /// The current rows of several records of one scope, in the order asked (`None`: no such record), in one batch
    /// read. The same answers, and the same counted work, as `current` for each id.
    fn currents(
        &self,
        account: &str,
        resource: &str,
        ids: &[&str],
    ) -> Result<Vec<Option<Version>>, Error> {
        let mut found = Vec::with_capacity(ids.len());
        for ids in ids.chunks(READ_BATCH) {
            let keys: Vec<Vec<Value>> = ids
                .iter()
                .map(|id| {
                    vec![
                        text(account),
                        text(resource),
                        text(id),
                        Value::Integer(CURRENT),
                    ]
                })
                .collect();
            let rows = rows_by_key(&self.storage, VERSIONS, &keys, &ROW).map_err(unavailable)?;
            self.count(rows.len(), rows.iter().flatten().count());
            for row in rows {
                found.push(row.map(|row| Version::from_row(row, CURRENT)).transpose()?);
            }
        }
        Ok(found)
    }

    /// The current row of a record (live or tombstone).
    fn current(&self, account: &str, resource: &str, id: &str) -> Result<Option<Version>, Error> {
        self.get_row(
            &[
                text(account),
                text(resource),
                text(id),
                Value::Integer(CURRENT),
            ],
            &ROW,
        )
        .map_err(unavailable)?
        .map(|row| Version::from_row(row, CURRENT))
        .transpose()
    }

    /// The version of a record live at stamp `at`: the first `versions` row after (id, at). One seek, one row.
    fn version_at(
        &self,
        account: &str,
        resource: &str,
        id: &str,
        at: i64,
    ) -> Result<Option<Version>, Error> {
        let scope = [text(account), text(resource), text(id)];
        let range = Range {
            order: Order::Key,
            from: Bound::Excluded(vec![
                scope[0].clone(),
                scope[1].clone(),
                scope[2].clone(),
                Value::Integer(at),
            ]),
            to: Bound::Included(scope.to_vec()),
            reverse: false,
            limit: Some(1),
        };
        let row = self
            .scan_rows(VERSIONS, &range, &FULL_ROW)
            .map_err(unavailable)?
            .pop();
        Ok(row
            .map(|row| Version::from_row(row, CURRENT))
            .transpose()?
            .filter(|version| version.valid_from <= at))
    }

    /// The newest committed stamp of a scope: its newest current change and its newest replacement.
    fn newest_stamp(&self, account: &str, resource: &str) -> Result<i64, StorageError> {
        let scope = vec![text(account), text(resource)];
        let mut newest = 0;
        for (order, field) in [("changed", "valid_from"), ("ending", "valid_to")] {
            let range = Range {
                order: Order::Named(order),
                from: Bound::Included(scope.clone()),
                to: Bound::Included(scope.clone()),
                reverse: false,
                limit: Some(1),
            }
            .reverse();
            if let Some(mut row) = self
                .scan_rows(VERSIONS, &range, &[Field::whole(field)])?
                .pop()
            {
                newest = newest.max(row.take(0).as_integer().unwrap_or(0));
            }
        }
        Ok(newest)
    }

    /// Mint the next stamp of a scope inside its write scope. The caller records it only after commit.
    fn mint(&mut self, account: &str, resource: &str) -> Result<i64, StorageError> {
        let key = (account.to_owned(), resource.to_owned());
        let last = match self.stamps.get(&key) {
            Some(last) => *last,
            None => self.newest_stamp(account, resource)?,
        };
        let now = self.clock.now_ms().max(0).min(i64::MAX >> 16) << 16;
        Ok(now.max(last + 1))
    }

    /// Stage a version row: a current row replaces the record's current row, a replaced one is new.
    fn put_version(batch: &mut Batch, account: &str, resource: &str, version: &Version) {
        batch.put(
            VERSIONS,
            version.fields(account, resource),
            version.valid_to != CURRENT,
        );
    }

    /// Keep what the store derives from a record equal to its current value. Its rows in every declared order: a row
    /// is written or moved only when the ordered value changes (0 rows when it does not), and removed when the record
    /// is deleted or erased. Every declared total of its kind: the value before leaves its group, the value after
    /// joins its group (`Batch::send` writes each touched total row once per step).
    fn index_derived(
        &self,
        batch: &mut Batch,
        account: &str,
        resource: &str,
        id: &str,
        before: Option<&serde_json::Value>,
        after: Option<&serde_json::Value>,
    ) -> Result<(), Error> {
        self.index_derived_planned(
            batch, account, resource, id, before, after, &mut MutationPlan::default(),
        )
    }

    fn index_derived_planned(
        &self,
        batch: &mut Batch,
        account: &str,
        resource: &str,
        id: &str,
        before: Option<&serde_json::Value>,
        after: Option<&serde_json::Value>,
        plan: &mut MutationPlan,
    ) -> Result<(), Error> {
        for declared in &self.settings.orders {
            let value_in = |value: Option<&serde_json::Value>| -> Result<Option<Vec<u8>>, Error> {
                match value {
                    Some(value) => {
                        orders::value_of(declared, self.kind_of(value).as_deref(), value)
                    }
                    None => Ok(None),
                }
            };
            let (old, new) = (value_in(before)?, value_in(after)?);
            let carried = |value: Option<&serde_json::Value>| {
                value.and_then(|value| orders::carried_of(declared, value))
            };
            let (old_carry, new_carry) = (carried(before), carried(after));
            if old == new && (new.is_none() || old_carry == new_carry) {
                continue;
            }
            let key = |value: Vec<u8>| {
                vec![
                    text(account),
                    text(resource),
                    text(&declared.order),
                    Value::Blob(value),
                    text(id),
                ]
            };
            if let Some(old) = old {
                if old_carry.is_some() {
                    batch.erase(ORDER_CARRY, key(old.clone()));
                }
                batch.erase(ORDERED, key(old));
            }
            if let Some(new) = new {
                if let Some(carry) = new_carry {
                    let mut row: Vec<(&'static str, Value)> =
                        ["account", "resource", "order", "value", "id"]
                            .into_iter()
                            .zip(key(new.clone()))
                            .collect();
                    row.push(("carried", Value::Blob(carry)));
                    batch.put(ORDER_CARRY, row, false);
                }
                batch.put(
                    ORDERED,
                    ["account", "resource", "order", "value", "id"]
                        .into_iter()
                        .zip(key(new))
                        .collect(),
                    false,
                );
            }
        }
        self.index_referrers(batch, account, resource, id, before, after)?;
        let before_kind = before.and_then(|value| self.kind_of(value));
        let after_kind = after.and_then(|value| self.kind_of(value));
        for declared in &self.settings.totals {
            // A declaration for another kind has no dependency on this mutation.
            // Check kind participation before even asking for its fill frontier.
            if before_kind.as_deref() != Some(declared.kind.as_str())
                && after_kind.as_deref() != Some(declared.kind.as_str())
            {
                continue;
            }
            let key = (account.to_owned(), declared.total.clone());
            if !plan.total_fills.contains_key(&key) {
                plan.total_fills
                    .insert(key.clone(), self.total_fill(account, &declared.total)?);
            }
            // While a fill of this total walks the account, only the records it has passed are counted by a write;
            // the walk counts the rest as it reaches them, at their value then.
            if let Some(TotalFill {
                signature,
                after,
                complete: false,
            }) = plan.total_fills.get(&key).and_then(Option::as_ref)
            {
                let passed = after.as_ref().is_some_and(|(walked_resource, walked_id)| {
                    (resource, id) <= (walked_resource.as_str(), walked_id.as_str())
                });
                if *signature == totals::signature_of(declared) && !passed {
                    continue;
                }
            }
            for (value, sign) in [(before, -1), (after, 1)] {
                let Some(value) = value else { continue };
                if let Some((group, sum)) =
                    totals::contribution(declared, self.kind_of(value).as_deref(), value)?
                {
                    batch.total(account, &declared.total, group, sign, sign * sum);
                }
            }
        }
        Ok(())
    }

    /// One change, inside the caller's write scope. Returns the change and whether it was newly applied.
    fn apply(
        &mut self,
        account: &str,
        resource: &str,
        input: &Mutation,
        identity: &str,
        check: &mut dyn FnMut() -> Result<(), Error>,
        plan: &mut MutationPlan,
    ) -> Result<Written<Change>, Error> {
        // The stamp this change would take, so that its current row and the exit step's ranges are read together.
        let at = self.mint(account, resource).map_err(uncertain)?;
        let exit = self.exit_ranges(account, resource, at).map_err(uncertain)?;
        let key = [
            text(account),
            text(resource),
            text(&input.id),
            Value::Integer(CURRENT),
        ];
        let (mut replies, released) = self
            .read_with_exit(
                &[Query::Get {
                    family: VERSIONS,
                    key: &key,
                    read: &ROW,
                }],
                &exit,
            )
            .map_err(unavailable)?;
        let row = replies
            .pop()
            .ok_or(crate::cause!(Error::Unavailable))?
            .row()
            .map_err(unavailable)?;
        self.count(1, usize::from(row.is_some()));
        let current = row.map(|row| Version::from_row(row, CURRENT)).transpose()?;
        let ring = match &current {
            Some(current) => Ring::parse(current.ring.as_deref()).ok_or(crate::cause!(Error::Unavailable))?,
            None => Ring::default(),
        };
        if let Some(receipt) = ring.find(&input.request_key).cloned() {
            if receipt.identity != identity {
                return Err(crate::cause!(Error::Conflict));
            }
            let value = if receipt.deleted {
                None
            } else {
                let written = match &current {
                    Some(current) if current.valid_from == receipt.at => Some(current.clone()),
                    _ => self.version_at(account, resource, &input.id, receipt.at)?,
                };
                written
                    .and_then(|version| version.value().transpose())
                    .transpose()?
            };
            check()?;
            let change = Change {
                sequence: receipt.at,
                id: input.id.clone(),
                version: receipt.version,
                deleted: receipt.deleted,
                value,
            };
            return Ok(Written::Keep(change));
        }
        if input.deleted && !input.value.is_null() {
            return Err(Error::Invalid("a delete must not include a new value", crate::cause!()));
        }
        let held = current.as_ref().map_or(0, |current| current.version);
        if input.expected_version != held || (held == 0 && input.deleted) {
            return Err(crate::cause!(Error::Conflict));
        }
        // An unchanged write (the value the record already holds) writes nothing: no version, no history, no receipt,
        // nothing derived (old trillion record-log-store.mjs write: "nothing changed, nothing written"). Its retry,
        // while the record still holds that value, is answered the same way. No receipt is kept, because callers that
        // make the next request key from the version (secrets.rs, own_records.rs) would find their next change's key
        // already taken by the unchanged one.
        if let Some(current) = current
            .as_ref()
            .filter(|current| !current.deleted && !input.deleted)
        {
            if current.value()?.as_ref() == Some(&input.value) {
                check()?;
                let change = Change {
                    sequence: current.valid_from,
                    id: input.id.clone(),
                    version: current.version,
                    deleted: false,
                    value: Some(input.value.clone()),
                };
                return Ok(Written::Keep(change));
            }
        }
        let version = input.expected_version + 1;
        let body = (!input.deleted)
            .then(|| serde_json::to_vec(&input.value))
            .transpose()
            .map_err(|_| Error::Invalid("invalid record value", crate::cause!()))?;
        let before = match &current {
            Some(current) if !current.deleted => current.value()?,
            _ => None,
        };
        let mut batch = Batch::default();
        // A resource whose row says `overwrite` (src/storage/record_store_resources.json `history`) keeps no history row: the
        // current row below is rewritten where it is, and the replaced version's pages go back to the file's free list.
        if let Some(current) = current
            .as_ref()
            .filter(|_| !crate::storage::record_store_resources::overwrites(resource))
        {
            let replaced = Version {
                valid_to: at,
                ring: None,
                ..current.clone()
            };
            Self::put_version(&mut batch, account, resource, &replaced);
        }
        let receipt = Receipt {
            request: input.request_key.clone(),
            identity: identity.to_owned(),
            version,
            at,
            deleted: input.deleted,
        };
        let next = Version {
            id: input.id.clone(),
            valid_from: at,
            valid_to: CURRENT,
            version,
            deleted: input.deleted,
            body,
            ring: Some(
                ring.after(receipt, &self.settings.receipts)
                    .text()
                    .ok_or(crate::cause!(Error::Unavailable))?,
            ),
            kind: self.kind_of(&input.value),
        };
        Self::put_version(&mut batch, account, resource, &next);
        self.written.push(Changed {
            scope: None, resource: resource.to_owned(),
            kind: next.kind.clone(),
            id: input.id.clone(),
            sequence: at,
        });
        let after = (!input.deleted).then_some(&input.value);
        self.search_changed(account, resource, &input.id, at, after)
            .map_err(uncertain)?;
        self.index_derived_planned(
            &mut batch,
            account,
            resource,
            &input.id,
            before.as_ref(),
            after,
            plan,
        )?;
        self.exit_stage(&mut batch, account, resource, released)
            .map_err(uncertain)?;
        batch.send(&self.storage).map_err(uncertain)?;
        let bytes = self.storage.allocated_bytes().map_err(uncertain)?;
        self.measured.set(bytes);
        if bytes > self.limits.byte_budget {
            return Err(Error::Invalid("the store's byte budget would be exceeded", crate::cause!()));
        }
        check()?;
        let change = Change {
            sequence: at,
            id: input.id.clone(),
            version,
            deleted: input.deleted,
            value: after.cloned(),
        };
        Ok(Written::Commit(change, Some(at)))
    }

    /// Run one write in one scope of the supply. `Commit(value, stamp)` commits and records the scope's newest
    /// stamp; `Keep(value)` (an answered retry, nothing to do) and every error roll back, so nothing is half done.
    /// After a commit that removed custody, the store is rewritten so destroyed bytes leave its files.
    fn write<T>(
        &mut self,
        account: &str,
        resource: &str,
        work: impl FnOnce(&mut Self) -> Result<Written<T>, Error>,
    ) -> Result<T, Error> {
        self.check_room()?;
        // A native command may lend its already-open IMMEDIATE transaction to
        // record store so its command's kept reply and record value commit together. Join
        // that write with a savepoint; never try a second BEGIN, and never
        // turn a read transaction into a writer.
        let intent = if self.storage.scoped() {
            if !self.storage.writing().map_err(|error| Error::Unavailable(error.cause()))? {
                return Err(crate::cause!(Error::Unavailable));
            }
            Intent::Nested
        } else {
            Intent::Write
        };
        self.storage
            .open_scope(intent)
            .map_err(|error| Error::Unavailable(error.cause()))?;
        self.written.clear();
        // Another store on the same storage (another connection, process or host) may have committed since this one
        // last wrote: inside the write reservation, its commits move the mark, and the caches derived from stored
        // rows are dropped before anything is minted from them.
        let mark = match self.storage.mark() {
            Ok(mark) => mark,
            Err(_) => {
                self.storage.close_scope(false).map_err(uncertain)?;
                return Err(crate::cause!(Error::Unavailable));
            }
        };
        if self.stamps_mark != Some(mark) {
            self.stamps.clear();
            self.stamps_mark = Some(mark);
        }
        self.search_observe(mark);
        // The scope's search memory is loaded before the write changes anything, so it reflects committed rows only. A load
        // that fails answers its own cause (a deadline, a step budget, an unreadable segment), not a bare refusal.
        if let Err(error) = self.search_load(account, resource) {
            self.storage.close_scope(false).map_err(uncertain)?;
            return Err(unavailable(error));
        }
        match work(self) {
            Ok(Written::Commit(value, stamp)) => {
                if let Err(error) = self.mirror_settle(account) {
                    // The settle store is written in the same scope: a write it cannot follow is not made.
                    self.written.clear();
                    self.search_rollback();
                    self.storage.close_scope(false).map_err(uncertain)?;
                    return Err(error);
                }
                if let Err(error) = self.storage.close_scope(true) {
                    // The commit may have happened: forget the cached stamp and search memory so the next use recovers them.
                    // Its changes are not published: a reader learns of them at the next change, or from a Gap.
                    self.written.clear();
                    self.stamps
                        .remove(&(account.to_owned(), resource.to_owned()));
                    self.search_forget(account, resource);
                    return Err(uncertain(error));
                }
                let written = std::mem::take(&mut self.written);
                if intent == Intent::Nested {
                    // Durable only when the lending owner commits: held for it (`changes::publish_held`).
                    changes::hold(account, written);
                    // The outer owner can still roll back after our savepoint
                    // closes. Drop in-memory state that would then lie about
                    // the rows; the next use reads the transaction itself. Carried
                    // search memory stands: its shared search memory drops it on that rollback.
                    if self.search_carried {
                        self.search_commit();
                    } else {
                        self.search_forget(account, resource);
                    }
                    self.stamps
                        .remove(&(account.to_owned(), resource.to_owned()));
                } else {
                    self.search_commit();
                    if let Some(stamp) = stamp {
                        self.stamps
                            .insert((account.to_owned(), resource.to_owned()), stamp);
                    }
                    if let Some(notifier) =
                        changes::AccountChanges::of(account).filter(|_| !written.is_empty())
                    {
                        notifier.publish(written);
                    }
                }
                Ok(value)
            }
            Ok(Written::Keep(value)) => {
                self.written.clear();
                self.search_rollback();
                self.storage
                    .close_scope(false)
                    .map_err(|error| Error::Unavailable(error.cause()))?;
                Ok(value)
            }
            Err(error) => {
                self.written.clear();
                self.search_rollback();
                // The work failed before any commit was asked for, so nothing of it is durable whether or not the
                // rollback is confirmed: a storage failure inside it (`uncertain`: a deadline interrupt, a full disk)
                // is certainly undone, never an outcome unknown. Only a commit the supply could not confirm is
                // (the `close_scope(true)` arm above). A rollback that fails leaves the handle refusing later scopes
                // until it is closed, and SQLite discards the open transaction then.
                let closed = self.storage.close_scope(false);
                Err(match error {
                    Error::OutcomeUnknown(cause) => Error::Unavailable(cause),
                    _ if closed.is_err() => Error::Unavailable(closed.unwrap_err().cause()),
                    error => error,
                })
            }
        }
    }

    /// Makes every record this write changed (`written`) into the settle store of its scope (`record_log.rs`, families
    /// `settle_*` beside `versions` in the same file), inside the write's own scope: the record and its settle state
    /// commit together or not at all. So the settle store is the account's actual records, at the writer and at every
    /// copy (a copy takes the writer's changes through this same write, `follow.rs` `apply_carried_at`), and two
    /// computers' settle roots are equal exactly when they hold the same records with the same stamps (`mirror_stamp`
    /// of the writer's sequence). Each record as this write left it: its object value whole, a value that is not an
    /// object whole under the field `value`, or a removal (a deleted or erased record). Off when the settings say so
    /// (`settle_mirror`), or when the storage declares no settle families.
    fn mirror_settle(&self, account: &str) -> Result<(), Error> {
        if self.written.is_empty() || !self.mirrors() {
            return Ok(());
        }
        if !self
            .storage
            .present("settle_log")
            .map_err(|error| Error::Unavailable(error.cause()))?
        {
            return Ok(());
        }
        // The last change of each record per resource, in the order first written.
        let mut by_resource: Vec<(String, Vec<(String, String, i64)>)> = Vec::new();
        // Keep first-write order without walking the resource and record vectors
        // again for each change. Both maps are bounded by this command's changes.
        let mut resources = BTreeMap::new();
        let mut positions = BTreeMap::new();
        for changed in &self.written {
            let at = *resources.entry(changed.resource.as_str()).or_insert_with(|| {
                by_resource.push((changed.resource.clone(), Vec::new()));
                by_resource.len() - 1
            });
            let records = &mut by_resource[at].1;
            let kind = changed.kind.clone().unwrap_or_default();
            let key = (changed.resource.as_str(), changed.id.as_str());
            if let Some(&position) = positions.get(&key) {
                let held: &mut (String, String, i64) = &mut records[position];
                held.1 = kind;
                held.2 = held.2.max(changed.sequence);
            } else {
                positions.insert(key, records.len());
                records.push((changed.id.clone(), kind, changed.sequence));
            }
        }
        for (resource, records) in by_resource {
            let ids: Vec<&str> = records.iter().map(|(id, ..)| id.as_str()).collect();
            let mut values = Vec::with_capacity(ids.len());
            for chunk in ids.chunks(READ_BATCH) {
                values.extend(self.get_many(account, &resource, chunk)?);
            }
            let rows: Vec<(&str, &str, Option<stamps::Fields>, String)> = records
                .iter()
                .zip(values)
                .map(|((id, kind, sequence), record)| {
                    (
                        id.as_str(),
                        kind.as_str(),
                        record.map(|record| settle_fields(record.value)),
                        record_log::mirror_stamp(*sequence),
                    )
                })
                .collect();
            let mut log = record_log::RecordLog::new(&self.storage, account, &resource);
            log.mirror(&rows, record_sync::Actor::by("write"))
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        }
        Ok(())
    }

    /// Carries scope (`account`, `resource`)'s records into its settle store once (`carry.rs` `carry`, from `Versions`):
    /// for a store whose records were written before every write kept its settle state. In one write scope, so no write
    /// lands between its pages; marked done beside the store (`settle_positions`, copy `FILLED`), so it runs once. A
    /// carry that does not read back, or whose source moved, refuses and leaves nothing (it is run again). Answers what
    /// it carried, None when the scope was filled already or the settings keep no settle state.
    pub fn fill_settle(
        &self,
        account: &str,
        resource: &str,
    ) -> Result<Option<carry::Carried>, Error> {
        use record_sync::SettleStore;
        if !self.mirrors()
            || !self
                .storage
                .present("settle_log")
                .map_err(|error| Error::Unavailable(error.cause()))?
        {
            return Ok(None);
        }
        validate(account, resource, "fill")?;
        let mut log = record_log::RecordLog::new(&self.storage, account, resource);
        if log
            .position(FILLED)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
            .is_some()
        {
            return Ok(None);
        }
        let intent = if self.storage.scoped() {
            Intent::Nested
        } else {
            Intent::Write
        };
        let scope = super::Scope::begin(&self.storage, intent).map_err(|error| Error::Unavailable(error.cause()))?;
        let source = carry::Versions {
            store: self,
            account,
            resource,
        };
        let carried =
            carry::carry(&source, &mut log, carry::CarryBounds::default()).map_err(|error| {
                crate::quiet_eprintln!(
                    "record-store-fill-refused resource={resource:?} status={} why={:?}",
                    error.status, error.message
                );
                crate::cause!(Error::Unavailable)
            })?;
        log.move_position(FILLED, Some("done"), "seed")
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        scope.commit().map_err(uncertain)?;
        Ok(Some(carried))
    }

    /// Mutate on an already trusted local owner's storage supply, including a
    /// supply lent from that owner's open SQLite transaction. The caller's
    /// current-rights check runs inside record store's nested write scope and again
    /// before a recovered retry's kept reply is disclosed. The outer owner must
    /// commit its command/result identity in the same transaction; this does
    /// not switch the native account writer away from its original journal.
    pub fn mutate_local_with_check(
        &mut self,
        account: &str,
        resource: &str,
        input: Mutation,
        check: impl FnMut() -> Result<(), Error>,
    ) -> Result<Change, Error> {
        self.mutate_with_check(
            account,
            resource,
            input,
            self.limits.max_record_bytes,
            check,
        )
    }

    fn mutate_with_check(
        &mut self,
        account: &str,
        resource: &str,
        input: Mutation,
        max_record_bytes: usize,
        mut check: impl FnMut() -> Result<(), Error>,
    ) -> Result<Change, Error> {
        validate(account, resource, &input.id)?;
        if input.expected_version < 0
            || input.expected_version == i64::MAX
            || input.request_key.is_empty()
            || input.request_key.len() > 1024
        {
            return Err(Error::Invalid(
                "a bounded stable request key and valid expected version are required",
             crate::cause!()));
        }
        let encoded =
            serde_json::to_vec(&input.value).map_err(|_| Error::Invalid("invalid record value", crate::cause!()))?;
        if encoded.len() > max_record_bytes {
            return Err(Error::Invalid("record exceeds the host's record bound", crate::cause!()));
        }
        // A write at a level that waits for recovery runs the store's recovery first (old trillion store-size.json:22:
        // "calls wait for verified recovery first"; src/full-store-recovery.mjs). The write then goes on and answers
        // its own outcome, whatever the recovery freed.
        if self.recovery.is_some()
            && !self.storage.scoped()
            && self
                .size_row()
                .level(self.measured.get())
                .waits_for_recovery()
        {
            let _ = self.recover_full(account, resource, "write");
        }
        let identity = blake3::hash(
            &serde_json::to_vec(&(
                account,
                resource,
                &input.id,
                input.expected_version,
                input.deleted,
                &input.value,
            ))
            .map_err(|_| Error::Invalid("invalid record value", crate::cause!()))?,
        )
        .to_hex()
        .to_string();
        self.write(account, resource, |store| {
            check()?;
            store.apply(
                account, resource, &input, &identity, &mut check, &mut MutationPlan::default(),
            )
        })
    }

    /// Several records in one write (old trillion record-log-store.mjs `write(records)`: one transaction, one log row):
    /// each change as `mutate` makes it, in the order given, all committed together or none. A retry of the whole
    /// batch answers each change as first made. An id may appear once.
    pub fn mutate_many(
        &mut self,
        account: &str,
        resource: &str,
        inputs: Vec<Mutation>,
    ) -> Result<Vec<Change>, Error> {
        validate(account, resource, "mutate_many")?;
        if inputs.is_empty() || inputs.len() > crate::record_log::MAX_BATCH_RECORDS {
            return Err(Error::Invalid(
                "a batch names 1 to MAX_BATCH_RECORDS records",
             crate::cause!()));
        }
        let mut identities = Vec::with_capacity(inputs.len());
        let mut seen = HashSet::new();
        for input in &inputs {
            validate(account, resource, &input.id)?;
            if !seen.insert(input.id.as_str()) {
                return Err(Error::Invalid("a batch names each record once", crate::cause!()));
            }
            if input.expected_version < 0
                || input.expected_version == i64::MAX
                || input.request_key.is_empty()
                || input.request_key.len() > 1024
            {
                return Err(Error::Invalid(
                    "a bounded stable request key and valid expected version are required",
                 crate::cause!()));
            }
            let encoded = serde_json::to_vec(&input.value)
                .map_err(|_| Error::Invalid("invalid record value", crate::cause!()))?;
            if encoded.len() > self.limits.max_record_bytes {
                return Err(Error::Invalid("record exceeds the host's record bound", crate::cause!()));
            }
            identities.push(
                blake3::hash(
                    &serde_json::to_vec(&(
                        account,
                        resource,
                        &input.id,
                        input.expected_version,
                        input.deleted,
                        &input.value,
                    ))
                    .map_err(|_| Error::Invalid("invalid record value", crate::cause!()))?,
                )
                .to_hex()
                .to_string(),
            );
        }
        self.write(account, resource, |store| {
            let (mut changes, mut newest, mut committed) =
                (Vec::with_capacity(inputs.len()), None, false);
            // These mutations never move total-fill frontiers. Reuse those witnesses
            // only while this write reservation holds; rollback/retry starts a new plan.
            let mut plan = MutationPlan::default();
            for (input, identity) in inputs.iter().zip(&identities) {
                let written = store.apply(
                    account, resource, input, identity, &mut || Ok(()), &mut plan,
                )?;
                match written {
                    Written::Commit(change, stamp) => {
                        committed = true;
                        if let Some(stamp) = stamp {
                            // The scope's cache moves with each minted stamp so the next record gets a later one.
                            store
                                .stamps
                                .insert((account.to_owned(), resource.to_owned()), stamp);
                            newest = Some(stamp);
                        }
                        changes.push(change);
                    }
                    Written::Keep(change) => changes.push(change),
                }
            }
            Ok(if committed {
                Written::Commit(changes, newest)
            } else {
                Written::Keep(changes)
            })
        })
        .inspect_err(|_| {
            // A refused batch rolled back the stamps it minted; recover the scope's stamp from storage next time.
            self.stamps
                .remove(&(account.to_owned(), resource.to_owned()));
        })
    }

    /// The newest committed stamp of a scope (0 when nothing was written): an as-of read at it answers the scope as it
    /// is now, and a change feed started after it hears only later changes. Two seeks, at most two rows.
    pub fn stamp(&self, account: &str, resource: &str) -> Result<i64, Error> {
        validate(account, resource, "stamp")?;
        self.newest_stamp(account, resource).map_err(unavailable)
    }

    /// The version a write to `id` must name as `expected_version`: the current row's version, a deletion's tombstone
    /// included, or 0 when the id never held a record. One seek, one row.
    pub fn held_version(&self, account: &str, resource: &str, id: &str) -> Result<i64, Error> {
        validate(account, resource, id)?;
        Ok(self
            .current(account, resource, id)?
            .map_or(0, |version| version.version))
    }

    /// The current stored record and its held version come from the same
    /// current-row seek. A deleted current row still supplies its tombstone
    /// version, so a later compare-and-set mutation cannot reuse version 0.
    pub fn held_record_with_version(
        &self,
        account: &str,
        resource: &str,
        id: &str,
    ) -> Result<(i64, Option<Record>), Error> {
        validate(account, resource, id)?;
        let current = self.current(account, resource, id)?;
        let version = current.as_ref().map_or(0, |row| row.version);
        let record = current.map(|row| row.record()).transpose()?.flatten();
        Ok((version, record))
    }

    /// The record as it was at stamp `at` (a change sequence): one seek, one row, whatever its history size.
    /// The current record (`Records::get` without the record contract's `Send` bound: over a lent transaction too).
    pub fn current_record(
        &self,
        account: &str,
        resource: &str,
        id: &str,
    ) -> Result<Option<Record>, Error> {
        validate(account, resource, id)?;
        self.current(account, resource, id)?
            .map(|version| version.record())
            .transpose()
            .map(Option::flatten)
    }

    pub fn as_of(&self, account: &str, resource: &str, id: &str, at: i64) -> Result<Read, Error> {
        validate(account, resource, id)?;
        let start = self.work.get();
        let record = self
            .version_at(account, resource, id, at)?
            .map(|version| version.record())
            .transpose()?
            .flatten();
        Ok(Read {
            record,
            work: self.since(start),
        })
    }

    /// Destroy one record: every version moves into custody in one scope, unreachable by every read at once. The
    /// operator may `restore` it until the undo window ends; then the exit step removes it physically.
    pub fn erase(
        &mut self,
        account: &str,
        resource: &str,
        id: &str,
    ) -> Result<Option<Erased>, Error> {
        validate(account, resource, id)?;
        self.write(account, resource, |store| {
            let key = vec![text(account), text(resource), text(id)];
            let rows = store
                .scan_rows(VERSIONS, &exact(key.clone()), &FULL_ROW)
                .map_err(uncertain)?;
            if rows.is_empty() {
                return Ok(Written::Keep(None));
            }
            let erased_at = store.mint(account, resource).map_err(uncertain)?;
            let mut tombstone = None;
            let mut batch = Batch::default();
            for row in &rows {
                let version = Version::from_row(row.clone(), CURRENT)?;
                if version.valid_to == CURRENT {
                    // Its order rows leave with it (a live record has them; a tombstone already lost them).
                    if !version.deleted {
                        store.index_derived(
                            &mut batch,
                            account,
                            resource,
                            id,
                            version.value()?.as_ref(),
                            None,
                        )?;
                    }
                    // The destroyed record keeps only a tombstone: its version (so compare-and-set continues) and
                    // its kept replies (so a retried request is answered, never applied again). No value.
                    tombstone = Some(Version {
                        valid_from: erased_at,
                        version: version.version + 1,
                        deleted: true,
                        body: None,
                        ..version.clone()
                    });
                }
                let mut fields = version.fields(account, resource);
                fields.push(("erased_at", Value::Integer(erased_at)));
                batch.put(CUSTODY, fields, true);
            }
            batch.erase(VERSIONS, key.clone());
            store
                .search_erase(account, resource, id)
                .map_err(uncertain)?;
            // The settle log keeps no value of an erased record either (`record_log.rs` `erase_values`); the write's
            // settle mirror then keeps it as a removal.
            if store.mirrors() && store.storage.present("settle_log").map_err(uncertain)? {
                record_log::RecordLog::new(&store.storage, account, resource)
                    .erase_values(id)
                    .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            }
            if let Some(tombstone) = &tombstone {
                Self::put_version(&mut batch, account, resource, tombstone);
                store.written.push(Changed {
                    scope: None, resource: resource.to_owned(),
                    kind: tombstone.kind.clone(),
                    id: id.to_owned(),
                    sequence: erased_at,
                });
            }
            batch.send(&store.storage).map_err(uncertain)?;
            store
                .exit_step(account, resource, erased_at)
                .map_err(uncertain)?;
            Ok(Written::Commit(
                Some(Erased {
                    erased_at,
                    versions: rows.len() as u64,
                }),
                Some(erased_at),
            ))
        })
    }

    /// The operator's restore of a destroyed record still in custody. Refused when the record exists again; false
    /// when custody no longer holds it (its undo window ended).
    ///
    /// A restore is a new change, at a new stamp, so a change feed (by stamp) carries it to every copy: the versions
    /// come back from custody as history (the one current at the erase closed at the erase stamp), the erase's
    /// tombstone stays as history until the restore stamp (an as-of read between the two answers the record deleted, as
    /// readers saw it then), and the record's newest version comes back as a new version at the restore stamp, one above
    /// the tombstone's, with the record's kept replies. The restore is marked (`follow::mark_restored`) so the feed tells a
    /// copy that holds the erase to bring the versions back from its own custody too.
    pub fn restore(
        &mut self,
        erased: &Erased,
        account: &str,
        resource: &str,
        id: &str,
    ) -> Result<bool, Error> {
        validate(account, resource, id)?;
        self.write(account, resource, |store| {
            let mut batch = Batch::default();
            // Only the destruction's own tombstone may stand where the record is restored.
            let tombstone = match store.current(account, resource, id)? {
                None => None,
                Some(current) if current.deleted && current.valid_from == erased.erased_at => {
                    Some(current)
                }
                Some(_) => return Err(crate::cause!(Error::Conflict)),
            };
            let key = vec![
                Value::Integer(erased.erased_at),
                text(account),
                text(resource),
                text(id),
            ];
            let rows = store
                .scan_rows(CUSTODY, &exact(key.clone()), &FULL_ROW)
                .map_err(uncertain)?;
            if rows.is_empty() {
                return Ok(Written::Keep(false));
            }
            let restored_at = store.mint(account, resource).map_err(uncertain)?;
            let mut live = None;
            for row in rows {
                let version = Version::from_row(row, CURRENT)?;
                if version.valid_to == CURRENT {
                    live = Some(version);
                } else {
                    Self::put_version(&mut batch, account, resource, &version);
                }
            }
            let live = live.ok_or(crate::cause!(Error::Unavailable))?;
            let closed_at = tombstone
                .as_ref()
                .map_or(restored_at, |tombstone| tombstone.valid_from);
            Self::put_version(
                &mut batch,
                account,
                resource,
                &Version {
                    valid_to: closed_at,
                    ring: None,
                    ..live.clone()
                },
            );
            let ring = match &tombstone {
                Some(tombstone) => {
                    Self::put_version(
                        &mut batch,
                        account,
                        resource,
                        &Version {
                            valid_to: restored_at,
                            ring: None,
                            ..tombstone.clone()
                        },
                    );
                    tombstone.ring.clone()
                }
                None => live.ring.clone(),
            };
            let version = tombstone
                .as_ref()
                .map_or(live.version, |tombstone| tombstone.version)
                .max(live.version)
                + 1;
            let next = Version {
                valid_from: restored_at,
                valid_to: CURRENT,
                version,
                ring,
                ..live
            };
            Self::put_version(&mut batch, account, resource, &next);
            if !next.deleted {
                let value = next.value()?;
                store
                    .search_changed(account, resource, id, restored_at, value.as_ref())
                    .map_err(uncertain)?;
                store.index_derived(&mut batch, account, resource, id, None, value.as_ref())?;
            }
            batch.erase(CUSTODY, key);
            follow::mark_restored(
                &mut batch,
                account,
                resource,
                id,
                restored_at,
                erased.erased_at,
            );
            batch.send(&store.storage).map_err(uncertain)?;
            store.written.push(Changed {
                scope: None, resource: resource.to_owned(),
                kind: next.kind.clone(),
                id: id.to_owned(),
                sequence: restored_at,
            });
            Ok(Written::Commit(true, Some(restored_at)))
        })
    }

    /// The kind a value declares in its `kind_field`, when that field is text.
    fn kind_of(&self, value: &serde_json::Value) -> Option<String> {
        value
            .get(&self.settings.kind_field)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    }

    /// One-way bulk load of records that do not exist yet (a migration): each becomes version 1 in one scope per
    /// call, with no kept replies (no client request made them). An id that already exists refuses the whole call, and so
    /// does a record above the host's record bound.
    pub fn import(
        &mut self,
        account: &str,
        resource: &str,
        records: &[(String, serde_json::Value)],
    ) -> Result<usize, Error> {
        validate(account, resource, "import")?;
        self.write(account, resource, |store| {
            let mut newest = None;
            let mut inserted = 0;
            // Which ids already exist is asked once, for the ids that pass validation, in the order the records come.
            let valid: Vec<&str> = records
                .iter()
                .map(|(id, _)| id.as_str())
                .filter(|id| validate(account, resource, id).is_ok())
                .collect();
            let mut held = store.currents(account, resource, &valid)?.into_iter();
            let mut taken: HashSet<&str> = HashSet::new();
            let mut batch = Batch::default();
            for (id, value) in records {
                validate(account, resource, id)?;
                // An id the call already took exists for the records after it, as it would after its own write.
                let existing = held.next().ok_or(crate::cause!(Error::Unavailable))?.is_some();
                if !taken.insert(id.as_str()) {
                    return Err(crate::cause!(Error::Conflict));
                }
                if existing {
                    return Err(crate::cause!(Error::Conflict));
                }
                let at = store.mint(account, resource).map_err(uncertain)?;
                // The scope's cache moves with each minted stamp so the next record gets a later one.
                store
                    .stamps
                    .insert((account.to_owned(), resource.to_owned()), at);
                let body = serde_json::to_vec(value)
                    .map_err(|_| Error::Invalid("invalid record value", crate::cause!()))?;
                if body.len() > store.limits.max_record_bytes {
                    return Err(Error::Invalid("record exceeds the host's record bound", crate::cause!()));
                }
                let version = Version {
                    id: id.clone(),
                    valid_from: at,
                    valid_to: CURRENT,
                    version: 1,
                    deleted: false,
                    body: Some(body),
                    ring: None,
                    kind: store.kind_of(value),
                };
                store.written.push(Changed {
                    scope: None, resource: resource.to_owned(),
                    kind: version.kind.clone(),
                    id: id.clone(),
                    sequence: at,
                });
                Self::put_version(&mut batch, account, resource, &version);
                store
                    .search_changed(account, resource, id, at, Some(value))
                    .map_err(uncertain)?;
                store.index_derived(&mut batch, account, resource, id, None, Some(value))?;
                if batch.len() >= WRITE_BATCH {
                    batch.send(&store.storage).map_err(uncertain)?;
                }
                newest = Some(at);
                inserted += 1;
            }
            batch.send(&store.storage).map_err(uncertain)?;
            if inserted == 0 {
                return Ok(Written::Keep(0));
            }
            if store.storage.allocated_bytes().map_err(uncertain)? > store.limits.byte_budget {
                return Err(Error::Invalid("the store's byte budget would be exceeded", crate::cause!()));
            }
            Ok(Written::Commit(inserted, newest))
        })
        .inspect_err(|_| {
            // A refused batch rolled back the stamps it minted; recover the scope's stamp from storage next time.
            self.stamps
                .remove(&(account.to_owned(), resource.to_owned()));
        })
    }

    /// The live records of `ids` in one scope, in the order asked (none for an absent or deleted id): one batch read.
    pub fn get_many(
        &self,
        account: &str,
        resource: &str,
        ids: &[&str],
    ) -> Result<Vec<Option<Record>>, Error> {
        validate(account, resource, "get_many")?;
        for id in ids {
            validate(account, resource, id)?;
        }
        self.currents(account, resource, ids)?
            .into_iter()
            .map(|version| {
                version
                    .map(|version| version.record())
                    .transpose()
                    .map(Option::flatten)
            })
            .collect()
    }

    /// Whether one exact id has a current, live record in this scope. The
    /// storage projection reads only the declared `deleted` field; it never
    /// fetches or decodes `body`. Tombstones and absent ids answer false.
    pub fn has_live_record(&self, account: &str, resource: &str, id: &str) -> Result<bool, Error> {
        validate(account, resource, id)?;
        let Some(mut row) = self
            .get_row(
                &[
                    text(account),
                    text(resource),
                    text(id),
                    Value::Integer(CURRENT),
                ],
                &CURRENT_EXISTS,
            )
            .map_err(unavailable)?
        else {
            return Ok(false);
        };
        match row.take(0).as_integer() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(crate::cause!(Error::Unavailable)),
        }
    }

    /// Where the fill of one total stands, None when none was ever kept.
    fn total_fill(&self, account: &str, total: &str) -> Result<Option<TotalFill>, Error> {
        let read = [
            Field::whole("signature"),
            Field::whole("after_resource"),
            Field::whole("after_id"),
            Field::whole("complete"),
        ];
        let Some(mut row) = self
            .storage
            .get(TOTALS_FILL, &[text(account), text(total)], &read)
            .map_err(unavailable)?
        else {
            return Ok(None);
        };
        let signature = row.take(0).as_text().ok_or(crate::cause!(Error::Unavailable))?.to_owned();
        let after = match (
            row.take(1).as_text().map(str::to_owned),
            row.take(2).as_text().map(str::to_owned),
        ) {
            (Some(resource), Some(id)) => Some((resource, id)),
            _ => None,
        };
        Ok(Some(TotalFill {
            signature,
            after,
            complete: row.take(3).as_integer() == Some(1),
        }))
    }
    fn put_total_fill(
        batch: &mut Batch,
        account: &str,
        total: &str,
        signature: &str,
        after: Option<(&str, &str)>,
        complete: bool,
    ) {
        batch.put(
            TOTALS_FILL,
            vec![
                ("account", text(account)),
                ("total", text(total)),
                ("signature", text(signature)),
                (
                    "after_resource",
                    after.map_or(Value::Null, |(resource, _)| text(resource)),
                ),
                ("after_id", after.map_or(Value::Null, |(_, id)| text(id))),
                ("complete", Value::Integer(i64::from(complete))),
            ],
            false,
        );
    }

    /// Whether a declared total's rows are the count of the account's records (old: a count, never a guess). False
    /// while its fill walks, or when its declaration changed since it was counted. A total counted from its
    /// declaration with no fill kept (every store before fills existed) is known.
    pub fn total_known(&self, account: &str, total: &str) -> Result<bool, Error> {
        let declared = self
            .settings
            .totals
            .iter()
            .find(|declared| declared.total == total)
            .ok_or(Error::Invalid("the total is not declared", crate::cause!()))?;
        Ok(match self.total_fill(account, total)? {
            None => true,
            Some(fill) => fill.complete && fill.signature == totals::signature_of(declared),
        })
    }

    /// One step of filling a declared total for an account whose records were written before it was declared (or
    /// under another declaration of it): first its rows leave, `limit` at a time; then the account's records are walked
    /// in key order, `limit` version rows a step, each live record of its kind counted; answers whether it is known.
    /// A total with rows and no fill kept was counted from its declaration and is adopted as it is.
    /// `resource` is the caller's scope its steps' writes run in (a total is account-wide: the walk covers every scope).
    pub fn fill_total(
        &mut self,
        account: &str,
        resource: &str,
        total: &str,
        limit: usize,
    ) -> Result<bool, Error> {
        validate(account, resource, total)?;
        if !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid page size", crate::cause!()));
        }
        let settings = self.settings;
        let declared = settings
            .totals
            .iter()
            .find(|declared| declared.total == total)
            .ok_or(Error::Invalid("the total is not declared", crate::cause!()))?;
        let signature = totals::signature_of(declared);
        let fill = self.total_fill(account, total)?;
        if fill
            .as_ref()
            .is_some_and(|fill| fill.complete && fill.signature == signature)
        {
            return Ok(true);
        }
        let rows_of = |store: &Self, limit: Option<usize>| -> Result<Vec<Row>, Error> {
            let key = vec![text(account), text(total)];
            let range = Range {
                order: Order::Key,
                from: Bound::Included(key.clone()),
                to: Bound::Included(key),
                reverse: false,
                limit,
            };
            store
                .scan_rows(TOTALS, &range, &[Field::whole("group")])
                .map_err(unavailable)
        };
        let walking = fill
            .as_ref()
            .is_some_and(|fill| fill.signature == signature);
        if !walking {
            if fill.is_none() && !rows_of(self, Some(1))?.is_empty() {
                // Counted from its declaration: adopted, one row written.
                self.write(account, resource, |store| {
                    let mut batch = Batch::default();
                    Self::put_total_fill(&mut batch, account, total, &signature, None, true);
                    batch.send(&store.storage).map_err(uncertain)?;
                    Ok(Written::Commit((), None))
                })?;
                return Ok(true);
            }
            // Its rows leave first; the walk starts once none is left, in the same write as the last of them.
            self.write(account, resource, |store| {
                let rows = rows_of(store, Some(limit + 1))?;
                let more = rows.len() > limit;
                let mut batch = Batch::default();
                for mut row in rows.into_iter().take(limit) {
                    batch.erase(TOTALS, vec![text(account), text(total), row.take(0)]);
                }
                if !more {
                    Self::put_total_fill(&mut batch, account, total, &signature, None, false);
                }
                batch.send(&store.storage).map_err(uncertain)?;
                Ok(Written::Commit((), None))
            })?;
            return Ok(false);
        }
        let after = fill.and_then(|fill| fill.after);
        self.write(account, resource, |store| {
            let scope = vec![text(account)];
            let from = match &after {
                Some((resource, id)) => {
                    Bound::Excluded(vec![text(account), text(resource), text(id)])
                }
                None => Bound::Included(scope.clone()),
            };
            let range = Range {
                order: Order::Key,
                from,
                to: Bound::Included(scope),
                reverse: false,
                limit: Some(limit),
            };
            let rows = store
                .scan_rows(
                    VERSIONS,
                    &range,
                    &[
                        Field::whole("resource"),
                        Field::whole("id"),
                        Field::whole("valid_to"),
                        Field::whole("deleted"),
                        Field::whole("body"),
                        Field::whole("kind"),
                    ],
                )
                .map_err(unavailable)?;
            let complete = rows.len() < limit;
            let mut batch = Batch::default();
            let mut last: Option<(String, String)> = None;
            for mut row in rows {
                let resource = row.take(0).as_text().ok_or(crate::cause!(Error::Unavailable))?.to_owned();
                let id = row.take(1).as_text().ok_or(crate::cause!(Error::Unavailable))?.to_owned();
                let current = row.take(2).as_integer() == Some(CURRENT)
                    && row.take(3).as_integer() == Some(0);
                let body = row.take(4);
                let kind = row.take(5);
                last = Some((resource, id));
                if !current || kind.as_text() != Some(declared.kind.as_str()) {
                    continue;
                }
                let Value::Blob(body) = body else { continue };
                let value: serde_json::Value =
                    serde_json::from_slice(&body).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                if let Some((group, sum)) =
                    totals::contribution(declared, Some(declared.kind.as_str()), &value)?
                {
                    batch.total(account, total, group, 1, sum);
                }
            }
            let at = last
                .as_ref()
                .map(|(resource, id)| (resource.as_str(), id.as_str()))
                .or(after
                    .as_ref()
                    .map(|(resource, id)| (resource.as_str(), id.as_str())));
            Self::put_total_fill(
                &mut batch,
                account,
                total,
                &signature,
                if complete { None } else { at },
                complete,
            );
            batch.send(&store.storage).map_err(uncertain)?;
            Ok(Written::Commit(complete, None))
        })
    }

    /// Every declared total of an account (`settings.totals`), one row per total and group: one range scan.
    pub fn totals(&self, account: &str) -> Result<Vec<totals::Total>, Error> {
        if account.is_empty() || account.len() > 4096 || account.contains('\0') {
            return Err(Error::Invalid(
                "record scope and ID must be nonempty, NUL-free and bounded",
             crate::cause!()));
        }
        let scope = vec![text(account)];
        let range = Range {
            order: Order::Key,
            from: Bound::Included(scope.clone()),
            to: Bound::Included(scope),
            reverse: false,
            limit: None,
        };
        let rows = self
            .scan_rows(
                TOTALS,
                &range,
                &[
                    Field::whole("total"),
                    Field::whole("group"),
                    Field::whole("count"),
                    Field::whole("sum"),
                ],
            )
            .map_err(unavailable)?;
        rows.into_iter()
            .map(|mut row| {
                let total = row
                    .take(0)
                    .as_text()
                    .map(str::to_owned)
                    .ok_or(crate::cause!(Error::Unavailable))?;
                let group = row
                    .take(1)
                    .as_text()
                    .filter(|group| !group.is_empty())
                    .map(str::to_owned);
                let count = row.take(2).as_integer().ok_or(crate::cause!(Error::Unavailable))?;
                let sum = row.take(3).as_integer().ok_or(crate::cause!(Error::Unavailable))?;
                Ok(totals::Total {
                    total,
                    group,
                    count,
                    sum,
                })
            })
            .collect()
    }

    /// Live ids of one kind, ascending, strictly after `after`. One ordered walk of `live_kind`: a copy that writes a kind
    /// into another store in this order appends at the right edge of that store's tree and fills its pages, where a
    /// descending copy leaves every page split half empty (a list's move, src/storage/record_store_resources/lists.rs:
    /// 48,258 rows copied descending kept 57% of the versions pages unused, 2026-11-14).
    pub fn ids_of_kind_after(
        &self,
        account: &str,
        resource: &str,
        kind: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<String>, Option<String>), Error> {
        validate(account, resource, kind)?;
        self.id_walk("live_kind", vec![text(account), text(resource), text(kind)], after, false, limit)
    }

    /// Live ids of one kind, descending, strictly before `before`. One ordered walk of `live_kind`.
    pub fn ids_of_kind(
        &self,
        account: &str,
        resource: &str,
        kind: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<String>, Option<String>), Error> {
        validate(account, resource, kind)?;
        self.id_walk(
            "live_kind",
            vec![text(account), text(resource), text(kind)],
            before,
            true,
            limit,
        )
    }

    /// How many live records of one kind a scope holds (old trillion record-log-store.mjs `count(type)` :3909): one count
    /// over the kind's own `live_kind` list, exact on every read. The old store kept counts in its projection and so
    /// answered null while an old projection was upgraded; nothing here is kept apart from the records, so there is no
    /// state in which a count could be a guess.
    pub fn count_of_kind(&self, account: &str, resource: &str, kind: &str) -> Result<u64, Error> {
        validate(account, resource, kind)?;
        let scope = vec![text(account), text(resource), text(kind)];
        let range = Range {
            order: Order::Named("live_kind"),
            from: Bound::Included(scope.clone()),
            to: Bound::Included(scope),
            reverse: false,
            limit: None,
        };
        let count = self.storage.count(VERSIONS, &range).map_err(unavailable)?;
        self.count(1, 0);
        Ok(count)
    }
    /// The count of each distinct kind asked, in first-asked order (old `countMany`): one count per kind.
    pub fn count_many(
        &self,
        account: &str,
        resource: &str,
        kinds: &[&str],
    ) -> Result<Vec<(String, u64)>, Error> {
        let mut out: Vec<(String, u64)> = Vec::new();
        for kind in kinds {
            if !out.iter().any(|(held, _)| held == kind) {
                out.push((
                    kind.to_string(),
                    self.count_of_kind(account, resource, kind)?,
                ));
            }
        }
        Ok(out)
    }

    /// Live ids of a scope, ascending, strictly after `after`, without their values. One ordered walk of `live`.
    pub fn ids(
        &self,
        account: &str,
        resource: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<String>, Option<String>), Error> {
        validate(account, resource, "ids")?;
        self.id_walk(
            "live",
            vec![text(account), text(resource)],
            after,
            false,
            limit,
        )
    }

    /// One page of ids from an order whose entries are `scope` then `id`, past the `cursor` id in walk direction.
    fn id_walk(
        &self,
        order: &'static str,
        scope: Vec<Value>,
        cursor: Option<&str>,
        reverse: bool,
        limit: usize,
    ) -> Result<(Vec<String>, Option<String>), Error> {
        if !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid page size", crate::cause!()));
        }
        let from = match cursor {
            Some(cursor) => {
                let mut past = scope.clone();
                past.push(text(cursor));
                Bound::Excluded(past)
            }
            None => Bound::Included(scope.clone()),
        };
        let range = Range {
            order: Order::Named(order),
            from,
            to: Bound::Included(scope),
            reverse,
            limit: Some(limit + 1),
        };
        let rows = self
            .scan_rows(VERSIONS, &range, &[Field::whole("id")])
            .map_err(unavailable)?;
        let more = rows.len() > limit;
        let ids: Vec<String> = rows
            .into_iter()
            .take(limit)
            .map(|mut row| {
                row.take(0)
                    .as_text()
                    .map(str::to_owned)
                    .ok_or(crate::cause!(Error::Unavailable))
            })
            .collect::<Result<_, _>>()?;
        let next = if more { ids.last().cloned() } else { None };
        Ok((ids, next))
    }

    /// One page of a bounded, resumable walk: at most `limit` ids along `order` under `scope`, past `after`, with each
    /// one's current version, and the id to continue after (None at the end). The one step every walk of records kept
    /// before something derived from them existed takes: the search walk (`segments.rs` `search_walk`), the holders
    /// walk (`referrers.rs` `walk_referrers`) and the order fill (`fill_order`), each in its own write scope with its
    /// cursor saved in the same write (old trillion record-log-store.mjs `buildIndexes` :2280 and `buildModel` :2318:
    /// keys and progress commit together, so a restart walks on from a place whose keys exist).
    pub(super) fn walk_page(
        &self,
        account: &str,
        resource: &str,
        order: &'static str,
        scope: Vec<Value>,
        after: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<(String, Option<Version>)>, Option<String>), Error> {
        let (ids, next) = self.id_walk(order, scope, after, false, limit)?;
        let versions = self.currents(
            account,
            resource,
            &ids.iter().map(String::as_str).collect::<Vec<_>>(),
        )?;
        Ok((ids.into_iter().zip(versions).collect(), next))
    }

    /// One page of live records in a declared order (`settings.orders`), past `cursor`, highest value first when
    /// `reverse`. One range scan over the order's rows plus one get per record shown.
    pub fn ordered_page(
        &self,
        account: &str,
        resource: &str,
        order: &str,
        cursor: Option<&OrderCursor>,
        reverse: bool,
        limit: usize,
    ) -> Result<Ordered, Error> {
        validate(account, resource, order)?;
        if !self
            .settings
            .orders
            .iter()
            .any(|declared| declared.order == order)
        {
            return Err(Error::Invalid("the order is not declared", crate::cause!()));
        }
        if !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid page size", crate::cause!()));
        }
        let start = self.work.get();
        if !self.order_filled(account, resource, order)? {
            return Err(Error::Invalid(
                "the order is not filled for this scope yet (fill_order)",
             crate::cause!()));
        }
        let scope = vec![text(account), text(resource), text(order)];
        let from = match cursor {
            Some(cursor) => {
                let mut past = scope.clone();
                past.extend([Value::Blob(cursor.value.clone()), text(&cursor.id)]);
                Bound::Excluded(past)
            }
            None => Bound::Included(scope.clone()),
        };
        let range = Range {
            order: Order::Key,
            from,
            to: Bound::Included(scope),
            reverse,
            limit: Some(limit + 1),
        };
        let rows = self
            .scan_rows(
                ORDERED,
                &range,
                &[Field::whole("value"), Field::whole("id")],
            )
            .map_err(unavailable)?;
        let more = rows.len() > limit;
        let mut shown = Vec::with_capacity(limit);
        for mut row in rows.into_iter().take(limit) {
            let (Value::Blob(value), Value::Text(id)) = (row.take(0), row.take(1)) else {
                return Err(crate::cause!(Error::Unavailable));
            };
            shown.push((value, id));
        }
        // The records of the whole page are read in one batch.
        let versions = self.currents(
            account,
            resource,
            &shown.iter().map(|(_, id)| id.as_str()).collect::<Vec<_>>(),
        )?;
        let (mut records, mut bytes, mut last, mut cut) = (Vec::new(), 2, None, false);
        for ((value, id), version) in shown.into_iter().zip(versions) {
            // An order row always has its live record: both change in one scope.
            let record = version
                .and_then(|version| version.record().transpose())
                .transpose()?;
            let record = record.ok_or(crate::cause!(Error::Unavailable))?;
            if !append_bounded(&mut records, &mut bytes, record)? {
                cut = true;
                break;
            }
            last = Some(OrderCursor { value, id });
        }
        let next = if more || cut { last } else { None };
        Ok(Ordered {
            records,
            next,
            work: self.since(start),
        })
    }

    /// Read a page of a scope's change feed without requiring its supply to be `Send`. This is the same bounded
    /// read used by the `Records` adapter, and lets an admitted read-only local handle retain the record contract.
    pub(crate) fn changes_page_readonly(
        &self,
        account: &str,
        resource: &str,
        after: i64,
        limit: usize,
    ) -> Result<Page<Change, i64>, Error> {
        validate(account, resource, "changes")?;
        if after < 0 || !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid change cursor or limit", crate::cause!()));
        }
        let start = self.work.get();
        let scope = vec![text(account), text(resource)];
        let mut from = scope.clone();
        from.push(Value::Integer(after));
        let range = Range {
            order: Order::Named("changed"),
            from: Bound::Excluded(from),
            to: Bound::Included(scope),
            reverse: false,
            limit: Some(limit + 1),
        };
        let rows = self
            .scan_rows(VERSIONS, &range, &ROW)
            .map_err(unavailable)?;
        let more = rows.len() > limit;
        let mut items = Vec::new();
        let mut bytes = 2;
        let mut cut = false;
        for row in rows.into_iter().take(limit) {
            let version = Version::from_row(row, CURRENT)?;
            let change = Change {
                sequence: version.valid_from,
                id: version.id.clone(),
                version: version.version,
                deleted: version.deleted,
                value: version.value()?,
            };
            if !append_bounded(&mut items, &mut bytes, change)? {
                cut = true;
                break;
            }
        }
        let next = if more || cut {
            items.last().map(|change: &Change| change.sequence)
        } else {
            None
        };
        Ok(Page {
            items,
            next,
            serialized_item_bytes: bytes,
            work: self.since(start),
        })
    }

    /// Whether every declared order of a scope holds every live record and every declared total is known: one row per
    /// order and total, read-only, so idle upkeep asks it before it takes a store's write to fill one
    /// (src/local_account/own_records.rs `fill_list_store_orders`).
    pub fn orders_filled(&self, account: &str, resource: &str) -> Result<bool, Error> {
        validate(account, resource, "orders_filled")?;
        for declared in &self.settings.orders {
            if !self.order_filled(account, resource, &declared.order)? {
                return Ok(false);
            }
        }
        for declared in &self.settings.totals {
            if !self.total_known(account, &declared.total)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Whether a declared order holds every live record of a scope. Read once per store and scope (1 row), then
    /// remembered: a filled order stays filled, since every write keeps its rows.
    fn order_filled(&self, account: &str, resource: &str, order: &str) -> Result<bool, Error> {
        let key = (account.to_owned(), resource.to_owned(), order.to_owned());
        if self.filled.borrow().contains(&key) {
            return Ok(true);
        }
        let row = self.storage.get(
            ORDER_STATE,
            &[text(account), text(resource), text(order)],
            &[Field::whole("complete")],
        );
        let mut row = row.map_err(unavailable)?;
        self.count(1, usize::from(row.is_some()));
        let mut complete = row
            .as_mut()
            .is_some_and(|row| row.take(0).as_integer() == Some(1));
        // A fill made under another declaration of this name is no fill of this one. A fill kept before signatures
        // were kept (no signature row) is taken as this declaration's: such stores were filled by the only one they had.
        if complete {
            let declared = self
                .settings
                .orders
                .iter()
                .find(|declared| declared.order == order);
            if let (Some(declared), Some(held)) =
                (declared, self.order_signature(account, resource, order)?)
            {
                complete = held == orders::signature_of(declared);
            }
        }
        // Remembered only outside a scope: a fill read or written inside a scope its caller lent can still be rolled
        // back with it, and the memory would then believe a fill that never committed (old record-log-store.mjs
        // maintenance admission: rolled-back progress is never cached).
        if complete && !self.storage.scoped() {
            self.filled.borrow_mut().insert(key);
        }
        Ok(complete)
    }

    /// Fill a declared order for the records a scope already holds (a store that existed before the order was
    /// declared): one write scope per call, at most `limit` live records, resumable after a restart. Writes keep
    /// the order's rows from the moment it is declared, so filling is only the past. Answers whether it is complete.
    pub fn fill_order(
        &mut self,
        account: &str,
        resource: &str,
        order: &str,
        limit: usize,
    ) -> Result<bool, Error> {
        validate(account, resource, order)?;
        let settings = self.settings;
        let declared = settings
            .orders
            .iter()
            .find(|declared| declared.order == order)
            .ok_or(Error::Invalid("the order is not declared", crate::cause!()))?;
        if self.order_filled(account, resource, order)? {
            return Ok(true);
        }
        let signature = orders::signature_of(declared);
        // A declaration changed under the same name (its kind, path or `then`): its rows were written under the old
        // one, so they leave first, a bounded step at a time, and the order fills from the start (old trillion
        // record-log-store.mjs: an index whose signature changed is dropped and built again).
        if self
            .order_signature(account, resource, order)?
            .is_some_and(|held| held != signature)
        {
            return self
                .unfill_order(account, resource, order, limit)
                .map(|_| false);
        }
        let complete = self.write(account, resource, |store| {
            let key = [text(account), text(resource), text(order)];
            let through = store
                .storage
                .get(ORDER_STATE, &key, &[Field::whole("filled_through")])
                .map_err(uncertain)?
                .and_then(|mut row| row.take(0).as_text().map(str::to_owned));
            // An order of one kind walks that kind's own list (old buildIndexes walked the index's type); one with no
            // kind walks every record of the scope.
            let (order_walked, scope) = match &declared.kind {
                Some(kind) => ("live_kind", vec![text(account), text(resource), text(kind)]),
                None => ("live", vec![text(account), text(resource)]),
            };
            let (page, next) = store.walk_page(
                account,
                resource,
                order_walked,
                scope,
                through.as_deref(),
                limit,
            )?;
            let mut batch = Batch::default();
            for (id, version) in &page {
                let Some(version) = version else { continue };
                let Some(value) = version.value()? else {
                    continue;
                };
                if let Some(ordered) =
                    orders::value_of(declared, store.kind_of(&value).as_deref(), &value)?
                {
                    let row = [
                        text(account),
                        text(resource),
                        text(order),
                        Value::Blob(ordered),
                        text(id),
                    ];
                    if let Some(carry) = orders::carried_of(declared, &value) {
                        let mut carried: Vec<(&'static str, Value)> =
                            ["account", "resource", "order", "value", "id"]
                                .into_iter()
                                .zip(row.clone())
                                .collect();
                        carried.push(("carried", Value::Blob(carry)));
                        batch.put(ORDER_CARRY, carried, false);
                    }
                    batch.put(
                        ORDERED,
                        ["account", "resource", "order", "value", "id"]
                            .into_iter()
                            .zip(row)
                            .collect(),
                        false,
                    );
                }
            }
            let complete = next.is_none();
            batch.put(
                ORDER_STATE,
                vec![
                    ("account", key[0].clone()),
                    ("resource", key[1].clone()),
                    ("order", key[2].clone()),
                    ("complete", Value::Integer(i64::from(complete))),
                    (
                        "filled_through",
                        page.last().map_or(Value::Null, |(id, _)| text(id)),
                    ),
                ],
                false,
            );
            batch.put(
                ORDER_SIGNATURES,
                vec![
                    ("account", key[0].clone()),
                    ("resource", key[1].clone()),
                    ("order", key[2].clone()),
                    ("signature", text(&signature)),
                ],
                false,
            );
            batch.send(&store.storage).map_err(uncertain)?;
            Ok(Written::Commit(complete, None))
        })?;
        if complete && !self.storage.scoped() {
            self.filled.borrow_mut().insert((
                account.to_owned(),
                resource.to_owned(),
                order.to_owned(),
            ));
        }
        Ok(complete)
    }

    /// The signature an order's fill was made under, None when none is kept (a fill from before signatures).
    fn order_signature(
        &self,
        account: &str,
        resource: &str,
        order: &str,
    ) -> Result<Option<String>, Error> {
        let row = self
            .storage
            .get(
                ORDER_SIGNATURES,
                &[text(account), text(resource), text(order)],
                &[Field::whole("signature")],
            )
            .map_err(unavailable)?;
        self.count(1, usize::from(row.is_some()));
        Ok(row.and_then(|mut row| row.take(0).as_text().map(str::to_owned)))
    }
    /// One step of taking an order's rows away (at most `limit`), then its fill state and signature once none is left.
    /// Answers whether the order is gone from the scope.
    fn unfill_order(
        &mut self,
        account: &str,
        resource: &str,
        order: &str,
        limit: usize,
    ) -> Result<bool, Error> {
        if !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid page size", crate::cause!()));
        }
        let gone = self.write(account, resource, |store| {
            let key = vec![text(account), text(resource), text(order)];
            let range = Range {
                order: Order::Key,
                from: Bound::Included(key.clone()),
                to: Bound::Included(key.clone()),
                reverse: false,
                limit: Some(limit + 1),
            };
            let rows = store
                .scan_rows(
                    ORDERED,
                    &range,
                    &[Field::whole("value"), Field::whole("id")],
                )
                .map_err(unavailable)?;
            let more = rows.len() > limit;
            let mut batch = Batch::default();
            for mut row in rows.into_iter().take(limit) {
                let (value, id) = (row.take(0), row.take(1));
                batch.erase(
                    ORDER_CARRY,
                    vec![
                        key[0].clone(),
                        key[1].clone(),
                        key[2].clone(),
                        value.clone(),
                        id.clone(),
                    ],
                );
                batch.erase(
                    ORDERED,
                    vec![key[0].clone(), key[1].clone(), key[2].clone(), value, id],
                );
            }
            if !more {
                batch.erase(ORDER_STATE, key.clone());
                batch.erase(ORDER_SIGNATURES, key.clone());
            }
            batch.send(&store.storage).map_err(uncertain)?;
            Ok(Written::Commit(!more, None))
        })?;
        self.filled.borrow_mut().remove(&(
            account.to_owned(),
            resource.to_owned(),
            order.to_owned(),
        ));
        Ok(gone)
    }

    /// Remove, from one scope, the rows of orders that are no longer declared (an order taken out of
    /// `settings.orders`): at most `limit` order rows in one write scope, then the order's fill state once none is
    /// left, so an order declared again later fills from the start. Answers whether no undeclared order is left.
    /// Writes only keep declared orders, so a record erased after its order was taken out would otherwise leave that
    /// order's row (its field text and id) behind.
    pub fn retire_orders(
        &mut self,
        account: &str,
        resource: &str,
        limit: usize,
    ) -> Result<bool, Error> {
        validate(account, resource, "retire_orders")?;
        if !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid page size", crate::cause!()));
        }
        let settings = self.settings;
        let scope = vec![text(account), text(resource)];
        let states = Range {
            order: Order::Key,
            from: Bound::Included(scope.clone()),
            to: Bound::Included(scope),
            reverse: false,
            limit: None,
        };
        let undeclared: Vec<String> = self
            .scan_rows(ORDER_STATE, &states, &[Field::whole("order")])
            .map_err(unavailable)?
            .into_iter()
            .filter_map(|mut row| row.take(0).as_text().map(str::to_owned))
            .filter(|order| {
                !settings
                    .orders
                    .iter()
                    .any(|declared| &declared.order == order)
            })
            .collect();
        let Some(order) = undeclared.first().cloned() else {
            return Ok(true);
        };
        self.unfill_order(account, resource, &order, limit)?;
        Ok(false)
    }

    /// One exit step for a scope nobody writes (a host timer's call). Returns the rows removed.
    pub fn retire(&mut self, account: &str, resource: &str) -> Result<u64, Error> {
        validate(account, resource, "retire")?;
        self.write(account, resource, |store| {
            let now = store.mint(account, resource).map_err(uncertain)?;
            let removed = store.exit_step(account, resource, now).map_err(uncertain)?;
            // The exit step mints no stamp of its own: the scope's recorded stamp stays where it was.
            Ok(Written::Commit(removed, None))
        })
    }

    /// The three ranges of an exit step at `now`: replaced versions, tombstones and custody that the undo window has
    /// released, at most `exit_step_rows` of each. History is bounded by bytes as well as time (`settings.json`
    /// `history`, old trillion src/record-history.json): once the store's last measured size reached the history's
    /// `from_level` of its size row, replaced versions older than `keep_ms` leave too, up to its rows per step.
    /// Tombstones and custody keep the undo window whatever the store's size, so an erasure stays restorable.
    /// A resource declared `overwrite` keeps no history (its current row is rewritten in place), so every replaced
    /// version it still holds, including those written before the rule, leaves at once: `now` is its horizon.
    fn exit_ranges(&self, account: &str, resource: &str, now: i64) -> Result<[Range<'static>; 3], StorageError> {
        let to_stamp = |ms: u64| i64::try_from(ms).unwrap_or(i64::MAX >> 16) << 16;
        let profile = crate::storage::record_store_resources::undo_of(resource);
        let horizon = now.saturating_sub(to_stamp(self.settings.undo_windows.of(profile)));
        let pressed = self
            .settings
            .history
            .pressed(&self.size_row().level(self.measured.get()));
        let (history_horizon, history_rows) = match pressed {
            // An overwrite keeps no history, so its replaced versions leave at once, except a vault's: those keep the vault's
            // undo window, so a put that overwrote a good value stays undoable for the window.
            _ if crate::storage::record_store_resources::overwrites(resource) && profile == crate::storage::record_store_resources::Undo::Records => {
                (now, self.settings.exit_step_rows)
            }
            _ if crate::storage::record_store_resources::overwrites(resource) => {
                (self.holder_horizon(account, resource, now, horizon)?, self.settings.exit_step_rows)
            }
            Some((keep_ms, rows)) => (
                now.saturating_sub(to_stamp(keep_ms)).max(horizon),
                rows.max(self.settings.exit_step_rows),
            ),
            None => (horizon, self.settings.exit_step_rows),
        };
        let scope = vec![text(account), text(resource)];
        let versions = |order, until: i64, rows: usize| {
            let mut to = scope.clone();
            to.push(Value::Integer(until));
            Range {
                order: Order::Named(order),
                from: Bound::Included(scope.clone()),
                to: Bound::Excluded(to),
                reverse: false,
                limit: Some(rows),
            }
        };
        let custody = Range {
            order: Order::Key,
            from: Bound::Unbounded,
            to: Bound::Excluded(vec![Value::Integer(horizon)]),
            reverse: false,
            limit: Some(self.settings.exit_step_rows),
        };
        Ok([
            versions("ending", history_horizon, history_rows),
            versions("gone", horizon, self.settings.exit_step_rows),
            custody,
        ])
    }

    /// Keep `reserve` free bytes on this store's volume: a write is refused before any SQL while the volume has less.
    pub fn with_volume_reserve(mut self, reserve: u64) -> Self {
        self.volume_reserve = Some(reserve);
        self
    }

    /// Refuse a write before any SQL when the volume has less free than the computer keeps (`disk_pressure`, D37). A
    /// volume that cannot say its free space (the hosted build) keeps no reserve to check.
    fn check_room(&self) -> Result<(), Error> {
        let (Some(reserve), Some(location)) = (self.volume_reserve, self.storage.location()) else { return Ok(()) };
        let free = match settings::volume_free_bytes(std::path::Path::new(location)) {
            Ok(free) => free,
            Err(error) if error.kind() == std::io::ErrorKind::Unsupported => return Ok(()),
            Err(_) => return Err(crate::cause!(Error::Unavailable)),
        };
        if free < reserve {
            return Err(Error::Refused(crate::resource_authority::Refusal::DiskPressure(crate::cause!()), crate::cause!()));
        }
        Ok(())
    }

    /// The horizon a vault's replaced versions may be pruned to: the undo window's, held back by the holders that have
    /// not pulled past them (`holders.rs`). Unknown holders keep every version (stamps are positive, so nothing ends
    /// before 0).
    fn holder_horizon(&self, account: &str, resource: &str, now: i64, window: i64) -> Result<i64, StorageError> {
        Ok(match &self.holder_guard() {
            HolderGuard::Unknown => 0,
            HolderGuard::Copy => window,
            HolderGuard::Writer(listed) => match self.holder_floor(account, resource, listed, now)? {
                Some(floor) => window.min(floor),
                None => window,
            },
        })
    }

    /// The holder guard of this store's file (`holders::set_guard`); Unknown when no owner set one.
    fn holder_guard(&self) -> HolderGuard {
        self.storage.location().map(|path| holders::guard_of(std::path::Path::new(path))).unwrap_or_default()
    }

    /// Answer the three ranges of `exit_ranges` after `first` queries, in one batch read; the answers to `first`
    /// come back with the rows the exit step will remove.
    fn read_with_exit(
        &self,
        first: &[Query<'_>],
        exit: &[Range<'static>; 3],
    ) -> Result<(Vec<Reply>, Released), StorageError> {
        let mut queries = first.to_vec();
        queries.extend([
            Query::Scan {
                family: VERSIONS,
                range: &exit[0],
                read: &EXIT_VERSIONS,
            },
            Query::Scan {
                family: VERSIONS,
                range: &exit[1],
                read: &EXIT_VERSIONS,
            },
            Query::Scan {
                family: CUSTODY,
                range: &exit[2],
                read: &EXIT_CUSTODY,
            },
        ]);
        let mut replies = self.storage.read_many(&queries)?;
        if replies.len() != queries.len() {
            return Err(crate::cause!(StorageError::Unavailable));
        }
        let mut answers = replies.split_off(first.len()).into_iter();
        let mut next = || answers.next().ok_or(crate::cause!(StorageError::Unavailable))?.rows();
        let released = Released {
            ending: next()?,
            gone: next()?,
            custody: next()?,
        };
        for rows in [&released.ending, &released.gone, &released.custody] {
            self.count(1, rows.len());
        }
        Ok((replies, released))
    }

    /// Stage the removal of `released` into `batch`, inside the caller's write scope. A destroyed record leaves
    /// custody only on a supply whose removals overwrite the removed bytes as they commit
    /// (`Storage::overwrites_removed`); on any other it stays in custody, unreachable as before, until an exit step on
    /// a supply that does (the account's own store) releases it, so its bytes never sit in free space.
    fn exit_stage(
        &mut self,
        batch: &mut Batch,
        account: &str,
        resource: &str,
        released: Released,
    ) -> Result<(), StorageError> {
        // A resource that archives its history (`history_archive.rs`) lets its replaced versions leave only once a
        // kept, verified file holds them; its archive step removes them, never the exit step.
        let ending = if self.settings.history_archive.covers(resource) {
            Vec::new()
        } else {
            released.ending
        };
        for rows in [ending, released.gone] {
            for mut row in rows {
                let (id, valid_to) = (row.take(0), row.take(1));
                batch.erase(VERSIONS, vec![text(account), text(resource), id, valid_to]);
            }
        }
        if !released.custody.is_empty() && self.storage.overwrites_removed()? {
            for row in &released.custody {
                batch.erase(CUSTODY, row.0.clone());
            }
        }
        Ok(())
    }

    /// One short step of giving freed space back to the volume (`Storage::reclaim_step`, at most the settings'
    /// `reclaim_step_pages`), outside any write: the account's owner runs it between requests. Answers the free pages
    /// left for later steps.
    pub fn reclaim_step(&self) -> Result<Reclaim, Error> {
        self.reclaim_pages(self.settings.reclaim_step_pages)
    }

    /// `reclaim_step` of at most `pages`, never more than the settings' `reclaim_step_pages`: a caller that bounds each
    /// step by time as well asks for fewer pages when a step ran long.
    pub fn reclaim_pages(&self, pages: u64) -> Result<Reclaim, Error> {
        match self.storage.reclaim_step(pages.clamp(1, self.settings.reclaim_step_pages)) {
            Ok(left) => Ok(Reclaim::Freed(left)),
            Err(StorageError::NeedsRewrite(_)) => Ok(Reclaim::NeedsRewrite),
            Err(error) => Err(unavailable(error)),
        }
    }

    /// The one-time vacuum of a store file that is not yet incremental auto-vacuum (`settings.json` `vacuum`): once its
    /// free pages are the DATA share of its pages, the volume has `free_disk_factor` times the file's size free, and the
    /// scope has been idle for `idle_ms`, one full vacuum (`Storage::reclaim`) runs, and the file is incremental from then
    /// on, so `reclaim_step` gives the free pages back without another rewrite. Answers what was done, or why not yet.
    /// `free_disk` is the volume's free bytes now (the caller reads them from the file's volume).
    pub fn vacuum_if_due(&self, account: &str, resource: &str, free_disk: u64) -> Result<VacuumStep, Error> {
        validate(account, resource, "vacuum")?;
        let rule = &self.settings.vacuum;
        let Some(state) = self.storage.vacuum_state().map_err(unavailable)? else {
            return Ok(VacuumStep::NotDue("the supply keeps no file of its own"));
        };
        if state.incremental {
            return Ok(VacuumStep::NotDue("the file is already incremental auto-vacuum"));
        }
        let file = state.pages * state.page_size;
        if file == 0 || (state.free_pages as f64) < rule.free_fraction * state.pages as f64 {
            return Ok(VacuumStep::NotDue("the free pages are below the DATA share of the file"));
        }
        let idle_ms = clock_ms(&*self.clock).saturating_sub(stamp_ms(self.newest_stamp(account, resource).map_err(unavailable)?));
        if idle_ms < rule.idle_ms {
            return Ok(VacuumStep::NotDue("the scope has not been idle for the DATA window"));
        }
        if (free_disk as f64) < rule.free_disk_factor * file as f64 {
            return Ok(VacuumStep::NotDue("the volume has less free than the DATA factor times the file"));
        }
        crate::quiet_eprintln!("{}", json!({"store_vacuum": {"phase": "before", "file_bytes": file, "free_pages": state.free_pages, "free_disk_bytes": free_disk}}));
        match self.storage.reclaim() {
            Ok(()) => {}
            // A writer holds the file: the VACUUM yields at once, and the next turn tries again.
            Err(StorageError::Busy(_)) => return Ok(VacuumStep::Busy),
            Err(error) => return Err(unavailable(error)),
        }
        let after = self.storage.vacuum_state().map_err(unavailable)?.map_or(file, |state| state.pages * state.page_size);
        crate::quiet_eprintln!("{}", json!({"store_vacuum": {"phase": "after", "file_bytes": after, "freed_bytes": file.saturating_sub(after)}}));
        Ok(VacuumStep::Vacuumed { before: file, after })
    }

    /// The most pages one reclaim step gives back (settings `reclaim_step_pages`).
    pub fn reclaim_step_pages(&self) -> u64 {
        self.settings.reclaim_step_pages
    }

    /// Remove, inside the caller's write scope, at most `exit_step_rows` per family of what the undo window has
    /// released: replaced versions, tombstones and custody (`exit_stage`). Returns the rows removed.
    fn exit_step(&mut self, account: &str, resource: &str, now: i64) -> Result<u64, StorageError> {
        let exit = self.exit_ranges(account, resource, now)?;
        let (_, released) = self.read_with_exit(&[], &exit)?;
        let mut batch = Batch::default();
        self.exit_stage(&mut batch, account, resource, released)?;
        batch.send(&self.storage)
    }
}

/// What one reclaim step (`RecordStore::reclaim_step`) answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reclaim {
    /// The free pages the store has left after the step.
    Freed(u64),
    /// The file is not yet incremental auto-vacuum, so its free pages come back only through the one-time vacuum
    /// (`vacuum_if_due`), which the idle pass runs next.
    NeedsRewrite,
}

impl Reclaim {
    /// The free pages left after the step; 0 when the file first needs its one-time vacuum.
    pub fn left(self) -> u64 {
        match self {
            Self::Freed(left) => left,
            Self::NeedsRewrite => 0,
        }
    }
}

/// What `RecordStore::vacuum_if_due` did: the file's bytes before and after its vacuum, the rule that holds it back, or
/// `Busy` when a writer held the file, so the VACUUM yielded and the next turn tries again.
#[derive(Debug, PartialEq, Eq)]
pub enum VacuumStep {
    Vacuumed { before: u64, after: u64 },
    NotDue(&'static str),
    Busy,
}

/// The rows an exit step removes, by family: replaced versions, tombstones and custody.
struct Released {
    ending: Vec<Row>,
    gone: Vec<Row>,
    custody: Vec<Row>,
}

/// What one write leaves: commit (with the stamp it minted, if any) or keep nothing.
enum Written<T> {
    Commit(T, Option<i64>),
    Keep(T),
}

/// Where an ordered page ends: the last record's order value and id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderCursor {
    pub value: Vec<u8>,
    pub id: String,
}

/// One page of records in a declared order, the cursor past it (none at the end), and the reads it made.
#[derive(Debug, Serialize)]
pub struct Ordered {
    pub records: Vec<Record>,
    pub next: Option<OrderCursor>,
    pub work: serde_json::Value,
}

/// The records a search found, newest change first, and the reads it made.
#[derive(Debug, Serialize)]
pub struct Found {
    pub records: Vec<Record>,
    pub work: serde_json::Value,
}

/// Rows by key in one batch read: one answer per key, in the order asked (`None`: no such row).
fn rows_by_key<S: Storage>(
    storage: &S,
    family: &str,
    keys: &[Vec<Value>],
    read: &[Field<'_>],
) -> Result<Vec<Option<Row>>, StorageError> {
    let queries: Vec<Query<'_>> = keys
        .iter()
        .map(|key| Query::Get { family, key, read })
        .collect();
    storage
        .read_many(&queries)?
        .into_iter()
        .map(Reply::row)
        .collect()
}

/// The rows whose cursor starts with `prefix` (a full key selects one row).
fn exact(prefix: Vec<Value>) -> Range<'static> {
    Range {
        order: Order::Key,
        from: Bound::Included(prefix.clone()),
        to: Bound::Included(prefix),
        reverse: false,
        limit: None,
    }
}

// The record contract for admitted operations and local transports; the old supply's error translation is not needed
// because this store speaks the record contract's errors throughout.
impl<S: Storage + Send> Records for RecordStore<S> {
    fn get(&self, account: &str, resource: &str, id: &str) -> Result<Read, Error> {
        validate(account, resource, id)?;
        let start = self.work.get();
        let record = self
            .current(account, resource, id)?
            .map(|version| version.record())
            .transpose()?
            .flatten();
        Ok(Read {
            record,
            work: self.since(start),
        })
    }

    fn mutate(&mut self, account: &str, resource: &str, input: Mutation) -> Result<Change, Error> {
        let bound = self.limits.max_record_bytes;
        self.mutate_with_check(account, resource, input, bound, || Ok(()))
    }

    fn list_page(
        &self,
        account: &str,
        resource: &str,
        after: &str,
        limit: usize,
    ) -> Result<Page<Record, String>, Error> {
        validate(account, resource, "page")?;
        if after.len() > 4096 || after.contains('\0') || !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid record cursor or page size", crate::cause!()));
        }
        let start = self.work.get();
        let scope = vec![text(account), text(resource)];
        let mut from = scope.clone();
        from.push(text(after));
        let range = Range {
            order: Order::Named("live"),
            from: Bound::Excluded(from),
            to: Bound::Included(scope),
            reverse: false,
            limit: Some(limit + 1),
        };
        let rows = self
            .scan_rows(VERSIONS, &range, &ROW)
            .map_err(unavailable)?;
        let more = rows.len() > limit;
        let mut items = Vec::new();
        let mut bytes = 2;
        let mut cut = false;
        for row in rows.into_iter().take(limit) {
            let Some(record) = Version::from_row(row, CURRENT)?.record()? else {
                continue;
            };
            if !append_bounded(&mut items, &mut bytes, record)? {
                cut = true;
                break;
            }
        }
        let next = if more || cut {
            items.last().map(|record: &Record| record.id.clone())
        } else {
            None
        };
        Ok(Page {
            items,
            next,
            serialized_item_bytes: bytes,
            work: self.since(start),
        })
    }

    fn changes_page(
        &self,
        account: &str,
        resource: &str,
        after: i64,
        limit: usize,
    ) -> Result<Page<Change, i64>, Error> {
        self.changes_page_readonly(account, resource, after, limit)
    }

    /// Remote writes use the immutable admitted input and the client-owned retry key. The check runs inside the same
    /// scope as the bytes and the kept reply, before a recovered kept reply is disclosed and before commit.
    fn mutate_admitted(
        &mut self,
        call: &AdmittedCall,
        context: &dyn CommitContext,
    ) -> Result<Change, Error> {
        if call.scope().operation != "record.mutate" {
            return Err(Error::Invalid(
                "the admitted operation is not record.mutate",
             crate::cause!()));
        }
        let input: AdmittedMutation = serde_json::from_value(call.input().clone())
            .map_err(|_| Error::Invalid("invalid record request", crate::cause!()))?;
        let mutation = Mutation {
            id: input.id,
            expected_version: input.expected_version,
            request_key: call.owned_request_key().into(),
            deleted: input.deleted,
            value: input.value,
        };
        let scope = call.scope();
        // A remote call also keeps the record contract's bound, whatever the host allows.
        let bound = self.limits.max_record_bytes.min(MAX_RECORD_BYTES);
        self.mutate_with_check(
            &scope.account_id,
            &scope.resource_address,
            mutation,
            bound,
            || {
                let route = context
                    .current_route(scope)
                    .ok_or_else(|| { let refused = crate::cause!(Refusal::RouteChanged); let cause = refused.cause(); Error::Refused(refused, cause) })?;
                call.assert_current(&route, context.now_ms())
                    .map_err(|value| { let cause = value.cause(); Error::Refused(value, cause) })
            },
        )
    }
}

#[cfg(test)]
mod exact_exists_tests {
    use super::*;
    use crate::storage::{memory::Memory, Result as StorageResult};
    use std::cell::RefCell;

    struct ProjectionProbe<S> {
        inner: S,
        last_fields: RefCell<Vec<String>>,
        total_fill_reads: Cell<usize>,
        logical_reads: Cell<usize>,
        returned_rows: Cell<usize>,
    }

    impl<S: Storage> ProjectionProbe<S> {
        fn new(inner: S) -> Self {
            Self {
                inner,
                last_fields: RefCell::new(Vec::new()),
                total_fill_reads: Cell::new(0),
                logical_reads: Cell::new(0),
                returned_rows: Cell::new(0),
            }
        }
    }

    impl<S: Storage> Storage for ProjectionProbe<S> {
        fn schema(&self) -> &'static super::super::Schema {
            self.inner.schema()
        }
        fn get(
            &self,
            family: &str,
            key: &[Value],
            read: &[Field<'_>],
        ) -> StorageResult<Option<Row>> {
            if family == TOTALS_FILL {
                self.total_fill_reads.set(self.total_fill_reads.get() + 1);
            }
            *self.last_fields.borrow_mut() =
                read.iter().map(|field| field.field.to_owned()).collect();
            self.logical_reads.set(self.logical_reads.get()+1);
            let answer = self.inner.get(family, key, read);
            if let Ok(row) = &answer { self.returned_rows.set(self.returned_rows.get()+usize::from(row.is_some())); }
            answer
        }
        fn scan(
            &self,
            family: &str,
            range: &Range<'_>,
            read: &[Field<'_>],
        ) -> StorageResult<Vec<Row>> {
            self.logical_reads.set(self.logical_reads.get()+1);
            let answer = self.inner.scan(family, range, read);
            if let Ok(rows) = &answer { self.returned_rows.set(self.returned_rows.get()+rows.len()); }
            answer
        }
        fn put(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> StorageResult<u64> {
            self.inner.put(family, row, when)
        }
        fn count(&self, family: &str, range: &Range<'_>) -> StorageResult<u64> {
            self.inner.count(family, range)
        }
        fn erase(&self, family: &str, range: &Range<'_>) -> StorageResult<u64> {
            self.inner.erase(family, range)
        }
        fn present(&self, family: &str) -> StorageResult<bool> {
            self.inner.present(family)
        }
        fn custody(&self) -> StorageResult<()> {
            self.inner.custody()
        }
        fn location(&self) -> Option<&str> {
            self.inner.location()
        }
        fn scoped(&self) -> bool {
            self.inner.scoped()
        }
        fn writing(&self) -> StorageResult<bool> {
            self.inner.writing()
        }
        fn changes(&self) -> u64 {
            self.inner.changes()
        }
        fn mark(&self) -> StorageResult<i64> {
            self.inner.mark()
        }
        fn schema_mark(&self) -> StorageResult<i64> {
            self.inner.schema_mark()
        }
        fn allocated_bytes(&self) -> StorageResult<u64> {
            self.inner.allocated_bytes()
        }
        fn reclaim(&self) -> StorageResult<()> {
            self.inner.reclaim()
        }
        fn reclaim_step(&self, pages: u64) -> StorageResult<u64> {
            self.inner.reclaim_step(pages)
        }
        fn vacuum_state(&self) -> StorageResult<Option<crate::storage::VacuumState>> {
            self.inner.vacuum_state()
        }
        fn overwrites_removed(&self) -> StorageResult<bool> {
            self.inner.overwrites_removed()
        }
        fn open_scope(&self, intent: Intent) -> StorageResult<()> {
            self.inner.open_scope(intent)
        }
        fn close_scope(&self, commit: bool) -> StorageResult<()> {
            self.inner.close_scope(commit)
        }
    }

    fn limits() -> Limits {
        settings::Limits::fixed(1 << 20, 10 << 30)
    }

    #[test]
    fn exact_exists_reads_only_the_declared_deleted_metadata_for_absent_live_and_erased_ids() {
        let memory = Memory::open(SCHEMA).unwrap();
        let mut writer =
            RecordStore::new(memory.reopen(), Box::new(RealClock), limits()).unwrap();
        writer
            .mutate(
                "account:presence",
                "notes",
                Mutation {
                    id: "live".into(),
                    expected_version: 0,
                    request_key: "create-live".into(),
                    deleted: false,
                    value: json!({"kind": "note", "body": "body is not part of this read"}),
                },
            )
            .unwrap();
        writer
            .mutate(
                "account:presence",
                "notes",
                Mutation {
                    id: "erased".into(),
                    expected_version: 0,
                    request_key: "create-erased".into(),
                    deleted: false,
                    value: json!({"kind": "note", "body": "also not part of the existence read"}),
                },
            )
            .unwrap();
        writer.erase("account:presence", "notes", "erased").unwrap();

        let probe = ProjectionProbe::new(memory);
        let store = RecordStore::new(probe, Box::new(RealClock), limits()).unwrap();
        for (id, expected) in [("absent", false), ("live", true), ("erased", false)] {
            assert_eq!(
                store
                    .has_live_record("account:presence", "notes", id)
                    .unwrap(),
                expected
            );
            assert_eq!(*store.storage().last_fields.borrow(), vec!["deleted"]);
        }
        let work = store.work();
        assert_eq!(work.seeks, 3, "one exact-key seek per existence check");
        assert_eq!(
            work.rows_read, 2,
            "only the live row and tombstone metadata were present"
        );
    }

    // Synthetic complete mutations, with logical reads including absent witnesses.
    #[test]
    fn mutation_plan_reads_only_relevant_total_frontiers_once_per_command() {
        let mut settings = settings::shipped().unwrap().clone();
        settings.totals = (0..12).map(|n| totals::Declared {
            why: "command dependency control".into(), total: format!("total-{n}"),
            kind: if n == 0 { "note".into() } else { format!("unrelated-{n}") },
            group: vec![], sum: vec![],
        }).collect();
        let memory = Memory::open(SCHEMA).unwrap();
        let mut store = RecordStore::with_settings(ProjectionProbe::new(memory),
            Box::new(RealClock), Box::leak(Box::new(settings)), limits()).unwrap();
        let inputs = (0..8).map(|n| Mutation {
            id: format!("note-{n}"), expected_version: 0, request_key: format!("create-{n}"),
            deleted: false, value: serde_json::json!({"kind":"note", "title":format!("row {n}")}),
        }).collect::<Vec<_>>();
        let start = store.work();
        let changes = store.mutate_many("account", "notes", inputs.clone()).unwrap();
        let work = store.work();
        let reads = store.storage.total_fill_reads.get();
        crate::quiet_eprintln!("M09 full write: records={} total_frontier_gets={} seeks={} rows={} logical_reads={} returned_rows={}",
            changes.len(), reads, work.seeks-start.seeks, work.rows_read-start.rows_read,
            store.storage.logical_reads.get(), store.storage.returned_rows.get());
        assert_eq!(reads, 1);
        // Paired unchanged-source measurement: 142 reads (96 frontier + 46 retained).
        assert_eq!(store.storage.logical_reads.get(), 47);
        assert_eq!(store.storage.returned_rows.get(), 7);
        assert_eq!(changes.len(), 8);
        for input in &inputs {
            let held = store.get("account", "notes", &input.id).unwrap().record.unwrap();
            assert_eq!(held.value, input.value);
            assert_eq!(held.version, 1);
        }
        assert_eq!(store.totals("account").unwrap().iter().find(|t|t.total=="total-0").unwrap().count, 8);
        assert_eq!(store.mutate_many("account", "notes", inputs).unwrap().len(), 8);
        assert_eq!(store.totals("account").unwrap().iter().find(|t|t.total=="total-0").unwrap().count, 8);
        let before = store.storage.total_fill_reads.get();
        store.mutate("account", "notes", Mutation {
            id: "unrelated".into(), expected_version: 0, request_key: "unrelated".into(),
            deleted: false, value: serde_json::json!({"kind":"no-total"}),
        }).unwrap();
        assert_eq!(store.storage.total_fill_reads.get(), before, "an unrelated kind reads no frontier");
    }

    #[test]
    fn mutation_plan_drops_absent_and_present_frontiers_after_commit_and_rollback() {
        let mut settings = settings::shipped().unwrap().clone();
        settings.totals = vec![totals::Declared {
            why: "frontier witness control".into(), total: "notes".into(), kind: "note".into(),
            group: vec![], sum: vec![],
        }];
        let signature = totals::signature_of(&settings.totals[0]);
        let memory = Memory::open(SCHEMA).unwrap();
        let other = memory.reopen();
        let mut store = RecordStore::with_settings(ProjectionProbe::new(memory),
            Box::new(RealClock), Box::leak(Box::new(settings)), limits()).unwrap();
        let input = |id: &str, expected_version| Mutation {
            id: id.into(), expected_version, request_key: format!("create-{id}"),
            deleted: false, value: serde_json::json!({"kind":"note"}),
        };
        let frontier = |complete| {
            other.put(TOTALS_FILL, &[
                ("account", text("account")), ("total", text("notes")),
                ("signature", text(&signature)), ("after_resource", Value::Null),
                ("after_id", Value::Null), ("complete", Value::Integer(complete)),
            ], When::Always).unwrap();
        };
        store.mutate_many("account", "notes", vec![input("a",0),input("b",0)]).unwrap();
        assert_eq!(store.storage.total_fill_reads.get(),1);
        frontier(0);
        // The absent witness of the first command cannot survive this new frontier.
        store.mutate_many("account", "notes", vec![input("c",0),input("d",0)]).unwrap();
        assert_eq!(store.storage.total_fill_reads.get(),2);
        assert!(!store.total_known("account", "notes").unwrap());
        assert_eq!(store.totals("account").unwrap()[0].count,2);
        frontier(1);
        let before = store.storage.total_fill_reads.get();
        // A late CAS failure rolls back the first mutation and its total too.
        assert!(matches!(store.mutate_many("account", "notes", vec![input("e",0),input("f",99)]), Err(Error::Conflict(_))));
        assert!(store.get("account", "notes", "e").unwrap().record.is_none());
        assert_eq!(store.totals("account").unwrap()[0].count,2);
        assert_eq!(store.storage.total_fill_reads.get(),before+1);
        store.mutate_many("account", "notes", vec![input("e",0),input("f",0)]).unwrap();
        assert_eq!(store.storage.total_fill_reads.get(),before+2);
        assert!(store.total_known("account", "notes").unwrap());
        assert_eq!(store.totals("account").unwrap()[0].count,4);
    }

    /// The shipped settings with one more order over `note`, for a store that declared it and later did not.
    fn with_note_order() -> &'static settings::Settings {
        let mut declared = settings::shipped().unwrap().clone();
        declared.orders.push(super::orders::Declared {
            why: "a test order".into(),
            order: "note/at".into(),
            kind: Some("note".into()),
            path: vec!["at".into()],
            then: Vec::new(),
            carry: Vec::new(),
        });
        Box::leak(Box::new(declared))
    }

    #[test]
    fn an_order_no_longer_declared_leaves_the_store_and_fills_again_from_the_start_when_declared_again(
    ) {
        let (account, resource) = ("account:orders", "notes");
        let note = |id: &str, at: u64| Mutation {
            id: id.into(),
            expected_version: 0,
            request_key: format!("create-{id}"),
            deleted: false,
            value: json!({"kind": "note", "at": at}),
        };
        let memory = Memory::open(SCHEMA).unwrap();
        let mut declaring = RecordStore::with_settings(
            memory.reopen(),
            Box::new(RealClock),
            with_note_order(),
            limits(),
        )
        .unwrap();
        for n in 0..5 {
            declaring
                .mutate(account, resource, note(&format!("note:{n}"), n))
                .unwrap();
        }
        while !declaring
            .fill_order(account, resource, "note/at", 2)
            .unwrap()
        {}
        assert_eq!(
            declaring
                .ordered_page(account, resource, "note/at", None, false, 10)
                .unwrap()
                .records
                .len(),
            5
        );
        let rows = |memory: &Memory, family: &str| {
            let all = Range {
                order: Order::Key,
                from: Bound::Unbounded,
                to: Bound::Unbounded,
                reverse: false,
                limit: None,
            };
            memory
                .scan(family, &all, &[Field::whole("order")])
                .unwrap()
                .into_iter()
                .map(|mut row| row.take(0))
                .filter(|order| order.as_text() == Some("note/at"))
                .count()
        };
        assert_eq!(rows(&memory, ORDERED), 5);
        assert_eq!(rows(&memory, ORDER_STATE), 1);

        // The same file under settings that no longer declare it: its rows go, a step at a time, then its fill state.
        let mut store = RecordStore::new(memory.reopen(), Box::new(RealClock), limits()).unwrap();
        assert!(store
            .settings()
            .orders
            .iter()
            .all(|declared| declared.order != "note/at"));
        let mut steps = 0;
        while !store.retire_orders(account, resource, 2).unwrap() {
            steps += 1;
        }
        assert_eq!(
            steps, 3,
            "two steps of two rows, then the last row and the fill state"
        );
        assert_eq!((rows(&memory, ORDERED), rows(&memory, ORDER_STATE)), (0, 0));
        // An erase after the order left touches no order row: there is none left behind.
        store.erase(account, resource, "note:0").unwrap();
        assert!(
            store.retire_orders(account, resource, 2).unwrap(),
            "nothing left to retire"
        );

        // Declared again, the order is not filled until it fills from the start, and then it holds every live note.
        let mut again = RecordStore::with_settings(
            memory.reopen(),
            Box::new(RealClock),
            with_note_order(),
            limits(),
        )
        .unwrap();
        assert!(again
            .ordered_page(account, resource, "note/at", None, false, 10)
            .is_err());
        while !again.fill_order(account, resource, "note/at", 2).unwrap() {}
        assert_eq!(
            again
                .ordered_page(account, resource, "note/at", None, false, 10)
                .unwrap()
                .records
                .len(),
            4
        );
    }
}
