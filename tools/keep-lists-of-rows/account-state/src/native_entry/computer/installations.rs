// src/native_entry/computer/installations.rs
//
// Purpose: Answer a browser's request for an installation of an account at its computer
// (`/a/<address>/installations/<installation>/<path>`, where the forwarder carries a request for another origin) from
// the installation's own files in the account's files, and make the account's signed origins row from the origins
// list the account keeps there, for the computer to hand the forwarder.
//
// Non-Negotiable Invariants:
// - Only an installation the account's own origins list names is answered: that list is the account publishing it.
// - Only GET and HEAD of files: an installation's own backend, shop or form is a tool, never trillion-local.
// - A path is read only in its one checked form (no `..`, no empty segment, no hidden segment but `.well-known`), and
//   only under the installation's own folder: one installation never reads another's files or the account's others.
// - Every page carries its own policy (`page_policy`) and is never stored by a shared cache.
//
// Key Concepts:
// - SiteFiles: the reads this owner needs (a byte window of one file, by full name); the account's files in production
//   (`AccountSiteFiles`), a test's own map in tests.
// - published: the origins list (`origins_file`), `{origins: [{host, installation, moved_to?}]}`, which a tool for names
//   or domains writes; signed into the account's origins row by the account's own key (`origins_row`).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! A published installation's files, answered at the account's computer.
//!
//! The port of old trillion `src/public-app-host.mjs:1456-1503` (the file part of `answerPublicApp`): the path read by
//! `publicAppFilePath` (Trillion-X/trillion-workshop tools/shared-code/src/public-app-files.mjs:20-31), a folder's index
//! reached without its slash sent on to it with one (:1463, 308), a single-page site's extensionless page answered by
//! its `index.html` (:1477-1483), and each answer's headers (:1486-1487: its media type, `nosniff`, the referrer
//! policy, `no-store`, and for a page its content security policy, :123-129). The old installation's files lived in
//! a central KV row and an R2 bucket; here they are the account's own files under `files_folder`/<installation>/, and
//! whether the installation is live is whether the account's own origins list names it. The old visitor count,
//! shop, placed capabilities, linked routes and site backend are product features: tools, not this route.
//!
//! Every number and word is DATA beside this code (`installations.json`).

use crate::forwarder::origins::{Origin, OriginsRow};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use serde::Deserialize;
use std::sync::OnceLock;

/// The settings DATA beside this code.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    /// The account files folder each installation's files are under: `<files_folder>/<installation>/<path>`.
    pub files_folder: String,
    /// The account file the account's origins list is kept in.
    pub origins_file: String,
    /// The account file the forwarder's answer to that list is kept in (`keep_told`).
    pub told_file: String,
    /// The page a folder or the root answers with.
    index: String,
    /// Path segments a single-page site's index never answers for (its own API, as old trillion's).
    not_single_page: Vec<String>,
    /// The one dot-named segment a path may carry.
    well_known: String,
    /// The most bytes one answer carries: within the door's one request bound, the bound of one session message.
    pub most_answer_bytes: u64,
    /// The most bytes one read of the account's files asks for (its read bound).
    read_bytes: u64,
    /// The most bytes of the origins list.
    most_origins_bytes: u64,
    /// The content security policy of a page; `{service}` is the computer's public origin.
    page_policy: String,
    referrer_policy: String,
    /// How long one request's reads of the account's files may take.
    pub read_wait_ms: u64,
    words: Words,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Words {
    not_found: String,
    not_published: String,
    method: String,
    too_large: String,
    range: String,
    unavailable: String,
}

pub(crate) fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| serde_json::from_slice(include_bytes!("installations.json")).expect("installations.json is valid"))
}

/// One window of a file's bytes, and the facts of the whole file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Window {
    pub media_type: String,
    pub byte_length: u64,
    pub bytes: Vec<u8>,
}

/// What reading a file answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Read {
    Found(Window),
    Missing,
    /// The account's files did not answer (no store, a store refused, out of time).
    Unavailable,
}

/// The reads this owner needs of the account's files.
pub(crate) trait SiteFiles {
    /// Up to `length` bytes of the file named `name` (a full name) from `offset`.
    fn read(&self, name: &str, offset: u64, length: u64) -> Read;
}

/// The account's origins list, as the tool writes it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OriginsList {
    origins: Vec<Origin>,
}

/// What the account's origins list says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Published {
    /// The list, and the bytes it was read from (what the computer compares to know it changed).
    Origins(Vec<Origin>, Vec<u8>),
    /// The account keeps no list: it publishes nothing.
    None,
    /// The list could not be read now, or is not a list: nothing is decided from it.
    Unreadable,
}

