//! The one admitted handle of every physical read and write of account files file bytes.
//!
//! Every byte port takes its caller's `CallControl`, and every control carries
//! exactly one `Admission`: the byte check that lets a read or write through. A new endpoint inherits metering by
//! building its control; it writes no metering code. The byte check knows bytes only: no
//! customer, plan, price or markup lives here.
//!
//! - `Admission::none()` (the default of a control): every physical read and
//!   write is refused before any request is sent. No byte reaches a store
//!   without a byte check that names who it is for.
//! - `Allowance` (metered): a resident in-memory byte balance. On the request
//!   path a byte check is one lock-free compare-and-swap subtraction, and its
//!   observation one atomic counter add. No file, record, lock wait or network
//!   is touched for metering on that path. A request the balance cannot cover
//!   is refused before anything is sent to the store.
//! - `Unmetered` (named): an operator tool, a stand-in test, or trillion-local's own
//!   kept run outputs (`AccountFilesDoor::run_outputs_control`) says why in a
//!   `&'static str`, so every unmetered reader and writer is greppable
//!   (`Unmetered::new`, `S3Objects::unmetered`).
//!
//! Off the request path, an `Allowance`'s own thread holds chunks from its
//! `Supply` (the generic hold owner, `resource_authority::budget::account_files`)
//! when the balance falls below its low-water mark, and settles each chunk once
//! when it is used up. A funded reader never waits on that thread. A chunk that
//! is never settled (a crash) stays held at its owner: it counts as consumed,
//! never as unused. A dropped handle settles its open chunks as wholly consumed.
//! Durability costs one hold per chunk, never one per read.
//!
//! A store request that carries no file bytes (a HEAD that stats one object, a
//! key listing) asks the same byte check (`admit_lookup`) and is counted after
//! (`looked_up`): the empty check refuses it before it is sent, a metered
//! allowance takes the most bytes its answer may carry and gets back what the
//! answer did not carry, and each one also adds to the account's own usage
//! counts (`stat_requests`, `list_requests`, `listed_bytes`). An answer whose
//! size is unknown keeps the whole bound taken: never counted as zero.

use super::{counters::Registry, objects::ObjectError, usage::Tally};
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, OnceLock},
    thread::Thread,
};

/// One physical read attempt. Private object keys and file contents never enter the accounting seam.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SourceRead {
    pub origin: String,
    pub offset: u64,
    pub requested_bytes: u64,
}

/// Why this attempt stopped. `Complete` means a valid bounded range was read;
/// it does not prove that a remote client consumed the account files answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadOutcome {
    Complete,
    Refused,
    RangeNotHonoured,
    /// Deadline, cancellation or current authority ended during this attempt.
    Interrupted,
    Incomplete,
}

/// Source work actually observed by this transport, separate from the bytes
/// returned by it. Buffered response-body bytes count even when a later rights
/// check withholds them. `None` preserves uncertainty when no complete response
/// head established the boundary; it is never recorded as a measured zero.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SourceReadObservation {
    pub request_started: bool,
    pub response_status: Option<u16>,
    pub source_body_bytes_observed: Option<u64>,
    pub bytes_returned: u64,
    pub outcome: ReadOutcome,
}

/// The off-path owner an `Allowance` holds its chunks from. `hold` is durable
/// before it answers (the chunk is held at its owner), and may block or fail:
/// only the allowance's own thread calls it.
pub trait Supply: Send + Sync {
    fn hold(&self, bytes: u64) -> Result<Box<dyn Chunk>, ObjectError>;
}

/// One held chunk, settled exactly once with the bytes consumed from it.
pub trait Chunk: Send {
    fn settle(self: Box<Self>, consumed: u64) -> Result<(), ObjectError>;
}

/// A store request that carries no file bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lookup {
    /// One HEAD: the size and media type of one object.
    Stat,
    /// One key listing page.
    List,
}

