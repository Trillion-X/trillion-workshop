// tests/mac_dispatch.rs
//
// Purpose: Tests HTTP and Mac session dispatch through authenticated clients into SQLite-backed resource operations.
//
// Non-Negotiable Invariants:
// - Account, client, route, and current authority scope each check dispatch; uncertain replies retain their original retry identity.
//
// Key Concepts:
// - HTTP bearer identity maps to a principal, then route and client proof govern resource invocation.
// - A lost device reply is uncertain; retry keys, expected versions, and SQLite receipts connect replay to the original mutation.
//
// Security Considerations:
// - Bearer tokens, proofs, route directory, and store are local fixtures; cross-account calls and revoked authority cannot authorize writes.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpStream,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use trillion_local::account::computers::{AccountKey, KeptAccount, ComputersRow};
use trillion_local::forwarder::gateway::Gateway;
use trillion_local::forwarder::session::{
    ConnectionAdmission, ConnectionGrant, connect_mac_session, connect_mac_session_with_admission,
};
use trillion_local::forwarder::websocket::upgrade_resource_websocket_on_verified_tls;
use trillion_local::{
    mcp::{
        Operation, OperationFailure, Principal, CallAnswerer,
        http::{
            BearerAuthenticator, Request,
            axum_adapter::{Service, serve},
            handle,
        },
    },
    mcp_current_policy::Reach,
    forwarder::{ClientProofIssuer, ComputerConnections, RouteDirectory, McpForwarder},
    resource_authority::{
        ClientAuthority, CurrentClient, InvokeMessage, Route, Scope, dispatch_record_message,
    },
    store::{CommitContext, Store},
};

/// Owner and device ids in the shape computers rows and credentials use (64 lowercase hex). `ACCOUNT_ONE` is the owner
/// id `account_key` names (checked by `the_test_account_is_the_one_its_key_names`).
const ACCOUNT_ONE: &str = "8df79b56dfd5d698b41a1d08df13df261c9067258cfb8b1cc100b1c40741b9ee";
const ACCOUNT_OTHER: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const DEVICE_ONE: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

/// The account's own key: it signs the computers row the websocket computer tells.
fn account_key() -> AccountKey {
    AccountKey::from_secret_text(&"07".repeat(32)).expect("secret")
}

#[test]
fn the_test_account_is_the_one_its_key_names() {
    assert_eq!(account_key().address(), ACCOUNT_ONE);
}

fn now() -> i64 {
    1_000
}
fn route() -> Route {
    Route {
        account_id: ACCOUNT_ONE.into(),
        device_id: DEVICE_ONE.into(),
        resource_address: "project:one".into(),
        generation: "generation:one".into(),
    }
}
struct Directory;
impl RouteDirectory for Directory {
    fn current_route(&self, _: &str, _: &str) -> Option<Route> {
        Some(route())
    }
}
struct Issuer;
impl ClientProofIssuer for Issuer {
    fn issue(&self, principal: &Principal, _: &InvokeMessage) -> Option<String> {
        Some(format!("fixture-proof:{}", principal.sign_in))
    }
}
struct Authenticator;
impl BearerAuthenticator for Authenticator {
    fn authenticate(&self, token: &[u8]) -> Option<Principal> {
        match token {
            b"example-token-chatgpt" => Some(Principal { kind: trillion_local::mcp::PrincipalKind::Person,
                account_id: ACCOUNT_ONE.into(),
                sign_in: "grant:chatgpt".into(),
                client_id: "chatgpt".into(),
            }),
            b"example-token-claude" => Some(Principal { kind: trillion_local::mcp::PrincipalKind::Person,
                account_id: ACCOUNT_ONE.into(),
                sign_in: "grant:claude".into(),
                client_id: "claude".into(),
            }),
            b"example-token-other" => Some(Principal { kind: trillion_local::mcp::PrincipalKind::Person,
                account_id: ACCOUNT_OTHER.into(),
                sign_in: "grant:other".into(),
                client_id: "chatgpt".into(),
            }),
            _ => None,
        }
    }
}
struct Authority {
    live: Arc<AtomicBool>,
}
struct Client {
    identity: String,
    expected: Scope,
    live: Arc<AtomicBool>,
}
impl CurrentClient for Client {
    fn identity(&self) -> &str {
        &self.identity
    }
    fn assert_current(&self, scope: &Scope) -> bool {
        self.expected == *scope && self.live.load(Ordering::SeqCst)
    }
}
impl ClientAuthority for Authority {
    fn admit(&self, proof: &str, scope: &Scope) -> Option<Box<dyn CurrentClient>> {
        Some(Box::new(Client {
            identity: proof.strip_prefix("fixture-proof:")?.into(),
            expected: scope.clone(),
            live: self.live.clone(),
        }))
    }
}
struct Context;
impl CommitContext for Context {
    fn current_route(&self, _: &Scope) -> Option<Route> {
        Some(route())
    }
    fn now_ms(&self) -> i64 {
        now()
    }
}
struct Connections {
    store: Mutex<Store>,
    authority: Authority,
    lose_next_reply: AtomicBool,
}

