// src/storage/record_store/holders.rs
//
// Purpose: the writer's match index for the holders of a store, which holds back the prune of a vault's replaced
// versions. Each holder that pulls from the writer records, on the pull, the stamp it has pulled through (one small row
// per holder, `holder_pulls`). A prune removes only the replaced versions every listed holder has pulled past (the
// minimum stamp, as Raft's match index and Kafka's high-water mark).
//
// A holder stops holding the prune back when it is expired (its last pull is older than `holders.lease_ms`) or behind
// past a DATA bound (its last pull is older than `holders.lag_ms` and it is still below the writer's newest stamp). Such a
// holder is not waited for: when it returns it gets a full copy, the catch-up of `follow::catch_up` from its own base, the
// same as a copy the writer no longer keeps history for. A listed holder with no row yet holds the prune back at once,
// so a missing row fails closed.
//
// Non-Negotiable Invariants:
// - No network call inside a prune: the rows are local, written on each pull.
// - A store with `HolderGuard::Unknown` prunes no replaced vault version: nothing is known about its holders.
// - A copy (`HolderGuard::Copy`) prunes by its undo window only: no other computer takes its history.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{text, unavailable, validate, RecordStore};
use crate::{
    records::Error,
    storage::{Error as StorageError, Read as Field, Storage, Value, When},
};
use std::{collections::BTreeMap, path::{Path, PathBuf}, sync::{Mutex, PoisonError}};

/// The holder guard of each vault file, as its owner last set it (`set_guard`). Every open of a file reads it, so the
/// writer's write paths and the idle pass see the same holders.
static GUARDS: Mutex<BTreeMap<PathBuf, HolderGuard>> = Mutex::new(BTreeMap::new());

/// Set the holder guard of the store file at `path`.
pub fn set_guard(path: &Path, guard: HolderGuard) {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    GUARDS.lock().unwrap_or_else(PoisonError::into_inner).insert(path, guard);
}

/// The holder guard of the store file at `path`: Unknown when none was set.
pub fn guard_of(path: &Path) -> HolderGuard {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    GUARDS.lock().unwrap_or_else(PoisonError::into_inner).get(&path).cloned().unwrap_or_default()
}

/// The family of the writer's per-holder match rows (`families.json`).
pub(super) const HOLDER_PULLS: &str = "holder_pulls";

/// Which holders hold back the prune of a vault's replaced versions (`RecordStore::set_holders`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum HolderGuard {
    /// Nothing is known about the holders: the replaced versions of a vault are kept (fail closed).
    #[default]
    Unknown,
    /// A copy: no other computer takes its history, so the undo window alone decides.
    Copy,
    /// The writer: the listed holders hold the prune back until each has pulled past a version (`holder_floor`).
    Writer(Vec<String>),
}

fn key(account: &str, resource: &str, holder: &str) -> Vec<Value> {
    vec![text(account), text(resource), text(holder)]
}

impl<S: Storage> RecordStore<S> {
    /// Record that `holder` pulled from this writer through `stamp` now. The row keeps the newest stamp it has pulled
    /// through, so a pull that arrives late moves nothing back.
    pub fn record_holder_pull(&self, account: &str, resource: &str, holder: &str, stamp: i64) -> Result<(), Error> {
        validate(account, resource, "holder_pull")?;
        let now = self.clock.now_ms();
        let kept = self
            .storage
            .get(HOLDER_PULLS, &key(account, resource, holder), &[Field::whole("stamp")])
            .map_err(unavailable)?
            .and_then(|mut row| row.take(0).as_integer())
            .unwrap_or(i64::MIN);
        let row = vec![
            ("account", text(account)),
            ("resource", text(resource)),
            ("holder", text(holder)),
            ("stamp", Value::Integer(kept.max(stamp))),
            ("pulled_ms", Value::Integer(i64::try_from(now).unwrap_or(i64::MAX))),
        ];
        self.storage.put(HOLDER_PULLS, &row, When::Always).map_err(unavailable)?;
        Ok(())
    }

    /// The stamp below which a prune may remove replaced versions for the `listed` holders: the least stamp among those
    /// still holding it back. None when no listed holder holds the prune back (every one is expired or behind past its
    /// bound). A listed holder with no row answers 0, so nothing is pruned for it.
    pub fn holder_floor(&self, account: &str, resource: &str, listed: &[String], newest: i64) -> Result<Option<i64>, StorageError> {
        let (lease, lag) = (self.settings.holders.lease_ms, self.settings.holders.lag_ms);
        let now = i64::try_from(self.clock.now_ms()).unwrap_or(i64::MAX);
        let mut floor: Option<i64> = None;
        for holder in listed {
            let row = self
                .storage
                .get(HOLDER_PULLS, &key(account, resource, holder), &[Field::whole("stamp"), Field::whole("pulled_ms")])?;
            let Some(mut row) = row else {
                return Ok(Some(0));
            };
            let stamp = row.take(0).as_integer().unwrap_or(0);
            let pulled = row.take(1).as_integer().unwrap_or(0);
            let age = now.saturating_sub(pulled);
            let expired = age > i64::try_from(lease).unwrap_or(i64::MAX);
            let behind = stamp < newest && age > i64::try_from(lag).unwrap_or(i64::MAX);
            if expired || behind {
                continue;
            }
            floor = Some(floor.map_or(stamp, |least| least.min(stamp)));
        }
        Ok(floor)
    }
}
