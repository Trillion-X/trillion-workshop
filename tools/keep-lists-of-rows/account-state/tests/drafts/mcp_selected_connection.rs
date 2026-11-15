// End-to-end consumer controls for the selected Mac connection candidate.
// Included as a child of the existing selected_workspace_write controls so
// every write reaches the same original fixture account, journal and writer.
use super::*;
use content_crypto::advanced::blake3;
use crate::{
    mcp::http::BearerAuthenticator,
    forwarder::{gateway::Gateway, session::{ConnectionAdmission, ConnectionGrant}},
    resource_authority::Route,
};
use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Condvar, Mutex},
    thread,
    time::Instant,
};
use tower::ServiceExt;

const PUBLIC_HOST: &str = "mcp.synthetic.test";
const DEVICE_CREDENTIAL: &[u8] = b"SYNTHETIC_SELECTED_DEVICE_ADMISSION_ONLY";

struct GatewayAuth { fixture: Arc<Fixture>, withdraw_next: Arc<AtomicBool> }
impl BearerAuthenticator for GatewayAuth {
    fn authenticate(&self, bearer: &[u8]) -> Option<Principal> {
        if bearer == self.fixture.token.as_bytes() {
            let principal = self.fixture.principal();
            if self.withdraw_next.swap(false, Ordering::SeqCst) {
                let db = Connection::open(self.fixture.root.join("storage/kv/trillion-local-app/current.sqlite")).ok()?;
                let digest = SecretNativeKey::parse(&self.fixture.token).ok()?.identity();
                if db.execute("DELETE FROM _mf_entries WHERE key=?", [format!("personal-key:{digest}")]).ok()? != 1 {
                    return None;
                }
            }
            Some(principal)
        } else if bearer == b"synthetic-other-account" {
            Some(Principal { account_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                sign_in: "grant:synthetic-other-sign-in".into(), client_id: String::new() })
        } else { None }
    }
}
struct DeviceRegistration(Route);
impl ConnectionAdmission for DeviceRegistration {
    fn admit(&self, credential: &[u8], now: i64) -> Option<ConnectionGrant> {
        (credential == DEVICE_CREDENTIAL).then(|| ConnectionGrant { admission_identity: None, route: self.0.clone(), expires_at_ms: now + 30_000 })
    }
    fn is_current(&self, grant: &ConnectionGrant, now: i64) -> bool {
        grant.route == self.0 && now < grant.expires_at_ms
    }
}
fn gateway_now() -> i64 { i64::try_from(millis()).unwrap() }

fn public_route() -> Route {
    Route { account_id: OWNER.into(), device_id: "synthetic-selected-device".into(),
        resource_address: "@own-records".into(), generation: "synthetic-route-generation".into() }
}

struct LoseMacReply<T> { inner: T, credential_message_bytes: usize, written: usize }
impl<T: Read> Read for LoseMacReply<T> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> { self.inner.read(bytes) }
}
impl<T: Write> Write for LoseMacReply<T> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.written >= self.credential_message_bytes {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "synthetic reply loss"));
        }
        let remaining = self.credential_message_bytes - self.written;
        let count = self.inner.write(&bytes[..bytes.len().min(remaining)])?;
        self.written += count;
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> { self.inner.flush() }
}

