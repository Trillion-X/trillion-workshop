// Tests of the person-present gate: the challenge store against a synthetic ES256 passkey signed here with ring (no
// browser, no account database), the requirements the live record model derives from a synthetic declaring record,
// and a scan that the gate's Rust source names no product concept. Every name below is synthetic.
use super::*;
use ring::{
    digest,
    rand::SystemRandom,
    signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING},
};
use serde_json::json;
use std::sync::atomic::{AtomicU32, Ordering};

pub(crate) const ORIGIN: &str = "https://app.example.test";
pub(crate) const RELYING_PARTY: &str = "app.example.test";
pub(crate) const CREDENTIAL_ID: &str = "synthetic-passkey-1";
/// The DER SubjectPublicKeyInfo prefix of an uncompressed P-256 public key (id-ecPublicKey, prime256v1).
const P256_SPKI_PREFIX: &[u8] = &[
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
    0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

/// One account's synthetic passkey: an ES256 key made for this test, and the counter its authenticator keeps.
pub(crate) struct FixturePasskey {
    key: EcdsaKeyPair,
    account: String,
    signed: AtomicU32,
    kept: AtomicU32,
}
impl FixturePasskey {
    pub(crate) fn new(account: &str) -> Arc<Self> {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng).unwrap();
        Arc::new(Self { key, account: account.to_owned(), signed: AtomicU32::new(0), kept: AtomicU32::new(0) })
    }
    fn credential(&self) -> Value {
        let mut spki = P256_SPKI_PREFIX.to_vec();
        spki.extend_from_slice(self.key.public_key().as_ref());
        json!({"id": CREDENTIAL_ID, "publicKey": URL_SAFE_NO_PAD.encode(spki), "algorithm": "ES256"})
    }
    /// The browser's assertion of `challenge`: user-present and verification flags, the next counter, signed by this key.
    pub(crate) fn assert(&self, challenge: &str) -> Value {
        self.assert_with(challenge, ORIGIN, 0x05)
    }
    fn assert_with(&self, challenge: &str, origin: &str, flags: u8) -> Value {
        let counter = self.signed.fetch_add(1, Ordering::SeqCst) + 1;
        let mut authenticator = digest::digest(&digest::SHA256, RELYING_PARTY.as_bytes()).as_ref().to_vec();
        authenticator.push(flags);
        authenticator.extend_from_slice(&counter.to_be_bytes());
        let client = json!({"type": "webauthn.get", "challenge": challenge, "origin": origin}).to_string();
        let mut message = authenticator.clone();
        message.extend_from_slice(digest::digest(&digest::SHA256, client.as_bytes()).as_ref());
        let signature = self.key.sign(&SystemRandom::new(), &message).unwrap();
        json!({"id": CREDENTIAL_ID, "type": "public-key", "response": {
            "authenticatorData": URL_SAFE_NO_PAD.encode(authenticator),
            "clientDataJSON": URL_SAFE_NO_PAD.encode(client.as_bytes()),
            "signature": URL_SAFE_NO_PAD.encode(signature.as_ref()),
        }})
    }
}
impl Passkeys for FixturePasskey {
    fn origin(&self) -> String {
        ORIGIN.into()
    }
    fn relying_party(&self) -> String {
        RELYING_PARTY.into()
    }
    fn credentials(&self, account: &str) -> Vec<StoredPasskey> {
        if account != self.account {
            return Vec::new();
        }
        vec![StoredPasskey { credential: self.credential(), counter: self.kept.load(Ordering::SeqCst) }]
    }
    fn advance(&self, account: &str, credential_id: &str, counter: u32) -> bool {
        account == self.account && credential_id == CREDENTIAL_ID && {
            self.kept.store(counter, Ordering::SeqCst);
            true
        }
    }
}

fn requirement(record: &str, field: &str, value: &str) -> Requirement {
    Requirement { record: record.into(), field: field.into(), value: value.into() }
}
const ACCOUNT: &str = "synthetic-account-a";
const NOW: u64 = 1_800_000_000_000;

fn proof(passkey: &FixturePasskey, issued: &Issued) -> Value {
    json!({"nonce": issued.nonce, "assertion": passkey.assert(&issued.challenge)})
}

#[test]
fn a_fresh_confirmation_of_the_exact_write_is_accepted_once() {
    let store = Challenges::default();
    let passkey = FixturePasskey::new(ACCOUNT);
    let wanted = requirement("record:row-1", "state", "Down");
    let issued = store.issue(ACCOUNT, &wanted, NOW).unwrap();
    assert_eq!(issued.challenge, challenge_of(ACCOUNT, &wanted, &issued.nonce));
    assert_eq!(issued.expires_at_ms, NOW + CHALLENGE_LIFETIME_MS);
    let given = proof(&passkey, &issued);
    assert_eq!(store.confirm(ACCOUNT, &wanted, &given, NOW + 1, passkey.as_ref()), Ok(()));
    // Already used: the nonce is gone, so even the same signed answer is refused.
    assert_eq!(store.confirm(ACCOUNT, &wanted, &given, NOW + 2, passkey.as_ref()), Err(crate::cause!(Refused::Unknown)));
}

