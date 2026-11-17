// src/host/https.rs
//
// Purpose: The one HTTP client of this tool, kept from src/https.rs of Trillion-X/trillion-rust at 5fbc2ff4b1 (the parts the
// byte store's requests use): the verified client, a request, an answer whose body is read as it arrives, and a request whose
// body is read from a reader while it is sent. Every request this tool makes to the person's byte store goes through it.
//
// Non-Negotiable Invariants:
// - https to any host, verified by rustls (on ring) against the platform's roots (plus `SSL_CERT_FILE` when it names a
//   file), TLS 1.2 or newer. Plain http only to a loopback host, so nothing leaves the computer unencrypted.
// - No redirect is followed and no proxy is read from the environment: a caller that follows redirects reads the answer.
// - Every request is bounded in time (the caller's wait) and every body in bytes (the caller's limit); a body past its
//   limit is refused, never cut short.
//
// Key Concepts:
// - `Ask`: one request. `Opened` and `Body`: an answer whose body is read as it arrives. `Upload`: a request body read from a
//   reader while it is sent (`Client::open_uploading`: an object store's PUT of a whole object), so memory holds a part,
//   never the whole.
// - `Body::read_waiting` lets a caller end its own waits for the body.
// - A kept connection is used again by the next request to its host, and dropped once it has sat unused `kept_idle_ms`.
// - reqwest, over the hyper the door already serves with, runs every request on one small runtime of its own; a caller
//   on any thread (a tokio worker too) waits for its answer on a channel, so no caller blocks inside that runtime.
//
// Security Considerations:
// - A credential header (`authorization`, `cookie`) is marked sensitive, so no debug print or log shows it.
// - A request names its own headers; `Host`, `Content-Length`, `Connection` and `Transfer-Encoding` are the client's
//   alone, so nothing an asker passes can split or reframe the request.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! The engine's one HTTP client (reqwest with rustls). See the header for what it guarantees.
use axum::body::Bytes;
use reqwest::{header::{HeaderMap, HeaderName, HeaderValue}, Method};
use rustls::pki_types::{pem::PemObject, CertificateDer};
use serde::Deserialize;
use std::{
    ffi::OsString,
    io::{self, Read},
    sync::{mpsc, Arc, Mutex, OnceLock, PoisonError},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use url::Url;

/// The settings DATA beside this code (`https/settings.json`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    worker_threads: usize,
    lookup_threads: usize,
    chunks_ahead: usize,
    kept_idle_ms: u64,
}

fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| serde_json::from_slice(include_bytes!("https/settings.json")).expect("https/settings.json is valid"))
}

/// The runtime every request runs on, made once and kept for the life of the process. Its blocking threads are the
/// system DNS lookups (hyper's resolver runs each on one), bounded by `lookup_threads`.
fn runtime() -> io::Result<&'static tokio::runtime::Runtime> {
    static RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
    let made = RUNTIME.get_or_init(|| {
        let settings = settings();
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(settings.worker_threads)
            .max_blocking_threads(settings.lookup_threads)
            .thread_name("https-client")
            .enable_all()
            .build()
            .map_err(|error| error.to_string())
    });
    crate::io_operation!(made.as_ref().map_err(|error| io::Error::other(format!("HTTP client runtime unavailable: {error}"))))
}

/// One request: its method (upper-case letters), its URL (https, or http to a loopback host), the headers it carries
/// besides the four the client writes itself, and its body.
pub(crate) struct Ask<'a> {
    pub method: &'a str,
    pub url: &'a Url,
    pub headers: &'a [(&'a str, &'a str)],
    pub body: &'a [u8],
}

/// An answer whose head has arrived; its body is read from `body` as it arrives.
pub(crate) struct Opened {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Body,
}

/// What the request's task tells its caller, in order: the head, then each chunk of the body, then its end.
enum Heard {
    Head(u16, Vec<(String, String)>),
    Chunk(Bytes),
    End,
    Failed(io::Error),
}

/// An answer's body, read as it arrives. The request's task reads at most `chunks_ahead` chunks before the reader takes
/// them. Each read waits at most `read_wait`, and never past `deadline` when there is one. Dropping the body ends the
/// request.
pub(crate) struct Body {
    heard: mpsc::Receiver<Heard>,
    credit: Arc<Semaphore>,
    task: tokio::task::AbortHandle,
    held: Bytes,
    deadline: Option<Instant>,
    read_wait: Duration,
    ended: bool,
}

