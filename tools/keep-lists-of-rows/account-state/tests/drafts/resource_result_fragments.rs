//! Draft executable controls for the generic resource result fragment recipe.
//! Account integration must provide the same current transaction, model,
//! logical source, public schema, transformations, and original locale.

use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap},
};
use trillion_local::{
    ecma_json::{self, JsString, Object, Value},
    legacy_records::StoredRecord,
    native_boot::tool_screens::ToolLabelLocale,
    record_sealed::{self, SecretFieldKey},
    record_value::{
        self,
        erasure_owner::{self, ErasureModel},
        CurrentKeys, KeyState, OpenPolicy, Supply,
    },
    resource_result_fragments::{
        self as fragments, CurrentOriginal, InstalledPublicValues, InstalledTransforms,
        OriginalCommand,
    },
    workspace_tool_screens::Failure,
};
use zeroize::Zeroizing;

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object.get(&name.into()),
        _ => None,
    }
}
fn string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => value.to_rust_string().ok(),
        _ => None,
    }
}
fn key_bytes(owner: &str) -> [u8; 32] {
    let mut key = [0u8; 32];
    for (index, byte) in owner.bytes().enumerate() {
        let slot = index % 31;
        key[slot] = key[slot].wrapping_add(byte ^ index as u8);
    }
    key[31] ^= owner.len() as u8;
    key
}

struct Locale;
impl ToolLabelLocale for Locale {
    fn assert_current(&self) -> Result<(), Failure> {
        Ok(())
    }
    fn compare(&self, left: &JsString, right: &JsString) -> Result<Ordering, Failure> {
        Ok(left
            .to_rust_string()
            .map_err(|_| trillion_local::cause!(Failure::Source))?
            .cmp(&right.to_rust_string().map_err(|_| trillion_local::cause!(Failure::Source))?))
    }
}

#[derive(Clone, Default)]
struct Source {
    rows: HashMap<String, (String, Value)>,
    keys: HashMap<String, [u8; 32]>,
}
impl CurrentKeys for Source {
    fn assert_current(&mut self) -> record_value::Result<()> {
        Ok(())
    }
    fn key(&mut self, owner: &str) -> record_value::Result<KeyState> {
        Ok(match self.keys.get(owner) {
            Some(key) => KeyState::Present(SecretFieldKey::from_bytes(Zeroizing::new(*key))),
            None => KeyState::Missing,
        })
    }
}
impl Supply for Source {
    fn stored(&mut self, id: &str) -> record_value::Result<Option<StoredRecord>> {
        Ok(self.rows.get(id).map(|(kind, value)| StoredRecord {
            id: id.into(),
            record_type: kind.clone(),
            sequence: "synthetic".into(),
            value_json: ecma_json::stringify(value, Default::default()).unwrap(),
            meta_json: None,
            protected_key_present: true,
        }))
    }
}
struct Public;
impl InstalledPublicValues for Public {
    fn assert_current(&mut self, _: &OriginalCommand) -> fragments::Result<()> {
        Ok(())
    }
    fn value(&mut self, _: &OriginalCommand, key: &str) -> fragments::Result<Value> {
        Err(if key.is_empty() {
            trillion_local::cause!(fragments::Error::Invalid)
        } else {
            trillion_local::cause!(fragments::Error::Source)
        })
    }
}
struct Transforms;
impl InstalledTransforms for Transforms {
    fn assert_current(&mut self, _: &OriginalCommand) -> fragments::Result<()> {
        Ok(())
    }
    fn transform(&mut self, _: &OriginalCommand, _: &str, _: &Value) -> fragments::Result<Value> {
        Err(trillion_local::cause!(fragments::Error::Source))
    }
}

