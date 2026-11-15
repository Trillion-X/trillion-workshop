//! The one HTTP client against real local servers: plain http on loopback (allowed only there) for framing, bounds and
//! deadlines, and the synthetic TLS fixture for verification.
use super::*;
use std::{
    io::{BufRead, BufReader, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    thread,
};

/// A loopback server that answers each connection with `answer` (raw bytes) after reading the request head, and hands
/// back the heads it read.
fn answering(answer: &'static [u8]) -> (Url, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://127.0.0.1:{}/ask", listener.local_addr().unwrap().port())).unwrap();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let head = read_head(&stream);
        (&stream).write_all(answer).unwrap();
        vec![head]
    });
    (url, server)
}

fn read_head(stream: &TcpStream) -> String {
    let mut reader = BufReader::new(stream);
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
            return head;
        }
        head.push_str(&line);
    }
}

fn get(url: &Url) -> Ask<'_> {
    Ask { method: "GET", url, headers: &[], body: &[] }
}

const WAIT: Duration = Duration::from_secs(5);

#[test]
fn a_chunked_answer_is_joined() {
    let (url, server) = answering(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n4\r\n{\"va\r\na\r\nlid\":true}\r\n0\r\n\r\n");
    let answer = request(&get(&url), 1024, WAIT).unwrap();
    assert_eq!((answer.status, answer.body.as_slice()), (200, b"{\"valid\":true}".as_slice()));
    assert_eq!(answer.header("CONTENT-TYPE"), Some("application/json"));
    server.join().unwrap();
}

#[test]
fn an_answer_past_its_limit_is_refused_not_cut_short() {
    let (url, server) = answering(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789");
    let refused = request(&get(&url), 9, WAIT).unwrap_err();
    assert_eq!(refused.kind(), io::ErrorKind::InvalidData);
    server.join().unwrap();
}

#[test]
fn a_redirect_is_answered_not_followed() {
    let (url, server) = answering(b"HTTP/1.1 302 Found\r\nLocation: https://elsewhere.example.test/\r\nContent-Length: 0\r\n\r\n");
    let answer = request(&get(&url), 1024, WAIT).unwrap();
    assert_eq!((answer.status, answer.header("location")), (302, Some("https://elsewhere.example.test/")));
    server.join().unwrap();
}

#[test]
fn the_asker_headers_and_body_reach_the_server_and_the_client_writes_the_framing() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://localhost:{}/post?x=1", listener.local_addr().unwrap().port())).unwrap();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(&stream);
        let mut head = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" { break; }
            head.push_str(&line);
        }
        let mut body = [0u8; 4];
        reader.read_exact(&mut body).unwrap();
        (&stream).write_all(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap();
        (head, body)
    });
    let headers = [("authorization", "Bearer synthetic"), ("x-trillion-request-key", "key-1")];
    let answer = request(&Ask { method: "POST", url: &url, headers: &headers, body: b"{}{}" }, 64, WAIT).unwrap();
    assert_eq!(answer.status, 204);
    let (head, body) = server.join().unwrap();
    let head = head.to_ascii_lowercase();
    assert!(head.starts_with("post /post?x=1 http/1.1\r\n"), "{head}");
    assert!(head.contains("authorization: bearer synthetic\r\n") && head.contains("x-trillion-request-key: key-1\r\n"), "{head}");
    assert!(head.contains("content-length: 4\r\n"), "{head}");
    assert_eq!(&body, b"{}{}");
}

#[test]
fn plain_http_leaves_no_computer_and_an_asker_cannot_reframe_the_request() {
    for url in ["http://example.test/", "ftp://127.0.0.1/", "https://user:secret@example.test/", "https://example.test/#part"] {
        let url = Url::parse(url).unwrap();
        assert_eq!(request(&get(&url), 16, WAIT).unwrap_err().kind(), io::ErrorKind::InvalidInput, "{url}");
    }
    let url = Url::parse("http://127.0.0.1:9/").unwrap();
    for header in ["host", "Content-Length", "connection", "transfer-encoding"] {
        let headers = [(header, "1")];
        let ask = Ask { method: "GET", url: &url, headers: &headers, body: &[] };
        assert_eq!(request(&ask, 16, WAIT).unwrap_err().kind(), io::ErrorKind::InvalidInput, "{header}");
    }
    let headers = [("x-split", "a\r\nInjected: yes")];
    assert_eq!(request(&Ask { method: "GET", url: &url, headers: &headers, body: &[] }, 16, WAIT).unwrap_err().kind(),
        io::ErrorKind::InvalidInput);
    assert_eq!(request(&Ask { method: "get", url: &url, headers: &[], body: &[] }, 16, WAIT).unwrap_err().kind(),
        io::ErrorKind::InvalidInput);
}

