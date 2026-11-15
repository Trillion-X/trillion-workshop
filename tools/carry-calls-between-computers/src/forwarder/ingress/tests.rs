//! The door's listener on a real loopback socket, plain HTTP as the front door carries it: MCP, its discovery and
//! challenge, the Host gate, and the resource connection's upgrade.
use super::*;
use crate::{
    forwarder::{
        session::{ConnectionAdmission, ConnectionGrant},
        ClientProofIssuer,
    },
    mcp::{http::BearerAuthenticator, Principal},
    resource_authority::InvokeMessage,
};
use std::{net::TcpStream, thread};
use tungstenite::client::client_with_config;

struct FixtureBearer;
impl BearerAuthenticator for FixtureBearer {
    fn authenticate(&self, token: &[u8]) -> Option<Principal> {
        (token == b"local-test-bearer-credential").then(|| Principal { kind: crate::mcp::PrincipalKind::Person,
            account_id: "account:test".into(),
            sign_in: "grant:test".into(),
            client_id: "client:test".into(),
        })
    }
}

struct FixtureProof;
impl ClientProofIssuer for FixtureProof {
    fn issue(&self, _: &Principal, _: &InvokeMessage) -> Option<String> {
        Some("fixture-proof".into())
    }
}

struct RejectRegistration;
impl ConnectionAdmission for RejectRegistration {
    fn admit(&self, _: &[u8], _: i64) -> Option<ConnectionGrant> {
        None
    }
    fn is_current(&self, _: &ConnectionGrant, _: i64) -> bool {
        false
    }
}

fn now() -> i64 {
    1_000
}

/// A door for `gateway` on a loopback port, served on its own thread until the returned flag is set.
fn serving(gateway: Arc<Gateway>) -> (SocketAddr, Arc<AtomicBool>, thread::JoinHandle<io::Result<()>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let ingress = Ingress::new(listener, gateway).unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let stop = shutdown.clone();
    (address, shutdown, thread::spawn(move || ingress.serve(stop)))
}

fn connect(address: SocketAddr) -> TcpStream {
    let stream = TcpStream::connect(address).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
    stream
}

/// One whole HTTP exchange of `request` (which says `Connection: close`): the answer's text.
fn exchange(address: SocketAddr, request: &[u8]) -> String {
    let mut stream = connect(address);
    stream.write_all(request).unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    answer
}

