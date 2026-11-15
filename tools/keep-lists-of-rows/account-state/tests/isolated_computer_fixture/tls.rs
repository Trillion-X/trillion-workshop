//! Test-owned HTTPS front over the actual Computer route table. The leaf is signed by a fresh local test CA;
//! clients trust that CA only for this fixture. No product TLS check or machine trust store is changed.
//! TLS setup follows tests/computer_forwarder.rs:1031; every worker/socket is owned and joined at close.
use super::Settings;
use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use native_tls::{Identity, TlsAcceptor, TlsConnector};
use std::{
    fs,
    io::{Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tower::ServiceExt;

pub fn identity(folder: &Path) -> (Vec<u8>, Identity) {
    fs::create_dir(folder).expect("fixture TLS folder");
    fs::write(
        folder.join("openssl.cnf"),
        "[req]\ndistinguished_name=dn\n[dn]\n",
    )
    .unwrap();
    let openssl = |args: &[&str]| {
        let done = Command::new("openssl")
            .env("OPENSSL_CONF", folder.join("openssl.cnf"))
            .current_dir(folder)
            .args(args)
            .output()
            .expect("fixture certificate command");
        assert!(done.status.success(), "fixture certificate command failed");
    };
    // SHA-256 here is the TLS certificate signature algorithm, never a content identity or fixture receipt.
    openssl(&[
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
        "/CN=Isolated Computer Test Root",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    openssl(&[
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "leaf.key",
        "-out",
        "leaf.csr",
        "-subj",
        "/CN=localhost",
    ]);
    fs::write(folder.join("leaf.ext"), "subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n").unwrap();
    openssl(&[
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
    ]);
    openssl(&[
        "pkcs8",
        "-topk8",
        "-nocrypt",
        "-in",
        "leaf.key",
        "-out",
        "leaf-pkcs8.key",
    ]);
    let root = fs::read(folder.join("ca.pem")).unwrap();
    let mut chain = fs::read(folder.join("leaf.pem")).unwrap();
    chain.extend_from_slice(&root);
    let identity =
        Identity::from_pkcs8(&chain, &fs::read(folder.join("leaf-pkcs8.key")).unwrap()).unwrap();
    (root, identity)
}

pub struct Server {
    pub address: SocketAddr,
    stop: Arc<AtomicBool>,
    sockets: Arc<Mutex<Vec<TcpStream>>>,
    worker: Option<JoinHandle<()>>,
}

impl Server {
    pub fn start(
        listener: TcpListener,
        identity: Identity,
        app: Router,
        settings: Settings,
    ) -> Self {
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let sockets = Arc::new(Mutex::new(Vec::new()));
        let (stopping, open) = (stop.clone(), sockets.clone());
        let acceptor = Arc::new(TlsAcceptor::new(identity).unwrap());
        let runtime = Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap(),
        );
        let worker = thread::spawn(move || {
            let mut workers = Vec::new();
            while !stopping.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, peer)) => {
                        if !peer.ip().is_loopback() || workers.len() >= settings.maximum_connections
                        {
                            continue;
                        }
                        // BSD/macOS may inherit O_NONBLOCK from the accepting listener. TLS owns a blocking
                        // worker here; leaving that inherited flag set makes the first handshake return WouldBlock.
                        stream.set_nonblocking(false).unwrap();
                        let timeout = Some(Duration::from_millis(settings.socket_timeout_ms));
                        stream.set_read_timeout(timeout).unwrap();
                        stream.set_write_timeout(timeout).unwrap();
                        open.lock().unwrap().push(stream.try_clone().unwrap());
                        let (acceptor, app, runtime, settings) = (
                            acceptor.clone(),
                            app.clone(),
                            runtime.clone(),
                            settings.clone(),
                        );
                        workers.push(thread::spawn(move || {
                            let _ = serve_one(stream, &acceptor, app, &runtime, &settings);
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(settings.poll_ms))
                    }
                    Err(_) => break,
                }
            }
            drop(listener);
            for socket in open.lock().unwrap().iter() {
                let _ = socket.shutdown(Shutdown::Both);
            }
            for worker in workers {
                worker.join().expect("fixture HTTPS worker joined");
            }
            open.lock().unwrap().clear();
            drop(app);
            let runtime = Arc::try_unwrap(runtime)
                .ok()
                .expect("fixture HTTPS runtime has no remaining worker");
            runtime.shutdown_timeout(Duration::from_millis(settings.close_timeout_ms));
        });
        Self {
            address,
            stop,
            sockets,
            worker: Some(worker),
        }
    }

    pub fn close(&mut self) {
        self.stop.store(true, Ordering::Release);
        for socket in self.sockets.lock().unwrap().iter() {
            let _ = socket.shutdown(Shutdown::Both);
        }
        if let Some(worker) = self.worker.take() {
            worker.join().expect("fixture HTTPS listener joined");
        }
        assert!(
            TcpStream::connect_timeout(&self.address, Duration::from_millis(100)).is_err(),
            "fixture HTTPS listener remains open"
        );
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.close();
    }
}

fn serve_one(
    stream: TcpStream,
    acceptor: &TlsAcceptor,
    app: Router,
    runtime: &tokio::runtime::Runtime,
    settings: &Settings,
) -> Result<(), ()> {
    let mut tls = acceptor.accept(stream).map_err(|_| ())?;
    let mut head = Vec::new();
    let mut byte = [0];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= settings.maximum_head_bytes || tls.read(&mut byte).map_err(|_| ())? == 0 {
            return Err(());
        }
        head.push(byte[0]);
    }
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut parsed = httparse::Request::new(&mut headers);
    if !parsed.parse(&head).map_err(|_| ())?.is_complete() {
        return Err(());
    }
    let mut request = Request::builder()
        .method(parsed.method.ok_or(())?)
        .uri(parsed.path.ok_or(())?);
    let mut length = 0;
    let mut lengths = 0;
    for header in parsed.headers.iter() {
        if header.name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(());
        }
        if header.name.eq_ignore_ascii_case("content-length") {
            lengths += 1;
            length = std::str::from_utf8(header.value)
                .map_err(|_| ())?
                .parse::<usize>()
                .map_err(|_| ())?;
        }
        request = request.header(header.name, header.value);
    }
    if lengths > 1 || length > settings.maximum_body_bytes {
        return Err(());
    }
    let mut body = vec![0; length];
    tls.read_exact(&mut body).map_err(|_| ())?;
    let reply = runtime
        .block_on(app.oneshot(request.body(Body::from(body)).map_err(|_| ())?))
        .map_err(|_| ())?;
    let (parts, body) = reply.into_parts();
    let body = runtime
        .block_on(to_bytes(body, settings.maximum_body_bytes))
        .map_err(|_| ())?;
    write!(
        tls,
        "HTTP/1.1 {} {}\r\n",
        parts.status.as_u16(),
        parts.status.canonical_reason().unwrap_or("Reply")
    )
    .map_err(|_| ())?;
    for (name, value) in &parts.headers {
        if ["content-length", "connection", "transfer-encoding"].contains(&name.as_str()) {
            continue;
        }
        tls.write_all(name.as_str().as_bytes())
            .and_then(|()| tls.write_all(b": "))
            .and_then(|()| tls.write_all(value.as_bytes()))
            .and_then(|()| tls.write_all(b"\r\n"))
            .map_err(|_| ())?;
    }
    write!(
        tls,
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .map_err(|_| ())?;
    tls.write_all(&body)
        .and_then(|()| tls.flush())
        .map_err(|_| ())?;
    let _ = tls.shutdown();
    Ok(())
}

