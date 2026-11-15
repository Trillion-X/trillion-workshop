// src/storage/record_store/native.rs
//
// Purpose: The seam the native account reads current records through: one record's stored form by id, and the live
// ids of one record type. Two suppliers implement it: the old engine's readers (`legacy.rs`) and the record store
// (`RecordStoreCurrent` here). A switch in DATA chooses which one the native account is handed; the screens above it do not
// change.
//
// Non-Negotiable Invariants:
// - A stored form travels byte for byte: type, sequence, value JSON text and meta JSON text exactly as the original
//   engine stored them (sealed values stay sealed; key resolution stays with the account's key owner above this
//   seam).
// - Each read reports the work it did in units its supplier can count (record store: rows read; legacy: elapsed time).
//
// Key Concepts:
// - `CurrentRecords`: `stored(id)`, `ids_of_type(type, before, limit)` (descending, strict `before` cursor).
// - The record store body of a migrated record: {"kind", "sequence", "stored", "meta", "protected"}; `kind` is the store's
//   kind field, so `ids_of_type` is one walk of the `live_kind` order.
//
// Security Considerations:
// - The seam carries stored forms, never plaintext of protected fields and never key material.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::RecordStore;
use crate::{
    legacy_records::StoredRecord,
    records::{Error, Records},
    storage::Storage,
};
use serde_json::{json, Value};

/// One page of live ids of one record type, descending.
#[derive(Debug, Default)]
pub struct TypeIds {
    pub ids: Vec<String>,
    /// Strict `before` for the next page; None when this page is the last.
    pub next: Option<String>,
}

/// What a supplier has done since it was opened.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct SeamWork {
    pub reads: u64,
    /// Rows read through the storage boundary (record store), when the supplier counts them.
    pub rows_read: Option<u64>,
    /// Wall time inside the supplier, in microseconds.
    pub elapsed_us: u64,
}

/// The current records the native account reads.
pub trait CurrentRecords {
    /// One record's stored form; None when absent or deleted.
    fn stored(&mut self, id: &str) -> Result<Option<StoredRecord>, Error>;
    /// Live ids of one record type, descending, strictly before `before`.
    fn ids_of_type(&mut self, record_type: &str, before: Option<&str>, limit: usize) -> Result<TypeIds, Error>;
    fn work(&self) -> SeamWork;
}

/// The record store body of a stored form.
pub fn body(record: &StoredRecord) -> Value {
    json!({
        "kind": record.record_type,
        "sequence": record.sequence,
        "stored": record.value_json,
        "meta": record.meta_json,
        "protected": record.protected_key_present,
    })
}
/// The stored form a record store body carries.
pub fn stored_form(id: &str, body: &Value) -> Result<StoredRecord, Error> {
    let text = |field: &str| body.get(field).and_then(Value::as_str).map(str::to_owned).ok_or(crate::cause!(Error::Unavailable));
    Ok(StoredRecord {
        id: id.to_owned(),
        record_type: text("kind")?,
        sequence: text("sequence")?,
        value_json: text("stored")?,
        meta_json: body.get("meta").and_then(Value::as_str).map(str::to_owned),
        protected_key_present: body.get("protected").and_then(Value::as_bool).ok_or(crate::cause!(Error::Unavailable))?,
    })
}

/// The record store supplier of the seam for one account's records resource. A supply lent from an owner's open SQLite
/// transaction (`sqlite::lend`) is not `Send`; it can still hold the seam and write through `migrate::absorb`.
pub struct RecordStoreCurrent<S: Storage> {
    pub store: RecordStore<S>,
    pub account: String,
    pub resource: String,
    work: SeamWork,
}
impl<S: Storage> RecordStoreCurrent<S> {
    pub fn new(store: RecordStore<S>, account: &str, resource: &str) -> Self {
        Self { store, account: account.into(), resource: resource.into(), work: SeamWork::default() }
    }
    fn timed<T>(&mut self, read: impl FnOnce(&mut Self) -> Result<T, Error>) -> Result<T, Error> {
        let started = std::time::Instant::now();
        let answer = read(self);
        self.work.reads += 1;
        self.work.elapsed_us += started.elapsed().as_micros() as u64;
        self.work.rows_read = Some(self.store.work().rows_read);
        answer
    }

    /// Read the stored form and compare-and-set version from one current row.
    /// Tombstones keep their version even though they have no stored form.
    pub(crate) fn stored_with_held_version(&mut self, id: &str) -> Result<(i64, Option<StoredRecord>), Error> {
        self.timed(|seam| {
            let (version, record) = seam.store.held_record_with_version(&seam.account, &seam.resource, id)?;
            let stored = record.map(|record| stored_form(id, &record.value)).transpose()?;
            Ok((version, stored))
        })
    }
}
impl<S: Storage + Send> CurrentRecords for RecordStoreCurrent<S> {
    fn stored(&mut self, id: &str) -> Result<Option<StoredRecord>, Error> {
        self.timed(|seam| {
            let read = seam.store.get(&seam.account, &seam.resource, id)?;
            read.record.map(|record| stored_form(id, &record.value)).transpose()
        })
    }
    fn ids_of_type(&mut self, record_type: &str, before: Option<&str>, limit: usize) -> Result<TypeIds, Error> {
        self.timed(|seam| {
            let (ids, next) = seam.store.ids_of_kind(&seam.account, &seam.resource, record_type, before, limit)?;
            Ok(TypeIds { ids, next })
        })
    }
    fn work(&self) -> SeamWork {
        self.work
    }
}