/// The counter cells of one byte check kind, resolved once when the handle is built.
#[derive(Clone)]
struct Cells {
    read_observed: Arc<AtomicU64>,
    read_unknown: Arc<AtomicU64>,
    read_failed: Arc<AtomicU64>,
    written: Arc<AtomicU64>,
    refused: Arc<AtomicU64>,
    holds_refused: Arc<AtomicU64>,
    settles_failed: Arc<AtomicU64>,
    stat_requests: Arc<AtomicU64>,
    list_requests: Arc<AtomicU64>,
    listed_bytes: Arc<AtomicU64>,
}
impl Cells {
    fn of(registry: &Registry, kind: &str) -> Self {
        let cell = |what: &str| registry.cell(&format!("namespace.bytes.{kind}.{what}"));
        Self {
            read_observed: cell("read_observed"), read_unknown: cell("read_unknown"), read_failed: cell("read_failed"),
            written: cell("written"), refused: cell("refused"), holds_refused: cell("holds_refused"),
            settles_failed: cell("settles_failed"), stat_requests: cell("stat_requests"),
            list_requests: cell("list_requests"), listed_bytes: cell("listed_bytes"),
        }
    }
}

/// A named unmetered byte check: counted, never limited. Only operator tools, stand-in tests and trillion-local's own kept
/// run outputs use it.
pub struct Unmetered {
    reason: &'static str,
    cells: Cells,
}
impl Unmetered {
    pub fn new(reason: &'static str) -> Self {
        Self { reason, cells: Cells::of(&Registry::global(), &format!("unmetered.{reason}")) }
    }
    pub fn reason(&self) -> &'static str { self.reason }
}

/// What the request path and the allowance's thread share.
struct Shared {
    resident: AtomicU64,
    wanted: AtomicBool,
    closed: AtomicBool,
}

/// A resident byte allowance held in chunks from a `Supply`.
pub struct Allowance {
    shared: Arc<Shared>,
    low_water: u64,
    worker: Thread,
    cells: Cells,
}

impl Allowance {
    /// Hold the first chunk (host setup, before any request), then keep the
    /// balance above `low_water` from a thread of its own. `registry` holds the
    /// counters (`Registry::global()` unless a test gives its own).
    pub fn open(supply: Arc<dyn Supply>, chunk_bytes: u64, low_water: u64, registry: &Registry) -> Result<Arc<Self>, ObjectError> {
        if chunk_bytes == 0 || low_water > chunk_bytes {
            return Err(ObjectError::Unavailable("an allowance chunk is at least one byte and at least its low-water mark".into(), crate::cause!()));
        }
        let first = supply.hold(chunk_bytes)?;
        let shared = Arc::new(Shared { resident: AtomicU64::new(chunk_bytes), wanted: AtomicBool::new(false), closed: AtomicBool::new(false) });
        let cells = Cells::of(registry, "metered");
        let refill = Refill { supply, chunk_bytes, low_water, shared: shared.clone(), cells: cells.clone() };
        // If the thread cannot start, its chunk is dropped unsettled: it stays
        // held at its owner, which counts it as consumed.
        let worker = std::thread::Builder::new().name("namespace-allowance".into())
            .spawn(move || refill.run(first))
            .map_err(|_| ObjectError::Unavailable("the allowance thread did not start".into(), crate::cause!()))?;
        Ok(Arc::new(Self { shared, low_water, worker: worker.thread().clone(), cells }))
    }

    /// The bytes this handle can admit now without waiting.
    pub fn resident(&self) -> u64 {
        self.shared.resident.load(Ordering::Acquire)
    }

    /// One lock-free subtraction; refused (and nothing sent) when the balance cannot cover `bytes`.
    fn take(&self, bytes: u64) -> Result<(), ObjectError> {
        match self.shared.resident.fetch_update(Ordering::AcqRel, Ordering::Acquire, |held| held.checked_sub(bytes)) {
            Ok(held) => {
                if held - bytes < self.low_water { self.want(); }
                Ok(())
            }
            Err(_) => {
                self.cells.refused.fetch_add(1, Ordering::Relaxed);
                self.want();
                Err(ObjectError::Unavailable("the account files byte allowance cannot cover this request".into(), crate::cause!()))
            }
        }
    }

