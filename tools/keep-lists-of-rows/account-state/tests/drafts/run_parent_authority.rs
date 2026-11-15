// One narrowed run capability can retain its original credential authority.
// These controls use a synthetic grant callback, never a provider or account.
use super::*;
use crate::mcp::{OperationFailure, RequestDisclosure};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const ACCOUNT: &str = "synthetic-run-parent-account";
const PARENT: &[u8] = b"synthetic-oauth-parent-bearer";
const LIFE: Duration = Duration::from_secs(60);

fn who(account: &str) -> Principal {
    Principal { kind: trillion_local::mcp::PrincipalKind::Person,
        account_id: account.into(),
        sign_in: "grant:synthetic-run-parent".into(),
        client_id: "synthetic-parent-client".into(),
    }
}

fn write() -> &'static str {
    crate::record_write_model::write_command::Command::shipped()
        .unwrap()
        .operation()
}

fn scope() -> Rights {
    Rights::declared(&json!({"most_writes":1,"rights":[
        {"kind":"note","id":"allowed-note","operations":[write()]}
    ]}))
    .unwrap()
}

fn call(id: &str, kind: &str) -> Operation {
    Operation { person_present: None,
        resource: Door::shipped().unwrap().resource().into(),
        operation: write().into(),
        request_key: "synthetic-parent-write".into(),
        input: json!({"records":[{"id":id,"type":kind,"value":{"words":"synthetic"}}]}),
    }
}

struct Grant {
    live: AtomicBool,
    authentications: AtomicUsize,
    calls: AtomicUsize,
    answered_as: String,
    received: Mutex<Vec<Value>>,
}
impl Grant {
    fn new(account: &str) -> Arc<Self> {
        Arc::new(Self {
            live: AtomicBool::new(true),
            authentications: AtomicUsize::new(0),
            calls: AtomicUsize::new(0),
            answered_as: account.into(),
            received: Mutex::new(Vec::new()),
        })
    }
}
impl ParentAuthority for Grant {
    fn authenticate(&self) -> Result<Principal, AuthenticationFailure> {
        self.authentications.fetch_add(1, Ordering::SeqCst);
        if !self.live.load(Ordering::SeqCst) {
            return Err(trillion_local::cause!(AuthenticationFailure::Unauthorized));
        }
        Ok(who(&self.answered_as))
    }

    fn invoke(
        &self,
        principal: &Principal,
        call: Operation,
        run: &Admitted,
        _disclosure: &RequestDisclosure,
    ) -> Result<Value, OperationFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(principal, &who(ACCOUNT));
        assert!(run.reaches(write(), "note"));
        assert!(!run.reaches(write(), "private-kind"));
        assert_eq!(run.cause(), Some("synthetic-root-cause"));
        self.received.lock().unwrap().push(call.input.clone());
        Ok(json!({"changed":true}))
    }
}

/// A typed OAuth parent must use its retained authority. Passing its original
/// bearer to a personal-key-only authenticator would refuse every such run.
struct RejectAll;
impl BearerAuthenticator for RejectAll {
    fn authenticate(&self, _bearer: &[u8]) -> Option<Principal> {
        None
    }
}

