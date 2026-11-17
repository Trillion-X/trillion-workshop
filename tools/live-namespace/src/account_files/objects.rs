// src/account_files/objects.rs
//
// Purpose: The one byte owner of the local account files route. It reads ranges of, and writes, objects in any
// S3-compatible object store, signed with AWS Signature V4. Which stores an account uses, in which order new bytes
// land, and which credential names each store reads are the account's own records (`@namespace/origins`, written by
// the migration from the app's origin settings); no vendor and no account is named in this code.
//
// Non-Negotiable Invariants:
// - A read is always a ranged GET (`Range: bytes=a-b`). A store that answers with anything but `206 Partial Content`
//   and the exact `Content-Range` asked for is refused before its body is read, so a store that ignores the range can
//   never stream a whole object (B2 egress costs money).
// - Credentials stay in their one home, the secrets vault (`Secrets`). The secret key never comes out: the
//   vault answers the SigV4 day key (HMAC-SHA256 of "AWS4" + secret over the day), the same locked-box contract the
//   hosted Worker signed with, and this module derives the rest of the signing chain from it. Plain facts (key id,
//   bucket, endpoint, region) are read from the vault by name. Derived key bytes live in `Zeroizing` buffers and are
//   never logged, never put in argv, never stored in a record.
// - This module deletes an object only when the byte release asks (`Objects::delete`, one DELETE of one exact key,
//   the old origin's `remove`, ports/account-files-byte-release.json): the release (`release.rs`) asks only for an
//   object nothing names any more, after its release row is claimed. Nothing else here sends a DELETE.
// - A write is a single PUT of the whole object with its SHA-256 payload hash, so the store verifies what it keeps.
//   A large object is streamed into that one PUT from a reader (`write_stream`), its SHA-256 known before the first
//   byte is sent; memory holds what the reader holds, never the object.
// - A listing walks keys in the store's own order from a key (`start-after`), one page of at most 1000 per request,
//   so a walk resumes from the last key it saw without an opaque token.
// - Every ranged read and every PUT of file bytes passes the caller's one byte check (`CallControl::admission`,
//   `source_reads.rs`) before any request is sent: a read with no byte check is refused, a metered read or write the
//   resident allowance cannot cover is refused, and what was observed is counted after. This port mints no share URL:
//   a share goes through the caller's grant-aware delivery owner, whose reads come back through this byte check.
//
// Key Concepts:
// - `Objects`: the byte port the account files reads and writes through (`S3Objects` on the Mac, an in-memory map in
//   tests).
// - `Origin`: one store record: its rank for new bytes, where new files are kept, and for each connection fact (key
//   id, secret, bucket, endpoint, region) either the account's chosen value or the vault name that holds it.
// - `Secrets`: the vault port (plain fact by name, SigV4 day key by name).
// - Transport: every request goes through the engine's one HTTP client (`crate::https`, reqwest over rustls), which keeps
//   a connection to a store for the next request and frames every answer; this module signs, bounds and reads.
//
// Security Considerations:
// - TLS 1.2 or newer with platform trust and hostname verification (`crate::https`). Plain http is refused for every
//   host but the loopback address (`127.0.0.1`, `::1`, `localhost`), whose bytes never leave the machine (a local
//   S3-compatible server under test); the client refuses it too.
// - What is sent is what was signed: a request URL the URL form would rewrite (a `.` or `..` key segment) is refused.
// - Response heads are bounded by the client's parser and bodies here; an error body is never echoed (a denial's is read
//   to at most `MAX_DENIAL_BYTES` for its `Code` and `Message`, nothing else), and a listing body is read to at most
//   `MAX_LISTING_BYTES`.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::https;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    collections::HashMap,
    io::Read,
    sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}},
    time::{Duration, Instant},
};
use url::Url;
use zeroize::Zeroizing;

/// The most bytes one ranged read may ask for (the contract's largest read is 256 KiB per span; a span read is cut to
/// the asked range, so one GET never exceeds what a caller asked).
pub const MAX_RANGE_BYTES: u64 = 32 * 1024 * 1024;
/// The most bytes a listing page's body may hold (1000 keys of at most 1024 bytes each, URL-encoded, with their XML).
const MAX_LISTING_BYTES: usize = 8 * 1024 * 1024;
/// The most keys one listing request asks for (the S3 API's own page bound).
pub const MAX_LISTING_KEYS: usize = 1000;
/// The most bytes of a denial's body read, and the most characters of its reason kept.
const MAX_DENIAL_BYTES: usize = 16 * 1024;
const MAX_DENIAL_CHARS: usize = 300;
/// The bound a reply wait has of its own; the call's total (`until`) is what ends it.
const REPLY_BOUND: Duration = Duration::from_secs(24 * 60 * 60);

/// Why a byte request did not answer.
#[derive(Debug)]
pub enum ObjectError {
    /// The origin is not a declared store row.
    UnknownOrigin(String, crate::refusal_cause::Cause),
    /// A value the origin names is not held in the vault (the name, never the value).
    NotHeld(String, crate::refusal_cause::Cause),
    /// The store answered with this HTTP status (403 wrong key, 404 no such object, 416 range past the end).
    Refused(u16, crate::refusal_cause::Cause),
    /// The store denied this account's access (HTTP 401 or 403), with the reason it gave: its error `Code` and
    /// `Message` (a revoked key, a missing capability, or a spending cap such as B2's cap on served bytes or Class B
    /// transaction cap), at most `MAX_DENIAL_CHARS`. Never a key or a secret: S3 stores do not echo them here.
    Denied(u16, String, crate::refusal_cause::Cause),
    /// The store answered a ranged read without honouring the exact range; the body was not read.
    RangeNotHonoured(crate::refusal_cause::Cause),
    /// New bytes were refused before anything was sent: the origin is a real store and this state folder is not the
    /// one it was bound to (the origin's id).
    NotBound(String, crate::refusal_cause::Cause),
    /// The request did not complete (DNS, TCP, TLS, timeout, malformed response).
    Unavailable(String, crate::refusal_cause::Cause),
}
impl ObjectError {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::UnknownOrigin(_, cause) | Self::NotHeld(_, cause) | Self::Refused(_, cause)
            | Self::NotBound(_, cause) | Self::Unavailable(_, cause) | Self::Denied(_, _, cause)
            | Self::RangeNotHonoured(cause) => cause,
        }
    }
}
crate::impl_caused!(ObjectError);