impl ComputerConnections for Connections {
    fn invoke(&self, _: &Route, session_message: &[u8]) -> Result<Vec<u8>, trillion_local::refusal_cause::CodedError<()>> {
        let reply = dispatch_record_message(
            session_message,
            &mut *self.store.lock().unwrap(),
            &Context,
            Some(&self.authority),
        )
        .map_err(|_| trillion_local::refusal_cause::CodedError::new(()))?;
        if self.lose_next_reply.swap(false, Ordering::SeqCst) {
            return Err(trillion_local::refusal_cause::CodedError::new(()));
        }
        Ok(reply)
    }
}
struct SocketAnswerer {
    connections: Arc<Connections>,
}
impl CallAnswerer for SocketAnswerer {
    fn invoke(&self, principal: &Principal, call: Operation) -> Result<Value, OperationFailure> {
        CallAnswerer::invoke(
            &McpForwarder {
                directory: &Directory,
                issuer: &Issuer,
                connections: self.connections.as_ref(),
                now_ms: std::sync::Arc::new(OneThousand),
            },
            principal,
            call,
        )
    }
}
struct DeviceAdmission {
    live: Arc<AtomicBool>,
}
impl ConnectionAdmission for DeviceAdmission {
    fn admit(&self, credential: &[u8], _: i64) -> Option<ConnectionGrant> {
        (self.live.load(Ordering::SeqCst) && credential == b"fixture-device-credential").then(
            || ConnectionGrant { admission_identity: None,
                route: route(),
                expires_at_ms: 2_000,
            },
        )
    }
    fn is_current(&self, grant: &ConnectionGrant, now_ms: i64) -> bool {
        self.live.load(Ordering::SeqCst) && grant.route == route() && now_ms < grant.expires_at_ms
    }
}
fn socket_post(port: u16, bearer: &str, key: &str, version: i64) -> String {
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"run_resource_operation","arguments":{
            "resource":"project:one","operation":"record.mutate","request_key":key,
            "input":{"id":"record:socket","expected_version":version,"value":{"key":key}}
        }
    }})
    .to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let request = format!(
        "POST /mcp HTTP/1.1\r\nHost: mcp.example.test\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer {bearer}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loopback_http_reaches_mac_admission_and_sqlite() {
    let live = Arc::new(AtomicBool::new(true));
    let connections = Arc::new(Connections {
        store: Mutex::new(Store::open(":memory:").unwrap()),
        authority: Authority { live: live.clone() },
        lose_next_reply: AtomicBool::new(false),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let service = Service::new(
        "mcp.example.test",
        Arc::new(Authenticator),
        Arc::new(SocketAnswerer {
            connections: connections.clone(),
        }),
    )
    .unwrap();
    let server = tokio::spawn(async move { serve(listener, service).await });
    let first = tokio::task::spawn_blocking(move || {
        socket_post(port, "example-token-chatgpt", "socket-one", 0)
    })
    .await
    .unwrap();
    assert!(first.starts_with("HTTP/1.1 200"));
    assert!(first.contains("\"version\":1"));
    let second = tokio::task::spawn_blocking(move || {
        socket_post(port, "example-token-claude", "socket-two", 1)
    })
    .await
    .unwrap();
    assert!(second.starts_with("HTTP/1.1 200"));
    assert!(second.contains("\"version\":2"));
    let cross_account = tokio::task::spawn_blocking(move || {
        socket_post(port, "example-token-other", "socket-other", 2)
    })
    .await
    .unwrap();
    assert!(cross_account.contains("resource_route_changed"));
    assert_eq!(
        connections
            .store
            .lock()
            .unwrap()
            .get(ACCOUNT_ONE, "project:one", "record:socket")
            .unwrap()
            .record
            .unwrap()
            .value,
        json!({"key":"socket-two"})
    );
    live.store(false, Ordering::SeqCst);
    let revoked = tokio::task::spawn_blocking(move || {
        socket_post(port, "example-token-chatgpt", "socket-one", 0)
    })
    .await
    .unwrap();
    assert!(revoked.contains("client_not_authorized"));
    server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loopback_http_uses_mac_initiated_websocket_connection() {
    let live = Arc::new(AtomicBool::new(true));
    let registered = Arc::new(AtomicBool::new(true));
    let connections = Arc::new(Connections {
        store: Mutex::new(Store::open(":memory:").unwrap()),
        authority: Authority { live: live.clone() },
        lose_next_reply: AtomicBool::new(false),
    });
    let connection_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let connection_address = connection_listener.local_addr().unwrap();
    let mac_owner = connections.clone();
    let mac_thread = std::thread::spawn(move || {
        let mac = TcpStream::connect(connection_address)?;
        mac.set_read_timeout(Some(Duration::from_secs(3)))?;
        mac.set_write_timeout(Some(Duration::from_secs(3)))?;
        // The loopback socket stands in for the caller-owned verified TLS stream.
        let socket = upgrade_resource_websocket_on_verified_tls(mac, "mcp.example.test")
            .map_err(|error| std::io::Error::other(trillion_local::refusal_cause::CodedError::with_cause("local WebSocket handshake failed", error.cause())))?;
        let key = account_key();
        let row = ComputersRow::sign(ACCOUNT_ONE, 1, &[DEVICE_ONE.to_string()], &[DEVICE_ONE.to_string()], &key)
            .map_err(|_| std::io::Error::other("computers row refused"))?;
        let row = KeptAccount { row, account_key: key.public_hex() };
        connect_mac_session_with_admission(
            socket,
            b"fixture-device-credential",
            &[row],
            &route(),
            std::sync::Arc::new(OneThousand),
            || Ok(()),
            |bytes| {
                dispatch_record_message(
                    bytes,
                    &mut *mac_owner.store.lock().unwrap(),
                    &Context,
                    Some(&mac_owner.authority),
                )
                .map_err(|error| trillion_local::refusal_cause::CodedError::with_cause((), error.cause()))
            },
        )
    });
    let (public, _) = connection_listener.accept().unwrap();
    public
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    public
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let gateway = Arc::new(Gateway::new(
        "mcp.example.test",
        Arc::new(Authenticator),
        Arc::new(Issuer),
        Arc::new(DeviceAdmission {
            live: registered.clone(),
        }),
        std::sync::Arc::new(OneThousand),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let service = gateway.http_service().unwrap();
    let server = tokio::spawn(async move { serve(listener, service).await });
    assert_eq!(gateway.admit_mac_websocket(public, "198.51.100.9:50000").unwrap(), route());
    let first = tokio::task::spawn_blocking(move || {
        socket_post(port, "example-token-chatgpt", "framed-one", 0)
    })
    .await
    .unwrap();
    assert!(first.starts_with("HTTP/1.1 200"));
    assert!(first.contains("\"version\":1"));
    let second = tokio::task::spawn_blocking(move || {
        socket_post(port, "example-token-claude", "framed-two", 1)
    })
    .await
    .unwrap();
    assert!(second.contains("\"version\":2"));
    let cross_account = tokio::task::spawn_blocking(move || {
        socket_post(port, "example-token-other", "framed-other", 2)
    })
    .await
    .unwrap();
    assert!(cross_account.contains("resource_route_unavailable"));
    assert_eq!(
        connections
            .store
            .lock()
            .unwrap()
            .get(ACCOUNT_ONE, "project:one", "record:socket")
            .unwrap()
            .record
            .unwrap()
            .value,
        json!({"key":"framed-two"})
    );
    live.store(false, Ordering::SeqCst);
    let revoked = tokio::task::spawn_blocking(move || {
        socket_post(port, "example-token-chatgpt", "framed-one", 0)
    })
    .await
    .unwrap();
    assert!(revoked.contains("client_not_authorized"));
    live.store(true, Ordering::SeqCst);
    registered.store(false, Ordering::SeqCst);
    let registration_revoked = tokio::task::spawn_blocking(move || {
        socket_post(port, "example-token-claude", "framed-three", 2)
    })
    .await
    .unwrap();
    assert!(registration_revoked.contains("resource_route_unavailable"));
    assert_eq!(
        connections
            .store
            .lock()
            .unwrap()
            .get(ACCOUNT_ONE, "project:one", "record:socket")
            .unwrap()
            .record
            .unwrap()
            .value,
        json!({"key":"framed-two"})
    );
    server.abort();
    let _ = server.await;
    drop(gateway);
    // Retiring the registration drops this fixture socket without a WebSocket
    // close handshake. The Mac treats that transport loss as a failed session.
    assert_eq!(
        mac_thread.join().unwrap().unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
}
fn post_json(forwarder: &McpForwarder<'_>, body: &[u8], authorization: &[u8]) -> Value {
    let headers = [authorization];
    let response = handle(
        Request {
            method: "POST",
            path: "/mcp",
            host: "mcp.example.test",
            expected_host: "mcp.example.test",
            origin_present: false,
            authorization: &headers,
            content_type: Some("application/json"),
            accept: Some("application/json, text/event-stream"),
            body,
        },
        Some(&Authenticator),
        Some(forwarder),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.cache_control(), "no-store");
    serde_json::from_slice(&response.body.unwrap()).unwrap()
}
fn ask(
    forwarder: &McpForwarder<'_>,
    account: &str,
    client: &str,
    key: &str,
    version: i64,
    id: &str,
) -> Value {
    let message = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"run_resource_operation","arguments":{
            "resource":"project:one","operation":"record.mutate","request_key":key,
            "input":{"id":id,"expected_version":version,"value":{"writer":client}}
        }
    }});
    let bearer: &[u8] = match (account, client) {
        (ACCOUNT_ONE, "chatgpt") => b"Bearer example-token-chatgpt",
        (ACCOUNT_ONE, "claude") => b"Bearer example-token-claude",
        (ACCOUNT_OTHER, "chatgpt") => b"Bearer example-token-other",
        _ => panic!("unsupported fixture identity"),
    };
    post_json(forwarder, &serde_json::to_vec(&message).unwrap(), bearer)
}

fn ask_with_value(
    forwarder: &McpForwarder<'_>,
    client: &str,
    key: &str,
    version: i64,
    id: &str,
    value: Value,
) -> Value {
    let message = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"run_resource_operation","arguments":{
            "resource":"project:one","operation":"record.mutate","request_key":key,
            "input":{"id":id,"expected_version":version,"value":value}
        }
    }});
    let bearer = match client {
        "chatgpt" => b"Bearer example-token-chatgpt".as_slice(),
        "claude" => b"Bearer example-token-claude".as_slice(),
        _ => panic!("unsupported fixture identity"),
    };
    post_json(forwarder, &serde_json::to_vec(&message).unwrap(), bearer)
}

