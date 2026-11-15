// src/storage/record_store/legacy.rs
//
// Purpose: The old engine's supplier of the native current-record seam: the record-log/kept-run readers through
// their public functions only (`LegacyRecords::read_stored`, `LegacyRecords::ids_of_type`), so the switch reads exactly
// what the native account reads today, and the old reader's refusals named for the record store side (`refused`).
//
// Non-Negotiable Invariants:
// - The seam reads through the existing canonical readers only, journal tail included.
// - No physical old-engine reading lives here: the generic `S` is the old engine's own source seam, and the bulk
//   checkpoint read the one-time migration uses is in that tool (`examples/record_store_migrate.rs`, through
//   `migrate::Source`), so the record store holds no SQL text.
// - Read allowances are the caller's (an offline migration may pass larger ones than a request does).
//
// Key Concepts:
// - Work: every seam read is counted and timed (`SeamWork`) so the switch compares the two engines' costs.
//
// Security Considerations:
// - Reads only; the source is the caller's pinned readonly original.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::native::{CurrentRecords, SeamWork, TypeIds};
use crate::{
    ecma_json::JsString,
    legacy_kept::LegacyKept,
    legacy_records::{
        ids::{IdsLimits, IdsRequest},
        LegacyRecords, StoredRecord,
    },
    record_source::BoundedRecordSql,
    records::Error,
};
use std::time::Instant;

/// The old reader's refusal, named, so a migration that stops says where.
pub fn refused(error: crate::legacy_records::Error) -> Error {
    use crate::legacy_records::Error as Old;
    let cause = error.cause();
    Error::Invalid(match error {
        Old::Invalid(_) => "original record input refused",
        Old::Bounds(_) => "original record read exceeds bounds",
        Old::Deadline(_) => "original record operation deadline exhausted",
        Old::Source(_) => "original record source unavailable or changed",
        Old::Schema(_) => "original record schema differs",
        Old::UnsupportedEngine(_) => "original record engine unsupported",
        Old::WrongEngine(_) => "original record read belongs to another engine",
        Old::Corrupt(_) => "original record data is inconsistent",
        Old::ReplayRequired(_) => "original record projection requires bounded log replay",
    }, cause)
}

/// The old engine's readers behind the seam.
pub struct Legacy<S: BoundedRecordSql> {
    records: LegacyRecords<S>,
    kept: LegacyKept,
    limits: IdsLimits,
    work: SeamWork,
}
impl<S: BoundedRecordSql> Legacy<S> {
    pub fn new(records: LegacyRecords<S>, kept: LegacyKept, limits: IdsLimits) -> Self {
        Self { records, kept, limits, work: SeamWork::default() }
    }
    /// The old reader's redacted observations of its most recent refusal (stage, reason, work), when it kept one.
    pub fn last_refusal(&self) -> Option<String> {
        self.records.last_read_diagnostic().map(ToString::to_string)
    }
    fn timed<T>(&mut self, read: impl FnOnce(&mut Self) -> Result<T, Error>) -> Result<T, Error> {
        let started = Instant::now();
        let answer = read(self);
        self.work.reads += 1;
        self.work.elapsed_us += started.elapsed().as_micros() as u64;
        answer
    }
}
impl<S: BoundedRecordSql> CurrentRecords for Legacy<S> {
    fn stored(&mut self, id: &str) -> Result<Option<StoredRecord>, Error> {
        self.timed(|seam| seam.records.read_stored(id, &seam.kept).map_err(refused))
    }
    fn ids_of_type(&mut self, record_type: &str, before: Option<&str>, limit: usize) -> Result<TypeIds, Error> {
        self.timed(|seam| {
            let prefix = JsString::from("");
            let before = before.map(JsString::from);
            let request = IdsRequest { record_type, prefix: &prefix, before: before.as_ref(), limit };
            let page = seam.records.ids_of_type(request, seam.limits, &seam.kept).map_err(refused)?;
            Ok(TypeIds { ids: page.ids, next: page.next })
        })
    }
    fn work(&self) -> SeamWork {
        self.work
    }
}

