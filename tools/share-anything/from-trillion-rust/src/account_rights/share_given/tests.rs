//! A share given and read back: the sharer's side here is the real share grant (`Grants::reached`, `Grants::narrow`)
//! over the sharer's records, behind routes this test holds in memory; the recipient's side is the real vault,
//! records shape, routes read and cache. Every prefix, resource and operation comes from the shipped DATA.

use super::*;
use crate::secrets::{open_store, SecretsKey, VaultIdentity};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::{cell::RefCell, collections::BTreeMap};

const RECIPIENT: &str = "recipient-account";
const DOOR: &str = "https://sharer.example";
const PRESET: &str = "show-types-shared:preset-1";

fn receiving() -> &'static Receiving {
    Receiving::shipped().expect("share-given.json given")
}
fn grants() -> &'static Grants {
    Grants::shipped().expect("share-grant.json door_grant")
}
/// A share key as the sharer hands it: the token prefix and 32 random bytes.
fn key(byte: u8) -> String {
    let data: Value = serde_json::from_slice(include_bytes!("../share-grant.json")).unwrap();
    let prefix = data["door_grant"]["token_prefix"].as_str().unwrap();
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode([byte; 32]))
}
fn vault(dir: &tempfile::TempDir) -> Secrets<impl Storage + Send> {
    let root = SecretsKey::new(Zeroizing::new(format!("nm_{}_{}", "d".repeat(64), "b".repeat(64)))).unwrap();
    Secrets::open(open_store(&dir.path().join("held.sqlite")).unwrap(), RECIPIENT, &root, VaultIdentity::new("testhost").unwrap())
        .unwrap()
}

/// The sharer's routes, in memory: their records (the shared preset and its sharing record) and every call it saw.
struct Sharer {
    records: RefCell<BTreeMap<String, Value>>,
    reachable: RefCell<bool>,
    calls: RefCell<Vec<String>>,
}
impl Sharer {
    fn new() -> Self {
        Self { records: RefCell::new(BTreeMap::new()), reachable: RefCell::new(true), calls: RefCell::new(Vec::new()) }
    }
    fn sharing_label(&self) -> String {
        format!("{}{PRESET}", grants().record_prefix())
    }
    /// The admin keeps a preset and shares it with one person's key.
    fn share(&self, key: &str) {
        let mut records = self.records.borrow_mut();
        records.insert(PRESET.to_owned(), json!({"label": "For reviewers", "types": [{"id": "decision"}, {"id": "pursuit"}, {"no": "id"}]}));
        records.insert(self.sharing_label(), json!({"record": PRESET, "people": [{"principal": "someone", "key_blake3": grants().digest(key.as_bytes()).unwrap()}], "changed_at": 1}));
    }
    /// The admin's "stop sharing": the sharing record goes.
    fn stop(&self) {
        self.records.borrow_mut().remove(&self.sharing_label());
    }
}
impl SharerDoor for Sharer {
    fn read(&self, door: &str, resource: &str, operation: &str, input: &Value, bearer: &[u8]) -> Result<DoorAnswer, Refusal> {
        self.calls.borrow_mut().push(format!("{door} {resource} {operation} {input}"));
        if !*self.reachable.borrow() {
            return Err(crate::cause!(Refusal::Unavailable));
        }
        let records = self.records.borrow();
        let sharing: BTreeMap<String, Value> =
            records.iter().filter(|(label, _)| label.starts_with(grants().record_prefix())).map(|(l, v)| (l.clone(), v.clone())).collect();
        match grants().narrow(&grants().reached(&sharing, bearer), resource, operation, input) {
            Ok(labels) => Ok(DoorAnswer::Records(labels.into_iter().filter_map(|label| Some((label.clone(), records.get(&label)?.clone()))).collect())),
            Err(error) => Ok(DoorAnswer::Refused(error.cause())),
        }
    }
}

fn ids(types: &[Value]) -> Vec<&str> {
    types.iter().filter_map(|ty| ty["id"].as_str()).collect()
}

/// The person's own records after their client wrote the given record the receive answered.
fn given_records(record: (String, Value)) -> BTreeMap<String, Value> {
    BTreeMap::from([record])
}

