// src/account_files/usage.rs
//
// Purpose: The three generic quantities trillion-local counts for each account, kept as that account's own rows. Bytes it
// stores (at the admitted file handle, `source_reads::Admission::wrote`), bytes it reads from a source (at the same
// handle, `Admission::observed_read`) and the milliseconds a tool run works (at the one tool invoke,
// `tool_runs::tools::Workshop::run_at_before`). Nothing here knows a price, a margin, a plan or a payer: those are
// rows the tool `tools/take-payments` reads beside these counts (decision: trillion-local counts, the tools
// bills). The old trillion app's meters (trillion src/usage-meters.json `meter:stored-gigabytes` reading `stored-bytes`,
// `meter:service-work` reading `work-cost`, `resource:source-bytes`) map one to one onto the fields of a day row.
//
// Non-Negotiable Invariants:
// - The request path never waits on a row. An account route resolves the account's `Tally` once per call (one read lock on the
//   registry, a write lock only the first time an account counts in a period) and the handle then only adds to its
//   resolved `AtomicU64`s. No store is opened, read or written for metering on a request path.
// - Rows are written off the request path, by the one flush thread (`flush_rows_every`), into the account's own
//   Account files store (`@namespace/usage`, kind `namespace-usage-day`, one row per UTC day). Counts only grow; a
//   flush journals the one write it makes in the tally's own words before the row write and closes it after, and the
//   row names the generation of each pending file it carries (`carried`). When the store is missing, busy or
//   refuses, the journal stays for the next flush, so a failed write never loses a count and never counts twice.
// - A count outlives the process: a tally's words live in the account's pending file beside its files store
//   (`<store file>.usage-<16 hex of the account's BLAKE3>`, one page, mode 0600, mapped shared), so an atomic add is in
//   the file the moment it returns, with no system call on the request path. A process that dies, at any point, loses
//   none: the next process that resolves the account's tally finds the counts and any write in flight there, and every
//   process sharing a state folder adds to the same words (one flush at a time, by the file's lock). Only a tally
//   whose files store does not exist yet, or whose file cannot be mapped, counts in memory (`Tally::is_kept` says which).
// - A day row is written by compare-and-set on the version it was read at, with a request key made of that day and
//   version, so a retried write is the same change and a concurrent writer is a conflict, retried from a new read.
// - `stored_bytes` is a level, read at flush time from the store's own declared totals (each stored file once, however
//   many names it has; the old `stored-bytes` reading); `stored_bytes_written` is the bytes written through the
//   handle that day. A level is what `meter:stored-gigabytes` bills (byte-days); the written count proves the handle
//   saw the bytes.
// - `stat_requests`, `list_requests` and `listed_bytes` are the store requests that carry no file bytes (a HEAD, a key
//   listing page; `source_reads::Lookup`), counted at the same admitted handle, so listing and stat are metered too.
// - `tool_runs` counts the runs the work milliseconds came from, so a reader can tell one long run from many short.
// - Bounded memory: the registry holds only accounts that counted since the last flush; an emptied tally leaves it.
//   Accounts, state folders and counts never become counter-registry keys (`counters.rs` keys stay code-declared).
//
// Known gaps (flagged, not hidden): a machine that loses power can lose what the system had not yet written of the
// pending page (each flush asks for it to be written, `msync`); the counts of an account whose routes are not called again
// in a new process wait in its pending file until it is (nothing walks state folders at start); and a copy of a state
// folder made between a count and its flush carries that pending file, so its counts would reach both copies' rows.
// `stored_bytes` is set to the store's level when a row is written, also for a day a write in flight was left on.
// The flush period is DATA (`account-files-routes.json` `usage.flush_seconds`).

// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{FILE_KIND, USAGE, USAGE_KIND};
use crate::store::{Error, Mutation, Store};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex, OnceLock, RwLock},
    time::Duration,
};

/// The counts of one account, in the order of their words (`Counts::of`).
const FIELDS: usize = 7;
const STORED: usize = 0;
const READ: usize = 1;
const WORK_MS: usize = 2;
const TOOL_RUNS: usize = 3;
const STATS: usize = 4;
const LISTS: usize = 5;
const LISTED: usize = 6;