fn original() -> OriginalCommand {
    OriginalCommand {
        permit_id: "command-1".into(),
        identity: "permit-identity".into(),
        operation: "inspect".into(),
        context: Value::Object(Object::new()),
        state: "working".into(),
        result_receipt: None,
    }
}
struct Journal {
    row: OriginalCommand,
    calls: usize,
    drift_on: Option<usize>,
}
impl Journal {
    fn new(row: OriginalCommand) -> Self {
        Self {
            row,
            calls: 0,
            drift_on: None,
        }
    }
}
impl CurrentOriginal for Journal {
    fn assert_current(&mut self, id: &str) -> fragments::Result<OriginalCommand> {
        self.calls += 1;
        if self.drift_on == Some(self.calls) {
            self.row.context = Value::String("changed".into());
        }
        if id != self.row.permit_id {
            return Err(trillion_local::cause!(fragments::Error::Changed));
        }
        Ok(self.row.clone())
    }
}
fn model() -> ErasureModel {
    let model = ecma_json::parse(
        br#"{"kinds":[{"type":"message","erasable":[["body","text"]]},{"type":"resource-command-result","erasable":[["value"]],"erasable_key":"source_record"}]}"#,
        Default::default(),
    )
    .unwrap();
    ErasureModel::from_model(&model).unwrap()
}
fn handoff_model() -> ErasureModel {
    let model = ecma_json::parse(
        br#"{"kinds":[{"type":"message","erasable":[["body","text"]]},{"type":"agent-handoff","erasable":[["said"]],"erasable_key":["input","arrived","message_id"]},{"type":"resource-command-result","erasable":[["value"]],"erasable_key":"source_record"}]}"#,
        Default::default(),
    ).unwrap();
    ErasureModel::from_model(&model).unwrap()
}
fn handoff_row(id: &str, parent: &str, include_words: bool) -> Value {
    let mut arrived = Object::new();
    arrived.insert("message_id".into(), Value::String(parent.into()));
    let mut input = Object::new();
    input.insert("arrived".into(), Value::Object(arrived));
    let mut row = Object::new();
    row.insert("input".into(), Value::Object(input));
    if include_words {
        let key = SecretFieldKey::from_bytes(Zeroizing::new(key_bytes("message-1")));
        row.insert(
            "said".into(),
            Value::Object(
                record_sealed::prepare::seal(
                    &key,
                    id,
                    &JsString::from("said"),
                    &Value::String("inherited words".into()),
                    Some("message-1"),
                    Default::default(),
                )
                .unwrap(),
            ),
        );
    }
    Value::Object(row)
}

fn sealed_text() -> Value {
    sealed_text_for("message-1", "captured words")
}
fn sealed_text_for(id: &str, text: &str) -> Value {
    let key = SecretFieldKey::from_bytes(Zeroizing::new(key_bytes(id)));
    Value::Object(
        record_sealed::prepare::seal(
            &key,
            id,
            &JsString::from("body.text"),
            &Value::String(text.into()),
            None,
            Default::default(),
        )
        .unwrap(),
    )
}
fn source_fixture() -> Source {
    let mut body = Object::new();
    body.insert("text".into(), sealed_text());
    let mut value = Object::new();
    value.insert("body".into(), Value::Object(body));
    let mut rows = HashMap::from([("message-1".into(), ("message".into(), Value::Object(value)))]);
    for (id, text) in [("𐀀", "supplementary"), ("\u{e000}", "bmp-private")] {
        let mut body = Object::new();
        body.insert("text".into(), sealed_text_for(id, text));
        let mut record = Object::new();
        record.insert("body".into(), Value::Object(body));
        rows.insert(id.into(), ("message".into(), Value::Object(record)));
    }
    let mut keys = HashMap::new();
    for id in rows.keys() {
        keys.insert(id.clone(), key_bytes(id));
    }
    Source { rows, keys }
}
fn source_recipe(record: &str) -> Value {
    let mut selector = Object::new();
    selector.insert("record".into(), Value::String(record.into()));
    selector.insert(
        "path".into(),
        Value::Array(vec![
            Value::String("body".into()),
            Value::String("text".into()),
        ]),
    );
    let mut source = Object::new();
    source.insert("$source".into(), Value::Object(selector));
    Value::Object(source)
}
fn large_source_fixture(text: &str) -> Source {
    let mut source = source_fixture();
    let mut body = Object::new();
    body.insert("text".into(), sealed_text_for("message-1", text));
    let mut record = Object::new();
    record.insert("body".into(), Value::Object(body));
    source.rows.insert(
        "message-1".into(),
        ("message".into(), Value::Object(record)),
    );
    source
}
fn policy() -> OpenPolicy {
    OpenPolicy::new(vec![vec!["body".into(), "text".into()]]).unwrap()
}