#[test]
fn a_shared_preset_is_read_back_by_its_recipient_and_gone_after_stop_sharing() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault(&dir);
    let sharer = Sharer::new();
    let key = key(7);
    sharer.share(&key);

    let asked = receiving().asked(&json!({"door": DOOR, "label": PRESET, "key": key})).expect("a receive");
    let record = receiving().receive(&vault, &asked.given, asked.key.as_ref().unwrap(), 1_000).unwrap();
    let records = given_records(record);
    let given = receiving().given(&records).unwrap();
    assert_eq!(given, vec![Given { door: DOOR.to_owned(), label: PRESET.to_owned() }]);

    let kept = Kept::default();
    let keep_for = Duration::from_secs(30);
    let start = Instant::now();
    let types = kept.types(receiving(), &vault, &sharer, RECIPIENT, &given, keep_for, start).unwrap();
    assert_eq!(ids(&types), vec!["decision", "pursuit"], "the preset's types, each with an id, are the person's given types");
    // The sharer's routes were asked exactly that one label, as the share grant's read.
    let (resource, operation) = grants().read_call();
    assert_eq!(*sharer.calls.borrow(), vec![format!("{DOOR} {resource} {operation} {}", json!({"selection": {"labels": [PRESET]}}))]);

    // A second read inside read_seconds is the kept one; the sharer's routes are not asked again.
    let again = kept.types(receiving(), &vault, &sharer, RECIPIENT, &given, keep_for, start + Duration::from_secs(5)).unwrap();
    assert_eq!(ids(&again), vec!["decision", "pursuit"]);
    assert_eq!(sharer.calls.borrow().len(), 1);

    // Stop sharing: at the next read (once the kept read is read_seconds old) the preset gives nothing.
    sharer.stop();
    let after = kept.types(receiving(), &vault, &sharer, RECIPIENT, &given, keep_for, start + keep_for).unwrap();
    assert!(after.is_empty(), "the sharer's stop sharing removed it");
    assert_eq!(sharer.calls.borrow().len(), 2);

    // Shared again: read back again.
    sharer.share(&key);
    let back = kept.types(receiving(), &vault, &sharer, RECIPIENT, &given, keep_for, start + keep_for * 2).unwrap();
    assert_eq!(ids(&back), vec!["decision", "pursuit"]);
}

#[test]
fn a_wrong_key_is_refused_by_the_sharers_door() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault(&dir);
    let sharer = Sharer::new();
    sharer.share(&key(7));
    let given = Given { door: DOOR.to_owned(), label: PRESET.to_owned() };
    receiving().receive(&vault, &given, &key(8), 1).unwrap();
    // The sharer's own routes refuse the wrong key for that label.
    let (resource, operation) = grants().read_call();
    let input = json!({"selection": {"labels": [PRESET]}});
    assert_eq!(sharer.read(DOOR, resource, operation, &input, key(8).as_bytes()).unwrap(), DoorAnswer::Refused(crate::cause!()));
    // So the recipient is given nothing by it.
    let types = Kept::default().types(receiving(), &vault, &sharer, RECIPIENT, &[given], Duration::from_secs(30), Instant::now()).unwrap();
    assert!(types.is_empty());
    // A key that is not a share key at all is not even taken.
    assert!(receiving().asked(&json!({"door": DOOR, "label": PRESET, "key": "not-a-share-key"})).is_none());
    assert_eq!(receiving().receive(&vault, &Given { door: DOOR.to_owned(), label: PRESET.to_owned() }, "nope", 1), Err(crate::cause!(Refusal::Input)));
}

#[test]
fn a_failed_read_is_unavailable_never_no_rules() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault(&dir);
    let sharer = Sharer::new();
    sharer.share(&key(7));
    let given = Given { door: DOOR.to_owned(), label: PRESET.to_owned() };
    // A given record whose key the vault does not hold.
    let kept = Kept::default();
    let keep_for = Duration::from_secs(30);
    assert_eq!(kept.types(receiving(), &vault, &sharer, RECIPIENT, std::slice::from_ref(&given), keep_for, Instant::now()), Err(crate::cause!(Refusal::Unavailable)));
    // Sharer routes that cannot be reached; and the failure is not kept, so the next read asks again.
    receiving().receive(&vault, &given, &key(7), 1).unwrap();
    *sharer.reachable.borrow_mut() = false;
    let now = Instant::now();
    assert_eq!(kept.types(receiving(), &vault, &sharer, RECIPIENT, std::slice::from_ref(&given), keep_for, now), Err(crate::cause!(Refusal::Unavailable)));
    *sharer.reachable.borrow_mut() = true;
    assert_eq!(ids(&kept.types(receiving(), &vault, &sharer, RECIPIENT, std::slice::from_ref(&given), keep_for, now).unwrap()), vec!["decision", "pursuit"]);
    // An answer from the sharer's routes that is not a workspace read, or a refusal other than rights, is unavailable too.
    assert_eq!(door_answer(500, b""), Err(crate::cause!(Refusal::Unavailable)));
    assert_eq!(door_answer(200, b"not json"), Err(crate::cause!(Refusal::Unavailable)));
    let other = json!({"result": {"isError": true, "structuredContent": {"code": "original_workspace_source_unavailable"}}});
    assert_eq!(door_answer(200, other.to_string().as_bytes()), Err(crate::cause!(Refusal::Unavailable)));
    // Sharer routes that answer labels they were not asked are not believed.
    let extra = DoorAnswer::Records(BTreeMap::from([("other".to_owned(), json!({"types": [{"id": "x"}]}))]));
    assert_eq!(receiving().types_in(&given, &extra), Err(crate::cause!(Refusal::Unavailable)));
    // A given record that does not read as one, or names another share than its label, is unavailable.
    let (label, mut value) = receiving().record(&given, 1);
    value["label"] = json!("show-types-shared:another");
    assert_eq!(receiving().given(&BTreeMap::from([(label, value)])), Err(crate::cause!(Refusal::Unavailable)));
}