// The words of one tally, the same in memory and in its pending file: a magic word, the file's own random id, then
// `live` (every count ever added, only ever growing), `applied` (how much of `live` day rows already carry), the
// journal of the one write in flight (`target`, the `live` it brings `applied` up to, and `delta`, what it adds to
// its day row), the journal's generation (0: no write in flight), its day, and the last generation used.
const MAGIC_AT: usize = 0;
const ID_AT: usize = 1;
const LIVE: usize = 2;
const APPLIED: usize = LIVE + FIELDS;
const TARGET: usize = APPLIED + FIELDS;
const DELTA: usize = TARGET + FIELDS;
const GEN: usize = DELTA + FIELDS;
const DAY: usize = GEN + 1;
const NEXT_GEN: usize = DAY + 1;
const WORDS: usize = NEXT_GEN + 1;
/// The bytes of one pending file: one page.
const FILE_BYTES: usize = 4096;
const MAGIC: u64 = u64::from_be_bytes(*b"tusage01");

/// Where a tally's words live: in this process's memory (lost with it), or in the account's pending file, mapped
/// shared, so a count is in the file the moment its atomic add returns and a process death loses none of them.
enum Words {
    Heap(Box<[AtomicU64]>),
    Mapped { at: std::ptr::NonNull<AtomicU64>, file: std::fs::File },
}
// SAFETY: the mapped words are only ever reached as `AtomicU64`s, which are `Send` and `Sync`; the mapping lives as
// long as `Words` and is unmapped once, on drop.
unsafe impl Send for Words {}
unsafe impl Sync for Words {}

impl Words {
    fn heap() -> Self {
        Self::Heap((0..WORDS).map(|_| AtomicU64::new(0)).collect())
    }

    fn at(&self, word: usize) -> &AtomicU64 {
        match self {
            Self::Heap(words) => &words[word],
            // SAFETY: `word < WORDS` and the mapping holds `FILE_BYTES` (more than `WORDS` words), page aligned.
            Self::Mapped { at, .. } => {
                assert!(word < WORDS);
                unsafe { &*at.as_ptr().add(word) }
            }
        }
    }

    /// The account's pending file at `path`, made (one page, mode 0600) when it is missing and its folder exists.
    /// None when it cannot be mapped or is not a pending file of this layout, or this computer has no owner-only shared
    /// files (src/tool_runs/os.rs `OwnerFiles`): the tally then counts in memory.
    fn mapped(path: &Path) -> Option<Self> {
        use crate::tool_runs::os::{Lock, Open, OwnerFiles, This};
        let file = This::open(std::fs::OpenOptions::new().read(true).write(true).create(true), path, Open::owner_only(0o600)).ok()?;
        if !This::lock(&file, Lock::Wait).unwrap_or(false) {
            return None;
        }
        let made = (|| {
            match file.metadata().ok()?.len() {
                0 => file.set_len(FILE_BYTES as u64).ok()?,
                length if length == FILE_BYTES as u64 => {}
                _ => return None,
            }
            let at = This::map_shared(&file, FILE_BYTES).ok()?;
            let words = Self::Mapped { at: at.cast(), file: file.try_clone().ok()? };
            match words.at(MAGIC_AT).load(Ordering::Acquire) {
                0 => {
                    words.at(ID_AT).store(random_id()?, Ordering::Release);
                    words.at(MAGIC_AT).store(MAGIC, Ordering::Release);
                }
                MAGIC if words.at(ID_AT).load(Ordering::Acquire) != 0 => {}
                _ => return None,
            }
            Some(words)
        })();
        let _ = This::lock(&file, Lock::Release);
        made
    }

    /// Hold the file's one writer across processes (the caller holds the tally's own lock in this process).
    fn lock(&self) -> FileLock<'_> {
        if let Self::Mapped { file, .. } = self {
            use crate::tool_runs::os::{Lock, OwnerFiles, This};
            // A failed lock still leaves the in-process lock held.
            let _ = This::lock(file, Lock::Wait);
            return FileLock(Some(file));
        }
        FileLock(None)
    }

    /// Ask the system to write the mapped page to the disk (a process death never needs it; a machine that loses
    /// power loses what was not yet written). Off every request path: only a flush asks.
    fn sync(&self) {
        if let Self::Mapped { at, .. } = self {
            use crate::tool_runs::os::{OwnerFiles, This};
            This::sync_map(at.cast(), FILE_BYTES);
        }
    }

    fn id(&self) -> u64 { self.at(ID_AT).load(Ordering::Acquire) }
    fn is_mapped(&self) -> bool { !matches!(self, Self::Heap(_)) }
}
impl Drop for Words {
    fn drop(&mut self) {
        if let Self::Mapped { at, .. } = self {
            use crate::tool_runs::os::{OwnerFiles, This};
            // The mapping this value made, unmapped once.
            This::unmap(at.cast(), FILE_BYTES);
        }
    }
}

