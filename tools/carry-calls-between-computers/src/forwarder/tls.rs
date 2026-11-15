//! Mac outbound WSS transport. DNS chooses the address; TLS verifies the
//! configured public host before the resource WebSocket or device credential.
use super::session::MAX_SESSION_LIFE_MS;
use super::websocket::{upgrade_resource_websocket_on_verified_tls, Keepalive, WebSocketStream};
use rustls::{pki_types::ServerName, ClientConfig, ClientConnection, StreamOwned};
use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    sync::{mpsc, OnceLock, Arc, atomic::{AtomicBool, Ordering}},
    thread,
    time::{Duration, Instant},
};

type Lookup = (String, u16, mpsc::Sender<io::Result<Vec<SocketAddr>>>);

/// One reusable worker bounds outstanding system DNS calls. A stuck OS lookup
/// cannot create an unbounded collection of resolver threads on reconnect.
struct Resolver {
    requests: mpsc::SyncSender<Lookup>,
}

impl Resolver {
    fn new(
        lookup: impl Fn(&str, u16) -> io::Result<Vec<SocketAddr>> + Send + 'static,
    ) -> io::Result<Self> {
        let (requests, pending) = mpsc::sync_channel::<Lookup>(1);
        crate::io_operation!((thread::Builder::new()
            .name("resource-dns".into())
            .spawn(move || {
                while let Ok((host, port, answer)) = pending.recv() {
                    let _ = answer.send(lookup(&host, port));
                }
            })).map_err(std::io::Error::from))?;
        Ok(Self { requests })
    }

    #[cfg(test)]
    fn resolve(&self, host: &str, port: u16, deadline: Instant) -> io::Result<Vec<SocketAddr>> {
        crate::io_operation!(self.resolve_while(host, port, deadline, None))
    }

    fn resolve_while(&self, host: &str, port: u16, deadline: Instant,
        cancelled: Option<&AtomicBool>) -> io::Result<Vec<SocketAddr>> {
        crate::io_operation!((current_connection(cancelled)).map_err(std::io::Error::from))?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return crate::io_operation!(Err(expired_connection()));
        }
        let (answer, reply) = mpsc::channel();
        // One lookup runs and one waits (the bounded queue): a caller that finds both taken waits its turn, up to its own
        // deadline, as it waits for the answer below. Before, it was refused at once ("DNS resolver busy"), so of the
        // messages a computer sends its other computers at once (`Copies::send_all`; each post resolves the forwarder),
        // all but two were never sent: a sign-in change then missed a computer that may answer, and the writer gave its
        // turn up (measured 2026-11-08, tests/computer_forwarder.rs
        // `a_stopped_computer_hands_its_writer_turn_to_another_whole_computer_before_its_term_runs_out`: posts refused
        // within 100 ms as WouldBlock, and A held no turn to hand over when it stopped).
        let mut lookup = (host.into(), port, answer);
        loop {
            match self.requests.try_send(lookup) {
                Ok(()) => break,
                Err(mpsc::TrySendError::Full(waiting)) => {
                    crate::io_operation!((current_connection(cancelled)).map_err(std::io::Error::from))?;
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return crate::io_operation!(Err(expired_connection()));
                    }
                    thread::sleep(remaining.min(Duration::from_millis(1)));
                    lookup = waiting;
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    return crate::io_operation!(Err(io::Error::new(io::ErrorKind::BrokenPipe, "DNS resolver unavailable")));
                }
            }
        }
        let addresses = loop {
            crate::io_operation!((current_connection(cancelled)).map_err(std::io::Error::from))?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() { return crate::io_operation!(Err(expired_connection())); }
            let wait = if cancelled.is_some() { remaining.min(Duration::from_millis(20)) } else { remaining };
            match reply.recv_timeout(wait) {
                Ok(result) => break crate::io_operation!((result).map_err(std::io::Error::from))?,
                Err(mpsc::RecvTimeoutError::Timeout) if cancelled.is_some() => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => return crate::io_operation!(Err(expired_connection())),
                Err(mpsc::RecvTimeoutError::Disconnected) => return crate::io_operation!(Err(io::Error::new(io::ErrorKind::BrokenPipe, "DNS resolver unavailable"))),
            }
        };
        crate::io_operation!((current_connection(cancelled)).map_err(std::io::Error::from))?;
        if Instant::now() >= deadline {
            return crate::io_operation!(Err(expired_connection()));
        }
        Ok(addresses)
    }
}

fn resolve_public_host_while(host: &str, port: u16, deadline: Instant,
    cancelled: Option<&AtomicBool>) -> io::Result<Vec<SocketAddr>> {
    static RESOLVER: OnceLock<io::Result<Resolver>> = OnceLock::new();
    let resolver = RESOLVER.get_or_init(|| {
        Resolver::new(|host, port| {
            (host, port)
                .to_socket_addrs()
                .map(|addresses| addresses.collect())
        })
    });
    crate::io_operation!(crate::io_operation!((resolver
        .as_ref()
        .map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::other("DNS resolver unavailable"), _refusal_io_cause) })).map_err(std::io::Error::from))?
        .resolve_while(host, port, deadline, cancelled))
}

fn current_connection(cancelled: Option<&AtomicBool>) -> io::Result<()> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        crate::io_operation!(Err(io::Error::new(io::ErrorKind::Interrupted, "resource connection cancelled")))
    } else { Ok(()) }
}

