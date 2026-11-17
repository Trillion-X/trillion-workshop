// src/share_bytes/mod.rs
//
// Purpose: The public byte route of a share: `GET` and `HEAD` at `/share/<id>/<key>` answer the bytes of the one file a share names, whole
// or by `Range` (200, 206, 416), to anyone who holds the share's key and for as long as the person's own share stands. It replaces the
// signed store link a share used to be (a link that stayed valid until its expiry however the share was stopped, and that could not
// name a file kept in chunks): no link to the store is made any more, the bytes are read here, by range, through the account files.
//
// What a share is, is not decided here. It is the share-anything record `sharing:<id>` of the person's own (`{ reach, can, people:
// [{ principal, key_blake3 }], published, revoked_at, expires_at }`), read through the records door on EVERY request and on every
// `recheck_seconds` of a long body, so a share stopped, withdrawn or ended refuses the very next read. Nothing is cached about a share.
//
// Non-Negotiable Invariants:
// - A request is served only when, read now: the share record holds a person whose `key_blake3` is the BLAKE3 of the presented key, it
//   is published, not revoked, not expired, `can` holds `view`, and its `reach` names the shared-file record the path names.
// - Every refusal of a key, a share, a record or a file answers the same 404 with the same body, so a key, an id or a stopped share can
//   not be told from one that never was. Only a records door that cannot answer is told apart (503), which says nothing about the key.
// - The route never answers a byte it did not read by range through the byte check of the account files (`Reader`), so each read is
//   counted as every read is.
// - The route holds no credential: not the store's, not the share's key (only a digest of it is compared).
// - Every number is DATA (`Config`, settings.json `share_bytes`).
//
// Key Concepts:
// - `Grants`: what the route asks of the person's records (the share record, the shared-file record). `Reader`: ranged bytes of a file by identity.
// - `router`: the axum router over both; `admit`: the whole decision about one request.
//
// Security Considerations:
// - Content is served `no-store`, `nosniff` and under `sandbox`; only the media types `inline_types` names display in the browser, every
//   other is an attachment, so a shared page can never run on the person's own address.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use std::{sync::Arc, time::{Duration, Instant}};

/// The kind of the record a share of a file names (`share_anything::SHARED_FILE_KIND`).
pub use crate::account_files::share_anything::SHARED_FILE_KIND;
/// The prefix of the workspace label a share is kept at.
const SHARE_LABEL_PREFIX: &str = "sharing:";
/// The link's principal in a share's people.
const KEY_PREFIX: &str = "shr_";
/// The most characters a key of a share has.
const MOST_KEY_CHARS: usize = 128;

/// `settings.json` `share_bytes`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(rename = "_what")]
    _what: String,
    /// The loopback address the route listens on (a front door's route for `/share/*` reaches it).
    pub listen: String,
    /// The most bytes one read of the store answers a body with.
    pub window_bytes: u64,
    /// How often a long body asks the person's records again whether the share still stands.
    pub recheck_seconds: u64,
    /// The media types (a whole type, or a prefix ending in `/`) shown in the browser; every other is offered as a download.
    pub inline_types: Vec<String>,
}

impl Config {
    /// Why a config is refused, in words.
    pub fn check(&self) -> Result<(), &'static str> {
        let loopback = self.listen.parse::<std::net::SocketAddr>().is_ok_and(|address| address.ip().is_loopback());
        if !loopback {
            return Err("the share route listens on a loopback address");
        }
        if !(1..=32 * 1024 * 1024).contains(&self.window_bytes) {
            return Err("a share route window is 1 byte up to 32 MiB");
        }
        if self.inline_types.iter().any(|kind| kind.is_empty() || kind.chars().any(|c| c.is_control() || c.is_whitespace())) {
            return Err("an inline type is plain text with no space");
        }
        Ok(())
    }
}

/// Why the person's records could not answer.
#[derive(Debug, PartialEq, Eq)]
pub struct Unavailable;

/// What the route reads of the person's own records.
pub trait Grants: Send + Sync {
    /// The workspace record at `label` (a share), or None when there is none.
    fn workspace(&self, label: &str) -> Result<Option<Value>, Unavailable>;
    /// The record of `kind` and `id` (a shared file's facts), or None when there is none.
    fn record(&self, kind: &str, id: &str) -> Result<Option<Value>, Unavailable>;
}

