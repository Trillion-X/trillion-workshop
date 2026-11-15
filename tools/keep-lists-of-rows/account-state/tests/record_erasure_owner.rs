//! Draft source controls for canonical inherited erasure ownership.
//! This integration target imports the real library module and source traits.

use std::collections::HashMap;
use trillion_local::{
    ecma_json::{self, JsString, Object, Value},
    legacy_records::StoredRecord,
    record_sealed::{self, SecretFieldKey},
    record_value::{
        erasure_owner::{erasure_owner_of_with_model, ErasureModel, OwnerError},
        CurrentKeys, KeyState, Supply,
    },
};
use zeroize::Zeroizing;

#[derive(Clone, Copy)]
enum KeyFact {
    Present,
    Missing,
    Erased,
}
#[derive(Default)]
struct Fixture {
    rows: HashMap<String, (String, String)>,
    keys: HashMap<String, KeyFact>,
}
impl Fixture {
    fn add(&mut self, id: &str, kind: &str, value: Value) {
        self.rows.insert(
            id.to_owned(),
            (
                kind.to_owned(),
                ecma_json::stringify(&value, Default::default()).unwrap(),
            ),
        );
    }
    fn key(&mut self, id: &str, fact: KeyFact) {
        self.keys.insert(id.to_owned(), fact);
    }
}
impl CurrentKeys for Fixture {
    fn assert_current(&mut self) -> trillion_local::record_value::Result<()> {
        Ok(())
    }
    fn key(&mut self, owner: &str) -> trillion_local::record_value::Result<KeyState> {
        Ok(
            match self.keys.get(owner).copied().unwrap_or(KeyFact::Missing) {
                KeyFact::Present => {
                    KeyState::Present(SecretFieldKey::from_bytes(Zeroizing::new([0x39; 32])))
                }
                KeyFact::Missing => KeyState::Missing,
                KeyFact::Erased => KeyState::Erased,
            },
        )
    }
}
impl Supply for Fixture {
    fn stored(&mut self, id: &str) -> trillion_local::record_value::Result<Option<StoredRecord>> {
        Ok(self.rows.get(id).map(|(kind, value)| StoredRecord {
            id: id.to_owned(),
            record_type: kind.clone(),
            sequence: "synthetic-sequence".to_owned(),
            value_json: value.clone(),
            meta_json: None,
            protected_key_present: false,
        }))
    }
}

fn sealed(record_id: &str, owner: &str, field: &str) -> Value {
    let key = SecretFieldKey::from_bytes(Zeroizing::new([0x39; 32]));
    let plaintext = Value::String(JsString::from("synthetic-secret"));
    let key_owner = (owner != record_id).then_some(owner);
    Value::Object(
        record_sealed::prepare::seal(
            &key,
            record_id,
            &JsString::from(field),
            &plaintext,
            key_owner,
            Default::default(),
        )
        .unwrap(),
    )
}
fn handoff(id: &str, inherited: &str, physical: &str, second_owner: Option<&str>) -> Value {
    let mut arrived = Object::new();
    arrived.insert("message_id".into(), Value::String(inherited.into()));
    let mut input = Object::new();
    input.insert("arrived".into(), Value::Object(arrived));
    let mut value = Object::new();
    value.insert("input".into(), Value::Object(input));
    value.insert("said".into(), sealed(id, physical, "said"));
    value.insert(
        "asked".into(),
        sealed(id, second_owner.unwrap_or(physical), "asked"),
    );
    Value::Object(value)
}
fn message(id: &str) -> Value {
    let mut value = Object::new();
    value.insert("text".into(), sealed(id, id, "text"));
    Value::Object(value)
}

fn custom_record(id: &str, owner: &str) -> Value {
    let mut parent = Object::new();
    parent.insert("id".into(), Value::String(owner.into()));
    let mut value = Object::new();
    value.insert("parent".into(), Value::Object(parent));
    value.insert("secret".into(), sealed(id, owner, "secret"));
    Value::Object(value)
}
fn custom_terminal(id: &str) -> Value {
    let mut value = Object::new();
    value.insert("secret".into(), sealed(id, id, "secret"));
    Value::Object(value)
}
fn supplied_model() -> Value {
    ecma_json::parse(
        br#"{"kinds":[{"type":"custom-record","erasable":["secret"],"erasable_key":["parent","id"]},{"type":"custom-terminal","erasable":["secret"]}]}"#,
        Default::default(),
    )
    .unwrap()
}

/// The erasure model the installed tools give: two tools' rows, each keeping its own kind (a job handed to an
/// AI, and a message), joined the way an account's model is (record_model_policy `Installed::from_rows`).
fn installed_model() -> ErasureModel {
    let handoff = serde_json::json!({"type": "agent-handoff", "erasable": ["job", "said", "asked", ["input", "said"]],
        "erasable_key": ["input", "arrived", "message_id"], "erase_with": [{"field": "result_record", "type": "agent-handoff-result"},
        {"field": "corrections_record", "type": "agent-handoff-result"}, {"field": ["input", "arrived", "message_id"], "type": "message"}]});
    let message = serde_json::json!({"type": "message", "parts": [{"role": "about", "path": ["about"], "each": ["id"], "role_from": ["kind"]}],
        "erasable": ["text"], "erase_with": [{"field": "corrected_from", "type": "message"}, {"type": "agent-handoff", "index": "message"}]});
    let rows = [serde_json::json!({"id": "tool:hand", "record_model": {"kinds": [handoff]}}),
        serde_json::json!({"id": "tool:talk", "record_model": {"kinds": [message]}})];
    let installed = trillion_local::record_model_policy::Installed::from_rows(&rows, true).unwrap();
    ErasureModel::from_model(installed.data()).unwrap()
}

