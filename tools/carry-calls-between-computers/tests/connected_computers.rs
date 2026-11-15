// tests/connected_computers.rs
//
// Purpose: Tests installation, replacement, in-flight draining, and revocation of live session list of connected computers.
//
// Non-Negotiable Invariants:
// - A replacement is acknowledged only after the old connection can no longer dispatch, and revoked sessions refuse work:
//   the registration is read where a message would leave, and a revoked one retires the session without sending.
//
// Key Concepts:
// - Session installation sends acknowledgement only after the owner of the connected computers records the live connection.
// - Replacement drains old in-flight dispatches, while revocation makes the current session unusable.
//
// Security Considerations:
// - Credentials and routes are synthetic; acknowledgements follow admission, and stale sessions cannot retain authority.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

#![cfg(unix)]
use serde_json::json;
use std::{
    io::{self, Cursor, Read, Write},
    os::unix::net::UnixStream,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use trillion_local::{
    forwarder::{
        connected_computers::ConnectedComputers,
        session::{ConnectionAdmission, ConnectionGrant, ForwarderConnection},
        ComputerConnections, RouteDirectory,
    },
    resource_authority::{InvokeMessage, Route},
};

use trillion_local::account::computers::{self, AccountKey, KeptAccount, ComputersRow};

/// The account the routes name (its owner id, 64 lowercase hex) and the computer that holds and answers for it.
/// The owner id `account_key` names (checked by `the_test_account_is_the_one_its_key_names`).
const ACCOUNT: &str = "8df79b56dfd5d698b41a1d08df13df261c9067258cfb8b1cc100b1c40741b9ee";
const OTHER_ACCOUNT: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const DEVICE: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

fn account_key() -> AccountKey {
    AccountKey::from_secret_text(&"07".repeat(32)).expect("secret")
}

#[test]
fn the_test_account_is_the_one_its_key_names() {
    assert_eq!(account_key().address(), ACCOUNT);
}

/// The rows a computer tells: `DEVICE` holds and answers for `ACCOUNT`, signed by the account.
fn told() -> Vec<KeptAccount> {
    let key = account_key();
    let row = ComputersRow::sign(ACCOUNT, 1, &[DEVICE.to_string()], &[DEVICE.to_string()], &key).expect("signed");
    vec![KeptAccount { row, account_key: key.public_hex() }]
}

fn framed_kept_accounts() -> Vec<u8> {
    let bytes = computers::kept_accounts_bytes(&told()).expect("told");
    [&(bytes.len() as u32).to_be_bytes()[..], &bytes].concat()
}

fn now() -> i64 {
    1_000
}
/// A clock that reads 1000 ms, the time these connection tests check their admissions against.
struct AtOneThousand;
impl trillion_local::storage::time_source::Clock for AtOneThousand {
    fn now_ms(&self) -> i64 {
        1_000
    }
}

fn route() -> Route {
    Route {
        account_id: ACCOUNT.into(),
        device_id: DEVICE.into(),
        resource_address: "project:one".into(),
        generation: "generation:one".into(),
    }
}

struct Admission(Arc<AtomicBool>);
impl ConnectionAdmission for Admission {
    fn admit(&self, credential: &[u8], _: i64) -> Option<ConnectionGrant> {
        (self.0.load(Ordering::SeqCst) && credential == b"fixture-device-credential").then(|| {
            ConnectionGrant { admission_identity: None,
                route: route(),
                expires_at_ms: 2_000,
            }
        })
    }

    fn is_current(&self, grant: &ConnectionGrant, now_ms: i64) -> bool {
        self.0.load(Ordering::SeqCst) && grant.route == route() && now_ms < grant.expires_at_ms
    }
}

fn framed_credential() -> Vec<u8> {
    let credential = b"fixture-device-credential";
    [&(credential.len() as u32).to_be_bytes()[..], credential].concat()
}

fn session(live: Arc<AtomicBool>) -> (Arc<ForwarderConnection<UnixStream>>, UnixStream) {
    let (public, mut mac) = UnixStream::pair().unwrap();
    public
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    public
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    mac.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    mac.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
    mac.write_all(&framed_credential()).unwrap();
    mac.write_all(&framed_kept_accounts()).unwrap();
    let session =
        ForwarderConnection::admit_from_stream(public, Arc::new(Admission(live)), std::sync::Arc::new(AtOneThousand)).unwrap();
    (Arc::new(session), mac)
}

fn read_ack(mac: &mut UnixStream) {
    let mut size = [0_u8; 4];
    mac.read_exact(&mut size).unwrap();
    let mut ack = vec![0_u8; u32::from_be_bytes(size) as usize];
    mac.read_exact(&mut ack).unwrap();
    let ack: serde_json::Value = serde_json::from_slice(&ack).unwrap();
    assert_eq!(ack["route"], serde_json::to_value(route()).unwrap());
}

fn invoke_message() -> Vec<u8> {
    serde_json::to_vec(&InvokeMessage { person_present: None,
        request_id: "request:one".into(),
        operation_resource: None,
        account_id: route().account_id,
        device_id: route().device_id,
        resource_address: route().resource_address,
        generation: route().generation,
        operation: "record.mutate".into(),
        input: json!({"id":"record:one"}),
        request_key: "original-key".into(),
        client_authorization: "fixture-proof".into(),
        deadline_at_ms: 5_000,
    })
    .unwrap()
}

fn read_invoke(mac: &mut UnixStream) -> InvokeMessage {
    let mut size = [0_u8; 4];
    mac.read_exact(&mut size).unwrap();
    let mut body = vec![0_u8; u32::from_be_bytes(size) as usize];
    mac.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn write_reply(mac: &mut UnixStream, request_id: &str) {
    let reply =
        json!({"state":"completed","request_id":request_id,"value":{"ok":true}}).to_string();
    mac.write_all(&(reply.len() as u32).to_be_bytes()).unwrap();
    mac.write_all(reply.as_bytes()).unwrap();
}

struct FailAck(Cursor<Vec<u8>>);
impl Read for FailAck {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.0.read(bytes)
    }
}
impl Write for FailAck {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "fixture ack failure",
        ))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn connected_computers_install_before_ack_replace_old_connection_and_refuse_revocation() {
    let live = Arc::new(AtomicBool::new(true));
    let connected_computers = ConnectedComputers::new();
    let (first, mut first_mac) = session(live.clone());
    assert!(connected_computers
        .current_route(ACCOUNT, "project:one")
        .is_none());
    connected_computers.install(first.clone()).unwrap();
    read_ack(&mut first_mac);
    assert_eq!(
        connected_computers.current_route(ACCOUNT, "project:one"),
        Some(route())
    );
    assert!(connected_computers.install(first.clone()).is_err());
    assert_eq!(
        connected_computers.current_route(ACCOUNT, "project:one"),
        Some(route())
    );

    let rejected = Arc::new(
        ForwarderConnection::admit_from_stream(
            FailAck(Cursor::new([framed_credential(), framed_kept_accounts()].concat())),
            Arc::new(Admission(live.clone())),
            std::sync::Arc::new(AtOneThousand),
        )
        .unwrap(),
    );
    assert!(connected_computers.install(rejected).is_err());
    assert_eq!(
        connected_computers.current_route(ACCOUNT, "project:one"),
        Some(route())
    );

    let (second, mut second_mac) = session(live.clone());
    connected_computers.install(second).unwrap();
    read_ack(&mut second_mac);
    let mut byte = [0_u8; 1];
    assert_eq!(first_mac.read(&mut byte).unwrap(), 0);
    assert_eq!(
        connected_computers.current_route(ACCOUNT, "project:one"),
        Some(route())
    );
    assert!(connected_computers
        .current_route(OTHER_ACCOUNT, "project:one")
        .is_none());

    // A revoked registration is read where a message would leave: the message is
    // refused without reaching the Mac and the session is retired for good.
    live.store(false, Ordering::SeqCst);
    let refused: serde_json::Value =
        serde_json::from_slice(&connected_computers.invoke(&route(), &invoke_message()).unwrap()).unwrap();
    assert_eq!({ let mut source_reply = refused; let source_cause = source_reply.as_object_mut().unwrap().remove("cause").expect("every refusal carries its construction source"); let source_cause = trillion_local::refusal_cause::ReportedCause::from_wire(source_cause.as_str().unwrap()).expect("the source identity is valid and content-free"); assert!(source_cause.id().contains("@src/forwarder/")); source_reply }, json!({"state":"refused","request_id":"request:one","code":"resource_route_unavailable"}));
    assert!(matches!(second_mac.read(&mut byte), Ok(0)), "no message reached the Mac; its stream is closed");
    assert!(connected_computers
        .current_route(ACCOUNT, "project:one")
        .is_none());
    live.store(true, Ordering::SeqCst);
    assert!(connected_computers
        .current_route(ACCOUNT, "project:one")
        .is_none());
}

