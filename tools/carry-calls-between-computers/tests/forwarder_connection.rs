// tests/forwarder_connection.rs
//
// Purpose: Tests authenticated Unix-stream session admission, route binding, expiry, and lost-reply retirement.
//
// Non-Negotiable Invariants:
// - Dispatch requires a valid acknowledged grant for the current route and lifetime; a lost reply retires the session without resend.
//
// Key Concepts:
// - Unix-stream connection admission exchanges a bounded credential and route-bound grant acknowledgement.
// - Expiry and lost replies retire the session; an invoke message is accepted only after one valid acknowledgement.
// - A registration owner that cannot be read (a timeout) refuses that one message and keeps the session; only a
//   withdrawal retires it.
//
// Security Considerations:
// - Wire credentials are fixture-only and bounded; absent or mismatched admission, expiry, and stale acknowledgements fail closed.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

#![cfg(unix)]
use serde_json::json;
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use trillion_local::{
    forwarder::{
        session::{
            connect_mac_session, serve_mac_session, ConnectionAdmission, ConnectionGrant,
            Registration, ForwarderConnection,
        },
        ComputerConnections,
    },
    resource_authority::{InvokeMessage, Route},
};

static CLOCK: AtomicI64 = AtomicI64::new(1_000);
static TEST_LOCK: Mutex<()> = Mutex::new(());
fn now() -> i64 {
    CLOCK.load(Ordering::SeqCst)
}
/// The test's clock, read from `CLOCK` at each use, for the forwarder's calls that take a clock.
struct TestClock;
impl trillion_local::storage::time_source::Clock for TestClock {
    fn now_ms(&self) -> i64 {
        now()
    }
}
fn test_clock() -> std::sync::Arc<dyn trillion_local::storage::time_source::Clock> {
    std::sync::Arc::new(TestClock)
}
fn route() -> Route {
    Route {
        account_id: "account:one".into(),
        device_id: "device:one".into(),
        resource_address: "project:one".into(),
        generation: "generation:one".into(),
    }
}
struct Admission {
    expires_at_ms: i64,
    live: Arc<AtomicBool>,
}
impl ConnectionAdmission for Admission {
    fn admit(&self, credential: &[u8], _: i64) -> Option<ConnectionGrant> {
        (self.live.load(Ordering::SeqCst) && credential == b"fixture-device-credential").then(
            || ConnectionGrant { admission_identity: None,
                route: route(),
                expires_at_ms: self.expires_at_ms,
            },
        )
    }
    fn is_current(&self, grant: &ConnectionGrant, now_ms: i64) -> bool {
        self.live.load(Ordering::SeqCst) && grant.route == route() && now_ms < self.expires_at_ms
    }
}
/// The refusal a connection answers for a message it never sent.
fn not_sent(reply: Result<Vec<u8>, trillion_local::refusal_cause::CodedError<()>>, code: &str) {
    let reply: serde_json::Value = serde_json::from_slice(&reply.expect("a message never sent is refused, not unknown")).unwrap();
    assert_eq!({ let mut source_reply = reply; let source_cause = source_reply.as_object_mut().unwrap().remove("cause").expect("every refusal carries its construction source"); let source_cause = trillion_local::refusal_cause::ReportedCause::from_wire(source_cause.as_str().unwrap()).expect("the source identity is valid and content-free"); assert!(source_cause.id().contains("@src/forwarder/")); source_reply }, json!({"state":"refused","request_id":"request:one","code":code}));
}
fn message() -> Vec<u8> {
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
        client_authorization: "fixture-client-proof".into(),
        deadline_at_ms: 1_500,
    })
    .unwrap()
}
fn pair() -> (UnixStream, UnixStream) {
    let (public, mac) = UnixStream::pair().unwrap();
    for stream in [&public, &mac] {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
    }
    (public, mac)
}

/// The computer's list of kept accounts of its placement rows after its credential: none here.
fn tell(stream: &mut impl Write) {
    let rows = br#"{"rows":[]}"#;
    stream.write_all(&(rows.len() as u32).to_be_bytes()).unwrap();
    stream.write_all(rows).unwrap();
}

