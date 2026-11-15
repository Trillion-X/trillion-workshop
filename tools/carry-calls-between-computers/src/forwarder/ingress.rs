//! The door's listener: plain HTTP on the address its hosting owner gives, behind the front door's TLS terminator.
//!
//! A public computer's front door (Workshop tool start-a-computer, a layout's `caddy` row with `front_door`) terminates
//! TLS, makes a certificate on demand only when this door's `/origins/certificate` answers 200, and carries every request
//! here with its own Host. This module serves them with axum over hyper: the Gateway's whole route table (MCP, every
//! account path, the certificate ask, other origins) and the Mac's resource connection, a WebSocket upgrade made on
//! hyper's own connection and carried to the session as a bounded blocking stream (`UpgradedStream`). It parses no HTTP
//! and holds no TLS of its own.
use super::{answers::json, gateway::Gateway, websocket::RESOURCE_CONNECTION_PATH};
use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::Response,
    routing::get,
};
use hyper_util::rt::TokioIo;
use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    runtime::{Handle, Runtime},
    sync::Semaphore,
};

/// The most requests this door answers at once; one more is answered 503 rather than queued.
pub const MAX_ACTIVE_CONNECTIONS: usize = 64;
/// The longest one request may take, from its head to its answer; a resource connection's session has its own bounds.
const CONNECTION_LIFETIME: Duration = Duration::from_secs(120);
/// The longest one read or write of a resource connection waits before its session is admitted.
const SOCKET_IO_TIMEOUT: Duration = Duration::from_secs(5);

/// One listener serves the route table and the Mac's resource connection.
pub struct Ingress {
    listener: TcpListener,
    gateway: Arc<Gateway>,
    runtime: Runtime,
}

impl Ingress {
    /// The door on `listener` (the hosting owner's loopback address; the front door in front of it holds the TLS), for
    /// `gateway`, whose public Host is the front door's name.
    pub fn new(listener: TcpListener, gateway: Arc<Gateway>) -> io::Result<Self> {
        let expected_host = gateway.public_host();
        if expected_host.is_empty()
            || expected_host.len() > 255
            || !expected_host.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']'))
        {
            return crate::io_operation!(Err(io::Error::new(io::ErrorKind::InvalidInput, "a configured public host is required")));
        }
        let runtime = crate::io_operation!(tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .max_blocking_threads(32)
            .thread_name("door")
            .enable_all()
            .build())?;
        Ok(Self { listener, gateway, runtime })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        crate::io_operation!(self.listener.local_addr())
    }

    /// Serve until `shutdown` becomes true, then stop taking connections and let the ones in progress finish.
    pub fn serve(self, shutdown: Arc<AtomicBool>) -> io::Result<()> {
        let Self { listener, gateway, runtime } = self;
        let routes = crate::io_operation!(gateway.http_route_table().map_err(|refusal| {
            let cause = crate::refusal_cause::Caused::stored_cause(&refusal).unwrap_or_else(|| crate::cause!());
            crate::refusal_cause::locate_io(io::Error::other("door route table unavailable"), cause)
        }))?;
        let active = Arc::new(Semaphore::new(MAX_ACTIVE_CONNECTIONS));
        let router = axum::Router::new()
            .route(RESOURCE_CONNECTION_PATH, get(resource_connection))
            .with_state(gateway.clone())
            .merge(routes.layer(axum::middleware::from_fn_with_state(gateway, own_host)))
            .layer(axum::middleware::from_fn_with_state(active, bounded));
        crate::io_operation!(listener.set_nonblocking(true))?;
        crate::io_operation!(runtime.block_on(async move {
            let listener = crate::io_operation!(tokio::net::TcpListener::from_std(listener))?;
            let stopped = async move {
                while !shutdown.load(Ordering::Acquire) {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            };
            crate::io_operation!(axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(stopped)
                .await)
        }))
    }
}