#[test]
fn signed_confirmation_binds_the_full_history_without_consuming_mismatched_attempts() {
    use crate::storage::record_store_resources::domains::Identity;
    let store = Challenges::default();
    let passkey = FixturePasskey::new(ACCOUNT);
    let wanted = requirement("record:row-1", "state", "Down");
    let domain = Identity { id: "scope-a".into(), incarnation: "first".into(), generation: 1 };
    let issued = store.issue_in_domain(ACCOUNT, Some(&domain), &wanted, NOW).unwrap();
    assert_ne!(issued.challenge, challenge_of(ACCOUNT, &wanted, &issued.nonce));
    let given = proof(&passkey, &issued);
    for other in [None, Some(Identity { id: "scope-b".into(), ..domain.clone() }),
        Some(Identity { incarnation: "next".into(), ..domain.clone() }),
        Some(Identity { generation: 2, ..domain.clone() })] {
        assert_eq!(store.confirm_in_domain(ACCOUNT, other.as_ref(), &wanted, &given, NOW + 1, passkey.as_ref()), Err(crate::cause!(Refused::Mismatch)));
    }
    assert_eq!(store.confirm_in_domain(ACCOUNT, Some(&domain), &wanted, &given, NOW + 1, passkey.as_ref()), Ok(()));
    assert_eq!(store.confirm_in_domain(ACCOUNT, Some(&domain), &wanted, &given, NOW + 2, passkey.as_ref()), Err(crate::cause!(Refused::Unknown)));
}

#[test]
fn an_expired_confirmation_is_refused_and_forgotten() {
    let store = Challenges::default();
    let passkey = FixturePasskey::new(ACCOUNT);
    let wanted = requirement("record:row-1", "state", "Down");
    let issued = store.issue(ACCOUNT, &wanted, NOW).unwrap();
    let given = proof(&passkey, &issued);
    assert_eq!(store.confirm(ACCOUNT, &wanted, &given, NOW + CHALLENGE_LIFETIME_MS, passkey.as_ref()), Err(crate::cause!(Refused::Expired)));
    assert_eq!(store.confirm(ACCOUNT, &wanted, &given, NOW + 1, passkey.as_ref()), Err(crate::cause!(Refused::Unknown)));
}

#[test]
fn a_confirmation_for_another_record_field_value_or_account_is_refused_and_left_waiting() {
    let store = Challenges::default();
    let passkey = FixturePasskey::new(ACCOUNT);
    let other_account = FixturePasskey::new("synthetic-account-b");
    let wanted = requirement("record:row-1", "state", "Down");
    let issued = store.issue(ACCOUNT, &wanted, NOW).unwrap();
    let given = proof(&passkey, &issued);
    for other in [requirement("record:row-2", "state", "Down"), requirement("record:row-1", "other", "Down"),
        requirement("record:row-1", "state", "Up")] {
        assert_eq!(store.confirm(ACCOUNT, &other, &given, NOW + 1, passkey.as_ref()), Err(crate::cause!(Refused::Mismatch)));
    }
    assert_eq!(store.confirm("synthetic-account-b", &wanted, &given, NOW + 1, other_account.as_ref()), Err(crate::cause!(Refused::Mismatch)));
    // None of those consumed it; the account's own write still confirms.
    assert_eq!(store.confirm(ACCOUNT, &wanted, &given, NOW + 1, passkey.as_ref()), Ok(()));
}