/// Read and discard the list of kept accounts message a connected computer writes after its credential.
fn skip_kept_accounts(stream: &mut impl Read) {
    let mut size = [0_u8; 4];
    stream.read_exact(&mut size).unwrap();
    let mut rows = vec![0_u8; u32::from_be_bytes(size) as usize];
    stream.read_exact(&mut rows).unwrap();
    assert_eq!(rows, br#"{"rows":[]}"#);
}

fn admitted_pair(
    expires_at_ms: i64,
    live: Arc<AtomicBool>,
) -> (ForwarderConnection<UnixStream>, UnixStream) {
    let (public, mut mac) = pair();
    let credential = b"fixture-device-credential";
    mac.write_all(&(credential.len() as u32).to_be_bytes())
        .unwrap();
    mac.write_all(credential).unwrap();
    tell(&mut mac);
    let connection = ForwarderConnection::admit_from_stream(
        public,
        Arc::new(Admission {
            expires_at_ms,
            live,
        }),
        test_clock(),
    )
    .unwrap();
    connection.acknowledge().unwrap();
    let mut size = [0_u8; 4];
    mac.read_exact(&mut size).unwrap();
    let mut ack = vec![0_u8; u32::from_be_bytes(size) as usize];
    mac.read_exact(&mut ack).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&ack).unwrap()["route"],
        serde_json::to_value(route()).unwrap()
    );
    (connection, mac)
}

#[test]
fn on_wire_connection_credential_is_bounded_and_authenticated() {
    let _lock = TEST_LOCK.lock().unwrap();
    CLOCK.store(1_000, Ordering::SeqCst);
    let oversized = vec![b'x'; 8_193];
    for (credential, send_body) in [
        (b"wrong-credential".as_slice(), true),
        (oversized.as_slice(), false),
    ] {
        let (public, mut mac) = pair();
        mac.write_all(&(credential.len() as u32).to_be_bytes())
            .unwrap();
        if send_body {
            mac.write_all(credential).unwrap();
            tell(&mut mac);
        }
        assert!(ForwarderConnection::admit_from_stream(
            public,
            Arc::new(Admission {
                expires_at_ms: 2_000,
                live: Arc::new(AtomicBool::new(true)),
            }),
            test_clock(),
        )
        .is_none());
    }
}

#[test]
fn mac_refuses_missing_or_wrong_route_admission_ack() {
    let _lock = TEST_LOCK.lock().unwrap();
    CLOCK.store(1_000, Ordering::SeqCst);
    let (public, mac) = pair();
    let rejected = std::thread::spawn(move || {
        connect_mac_session(mac, b"wrong-credential", &route(), test_clock(), |_| unreachable!())
    });
    assert!(ForwarderConnection::admit_from_stream(
        public,
        Arc::new(Admission {
            expires_at_ms: 2_000,
            live: Arc::new(AtomicBool::new(true))
        }),
        test_clock(),
    )
    .is_none());
    assert!(rejected.join().unwrap().is_err());

    let (mut public, mac) = pair();
    let wrong_route = std::thread::spawn(move || {
        connect_mac_session(
            mac,
            b"fixture-device-credential",
            &route(),
            test_clock(),
            |_| unreachable!(),
        )
    });
    let mut size = [0_u8; 4];
    public.read_exact(&mut size).unwrap();
    let mut credential = vec![0_u8; u32::from_be_bytes(size) as usize];
    public.read_exact(&mut credential).unwrap();
    assert_eq!(credential, b"fixture-device-credential");
    skip_kept_accounts(&mut public);
    let mut other_route = route();
    other_route.generation = "generation:other".into();
    let ack = json!({"version":"trillion.resource-connection-admitted/v1","route":other_route,"expires_at_ms":2_000}).to_string();
    public.write_all(&(ack.len() as u32).to_be_bytes()).unwrap();
    public.write_all(ack.as_bytes()).unwrap();
    assert!(wrong_route.join().unwrap().is_err());
}

