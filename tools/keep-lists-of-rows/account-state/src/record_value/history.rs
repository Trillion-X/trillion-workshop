// src/record_value/history.rs
//
// Purpose: The generic read of one record's version history: its stored versions newest first, each opened exactly as
// the current record is (`record_value::read`: sealed fields, erasure, shared expansion). It names no kind and no
// field; the door (`record_value::door`) shapes the input and the answer.
//
// Non-Negotiable Invariants:
// - A version's value is opened through `record_value::read` under the caller's policy and limits. The key state is
//   the supply's current one, so a record whose field key was erased answers its sealed fields as null in every
//   version, and a destroyed record shows only its tombstone.
// - A deleted version has no value; it is answered as deleted, never as a record of null.
// - Shared records a version refers to are read as they are now; only the root record is read as of its version.
//
// Key Concepts:
// - `VersionSupply`: the account's own records, beside `Supply`, answer one page of a record's stored versions.
// - `AtVersion`: a `Supply` whose root record is one stored version and whose keys and other records are the
//   underlying supply's.
//
// Security Considerations:
// - This module is no admission. Every opened value leaves only through the caller's disclosure.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{read, CurrentKeys, Error, KeyState, Limits, OpenPolicy, Result, StoredRecord, Supply};
use serde_json::Value;

/// One stored version of a record, in its stored form.
#[derive(Clone, Debug)]
pub struct StoredVersion {
    pub version: i64,
    /// Wall-clock milliseconds the version was written.
    pub at_ms: u64,
    /// None for a deletion tombstone.
    pub stored: Option<StoredRecord>,
}

/// One page of stored versions, newest first, and the `before_version` of the next page.
#[derive(Clone, Debug)]
pub struct StoredHistory {
    pub versions: Vec<StoredVersion>,
    pub next: Option<i64>,
}

/// The version of a record that was current at a moment (`version_at`): None when there was none (not written yet, or
/// deleted then: a tombstone answers `stored` None). `complete` is false when the versions that could answer have left
/// the store; `kept_from_ms` is then the earliest moment the answer is good for (old trillion record-log-store.mjs
/// `recordAt` `complete` / `kept_from`).
#[derive(Clone, Debug)]
pub struct VersionAt {
    pub version: Option<StoredVersion>,
    pub complete: bool,
    pub kept_from_ms: Option<u64>,
}

/// The most history pages `version_at`'s walk reads before it answers incomplete.
const AT_WALK_PAGES: usize = 64;
const AT_WALK_PAGE: usize = 100;

/// A supply that also answers a record's version history.
pub trait VersionSupply: Supply {
    fn versions(&mut self, id: &str, before_version: Option<i64>, limit: usize) -> Result<StoredHistory>;
    /// The version of `id` current at `at_ms`. The default walks the history newest first, a bounded number of pages;
    /// a supply that can seek the moment (the record store's `record_at`) answers in one read.
    fn version_at(&mut self, id: &str, at_ms: u64) -> Result<VersionAt> {
        let mut before = None;
        let mut oldest: Option<StoredVersion> = None;
        for _ in 0..AT_WALK_PAGES {
            let page = self.versions(id, before, AT_WALK_PAGE)?;
            for held in page.versions {
                if held.at_ms <= at_ms {
                    return Ok(VersionAt { version: Some(held), complete: true, kept_from_ms: None });
                }
                oldest = Some(held);
            }
            match page.next {
                Some(next) => before = Some(next),
                None => {
                    // Every kept version is later than the moment: it was the record's first (none then), or the
                    // ones before it left the store.
                    let incomplete = oldest.as_ref().filter(|first| first.version > 1);
                    return Ok(VersionAt { version: None, complete: incomplete.is_none(), kept_from_ms: incomplete.map(|first| first.at_ms) });
                }
            }
        }
        Ok(VersionAt { version: None, complete: false, kept_from_ms: oldest.map(|first| first.at_ms) })
    }
}

/// One version as answered: its number, time, and opened value (None when deleted).
#[derive(Clone, Debug, PartialEq)]
pub struct OpenedVersion {
    pub version: i64,
    pub at_ms: u64,
    pub value: Option<Value>,
}

/// One page of opened versions.
#[derive(Clone, Debug, PartialEq)]
pub struct OpenedHistory {
    pub versions: Vec<OpenedVersion>,
    pub next: Option<i64>,
}

struct AtVersion<'a, S: Supply> {
    inner: &'a mut S,
    id: &'a str,
    stored: StoredRecord,
}
impl<S: Supply> CurrentKeys for AtVersion<'_, S> {
    fn assert_current(&mut self) -> Result<()> {
        self.inner.assert_current()
    }
    fn key(&mut self, owner_id: &str) -> Result<KeyState> {
        self.inner.key(owner_id)
    }
}
impl<S: Supply> Supply for AtVersion<'_, S> {
    fn stored(&mut self, id: &str) -> Result<Option<StoredRecord>> {
        if id == self.id {
            return Ok(Some(self.stored.clone()));
        }
        self.inner.stored(id)
    }
}

/// The record `id` as it was saved at `at_ms`, opened under `policy` (old trillion record-log-store.mjs `recordAt(id,
/// { known })`): None when it had no live version then, else its opened value; and whether the answer is complete.
pub fn read_at(id: &str, at_ms: u64, supply: &mut impl VersionSupply, policy: &OpenPolicy, limits: Limits)
    -> Result<(Option<(i64, u64, super::LogicalRecord)>, bool, Option<u64>)> {
    let at = supply.version_at(id, at_ms)?;
    let opened = match at.version {
        Some(StoredVersion { version, at_ms: saved, stored: Some(stored) }) => {
            let mut view = AtVersion { inner: &mut *supply, id, stored };
            Some((version, saved, read(id, &mut view, policy, limits)?.ok_or(crate::cause!(Error::Source))?))
        }
        _ => None,
    };
    Ok((opened, at.complete, at.kept_from_ms))
}

/// Up to `limit` versions of `id`, newest first, below `before_version` when given, each opened under `policy`.
pub fn history(
    id: &str,
    before_version: Option<i64>,
    limit: usize,
    supply: &mut impl VersionSupply,
    policy: &OpenPolicy,
    limits: Limits,
) -> Result<OpenedHistory> {
    let page = supply.versions(id, before_version, limit)?;
    let mut versions = Vec::with_capacity(page.versions.len());
    for held in page.versions {
        let value = match held.stored {
            None => None,
            Some(stored) => {
                let mut at = AtVersion { inner: &mut *supply, id, stored };
                let record = read(id, &mut at, policy, limits)?.ok_or(crate::cause!(Error::Source))?;
                Some(super::account_routes::value_json(&record)?)
            }
        };
        versions.push(OpenedVersion { version: held.version, at_ms: held.at_ms, value });
    }
    Ok(OpenedHistory { versions, next: page.next })
}