#[test]
fn a_server_that_never_answers_is_given_up_within_the_wait() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port())).unwrap();
    let held = thread::spawn(move || listener.accept().map(|(stream, _)| { thread::sleep(Duration::from_secs(2)); drop(stream) }));
    let started = Instant::now();
    let refused = request(&get(&url), 16, Duration::from_millis(300)).unwrap_err();
    assert_eq!(refused.kind(), io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    held.join().unwrap().unwrap();
}

#[test]
fn a_body_that_stops_arriving_is_given_up_at_the_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port())).unwrap();
    let held = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        read_head(&stream);
        (&stream).write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nfirst").unwrap();
        thread::sleep(Duration::from_secs(2));
    });
    let started = Instant::now();
    assert_eq!(request(&get(&url), 1024, Duration::from_millis(400)).unwrap_err().kind(), io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    held.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_caller_on_a_tokio_worker_waits_for_its_answer() {
    let (url, server) = answering(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    let answer = request(&get(&url), 16, WAIT).unwrap();
    assert_eq!(answer.body, b"ok");
    server.join().unwrap();
}

#[test]
fn a_streamed_body_is_read_in_order_and_ends_at_its_length() {
    let (url, server) = answering(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nhello world");
    let opened = Client::verified().unwrap().open(&get(&url), WAIT).unwrap();
    assert_eq!(opened.status, 200);
    let mut read = Vec::new();
    opened.body.reading_within(WAIT).read_to_end(&mut read).unwrap();
    assert_eq!(read, b"hello world");
    server.join().unwrap();
}

#[test]
fn a_body_shorter_than_its_length_is_refused() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port())).unwrap();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        read_head(&stream);
        (&stream).write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nshort").unwrap();
    });
    assert!(request(&get(&url), 1024, WAIT).is_err());
    server.join().unwrap();
}

/// A TLS server for `mcp.example.test` (the synthetic fixture's name) on loopback that answers one request.
fn tls_server(folder: &std::path::Path, answer: &'static [u8]) -> (SocketAddr, thread::JoinHandle<bool>) {
    let (identity, _) = crate::forwarder::tls::fixture::identity(folder);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        tcp.set_read_timeout(Some(WAIT)).unwrap();
        let Ok(tls) = native_tls::TlsAcceptor::new(identity).unwrap().accept(tcp) else { return false };
        let mut reader = BufReader::new(tls);
        let mut line = String::new();
        while reader.read_line(&mut line).is_ok_and(|read| read > 0) && line != "\r\n" {
            line.clear();
        }
        reader.get_mut().write_all(answer).is_ok()
    });
    (address, server)
}