impl Body {
}

impl Body {
    /// One read of at most `output.len()` bytes that waits at most `wait` for the next piece of the body: `Ok(None)`
    /// when none came in that time, so a caller that ends its own waits (a run's stop, a body that stops arriving:
    /// src/tool_runs/tools/network.rs) reads again or gives up; `Ok(Some(0))` once the body has ended.
    pub(crate) fn read_waiting(&mut self, output: &mut [u8], wait: Duration) -> io::Result<Option<usize>> {
        loop {
            if !self.held.is_empty() {
                let count = output.len().min(self.held.len());
                output[..count].copy_from_slice(&self.held.split_to(count));
                return Ok(Some(count));
            }
            if self.ended || output.is_empty() {
                return Ok(Some(0));
            }
            match self.heard.recv_timeout(wait) {
                Ok(Heard::Chunk(bytes)) => {
                    self.credit.add_permits(1);
                    self.held = bytes;
                }
                Ok(Heard::End) => self.ended = true,
                Ok(Heard::Failed(error)) => return crate::io_operation!(Err(error)),
                Ok(Heard::Head(..)) => return crate::io_operation!(Err(io::Error::new(io::ErrorKind::InvalidData, "a second answer head"))),
                Err(mpsc::RecvTimeoutError::Timeout) => return Ok(None),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return crate::io_operation!(Err(io::Error::new(io::ErrorKind::UnexpectedEof, "answer body ended early")));
                }
            }
        }
    }
}

impl Read for Body {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let wait = match self.deadline {
            Some(deadline) => deadline.saturating_duration_since(Instant::now()).min(self.read_wait),
            None => self.read_wait,
        };
        match crate::io_operation!(self.read_waiting(output, wait))? {
            Some(count) => Ok(count),
            None => crate::io_operation!(Err(io::Error::new(io::ErrorKind::TimedOut, "answer body not read in time"))),
        }
    }
}

impl Drop for Body {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The client: reqwest's, so a connection to a host is kept and used again by the next request to it.
#[derive(Clone)]
pub(crate) struct Client(reqwest::Client);

impl Client {
    /// The verifying client, on the TLS settings `tls_config` makes (one per root file, cloned after).
    pub(crate) fn verified() -> io::Result<Self> {
        let (_, client) = crate::io_operation!(trust())?;
        Ok(client)
    }

    /// The request `ask` names, refused when it breaks a rule of the header: its URL, method and headers.
    fn prepared(&self, ask: &Ask<'_>) -> io::Result<reqwest::RequestBuilder> {
        let refused = |what: &'static str| io::Error::new(io::ErrorKind::InvalidInput, what);
        let url = ask.url;
        let reachable = match url.scheme() {
            "https" => url.host().is_some(),
            "http" => url.host().is_some_and(|host| loopback(&host)),
            _ => false,
        };
        if !reachable || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return crate::io_operation!(Err(refused("not an https URL, nor an http URL of this computer")));
        }
        crate::io_operation!(self.framed(ask))
    }

    /// The request `ask` names, its URL already judged: refused when its method or a header breaks a rule of the header.
    fn framed(&self, ask: &Ask<'_>) -> io::Result<reqwest::RequestBuilder> {
        let refused = |what: &'static str| io::Error::new(io::ErrorKind::InvalidInput, what);
        let url = ask.url;
        if ask.method.is_empty() || !ask.method.bytes().all(|byte| byte.is_ascii_uppercase()) {
            return crate::io_operation!(Err(refused("invalid method")));
        }
        let method = crate::io_operation!(Method::from_bytes(ask.method.as_bytes()).map_err(|_| refused("invalid method")))?;
        let mut headers = HeaderMap::with_capacity(ask.headers.len());
        for (name, value) in ask.headers {
            let name = crate::io_operation!(HeaderName::from_bytes(name.as_bytes()).map_err(|_| refused("invalid header name")))?;
            if matches!(name.as_str(), "host" | "content-length" | "connection" | "transfer-encoding") {
                return crate::io_operation!(Err(refused("a header the client writes itself")));
            }
            let mut value = crate::io_operation!(HeaderValue::from_str(value).map_err(|_| refused("invalid header value")))?;
            if matches!(name.as_str(), "authorization" | "cookie") {
                value.set_sensitive(true);
            }
            headers.append(name, value);
        }
        let sends_body = !ask.body.is_empty() || matches!(method, Method::POST | Method::PUT | Method::PATCH);
        let request = self.0.request(method, url.clone()).headers(headers);
        Ok(if sends_body { request.body(ask.body.to_vec()) } else { request })
    }
}