fn persist_drafts(
    source: &mut Source,
    rows: Vec<fragments::RecordDraft>,
) -> (
    fragments::PersistedManifest,
    BTreeMap<String, fragments::PersistedFragment>,
) {
    for draft in rows {
        let raw = field(&draft.value, "value").unwrap().clone();
        let owner = field(&draft.value, "source_record")
            .and_then(string)
            .unwrap_or_else(|| draft.id.clone());
        let key = SecretFieldKey::from_bytes(Zeroizing::new(key_bytes(&owner)));
        let sealed = Value::Object(
            record_sealed::prepare::seal(
                &key,
                &draft.id,
                &JsString::from("value"),
                &raw,
                (owner != draft.id).then_some(owner.as_str()),
                Default::default(),
            )
            .unwrap(),
        );
        source.keys.insert(owner.clone(), key_bytes(&owner));
        let mut stored = Object::new();
        if owner != draft.id {
            stored.insert("source_record".into(), Value::String(owner));
        }
        stored.insert("value".into(), sealed);
        source
            .rows
            .insert(draft.id, (draft.record_type, Value::Object(stored)));
    }
    let manifest_id = "resource-command-result:command-1";
    let manifest = record_value::read(manifest_id, source, &policy(), Default::default())
        .unwrap()
        .unwrap();
    let manifest_payload = field(field(manifest.value(), "value").unwrap(), "fragmented")
        .unwrap()
        .clone();
    let mut fragments = BTreeMap::new();
    let fragment_ids: Vec<_> = source
        .rows
        .iter()
        .filter(|(id, (kind, _))| {
            id.starts_with("resource-command-result:")
                && id.as_str() != manifest_id
                && kind == "resource-command-result"
        })
        .map(|(id, (kind, _))| (id.clone(), kind.clone()))
        .collect();
    for (id, kind) in fragment_ids {
        let logical = record_value::read(&id, source, &policy(), Default::default())
            .unwrap()
            .unwrap();
        let root = logical.value();
        let owner = string(field(root, "source_record").unwrap()).unwrap();
        let payload = field(
            field(field(root, "value").unwrap(), "fragment").unwrap(),
            "value",
        )
        .unwrap()
        .clone();
        fragments.insert(
            id,
            fragments::PersistedFragment {
                record_type: kind,
                erased: false,
                source_record: Some(owner),
                value: payload,
            },
        );
    }
    (
        fragments::PersistedManifest {
            record_type: manifest.record_type().into(),
            erased: false,
            source_record: None,
            fragmented: manifest_payload,
        },
        fragments,
    )
}

#[test]
fn arbitrary_private_recipe_string_is_refused_before_any_source_read() {
    let mut source = Source::default();
    let mut plans = Object::new();
    plans.insert(
        "result".into(),
        Value::String("private words must not be literal".into()),
    );
    plans.insert("state".into(), Value::Object(Object::new()));
    let mut public = Public;
    let mut transforms = Transforms;
    let mut journal = Journal::new(original());
    let error = fragments::prepare(
        "command-1",
        &mut journal,
        &Value::String("private words must not be literal".into()),
        &Value::Object(Object::new()),
        &Value::Object(plans),
        &[],
        &mut source,
        &mut public,
        &mut transforms,
        &model(),
        &OpenPolicy::new(Vec::new()).unwrap(),
        &Locale,
    )
    .unwrap_err();
    assert!(matches!(error, fragments::Error::Invalid(_)));
}

#[test]
fn recipe_requires_both_exact_result_and_state_slots() {
    let mut source = Source::default();
    let mut plans = Object::new();
    plans.insert("result".into(), Value::Object(Object::new()));
    let mut public = Public;
    let mut transforms = Transforms;
    let mut journal = Journal::new(original());
    let error = fragments::prepare(
        "command-1",
        &mut journal,
        &Value::Object(Object::new()),
        &Value::Object(Object::new()),
        &Value::Object(plans),
        &[],
        &mut source,
        &mut public,
        &mut transforms,
        &model(),
        &OpenPolicy::new(Vec::new()).unwrap(),
        &Locale,
    )
    .unwrap_err();
    assert!(matches!(error, fragments::Error::Invalid(_)));
}