#[test]
fn authentic_sealed_marker_keeps_physical_owner_and_full_same_endpoint_path() {
    let mut source = Fixture::default();
    source.add(
        "handoff-1",
        "agent-handoff",
        handoff("handoff-1", "message-1", "message-1", None),
    );
    source.add("message-1", "message", message("message-1"));
    source.key("message-1", KeyFact::Present);

    let answer = erasure_owner_of_with_model("handoff-1", &mut source, &installed_model()).unwrap();
    assert_eq!(answer.physical_owner.as_deref(), Some("message-1"));
    assert_eq!(answer.owner.as_deref(), Some("message-1"));
    assert_eq!(answer.visited, ["handoff-1", "message-1"]);
    assert!(source.rows["handoff-1"].1.contains("\\u0000sealed"));
}

#[test]
fn supplied_model_drives_pure_path_query_physical_discovery_and_inheritance() {
    let parsed = ErasureModel::from_model(&supplied_model()).unwrap();
    assert_eq!(parsed.erasable_fields("custom-record").len(), 1);
    assert!(parsed.erasable_fields("unknown-kind").is_empty());
    let installed = installed_model();
    assert!(installed.erasable_fields("custom-record").is_empty());

    let mut source = Fixture::default();
    source.add(
        "custom-row",
        "custom-record",
        custom_record("custom-row", "custom-owner"),
    );
    source.add(
        "custom-owner",
        "custom-terminal",
        custom_terminal("custom-owner"),
    );
    source.key("custom-owner", KeyFact::Present);

    let answer = erasure_owner_of_with_model("custom-row", &mut source, &parsed).unwrap();
    assert_eq!(answer.physical_owner.as_deref(), Some("custom-owner"));
    assert_eq!(answer.owner.as_deref(), Some("custom-owner"));
    assert_eq!(answer.visited, ["custom-row", "custom-owner"]);
}

#[test]
fn physical_sealed_owner_is_distinct_from_rebound_current_inheritance_path() {
    let mut source = Fixture::default();
    source.add(
        "handoff-2",
        "agent-handoff",
        handoff("handoff-2", "message-current", "message-original", None),
    );
    source.add("message-current", "message", message("message-current"));
    source.key("message-current", KeyFact::Present);
    // The original sealed owner remains independently keyable even though the
    // current model path now names a different message.
    source.key("message-original", KeyFact::Present);

    let answer = erasure_owner_of_with_model("handoff-2", &mut source, &installed_model()).unwrap();
    assert_eq!(answer.physical_owner.as_deref(), Some("message-original"));
    assert_eq!(answer.owner.as_deref(), Some("message-original"));
    assert_eq!(answer.visited, ["handoff-2", "message-current"]);
}

#[test]
fn erased_inherited_owner_returns_no_available_physical_owner() {
    let mut source = Fixture::default();
    source.add(
        "handoff-erased",
        "agent-handoff",
        handoff("handoff-erased", "message-gone", "message-gone", None),
    );
    source.add("message-gone", "message", message("message-gone"));
    source.key("message-gone", KeyFact::Erased);

    let answer = erasure_owner_of_with_model("handoff-erased", &mut source, &installed_model()).unwrap();
    assert_eq!(answer.physical_owner.as_deref(), Some("message-gone"));
    assert_eq!(answer.owner, None);
    assert_eq!(answer.visited, ["handoff-erased", "message-gone"]);
}

#[test]
fn two_distinct_sealed_field_owners_refuse() {
    let mut source = Fixture::default();
    source.add(
        "handoff-split",
        "agent-handoff",
        handoff(
            "handoff-split",
            "message-one",
            "message-one",
            Some("message-two"),
        ),
    );
    assert_eq!(
        erasure_owner_of_with_model("handoff-split", &mut source, &installed_model()).unwrap_err(),
        trillion_local::cause!(OwnerError::DistinctPhysicalOwners)
    );
}

#[test]
fn inheritance_cycle_and_sixty_fifth_step_refuse() {
    let mut cycle = Fixture::default();
    cycle.add(
        "handoff-a",
        "agent-handoff",
        handoff("handoff-a", "handoff-b", "handoff-a", None),
    );
    cycle.add(
        "handoff-b",
        "agent-handoff",
        handoff("handoff-b", "handoff-a", "handoff-b", None),
    );
    assert_eq!(
        erasure_owner_of_with_model("handoff-a", &mut cycle, &installed_model()).unwrap_err(),
        trillion_local::cause!(OwnerError::Cycle)
    );

    let mut long = Fixture::default();
    for index in 0..65 {
        let id = format!("handoff-{index}");
        let next = format!("handoff-{}", index + 1);
        long.add(&id, "agent-handoff", handoff(&id, &next, &id, None));
    }
    assert_eq!(
        erasure_owner_of_with_model("handoff-0", &mut long, &installed_model()).unwrap_err(),
        trillion_local::cause!(OwnerError::Depth)
    );
}