/// A refusal of the door's own, with its source cause (`answers::json`).
fn refused(status: StatusCode, cause: crate::refusal_cause::Cause) -> Response {
    crate::quiet_eprintln!("door-refusal status={} cause={cause}", status.as_u16());
    json(status, &serde_json::json!({"error": format!("HTTP request refused ({})", status.as_u16()), "cause": cause.id()}),
        &[("cache-control", "no-store")])
}

/// Every request: at most `MAX_ACTIVE_CONNECTIONS` at once (one more is answered 503), each answered within
/// `CONNECTION_LIFETIME` (or 503). A resource connection's session runs on after its upgrade answer, outside this bound.
async fn bounded(State(active): State<Arc<Semaphore>>, request: Request, next: Next) -> Response {
    let Ok(_permit) = active.try_acquire() else {
        return refused(StatusCode::SERVICE_UNAVAILABLE, crate::cause!());
    };
    match tokio::time::timeout(CONNECTION_LIFETIME, next.run(request)).await {
        Ok(response) => response,
        Err(_) => refused(StatusCode::SERVICE_UNAVAILABLE, crate::cause!()),
    }
}

/// The door's own Host, or another origin a live account names (the front door carries a person's own domain here with
/// its own Host): any other Host, or none, is misdirected (421).
async fn own_host(State(gateway): State<Arc<Gateway>>, request: Request, next: Next) -> Response {
    let mut hosts = request.headers().get_all(header::HOST).iter();
    let host = hosts.next().and_then(|value| value.to_str().ok()).filter(|_| hosts.next().is_none()).map(str::to_owned);
    let admitted = match host {
        Some(host) if host.eq_ignore_ascii_case(gateway.public_host()) => true,
        Some(host) => {
            let gateway = gateway.clone();
            tokio::task::spawn_blocking(move || gateway.names_origin(&host)).await.unwrap_or(false)
        }
        None => false,
    };
    if !admitted {
        return refused(StatusCode::MISDIRECTED_REQUEST, crate::cause!());
    }
    next.run(request).await
}

/// The Mac's resource connection: the exact upgrade gate (`websocket::upgrade_admissible`: Host, path, no query, Origin,
/// subprotocol or extension), then hyper's own upgrade. The connection is carried to the session as a bounded blocking
/// stream, and the Gateway admits it (`admit_mac_upgraded`: a pending slot, then the device credential) on a blocking
/// thread, as the session's own I/O is blocking.
async fn resource_connection(
    State(gateway): State<Arc<Gateway>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut request: Request,
) -> Response {
    if !super::websocket::upgrade_admissible(&request, gateway.public_host()) {
        return refused(StatusCode::FORBIDDEN, crate::cause!());
    }
    let Some(accept) = super::websocket::upgrade_accept(request.headers()) else {
        return refused(StatusCode::BAD_REQUEST, crate::cause!());
    };
    let upgrade = hyper::upgrade::on(&mut request);
    let handle = Handle::current();
    tokio::spawn(async move {
        let Ok(upgraded) = upgrade.await else { return };
        let stream = UpgradedStream { io: TokioIo::new(upgraded), handle, bounds: StreamBounds::new() };
        let bounds = stream.bounds.clone();
        let peer = peer.to_string();
        let _ = tokio::task::spawn_blocking(move || match gateway.admit_mac_upgraded(stream, &peer) {
            Ok(_) => bounds.admitted_session(),
            Err(error) => crate::quiet_eprintln!("door-refusal status=101 cause={}", error.cause()),
        })
        .await;
    });
    let mut answer = Response::new(Body::empty());
    *answer.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let headers = answer.headers_mut();
    headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    headers.insert(header::SEC_WEBSOCKET_ACCEPT, accept);
    answer
}

