//! A valid registration ACK can reach its computer before the session entry is published.
use super::*;
use crate::{account::computers::ComputerSigner, secrets::secrets_key::ComputerKey};
use std::{io::{self, Cursor, Read, Write}, sync::mpsc, time::Duration};

fn now() -> i64 { 1_000_000 }

/// These are real registration frames and a real ACK. The gate only pauses the ACK's flush after its bytes
/// are observable to the computer, exactly before `install` publishes the acknowledged entry.
struct AckBeforePublication {
    input: Cursor<Vec<u8>>,
    written: Arc<Mutex<Vec<u8>>>,
    ack_written: Option<mpsc::Sender<()>>,
    publish: mpsc::Receiver<()>,
}
impl Read for AckBeforePublication {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> { crate::io_operation!(self.input.read(bytes)) }
}
impl Write for AckBeforePublication {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.written.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        if let Some(ack) = self.ack_written.take() {
            crate::io_operation!((ack.send(()).map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::other("ACK observer ended"), _refusal_io_cause) })).map_err(std::io::Error::from))?;
            crate::io_operation!((self.publish.recv().map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::other("publication gate ended"), _refusal_io_cause) })).map_err(std::io::Error::from))?;
        }
        Ok(())
    }
}

#[test]
fn a_row_announced_after_ack_waits_for_its_session_to_be_published() {
    let key = ComputerKey::from_bytes(vec![37u8; 32]).unwrap();
    let signer = ComputerSigner::of(&key).unwrap();
    let computer = signer.computer_id();
    let credential = signer.session_credential(&computer, now());
    let kept = crate::account::computers::kept_accounts_bytes_catching_up(&[], &[]).unwrap();
    let mut input = Vec::new();
    for bytes in [credential.as_bytes(), kept.as_slice()] {
        input.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        input.extend_from_slice(bytes);
    }
    let written = Arc::new(Mutex::new(Vec::new()));
    let (ack, ack_written) = mpsc::channel();
    let (publish, publication) = mpsc::channel();
    let session = Arc::new(crate::forwarder::session::ForwarderConnection::admit_from_stream(
        AckBeforePublication { input: Cursor::new(input), written: written.clone(), ack_written: Some(ack), publish: publication },
        Arc::new(crate::forwarder::remote_connection_check::ComputerAdmission), crate::storage::time_source::fixed(now()),
    ).expect("the genuine computer credential is admitted"));
    let directory = Arc::new(ConnectedComputers::new());
    let installing = directory.clone();
    let registering = session.clone();
    let installed = std::thread::spawn(move || installing.install(registering));
    ack_written.recv_timeout(Duration::from_secs(5)).unwrap();
    let observed = written.lock().unwrap().clone();
    let length = u32::from_be_bytes(observed[..4].try_into().unwrap()) as usize;
    assert_eq!(observed.len(), length + 4, "the complete ACK is already observable");
    let ack: serde_json::Value = serde_json::from_slice(&observed[4..]).unwrap();
    assert_eq!(ack["route"], serde_json::to_value(session.route()).unwrap());
    let slot = directory.slot(&key_of(session.route())).unwrap();
    assert!(slot.active.lock().unwrap().is_none(), "publication is actually paused after ACK");
    assert!(slot.turn.try_lock().is_err(), "registration holds its existing turn");

    let told = row(1, &[&computer], &[&computer], account_key());
    assert!(told.believed(&account()));
    let (starting, started) = mpsc::channel();
    let (answer, answered) = mpsc::channel();
    let announcing = directory.clone();
    let from = computer.clone();
    let announced = std::thread::spawn(move || {
        starting.send(()).unwrap();
        answer.send(announcing.tell_again(&account(), &from, told, false)).unwrap();
    });
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    // The bounded receive observes a negative concurrency property while publication is explicitly gated;
    // there is no sleep or change to any production lease, retry, socket or worker setting.
    let before_publication = answered.recv_timeout(Duration::from_secs(1));
    let returned_early = before_publication.is_ok();
    publish.send(()).unwrap();
    installed.join().unwrap().unwrap();
    let taken = match before_publication {
        Ok(taken) => taken,
        Err(mpsc::RecvTimeoutError::Timeout) => answered.recv_timeout(Duration::from_secs(5)).unwrap(),
        Err(other) => panic!("announcement ended before publication: {other}"),
    };
    announced.join().unwrap();
    assert!(!returned_early, "an unpublished session was read as absent instead of waiting for its turn");
    assert!(taken, "the genuine signed account row is taken once the session is published");
    assert_eq!(chosen(&directory).as_deref(), Some(computer.as_str()));
}

