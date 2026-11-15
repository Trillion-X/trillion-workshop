//! Purpose: own the original live screen-revision lifecycle on an existing
//! selected resource connection and compose its actual record-owner heads.
//! Invariants: the saved revision is a CEILING, not the current revision; a
//! cold owner starts one past it and reserves 1024 ahead before disclosure.
//! Counted writes settle once per turn; neutral SQL never hides counted work.
//! Security: ownership and presentation admission are mandatory capabilities,
//! not account labels. The supplied read retains its real lifetime through
//! reply delivery. This module opens no path or replacement authority store.
//! Source contracts: live-screen.mjs, kept-list.mjs and native-work-live.mjs.

use crate::ecma_json::{self, JsString, Object, Value};
use crate::records::Mutation;
use crate::storage::sqlite::{Access, Connection, DatabaseName, Transaction, TransactionBehavior};
use std::{fmt, io::Write};

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const RESERVATION: u64 = 1024;
const MAX_REPLY: usize = 65_536;
const MAX_CHANGED: usize = 256;
/// The record store resource of the account's own store that holds the saved revision ceiling: one record, copied at start
/// from the old store's table by the generic copy (src/storage/record_store_resources.json).
const RESOURCE: &str = "screen-revision";
/// The ceiling's record id: the old table's singleton key.
const ID: &str = "1";

pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    SourceChanged(crate::refusal_cause::Cause),
    NotAuthorized(crate::refusal_cause::Cause),
    Unavailable(crate::refusal_cause::Cause),
    Unresolved(crate::refusal_cause::Cause),
    Sql(rusqlite::Error, crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause,
            Self::Bounds(cause) => cause,
            Self::SourceChanged(cause) => cause,
            Self::NotAuthorized(cause) => cause,
            Self::Unavailable(cause) => cause,
            Self::Unresolved(cause) => cause,
            Self::Sql(_, cause) => cause,
        }
    }
}
crate::impl_caused!(Error);

impl From<rusqlite::Error> for Error {
    #[track_caller]
    fn from(value: rusqlite::Error) -> Self {
        Self::Sql(value, crate::cause!(caller_site: Self::Sql))
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} cause={}", match self {
            Self::Invalid(_) => "workspace heads input refused",
            Self::Bounds(_) => "workspace heads exceed bounds",
            Self::SourceChanged(_) => "workspace heads source changed",
            Self::NotAuthorized(_) => "workspace heads admission refused",
            Self::Unavailable(_) | Self::Sql(_, _) => "workspace heads source unavailable",
            Self::Unresolved(_) => "workspace heads reservation needs owner reconciliation",
        }, self.cause())
    }
}
impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;

fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

/// Existing selected account/resource/generation, independently authenticated by
/// ResourceOwner on the actual connection. These fields alone grant nothing.
#[derive(Clone, PartialEq, Eq)]
pub struct Binding {
    pub account: String,
    pub resource: String,
    pub generation: String,
}
impl Binding {
    pub fn new(account: &str, resource: &str, generation: &str) -> Result<Self> {
        if !bounded(account, 512) || !bounded(resource, 512) || !bounded(generation, 512) {
            return Err(crate::cause!(Error::Invalid));
        }
        Ok(Self {
            account: account.into(),
            resource: resource.into(),
            generation: generation.into(),
        })
    }
}
impl fmt::Debug for Binding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("HeadsBinding([redacted])")
    }
}

/// The actual installed resource owner attests its retained physical connection
/// and generation, not an equal-labelled snapshot/copy/newly opened database.
/// Head reads must use the current original told/record owners; an undecodable
/// protected record is Unavailable, never an empty head. No default exists.
pub trait ResourceOwner {
    fn assert_current(&mut self, binding: &Binding, db: &Connection) -> Result<()>;
    fn heads(&mut self, binding: &Binding, db: &Connection) -> Result<Heads>;
}

/// Request-scoped, actual presentation:read/heads admission, quota/resource
/// lifetime and cancellation. Implementations retain their non-cloneable
/// admission through Reply's physical delivery. Browser full-reach labels,
/// immutable records or a saved revision are not implementations of this proof.
pub trait HeadsRead: ResourceOwner {
    fn assert_read(&mut self, binding: &Binding, db: &Connection) -> Result<()>;
    fn assert_delivery(&mut self, binding: &Binding) -> Result<()>;
}

pub struct Heads {
    told: Option<u64>,
    records: Option<JsString>,
}
impl Heads {
    pub fn new(told: Option<u64>, records: Option<JsString>) -> Result<Self> {
        if told.is_some_and(|n| n > MAX_SAFE)
            || records
                .as_ref()
                .is_some_and(|s| s.len() > 4096 || s.units().contains(&0))
        {
            return Err(crate::cause!(Error::Bounds));
        }
        Ok(Self { told, records })
    }
}

