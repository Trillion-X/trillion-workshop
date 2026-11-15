// src/forwarder/websocket.rs
//
// Purpose: Adapt one bounded session message to each binary WebSocket message over an independently authenticated stream.
//
// Non-Negotiable Invariants:
// - Preserve binary message boundaries and the declared maximum wire size.
// - Validate the expected resource-connection path and host during upgrade.
// - WebSocket framing must not claim to establish TLS, host identity or resource rights.
//
// Key Concepts:
// - Tungstenite size configuration and binary session stream adaptation.
// - Resource-connection upgrade on caller-verified TLS.
//
// Security Considerations:
// - Require the caller to verify confidential transport and remote identity before using the client adapter.
// - Refuse unsupported or oversized wire input instead of materializing unbounded messages.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! One bounded session message per WebSocket binary message. The Mac and public
//! gateway can use the same adapter around independently authenticated WSS
//! streams. WebSocket framing does not establish TLS, host identity or rights.
use crate::refusal_cause::CodedError;
use serde::Deserialize;
use std::{io::{self, Read, Write}, sync::{Arc, OnceLock, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant, SystemTime}};
use tungstenite::{
    accept_hdr_with_config,
    client::client_with_config,
    http::{Response, StatusCode},
    protocol::{WebSocket, WebSocketConfig},
    Error, Message,
};

/// The most bytes one session message may carry: one account request in base64 inside its envelope
/// (`crate::mcp::carried_message_bytes`, from src/mcp/settings.json `request_bytes`).
fn max_message_bytes() -> usize {
    crate::mcp::carried_message_bytes()
}
/// One message on the wire: its four length bytes, then the message.
fn max_wire_bytes() -> usize {
    max_message_bytes() + 4
}
pub const RESOURCE_CONNECTION_PATH: &str = "/mcp/resource-connection";

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-:[]".contains(&byte))
}

fn websocket_config() -> WebSocketConfig {
    WebSocketConfig {
        write_buffer_size: 0,
        max_write_buffer_size: max_wire_bytes() * 2,
        max_message_size: Some(max_wire_bytes()),
        max_frame_size: Some(max_wire_bytes()),
        accept_unmasked_frames: false,
        ..WebSocketConfig::default()
    }
}

/// Whether `request` may become the Mac's resource connection: exactly one Host, `expected_host`; the exact path with no
/// scheme, authority or query in its target; no Origin, subprotocol or extension. This gate precedes the device
/// credential, whose independent current registration is checked by `Gateway` after upgrade. The one gate of both
/// upgrades: the door's (`ingress.rs`, on hyper's connection) and a raw stream's (`accept_resource_websocket`).
pub(crate) fn upgrade_admissible<B>(request: &tungstenite::http::Request<B>, expected_host: &str) -> bool {
    let mut hosts = request.headers().get_all("host").iter();
    let host_matches = hosts
        .next()
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host.eq_ignore_ascii_case(expected_host))
        && hosts.next().is_none();
    valid_host(expected_host)
        && request.method() == tungstenite::http::Method::GET
        && host_matches
        && request.uri().path() == RESOURCE_CONNECTION_PATH
        && request.uri().scheme().is_none()
        && request.uri().authority().is_none()
        && request.uri().query().is_none()
        && !request.headers().contains_key("origin")
        && !request.headers().contains_key("sec-websocket-protocol")
        && !request.headers().contains_key("sec-websocket-extensions")
}

/// The `Sec-WebSocket-Accept` answer to an upgrade's headers (RFC 6455 4.2.1: `Upgrade: websocket`, `Connection`
/// naming `upgrade`, version 13 and a key), or None when they do not ask for a WebSocket.
pub(crate) fn upgrade_accept(headers: &tungstenite::http::HeaderMap) -> Option<tungstenite::http::HeaderValue> {
    let names = |name: &str, token: &str| headers.get_all(name).iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| value.split(',').any(|part| part.trim().eq_ignore_ascii_case(token)));
    if !names("upgrade", "websocket") || !names("connection", "upgrade")
        || headers.get("sec-websocket-version").and_then(|value| value.to_str().ok()) != Some("13")
    {
        return None;
    }
    let key = headers.get("sec-websocket-key")?;
    tungstenite::http::HeaderValue::from_str(&tungstenite::handshake::derive_accept_key(key.as_bytes())).ok()
}

