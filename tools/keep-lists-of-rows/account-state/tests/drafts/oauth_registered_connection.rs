// Purpose: Join canonical synthetic device registration/short credentials,
// actual verified TLS/WebSocket/session adapters, and independent OAuth SDK
// clients on the same selected account and original SQLite writer.
// Invariants: reuse the original issuer and admission owners; no new token
// authority, account store, real enrollment, hosted publication or domain logic.
// Limits: the HTTP SDK client remains in-process; parent-current is an explicit
// test supply. This does not qualify native outbound publication or real AIs.
use super::*;
use super::super::super::{
    current_state as state,
    oauth_independent_grants_controls::{with_independent_grants, http_reply, GRANT_A, TOKEN_A, TOKEN_B},
    oauth_read_consumer_controls::oauth_read_request,
    oauth_rmcp_client_consumer_controls::client_call_on_gateway,
    oauth_test_support::SyntheticOAuthIssuer,
};
use crate::{
    native_boot::{forwarder_connection::SelectedMacDispatcher, oauth_gateway::{OAuthBearerAuthenticator, OAuthBearerForwarder}},
    forwarder::{gateway::Gateway, session, websocket},
};
use native_tls::TlsAcceptor;
use std::{io, net::{TcpListener, TcpStream}, thread};
use std::sync::atomic::{AtomicBool, Ordering};

struct ObservedPeerEof<S> { stream: S, eof: Arc<AtomicBool> }
impl<S: io::Read> io::Read for ObservedPeerEof<S> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.stream.read(bytes)?;
        if count == 0 && !bytes.is_empty() { self.eof.store(true, Ordering::SeqCst); }
        Ok(count)
    }
}
impl<S: io::Write> io::Write for ObservedPeerEof<S> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { self.stream.write(bytes) }
    fn flush(&mut self) -> io::Result<()> { self.stream.flush() }
}
struct ConnectionWorker { task: thread::JoinHandle<io::Result<()>>, peer_eof: Arc<AtomicBool> }

fn now() -> i64 { i64::try_from(millis()).unwrap() }

async fn attach_verified_wss(
    gateway: Arc<Gateway>, owner: Arc<Mutex<SelectedAccount>>,
    issuer: Arc<SyntheticOAuthIssuer>, token: &IssuedCredential,
) -> ConnectionWorker {
    let material = tempfile::tempdir().unwrap();
    let (identity, connector) = crate::forwarder::tls::fixture::identity(material.path());
    let acceptor = TlsAcceptor::new(identity).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let mac_tcp = TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
    let (gateway_tcp, _) = listener.accept().unwrap();
    for stream in [&mac_tcp, &gateway_tcp] {
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(10))).unwrap();
    }
    let expected_host = format!("mcp.example.test:{}", address.port());
    let mac_host = expected_host.clone();
    let raw = zeroize::Zeroizing::new(token.as_bytes().to_vec());
    let route = token.grant().route.clone();
    let expected_route = route.clone();
    let runtime = tokio::runtime::Handle::current();
    let peer_eof = Arc::new(AtomicBool::new(false));
    let observed_eof = peer_eof.clone();
    let worker = thread::spawn(move || {
        let _material = material;
        let tls = connector.connect("mcp.example.test", mac_tcp)
            .map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "synthetic connection TLS refused"))?;
        let stream = websocket::upgrade_resource_websocket_on_verified_tls(
            ObservedPeerEof { stream: tls, eof: observed_eof }, &mac_host)
            .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, crate::refusal_cause::CodedError::with_cause("synthetic connection upgrade refused", error.cause())))?;
        let dispatcher = SelectedMacDispatcher::new_with_oauth(owner, route.clone(),
            issuer.authority.clone(), Arc::new(|| true), now)
            .map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "synthetic selected owner refused"))?;
        session::connect_mac_session_with_admission(stream, &raw, &route, now,
            || Ok(()), |bytes| runtime.block_on(dispatcher.dispatch(bytes)))
    });
    let admitted = tokio::task::spawn_blocking(move || {
        let tls = acceptor.accept(gateway_tcp).expect("fresh trusted connection TLS");
        let stream = websocket::accept_resource_websocket(tls, &expected_host)
            .expect("exact WSS resource endpoint and Host");
        gateway.admit_mac_connection(stream)
    }).await.unwrap().expect("canonical original short-credential admission");
    assert_eq!(admitted, expected_route);
    ConnectionWorker { task: worker, peer_eof }
}