#[test]
fn an_assertion_that_does_not_sign_this_challenge_with_a_verified_passkey_of_the_account_is_refused() {
    let store = Challenges::default();
    let passkey = FixturePasskey::new(ACCOUNT);
    let stranger = FixturePasskey::new(ACCOUNT);
    let wanted = requirement("record:row-1", "state", "Down");
    let issued = store.issue(ACCOUNT, &wanted, NOW).unwrap();
    let decoy = store.issue(ACCOUNT, &requirement("record:row-1", "state", "Up"), NOW).unwrap();
    let refused = |assertion: Value| store.confirm(ACCOUNT, &wanted, &json!({"nonce": issued.nonce, "assertion": assertion}),
        NOW + 1, passkey.as_ref());
    // Another key under the same credential id; the challenge of another write; another origin; no user verification.
    assert_eq!(refused(stranger.assert(&issued.challenge)), Err(crate::cause!(Refused::Unverified)));
    assert_eq!(refused(passkey.assert(&decoy.challenge)), Err(crate::cause!(Refused::Unverified)));
    assert_eq!(refused(passkey.assert_with(&issued.challenge, "https://elsewhere.example.test", 0x05)), Err(crate::cause!(Refused::Unverified)));
    assert_eq!(refused(passkey.assert_with(&issued.challenge, ORIGIN, 0x01)), Err(crate::cause!(Refused::Unverified)));
    // Shapes that carry no confirmation.
    for shape in [json!({}), json!({"nonce": issued.nonce}), json!({"nonce": issued.nonce, "assertion": "x"}),
        json!({"nonce": issued.nonce, "assertion": {}, "extra": 1})] {
        assert!(store.confirm(ACCOUNT, &wanted, &shape, NOW + 1, passkey.as_ref()).is_err());
    }
    // The account without a passkey source confirms nothing.
    assert_eq!(confirm_write("synthetic-account-unregistered", &wanted, Some(&proof(&passkey, &issued))), Err(crate::cause!(Refused::NoPasskeys)));
    assert_eq!(confirm_write(ACCOUNT, &wanted, None), Err(crate::cause!(Refused::Missing)));
    // A counter that does not advance is refused: an assertion signed before a newer one that was kept.
    let again = store.issue(ACCOUNT, &wanted, NOW).unwrap();
    let older = passkey.assert(&again.challenge);
    let newer = passkey.assert(&issued.challenge);
    assert_eq!(refused(newer), Ok(()));
    assert_eq!(store.confirm(ACCOUNT, &wanted, &json!({"nonce": again.nonce, "assertion": older}), NOW + 1, passkey.as_ref()),
        Err(crate::cause!(Refused::Unverified)));
}

fn parsed(raw: Value) -> JsValue {
    crate::ecma_json::parse(raw.to_string().as_bytes(), Default::default()).unwrap()
}
fn model_with(declarations: &[(&str, Value)]) -> Model {
    // The list rule and field kinds an installed tool declares.
    let installed = crate::record_model_policy::list_rule_model();
    let mut model = Model::from_product_data(installed.data(), installed.data()).unwrap();
    for (id, value) in declarations {
        model.declare(&"list".into(), &JsString::from(*id), &parsed(value.clone())).unwrap();
    }
    model
}
fn switches(marked: Value) -> Value {
    json!({"row_type": "switch-row", "fields": [
        {"id": "state", "kind": "choice", "choices": ["Up", "Down"], "needs_person_present_to_set": marked},
        {"id": "note", "kind": "text"}]})
}
const LIST: &str = "list:synthetic-switches";
const ROW_KIND: &str = "record:switch-row";

/// The confirmations a write of `kind` `id` with `value` (none removes) over `old` needs under `model`.
fn needs(model: &Model, id: &str, kind: &str, value: Option<Value>, old: Option<(&str, Value)>) -> Vec<(String, String, String)> {
    let value = value.map(parsed);
    let old = old.map(|(kind, value)| (JsString::from(kind), parsed(value)));
    required(model, model, &JsString::from(id), &JsString::from(kind), value.as_ref(), old.as_ref().map(|(k, v)| (k, v)))
        .unwrap().into_iter().map(|r| (r.record, r.field, r.value)).collect()
}
fn one(record: &str, field: &str, value: &str) -> Vec<(String, String, String)> {
    vec![(record.into(), field.into(), value.into())]
}

#[test]
fn a_row_needs_the_person_only_to_newly_set_a_marked_value() {
    let model = model_with(&[(LIST, switches(json!(["Down"])))]);
    let row = "record:switch-row:1";
    assert_eq!(needs(&model, row, ROW_KIND, Some(json!({"state": "Down"})), None), one(row, "state", "Down"));
    assert_eq!(needs(&model, row, ROW_KIND, Some(json!({"state": "Down"})), Some((ROW_KIND, json!({"state": "Up"})))),
        one(row, "state", "Down"));
    // An unmarked value, another field, a field left as it is, and a removal need nothing.
    assert!(needs(&model, row, ROW_KIND, Some(json!({"state": "Up"})), Some((ROW_KIND, json!({"state": "Down"})))).is_empty());
    assert!(needs(&model, row, ROW_KIND, Some(json!({"state": "Down", "note": "x"})), Some((ROW_KIND, json!({"state": "Down"})))).is_empty());
    assert!(needs(&model, row, ROW_KIND, Some(json!({"note": "x"})), None).is_empty());
    assert!(needs(&model, row, ROW_KIND, None, Some((ROW_KIND, json!({"state": "Down"})))).is_empty());
    // A row of another kind, even with the same field and value, needs nothing.
    assert!(needs(&model, "record:other-row:1", "record:other-row", Some(json!({"state": "Down"})), None).is_empty());
}