/// Ranged bytes of the person's files, each read through the account files' byte check.
pub trait Reader: Send + Sync {
    /// `length` (at least 1) bytes of the file `identity` from `offset`.
    fn read(&self, identity: &str, offset: u64, length: u64) -> Result<Vec<u8>, Unavailable>;
}

/// The route's state: the person's records, the files, the numbers.
pub struct Route {
    pub grants: Arc<dyn Grants>,
    pub reader: Arc<dyn Reader>,
    pub config: Config,
}

/// The file a request is let read, as the shared-file record holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admitted {
    pub identity: String,
    pub name: String,
    pub byte_length: u64,
    pub media_type: String,
}

/// Why a request is not let in.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Every reason a key, a share or a file is not there to this reader.
    NotFound,
    /// The person's records did not answer.
    Unavailable,
}

impl From<Unavailable> for Refusal {
    fn from(_: Unavailable) -> Self {
        Refusal::Unavailable
    }
}

fn text<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn plain_id(id: &str) -> bool {
    id.strip_prefix(SHARED_FILE_KIND).and_then(|rest| rest.strip_prefix(':')).is_some_and(|hex| hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn plain_key(key: &str) -> bool {
    key.starts_with(KEY_PREFIX) && key.len() <= MOST_KEY_CHARS && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn instant(value: &Value, field: &str) -> Result<Option<DateTime<Utc>>, Refusal> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(at)) => DateTime::parse_from_rfc3339(at).map(|at| Some(at.with_timezone(&Utc))).map_err(|_| Refusal::NotFound),
        Some(_) => Err(Refusal::NotFound),
    }
}

/// Whether the share record `share` lets the holder of `key` read the record `id` at `now`.
pub fn stands(share: &Value, key: &str, id: &str, now: DateTime<Utc>) -> Result<(), Refusal> {
    let digest = content_crypto::advanced::blake3::hash(key.as_bytes()).to_hex().to_string();
    let person = share.get("people").and_then(Value::as_array).is_some_and(|people| people.iter().any(|person| text(person, "key_blake3") == Some(digest.as_str())));
    let open = share.get("published").and_then(Value::as_bool) != Some(false)
        && share.get("revoked_at").is_none_or(Value::is_null)
        && instant(share, "expires_at")?.is_none_or(|end| end > now);
    let may_view = share.get("can").and_then(Value::as_array).is_some_and(|can| can.iter().any(|word| word.as_str() == Some("view")));
    let reaches = share.get("reach").and_then(Value::as_array).is_some_and(|reach| {
        reach.iter().any(|entry| {
            text(entry, "type") == Some(SHARED_FILE_KIND)
                && match (text(entry, "id"), text(entry, "prefix")) {
                    (Some(named), None) => named == id,
                    _ => false,
                }
        })
    });
    if person && open && may_view && reaches { Ok(()) } else { Err(Refusal::NotFound) }
}

/// The whole decision about one request: the share and its record are read now, and the file is the record's.
pub fn admit(grants: &dyn Grants, id: &str, key: &str, now: DateTime<Utc>) -> Result<Admitted, Refusal> {
    if !plain_id(id) || !plain_key(key) {
        return Err(Refusal::NotFound);
    }
    let share = grants.workspace(&format!("{SHARE_LABEL_PREFIX}{id}"))?.ok_or(Refusal::NotFound)?;
    stands(&share, key, id, now)?;
    let record = grants.record(SHARED_FILE_KIND, id)?.ok_or(Refusal::NotFound)?;
    if text(&record, "kind") != Some(SHARED_FILE_KIND) || instant(&record, "expires_at")?.is_some_and(|end| end <= now) {
        return Err(Refusal::NotFound);
    }
    Ok(Admitted {
        identity: text(&record, "identity").filter(|identity| !identity.is_empty()).ok_or(Refusal::NotFound)?.to_owned(),
        name: text(&record, "name").unwrap_or("file").to_owned(),
        byte_length: record.get("byte_length").and_then(Value::as_u64).ok_or(Refusal::NotFound)?,
        media_type: text(&record, "media_type").unwrap_or("application/octet-stream").to_owned(),
    })
}

