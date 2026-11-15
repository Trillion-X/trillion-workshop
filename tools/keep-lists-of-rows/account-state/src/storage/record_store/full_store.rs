// full_store.rs, in the record store's folder
//
// Purpose: one owner for what a record store does once it is full (its level waits for recovery, `store_size.rs`, or a
// write failed for want of room): ported one to one from old trillion src/full-store-recovery.mjs (1-105, at
// 22b601c), where every Durable Object store used it, as PersonStore.recoverFullStore did for the person's own store.
//
// Non-Negotiable Invariants (the old file's five, kept in its order):
//   1. The caller's answer is the original failure. Recovery never replaces or hides it: `recover` answers what it
//      did, beside the caller's own result, and the caller still answers its own error.
//   2. Only derived or expired space is freed. In this store that is: replaced versions past their stated retention
//      (the history bound, `settings.json` `history`: older than `keep_ms` once the store is pressed, at most
//      `full_store_rows_per_step` per step), tombstones and custody past the undo window (`exit_step`), and free
//      pages given back to the volume (`reclaim_step`; that step never counts as freed: a free page is room a write
//      already reuses, so a store whose only gain is free pages goes idle as one full of records does). A step offered here is one of those kinds: past its stated
//      retention, or space no row holds. Real records (the current version of every record) are never dropped.
//   3. One recovery at a time per store: a second full failure while one runs waits for the same one and answers
//      what it did.
//   4. Each step is bounded (one page of work); the store's next write or timer carries on from there. A recovery
//      that freed nothing is not asked again by every call for `idle_ms`, so a store full of real records answers at
//      once.
//   5. A step that fails is logged and the next one still runs: one broken step never keeps the others full.
//
// What was dropped from the old file, and why:
// - `guardFullStore` (wrapping every method of a Durable Object prototype): a Rust store has one write path, so the
//   hook is in the record store's `mutate_with_check` (a write at a level that waits for recovery runs it first), not a wrapper.
// - The `record-log-runs` step (kept-runs releaseDerivedSpace: a merge's partial output): this store keeps no record
//   log runs; its search segments merge inside writes and are not freed here.
// - `ctx.waitUntil`: a step here runs in the caller's thread, bounded, and nothing outlives the call.
// - `storeUse` (the per-table inventory): the size report says the store's bytes and level only; this store has no
//   table inventory read.
//
// Key Concepts:
// - `FullStoreRecovery`: one per store file (`for_store`), holding whether a recovery runs, until when one is not
//   asked again, and what the last one did.
// - `Step`: `{ id, run }`, where `run` answers `Freed { freed, more }` for one bounded page of work.
// - `Recovered`: what one recovery did: when, why, whether anything was freed, each step's answer, the bytes and the
//   level when it started.
//
// Security Considerations:
// - Logs carry static recovery stages and source causes only; step ids, recovery reasons,
//   driver messages, record ids, values and keys never enter the log.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::records::Error;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicI64, Ordering}, Arc, Mutex, OnceLock, TryLockError},
};

/// One step's answer for one bounded page of work.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Freed {
    /// Whether the step freed any space.
    pub freed: bool,
    /// Whether it stopped at its bound with more of its kind left.
    pub more: bool,
}

/// One step a store offers: its id, and one bounded page of work.
pub struct Step<'a> {
    pub id: &'static str,
    pub run: Box<dyn FnMut() -> Result<Freed, Error> + 'a>,
}

/// What one step did in a recovery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepRan {
    pub id: String,
    pub freed: bool,
    pub more: bool,
    pub failed: bool,
}

/// What one recovery did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recovered {
    pub at_ms: i64,
    pub reason: String,
    pub freed: bool,
    pub steps: Vec<StepRan>,
    /// The store's bytes when it started.
    pub bytes: Option<u64>,
    /// The store's level (its id on the size row) when it started.
    pub level: Option<String>,
}

/// The recovery of one store (old trillion `makeFullStoreRecovery`).
pub struct FullStoreRecovery {
    running: Mutex<()>,
    idle_until: AtomicI64,
    last: Mutex<Option<Recovered>>,
    idle_ms: i64,
}

impl Default for FullStoreRecovery {
    fn default() -> Self {
        Self::new(super::settings::shipped().map_or(60_000, |settings| settings.full_store.idle_ms))
    }
}

impl FullStoreRecovery {
    /// A recovery that is not asked again for `idle_ms` after one that freed nothing.
    pub fn new(idle_ms: i64) -> Self {
        Self { running: Mutex::new(()), idle_until: AtomicI64::new(0), last: Mutex::new(None), idle_ms }
    }

    /// The one recovery of the store file at `path` in this process (old trillion: one per Durable Object).
    pub fn for_store(path: &Path) -> Arc<Self> {
        static STORES: OnceLock<Mutex<HashMap<PathBuf, Arc<FullStoreRecovery>>>> = OnceLock::new();
        let mut stores = STORES.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        stores.entry(path.to_owned()).or_insert_with(|| Arc::new(Self::default())).clone()
    }

    /// Start (or join) one recovery when `full` (the store is full); answers what it did, or `None` when the store is
    /// not full, or when a recovery that freed nothing ran within `idle_ms`. `size` is the store's bytes and level when
    /// it starts; `steps` the steps it offers now, in the order to run them.
    pub fn recover<'a>(
        &self, full: bool, reason: &str, now_ms: i64,
        size: impl FnOnce() -> (Option<u64>, Option<String>), steps: impl FnOnce() -> Vec<Step<'a>>,
    ) -> Option<Recovered> {
        if !full {
            return None;
        }
        let _one = match self.running.try_lock() {
            Ok(guard) => guard,
            // One runs: wait for it, and answer what it did.
            Err(TryLockError::WouldBlock) => {
                drop(self.running.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
                return self.last();
            }
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        };
        if now_ms < self.idle_until.load(Ordering::Acquire) {
            return None;
        }
        let (bytes, level) = size();
        // Said before any step runs, so a recovery that starts and never ends is seen as that.
        crate::quiet_eprintln!("full-store stage=recovery-started");
        let mut ran = Vec::new();
        for mut step in steps() {
            match (step.run)() {
                Ok(answer) => ran.push(StepRan { id: step.id.to_owned(), freed: answer.freed, more: answer.more, failed: false }),
                Err(error) => {
                    ran.push(StepRan { id: step.id.to_owned(), freed: false, more: false, failed: true });
                    let cause = error.cause();
                    crate::quiet_eprintln!("full-store stage=step-failed cause={cause}");
                }
            }
        }
        let freed = ran.iter().any(|step| step.freed);
        self.idle_until.store(if freed { 0 } else { now_ms.saturating_add(self.idle_ms) }, Ordering::Release);
        crate::quiet_eprintln!("full-store stage=recovery-finished");
        let last = Recovered { at_ms: now_ms, reason: reason.to_owned(), freed, steps: ran, bytes, level };
        *self.last.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(last.clone());
        Some(last)
    }

    /// What the last recovery did.
    pub fn last(&self) -> Option<Recovered> {
        self.last.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }
}
