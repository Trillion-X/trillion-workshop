// src/account_files/moves.rs
//
// Purpose: Empty one of an account's stores into another. Every byte the account files' records put at the `from`
// origin (each chunk, and each file kept whole) is copied to the `to` origin under the same key, proved by its upload
// checksum, and only then is its one record rewritten to name `to`. A second, optional pass walks the `from` store's own
// key listing and carries every key no record names (anything else the store holds), proved the same way. Generic
// over origins: which stores, and which vendor is behind each, are the account's origin records.
//
// Non-Negotiable Invariants:
// - Bytes before records. A record names `to` only after its key is proved there, and a copy has exactly one proof,
//   `upload-sha256`: the BLAKE3 of the bytes is computed while they stream from `from` (and must equal the identity
//   the key names, a chunk or a whole file: `1f:` + BLAKE3 hex, before any byte is sent); their SHA-256 is signed into
//   the PUT (`x-amz-content-sha256`), so `to` itself refuses a body that does not hash to it; then one HEAD checks
//   that `to` holds the key at its length. A copy is never downloaded back to check it (the person's ruling, 2026-10-30:
//   B2 bills a read-back as download, and 518 GB of read-backs in one UTC day passed its $5/day cap). The one read
//   from `to` is `verify-sample`, an explicit spot check bounded by a byte ceiling in DATA (`moves.json`).
// - Every proof is a record: `@namespace/moved/<from>`, id = the key, `{kind: "namespace-moved", to, byte_length,
//   blake3, proof, in?}`, written before the chunk or file record is rewritten. The proof records and the chunk and file
//   records are the checkpoint: a stopped run starts again where it stopped, and a key already proved is never
//   copied twice. The proof records are also the list a later deletion of the `from` store is checked against.
// - Nothing here deletes bytes. The `from` store keeps every object until a person or a separate, delete-capable step
//   removes it, and `audit` reports what it still holds.
// - Bounded: at most `concurrency` keys are in flight, each holding at most one ranged read (`MAX_RANGE_BYTES`) in
//   memory; a larger object is hashed in one ranged pass and streamed into its one PUT in a second, so memory never
//   holds a whole large object. Record walks are pages of `MAX_PAGE_ITEMS`.
// - Bytes are checked against their identity before they are sent: a source whose bytes do not hash to the identity
//   is refused and never written to `to`.
// - The first write of a real run marks `from` as taking no new bytes (`Origin::takes_new_bytes = false`), so no
//   upload lands there while it is being emptied.
//
// Key Concepts:
// - `Plan`: from, to, concurrency, whether to carry the store's unnamed keys, and whether this is a dry run (counts
//   and request estimates only: no request is sent and no record is written).
// - Phases, in order: `chunks`, `whole_files`, then `chunked_files` (a file whose every chunk is now at `to` is
//   relabelled `to`; it holds no bytes of its own), then `unnamed_keys` (the store listing, when asked).
// - Packing (`pack_plan`, `pack_keys`): small keys no record names are kept in content-addressed archives with
//   manifests; each member's BLAKE3 is computed while it streams from `from` and recorded in the manifest, and each
//   archive and manifest PUT carries its signed SHA-256, the same proof as a key kept under its own name.
// - `audit`: the keys the `from` store still holds, each proved or not, and the records that still name `from`.
// - `retire`: once `audit` finds every held key proved and no record naming `from`, the `from` origin record is
//   deleted, so nothing can read from or write to that store again.
//
// Security Considerations:
// - Credentials stay in the vault (the byte port signs through it); this module sees keys, sizes and hashes only.
// - The report holds counts, timings and keys of failed items (storage keys: a person id and content identities),
//   never bytes or names.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{
    objects::{Body, Listing, ObjectError, Objects, Origin, MAX_LISTING_KEYS, MAX_RANGE_BYTES},
    AccountFilesError, CHUNKS, FILES, ORIGINS, SPANS,
};
use content_crypto::advanced;
use crate::{
    records::{Error, Mutation, Record, Records, MAX_PAGE_ITEMS},
    storage::{record_store::RecordStore, Storage},
};
use crate::refusal_cause::{Cause, CodedError};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

/// The kind of a proof record.
pub const MOVED_KIND: &str = "namespace-moved";
/// The most failed keys a report lists (every failure is counted).
const REPORTED_FAILURES: usize = 200;
/// The most unproved keys an audit lists (every one is counted).
const REPORTED_UNPROVED: usize = 1000;
/// The one proof of a copy (a proof line's and a proof record's `proof`): its BLAKE3 computed while it streamed from
/// the source, the SHA-256 signed into its PUT so the destination refused any other body, and one HEAD of its length.
pub const UPLOAD_PROOF: &str = "upload-sha256";
/// The byte ceiling of `verify-sample`, the only read of a destination: DATA.
const MOVES_DATA: &[u8] = include_bytes!("moves.json");
/// The kind of a pack manifest object.
pub const PACK_KIND: &str = "namespace-pack";
/// Packed archives and their manifests are kept at the destination under this root, then the store they came from,
/// then their group (`packed/<from>/people/<id>/<blake3>.pack`).
pub const PACKED_ROOT: &str = "packed/";
/// An archive is sealed once its members' bytes would pass this (bounds a packer's memory: one archive).
pub const PACK_TARGET_BYTES: u64 = 128 * 1024 * 1024;
/// An archive is also sealed at this many members (bounds its manifest).
pub const PACK_MOST_MEMBERS: usize = 20_000;
/// The largest key a work list packs; a larger key is carried whole under its own key, and so is every key a chunk or
/// file record names (its record must keep naming one key).
pub const PACK_MOST_MEMBER_BYTES: u64 = 4 * 1024 * 1024;
/// Readers of one archive's members; `concurrency / PACK_READERS` archives are packed at once (most groups are small,
/// so many archives in flight keep the readers busy while each archive waits on its writes).
const PACK_READERS: usize = 32;
/// The media type archives and manifests are kept under (a manifest is JSON; its key ends in `.manifest.json`).
const PACKED_TYPE: &str = "application/octet-stream";
/// Listing pages in flight at once when a store lists by level.
const LISTING_WIDTH: usize = 64;
/// How deep a store is listed by level before each prefix found is walked flat (3: `people/<id>/<kind>/`). Measured
/// on the 2.76M-key landing store (2026-10-29): at depth 2 one person's 1.59M keys were one flat walk of 1,590 pages
/// in a row (50 min in all); at depth 3 its largest prefix holds 85k keys.
const LISTING_LEVELS: usize = 3;
/// How many times one key is tried when the store did not answer (a network failure or a 429/5xx): the first try
/// and at most 5 retries. Every try's requests count toward the run's budget.
const ATTEMPTS: u32 = 6;

/// The request key of one move write: BLAKE3 over its step and the facts that make it one write, NUL-joined (a
/// retried write after an unknown outcome carries the same key).
fn request_key(parts: &[&str]) -> String {
    advanced::blake3::hash(parts.join("\0").as_bytes()).to_hex().to_string()
}

/// The scope of the proof records of keys carried out of `from`.
pub fn moved_scope(from: &str) -> String {
    format!("@namespace/moved/{from}")
}

/// What to move.
pub struct Plan {
    pub from: String,
    pub to: String,
    /// Keys in flight at once (each holds at most one ranged read in memory).
    pub concurrency: usize,
    /// Also carry every key the `from` store lists that no record names.
    pub unnamed_keys: bool,
    /// Count and estimate only: no request, no record write.
    pub dry_run: bool,
    /// Rewrite the records of keys already proved (by `import_proofs` or an earlier run) and send no request: an
    /// unproved key is counted (`Phase::unproved`) and left naming `from`, and the store is not listed.
    pub records_only: bool,
    /// The most requests and bytes this run may spend, by the report's counter names (`<origin> <METHOD>`,
    /// `<origin> read`, `<origin> written`). The run stops the moment any counter would pass its cap; a counter with
    /// no cap is refused outright, so nothing is spent that the budget did not foresee.
    pub budget: Option<Budget>,
}

/// Caps per counter name (requests per `<origin> <METHOD>`, bytes per `<origin> read` and `<origin> written`).
pub type Budget = BTreeMap<String, u64>;

/// One key to carry, as a work list line: what a copier with no records (another machine) needs.
#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct Carry {
    pub key: String,
    pub length: u64,
    /// The media type to keep it under; empty when unknown (the copier asks `from` with a HEAD).
    pub media_type: String,
    /// The BLAKE3 hex the bytes must hash to, when the key names an identity.
    pub identity: Option<String>,
}

/// One key proved at `to`, as a proof line (written as a `namespace-moved` record by `import_proofs`).
#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct Proved {
    pub key: String,
    pub to: String,
    pub byte_length: u64,
    pub blake3: String,
    /// Always `UPLOAD_PROOF`: `blake3` is of the bytes as they streamed from `from`, `to` accepted them under their
    /// signed SHA-256 and holds the key at its length.
    pub proof: String,
    /// Where a packed key's bytes are kept at `to` (None: under its own key).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packed: Option<Packed>,
}

/// Where a packed key is kept at the destination: a proof line's `packed` and a proof record's `in`.
#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct Packed {
    /// The manifest object that lists the key with its size, BLAKE3 and offset in the archive.
    pub manifest: String,
    /// The archive object that holds the key's bytes; None for an empty key (its manifest alone holds it).
    pub archive: Option<String>,
    /// Where the key's bytes start in the archive (0 for an empty key).
    pub offset: u64,
}