/// The server side of a resource connection whose upgrade answer was already sent (the door's: hyper made the upgrade
/// after `upgrade_admissible`), framed and bounded like every resource connection.
pub(crate) fn resource_websocket_upgraded<S: Read + Write>(stream: S) -> WebSocketStream<S> {
    WebSocketStream::new(WebSocket::from_raw_socket(stream, tungstenite::protocol::Role::Server, Some(websocket_config())))
}

/// Upgrade only the exact resource-connection endpoint (`upgrade_admissible`) on a caller-supplied stream with
/// deadlines that carries the HTTP upgrade itself.
pub fn accept_resource_websocket<S: Read + Write>(
    stream: S,
    expected_host: &str,
) -> Result<WebSocketStream<S>, CodedError<()>> {
    if !valid_host(expected_host) {
        return Err(CodedError::new(()));
    }
    let socket = accept_hdr_with_config(
        stream,
        |request: &tungstenite::handshake::server::Request, response| {
            if upgrade_admissible(request, expected_host) {
                Ok(response)
            } else {
                Err(Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(Some(String::new()))
                    .expect("static rejection response"))
            }
        },
        Some(websocket_config()),
    )
    .map_err(|failure| match failure {
        tungstenite::HandshakeError::Failure(Error::Io(error)) => CodedError::with_cause((),
            crate::refusal_cause::Caused::stored_cause(&error).unwrap_or_else(|| crate::cause!())),
        _ => CodedError::new(()),
    })?;
    Ok(WebSocketStream::new(socket))
}

/// Upgrade a Mac-initiated connection after its caller has verified TLS for
/// `expected_host` and set read/write deadlines on the underlying stream.
/// This performs the WebSocket handshake only; it never opens or verifies TLS.
pub fn upgrade_resource_websocket_on_verified_tls<S: Read + Write>(
    stream: S,
    expected_host: &str,
) -> Result<WebSocketStream<S>, CodedError<()>> {
    if !valid_host(expected_host) {
        return Err(CodedError::new(()));
    }
    let uri = format!("wss://{expected_host}{RESOURCE_CONNECTION_PATH}");
    let (socket, _) = client_with_config(uri, stream, Some(websocket_config())).map_err(|failure| match failure {
        tungstenite::HandshakeError::Failure(Error::Io(error)) => CodedError::with_cause((),
            crate::refusal_cause::Caused::stored_cause(&error).unwrap_or_else(|| crate::cause!())),
        _ => CodedError::new(()),
    })?;
    Ok(WebSocketStream::new(socket))
}

fn io_error(error: Error) -> io::Error {
    match error {
        Error::Io(error) => error,
        Error::ConnectionClosed | Error::AlreadyClosed => {
            io::Error::new(io::ErrorKind::UnexpectedEof, "WebSocket closed")
        }
        Error::Capacity(_) | Error::Protocol(_) => {
            io::Error::new(io::ErrorKind::InvalidData, "invalid WebSocket frame")
        }
        _ => io::Error::new(io::ErrorKind::Other, "WebSocket transport failed"),
    }
}

/// The settings DATA beside this code (`keepalive.json`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeepaliveSettings {
    #[serde(rename = "_what")]
    _what: String,
    ping_interval_ms: u64,
    ping_timeout_ms: u64,
    jitter_ms: u64,
    idle_tick_ms: u64,
}

fn keepalive_settings() -> &'static KeepaliveSettings {
    static SETTINGS: OnceLock<KeepaliveSettings> = OnceLock::new();
    SETTINGS.get_or_init(|| serde_json::from_slice(include_bytes!("keepalive.json")).expect("keepalive.json is valid"))
}