    /// Give back bytes taken for an answer that carried fewer (one atomic add; never waits).
    fn give_back(&self, bytes: u64) {
        if bytes > 0 { self.shared.resident.fetch_add(bytes, Ordering::AcqRel); }
    }

    /// Wake the refill thread at most once per wake; never waits.
    fn want(&self) {
        if !self.shared.wanted.swap(true, Ordering::AcqRel) {
            self.worker.unpark();
        }
    }
}
impl Drop for Allowance {
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::Release);
        self.worker.unpark();
    }
}

/// The allowance's own thread: holds below low water, settles used-up chunks, and settles every open chunk as
/// wholly consumed when the handle is dropped.
struct Refill {
    supply: Arc<dyn Supply>,
    chunk_bytes: u64,
    low_water: u64,
    shared: Arc<Shared>,
    cells: Cells,
}
impl Refill {
    fn run(self, first: Box<dyn Chunk>) {
        let mut open: VecDeque<Box<dyn Chunk>> = VecDeque::from([first]);
        let (mut held, mut settled) = (self.chunk_bytes, 0u64);
        loop {
            self.shared.wanted.store(false, Ordering::Release);
            if self.shared.closed.load(Ordering::Acquire) {
                self.shared.resident.store(0, Ordering::Release);
                for chunk in open.drain(..) { self.settle(chunk); }
                return;
            }
            let resident = self.shared.resident.load(Ordering::Acquire);
            let consumed = held.saturating_sub(resident);
            while consumed >= settled + self.chunk_bytes {
                let Some(chunk) = open.pop_front() else { break };
                self.settle(chunk);
                settled += self.chunk_bytes;
            }
            if resident < self.low_water {
                match self.supply.hold(self.chunk_bytes) {
                    Ok(chunk) => {
                        open.push_back(chunk);
                        held += self.chunk_bytes;
                        self.shared.resident.fetch_add(self.chunk_bytes, Ordering::AcqRel);
                        continue;
                    }
                    Err(_) => { self.cells.holds_refused.fetch_add(1, Ordering::Relaxed); }
                }
            }
            std::thread::park();
        }
    }