#[derive(Clone)]
struct State {
    ceiling: u64,
    revision: u64,
    seen: u64,
    pending: bool,
    elsewhere: bool,
    coalescing: u32,
    deferred: bool,
    quiet_depth: u32,
    changed: Vec<String>,
}
impl State {
    fn new(ceiling: u64, seen: u64) -> Result<Self> {
        let revision = ceiling
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE)
            .ok_or(crate::cause!(Error::Bounds))?;
        Ok(Self {
            ceiling,
            revision,
            seen,
            pending: false,
            elsewhere: false,
            coalescing: 0,
            deferred: false,
            quiet_depth: 0,
            changed: Vec::new(),
        })
    }
    fn settle(&mut self, db: &Connection) -> Result<bool> {
        if !self.pending {
            return Ok(false);
        }
        self.pending = false;
        if self.coalescing != 0 {
            self.deferred = true;
            return Ok(false);
        }
        let total = db.total_changes();
        if !self.elsewhere && total == self.seen {
            return Ok(false);
        }
        if total < self.seen {
            return Err(crate::cause!(Error::SourceChanged));
        }
        self.revision = self
            .revision
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE)
            .ok_or(crate::cause!(Error::Bounds))?;
        self.elsewhere = false;
        self.seen = total;
        Ok(true)
    }
}

/// Persistent ONE live state per actual selected resource generation. Do not
/// reconstruct this for each HTTP request. All resource writer/quiet/external
/// notifications must use this same state and raw SQLite changes counter.
pub struct LiveHeads {
    binding: Binding,
    state: State,
    unresolved: bool,
}
impl fmt::Debug for LiveHeads {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LiveHeads([redacted])")
    }
}

fn writable(db: &Connection) -> Result<()> {
    if !db.is_autocommit() || db.is_readonly(DatabaseName::Main)? {
        return Err(crate::cause!(Error::Unavailable));
    }
    Ok(())
}
/// The saved ceiling of `binding`'s account (0 when none is saved) and the version of its record, for the next
/// reservation's compare-and-set.
fn ceiling(db: &Connection, binding: &Binding) -> Result<(u64, i64)> {
    let store = crate::workspace_store::lend_store(db, Access::Read).map_err(|error| Error::Unavailable(error.cause()))?;
    let (version, held) = store.held_record_with_version(&binding.account, RESOURCE, ID).map_err(|error| Error::Unavailable(error.cause()))?;
    let Some(record) = held else { return Ok((0, version)) };
    let saved = record.value.get("revision").and_then(serde_json::Value::as_u64).ok_or(crate::cause!(Error::Unavailable))?;
    if saved > MAX_SAFE {
        return Err(crate::cause!(Error::Bounds));
    }
    Ok((saved, version))
}
fn initialize(db: &Connection, owner: &mut impl ResourceOwner, binding: &Binding) -> Result<State> {
    writable(db)?;
    owner.assert_current(binding, db)?;
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    let (saved, _) = ceiling(&tx, binding)?;
    owner.assert_current(binding, &tx)?;
    tx.commit()?;
    owner.assert_current(binding, db)?;
    State::new(saved, db.total_changes())
}