fn assert_closed(worker: ConnectionWorker) {
    match worker.task.join().expect("connection worker must not panic") {
        Ok(()) => {},
        // Retiring a fixture session drops its socket without a WebSocket Close
        // handshake. Accept that protocol error only with observed TLS EOF;
        // malformed chunks on an open transport still fail this assertion.
        Err(error) => assert!(matches!(error.kind(), io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset)
            || (error.kind() == io::ErrorKind::InvalidData && worker.peer_eof.load(Ordering::SeqCst)),
            "only peer closure is expected when a fixture retires its connection"),
    }
}

fn gateway(issuer: &SyntheticOAuthIssuer,
    admission: Arc<SelectedCredentialAdmission>) -> Arc<Gateway>
{
    Arc::new(Gateway::new("127.0.0.1:28788",
        Arc::new(OAuthBearerAuthenticator::new(issuer.authority.clone(), now)),
        Arc::new(OAuthBearerForwarder {}), admission, now))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn registered_wss_preserves_other_grant_after_local_withdrawal_and_refuses_device_revocation() {
    let (fixture, key) = setup();
    let (fixture, issuer) = with_independent_grants(fixture);
    let (owner, admission) = source(&fixture, &key);
    let admission = Arc::new(admission);
    let token = issued(&admission, &key, "registered-wss-original-short-token", 0, now()).unwrap();
    assert!(token.as_bytes().starts_with(b"trc_"));
    assert!(admission.admit(key.as_bytes(), now()).is_none(), "tc_ never becomes public session authority");
    let gateway = gateway(&issuer, admission.clone());
    let worker = attach_verified_wss(gateway.clone(), owner, issuer, &token).await;
    let app = crate::mcp::http::axum_adapter::route_table(gateway.http_service().unwrap());
    let before = state(&fixture);
    let result = client_call_on_gateway(app.clone(), TOKEN_A.into(), "registered-sdk-a", "workspace:write",
        "registered-wss-a-write", json!({"writes":[{"address_label":"saved-board","payload":{"items":["registered-wss-a-value"]}}],"conflict_policy":"retry"})).await;
    assert_eq!(result["written"], 1);
    let committed = state(&fixture);
    assert_eq!(committed.2, before.2 + 1);
    let read = client_call_on_gateway(app.clone(), TOKEN_B.into(), "registered-sdk-b", "workspace:read",
        "registered-wss-b-read", json!({})).await;
    assert!(read["text"].as_str().unwrap().contains("registered-wss-a-value"));
    assert_eq!(state(&fixture), committed);
    super::super::super::change_gate(&fixture, "oauth-a-use.sqlite", |state| {
        state["sign_ins"][GRANT_A]["ended_until_ms"] = json!(millis() + 60_000);
    });
    let (_, denied) = http_reply(app.clone(), oauth_read_request(TOKEN_A, "registered-wss-a-withdrawn")).await;
    assert_eq!(denied["result"]["structuredContent"]["code"], "resource_outcome_unknown");
    assert!(!denied.to_string().contains("registered-wss-a-value"));
    assert_eq!(state(&fixture), committed);
    let read = client_call_on_gateway(app.clone(), TOKEN_B.into(), "registered-sdk-b", "workspace:read",
        "registered-wss-b-after-a-withdrawn", json!({})).await;
    assert!(read["text"].as_str().unwrap().contains("registered-wss-a-value"));
    assert_eq!(state(&fixture), committed);
    let write = client_call_on_gateway(app.clone(), TOKEN_B.into(), "registered-sdk-b", "workspace:write",
        "registered-wss-b-new-write", json!({"writes":[{"address_label":"saved-board","payload":{"items":["registered-wss-b-value"]}}],"conflict_policy":"retry"})).await;
    assert_eq!(write["written"], 1);
    let after = state(&fixture);
    assert!(after.0.contains("registered-wss-b-value"));
    assert_eq!(after.2, committed.2 + 1);
    apply(&fixture, &change(&key, 1, false, "registered-wss-device-withdrawal")).unwrap();
    assert!(!admission.is_current(token.grant(), now()));
    let (_, denied) = http_reply(app.clone(), oauth_read_request(TOKEN_B, "registered-wss-device-withdrawn")).await;
    assert_eq!(denied["result"]["structuredContent"]["code"], "resource_route_unavailable");
    assert!(!denied.to_string().contains("registered-wss-b-value"));
    assert_eq!(state(&fixture), after);
    drop(app);
    drop(gateway);
    assert_closed(worker);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn registered_wss_token_rotation_keeps_original_write_identity_and_shared_state() {
    let (fixture, key) = setup();
    let (fixture, issuer) = with_independent_grants(fixture);
    let (owner, admission) = source(&fixture, &key);
    let admission = Arc::new(admission);
    let first = issued(&admission, &key, "registered-wss-first-token", 0, now()).unwrap();
    let gateway = gateway(&issuer, admission.clone());
    let worker = attach_verified_wss(gateway.clone(), owner.clone(), issuer.clone(), &first).await;
    let app = crate::mcp::http::axum_adapter::route_table(gateway.http_service().unwrap());
    let payload = json!({"writes":[{"address_label":"saved-board","payload":{"items":["registered-wss-portable-commit"]}}],"conflict_policy":"retry"});
    let result = client_call_on_gateway(app.clone(), TOKEN_A.into(), "registered-sdk-a", "workspace:write",
        "registered-wss-original-write", payload.clone()).await;
    assert_eq!(result["written"], 1);
    let committed = state(&fixture);
    let second = issued(&admission, &key, "registered-wss-rotated-token", 1, now()).unwrap();
    assert_eq!(second.grant().route, first.grant().route);
    assert!(!admission.is_current(first.grant(), now()));
    let (_, denied) = http_reply(app.clone(), oauth_read_request(TOKEN_B, "registered-wss-old-token-refused")).await;
    assert_eq!(denied["result"]["structuredContent"]["code"], "resource_route_unavailable");
    assert_eq!(state(&fixture), committed);
    assert_closed(worker);
    let replacement = attach_verified_wss(gateway.clone(), owner, issuer, &second).await;
    let retried = client_call_on_gateway(app.clone(), TOKEN_A.into(), "registered-sdk-a", "workspace:write",
        "registered-wss-original-write", payload).await;
    assert_eq!(retried["written"], 1);
    assert_eq!(state(&fixture), committed, "rotation must not replay the original command");
    let read = client_call_on_gateway(app.clone(), TOKEN_B.into(), "registered-sdk-b", "workspace:read",
        "registered-wss-b-after-token-rotation", json!({})).await;
    assert!(read["text"].as_str().unwrap().contains("registered-wss-portable-commit"));
    assert_eq!(state(&fixture), committed);
    drop(app);
    drop(gateway);
    assert_closed(replacement);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replacement_gateway_reconnects_same_owner_without_replaying_committed_write() {
    let (fixture, key) = setup();
    let (fixture, issuer) = with_independent_grants(fixture);
    let (owner, admission) = source(&fixture, &key);
    let admission = Arc::new(admission);
    let token = issued(&admission, &key, "replacement-gateway-short-token", 0, now()).unwrap();
    let first_gateway = gateway(&issuer, admission.clone());
    let first_worker = attach_verified_wss(
        first_gateway.clone(), owner.clone(), issuer.clone(), &token,
    ).await;
    let first_app = crate::mcp::http::axum_adapter::route_table(first_gateway.http_service().unwrap());
    let payload = json!({"writes":[{"address_label":"saved-board","payload":{"items":["replacement-gateway-commit"]}}],"conflict_policy":"retry"});
    let original_key = "replacement-gateway-original-write";
    let written = client_call_on_gateway(first_app.clone(), TOKEN_A.into(),
        "replacement-sdk-client-a", "workspace:write", original_key, payload.clone()).await;
    assert_eq!(written["written"], 1);
    let committed = state(&fixture);

    // A new gateway at the same public Host has no inherited online existence.
    // Its route stays unavailable until the original registered Mac reconnects.
    let replacement_gateway = gateway(&issuer, admission.clone());
    assert_eq!(replacement_gateway.public_host(), first_gateway.public_host());
    let replacement_app = crate::mcp::http::axum_adapter::route_table(
        replacement_gateway.http_service().unwrap(),
    );
    let (_, absent) = http_reply(replacement_app.clone(),
        oauth_read_request(TOKEN_B, "replacement-gateway-before-reconnect")).await;
    assert_eq!(absent["result"]["structuredContent"]["code"], "resource_route_unavailable");
    assert_eq!(state(&fixture), committed);

    drop(first_app);
    drop(first_gateway);
    assert_closed(first_worker);
    assert!(admission.is_current(token.grant(), now()));
    let replacement_worker = attach_verified_wss(
        replacement_gateway.clone(), owner, issuer, &token,
    ).await;
    let retried = client_call_on_gateway(replacement_app.clone(), TOKEN_A.into(),
        "replacement-sdk-client-a", "workspace:write", original_key, payload).await;
    assert_eq!(retried["written"], 1);
    assert_eq!(state(&fixture), committed, "gateway replacement must not replay the original command");
    let read = client_call_on_gateway(replacement_app.clone(), TOKEN_B.into(),
        "replacement-sdk-client-b", "workspace:read", "replacement-gateway-b-read",
        json!({})).await;
    assert!(read["text"].as_str().unwrap().contains("replacement-gateway-commit"));
    assert_eq!(state(&fixture), committed);
    drop(replacement_app);
    drop(replacement_gateway);
    assert_closed(replacement_worker);
}