/// What a `Range` header asks of a file of `length` bytes.
#[derive(Debug, PartialEq, Eq)]
pub enum Wanted {
    /// No range, or one that is not a single byte range: the whole file.
    Whole,
    /// The bytes `from` up to and including `to`.
    Span { from: u64, to: u64 },
    /// A range no byte of the file is in.
    Unsatisfiable,
}

/// The single byte range of a `Range` header (`bytes=a-b`, `bytes=a-`, `bytes=-n`); anything else asks for the whole file.
pub fn wanted(header: Option<&str>, length: u64) -> Wanted {
    let Some(spec) = header.and_then(|value| value.trim().strip_prefix("bytes=")) else { return Wanted::Whole };
    let Some((first, last)) = spec.split_once('-').filter(|_| !spec.contains(',')) else { return Wanted::Whole };
    let (first, last) = (first.trim(), last.trim());
    let number = |text: &str| -> Option<u64> { if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) { None } else { text.parse().ok() } };
    if first.is_empty() {
        return match number(last) {
            Some(0) => Wanted::Unsatisfiable,
            Some(_) if length == 0 => Wanted::Unsatisfiable,
            Some(suffix) => Wanted::Span { from: length.saturating_sub(suffix), to: length - 1 },
            None => Wanted::Whole,
        };
    }
    let Some(from) = number(first) else { return Wanted::Whole };
    let to = if last.is_empty() { u64::MAX } else if let Some(to) = number(last) { to } else { return Wanted::Whole };
    if to < from {
        return Wanted::Whole;
    }
    if from >= length {
        return Wanted::Unsatisfiable;
    }
    Wanted::Span { from, to: to.min(length - 1) }
}

fn plain_type(media_type: &str) -> bool {
    let valid = |c: char| c.is_ascii_alphanumeric() || "!#$&-^_.+/".contains(c);
    media_type.len() <= 127 && media_type.contains('/') && media_type.chars().all(valid)
}

fn download_name(name: &str) -> String {
    let leaf = name.rsplit('/').next().unwrap_or("file");
    let safe: String = leaf.chars().map(|c| if (c.is_ascii_graphic() && !"\"\\;%".contains(c)) || c == ' ' { c } else { '_' }).take(120).collect();
    if safe.trim().is_empty() { "file".into() } else { safe }
}

fn refuse(status: StatusCode) -> Response {
    let mut response = Response::new(Body::from("not found"));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    response
}

/// The route's router: `/share/<id>/<key>`.
pub fn router(route: Route) -> Router {
    Router::new().route("/share/{id}/{key}", get(serve)).fallback(|| async { refuse(StatusCode::NOT_FOUND) }).with_state(Arc::new(route))
}