/// The pending file's lock, released when it goes out of scope.
struct FileLock<'a>(Option<&'a std::fs::File>);
impl Drop for FileLock<'_> {
    fn drop(&mut self) {
        if let Some(file) = self.0 {
            use crate::tool_runs::os::{Lock, OwnerFiles, This};
            let _ = This::lock(file, Lock::Release);
        }
    }
}

/// A nonzero random id for a new pending file.
fn random_id() -> Option<u64> {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 8];
    ring::rand::SystemRandom::new().fill(&mut bytes).ok()?;
    Some(u64::from_be_bytes(bytes)).filter(|id| *id != 0)
}

/// The counts of one account not yet carried by a day row.
pub struct Tally {
    words: Words,
    /// The one flush of this tally in this process (the file lock is the one across processes).
    flushing: Mutex<()>,
}

impl Default for Tally {
    fn default() -> Self { Self { words: Words::heap(), flushing: Mutex::new(()) } }
}

impl Tally {
    /// The tally of the account whose pending file is `path`, kept in that file when it can be mapped (a count then
    /// outlives this process), else in memory.
    fn at(path: Option<PathBuf>) -> Self {
        if let Some(words) = path.as_deref().and_then(Words::mapped) {
            return Self { words, flushing: Mutex::new(()) };
        }
        let _ = path;
        Self::default()
    }

    fn add(&self, field: usize, count: u64) { self.words.at(LIVE + field).fetch_add(count, Ordering::Relaxed); }

    /// Bytes the admitted handle wrote to a store for this account.
    pub fn stored(&self, bytes: u64) { self.add(STORED, bytes); }
    /// Bytes the admitted handle observed read from a source for this account.
    pub fn read(&self, bytes: u64) { self.add(READ, bytes); }
    /// One tool run that worked `ms` milliseconds for this account.
    pub fn worked(&self, ms: u64) {
        self.add(WORK_MS, ms);
        self.add(TOOL_RUNS, 1);
    }
    /// One store stat or listing request for this account, whose answer carried `bytes`.
    pub fn looked_up(&self, lookup: super::source_reads::Lookup, bytes: u64) {
        self.add(match lookup { super::source_reads::Lookup::Stat => STATS, super::source_reads::Lookup::List => LISTS }, 1);
        self.add(LISTED, bytes);
    }

    fn load(&self, base: usize) -> [u64; FIELDS] {
        std::array::from_fn(|field| self.words.at(base + field).load(Ordering::Acquire))
    }

    /// The counts no day row carries yet, without taking them (tests and diagnostics).
    pub fn peek(&self) -> Counts {
        let (live, applied) = (self.load(LIVE), self.load(APPLIED));
        Counts::of(std::array::from_fn(|field| live[field].wrapping_sub(applied[field])))
    }

    /// Whether this tally keeps its counts in its account's pending file (they then outlive the process).
    pub fn is_kept(&self) -> bool { self.words.is_mapped() }

    /// Nothing to write: no count past what rows carry, and no write in flight.
    fn is_idle(&self) -> bool { self.peek().is_empty() && self.words.at(GEN).load(Ordering::Acquire) == 0 }
}

/// One account's counts for one write.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub stored_bytes_written: u64,
    pub source_bytes_read: u64,
    pub work_ms: u64,
    pub tool_runs: u64,
    /// Store HEAD requests (one object's size and media type).
    pub stat_requests: u64,
    /// Store key-listing requests.
    pub list_requests: u64,
    /// Bytes the answers of those requests carried (an answer of unknown size counts its whole bound).
    pub listed_bytes: u64,
}
impl Counts {
    fn is_empty(&self) -> bool { *self == Self::default() }
    fn of(words: [u64; FIELDS]) -> Self {
        Self {
            stored_bytes_written: words[STORED], source_bytes_read: words[READ], work_ms: words[WORK_MS],
            tool_runs: words[TOOL_RUNS], stat_requests: words[STATS], list_requests: words[LISTS], listed_bytes: words[LISTED],
        }
    }
}

/// Where one account's counts are kept: the folder of this run's own working files, and the account's id.
type Place = (PathBuf, String);

/// The tallies of every account that counted since the last flush, each with the rows its day rows are written into.
#[derive(Default)]
pub struct Meters {
    tallies: RwLock<HashMap<Place, (Arc<Tally>, Store)>>,
}

impl Meters {
    /// The process's one registry, which every account route and tool run adds to.
    pub fn global() -> Arc<Meters> {
        static GLOBAL: OnceLock<Arc<Meters>> = OnceLock::new();
        GLOBAL.get_or_init(Arc::default).clone()
    }