/// The account's origins list (`origins_file`).
pub(crate) fn published(files: &dyn SiteFiles) -> Published {
    let settings = settings();
    match files.read(&settings.origins_file, 0, settings.most_origins_bytes) {
        Read::Found(window) if window.byte_length <= settings.most_origins_bytes => {
            match serde_json::from_slice::<OriginsList>(&window.bytes) {
                Ok(list) => Published::Origins(list.origins, window.bytes),
                Err(_) => Published::Unreadable,
            }
        }
        Read::Found(_) | Read::Unavailable => Published::Unreadable,
        Read::Missing => Published::None,
    }
}

/// The account's origins row at `revision`, signed with its `key`, from its origins list; `None` when the list is not
/// one a row can carry (a host, an installation or a rename the row refuses).
pub(crate) fn origins_row(origins: &[Origin], revision: u64, key: &crate::account::computers::AccountKey) -> Option<OriginsRow> {
    OriginsRow::sign(revision, origins, key).ok()
}

/// What the forwarder answered the account's origins row with, kept beside the list (`told_file`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Told {
    /// Taken: the forwarder answers these many hosts for the account.
    Answering(usize),
    /// Refused, with the forwarder's word for why (src/forwarder/words.json).
    Refused(String),
}

/// What the forwarder's answer (`status`, `body`) to a row of `hosts` hosts says: taken (200), or a refusal of the row
/// itself (409 with its word). A refusal because the posting computer is not (yet) a live computer of the account, any
/// other status, or a body with no word is no answer: the computer posts again on its next step.
pub(crate) fn told_of(status: u16, body: &[u8], hosts: usize) -> Option<Told> {
    match status {
        200 => Some(Told::Answering(hosts)),
        409 => serde_json::from_slice::<serde_json::Value>(body).ok()
            .and_then(|answer| answer["error"].as_str().map(|word| word.chars().take(64).collect::<String>()))
            .filter(|word| *word != crate::forwarder::origins::not_believed_word())
            .map(Told::Refused),
        _ => None,
    }
}

/// The JSON kept in `told_file` for `told` at `at_ms`.
pub(crate) fn told_json(told: &Told, at_ms: i64) -> serde_json::Value {
    match told {
        Told::Answering(hosts) => serde_json::json!({"state": "answering", "hosts": hosts, "told_at_ms": at_ms}),
        Told::Refused(why) => serde_json::json!({"state": "refused", "why": why, "told_at_ms": at_ms}),
    }
}

/// Keep what the forwarder answered in the account's own files (`told_file`), for the person's tools to say: one
/// `write_file`, admitted by the named unmetered admission of published installations. A write that fails is only
/// logged: the list itself is unchanged and is handed in again.
pub(crate) fn keep_told(state_root: &std::path::Path, account: &str, told: &Told, at_ms: i64, until: std::time::Instant) {
    use crate::account_files::account_routes::AccountFilesDoor;
    let Some(door) = AccountFilesDoor::shipped() else { return };
    let input = serde_json::json!({"name": settings().told_file, "text": told_json(told, at_ms).to_string(), "media_type": "application/json"});
    if let Err(error) = door.call_with_control(state_root, account, "write_file", &input, control(until)) {
        crate::quiet_eprintln!("computer-origins event=told-not-kept cause={}", error.cause());
    }
}

/// The control every read and write of published installations runs with: no step after `until`, admitted by the one
/// named unmetered admission `published installations` (counted under `namespace.bytes.unmetered.published
/// installations.*`) and in the account's own usage.
fn control(until: std::time::Instant) -> crate::account_files::CallControl {
    static ADMISSION: OnceLock<crate::account_files::source_reads::Admission> = OnceLock::new();
    let admission = ADMISSION.get_or_init(|| crate::account_files::source_reads::Unmetered::new("published installations").into());
    crate::account_files::CallControl::new(until, std::sync::Arc::new(|| true), admission.clone())
}

/// The one checked form of a request path within an installation (`publicAppFilePath`): percent-decoded, the leading
/// slashes taken off, the index for the root or a folder; `None` for an empty, `.`/`..`, hidden or odd segment.
pub(crate) fn file_path(path: &str) -> Option<String> {
    let settings = settings();
    let decoded = url::form_urlencoded::parse(format!("p={}", path.replace('+', "%2B")).as_bytes())
        .next().map(|(_, value)| value.into_owned())?;
    let mut path = decoded.trim_start_matches('/').to_owned();
    if path.is_empty() {
        path.clone_from(&settings.index);
    } else if path.ends_with('/') {
        path.push_str(&settings.index);
    }
    let segments: Vec<&str> = path.split('/').collect();
    let last = segments.len() - 1;
    let segment_ok = |(index, segment): (usize, &&str)| {
        let well_known = **segment == *settings.well_known && index != last;
        !segment.is_empty() && *segment != "." && *segment != ".."
            && (well_known || (segment.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
                && segment.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))))
    };
    segments.iter().enumerate().all(segment_ok).then_some(path)
}