/// Socket I/O stops at a monotonic connection deadline even if a peer keeps
/// sending partial TLS, WebSocket or session messages.
pub struct DeadlineTcp {
    tcp: TcpStream,
    deadline: Instant,
    io_timeout: Duration,
    cancelled: Option<Arc<AtomicBool>>,
    idle_read: Option<Arc<AtomicBool>>,
    /// With a keepalive, an idle read returns `WouldBlock` this often instead of waiting out the connection, so the
    /// WebSocket layer can ping and look at its clocks (`websocket::Keepalive`).
    idle_tick: Option<Duration>,
}

impl DeadlineTcp {
    fn new(tcp: TcpStream, io_timeout: Duration, deadline: Instant) -> io::Result<Self> {
        if Instant::now() >= deadline {
            return crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "resource connection expired",
            )));
        }
        Ok(Self {
            tcp,
            deadline,
            io_timeout,
            cancelled: None,
            idle_read: None,
            idle_tick: None,
        })
    }

    fn remaining(&self) -> io::Result<Duration> {
        crate::io_operation!((current_connection(self.cancelled.as_deref())).map_err(std::io::Error::from))?;
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "resource connection expired",
            )))
        } else {
            Ok(remaining.min(self.io_timeout))
        }
    }

    fn finish(&self, result: io::Result<usize>) -> io::Result<usize> {
        crate::io_operation!((current_connection(self.cancelled.as_deref())).map_err(std::io::Error::from))?;
        if Instant::now() >= self.deadline {
            crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "resource connection expired",
            )))
        } else {
            crate::io_operation!(result)
        }
    }
}

impl Read for DeadlineTcp {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        // A connected Mac waits quietly for the next WebSocket message. Once
        // any TLS record arrives the ordinary I/O timeout applies again, so a
        // peer cannot extend a partial message by withholding its remaining bytes.
        let idle = self.idle_read.as_ref().is_some_and(|flag| flag.load(Ordering::Acquire));
        let until = if idle { self.deadline } else {
            crate::io_operation!((Instant::now().checked_add(crate::io_operation!((self.remaining()).map_err(std::io::Error::from))?).ok_or_else(expired_connection)).map_err(std::io::Error::from))?
        };
        let tick_at = self.idle_tick.filter(|_| idle).map(|tick| Instant::now() + tick);
        loop {
            let remaining = crate::io_operation!((self.remaining()).map_err(std::io::Error::from))?.min(until.saturating_duration_since(Instant::now()));
            if remaining.is_zero() { return crate::io_operation!(Err(expired_connection())); }
            let mut wait = if self.cancelled.is_some() { remaining.min(Duration::from_millis(20)) } else { remaining };
            if let Some(tick_at) = tick_at {
                if Instant::now() >= tick_at { return Err(io::Error::new(io::ErrorKind::WouldBlock, "idle tick")); }
                wait = wait.min(tick_at.saturating_duration_since(Instant::now()).max(Duration::from_millis(1)));
            }
            crate::io_operation!((self.tcp.set_read_timeout(Some(wait))).map_err(std::io::Error::from))?;
            let result = crate::io_operation!(self.tcp.read(output));
            if result.as_ref().is_ok_and(|count| *count > 0) {
                if let Some(idle) = &self.idle_read { idle.store(false, Ordering::Release); }
            }
            if (self.cancelled.is_some() || idle) && result.as_ref().is_err_and(|error|
                matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted)) { continue; }
            return crate::io_operation!(self.finish(result));
        }
    }
}

/// Clears the idle phase on plaintext returned from TLS's own read buffer too.
/// Without this layer a coalesced partial WebSocket message could retain the
/// longer idle budget even though its first bytes had already been consumed.
pub struct IdleBoundedTls {
    inner: StreamOwned<ClientConnection, DeadlineTcp>,
    idle_read: Arc<AtomicBool>,
    framed: Arc<AtomicBool>,
    header: Vec<u8>,
    payload_left: Option<u64>,
}
impl Read for IdleBoundedTls {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() { return Ok(0); }
        // Do not let tungstenite prefetch the next message while returning the
        // previous message. Otherwise a buffered partial next message would be
        // mistaken for an idle wait. Its OWN public header parser supplies the
        // boundary; payloads still move in bulk and all protocol checks remain
        // in the original WebSocket owner. HTTP upgrade reads are unchanged.
        let framed = self.framed.load(Ordering::Acquire);
        let limit = if framed {
            self.payload_left.map_or(1, |left| output.len().min(left as usize))
        } else { output.len() };
        let result = crate::io_operation!(self.inner.read(&mut output[..limit]));
        if result.as_ref().is_ok_and(|count| *count > 0) {
            self.idle_read.store(false, Ordering::Release);
        }
        if framed {
            if let Ok(count) = &result {
                if let Some(left) = &mut self.payload_left {
                    *left -= *count as u64;
                    if *left == 0 { self.payload_left = None; self.header.clear(); }
                } else if *count > 0 {
                    self.header.extend_from_slice(&output[..*count]);
                    if self.header.len() > 14 { return crate::io_operation!(Err(io::Error::new(io::ErrorKind::InvalidData, "invalid WebSocket header"))); }
                    let mut cursor = io::Cursor::new(self.header.as_slice());
                    let parsed = crate::io_operation!((tungstenite::protocol::frame::FrameHeader::parse(&mut cursor)
                        .map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::new(io::ErrorKind::InvalidData, "invalid WebSocket header"), _refusal_io_cause) })).map_err(std::io::Error::from))?;
                    if let Some((_, size)) = parsed {
                        if size == 0 { self.header.clear(); }
                        else { self.payload_left = Some(size); }
                    }
                }
            }
        }
        crate::io_operation!(result)
    }
}
impl Write for IdleBoundedTls {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> { crate::io_operation!(self.inner.write(input)) }
    fn flush(&mut self) -> io::Result<()> { crate::io_operation!(self.inner.flush()) }
}

