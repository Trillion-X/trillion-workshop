// src/records/changes.rs
//
// Purpose: The one per-account change notifier: it tells the account's readers (the wake ticker and the live owner)
// that records moved, and where (resource, sequence), the moment a write is durable, so neither polls the store.
//
// Non-Negotiable Invariants:
// - A change is published only after the write that made it is durable (the one write owner publishes after its
//   commit), so a reader that is told and then reads the store finds it.
// - Publishing never waits on a reader and costs the same whatever the number of readers: one generation bump and one
//   bounded ring entry per change. Readers keep their own cursor and filter by resource themselves.
// - The ring holds at most `max_kept` changes (DATA). A reader that fell behind what the ring still holds is told
//   `Gap` and reads the store again from its own last sequence; nothing is ever dropped silently.
// - It carries no value and no right: only (resource, kind, record id, sequence), so a windowed list can tell whether a
//   change touches its window. Readers read values through their own owner with their own rights.
// - There is one notifier per account in the process (`AccountChanges::of`): every writer of that account's records
//   publishes to it and every reader waits on it, whichever store handle or thread they hold.
//
// Key Concepts:
// - `AccountChanges`: the notifier. `of` (the one of an account), `publish` (changes made durable), `nudge`
//   (something else for the readers to look at, like a host event, with no change in the ring), `cursor`.
// - `Cursor::wait`: blocks until the generation moves past what the cursor saw, its stop is set, or its longest wait
//   passes, and answers what moved (`Moved`).
// - `hold` and `HeldChanges`: a write made inside a transaction someone else commits (a native command's lent
//   transaction) is durable only when that owner commits. Its changes are held on the thread that runs the
//   transaction; the owner's `HeldChanges` (made when it begins) publishes them after its commit (`published`), and
//   drops them when it ends any other way.
//
// Security Considerations:
// - Nothing here logs; the ring holds resource names and sequences only.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde::Deserialize;
use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard, OnceLock,
    },
    time::{Duration, Instant},
};

/// The declared product DATA file the notifier's bound is read from.
const DATA: &[u8] = include_bytes!("account-changes.json");
/// How often a waiting cursor looks at its stop.
const STOP_LOOK: Duration = Duration::from_millis(50);

/// src/records/account-changes.json.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    max_kept: usize,
}

/// One durable change: the resource it is in, the kind of the record (the store's kind field, if it has one), the
/// record's id and the sequence (record store stamp) the change took.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Changed {
    pub resource: String,
    /// Complete admitted history context, absent only for the original account
    /// namespace. This is routing evidence, never a right or record value.
    pub scope: Option<serde_json::Value>,
    pub kind: Option<String>,
    pub id: String,
    pub sequence: i64,
}

/// What a cursor's wait saw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Moved {
    /// These changes were published since the cursor last looked, oldest first.
    Changes(Vec<Changed>),
    /// Only a nudge moved the generation: no change is in the ring for it.
    Nudged,
    /// The cursor fell behind what the ring holds: read the store again from the reader's own last sequence.
    Gap,
    /// Nothing moved before the stop or the longest wait.
    Still,
}

#[derive(Debug)]
struct State {
    /// Moves once per publish and per nudge.
    generation: u64,
    /// The newest changes, each with the generation of the publish that made it.
    ring: VecDeque<(u64, Changed)>,
    /// The newest generation whose changes have left the ring.
    evicted_through: u64,
}

/// The notifier of one account.
#[derive(Debug)]
pub struct AccountChanges {
    max_kept: usize,
    state: Mutex<State>,
    moved: Condvar,
}

impl AccountChanges {
    /// The one notifier of `account` in this process, made with the shipped bound on first use; None when the DATA
    /// cannot be read (then nothing is published and readers fall back to their own pace).
    pub fn of(account: &str) -> Option<Arc<Self>> {
        static ACCOUNTS: OnceLock<Mutex<BTreeMap<String, Arc<AccountChanges>>>> = OnceLock::new();
        let mut accounts = ACCOUNTS.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(changes) = accounts.get(account) {
            return Some(changes.clone());
        }
        let changes = Arc::new(Self::shipped()?);
        accounts.insert(account.to_owned(), changes.clone());
        Some(changes)
    }

    /// The notifier with the shipped bound (src/records/account-changes.json).
    pub fn shipped() -> Option<Self> {
        Self::from_data(DATA)
    }

    pub fn from_data(bytes: &[u8]) -> Option<Self> {
        let settings: Settings = serde_json::from_slice(bytes).ok()?;
        (settings.max_kept > 0).then(|| Self::with_bound(settings.max_kept))
    }

