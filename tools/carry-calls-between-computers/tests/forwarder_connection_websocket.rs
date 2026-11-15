// tests/forwarder_connection_websocket.rs
//
// Purpose: Tests WebSocket framing for session bytes and public upgrade request validation.
//
// Non-Negotiable Invariants:
// - Only exact bounded binary messages are accepted, and public upgrade requires the expected host, path, and origin policy.
//
// Key Concepts:
// - Binary WebSocket payloads carry length-prefixed session messages in both stream directions.
// - Upgrade validation checks host, request target, path, query, and origin; message length and message type are bounded.
//
// Security Considerations:
// - All sockets are loopback fixtures; text, mismatched or incomplete messages and request-target-changing hosts are refused.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::Duration,
};
use trillion_local::forwarder::websocket::{
    accept_resource_websocket, upgrade_resource_websocket_on_verified_tls, WebSocketStream,
};
use tungstenite::{accept_with_config, client::client_with_config, Message};

fn client(address: std::net::SocketAddr) -> WebSocketStream<TcpStream> {
    let tcp = TcpStream::connect(address).unwrap();
    tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    tcp.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
    let (socket, _) =
        client_with_config("ws://localhost/mcp/resource-connection", tcp, None).unwrap();
    WebSocketStream::new(socket)
}

#[test]
fn binary_messages_carry_exact_bounded_session_messages_in_both_directions() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        tcp.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
        let socket = accept_with_config(tcp, None).unwrap();
        let mut stream = WebSocketStream::new(socket);
        let mut received = [0u8; 9];
        stream.read_exact(&mut received).unwrap();
        assert_eq!(&received, b"\0\0\0\x05hello");
        stream.write_all(b"\0\0\0\x05world").unwrap();
        stream.flush().unwrap();
    });
    let mut stream = client(address);
    stream.write_all(b"\0\0\0\x05").unwrap();
    stream.write_all(b"hello").unwrap();
    stream.flush().unwrap();
    let mut received = [0u8; 9];
    stream.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"\0\0\0\x05world");
    server.join().unwrap();
}

#[test]
fn text_and_mismatched_binary_lengths_are_refused() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        let mut socket = accept_with_config(tcp, None).unwrap();
        socket
            .send(Message::Text("not a binary session message".into()))
            .unwrap();
    });
    let mut stream = client(address);
    assert_eq!(
        stream.read(&mut [0u8; 1]).unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
    server.join().unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        let mut socket = accept_with_config(tcp, None).unwrap();
        socket
            .send(Message::Binary(b"\0\0\0\x06hello".to_vec()))
            .unwrap();
    });
    let mut stream = client(address);
    assert_eq!(
        stream.read(&mut [0u8; 1]).unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
    server.join().unwrap();
}

#[test]
fn incomplete_and_oversized_outgoing_messages_are_refused() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        let _socket = accept_with_config(tcp, None).unwrap();
        thread::sleep(Duration::from_millis(100));
    });
    let mut stream = client(address);
    stream.write_all(b"\0\0\0\x06hello").unwrap();
    assert_eq!(
        stream.flush().unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );
    assert_eq!(
        stream.write(&vec![0u8; door_bounds().1 + 5]).unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );
    server.join().unwrap();
}

#[test]
fn public_upgrade_refuses_wrong_host_path_origin_and_query() {
    for (path, host, extra) in [
        ("/mcp/resource-connection", "other.example.test", ""),
        ("/mcp", "mcp.example.test", ""),
        (
            "ws://other.example.test/mcp/resource-connection",
            "mcp.example.test",
            "",
        ),
        (
            "/mcp/resource-connection?device=one",
            "mcp.example.test",
            "",
        ),
        (
            "/mcp/resource-connection",
            "mcp.example.test",
            "Origin: https://other.example.test\r\n",
        ),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            tcp.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
            assert!(accept_resource_websocket(tcp, "mcp.example.test").is_err());
        });
        let mut tcp = TcpStream::connect(address).unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n{extra}\r\n");
        tcp.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        tcp.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 403"), "{response}");
        server.join().unwrap();
    }
}

#[test]
fn mac_upgrade_rejects_host_that_could_change_the_request_target() {
    struct NoIo;
    impl Read for NoIo {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            panic!("invalid host reached the stream")
        }
    }
    impl Write for NoIo {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            panic!("invalid host reached the stream")
        }
        fn flush(&mut self) -> std::io::Result<()> {
            panic!("invalid host reached the stream")
        }
    }

    for host in [
        "mcp.example.test/other",
        "mcp.example.test@example.com",
        "mcp.example.test?next=/other",
        "mcp.example.test\r\nOrigin: other.example.test",
    ] {
        assert!(upgrade_resource_websocket_on_verified_tls(NoIo, host).is_err());
    }
}

/// The door's one request limit (src/mcp/settings.json `request_bytes`) and the session message that carries one
/// request in base64 inside its envelope (`call_bytes`).
fn door_bounds() -> (usize, usize) {
    let settings: serde_json::Value = serde_json::from_str(include_str!("../src/mcp/settings.json")).unwrap();
    let request = settings["request_bytes"].as_u64().unwrap() as usize;
    (request, request.div_ceil(3) * 4 + settings["call_bytes"].as_u64().unwrap() as usize)
}
