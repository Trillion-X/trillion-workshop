//! A message that never leaves the connected computers is refused, correlated, and never read as an unknown outcome.
use super::*;

/// A session that has ended: never ready, and it must never be asked to send.
struct EndedSession;

impl ComputerConnections for EndedSession {
    fn invoke(&self, _: &Route, _: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
        panic!("a message is sent on a session that ended");
    }
}

impl RegisteredSession for EndedSession {
    fn is_ready(&self) -> bool {
        false
    }

    fn is_past_lifetime(&self) -> bool {
        true
    }

    fn retire(&self) {}

    fn told(&self) -> Vec<KeptAccount> {
        Vec::new()
    }
}

fn message(route: &Route) -> Vec<u8> {
    serde_json::to_vec(&crate::resource_authority::InvokeMessage { person_present: None,
        request_id: "req:not-sent".into(), account_id: route.account_id.clone(), device_id: route.device_id.clone(),
        resource_address: route.resource_address.clone(), operation_resource: None, generation: route.generation.clone(),
        operation: "records:write".into(), input: serde_json::json!({}), request_key: "k".into(),
        client_authorization: "bearer".into(), deadline_at_ms: i64::MAX,
    }).unwrap()
}

fn refused_route_unavailable(reply: Result<Vec<u8>, crate::refusal_cause::CodedError<()>>) {
    let reply: serde_json::Value = serde_json::from_slice(&reply.expect("a message never sent is refused, not unknown")).unwrap();
    assert_eq!({ let mut source_reply = reply; let source_cause = source_reply.as_object_mut().unwrap().remove("cause").expect("every refusal carries its construction source"); let source_cause = crate::refusal_cause::ReportedCause::from_wire(source_cause.as_str().unwrap()).expect("the source identity is valid and content-free"); assert!(source_cause.id().contains("@src/forwarder/")); source_reply }, serde_json::json!({"state": "refused", "request_id": "req:not-sent", "code": crate::forwarder::ROUTE_UNAVAILABLE}));
}

#[test]
fn a_route_with_no_session_is_refused_and_not_unknown() {
    let directory = ConnectedComputers::new();
    let route = route_at(&account(), RESOURCE, COMPUTER_A);
    refused_route_unavailable(directory.invoke(&route, &message(&route)));
}

#[test]
fn a_session_that_ended_before_its_turn_is_refused_and_cleared() {
    let directory = ConnectedComputers::new();
    let route = route_at(&account(), RESOURCE, COMPUTER_A);
    let slot = directory.install_slot(&key_of(&route)).expect("slot");
    *slot.active.lock().unwrap() = Some(Entry { route: route.clone(), session: Arc::new(EndedSession) });
    refused_route_unavailable(directory.invoke(&route, &message(&route)));
    assert!(slot.active.lock().unwrap().is_none(), "the ended session is cleared");
}

#[test]
fn a_message_that_cannot_be_read_stays_err() {
    let directory = ConnectedComputers::new();
    let route = route_at(&account(), RESOURCE, COMPUTER_A);
    assert!(directory.invoke(&route, b"not a message").is_err());
}