#[test]
fn mac_stops_dispatching_when_acknowledged_session_expires() {
    let _lock = TEST_LOCK.lock().unwrap();
    CLOCK.store(1_000, Ordering::SeqCst);
    let (mut public, mac) = pair();
    let handled = Arc::new(AtomicUsize::new(0));
    let mac_handled = handled.clone();
    let mac_thread = std::thread::spawn(move || {
        connect_mac_session(mac, b"fixture-device-credential", &route(), test_clock(), |_bytes| {
            mac_handled.fetch_add(1, Ordering::SeqCst);
            Ok(b"ok".to_vec())
        })
    });
    let mut size = [0_u8; 4];
    public.read_exact(&mut size).unwrap();
    let mut credential = vec![0_u8; u32::from_be_bytes(size) as usize];
    public.read_exact(&mut credential).unwrap();
    assert_eq!(credential, b"fixture-device-credential");
    skip_kept_accounts(&mut public);
    let ack = json!({"version":"trillion.resource-connection-admitted/v1","route":route(),"expires_at_ms":2_000}).to_string();
    public.write_all(&(ack.len() as u32).to_be_bytes()).unwrap();
    public.write_all(ack.as_bytes()).unwrap();

    let invoke = message();
    public
        .write_all(&(invoke.len() as u32).to_be_bytes())
        .unwrap();
    public.write_all(&invoke).unwrap();
    public.read_exact(&mut size).unwrap();
    assert_eq!(u32::from_be_bytes(size), 2);
    let mut reply = [0_u8; 2];
    public.read_exact(&mut reply).unwrap();
    assert_eq!(&reply, b"ok");
    assert_eq!(handled.load(Ordering::SeqCst), 1);

    CLOCK.store(2_000, Ordering::SeqCst);
    let _ = public.write_all(&(invoke.len() as u32).to_be_bytes());
    let _ = public.write_all(&invoke);
    assert_eq!(
        mac_thread.join().unwrap().unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert_eq!(handled.load(Ordering::SeqCst), 1);
}

#[test]
fn wire_session_refuses_invokes_until_one_acknowledgement() {
    let _lock = TEST_LOCK.lock().unwrap();
    CLOCK.store(1_000, Ordering::SeqCst);
    let (public, mut mac) = pair();
    let credential = b"fixture-device-credential";
    mac.write_all(&(credential.len() as u32).to_be_bytes())
        .unwrap();
    mac.write_all(credential).unwrap();
    tell(&mut mac);
    let connection = ForwarderConnection::admit_from_stream(
        public,
        Arc::new(Admission {
            expires_at_ms: 2_000,
            live: Arc::new(AtomicBool::new(true)),
        }),
        test_clock(),
    )
    .unwrap();
    not_sent(connection.invoke(&route(), &message()), "resource_route_unavailable");
    connection.acknowledge().unwrap();
    assert!(connection.acknowledge().is_err());
    let mut size = [0_u8; 4];
    mac.read_exact(&mut size).unwrap();
    let mut ack = vec![0_u8; u32::from_be_bytes(size) as usize];
    mac.read_exact(&mut ack).unwrap();
    let ack: serde_json::Value = serde_json::from_slice(&ack).unwrap();
    assert_eq!(ack["route"], serde_json::to_value(route()).unwrap());
    assert_eq!(ack["expires_at_ms"], 2_000);
}

#[test]
fn admitted_outbound_session_binds_route_and_expires() {
    let _lock = TEST_LOCK.lock().unwrap();
    CLOCK.store(1_000, Ordering::SeqCst);
    let live = Arc::new(AtomicBool::new(true));
    let (too_long_public, mut too_long_mac) = pair();
    let credential = b"fixture-device-credential";
    too_long_mac
        .write_all(&(credential.len() as u32).to_be_bytes())
        .unwrap();
    too_long_mac.write_all(credential).unwrap();
    assert!(ForwarderConnection::admit_from_stream(
        too_long_public,
        Arc::new(Admission {
            expires_at_ms: 121_001,
            live: live.clone()
        }),
        test_clock(),
    )
    .is_none());
    let (connection, mac) = admitted_pair(2_000, live.clone());
    let handled = Arc::new(AtomicUsize::new(0));
    let mac_handled = handled.clone();
    let mac_thread = std::thread::spawn(move || {
        serve_mac_session(mac, &route(), test_clock(), |_bytes| {
            mac_handled.fetch_add(1, Ordering::SeqCst);
            Ok(
                json!({"state":"completed","request_id":"request:one","value":{"version":1}})
                    .to_string()
                    .into_bytes(),
            )
        })
    });
    let mut wrong = route();
    wrong.generation = "generation:other".into();
    assert!(connection.invoke(&wrong, &message()).is_err());
    let reply = connection.invoke(&route(), &message()).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&reply).unwrap()["value"]["version"],
        1
    );
    live.store(false, Ordering::SeqCst);
    not_sent(connection.invoke(&route(), &message()), "resource_route_unavailable");
    live.store(true, Ordering::SeqCst);
    not_sent(connection.invoke(&route(), &message()), "resource_route_unavailable");
    assert_eq!(handled.load(Ordering::SeqCst), 1);
    CLOCK.store(2_000, Ordering::SeqCst);
    not_sent(connection.invoke(&route(), &message()), "resource_route_unavailable");
    assert_eq!(handled.load(Ordering::SeqCst), 1);
    drop(connection);
    mac_thread.join().unwrap().unwrap();
}

