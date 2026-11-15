//! A test's front door: what Caddy is in front of the door on a public computer (Workshop tool start-a-computer, a
//! layout's `caddy` row with `front_door`). It terminates TLS with the test's own identity on the address computers
//! reach and carries every byte, the HTTP head with its Host included, to the door's plain loopback listener.
use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::Arc,
    thread,
    time::Duration,
};
use trillion_local::forwarder::{gateway::Gateway, ingress::Ingress};

/// The door for `gateway` on a loopback port of its own, with `public` terminating TLS with `identity` in front of it.
/// Answers the door, for the test to serve.
pub fn behind_tls(public: TcpListener, identity: native_tls::Identity, gateway: Arc<Gateway>) -> io::Result<Ingress> {
    let inner = TcpListener::bind("127.0.0.1:0")?;
    let door = inner.local_addr()?;
    let acceptor = native_tls::TlsAcceptor::new(identity).map_err(io::Error::other)?;
    thread::spawn(move || {
        for client in public.incoming() {
            let Ok(client) = client else { continue };
            let acceptor = acceptor.clone();
            thread::spawn(move || carry(&acceptor, client, door));
        }
    });
    Ingress::new(inner, gateway)
}

/// One client connection: its TLS ended here, its bytes carried both ways until either side closes.
fn carry(acceptor: &native_tls::TlsAcceptor, client: TcpStream, door: SocketAddr) {
    let Ok(mut tls) = acceptor.accept(client) else { return };
    let Ok(mut upstream) = TcpStream::connect(door) else { return };
    let tick = Some(Duration::from_millis(5));
    if tls.get_ref().set_read_timeout(tick).is_err() || upstream.set_read_timeout(tick).is_err() {
        return;
    }
    let mut buffer = vec![0u8; 64 * 1024];
    while moved(&mut tls, &mut upstream, &mut buffer).is_some() && moved(&mut upstream, &mut tls, &mut buffer).is_some() {}
}

/// What one read of `from` carried to `to`: `Some(count)` (zero when nothing was waiting), `None` once either side closed.
fn moved(from: &mut impl Read, to: &mut impl Write, buffer: &mut [u8]) -> Option<usize> {
    match from.read(buffer) {
        Ok(0) => None,
        Ok(count) => to.write_all(&buffer[..count]).and_then(|()| to.flush()).ok().map(|()| count),
        Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => Some(0),
        Err(_) => None,
    }
}