/// Send `request` on the client's runtime: its answer is read by the returned body's task, which tells the head, then
/// each chunk of the body (at most `chunks_ahead` before the reader takes them), then the end. The request waits at most
/// `wait` for its head; each read of the body waits at most `wait` too.
fn started(request: reqwest::RequestBuilder, wait: Duration) -> io::Result<Body> {
    let runtime = crate::io_operation!(runtime())?;
    let (tell, heard) = mpsc::channel();
    let credit = Arc::new(Semaphore::new(settings().chunks_ahead));
    let pump = credit.clone();
    let task = runtime.spawn(async move {
        let mut answer = match tokio::time::timeout(wait, request.send()).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(error)) => {
                let _ = tell.send(Heard::Failed(transport_error(error)));
                return;
            }
            Err(_) => {
                let _ = tell.send(Heard::Failed(io::Error::new(io::ErrorKind::TimedOut, "no answer in time")));
                return;
            }
        };
        let headers = answer.headers().iter()
            .filter_map(|(name, value)| Some((name.as_str().to_owned(), String::from_utf8(value.as_bytes().to_vec()).ok()?)))
            .collect();
        if tell.send(Heard::Head(answer.status().as_u16(), headers)).is_err() {
            return;
        }
        loop {
            let Ok(permit) = pump.acquire().await else { return };
            permit.forget();
            let next = match answer.chunk().await {
                Ok(Some(chunk)) => Heard::Chunk(chunk),
                Ok(None) => Heard::End,
                Err(error) => Heard::Failed(transport_error(error)),
            };
            let last = !matches!(next, Heard::Chunk(_));
            if tell.send(next).is_err() || last {
                return;
            }
        }
    });
    Ok(Body { heard, credit, task: task.abort_handle(), held: Bytes::new(), deadline: None, read_wait: wait, ended: false })
}

/// The answer whose request `body`'s task sent, once its head has come, waiting for it in the waits `next_wait` gives
/// (each at most that long; `None` ends the wait as timed out, and the request with it, as the body is dropped). A
/// caller with one bound gives `one_wait`; a caller that ends its own waits (a run's stop or stall,
/// src/tool_runs/tools/network.rs through `Pinned::open_waiting`) gives them one at a time.
fn headed(body: Body, next_wait: &mut dyn FnMut() -> Option<Duration>) -> io::Result<Opened> {
    loop {
        let Some(wait) = next_wait() else {
            return crate::io_operation!(Err(io::Error::new(io::ErrorKind::TimedOut, "no answer in time")));
        };
        return match body.heard.recv_timeout(wait) {
            Ok(Heard::Head(status, headers)) => Ok(Opened { status, headers, body }),
            Ok(Heard::Failed(error)) => crate::io_operation!(Err(error)),
            Ok(Heard::Chunk(_) | Heard::End) => crate::io_operation!(Err(io::Error::new(io::ErrorKind::InvalidData, "a body before its head"))),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => crate::io_operation!(Err(io::Error::new(io::ErrorKind::BrokenPipe, "the request ended with no answer"))),
        };
    }
}

/// One wait of at most `wait`, then none: `headed` for a caller with one bound.
fn one_wait(wait: Duration) -> impl FnMut() -> Option<Duration> {
    let mut waited = false;
    move || (!std::mem::replace(&mut waited, true)).then_some(wait)
}

/// How every client is made: the TLS settings `config`, no redirect followed, no proxy from the environment, HTTP/1.1,
/// and a connection kept for the next request only while it has sat unused at most `kept_idle_ms` (a store closes an
/// idle connection on its own clock; one kept past that is dropped, never sent a request).
fn builder(config: &rustls::ClientConfig) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .use_preconfigured_tls(config.clone())
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .http1_only()
        .pool_idle_timeout(Duration::from_millis(settings().kept_idle_ms))
}

