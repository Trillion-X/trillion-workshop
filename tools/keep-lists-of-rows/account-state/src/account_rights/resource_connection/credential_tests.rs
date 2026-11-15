use super::*;
use content_crypto::advanced::blake3;
use crate::storage::{memory::Memory, Value as Stored, When};
use serde_json::json;

const KEY: &[u8] = b"synthetic-computer-key";
const START: u64 = 1_800_000_000_000;

fn account() -> AccountIdentity {
    AccountIdentity { user_id: "synthetic-user".into(), owner_id: blake3::hash(b"synthetic-owner").to_hex().to_string() }
}
fn device() -> String {
    blake3::hash(KEY).to_hex().to_string()
}
fn fact(store: &Memory, name: &str, value: &serde_json::Value) {
    store.put("policy_directory", &[("name", Stored::from(name)), ("value", Stored::Text(value.to_string()))], When::Always)
        .unwrap();
}
/// A canonical account whose computer `KEY` is registered, active, to host its own records.
fn store() -> Memory {
    let store = Memory::open("account_gate").unwrap();
    fact(&store, "policy-source", &json!({"from": "born", "missing": []}));
    fact(&store, "policy-source:account", &json!({"lifecycle": {}, "account_controls": {"owner_user_id": account().user_id}}));
    fact(&store, &super::super::name(&device(), "@own-records").unwrap(), &json!({
        "version": super::super::VERSION, "account_id": account().owner_id, "device_id": device(),
        "resource_address": "@own-records", "resource_generation": 1, "registration_revision": 1, "active": true,
        "last_request_key": "synthetic-enroll", "last_input_identity": blake3::hash(b"synthetic-enroll").to_hex().to_string(),
    }));
    store
}
struct Owner;
impl Issuer for Owner {
    fn assert_current(&mut self, _: &dyn Storage, _: &Registration) -> Result<()> { Ok(()) }
}
fn issued(store: &Memory, request_key: &str, expected: u64, now: u64) -> IssuedCredential {
    issue(store, &mut Owner, &account(), KEY, request_key, expected, MAX_LIFE_MS, now).unwrap()
}

#[test]
fn a_renewal_keeps_the_replaced_credential_current_until_its_own_expiry_so_a_call_during_it_is_carried() {
    let store = store();
    let first = issued(&store, "synthetic-first", 0, START);
    // Two thirds into the first credential's life the next session takes a fresh credential.
    let renewed_at = START + MAX_LIFE_MS * 2 / 3;
    let next = issued(&store, "synthetic-next", 1, renewed_at);
    // Until the next session is acknowledged the first one still carries calls: its registration still reads
    // current, at the account's door (is_current) and at the forwarder's admit read alike.
    let during = renewed_at + 1_000;
    assert!(is_current(&store, &account(), first.grant(), during).is_ok(), "the session in service is not cut by its renewal");
    let read_again = admit(&store, &account(), first.as_bytes(), during).unwrap();
    assert_eq!(read_again.expires_at_ms, first.grant().expires_at_ms);
    assert_eq!(read_again.admission_identity, first.grant().admission_identity);
    assert!(is_current(&store, &account(), next.grant(), during).is_ok());
    // The replaced credential ends at its own expiry, never later; the next one goes on.
    let after = START + MAX_LIFE_MS;
    assert_eq!(is_current(&store, &account(), first.grant(), after).unwrap_err(), crate::cause!(Error::Expired));
    assert_eq!(admit(&store, &account(), first.as_bytes(), after).err(), Some(crate::cause!(Error::Expired)));
    assert!(is_current(&store, &account(), next.grant(), after).is_ok());
    // Recovery answers only the newest credential.
    let recovered = recover_current(&store, &account(), KEY, during).unwrap().unwrap();
    assert_eq!(recovered.as_bytes(), next.as_bytes());
}

#[test]
fn only_the_one_credential_a_renewal_replaced_stays_and_a_withdrawn_registration_ends_both() {
    let store = store();
    let first = issued(&store, "synthetic-first", 0, START);
    let second = issued(&store, "synthetic-second", 1, START + 10_000);
    let third = issued(&store, "synthetic-third", 2, START + 20_000);
    let now = START + 21_000;
    assert_eq!(is_current(&store, &account(), first.grant(), now).unwrap_err(), crate::cause!(Error::Unauthorized),
        "a credential two renewals back is not kept");
    assert!(is_current(&store, &account(), second.grant(), now).is_ok());
    assert!(is_current(&store, &account(), third.grant(), now).is_ok());
    // Withdrawing the computer's registration ends every credential at once.
    let mut registration = super::super::current(&store, &account(), &device(), "@own-records").unwrap().unwrap();
    registration.active = false;
    fact(&store, &super::super::name(&device(), "@own-records").unwrap(), &serde_json::to_value(&registration).unwrap());
    assert!(is_current(&store, &account(), second.grant(), now).is_err());
    assert!(is_current(&store, &account(), third.grant(), now).is_err());
    assert!(admit(&store, &account(), second.as_bytes(), now).is_err());
}