/// When an idle session pings and when it gives up. Every wait is measured on two clocks, the monotonic one and the wall
/// clock, and ends at whichever passes it first: the monotonic clock stops while the Mac sleeps and the wall clock does not
/// (Syncthing #10940: a ping timer on one clock and a receive timeout on the other left a dead link standing after sleep).
#[derive(Clone, Copy, Debug)]
pub struct Keepalive {
    pub interval: Duration,
    pub timeout: Duration,
    pub jitter: Duration,
    /// How often an idle read wakes (`DeadlineTcp::idle_tick`) so the clocks are looked at.
    pub tick: Duration,
}

impl Keepalive {
    /// The settings in `keepalive.json`.
    pub fn from_settings() -> Self {
        let settings = keepalive_settings();
        Self {
            interval: Duration::from_millis(settings.ping_interval_ms),
            timeout: Duration::from_millis(settings.ping_timeout_ms),
            jitter: Duration::from_millis(settings.jitter_ms),
            tick: Duration::from_millis(settings.idle_tick_ms),
        }
    }

    /// The wait before the next ping: the interval plus a spread taken from the clock's nanoseconds.
    fn next_wait(&self) -> Duration {
        let spread = u64::try_from(self.jitter.as_millis()).unwrap_or(0).max(1);
        let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |since| since.subsec_nanos());
        self.interval + Duration::from_millis(u64::from(nanos) % spread)
    }
}

/// One point in time on both clocks.
#[derive(Clone, Copy)]
struct Both(Instant, SystemTime);

impl Both {
    fn now() -> Self { Self(Instant::now(), SystemTime::now()) }
    /// Whether `wait` has passed on either clock (a clock that moved backwards has not passed it).
    fn passed(&self, wait: Duration) -> bool {
        self.0.elapsed() >= wait || self.1.elapsed().is_ok_and(|elapsed| elapsed >= wait)
    }
}

/// The keepalive's state on one session: when the next ping is due and the ping sent that nothing has answered.
struct KeepaliveState {
    settings: Keepalive,
    heard: Both,
    wait: Duration,
    pinged: Option<Both>,
}

/// Adapts an already upgraded WebSocket to the length-prefixed session ABI.
/// Its caller must establish confidential transport, verify the public host,
/// bound underlying I/O and authenticate the registration independently.
pub struct WebSocketStream<S> {
    socket: WebSocket<S>,
    incoming: Vec<u8>,
    read_at: usize,
    outgoing: Vec<u8>,
    // Only the Mac's deadline-bound TLS adapter supplies this phase marker.
    // A quiet connection may wait for its next message until session expiry;
    // the first transport/plaintext byte restores the ordinary I/O budget.
    idle_read: Option<Arc<AtomicBool>>,
    idle_ready: bool,
    keepalive: Option<KeepaliveState>,
}

impl<S: Read + Write> WebSocketStream<S> {
    pub fn new(mut socket: WebSocket<S>) -> Self {
        socket.set_config(|config| *config = websocket_config());
        Self {
            socket,
            incoming: Vec::new(),
            read_at: 0,
            outgoing: Vec::new(),
            idle_read: None,
            idle_ready: false,
            keepalive: None,
        }
    }

    /// Ping while idle: see `Keepalive`. The underlying stream must wake an idle read every `tick` with `WouldBlock`
    /// (`DeadlineTcp::idle_tick`).
    pub(crate) fn with_keepalive(mut self, settings: Keepalive) -> Self {
        self.keepalive = Some(KeepaliveState { settings, heard: Both::now(), wait: settings.next_wait(), pinged: None });
        self
    }

    /// Anything received shows the path is alive: the next ping waits a full interval again.
    fn heard(&mut self) {
        if let Some(state) = &mut self.keepalive {
            state.heard = Both::now();
            state.wait = state.settings.next_wait();
            state.pinged = None;
        }
    }