struct RunningGateway {
    stop: Arc<AtomicBool>,
    admitted: Arc<(Mutex<usize>, Condvar)>,
    app: axum::Router,
    mac_endpoint: MacEndpoint,
    selected_http_host: String,
    selected: Arc<Mutex<crate::native_boot::SelectedAccount>>,
    withdraw_next: Arc<AtomicBool>,
    unix_path: Option<PathBuf>,
    _acceptor: Option<thread::JoinHandle<()>>,
}
enum MacEndpoint { Tcp(SocketAddr), Unix(PathBuf) }
enum MacListener { Tcp(TcpListener), Unix(UnixListener) }
impl MacListener {
    fn accept(&self) -> io::Result<Box<dyn ReadWrite>> {
        match self {
            Self::Tcp(listener) => {
                let (stream, _) = listener.accept()?;
                stream.set_nonblocking(false)?;
                stream.set_read_timeout(Some(Duration::from_secs(5)))?;
                stream.set_write_timeout(Some(Duration::from_secs(5)))?;
                Ok(Box::new(stream))
            }
            Self::Unix(listener) => {
                let (stream, _) = listener.accept()?;
                stream.set_nonblocking(false)?;
                stream.set_read_timeout(Some(Duration::from_secs(5)))?;
                stream.set_write_timeout(Some(Duration::from_secs(5)))?;
                Ok(Box::new(stream))
            }
        }
    }
}
impl MacEndpoint {
    fn connect(&self) -> io::Result<Box<dyn ReadWrite>> {
        match self {
            Self::Tcp(address) => {
                let stream = TcpStream::connect(address)?;
                stream.set_read_timeout(Some(Duration::from_secs(5)))?;
                stream.set_write_timeout(Some(Duration::from_secs(5)))?;
                Ok(Box::new(stream))
            }
            Self::Unix(path) => {
                let stream = UnixStream::connect(path)?;
                stream.set_read_timeout(Some(Duration::from_secs(5)))?;
                stream.set_write_timeout(Some(Duration::from_secs(5)))?;
                Ok(Box::new(stream))
            }
        }
    }
}
impl RunningGateway {
    fn new(fixture: &Arc<Fixture>) -> Self {
        Self::with_transport(fixture, false, None)
    }
    fn new_unix(fixture: &Arc<Fixture>, selected: Arc<Mutex<crate::native_boot::SelectedAccount>>) -> Self {
        Self::with_transport(fixture, true, Some(selected))
    }
    fn with_transport(fixture: &Arc<Fixture>, unix: bool, retained: Option<Arc<Mutex<crate::native_boot::SelectedAccount>>>) -> Self {
        let route = public_route();
        let withdraw_next = Arc::new(AtomicBool::new(false));
        let gateway = Arc::new(Gateway::new(
            PUBLIC_HOST,
            Arc::new(GatewayAuth { fixture: fixture.clone(), withdraw_next: withdraw_next.clone() }),
            Arc::new(crate::mcp_personal_key::PersonalKeyForwarder),
            Arc::new(DeviceRegistration(route.clone())),
            gateway_now,
        ));
        let app = crate::mcp::http::axum_adapter::route_table(gateway.http_service().unwrap());
        let (inbound, endpoint, selected_address, unix_path) = if unix {
            let address_probe = TcpListener::bind("127.0.0.1:0").unwrap();
            let selected_address = address_probe.local_addr().unwrap();
            drop(address_probe);
            let path = fixture.root.join("selected-mcp-carrier.sock");
            let listener = UnixListener::bind(&path).unwrap();
            listener.set_nonblocking(true).unwrap();
            (MacListener::Unix(listener), MacEndpoint::Unix(path.clone()), selected_address, Some(path))
        } else {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            listener.set_nonblocking(true).unwrap();
            (MacListener::Tcp(listener), MacEndpoint::Tcp(address), address, None)
        };
        let inbound_address = selected_address;
        let selected = retained.unwrap_or_else(|| Arc::new(Mutex::new(fixture.selected_at(inbound_address))));
        let stop = Arc::new(AtomicBool::new(false));
        let admitted = Arc::new((Mutex::new(0_usize), Condvar::new()));
        let accept_gateway = gateway.clone();
        let accept_stop = stop.clone();
        let accept_admitted = admitted.clone();
        let acceptor = thread::spawn(move || {
            while !accept_stop.load(Ordering::SeqCst) {
                match inbound.accept() {
                    Ok(stream) => {
                        if accept_gateway.admit_mac_connection(stream).is_ok() {
                            let (lock, ready) = &*accept_admitted;
                            *lock.lock().unwrap() += 1;
                            ready.notify_all();
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
                    Err(_) => break,
                }
            }
        });
        Self { stop, admitted, app, mac_endpoint: endpoint,
            selected_http_host: "127.0.0.1:28788".into(), selected,
            withdraw_next, unix_path, _acceptor: Some(acceptor) }
    }

    fn connect_mac(&self, lose_first_reply: bool) -> thread::JoinHandle<io::Result<()>> {
        let endpoint = match &self.mac_endpoint { MacEndpoint::Tcp(address) => MacEndpoint::Tcp(*address), MacEndpoint::Unix(path) => MacEndpoint::Unix(path.clone()) };
        let route = public_route();
        let selected = self.selected.clone();
        let handle = tokio::runtime::Handle::current();
        thread::spawn(move || {
            let stream = endpoint.connect()?;
            let stream = if lose_first_reply {
                let count = DEVICE_CREDENTIAL.len() + 4;
                Box::new(LoseMacReply { inner: stream, credential_message_bytes: count, written: 0 }) as Box<dyn ReadWrite>
            } else { Box::new(stream) as Box<dyn ReadWrite> };
            let result = crate::native_boot::forwarder_connection::connect_selected_mac_session(
                stream, DEVICE_CREDENTIAL, &route, selected, gateway_now, &handle,
            );
            if let Err(error) = &result { eprintln!("synthetic Mac connection ended: {:?}: {}", error.kind(), error); }
            result
        })
    }

    fn wait_for_admission(&self, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let (lock, ready) = &*self.admitted;
        let mut admitted = lock.lock().unwrap();
        while *admitted < count {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for Mac connection admission");
            let (next, timeout) = ready.wait_timeout(admitted, remaining).unwrap();
            admitted = next;
            assert!(!timeout.timed_out() || *admitted >= count, "timed out waiting for Mac connection admission");
        }
    }

    fn withdraw_on_next_gateway_authentication(&self) {
        self.withdraw_next.store(true, Ordering::SeqCst);
    }

    async fn call(&self, key: &str, client: &str, resource: &str, method: &str, payload: Value, bearer: &str) -> (axum::http::StatusCode, Vec<u8>) {
        let body = json!({
            "jsonrpc":"2.0", "id":format!("{client}-{key}"), "method":"tools/call",
            "params":{"name":"run_resource_operation","arguments":{
                "address":resource,"method":method,"request_key":key,"input":payload
            },"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                "io.modelcontextprotocol/clientInfo":{"name":client,"version":"1"},
                "io.modelcontextprotocol/clientCapabilities":{}}}
        });
        let request = axum::http::Request::builder().method("POST").uri("/mcp")
            .header("Host", PUBLIC_HOST).header("Authorization", format!("Bearer {bearer}"))
            .header("Content-Type", "application/json").header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2026-07-28").header("Mcp-Method", "tools/call")
            .header("Mcp-Name", "run_resource_operation").body(axum::body::Body::from(body.to_string())).unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 65_536).await.unwrap().to_vec();
        (status, bytes)
    }
}
impl Drop for RunningGateway {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(acceptor) = self._acceptor.take() { acceptor.join().expect("admission acceptor exits on stop"); }
        if let Some(path) = &self.unix_path { let _ = std::fs::remove_file(path); }
    }
}