    /// The tally of `account` whose pending file is in `state_root` and whose day rows go into `store`, made on its first
    /// count in a period. Resolve it once per call.
    pub fn tally(&self, state_root: &Path, store: &Store, account: &str) -> Arc<Tally> {
        let place = (state_root.to_path_buf(), account.to_owned());
        if let Some((tally, _)) = self.tallies.read().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&place) {
            return tally.clone();
        }
        let mut tallies = self.tallies.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        tallies.entry(place).or_insert_with(|| (Arc::new(Tally::at(pending_file(state_root, account))), store.clone())).0.clone()
    }

    /// Every account with a nonzero count, its tally and its rows. An account whose tally is empty and held by no live call
    /// leaves the registry.
    fn counted(&self) -> Vec<(Place, Arc<Tally>, Store)> {
        let mut tallies = self.tallies.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        tallies.retain(|_, (tally, _)| Arc::strong_count(tally) > 1 || !tally.is_idle());
        tallies.iter().filter(|(_, (tally, _))| !tally.is_idle()).map(|(place, (tally, store))| (place.clone(), tally.clone(), store.clone())).collect()
    }
}

/// What one flush did, for its diagnostic line.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Flushed {
    pub written: usize,
    pub carried: usize,
}

/// The most compare-and-set attempts one flush makes for one day row before it carries the counts to the next flush.
const MOST_ATTEMPTS: usize = 4;

/// Write every counted account's counts into its own day row for `day` (`YYYY-MM-DD`, UTC). An account whose store
/// is missing or refuses keeps its counts (and any write in flight) for the next flush.
pub fn flush(meters: &Meters, day: &str, at: &str) -> Flushed {
    let mut flushed = Flushed::default();
    for (_, tally, store) in meters.counted() {
        match flush_tally(&tally, &store, day, at) {
            Ok(true) => flushed.written += 1,
            Ok(false) => {}
            Err(_) => flushed.carried += 1,
        }
    }
    flushed
}

/// One account's flush, exactly once whatever process dies where: first the write a death left in flight, then the
/// counts since. Counts only grow (`live`); a write is journalled in the tally's words before its row is written
/// (`target`, `delta`, the day and a new generation, the generation stored last), the row records the generation it
/// carries for this pending file (`carried`), and only then does `applied` become `target`. A death before the row
/// write leaves the journal, which the next flush writes; a death after it leaves a journal the row already carries,
/// which the next flush only closes. A store that is missing or refuses leaves the journal for the next flush.
fn flush_tally(tally: &Tally, store: &Store, day: &str, at: &str) -> Result<bool, Error> {
    let _one = tally.flushing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _file = tally.words.lock();
    let words = &tally.words;
    let mut wrote = false;
    if words.at(GEN).load(Ordering::Acquire) != 0 {
        close_journal(tally, store, at)?;
        wrote = true;
    }
    let (live, applied) = (tally.load(LIVE), tally.load(APPLIED));
    let delta: [u64; FIELDS] = std::array::from_fn(|field| live[field].wrapping_sub(applied[field]));
    if Counts::of(delta).is_empty() {
        return Ok(wrote);
    }
    let day_word = day_word(day).ok_or(Error::Invalid("a usage day is YYYY-MM-DD", crate::cause!()))?;
    for field in 0..FIELDS {
        words.at(TARGET + field).store(live[field], Ordering::Release);
        words.at(DELTA + field).store(delta[field], Ordering::Release);
    }
    words.at(DAY).store(day_word, Ordering::Release);
    let generation = words.at(NEXT_GEN).load(Ordering::Acquire) + 1;
    words.at(NEXT_GEN).store(generation, Ordering::Release);
    words.at(GEN).store(generation, Ordering::Release);
    words.sync();
    close_journal(tally, store, at)?;
    Ok(true)
}

/// Write the journalled write into its day row unless the row already carries its generation, then close it.
fn close_journal(tally: &Tally, store: &Store, at: &str) -> Result<(), Error> {
    let words = &tally.words;
    let generation = words.at(GEN).load(Ordering::Acquire);
    let day = day_text(words.at(DAY).load(Ordering::Acquire)).ok_or(Error::Invalid("a pending usage write without its day", crate::cause!()))?;
    let delta = Counts::of(tally.load(DELTA));
    add_to_day_once(store, &day, at, &delta, Some((&format!("{:016x}", words.id()), generation)))?;
    for field in 0..FIELDS {
        words.at(APPLIED + field).store(words.at(TARGET + field).load(Ordering::Acquire), Ordering::Release);
    }
    words.at(GEN).store(0, Ordering::Release);
    words.sync();
    Ok(())
}

