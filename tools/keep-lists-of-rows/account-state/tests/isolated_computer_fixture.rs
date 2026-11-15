//! Reusable synthetic Computer producer for browser proofs, and its actual TLS/account/lifetime smoke test.
//! Old trillion: scripts/passkey-account.mjs:1 made live proof accounts; scripts/paid-plan.mjs:1 bought their plans.
//! Rust home: this test owner uses Computer::start/app/accounts and owns only temporary synthetic state.
//! It neither recreates the old issuer/payment helpers nor proves any of Apps' original live proof requirements.
#![cfg(unix)]

#[path = "isolated_computer_fixture/computer.rs"]
mod computer;
#[path = "isolated_computer_fixture/control.rs"]
mod control;
#[path = "isolated_computer_fixture/tls.rs"]
mod tls;
use serde::Deserialize;

#[derive(Clone, Deserialize)]
struct Settings {
    version: u32,
    loopback: String,
    host: String,
    socket_timeout_ms: u64,
    poll_ms: u64,
    close_timeout_ms: u64,
    lifetime_ms: u64,
    maximum_head_bytes: usize,
    maximum_body_bytes: usize,
    maximum_connections: usize,
    maximum_control_bytes: usize,
    control_prefix: String,
    key_file: String,
    accounts_folder: String,
}
fn settings() -> Settings {
    serde_json::from_str(include_str!("isolated_computer_fixture/settings.json")).unwrap()
}

/// Start this one ignored test with --exact owned_browser_fixture --ignored --nocapture. Its stdin control protocol
/// owns close/EOF/deadline teardown. This binary never searches for or opens an installed account or browser.
#[test]
#[ignore = "explicit synthetic browser fixture process"]
fn owned_browser_fixture() {
    control::run(settings());
}