#[test]
fn https_is_verified_against_the_named_roots() {
    let folder = tempfile::tempdir().unwrap();
    let (address, server) = tls_server(folder.path(), b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    let config = config_trusting_only(&std::fs::read(folder.path().join("ca.pem")).unwrap());
    let client = Client(builder(&config).resolve("mcp.example.test", address).build().unwrap());
    let url = Url::parse(&format!("https://mcp.example.test:{}/", address.port())).unwrap();
    let answer = client.request(&get(&url), 16, WAIT).unwrap();
    assert_eq!((answer.status, answer.body.as_slice()), (200, b"ok".as_slice()));
    assert!(server.join().unwrap());
}

#[test]
fn https_to_a_peer_no_named_root_signed_is_refused_before_any_request() {
    let folder = tempfile::tempdir().unwrap();
    let (address, server) = tls_server(folder.path(), b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    let other = tempfile::tempdir().unwrap();
    let _ = crate::forwarder::tls::fixture::identity(other.path());
    let config = config_trusting_only(&std::fs::read(other.path().join("ca.pem")).unwrap());
    let client = Client(builder(&config).resolve("mcp.example.test", address).build().unwrap());
    let url = Url::parse(&format!("https://mcp.example.test:{}/", address.port())).unwrap();
    assert!(client.request(&get(&url), 16, WAIT).is_err());
    assert!(!server.join().unwrap(), "the handshake must fail, so no request is read");
}

#[test]
fn a_root_bundle_with_no_certificate_is_refused() {
    assert_eq!(pem_roots(b"# only a comment\n").unwrap_err().kind(), io::ErrorKind::InvalidData);
}

#[test]
fn only_a_bare_https_origin_with_a_dns_host_is_reached() {
    assert_eq!(reach_of("https://door.example.test"), Some(Reach { host: "door.example.test".into(), port: 443 }));
    assert_eq!(reach_of("https://door.example.test:8443"), Some(Reach { host: "door.example.test".into(), port: 8443 }));
    for refused in ["http://door.example.test", "https://door.example.test/", "https://door.example.test/a",
        "https://127.0.0.1", "https://user@example.com", "https://door.example.test?x=1"] {
        assert_eq!(reach_of(refused), None, "{refused}");
    }
}

#[test]
fn an_authority_post_is_https_only_and_a_withdrawn_caller_sends_nothing() {
    let plain = Url::parse("http://127.0.0.1:9/publish").unwrap();
    assert_eq!(post_authority_json(&plain, "bearer", b"{}", 64, Instant::now() + WAIT, &|| true),
        Err(crate::cause!(AuthorityHttpFailure::Unavailable)));
    let url = Url::parse("https://mcp.example.test/publish").unwrap();
    assert_eq!(post_authority_json(&url, "bearer", b"{}", 64, Instant::now() + WAIT, &|| false),
        Err(crate::cause!(AuthorityHttpFailure::Unavailable)));
    for bearer in ["", "with space", "tab\t"] {
        assert_eq!(post_authority_json(&url, bearer, b"{}", 64, Instant::now() + WAIT, &|| true),
            Err(crate::cause!(AuthorityHttpFailure::Unavailable)), "{bearer:?}");
    }
}

#[test]
fn an_authority_status_is_classified() {
    let folder = tempfile::tempdir().unwrap();
    for (answer, expected) in [
        (b"HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 2\r\n\r\n{}".as_slice(), Ok(b"{}".to_vec())),
        (b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n", Err(crate::cause!(AuthorityHttpFailure::CredentialRejected))),
        (b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n", Err(crate::cause!(AuthorityHttpFailure::CredentialRejected))),
        (b"HTTP/1.1 302 Found\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n", Err(crate::cause!(AuthorityHttpFailure::Unavailable))),
        (b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\n\r\n{}", Err(crate::cause!(AuthorityHttpFailure::Unavailable))),
    ] {
        let answer: &'static [u8] = Box::leak(answer.to_vec().into_boxed_slice());
        let place = tempfile::tempdir_in(folder.path()).unwrap();
        let (address, server) = tls_server(place.path(), answer);
        let ca = place.path().join("ca.pem");
        let url = Url::parse(&format!("https://mcp.example.test:{}/publish", address.port())).unwrap();
        let client = Client(builder(&config_trusting_only(&std::fs::read(ca).unwrap())).resolve("mcp.example.test", address).build().unwrap());
        assert_eq!(authority_answer(&client, &url, "synthetic", b"{}", 64, Instant::now() + WAIT, &|| true), expected);
        server.join().unwrap();
    }
}

#[test]
fn a_request_whose_first_address_is_not_listening_reaches_the_next_one() {
    let folder = tempfile::tempdir().unwrap();
    // The first address: a port that was bound and let go, so nothing listens there (as `::1` when the forwarder
    // listens on 127.0.0.1 only).
    let gone = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let (live, server) = tls_server(folder.path(), b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\n{\"b\":2}");
    let config = config_trusting_only(&std::fs::read(folder.path().join("ca.pem")).unwrap());
    let client = Client(builder(&config).resolve_to_addrs("mcp.example.test", &[gone, live]).build().unwrap());
    let url = Url::parse(&format!("https://mcp.example.test:{}/a/x/places/y", live.port())).unwrap();
    let headers = [("authorization", "Bearer proof")];
    let answer = client.request(&Ask { method: "POST", url: &url, headers: &headers, body: b"{\"a\":1}" }, 1024, WAIT).unwrap();
    assert_eq!((answer.status, answer.body.as_slice()), (200, b"{\"b\":2}".as_slice()));
    assert!(server.join().unwrap());
}

#[test]
fn the_named_root_file_is_trusted_with_its_host_checked_and_a_bad_one_is_refused() {
    let folder = tempfile::tempdir().unwrap();
    let (address, server) = tls_server(folder.path(), b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    let ca = folder.path().join("ca.pem");
    let roots = named_roots(Some(ca.as_os_str())).unwrap();
    assert_eq!(roots.len(), 1);
    let config = config_trusting(rustls::RootCertStore::empty(), roots).unwrap();
    let client = Client(builder(&config).resolve("mcp.example.test", address).build().unwrap());
    let url = Url::parse(&format!("https://mcp.example.test:{}/", address.port())).unwrap();
    assert_eq!(client.request(&get(&url), 16, WAIT).unwrap().status, 200);
    assert!(server.join().unwrap());
    // The same root, another name: the certificate does not name it, so the peer is refused.
    let (address, server) = tls_server(tempfile::tempdir().unwrap().path(), b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    let client = Client(builder(&config).resolve("other.example.test", address).build().unwrap());
    let url = Url::parse(&format!("https://other.example.test:{}/", address.port())).unwrap();
    assert!(client.request(&get(&url), 16, WAIT).is_err());
    assert!(!server.join().unwrap());
    let missing = folder.path().join("missing.pem");
    assert!(named_roots(Some(missing.as_os_str())).is_err());
    let empty = folder.path().join("empty.pem");
    std::fs::write(&empty, b"").unwrap();
    assert!(named_roots(Some(empty.as_os_str())).is_err());
    assert!(named_roots(None).unwrap().is_empty());
}

/// The roots `SSL_CERT_FILE` names are read on every platform (macOS's trust store does not read that file itself).
#[test]
fn every_certificate_of_a_named_root_bundle_is_read_and_a_bundle_without_one_is_refused() {
    let folder = tempfile::tempdir().unwrap();
    let _ = crate::forwarder::tls::fixture::identity(folder.path());
    let ca = std::fs::read(folder.path().join("ca.pem")).unwrap();
    assert_eq!(pem_roots(&ca).unwrap().len(), 1);
    let two = [ca.as_slice(), b"\n", ca.as_slice()].concat();
    assert_eq!(pem_roots(&two).unwrap().len(), 2);
    let commented = [b"# Test CA\n".as_slice(), ca.as_slice(), b"\n# Test CA again\n", ca.as_slice(), b"\n"].concat();
    assert_eq!(pem_roots(&commented).unwrap().len(), 2, "comments between certificates are not read as one");
    assert!(pem_roots(b"").is_err(), "no certificate");
    assert!(pem_roots(b"\x2d----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----\n").is_err());
    assert!(pem_roots(&[0xff, 0xfe]).is_err(), "not text");
}

#[test]
fn the_tls_settings_are_made_once_per_root_file() {
    let (first, _) = trust().unwrap();
    let (again, _) = trust().unwrap();
    assert!(Arc::ptr_eq(&first, &again), "the second ask is served from the settings already made");
    assert!(Arc::ptr_eq(&tls_config().unwrap(), &first), "the forwarder session uses the same settings as every request");
}

// A request body read from a reader while it is sent (`Client::open_uploading`).

/// A loopback server that reads one request head and then, by `read_body`, up to `limit` body bytes, answers 200 and
/// hands back the head and the body bytes it read.
fn taking(read_body: bool, limit: usize) -> (Url, thread::JoinHandle<(String, Vec<u8>)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://127.0.0.1:{}/object", listener.local_addr().unwrap().port())).unwrap();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(&stream);
        let mut head = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" { break; }
            head.push_str(&line);
        }
        let mut body = Vec::new();
        if read_body {
            let _ = (&mut reader).take(limit as u64).read_to_end(&mut body);
            let _ = (&stream).write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        } else {
            thread::sleep(Duration::from_secs(3));
        }
        (head.to_ascii_lowercase(), body)
    });
    (url, server)
}

fn put(url: &Url) -> Ask<'_> {
    Ask { method: "PUT", url, headers: &[], body: &[] }
}

/// The error of an upload that was to be refused.
fn refused(opened: io::Result<Opened>) -> io::Error {
    match opened {
        Ok(opened) => panic!("answered {}", opened.status),
        Err(error) => error,
    }
}

#[test]
fn an_uploaded_body_reaches_the_server_whole_with_its_length_and_no_chunking() {
    let length = 300 * 1024 + 7;
    let (url, server) = taking(true, length);
    let bytes: Vec<u8> = (0..length).map(|at| (at % 251) as u8).collect();
    let mut reader = bytes.as_slice();
    let opened = Client::verified().unwrap()
        .open_uploading(&put(&url), Upload { length: length as u64, reader: &mut reader }, WAIT, Instant::now() + WAIT).unwrap();
    let answer = opened.whole(16).unwrap();
    assert_eq!((answer.status, answer.body.as_slice()), (200, b"ok".as_slice()));
    let (head, body) = server.join().unwrap();
    assert!(head.contains(&format!("content-length: {length}\r\n")) && !head.contains("transfer-encoding"), "{head}");
    assert_eq!(body, bytes);
}

#[test]
fn an_upload_whose_reader_ends_early_ends_the_request_unfinished() {
    let (url, server) = taking(true, 1024 * 1024);
    let bytes = vec![7u8; 100 * 1024];
    let mut reader = bytes.as_slice();
    let error = refused(Client::verified().unwrap()
        .open_uploading(&put(&url), Upload { length: 200 * 1024, reader: &mut reader }, WAIT, Instant::now() + WAIT));
    assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    let (head, body) = server.join().unwrap();
    assert!(head.contains("content-length: 204800\r\n"), "{head}");
    assert!(body.len() < 200 * 1024, "the server took {} bytes as a whole body", body.len());
}

#[test]
fn an_upload_the_server_stops_taking_is_given_up_after_the_stall() {
    let (url, server) = taking(false, 0);
    let bytes = vec![7u8; 64 * 1024 * 1024];
    let mut reader = bytes.as_slice();
    let started = Instant::now();
    let error = refused(Client::verified().unwrap()
        .open_uploading(&put(&url), Upload { length: bytes.len() as u64, reader: &mut reader }, Duration::from_millis(300), Instant::now() + WAIT));
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(3), "given up after {:?}", started.elapsed());
    assert!(reader.len() > 32 * 1024 * 1024, "the reader was read past what the connection took");
    server.join().unwrap();
}

#[test]
fn an_upload_carries_one_body() {
    let url = Url::parse("http://127.0.0.1:9/").unwrap();
    let mut reader: &[u8] = b"x";
    let ask = Ask { method: "PUT", url: &url, headers: &[], body: b"y" };
    let error = refused(Client::verified().unwrap()
        .open_uploading(&ask, Upload { length: 1, reader: &mut reader }, WAIT, Instant::now() + WAIT));
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

// ---- A client pinned to the addresses its caller judged ----

/// A loopback server that hands back each request head it reads and answers it with `answer`; it counts connections.
fn counting(answer: &'static [u8]) -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let heads = Arc::new(Mutex::new(Vec::new()));
    let kept = heads.clone();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let head = read_head(&stream);
            kept.lock().unwrap().push(head);
            let _sent = (&stream).write_all(answer);
        }
    });
    (address, heads)
}

/// The kind of a refused open (an answer has no Debug: its body is a live request).
fn refusal(opened: io::Result<Opened>) -> io::ErrorKind {
    match opened {
        Ok(opened) => panic!("answered {}", opened.status),
        Err(error) => error.kind(),
    }
}

/// One wait of at most `wait`, then none.
fn once(wait: Duration) -> impl FnMut() -> Option<Duration> {
    let mut waited = false;
    move || (!std::mem::replace(&mut waited, true)).then_some(wait)
}

#[test]
fn a_pinned_name_is_connected_only_at_the_addresses_it_was_given_and_plain_http_goes_there() {
    let (address, heads) = counting(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    // A public-looking name no system lookup answers: only the pinned address can reach the server.
    let host = url::Host::Domain("site.example.test");
    let pinned = Pinned::new(&host, &[address]).unwrap();
    assert_eq!(pinned.opened(), None);
    let url = Url::parse("http://site.example.test/page").unwrap();
    let opened = pinned.open_waiting(&get(&url), WAIT, &mut once(WAIT)).unwrap();
    assert!(pinned.opened().is_some(), "the connection opened before the head came");
    assert_eq!(opened.whole(16).unwrap().body, b"ok");
    let head = heads.lock().unwrap()[0].to_ascii_lowercase();
    assert!(head.starts_with("get /page http/1.1\r\n") && head.contains("host: site.example.test\r\n"), "{head}");
}

#[test]
fn a_pinned_client_asks_no_other_host_and_an_ip_literal_only_at_itself() {
    let (address, heads) = counting(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    let pinned = Pinned::new(&url::Host::Domain("site.example.test"), &[address]).unwrap();
    for other in ["http://other.example.test/", "http://127.0.0.1/", "ftp://site.example.test/", "https://user@example.com/",
        "http://site.example.test/#part"] {
        let url = Url::parse(other).unwrap();
        assert_eq!(refusal(pinned.open_waiting(&get(&url), WAIT, &mut once(WAIT))), io::ErrorKind::InvalidInput, "{other}");
    }
    assert!(Pinned::new(&url::Host::Domain("site.example.test"), &[]).is_err(), "a name with no address");
    let literal = url::Host::Ipv4(std::net::Ipv4Addr::LOCALHOST);
    assert!(Pinned::new(&literal, &[SocketAddr::from(([10, 0, 0, 1], address.port()))]).is_err(), "a literal at another address");
    let at_itself = Pinned::new(&literal, &[address]).unwrap();
    let url = Url::parse(&format!("http://127.0.0.1:{}/", address.port())).unwrap();
    assert_eq!(at_itself.open_waiting(&get(&url), WAIT, &mut once(WAIT)).unwrap().status, 200);
    assert_eq!(heads.lock().unwrap().len(), 1, "only the literal's own request reached the server");
}

#[test]
fn a_pinned_connection_that_never_opens_is_known_to_have_sent_nothing() {
    let gone = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let pinned = Pinned::new(&url::Host::Domain("site.example.test"), &[gone]).unwrap();
    let url = Url::parse("http://site.example.test/").unwrap();
    assert!(pinned.open_waiting(&get(&url), WAIT, &mut once(WAIT)).is_err());
    assert_eq!(pinned.opened(), None);
}

#[test]
fn a_caller_ends_its_own_waits_for_the_head_and_for_the_body() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let held = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        read_head(&stream);
        thread::sleep(Duration::from_millis(300));
        (&stream).write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nfirst").unwrap();
        thread::sleep(Duration::from_secs(2));
    });
    let pinned = Pinned::new(&url::Host::Domain("site.example.test"), &[address]).unwrap();
    let url = Url::parse("http://site.example.test/").unwrap();
    // Short waits are each given again until the head comes.
    let mut waits = 0;
    let opened = pinned.open_waiting(&get(&url), WAIT, &mut || { waits += 1; Some(Duration::from_millis(50)) }).unwrap();
    assert!(waits > 1, "{waits}");
    let mut body = opened.body;
    let mut read = [0u8; 16];
    let mut arrived = Vec::new();
    while arrived.len() < 5 {
        if let Some(count) = body.read_waiting(&mut read, WAIT).unwrap() {
            arrived.extend_from_slice(&read[..count]);
        }
    }
    assert_eq!(arrived, b"first");
    // The rest does not come: a short wait answers that nothing came, and the body is not ended.
    assert_eq!(body.read_waiting(&mut read, Duration::from_millis(100)).unwrap(), None);
    // A caller that gives no more waits ends the request as timed out.
    let started = Instant::now();
    let pinned = Pinned::new(&url::Host::Domain("site.example.test"), &[address]).unwrap();
    let mut stopped = || None;
    assert_eq!(refusal(pinned.open_waiting(&get(&url), WAIT, &mut stopped)), io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(body);
    held.join().unwrap();
}

#[test]
fn an_answer_that_is_not_http_is_invalid_data() {
    let (address, _) = counting(b"not a reply\r\n\r\n");
    let pinned = Pinned::new(&url::Host::Domain("site.example.test"), &[address]).unwrap();
    let url = Url::parse("http://site.example.test/").unwrap();
    assert_eq!(refusal(pinned.open_waiting(&get(&url), WAIT, &mut once(WAIT))), io::ErrorKind::InvalidData);
}

#[test]
fn https_through_a_pinned_client_is_verified_with_every_clients_settings() {
    // tls_config trusts the platform's roots (plus SSL_CERT_FILE), never the fixture's own authority: the handshake
    // fails, so the connection never opens and no request is read.
    let folder = tempfile::tempdir().unwrap();
    let (address, server) = tls_server(folder.path(), b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    let pinned = Pinned::new(&url::Host::Domain("mcp.example.test"), &[address]).unwrap();
    let url = Url::parse(&format!("https://mcp.example.test:{}/", address.port())).unwrap();
    assert!(pinned.open_waiting(&get(&url), WAIT, &mut once(WAIT)).is_err());
    assert_eq!(pinned.opened(), None, "an unverified handshake is not an opened connection");
    assert!(!server.join().unwrap());
}