/// The TLS settings and the client made on them, for the root file `SSL_CERT_FILE` names now. One pair is made per root
/// file and cloned after: making one reads and decodes the whole platform trust store, which on a two-core place was most
/// of its CPU when computers posted to each other several times a second (hel1, 2026-11-12).
fn trust() -> io::Result<(Arc<rustls::ClientConfig>, Client)> {
    static LAST: Mutex<Option<(Option<OsString>, Arc<rustls::ClientConfig>, Client)>> = Mutex::new(None);
    let named = std::env::var_os("SSL_CERT_FILE");
    let mut last = LAST.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((roots, config, client)) = last.as_ref() {
        if *roots == named {
            return Ok((config.clone(), client.clone()));
        }
    }
    let extra = crate::io_operation!(named_roots(named.as_deref()))?;
    let mut roots = rustls::RootCertStore::empty();
    // A platform store often holds a few certificates rustls does not read (ancient roots with no extensions): those are
    // passed over, as every rustls user does, and the rest are trusted.
    let _ = roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    let config = crate::io_operation!(config_trusting(roots, extra))?;
    let client = crate::io_operation!(builder(&config).build().map(Client).map_err(io::Error::other))?;
    *last = Some((named, config.clone(), client.clone()));
    Ok((config, client))
}

/// Every certificate of the root file `named`, or none when no file is named.
fn named_roots(named: Option<&std::ffi::OsStr>) -> io::Result<Vec<CertificateDer<'static>>> {
    let Some(path) = named else { return Ok(Vec::new()) };
    let pem = crate::io_operation!(std::fs::read(path))?;
    crate::io_operation!(pem_roots(&pem))
}

/// rustls on ring, TLS 1.2 or 1.3, trusting `roots` and `extra`; refused when it would trust nothing.
fn config_trusting(mut roots: rustls::RootCertStore, extra: Vec<CertificateDer<'static>>) -> io::Result<Arc<rustls::ClientConfig>> {
    for root in extra {
        crate::io_operation!(roots.add(root).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)))?;
    }
    if roots.is_empty() {
        return crate::io_operation!(Err(io::Error::other("no root this computer trusts")));
    }
    let config = crate::io_operation!(rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

/// Every certificate of a PEM bundle, in order; text between certificates (a bundle's comments) is passed over. A bundle
/// with no certificate, or one that does not read, is refused.
fn pem_roots(pem: &[u8]) -> io::Result<Vec<CertificateDer<'static>>> {
    let roots = crate::io_operation!(CertificateDer::pem_slice_iter(pem).collect::<Result<Vec<_>, _>>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, format!("{error:?}"))))?;
    if roots.is_empty() {
        return crate::io_operation!(Err(io::Error::new(io::ErrorKind::InvalidData, "the root file holds no certificate")));
    }
    Ok(roots)
}

/// Whether `host` is this computer: `localhost` or a loopback address.
fn loopback(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Domain(name) => *name == "localhost",
        url::Host::Ipv4(address) => address.is_loopback(),
        url::Host::Ipv6(address) => address.is_loopback(),
    }
}

/// A transport failure as an I/O error of the kind it is (a timeout, a connection that did not open, an answer that is
/// not HTTP, anything else), with reqwest's error, and the TLS or socket error under it, as its source.
fn transport_error(error: reqwest::Error) -> io::Error {
    let kind = if error.is_timeout() {
        io::ErrorKind::TimedOut
    } else if error.is_connect() {
        io::ErrorKind::ConnectionRefused
    } else if not_http(&error) {
        io::ErrorKind::InvalidData
    } else {
        io::ErrorKind::Other
    };
    io::Error::new(kind, error)
}

// A request whose body is read from a reader while it is sent: an object store's PUT of a whole object, its length and
// hash known before the first byte (`account_files/objects.rs`). Memory holds one part of the body waiting for the
// connection (and what the connection buffers), never the whole.

/// A request body of exactly `length` bytes, read from `reader` while the request is sent.
pub(crate) struct Upload<'a> {
    pub length: u64,
    pub reader: &'a mut dyn Read,
}

/// The most bytes one read of an upload's reader asks for, so the most one part of its body holds.
const UPLOAD_PART_BYTES: usize = 64 * 1024;