trait ReadWrite: Read + Write + Send {}
impl<T: Read + Write + Send> ReadWrite for T {}

#[test]
fn personal_key_forwarder_requires_the_original_authenticated_bearer() {
    use crate::forwarder::ClientProofIssuer;
    let token = format!("nm_{}", blake3::hash(b"SYNTHETIC_FORWARDER_ONLY").to_hex());
    let digest = SecretNativeKey::parse(&token).unwrap().identity();
    let mut principal = Principal { account_id: OWNER.into(), sign_in: format!("key:{digest}"), client_id: String::new() };
    let route = public_route();
    let mut message = crate::resource_authority::InvokeMessage { person_present: None,
        request_id: "synthetic-forwarder".into(), account_id: route.account_id,
        operation_resource: None,
        device_id: route.device_id, resource_address: route.resource_address,
        generation: route.generation, operation: "workspace:read".into(),
        input: json!({}), request_key: "synthetic-forwarder".into(),
        client_authorization: String::new(), deadline_at_ms: gateway_now() + 1_000,
    };
    let issuer = crate::mcp_personal_key::PersonalKeyForwarder;
    assert!(issuer.issue(&principal, &message).is_none());
    assert!(issuer.issue_with_bearer(&principal, b"", &message).is_none());
    assert_eq!(issuer.issue_with_bearer(&principal, token.as_bytes(), &message).as_deref(), Some(token.as_str()));
    principal.sign_in = "grant:synthetic-other-sign-in".into();
    assert!(issuer.issue_with_bearer(&principal, token.as_bytes(), &message).is_none());
    principal.sign_in = format!("key:{digest}");
    message.account_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into();
    assert!(issuer.issue_with_bearer(&principal, token.as_bytes(), &message).is_none());
    message.account_id = OWNER.into();
    message.client_authorization = "synthetic-existing-proof".into();
    assert!(issuer.issue_with_bearer(&principal, token.as_bytes(), &message).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_gateway_http_uses_selected_mac_and_original_journal_after_reply_loss() {
    let fixture = Arc::new(Fixture::new());
    let before = state(&fixture);
    let running = RunningGateway::new(&fixture);
    // First client commits on the selected account, while the Mac loses the
    // socket reply. The gateway must report uncertainty, retaining the key.
    let first_mac = running.connect_mac(true);
    running.wait_for_admission(1);
    let (status, lost) = running.call("carrier-original-retry", "synthetic-ai-one", "@own-records", "workspace:write", input(), &fixture.token).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let lost_reply: Value = serde_json::from_slice(&lost).unwrap();
    assert_eq!(lost_reply["result"]["isError"], true);
    assert_eq!(lost_reply["result"]["structuredContent"], json!({"code":"resource_outcome_unknown","outcome":"unknown","request_key":"carrier-original-retry"}));
    assert!(!String::from_utf8_lossy(&lost).contains(&fixture.token));
    let committed = state(&fixture);
    assert!(committed.0.contains("written"));
    assert!(committed.1 > 0);
    assert_eq!(committed.2, 1);
    assert!(first_mac.join().unwrap().is_err());

    // A fresh admitted connection and a second client retry the exact original
    // key. The canonical journal returns the saved result without a second write.
    let second_mac = running.connect_mac(false);
    running.wait_for_admission(2);
    let (retry_status, retry) = running.call("carrier-original-retry", "synthetic-ai-two", "@own-records", "workspace:write", input(), &fixture.token).await;
    assert_eq!(retry_status, axum::http::StatusCode::OK);
    let retry_reply: Value = serde_json::from_slice(&retry).unwrap();
    assert_eq!(retry_reply["result"]["isError"], false);
    assert_eq!(retry_reply["result"]["structuredContent"]["written"], 1);
    assert_eq!(state(&fixture), committed);
    assert!(!String::from_utf8_lossy(&retry).contains(&fixture.token));
    let mut changed = input();
    changed["writes"][0]["payload"] = json!({"items":["different"]});
    let (changed_status, changed_reply) = running.call("carrier-original-retry", "synthetic-ai-two", "@own-records", "workspace:write", changed, &fixture.token).await;
    assert_eq!(changed_status, axum::http::StatusCode::OK);
    let changed_reply: Value = serde_json::from_slice(&changed_reply).unwrap();
    assert_eq!(changed_reply["result"]["isError"], true);
    assert_eq!(changed_reply["result"]["structuredContent"], json!({"code":"original_command_conflict","outcome":"not_started","request_key":"carrier-original-retry"}));
    assert_eq!(state(&fixture), committed, "changed input cannot reuse an original committed request key");
    let (read_status, readback) = running.call("carrier-second-client-read", "synthetic-ai-two", "@own-records", "workspace:read", json!({}), &fixture.token).await;
    assert_eq!(read_status, axum::http::StatusCode::OK);
    let read_reply: Value = serde_json::from_slice(&readback).unwrap();
    assert_eq!(read_reply["result"]["isError"], false);
    let canonical: Value = serde_json::from_str(read_reply["result"]["structuredContent"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(canonical["records"]["saved-board"], json!({"items":["written"]}));
    assert!(!String::from_utf8_lossy(&readback).contains(&fixture.token));
    assert_eq!(state(&fixture), committed, "the second client's read adds no journal commit");
    let local = crate::native_boot::mcp_local::route_table(running.selected.clone(), running.selected_http_host.clone()).unwrap();
    let local_retry = local.oneshot(local_http_request(&fixture, "carrier-original-retry", "2026-07-28")).await.unwrap();
    assert_eq!(local_retry.status(), axum::http::StatusCode::OK);
    let local_body = axum::body::to_bytes(local_retry.into_body(), 65_536).await.unwrap();
    let local_reply: Value = serde_json::from_slice(&local_body).unwrap();
    assert_eq!(local_reply["result"]["isError"], false);
    assert_eq!(local_reply["result"]["structuredContent"]["written"], 1);
    assert_eq!(state(&fixture), committed, "direct local retry preserves the gateway's original journal key");
    drop(running);
    second_mac.join().unwrap().unwrap();
    assert_eq!(state(&fixture), committed);
    assert_ne!(before, committed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_key_withdrawal_after_admission_refuses_work_without_disclosure() {
    let fixture = Arc::new(Fixture::new());
    let running = RunningGateway::new(&fixture);
    let mac = running.connect_mac(false);
    running.wait_for_admission(1);
    running.withdraw_on_next_gateway_authentication();
    let before = state(&fixture);
    let (status, response) = running.call("withdrawn-selected-key", "synthetic-ai", "@own-records", "workspace:write", input(), &fixture.token).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let refused: Value = serde_json::from_slice(&response).unwrap();
    assert_eq!(refused["result"]["isError"], true);
    assert_eq!(refused["result"]["structuredContent"], json!({"code":"client_not_authorized","outcome":"not_started","request_key":"withdrawn-selected-key"}));
    assert!(!String::from_utf8_lossy(&response).contains(&fixture.token));
    assert_eq!(state(&fixture), before);
    drop(running);
    let _ = mac.join();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wrong_selected_account_and_resource_route_refuse_without_private_result() {
    let fixture = Arc::new(Fixture::new());
    let before = state(&fixture);
    let running = RunningGateway::new(&fixture);
    let mac = running.connect_mac(false);
    running.wait_for_admission(1);
    let (wrong_account_status, wrong_account) = running.call("wrong-account", "synthetic-ai", "@own-records", "workspace:write", input(), "synthetic-other-account").await;
    assert_eq!(wrong_account_status, axum::http::StatusCode::OK);
    let wrong_account_reply: Value = serde_json::from_slice(&wrong_account).unwrap();
    assert_eq!(wrong_account_reply["result"]["isError"], true);
    assert_eq!(wrong_account_reply["result"]["structuredContent"], json!({"code":"resource_route_unavailable","outcome":"not_started","request_key":"wrong-account"}));
    assert!(!String::from_utf8_lossy(&wrong_account).contains(&fixture.token));
    let (wrong_route_status, wrong_route) = running.call("wrong-resource", "synthetic-ai", "@another-resource", "workspace:write", input(), &fixture.token).await;
    assert_eq!(wrong_route_status, axum::http::StatusCode::OK);
    let wrong_route_reply: Value = serde_json::from_slice(&wrong_route).unwrap();
    assert_eq!(wrong_route_reply["result"]["isError"], true);
    assert_eq!(wrong_route_reply["result"]["structuredContent"], json!({"code":"resource_route_unavailable","outcome":"not_started","request_key":"wrong-resource"}));
    assert!(!String::from_utf8_lossy(&wrong_route).contains(&fixture.token));
    assert_eq!(state(&fixture), before);
    drop(running);
    let _ = mac.join();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unix_stream_connection_uses_the_same_gateway_and_selected_original_writer() {
    let fixture = Arc::new(Fixture::new());
    let before = state(&fixture);
    let tcp = RunningGateway::new(&fixture);
    let tcp_mac = tcp.connect_mac(false);
    tcp.wait_for_admission(1);
    let (tcp_status, tcp_response) = tcp.call("unix-selected-write", "synthetic-tcp-client", "@own-records", "workspace:write", input(), &fixture.token).await;
    assert_eq!(tcp_status, axum::http::StatusCode::OK);
    let tcp_reply: Value = serde_json::from_slice(&tcp_response).unwrap();
    assert_eq!(tcp_reply["result"]["isError"], false, "{}", tcp_reply["result"]["structuredContent"]);
    let committed = state(&fixture);
    let retained = tcp.selected.clone();
    drop(tcp);
    tcp_mac.join().unwrap().unwrap();
    let running = RunningGateway::new_unix(&fixture, retained.clone());
    assert!(Arc::ptr_eq(&running.selected, &retained));
    let mac = running.connect_mac(false);
    running.wait_for_admission(1);
    let (status, response) = running.call("unix-selected-write", "synthetic-unix-client", "@own-records", "workspace:write", input(), &fixture.token).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let reply: Value = serde_json::from_slice(&response).unwrap();
    assert_eq!(reply["result"]["isError"], false);
    assert_eq!(reply["result"]["structuredContent"]["written"], 1);
    assert!(!String::from_utf8_lossy(&response).contains(&fixture.token));
    let after = state(&fixture);
    assert!(after.0.contains("written"));
    assert!(after.1 > 0);
    assert_eq!(after.2, 1);
    assert_eq!(after, committed, "transport replacement reuses the same selected owner and journal");
    assert_eq!(reply["result"]["structuredContent"], tcp_reply["result"]["structuredContent"]);
    let (read_status, readback) = running.call("unix-selected-read", "synthetic-unix-client", "@own-records", "workspace:read", json!({}), &fixture.token).await;
    assert_eq!(read_status, axum::http::StatusCode::OK);
    let read_reply: Value = serde_json::from_slice(&readback).unwrap();
    assert_eq!(read_reply["result"]["isError"], false);
    let canonical: Value = serde_json::from_str(read_reply["result"]["structuredContent"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(canonical["records"]["saved-board"], json!({"items":["written"]}));
    assert_eq!(state(&fixture), committed);
    drop(running);
    mac.join().unwrap().unwrap();
    assert_ne!(before, after);
}
