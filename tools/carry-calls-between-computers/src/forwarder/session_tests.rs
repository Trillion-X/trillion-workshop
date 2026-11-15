//! Scenarios of the forwarder's session (the owner's tests). Each one states its verdict through the shared harness.

use super::*;
use std::io::Cursor;

/// A stream a relay writes to: the bytes it sends are read back, and what the computer writes is kept.
struct Relay {
    sent: Cursor<Vec<u8>>,
    written: Vec<u8>,
}

impl Read for Relay {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.sent.read(buffer)
    }
}

impl Write for Relay {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.written.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

const SCENARIO_NOW_MS: i64 = 1_000_000;

fn scenario_now() -> i64 {
    SCENARIO_NOW_MS
}

/// Incident 6 (version skew, shape-versions): a relay newer than the computer adds a field to its admission ack. The
/// computer must admit the ack. With its ack type refusing unknown fields it refuses the ack, which the forwarder
/// reports as 504 (`outcome_unknown`).
fn relay_newer_than_computer_ack_admits_unknown_field_body() -> Result<(), String> {
    let route = Route {
        account_id: "account-synthetic".into(),
        device_id: "device-synthetic".into(),
        resource_address: "resource-synthetic".into(),
        generation: "1".into(),
    };
    let ack = serde_json::to_vec(&serde_json::json!({
        "version": "trillion.resource-connection-admitted/v1",
        "route": route,
        "expires_at_ms": SCENARIO_NOW_MS + 60_000,
        "added_by_a_newer_relay": true,
    }))
    .map_err(|error| error.to_string())?;
    let mut sent = (ack.len() as u32).to_be_bytes().to_vec();
    sent.extend_from_slice(&ack);
    let mut relay = Relay { sent: Cursor::new(sent), written: Vec::new() };
    connect_mac_session(&mut relay, b"synthetic-credential", &route, crate::storage::time_source::fixed(scenario_now()), |_| Ok(Vec::new()))
        .map_err(|error| format!("the newer relay's ack was refused: {error}"))
}

#[test]
fn relay_newer_than_computer_ack_admits_unknown_field() {
    crate::simulation::verdict("relay-newer-than-computer-ack-admits-unknown-field", relay_newer_than_computer_ack_admits_unknown_field_body);
}