#[test]
fn lost_reply_retires_session_without_resending() {
    let _lock = TEST_LOCK.lock().unwrap();
    CLOCK.store(1_000, Ordering::SeqCst);
    let (connection, mac) = admitted_pair(2_000, Arc::new(AtomicBool::new(true)));
    let mac_thread = std::thread::spawn(move || serve_mac_session(mac, &route(), test_clock(), |_bytes| Err(trillion_local::refusal_cause::CodedError::new(()))));
    assert!(connection.invoke(&route(), &message()).is_err(), "a lost reply is an unknown outcome");
    not_sent(connection.invoke(&route(), &message()), "resource_route_unavailable");
    assert!(mac_thread.join().unwrap().is_err());
}

/// An invoke message with its own request id and deadline.
fn message_at(request_id: &str, deadline_at_ms: i64) -> Vec<u8> {
    let mut message: InvokeMessage = serde_json::from_slice(&message()).unwrap();
    message.request_id = request_id.into();
    message.deadline_at_ms = deadline_at_ms;
    serde_json::to_vec(&message).unwrap()
}

fn write_message(stream: &mut impl Write, bytes: &[u8]) {
    stream.write_all(&(bytes.len() as u32).to_be_bytes()).unwrap();
    stream.write_all(bytes).unwrap();
}

fn read_reply(stream: &mut impl Read) -> serde_json::Value {
    let mut size = [0_u8; 4];
    stream.read_exact(&mut size).unwrap();
    let mut reply = vec![0_u8; u32::from_be_bytes(size) as usize];
    stream.read_exact(&mut reply).unwrap();
    serde_json::from_slice(&reply).unwrap()
}

#[test]
fn expired_messages_in_line_do_not_delay_a_fresh_one() {
    let _lock = TEST_LOCK.lock().unwrap();
    CLOCK.store(1_000, Ordering::SeqCst);
    let (mut public, mac) = pair();
    let handled = Arc::new(AtomicUsize::new(0));
    let mac_handled = handled.clone();
    // Each dispatch takes as long as a slow operation: five of them would take a second.
    let mac_thread = std::thread::spawn(move || {
        serve_mac_session(mac, &route(), test_clock(), |bytes| {
            mac_handled.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(200));
            let message: InvokeMessage = serde_json::from_slice(bytes).unwrap();
            Ok(json!({"state":"completed","request_id":message.request_id,"value":{}}).to_string().into_bytes())
        })
    });
    // Five messages the forwarder has given up on wait in line before one fresh message.
    for index in 0..5 {
        write_message(&mut public, &message_at(&format!("request:expired-{index}"), 999));
    }
    write_message(&mut public, &message_at("request:fresh", 1_500));
    let started = std::time::Instant::now();
    for index in 0..5 {
        assert_eq!({ let mut source_reply = read_reply(&mut public); let source_cause = source_reply.as_object_mut().unwrap().remove("cause").expect("every refusal carries its construction source"); let source_cause = trillion_local::refusal_cause::ReportedCause::from_wire(source_cause.as_str().unwrap()).expect("the source identity is valid and content-free"); assert!(source_cause.id().contains("@src/forwarder/")); source_reply }, json!({"state":"refused","request_id":format!("request:expired-{index}"),"code":"resource_deadline_elapsed"}));
    }
    assert_eq!(read_reply(&mut public)["request_id"], "request:fresh");
    let took = started.elapsed();
    assert_eq!(handled.load(Ordering::SeqCst), 1, "only the fresh message is dispatched");
    assert!(took < Duration::from_millis(600), "the fresh message waited {took:?} behind expired ones");
    drop(public);
    mac_thread.join().unwrap().unwrap();
}