/// One answer: status, headers and body.
pub(crate) struct Answer {
    pub status: StatusCode,
    pub headers: Vec<(header::HeaderName, String)>,
    pub body: Vec<u8>,
    /// The file's whole size when `body` is only its first window (a whole read of a file larger than one answer, asked
    /// with `stream`), else None.
    pub whole: Option<u64>,
}

impl Answer {
    fn plain(status: StatusCode, word: &str) -> Self {
        Self {
            status,
            headers: vec![(header::CONTENT_TYPE, "text/plain; charset=utf-8".into()), (header::CACHE_CONTROL, "no-store".into())],
            body: word.as_bytes().to_vec(),
            whole: None,
        }
    }

    pub fn into_response(self) -> axum::response::Response {
        let mut response = axum::response::Response::new(axum::body::Body::from(self.body));
        *response.status_mut() = self.status;
        if let Some(whole) = self.whole {
            response.extensions_mut().insert(crate::account::computers::messages::WholeLength(whole));
        }
        for (name, value) in self.headers {
            if let Ok(value) = HeaderValue::from_str(&value) {
                response.headers_mut().append(name, value);
            }
        }
        response
    }
}

/// Answer `method` `target` (the path and query after `/installations/<installation>`) for `installation` from
/// `files`, for a computer whose public origin is `service`. A whole read of a file larger than one answer is 413 unless
/// the asker `stream`s (the forwarder): it is then answered 200 with the first window and the file's size, and the rest is
/// asked by byte range.
pub(crate) fn answer(files: &dyn SiteFiles, installation: &str, method: &Method, target: &str, headers: &HeaderMap, service: &str, stream: bool) -> Answer {
    let settings = settings();
    let words = &settings.words;
    if method != Method::GET && method != Method::HEAD {
        let mut refused = Answer::plain(StatusCode::METHOD_NOT_ALLOWED, &words.method);
        refused.headers.push((header::ALLOW, "GET, HEAD".into()));
        return refused;
    }
    match published(files) {
        Published::Origins(origins, _) if origins.iter().any(|origin| origin.installation == installation) => {}
        Published::Unreadable => return Answer::plain(StatusCode::SERVICE_UNAVAILABLE, &words.unavailable),
        _ => return Answer::plain(StatusCode::NOT_FOUND, &words.not_published),
    }
    let (path, query) = target.split_once('?').map_or((target, None), |(path, query)| (path, Some(query)));
    let Some(mut file) = file_path(path) else { return Answer::plain(StatusCode::NOT_FOUND, &words.not_found) };
    let folder = format!("{}/{installation}/", settings.files_folder);
    let range = requested_range(headers);
    // A HEAD reads no bytes, only the file's facts.
    let first_length = if method == Method::HEAD { 0 } else { settings.read_bytes };
    let first = |file: &str| files.read(&format!("{folder}{file}"), range.map_or(0, |(start, _)| start), first_length);
    let mut read = first(&file);
    if read == Read::Missing && !path.ends_with('/') && !path.is_empty() {
        // A folder's index reached without its slash: the visitor goes on to the folder, so the page's own relative
        // addresses resolve as the site wrote them (old :1463, 308).
        if let Read::Found(_) = files.read(&format!("{folder}{file}/{}", settings.index), 0, 0) {
            let location = format!("{path}/{}", query.map(|query| format!("?{query}")).unwrap_or_default());
            return Answer {
                status: StatusCode::PERMANENT_REDIRECT,
                headers: vec![(header::LOCATION, location), (header::CACHE_CONTROL, "no-store".into())],
                body: Vec::new(),
                whole: None,
            };
        }
        // A single-page site answers its extensionless pages with its index (old :1477-1483).
        let last = path.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
        let wants_page = headers.get(header::ACCEPT).and_then(|value| value.to_str().ok()).is_some_and(|accept| accept.contains("text/html"));
        let reserved = settings.not_single_page.iter().any(|segment| file.starts_with(&format!("{segment}/")));
        if wants_page && !last.contains('.') && !reserved {
            file.clone_from(&settings.index);
            read = first(&file);
        }
    }
    let window = match read {
        Read::Found(window) => window,
        Read::Missing => return Answer::plain(StatusCode::NOT_FOUND, &words.not_found),
        Read::Unavailable => return Answer::plain(StatusCode::SERVICE_UNAVAILABLE, &words.unavailable),
    };
    let size = window.byte_length;
    let streamed = stream && range.is_none() && method == Method::GET && size > settings.most_answer_bytes;
    let (start, end) = match range {
        Some((start, _)) if start >= size => {
            let mut refused = Answer::plain(StatusCode::RANGE_NOT_SATISFIABLE, &words.range);
            refused.headers.push((header::CONTENT_RANGE, format!("bytes */{size}")));
            return refused;
        }
        Some((start, end)) => (start, end.unwrap_or(size - 1).min(size - 1).min(start + settings.most_answer_bytes - 1)),
        None if streamed => (0, settings.most_answer_bytes - 1),
        None if size > settings.most_answer_bytes => return Answer::plain(StatusCode::PAYLOAD_TOO_LARGE, &words.too_large),
        None => (0, size.saturating_sub(1)),
    };
    let wanted = if size == 0 { 0 } else { end + 1 - start };
    let mut body = window.bytes;
    if method == Method::GET {
        // The first read gave up to `read_bytes`; the rest of the window is read in further reads of that size.
        body.truncate(usize::try_from(wanted).unwrap_or(usize::MAX));
        while (body.len() as u64) < wanted {
            match files.read(&format!("{folder}{file}"), start + body.len() as u64, (wanted - body.len() as u64).min(settings.read_bytes)) {
                Read::Found(more) if !more.bytes.is_empty() => body.extend_from_slice(&more.bytes),
                Read::Found(_) | Read::Missing => break,
                Read::Unavailable => return Answer::plain(StatusCode::SERVICE_UNAVAILABLE, &words.unavailable),
            }
        }
        body.truncate(usize::try_from(wanted).unwrap_or(usize::MAX));
        if (body.len() as u64) < wanted {
            return Answer::plain(StatusCode::SERVICE_UNAVAILABLE, &words.unavailable);
        }
    } else {
        body.clear();
    }
    let mut headers = vec![
        (header::CONTENT_TYPE, window.media_type.clone()),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        (header::REFERRER_POLICY, settings.referrer_policy.clone()),
        (header::CACHE_CONTROL, "no-store".into()),
        (header::ACCEPT_RANGES, "bytes".into()),
    ];
    if window.media_type.starts_with("text/html") {
        headers.push((header::CONTENT_SECURITY_POLICY, settings.page_policy.replace("{service}", service)));
    }
    let status = if range.is_some() {
        headers.push((header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}")));
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    Answer { status, headers, body, whole: streamed.then_some(size) }
}

/// One `Range: bytes=<start>-<end?>` the request asks for; any other form (several ranges, a suffix range) is
/// answered whole, as RFC 9110 lets a server do.
fn requested_range(headers: &HeaderMap) -> Option<(u64, Option<u64>)> {
    let value = headers.get(header::RANGE)?.to_str().ok()?.trim().strip_prefix("bytes=")?;
    let (start, end) = value.split_once('-')?;
    let start = start.trim().parse::<u64>().ok()?;
    let end = match end.trim() {
        "" => None,
        end => Some(end.parse::<u64>().ok().filter(|end| *end >= start)?),
    };
    Some((start, end))
}

/// The account's own files, as `SiteFiles`: each read is the account files' `read_file` (base64), admitted by the one
/// named unmetered admission of published installations and counted in the account's own usage (`usage.rs`).
pub(crate) struct AccountSiteFiles<'a> {
    pub state_root: &'a std::path::Path,
    pub account: &'a str,
    pub until: std::time::Instant,
}

impl SiteFiles for AccountSiteFiles<'_> {
    fn read(&self, name: &str, offset: u64, length: u64) -> Read {
        use crate::account_files::{account_routes::{AccountFilesDoor, Failure}, AccountFilesError};
        use base64::Engine as _;
        let Some(door) = AccountFilesDoor::shipped() else { return Read::Unavailable };
        let control = control(self.until);
        let input = serde_json::json!({"name_or_identity": name, "offset": offset, "length": length, "encoding": "base64"});
        match door.call_with_control(self.state_root, self.account, "read_file", &input, control) {
            Ok(value) => {
                let bytes = value["content"].as_str()
                    .and_then(|content| base64::engine::general_purpose::STANDARD.decode(content).ok());
                match (bytes, value["byte_length"].as_u64(), value["media_type"].as_str()) {
                    (Some(bytes), Some(byte_length), Some(media_type)) =>
                        Read::Found(Window { media_type: media_type.to_owned(), byte_length, bytes }),
                    _ => Read::Unavailable,
                }
            }
            Err(Failure::AccountFiles(AccountFilesError::NotFound(_), _)) => Read::Missing,
            Err(_) => Read::Unavailable,
        }
    }
}

#[cfg(test)]
mod tests;