#[test]
fn replacement_waits_for_old_in_flight_dispatch_before_acknowledging() {
    let live = Arc::new(AtomicBool::new(true));
    let connected_computers = Arc::new(ConnectedComputers::new());
    let (first, mut first_mac) = session(live.clone());
    connected_computers.install(first).unwrap();
    read_ack(&mut first_mac);

    let dispatch_owner = connected_computers.clone();
    let dispatch = std::thread::spawn(move || dispatch_owner.invoke(&route(), &invoke_message()));
    let request = read_invoke(&mut first_mac);

    let (second, mut second_mac) = session(live);
    let (started_tx, started_rx) = mpsc::channel();
    let install_owner = connected_computers.clone();
    let replacement = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        install_owner.install(second)
    });
    started_rx.recv().unwrap();
    second_mac
        .set_read_timeout(Some(Duration::from_millis(150)))
        .unwrap();
    let mut size = [0_u8; 4];
    let premature = second_mac.read(&mut size);
    assert!(matches!(
        premature,
        Err(ref error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)
    ));

    write_reply(&mut first_mac, &request.request_id);
    assert!(dispatch.join().unwrap().is_ok());
    assert!(replacement.join().unwrap().is_ok());
    second_mac
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    read_ack(&mut second_mac);
    assert_eq!(
        connected_computers.current_route(ACCOUNT, "project:one"),
        Some(route())
    );
}