#[test]
fn public_mcp_to_mac_sqlite_preserves_accounts_clients_and_lost_reply_retries() {
    let live = Arc::new(AtomicBool::new(true));
    let connections = Connections {
        store: Mutex::new(Store::open(":memory:").unwrap()),
        authority: Authority { live: live.clone() },
        lose_next_reply: AtomicBool::new(false),
    };
    let forwarder = McpForwarder {
        directory: &Directory,
        issuer: &Issuer,
        connections: &connections,
        now_ms: std::sync::Arc::new(OneThousand),
    };
    let first = ask(
        &forwarder,
        ACCOUNT_ONE,
        "chatgpt",
        "same-key",
        0,
        "record:one",
    );
    assert_eq!(first["result"]["structuredContent"]["version"], 1);
    let second = ask(
        &forwarder,
        ACCOUNT_ONE,
        "claude",
        "same-key",
        1,
        "record:one",
    );
    assert_eq!(second["result"]["structuredContent"]["version"], 2);
    assert_eq!(
        connections
            .store
            .lock()
            .unwrap()
            .get(ACCOUNT_ONE, "project:one", "record:one")
            .unwrap()
            .record
            .unwrap()
            .value,
        json!({"writer":"claude"})
    );
    let cross_account = ask(
        &forwarder,
        ACCOUNT_OTHER,
        "chatgpt",
        "new-key",
        0,
        "record:two",
    );
    assert_eq!(
        cross_account["result"]["structuredContent"]["code"],
        "resource_route_changed"
    );
    connections.lose_next_reply.store(true, Ordering::SeqCst);
    let unknown = ask(
        &forwarder,
        ACCOUNT_ONE,
        "chatgpt",
        "lost-key",
        0,
        "record:two",
    );
    assert_eq!(unknown["result"]["structuredContent"]["outcome"], "unknown");
    let recovered = ask(
        &forwarder,
        ACCOUNT_ONE,
        "chatgpt",
        "lost-key",
        0,
        "record:two",
    );
    assert_eq!(recovered["result"]["structuredContent"]["version"], 1);
    assert_eq!(
        connections
            .store
            .lock()
            .unwrap()
            .changes(ACCOUNT_ONE, "project:one", 0, 10)
            .unwrap()
            .len(),
        3
    );
    let large_message = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"run_resource_operation","arguments":{
            "resource":"project:one","operation":"record.mutate","request_key":"large-key",
            "input":{"id":"record:large","expected_version":0,"value":{"blob":"x".repeat(58_000)}}
        }
    }});
    let large_reply = post_json(
        &forwarder,
        &serde_json::to_vec(&large_message).unwrap(),
        b"Bearer example-token-chatgpt",
    );
    assert_eq!(large_reply["result"]["structuredContent"]["version"], 1);
    assert!(serde_json::to_vec(&large_reply).unwrap().len() < 65_536);
    assert_eq!(
        connections
            .store
            .lock()
            .unwrap()
            .get(ACCOUNT_ONE, "project:one", "record:large")
            .unwrap()
            .record
            .unwrap()
            .value["blob"]
            .as_str()
            .unwrap()
            .len(),
        58_000
    );
    live.store(false, Ordering::SeqCst);
    let denied = ask(
        &forwarder,
        ACCOUNT_ONE,
        "chatgpt",
        "lost-key",
        0,
        "record:two",
    );
    assert_eq!(
        denied["result"]["structuredContent"]["code"],
        "client_not_authorized"
    );
    assert_eq!(
        denied["result"]["structuredContent"]["outcome"],
        "not_started"
    );
}

/// A clock that reads 1000 ms, the time these dispatch tests check their grants and windows against.
struct OneThousand;
impl trillion_local::storage::time_source::Clock for OneThousand {
    fn now_ms(&self) -> i64 {
        1_000
    }
}
