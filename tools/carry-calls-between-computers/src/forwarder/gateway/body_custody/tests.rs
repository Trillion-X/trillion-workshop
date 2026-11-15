use super::*;
use crate::forwarder::{
    session::{self, ConnectionAdmission, ConnectionGrant},
    ClientProofIssuer,
};
use crate::resource_authority::{decode_message, InvokeMessage};
use serde_json::json;
use std::{
    os::unix::net::UnixStream,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    thread,
};

const CANARY: &str = "FORWARDER_MUST_NOT_DISCLOSE_THIS_AFTER_WITHDRAWAL";
const TOKEN_A: &str = "synthetic-public-client-a";
const TOKEN_B: &str = "synthetic-public-client-b";
/// A device id in the shape computers rows use (64 lowercase hex).
const DEVICE: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

struct FailedBody(crate::refusal_cause::Cause);
impl HttpBody for FailedBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Result<Chunk<Bytes>, io::Error>>> {
        Poll::Ready(Some(Err(crate::refusal_cause::locate_io(io::Error::other("synthetic body producer refused"), self.0.clone()))))
    }
}

fn body_without_a_route(inner: Body, cancelled: bool) -> Guarded {
    Guarded {
        permit: Some(BodyPermit {
            principal: Principal { kind: crate::mcp::PrincipalKind::Person, account_id: "private-route-value".into(), sign_in: "private-sign-in-value".into(), client_id: TOKEN_A.into() },
            route: Route { account_id: "private-route-value".into(), resource_address: "private-resource-value".into(), device_id: DEVICE.into(), generation: "private-generation-value".into() },
            connected_computers: Arc::new(ConnectedComputers::new()),
            cancel: Arc::new(AtomicBool::new(cancelled)),
            now_ms: crate::storage::time_source::fixed(0),
            issued_at_ms: 0,
            deadline_at_ms: 60_000,
            deadline: Instant::now() + Duration::from_secs(60),
        }),
        inner,
        ready: None,
        ingress: Arc::new(()),
    }
}

fn first_body_error(mut body: Guarded) -> io::Error {
    let waker = futures::task::noop_waker();
    let mut context = Context::from_waker(&waker);
    match Pin::new(&mut body).poll_frame(&mut context) {
        Poll::Ready(Some(Err(error))) => {
            assert!(body.permit.is_none());
            assert!(body.ready.is_none());
            error
        }
        _ => panic!("the failed first chunk must disclose no body bytes"),
    }
}

#[test]
fn body_refusals_keep_distinct_conditions_and_the_original_upstream_source_without_values() {
    use crate::refusal_cause::Caused;
    let cancelled = first_body_error(body_without_a_route(Body::from(CANARY), true));
    let missing = first_body_error(body_without_a_route(Body::empty(), false));
    let producer = crate::cause!();
    let upstream = first_body_error(body_without_a_route(Body::new(FailedBody(producer.clone())), false));
    for error in [&cancelled, &missing, &upstream] {
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        let identity = error.cause().id();
        assert!(!identity.contains(CANARY));
        assert!(!identity.contains(TOKEN_A));
        assert!(!identity.contains("private-route-value"));
    }
    assert_ne!(cancelled.cause(), missing.cause());
    assert_eq!(upstream.cause(), producer);
    let source = include_str!("../body_custody.rs");
    let stopped = source.lines().position(|line| line.contains("if permit.stopped() {")).unwrap() + 2;
    let absent = source.lines().position(|line| line.contains("Poll::Ready(None) => return fail")).unwrap() + 1;
    assert_eq!(cancelled.cause().file(), "src/forwarder/gateway/body_custody.rs");
    assert_eq!(cancelled.cause().line() as usize, stopped);
    assert_eq!(missing.cause().line() as usize, absent);
    assert_eq!(producer, serde_json::from_str::<crate::refusal_cause::Cause>(&serde_json::to_string(&upstream.cause()).unwrap()).unwrap());
}

/// The account's own key, which signs the computers row the test computer tells.
fn account_key() -> crate::account::computers::AccountKey {
    crate::account::computers::AccountKey::from_secret_text(&"07".repeat(32)).unwrap()
}

/// The account: the owner id its key names.
fn account() -> String {
    account_key().address()
}