/// The bounds of one resource connection's I/O, shared so its admitted session can widen them (`admitted_session`): its
/// deadline (milliseconds after `base`) and the most one read may wait.
#[derive(Clone, Debug)]
struct StreamBounds {
    base: Instant,
    deadline_ms: Arc<AtomicU64>,
    read_wait_ms: Arc<AtomicU64>,
}
impl StreamBounds {
    fn new() -> Self {
        Self {
            base: Instant::now(),
            deadline_ms: Arc::new(AtomicU64::new(CONNECTION_LIFETIME.as_millis() as u64)),
            read_wait_ms: Arc::new(AtomicU64::new(SOCKET_IO_TIMEOUT.as_millis() as u64)),
        }
    }

    fn deadline(&self) -> Instant {
        self.base + Duration::from_millis(self.deadline_ms.load(Ordering::Acquire))
    }

    /// A Mac's resource session was admitted on this connection: from now on a read waits for the computer's answer
    /// until the longest message deadline (`DEADLINE_WINDOW_MS`), not `SOCKET_IO_TIMEOUT`, and the stream lasts the
    /// session's longest life from now (`session::MAX_SESSION_LIFE_MS`; a grant never outlives it). Before, a Mac that
    /// took more than 5 s to answer lost its session and its operation read as an unknown outcome although its
    /// deadline was 30 s; and the stream's deadline, counted from accept, could end before the session's own lifetime
    /// (counted from admission), so a message sent then failed before its first byte left, as unknown. The door only
    /// reads this stream for an answer to a message it sent, so a wider read wait never holds an idle session. Writes
    /// keep `SOCKET_IO_TIMEOUT`.
    fn admitted_session(&self) {
        let window = u64::try_from(super::DEADLINE_WINDOW_MS).unwrap_or(0);
        let life = u64::try_from(super::session::MAX_SESSION_LIFE_MS).unwrap_or(0);
        let now = u64::try_from(self.base.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.read_wait_ms.fetch_max(window, Ordering::AcqRel);
        self.deadline_ms.fetch_max(now.saturating_add(life), Ordering::AcqRel);
    }

    /// The wait one read or write may take now: at most `most`, never past the deadline.
    fn wait_within(&self, most: Duration) -> io::Result<Duration> {
        let left = self.deadline().saturating_duration_since(Instant::now());
        if left.is_zero() {
            return crate::io_operation!(Err(io::Error::new(io::ErrorKind::TimedOut, "door connection expired")));
        }
        Ok(left.min(most))
    }
}

/// hyper's upgraded connection as the blocking stream the session reads and writes, each read or write bounded by
/// `StreamBounds` on the door's runtime. Used only from blocking threads (the admission's and the session's).
struct UpgradedStream {
    io: TokioIo<hyper::upgrade::Upgraded>,
    handle: Handle,
    bounds: StreamBounds,
}
/// One read or write of `step` on the door's runtime, waiting at most `most` and never past the bounds' deadline.
fn bounded_io<T>(handle: &Handle, bounds: &StreamBounds, most: Duration, step: impl std::future::Future<Output = io::Result<T>>)
    -> io::Result<T> {
    let wait = crate::io_operation!(bounds.wait_within(most))?;
    crate::io_operation!(handle.block_on(tokio::time::timeout(wait, step))
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "door connection read or write timed out"))
        .and_then(|result| result))
}
impl Read for UpgradedStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let most = Duration::from_millis(self.bounds.read_wait_ms.load(Ordering::Acquire));
        crate::io_operation!(bounded_io(&self.handle, &self.bounds, most, self.io.read(buffer)))
    }
}
impl Write for UpgradedStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        crate::io_operation!(bounded_io(&self.handle, &self.bounds, SOCKET_IO_TIMEOUT, self.io.write(buffer)))
    }
    fn flush(&mut self) -> io::Result<()> {
        crate::io_operation!(bounded_io(&self.handle, &self.bounds, SOCKET_IO_TIMEOUT, self.io.flush()))
    }
}

#[cfg(test)]
mod tests;