impl LiveHeads {
    pub fn attach(
        binding: Binding,
        db: &Connection,
        owner: &mut impl ResourceOwner,
    ) -> Result<Self> {
        // Revalidate even a manually constructed Binding before any SQL.
        Binding::new(&binding.account, &binding.resource, &binding.generation)?;
        let state = initialize(db, owner, &binding)?;
        Ok(Self {
            binding,
            state,
            unresolved: false,
        })
    }
    fn ready(&self) -> Result<()> {
        if self.unresolved {
            Err(crate::cause!(Error::Unresolved))
        } else {
            Ok(())
        }
    }
    pub fn notice_write(&mut self) {
        if self.state.quiet_depth == 0 {
            self.state.pending = true;
        }
    }
    pub fn changed_elsewhere(&mut self) {
        self.state.elsewhere = true;
        self.notice_write();
    }
    pub fn begin_coalesce(&mut self) -> Result<()> {
        self.state.coalescing = self.state.coalescing.checked_add(1).ok_or(crate::cause!(Error::Bounds))?;
        Ok(())
    }
    pub fn end_coalesce(&mut self) -> Result<()> {
        self.state.coalescing = self.state.coalescing.checked_sub(1).ok_or(crate::cause!(Error::Invalid))?;
        if self.state.coalescing == 0 && self.state.deferred {
            self.state.deferred = false;
            self.notice_write();
        }
        Ok(())
    }
    /// Called once after a counted write turn. Head reads
    /// also flush pending work, matching nativeWorkLiveHooks' deferred schedule.
    pub fn settle(&mut self, db: &Connection, owner: &mut impl ResourceOwner) -> Result<bool> {
        self.ready()?;
        if self.state.quiet_depth != 0 {
            return Err(crate::cause!(Error::Invalid));
        }
        owner.assert_current(&self.binding, db)?;
        let mut next = self.state.clone();
        let changed = next.settle(db)?;
        owner.assert_current(&self.binding, db)?;
        self.state = next;
        Ok(changed)
    }
    /// Neutral scopes absorb only their own raw counter delta, including on
    /// Err and SQLite rollback, while preserving earlier counted work.
    pub fn quietly<T>(
        &mut self,
        db: &Connection,
        owner: &mut impl ResourceOwner,
        run: impl FnOnce(&mut Self, &Connection) -> Result<T>,
    ) -> Result<T> {
        self.ready()?;
        owner.assert_current(&self.binding, db)?;
        let before = db.total_changes();
        let seen = self.state.seen;
        self.state.quiet_depth = self.state.quiet_depth.checked_add(1).ok_or(crate::cause!(Error::Bounds))?;
        let answer = run(self, db);
        self.state.quiet_depth -= 1;
        let delta = db
            .total_changes()
            .checked_sub(before)
            .ok_or(crate::cause!(Error::SourceChanged))?;
        self.state.seen = seen.checked_add(delta).ok_or(crate::cause!(Error::Bounds))?;
        owner.assert_current(&self.binding, db)?;
        answer
    }
    pub fn changed_for<T>(
        &mut self,
        reads: &[String],
        db: &Connection,
        owner: &mut impl ResourceOwner,
        run: impl FnOnce(&mut Self, &Connection) -> Result<T>,
    ) -> Result<T> {
        if reads.len() > MAX_CHANGED || reads.iter().any(|s| !bounded(s, 4096)) {
            return Err(crate::cause!(Error::Bounds));
        }
        let before = db.total_changes();
        let answer = self.quietly(db, owner, run)?;
        if db.total_changes() != before {
            for read in reads {
                if !self.state.changed.contains(read) {
                    if self.state.changed.len() == MAX_CHANGED {
                        return Err(crate::cause!(Error::Bounds));
                    }
                    self.state.changed.push(read.clone());
                }
            }
        }
        Ok(answer)
    }
    pub fn take_changed_reads(&mut self) -> Vec<String> {
        std::mem::take(&mut self.state.changed)
    }

    /// Actual original store reconstruction/reset, not a way to discard an
    /// unresolved source. The owner must first establish the real current DB.
    pub fn made_again(&mut self, db: &Connection, owner: &mut impl ResourceOwner) -> Result<()> {
        let mut state = initialize(db, owner, &self.binding)?;
        state.coalescing = self.state.coalescing;
        state.quiet_depth = self.state.quiet_depth;
        self.state = state;
        self.unresolved = false;
        Ok(())
    }