/// A registration owner that counts its reads.
struct CountedAdmission {
    asked: Arc<AtomicUsize>,
}
impl ConnectionAdmission for CountedAdmission {
    fn admit(&self, credential: &[u8], _: i64) -> Option<ConnectionGrant> {
        (credential == b"fixture-device-credential").then(|| ConnectionGrant {
            admission_identity: None,
            route: route(),
            expires_at_ms: 2_000,
        })
    }
    fn is_current(&self, grant: &ConnectionGrant, now_ms: i64) -> bool {
        self.asked.fetch_add(1, Ordering::SeqCst);
        grant.route == route() && now_ms < 2_000
    }
}

#[test]
fn a_message_past_its_deadline_is_not_sent_and_the_registration_is_read_once_per_sent_message() {
    let _lock = TEST_LOCK.lock().unwrap();
    CLOCK.store(1_000, Ordering::SeqCst);
    let (public, mut mac) = pair();
    let credential = b"fixture-device-credential";
    write_message(&mut mac, credential);
    tell(&mut mac);
    let asked = Arc::new(AtomicUsize::new(0));
    let connection = ForwarderConnection::admit_from_stream(public, Arc::new(CountedAdmission { asked: asked.clone() }), test_clock())
        .unwrap();
    connection.acknowledge().unwrap();
    read_reply(&mut mac);
    let after_acknowledgement = asked.load(Ordering::SeqCst);
    let handled = Arc::new(AtomicUsize::new(0));
    let mac_handled = handled.clone();
    let mac_thread = std::thread::spawn(move || {
        serve_mac_session(mac, &route(), test_clock(), |bytes| {
            mac_handled.fetch_add(1, Ordering::SeqCst);
            let message: InvokeMessage = serde_json::from_slice(bytes).unwrap();
            Ok(json!({"state":"completed","request_id":message.request_id,"value":{}}).to_string().into_bytes())
        })
    });
    // A message whose deadline passed while it waited for its turn is not sent, and the session stays usable.
    let late: serde_json::Value = serde_json::from_slice(&connection.invoke(&route(), &message_at("request:late", 1_000)).unwrap()).unwrap();
    assert_eq!({ let mut source_reply = late; let source_cause = source_reply.as_object_mut().unwrap().remove("cause").expect("every refusal carries its construction source"); let source_cause = trillion_local::refusal_cause::ReportedCause::from_wire(source_cause.as_str().unwrap()).expect("the source identity is valid and content-free"); assert!(source_cause.id().contains("@src/forwarder/")); source_reply }, json!({"state":"refused","request_id":"request:late","code":"resource_deadline_elapsed"}));
    assert_eq!(asked.load(Ordering::SeqCst), after_acknowledgement, "nothing is read for a message that is not sent");
    for index in 0..3 {
        let reply = connection.invoke(&route(), &message_at(&format!("request:{index}"), 1_500)).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&reply).unwrap()["request_id"], format!("request:{index}"));
    }
    assert_eq!(handled.load(Ordering::SeqCst), 3);
    assert_eq!(asked.load(Ordering::SeqCst) - after_acknowledgement, 3, "one registration read per sent message");
    drop(connection);
    mac_thread.join().unwrap().unwrap();
}

/// A registration owner whose next answers are scripted; with nothing scripted it answers current.
struct ScriptedAdmission {
    answers: Arc<Mutex<Vec<Registration>>>,
}
impl ConnectionAdmission for ScriptedAdmission {
    fn admit(&self, credential: &[u8], _: i64) -> Option<ConnectionGrant> {
        (credential == b"fixture-device-credential").then(|| ConnectionGrant {
            admission_identity: None,
            route: route(),
            expires_at_ms: 2_000,
        })
    }
    fn is_current(&self, grant: &ConnectionGrant, now_ms: i64) -> bool {
        self.registration(grant, now_ms) == Registration::Current
    }
    fn registration(&self, _: &ConnectionGrant, _: i64) -> Registration {
        let mut answers = self.answers.lock().unwrap();
        if answers.is_empty() { Registration::Current } else { answers.remove(0) }
    }
}