/// `YYYY-MM-DD` as the number YYYYMMDD, and back.
fn day_word(day: &str) -> Option<u64> {
    is_day(day).then(|| day.replace('-', "").parse().ok()).flatten()
}
fn day_text(word: u64) -> Option<String> {
    let text = format!("{:04}-{:02}-{:02}", word / 10_000, word / 100 % 100, word % 100);
    (word >= 10_000_101 && is_day(&text)).then_some(text)
}
fn is_day(day: &str) -> bool {
    day.len() == 10 && day.bytes().enumerate().all(|(at, byte)| if at == 4 || at == 7 { byte == b'-' } else { byte.is_ascii_digit() })
}

/// The pending file of `account` in `state_root`, named for the account (a hash, never its id). None when the folder is not
/// there: an account's counts are then kept in memory only.
fn pending_file(state_root: &Path, account: &str) -> Option<PathBuf> {
    if !std::fs::symlink_metadata(state_root).is_ok_and(|metadata| metadata.is_dir()) {
        return None;
    }
    let hash = content_crypto::advanced::blake3::hash(account.as_bytes()).to_hex();
    Some(state_root.join(format!("usage-{}", &hash.as_str()[..16])))
}

/// The bytes of every file the account keeps, each stored file once: the declared `namespace-file/origin` totals.
pub fn stored_level(store: &Store) -> Result<u64, Error> {
    let totals = store.totals()?;
    let total = format!("{FILE_KIND}/origin");
    Ok(totals.iter().filter(|row| row.total == total).map(|row| row.sum.max(0) as u64).sum())
}

/// Add `counts` to the account's row for `day`, by compare-and-set on the version it read, and set the day's stored
/// level to what the store holds now.
pub fn add_to_day(store: &Store, day: &str, at: &str, counts: &Counts) -> Result<Value, Error> {
    add_to_day_once(store, day, at, counts, None)
}

/// `add_to_day`, and when `pending` names a pending file and a generation: written only when the row does not yet
/// carry that generation of that file (`carried`), so a write a death interrupted is never added twice.
fn add_to_day_once(store: &Store, day: &str, at: &str, counts: &Counts,
    pending: Option<(&str, u64)>) -> Result<Value, Error> {
    if !is_day(day) {
        return Err(Error::Invalid("a usage day is YYYY-MM-DD", crate::cause!()));
    }
    let mut last = crate::cause!(Error::Unavailable);
    for _ in 0..MOST_ATTEMPTS {
        let (version, held) = store.held_record_with_version(USAGE, day)?;
        let held = held.map(|record| record.value);
        let mut carried = held.as_ref().and_then(|value| value.get("carried")).cloned().unwrap_or_else(|| json!({}));
        if let Some((file, generation)) = pending {
            if carried.get(file).and_then(Value::as_u64).is_some_and(|done| done >= generation) {
                return Ok(held.unwrap_or(Value::Null));
            }
            carried[file] = json!(generation);
        }
        let old = |field: &str| held.as_ref().and_then(|record| record.get(field)).and_then(Value::as_u64).unwrap_or(0);
        let value = json!({
            "kind": USAGE_KIND,
            "day": day,
            "stored_bytes": stored_level(store)?,
            "stored_bytes_written": old("stored_bytes_written").saturating_add(counts.stored_bytes_written),
            "source_bytes_read": old("source_bytes_read").saturating_add(counts.source_bytes_read),
            "work_ms": old("work_ms").saturating_add(counts.work_ms),
            "tool_runs": old("tool_runs").saturating_add(counts.tool_runs),
            "stat_requests": old("stat_requests").saturating_add(counts.stat_requests),
            "list_requests": old("list_requests").saturating_add(counts.list_requests),
            "listed_bytes": old("listed_bytes").saturating_add(counts.listed_bytes),
            "flushes": old("flushes").saturating_add(1),
            "carried": carried,
            "updated_at": at,
        });
        let mutation = Mutation {
            id: day.to_owned(), expected_version: version, request_key: format!("usage:{day}:{version}"), deleted: false,
            value: value.clone(),
        };
        match store.mutate(USAGE, mutation) {
            Ok(_) => return Ok(value),
            Err(Error::Conflict(_)) => last = crate::cause!(Error::Conflict),
            Err(error) => return Err(error),
        }
    }
    Err(last)
}

