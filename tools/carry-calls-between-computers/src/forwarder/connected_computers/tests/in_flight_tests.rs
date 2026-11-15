//! A message in flight on one computer's session holds that computer's turn, never the route lookup.
use super::*;

/// A session whose message stays in flight until the test lets it go.
struct HeldSession {
    rows: Vec<KeptAccount>,
    entered: std::sync::mpsc::SyncSender<()>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}

impl ComputerConnections for HeldSession {
    fn invoke(&self, _: &Route, _: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
        self.entered.send(()).map_err(|_| crate::refusal_cause::CodedError::new(()))?;
        self.release.lock().map_err(|_| crate::refusal_cause::CodedError::new(()))?.recv().map_err(|_| crate::refusal_cause::CodedError::new(()))?;
        Ok(b"answered".to_vec())
    }
}

impl RegisteredSession for HeldSession {
    fn is_ready(&self) -> bool {
        true
    }

    fn is_past_lifetime(&self) -> bool {
        false
    }

    fn retire(&self) {}

    fn told(&self) -> Vec<KeptAccount> {
        self.rows.clone()
    }
}

#[test]
fn a_route_lookup_does_not_wait_for_a_message_in_flight() {
    let directory = Arc::new(ConnectedComputers::new());
    let (entered, in_flight) = std::sync::mpsc::sync_channel(1);
    let (release, held) = std::sync::mpsc::channel();
    let route = route_at(&account(), RESOURCE, COMPUTER_A);
    let session = HeldSession { rows: vec![row(1, &[COMPUTER_A], &[COMPUTER_A], account_key())], entered,
        release: Mutex::new(held) };
    let slot = directory.install_slot(&key_of(&route)).expect("slot");
    *slot.active.lock().unwrap() = Some(Entry { route: route.clone(), session: Arc::new(session) });
    let message = serde_json::to_vec(&crate::resource_authority::InvokeMessage { person_present: None,
        request_id: "req".into(), account_id: account(), device_id: COMPUTER_A.into(), resource_address: RESOURCE.into(),
        operation_resource: None, generation: route.generation.clone(), operation: "records:read".into(),
        input: serde_json::json!({}), request_key: "k".into(), client_authorization: "bearer".into(), deadline_at_ms: 1,
    }).unwrap();
    let sending = directory.clone();
    let sent_route = route.clone();
    let sender = std::thread::spawn(move || sending.invoke(&sent_route, &message));
    in_flight.recv_timeout(std::time::Duration::from_secs(5)).expect("the message is in flight");
    let started = std::time::Instant::now();
    assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_A), "the computer stays live while its message is in flight");
    assert!(started.elapsed() < std::time::Duration::from_millis(100), "the lookup waited {:?}", started.elapsed());
    release.send(()).unwrap();
    assert_eq!(sender.join().unwrap().unwrap(), b"answered");
}