fn mcp(address: SocketAddr, host: &str, bearer: Option<&str>, protocol_version: &str, body: &str) -> String {
    let routing = if protocol_version >= "2026-07-28" {
        let message: serde_json::Value = serde_json::from_str(body).unwrap();
        let method = message["method"].as_str().unwrap();
        let name = message.pointer("/params/name").and_then(serde_json::Value::as_str);
        format!("Mcp-Method: {method}\r\n{}", name.map(|name| format!("Mcp-Name: {name}\r\n")).unwrap_or_default())
    } else {
        String::new()
    };
    let authorization = bearer.map(|value| format!("Authorization: Bearer {value}\r\n")).unwrap_or_default();
    let request = format!("POST /mcp HTTP/1.1\r\nHost: {host}\r\n{authorization}Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: {protocol_version}\r\n{routing}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    exchange(address, request.as_bytes())
}

const LIST: &str = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;

#[test]
fn door_discovery_and_challenge_answer_without_a_bearer() {
    let host = "mcp.example.test";
    let origin = format!("https://{host}");
    let gateway = Arc::new(Gateway::with_door(host, &origin, crate::storage::time_source::fixed(now())).unwrap());
    let (address, shutdown, server) = serving(gateway);
    let metadata = exchange(address, format!("GET /.well-known/oauth-protected-resource/mcp HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes());
    let challenge = mcp(address, host, None, "2025-06-18", "{}");
    shutdown.store(true, Ordering::Release);
    server.join().unwrap().unwrap();
    assert!(metadata.starts_with("HTTP/1.1 200"), "{metadata}");
    let document: serde_json::Value = serde_json::from_str(metadata.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(document["resource"], format!("{origin}/mcp"));
    assert_eq!(document["authorization_servers"], serde_json::json!([crate::account::signed_in::settings().authorization_server]),
        "the door names Better Auth as its authorization server");
    assert!(challenge.starts_with("HTTP/1.1 401"), "{challenge}");
    assert!(challenge.contains("resource_metadata=\""));
    assert!(challenge.contains("scope=\"records tools\""));
}

#[test]
fn one_listener_serves_authenticated_mcp_and_the_resource_connection_upgrade() {
    let gateway = Arc::new(Gateway::new(
        "mcp.example.test",
        Arc::new(FixtureBearer),
        Arc::new(FixtureProof),
        Arc::new(RejectRegistration),
        crate::storage::time_source::fixed(now()),
    ));
    let (address, shutdown, server) = serving(gateway);

    let listed = mcp(address, "mcp.example.test", Some("local-test-bearer-credential"), "2025-06-18", LIST);
    assert!(listed.starts_with("HTTP/1.1 200"), "{listed}");
    assert!(mcp(address, "mcp.example.test", Some("wrong-credential"), "2025-06-18", LIST).starts_with("HTTP/1.1 401"));
    // Another Host no live account names is misdirected, before any route reads the request.
    let misdirected = mcp(address, "other.example.test", Some("local-test-bearer-credential"), "2025-06-18", LIST);
    assert!(misdirected.starts_with("HTTP/1.1 421"), "{misdirected}");
    assert!(misdirected.contains("\"cause\""), "a refusal names its cause");

    let discovered = mcp(address, "mcp.example.test", Some("local-test-bearer-credential"), "2026-07-28",
        r#"{"jsonrpc":"2.0","id":"discover","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}"#);
    assert!(discovered.starts_with("HTTP/1.1 200"), "{discovered}");
    let lower = discovered.to_ascii_lowercase();
    assert!(lower.contains("content-type: application/json") && lower.contains("cache-control: no-store"), "{discovered}");
    let discovery: serde_json::Value = serde_json::from_str(discovered.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert!(discovery["result"]["supportedVersions"].as_array().unwrap().iter().any(|version| version == "2026-07-28"));
    let mismatched = mcp(address, "mcp.example.test", Some("local-test-bearer-credential"), "2026-07-28",
        r#"{"jsonrpc":"2.0","id":"mismatch","method":"tools/call","params":{"name":"run_resource_operation","arguments":{"address":"@own-records","method":"record.read","request_key":"mismatch-key"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2025-06-18","io.modelcontextprotocol/clientCapabilities":{}}}}"#);
    assert!(mismatched.starts_with("HTTP/1.1 400"), "{mismatched}");

    // The resource connection upgrades on the door's own Host and path; the credential is then the session's to check.
    let (_, upgrade) = client_with_config("ws://mcp.example.test/mcp/resource-connection", connect(address), None).unwrap();
    assert_eq!(upgrade.status(), tungstenite::http::StatusCode::SWITCHING_PROTOCOLS);
    // Another Host, a query, an Origin or a subprotocol is refused before any upgrade.
    for refused in [
        "GET /mcp/resource-connection HTTP/1.1\r\nHost: other.example.test\r\n",
        "GET /mcp/resource-connection?x=1 HTTP/1.1\r\nHost: mcp.example.test\r\n",
        "GET /mcp/resource-connection HTTP/1.1\r\nHost: mcp.example.test\r\nOrigin: https://page.example.test\r\n",
        "GET /mcp/resource-connection HTTP/1.1\r\nHost: mcp.example.test\r\nSec-WebSocket-Protocol: chat\r\n",
    ] {
        let request = format!("{refused}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nConnection: close\r\n\r\n");
        let answer = exchange(address, request.as_bytes());
        assert!(answer.starts_with("HTTP/1.1 403"), "{refused}: {answer}");
    }
    // The right Host and path with no WebSocket handshake is not an upgrade.
    let plain = exchange(address, b"GET /mcp/resource-connection HTTP/1.1\r\nHost: mcp.example.test\r\nConnection: close\r\n\r\n");
    assert!(plain.starts_with("HTTP/1.1 400"), "{plain}");

    shutdown.store(true, Ordering::Release);
    server.join().unwrap().unwrap();
}

/// An admitted resource session's stream waits for an answer until the longest message deadline, and lasts the
/// session's longest life from its admission; an ordinary connection keeps its 5 s reads and its 120 s from accept.
#[test]
fn an_admitted_session_waits_for_answers_until_the_message_deadline_and_outlives_its_session() {
    let bounds = StreamBounds::new();
    assert_eq!(bounds.read_wait_ms.load(Ordering::Acquire), SOCKET_IO_TIMEOUT.as_millis() as u64);
    let accepted_deadline = bounds.deadline();
    std::thread::sleep(Duration::from_millis(20));
    let admitted = Instant::now();
    bounds.admitted_session();
    assert_eq!(bounds.read_wait_ms.load(Ordering::Acquire), super::super::DEADLINE_WINDOW_MS as u64);
    assert!(bounds.deadline() > accepted_deadline, "the stream outlives a session admitted after accept");
    // The bounds count whole milliseconds.
    let life = Duration::from_millis(super::super::session::MAX_SESSION_LIFE_MS as u64);
    assert!(bounds.deadline() + Duration::from_millis(1) >= admitted + life);
    let widened = bounds.deadline();
    bounds.clone().admitted_session();
    assert!(bounds.deadline() >= widened, "a clone widens the same bounds and never narrows them");
}
