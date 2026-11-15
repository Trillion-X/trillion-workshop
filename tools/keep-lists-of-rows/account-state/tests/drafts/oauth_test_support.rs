// Synthetic Worker-compatible OAuth issuer for selected-MCP consumer tests.
//
// This fixture serves real TLS and HTTP over a loopback socket using a fresh
// test CA. It has no external authority, account, credential store or provider.
use super::{iso, millis, Fixture, OWNER};
use serde_json::{json, Value};
use crate::native_boot::mcp_selected_personal::oauth_authority::OAuthAuthority;
use native_tls::{TlsAcceptor, TlsConnector};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::Url;

const USER: &str = "synthetic-user";
const RESOURCE: &str = "@own-records";
const GRANT: &str = "grant:synthetic-oauth-grant";
const CLIENT: &str = "synthetic-oauth-client";
const BEARER: &str = "synthetic-oauth-bearer-for-selected-mcp-tests";

#[derive(Clone)]
pub(crate) struct SyntheticOAuthGrant {
    pub(crate) bearer: &'static str,
    pub(crate) account: &'static str,
    pub(crate) user: &'static str,
    pub(crate) sign_in: &'static str,
    pub(crate) client: &'static str,
}

struct IssuerState {
    grants: Vec<SyntheticOAuthGrant>,
    revoked_bearers: Mutex<std::collections::BTreeSet<String>>,
    issued_at_ms: i64,
    revoked: AtomicBool,
    accepted_sockets: AtomicUsize,
    tls_handshakes: AtomicUsize,
    handshake_failures: AtomicUsize,
    last_handshake_error: Mutex<Option<String>>,
    parsed_headers: AtomicUsize,
    requests: AtomicUsize,
    revoke_on_request: AtomicUsize,
}

pub(crate) struct SyntheticOAuthIssuer {
    pub(crate) authority: Arc<OAuthAuthority>,
    bearer: String,
    state: Arc<IssuerState>,
    stop: Arc<AtomicBool>,
    server: Mutex<Option<JoinHandle<()>>>,
    _tls_material: tempfile::TempDir,
}

impl SyntheticOAuthIssuer {
    pub(crate) fn new(fixture: &Fixture) -> Self {
        Self::with_grants(fixture, vec![SyntheticOAuthGrant {
            bearer: BEARER, account: OWNER, user: USER, sign_in: GRANT, client: CLIENT,
        }])
    }