impl fmt::Display for ObjectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownOrigin(origin, _) => write!(f, "no store row for origin {origin}"),
            Self::NotHeld(name, _) => write!(f, "no value is held under {name}"),
            Self::Refused(status, _) => write!(f, "the store refused the request (HTTP {status})"),
            Self::Denied(status, why, _) => write!(f, "the store denied access (HTTP {status}: {why})"),
            Self::RangeNotHonoured(_) => f.write_str("the store did not honour the asked byte range"),
            Self::NotBound(origin, _) => write!(f, "store {origin} is not bound to this account files; bind it on purpose (the engine's account-files-bind subcommand) before it takes new bytes here"),
            Self::Unavailable(why, _) => write!(f, "the store did not answer: {why}"),
        }
    }
}
impl std::error::Error for ObjectError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// The byte port of the account files (`Send`: the account files is served from the MCP server's blocking workers).
pub trait Objects: Send + Sync {
    /// Install the caller's transient call check and its byte check. Every
    /// port takes it (no default): a port that sends requests asks the
    /// admission before each read or write; a stand-in may only keep it.
    fn set_control(&mut self, control: super::CallControl);
    /// `length` bytes of `key` at `origin`, from `offset` (a ranged read; `length` >= 1).
    fn read(&self, origin: &str, key: &str, offset: u64, length: u64) -> Result<Vec<u8>, ObjectError>;
    /// A verifier's range, including proof that this response came from a physical object of exactly `total` bytes.
    /// A prior HEAD is insufficient: the object may change before GET. Ports without an atomic size witness refuse;
    /// ordinary reads keep their existing contract. S3 checks the actual GET's Content-Range total.
    fn read_verified(&self, _: &str, _: &str, _: u64, _: u64, _: u64) -> Result<Vec<u8>, ObjectError> {
        Err(ObjectError::Unavailable("physical object length proof is unavailable".into(), crate::cause!()))
    }
    /// Keep `bytes` as the whole object `key` at `origin`.
    fn write(&self, origin: &str, key: &str, bytes: &[u8], media_type: &str) -> Result<(), ObjectError>;
    /// Keep the whole object `key` at `origin` from a reader of exactly `body.length` bytes whose SHA-256 is
    /// `body.sha256` (one PUT; a reader that ends early or a store that refuses leaves nothing kept).
    fn write_stream(&self, origin: &str, key: &str, body: Body<'_>, media_type: &str) -> Result<(), ObjectError>;
    /// The size and media type of `key` at `origin`, or None when the store holds no such object (one HEAD).
    fn stat(&self, origin: &str, key: &str) -> Result<Option<Stat>, ObjectError>;
    /// Up to `limit` (at most `MAX_LISTING_KEYS`) keys under `prefix` at `origin`, in the store's key order,
    /// strictly after `after` (one list request).
    fn list(&self, origin: &str, prefix: &str, after: &str, limit: usize) -> Result<Listing, ObjectError>;
    /// One page of the level of `prefix` at `origin` (one list request with the `/` delimiter): the keys directly
    /// under it and the prefixes one `/` deeper, from the continuation `token` of the page before ("" for the first).
    /// None when this port cannot list by level; callers then walk the flat listing.
    fn list_level(&self, origin: &str, prefix: &str, token: &str) -> Result<Option<Level>, ObjectError> {
        let _ = (origin, prefix, token);
        Ok(None)
    }
    /// One page of every key under `prefix` at `origin` (no delimiter), from the continuation `token` of the page
    /// before ("" for the first): the store's own cursor, so the walk follows the store's order exactly (R2 was seen to
    /// order a key after a longer key it prefixes, which a `start-after` walk then answered twice). None when this
    /// port cannot page by token.
    fn list_flat(&self, origin: &str, prefix: &str, token: &str) -> Result<Option<Level>, ObjectError> {
        let _ = (origin, prefix, token);
        Ok(None)
    }
    /// Remove the object `key` at `origin` (one DELETE; a store that holds no such object has nothing left to remove,
    /// which is done too). Only the byte release (`release.rs`) asks, for a claimed release row. A port that cannot
    /// remove refuses, so the row stays claimed and is tried again when its claim goes stale.
    fn delete(&self, origin: &str, key: &str) -> Result<(), ObjectError> {
        let _ = (origin, key);
        Err(ObjectError::Unavailable("this byte port removes nothing".into(), crate::cause!()))
    }
}

/// The bytes of one PUT: how many, their SHA-256 (signed into the request, so the store checks what it receives),
/// and the reader they come from.
pub struct Body<'a> {
    pub length: u64,
    pub sha256: [u8; 32],
    pub bytes: &'a mut dyn Read,
}

/// One object as a store describes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stat {
    pub length: u64,
    pub media_type: Option<String>,
}

/// One page of a store's keys.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Listing {
    /// Each key and its size, in the store's key order.
    pub objects: Vec<(String, u64)>,
    /// The store has more keys after the last one here.
    pub more: bool,
}

/// One page of one level of a store's keys.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Level {
    /// Each key directly under the prefix (no further `/`) and its size, in the store's key order.
    pub objects: Vec<(String, u64)>,
    /// The prefixes one `/` deeper (each ends in `/`), in the store's key order.
    pub prefixes: Vec<String>,
    /// The continuation token of the next page of this level, when there is one.
    pub next: Option<String>,
}

/// One S3-compatible store, as the account's `@namespace/origins` record holds it (record id = the `origin` a file
/// or chunk record names). The account's own choice of stores (rank, endpoint, region, landing bucket) is migrated
/// from the app's origin settings; what the access key opens is named as credentials.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Origin {
    /// Always `namespace-origin`.
    pub kind: String,
    /// New bytes go to the lowest rank whose store accepts them.
    pub rank: u32,
    /// Whether new bytes may land here. A store being emptied (its bytes moving to another) still
    /// answers reads of what it holds and takes nothing new. Records written before the field existed take
    /// new bytes.
    #[serde(default = "takes_new_bytes")]
    pub takes_new_bytes: bool,
    /// Where a new whole file's object is kept in this store: this prefix, then the file's identity.
    pub file_key_prefix: String,
    /// Where each connection fact comes from.
    pub reach: Reach,
    /// The binding of the account files this store was bound to on purpose (`bind::tie` of the account files' own binding
    /// in `@namespace/home` and the account; set by `account-files-bind`, src/account_files/bind.rs). An account's files that does
    /// not hold that binding for this account may not put new bytes in a store that is not on this computer's
    /// loopback. The binding lives inside the account files, so a copy or restore of the account's folder keeps it. No
    /// binding means no account files may.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_to: Option<String>,
}
impl Origin {
    /// Whether the store is on this computer's loopback (a plain endpoint value naming `127.0.0.1`, `::1` or
    /// `localhost`). An endpoint held in the vault, or one that does not parse, is not known to be loopback.
    pub fn is_loopback(&self) -> bool {
        let Source::Value(endpoint) = &self.reach.endpoint else { return false };
        let Ok(endpoint) = url::Url::parse(endpoint) else { return false };
        matches!(endpoint.host(), Some(url::Host::Domain("localhost")))
            || matches!(endpoint.host(), Some(url::Host::Ipv4(address)) if address.is_loopback())
            || matches!(endpoint.host(), Some(url::Host::Ipv6(address)) if address.is_loopback())
    }
}

fn takes_new_bytes() -> bool {
    true
}

/// The connection facts of a store, each either a plain value or a credential name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reach {
    pub key_id: Source,
    pub secret: Source,
    pub bucket: Source,
    pub endpoint: Source,
    pub region: Source,
}

/// One connection fact: a value the account chose, or the name the vault holds it under.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Source {
    Value(String),
    Held(String),
}

/// The secrets vault, as the byte owner needs it. A secret never leaves it. `Send + Sync`: the byte owner is
/// shared by the MCP server's blocking workers.
pub trait Secrets: Send + Sync {
    /// A plain connection fact held under `name` (a key id, bucket, endpoint or region).
    fn plain(&self, name: &str) -> Result<Zeroizing<String>, ObjectError>;
    /// The SigV4 day key of the secret held under `name`: HMAC-SHA256(key = "AWS4" + secret, data = `day`
    /// (YYYYMMDD)).
    fn sigv4_day_key(&self, name: &str, day: &str) -> Result<Zeroizing<Vec<u8>>, ObjectError>;
    /// Whether a value is held under `name` (no value is read).
    fn holds(&self, name: &str) -> Result<bool, ObjectError>;
}