    /// A chunk settles as wholly consumed: used up, or left open when its handle went away.
    fn settle(&self, chunk: Box<dyn Chunk>) {
        if chunk.settle(self.chunk_bytes).is_err() {
            // The hold stays held at its owner, which still counts it as consumed.
            self.cells.settles_failed.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[derive(Clone)]
enum Kind {
    None(Cells),
    Metered(Arc<Allowance>),
    Unmetered(Arc<Unmetered>),
}

/// The byte check every `CallControl` carries; every byte port asks it before
/// sending a request and tells it what was observed after. A route that knows
/// whose call it is gives it that account's `Tally` (`counting`): every byte
/// the handle then writes or observes read is also added to that account's
/// own usage counts (`usage.rs`), with one more atomic add and nothing else.
#[derive(Clone)]
pub struct Admission(Kind, Option<Arc<Tally>>);

impl Admission {
    /// No byte check: every physical read and write is refused before dispatch.
    pub fn none() -> Self {
        static NONE: OnceLock<Cells> = OnceLock::new();
        Self(Kind::None(NONE.get_or_init(|| Cells::of(&Registry::global(), "none")).clone()), None)
    }

    /// The same byte check, also counting every byte it admits for the account `tally` belongs to.
    pub fn counting(mut self, tally: Arc<Tally>) -> Self {
        self.1 = Some(tally);
        self
    }

    pub fn is_none(&self) -> bool { matches!(self.0, Kind::None(_)) }

    fn cells(&self) -> &Cells {
        match &self.0 {
            Kind::None(cells) => cells,
            Kind::Metered(allowance) => &allowance.cells,
            Kind::Unmetered(unmetered) => &unmetered.cells,
        }
    }

    /// Before a read is sent: refused when there is no byte check or the allowance cannot cover it.
    pub fn admit_read(&self, read: &SourceRead) -> Result<(), ObjectError> {
        match &self.0 {
            Kind::None(cells) => refused(cells, "a source read needs its caller's read admission", crate::cause!()),
            Kind::Metered(allowance) => allowance.take(read.requested_bytes),
            Kind::Unmetered(_) => Ok(()),
        }
    }

    /// After a read: one counter add when it completed; an unknown boundary is counted apart, never as zero.
    pub fn observed_read(&self, observation: &SourceReadObservation) {
        let cells = self.cells();
        if let Some(bytes) = observation.source_body_bytes_observed {
            cells.read_observed.fetch_add(bytes, Ordering::Relaxed);
            if let Some(tally) = &self.1 { tally.read(bytes); }
        }
        if observation.outcome != ReadOutcome::Complete || observation.source_body_bytes_observed.is_none() {
            cells.read_failed.fetch_add(1, Ordering::Relaxed);
            if observation.request_started && observation.source_body_bytes_observed.is_none() {
                cells.read_unknown.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Before a write is sent: refused when there is no byte check or the allowance cannot cover it.
    pub fn admit_write(&self, bytes: u64) -> Result<(), ObjectError> {
        match &self.0 {
            Kind::None(cells) => refused(cells, "a source write needs its caller's write admission", crate::cause!()),
            Kind::Metered(allowance) => allowance.take(bytes),
            Kind::Unmetered(_) => Ok(()),
        }
    }

    /// Before a stat or listing request is sent: refused under the empty
    /// byte check; a metered allowance takes `bound`, the most bytes its answer
    /// may carry (0 for a HEAD), and refuses when it cannot cover it.
    pub fn admit_lookup(&self, _lookup: Lookup, bound: u64) -> Result<(), ObjectError> {
        match &self.0 {
            Kind::None(cells) => refused(cells, "a store stat or listing needs its caller's admission", crate::cause!()),
            Kind::Metered(allowance) => allowance.take(bound),
            Kind::Unmetered(_) => Ok(()),
        }
    }

    /// After a stat or listing request was attempted: one request counted, and the answer's `observed` bytes (None
    /// when no answer established them). A metered allowance gets back `bound` less what was observed; an unknown
    /// answer keeps the whole bound.
    pub fn looked_up(&self, lookup: Lookup, bound: u64, observed: Option<u64>) {
        let cells = self.cells();
        let carried = observed.unwrap_or(bound);
        match lookup {
            Lookup::Stat => cells.stat_requests.fetch_add(1, Ordering::Relaxed),
            Lookup::List => cells.list_requests.fetch_add(1, Ordering::Relaxed),
        };
        cells.listed_bytes.fetch_add(carried, Ordering::Relaxed);
        if let Some(tally) = &self.1 { tally.looked_up(lookup, carried); }
        if let (Kind::Metered(allowance), Some(observed)) = (&self.0, observed) {
            allowance.give_back(bound.saturating_sub(observed));
        }
    }

    /// After a write was attempted: its admitted bytes, sent or not, counted once.
    pub fn wrote(&self, bytes: u64) {
        self.cells().written.fetch_add(bytes, Ordering::Relaxed);
        if let Some(tally) = &self.1 { tally.stored(bytes); }
    }
}
/// A request with no byte check: counted as refused, and nothing is sent.
fn refused(cells: &Cells, why: &str, cause: crate::refusal_cause::Cause) -> Result<(), ObjectError> {
    cells.refused.fetch_add(1, Ordering::Relaxed);
    Err(ObjectError::Unavailable(why.into(), cause))
}
impl From<Arc<Allowance>> for Admission {
    fn from(allowance: Arc<Allowance>) -> Self { Self(Kind::Metered(allowance), None) }
}
impl From<Unmetered> for Admission {
    fn from(unmetered: Unmetered) -> Self { Self(Kind::Unmetered(Arc::new(unmetered)), None) }
}