/// One archive to pack: the group its members share and the members, in work-list order.
#[derive(Clone, Debug)]
pub struct Pack {
    pub group: String,
    pub members: Vec<Carry>,
}

/// Where keys are carried and how many at once.
#[derive(Clone, Copy, Debug)]
pub struct Route<'a> {
    pub from: &'a str,
    pub to: &'a str,
    /// Keys in flight at once.
    pub width: usize,
}

/// What a copier with no records did.
#[derive(Debug, Default, Serialize)]
pub struct Carried {
    pub proved: u64,
    pub proved_bytes: u64,
    pub failed: u64,
    pub failures: Vec<Failed>,
    pub requests: BTreeMap<String, u64>,
    pub bytes: BTreeMap<String, u64>,
    /// The counter that would have passed its budget cap; the copier stopped there.
    pub budget_spent: Option<String>,
    pub seconds: f64,
}

/// One phase's counts.
#[derive(Debug, Default, Serialize)]
pub struct Phase {
    /// Keys (or files, for `chunked_files`) this phase found to do.
    pub items: u64,
    pub bytes: u64,
    /// Keys already proved at `to` by an earlier run (only their record was left to rewrite).
    pub already_proved: u64,
    /// Keys copied and proved in this run.
    pub copied: u64,
    pub copied_bytes: u64,
    /// Chunk or file records rewritten to name `to`.
    pub records_rewritten: u64,
    /// Files left naming `from` because a chunk of theirs is not at `to` yet (`chunked_files`).
    pub waiting: u64,
    /// Keys not proved yet, left naming `from` by a records-only run.
    pub unproved: u64,
}

/// One key that did not move, and why.
#[derive(Debug, Serialize)]
pub struct Failed {
    pub key: String,
    pub why: String,
    /// The exact condition that failed; the public words above keep their original form.
    pub cause: Cause,
}

/// What a run did (or, in a dry run, would do).
#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub from: String,
    pub to: String,
    pub dry_run: bool,
    pub phases: BTreeMap<&'static str, Phase>,
    /// Requests per `<origin> <METHOD>`: sent in a run, estimated (the most a run would send) in a dry run.
    pub requests: BTreeMap<String, u64>,
    /// Bytes read from and written to each origin (`<origin> read` / `<origin> written`).
    pub bytes: BTreeMap<String, u64>,
    pub failed: u64,
    pub failures: Vec<Failed>,
    /// Uploads that were in progress at `from` when the hosted Worker stopped (they hold no finished file).
    pub uploads_naming_from: u64,
    /// The counter that would have passed its budget cap; the run stopped there.
    pub budget_spent: Option<String>,
    pub seconds: f64,
}

/// What the `from` store still holds, against the proof records.
#[derive(Debug, Default, Serialize)]
pub struct Audit {
    pub from: String,
    pub listed: u64,
    pub listed_bytes: u64,
    pub proved: u64,
    pub proved_bytes: u64,
    pub unproved: u64,
    pub unproved_bytes: u64,
    /// The first unproved keys and their sizes.
    pub unproved_keys: Vec<(String, u64)>,
    /// Chunk and file records that still name `from`.
    pub records_naming_from: u64,
    /// Every listed key is proved at its destination and no chunk or file record names `from`.
    pub complete: bool,
}

/// Which record a carried key belongs to.
#[derive(Clone)]
enum Owner {
    /// A chunk or file record (scope, the record as read).
    Record(&'static str, Record),
    /// A key the store lists that no record names.
    Unnamed,
}

/// One key to carry.
struct Item {
    key: String,
    length: u64,
    media_type: String,
    /// The BLAKE3 hex the bytes must hash to, when the key names an identity.
    identity: Option<String>,
    phase: &'static str,
    owner: Owner,
    /// The version of this key's proof record (0: none yet; an unnamed key whose size changed at `from` since its
    /// proof is carried again and its proof rewritten).
    proof_version: i64,
}

/// How a carried key was proved at `to` (`UPLOAD_PROOF`): the BLAKE3 of the bytes as they streamed from `from`.
struct Proof {
    blake3: String,
}

/// Requests and bytes per origin, counted by the port wrapper, and the budget they may not pass.
#[derive(Default)]
struct Counts {
    requests: Mutex<BTreeMap<String, u64>>,
    bytes: Mutex<BTreeMap<String, u64>>,
    budget: Option<Budget>,
    /// The first counter that would have passed its cap (then every further request is refused).
    spent: Mutex<Option<CodedError<String>>>,
}
impl Counts {
    fn with_budget(budget: Option<Budget>) -> Self {
        Self { budget, ..Self::default() }
    }
    fn add(map: &Mutex<BTreeMap<String, u64>>, key: String, by: u64) {
        if let Ok(mut map) = map.lock() {
            *map.entry(key).or_default() += by;
        }
    }
    /// Add `by` to a counter unless that would pass its cap; past the cap, the budget is spent for the whole run.
    fn spend(&self, map: &Mutex<BTreeMap<String, u64>>, key: String, by: u64) -> Result<(), Refusal> {
        if let Some(spent) = self.spent_refusal() {
            return Err(Refusal::Spent(spent.code.clone(), spent.cause()));
        }
        let mut map = map.lock().map_err(|_| Refusal::Spent("counters poisoned".into(), crate::cause!()))?;
        let next = map.get(&key).copied().unwrap_or(0) + by;
        if let Some(budget) = &self.budget {
            if next > budget.get(&key).copied().unwrap_or(0) {
                let why = format!("{key} would reach {next}, past its cap of {}", budget.get(&key).copied().unwrap_or(0));
                let cause = crate::cause!(moves budget_cap_would_be_passed);
                if let Ok(mut spent) = self.spent.lock() {
                    spent.get_or_insert_with(|| CodedError::with_cause(why.clone(), cause.clone()));
                }
                return Err(Refusal::Spent(why, cause));
            }
        }
        map.insert(key, next);
        Ok(())
    }
    fn request(&self, origin: &str, method: &str) -> Result<(), Refusal> {
        self.spend(&self.requests, format!("{origin} {method}"), 1)
    }
    fn moved(&self, origin: &str, way: &str, by: u64) -> Result<(), Refusal> {
        self.spend(&self.bytes, format!("{origin} {way}"), by)
    }
    fn spent(&self) -> Option<String> {
        self.spent_refusal().map(|spent| spent.code)
    }
    fn spent_refusal(&self) -> Option<CodedError<String>> {
        self.spent.lock().ok().and_then(|spent| spent.clone())
    }
    /// Stop the whole run: every further request is refused, as if the budget were spent.
    fn stop(&self, refusal: &CodedError<String>) {
        if let Ok(mut spent) = self.spent.lock() {
            spent.get_or_insert_with(|| refusal.clone());
        }
    }
}

/// The byte port, counting every request it sends.
struct Counted<'a> {
    objects: &'a (dyn Objects + Sync),
    counts: &'a Counts,
}
impl Counted<'_> {
    /// A ranged read; its bytes are charged before the request is sent, so a read never passes the byte cap.
    fn read(&self, origin: &str, key: &str, offset: u64, length: u64) -> Result<Vec<u8>, Refusal> {
        self.counts.request(origin, "GET")?;
        self.counts.moved(origin, "read", length)?;
        self.objects.read(origin, key, offset, length).map_err(|error| Refusal::of(origin, error))
    }
    fn write_stream(&self, origin: &str, key: &str, body: Body<'_>, media_type: &str) -> Result<(), Refusal> {
        self.counts.request(origin, "PUT")?;
        self.counts.moved(origin, "written", body.length)?;
        self.objects.write_stream(origin, key, body, media_type).map_err(|error| Refusal::of(origin, error))
    }
    fn stat(&self, origin: &str, key: &str) -> Result<Option<super::objects::Stat>, Refusal> {
        self.counts.request(origin, "HEAD")?;
        self.objects.stat(origin, key).map_err(|error| Refusal::of(origin, error))
    }
    fn list(&self, origin: &str, after: &str) -> Result<Listing, Refusal> {
        self.counts.request(origin, "LIST")?;
        self.objects.list(origin, "", after, MAX_LISTING_KEYS).map_err(|error| Refusal::of(origin, error))
    }
}

/// Why one key did not move.
enum Refusal {
    /// The store did not answer (worth another try). The cause is kept with the refusal, as every refusal keeps its
    /// construction cause, whether or not a log line reads it.
    #[allow(dead_code)]
    Unanswered(ObjectError, crate::refusal_cause::Cause),
    /// The bytes or the store's answer prove something is wrong (never retried).
    Wrong(String, crate::refusal_cause::Cause),
    /// The run's budget would be passed: nothing more is sent by anyone.
    Spent(String, crate::refusal_cause::Cause),
    /// The store refused this account's access (HTTP 401 or 403: the key, or a spending cap the store enforces, such
    /// as a cap_exceeded answer). No key can move past it, so the whole run stops at once, never retried.
    Stop(String, crate::refusal_cause::Cause),
}
impl From<ObjectError> for Refusal {
    fn from(error: ObjectError) -> Self {
        Self::of("the store", error)
    }
}
impl Refusal {
    fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Unanswered(error, _) => error.cause(),
            Self::Wrong(_, cause) | Self::Spent(_, cause) | Self::Stop(_, cause) => cause.clone(),
        }
    }
    /// Why a request to `origin` did not answer, naming the store when it refused access.
    fn of(origin: &str, error: ObjectError) -> Self {
        let cause = error.cause();
        match error {
            ObjectError::Unavailable(_, _) => Self::Unanswered(error, cause),
            ObjectError::Refused(status, _) if status == 429 || status >= 500 => Self::Unanswered(error, cause),
            ObjectError::Refused(401 | 403, _) | ObjectError::Denied(..) => Self::Stop(format!("{origin}: {error}: the key or a store spending cap; the whole run stops"), cause),
            other => Self::Wrong(other.to_string(), cause),
        }
    }
}
crate::impl_caused!(Refusal);

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unanswered(error, _) => write!(f, "{error}"),
            Self::Wrong(why, _) | Self::Stop(why, _) => f.write_str(why),
            Self::Spent(why, _) => write!(f, "the budget is spent: {why}"),
        }
    }
}