/// The resolved connection facts of one origin for one request (the secret stays in the vault).
struct Connection {
    key_id: Zeroizing<String>,
    /// Where the secret is held: its day key is asked for when a request is signed.
    secret: Source,
    bucket: String,
    endpoint: Url,
    region: String,
}

/// Each origin's signing key and the day it signs for.
type SigningKeys = Mutex<HashMap<String, (String, Zeroizing<Vec<u8>>)>>;
/// A response's status, its headers (lowercase names) and the reader of its body.
type Response = (u16, Vec<(String, String)>, Reply);

/// A range attempt's progress. Unlike returned bytes, body bytes count as the client yields them, before a post-I/O
/// withdrawal can withhold their answer; the client parses the head, so response headers are never mistaken for source
/// file bytes.
#[derive(Default)]
struct ReadProgress {
    request_started: AtomicBool,
    body_bytes: AtomicU64,
    head_complete: AtomicBool,
    status: AtomicU64,
}
impl ReadProgress {
    fn observation(&self, bytes_returned: u64, outcome: super::source_reads::ReadOutcome) -> super::source_reads::SourceReadObservation {
        super::source_reads::SourceReadObservation {
            request_started: self.request_started.load(Ordering::Acquire),
            response_status: self.head_complete.load(Ordering::Acquire).then(|| self.status.load(Ordering::Acquire) as u16),
            source_body_bytes_observed: self.head_complete.load(Ordering::Acquire).then(|| self.body_bytes.load(Ordering::Acquire)),
            bytes_returned,
            outcome,
        }
    }
}

/// Objects in S3-compatible stores, signed through the secrets vault.
pub struct S3Objects {
    origins: Vec<(String, Origin)>,
    vault: Box<dyn Secrets>,
    /// The engine's one HTTP client (its connections to stores are kept and shared by every call in this process).
    client: https::Client,
    /// Each origin's connection facts, read from the vault once (the vault mints a handle per read and limits how
    /// many it mints).
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    /// Each origin's signing key for one day: the vault's day key is asked once per origin per day.
    signing: SigningKeys,
    control: super::CallControl,
    /// The named unmetered byte check of an operator tool or stand-in test (`S3Objects::unmetered`), used while the
    /// caller's control names none. None for the account files' own port, which then refuses every read.
    unmetered: Option<super::source_reads::Admission>,
}

impl S3Objects {
    /// Stores of the account's origin records, signed through `vault`, admitted only by the caller's control.
    pub(super) fn new(origins: Vec<(String, Origin)>, vault: Box<dyn Secrets>) -> Result<Self, ObjectError> {
        let client = https::Client::verified()
            .map_err(|error| ObjectError::Unavailable(format!("TLS verifier unavailable: {error}"), crate::cause!()))?;
        Ok(Self { origins, vault, client, connections: Mutex::default(), signing: Mutex::default(),
            control: super::CallControl::default(), unmetered: None })
    }

    /// The same stores read and written with no allowance, for an operator tool or a stand-in test that truly needs
    /// it and says why (`reason`, counted under its own name). Every unmetered reader is found by this name.
    pub fn unmetered(origins: Vec<(String, Origin)>, vault: Box<dyn Secrets>, reason: &'static str) -> Result<Self, ObjectError> {
        Ok(Self { unmetered: Some(super::source_reads::Unmetered::new(reason).into()), ..Self::new(origins, vault)? })
    }

    /// The byte check of this request: the caller's, or this port's named unmetered one while the caller names none.
    fn admission(&self) -> &super::source_reads::Admission {
        match &self.unmetered {
            Some(unmetered) if self.control.admission().is_none() => unmetered,
            _ => self.control.admission(),
        }
    }


    fn origin(&self, id: &str) -> Result<&Origin, ObjectError> {
        self.origins.iter().find(|(origin, _)| origin == id).map(|(_, row)| row).ok_or_else(|| ObjectError::UnknownOrigin(id.into(), crate::cause!()))
    }

    /// Whether the vault holds every value an origin names (no value is read).
    pub fn has_credentials(&self, origin: &str) -> Result<bool, ObjectError> {
        let reach = &self.origin(origin)?.reach;
        let mut all = true;
        for source in [&reach.key_id, &reach.secret, &reach.bucket, &reach.endpoint, &reach.region] {
            if let Source::Held(name) = source {
                all &= self.vault.holds(name)?;
            }
        }
        Ok(all)
    }

    fn fact(&self, source: &Source) -> Result<Zeroizing<String>, ObjectError> {
        match source {
            Source::Value(value) => Ok(Zeroizing::new(value.clone())),
            Source::Held(name) => self.vault.plain(name),
        }
    }

    /// The SigV4 signing key of a request day: the vault's day key, then region, service and terminator; asked of
    /// the vault once per origin per day.
    fn signing_key(&self, origin: &str, connection: &Connection, day: &str) -> Result<Zeroizing<Vec<u8>>, ObjectError> {
        let mut signing = self.signing.lock().map_err(|_| ObjectError::Unavailable("signing keys poisoned".into(), crate::cause!()))?;
        if let Some((held_day, key)) = signing.get(origin) {
            if held_day == day {
                return Ok(key.clone());
            }
        }
        let mut key = match &connection.secret {
            Source::Held(name) => self.vault.sigv4_day_key(name, day)?,
            Source::Value(_) => return Err(ObjectError::NotHeld("a secret must be held in the vault".into(), crate::cause!())),
        };
        for part in [connection.region.as_str(), "s3", "aws4_request"] {
            *key = hmac(&key, part.as_bytes());
        }
        signing.insert(origin.to_owned(), (day.to_owned(), key.clone()));
        Ok(key)
    }

    /// An origin's connection facts, read from the vault on first use and kept for the life of this byte owner.
    fn connection(&self, origin: &str) -> Result<Arc<Connection>, ObjectError> {
        let mut connections = self.connections.lock().map_err(|_| ObjectError::Unavailable("connections poisoned".into(), crate::cause!()))?;
        if let Some(connection) = connections.get(origin) {
            return Ok(connection.clone());
        }
        let reach = &self.origin(origin)?.reach;
        let endpoint = self.fact(&reach.endpoint)?;
        let endpoint = Url::parse(&endpoint).map_err(|_| ObjectError::Unavailable("the endpoint is not a URL".into(), crate::cause!()))?;
        let loopback = matches!(endpoint.host(), Some(url::Host::Domain("localhost")))
            || matches!(endpoint.host(), Some(url::Host::Ipv4(address)) if address.is_loopback())
            || matches!(endpoint.host(), Some(url::Host::Ipv6(address)) if address.is_loopback());
        if !(endpoint.scheme() == "https" || endpoint.scheme() == "http" && loopback) || endpoint.host_str().is_none() {
            return Err(ObjectError::Unavailable("the endpoint is not an https URL (plain http only on loopback)".into(), crate::cause!()));
        }
        let connection = Arc::new(Connection {
            key_id: self.fact(&reach.key_id)?,
            secret: reach.secret.clone(),
            bucket: self.fact(&reach.bucket)?.to_string(),
            endpoint,
            region: self.fact(&reach.region)?.to_string(),
        });
        connections.insert(origin.to_owned(), connection.clone());
        Ok(connection)
    }