async fn serve(State(route): State<Arc<Route>>, Path((id, key)): Path<(String, String)>, headers: HeaderMap) -> Response {
    let admitted = {
        let (route, id, key) = (route.clone(), id.clone(), key.clone());
        tokio::task::spawn_blocking(move || admit(route.grants.as_ref(), &id, &key, Utc::now())).await
    };
    let file = match admitted {
        Ok(Ok(file)) => file,
        Ok(Err(Refusal::NotFound)) => return refuse(StatusCode::NOT_FOUND),
        _ => return refuse(StatusCode::SERVICE_UNAVAILABLE),
    };
    let length = file.byte_length;
    let ask = headers.get(header::RANGE).and_then(|value| value.to_str().ok());
    let (status, from, to) = match wanted(ask, length) {
        Wanted::Whole => (StatusCode::OK, 0, length.saturating_sub(1)),
        Wanted::Span { from, to } => (StatusCode::PARTIAL_CONTENT, from, to),
        Wanted::Unsatisfiable => {
            let mut response = refuse(StatusCode::RANGE_NOT_SATISFIABLE);
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{length}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            return response;
        }
    };
    let size = if length == 0 { 0 } else { to - from + 1 };
    let media_type = if plain_type(&file.media_type) { file.media_type.as_str() } else { "application/octet-stream" };
    let inline = route.config.inline_types.iter().any(|kind| if kind.ends_with('/') { media_type.starts_with(kind.as_str()) } else { media_type == kind });
    let mut response = Response::new(if size == 0 {
        Body::empty()
    } else {
        Body::from_stream(window_stream(route.clone(), id, key, file.clone(), from, to))
    });
    *response.status_mut() = status;
    let out = response.headers_mut();
    let mut put = |name: header::HeaderName, value: String| {
        if let Ok(value) = HeaderValue::from_str(&value) {
            out.insert(name, value);
        }
    };
    put(header::CONTENT_TYPE, media_type.to_owned());
    put(header::CONTENT_LENGTH, size.to_string());
    put(header::ACCEPT_RANGES, "bytes".into());
    put(header::CACHE_CONTROL, "no-store".into());
    put(header::X_CONTENT_TYPE_OPTIONS, "nosniff".into());
    put(header::CONTENT_SECURITY_POLICY, "sandbox; default-src 'none'; media-src 'self'".into());
    put(header::CONTENT_DISPOSITION, format!("{}; filename=\"{}\"", if inline { "inline" } else { "attachment" }, download_name(&file.name)));
    if status == StatusCode::PARTIAL_CONTENT {
        put(header::CONTENT_RANGE, format!("bytes {from}-{to}/{length}"));
    }
    response
}

struct Cursor {
    route: Arc<Route>,
    id: String,
    key: String,
    file: Admitted,
    next: u64,
    end: u64,
    checked: Instant,
}

/// The body: one read of the store a window at a time, so the first byte leaves after the first window and memory holds one window.
/// Each `recheck_seconds` the share is read again; a share that no longer stands ends the body with an error, never with more bytes.
fn window_stream(route: Arc<Route>, id: String, key: String, file: Admitted, from: u64, to: u64) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    let cursor = Cursor { route, id, key, file, next: from, end: to, checked: Instant::now() };
    futures_util::stream::unfold(Some(cursor), |state| async move {
        let mut cursor = state?;
        if cursor.next > cursor.end {
            return None;
        }
        let window = cursor.route.config.window_bytes.min(cursor.end - cursor.next + 1);
        let again = cursor.checked.elapsed() >= Duration::from_secs(cursor.route.config.recheck_seconds);
        let step = {
            let (route, id, key, file, at) = (cursor.route.clone(), cursor.id.clone(), cursor.key.clone(), cursor.file.clone(), cursor.next);
            tokio::task::spawn_blocking(move || {
                if again && admit(route.grants.as_ref(), &id, &key, Utc::now()).ok().as_ref() != Some(&file) {
                    return Err(());
                }
                route.reader.read(&file.identity, at, window).map_err(|_| ())
            })
            .await
        };
        match step {
            Ok(Ok(bytes)) if bytes.len() as u64 == window => {
                if again {
                    cursor.checked = Instant::now();
                }
                cursor.next += window;
                Some((Ok(Bytes::from(bytes)), Some(cursor)))
            }
            _ => Some((Err(std::io::Error::other("the share ended or its bytes could not be read")), None)),
        }
    })
}

/// The person's records as the records door answers them: each read is one door call under a request key of its own.
pub struct DoorGrants {
    door: crate::records_door::RecordsDoor,
    reads: std::sync::atomic::AtomicU64,
}

impl DoorGrants {
    pub fn new(door: crate::records_door::RecordsDoor) -> Self {
        Self { door, reads: std::sync::atomic::AtomicU64::new(0) }
    }

    fn key(&self, what: &str) -> String {
        let n = self.reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_nanos());
        format!("share-bytes:{what}:{at}:{n}")
    }
}

impl Grants for DoorGrants {
    fn workspace(&self, label: &str) -> Result<Option<Value>, Unavailable> {
        self.door.read_workspace(label, &self.key("workspace")).map_err(|_| Unavailable)
    }
    fn record(&self, kind: &str, id: &str) -> Result<Option<Value>, Unavailable> {
        self.door.read_record(kind, id, &self.key("record")).map_err(|_| Unavailable)
    }
}
