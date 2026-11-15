// src/storage/supplies/kv/mod.rs
//
// Purpose: One `Storage` supply for every ordered key-value store, written once over a small `Backend` (get, batch get,
// ordered range, one guarded atomic batch). A backend only moves bytes: Redis, DynamoDB, MongoDB, S3, CouchDB and
// SurrealDB each provide a `Backend`; the families, keys, orders, partial orders, arrival order, compare-and-set puts,
// scopes and byte totals are built here from the DATA declarations.
//
// Non-Negotiable Invariants:
// - One flat ordered keyspace: row keys, order keys, arrival keys and two meta keys, each under a one-byte prefix and a
//   family id, in the `codec` ordered form. The contract's value order is therefore plain byte order, and a range of
//   the contract is a range of bytes.
// - A scope is a write buffer in this process. Reads inside it see its own writes (the buffer is merged into every
//   get and range). Nothing reaches the store until the outermost scope commits, so a dropped or rolled-back scope has
//   nothing to undo; a dropped handle is a crash and leaves no trace.
// - A row the scope has read from the store is remembered for the scope (up to `KNOWN_BYTES`), so asking for it again
//   costs no round trip. This is sound because the commit is guarded by the header the scope saw with its first read: if
//   any other handle committed since, the commit is refused, and nothing the scope decided from its reads is applied.
// - A commit is one `Backend::apply`: the buffered writes plus the new header, guarded by the header value the scope's
//   first read of the store saw (the header is the first key of that request and rides with it, so it is never newer
//   than a row read after it; a scope that read nothing reads it at commit). If any other handle committed in between, the guard refuses and the commit is `Busy` with
//   nothing applied. This is optimistic serialization over one global version, like SQLite's single writer.
// - A backend whose batch is not one atomic operation says so through `Backend::atomic` and the supply reports it;
//   the supply never claims a guarantee its backend does not give.
// - An operation that fails changes nothing of the buffer (it checks every size before it buffers anything), so the
//   scope stays usable after a refused put.
//
// Key Concepts:
// - `Backend`: the driver seam. `Write`, `Outcome`, `Limits`: batch vocabulary. `Backend::read_many`: keys and ranges
//   in one request (`Ask`: one range of it); the default is a batch get and a range after another, and Redis, CouchDB
//   and SurrealDB answer them in one request.
// - The header: commits (the mark) and total stored bytes, one key, always written by a commit.
// - The write reservation: an outermost write scope, when it first reads the header, writes its handle's hold into the
//   header (guarded by the header it read), and its commit or close takes the hold out again. Another handle's write
//   scope that meets a live hold is refused `Busy` at once, the way SQLite refuses a second `BEGIN IMMEDIATE` and
//   Postgres a second writer of the meta row; and because taking the hold changes the header, a rival that read the
//   header before it cannot commit either. A hold lasts `HOLD_MS` from when it was taken. A handle that ends without
//   closing its scope (`Drop`) gives its hold back; one whose process ended keeps writers out until the hold runs out.
//   A hold that ran out only lets another writer in: the old writer's commit then fails its guard, so a lost hold never
//   lets two commits apply. A read scope's check compares commits and bytes only, so a hold taken or given back is not
//   a change it saw.
// - `Kv<B>`: the `Storage` implementation.
//
// Security Considerations:
// - Keys are built from DATA ids and encoded values, never from caller text.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub mod names;
pub mod wal;

use crate::{
    codec,
    layout::{layouts, FamilyLayout},
};
use local_engine::storage::{
    Bound, Error, Intent, Order, Query, Range, Read, Reply, Result, Row, Schema, Storage, Value, When, Write as Asked, ARRIVAL,
};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap},
};

/// What one backend can carry in a single call.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_key: usize,
    pub max_value: usize,
    /// The most writes one atomic batch holds.
    pub max_writes: usize,
}

/// One change of a batch.
#[derive(Clone, Debug)]
pub enum Write {
    Set(Vec<u8>, Vec<u8>),
    Delete(Vec<u8>),
}

/// What a guarded batch did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Applied,
    /// The guard no longer held: nothing was applied.
    Refused,
}

/// How completely a backend honors an atomic batch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Atomicity {
    /// All writes of a batch become visible together or not at all, for every reader.
    Full,
    /// A batch survives a crash whole (it is finished on the next open), but a concurrent reader may see it half done.
    CrashSafe,
}

/// Entries of a range, in walk order.
pub type Entries = Vec<(Vec<u8>, Vec<u8>)>;

/// What `Backend::read_many` answers: the values of its keys, then the entries of each range.
pub type Fetched = (Vec<Option<Vec<u8>>>, Vec<Entries>);

/// One range of a `Backend::read_many` batch: the arguments of `Backend::range`.
#[derive(Clone, Debug)]
pub struct Ask {
    pub lo: Vec<u8>,
    pub hi: Option<Vec<u8>>,
    pub reverse: bool,
    pub limit: usize,
    pub values: bool,
}