    /// One signed request; answers the status, the response headers and the reader of its body. `query` is signed in
    /// canonical order; the body's SHA-256 is signed before its first byte is sent.
    fn send(
        &self,
        origin: &str,
        method: &str,
        key: &str,
        query: &[(&str, &str)],
        extra: &[(&str, String)],
        body: Body<'_>,
    ) -> Result<Response, ObjectError> {
        self.send_observed(origin, method, key, query, extra, body, None)
    }

    /// The same request with transport facts for an already-reserved range attempt. No object key, credential or private
    /// response text is observed. While the body is sent, each part waits at most the call's idle bound for the store to
    /// take the parts before it; once it is all sent, the answer (head and body) is bounded by the call's total, since a
    /// store may take longer than one idle bound to commit a body it has read. The call's check runs between reads, so a
    /// withdrawn call sends and takes no further byte; a completed PUT may already exist remotely when a later check
    /// refuses.
    #[allow(clippy::too_many_arguments)]
    fn send_observed(
        &self, origin: &str, method: &str, key: &str, query: &[(&str, &str)],
        extra: &[(&str, String)], body: Body<'_>, progress: Option<Arc<ReadProgress>>,
    ) -> Result<Response, ObjectError> {
        self.control.timeout(self.control.idle())?;
        let connection = self.connection(origin)?;
        let (authority, path) = address_of(&connection, key)?;
        let mut pairs: Vec<(String, String)> = query.iter().map(|(name, value)| (encode_segment(name), encode_segment(value))).collect();
        pairs.sort();
        let canonical_query = pairs.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("&");
        let url = request_url(&connection, &authority, &path, &canonical_query)?;
        let now = chrono::Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let day = now.format("%Y%m%d").to_string();
        let payload_hash = hex(&body.sha256);
        let canonical_request = format!(
            "{method}\n{path}\n{canonical_query}\nhost:{authority}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n\nhost;x-amz-content-sha256;x-amz-date\n{payload_hash}"
        );
        let scope = format!("{day}/{}/s3/aws4_request", connection.region);
        let to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hex(&Sha256::digest(canonical_request.as_bytes())));
        let signing = self.signing_key(origin, &connection, &day)?;
        let signature = hex(&hmac(&signing, to_sign.as_bytes()));
        let authorization = Zeroizing::new(format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={signature}",
            connection.key_id.as_str()
        ));
        // The client writes `Host` (the URL's authority, which is what was signed), `Content-Length` and the framing.
        let mut headers = vec![("x-amz-content-sha256", payload_hash.as_str()), ("x-amz-date", amz_date.as_str()), ("authorization", authorization.as_str())];
        headers.extend(extra.iter().map(|(name, value)| (*name, value.as_str())));
        let stall = self.control.timeout(self.control.idle())?;
        let deadline = Instant::now() + self.control.timeout(REPLY_BOUND)?;
        if let Some(progress) = &progress {
            progress.request_started.store(true, Ordering::Release);
        }
        let mut bytes = Checked { bytes: body.bytes, control: &self.control };
        let opened = self.client.open_uploading(
            &https::Ask { method, url: &url, headers: &headers, body: &[] },
            https::Upload { length: body.length, reader: &mut bytes },
            stall,
            deadline,
        ).map_err(|error| self.failed("send", error))?;
        if let Some(progress) = &progress {
            progress.status.store(opened.status as u64, Ordering::Release);
            progress.head_complete.store(true, Ordering::Release);
        }
        Ok((opened.status, opened.headers, Reply { body: opened.body, control: self.control.clone(), progress }))
    }

    /// A transport failure as this port answers it: the call's own stop when the call is withdrawn or past its total
    /// (the stop is why the request ended), otherwise the failure itself.
    #[track_caller]
    fn failed(&self, step: &str, error: std::io::Error) -> ObjectError {
        match self.control.timeout(REPLY_BOUND) {
            Err(stopped) => stopped,
            Ok(_) => ObjectError::Unavailable(format!("{step}: {error}"), crate::cause!(caller_site: ObjectError::Unavailable)),
        }
    }
}

/// The authority (the host, and the port when it is not the scheme's default) and path-style request path
/// (`/<bucket>/<key>`, each segment SigV4-encoded) of `key` in a connection's store.
fn address_of(connection: &Connection, key: &str) -> Result<(String, String), ObjectError> {
    let host = connection.endpoint.host_str().ok_or_else(|| ObjectError::Unavailable("endpoint host".into(), crate::cause!()))?.to_owned();
    let port = connection.endpoint.port_or_known_default().unwrap_or(443);
    let default_port = if connection.endpoint.scheme() == "https" { 443 } else { 80 };
    let authority = if port == default_port { host } else { format!("{host}:{port}") };
    let mut path = format!("/{}", encode_segment(&connection.bucket));
    if !key.is_empty() {
        path.push('/');
        path.push_str(&key.split('/').map(encode_segment).collect::<Vec<_>>().join("/"));
    }
    Ok((authority, path))
}

/// The URL of one request: the endpoint's scheme, the signed authority, path and canonical query. Refused when the URL
/// form would send other than what was signed (it removes a `.` or `..` path segment): the store would answer a key
/// nobody asked for, or refuse the signature.
fn request_url(connection: &Connection, authority: &str, path: &str, query: &str) -> Result<Url, ObjectError> {
    let target = if query.is_empty() { path.to_owned() } else { format!("{path}?{query}") };
    let url = Url::parse(&format!("{}://{authority}{target}", connection.endpoint.scheme()))
        .map_err(|_| ObjectError::Unavailable("the request is not a URL".into(), crate::cause!()))?;
    if url.path() != path || url.query().unwrap_or("") != query {
        return Err(ObjectError::Unavailable("a key the request URL cannot carry as signed".into(), crate::cause!()));
    }
    Ok(url)
}

/// The longest a share may stay valid (seven days, the SigV4 signature's own limit, kept by the delivery owner).
pub const MOST_SHARE_SECONDS: u64 = 7 * 24 * 60 * 60;

/// The call's check as an I/O answer: the time left before the call's total (at most `bound`), or the call's stop
/// ("account files call stopped") with the stop's own cause.
fn call_open(control: &super::CallControl, bound: Duration) -> std::io::Result<Duration> {
    crate::io_operation!(control.timeout(bound).map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "account files call stopped"), _refusal_io_cause) }))
}

/// A request body as it is sent: the call is checked before each read, so a withdrawn or overdue call sends no further
/// byte.
struct Checked<'a> {
    bytes: &'a mut dyn Read,
    control: &'a super::CallControl,
}
impl Read for Checked<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        crate::io_operation!(call_open(self.control, self.control.idle()))?;
        crate::io_operation!(self.bytes.read(bytes))
    }
}

/// An answer's body as this port reads it: the call is checked before and after each read (a withdrawn or overdue call
/// takes no further byte), and every byte the client yields counts as observed for a ranged read's byte check, before
/// a later check can withhold it.
struct Reply {
    body: https::Body,
    control: super::CallControl,
    progress: Option<Arc<ReadProgress>>,
}
impl Read for Reply {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        crate::io_operation!(call_open(&self.control, REPLY_BOUND))?;
        let read = crate::io_operation!(self.body.read(bytes))?;
        if let Some(progress) = &self.progress { progress.body_bytes.fetch_add(read as u64, Ordering::AcqRel); }
        crate::io_operation!(call_open(&self.control, REPLY_BOUND))?;
        Ok(read)
    }
}