/// `step`, tried again (after a pause) while the store did not answer: the first try and at most `ATTEMPTS - 1`
/// retries. A refusal of access stops the whole run (`Counts::stop`) before it is answered.
fn tried<T>(counts: &Counts, mut step: impl FnMut() -> Result<T, Refusal>) -> Result<T, CodedError<String>> {
    let mut attempt = 1;
    loop {
        match step() {
            Ok(done) => return Ok(done),
            Err(Refusal::Unanswered(_, _)) if attempt < ATTEMPTS => {
                std::thread::sleep(Duration::from_secs(2 * u64::from(attempt)));
                attempt += 1;
            }
            Err(Refusal::Stop(why, cause)) => {
                let refusal = CodedError::with_cause(why, cause);
                counts.stop(&refusal);
                return Err(refusal);
            }
            Err(refusal) => return Err(CodedError::with_cause(refusal.to_string(), refusal.cause())),
        }
    }
}

/// The BLAKE3 hex an identity names (`1f:` + 64 hex), or None.
fn identity_hex(identity: &str) -> Option<String> {
    let hex = identity.strip_prefix("1f:")?;
    (hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| hex.to_ascii_lowercase())
}

/// The identity a storage key names by its last segment (`.../chunks/1f:<hex>`, `.../files/1f:<hex>`), or None.
fn key_identity(key: &str) -> Option<String> {
    identity_hex(key.rsplit('/').next()?)
}

/// The ranged reads of one object that cover it, each at most `MAX_RANGE_BYTES`.
fn pieces(length: u64) -> u64 {
    length.div_ceil(MAX_RANGE_BYTES)
}

/// A reader over an object's bytes, one ranged read at a time (memory: one piece).
struct Ranges<'a> {
    port: &'a Counted<'a>,
    origin: &'a str,
    key: &'a str,
    length: u64,
    at: u64,
    piece: Vec<u8>,
    used: usize,
}
impl Read for Ranges<'_> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.used == self.piece.len() {
            if self.at == self.length {
                return Ok(0);
            }
            let take = MAX_RANGE_BYTES.min(self.length - self.at);
            self.piece = crate::io_operation!((self.port.read(self.origin, self.key, self.at, take).map_err(|refusal| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&refusal).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(std::io::Error::other(refusal.to_string()), _refusal_io_cause) })).map_err(std::io::Error::from))?;
            if self.piece.len() as u64 != take {
                return crate::io_operation!(Err(std::io::Error::other("a ranged read answered fewer bytes than asked")));
            }
            self.at += take;
            self.used = 0;
        }
        let n = out.len().min(self.piece.len() - self.used);
        out[..n].copy_from_slice(&self.piece[self.used..self.used + n]);
        self.used += n;
        Ok(n)
    }
}

/// The BLAKE3 hex (and SHA-256) of an object, read in ranged pieces.
fn hash_at(port: &Counted<'_>, origin: &str, key: &str, length: u64) -> Result<(String, [u8; 32]), Refusal> {
    let mut blake = advanced::blake3::Hasher::new();
    let mut sha = Sha256::new();
    let mut at = 0;
    while at < length {
        let take = MAX_RANGE_BYTES.min(length - at);
        let piece = port.read(origin, key, at, take)?;
        if piece.len() as u64 != take {
            return Err(Refusal::Wrong(format!("{origin} answered {} of {take} bytes at {at}", piece.len()), crate::cause!()));
        }
        blake.update(&piece);
        sha.update(&piece);
        at += take;
    }
    Ok((blake.finalize().to_hex().to_string(), sha.finalize().into()))
}

/// Carry one key from `from` to `to` and prove it there by its upload checksum (the worker's whole job; no record is
/// touched here). Nothing is read from `to` but one HEAD.
fn carry(port: &Counted<'_>, from: &str, to: &str, item: &Item) -> Result<Proof, Refusal> {
    let (key, length) = (item.key.as_str(), item.length);
    let media_type = match item.media_type.as_str() {
        "" => port.stat(from, key)?.and_then(|stat| stat.media_type).unwrap_or_else(|| "application/octet-stream".into()),
        media_type => media_type.to_owned(),
    };
    let check = |blake3: &str| match &item.identity {
        Some(identity) if identity != blake3 => {
            Err(Refusal::Wrong(format!("the bytes at {from} hash to {blake3}, not to the identity the key names"), crate::cause!()))
        }
        _ => Ok(()),
    };
    let blake3 = if pieces(length) <= 1 {
        // One piece: read once, hash and check, send from memory under its SHA-256.
        let bytes = if length == 0 { Vec::new() } else { port.read(from, key, 0, length)? };
        if bytes.len() as u64 != length {
            return Err(Refusal::Wrong(format!("{from} answered {} of {length} bytes", bytes.len()), crate::cause!()));
        }
        let blake3 = advanced::blake3::hash(&bytes).to_hex().to_string();
        check(&blake3)?;
        let mut reader = bytes.as_slice();
        port.write_stream(to, key, Body { length, sha256: Sha256::digest(&bytes).into(), bytes: &mut reader }, &media_type)?;
        blake3
    } else {
        // Many pieces: one pass hashes (BLAKE3, checked, and SHA-256) before any byte is sent; the second streams into
        // one PUT signed with that SHA-256, so `to` refuses it if the second pass read other bytes.
        let (blake3, sha256) = hash_at(port, from, key, length)?;
        check(&blake3)?;
        let mut reader = Ranges { port, origin: from, key, length, at: 0, piece: Vec::new(), used: 0 };
        port.write_stream(to, key, Body { length, sha256, bytes: &mut reader }, &media_type)?;
        blake3
    };
    // `to` accepted the body under its signed SHA-256; it must now hold the key at its length.
    match port.stat(to, key)? {
        Some(stat) if stat.length == length => Ok(Proof { blake3 }),
        _ => Err(Refusal::Wrong(format!("{to} does not hold the {length} bytes it accepted"), crate::cause!())),
    }
}

/// Run `work` over `items` with `width` threads; `settle` runs on this thread for each answer, in the order answers
/// arrive. Stops handing out work once `stopped` answers true or `settle` fails; the work already handed out finishes
/// first. The one bounded worker pool of this module: key copiers, archive packers and their member readers.
fn in_parallel<I: Send, O: Send>(
    width: usize,
    items: impl IntoIterator<Item = I>,
    stopped: &(dyn Fn() -> bool + Sync),
    work: &(dyn Fn(I) -> O + Sync),
    mut settle: impl FnMut(O) -> Result<(), AccountFilesError>,
) -> Result<(), AccountFilesError> {
    let width = width.max(1);
    let (results_in, results) = mpsc::channel::<O>();
    let (work_in, queue) = mpsc::sync_channel::<I>(width);
    let queue = Mutex::new(queue);
    std::thread::scope(|threads| -> Result<(), AccountFilesError> {
        for _ in 0..width {
            let (queue, results_in) = (&queue, results_in.clone());
            threads.spawn(move || loop {
                let next = match queue.lock() {
                    Ok(queue) => queue.recv(),
                    Err(_) => return,
                };
                let Ok(item) = next else { return };
                if results_in.send(work(item)).is_err() {
                    return;
                }
            });
        }
        drop(results_in);
        let mut outcome = Ok(());
        for item in items {
            if outcome.is_err() || stopped() || work_in.send(item).is_err() {
                break;
            }
            while let Ok(answer) = results.try_recv() {
                if outcome.is_ok() {
                    outcome = settle(answer);
                }
            }
        }
        drop(work_in);
        for answer in results.iter() {
            if outcome.is_ok() {
                outcome = settle(answer);
            }
        }
        outcome
    })
}

/// Carry `items` with `width` workers; `settle` runs on this thread for each answer, in the order answers arrive.
/// Stops handing out work once the budget is spent (or the run was stopped) or `settle` fails.
fn carry_all(
    objects: &(dyn Objects + Sync),
    counts: &Counts,
    route: Route<'_>,
    items: Vec<Item>,
    mut settle: impl FnMut(Item, Result<Proof, CodedError<String>>) -> Result<(), AccountFilesError>,
) -> Result<(), AccountFilesError> {
    let port = Counted { objects, counts };
    let work = |item: Item| {
        let proof = tried(counts, || carry(&port, route.from, route.to, &item));
        (item, proof)
    };
    in_parallel(route.width, items, &|| counts.spent().is_some(), &work, |(item, proof)| settle(item, proof))
}

/// The mover over one account's store.
pub struct Mover<'a, S: Storage + Send> {
    store: &'a mut RecordStore<S>,
    account: String,
    plan: Plan,
    report: Report,
    counts: Arc<Counts>,
    started: Instant,
}