/// What the test computer tells: `DEVICE` holds and answers for the account, with the account's key.
fn told() -> Vec<crate::account::computers::KeptAccount> {
    let key = account_key();
    let row = crate::account::computers::ComputersRow::sign(&account(), 1, &[DEVICE.to_string()], &[DEVICE.to_string()], &key)
        .unwrap();
    vec![crate::account::computers::KeptAccount { row, account_key: key.public_hex() }]
}
fn principal(token: &str) -> Principal {
    Principal { kind: crate::mcp::PrincipalKind::Person,
        account_id: account(),
        sign_in: if token == TOKEN_A {
            "grant:a"
        } else {
            "grant:b"
        }
        .into(),
        client_id: token.into(),
    }
}
struct Auth {
    a: AtomicBool,
    b: AtomicBool,
    /// How many times a client's credential was read.
    reads: AtomicUsize,
}
impl BearerAuthenticator for Auth {
    fn authenticate(&self, bearer: &[u8]) -> Option<Principal> {
        self.reads.fetch_add(1, Ordering::AcqRel);
        match bearer {
            value if value == TOKEN_A.as_bytes() && self.a.load(Ordering::Acquire) => {
                Some(principal(TOKEN_A))
            }
            value if value == TOKEN_B.as_bytes() && self.b.load(Ordering::Acquire) => {
                Some(principal(TOKEN_B))
            }
            _ => None,
        }
    }
}
struct Issuer;
impl ClientProofIssuer for Issuer {
    fn issue(&self, _: &Principal, _: &InvokeMessage) -> Option<String> {
        Some("synthetic-client-proof".into())
    }
}
struct Admission {
    route: Mutex<Route>,
    current: AtomicBool,
    /// How many times the registration was read.
    reads: AtomicUsize,
}
impl ConnectionAdmission for Admission {
    fn admit(&self, credential: &[u8], at: i64) -> Option<ConnectionGrant> {
        (credential == b"synthetic-device" && self.current.load(Ordering::Acquire)).then(|| {
            ConnectionGrant {
                route: self.route.lock().unwrap().clone(),
                expires_at_ms: at + 120_000,
                admission_identity: Some("synthetic-registration".into()),
            }
        })
    }
    fn is_current(&self, grant: &ConnectionGrant, at: i64) -> bool {
        self.reads.fetch_add(1, Ordering::AcqRel);
        self.current.load(Ordering::Acquire)
            && at < grant.expires_at_ms
            && grant.route == *self.route.lock().unwrap()
    }
}
fn connect(
    gateway: &Arc<Gateway>,
    admission: &Arc<Admission>,
    calls: Arc<AtomicUsize>,
) -> thread::JoinHandle<io::Result<()>> {
    let (public, mac) = UnixStream::pair().unwrap();
    for stream in [&public, &mac] {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
    }
    let route = admission.route.lock().unwrap().clone();
    let now_ms = gateway.now_ms.clone();
    let worker = thread::spawn(move || {
        session::connect_mac_session_with_admission(
            mac,
            b"synthetic-device",
            &told(),
            &route,
            now_ms,
            || Ok(()),
            |bytes| {
                let message = decode_message(bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()))?;
                calls.fetch_add(1, Ordering::AcqRel);
                serde_json::to_vec(&json!({"state":"completed","request_id":message.request_id,"value":{"private":CANARY}})).map_err(|_| crate::refusal_cause::CodedError::new(()))
            },
        )
    });
    gateway.admit_mac_connection(public).unwrap();
    worker
}
struct Harness {
    gateway: Arc<Gateway>,
    auth: Arc<Auth>,
    admission: Arc<Admission>,
    calls: Arc<AtomicUsize>,
    worker: Option<thread::JoinHandle<io::Result<()>>>,
}
impl Harness {
    fn new() -> Self {
        Self::at(std::sync::Arc::new(crate::storage::time_source::RealClock))
    }
    fn at(now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>) -> Self {
        let auth = Arc::new(Auth {
            a: AtomicBool::new(true),
            b: AtomicBool::new(true),
            reads: AtomicUsize::new(0),
        });
        let admission = Arc::new(Admission {
            route: Mutex::new(Route {
                account_id: account(),
                device_id: DEVICE.into(),
                resource_address: "@own-records".into(),
                generation: "generation-one".into(),
            }),
            current: AtomicBool::new(true),
            reads: AtomicUsize::new(0),
        });
        let gateway = Arc::new(Gateway::new(
            "mcp.example.test",
            auth.clone(),
            Arc::new(Issuer),
            admission.clone(),
            now_ms,
        ));
        let calls = Arc::new(AtomicUsize::new(0));
        let worker = Some(connect(&gateway, &admission, calls.clone()));
        Self {
            gateway,
            auth,
            admission,
            calls,
            worker,
        }
    }
    fn pending(&self, token: &str, key: &str) -> (Body, Arc<RequestDisclosure>) {
        let disclosure = Arc::new(RequestDisclosure::default());
        let principal = principal(token);
        let value = self
            .gateway
            .invoke_with_disclosure(
                &principal,
                token.as_bytes(),
                Operation { person_present: None,
                    resource: "@own-records".into(),
                    operation: "records:read".into(),
                    request_key: key.into(),
                    input: json!({}),
                },
                &disclosure,
            )
            .unwrap();
        assert_eq!(
            value["private"], CANARY,
            "the Mac already released its result to the forwarder"
        );
        let custody = disclosure.take().unwrap().unwrap();
        let body = custody
            .finish(
                Body::from(serde_json::to_vec(&value).unwrap()),
                &principal,
                Zeroizing::new(token.as_bytes().to_vec()),
                disclosure.clone(),
            )
            .unwrap();
        (body, disclosure)
    }
    fn stop(mut self) {
        drop(self.gateway);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join().unwrap();
        }
    }
}