    fn with_bound(max_kept: usize) -> Self {
        Self {
            max_kept,
            state: Mutex::new(State { generation: 0, ring: VecDeque::new(), evicted_through: 0 }),
            moved: Condvar::new(),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Changes one write made durable, in the order it made them. Called by the write owner after its commit, never
    /// before; an empty list publishes nothing.
    pub fn publish(&self, changes: impl IntoIterator<Item = Changed>) {
        let mut state = self.state();
        let generation = state.generation + 1;
        let before = state.ring.len();
        state.ring.extend(changes.into_iter().map(|changed| (generation, changed)));
        if state.ring.len() == before {
            return;
        }
        state.generation = generation;
        while state.ring.len() > self.max_kept {
            if let Some((evicted, _)) = state.ring.pop_front() {
                state.evicted_through = evicted;
            }
        }
        drop(state);
        self.moved.notify_all();
    }

    /// Wake every waiting cursor with no change in the ring (`Moved::Nudged`): something else is there for the
    /// readers to look at, like an event the computer sent.
    pub fn nudge(&self) {
        let mut state = self.state();
        state.generation += 1;
        drop(state);
        self.moved.notify_all();
    }

    /// A cursor that has seen everything published so far.
    pub fn cursor(&self) -> Cursor {
        Cursor { seen: self.state().generation }
    }
}

thread_local! {
    /// Changes written inside a transaction this thread runs and another owner commits, by account, until that owner
    /// commits (`publish_held`) or rolls back (`drop_held`).
    static HELD: RefCell<Vec<(String, Changed)>> = const { RefCell::new(Vec::new()) };
    static HELD_SCOPE: RefCell<Option<serde_json::Value>> = const { RefCell::new(None) };
}

/// Hold `changes` of `account`, written inside a transaction its owner has not committed yet.
pub fn hold(account: &str, changes: impl IntoIterator<Item = Changed>) {
    let scope = HELD_SCOPE.with(|scope| scope.borrow().clone());
    HELD.with(|held| held.borrow_mut().extend(changes.into_iter().map(|mut changed| {
        // Only the admitted outer transaction chooses its history. An inner
        // record supply cannot redirect a notice to another namespace.
        changed.scope = scope.clone();
        (account.to_owned(), changed)
    })));
}

/// The resources of `account` that changes held on this thread (written, not yet committed) belong to, in order and
/// once each. A copy's writer reads them before it commits, to send those changes to a second copy first
/// (`account/computers/copies.rs`).
pub fn held_resources(account: &str) -> Vec<String> {
    HELD.with(|held| {
        let mut resources: Vec<String> = Vec::new();
        for (owner, changed) in held.borrow().iter() {
            if owner == account && !resources.contains(&changed.resource) {
                resources.push(changed.resource.clone());
            }
        }
        resources
    })
}

/// The changes held for one transaction this thread runs, from its begin to its end. Dropped without `published`
/// (a rollback, an unknown outcome, an early return), it lets them go unpublished.
pub struct HeldChanges(());
impl HeldChanges {
    /// The transaction begins: anything a transaction before it left held is let go.
    pub fn begin() -> Self {
        Self::begin_in_scope(None)
    }
    /// A command's complete admitted scope, retained with its unpublished
    /// effects. A rollback forgets this context as well as the notices.
    pub fn begin_in_scope(scope: Option<serde_json::Value>) -> Self {
        drop_held();
        HELD_SCOPE.with(|held| *held.borrow_mut() = scope);
        Self(())
    }
    /// The transaction committed: publish what it held.
    pub fn published(self) {
        publish_held();
    }
}
impl Drop for HeldChanges {
    fn drop(&mut self) {
        drop_held();
    }
}

/// The transaction this thread ran committed: publish what it held, to each account's notifier, in order.
fn publish_held() {
    let held = HELD.with(|held| std::mem::take(&mut *held.borrow_mut()));
    let mut by_account: BTreeMap<String, Vec<Changed>> = BTreeMap::new();
    for (account, changed) in held {
        by_account.entry(account).or_default().push(changed);
    }
    for (account, changes) in by_account {
        if let Some(notifier) = AccountChanges::of(&account) {
            notifier.publish(changes);
        }
    }
}

/// The transaction this thread ran rolled back, or its outcome is unknown: what it held is let go unpublished.
fn drop_held() {
    HELD.with(|held| held.borrow_mut().clear());
    HELD_SCOPE.with(|held| *held.borrow_mut() = None);
}

/// One reader's position in the notifier.
#[derive(Clone, Copy, Debug)]
pub struct Cursor {
    seen: u64,
}

impl Cursor {
    /// Wait until something is published or nudged after what this cursor saw, `stop` is set, or `longest` passes;
    /// answer what moved and move the cursor past it.
    pub fn wait(&mut self, changes: &AccountChanges, longest: Duration, stop: &AtomicBool) -> Moved {
        let until = Instant::now() + longest;
        let mut state = changes.state();
        loop {
            if state.generation != self.seen {
                let seen = std::mem::replace(&mut self.seen, state.generation);
                if state.evicted_through > seen {
                    return Moved::Gap;
                }
                let moved: Vec<Changed> =
                    state.ring.iter().filter(|(generation, _)| *generation > seen).map(|(_, changed)| changed.clone()).collect();
                return if moved.is_empty() { Moved::Nudged } else { Moved::Changes(moved) };
            }
            let left = until.saturating_duration_since(Instant::now());
            if stop.load(Ordering::Acquire) || left.is_zero() {
                return Moved::Still;
            }
            state = changes.moved.wait_timeout(state, left.min(STOP_LOOK)).map_or_else(|poisoned| poisoned.into_inner().0, |(state, _)| state);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::Arc, thread};

    fn changed(resource: &str, sequence: i64) -> Changed {
        Changed { resource: resource.into(), scope: None, kind: Some("note".into()), id: format!("note-{sequence}"), sequence }
    }

    #[test]
    fn a_cursor_sees_each_published_change_once_in_order() {
        let changes = AccountChanges::with_bound(8);
        let stop = AtomicBool::new(false);
        let mut cursor = changes.cursor();
        changes.publish([changed("own-records", 4), changed("wake-book", 5)]);
        changes.publish([changed("own-records", 6)]);
        assert_eq!(cursor.wait(&changes, Duration::ZERO, &stop),
            Moved::Changes(vec![changed("own-records", 4), changed("wake-book", 5), changed("own-records", 6)]));
        assert_eq!(cursor.wait(&changes, Duration::ZERO, &stop), Moved::Still, "nothing new");
        changes.publish([]);
        assert_eq!(cursor.wait(&changes, Duration::ZERO, &stop), Moved::Still, "an empty publish moves nothing");
    }

    #[test]
    fn two_cursors_read_the_same_ring_independently() {
        let changes = AccountChanges::with_bound(8);
        let stop = AtomicBool::new(false);
        let (mut wake, mut live) = (changes.cursor(), changes.cursor());
        changes.publish([changed("a", 1)]);
        assert_eq!(wake.wait(&changes, Duration::ZERO, &stop), Moved::Changes(vec![changed("a", 1)]));
        changes.publish([changed("b", 2)]);
        assert_eq!(live.wait(&changes, Duration::ZERO, &stop), Moved::Changes(vec![changed("a", 1), changed("b", 2)]));
        assert_eq!(wake.wait(&changes, Duration::ZERO, &stop), Moved::Changes(vec![changed("b", 2)]));
    }

    #[test]
    fn a_cursor_behind_the_ring_is_told_gap_and_one_within_it_is_not() {
        let changes = AccountChanges::with_bound(2);
        let stop = AtomicBool::new(false);
        let (mut behind, mut close) = (changes.cursor(), changes.cursor());
        changes.publish([changed("a", 1)]);
        assert_eq!(close.wait(&changes, Duration::ZERO, &stop), Moved::Changes(vec![changed("a", 1)]));
        changes.publish([changed("a", 2), changed("a", 3)]);
        assert_eq!(behind.wait(&changes, Duration::ZERO, &stop), Moved::Gap, "change 1 left the ring");
        assert_eq!(close.wait(&changes, Duration::ZERO, &stop), Moved::Changes(vec![changed("a", 2), changed("a", 3)]));
        assert_eq!(behind.wait(&changes, Duration::ZERO, &stop), Moved::Still, "after a gap the cursor is current");
    }

    #[test]
    fn a_nudge_wakes_a_waiting_cursor_with_no_change_and_a_stop_ends_the_wait() {
        let changes = Arc::new(AccountChanges::with_bound(4));
        let stop = AtomicBool::new(false);
        let mut cursor = changes.cursor();
        let nudger = changes.clone();
        let started = Instant::now();
        let waited = thread::scope(|scope| {
            scope.spawn(move || {
                thread::sleep(Duration::from_millis(50));
                nudger.nudge();
            });
            cursor.wait(&changes, Duration::from_secs(30), &stop)
        });
        assert_eq!(waited, Moved::Nudged);
        assert!(started.elapsed() < Duration::from_secs(5));
        let stopped = AtomicBool::new(true);
        let started = Instant::now();
        assert_eq!(cursor.wait(&changes, Duration::from_secs(30), &stopped), Moved::Still);
        assert!(started.elapsed() < Duration::from_secs(1), "a set stop ends the wait at once");
    }

    #[test]
    fn many_waiting_readers_each_see_one_publish_and_publishing_does_not_wait_on_them() {
        let changes = Arc::new(AccountChanges::with_bound(16));
        let stop = AtomicBool::new(false);
        let readers = 64;
        let ready = std::sync::Barrier::new(readers + 1);
        let seen = thread::scope(|scope| {
            let waiting: Vec<_> = (0..readers)
                .map(|_| {
                    let (changes, ready, stop) = (&changes, &ready, &stop);
                    let mut cursor = changes.cursor();
                    scope.spawn(move || {
                        ready.wait();
                        cursor.wait(changes, Duration::from_secs(30), stop)
                    })
                })
                .collect();
            ready.wait();
            // A publish is one bump and one ring entry: its time is the same with 64 readers waiting as with none.
            let started = Instant::now();
            for sequence in 1..=1000 {
                changes.publish([changed("own-records", sequence)]);
            }
            let with_readers = started.elapsed();
            let alone = AccountChanges::with_bound(16);
            let started = Instant::now();
            for sequence in 1..=1000 {
                alone.publish([changed("own-records", sequence)]);
            }
            let without = started.elapsed();
            assert!(with_readers < without * 20 + Duration::from_millis(50), "{with_readers:?} against {without:?}");
            waiting.into_iter().map(|reader| reader.join().unwrap()).collect::<Vec<_>>()
        });
        assert_eq!(seen.len(), readers);
        assert!(seen.iter().all(|moved| matches!(moved, Moved::Changes(changes) if !changes.is_empty()) || *moved == Moved::Gap),
            "each reader is woken and told what moved, or that it fell behind the ring");
    }

    #[test]
    fn held_changes_publish_only_after_their_commit_and_a_rollback_publishes_nothing() {
        let notifier = AccountChanges::of("account-held").unwrap();
        let stop = AtomicBool::new(false);
        let mut cursor = notifier.cursor();
        let rolled_back = HeldChanges::begin();
        hold("account-held", [changed("own-records", 1)]);
        assert_eq!(cursor.wait(&notifier, Duration::ZERO, &stop), Moved::Still, "held, not published");
        drop(rolled_back);
        HeldChanges::begin().published();
        assert_eq!(cursor.wait(&notifier, Duration::ZERO, &stop), Moved::Still, "a rollback publishes nothing");
        let committed = HeldChanges::begin();
        hold("account-held", [changed("own-records", 2)]);
        committed.published();
        assert_eq!(cursor.wait(&notifier, Duration::ZERO, &stop), Moved::Changes(vec![changed("own-records", 2)]));
    }

    #[test]
    fn each_account_has_one_notifier() {
        let (a, again, b) = (AccountChanges::of("account-a").unwrap(), AccountChanges::of("account-a").unwrap(),
            AccountChanges::of("account-b").unwrap());
        assert!(Arc::ptr_eq(&a, &again));
        assert!(!Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn committed_duplicate_ids_and_sequences_keep_their_history_and_rollback_drops_it() {
        let notifier = AccountChanges::of("synthetic-history-notices").unwrap();
        let stop = AtomicBool::new(false);
        let mut cursor = notifier.cursor();
        let context = |id| serde_json::json!({"id":id,"incarnation":"first","generation":1});
        for id in ["a", "b"] {
            let held = HeldChanges::begin_in_scope(Some(context(id)));
            hold("synthetic-history-notices", [changed("own-records", 1)]);
            assert_eq!(cursor.wait(&notifier, Duration::ZERO, &stop), Moved::Still);
            held.published();
            let mut expected = changed("own-records", 1);
            expected.scope = Some(context(id));
            assert_eq!(cursor.wait(&notifier, Duration::ZERO, &stop), Moved::Changes(vec![expected]));
        }
        let rolled_back = HeldChanges::begin_in_scope(Some(context("discard")));
        hold("synthetic-history-notices", [changed("own-records", 1)]);
        drop(rolled_back);
        let original = HeldChanges::begin();
        hold("synthetic-history-notices", [changed("own-records", 2)]);
        original.published();
        assert_eq!(cursor.wait(&notifier, Duration::ZERO, &stop), Moved::Changes(vec![changed("own-records", 2)]));
    }

    #[test]
    fn the_shipped_bound_reads() {
        assert!(AccountChanges::shipped().is_some());
    }
}