#[test]
fn private_values_are_redacted_from_command_debug_output() {
    let mut command = original();
    command.context = Value::String("sensitive-context".into());
    let rendered = format!("{command:?}");
    assert!(!rendered.contains("sensitive-context"));
    assert!(rendered.contains("redacted"));
}

#[test]
fn authentic_sealed_source_is_fragmented_and_result_and_state_both_match() {
    let mut source = source_fixture();
    let mut public = Public;
    let mut transforms = Transforms;
    let mut result = Object::new();
    result.insert("$source".into(), {
        let mut selector = Object::new();
        selector.insert("record".into(), "message-1".into());
        selector.insert(
            "path".into(),
            Value::Array(vec!["body".into(), "text".into()]),
        );
        Value::Object(selector)
    });
    let mut result_recipe = Object::new();
    result_recipe.insert("answer".into(), Value::Object(result));
    let mut plans = Object::new();
    plans.insert("result".into(), Value::Object(result_recipe));
    plans.insert("state".into(), Value::Object(Object::new()));
    let mut expected = Object::new();
    expected.insert("answer".into(), "captured words".into());
    let mut journal = Journal::new(original());
    let prepared = fragments::prepare(
        "command-1",
        &mut journal,
        &Value::Object(expected.clone()),
        &Value::Object(Object::new()),
        &Value::Object(plans),
        &["message-1".into()],
        &mut source,
        &mut public,
        &mut transforms,
        &model(),
        &policy(),
        &Locale,
    )
    .unwrap();
    assert_eq!(prepared.writes.len(), 1);
    assert_eq!(prepared.manifest.source_records, ["message-1"]);
    assert!(!format!("{:?}", prepared).contains("captured words"));

    let (persisted, persisted_fragments) = persist_drafts(&mut source, prepared.record_drafts());
    let mut journal = Journal::new(original());
    let pair = fragments::read_pair(
        "command-1",
        &mut journal,
        &persisted,
        &persisted_fragments,
        &mut source,
        &mut public,
        &mut transforms,
        &model(),
        &policy(),
        &Locale,
    )
    .unwrap();
    assert_eq!(pair.result, Value::Object(expected));
    assert_eq!(pair.state, Value::Object(Object::new()));
    assert!(pair.output_roots.iter().any(|root| root == "message-1"));

    let mut borrowed_manifest = source.clone();
    let manifest_row = borrowed_manifest
        .rows
        .get_mut("resource-command-result:command-1")
        .unwrap();
    if let Value::Object(value) = &mut manifest_row.1 {
        value.insert("source_record".into(), Value::String("donor".into()));
    }
    let mut journal = Journal::new(original());
    assert!(fragments::read_pair(
        "command-1",
        &mut journal,
        &persisted,
        &persisted_fragments,
        &mut borrowed_manifest,
        &mut public,
        &mut transforms,
        &model(),
        &policy(),
        &Locale,
    )
    .is_err());

    let mut wrong_fragment_owner = persisted_fragments.clone();
    let fragment = wrong_fragment_owner.values_mut().next().unwrap();
    fragment.source_record = Some("wrong-owner".into());
    let mut journal = Journal::new(original());
    assert!(matches!(fragments::read_pair(
            "command-1",
            &mut journal,
            &persisted,
            &wrong_fragment_owner,
            &mut source.clone(),
            &mut public,
            &mut transforms,
            &model(),
            &policy(),
            &Locale,
        )
        .unwrap_err(), fragments::Error::Erased(_)));

    let mut borrowed_fragment = source.clone();
    let fragment_id = persisted_fragments.keys().next().unwrap().clone();
    if let Value::Object(value) = &mut borrowed_fragment.rows.get_mut(&fragment_id).unwrap().1 {
        value.insert("source_record".into(), Value::String("donor".into()));
    }
    let mut journal = Journal::new(original());
    assert!(fragments::read_pair(
        "command-1",
        &mut journal,
        &persisted,
        &persisted_fragments,
        &mut borrowed_fragment,
        &mut public,
        &mut transforms,
        &model(),
        &policy(),
        &Locale,
    )
    .is_err());

    let mut wrong_key = source.clone();
    wrong_key
        .keys
        .insert("message-1".into(), key_bytes("wrong-owner"));
    assert!(
        record_value::read("message-1", &mut wrong_key, &policy(), Default::default()).is_err()
    );

    let mut erased = source.clone();
    erased.keys.remove("message-1");
    let manifest_owner = erasure_owner::erasure_owner_of_with_model(
        "resource-command-result:command-1",
        &mut erased,
        &model(),
    )
    .unwrap();
    assert_eq!(
        manifest_owner.owner.as_deref(),
        Some("resource-command-result:command-1")
    );
    assert!(record_value::read(
        "resource-command-result:command-1",
        &mut erased,
        &policy(),
        Default::default(),
    )
    .unwrap()
    .is_some());
    let mut journal = Journal::new(original());
    assert!(fragments::read_pair(
        "command-1",
        &mut journal,
        &persisted,
        &persisted_fragments,
        &mut erased,
        &mut public,
        &mut transforms,
        &model(),
        &policy(),
        &Locale,
    )
    .is_err());
    let mut journal = Journal::new(original());
    assert!(matches!(
        fragments::read_pair(
            "command-1",
            &mut journal,
            &persisted,
            &persisted_fragments,
            &mut erased,
            &mut public,
            &mut transforms,
            &model(),
            &policy(),
            &Locale,
        ),
        Err(fragments::Error::Erased(_) | fragments::Error::Source(_)),
    ));

    let mut changed = source.clone();
    let mut replacement_body = Object::new();
    replacement_body.insert("text".into(), Value::String("changed words".into()));
    let mut replacement = Object::new();
    replacement.insert("body".into(), Value::Object(replacement_body));
    changed.rows.insert(
        "message-1".into(),
        ("message".into(), Value::Object(replacement)),
    );
    let mut journal = Journal::new(original());
    assert!(fragments::read_pair(
        "command-1",
        &mut journal,
        &persisted,
        &persisted_fragments,
        &mut changed,
        &mut public,
        &mut transforms,
        &model(),
        &policy(),
        &Locale,
    )
    .is_err());

    // A committed command without its protected result receipt is not a valid
    // source response even though its exact fragments are still available.
    journal.row.state = "committed".into();
    assert!(matches!(fragments::read_pair(
            "command-1",
            &mut journal,
            &persisted,
            &persisted_fragments,
            &mut source,
            &mut public,
            &mut transforms,
            &model(),
            &policy(),
            &Locale,
        )
        .unwrap_err(), fragments::Error::Erased(_)));
    let mut receipt = Object::new();
    receipt.insert("result_ref".into(), Value::String("wrong-command".into()));
    receipt.insert(
        "result_identity".into(),
        Value::String(prepared.manifest.result_identity.clone().into()),
    );
    journal.row.result_receipt = Some(Value::Object(receipt));
    assert!(matches!(fragments::read_pair(
            "command-1",
            &mut journal,
            &persisted,
            &persisted_fragments,
            &mut source,
            &mut public,
            &mut transforms,
            &model(),
            &policy(),
            &Locale,
        )
        .unwrap_err(), fragments::Error::Changed(_)));
    let mut receipt = Object::new();
    receipt.insert("result_ref".into(), Value::String("command-1".into()));
    receipt.insert(
        "result_identity".into(),
        Value::String(prepared.manifest.result_identity.clone().into()),
    );
    journal.row.result_receipt = Some(Value::Object(receipt));
    assert!(fragments::read_pair(
        "command-1",
        &mut journal,
        &persisted,
        &persisted_fragments,
        &mut source,
        &mut public,
        &mut transforms,
        &model(),
        &policy(),
        &Locale,
    )
    .is_ok());
}