#[test]
fn an_owner_that_times_out_refuses_one_message_and_keeps_the_session_and_only_a_withdrawal_retires_it() {
    let _lock = TEST_LOCK.lock().unwrap();
    CLOCK.store(1_000, Ordering::SeqCst);
    let (public, mut mac) = pair();
    write_message(&mut mac, b"fixture-device-credential");
    tell(&mut mac);
    let answers = Arc::new(Mutex::new(Vec::new()));
    let connection = ForwarderConnection::admit_from_stream(public, Arc::new(ScriptedAdmission { answers: answers.clone() }), test_clock())
        .unwrap();
    connection.acknowledge().unwrap();
    read_reply(&mut mac);
    let handled = Arc::new(AtomicUsize::new(0));
    let mac_handled = handled.clone();
    let mac_thread = std::thread::spawn(move || {
        serve_mac_session(mac, &route(), test_clock(), |bytes| {
            mac_handled.fetch_add(1, Ordering::SeqCst);
            let message: InvokeMessage = serde_json::from_slice(bytes).unwrap();
            Ok(json!({"state":"completed","request_id":message.request_id,"value":{}}).to_string().into_bytes())
        })
    });
    // The owner timed out: the message is refused unsent, and the session is still ready for the next one.
    let unknown_cause = trillion_local::cause!(condition: synthetic_registry_unavailable);
    answers.lock().unwrap().push(Registration::Unknown(unknown_cause.clone()));
    let blip: serde_json::Value = serde_json::from_slice(&connection.invoke(&route(), &message_at("request:blip", 1_500)).unwrap()).unwrap();
    assert_eq!(blip["cause"], unknown_cause.id(), "the registry failure origin survives the no-send envelope");
    assert_eq!({ let mut source_reply = blip; let source_cause = source_reply.as_object_mut().unwrap().remove("cause").expect("every refusal carries its construction source"); let source_cause = trillion_local::refusal_cause::ReportedCause::from_wire(source_cause.as_str().unwrap()).expect("the source identity is valid and content-free"); assert_eq!(source_cause.id(), unknown_cause.id()); source_reply }, json!({"state":"refused","request_id":"request:blip","code":"resource_route_unavailable"}));
    assert_eq!(handled.load(Ordering::SeqCst), 0, "nothing reached the Mac while the owner could not be read");
    let next = connection.invoke(&route(), &message_at("request:next", 1_500)).unwrap();
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&next).unwrap()["request_id"], "request:next");
    assert_eq!(handled.load(Ordering::SeqCst), 1, "a timeout did not retire the session: it carries the next message");
    // The owner says the registration is withdrawn: the message is refused and the session retires for good.
    let withdrawn_cause = trillion_local::cause!(condition: synthetic_registry_withdrawn);
    answers.lock().unwrap().push(Registration::Withdrawn(withdrawn_cause.clone()));
    let gone: serde_json::Value = serde_json::from_slice(&connection.invoke(&route(), &message_at("request:gone", 1_500)).unwrap()).unwrap();
    assert_eq!(gone["cause"], withdrawn_cause.id(), "a withdrawal keeps the registry source");
    assert_eq!({ let mut source_reply = gone; let source_cause = source_reply.as_object_mut().unwrap().remove("cause").expect("every refusal carries its construction source"); let source_cause = trillion_local::refusal_cause::ReportedCause::from_wire(source_cause.as_str().unwrap()).expect("the source identity is valid and content-free"); assert_eq!(source_cause.id(), withdrawn_cause.id()); source_reply }, json!({"state":"refused","request_id":"request:gone","code":"resource_route_unavailable"}));
    // The owner would answer current again, but a withdrawn session stays retired: nothing more is sent on it.
    let after: serde_json::Value = serde_json::from_slice(&connection.invoke(&route(), &message_at("request:after", 1_500)).unwrap()).unwrap();
    assert_eq!(after["code"], "resource_route_unavailable");
    assert_eq!(handled.load(Ordering::SeqCst), 1, "a withdrawal retires the session");
    drop(connection);
    mac_thread.join().unwrap().unwrap();
}