impl Write for DeadlineTcp {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        let until = crate::io_operation!((Instant::now().checked_add(crate::io_operation!((self.remaining()).map_err(std::io::Error::from))?).ok_or_else(expired_connection)).map_err(std::io::Error::from))?;
        loop {
            let remaining = crate::io_operation!((self.remaining()).map_err(std::io::Error::from))?.min(until.saturating_duration_since(Instant::now()));
            if remaining.is_zero() { return crate::io_operation!(Err(expired_connection())); }
            let wait = if self.cancelled.is_some() { remaining.min(Duration::from_millis(20)) } else { remaining };
            crate::io_operation!((self.tcp.set_write_timeout(Some(wait))).map_err(std::io::Error::from))?;
            let result = crate::io_operation!(self.tcp.write(input));
            if self.cancelled.is_some() && result.as_ref().is_err_and(|error|
                matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted)) { continue; }
            return crate::io_operation!(self.finish(result));
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        crate::io_operation!((self.remaining()).map_err(std::io::Error::from))?;
        crate::io_operation!((self.tcp.flush()).map_err(std::io::Error::from))?;
        crate::io_operation!(self.remaining().map(|_| ()))
    }
}

fn valid_dns_host(host: &str) -> bool {
    host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn valid_parameters(
    host: &str,
    port: u16,
    connect_timeout: Duration,
    io_timeout: Duration,
) -> bool {
    valid_dns_host(host) && port != 0 && !connect_timeout.is_zero() && !io_timeout.is_zero()
}

/// TLS over `socket` for `host`, verified by `config` (the computer's one TLS settings, `crate::https::tls_config`)
/// before any byte of the WebSocket upgrade is written: the handshake runs to its end here.
fn verified_tls<S: Read + Write>(config: &Arc<ClientConfig>, host: &str, socket: S) -> io::Result<StreamOwned<ClientConnection, S>> {
    let name = crate::io_operation!(ServerName::try_from(host.to_owned())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid public host")))?;
    let connection = crate::io_operation!(ClientConnection::new(config.clone(), name).map_err(io::Error::other))?;
    let mut stream = StreamOwned::new(connection, socket);
    while stream.conn.is_handshaking() {
        crate::io_operation!(stream.conn.complete_io(&mut stream.sock))?;
    }
    Ok(stream)
}

fn expired_connection() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "resource connection expired")
}

#[cfg(test)]
fn upgrade_on_address(
    address: SocketAddr,
    host: &str,
    port: u16,
    connect_timeout: Duration,
    io_timeout: Duration,
    deadline: Instant,
    config: &Arc<ClientConfig>,
) -> io::Result<WebSocketStream<IdleBoundedTls>> {
    crate::io_operation!(upgrade_on_address_while(address, host, port, connect_timeout, io_timeout, deadline, config, None, Keepalive::from_settings()))
}

fn upgrade_on_address_while(
    address: SocketAddr, host: &str, port: u16, connect_timeout: Duration,
    io_timeout: Duration, deadline: Instant, config: &Arc<ClientConfig>,
    cancelled: Option<Arc<AtomicBool>>, keepalive: Keepalive,
) -> io::Result<WebSocketStream<IdleBoundedTls>> {
    crate::io_operation!((current_connection(cancelled.as_deref())).map_err(std::io::Error::from))?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return crate::io_operation!(Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "resource connection expired",
        )));
    }
    let tcp = crate::io_operation!((TcpStream::connect_timeout(&address, connect_timeout.min(remaining))).map_err(std::io::Error::from))?;
    crate::io_operation!((current_connection(cancelled.as_deref())).map_err(std::io::Error::from))?;
    let mut tcp = crate::io_operation!((DeadlineTcp::new(tcp, io_timeout, deadline)).map_err(std::io::Error::from))?;
    tcp.cancelled = cancelled.clone();
    let idle_read = Arc::new(AtomicBool::new(false));
    tcp.idle_read = Some(idle_read.clone());
    tcp.idle_tick = Some(keepalive.tick);
    let connected = verified_tls(config, host, tcp);
    crate::io_operation!((current_connection(cancelled.as_deref())).map_err(std::io::Error::from))?;
    let tls = crate::io_operation!((connected.map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io({
        if Instant::now() >= deadline {
            expired_connection()
        } else {
            io::Error::new(io::ErrorKind::PermissionDenied, "TLS peer not verified")
        }
    }, _refusal_io_cause) })).map_err(std::io::Error::from))?;
    let authority = if port == 443 {
        host.to_owned()
    } else {
        format!("{host}:{port}")
    };
    let framed = Arc::new(AtomicBool::new(false));
    let tls = IdleBoundedTls { inner: tls, idle_read: idle_read.clone(),
        framed: framed.clone(), header: Vec::with_capacity(14), payload_left: None };
    let upgraded = upgrade_resource_websocket_on_verified_tls(tls, &authority)
        .map(|stream| { framed.store(true, Ordering::Release); stream.with_idle_read(idle_read).with_keepalive(keepalive) });
    crate::io_operation!((current_connection(cancelled.as_deref())).map_err(std::io::Error::from))?;
    crate::io_operation!(upgraded.map_err(|failure| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&failure).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io({
        if Instant::now() >= deadline {
            expired_connection()
        } else {
            io::Error::new(io::ErrorKind::InvalidData, crate::refusal_cause::CodedError::with_cause("resource WebSocket refused", failure.cause()))
        }
    }, _refusal_io_cause) }))
}