    pub(crate) fn with_grants(_fixture: &Fixture, grants: Vec<SyntheticOAuthGrant>) -> Self {
        assert!(!grants.is_empty(), "synthetic issuer needs a grant");
        let mut bearers = std::collections::BTreeSet::new();
        let mut sign_ins = std::collections::BTreeSet::new();
        for grant in &grants {
            assert!(bearers.insert(grant.bearer), "synthetic bearer identities must be distinct");
            assert!(sign_ins.insert(grant.sign_in), "synthetic grant identities must be distinct");
        }
        let bearer = grants[0].bearer.to_owned();
        let tls_material = tempfile::tempdir().expect("synthetic issuer TLS directory");
        let (identity, connector) = crate::forwarder::tls::fixture::identity(tls_material.path());
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback issuer listener");
        listener.set_nonblocking(true).expect("nonblocking issuer listener");
        let address = listener.local_addr().expect("issuer address");
        let hostname = "mcp.example.test";
        let endpoint = Url::parse(&format!("https://{hostname}:{}/mcp/local-authority/validate", address.port()))
            .expect("synthetic authority endpoint");
        let audience = format!("{}/mcp", endpoint.origin().ascii_serialization());
        let authority = Arc::new(OAuthAuthority::new_with_test_transport(
            endpoint, audience, connector, address,
        ).expect("synthetic test authority"));
        let issued_at_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
        let state = Arc::new(IssuerState { grants, revoked_bearers: Mutex::new(Default::default()), issued_at_ms, revoked: AtomicBool::new(false), accepted_sockets: AtomicUsize::new(0), tls_handshakes: AtomicUsize::new(0), handshake_failures: AtomicUsize::new(0), last_handshake_error: Mutex::new(None), parsed_headers: AtomicUsize::new(0), requests: AtomicUsize::new(0), revoke_on_request: AtomicUsize::new(0) });
        let stop = Arc::new(AtomicBool::new(false));
        let acceptor = TlsAcceptor::new(identity).expect("synthetic issuer TLS acceptor");
        let server_state = state.clone();
        let server_stop = stop.clone();
        let server = thread::spawn(move || {
            while !server_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        server_state.accepted_sockets.fetch_add(1, Ordering::AcqRel);
                        // Darwin may preserve O_NONBLOCK from the listener on
                        // accepted descriptors; native TLS handshake expects
                        // a blocking socket and uses the bounded timeouts below.
                        if stream.set_nonblocking(false).is_err() {
                            server_state.handshake_failures.fetch_add(1, Ordering::AcqRel);
                            if let Ok(mut last) = server_state.last_handshake_error.lock() {
                                *last = Some("could not set accepted socket blocking".into());
                            }
                            continue;
                        }
                        serve_one(stream, &acceptor, &server_state);
                    },
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });
        let issuer = Self {
            authority, bearer, state, stop,
            server: Mutex::new(Some(server)), _tls_material: tls_material,
        };
        issuer.assert_transport_ready();
        issuer.reset_diagnostics();
        issuer
    }

    pub(crate) fn bearer(&self) -> String { self.bearer.clone() }

    pub(crate) fn revoke(&self) { self.state.revoked.store(true, Ordering::Release); }

    pub(crate) fn revoke_bearer(&self, bearer: &str) {
        assert!(self.state.grants.iter().any(|grant| grant.bearer == bearer),
            "only a supplied synthetic grant may be withdrawn");
        self.state.revoked_bearers.lock().unwrap().insert(bearer.to_owned());
    }

    pub(crate) fn requests(&self) -> usize { self.state.requests.load(Ordering::Acquire) }

    pub(crate) fn diagnostics(&self) -> String {
        let has_handshake_error = self.state.last_handshake_error.lock().ok().is_some_and(|error| error.is_some());
        format!(
            "accepted_sockets={}, tls_handshakes={}, handshake_failures={}, parsed_headers={}, requests={}, handshake_error_present={}",
            self.state.accepted_sockets.load(Ordering::Acquire),
            self.state.tls_handshakes.load(Ordering::Acquire),
            self.state.handshake_failures.load(Ordering::Acquire),
            self.state.parsed_headers.load(Ordering::Acquire),
            self.state.requests.load(Ordering::Acquire),
            has_handshake_error,
        )
    }

    fn reset_diagnostics(&self) {
        self.state.accepted_sockets.store(0, Ordering::Release);
        self.state.tls_handshakes.store(0, Ordering::Release);
        self.state.handshake_failures.store(0, Ordering::Release);
        if let Ok(mut error) = self.state.last_handshake_error.lock() { *error = None; }
        self.state.parsed_headers.store(0, Ordering::Release);
        self.state.requests.store(0, Ordering::Release);
    }

    fn assert_transport_ready(&self) {
        for grant in &self.state.grants {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let identity = self.authority.validate_bearer(
            grant.bearer.as_bytes(), millis() as i64, deadline,
        ).unwrap_or_else(|error| panic!(
            "synthetic OAuth TLS preflight failed: {error:?}; issuer diagnostics={:?}",
            self.diagnostics(),
        ));
        assert_eq!(identity.account_id, grant.account);
        assert_eq!(identity.user_id, grant.user);
        assert_eq!(identity.sign_in, grant.sign_in);
        assert_eq!(identity.client_id, grant.client);
        }
    }

    /// Revoke immediately before replying to the selected request ordinal. This
    /// lets consumer tests target the final native custody revalidation exactly.
    pub(crate) fn revoke_on_request(&self, ordinal: usize) {
        assert!(ordinal > 0, "request ordinal must be positive");
        self.state.revoke_on_request.store(ordinal, Ordering::Release);
    }
}

