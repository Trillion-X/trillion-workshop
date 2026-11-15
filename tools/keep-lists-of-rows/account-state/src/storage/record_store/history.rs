// src/storage/record_store/history.rs
//
// Purpose: The version history of one record, newest first, one bounded page at a time: the read behind the door's
// record history. It reads the `versions` family only (the key is account, resource, id, valid_to), so the cost is
// the rows walked, never the size of the account.
//
// Non-Negotiable Invariants:
// - Only versions still in the family are answered. A destroyed record keeps one tombstone (its versions moved to
//   custody), so history never shows a destroyed version; the tombstone shows as deleted.
// - Versions are answered newest first, by version number; `before_version` keeps only versions below it, and
//   `next` is the last version shown (the next page's `before_version`) while older versions remain, else None.
// - A page is 1..=`limit` versions; a record that never existed answers an empty page.
//
// Key Concepts:
// - The version number is not in the key, so skipping to `before_version` walks the newer rows in chunks of
//   `READ_BATCH`; a page costs the rows newer than its start plus its own.
//
// Security Considerations:
// - This is no admission. It answers stored values; the caller opens them (sealed fields, erasure) and decides
//   whether the key may read at all.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{text, unavailable, validate, Bound, Order, Range, Storage, Value, Version, CURRENT, FULL_ROW, READ_BATCH, RecordStore, VERSIONS};
use crate::records::Error;

/// One stored version of a record.
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryVersion {
    pub version: i64,
    /// The stamp that wrote it (`stamp_ms` is its wall clock).
    pub valid_from: i64,
    /// A deletion (or destruction) tombstone: no value.
    pub deleted: bool,
    pub value: Option<serde_json::Value>,
}

/// One page of history and the `before_version` of the next page, None at the oldest version.
#[derive(Clone, Debug, PartialEq)]
pub struct History {
    pub versions: Vec<HistoryVersion>,
    pub next: Option<i64>,
}

/// One record as it was saved at a moment (old trillion record-log-store.mjs:4203 `recordAt`).
#[derive(Clone, Debug, PartialEq)]
pub struct RecordAt {
    /// The version that was current then (a tombstone when the record was deleted then); None when there was none.
    pub version: Option<HistoryVersion>,
    /// False when versions older than the oldest still kept could have answered (they left the store): `kept_from` is
    /// then the earliest moment (ms) the answer is good for (old `complete` / `kept_from`).
    pub complete: bool,
    pub kept_from: Option<u64>,
}

impl<S: Storage> RecordStore<S> {
    /// The record as saved at `at_ms` (wall clock milliseconds): the version whose stamp is at or before that moment
    /// and that no later stamp at or before it replaced. One seek: the first version whose `valid_to` is past the
    /// moment (the key is account, resource, id, valid_to). Ported from old `recordAt(id, { known })`; its `valid`
    /// (application time) is dropped, because a version here carries one time, the stamp that saved it, and its
    /// per-field times are the record's stamps (`stamps.rs`), not this read's.
    pub fn record_at(&self, account: &str, resource: &str, id: &str, at_ms: u64) -> Result<RecordAt, Error> {
        validate(account, resource, id)?;
        let scope = vec![text(account), text(resource), text(id)];
        // The first stamp after the moment: every stamp of millisecond `at_ms` is at or before it.
        let after = i64::try_from(at_ms.saturating_add(1)).ok().and_then(|ms| ms.checked_mul(1 << 16)).unwrap_or(CURRENT);
        let range = Range {
            order: Order::Key,
            from: Bound::Excluded([scope.as_slice(), &[Value::Integer(after.saturating_sub(1))]].concat()),
            to: Bound::Included(scope.clone()),
            reverse: false,
            limit: Some(1),
        };
        let Some(row) = self.scan_rows(VERSIONS, &range, &FULL_ROW).map_err(unavailable)?.into_iter().next() else {
            return Ok(RecordAt { version: None, complete: true, kept_from: None });
        };
        let found = Version::from_row(row, CURRENT)?;
        if found.valid_from < after {
            let version = HistoryVersion { version: found.version, valid_from: found.valid_from, deleted: found.deleted, value: found.value()? };
            return Ok(RecordAt { version: Some(version), complete: true, kept_from: None });
        }
        // Saved only after the moment. Its first version means the record did not exist yet; a later one means the
        // versions before it (one of which was current then) have left the store.
        let complete = found.version <= 1;
        Ok(RecordAt { version: None, complete, kept_from: (!complete).then(|| super::stamp_ms(found.valid_from)) })
    }

    /// Up to `limit` versions of `id`, newest first, those below `before_version` when given.
    pub fn history(&self, account: &str, resource: &str, id: &str, before_version: Option<i64>, limit: usize)
        -> Result<History, Error> {
        validate(account, resource, id)?;
        if limit == 0 {
            return Err(Error::Invalid("history limit must be positive", crate::cause!()));
        }
        let scope = vec![text(account), text(resource), text(id)];
        let mut versions = Vec::new();
        let mut older = false;
        let mut walked: Option<i64> = None;
        'walk: loop {
            // Newest first: the walk starts at the oldest `valid_to` the last chunk reached (excluded), else at the
            // current row.
            let end = match walked {
                Some(valid_to) => Bound::Excluded([scope.as_slice(), &[Value::Integer(valid_to)]].concat()),
                None => Bound::Included(scope.clone()),
            };
            let range = Range { order: Order::Key, from: Bound::Included(scope.clone()), to: end, reverse: false, limit: Some(READ_BATCH) }
                .reverse();
            let rows = self.scan_rows(VERSIONS, &range, &FULL_ROW).map_err(unavailable)?;
            let full = rows.len() == READ_BATCH;
            for row in rows {
                let version = Version::from_row(row, CURRENT)?;
                walked = Some(version.valid_to);
                if before_version.is_some_and(|before| version.version >= before) {
                    continue;
                }
                if versions.len() == limit {
                    older = true;
                    break 'walk;
                }
                versions.push(HistoryVersion {
                    version: version.version,
                    valid_from: version.valid_from,
                    deleted: version.deleted,
                    value: version.value()?,
                });
            }
            if !full {
                break;
            }
        }
        let next = if older { versions.last().map(|last| last.version) } else { None };
        Ok(History { versions, next })
    }
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