#[test]
fn original_command_drift_between_entry_and_return_refuses_preparation() {
    let mut source = Source::default();
    let mut public = Public;
    let mut transforms = Transforms;
    let mut journal = Journal::new(original());
    journal.drift_on = Some(2);
    let plans = {
        let mut value = Object::new();
        value.insert("result".into(), Value::Object(Object::new()));
        value.insert("state".into(), Value::Object(Object::new()));
        Value::Object(value)
    };
    assert!(matches!(fragments::prepare(
            "command-1",
            &mut journal,
            &Value::Object(Object::new()),
            &Value::Object(Object::new()),
            &plans,
            &[],
            &mut source,
            &mut public,
            &mut transforms,
            &model(),
            &policy(),
            &Locale,
        )
        .unwrap_err(), fragments::Error::Changed(_)));
}

#[test]
fn declared_source_ids_follow_javascript_utf16_sort_order() {
    let mut source = source_fixture();
    let mut result = Object::new();
    result.insert("bmp".into(), source_recipe("\u{e000}"));
    result.insert("supplementary".into(), source_recipe("𐀀"));
    let mut plans = Object::new();
    plans.insert("result".into(), Value::Object(result));
    plans.insert("state".into(), Value::Object(Object::new()));
    let mut expected = Object::new();
    expected.insert("bmp".into(), Value::String("bmp-private".into()));
    expected.insert(
        "supplementary".into(),
        Value::String("supplementary".into()),
    );
    let mut journal = Journal::new(original());
    let mut public = Public;
    let mut transforms = Transforms;
    let prepared = fragments::prepare(
        "command-1",
        &mut journal,
        &Value::Object(expected),
        &Value::Object(Object::new()),
        &Value::Object(plans),
        &["\u{e000}".into(), "𐀀".into()],
        &mut source,
        &mut public,
        &mut transforms,
        &model(),
        &policy(),
        &Locale,
    )
    .unwrap();
    assert_eq!(prepared.manifest.source_records, ["𐀀", "\u{e000}"]);
}