impl Drop for SyntheticOAuthIssuer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(slot) = self.server.get_mut() {
            if let Some(server) = slot.take() { let _ = server.join(); }
        }
    }
}

fn serve_one(stream: TcpStream, acceptor: &TlsAcceptor, state: &IssuerState) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let tls = match acceptor.accept(stream) {
        Ok(tls) => tls,
        Err(error) => {
            state.handshake_failures.fetch_add(1, Ordering::AcqRel);
            if let Ok(mut last) = state.last_handshake_error.lock() { *last = Some(format!("{error:?}")); }
            return;
        }
    };
    state.tls_handshakes.fetch_add(1, Ordering::AcqRel);
    let mut reader = BufReader::new(tls);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).ok().filter(|n| *n <= 2048).unwrap_or(0) == 0 { return; }
    let mut grant = None;
    let mut host_header = String::new();
    let request_target_ok = request_line.starts_with("POST /mcp/local-authority/validate HTTP/1.1");
    let mut content_length = 0usize;
    let mut headers = 0usize;
    loop {
        let mut line = String::new();
        let Ok(read) = reader.read_line(&mut line) else { return; };
        headers = headers.saturating_add(read);
        if read == 0 || headers > 16 * 1024 { return; }
        if line == "\r\n" { break; }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("authorization") {
                grant = value.trim().strip_prefix("Bearer ")
                    .and_then(|bearer| state.grants.iter().find(|grant| grant.bearer == bearer));
            } else if name.eq_ignore_ascii_case("host") {
                host_header = value.trim().to_owned();
            } else if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(usize::MAX);
            }
        }
    }
    state.parsed_headers.fetch_add(1, Ordering::AcqRel);
    if content_length > 8192 { return; }
    let mut body = vec![0u8; content_length];
    if reader.read_exact(&mut body).is_err() { return; }
    let request_number = state.requests.fetch_add(1, Ordering::AcqRel) + 1;
    if state.revoke_on_request.load(Ordering::Acquire) == request_number {
        state.revoked.store(true, Ordering::Release);
    }
    let resource_ok = serde_json::from_slice::<Value>(&body)
        .ok().is_some_and(|value| value == json!({"resource_address":RESOURCE}));
    let mut tls = reader.into_inner();
    if !request_target_ok || host_header != format!("mcp.example.test:{}", tls.get_ref().local_addr().map(|a| a.port()).unwrap_or(0))
        || grant.is_none() || !resource_ok || state.revoked.load(Ordering::Acquire)
        || grant.is_some_and(|grant| state.revoked_bearers.lock().unwrap().contains(grant.bearer)) {
        let body = br#"{"error":"invalid_token"}"#;
        let _ = write!(tls, "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        let _ = tls.write_all(body);
        let _ = tls.flush();
        return;
    }
    let grant = grant.unwrap();
    // Every synthetic grant has one stable incarnation across validation calls.
    // Fresh response clocks would change issued_at/expires_at and correctly
    // trip the production identity-equality check on every revalidation.
    let now = state.issued_at_ms;
    let expires = now.saturating_add(60_000);
    let reach = json!({"private":true,"spaces":"all"});
    let reply = json!({
        "account_id":grant.account,
        "user_id":grant.user,
        "resource_address":RESOURCE,
        "sign_in":grant.sign_in,
        "client_id":grant.client,
        "audience":format!("https://{host_header}/mcp"),
        "scope":["decisions"],
        "expires_at_ms":expires,
        "reach":reach,
        "claims":{
            "sign_in":grant.sign_in,
            "issued_at":chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now).unwrap().to_rfc3339(),
            "made":reach.clone(),
            "ceiling":reach.clone(),
            "approved_by":"user",
            "browser_generation":null
        }
    });
    let bytes = serde_json::to_vec(&reply).expect("synthetic validation reply");
    let _ = write!(tls, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len());
    let _ = tls.write_all(&bytes);
    let _ = tls.flush();
}


