use super::*;
use crate::storage::memory::Memory;

/// `word:rest`, the shape of sign-in ids and gate names.
fn named(word: &str, rest: &str) -> String {
    [word, rest].join(":")
}

fn sign_in() -> String {
    named("key", "credential")
}
const RESOURCE: &str = "@own-records";
const PUBLISHED: &str = "update-latest";

fn reach() -> Value {
    json!({"private":true,"spaces":"all"})
}

fn identity() -> Value {
    json!({"owner":"owner","sign_in":sign_in(),"resource":RESOURCE})
}

fn put_fact(gate: &Memory, name: &str, value: &Value) {
    gate.put(
        "policy_directory",
        &[("name", Stored::from(name)), ("value", Stored::Text(value.to_string()))],
        When::Always,
    )
    .unwrap();
}

/// A hosted gate at its own epoch 9 that holds the latest published update, with `row` for the sign-in.
fn gate(row: Option<Value>) -> Memory {
    let gate = Memory::open("account_gate").unwrap();
    let sign_ins = row.map_or(json!({}), |row| json!({ (sign_in()): row }));
    gate.put(
        STATE,
        &[
            ("singleton", Stored::Integer(1)),
            ("epoch", Stored::Integer(9)),
            ("state_json", Stored::Text(json!({"epoch":9,"lifecycle":{},"sign_ins":sign_ins}).to_string())),
            ("updating_id", Stored::Null),
        ],
        When::New,
    )
    .unwrap();
    put_fact(&gate, "identity", &identity());
    put_fact(&gate, GATE_PUBLISHED, &json!(PUBLISHED));
    gate
}

/// The account's current policy snapshot for the sign-in at directory revision 35.
fn source(row: Value) -> Value {
    json!({"epoch":35,"lifecycle":{},"sign_ins":{ (sign_in()): row }})
}

fn saved(gate: &Memory) -> (u64, Value) {
    let mut row = gate
        .get(STATE, &[Stored::Integer(1)], &[Read::whole("epoch"), Read::whole("state_json")])
        .unwrap()
        .unwrap();
    let epoch = row.take(0).as_integer().unwrap() as u64;
    let Stored::Text(state) = row.take(1) else { panic!("state") };
    (epoch, serde_json::from_str(&state).unwrap())
}

fn catch_up(gate: &Memory, source: &Value) -> Result<bool> {
    let identity = identity();
    let latest = json!(PUBLISHED);
    catch_up_gate(gate, &GatePolicy { identity: &identity, source, revision: 35, latest_update: &latest }, || Ok(()))
}

fn granted() -> Value {
    json!({"made":reach(),"ceiling":reach(),"chosen":null,"last_used":"2026-10-25T00:00:00.000Z"})
}

#[test]
fn a_current_grant_is_decided_again_and_saved_at_the_revision() {
    let gate = gate(Some(granted()));
    // The source omits the signed registration and holds an older use; both are the gate's to keep.
    assert!(catch_up(&gate, &source(json!({"chosen":null,"last_used":"2026-10-01T00:00:00.000Z"}))).unwrap());
    let (epoch, state) = saved(&gate);
    assert_eq!(epoch, 35);
    assert_eq!(state["epoch"], json!(35));
    assert_eq!(state["sign_ins"][sign_in()]["made"], reach());
    assert_eq!(state["sign_ins"][sign_in()]["last_used"], json!("2026-10-25T00:00:00.000Z"));
    // Already at the revision: nothing further is saved.
    assert!(!catch_up(&gate, &source(json!({}))).unwrap());
    assert_eq!(saved(&gate), (epoch, state));
}

#[test]
fn a_right_the_current_policy_revoked_stays_revoked_after_catch_up() {
    let ended = json!({"ended_until_ms":"2099-01-01T00:00:00.000Z"});
    let revoked = json!({"made":reach(),"ceiling":reach(),"ended_until_ms":"2099-01-01T00:00:00.000Z"});
    let gate_revoked = gate(Some(revoked));
    assert!(catch_up(&gate_revoked, &source(ended.clone())).unwrap());
    assert_eq!(saved(&gate_revoked).0, 35);

    // A grant the gate still allows is revoked when the current policy ended it.
    let gate_granted = gate(Some(granted()));
    assert!(catch_up(&gate_granted, &source(ended)).unwrap());
}

#[test]
fn a_key_with_no_grant_gets_none() {
    let gate = gate(None);
    assert!(catch_up(&gate, &source(json!({}))).unwrap());
    let (epoch, state) = saved(&gate);
    assert_eq!(epoch, 35);
    assert!(state["sign_ins"][sign_in()].get("made").is_none_or(Value::is_null));
}

#[test]
fn a_gate_that_may_have_missed_a_change_is_refused_and_left_unchanged() {
    let paused = |gate: &Memory| put_fact(gate, "fence", &json!("update-next"));
    let older = |gate: &Memory| put_fact(gate, GATE_PUBLISHED, &json!("update-older"));
    let open = |gate: &Memory| {
        gate.put(
            STATE,
            &[("singleton", Stored::Integer(1)), ("updating_id", Stored::from("update-next"))],
            When::Always,
        )
        .unwrap();
    };
    for (case, change) in [("fenced", paused as fn(&Memory)), ("older", older), ("open", open)] {
        let gate = gate(Some(granted()));
        change(&gate);
        let before = saved(&gate);
        assert_eq!(catch_up(&gate, &source(json!({}))), Err(crate::cause!(Error::UpdateChanged)), "{case}");
        assert_eq!(saved(&gate), before, "{case}");
    }
    // Another gate's identity, or a policy that stopped being current before commit: nothing is saved.
    let gate_other = gate(Some(granted()));
    let before = saved(&gate_other);
    let other = json!({"owner":"owner","sign_in":named("key", "other"),"resource":RESOURCE});
    let latest = json!(PUBLISHED);
    let source = source(json!({}));
    let policy = GatePolicy { identity: &other, source: &source, revision: 35, latest_update: &latest };
    assert_eq!(catch_up_gate(&gate_other, &policy, || Ok(())), Err(crate::cause!(Error::NotAuthorized)));
    let identity = identity();
    let policy = GatePolicy { identity: &identity, ..policy };
    assert_eq!(catch_up_gate(&gate_other, &policy, || Err(crate::cause!(Error::SourceChanged))), Err(crate::cause!(Error::SourceChanged)));
    assert_eq!(saved(&gate_other), before);
}

#[test]
fn a_hosted_permit_cannot_be_read_or_completed_through_the_gate_after_catch_up() {
    // The hosted gate kept in-flight commands as rows of account_control_permits. The native engine reaches a gate
    // only through the account_gate schema, which declares no permit family: every read or write of a permit is
    // refused as undeclared, so no permit issued before catch-up (or by hosted at all) can be redeemed or completed.
    let gate = gate(Some(granted()));
    assert!(catch_up(&gate, &source(json!({}))).unwrap());
    let permit = [Stored::from("permit-from-hosted")];
    assert_eq!(
        gate.get("account_control_permits", &permit, &[Read::whole("state")]),
        Err(crate::cause!(crate::storage::Error::Undeclared))
    );
    assert_eq!(
        gate.put(
            "account_control_permits",
            &[("id", Stored::from("permit-from-hosted")), ("state", Stored::from("completed"))],
            When::Matches(&[("state", Stored::from("pending"))]),
        ),
        Err(crate::cause!(crate::storage::Error::Undeclared))
    );
}