/// The fixture's own strict TLS client: trusts its test CA, still verifies the localhost name and chain.
pub fn request(
    address: SocketAddr,
    root: &[u8],
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let connector = TlsConnector::builder()
        .add_root_certificate(native_tls::Certificate::from_pem(root).unwrap())
        .build()
        .unwrap();
    let socket = TcpStream::connect(address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    socket
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut tls = connector
        .connect("localhost", socket)
        .expect("fixture CA and hostname are verified");
    write!(tls, "{method} {path} HTTP/1.1\r\nHost: localhost:{}\r\nContent-Length: {}\r\nConnection: close\r\n", address.port(), body.len()).unwrap();
    for (name, value) in headers {
        write!(tls, "{name}: {value}\r\n").unwrap();
    }
    tls.write_all(b"\r\n").unwrap();
    tls.write_all(body).unwrap();
    tls.flush().unwrap();
    let mut bytes = Vec::new();
    tls.read_to_end(&mut bytes).unwrap();
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut parsed = httparse::Response::new(&mut headers);
    let at = parsed.parse(&bytes).unwrap().unwrap();
    let headers = parsed
        .headers
        .iter()
        .map(|header| {
            (
                header.name.to_owned(),
                String::from_utf8_lossy(header.value).into_owned(),
            )
        })
        .collect();
    (parsed.code.unwrap(), headers, bytes[at..].to_vec())
}