impl Client {
    /// Send `ask` (whose own `body` is empty) with `upload` as its body, sized by its `length` (the client writes that
    /// length), and wait for the answer's head until `deadline`. The body is read on the caller's thread a part at a
    /// time, the next only once the connection has taken the last; each part waits at most `stall` to be taken (the
    /// first one's wait includes opening the connection), so a store that stops taking the body is given up after
    /// `stall`, while one that takes it steadily may take until `deadline`. A reader
    /// that ends before `length` bytes, or fails, ends the request unfinished: the server receives a short body, never a
    /// whole request. The answer's body is read within `deadline`.
    pub(crate) fn open_uploading(&self, ask: &Ask<'_>, upload: Upload<'_>, stall: Duration, deadline: Instant) -> io::Result<Opened> {
        if !ask.body.is_empty() {
            return crate::io_operation!(Err(io::Error::new(io::ErrorKind::InvalidInput, "a request sends one body")));
        }
        let request = crate::io_operation!(self.prepared(ask))?;
        let wait = deadline.saturating_duration_since(Instant::now());
        if upload.length == 0 {
            let mut body = crate::io_operation!(started(request, wait))?;
            body.deadline = Some(deadline);
            return crate::io_operation!(headed(body, &mut one_wait(wait)));
        }
        let (give, parts) = tokio::sync::mpsc::unbounded_channel();
        let (took, taken) = mpsc::channel();
        let sized = reqwest::Body::wrap(UploadBody { parts, took, left: upload.length });
        let mut body = crate::io_operation!(started(request.body(sized), wait))?;
        body.deadline = Some(deadline);
        crate::io_operation!(upload_parts(upload, &give, &taken, stall, deadline))?;
        drop(give);
        crate::io_operation!(headed(body, &mut one_wait(deadline.saturating_duration_since(Instant::now()))))
    }
}

/// Read `upload` a part at a time into `give`, each part only once the connection has taken the one before (told on
/// `taken`), so one part waits for the connection at most and a reader is read no faster than the server takes the
/// body. Each wait is at most `stall`, never past `deadline`. Done when every byte is given, or when the request stopped
/// taking its body (its answer, or its failure, then says why).
fn upload_parts(upload: Upload<'_>, give: &tokio::sync::mpsc::UnboundedSender<Bytes>, taken: &mpsc::Receiver<()>,
    stall: Duration, deadline: Instant) -> io::Result<()> {
    let mut given = 0u64;
    while given < upload.length {
        let mut part = vec![0u8; (upload.length - given).min(UPLOAD_PART_BYTES as u64) as usize];
        let read = match upload.reader.read(&mut part) {
            Ok(0) => return crate::io_operation!(Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the request body ended before its length"))),
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return crate::io_operation!(Err(error)),
        };
        part.truncate(read);
        if give.send(Bytes::from(part)).is_err() {
            return Ok(());
        }
        given += read as u64;
        match taken.recv_timeout(deadline.saturating_duration_since(Instant::now()).min(stall)) {
            Ok(()) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return crate::io_operation!(Err(io::Error::new(io::ErrorKind::TimedOut, "the request body was not taken in time")));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
    Ok(())
}

/// An upload's body as the connection takes it: the parts `upload_parts` gives, exactly `left` bytes more, its exact
/// size known (so the request carries its `Content-Length`). Parts that end before the length end the request with an
/// error, never with a short body taken as whole.
struct UploadBody {
    parts: tokio::sync::mpsc::UnboundedReceiver<Bytes>,
    took: mpsc::Sender<()>,
    left: u64,
}

impl http_body::Body for UploadBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(mut self: std::pin::Pin<&mut Self>, context: &mut std::task::Context<'_>)
        -> std::task::Poll<Option<Result<http_body::Frame<Bytes>, io::Error>>> {
        if self.left == 0 {
            return std::task::Poll::Ready(None);
        }
        let next = std::task::ready!(self.parts.poll_recv(context));
        std::task::Poll::Ready(Some(match next {
            Some(part) if part.len() as u64 <= self.left => {
                self.left -= part.len() as u64;
                let _ = self.took.send(());
                Ok(http_body::Frame::data(part))
            }
            Some(_) => Err(io::Error::new(io::ErrorKind::InvalidData, "more request body than its length")),
            None => Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the request body ended before its length")),
        }))
    }

    fn is_end_stream(&self) -> bool {
        self.left == 0
    }

    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(self.left)
    }
}

// ---- A client pinned to the addresses its caller judged (a Workshop run's egress, src/tool_runs/tools/network.rs) ----

/// Whether reqwest's `error` is an answer that is not HTTP: hyper could not read its head as an HTTP reply.
fn not_http(error: &reqwest::Error) -> bool {
    let mut source = std::error::Error::source(error);
    while let Some(under) = source {
        if under.downcast_ref::<hyper::Error>().is_some_and(hyper::Error::is_parse) {
            return true;
        }
        source = under.source();
    }
    false
}