impl<'a, S: Storage + Send> Mover<'a, S> {
    pub fn new(store: &'a mut RecordStore<S>, account: &str, plan: Plan) -> Self {
        let report = Report { from: plan.from.clone(), to: plan.to.clone(), dry_run: plan.dry_run, ..Report::default() };
        let counts = Arc::new(Counts::with_budget(if plan.dry_run { None } else { plan.budget.clone() }));
        Self { store, account: account.into(), plan, report, counts, started: Instant::now() }
    }

    /// Mark `from` as taking no new bytes, unless this is a dry run (see `drain`).
    fn drain(&mut self) -> Result<(), AccountFilesError> {
        if self.plan.dry_run {
            return check_pair(self.store, &self.account, &self.plan.from, &self.plan.to).map(|_| ());
        }
        drain(self.store, &self.account, &self.plan.from, &self.plan.to).map(|_| ())
    }

    /// Run every phase; answers the report (also on a dry run). Failed keys are counted, not fatal: a later run
    /// tries them again.
    pub fn run(mut self, objects: &(dyn Objects + Sync), progress: &(dyn Fn(&str, &Phase) + Sync)) -> Result<Report, AccountFilesError> {
        self.drain()?;
        for phase in ["chunks", "whole_files"] {
            if self.counts.spent().is_none() {
                self.carry_records(objects, phase, progress)?;
            }
        }
        self.relabel_chunked_files()?;
        if self.plan.unnamed_keys && !self.plan.records_only && self.counts.spent().is_none() {
            self.carry_unnamed(objects, progress)?;
        }
        self.report.uploads_naming_from = self.uploads_naming_from()?;
        self.report.budget_spent = self.counts.spent();
        self.report.requests = std::mem::take(&mut *self.counts.requests.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?);
        self.report.bytes = std::mem::take(&mut *self.counts.bytes.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?);
        self.report.seconds = self.started.elapsed().as_secs_f64();
        Ok(self.report)
    }

    /// The items of one record page that this phase moves.
    fn items_of(&self, phase: &'static str, scope: &'static str, records: Vec<Record>) -> Vec<Item> {
        records
            .into_iter()
            .filter(|record| record.value.get("origin").and_then(Value::as_str) == Some(self.plan.from.as_str()))
            .filter(|record| phase != "whole_files" || record.value.get("spans").and_then(Value::as_u64) == Some(0))
            .filter_map(|record| {
                let key = record.value.get("key").and_then(Value::as_str)?.to_owned();
                let length = record.value.get("byte_length").and_then(Value::as_u64)?;
                let media_type = record.value.get("media_type").and_then(Value::as_str).unwrap_or("application/octet-stream").to_owned();
                let identity = identity_hex(&record.id);
                Some(Item { key, length, media_type, identity, phase, owner: Owner::Record(scope, record), proof_version: 0 })
            })
            .collect()
    }

    /// Walk the chunk records (`chunks`) or the file records (`whole_files`) and carry each one that names `from`.
    fn carry_records(&mut self, objects: &(dyn Objects + Sync), phase: &'static str, progress: &(dyn Fn(&str, &Phase) + Sync)) -> Result<(), AccountFilesError> {
        let scope = if phase == "chunks" { CHUNKS } else { FILES };
        self.report.phases.entry(phase).or_default();
        let mut after = String::new();
        // One page of records is carried before the next page is read.
        loop {
            let page = self.store.list_page(&self.account, scope, &after, MAX_PAGE_ITEMS)?;
            let next = page.next.clone();
            let items = self.items_of(phase, scope, page.items);
            self.carry_items(objects, items, progress)?;
            match next {
                Some(next) => after = next,
                None => return Ok(()),
            }
        }
    }

    /// Carry the `from` store's listed keys that no proof record covers.
    fn carry_unnamed(&mut self, objects: &(dyn Objects + Sync), progress: &(dyn Fn(&str, &Phase) + Sync)) -> Result<(), AccountFilesError> {
        self.report.phases.entry("unnamed_keys").or_default();
        if self.plan.dry_run {
            // Listing needs the store's key; a dry run sends no request, so the unnamed keys are counted by `audit`.
            return Ok(());
        }
        let counts = self.counts.clone();
        let port = Counted { objects, counts: &counts };
        let mut after = String::new();
        loop {
            let listing = port.list(&self.plan.from, &after).map_err(|refusal| ObjectError::Unavailable(refusal.to_string(), refusal.cause()))?;
            let Some((last, _)) = listing.objects.last() else { return Ok(()) };
            after = last.clone();
            let items = listing
                .objects
                .into_iter()
                .map(|(key, length)| Item {
                    identity: key_identity(&key),
                    key,
                    length,
                    media_type: String::new(),
                    phase: "unnamed_keys",
                    owner: Owner::Unnamed,
                    proof_version: 0,
                })
                .collect();
            self.carry_items(objects, items, progress)?;
            if !listing.more || self.counts.spent().is_some() {
                return Ok(());
            }
        }
    }

    /// Carry a batch of items: keys already proved only have their record rewritten; the rest go to the workers, and
    /// each proved key gets its proof record and then its record rewrite, here on the one thread that writes records.
    fn carry_items(&mut self, objects: &(dyn Objects + Sync), items: Vec<Item>, progress: &(dyn Fn(&str, &Phase) + Sync)) -> Result<(), AccountFilesError> {
        let moved = moved_scope(&self.plan.from);
        let keys: Vec<&str> = items.iter().map(|item| item.key.as_str()).collect();
        let proofs = if keys.is_empty() { Vec::new() } else { self.store.get_many(&self.account, &moved, &keys)? };
        let mut todo = Vec::new();
        for (mut item, proof) in items.into_iter().zip(proofs) {
            let phase = self.report.phases.entry(item.phase).or_default();
            match proof {
                // An unnamed key already proved at its listed size (by a record phase or an earlier run) is done.
                Some(proof) if matches!(item.owner, Owner::Unnamed) => {
                    if proof.value.get("byte_length").and_then(Value::as_u64) != Some(item.length) {
                        phase.items += 1;
                        phase.bytes += item.length;
                        item.proof_version = proof.version;
                        todo.push(item);
                    }
                }
                Some(proof) => {
                    phase.items += 1;
                    phase.bytes += item.length;
                    phase.already_proved += 1;
                    if !self.plan.dry_run {
                        let to = proof.value.get("to").and_then(Value::as_str).unwrap_or_default().to_owned();
                        self.relabel(&item, &to)?;
                    }
                }
                None => {
                    phase.items += 1;
                    phase.bytes += item.length;
                    todo.push(item);
                }
            }
        }
        if self.plan.dry_run {
            for item in &todo {
                self.estimate(item);
            }
            return Ok(());
        }
        if self.plan.records_only {
            for item in &todo {
                self.report.phases.entry(item.phase).or_default().unproved += 1;
            }
            return Ok(());
        }
        let (from, to, width, counts) = (self.plan.from.clone(), self.plan.to.clone(), self.plan.concurrency, self.counts.clone());
        let route = Route { from: &from, to: &to, width };
        carry_all(objects, &counts, route, todo, |item, proof| self.settle(item, proof, progress))
    }

    /// One worker's answer: on proof, the proof record and then the record rewrite; on refusal, a counted failure.
    fn settle(&mut self, item: Item, proof: Result<Proof, CodedError<String>>, progress: &(dyn Fn(&str, &Phase) + Sync)) -> Result<(), AccountFilesError> {
        match proof {
            Ok(proof) => {
                let to = self.plan.to.clone();
                let value = json!({
                    "kind": MOVED_KIND, "to": to, "byte_length": item.length, "blake3": proof.blake3,
                    "proof": UPLOAD_PROOF,
                });
                let request_key = request_key(&["moved", &self.plan.from, &to, &item.key, &item.proof_version.to_string()]);
                let moved = moved_scope(&self.plan.from);
                self.store.mutate(&self.account, &moved, Mutation { id: item.key.clone(), expected_version: item.proof_version, request_key, deleted: false, value })?;
                self.relabel(&item, &to)?;
                let phase = self.report.phases.entry(item.phase).or_default();
                phase.copied += 1;
                phase.copied_bytes += item.length;
                progress(item.phase, phase);
            }
            Err(why) => {
                self.report.failed += 1;
                if self.report.failures.len() < REPORTED_FAILURES {
                    self.report.failures.push(Failed { key: item.key, cause: why.cause(), why: why.code });
                }
            }
        }
        Ok(())
    }

    /// Rewrite a proved key's chunk or file record to name `to` (an unnamed key has none).
    fn relabel(&mut self, item: &Item, to: &str) -> Result<(), AccountFilesError> {
        let Owner::Record(scope, record) = &item.owner else { return Ok(()) };
        let mut value = record.value.clone();
        value["origin"] = json!(to);
        let request_key = request_key(&["relabel", scope, &record.id, to, &record.version.to_string()]);
        self.store.mutate(&self.account, scope, Mutation { id: record.id.clone(), expected_version: record.version, request_key, deleted: false, value })?;
        self.report.phases.entry(item.phase).or_default().records_rewritten += 1;
        Ok(())
    }

    /// The most requests a run would send for one item (a dry run).
    fn estimate(&self, item: &Item) {
        estimate(&self.counts, &self.plan.from, &self.plan.to, item.length, item.media_type.is_empty());
    }