/// The body of a request that sends none.
fn no_body(empty: &mut std::io::Empty) -> Body<'_> {
    Body { length: 0, sha256: Sha256::digest([]).into(), bytes: empty }
}

impl Objects for S3Objects {
    fn set_control(&mut self, control: super::CallControl) { self.control = control; }
    fn read(&self, origin: &str, key: &str, offset: u64, length: u64) -> Result<Vec<u8>, ObjectError> {
        self.read_controlled(origin, key, offset, length, None)
    }
    fn read_verified(&self, origin: &str, key: &str, offset: u64, length: u64, total: u64) -> Result<Vec<u8>, ObjectError> {
        self.read_controlled(origin, key, offset, length, Some(total))
    }

    fn write(&self, origin: &str, key: &str, bytes: &[u8], media_type: &str) -> Result<(), ObjectError> {
        let mut reader = bytes;
        self.write_stream(origin, key, Body { length: bytes.len() as u64, sha256: Sha256::digest(bytes).into(), bytes: &mut reader }, media_type)
    }

    fn write_stream(&self, origin: &str, key: &str, body: Body<'_>, media_type: &str) -> Result<(), ObjectError> {
        // Refused here, before any request, when a metered allowance cannot cover the whole body.
        let (admission, length) = (self.admission(), body.length);
        admission.admit_write(length)?;
        let sent = self.send(origin, "PUT", key, &[], &[("Content-Type", media_type.to_owned())], body);
        admission.wrote(length);
        let (status, _, mut answer) = sent?;
        if status != 200 {
            return Err(refusal(status, &mut answer));
        }
        Ok(())
    }

    fn stat(&self, origin: &str, key: &str) -> Result<Option<Stat>, ObjectError> {
        // Asked and counted like every other store request: refused here, before any request, with no byte check.
        use super::source_reads::Lookup;
        let admission = self.admission();
        admission.admit_lookup(Lookup::Stat, 0)?;
        let sent = self.send(origin, "HEAD", key, &[], &[], no_body(&mut std::io::empty()));
        // A HEAD answer carries no body: nothing to count but the request.
        admission.looked_up(Lookup::Stat, 0, Some(0));
        let (status, headers, _) = sent?;
        match status {
            200 => {
                // A size witness has exactly one length. Conflicting or duplicate lengths cannot prove an empty
                // object; a transfer-coded HEAD is likewise not this port's fixed-length object contract.
                if headers.iter().filter(|(name, _)| name == "content-length").count() != 1
                    || header(&headers, "transfer-encoding").is_some() {
                    return Err(crate::cause!(ObjectError::RangeNotHonoured));
                }
                let length = header(&headers, "content-length").and_then(|value| value.parse().ok())
                    .ok_or_else(|| ObjectError::Unavailable("a HEAD answer without its length".into(), crate::cause!()))?;
                Ok(Some(Stat { length, media_type: header(&headers, "content-type").map(str::to_owned) }))
            }
            404 => Ok(None),
            // A HEAD answer has no body, so no reason.
            401 | 403 => Err(ObjectError::Denied(status, "no reason in a HEAD answer".into(), crate::cause!())),
            other => Err(ObjectError::Refused(other, crate::cause!())),
        }
    }

    fn list(&self, origin: &str, prefix: &str, after: &str, limit: usize) -> Result<Listing, ObjectError> {
        parse_listing(&self.list_request(origin, limit, &[("prefix", prefix), ("start-after", after)])?)
    }

    fn list_level(&self, origin: &str, prefix: &str, token: &str) -> Result<Option<Level>, ObjectError> {
        self.list_by_token(origin, prefix, "/", token).map(Some)
    }

    fn list_flat(&self, origin: &str, prefix: &str, token: &str) -> Result<Option<Level>, ObjectError> {
        self.list_by_token(origin, prefix, "", token).map(Some)
    }

    /// One signed DELETE of `key` (the old origin's `remove`, ports/account-files-byte-release.json). S3 answers 204 for a
    /// removed key and for one it never held; 200 is accepted too. A refusal's reason is read as for any other request.
    fn delete(&self, origin: &str, key: &str) -> Result<(), ObjectError> {
        if key.is_empty() {
            return Err(ObjectError::Unavailable("a removal names one exact key".into(), crate::cause!()));
        }
        let (status, _, mut answer) = self.send(origin, "DELETE", key, &[], &[], no_body(&mut std::io::empty()))?;
        match status {
            200 | 204 | 404 => Ok(()),
            _ => Err(refusal(status, &mut answer)),
        }
    }
}

impl S3Objects {
    /// The same control and byte admission for ordinary and complete-object-witness reads. Only the verifier asks
    /// for the physical total; it is checked on the GET response, never inferred from an earlier HEAD.
    fn read_controlled(&self, origin: &str, key: &str, offset: u64, length: u64, total: Option<u64>) -> Result<Vec<u8>, ObjectError> {
        if length == 0 || length > MAX_RANGE_BYTES {
            return Err(ObjectError::Unavailable("a ranged read asks for 1 byte up to its bound".into(), crate::cause!()));
        }
        let last = offset.checked_add(length - 1)
            .ok_or_else(|| ObjectError::Unavailable("a ranged read exceeds its offset bound".into(), crate::cause!()))?;
        if total.is_some_and(|total| last >= total) { return Err(crate::cause!(ObjectError::RangeNotHonoured)); }
        self.control.timeout(self.control.idle())?;
        // Refused here, before any request, when there is no byte check or its allowance cannot cover the range.
        let admission = self.admission();
        admission.admit_read(&super::source_reads::SourceRead { origin: origin.to_owned(), offset, requested_bytes: length })?;
        let progress = Arc::new(ReadProgress::default());
        let result = self.read_reserved(origin, key, offset, last, progress.clone(), total);
        use super::source_reads::ReadOutcome;
        let outcome = match &result {
            Ok(_) => ReadOutcome::Complete,
            Err(_) if self.control.check().is_err() => ReadOutcome::Interrupted,
            Err(ObjectError::Refused(_, _) | ObjectError::Denied(_, _, _)) => ReadOutcome::Refused,
            Err(ObjectError::RangeNotHonoured(_)) => ReadOutcome::RangeNotHonoured,
            Err(_) => ReadOutcome::Incomplete,
        };
        admission.observed_read(&progress.observation(result.as_ref().map_or(0, |bytes| bytes.len() as u64), outcome));
        result
    }

