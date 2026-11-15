// src/account_files/counters.rs
//
// Purpose: The RAM-only counter registry the account files byte meter adds to. One cell is one `AtomicU64`; a key is a
// bounded, code-declared name (never an account, a file name, a key or any caller text). It is the minimal equivalent
// of the observability registry's design, kept inside this engine: no dependency on another repository.
//
// Non-Negotiable Invariants:
// - A request path never waits on this registry: a byte owner resolves its cells once (`cell`, when the handle is
//   built) and then only adds to the resolved `AtomicU64`. Adding to a resident key by name takes the read lock and one
//   atomic; only the first use of a key takes the write lock.
// - Cardinality is bounded: at most `MOST_KEYS` keys. A key past the bound lands in the one `OVERFLOW` cell, so a bug
//   that invents keys cannot grow memory.
// - RAM only. Nothing here writes a file, a record or a socket. A host flushes from its own thread, off every request
//   path (`flush_changes_every`): one diagnostic line to the host's stderr per period, and only when a count changed,
//   so an idle host writes nothing and no flush costs a store read, a store write or a network request. These counts
//   are diagnostics, keyed by admission kind and never by account. Each account's own billed counts are its usage day
//   rows (`usage.rs`); a funded allowance's spending truth is its hold book (`resource_authority::budget::account_files`),
//   one durable hold per chunk.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use std::{
    collections::BTreeMap,
    sync::{atomic::{AtomicU64, Ordering}, Arc, OnceLock, RwLock},
    time::Duration,
};

/// The most distinct keys one registry holds.
pub const MOST_KEYS: usize = 256;
/// The cell every key past `MOST_KEYS` adds to.
pub const OVERFLOW: &str = "counters.overflow";

/// One registry of named `AtomicU64` cells.
#[derive(Default)]
pub struct Registry {
    cells: RwLock<BTreeMap<String, Arc<AtomicU64>>>,
}

impl Registry {
    /// The process's registry, which every byte owner adds to unless a caller (a test) gives it its own.
    pub fn global() -> Arc<Registry> {
        static GLOBAL: OnceLock<Arc<Registry>> = OnceLock::new();
        GLOBAL.get_or_init(Arc::default).clone()
    }

    /// The cell of `key`, created on first use. A byte owner calls this when it is built, never per request.
    pub fn cell(&self, key: &str) -> Arc<AtomicU64> {
        if let Some(cell) = self.cells.read().unwrap_or_else(|poisoned| poisoned.into_inner()).get(key) {
            return cell.clone();
        }
        let mut cells = self.cells.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        let key = if cells.len() >= MOST_KEYS && !cells.contains_key(key) { OVERFLOW } else { key };
        cells.entry(key.to_owned()).or_default().clone()
    }

    /// Every key and its count at one moment, for a flush off the request path.
    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        self.cells.read().unwrap_or_else(|poisoned| poisoned.into_inner()).iter()
            .map(|(key, cell)| (key.clone(), cell.load(Ordering::Relaxed))).collect()
    }

    /// `namespace-counters key=count ...` for every key whose count changed since `last` (which then holds the counts
    /// now), or None when nothing changed. A key holds no space or `=`, so the line splits on both.
    pub fn changes(&self, last: &mut BTreeMap<String, u64>) -> Option<String> {
        let now = self.snapshot();
        let changed: Vec<String> = now.iter().filter(|(key, count)| last.get(*key) != Some(*count))
            .map(|(key, count)| format!("{}={count}", key.replace([' ', '='], "_"))).collect();
        *last = now;
        (!changed.is_empty()).then(|| format!("namespace-counters {}", changed.join(" ")))
    }
}

/// Start the process's one counter flush: every `period`, the global registry's `changes` go to `sink` (the host
/// passes its stderr). It runs on its own named thread for the life of the process; a second call starts nothing.
pub fn flush_changes_every(period: Duration, sink: fn(&str)) {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let registry = Registry::global();
        let mut last = BTreeMap::new();
        // A host that cannot start the thread still serves; its counts stay readable in `snapshot()`.
        let _ = std::thread::Builder::new().name("namespace-counters".into()).spawn(move || loop {
            std::thread::sleep(period);
            if let Some(line) = registry.changes(&mut last) {
                sink(&line);
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_resolved_cell_is_the_registry_cell_and_keys_are_bounded() {
        let registry = Registry::default();
        registry.cell("a").fetch_add(2, Ordering::Relaxed);
        registry.cell("a").fetch_add(3, Ordering::Relaxed);
        assert_eq!(registry.snapshot()["a"], 5);
        for n in 0..MOST_KEYS + 10 {
            registry.cell(&format!("k{n}")).fetch_add(1, Ordering::Relaxed);
        }
        let snapshot = registry.snapshot();
        assert!(snapshot.len() <= MOST_KEYS + 1, "{}", snapshot.len());
        assert!(snapshot[OVERFLOW] >= 10);
    }

    #[test]
    fn a_flush_names_only_the_counts_that_changed_and_nothing_when_idle() {
        let registry = Registry::default();
        let mut last = BTreeMap::new();
        assert_eq!(registry.changes(&mut last), None, "an empty registry flushes nothing");
        registry.cell("namespace.bytes.unmetered.workshop run outputs.written").fetch_add(7, Ordering::Relaxed);
        registry.cell("b").fetch_add(1, Ordering::Relaxed);
        assert_eq!(registry.changes(&mut last).as_deref(),
            Some("namespace-counters b=1 namespace.bytes.unmetered.workshop_run_outputs.written=7"));
        assert_eq!(registry.changes(&mut last), None, "nothing changed, nothing written");
        registry.cell("b").fetch_add(2, Ordering::Relaxed);
        assert_eq!(registry.changes(&mut last).as_deref(), Some("namespace-counters b=3"));
    }
}