    /// Relabel each chunked file that names `from` once every chunk of it is at `to` (its bytes are its chunks').
    fn relabel_chunked_files(&mut self) -> Result<(), AccountFilesError> {
        self.report.phases.entry("chunked_files").or_default();
        let mut after = String::new();
        loop {
            let page = self.store.list_page(&self.account, FILES, &after, MAX_PAGE_ITEMS)?;
            let next = page.next.clone();
            for file in page.items {
                if file.value.get("origin").and_then(Value::as_str) != Some(self.plan.from.as_str())
                    || file.value.get("spans").and_then(Value::as_u64).unwrap_or(0) == 0
                {
                    continue;
                }
                let length = file.value.get("byte_length").and_then(Value::as_u64).unwrap_or(0);
                let ready = !self.plan.dry_run && self.chunks_all_at(&file, &self.plan.to)?;
                let phase = self.report.phases.entry("chunked_files").or_default();
                phase.items += 1;
                phase.bytes += length;
                if ready {
                    let item = Item {
                        key: file.id.clone(),
                        length,
                        media_type: String::new(),
                        identity: None,
                        phase: "chunked_files",
                        owner: Owner::Record(FILES, file),
                        proof_version: 0,
                    };
                    let to = self.plan.to.clone();
                    self.relabel(&item, &to)?;
                } else if !self.plan.dry_run {
                    phase.waiting += 1;
                }
            }
            match next {
                Some(next) => after = next,
                None => return Ok(()),
            }
        }
    }