#[test]
fn aggregate_operation_bytes_refuse_repeated_overlapping_source_reads() {
    let large = "x".repeat(900_000);
    let mut source = large_source_fixture(&large);
    let mut plans = Object::new();
    let mut result = Object::new();
    result.insert("answer".into(), source_recipe("message-1"));
    plans.insert("result".into(), Value::Object(result));
    plans.insert("state".into(), Value::Object(Object::new()));
    let mut expected = Object::new();
    expected.insert("answer".into(), Value::String(large.clone().into()));
    let mut journal = Journal::new(original());
    let mut public = Public;
    let mut transforms = Transforms;
    assert!(
        fragments::prepare(
            "command-1",
            &mut journal,
            &Value::Object(expected),
            &Value::Object(Object::new()),
            &Value::Object(plans),
            &["message-1".into()],
            &mut source,
            &mut public,
            &mut transforms,
            &model(),
            &policy(),
            &Locale,
        )
        .is_ok(),
        "one individually bounded source slice fits the operation budget"
    );

    let mut source = large_source_fixture(&large);
    let mut result = Object::new();
    result.insert("first".into(), source_recipe("message-1"));
    result.insert("second".into(), source_recipe("message-1"));
    let mut plans = Object::new();
    plans.insert("result".into(), Value::Object(result));
    plans.insert("state".into(), Value::Object(Object::new()));
    let mut expected = Object::new();
    expected.insert("first".into(), Value::String(large.clone().into()));
    expected.insert("second".into(), Value::String(large.into()));
    let mut journal = Journal::new(original());
    let mut public = Public;
    let mut transforms = Transforms;
    assert!(matches!(fragments::prepare(
            "command-1",
            &mut journal,
            &Value::Object(expected),
            &Value::Object(Object::new()),
            &Value::Object(plans),
            &["message-1".into()],
            &mut source,
            &mut public,
            &mut transforms,
            &model(),
            &policy(),
            &Locale,
        )
        .unwrap_err(), fragments::Error::Bounds(_)));
}

