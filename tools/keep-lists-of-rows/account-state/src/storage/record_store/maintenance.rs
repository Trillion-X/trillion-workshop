// src/storage/record_store/maintenance.rs
//
// Purpose: the idle maintenance of every store file the account keeps open. Whoever knows a store file registers it with
// its account and resource (`register`: the owner that opens it, and the boot of an account whose file exists); the
// account's idle upkeep gives each registered store its turn in path order (`run_next`, round-robin), and for that store
// gives back its free pages (`reclaim_step`, within the pass's `longest`) and decides its one-time vacuum
// (`vacuum_if_due`, DATA `vacuum`). One store a pass, so the own store's leftover free pages never hold back another
// store: every registered store is reached once per round of passes. A store that is busy or refuses is named and tried
// again on its next turn.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{holders::{self, HolderGuard}, RecordStore, VacuumStep};
use crate::account::computers::copies::{vault_gate, VaultGate};
use crate::storage::record_store_resources::{undo_of, Undo};
use serde_json::{json, Value};
use crate::records::Error;
use crate::storage::{record_store_resources, Storage};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
    time::{Duration, Instant},
};

/// A store file an owner opened, with the account and resource it keeps there.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Registered {
    pub path: PathBuf,
    pub account: String,
    pub resource: String,
}

/// The stores an idle pass walks, and whose turn is next. The process keeps one (`SHARED`); a test keeps its own.
#[derive(Default)]
pub struct Registry {
    stores: Mutex<BTreeSet<Registered>>,
    /// The index in path order of the store whose turn is next.
    next: Mutex<usize>,
}

static SHARED: Registry = Registry { stores: Mutex::new(BTreeSet::new()), next: Mutex::new(0) };

/// Register the store file at `path` with the account and resource it holds. Registering a store twice is one entry.
pub fn register(path: &Path, account: &str, resource: &str) {
    SHARED.register(path, account, resource);
}

/// Every registered store of the process, in path order.
pub fn registered() -> Vec<Registered> {
    SHARED.registered()
}

/// The next turn of the process's idle pass (`Registry::run_next`).
pub fn run_next(longest: Duration) -> Option<(Registered, Result<VacuumStep, Error>)> {
    SHARED.run_next(longest)
}

impl Registry {
    /// Register the store file at `path` with the account and resource it holds. Registering a store twice is one entry.
    pub fn register(&self, path: &Path, account: &str, resource: &str) {
        let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let entry = Registered { path, account: account.to_owned(), resource: resource.to_owned() };
        self.stores.lock().unwrap_or_else(PoisonError::into_inner).insert(entry);
    }

    /// Every registered store, in path order.
    pub fn registered(&self) -> Vec<Registered> {
        self.stores.lock().unwrap_or_else(PoisonError::into_inner).iter().cloned().collect()
    }

    /// The idle pass's turn: the store whose turn is next is opened, maintained for at most `longest` of free-page steps
    /// and its vacuum decision, and closed; the turn moves to the next store in path order, whatever this one answered.
    /// None while nothing is registered.
    pub fn run_next(&self, longest: Duration) -> Option<(Registered, Result<VacuumStep, Error>)> {
        let stores = self.registered();
        if stores.is_empty() {
            return None;
        }
        let turn = {
            let mut next = self.next.lock().unwrap_or_else(PoisonError::into_inner);
            let turn = *next % stores.len();
            *next = (turn + 1) % stores.len();
            turn
        };
        let one = stores[turn].clone();
        let outcome = record_store_resources::open(&one.path, crate::sqlite_work::WorkMeter::new()).and_then(|mut store| {
            let free = crate::storage::record_store::settings::volume_free_bytes(&one.path).unwrap_or(0);
            if undo_of(&one.resource) == Undo::Vault {
                // A vault that a writer's copies follow is a copy here: no other computer takes its history, so only its
                // undo window applies. A vault no copy follows is the writer's, whose holders are not wired yet, so its
                // replaced versions are kept (`HolderGuard::Unknown`).
                let guard = match vault_gate(Some(one.path.as_path()), &one.account, &store) {
                    VaultGate::Free => HolderGuard::Unknown,
                    VaultGate::Copies(copies) if copies.is_writer() => HolderGuard::Writer(copies.holders()),
                    VaultGate::Copies(_) | VaultGate::Closed => HolderGuard::Copy,
                };
                holders::set_guard(&one.path, guard);
            }
            maintain(&mut store, &one.account, &one.resource, free, longest)
        });
        Some((one, outcome))
    }
}

/// The log line of one turn (`run_next`): what the store's pass did, and the typed reason its vacuum did not run (the free
/// pages below the DATA share, the store not quiet for the DATA window, the volume short of free disk, the file already
/// incremental, a writer holding the file, or a refusal). Every turn logs one, so the log always says why.
pub fn turn_line(one: &Registered, outcome: &Result<VacuumStep, Error>) -> Value {
    let (vacuum, reason) = match outcome {
        Ok(VacuumStep::Vacuumed { .. }) => ("vacuumed", None),
        Ok(VacuumStep::NotDue(why)) => ("not_due", Some((*why).to_owned())),
        Ok(VacuumStep::Busy) => ("busy", Some("a writer holds the store; the next turn tries again".to_owned())),
        Err(error) => ("refused", Some(format!("{error:?}"))),
    };
    json!({"store_maintenance": {"file": one.path, "resource": one.resource, "vacuum": vacuum, "reason": reason}})
}

/// One idle maintenance pass over an open store: the word index's owed merges (`search_merge`, as the account's own store
/// gets them in src/native_boot/own_records_start.rs: a store written a page at a time, a list's store during its move,
/// adds one segment a write, and every write's first search read parses every segment's meta, so unmerged segments cost
/// each write more), the free pages the store can give back now (`reclaim_step`, until none is left or `longest` has
/// passed), then its one-time vacuum decision (`vacuum_if_due`, with the volume's free bytes). Answers the vacuum decision.
pub fn maintain<S: Storage>(store: &mut RecordStore<S>, account: &str, resource: &str, free_disk: u64, longest: Duration) -> Result<VacuumStep, Error> {
    let started = Instant::now();
    let merge_bytes = store.settings().search.merge_bytes();
    while started.elapsed() < longest && !store.search_merge(account, resource, merge_bytes)?.done {}
    // The exit step removes at most `exit_step_rows` replaced versions per write or applied change, so a store no change
    // reaches keeps its backlog: the idle pass runs the exit step (`retire`) until none is left, before its free pages go
    // back. A store with nothing to remove answers 0 at once.
    while started.elapsed() < longest && store.retire(account, resource)? > 0 {}
    while started.elapsed() < longest && store.reclaim_step()?.left() > 0 {}
    store.vacuum_if_due(account, resource, free_disk)
}