    /// Whether every chunk of a chunked file names `origin` (its span pages, then batch gets of its chunks). A file
    /// whose spans are paged by upload (`pages-32k-v1`, `pages-append-v1`, `chunks-v1`) has its pages read here too.
    fn chunks_all_at(&self, file: &Record, origin: &str) -> Result<bool, AccountFilesError> {
        let mut chunks: Vec<String> = Vec::new();
        for page in super::paged_spans::page_ids(file) {
            let Some(record) = self.store.get(&self.account, SPANS, &page)?.record else { return Ok(false) };
            chunks.extend(record.value.get("spans").and_then(Value::as_array).into_iter().flatten().filter_map(|span| span.get("chunk")?.as_str()).map(str::to_owned));
        }
        if chunks.is_empty() {
            return Ok(false);
        }
        let chunks: Vec<&str> = chunks.iter().map(String::as_str).collect();
        for batch in chunks.chunks(MAX_PAGE_ITEMS) {
            for chunk in self.store.get_many(&self.account, CHUNKS, batch)? {
                if chunk.as_ref().and_then(|chunk| chunk.value.get("origin")).and_then(Value::as_str) != Some(origin) {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    /// Upload records that name `from` (uploads the hosted Worker never finished).
    fn uploads_naming_from(&self) -> Result<u64, AccountFilesError> {
        count_naming(self.store, &self.account, super::UPLOADS, &self.plan.from)
    }
}

/// An origin record and what it holds.
fn origin_of<S: Storage + Send>(store: &RecordStore<S>, account: &str, id: &str) -> Result<Option<(Record, Origin)>, AccountFilesError> {
    let Some(record) = store.get(account, ORIGINS, id)?.record else { return Ok(None) };
    let origin: Origin = serde_json::from_value(record.value.clone()).map_err(|_| Error::Invalid("invalid origin record", crate::cause!()))?;
    Ok(Some((record, origin)))
}

/// Both origins exist and `to` takes new bytes; answers the `from` record.
fn check_pair<S: Storage + Send>(store: &RecordStore<S>, account: &str, from: &str, to: &str) -> Result<(Record, Origin), AccountFilesError> {
    let held = origin_of(store, account, from)?.ok_or(AccountFilesError::Invalid("the account has no such from origin", crate::cause!()))?;
    let (_, to) = origin_of(store, account, to)?.ok_or(AccountFilesError::Invalid("the account has no such to origin", crate::cause!()))?;
    if !to.takes_new_bytes {
        return Err(AccountFilesError::Invalid("the to origin takes no new bytes", crate::cause!()));
    }
    Ok(held)
}

/// Mark `from` as taking no new bytes (one origin record rewrite; nothing when it already takes none), after checking
/// that `to` exists and takes them. Answers whether the record was rewritten.
pub fn drain<S: Storage + Send>(store: &mut RecordStore<S>, account: &str, from: &str, to: &str) -> Result<bool, AccountFilesError> {
    let (record, mut origin) = check_pair(store, account, from, to)?;
    if !origin.takes_new_bytes {
        return Ok(false);
    }
    origin.takes_new_bytes = false;
    let value = serde_json::to_value(&origin).map_err(|_| Error::Invalid("invalid origin record", crate::cause!()))?;
    let request_key = request_key(&["drain", from, &record.version.to_string()]);
    store.mutate(account, ORIGINS, Mutation { id: record.id, expected_version: record.version, request_key, deleted: false, value })?;
    Ok(true)
}

/// The most requests and bytes carrying one key can take, added to `counts`: the reads at `from` (twice for a
/// many-piece object: hash, then stream), one PUT and one HEAD at `to` (nothing is read back), and a HEAD at `from`
/// when the media type is not known.
fn estimate(counts: &Counts, from: &str, to: &str, length: u64, asks_media_type: bool) {
    let reads = pieces(length);
    let source_passes = if reads > 1 { 2 } else { 1 };
    Counts::add(&counts.requests, format!("{to} HEAD"), 1);
    Counts::add(&counts.requests, format!("{from} GET"), reads * source_passes);
    Counts::add(&counts.requests, format!("{to} PUT"), 1);
    if asks_media_type {
        Counts::add(&counts.requests, format!("{from} HEAD"), 1);
    }
    Counts::add(&counts.bytes, format!("{from} read"), length * source_passes);
    Counts::add(&counts.bytes, format!("{to} written"), length);
}

/// The plan of carrying `keys` (the most requests and bytes, by counter name), and the budget a run of it gets:
/// every counter of the plan times `margin_percent` / 100, rounded up.
pub fn plan_of(keys: &[Carry], from: &str, to: &str, margin_percent: u64) -> (Budget, Budget) {
    let counts = Counts::default();
    for key in keys {
        estimate(&counts, from, to, key.length, key.media_type.is_empty());
    }
    budget_of(counts, margin_percent)
}

/// A plan's counters and the budget they give: every counter times `margin_percent` / 100, rounded up.
fn budget_of(counts: Counts, margin_percent: u64) -> (Budget, Budget) {
    let mut plan = counts.requests.into_inner().unwrap_or_default();
    plan.extend(counts.bytes.into_inner().unwrap_or_default());
    let budget = plan.iter().map(|(name, count)| (name.clone(), (count * margin_percent).div_ceil(100))).collect();
    (plan, budget)
}

/// Every key of `from` not proved yet, as a work list for a copier with no records: the chunk and whole-file records
/// that name `from` (with their media type and identity), then (`with_listing`) every key the store lists that neither
/// a record nor a proof covers. One walk of the chunk and file records, one listing of the store (`listing_of`), one
/// batch get of proofs per page.
///
/// Answers the work list and how many keys the store listed (0 without the listing).
pub fn work_list<S: Storage + Send>(
    store: &RecordStore<S>,
    account: &str,
    objects: &(dyn Objects + Sync),
    from: &str,
    with_listing: bool,
    listed_so_far: ListingProgress<'_>,
) -> Result<(Vec<Carry>, u64), AccountFilesError> {
    let moved = moved_scope(from);
    let mut keys = Vec::new();
    let mut named = std::collections::HashSet::new();
    for scope in [CHUNKS, FILES] {
        let mut after = String::new();
        loop {
            let page = store.list_page(account, scope, &after, MAX_PAGE_ITEMS)?;
            let found: Vec<Carry> = page
                .items
                .iter()
                .filter(|record| record.value.get("origin").and_then(Value::as_str) == Some(from))
                .filter(|record| scope == CHUNKS || record.value.get("spans").and_then(Value::as_u64) == Some(0))
                .filter_map(|record| {
                    Some(Carry {
                        key: record.value.get("key").and_then(Value::as_str)?.to_owned(),
                        length: record.value.get("byte_length").and_then(Value::as_u64)?,
                        media_type: record.value.get("media_type").and_then(Value::as_str).unwrap_or("application/octet-stream").to_owned(),
                        identity: identity_hex(&record.id),
                    })
                })
                .collect();
            let ids: Vec<&str> = found.iter().map(|key| key.key.as_str()).collect();
            let proofs = if ids.is_empty() { Vec::new() } else { store.get_many(account, &moved, &ids)? };
            for (key, proof) in found.into_iter().zip(proofs) {
                named.insert(key.key.clone());
                if proof.is_none() {
                    keys.push(key);
                }
            }
            match page.next {
                Some(next) => after = next,
                None => break,
            }
        }
    }
    if !with_listing {
        return Ok((keys, 0));
    }
    let listing = listing_of(objects, from, listed_so_far)?;
    for page in listing.chunks(MAX_PAGE_ITEMS) {
        let ids: Vec<&str> = page.iter().map(|(key, _)| key.as_str()).collect();
        for ((key, length), proof) in page.iter().zip(store.get_many(account, &moved, &ids)?) {
            let proved = proof.is_some_and(|proof| proof.value.get("byte_length").and_then(Value::as_u64) == Some(*length));
            if !proved && !named.contains(key) {
                keys.push(Carry { key: key.clone(), length: *length, media_type: String::new(), identity: key_identity(key) });
            }
        }
    }
    Ok((keys, listing.len() as u64))
}

/// Carry a work list with no records (another machine), proving each key the way `proving` says: each proved key is
/// handed to `proved` as it is proved, with the requests and bytes spent so far; each failed key goes to the report. Stops handing out work once the budget is
/// spent.
pub fn carry_keys(
    objects: &(dyn Objects + Sync),
    route: Route<'_>,
    budget: Option<Budget>,
    keys: Vec<Carry>,
    mut proved: impl FnMut(&Proved, &BTreeMap<String, u64>, &BTreeMap<String, u64>),
) -> Carried {
    let started = Instant::now();
    let counts = Counts::with_budget(budget);
    let mut carried = Carried::default();
    let items = keys
        .into_iter()
        .map(|key| Item {
            key: key.key,
            length: key.length,
            media_type: key.media_type,
            identity: key.identity,
            phase: "carry",
            owner: Owner::Unnamed,
            proof_version: 0,
        })
        .collect();
    let to = route.to;
    let settled = carry_all(objects, &counts, route, items, |item, proof| {
        match proof {
            Ok(proof) => {
                carried.proved += 1;
                carried.proved_bytes += item.length;
                let line = Proved {
                    key: item.key,
                    to: to.to_owned(),
                    byte_length: item.length,
                    blake3: proof.blake3,
                    proof: UPLOAD_PROOF.to_owned(),
                    packed: None,
                };
                let requests = counts.requests.lock().map(|map| map.clone()).unwrap_or_default();
                let bytes = counts.bytes.lock().map(|map| map.clone()).unwrap_or_default();
                proved(&line, &requests, &bytes);
            }
            Err(why) => {
                carried.failed += 1;
                if carried.failures.len() < REPORTED_FAILURES {
                    carried.failures.push(Failed { key: item.key, cause: why.cause(), why: why.code });
                }
            }
        }
        Ok(())
    });
    if let Err(error) = settled {
        carried.failures.push(Failed { key: String::new(), why: error.to_string(), cause: error.cause() });
    }
    carried.budget_spent = counts.spent();
    carried.requests = counts.requests.into_inner().unwrap_or_default();
    carried.bytes = counts.bytes.into_inner().unwrap_or_default();
    carried.seconds = started.elapsed().as_secs_f64();
    carried
}

/// Write proof lines (from a copier with no records) as `namespace-moved` records of `from`. A key whose proof is
/// already held with the same size and BLAKE3 is left as it is; one held with another is refused (counted, not
/// rewritten). Answers (written, already held, refused).
pub fn import_proofs<S: Storage + Send>(
    store: &mut RecordStore<S>,
    account: &str,
    from: &str,
    lines: impl IntoIterator<Item = Proved>,
) -> Result<(u64, u64, u64), AccountFilesError> {
    let moved = moved_scope(from);
    let (mut written, mut held, mut refused) = (0, 0, 0);
    for line in lines {
        let known_kind = line.proof == UPLOAD_PROOF;
        if identity_hex(&format!("1f:{}", line.blake3)).is_none() || !known_kind {
            refused += 1;
            continue;
        }
        let mut value = json!({
            "kind": MOVED_KIND, "to": line.to, "byte_length": line.byte_length, "blake3": line.blake3, "proof": line.proof,
        });
        if let Some(packed) = &line.packed {
            value["in"] = json!(packed);
        }
        match store.get(account, &moved, &line.key)?.record {
            Some(record) if record.value == value => held += 1,
            Some(_) => refused += 1,
            None => {
                let request_key = request_key(&["moved", from, &line.to, &line.key, "0"]);
                store.mutate(account, &moved, Mutation { id: line.key, expected_version: 0, request_key, deleted: false, value })?;
                written += 1;
            }
        }
    }
    Ok((written, held, refused))
}

/// How far a listing walk has come: keys and bytes listed so far, and why a page is being asked again (when it is).
pub type ListingProgress<'a> = &'a mut dyn FnMut(u64, u64, Option<&str>);

/// Every key `from` lists, with its size, in key order. A store that lists by level (`Objects::list_level`) is walked
/// by level down to `LISTING_LEVELS` (`people/<id>/<kind>/`), and each prefix found there is walked flat (its pages
/// follow one another by the store's continuation token, 1000 keys each), with up to `LISTING_WIDTH` pages in flight:
/// so the requests stay one per 1000 keys plus one per prefix above that depth, however deep a person's folders go. Any other store is walked as one flat run of
/// pages. Each page is tried again (after a pause) while the store did not answer, at most `ATTEMPTS` times; each retry
/// of a flat run is told to `progress` with the store's answer.
fn listing_of(objects: &(dyn Objects + Sync), from: &str, progress: ListingProgress<'_>) -> Result<Vec<(String, u64)>, AccountFilesError> {
    /// One page to ask for: of a level (its prefix, continuation token and depth), or of a flat run (its prefix and
    /// continuation token).
    enum Ask {
        Level(String, String, usize),
        Flat(String, String),
    }
    /// What one page answered: keys and the pages to ask for next.
    type Answer = (Vec<(String, u64)>, Vec<Ask>);
    let counts = Counts::default();
    let ask = |page: Ask| -> Result<Option<Answer>, CodedError<String>> {
        match page {
            Ask::Level(prefix, token, depth) => {
                let Some(level) = tried(&counts, || Ok(objects.list_level(from, &prefix, &token)?))? else { return Ok(None) };
                let mut next: Vec<Ask> = level
                    .prefixes
                    .into_iter()
                    .map(|deeper| if depth + 1 < LISTING_LEVELS { Ask::Level(deeper, String::new(), depth + 1) } else { Ask::Flat(deeper, String::new()) })
                    .collect();
                next.extend(level.next.map(|token| Ask::Level(prefix, token, depth)));
                Ok(Some((level.objects, next)))
            }
            Ask::Flat(prefix, token) => {
                let Some(page) = tried(&counts, || Ok(objects.list_flat(from, &prefix, &token)?))? else { return Ok(None) };
                Ok(Some((page.objects, page.next.map(|token| Ask::Flat(prefix, token)).into_iter().collect())))
            }
        }
    };
    let Some((mut found, mut pending)) = ask(Ask::Level(String::new(), String::new(), 0)).map_err(|value| ObjectError::Unavailable(value.code.clone(), value.cause()))? else {
        return flat_listing(objects, from, progress);
    };
    let mut bytes = found.iter().map(|(_, length)| length).sum::<u64>();
    progress(found.len() as u64, bytes, None);
    while !pending.is_empty() {
        let round = std::mem::take(&mut pending);
        in_parallel(LISTING_WIDTH, round, &|| false, &ask, |answer| match answer {
            Ok(Some((keys, next))) => {
                bytes += keys.iter().map(|(_, length)| length).sum::<u64>();
                found.extend(keys);
                pending.extend(next);
                progress(found.len() as u64, bytes, None);
                Ok(())
            }
            Ok(None) => Err(ObjectError::Unavailable("the store stopped listing by level".into(), crate::cause!()).into()),
            Err(why) => Err(ObjectError::Unavailable(why.code.clone(), why.cause()).into()),
        })?;
    }
    found.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    Ok(found)
}

/// Every key `from` lists, one flat page after another.
fn flat_listing(objects: &dyn Objects, from: &str, progress: ListingProgress<'_>) -> Result<Vec<(String, u64)>, AccountFilesError> {
    let (mut found, mut bytes) = (Vec::new(), 0u64);
    let mut after = String::new();
    loop {
        let mut attempt = 1;
        let listing = loop {
            match objects.list(from, "", &after, MAX_LISTING_KEYS) {
                Ok(listing) => break listing,
                Err(error) => match Refusal::from(error) {
                    Refusal::Unanswered(error, _) if attempt < ATTEMPTS => {
                        progress(found.len() as u64, bytes, Some(&format!("try {attempt}: {error}")));
                        std::thread::sleep(Duration::from_secs(2 * u64::from(attempt)));
                        attempt += 1;
                    }
                    Refusal::Unanswered(error, _) => return Err(error.into()),
                    other => return Err(ObjectError::Unavailable(other.to_string(), crate::cause!()).into()),
                },
            }
        };
        bytes += listing.objects.iter().map(|(_, length)| length).sum::<u64>();
        let last = listing.objects.last().map(|(key, _)| key.clone());
        found.extend(listing.objects);
        progress(found.len() as u64, bytes, None);
        match (listing.more, last) {
            (true, Some(last)) => after = last,
            _ => return Ok(found),
        }
    }
}

/// The group a key is packed with: its first two path segments (`people/<id>/`), its first one when it has only one,
/// or "" for a key at the root.
fn pack_group(key: &str) -> &str {
    let mut ends = key.match_indices('/').map(|(at, _)| at + 1);
    match (ends.next(), ends.next()) {
        (_, Some(second)) => &key[..second],
        (Some(first), None) => &key[..first],
        _ => "",
    }
}

/// The most bytes `verify-sample`, the one read of a destination, may read back (DATA: `moves.json`).
pub fn verify_sample_most_bytes() -> Result<u64, AccountFilesError> {
    let data: Value = serde_json::from_slice(MOVES_DATA).map_err(|_| AccountFilesError::Invalid("moves.json is not JSON", crate::cause!()))?;
    data["verify_sample_most_bytes"].as_u64().ok_or(AccountFilesError::Invalid("moves.json names no verify_sample_most_bytes", crate::cause!()))
}

/// Whether a work-list key is packed: a key no record names (its media type is unknown) of at most
/// `PACK_MOST_MEMBER_BYTES`. Every other key is carried whole under its own key.
pub fn packs(key: &Carry) -> bool {
    key.media_type.is_empty() && key.length <= PACK_MOST_MEMBER_BYTES
}

/// The archives a work list of small keys packs into: one group at a time (in group order, members in work-list
/// order), each archive sealed before its bytes would pass `PACK_TARGET_BYTES` or its members `PACK_MOST_MEMBERS`.
/// The same keys always give the same archives.
pub fn pack_plan(keys: Vec<Carry>) -> Vec<Pack> {
    let mut groups: BTreeMap<String, Vec<Carry>> = BTreeMap::new();
    for key in keys {
        groups.entry(pack_group(&key.key).to_owned()).or_default().push(key);
    }
    let mut packs = Vec::new();
    for (group, members) in groups {
        let mut pack = Pack { group: group.clone(), members: Vec::new() };
        let mut bytes = 0;
        for member in members {
            if !pack.members.is_empty() && (bytes + member.length > PACK_TARGET_BYTES || pack.members.len() == PACK_MOST_MEMBERS) {
                packs.push(std::mem::replace(&mut pack, Pack { group: group.clone(), members: Vec::new() }));
                bytes = 0;
            }
            bytes += member.length;
            pack.members.push(member);
        }
        packs.push(pack);
    }
    packs
}

/// The key of a packed object at the destination: the packed root, the store the keys came from, their group, and
/// the BLAKE3 of the object's own bytes (so a key never names two contents).
fn packed_key(from: &str, group: &str, blake3: &str, ending: &str) -> String {
    format!("{PACKED_ROOT}{from}/{group}{blake3}.{ending}")
}

/// One member as its manifest lists it.
#[derive(Clone, Copy, Serialize)]
struct Member<'a> {
    key: &'a str,
    offset: u64,
    length: u64,
    blake3: &'a str,
}

/// A manifest's bytes: which store and group, the archive (None when every member is empty), its size and BLAKE3,
/// and every member's original key, offset, size and BLAKE3.
fn manifest_bytes(from: &str, group: &str, archive: Option<&str>, length: u64, blake3: &str, members: &[Member<'_>]) -> Result<Vec<u8>, AccountFilesError> {
    serde_json::to_vec(&json!({
        "kind": PACK_KIND, "from": from, "group": group, "archive": archive, "byte_length": length, "blake3": blake3, "members": members,
    }))
    .map_err(|_| AccountFilesError::Invalid("a manifest that is not JSON", crate::cause!()))
}

/// The plan of packing `packs` (the most requests and bytes, by counter name) and the budget a run of it gets. Per
/// member with bytes: one GET at `from`. Per archive: a PUT and a HEAD at `to` (nothing is read back). Per manifest, the same;
/// its size is the size it has when every member is packed (placeholder hashes have the real length), the most it can
/// be.
pub fn plan_of_packs(packs: &[Pack], from: &str, to: &str, margin_percent: u64) -> Result<(Budget, Budget), AccountFilesError> {
    let counts = Counts::default();
    let placeholder = "0".repeat(64);
    let keep = |length: u64| {
        Counts::add(&counts.requests, format!("{to} HEAD"), 1);
        Counts::add(&counts.requests, format!("{to} PUT"), 1);
        Counts::add(&counts.bytes, format!("{to} written"), length);
    };
    for pack in packs {
        let mut members = Vec::with_capacity(pack.members.len());
        let mut offset = 0;
        for member in &pack.members {
            if member.length > 0 {
                Counts::add(&counts.requests, format!("{from} GET"), 1);
                Counts::add(&counts.bytes, format!("{from} read"), member.length);
            }
            members.push(Member { key: &member.key, offset: if member.length > 0 { offset } else { 0 }, length: member.length, blake3: &placeholder });
            offset += member.length;
        }
        let archive = (offset > 0).then(|| packed_key(from, &pack.group, &placeholder, "pack"));
        if offset > 0 {
            keep(offset);
        }
        keep(manifest_bytes(from, &pack.group, archive.as_deref(), offset, &placeholder, &members)?.len() as u64);
    }
    Ok(budget_of(counts, margin_percent))
}

/// One member's bytes from `from` in one ranged read and their BLAKE3, computed as they arrive and checked against the
/// identity its key names (when it names one).
fn read_member(port: &Counted<'_>, from: &str, member: &Carry) -> Result<(Vec<u8>, String), Refusal> {
    if member.length > MAX_RANGE_BYTES {
        return Err(Refusal::Wrong("a key too large to pack".into(), crate::cause!()));
    }
    let bytes = port.read(from, &member.key, 0, member.length)?;
    if bytes.len() as u64 != member.length {
        return Err(Refusal::Wrong(format!("{from} answered {} of {} bytes", bytes.len(), member.length), crate::cause!()));
    }
    let blake3 = advanced::blake3::hash(&bytes).to_hex().to_string();
    if member.identity.as_ref().is_some_and(|identity| *identity != blake3) {
        return Err(Refusal::Wrong(format!("the bytes at {from} do not hash to the identity the key names"), crate::cause!()));
    }
    Ok((bytes, blake3))
}

/// Keep `bytes` as `key` at `to` by the one proof of a copy: one PUT signed with their SHA-256 (so `to` refuses any
/// other body), then one HEAD that finds the key at their length. Nothing is read back.
fn keep(port: &Counted<'_>, to: &str, key: &str, bytes: &[u8], media_type: &str) -> Result<(), Refusal> {
    let length = bytes.len() as u64;
    let mut reader = bytes;
    port.write_stream(to, key, Body { length, sha256: Sha256::digest(bytes).into(), bytes: &mut reader }, media_type)?;
    match port.stat(to, key)? {
        Some(held) if held.length == length => Ok(()),
        _ => Err(Refusal::Wrong(format!("{to} does not hold the {length} bytes it accepted"), crate::cause!())),
    }
}

/// What packing one archive answered: a proof line per member proved, and each other member and why.
struct Packing {
    proved: Vec<Proved>,
    failed: Vec<Failed>,
}

/// Pack one archive: read its members from `from` with `readers` readers (each member's BLAKE3 computed as it
/// arrives), keep the archive, then keep the manifest that records every member's key, offset, size and BLAKE3, each by
/// its signed upload checksum. A member is proved only once both objects are kept.
fn pack_one(port: &Counted<'_>, from: &str, to: &str, readers: usize, pack: Pack) -> Packing {
    let counts = port.counts;
    let mut packing = Packing { proved: Vec::new(), failed: Vec::new() };
    let mut read: Vec<Option<(Vec<u8>, String)>> = vec![None; pack.members.len()];
    let with_bytes: Vec<usize> = (0..pack.members.len()).filter(|&at| pack.members[at].length > 0).collect();
    let fetch = |at: usize| (at, tried(counts, || read_member(port, from, &pack.members[at])));
    let fetched = in_parallel(readers, with_bytes, &|| counts.spent().is_some(), &fetch, |(at, bytes)| {
        match bytes {
            Ok(bytes) => read[at] = Some(bytes),
            Err(why) => packing.failed.push(Failed { key: pack.members[at].key.clone(), cause: why.cause(), why: why.code }),
        }
        Ok(())
    });
    let all_fail = |packing: &mut Packing, why: &str, cause: Cause| {
        let failed: std::collections::HashSet<String> = packing.failed.iter().map(|failed| failed.key.clone()).collect();
        let rest = pack.members.iter().filter(|member| !failed.contains(&member.key));
        packing.failed.extend(rest.map(|member| Failed { key: member.key.clone(), why: why.to_owned(), cause: cause.clone() }).collect::<Vec<_>>());
    };
    if let Some(spent) = counts.spent_refusal() {
        all_fail(&mut packing, &format!("the run stopped before this archive was kept: {}", spent.code), spent.cause());
        return packing;
    }
    if let Err(error) = fetched {
        all_fail(&mut packing, &error.to_string(), error.cause());
        return packing;
    }
    // The archive: every member read, in work-list order; an empty member has no bytes in it.
    let empty = advanced::blake3::hash(&[]).to_hex().to_string();
    let mut archive = Vec::new();
    let mut placed = Vec::new();
    for (at, member) in pack.members.iter().enumerate() {
        if member.length == 0 {
            placed.push((at, 0, empty.clone()));
        } else if let Some((bytes, blake3)) = read[at].take() {
            placed.push((at, archive.len() as u64, blake3));
            archive.extend_from_slice(&bytes);
        }
    }
    drop(read);
    let archive_blake3 = advanced::blake3::hash(&archive).to_hex().to_string();
    let archive_key = (!archive.is_empty()).then(|| packed_key(from, &pack.group, &archive_blake3, "pack"));
    if let Some(key) = &archive_key {
        if let Err(why) = tried(counts, || keep(port, to, key, &archive, PACKED_TYPE)) {
            all_fail(&mut packing, &why.code, why.cause());
            return packing;
        }
    }
    let archive_length = archive.len() as u64;
    drop(archive);
    let listed: Vec<Member<'_>> = placed
        .iter()
        .map(|(at, offset, blake3)| Member { key: &pack.members[*at].key, offset: *offset, length: pack.members[*at].length, blake3 })
        .collect();
    let manifest = match manifest_bytes(from, &pack.group, archive_key.as_deref(), archive_length, &archive_blake3, &listed) {
        Ok(manifest) => manifest,
        Err(error) => {
            all_fail(&mut packing, &error.to_string(), error.cause());
            return packing;
        }
    };
    let manifest_key = packed_key(from, &pack.group, advanced::blake3::hash(&manifest).to_hex().as_str(), "manifest.json");
    if let Err(why) = tried(counts, || keep(port, to, &manifest_key, &manifest, PACKED_TYPE)) {
        all_fail(&mut packing, &why.code, why.cause());
        return packing;
    }
    for member in listed {
        packing.proved.push(Proved {
            key: member.key.to_owned(),
            to: to.to_owned(),
            byte_length: member.length,
            blake3: member.blake3.to_owned(),
            proof: UPLOAD_PROOF.to_owned(),
            packed: Some(Packed {
                manifest: manifest_key.clone(),
                archive: if member.length > 0 { archive_key.clone() } else { None },
                offset: member.offset,
            }),
        });
    }
    packing
}

/// Pack a work list of small keys with no records (another machine): `concurrency / PACK_READERS` archives at once,
/// each read with `PACK_READERS` readers. Each proved member is handed to `proved` as its archive and manifest are proved,
/// with the requests and bytes spent so far; each failed member goes to the report. Stops handing out archives once
/// the budget is spent or a store refused access.
pub fn pack_keys(
    objects: &(dyn Objects + Sync),
    from: &str,
    to: &str,
    concurrency: usize,
    budget: Option<Budget>,
    packs: Vec<Pack>,
    mut proved: impl FnMut(&Proved, &BTreeMap<String, u64>, &BTreeMap<String, u64>),
) -> Carried {
    let started = Instant::now();
    let counts = Counts::with_budget(budget);
    let port = Counted { objects, counts: &counts };
    let packers = (concurrency / PACK_READERS).max(1);
    let mut carried = Carried::default();
    let work = |pack: Pack| pack_one(&port, from, to, PACK_READERS, pack);
    let settled = in_parallel(packers, packs, &|| counts.spent().is_some(), &work, |packing| {
        let requests = counts.requests.lock().map(|map| map.clone()).unwrap_or_default();
        let bytes = counts.bytes.lock().map(|map| map.clone()).unwrap_or_default();
        for line in &packing.proved {
            carried.proved += 1;
            carried.proved_bytes += line.byte_length;
            proved(line, &requests, &bytes);
        }
        carried.failed += packing.failed.len() as u64;
        let room = REPORTED_FAILURES.saturating_sub(carried.failures.len());
        carried.failures.extend(packing.failed.into_iter().take(room));
        Ok(())
    });
    if let Err(error) = settled {
        carried.failures.push(Failed { key: String::new(), why: error.to_string(), cause: error.cause() });
    }
    carried.budget_spent = counts.spent();
    carried.requests = counts.requests.into_inner().unwrap_or_default();
    carried.bytes = counts.bytes.into_inner().unwrap_or_default();
    carried.seconds = started.elapsed().as_secs_f64();
    carried
}

/// Records of one scope whose `origin` is `origin` (one walk of the scope).
fn count_naming<S: Storage + Send>(store: &RecordStore<S>, account: &str, scope: &str, origin: &str) -> Result<u64, AccountFilesError> {
    let mut after = String::new();
    let mut count = 0;
    loop {
        let page = store.list_page(account, scope, &after, MAX_PAGE_ITEMS)?;
        count += page.items.iter().filter(|record| record.value.get("origin").and_then(Value::as_str) == Some(origin)).count() as u64;
        match page.next {
            Some(next) => after = next,
            None => return Ok(count),
        }
    }
}

/// What the `from` store still holds, against the proof records: one listing walk of the store and one batch get of
/// proof records per listing page, then one walk of the chunk and file records.
pub fn audit<S: Storage + Send>(
    store: &RecordStore<S>,
    account: &str,
    objects: &(dyn Objects + Sync),
    from: &str,
    listed_so_far: ListingProgress<'_>,
) -> Result<Audit, AccountFilesError> {
    let moved = moved_scope(from);
    let mut audit = Audit { from: from.into(), ..Audit::default() };
    for page in listing_of(objects, from, listed_so_far)?.chunks(MAX_PAGE_ITEMS) {
        let keys: Vec<&str> = page.iter().map(|(key, _)| key.as_str()).collect();
        for ((key, length), proof) in page.iter().zip(store.get_many(account, &moved, &keys)?) {
            audit.listed += 1;
            audit.listed_bytes += length;
            // A proof counts only for the bytes it proved: an object rewritten at `from` since is not proved.
            if proof.is_some_and(|proof| proof.value.get("byte_length").and_then(Value::as_u64) == Some(*length)) {
                audit.proved += 1;
                audit.proved_bytes += length;
            } else {
                audit.unproved += 1;
                audit.unproved_bytes += length;
                if audit.unproved_keys.len() < REPORTED_UNPROVED {
                    audit.unproved_keys.push((key.clone(), *length));
                }
            }
        }
    }
    audit.records_naming_from = count_naming(store, account, CHUNKS, from)? + count_naming(store, account, FILES, from)?;
    audit.complete = audit.unproved == 0 && audit.records_naming_from == 0;
    Ok(audit)
}

/// Delete the `from` origin record once its audit is complete, so no read or write can reach that store again.
/// Refused while any listed key is unproved or any record names it.
pub fn retire<S: Storage + Send>(
    store: &mut RecordStore<S>,
    account: &str,
    objects: &(dyn Objects + Sync),
    from: &str,
    listed_so_far: ListingProgress<'_>,
) -> Result<Audit, AccountFilesError> {
    let audit = audit(store, account, objects, from, listed_so_far)?;
    if !audit.complete {
        return Err(AccountFilesError::Invalid("the from store still holds unproved keys or records still name it", crate::cause!()));
    }
    let record = store.get(account, ORIGINS, from)?.record.ok_or(AccountFilesError::Invalid("the account has no such from origin", crate::cause!()))?;
    let request_key = request_key(&["retire", from, &record.version.to_string()]);
    store.mutate(account, ORIGINS, Mutation { id: record.id, expected_version: record.version, request_key, deleted: true, value: Value::Null })?;
    Ok(audit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_failures_keep_original_words_and_the_producer_through_reports_packs_and_listing() {
        use super::super::objects::{Level, Stat};
        struct Denied { cause: Cause }
        impl Objects for Denied {
            fn set_control(&mut self, _: super::super::CallControl) {}
            fn read(&self, _: &str, _: &str, _: u64, _: u64) -> Result<Vec<u8>, ObjectError> {
                Err(ObjectError::Refused(401, self.cause.clone()))
            }
            fn write(&self, _: &str, _: &str, _: &[u8], _: &str) -> Result<(), ObjectError> { unreachable!() }
            fn write_stream(&self, _: &str, _: &str, _: Body<'_>, _: &str) -> Result<(), ObjectError> { unreachable!() }
            fn stat(&self, _: &str, _: &str) -> Result<Option<Stat>, ObjectError> { unreachable!() }
            fn list(&self, _: &str, _: &str, _: &str, _: usize) -> Result<Listing, ObjectError> { unreachable!() }
            fn list_level(&self, _: &str, _: &str, _: &str) -> Result<Option<Level>, ObjectError> {
                Err(ObjectError::Refused(401, self.cause.clone()))
            }
        }
        let producer = crate::cause!(moves_test store_denied_access);
        let objects = Denied { cause: producer.clone() };
        let key = || Carry { key: "private/account/object".into(), length: 1, media_type: "application/test".into(), identity: None };
        let report = carry_keys(&objects, Route { from: "from", to: "to", width: 1 }, None, vec![key()], |_, _, _| unreachable!());
        assert_eq!(report.failed, 1);
        assert_eq!(report.failures[0].why, "from: the store refused the request (HTTP 401): the key or a store spending cap; the whole run stops");
        assert_eq!(report.failures[0].cause, producer);
        let wire = serde_json::to_value(&report.failures[0]).unwrap();
        assert_eq!(wire["why"], report.failures[0].why);
        assert_eq!(wire["cause"], producer.id());
        assert!(!wire["cause"].as_str().unwrap().contains("private/account"));
        let counts = Counts::default();
        let port = Counted { objects: &objects, counts: &counts };
        let packed = pack_one(&port, "from", "to", 1, Pack { group: "private/account/".into(), members: vec![key(), Carry { key: "private/account/second".into(), ..key() }] });
        assert_eq!(packed.failed.len(), 2);
        assert!(packed.failed.iter().all(|failed| failed.cause == producer));
        assert_eq!(counts.spent_refusal().unwrap().cause(), producer);
        let error = listing_of(&objects, "from", &mut |_, _, _| {}).unwrap_err();
        assert_eq!(error.cause(), producer, "listing wraps its public words without replacing the origin");
        let counts = Counts::default();
        let wrong = crate::cause!(moves_test wrong_bytes);
        let error = tried::<()>(&counts, || Err(Refusal::Wrong("the old words".into(), wrong.clone()))).unwrap_err();
        assert_eq!(error.code, "the old words");
        assert_eq!(error.cause(), wrong);
    }


    #[test]
    fn identities_are_read_from_ids_and_keys() {
        let hex = "ab".repeat(32);
        assert_eq!(identity_hex(&format!("1f:{hex}")), Some(hex.clone()));
        assert_eq!(identity_hex("12:abc"), None);
        assert_eq!(key_identity(&format!("people/p/chunks/1f:{hex}")), Some(hex));
        assert_eq!(key_identity("people/p/record-history/a.jsonl"), None);
    }

    #[test]
    fn pieces_cover_an_object_in_bounded_reads() {
        assert_eq!(pieces(0), 0);
        assert_eq!(pieces(1), 1);
        assert_eq!(pieces(MAX_RANGE_BYTES), 1);
        assert_eq!(pieces(MAX_RANGE_BYTES + 1), 2);
    }
}