    /// An idle read woke with nothing received. Ping when the interval has passed with nothing heard; end the session
    /// when a ping has gone unanswered for the timeout.
    fn idle_tick(&mut self) -> io::Result<()> {
        let Some(state) = &mut self.keepalive else { return Ok(()) };
        if let Some(sent) = state.pinged {
            if sent.passed(state.settings.timeout) {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "forwarder did not answer a ping"));
            }
        } else if state.heard.passed(state.wait) {
            state.pinged = Some(Both::now());
            self.socket.send(Message::Ping(Vec::new())).map_err(io_error)?;
        }
        Ok(())
    }

    pub(crate) fn with_idle_read(mut self, idle_read: Arc<AtomicBool>) -> Self {
        self.idle_read = Some(idle_read);
        self
    }

    fn receive(&mut self) -> io::Result<bool> {
        loop {
            // The first message is the registration acknowledgement and keeps
            // its short admission timeout. Only admitted idle waits may grow.
            if self.idle_ready {
                if let Some(idle) = &self.idle_read { idle.store(true, Ordering::Release); }
            }
            let message = match self.socket.read() {
                // A wake with the stream still idle (no byte of a next message yet) is the idle tick; the same error with
                // a message begun is an ordinary I/O timeout and ends the session.
                Err(Error::Io(error)) if self.keepalive.is_some() && self.idle_ready
                    && self.idle_read.as_ref().is_some_and(|idle| idle.load(Ordering::Acquire))
                    && matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                    crate::io_operation!((self.idle_tick()).map_err(std::io::Error::from))?;
                    continue;
                }
                read => crate::io_operation!((read.map_err(io_error)).map_err(std::io::Error::from))?,
            };
            self.heard();
            match message {
                Message::Binary(bytes) => {
                    if bytes.len() < 5 || bytes.len() > max_wire_bytes() {
                        return crate::io_operation!(Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "invalid session message size",
                        )));
                    }
                    let len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
                    if len == 0 || len > max_message_bytes() || len + 4 != bytes.len() {
                        return crate::io_operation!(Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "invalid session message length",
                        )));
                    }
                    self.incoming = bytes.to_vec();
                    self.read_at = 0;
                    self.idle_ready = true;
                    return Ok(true);
                }
                Message::Ping(_) => crate::io_operation!((self.socket.flush().map_err(io_error)).map_err(std::io::Error::from))?,
                Message::Pong(_) => {}
                Message::Close(_) => return Ok(false),
                _ => {
                    return crate::io_operation!(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "binary session message required",
                    )))
                }
            }
        }
    }
}

impl<S: Read + Write> Read for WebSocketStream<S> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if self.read_at == self.incoming.len() && !crate::io_operation!((self.receive()).map_err(std::io::Error::from))? {
            return Ok(0);
        }
        let count = output.len().min(self.incoming.len() - self.read_at);
        output[..count].copy_from_slice(&self.incoming[self.read_at..self.read_at + count]);
        self.read_at += count;
        if self.read_at == self.incoming.len() {
            self.incoming.clear();
            self.read_at = 0;
        }
        Ok(count)
    }
}

impl<S: Read + Write> Write for WebSocketStream<S> {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        if self.outgoing.len().saturating_add(input.len()) > max_wire_bytes() {
            return crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "session message exceeds limit",
            )));
        }
        self.outgoing.extend_from_slice(input);
        Ok(input.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.outgoing.len() < 5 {
            return crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "incomplete session message",
            )));
        }
        let len = u32::from_be_bytes(self.outgoing[..4].try_into().unwrap()) as usize;
        if len == 0 || len > max_message_bytes() || len + 4 != self.outgoing.len() {
            return crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid session message length",
            )));
        }
        let message = std::mem::take(&mut self.outgoing);
        crate::io_operation!(self.socket.send(Message::Binary(message)).map_err(io_error))
    }
}