#[test]
fn aggregate_input_depth_and_locale_comparison_limits_refuse() {
    let oversized = Value::String("x".repeat(16 * 1024 * 1024 + 1).into());
    let mut plans = Object::new();
    plans.insert("result".into(), Value::Object(Object::new()));
    plans.insert("state".into(), Value::Object(Object::new()));
    let mut source = Source::default();
    let mut public = Public;
    let mut transforms = Transforms;
    let mut journal = Journal::new(original());
    assert!(matches!(fragments::prepare(
            "command-1",
            &mut journal,
            &oversized,
            &Value::Object(Object::new()),
            &Value::Object(plans),
            &[],
            &mut source,
            &mut public,
            &mut transforms,
            &model(),
            &policy(),
            &Locale,
        )
        .unwrap_err(), fragments::Error::Bounds(_)));

    let mut nested = Value::Bool(true);
    for _ in 0..130 {
        nested = Value::Array(vec![nested]);
    }
    let mut plans = Object::new();
    plans.insert("result".into(), Value::Object(Object::new()));
    plans.insert("state".into(), Value::Object(Object::new()));
    let mut journal = Journal::new(original());
    assert!(matches!(fragments::prepare(
            "command-1",
            &mut journal,
            &nested,
            &Value::Object(Object::new()),
            &Value::Object(plans),
            &[],
            &mut source,
            &mut public,
            &mut transforms,
            &model(),
            &policy(),
            &Locale,
        )
        .unwrap_err(), fragments::Error::Bounds(_)));

    let mut object = Object::new();
    for index in 0..7_000 {
        object.insert(format!("field_{index:05}").into(), Value::Bool(true));
    }
    let mut plans = Object::new();
    plans.insert("result".into(), Value::Object(object.clone()));
    plans.insert("state".into(), Value::Object(Object::new()));
    let mut journal = Journal::new(original());
    assert!(matches!(fragments::prepare(
            "command-1",
            &mut journal,
            &Value::Object(object),
            &Value::Object(Object::new()),
            &Value::Object(plans),
            &[],
            &mut source,
            &mut public,
            &mut transforms,
            &model(),
            &policy(),
            &Locale,
        )
        .unwrap_err(), fragments::Error::Bounds(_)));
}

#[test]
fn same_endpoint_owner_path_rebind_invalidates_a_prepared_fragment_pair() {
    let mut source = source_fixture();
    source.rows.insert(
        "handoff-mid".into(),
        (
            "agent-handoff".into(),
            handoff_row("handoff-mid", "message-1", true),
        ),
    );
    source.rows.insert(
        "handoff-1".into(),
        (
            "agent-handoff".into(),
            handoff_row("handoff-1", "handoff-mid", true),
        ),
    );
    source
        .keys
        .insert("handoff-mid".into(), key_bytes("handoff-mid"));
    source
        .keys
        .insert("handoff-1".into(), key_bytes("handoff-1"));
    let mut result = Object::new();
    result.insert("answer".into(), source_recipe("handoff-1"));
    let mut plans = Object::new();
    plans.insert("result".into(), Value::Object(result));
    plans.insert("state".into(), Value::Object(Object::new()));
    let mut expected = Object::new();
    expected.insert("answer".into(), Value::String("inherited words".into()));
    let mut journal = Journal::new(original());
    let mut public = Public;
    let mut transforms = Transforms;
    let prepared = fragments::prepare(
        "command-1",
        &mut journal,
        &Value::Object(expected),
        &Value::Object(Object::new()),
        &Value::Object(plans),
        &["handoff-1".into()],
        &mut source,
        &mut public,
        &mut transforms,
        &handoff_model(),
        &policy(),
        &Locale,
    )
    .unwrap();
    let (persisted, persisted_fragments) = persist_drafts(&mut source, prepared.record_drafts());
    // Rebind through a different intermediate row while retaining message-1
    // as both the sealed physical owner and final live key owner.
    source.rows.insert(
        "handoff-other".into(),
        (
            "agent-handoff".into(),
            handoff_row("handoff-other", "message-1", false),
        ),
    );
    source
        .keys
        .insert("handoff-other".into(), key_bytes("handoff-other"));
    source.rows.insert(
        "handoff-1".into(),
        (
            "agent-handoff".into(),
            handoff_row("handoff-1", "handoff-other", true),
        ),
    );
    let mut journal = Journal::new(original());
    assert!(fragments::read_pair(
        "command-1",
        &mut journal,
        &persisted,
        &persisted_fragments,
        &mut source,
        &mut public,
        &mut transforms,
        &handoff_model(),
        &policy(),
        &Locale,
    )
    .is_err());
}