/// The driver seam of a key-value supply.
pub trait Backend {
    fn atomicity(&self) -> Atomicity;
    fn limits(&self) -> Limits;
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>>;
    /// Several keys; the answer lists them in the order asked.
    fn get_many(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>>;
    /// Entries with `lo <= key < hi` (`hi` None: no end), in key order or its reverse, at most `limit`. `values` false
    /// may return empty values.
    fn range(&self, lo: &[u8], hi: Option<&[u8]>, reverse: bool, limit: usize, values: bool) -> Result<Vec<(Vec<u8>, Vec<u8>)>>;
    /// Keys and ranges in one request: the values of `keys` in the order asked, then the entries of each of `asks`. The
    /// request is read as if its keys were read first, in order, and its ranges after them: the supply puts the
    /// header it guards a commit with first among the keys, and a backend must never answer a later key from an
    /// older state than an earlier one. The default is a batch get and one range after another, which is right for a
    /// backend that cannot ask for more in one request.
    fn read_many(&self, keys: &[Vec<u8>], asks: &[Ask]) -> Result<Fetched> {
        let found = if keys.is_empty() { Vec::new() } else { self.get_many(keys)? };
        let ranges = asks.iter().map(|ask| self.range(&ask.lo, ask.hi.as_deref(), ask.reverse, ask.limit, ask.values)).collect::<Result<_>>()?;
        Ok((found, ranges))
    }
    /// Apply `writes` only if the value at `guard.0` equals `guard.1` (None: absent).
    fn apply(&self, guard: (&[u8], Option<&[u8]>), writes: &[Write]) -> Result<Outcome>;
    /// Make deleted bytes leave the server's files, when the server can.
    fn reclaim(&self) -> Result<()> {
        Err(local_engine::cause!(Error::Unavailable))
    }
    /// Network round trips made so far.
    fn rounds(&self) -> u64;
    /// Provider-unit observations for actual backend requests, when available.
    fn measurements(&self) -> Vec<crate::provider_units::Observation> { Vec::new() }
    fn measurement_count(&self) -> usize { self.measurements().len() }
    fn measurements_since(&self, index: usize) -> Vec<crate::provider_units::Observation> { self.measurements().into_iter().skip(index).collect() }
    /// Where the data lives, without credentials.
    fn place(&self) -> String;
}

const ROW: u8 = 1;
const ORDER: u8 = 2;
const ARRIVE: u8 = 3;
const META: u8 = 4;
const HEADER: [u8; 2] = [META, b'H'];
const IDENTITY: [u8; 2] = [META, b'U'];
/// How long a write scope's hold keeps other writers out after it is taken: longer than any one scope the record
/// store holds, short enough that a process that ended while holding one blocks writers only briefly.
const HOLD_MS: u64 = 30_000;
/// Most bytes of rows one scope remembers from its reads.
const KNOWN_BYTES: usize = 16 * 1024 * 1024;
/// Most entries one backend call is asked for while walking a long range.
const CHUNK: usize = 1000;

/// The header value: commits and stored bytes, and the write hold when a write scope holds one.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct Header {
    commits: u64,
    bytes: u64,
    /// The holding handle's token and the time (ms since the epoch) the hold runs out.
    hold: Option<(u64, u64)>,
}
impl Header {
    fn read(raw: Option<&[u8]>) -> Result<Self> {
        let word = |raw: &[u8], at: usize| raw[at..at + 8].try_into().map(u64::from_be_bytes).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error));
        match raw {
            None => Ok(Self::default()),
            Some(raw) if raw.len() == 16 => Ok(Self { commits: word(raw, 0)?, bytes: word(raw, 8)?, hold: None }),
            Some(raw) if raw.len() == 32 => Ok(Self { commits: word(raw, 0)?, bytes: word(raw, 8)?, hold: Some((word(raw, 16)?, word(raw, 24)?)) }),
            Some(_) => Err(local_engine::cause!(Error::Unavailable)),
        }
    }
    fn write(self) -> Vec<u8> {
        let mut raw = self.commits.to_be_bytes().to_vec();
        raw.extend_from_slice(&self.bytes.to_be_bytes());
        if let Some((token, until)) = self.hold {
            raw.extend_from_slice(&token.to_be_bytes());
            raw.extend_from_slice(&until.to_be_bytes());
        }
        raw
    }
    /// The same header with no hold.
    fn released(self) -> Self {
        Self { hold: None, ..self }
    }
    /// Another handle's hold that has not run out yet.
    fn held_by_other(&self, token: u64, now: u64) -> bool {
        self.hold.is_some_and(|(holder, until)| holder != token && until > now)
    }
}

/// Milliseconds since the epoch on this computer's clock.
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// A token for one handle's holds: random per handle, from the standard library's randomly keyed hasher.
fn hold_token() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    hasher.write_u32(std::process::id());
    hasher.finish()
}

/// The scope's own entries inside a range: the key and the entry (`None`: deleted).
type Hidden = Vec<(Vec<u8>, Option<Vec<u8>>)>;

/// What the backend returned for a range, with the scope's own entries `hidden` in it put in place of the store's,
/// cut to `limit`.
fn merge(fetched: Entries, hidden: &Hidden, reverse: bool, limit: usize) -> Entries {
    if hidden.is_empty() {
        return fetched;
    }
    let mut merged: BTreeMap<Vec<u8>, Vec<u8>> = fetched.into_iter().filter(|(key, _)| !hidden.iter().any(|(own, _)| own == key)).collect();
    for (key, entry) in hidden {
        if let Some(value) = entry {
            merged.insert(key.clone(), value.clone());
        }
    }
    let mut entries: Entries = merged.into_iter().collect();
    if reverse {
        entries.reverse();
    }
    entries.truncate(limit);
    entries
}

/// One undone buffer entry: the key, the entry it had before (`None`: no entry), and the stored bytes the change added.
type Undo = (Vec<u8>, Option<Option<Vec<u8>>>, i128);

/// One open outermost scope.
struct Open {
    intent: Intent,
    /// The raw header value the scope's first read of the store saw (the commit's guard); `None` until the scope reads
    /// the store, because the header rides along with that first read. `Some(None)`: the store has no header yet.
    seen: Option<Option<Vec<u8>>>,
    header: Header,
    /// Bytes added or removed so far.
    delta: i128,
    overlay: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    /// What the store answered for a key this scope read (`None`: no such key), and the bytes held.
    known: HashMap<Vec<u8>, Option<Vec<u8>>>,
    known_bytes: usize,
    /// Earlier overlay entries, newest last: `(key, entry before)`; `None` before means the key had no entry.
    undo: Vec<Undo>,
    /// Where each nested scope's undo entries start.
    marks: Vec<usize>,
}

/// One stored row: its arrival position and values in declared field order.
struct Stored {
    arrival: i64,
    values: Vec<Value>,
}

/// One key-value handle implementing `Storage`.
pub struct Kv<B: Backend> {
    backend: B,
    schema: &'static Schema,
    layouts: Vec<FamilyLayout>,
    /// Per family: its id and its orders' ids (declared order names, sorted).
    order_ids: Vec<Vec<String>>,
    scope: RefCell<Option<Open>>,
    changes: Cell<u64>,
    /// Commits this handle applied: `mark` takes them out, so it moves only for other handles' commits (as SQLite's
    /// `data_version`).
    own_commits: Cell<u64>,
    uid: Vec<u8>,
    place: String,
    /// This handle's token in a write hold it takes.
    token: u64,
}

fn id_bytes(id: usize) -> Result<[u8; 2]> {
    u16::try_from(id).map(u16::to_be_bytes).map_err(|error| local_engine::carry_cause!(Error::Invalid, error))
}