#[test]
fn a_second_declaration_without_the_mark_does_not_shadow_it() {
    let model = model_with(&[(LIST, switches(json!(["Down"]))), ("list:synthetic-shadow", switches(json!([])))]);
    assert_eq!(needs(&model, "record:switch-row:1", ROW_KIND, Some(json!({"state": "Down"})), None),
        one("record:switch-row:1", "state", "Down"));
}

#[test]
fn removing_or_narrowing_the_mark_needs_the_person_and_adding_to_it_does_not() {
    let model = model_with(&[(LIST, switches(json!(["Down"])))]);
    let held = switches(json!(["Down"]));
    // Adding to it, or keeping it, needs nothing.
    assert!(needs(&model, LIST, "list", Some(switches(json!(["Down", "Up"]))), Some(("list", held.clone()))).is_empty());
    assert!(needs(&model, LIST, "list", Some(held.clone()), Some(("list", held.clone()))).is_empty());
    let mut no_mark = held.clone();
    no_mark["fields"][0].as_object_mut().unwrap().remove("needs_person_present_to_set");
    let mut renamed = held.clone();
    renamed["fields"][0]["id"] = json!("state-2");
    let mut moved = held.clone();
    moved["row_type"] = json!("switch-row-2");
    for changed in [Some(switches(json!(["Up"]))), Some(switches(json!([]))), Some(no_mark), Some(renamed), Some(moved), None] {
        assert_eq!(needs(&model, LIST, "list", changed.clone(), Some(("list", held.clone()))), one(LIST, "state", "Down"), "{changed:?}");
    }
    // Narrowing a wider mark needs the person for the value it drops only.
    let wide = switches(json!(["Down", "Up"]));
    assert_eq!(needs(&model, LIST, "list", Some(switches(json!(["Up"]))), Some(("list", wide))), one(LIST, "state", "Down"));
}

/// The gate's own Rust source names no product concept: no list id, no row kind, and not the field the first lists
/// mark. The words are assembled here so this test does not name them either.
#[test]
fn the_gates_rust_source_names_no_product_concept() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let sources = ["src/account/person_confirmation.rs", "src/record_write_model.rs",
        "src/local_account/native_command_context/original_mutations.rs"];
    let forbidden: Vec<String> = vec![
        ["ch", "eck"].concat(), ["ru", "le"].concat(), ["list:", "cap"].concat(), ["hook", "-guard"].concat(),
        ["record:", "hook"].concat(), ["Of", "f"].concat(),
    ];
    let field = format!("\"{}\"", ["o", "n"].concat());
    for source in sources {
        let text = std::fs::read_to_string(root.join(source)).unwrap();
        let lines: Vec<&str> = text.lines().filter(|line| {
            line.contains("person_present") || line.contains("PERSON_PRESENT") || line.contains("marks")
                || source.ends_with("person_confirmation.rs")
        }).collect();
        for line in lines {
            let lower = line.to_lowercase();
            for word in &forbidden {
                let word = word.to_lowercase();
                // Whole words only ("checks" in prose about verification is not a type name; see below).
                let hit = lower.match_indices(&word).any(|(at, _)| {
                    let before = lower[..at].chars().next_back();
                    let after = lower[at + word.len()..].chars().next();
                    !before.is_some_and(|c| c.is_alphanumeric() || c == '_')
                        && !after.is_some_and(|c| c.is_alphanumeric() || c == '_')
                });
                assert!(!hit, "{source} names {word:?}: {line}");
            }
            assert!(!line.contains(&field), "{source} names the field {field}: {line}");
        }
    }
}

#[test]
fn a_page_asks_for_a_challenge_and_its_assertion_confirms_the_write() {
    let account = "synthetic-account-page";
    let passkey = FixturePasskey::new(account);
    let _registered = register_passkeys(account, passkey.clone());
    let wanted = requirement("synthetic-offer", "grant", "apply");
    let asked = assertion_request(account, &wanted).unwrap();
    assert_eq!(asked["credential_ids"], json!([CREDENTIAL_ID]));
    assert_eq!(asked["rp_id"], RELYING_PARTY);
    let given = json!({"nonce": asked["nonce"], "assertion": passkey.assert(asked["challenge"].as_str().unwrap())});
    assert_eq!(confirm_write(account, &wanted, Some(&given)), Ok(()));
    assert_eq!(confirm_write(account, &wanted, Some(&given)), Err(crate::cause!(Refused::Unknown)), "one use");
    assert_eq!(assertion_request("synthetic-account-without", &wanted), Err(crate::cause!(Refused::NoPasskeys)));
}