    fn read_reserved(&self, origin: &str, key: &str, offset: u64, last: u64, progress: Arc<ReadProgress>, total: Option<u64>) -> Result<Vec<u8>, ObjectError> {
        let (status, headers, mut body) =
            self.send_observed(origin, "GET", key, &[], &[("range", format!("bytes={offset}-{last}"))], no_body(&mut std::io::empty()), Some(progress))?;
        if status != 206 {
            // Never read a body that is not the asked range: a 200 would be the whole object.
            return Err(if status == 200 { crate::cause!(ObjectError::RangeNotHonoured) } else { refusal(status, &mut body) });
        }
        let range = header(&headers, "content-range").ok_or(crate::cause!(ObjectError::RangeNotHonoured))?;
        let (from, to) = content_range(range).ok_or(crate::cause!(ObjectError::RangeNotHonoured))?;
        if total.is_some_and(|expected| range.split_once('/').and_then(|(_, total)| total.parse::<u64>().ok()) != Some(expected) || to != last) {
            return Err(crate::cause!(ObjectError::RangeNotHonoured));
        }
        // A range past the object's end is cut by the store to its last byte; anything else is not the asked range.
        if from != offset || to > last || to < from {
            return Err(crate::cause!(ObjectError::RangeNotHonoured));
        }
        let expected = to - from + 1;
        let declared: u64 = header(&headers, "content-length").and_then(|value| value.parse().ok()).ok_or(crate::cause!(ObjectError::RangeNotHonoured))?;
        if declared != expected || header(&headers, "transfer-encoding").is_some()
            || headers.iter().filter(|(name, _)| name == "content-length").count() != 1
            || headers.iter().filter(|(name, _)| name == "content-range").count() != 1 {
            return Err(crate::cause!(ObjectError::RangeNotHonoured));
        }
        // The client frames the body by its one `Content-Length`, so it yields exactly the declared bytes and then its end.
        let mut bytes = vec![0u8; expected as usize];
        body.read_exact(&mut bytes).map_err(|error| ObjectError::Unavailable(format!("body: {error}"), crate::cause!()))?;
        let past = body.read(&mut [0u8; 1]).map_err(|error| ObjectError::Unavailable(format!("body: {error}"), crate::cause!()))?;
        if past != 0 {
            return Err(crate::cause!(ObjectError::RangeNotHonoured));
        }
        Ok(bytes)
    }

    /// One page under `prefix` from the continuation `token`, by level when `delimiter` is "/" (keys directly under
    /// the prefix and the prefixes one level deeper) or flat when it is "".
    fn list_by_token(&self, origin: &str, prefix: &str, delimiter: &str, token: &str) -> Result<Level, ObjectError> {
        let xml = self.list_request(origin, MAX_LISTING_KEYS, &[("prefix", prefix), ("delimiter", delimiter), ("continuation-token", token)])?;
        let listing = parse_listing(&xml)?;
        let url_encoded = element(&xml, "EncodingType").is_some_and(|coding| coding == "url");
        let mut prefixes = Vec::new();
        let mut rest = xml.as_str();
        while let Some(start) = rest.find("<CommonPrefixes>") {
            let end = rest[start..].find("</CommonPrefixes>").ok_or_else(|| ObjectError::Unavailable("malformed listing".into(), crate::cause!()))? + start;
            let deeper = unescape_xml(element(&rest[start..end], "Prefix").ok_or_else(|| ObjectError::Unavailable("malformed listing".into(), crate::cause!()))?);
            prefixes.push(if url_encoded { percent_decode(&deeper).ok_or_else(|| ObjectError::Unavailable("malformed listing".into(), crate::cause!()))? } else { deeper });
            rest = &rest[end..];
        }
        // A truncated page without a token cannot be continued: refused rather than read as the level's end.
        let next = match (listing.more, element(&xml, "NextContinuationToken")) {
            (true, Some(token)) => Some(unescape_xml(token)),
            (true, None) => return Err(ObjectError::Unavailable("a truncated listing without a continuation token".into(), crate::cause!())),
            (false, _) => None,
        };
        Ok(Level { objects: listing.objects, prefixes, next })
    }

    /// One `list-type=2` request (URL-encoded keys, `limit` keys, at most `MAX_LISTING_KEYS`) with the non-empty of
    /// `extra` query pairs; answers the page's XML.
    fn list_request(&self, origin: &str, limit: usize, extra: &[(&str, &str)]) -> Result<String, ObjectError> {
        let limit = limit.clamp(1, MAX_LISTING_KEYS).to_string();
        let mut query = vec![("list-type", "2"), ("encoding-type", "url"), ("max-keys", limit.as_str())];
        query.extend(extra.iter().filter(|(_, value)| !value.is_empty()));
        // Asked before the request (refused with no byte check; a metered allowance takes the listing's bound) and
        // counted after with the body bytes the answer carried; an answer that did not end keeps the whole bound.
        use super::source_reads::Lookup;
        let (admission, bound) = (self.admission(), MAX_LISTING_BYTES as u64);
        admission.admit_lookup(Lookup::List, bound)?;
        let answer = self.send(origin, "GET", "", &query, &[], no_body(&mut std::io::empty())).and_then(|(status, _, mut body)| {
            if status != 200 {
                return Err(refusal(status, &mut body));
            }
            read_body(&mut body, MAX_LISTING_BYTES)
        });
        let observed = match &answer {
            Ok(xml) => Some(xml.len() as u64),
            Err(ObjectError::Refused(_, _)) => Some(0),
            Err(ObjectError::Denied(_, _, _)) => Some(MAX_DENIAL_BYTES as u64),
            Err(_) => None,
        };
        admission.looked_up(Lookup::List, bound, observed);
        let xml = answer?;
        String::from_utf8(xml).map_err(|_| ObjectError::Unavailable("a listing that is not UTF-8".into(), crate::cause!()))
    }
}

/// Why the store refused: for a 401 or 403, the `Code` and `Message` of its error body (S3 XML), so a revoked key and
/// a spending cap can be told apart; any other status alone, its body never read.
#[track_caller]
fn refusal(status: u16, body: &mut dyn Read) -> ObjectError {
    if !matches!(status, 401 | 403) {
        return ObjectError::Refused(status, crate::cause!(caller_site: ObjectError::Refused));
    }
    let text = read_body(body, MAX_DENIAL_BYTES).ok().and_then(|bytes| String::from_utf8(bytes).ok()).unwrap_or_default();
    let reason = [element(&text, "Code"), element(&text, "Message")].into_iter().flatten().map(unescape_xml).collect::<Vec<_>>().join(": ");
    let reason = if reason.is_empty() { "no reason given".to_owned() } else { reason.chars().take(MAX_DENIAL_CHARS).collect() };
    ObjectError::Denied(status, reason, crate::cause!(caller_site: ObjectError::Denied))
}

/// A response body as the client frames it, refused past `max` bytes (never cut short).
fn read_body(body: &mut dyn Read, max: usize) -> Result<Vec<u8>, ObjectError> {
    let mut bytes = Vec::new();
    body.take(max as u64 + 1).read_to_end(&mut bytes).map_err(|error| ObjectError::Unavailable(format!("body: {error}"), crate::cause!()))?;
    if bytes.len() > max {
        return Err(ObjectError::Unavailable("a response body past its bound".into(), crate::cause!()));
    }
    Ok(bytes)
}

/// A ListObjectsV2 answer: each `<Contents>`'s key and size, and `<IsTruncated>`. Keys are URL-decoded when the
/// store answers `<EncodingType>url</EncodingType>`, after their XML entities are read.
fn parse_listing(xml: &str) -> Result<Listing, ObjectError> {
    let url_encoded = element(xml, "EncodingType").is_some_and(|coding| coding == "url");
    let mut listing = Listing { objects: Vec::new(), more: element(xml, "IsTruncated") == Some("true") };
    let mut rest = xml;
    while let Some(start) = rest.find("<Contents>") {
        let end = rest[start..].find("</Contents>").ok_or_else(|| ObjectError::Unavailable("malformed listing".into(), crate::cause!()))? + start;
        let contents = &rest[start..end];
        let key = unescape_xml(element(contents, "Key").ok_or_else(|| ObjectError::Unavailable("malformed listing".into(), crate::cause!()))?);
        let key = if url_encoded { percent_decode(&key).ok_or_else(|| ObjectError::Unavailable("malformed listing".into(), crate::cause!()))? } else { key };
        let size = element(contents, "Size").and_then(|size| size.parse().ok()).ok_or_else(|| ObjectError::Unavailable("malformed listing".into(), crate::cause!()))?;
        listing.objects.push((key, size));
        rest = &rest[end..];
    }
    Ok(listing)
}