impl<B: Backend> Kv<B> {
    /// Open the schema on this backend, writing the identity key if the store is new.
    pub fn open(backend: B, schema: &str) -> Result<Self> {
        let schema = local_engine::storage::schema(schema)?;
        let layouts = layouts(schema);
        let order_ids = schema.families.iter().map(|family| family.orders.keys().cloned().collect()).collect();
        let place = backend.place();
        let mut kv = Self {
            backend,
            schema,
            layouts,
            order_ids,
            scope: RefCell::new(None),
            changes: Cell::new(0),
            own_commits: Cell::new(0),
            uid: Vec::new(),
            place,
            token: hold_token(),
        };
        kv.uid = match kv.backend.get(&IDENTITY)? {
            Some(uid) => uid,
            None => {
                let uid = format!(
                    "{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos())
                )
                .into_bytes();
                // Two handles opening a new store at once: the one whose identity lands first is the store's.
                kv.backend.apply((&IDENTITY, None), &[Write::Set(IDENTITY.to_vec(), uid.clone())])?;
                kv.backend.get(&IDENTITY)?.ok_or(local_engine::cause!(Error::Unavailable))?
            }
        };
        Ok(kv)
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    /// Network round trips made through this handle's backend so far.
    pub fn rounds(&self) -> u64 {
        self.backend.rounds()
    }

    /// Provider-unit observations captured by the underlying backend.
    pub fn measurements(&self) -> Vec<crate::provider_units::Observation> { self.backend.measurements() }
    pub fn measurement_count(&self) -> usize { self.backend.measurement_count() }
    pub fn measurements_since(&self, index: usize) -> Vec<crate::provider_units::Observation> { self.backend.measurements_since(index) }

    fn layout(&self, name: &str) -> Result<(usize, &FamilyLayout)> {
        self.layouts.iter().position(|layout| layout.family.family == name).map(|at| (at, &self.layouts[at])).ok_or(local_engine::cause!(Error::Undeclared))
    }

    fn row_prefix(&self, fid: usize) -> Result<Vec<u8>> {
        let id = id_bytes(fid)?;
        Ok(vec![ROW, id[0], id[1]])
    }

    fn row_key(&self, fid: usize, layout: &FamilyLayout, key: &[Value]) -> Result<Vec<u8>> {
        if key.len() != layout.family.key.len() {
            return Err(local_engine::cause!(Error::Invalid));
        }
        let mut bytes = self.row_prefix(fid)?;
        for one in key {
            codec::ordered(one, &mut bytes)?;
        }
        if bytes.len() > self.backend.limits().max_key {
            return Err(local_engine::cause!(Error::TooBig));
        }
        Ok(bytes)
    }

    fn order_key(&self, fid: usize, layout: &FamilyLayout, order: &str, values: &[Value]) -> Result<Vec<u8>> {
        let oid = self.order_ids[fid].iter().position(|name| name == order).ok_or(local_engine::cause!(Error::Undeclared))?;
        let (family, id, order_id) = (layout.family, id_bytes(fid)?, id_bytes(oid)?);
        let declaration = family.order(order)?;
        let mut bytes = vec![ORDER, id[0], id[1], order_id[0], order_id[1]];
        for field in declaration.fields.iter().chain(&family.key) {
            codec::ordered(&values[layout.index(field)?], &mut bytes)?;
        }
        if bytes.len() > self.backend.limits().max_key {
            return Err(local_engine::cause!(Error::TooBig));
        }
        Ok(bytes)
    }

    fn encode_row(&self, stored: &Stored) -> Result<Vec<u8>> {
        let mut bytes = stored.arrival.to_be_bytes().to_vec();
        for value in &stored.values {
            codec::plain(value, &mut bytes)?;
        }
        if bytes.len() > self.backend.limits().max_value {
            return Err(local_engine::cause!(Error::TooBig));
        }
        Ok(bytes)
    }

    fn decode_row(&self, layout: &FamilyLayout, bytes: &[u8]) -> Result<Stored> {
        let arrival = i64::from_be_bytes(bytes.get(..8).and_then(|head| head.try_into().ok()).ok_or(local_engine::cause!(Error::Unavailable))?);
        let mut at = 8;
        let mut values = Vec::with_capacity(layout.family.fields.len());
        for _ in &layout.family.fields {
            let (value, used) = codec::read_plain(&bytes[at..]).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))?;
            values.push(value);
            at += used;
        }
        Ok(Stored { arrival, values })
    }

    // ---- the layer: backend reads merged with the open scope's buffer ----

    fn raw_get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        Ok(self.raw_get_many(std::slice::from_ref(&key.to_vec()))?.pop().unwrap_or(None))
    }

    /// The entries of `keys`: the scope's own writes first, then what the scope already read, then one batch read of
    /// the rest (each key once), remembered for the scope.
    fn raw_get_many(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>> {
        Ok(self.raw_read(keys, &[])?.0)
    }

    /// The entries of `keys` as `raw_get_many` answers them, and the first chunk of each of `asks` merged with the
    /// scope's own writes: one request to the backend for everything the scope does not hold.
    fn raw_read(&self, keys: &[Vec<u8>], asks: &[(Ask, Hidden)]) -> Result<Fetched> {
        let mut answers: Vec<Option<Option<Vec<u8>>>> = vec![None; keys.len()];
        let mut missing: Vec<usize> = Vec::new();
        {
            let scope = self.scope.borrow();
            for (at, key) in keys.iter().enumerate() {
                let held = scope.as_ref().and_then(|open| open.overlay.get(key).or_else(|| open.known.get(key)));
                match held {
                    Some(entry) => answers[at] = Some(entry.clone()),
                    None => missing.push(at),
                }
            }
        }
        let mut once: HashMap<&[u8], usize> = HashMap::new();
        let mut asked: Vec<Vec<u8>> = Vec::new();
        for at in &missing {
            once.entry(keys[*at].as_slice()).or_insert_with(|| {
                asked.push(keys[*at].clone());
                asked.len() - 1
            });
        }
        let wanted: Vec<Ask> = asks.iter().map(|(ask, _)| ask.clone()).collect();
        let (fetched, chunks) = self.backend_read(&asked, &wanted)?;
        for at in missing {
            answers[at] = Some(fetched[once[keys[at].as_slice()]].clone());
        }
        if let Some(open) = self.scope.borrow_mut().as_mut() {
            for (key, entry) in asked.into_iter().zip(fetched) {
                if open.known_bytes < KNOWN_BYTES {
                    open.known_bytes += key.len() + entry.as_ref().map_or(0, Vec::len);
                    open.known.insert(key, entry);
                }
            }
        }
        let merged = chunks.into_iter().zip(asks).map(|(chunk, (ask, hidden))| merge(chunk, hidden, ask.reverse, ask.limit)).collect();
        Ok((answers.into_iter().map(|answer| answer.unwrap_or(None)).collect(), merged))
    }

    /// One request to the backend. A scope that has not yet seen the header asks for it first in this request, so
    /// the header is never newer than anything the scope reads after it, and a commit in between fails the guard.
    fn backend_read(&self, keys: &[Vec<u8>], asks: &[Ask]) -> Result<Fetched> {
        let unseen = self.scope.borrow().as_ref().is_some_and(|open| open.seen.is_none());
        if !unseen {
            if keys.is_empty() && asks.is_empty() {
                return Ok((Vec::new(), Vec::new()));
            }
            return self.backend.read_many(keys, asks);
        }
        let mut asked = Vec::with_capacity(keys.len() + 1);
        asked.push(HEADER.to_vec());
        asked.extend_from_slice(keys);
        let (mut found, chunks) = self.backend.read_many(&asked, asks)?;
        if found.is_empty() {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        self.settle(found.remove(0))?;
        Ok((found, chunks))
    }

    /// The scope has read the header: `raw` is its value. An outermost write scope takes the write hold here (see the
    /// file header): refused `Busy` when another handle holds it, or when another handle changed the header since.
    fn settle(&self, raw: Option<Vec<u8>>) -> Result<()> {
        let mut header = Header::read(raw.as_deref())?;
        let mut raw = raw;
        if self.scope.borrow().as_ref().is_some_and(|open| open.intent == Intent::Write) {
            let now = now_ms();
            if header.held_by_other(self.token, now) {
                return Err(local_engine::cause!(Error::Busy));
            }
            let held = Header { hold: Some((self.token, now.saturating_add(HOLD_MS))), ..header };
            let written = held.write();
            match self.backend.apply((&HEADER, raw.as_deref()), &[Write::Set(HEADER.to_vec(), written.clone())])? {
                Outcome::Applied => (header, raw) = (held, Some(written)),
                Outcome::Refused => return Err(local_engine::cause!(Error::Busy)),
            }
        }
        if let Some(open) = self.scope.borrow_mut().as_mut() {
            open.header = header;
            open.seen = Some(raw);
        }
        Ok(())
    }

    /// Give back the hold a write scope took, if it took one: the header as it was, without the hold, guarded by the
    /// header the hold wrote. A refusal means the hold had already run out and another writer moved on; nothing is
    /// owed then.
    fn release(&self, open: &Open) -> Result<()> {
        let Some(Some(seen)) = &open.seen else { return Ok(()) };
        if open.intent != Intent::Write || open.header.hold.map(|(holder, _)| holder) != Some(self.token) {
            return Ok(());
        }
        self.backend.apply((&HEADER, Some(seen)), &[Write::Set(HEADER.to_vec(), open.header.released().write())]).map(|_| ())
    }

    /// Make the open scope's header known, reading it from the store when no read has yet.
    fn know_header(&self) -> Result<()> {
        if self.scope.borrow().as_ref().is_some_and(|open| open.seen.is_none()) {
            let raw = self.backend.get(&HEADER)?;
            self.settle(raw)?;
        }
        Ok(())
    }

    /// The backend ask for a range, and the scope's own entries inside it, which the answer is merged with: the
    /// backend is asked for that many more, since some of what it returns they hide.
    fn range_ask(&self, lo: &[u8], hi: Option<&[u8]>, reverse: bool, limit: usize, values: bool) -> (Ask, Hidden) {
        use std::ops::Bound::{Excluded, Included, Unbounded};
        let hidden: Hidden = match self.scope.borrow().as_ref() {
            Some(open) if !open.overlay.is_empty() => open
                .overlay
                .range::<[u8], _>((Included(lo), hi.map_or(Unbounded, Excluded)))
                .map(|(key, entry)| (key.clone(), entry.clone()))
                .collect(),
            _ => Vec::new(),
        };
        let ask = Ask { lo: lo.to_vec(), hi: hi.map(<[u8]>::to_vec), reverse, limit: limit.saturating_add(hidden.len()), values };
        (ask, hidden)
    }

    fn raw_range(&self, lo: &[u8], hi: Option<&[u8]>, reverse: bool, limit: usize, values: bool) -> Result<Entries> {
        let (ask, hidden) = self.range_ask(lo, hi, reverse, limit, values);
        let fetched = self.backend_read(&[], std::slice::from_ref(&ask))?.1.pop().ok_or(local_engine::cause!(Error::Unavailable))?;
        Ok(merge(fetched, &hidden, reverse, limit))
    }

    /// Record a change in the open scope's buffer. `bytes` is how many stored bytes the change adds (negative: removes).
    fn buffer(&self, key: Vec<u8>, entry: Option<Vec<u8>>, bytes: i128) -> Result<()> {
        let mut scope = self.scope.borrow_mut();
        let open = scope.as_mut().ok_or(local_engine::cause!(Error::Invalid))?;
        if open.intent != Intent::Write {
            return Err(local_engine::cause!(Error::ReadOnly));
        }
        let before = open.overlay.insert(key.clone(), entry);
        open.undo.push((key, before, bytes));
        open.delta += bytes;
        Ok(())
    }

    /// Run `work` inside the open scope, or inside a scope of its own when none is open.
    fn atomically<T>(&self, work: impl FnOnce() -> Result<T>) -> Result<T> {
        if self.scope.borrow().is_some() {
            return work();
        }
        self.open_scope(Intent::Write)?;
        match work() {
            Ok(done) => {
                self.close_scope(true)?;
                Ok(done)
            }
            Err(error) => {
                let _ = self.close_scope(false);
                Err(error)
            }
        }
    }

    // ---- ranges ----

    /// The byte range of a contract range over one order, and how many leading cursor fields a bound names.
    fn byte_range(&self, fid: usize, layout: &FamilyLayout, range: &Range<'_>) -> Result<Option<Walk>> {
        let family = layout.family;
        let id = id_bytes(fid)?;
        let (base, cursor_fields) = match range.order {
            Order::Key => (vec![ROW, id[0], id[1]], family.key.len()),
            Order::Named(name) => {
                let oid = self.order_ids[fid].iter().position(|known| known == name).ok_or(local_engine::cause!(Error::Undeclared))?;
                let order_id = id_bytes(oid)?;
                (vec![ORDER, id[0], id[1], order_id[0], order_id[1]], family.order(name)?.fields.len())
            }
            Order::Arrival if family.arrival => (vec![ARRIVE, id[0], id[1]], 1),
            Order::Arrival => return Err(local_engine::cause!(Error::Undeclared)),
        };
        let (lower, upper) = if range.reverse { (&range.to, &range.from) } else { (&range.from, &range.to) };
        let mut guards: Vec<Vec<Vec<u8>>> = Vec::new();
        let mut ends: [Option<(Vec<u8>, bool)>; 2] = [None, None];
        for (slot, bound) in [lower, upper].into_iter().enumerate() {
            let (values, inclusive) = match bound {
                Bound::Unbounded => continue,
                Bound::Included(values) => (values, true),
                Bound::Excluded(values) => (values, false),
            };
            if values.is_empty() || values.len() > cursor_fields {
                return Err(local_engine::cause!(Error::Invalid));
            }
            // A row-value comparison is decided by the first position where the two sides differ, and a NULL on either
            // side is no answer. So a NULL in the bound ends what the bound can say: the rows it selects are those the
            // values before the NULL decide strictly, and a NULL first value selects nothing.
            let (values, inclusive) = match values.iter().position(Value::is_null) {
                Some(0) => return Ok(None),
                Some(at) => (&values[..at], false),
                None => (&values[..], inclusive),
            };
            let mut bytes = base.clone();
            if matches!(range.order, Order::Arrival) {
                bytes.extend_from_slice(&(values[0].as_integer().ok_or(local_engine::cause!(Error::Invalid))? as u64).to_be_bytes());
            } else {
                let mut guard = Vec::with_capacity(values.len());
                for one in values {
                    guard.push(codec::ordered_one(one)?);
                    codec::ordered(one, &mut bytes)?;
                }
                guards.push(guard);
            }
            ends[slot] = Some((bytes, inclusive));
        }
        // From the lower bound's first byte string to the upper bound's end, exclusive.
        let lo = match ends[0].take() {
            None => base.clone(),
            Some((bytes, true)) => bytes,
            Some((bytes, false)) => match codec::prefix_end(&bytes) {
                Some(next) => next,
                None => return Ok(None),
            },
        };
        let hi = match ends[1].take() {
            None => codec::prefix_end(&base),
            Some((bytes, true)) => codec::prefix_end(&bytes),
            Some((bytes, false)) => Some(bytes),
        };
        Ok(Some(Walk { lo, hi, guards, skip: base.len() }))
    }

    /// Walk a byte range in chunks, keeping entries no bound decides at a NULL, until `limit`.
    fn walk(&self, range: Walk, reverse: bool, limit: Option<usize>, values: bool, mut first: Option<Entries>) -> Result<Entries> {
        let Walk { mut lo, mut hi, guards, skip } = range;
        let want = limit.unwrap_or(usize::MAX);
        let mut found: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        loop {
            if found.len() >= want || hi.as_deref().is_some_and(|end| lo.as_slice() >= end) {
                break;
            }
            let ask = (want - found.len()).min(CHUNK);
            let chunk = match first.take() {
                Some(chunk) => chunk,
                None => self.raw_range(&lo, hi.as_deref(), reverse, ask, values)?,
            };
            let more = chunk.len() == ask;
            let last = chunk.last().map(|(key, _)| key.clone());
            for (key, value) in chunk {
                if guards.iter().all(|guard| decided_without_null(&key[skip..], guard)) {
                    found.push((key, value));
                }
            }
            match (more, last) {
                (true, Some(last)) if found.len() < want => {
                    if reverse {
                        hi = Some(last);
                    } else {
                        let mut next = last;
                        next.push(0);
                        lo = next;
                    }
                }
                _ => break,
            }
        }
        found.truncate(want);
        Ok(found)
    }

    /// The backend ask for the first chunk of a walk, when the walk will ask for one.
    fn first_chunk(&self, walk: &Walk, reverse: bool, limit: Option<usize>, values: bool) -> Option<(Ask, Hidden)> {
        let want = limit.unwrap_or(usize::MAX);
        if want == 0 || walk.hi.as_deref().is_some_and(|end| walk.lo.as_slice() >= end) {
            return None;
        }
        Some(self.range_ask(&walk.lo, walk.hi.as_deref(), reverse, want.min(CHUNK), values))
    }

    /// Whether a range's walk reads values (an order's entries carry only keys).
    fn walks_values(range: &Range<'_>) -> bool {
        !matches!(range.order, Order::Named(_))
    }

    /// The rows a range selects, in walk order, each with its row key. `bytes` is the range's byte range and `first`
    /// its first chunk when `read_many` already fetched it.
    fn select(&self, fid: usize, layout: &FamilyLayout, range: &Range<'_>, bytes: Option<Walk>, first: Option<Entries>) -> Result<Vec<(Vec<u8>, Stored)>> {
        let Some(bytes) = bytes else { return Ok(Vec::new()) };
        let prefix = self.row_prefix(fid)?;
        match range.order {
            Order::Key => self
                .walk(bytes, range.reverse, range.limit, true, first)?
                .into_iter()
                .map(|(key, value)| Ok((key, self.decode_row(layout, &value)?)))
                .collect(),
            Order::Named(name) => {
                let skip = layout.family.order(name)?.fields.len();
                let base = bytes.skip;
                let entries = self.walk(bytes, range.reverse, range.limit, false, first)?;
                let keys: Vec<Vec<u8>> = entries
                    .iter()
                    .map(|(entry, _)| {
                        let mut at = base;
                        for _ in 0..skip {
                            at += codec::ordered_len(&entry[at..])?;
                        }
                        let mut key = prefix.clone();
                        key.extend_from_slice(&entry[at..]);
                        Ok(key)
                    })
                    .collect::<Result<_>>()?;
                self.fetch(layout, keys)
            }
            Order::Arrival => {
                let entries = self.walk(bytes, range.reverse, range.limit, true, first)?;
                let keys: Vec<Vec<u8>> = entries
                    .into_iter()
                    .map(|(_, tuple)| {
                        let mut key = prefix.clone();
                        key.extend_from_slice(&tuple);
                        key
                    })
                    .collect();
                self.fetch(layout, keys)
            }
        }
    }

    fn fetch(&self, layout: &FamilyLayout, keys: Vec<Vec<u8>>) -> Result<Vec<(Vec<u8>, Stored)>> {
        let values = self.raw_get_many(&keys)?;
        keys.into_iter()
            .zip(values)
            .map(|(key, value)| {
                let value = value.ok_or(local_engine::cause!(Error::Unavailable))?;
                Ok((key, self.decode_row(layout, &value)?))
            })
            .collect()
    }

    // ---- writes ----

    fn key_of(&self, layout: &FamilyLayout, values: &[Value]) -> Result<Vec<Value>> {
        layout.family.key.iter().map(|field| Ok(values[layout.index(field)?].clone())).collect()
    }

    /// The order and arrival entries a row owns: key and value.
    fn index(&self, fid: usize, layout: &FamilyLayout, row: &Stored) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        let family = layout.family;
        let mut entries = Vec::new();
        for (name, order) in &family.orders {
            if layout.holds(&row.values, &order.only)? {
                entries.push((self.order_key(fid, layout, name, &row.values)?, Vec::new()));
            }
        }
        if family.arrival {
            let id = id_bytes(fid)?;
            let mut key = vec![ARRIVE, id[0], id[1]];
            key.extend_from_slice(&(row.arrival as u64).to_be_bytes());
            entries.push((key, codec::ordered_tuple(&self.key_of(layout, &row.values)?)?));
        }
        Ok(entries)
    }

    /// Replace the row at `row_key` (`old` is what it held; `new` None removes it), keeping orders and arrival.
    fn replace(&self, fid: usize, layout: &FamilyLayout, row_key: &[u8], old: Option<&Stored>, new: Option<&Stored>) -> Result<()> {
        let size = |key: &[u8], value: &[u8]| (key.len() + value.len()) as i128;
        let old_entries = match old {
            Some(old) => self.index(fid, layout, old)?,
            None => Vec::new(),
        };
        let new_entries = match new {
            Some(new) => self.index(fid, layout, new)?,
            None => Vec::new(),
        };
        // Every size is checked before anything is buffered: a refused row leaves the buffer as it was.
        let new_value = new.map(|new| self.encode_row(new)).transpose()?;
        // Order entries whose key is unchanged are left alone.
        for (key, value) in &old_entries {
            if !new_entries.iter().any(|(own, _)| own == key) {
                self.buffer(key.clone(), None, -size(key, value))?;
            }
        }
        for (key, value) in &new_entries {
            if !old_entries.iter().any(|(own, _)| own == key) {
                self.buffer(key.clone(), Some(value.clone()), size(key, value))?;
            }
        }
        match (old, new_value) {
            (old, Some(value)) => {
                let before = old.map(|old| self.encode_row(old)).transpose()?;
                let bytes = size(row_key, &value) - before.map_or(0, |before| size(row_key, &before));
                self.buffer(row_key.to_vec(), Some(value), bytes)
            }
            (Some(old), None) => {
                let before = self.encode_row(old)?;
                self.buffer(row_key.to_vec(), None, -size(row_key, &before))
            }
            (None, None) => Ok(()),
        }
    }

    fn next_arrival(&self, fid: usize) -> Result<i64> {
        let id = id_bytes(fid)?;
        let key = vec![META, b'A', id[0], id[1]];
        let current = match self.raw_get(&key)? {
            Some(raw) => u64::from_be_bytes(raw.as_slice().try_into().map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))?),
            None => 0,
        };
        let next = current + 1;
        self.buffer(key.clone(), Some(next.to_be_bytes().to_vec()), (key.len() + 8) as i128 * i128::from(current == 0))?;
        Ok(next as i64)
    }
}