/// Connect the Mac to the configured public DNS host and resource endpoint.
/// The platform trust store verifies the peer and hostname; TLS 1.2 or newer
/// is required. No credential is written until TLS and WebSocket both succeed.
/// The caller supplies the credential to `connect_mac_session` afterward.
pub fn connect_mac_resource_wss(
    host: &str,
    port: u16,
    connect_timeout: Duration,
    io_timeout: Duration,
) -> io::Result<WebSocketStream<IdleBoundedTls>> {
    crate::io_operation!(connect_mac_resource_wss_inner(host, port, connect_timeout, io_timeout, None, None))
}

/// Same verified WSS owner, additionally bounded by the native parent's
/// lifetime. Credentials still enter only after TLS and WebSocket admission.
pub(crate) fn connect_mac_resource_wss_while(
    host: &str, port: u16, connect_timeout: Duration, io_timeout: Duration,
    cancelled: Arc<AtomicBool>, deadline: Instant,
) -> io::Result<WebSocketStream<IdleBoundedTls>> {
    // A private native host joins this one I/O worker on parent loss. Limit a
    // noninterruptible OS connect attempt; DNS and socket I/O are cancellable.
    if connect_timeout > Duration::from_secs(1) { return crate::io_operation!(Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid native connection timeout"))); }
    crate::io_operation!(connect_mac_resource_wss_inner(host, port, connect_timeout, io_timeout, Some(cancelled), Some(deadline)))
}

fn connect_mac_resource_wss_inner(
    host: &str, port: u16, connect_timeout: Duration, io_timeout: Duration,
    cancelled: Option<Arc<AtomicBool>>, requested_deadline: Option<Instant>,
) -> io::Result<WebSocketStream<IdleBoundedTls>> {
    crate::io_operation!((current_connection(cancelled.as_deref())).map_err(std::io::Error::from))?;
    if !valid_parameters(host, port, connect_timeout, io_timeout) {
        return crate::io_operation!(Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid public resource endpoint",
        )));
    }
    let deadline = crate::io_operation!((Instant::now()
        .checked_add(Duration::from_millis(MAX_SESSION_LIFE_MS as u64))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid deadline"))).map_err(std::io::Error::from))?;
    let deadline = requested_deadline.map_or(deadline, |requested| requested.min(deadline));
    if Instant::now() >= deadline { return crate::io_operation!(Err(expired_connection())); }
    let config = crate::io_operation!(crate::https::tls_config())?;
    let addresses = crate::io_operation!((resolve_public_host_while(host, port, deadline, cancelled.as_deref())).map_err(std::io::Error::from))?;
    let mut last_error = io::Error::new(
        io::ErrorKind::AddrNotAvailable,
        "public host has no address",
    );
    for address in addresses {
        crate::io_operation!((current_connection(cancelled.as_deref())).map_err(std::io::Error::from))?;
        match upgrade_on_address_while(
            address,
            host,
            port,
            connect_timeout,
            io_timeout,
            deadline,
            &config,
            cancelled.clone(),
            Keepalive::from_settings(),
        ) {
            Ok(stream) => return Ok(stream),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut
                        | io::ErrorKind::ConnectionRefused
                        | io::ErrorKind::NetworkUnreachable
                        | io::ErrorKind::HostUnreachable
                ) =>
            {
                last_error = error;
            }
            Err(error) => return crate::io_operation!(Err(error)),
        }
    }
    crate::io_operation!(Err(last_error))
}

#[cfg(test)]
pub(crate) mod fixture {
    use native_tls::Identity;
    use rustls::ClientConfig;
    use std::sync::Arc;
    use std::{fs, path::Path, process::Command};

    fn openssl(folder: &Path, args: &[&str]) {
        let result = Command::new("openssl")
            .env("OPENSSL_CONF", folder.join("openssl.cnf"))
            .args(args)
            .current_dir(folder)
            .output()
            .expect("OpenSSL fixture generator is required");
        assert!(result.status.success(), "OpenSSL fixture generation failed");
    }

    /// A synthetic server identity for `mcp.example.test` (its authority's certificate kept as `ca.pem` in `folder`), and
    /// TLS settings that trust that authority alone.
    pub(crate) fn identity(folder: &Path) -> (Identity, Arc<ClientConfig>) {
        // Generator configuration is part of this fixture. A machine's
        // default req.x509_extensions can otherwise duplicate -addext entries
        // (observed with OpenSSL1.1.1), producing an invalid CA certificate.
        fs::write(folder.join("openssl.cnf"),
            "[req]\ndistinguished_name=dn\n[dn]\n").unwrap();
        let ca_suffix = folder
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| {
                name.bytes()
                    .filter(u8::is_ascii_alphanumeric)
                    .map(char::from)
                    .collect::<String>()
            })
            .filter(|suffix| !suffix.is_empty())
            .expect("temporary fixture directory must have an ASCII basename");
        let ca_subject = format!("/CN=Local Resource Test CA {ca_suffix}");
        openssl(
            folder,
            &[
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-sha256",
                "-keyout",
                "ca.key",
                "-out",
                "ca.pem",
                "-subj",
                &ca_subject,
                "-addext",
                "basicConstraints=critical,CA:TRUE",
                "-addext",
                "keyUsage=critical,keyCertSign,cRLSign",
            ],
        );
        openssl(
            folder,
            &[
                "req",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                "leaf.key",
                "-out",
                "leaf.csr",
                "-subj",
                "/CN=mcp.example.test",
            ],
        );
        fs::write(
            folder.join("leaf.ext"),
            "subjectAltName=DNS:mcp.example.test\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
        )
        .unwrap();
        openssl(
            folder,
            &[
                "x509",
                "-req",
                "-in",
                "leaf.csr",
                "-CA",
                "ca.pem",
                "-CAkey",
                "ca.key",
                "-CAcreateserial",
                "-out",
                "leaf.pem",
                "-days",
                "1",
                "-sha256",
                "-extfile",
                "leaf.ext",
            ],
        );
        // native-tls 0.2.14 imports PKCS#12 identities into one process-global
        // temporary keychain on macOS. Its supported PKCS#8 path creates a
        // separate temporary keychain per identity, so parallel synthetic peers
        // do not share import custody or depend on OpenSSL PKCS#12 defaults.
        openssl(
            folder,
            &[
                "pkcs8",
                "-topk8",
                "-nocrypt",
                "-in",
                "leaf.key",
                "-out",
                "leaf-pkcs8.key",
            ],
        );
        let key = zeroize::Zeroizing::new(fs::read(folder.join("leaf-pkcs8.key")).unwrap());
        let mut chain = fs::read(folder.join("leaf.pem")).unwrap();
        chain.extend_from_slice(&fs::read(folder.join("ca.pem")).unwrap());
        let identity = Identity::from_pkcs8(&chain, &key)
            .expect("isolated synthetic TLS identity import failed");
        (identity, crate::https::config_trusting_only(&fs::read(folder.join("ca.pem")).unwrap()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        mcp::{http::BearerAuthenticator, Operation, Principal, CallAnswerer},
        forwarder::{
            gateway::Gateway,
            session::{connect_mac_session_with_admission, ConnectionAdmission, ConnectionGrant},
            websocket::accept_resource_websocket,
            ClientProofIssuer,
        },
        account::computers::{AccountKey, KeptAccount, ComputersRow},
        resource_authority::{decode_message, InvokeMessage, Route},
    };
    use native_tls::TlsAcceptor;
    use serde_json::json;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::Arc,
        thread,
    };

    fn fixture() -> (TlsAcceptor, Arc<ClientConfig>) {
        let folder = tempfile::tempdir().unwrap();
        let (identity, config) = super::fixture::identity(folder.path());
        (TlsAcceptor::new(identity).unwrap(), config)
    }

    #[test]
    fn concurrent_synthetic_identity_imports_keep_both_verified_peers_usable() {
        // Complete both independent imports before using either identity. This
        // exercises the shared-keychain pressure from the old fixture without
        // retries, shared passwords or relaxed certificate/hostname checks.
        let imports: Vec<_> = (0..2).map(|_| thread::spawn(fixture)).collect();
        let peers: Vec<_> = imports.into_iter().map(|job| job.join().unwrap()).collect();
        for (acceptor, config) in peers {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                let (socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut tls = acceptor.accept(socket).unwrap();
                let mut message = [0_u8; 5];
                tls.read_exact(&mut message).unwrap();
                assert_eq!(&message, b"probe");
                tls.write_all(b"ready").unwrap();
                tls.flush().unwrap();
            });
            let socket = TcpStream::connect(address).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut tls = verified_tls(&config, "mcp.example.test", socket).unwrap();
            tls.write_all(b"probe").unwrap();
            let mut message = [0_u8; 5];
            tls.read_exact(&mut message).unwrap();
            assert_eq!(&message, b"ready");
            server.join().unwrap();
        }
    }

    #[test]
    fn verified_tls_precedes_resource_websocket_and_session_bytes() {
        let (acceptor, config) = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            tcp.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
            let tls = acceptor.accept(tcp).unwrap();
            let mut websocket =
                accept_resource_websocket(tls, &format!("mcp.example.test:{}", address.port()))
                    .unwrap();
            let mut session_message = [0_u8; 9];
            websocket.read_exact(&mut session_message).unwrap();
            assert_eq!(&session_message, b"\0\0\0\x05hello");
            websocket.write_all(b"\0\0\0\x05world").unwrap();
            websocket.flush().unwrap();
        });
        let mut websocket = upgrade_on_address(
            address,
            "mcp.example.test",
            address.port(),
            Duration::from_secs(3),
            Duration::from_secs(3),
            Instant::now() + Duration::from_secs(120),
            &config,
        )
        .unwrap();
        websocket.write_all(b"\0\0\0\x05hello").unwrap();
        websocket.flush().unwrap();
        let mut reply = [0_u8; 9];
        websocket.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"\0\0\0\x05world");
        server.join().unwrap();
    }

    #[test]
    fn verified_wss_admits_mac_route_and_carries_gateway_invoke() {
        struct NoBearer;
        impl BearerAuthenticator for NoBearer {
            fn authenticate(&self, _: &[u8]) -> Option<Principal> {
                None
            }
        }
        struct FixtureProof;
        impl ClientProofIssuer for FixtureProof {
            fn issue(&self, _: &Principal, _: &InvokeMessage) -> Option<String> {
                Some("fixture-client-proof".into())
            }
        }
        struct FixtureRegistration;
        impl ConnectionAdmission for FixtureRegistration {
            fn admit(&self, credential: &[u8], _: i64) -> Option<ConnectionGrant> {
                (credential == b"fixture-device-credential").then(|| ConnectionGrant { admission_identity: None,
                    route: route(),
                    expires_at_ms: 2_000,
                })
            }
            fn is_current(&self, grant: &ConnectionGrant, now_ms: i64) -> bool {
                grant.route == route() && now_ms < 2_000
            }
        }
        // The forwarder answers an account only from a computer its own signed computers row names as one that may answer
        // (ConnectedComputers::current_route), so the Mac tells that row, signed with the account's key, and
        // the account is the address that key names.
        fn account_key() -> &'static AccountKey {
            static KEY: std::sync::OnceLock<AccountKey> = std::sync::OnceLock::new();
            KEY.get_or_init(|| AccountKey::generate().expect("key"))
        }
        const DEVICE: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        fn told() -> Vec<KeptAccount> {
            let computer = vec![DEVICE.to_owned()];
            let row = ComputersRow::sign(&account_key().address(), 1, &computer, &computer, account_key()).expect("signed");
            vec![KeptAccount { row, account_key: account_key().public_hex() }]
        }
        fn route() -> Route {
            Route {
                account_id: account_key().address(),
                device_id: DEVICE.into(),
                resource_address: "project:one".into(),
                generation: "generation:one".into(),
            }
        }
        fn now_ms() -> i64 {
            1_000
        }

        let (acceptor, config) = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mac = thread::spawn(move || {
            let websocket = upgrade_on_address(
                address,
                "mcp.example.test",
                address.port(),
                Duration::from_secs(3),
                Duration::from_secs(3),
                Instant::now() + Duration::from_secs(120),
                &config,
            )?;
            connect_mac_session_with_admission(
                websocket,
                b"fixture-device-credential",
                &told(),
                &route(),
                crate::storage::time_source::fixed(now_ms()),
                || Ok(()),
                |bytes| {
                    let session_message = decode_message(bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()))?;
                    serde_json::to_vec(&json!({
                        "state":"completed",
                        "request_id":session_message.request_id,
                        "value":{"from":"mac"}
                    }))
                    .map_err(|_| crate::refusal_cause::CodedError::new(()))
                },
            )
        });
        let (tcp, _) = listener.accept().unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        tcp.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
        let tls = acceptor.accept(tcp).unwrap();
        let gateway = Arc::new(Gateway::new(
            format!("mcp.example.test:{}", address.port()),
            Arc::new(NoBearer),
            Arc::new(FixtureProof),
            Arc::new(FixtureRegistration),
            crate::storage::time_source::fixed(now_ms()),
        ));
        assert_eq!(gateway.admit_mac_websocket(tls, "198.51.100.9:50000").unwrap(), route());
        let reply = gateway
            .invoke(
                &Principal { kind: crate::mcp::PrincipalKind::Person,
                    account_id: account_key().address(),
                    sign_in: "grant:fixture".into(),
                    client_id: "fixture-client".into(),
                },
                Operation { person_present: None,
                    resource: "project:one".into(),
                    operation: "record.read".into(),
                    request_key: "fixture-key".into(),
                    input: json!({"id":"record:one"}),
                },
            )
            .unwrap();
        assert_eq!(reply, json!({"from":"mac"}));
        drop(gateway);
        assert!(mac.join().unwrap().is_err());
    }

    #[test]
    fn wrong_tls_hostname_is_refused_before_websocket_or_credential() {
        let (acceptor, config) = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            tcp.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
            let _ = acceptor.accept(tcp);
        });
        assert_eq!(
            upgrade_on_address(
                address,
                "other.example.test",
                address.port(),
                Duration::from_secs(3),
                Duration::from_secs(3),
                Instant::now() + Duration::from_secs(120),
                &config,
            )
            .err()
            .unwrap()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
        server.join().unwrap();
    }

    #[test]
    fn untrusted_tls_root_is_refused_before_websocket_or_credential() {
        let (acceptor, _) = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            tcp.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
            let _ = acceptor.accept(tcp);
        });
        assert_eq!(
            upgrade_on_address(
                address,
                "mcp.example.test",
                address.port(),
                Duration::from_secs(3),
                Duration::from_secs(3),
                Instant::now() + Duration::from_secs(120),
                &crate::https::tls_config().unwrap(),
            )
            .err()
            .unwrap()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
        server.join().unwrap();
    }

    #[test]
    fn total_deadline_ends_a_drip_fed_message() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let server = thread::spawn(move || {
            let (mut tcp, _) = listener.accept().unwrap();
            for _ in 0..20 {
                if tcp.write_all(b"x").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        });
        let mut client = DeadlineTcp::new(
            client,
            Duration::from_millis(100),
            Instant::now() + Duration::from_millis(50),
        )
        .unwrap();
        assert_eq!(
            client.read_exact(&mut [0_u8; 20]).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn invalid_public_host_is_refused_before_dns_or_network() {
        for host in [
            "",
            "mcp.example.test/other",
            "mcp.example.test:443",
            "-bad.test",
        ] {
            assert_eq!(
                connect_mac_resource_wss(
                    host,
                    443,
                    Duration::from_secs(1),
                    Duration::from_secs(1),
                )
                .err()
                .unwrap()
                .kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }

    #[test]
    fn expired_attempt_refuses_before_tcp_connect() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let error = upgrade_on_address(
            listener.local_addr().unwrap(),
            "mcp.example.test",
            443,
            Duration::from_secs(3),
            Duration::from_secs(3),
            Instant::now() - Duration::from_millis(1),
            &crate::https::tls_config().unwrap(),
        )
        .err()
        .unwrap();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        listener.set_nonblocking(true).unwrap();
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn stalled_tls_handshake_reports_connection_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (_tcp, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(120));
        });
        // The TLS settings first: loading the computer's roots can itself take longer than the 40 ms the handshake has,
        // and the deadline must run out in the handshake, not before the connection is made.
        let config = crate::https::tls_config().unwrap();
        let error = upgrade_on_address(
            address,
            "mcp.example.test",
            address.port(),
            Duration::from_secs(1),
            Duration::from_secs(1),
            Instant::now() + Duration::from_millis(40),
            &config,
        )
        .err()
        .unwrap();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        server.join().unwrap();
    }

    #[test]
    fn cancelled_native_connection_does_not_start_dns_or_connect() {
        let cancelled=Arc::new(AtomicBool::new(true));
        let result=connect_mac_resource_wss_while("mcp.synthetic.invalid",443,
            Duration::from_secs(1),Duration::from_secs(5),cancelled,
            Instant::now()+Duration::from_secs(5));
        assert_eq!(result.err().unwrap().kind(),io::ErrorKind::Interrupted);
    }

    #[test]
    fn native_parent_cancellation_interrupts_waiting_dns_without_another_worker() {
        let (started,begin)=mpsc::channel();
        let (release,blocked)=mpsc::channel();
        let resolver=Arc::new(Resolver::new(move |_,_| {
            let _=started.send(());
            blocked.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(vec!["127.0.0.1:443".parse().unwrap()])
        }).unwrap());
        let cancelled=Arc::new(AtomicBool::new(false));
        let worker_resolver=resolver.clone();
        let worker_cancelled=cancelled.clone();
        let (ended,finished)=mpsc::channel();
        let worker=thread::spawn(move || {
            let result=worker_resolver.resolve_while("synthetic.invalid",443,
                Instant::now()+Duration::from_secs(5),Some(&worker_cancelled));
            ended.send(result.map(|_|())).unwrap();
        });
        begin.recv_timeout(Duration::from_secs(2)).unwrap();
        cancelled.store(true,Ordering::Release);
        let result=finished.recv_timeout(Duration::from_secs(2)).unwrap();
        release.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(result.unwrap_err().kind(),io::ErrorKind::Interrupted);
    }

    #[test]
    fn native_parent_cancellation_interrupts_idle_socket_read_and_flush() {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let client=TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_server,_)=listener.accept().unwrap();
        let cancelled=Arc::new(AtomicBool::new(false));
        let mut stream=DeadlineTcp::new(client,Duration::from_secs(5),Instant::now()+Duration::from_secs(5)).unwrap();
        stream.cancelled=Some(cancelled.clone());
        let (started,begin)=mpsc::channel();
        let (ended,finished)=mpsc::channel();
        let worker=thread::spawn(move || {
            started.send(()).unwrap();
            let mut byte=[0u8;1];
            let read=stream.read(&mut byte);
            let flush=stream.flush();
            ended.send((read,flush)).unwrap();
        });
        begin.recv_timeout(Duration::from_secs(2)).unwrap();
        thread::sleep(Duration::from_millis(40));
        assert!(finished.try_recv().is_err());
        cancelled.store(true,Ordering::Release);
        let (read,flush)=finished.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        assert_eq!(read.unwrap_err().kind(),io::ErrorKind::Interrupted);
        assert_eq!(flush.unwrap_err().kind(),io::ErrorKind::Interrupted);
    }

    #[test]
    fn native_socket_poll_slices_do_not_extend_the_original_io_timeout() {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let client=TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_server,_)=listener.accept().unwrap();
        let mut stream=DeadlineTcp::new(client,Duration::from_millis(60),Instant::now()+Duration::from_secs(5)).unwrap();
        stream.cancelled=Some(Arc::new(AtomicBool::new(false)));
        assert_eq!(stream.read(&mut [0u8;1]).unwrap_err().kind(),io::ErrorKind::TimedOut);
    }

    #[test]
    fn admitted_websocket_waits_past_io_timeout_for_next_message() {
        let (acceptor, config) = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            let tls = acceptor.accept(tcp).unwrap();
            let mut websocket = tungstenite::accept(tls).unwrap();
            websocket.send(tungstenite::Message::Binary(b"\0\0\0\x05ready".to_vec())).unwrap();
            thread::sleep(Duration::from_millis(180));
            websocket.send(tungstenite::Message::Binary(b"\0\0\0\x04work".to_vec())).unwrap();
            thread::sleep(Duration::from_millis(50));
        });
        let mut websocket = upgrade_on_address(address, "mcp.example.test", address.port(),
            Duration::from_secs(1), Duration::from_millis(60),
            Instant::now() + Duration::from_secs(4), &config).unwrap();
        let mut ack = [0; 9]; websocket.read_exact(&mut ack).unwrap();
        assert_eq!(&ack, b"\0\0\0\x05ready");
        let mut invoke = [0; 8]; websocket.read_exact(&mut invoke).unwrap();
        assert_eq!(&invoke, b"\0\0\0\x04work");
        server.join().unwrap();
    }

    /// A session with nothing to hear pings, and a ping nobody answers ends it (before: an idle session waited out its
    /// whole lifetime, so a path that died with the Mac's sleep or a changed network was noticed only at the next write).
    fn quick_keepalive() -> Keepalive {
        Keepalive { interval: Duration::from_millis(100), timeout: Duration::from_millis(300),
            jitter: Duration::from_millis(1), tick: Duration::from_millis(20) }
    }

    fn upgrade_quick(address: SocketAddr, config: &Arc<ClientConfig>) -> WebSocketStream<IdleBoundedTls> {
        upgrade_on_address_while(address, "mcp.example.test", address.port(), Duration::from_secs(1),
            Duration::from_millis(60), Instant::now() + Duration::from_secs(4), config, None, quick_keepalive()).unwrap()
    }

    #[test]
    fn an_idle_session_pings_and_an_answered_ping_keeps_it() {
        let (acceptor, config) = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            let tls = acceptor.accept(tcp).unwrap();
            let mut websocket = tungstenite::accept(tls).unwrap();
            websocket.send(tungstenite::Message::Binary(b"\0\0\0\x05ready".to_vec())).unwrap();
            // Reading answers each ping with its pong; after two pings (well past the ping timeout) the work arrives.
            let mut pings = 0;
            while pings < 2 {
                if let tungstenite::Message::Ping(_) = websocket.read().unwrap() { pings += 1; }
            }
            websocket.send(tungstenite::Message::Binary(b"\0\0\0\x04work".to_vec())).unwrap();
            thread::sleep(Duration::from_millis(50));
        });
        let mut websocket = upgrade_quick(address, &config);
        websocket.read_exact(&mut [0; 9]).unwrap();
        let began = Instant::now();
        let mut invoke = [0; 8];
        websocket.read_exact(&mut invoke).unwrap();
        assert_eq!(&invoke, b"\0\0\0\x04work");
        assert!(began.elapsed() >= Duration::from_millis(200), "two pings came first");
        server.join().unwrap();
    }

    #[test]
    fn an_unanswered_ping_ends_the_session_at_the_ping_timeout() {
        let (acceptor, config) = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            let tls = acceptor.accept(tcp).unwrap();
            let mut websocket = tungstenite::accept(tls).unwrap();
            websocket.send(tungstenite::Message::Binary(b"\0\0\0\x05ready".to_vec())).unwrap();
            // The path is dead: nothing is read, so no pong is ever sent.
            thread::sleep(Duration::from_millis(1500));
        });
        let mut websocket = upgrade_quick(address, &config);
        websocket.read_exact(&mut [0; 9]).unwrap();
        let began = Instant::now();
        let error = websocket.read(&mut [0; 1]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut, "{error:?}");
        assert!(began.elapsed() >= Duration::from_millis(350), "after the interval and the timeout: {:?}", began.elapsed());
        assert!(began.elapsed() < Duration::from_millis(1200), "not at the session's lifetime: {:?}", began.elapsed());
        server.join().unwrap();
    }

    #[test]
    fn buffered_partial_websocket_message_keeps_short_io_timeout() {
        let (acceptor, config) = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            let tls = acceptor.accept(tcp).unwrap();
            let mut websocket = tungstenite::accept(tls).unwrap();
            // One TLS plaintext write coalesces the complete admission answer
            // and the beginning of the next message. The next read must clear
            // idle even when TLS returns those bytes from its internal buffer.
            websocket.get_mut().write_all(b"\x82\x09\0\0\0\x05ready\x82\x09\0\0").unwrap();
            websocket.get_mut().flush().unwrap();
            thread::sleep(Duration::from_millis(300));
        });
        let mut websocket = upgrade_on_address(address, "mcp.example.test", address.port(),
            Duration::from_secs(1), Duration::from_millis(60),
            Instant::now() + Duration::from_secs(4), &config).unwrap();
        websocket.read_exact(&mut [0; 9]).unwrap();
        let began = Instant::now();
        let error = websocket.read(&mut [0; 1]).unwrap_err();
        // native-tls/tungstenite may classify the interrupted TLS record as a
        // protocol error. The causal proof is refusal before the server ends
        // its withheld message, rather than its platform-specific error wrapper.
        assert!(began.elapsed() < Duration::from_millis(250), "{error:?}; waited {:?}", began.elapsed());
        server.join().unwrap();
    }

    #[test]
    fn idle_wait_still_ends_at_session_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_server, _) = listener.accept().unwrap();
        let mut stream = DeadlineTcp::new(client, Duration::from_millis(30),
            Instant::now() + Duration::from_millis(140)).unwrap();
        stream.idle_read = Some(Arc::new(AtomicBool::new(true)));
        let began = Instant::now();
        assert_eq!(stream.read(&mut [0; 1]).unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(began.elapsed() >= Duration::from_millis(100));
        assert!(began.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn stalled_dns_has_bounded_queue_and_caller_deadline() {
        let (started, observed_start) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        let resolver = Resolver::new(move |_, _| {
            let _ = started.send(());
            blocked.recv().unwrap();
            Ok(vec!["127.0.0.1:443".parse().unwrap()])
        })
        .unwrap();
        let first = resolver
            .resolve(
                "mcp.example.test",
                443,
                Instant::now() + Duration::from_millis(30),
            )
            .unwrap_err();
        assert_eq!(first.kind(), io::ErrorKind::TimedOut);
        observed_start.recv_timeout(Duration::from_secs(1)).unwrap();
        let queued = resolver
            .resolve(
                "mcp.example.test",
                443,
                Instant::now() + Duration::from_millis(30),
            )
            .unwrap_err();
        assert_eq!(queued.kind(), io::ErrorKind::TimedOut);
        // The queue is full: a caller waits its turn up to its own deadline (no other worker), not refused at once.
        let began = Instant::now();
        let full = resolver
            .resolve(
                "mcp.example.test",
                443,
                Instant::now() + Duration::from_millis(60),
            )
            .unwrap_err();
        assert_eq!(full.kind(), io::ErrorKind::TimedOut);
        assert!(began.elapsed() >= Duration::from_millis(60));
        // Once the stalled lookup ends, a caller that waits gets its answer.
        release.send(()).unwrap();
        release.send(()).unwrap();
        release.send(()).unwrap();
        assert_eq!(
            resolver
                .resolve(
                    "mcp.example.test",
                    443,
                    Instant::now() + Duration::from_secs(1),
                )
                .unwrap(),
            vec!["127.0.0.1:443".parse::<SocketAddr>().unwrap()]
        );
        drop(resolver);
    }

    #[test]
    fn resolver_returns_the_selected_socket_address() {
        let address: SocketAddr = "127.0.0.1:8443".parse().unwrap();
        let resolver = Resolver::new(move |host, port| {
            assert_eq!(host, "mcp.example.test");
            assert_eq!(port, 8443);
            Ok(vec![address])
        })
        .unwrap();
        assert_eq!(
            resolver
                .resolve(
                    "mcp.example.test",
                    8443,
                    Instant::now() + Duration::from_secs(1),
                )
                .unwrap(),
            vec![address]
        );
    }
}