/// The most day rows one `usage_days` page answers.
pub const MOST_DAYS: usize = 400;

/// `usage_days {after?, limit?}`: the account's day rows in day order, after `after`, at most `limit` (1 up to
/// `MOST_DAYS`, default `MOST_DAYS`), with where the next page starts. Each row's `stored_bytes` is refreshed to the
/// store's level now only for today's row by the flush, never here: this read changes nothing.
pub fn days(store: &Store, after: Option<&str>, limit: Option<usize>) -> Result<Value, Error> {
    let limit = limit.unwrap_or(MOST_DAYS);
    if !(1..=MOST_DAYS).contains(&limit) {
        return Err(Error::Invalid("limit must be 1 up to 400", crate::cause!()));
    }
    let page = store.list_page(USAGE, after.unwrap_or(""), limit)?;
    let next = (page.items.len() == limit).then(|| page.items.last().map(|record| record.id.clone())).flatten();
    let days: Vec<Value> = page.items.into_iter().map(|record| record.value).collect();
    Ok(json!({ "days": days, "next_after": next, "stored_bytes_now": stored_level(store)? }))
}

/// Start the process's one usage flush: every `period`, every counted account's counts go into its own day row. It
/// runs on its own named thread for the life of the process; a second call starts nothing. Each flush that wrote or
/// carried anything sends one line to `sink` (the host's stderr), naming how many accounts, never which.
pub fn flush_rows_every(period: Duration, sink: fn(&str)) {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let meters = Meters::global();
        let _ = std::thread::Builder::new().name("namespace-usage".into()).spawn(move || loop {
            std::thread::sleep(period);
            let now = chrono::Utc::now();
            let flushed = flush(&meters, &now.format("%Y-%m-%d").to_string(), &now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            if flushed != Flushed::default() {
                sink(&format!("namespace-usage written={} carried={}", flushed.written, flushed.carried));
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Change, Changed, Page, Read, Record, Rows, SqlStore, Total};
    use std::sync::atomic::AtomicBool;

    fn store() -> Store {
        Arc::new(SqlStore::memory().unwrap())
    }

    /// Rows that refuse every call while `down` is set.
    struct Flaky {
        rows: Store,
        down: Arc<AtomicBool>,
    }
    impl Flaky {
        fn gate(&self) -> Result<(), Error> {
            if self.down.load(Ordering::SeqCst) {
                return Err(crate::cause!(Error::Unavailable));
            }
            Ok(())
        }
    }
    impl Rows for Flaky {
        fn get(&self, scope: &str, id: &str) -> Result<Read, Error> {
            self.gate()?;
            self.rows.get(scope, id)
        }
        fn get_many(&self, scope: &str, ids: &[&str]) -> Result<Vec<Option<Record>>, Error> {
            self.gate()?;
            self.rows.get_many(scope, ids)
        }
        fn get_scoped(&self, pairs: &[(&str, &str)]) -> Result<Vec<Option<Record>>, Error> {
            self.gate()?;
            self.rows.get_scoped(pairs)
        }
        fn held_record_with_version(&self, scope: &str, id: &str) -> Result<(i64, Option<Record>), Error> {
            self.gate()?;
            self.rows.held_record_with_version(scope, id)
        }
        fn list_page(&self, scope: &str, after: &str, limit: usize) -> Result<Page<Record, String>, Error> {
            self.gate()?;
            self.rows.list_page(scope, after, limit)
        }
        fn ids(&self, scope: &str, after: Option<&str>, limit: usize) -> Result<(Vec<String>, Option<String>), Error> {
            self.gate()?;
            self.rows.ids(scope, after, limit)
        }
        fn mutate(&self, scope: &str, input: Mutation) -> Result<Change, Error> {
            self.gate()?;
            self.rows.mutate(scope, input)
        }
        fn stamp(&self, scope: &str) -> Result<i64, Error> {
            self.gate()?;
            self.rows.stamp(scope)
        }
        fn totals(&self) -> Result<Vec<Total>, Error> {
            self.gate()?;
            self.rows.totals()
        }
        fn search(&self, words: &[String], hits: usize) -> Result<Vec<Record>, Error> {
            self.gate()?;
            self.rows.search(words, hits)
        }
        fn place(&self) -> String {
            self.rows.place()
        }
        fn order(&self) -> Result<i64, Error> {
            self.gate()?;
            self.rows.order()
        }
        fn changes(&self, prefixes: &[&str], after: i64, limit: usize) -> Result<Page<Changed, i64>, Error> {
            self.gate()?;
            self.rows.changes(prefixes, after, limit)
        }
        fn minted(&self, prefixes: &[&str], minted: i64) -> Result<Option<(String, Record)>, Error> {
            self.gate()?;
            self.rows.minted(prefixes, minted)
        }
        fn wait_for_order(&self, after: i64, until: std::time::Instant) -> Result<i64, Error> {
            self.gate()?;
            self.rows.wait_for_order(after, until)
        }
    }

    #[test]
    fn a_day_row_adds_each_flush_and_never_counts_a_retry_twice() {
        let store = store();
        let one = Counts { stored_bytes_written: 5, source_bytes_read: 7, work_ms: 11, tool_runs: 1, ..Counts::default() };
        add_to_day(&store, "2026-11-03", "t1", &one).unwrap();
        let row = add_to_day(&store, "2026-11-03", "t2", &one).unwrap();
        assert_eq!((row["stored_bytes_written"].as_u64(), row["source_bytes_read"].as_u64(), row["work_ms"].as_u64(), row["flushes"].as_u64()),
            (Some(10), Some(14), Some(22), Some(2)));
        assert_eq!(row["kind"], USAGE_KIND);
        let page = days(&store, None, None).unwrap();
        assert_eq!(page["days"].as_array().unwrap().len(), 1);
        assert_eq!(page["days"][0]["work_ms"], 22);
        assert!(add_to_day(&store, "2026-11-3", "t", &one).is_err(), "a malformed day is refused");
        assert!(days(&store, None, Some(0)).is_err());
    }

    #[test]
    fn a_flush_writes_each_counted_account_into_its_own_rows_and_the_next_flush_adds_to_it() {
        let (_state, root) = kept_folder();
        let store = store();
        let meters = Meters::default();
        let tally = meters.tally(&root, &store, "account-1");
        tally.stored(100);
        tally.read(40);
        tally.worked(9);
        assert_eq!(flush(&meters, "2026-11-03", "t1"), Flushed { written: 1, carried: 0 });
        assert_eq!(tally.peek(), Counts::default(), "a written count leaves the tally");
        assert_eq!(flush(&meters, "2026-11-03", "t2"), Flushed::default(), "nothing counted, nothing written");
        tally.read(2);
        assert_eq!(flush(&meters, "2026-11-03", "t3"), Flushed { written: 1, carried: 0 });
        let page = days(&store, None, None).unwrap();
        assert_eq!(page["days"][0]["source_bytes_read"], 42);
        assert_eq!(page["days"][0]["stored_bytes_written"], 100);
        assert_eq!((page["days"][0]["work_ms"].as_u64(), page["days"][0]["tool_runs"].as_u64()), (Some(9), Some(1)));
        assert_eq!(page["days"][0]["flushes"], 2);
    }

    #[test]
    fn a_flush_into_rows_that_refuse_carries_every_count_to_the_next_flush() {
        let down = Arc::new(AtomicBool::new(true));
        let store: Store = Arc::new(Flaky { rows: store(), down: down.clone() });
        let meters = Meters::default();
        let folder = std::env::temp_dir().join(format!("usage-no-folder-{}", std::process::id()));
        let tally = meters.tally(&folder, &store, "account");
        tally.stored(3);
        tally.read(4);
        tally.worked(5);
        drop(tally);
        assert_eq!(flush(&meters, "2026-11-03", "t"), Flushed { written: 0, carried: 1 });
        assert_eq!(meters.tally(&folder, &store, "account").peek(), Counts { stored_bytes_written: 3, source_bytes_read: 4, work_ms: 5, tool_runs: 1, ..Counts::default() });
        down.store(false, Ordering::SeqCst);
        assert_eq!(flush(&meters, "2026-11-03", "t"), Flushed { written: 1, carried: 0 });
        // An account that counted nothing writes nothing and leaves the registry.
        let idle = Meters::default();
        drop(idle.tally(&folder, &store, "idle"));
        assert_eq!(flush(&idle, "2026-11-03", "t"), Flushed::default());
        assert!(idle.tallies.read().unwrap().is_empty());
    }

    /// A new working folder, and its canonical path.
    fn kept_folder() -> (tempfile::TempDir, PathBuf) {
        let state = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(state.path()).unwrap();
        (state, root)
    }

    fn day_row(store: &Store) -> Value {
        days(store, None, None).unwrap()["days"][0].clone()
    }

    #[test]
    fn counts_outlive_the_process_that_counted_them() {
        let (_state, root) = kept_folder();
        let store = store();
        let dead = Meters::default();
        let tally = dead.tally(&root, &store, "account-1");
        assert!(tally.is_kept(), "the tally lives in the account's pending file");
        tally.stored(10);
        tally.read(20);
        tally.looked_up(crate::account_files::source_reads::Lookup::List, 300);
        tally.looked_up(crate::account_files::source_reads::Lookup::Stat, 0);
        // The process dies: no flush, its registry and tally are gone.
        drop(tally);
        drop(dead);
        let next = Meters::default();
        let tally = next.tally(&root, &store, "account-1");
        assert_eq!(tally.peek(), Counts { stored_bytes_written: 10, source_bytes_read: 20, list_requests: 1, stat_requests: 1,
            listed_bytes: 300, ..Counts::default() });
        assert_eq!(flush(&next, "2026-11-04", "t"), Flushed { written: 1, carried: 0 });
        let row = day_row(&store);
        assert_eq!((row["stored_bytes_written"].as_u64(), row["source_bytes_read"].as_u64(), row["list_requests"].as_u64(),
            row["stat_requests"].as_u64(), row["listed_bytes"].as_u64()), (Some(10), Some(20), Some(1), Some(1), Some(300)));
        assert_eq!(tally.peek(), Counts::default());
        // Another account in the same folder has its own file.
        assert_eq!(next.tally(&root, &store, "account-2").peek(), Counts::default());
    }

    #[test]
    fn a_write_a_death_interrupted_is_written_once_before_or_after_its_row() {
        let (_state, root) = kept_folder();
        let down = Arc::new(AtomicBool::new(false));
        let store: Store = Arc::new(Flaky { rows: store(), down: down.clone() });
        let meters = Meters::default();
        let tally = meters.tally(&root, &store, "account-1");
        tally.read(7);
        // Death after the journal, before the row: the rows refuse, so the journal stays in the file.
        down.store(true, Ordering::SeqCst);
        assert_eq!(flush(&meters, "2026-11-04", "t1"), Flushed { written: 0, carried: 1 });
        assert_ne!(tally.words.at(GEN).load(Ordering::Acquire), 0, "the write is journalled");
        tally.read(5);
        down.store(false, Ordering::SeqCst);
        drop(tally);
        drop(meters);
        let meters = Meters::default();
        let tally = meters.tally(&root, &store, "account-1");
        assert_eq!(flush(&meters, "2026-11-04", "t2"), Flushed { written: 1, carried: 0 });
        assert_eq!(day_row(&store)["source_bytes_read"], 12, "the journal and the counts after it, once each");

        // Death after the row, before the journal closed: the row already carries its generation.
        tally.read(100);
        {
            let _file = tally.words.lock();
            let (live, applied) = (tally.load(LIVE), tally.load(APPLIED));
            for field in 0..FIELDS {
                tally.words.at(TARGET + field).store(live[field], Ordering::Release);
                tally.words.at(DELTA + field).store(live[field] - applied[field], Ordering::Release);
            }
            tally.words.at(DAY).store(day_word("2026-11-04").unwrap(), Ordering::Release);
            let generation = tally.words.at(NEXT_GEN).load(Ordering::Acquire) + 1;
            tally.words.at(NEXT_GEN).store(generation, Ordering::Release);
            tally.words.at(GEN).store(generation, Ordering::Release);
            let pending = format!("{:016x}", tally.words.id());
            add_to_day_once(&store, "2026-11-04", "t3", &Counts::of(tally.load(DELTA)), Some((&pending, generation))).unwrap();
        }
        assert_eq!(day_row(&store)["source_bytes_read"], 112);
        assert_eq!(flush(&meters, "2026-11-04", "t4"), Flushed { written: 1, carried: 0 });
        assert_eq!(day_row(&store)["source_bytes_read"], 112, "never added twice");
        assert_eq!(tally.peek(), Counts::default());
        assert_eq!(flush(&meters, "2026-11-04", "t5"), Flushed::default());
    }

    #[test]
    fn a_tally_with_no_folder_counts_in_memory() {
        let meters = Meters::default();
        let tally = meters.tally(Path::new("/no-such-state-folder-for-usage"), &store(), "account");
        assert!(!tally.is_kept());
        tally.read(1);
        assert_eq!(tally.peek().source_bytes_read, 1);
        assert_eq!((day_word("2026-11-04"), day_text(20261104).as_deref()), (Some(20261104), Some("2026-11-04")));
        assert_eq!((day_word("2026-1-04"), day_text(0)), (None, None));
    }
}