/// One walk over a byte range: its ends, the bounds that must not be decided at a NULL, and the prefix to skip.
struct Walk {
    lo: Vec<u8>,
    hi: Option<Vec<u8>>,
    /// Per bound, its ordered values.
    guards: Vec<Vec<Vec<u8>>>,
    skip: usize,
}

/// Whether a row's comparison with one bound is decided at a value that is not NULL. A row-value comparison is decided
/// at the first position where the row and the bound differ; a NULL there is no answer, so the row is refused.
fn decided_without_null(entry: &[u8], bound: &[Vec<u8>]) -> bool {
    let mut at = 0;
    for value in bound {
        let Ok(used) = codec::ordered_len(&entry[at..]) else { return false };
        let field = &entry[at..at + used];
        if field == value.as_slice() {
            at += used;
            continue;
        }
        return field.first() != Some(&0);
    }
    true
}

fn project(layout: &FamilyLayout, stored: &Stored, read: &[Read<'_>]) -> Result<Row> {
    if read.is_empty() {
        return Err(local_engine::cause!(Error::Invalid));
    }
    let mut values = Vec::with_capacity(read.len());
    for one in read {
        let value = if one.field == ARRIVAL {
            if !layout.family.arrival {
                return Err(local_engine::cause!(Error::Undeclared));
            }
            Value::Integer(stored.arrival)
        } else {
            stored.values[layout.index(one.field)?].clone()
        };
        values.push(match (one.at_most, octets(&value)) {
            (Some(limit), Some(length)) if length > limit => Value::Oversized(length as u64),
            _ => value,
        });
    }
    Ok(Row(values))
}

/// SQLite's `octet_length` of a value (numbers by their text form); None for NULL.
fn octets(value: &Value) -> Option<usize> {
    match value {
        Value::Null => None,
        Value::Integer(number) => Some(number.to_string().len()),
        Value::Real(number) => Some(number.to_string().len()),
        Value::Text(text) => Some(text.len()),
        Value::Blob(blob) => Some(blob.len()),
        Value::Oversized(bytes) => Some(*bytes as usize),
    }
}

impl<B: Backend> Storage for Kv<B> {
    fn schema(&self) -> &'static Schema {
        self.schema
    }

    fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> Result<Option<Row>> {
        let (fid, layout) = self.layout(family)?;
        let row_key = self.row_key(fid, layout, key)?;
        self.raw_get(&row_key)?.map(|raw| project(layout, &self.decode_row(layout, &raw)?, read)).transpose()
    }

    fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Vec<Row>> {
        let (fid, layout) = self.layout(family)?;
        let bytes = self.byte_range(fid, layout, range)?;
        self.select(fid, layout, range, bytes, None)?.iter().map(|(_, stored)| project(layout, stored, read)).collect()
    }

    /// One request to the backend for everything the open scope does not hold: the point gets' keys (each once) and
    /// the first chunk of every range. A range that fills its first chunk, and a named order's rows, are fetched after.
    fn read_many(&self, queries: &[Query<'_>]) -> Result<Vec<Reply>> {
        let mut keys = Vec::new();
        let mut asks = Vec::new();
        // Per range: its byte range, and which ask carries its first chunk.
        let mut ranges: Vec<(Option<Walk>, Option<usize>)> = Vec::new();
        for query in queries {
            match query {
                Query::Get { family, key, .. } => {
                    let (fid, layout) = self.layout(family)?;
                    keys.push(self.row_key(fid, layout, key)?);
                }
                Query::Scan { family, range, .. } => {
                    let (fid, layout) = self.layout(family)?;
                    let walk = self.byte_range(fid, layout, range)?;
                    let ask = walk.as_ref().and_then(|walk| self.first_chunk(walk, range.reverse, range.limit, Self::walks_values(range))).map(|ask| {
                        asks.push(ask);
                        asks.len() - 1
                    });
                    ranges.push((walk, ask));
                }
            }
        }
        let (raws, mut chunks) = self.raw_read(&keys, &asks)?;
        let (mut gets, mut scans) = (raws.into_iter(), ranges.into_iter());
        queries
            .iter()
            .map(|query| match query {
                Query::Get { family, read, .. } => {
                    let (_, layout) = self.layout(family)?;
                    let raw = gets.next().ok_or(local_engine::cause!(Error::Unavailable))?;
                    Ok(Reply::Row(raw.map(|raw| project(layout, &self.decode_row(layout, &raw)?, read)).transpose()?))
                }
                Query::Scan { family, range, read } => {
                    let (fid, layout) = self.layout(family)?;
                    let (walk, ask) = scans.next().ok_or(local_engine::cause!(Error::Unavailable))?;
                    let first = ask.map(|ask| std::mem::take(&mut chunks[ask]));
                    let rows = self.select(fid, layout, range, walk, first)?;
                    Ok(Reply::Rows(rows.iter().map(|(_, stored)| project(layout, stored, read)).collect::<Result<_>>()?))
                }
            })
            .collect()
    }

    /// The puts compare their rows with what is stored: inside a scope those rows are read first in one batch (the
    /// scope remembers them), then the writes are made in order. Everything else is the single operations.
    fn write_many(&self, writes: &[Asked<'_>]) -> Result<Vec<u64>> {
        if self.scoped() {
            let mut keys = Vec::new();
            for write in writes {
                let Asked::Put { family, row, .. } = write else { continue };
                let Ok((fid, layout)) = self.layout(family) else { continue };
                let key: Option<Vec<Value>> =
                    layout.family.key.iter().map(|field| row.iter().find(|(name, _)| name == field).map(|(_, value)| value.clone())).collect();
                if let Some(Ok(row_key)) = key.map(|key| self.row_key(fid, layout, &key)) {
                    keys.push(row_key);
                }
            }
            self.raw_get_many(&keys)?;
        }
        writes
            .iter()
            .map(|write| match write {
                Asked::Put { family, row, when } => self.put(family, row, *when),
                Asked::Erase { family, range } => self.erase(family, range),
            })
            .collect()
    }

    fn put(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> Result<u64> {
        let (fid, layout) = self.layout(family)?;
        let family = layout.family;
        if row.iter().any(|(field, _)| !family.has(field)) {
            return Err(local_engine::cause!(Error::Undeclared));
        }
        if row.iter().any(|(_, value)| matches!(value, Value::Oversized(_))) {
            return Err(local_engine::cause!(Error::Invalid));
        }
        let mut key = Vec::with_capacity(family.key.len());
        for field in &family.key {
            key.push(row.iter().find(|(name, _)| name == field).map(|(_, value)| value.clone()).ok_or(local_engine::cause!(Error::Invalid))?);
        }
        let row_key = self.row_key(fid, layout, &key)?;
        self.atomically(|| {
            let existing = self.raw_get(&row_key)?.map(|raw| self.decode_row(layout, &raw)).transpose()?;
            let assign = |mut values: Vec<Value>| -> Result<Vec<Value>> {
                for (field, value) in row {
                    values[layout.index(field)?] = value.clone();
                }
                Ok(values)
            };
            let next = match (when, &existing) {
                (When::New, Some(_)) => return Err(local_engine::cause!(Error::Conflict)),
                (When::Absent, Some(_)) => return Ok(0),
                (When::Always, Some(old)) => assign(old.values.clone())?,
                (When::Matches(conditions), existing) => {
                    if row.iter().all(|(field, _)| family.key.iter().any(|key| key == field)) {
                        return Err(local_engine::cause!(Error::Invalid));
                    }
                    let Some(old) = existing else { return Ok(0) };
                    for (field, expected) in conditions {
                        let at = layout.index(field)?;
                        let stored = &old.values[at];
                        let same = if expected.is_null() {
                            stored.is_null()
                        } else {
                            !stored.is_null() && codec::ordered_one(stored)? == codec::ordered_one(expected)?
                        };
                        if !same {
                            return Ok(0);
                        }
                    }
                    assign(old.values.clone())?
                }
                (When::New | When::Absent | When::Always, None) => assign(vec![Value::Null; family.fields.len()])?,
            };
            let arrival = match &existing {
                Some(old) => old.arrival,
                None if family.arrival => {
                    // A row too large to store is refused before the arrival counter moves.
                    self.encode_row(&Stored { arrival: 0, values: next.clone() })?;
                    self.next_arrival(fid)?
                }
                None => 0,
            };
            let stored = Stored { arrival, values: next };
            self.replace(fid, layout, &row_key, existing.as_ref(), Some(&stored))?;
            self.changes.set(self.changes.get() + 1);
            Ok(1)
        })
    }

    fn count(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        let (fid, layout) = self.layout(family)?;
        let Some(bytes) = self.byte_range(fid, layout, range)? else { return Ok(0) };
        Ok(self.walk(bytes, range.reverse, range.limit, false, None)?.len() as u64)
    }

    fn erase(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        let (fid, layout) = self.layout(family)?;
        if range.limit.is_some() {
            return Err(local_engine::cause!(Error::Invalid));
        }
        self.atomically(|| {
            let bytes = self.byte_range(fid, layout, range)?;
            let rows = self.select(fid, layout, range, bytes, None)?;
            for (row_key, stored) in &rows {
                self.replace(fid, layout, row_key, Some(stored), None)?;
            }
            self.changes.set(self.changes.get() + rows.len() as u64);
            Ok(rows.len() as u64)
        })
    }

    fn present(&self, family: &str) -> Result<bool> {
        self.layout(family).map(|_| true)
    }

    fn custody(&self) -> Result<()> {
        if self.backend.get(&IDENTITY)?.as_deref() == Some(self.uid.as_slice()) {
            Ok(())
        } else {
            Err(local_engine::cause!(Error::Moved))
        }
    }

    fn location(&self) -> Option<&str> {
        Some(&self.place)
    }

    fn scoped(&self) -> bool {
        self.scope.borrow().is_some()
    }

    fn writing(&self) -> Result<bool> {
        Ok(self.scope.borrow().as_ref().is_some_and(|open| open.intent == Intent::Write))
    }

    fn changes(&self) -> u64 {
        self.changes.get()
    }

    /// Moves only when another handle commits: this handle's own commits are taken out.
    fn mark(&self) -> Result<i64> {
        self.know_header()?;
        let commits = match self.scope.borrow().as_ref() {
            Some(open) => open.header.commits,
            None => Header::read(self.backend.get(&HEADER)?.as_deref())?.commits,
        };
        Ok(commits.wrapping_sub(self.own_commits.get()) as i64)
    }

    fn schema_mark(&self) -> Result<i64> {
        Ok(0)
    }

    fn allocated_bytes(&self) -> Result<u64> {
        self.know_header()?;
        if let Some(open) = self.scope.borrow().as_ref() {
            return Ok(u64::try_from(i128::from(open.header.bytes) + open.delta).unwrap_or(0));
        }
        Ok(Header::read(self.backend.get(&HEADER)?.as_deref())?.bytes)
    }

    fn reclaim(&self) -> Result<()> {
        if self.scoped() {
            return Err(local_engine::cause!(Error::Invalid));
        }
        self.backend.reclaim()
    }

    fn open_scope(&self, intent: Intent) -> Result<()> {
        if intent == Intent::Nested {
            let mut scope = self.scope.borrow_mut();
            let open = scope.as_mut().ok_or(local_engine::cause!(Error::Invalid))?;
            let mark = open.undo.len();
            open.marks.push(mark);
            return Ok(());
        }
        if self.scope.borrow().is_some() {
            return Err(local_engine::cause!(Error::Invalid));
        }
        *self.scope.borrow_mut() =
            Some(Open { intent, seen: None, header: Header::default(), delta: 0, overlay: BTreeMap::new(), known: HashMap::new(), known_bytes: 0, undo: Vec::new(), marks: Vec::new() });
        Ok(())
    }

    fn close_scope(&self, commit: bool) -> Result<()> {
        let mut scope = self.scope.borrow_mut();
        let open = scope.as_mut().ok_or(local_engine::cause!(Error::Invalid))?;
        if let Some(mark) = open.marks.pop() {
            if !commit {
                while open.undo.len() > mark {
                    let (key, before, bytes) = open.undo.pop().ok_or(local_engine::cause!(Error::Unavailable))?;
                    match before {
                        Some(Some(entry)) => open.overlay.insert(key, Some(entry)).map(|_| ()),
                        Some(None) => open.overlay.insert(key, None).map(|_| ()),
                        None => open.overlay.remove(&key).map(|_| ()),
                    };
                    open.delta -= bytes;
                }
            }
            return Ok(());
        }
        let mut open = scope.take().ok_or(local_engine::cause!(Error::Invalid))?;
        drop(scope);
        if !commit {
            return self.release(&open);
        }
        // A scope that never read the store has seen nothing to guard: its header is read now, as if it opened now.
        if open.seen.is_none() && open.intent != Intent::Read && !open.overlay.is_empty() {
            let raw = self.backend.get(&HEADER)?;
            open.header = Header::read(raw.as_deref())?;
            if open.header.held_by_other(self.token, now_ms()) {
                return Err(local_engine::cause!(Error::Busy));
            }
            open.seen = Some(raw);
        }
        match open.intent {
            Intent::Read => {
                // A read scope is consistent only if nothing committed while it was open (a hold taken or given back
                // is not a commit).
                match open.seen {
                    Some(seen) if Header::read(self.backend.get(&HEADER)?.as_deref())?.released() != Header::read(seen.as_deref())?.released() => Err(local_engine::cause!(Error::Busy)),
                    _ => Ok(()),
                }
            }
            _ if open.overlay.is_empty() => self.release(&open),
            _ => {
                let header = Header {
                    commits: open.header.commits + 1,
                    bytes: u64::try_from(i128::from(open.header.bytes) + open.delta).unwrap_or(0),
                    hold: None,
                };
                let mut writes: Vec<Write> = open
                    .overlay
                    .into_iter()
                    .map(|(key, entry)| match entry {
                        Some(value) => Write::Set(key, value),
                        None => Write::Delete(key),
                    })
                    .collect();
                writes.push(Write::Set(HEADER.to_vec(), header.write()));
                if writes.len() > self.backend.limits().max_writes {
                    return Err(local_engine::cause!(Error::TooBig));
                }
                match self.backend.apply((&HEADER, open.seen.flatten().as_deref()), &writes)? {
                    Outcome::Applied => {
                        self.own_commits.set(self.own_commits.get() + 1);
                        Ok(())
                    }
                    Outcome::Refused => Err(local_engine::cause!(Error::Busy)),
                }
            }
        }
    }
}

/// A handle that ends with its scope open (a dropped connection) gives its write hold back, as a server gives a
/// closed connection's locks back. Nothing it buffered is applied.
impl<B: Backend> Drop for Kv<B> {
    fn drop(&mut self) {
        if let Some(open) = self.scope.get_mut().take() {
            let _ = self.release(&open);
        }
    }
}