    /// Real reservation + original owner heads in one bounded transaction.
    /// The supplied request keeps its actual admission lifetime in the reply.
    pub fn read<R: HeadsRead>(&mut self, db: &Connection, mut read: R) -> Result<Reply<R>> {
        self.ready()?;
        if self.state.quiet_depth != 0 {
            return Err(crate::cause!(Error::Invalid));
        }
        writable(db)?;
        read.assert_current(&self.binding, db)?;
        read.assert_read(&self.binding, db)?;
        let mut next = self.state.clone();
        let mut neutral = 0_u64;
        let mut commit_attempt = false;
        let mut reservation_rows_changed = 0;
        // A read is a snapshot (DEFERRED: it begins at its first read and takes no write lock), so the heads it
        // answers are the heads of one instant and a write landing meanwhile refuses nothing. Only a read that must
        // reserve the next revision ceiling writes, and it takes the write lock from its start (IMMEDIATE), so its
        // reservation never meets a snapshot that went stale under it.
        let mut probe = self.state.clone();
        probe.settle(db)?;
        let behavior = if probe.revision > probe.ceiling {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        };
        let answer = (|| -> Result<Heads> {
            let tx = Transaction::new_unchecked(db, behavior)?;
            read.assert_current(&self.binding, &tx)?;
            read.assert_read(&self.binding, &tx)?;
            let (saved, version) = ceiling(&tx, &self.binding)?;
            if saved != self.state.ceiling {
                return Err(crate::cause!(Error::SourceChanged));
            }
            next.settle(&tx)?;
            if next.revision > next.ceiling {
                let reserved = next
                    .revision
                    .checked_add(RESERVATION)
                    .filter(|n| *n <= MAX_SAFE)
                    .ok_or(crate::cause!(Error::Bounds))?;
                let before = tx.total_changes();
                let write = crate::workspace_store::lend_store(&tx, Access::Write)
                    .map_err(|error| Error::Unavailable(error.cause()))
                    .and_then(|mut store| {
                        let reservation = Mutation {
                            id: ID.into(),
                            expected_version: version,
                            request_key: format!("screen-revision-{reserved}"),
                            deleted: false,
                            value: serde_json::json!({ "id": 1, "revision": reserved }),
                        };
                        store.mutate_local_with_check(&self.binding.account, RESOURCE, reservation, || Ok(())).map_err(|error| Error::SourceChanged(error.cause()))
                    });
                neutral = tx
                    .total_changes()
                    .checked_sub(before)
                    .ok_or(crate::cause!(Error::SourceChanged))?;
                write?;
                // One record holds the ceiling: a reservation changes that one record.
                reservation_rows_changed = 1;
                next.ceiling = reserved;
                next.seen = next.seen.checked_add(neutral).ok_or(crate::cause!(Error::Bounds))?;
            }
            let heads = read.heads(&self.binding, &tx)?;
            read.assert_current(&self.binding, &tx)?;
            read.assert_read(&self.binding, &tx)?;
            commit_attempt = true;
            tx.commit()?;
            Ok(heads)
        })();
        let heads = match answer {
            Ok(heads) => heads,
            Err(error) => {
                // total_changes includes rolled-back reservation rows. They
                // remain neutral even though no new revision was disclosed.
                self.state.seen = self.state.seen.checked_add(neutral).ok_or(crate::cause!(Error::Bounds))?;
                if commit_attempt || !db.is_autocommit() {
                    self.unresolved = true;
                }
                return Err(error);
            }
        };
        self.state = next;
        read.assert_current(&self.binding, db)?;
        read.assert_read(&self.binding, db)?;
        read.assert_delivery(&self.binding)?;
        let bytes = encode(self.state.revision, heads)?;
        read.assert_delivery(&self.binding)?;
        Ok(Reply {
            bytes,
            read,
            binding: self.binding.clone(),
            work: Work {
                reservation_rows_changed,
            },
        })
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Work {
    pub reservation_rows_changed: u64,
}

/// No Clone/Serialize/into-bytes escape: the actual request permit remains held
/// through connection write/flush. AsRef composes with the existing native connection.
pub struct Reply<R: HeadsRead> {
    bytes: Vec<u8>,
    read: R,
    binding: Binding,
    work: Work,
}
impl<R: HeadsRead> Reply<R> {
    pub fn work(&self) -> Work {
        self.work
    }
    pub fn write_to(mut self, output: &mut impl Write) -> Result<()> {
        self.read.assert_delivery(&self.binding)?;
        output
            .write_all(&self.bytes)
            .and_then(|()| output.flush())
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }
}
impl<R: HeadsRead> AsRef<[u8]> for Reply<R> {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

fn encode(revision: u64, heads: Heads) -> Result<Vec<u8>> {
    let heads = Heads::new(heads.told, heads.records)?;
    let mut h = Object::new();
    h.insert(
        "told".into(),
        heads.told.map_or(Value::Null, |n| Value::Number(n as f64)),
    );
    h.insert(
        "records".into(),
        heads.records.map_or(Value::Null, Value::String),
    );
    let mut chunk = Object::new();
    chunk.insert("revision".into(), Value::Number(revision as f64));
    chunk.insert("heads".into(), Value::Object(h));
    ecma_json::stringify(
        &Value::Object(chunk),
        ecma_json::Limits {
            output_bytes: MAX_REPLY,
            nodes: 16,
            total_string_units: 8192,
            string_units: 4096,
            container_entries: 8,
            depth: 4,
            ..Default::default()
        },
    )
    .map(String::into_bytes)
    .map_err(|error| Error::Bounds(error.cause()))
}

/// Original keptList.lastSeq(), supplied the admitted decoded CURRENT head.
/// Absence/decryption/read failure must be distinguished by its actual owner.
pub fn told_tail(head: Option<&Value>) -> Result<Option<u64>> {
    let Some(head) = head.filter(|v| !matches!(v, Value::Null)) else {
        return Ok(None);
    };
    let Value::Object(head) = head else {
        return Err(crate::cause!(Error::Invalid));
    };
    let last = if let Some(Value::Array(items)) = head.get(&"items".into()) {
        match items.last() {
            None => None,
            Some(Value::Object(item)) => item.get(&"seq".into()),
            Some(_) => return Err(crate::cause!(Error::Invalid)),
        }
    } else {
        match head.get(&"seqs".into()) {
            None | Some(Value::Null) => None,
            Some(Value::Array(seqs)) => seqs.last(),
            Some(_) => return Err(crate::cause!(Error::Invalid)),
        }
    };
    match last {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n))
            if n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= MAX_SAFE as f64 =>
        {
            Ok(Some(*n as u64))
        }
        Some(_) => Err(crate::cause!(Error::Invalid)),
    }
}