#[test]
fn a_row_told_again_uses_its_existing_internal_owner_session_slot() {
    let directory = ConnectedComputers::new();
    let owner = "5".repeat(64);
    let route = Route { account_id: owner.clone(), ..route_at(&account(), RESOURCE, COMPUTER_A) };
    let session = Arc::new(FakeSession {
        expired: false,
        rows: Mutex::new(vec![row(1, &[COMPUTER_A], &[COMPUTER_A], account_key())]),
        catching_up: Mutex::default(),
    });
    let slot = directory.install_slot(&key_of(&route)).unwrap();
    *slot.active.lock().unwrap() = Some(Entry { route: route.clone(), session: session.clone() });
    assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_A));
    assert!(directory.slot(&(account(), RESOURCE.into(), COMPUTER_A.into())).is_none(),
        "there is no slot under the public address");
    assert!(directory.slot(&(COMPUTER_A.into(), RESOURCE.into(), COMPUTER_A.into())).is_none(),
        "there is no computer-wide session to hide an alias regression");
    let newer = row(2, &[COMPUTER_A, COMPUTER_B], &[COMPUTER_A], account_key());
    assert!(directory.tell_again(&account(), COMPUTER_A, newer.clone(), true),
        "the existing alias session takes its correctly signed row through its own slot");
    assert_eq!(session.told(), vec![newer]);
    assert!(session.catching_up(&account()));
    assert_eq!(chosen(&directory), None, "the updated catching-up fact reaches that alias session");
    assert!(directory.tell_again(&account(), COMPUTER_A,
        row(3, &[COMPUTER_A, COMPUTER_B], &[COMPUTER_A], account_key()), false));
    assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_A));
    assert_eq!(directory.current_route(&owner, RESOURCE), None, "the internal id remains unaddressable by callers");
}

struct InvocationInFlight {
    placement: FakeSession,
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl ComputerConnections for InvocationInFlight {
    fn invoke(&self, _: &Route, _: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
        self.entered.send(()).map_err(|_| crate::refusal_cause::CodedError::new(()))?;
        self.release.lock().map_err(|_| crate::refusal_cause::CodedError::new(()))?.recv().map_err(|_| crate::refusal_cause::CodedError::new(()))?;
        Ok(b"answered".to_vec())
    }
}
impl RegisteredSession for InvocationInFlight {
    fn is_ready(&self) -> bool { true }
    fn is_past_lifetime(&self) -> bool { false }
    fn retire(&self) {}
    fn told(&self) -> Vec<KeptAccount> { self.placement.told() }
    fn tell_again(&self, told: KeptAccount) -> bool { self.placement.tell_again(told) }
    fn catching_up(&self, address: &str) -> bool { self.placement.catching_up(address) }
    fn set_catching_up(&self, address: &str, value: bool) { self.placement.set_catching_up(address, value); }
}

#[test]
fn an_ordinary_placement_announcement_does_not_wait_for_an_invocation_in_flight() {
    let directory = Arc::new(ConnectedComputers::new());
    let (entered, in_flight) = mpsc::channel();
    let (release, held) = mpsc::channel();
    let route = route_at(&account(), RESOURCE, COMPUTER_A);
    let session = Arc::new(InvocationInFlight {
        placement: FakeSession { expired: false,
            rows: Mutex::new(vec![row(1, &[COMPUTER_A], &[COMPUTER_A], account_key())]),
            catching_up: Mutex::default() },
        entered, release: Mutex::new(held),
    });
    let slot = directory.install_slot(&key_of(&route)).unwrap();
    *slot.active.lock().unwrap() = Some(Entry { route: route.clone(), session: session.clone() });
    let invoking = directory.clone();
    let sender = std::thread::spawn(move || invoking.invoke(&route, b"message on the same account"));
    in_flight.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(slot.turn.try_lock().is_err(), "the real invocation path holds its general turn");
    let (starting, started) = mpsc::channel();
    let (answer, answered) = mpsc::channel();
    let announcing = directory.clone();
    let announced = std::thread::spawn(move || {
        starting.send(()).unwrap();
        answer.send(announcing.tell_again(&account(), COMPUTER_A,
            row(2, &[COMPUTER_A, COMPUTER_B], &[COMPUTER_A], account_key()), false)).unwrap();
    });
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    let while_in_flight = answered.recv_timeout(Duration::from_secs(1));
    let completed_while_held = while_in_flight.is_ok();
    release.send(()).unwrap();
    assert_eq!(sender.join().unwrap().unwrap(), b"answered");
    let taken = match while_in_flight {
        Ok(taken) => taken,
        Err(mpsc::RecvTimeoutError::Timeout) => answered.recv_timeout(Duration::from_secs(5)).unwrap(),
        Err(other) => panic!("announcement ended: {other}"),
    };
    announced.join().unwrap();
    assert!(completed_while_held, "placement waited for invocation I/O on the general turn");
    assert!(taken);
    assert_eq!(session.told()[0].row.revision, 2);
}