#[tokio::test]
async fn public_body_does_not_borrow_a_successor_route_generation_after_mac_reply() {
    let mut h = Harness::new();
    let (pending, disclosure) = h.pending(TOKEN_A, "old-route-result");
    h.admission.route.lock().unwrap().generation = "generation-two".into();
    let successor = connect(&h.gateway, &h.admission, h.calls.clone());
    let _ = h.worker.take().unwrap().join().unwrap();
    h.worker = Some(successor);
    assert!(axum::body::to_bytes(pending, 65_536).await.is_err());
    assert_eq!(h.calls.load(Ordering::Acquire), 1);
    drop(disclosure);
    let (current, disclosure) = h.pending(TOKEN_A, "new-route-result");
    assert!(
        String::from_utf8_lossy(&axum::body::to_bytes(current, 65_536).await.unwrap())
            .contains(CANARY)
    );
    drop(disclosure);
    h.stop();
}

#[tokio::test]
async fn cancelled_public_request_withholds_its_ready_mac_result() {
    let h = Harness::new();
    let (pending, disclosure) = h.pending(TOKEN_A, "cancel-after-mac-reply");
    disclosure
        .cancellation_flag()
        .store(true, Ordering::Release);
    assert!(axum::body::to_bytes(pending, 65_536).await.is_err());
    assert_eq!(h.calls.load(Ordering::Acquire), 1);
    drop(disclosure);
    h.stop();
}

#[tokio::test]
async fn public_body_keeps_the_original_thirty_second_operation_deadline() {
    static CLOCK: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(1000);
    struct Time;
    impl crate::storage::time_source::Clock for Time {
        fn now_ms(&self) -> i64 {
            CLOCK.load(Ordering::Acquire)
        }
    }
    CLOCK.store(1000, Ordering::Release);
    let h = Harness::at(std::sync::Arc::new(Time));
    let (pending, disclosure) = h.pending(TOKEN_A, "original-deadline");
    CLOCK.store(31_000, Ordering::Release);
    assert!(axum::body::to_bytes(pending, 65_536).await.is_err());
    assert_eq!(h.calls.load(Ordering::Acquire), 1);
    drop(disclosure);
    h.stop();
}


#[tokio::test]
async fn release_reads_no_client_credential_and_no_registration() {
    let h = Harness::new();
    let (pending, disclosure) = h.pending(TOKEN_A, "release-reads-nothing");
    let client_reads = h.auth.reads.load(Ordering::Acquire);
    let registration_reads = h.admission.reads.load(Ordering::Acquire);
    let answer = axum::body::to_bytes(pending, 65_536).await.unwrap();
    assert!(String::from_utf8_lossy(&answer).contains(CANARY));
    assert_eq!(h.auth.reads.load(Ordering::Acquire), client_reads);
    assert_eq!(h.admission.reads.load(Ordering::Acquire), registration_reads);
    drop(disclosure);
    h.stop();
}