#[test]
fn run_parent_authority_authenticates_as_its_original_grant_and_rechecks_withdrawal() {
    let grant = Grant::new(ACCOUNT);
    let capability =
        mint_with_authority(ACCOUNT, PARENT, scope(), None, LIFE, grant.clone()).unwrap();
    let auth = Authenticator::new(RejectAll);
    assert_eq!(
        auth.authenticate_current(capability.token().as_bytes()),
        Ok(who(ACCOUNT))
    );
    grant.live.store(false, Ordering::SeqCst);
    assert_eq!(
        auth.authenticate_current(capability.token().as_bytes()),
        Err(trillion_local::cause!(AuthenticationFailure::Unauthorized))
    );
    assert!(grant.authentications.load(Ordering::SeqCst) >= 2);
    assert_eq!(grant.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn run_parent_authority_receives_only_narrowed_input_and_original_cause() {
    let grant = Grant::new(ACCOUNT);
    let capability = mint_with_authority(
        ACCOUNT,
        PARENT,
        scope(),
        Some("synthetic-root-cause"),
        LIFE,
        grant.clone(),
    )
    .unwrap();
    let admitted = held(capability.token().as_bytes()).unwrap().unwrap();
    let disclosure = RequestDisclosure::default();
    let answer = admitted
        .invoke_parent(&who(ACCOUNT), call("allowed-note", "note"), &disclosure)
        .expect("typed parent")
        .unwrap();
    assert_eq!(answer, json!({"changed":true}));
    let received = grant.received.lock().unwrap();
    assert_eq!(received.len(), 1);
    let field = crate::wake::Waker::shipped()
        .unwrap()
        .cause_field()
        .to_owned();
    assert_eq!(
        received[0]["records"][0]["value"][&field],
        "synthetic-root-cause"
    );
    drop(received);
    // Neither another id nor another kind may reach the parent implementation.
    for refused in [
        call("sibling-note", "note"),
        call("allowed-note", "private-kind"),
    ] {
        assert!(admitted
            .invoke_parent(&who(ACCOUNT), refused, &disclosure)
            .unwrap()
            .is_err());
    }
    let mut too_many = call("allowed-note", "note");
    too_many.input["records"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id":"allowed-note","type":"note","value":{}
        }));
    assert!(admitted
        .invoke_parent(&who(ACCOUNT), too_many, &disclosure)
        .unwrap()
        .is_err());
    assert_eq!(grant.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn run_parent_authority_refuses_foreign_identity_before_callback() {
    let grant = Grant::new(ACCOUNT);
    let capability = mint_with_authority(
        ACCOUNT,
        PARENT,
        scope(),
        Some("synthetic-root-cause"),
        LIFE,
        grant.clone(),
    )
    .unwrap();
    let admitted = held(capability.token().as_bytes()).unwrap().unwrap();
    assert!(admitted
        .invoke_parent(
            &who("foreign-account"),
            call("allowed-note", "note"),
            &RequestDisclosure::default(),
        )
        .unwrap()
        .is_err());
    assert_eq!(grant.calls.load(Ordering::SeqCst), 0);
    let foreign = Grant::new("foreign-account");
    assert_eq!(
        mint_with_authority(ACCOUNT, PARENT, scope(), None, LIFE, foreign.clone()).err(),
        Some(trillion_local::cause!(Refusal::NotGranted)),
        "a foreign parent is refused before a capability is minted"
    );
    assert_eq!(foreign.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn run_parent_authority_descriptor_contains_only_run_token_and_drop_revokes_it() {
    let grant = Grant::new(ACCOUNT);
    let parent = ParentKey {
        address: "synthetic-address",
        account: ACCOUNT,
        bearer: PARENT,
        door: "127.0.0.1:28788".parse().unwrap(),
        cause: None,
    };
    let rows = json!({"fd":4,"rights":[{"kind":"note","operations":["records:read"]}]});
    let issued = issue_from_authority(&parent, &rows, None, LIFE, grant.clone()).unwrap();
    let descriptor: Value = serde_json::from_slice(&issued.descriptor).unwrap();
    assert_eq!(descriptor["url"], "http://127.0.0.1:28788/a/synthetic-address/mcp");
    assert_eq!(descriptor["capability"], issued.capability.token());
    assert!(
        !String::from_utf8_lossy(&issued.descriptor).contains(std::str::from_utf8(PARENT).unwrap())
    );
    let token = issued.capability.token().to_owned();
    assert_eq!(
        Authenticator::new(RejectAll).authenticate_current(token.as_bytes()),
        Ok(who(ACCOUNT))
    );
    drop(issued);
    assert!(matches!(
        held(token.as_bytes()),
        Some(Err(Refusal::NotLive(_)))
    ));
}

#[test]
fn run_parent_authority_previously_admitted_request_dies_with_capability() {
    let grant = Grant::new(ACCOUNT);
    let capability = mint_with_authority(ACCOUNT, PARENT, scope(), None, LIFE, grant.clone()).unwrap();
    let admitted = held(capability.token().as_bytes()).unwrap().unwrap();
    let current = admitted.current_checker();
    assert_eq!(admitted.current(), Ok(()));
    assert!(current());
    assert!(admitted.reaches(write(), "note"));
    drop(capability);
    assert!(!current(), "retaining the check must not retain the capability");
    assert_eq!(admitted.current(), Err(trillion_local::cause!(Refusal::NotLive)));
    assert_eq!(admitted.narrow(&who(ACCOUNT), &call("allowed-note", "note")), Err(trillion_local::cause!(Refusal::NotLive)));
    assert!(!admitted.reaches(write(), "note"));
    assert!(admitted.invoke_parent(&who(ACCOUNT), call("allowed-note", "note"), &RequestDisclosure::default()).unwrap().is_err());
    assert_eq!(grant.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn run_parent_authority_previously_admitted_request_expires_at_effect_check() {
    let grant = Grant::new(ACCOUNT);
    let capability = mint_with_authority(ACCOUNT, PARENT, scope(), None, LIFE, grant).unwrap();
    let admitted = held(capability.token().as_bytes()).unwrap().unwrap();
    // Move the real entry's clock to the deadline without a timing-dependent
    // sleep; the same production currentness check must reject it.
    live().lock().unwrap().get_mut(&capability.digest).unwrap().until = Instant::now();
    assert_eq!(admitted.current(), Err(trillion_local::cause!(Refusal::NotLive)));
    assert!(!admitted.reaches(write(), "note"));
}