#[test]
fn the_door_answer_is_read_as_the_door_gives_it() {
    let read = json!({"records": {PRESET: {"types": [{"id": "decision"}]}}});
    let ok = json!({"jsonrpc": "2.0", "id": 1, "result": {"isError": false, "structuredContent": {"status": 200, "content_type": "application/json", "text": read.to_string()}}});
    let DoorAnswer::Records(records) = door_answer(200, ok.to_string().as_bytes()).unwrap() else { panic!("records") };
    assert_eq!(records[PRESET]["types"][0]["id"], "decision");
    let refused = json!({"result": {"isError": true, "structuredContent": {"code": "current_workspace_rights_refused", "outcome": "not_started"}}});
    assert_eq!(door_answer(200, refused.to_string().as_bytes()), Ok(DoorAnswer::Refused(crate::cause!())));
    assert_eq!(door_answer(401, b""), Ok(DoorAnswer::Refused(crate::cause!())));
    // The sharer's routes address is https with no path, query or user.
    for bad in ["http://sharer.example", "https://sharer.example/mcp", "https://u@example.com", "https://sharer.example/", "https://sharer.example?x=1", ""] {
        assert!(receiving().asked(&json!({"door": bad, "label": PRESET, "on": false})).is_none(), "{bad}");
    }
    assert!(receiving().asked(&json!({"door": "https://sharer.example:8443", "label": PRESET, "on": false})).is_some());
    assert!(receiving().asked(&json!({"door": DOOR, "label": PRESET, "on": true})).is_none(), "keeping needs a key");
}

#[test]
fn the_key_never_appears_in_a_record_a_file_or_a_debug_output() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault(&dir);
    let sharer = Sharer::new();
    let key = key(9);
    sharer.share(&key);
    let asked = receiving().asked(&json!({"door": DOOR, "label": PRESET, "key": key})).unwrap();
    assert!(!format!("{asked:?}").contains(&key), "Debug of a receive shows no key");
    let (label, record) = receiving().receive(&vault, &asked.given, &key, 1).unwrap();
    assert!(!label.contains(&key) && !record.to_string().contains(&key), "the given record holds no key");
    let kept = Kept::default();
    let given = receiving().given(&BTreeMap::from([(label, record)])).unwrap();
    kept.types(receiving(), &vault, &sharer, RECIPIENT, &given, Duration::from_secs(30), Instant::now()).unwrap();
    assert!(!format!("{kept:?}").contains(&key));
    assert!(!kept.entries.lock().unwrap().keys().any(|name| name.contains(&key)), "the cache is keyed by a digest");
    // The sharer's routes saw the call's resource, operation and input; the key went only as the bearer.
    assert!(!sharer.calls.borrow().iter().any(|call| call.contains(&key)));
    // The vault's files hold it sealed, never as its text.
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        assert!(!bytes.windows(key.len()).any(|window| window == key.as_bytes()), "a file holds the key as text");
    }
    // Forgetting removes it; a read then is unavailable, not empty.
    assert_eq!(receiving().forget(&vault, &asked.given), Ok(true));
    assert_eq!(
        Kept::default().types(receiving(), &vault, &sharer, RECIPIENT, &given, Duration::from_secs(30), Instant::now()),
        Err(crate::cause!(Refusal::Unavailable))
    );
}

#[test]
fn share_refusals_keep_remote_header_and_tool_sources_beside_the_old_classification() {
    let cause = crate::cause!(condition: synthetic_sharer_current_rights_refused);
    let refused = json!({"result":{"isError":true,"structuredContent":{"code":"current_workspace_rights_refused","cause":cause.id(),"outcome":"not_started"}}});
    let DoorAnswer::Refused(from_tool) = door_answer(200, refused.to_string().as_bytes()).unwrap() else { panic!("the original refusal classification") };
    assert_eq!(from_tool, cause);
    let DoorAnswer::Refused(from_header) = door_answer_reported(403, b"", Some(cause.clone())).unwrap() else { panic!("the original HTTP refusal classification") };
    assert_eq!(from_header, cause);
    assert_eq!(door_answer_reported(503, b"", Some(cause.clone())).unwrap_err().cause(), cause);
}