/// The text of the first `<name>` element.
fn element<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{name}>"))? + start;
    Some(&xml[start..end])
}

fn unescape_xml(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// S3's `encoding-type=url` key text to the key: `%XX` is that byte and `+` is a space (a literal `+` comes as
/// `%2B`), as the AWS SDKs read it.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let digits = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
            out.push(u8::from_str_radix(digits, 16).ok()?);
            at += 3;
        } else if bytes[at] == b'+' {
            out.push(b' ');
            at += 1;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
}

/// `bytes a-b/total` -> (a, b).
fn content_range(value: &str) -> Option<(u64, u64)> {
    let range = value.strip_prefix("bytes ")?.split('/').next()?;
    let (from, to) = range.split_once('-')?;
    Some((from.parse().ok()?, to.parse().ok()?))
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// RFC 3986 encoding of one path segment, as SigV4's canonical URI requires (unreserved characters stay).
fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct UnreadSecrets;
    impl Secrets for UnreadSecrets {
        fn plain(&self, _: &str) -> Result<Zeroizing<String>, ObjectError> {
            panic!("invalid ranges must refuse before reading the vault")
        }
        fn sigv4_day_key(&self, _: &str, _: &str) -> Result<Zeroizing<Vec<u8>>, ObjectError> {
            panic!("invalid ranges must refuse before signing a request")
        }
        fn holds(&self, _: &str) -> Result<bool, ObjectError> { Ok(false) }
    }

    #[test]
    fn range_refusals_keep_their_exact_source_through_file_routes_without_input_values() {
        let objects = S3Objects::new(Vec::new(), Box::new(UnreadSecrets)).unwrap();
        let origin = "private-origin-marker";
        let key = "private-object-marker";
        let zero = objects.read_controlled(origin, key, 0, 0, None).unwrap_err();
        let overflow = objects.read_controlled(origin, key, u64::MAX, 2, None).unwrap_err();
        let past_end = objects.read_controlled(origin, key, 0, 1, Some(0)).unwrap_err();
        let causes = [zero.cause(), overflow.cause(), past_end.cause()];
        assert_ne!(causes[0], causes[1]);
        assert_ne!(causes[0], causes[2]);
        assert_ne!(causes[1], causes[2]);
        assert_eq!(causes[0], objects.read_controlled(origin, key, 0, 0, None).unwrap_err().cause());
        let source = include_str!("objects.rs");
        for (cause, condition) in causes.iter().zip([
            "return Err(ObjectError::Unavailable(\"a ranged read asks for 1 byte up to its bound\"",
            ".ok_or_else(|| ObjectError::Unavailable(\"a ranged read exceeds its offset bound\"",
            "if total.is_some_and(|total| last >= total) { return Err(crate::cause!(ObjectError::RangeNotHonoured)); }",
        ]) {
            let expected = source.lines().position(|line| line.contains(condition)).unwrap() + 1;
            assert_eq!(cause.file(), "src/account_files/objects.rs");
            assert_eq!(cause.line() as usize, expected);
            assert!(!cause.id().contains(origin));
            assert!(!cause.id().contains(key));
        }
        for (error, expected) in [zero, overflow, past_end].into_iter().zip(causes) {
            let wrapped: super::super::AccountFilesError = error.into();
            assert_eq!(wrapped.cause(), expected);
            let failure = super::super::account_routes::Failure::AccountFiles(wrapped, crate::cause!());
            assert_eq!(failure.code(), ("namespace_source_unavailable", true));
            assert_eq!(failure.cause(), expected);
        }
    }

    #[test]
    fn origin_records_are_machine_readable() {
        let row: Origin = serde_json::from_value(serde_json::json!({
            "kind": "namespace-origin", "rank": 2, "file_key_prefix": "people/p/files/",
            "reach": {"key_id": {"held": "k"}, "secret": {"held": "s"}, "bucket": {"held": "b"},
                      "endpoint": {"value": "https://s3.example.test"}, "region": {"value": "r"}}
        }))
        .unwrap();
        assert_eq!(row.reach.endpoint, Source::Value("https://s3.example.test".into()));
        assert_eq!(row.reach.secret, Source::Held("s".into()));
    }

    struct FixtureSecrets;
    impl Secrets for FixtureSecrets {
        fn plain(&self, _: &str) -> Result<Zeroizing<String>, ObjectError> { Ok(Zeroizing::new("synthetic".into())) }
        fn sigv4_day_key(&self, _: &str, _: &str) -> Result<Zeroizing<Vec<u8>>, ObjectError> { Ok(Zeroizing::new(vec![0; 32])) }
        fn holds(&self, _: &str) -> Result<bool, ObjectError> { Ok(true) }
    }

    /// The span-upload fixture: one origin at `port`, a control whose call ends at `until`, and an idle bound `idle`.
    fn span_store(port: u16, until: std::time::Instant, idle: Duration) -> S3Objects {
        let control = super::super::CallControl::new(until, Arc::new(|| true),
            super::super::source_reads::Unmetered::new("span-window-test").into()).with_idle(idle);
        let origin: Origin = serde_json::from_value(serde_json::json!({
            "kind": "namespace-origin", "rank": 1, "file_key_prefix": "p/",
            "reach": {"key_id": {"held": "k"}, "secret": {"held": "s"}, "bucket": {"held": "b"},
                      "region": {"value": "r"}, "endpoint": {"value": format!("http://127.0.0.1:{port}")}}
        })).unwrap();
        let mut objects = S3Objects::new(vec![("origin".to_owned(), origin)], Box::new(FixtureSecrets)).unwrap();
        objects.set_control(control);
        objects
    }

    /// The request head of one connection, read byte by byte so the body is left for the test to read.
    fn read_request_head(stream: &mut std::net::TcpStream) {
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut byte = [0u8; 1];
            stream.read_exact(&mut byte).unwrap();
            head.push(byte[0]);
        }
    }

    /// A 512 KiB upload that the store takes in 64 KiB every 100 ms succeeds: no byte waits longer than the idle bound of
    /// 1 s, and the call's total of 10 s is never reached.
    #[test]
    fn a_steadily_dripped_upload_succeeds() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let length = 512 * 1024usize;
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request_head(&mut stream);
            let mut received = 0usize;
            let mut buffer = vec![0u8; 64 * 1024];
            while received < length {
                let want = buffer.len().min(length - received);
                let read = stream.read(&mut buffer[..want]).unwrap();
                assert!(read > 0, "the client stopped sending");
                received += read;
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
        let objects = span_store(port, std::time::Instant::now() + Duration::from_secs(10), Duration::from_secs(1));
        let bytes = vec![7u8; length];
        let mut reader: &[u8] = &bytes;
        objects.write_stream("origin", "p/span", Body { length: length as u64, sha256: Sha256::digest(&bytes).into(), bytes: &mut reader }, "application/octet-stream").unwrap();
        server.join().unwrap();
    }

    /// A store that takes the whole body and answers 1.5 s later (longer than the 1 s idle bound) succeeds: once the body is
    /// sent, the reply is bounded by the call's total (10 s), not by idle, since a store may take longer than one idle bound
    /// to commit what it read.
    #[test]
    fn a_slow_reply_after_the_whole_body_succeeds() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let length = 512 * 1024usize;
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request_head(&mut stream);
            std::io::copy(&mut std::io::Read::take(&mut stream, length as u64), &mut std::io::sink()).unwrap();
            std::thread::sleep(Duration::from_millis(1500));
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
        let objects = span_store(port, std::time::Instant::now() + Duration::from_secs(10), Duration::from_secs(1));
        let bytes = vec![7u8; length];
        let mut reader: &[u8] = &bytes;
        let started = std::time::Instant::now();
        objects.write_stream("origin", "p/span", Body { length: length as u64, sha256: Sha256::digest(&bytes).into(), bytes: &mut reader }, "application/octet-stream").unwrap();
        assert!(started.elapsed() >= Duration::from_millis(1500));
        server.join().unwrap();
    }

    /// A slow drip that never goes idle (64 KiB every 500 ms, under the 1 s idle bound) is still stopped: the call's total
    /// (2 s here) ends it, and the 512 KiB would take 4 s.
    #[test]
    fn a_slow_drip_that_never_goes_idle_is_stopped_by_the_outer_cap() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let length = 512 * 1024usize;
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request_head(&mut stream);
            let mut buffer = vec![0u8; 64 * 1024];
            for _ in 0..(length / buffer.len()) {
                if stream.read_exact(&mut buffer).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        });
        // The call's time and the measured time start at the same instant, so setting up the store under load is not counted against it.
        let started = std::time::Instant::now();
        let objects = span_store(port, started + Duration::from_secs(2), Duration::from_secs(1));
        let bytes = vec![7u8; length];
        let mut reader: &[u8] = &bytes;
        let error = objects.write_stream("origin", "p/span", Body { length: length as u64, sha256: Sha256::digest(&bytes).into(), bytes: &mut reader }, "application/octet-stream").unwrap_err();
        let elapsed = started.elapsed();
        assert!(format!("{error:?}").contains("account files call stopped") || format!("{error:?}").contains("os error"), "{error:?}");
        assert!(elapsed >= Duration::from_millis(1800) && elapsed <= Duration::from_millis(3000), "stopped after {elapsed:?}");
        drop(server);
    }

    /// A loopback store answering ranged GETs of a 1000-byte object (byte n is n % 251), counting the connections it
    /// accepted. `after_first` says what a connection does after its first answer: keep answering, say
    /// `Connection: close`, or close without saying.
    #[derive(Clone, Copy)]
    enum AfterFirst {
        KeepAnswering,
        SayClose,
        CloseSilently,
    }

    fn ranged_store(after_first: AfterFirst) -> (u16, Arc<std::sync::atomic::AtomicUsize>, Arc<AtomicBool>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (counter, stopped) = (accepted.clone(), stop.clone());
        std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            while !stopped.load(Ordering::Acquire) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                };
                counter.fetch_add(1, Ordering::AcqRel);
                stream.set_nonblocking(false).unwrap();
                std::thread::spawn(move || {
                    let mut answered = 0;
                    loop {
                        let mut head = Vec::new();
                        while !head.ends_with(b"\r\n\r\n") {
                            let mut byte = [0u8; 1];
                            if stream.read(&mut byte).unwrap_or(0) == 0 {
                                return;
                            }
                            head.push(byte[0]);
                        }
                        let head = String::from_utf8(head).unwrap();
                        let range = head.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("range: bytes=").map(str::to_owned)).unwrap();
                        let (from, to) = range.split_once('-').unwrap();
                        let (from, to): (usize, usize) = (from.parse().unwrap(), to.parse().unwrap());
                        let body: Vec<u8> = (from..=to).map(|at| (at % 251) as u8).collect();
                        answered += 1;
                        let saying = matches!(after_first, AfterFirst::SayClose) && answered == 1;
                        let reply = format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {from}-{to}/1000\r\nContent-Length: {}\r\n{}\r\n",
                            body.len(), if saying { "Connection: close\r\n" } else { "" });
                        stream.write_all(reply.as_bytes()).and_then(|()| stream.write_all(&body)).unwrap();
                        if answered == 1 && !matches!(after_first, AfterFirst::KeepAnswering) {
                            return;
                        }
                    }
                });
            }
        });
        (port, accepted, stop)
    }

    fn read_twice(port: u16) -> (Vec<u8>, Vec<u8>) {
        let objects = span_store(port, std::time::Instant::now() + Duration::from_secs(10), Duration::from_secs(2));
        let first = objects.read("origin", "a", 0, 100).unwrap();
        let second = objects.read("origin", "a", 500, 100).unwrap();
        (first, second)
    }

    /// Two reads one after the other cost one connection: the second request goes down the connection the first one
    /// finished on (a handshake and a connect per request were most of a read's time on the person's door, 2026-11-13).
    #[test]
    fn a_second_read_goes_down_the_connection_the_first_one_finished_on() {
        let (port, accepted, stop) = ranged_store(AfterFirst::KeepAnswering);
        let (first, second) = read_twice(port);
        assert_eq!(first, (0..100).map(|at| (at % 251) as u8).collect::<Vec<_>>());
        assert_eq!(second, (500..600).map(|at| (at % 251) as u8).collect::<Vec<_>>());
        assert_eq!(accepted.load(Ordering::Acquire), 1);
        stop.store(true, Ordering::Release);
    }

    /// A store that says `Connection: close` ends that connection with its answer: the next read opens a new one.
    #[test]
    fn a_connection_the_store_says_close_on_is_not_used_again() {
        let (port, accepted, stop) = ranged_store(AfterFirst::SayClose);
        let (first, second) = read_twice(port);
        assert_eq!((first.len(), second.len()), (100, 100));
        assert_eq!(accepted.load(Ordering::Acquire), 2);
        stop.store(true, Ordering::Release);
    }

    /// A store that closes a kept connection without saying so is found before the next request is sent on it, or when
    /// that request finds it closed; the read still answers, on a new connection.
    #[test]
    fn a_connection_the_store_closed_silently_is_replaced_not_failed() {
        let (port, accepted, stop) = ranged_store(AfterFirst::CloseSilently);
        let (first, second) = read_twice(port);
        assert_eq!((first.len(), second.len()), (100, 100));
        assert_eq!(accepted.load(Ordering::Acquire), 2);
        stop.store(true, Ordering::Release);
    }

    #[test]
    fn segments_encode_like_sigv4() {
        assert_eq!(encode_segment("1f:ab"), "1f%3Aab");
        assert_eq!(encode_segment("a b~c"), "a%20b~c");
    }

    #[test]
    fn content_range_reads_the_served_span() {
        assert_eq!(content_range("bytes 0-99/1000"), Some((0, 99)));
        assert_eq!(content_range("bytes */1000"), None);
    }

    /// The AWS SigV4 documented example (GET /test.txt with Range, us-east-1, 20130524) signs to its published value.
    #[test]
    fn signing_key_chain_matches_the_aws_example() {
        let mut key = format!("AWS4{}", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY").into_bytes();
        for part in ["20130524", "us-east-1", "s3", "aws4_request"] {
            key = hmac(&key, part.as_bytes());
        }
        let canonical = "GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:20130524T000000Z\n\nhost;range;x-amz-content-sha256;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let to_sign = format!(
            "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n{}",
            hex(&Sha256::digest(canonical.as_bytes()))
        );
        assert_eq!(hex(&hmac(&key, to_sign.as_bytes())), "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    }
}