/// A session opened with `kept_accounts` (a framed list of kept accounts) as the computer `DEVICE`.
fn session_telling_kept_accounts(kept_accounts: &[u8]) -> (Arc<ForwarderConnection<UnixStream>>, UnixStream) {
    let (public, mut mac) = UnixStream::pair().unwrap();
    public.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    public.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
    mac.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    mac.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
    mac.write_all(&framed_credential()).unwrap();
    mac.write_all(kept_accounts).unwrap();
    let session = ForwarderConnection::admit_from_stream(public, Arc::new(Admission(Arc::new(AtomicBool::new(true)))), std::sync::Arc::new(AtOneThousand)).unwrap();
    (Arc::new(session), mac)
}

/// The 2026-11-03 public 503 (no_live_computer): the hosting app's computer id is the device enrolled for its current key,
/// so a new key gave the Mac a new id while the account's signed row still named only the old one. The forwarder admits
/// and acknowledges that session, but never routes the account to it; the row moved to the new id
/// (`computers::told` succession) routes it.
#[test]
fn a_session_whose_computer_the_row_does_not_name_is_never_routed_until_the_row_names_it() {
    const EARLIER: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    let key = account_key();
    let framed = |row: ComputersRow| {
        let bytes = computers::kept_accounts_bytes(&[KeptAccount { row, account_key: key.public_hex() }]).expect("told");
        [&(bytes.len() as u32).to_be_bytes()[..], &bytes].concat()
    };
    let connected_computers = ConnectedComputers::new();
    let stale = ComputersRow::sign(ACCOUNT, 1, &[EARLIER.to_string()], &[EARLIER.to_string()], &key).expect("signed");
    let (session, mut mac) = session_telling_kept_accounts(&framed(stale));
    connected_computers.install(session).unwrap();
    read_ack(&mut mac);
    assert_eq!(connected_computers.current_route(ACCOUNT, "project:one"), None, "admitted, but the row names only the earlier id");
    let moved = ComputersRow::sign(ACCOUNT, 2, &[DEVICE.to_string()], &[DEVICE.to_string()], &key).expect("signed");
    let (session, mut mac) = session_telling_kept_accounts(&framed(moved));
    connected_computers.install(session).unwrap();
    read_ack(&mut mac);
    assert_eq!(connected_computers.current_route(ACCOUNT, "project:one"), Some(route()));
}
