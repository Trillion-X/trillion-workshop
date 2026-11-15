//! Native-owned executable controls after module mounting.
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{AeadInPlace, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use trillion_local::{
    ecma_json::{self, JsString, Object, Value},
    legacy_records::StoredRecord,
    record_model_policy::{self, CurrentRecordModel, Error as ModelError},
    record_sealed::{self, SecretFieldKey},
    record_value::{self, CurrentKeys, Error as ValueError, KeyState, Limits, Supply},
};
use zeroize::Zeroizing;

fn json(raw: &str) -> Value {
    ecma_json::parse(raw.as_bytes(), ecma_json::Limits::default()).unwrap()
}
fn encoded(value: &Value) -> String {
    ecma_json::stringify(value, ecma_json::Limits::default()).unwrap()
}
fn sealed(record: &str, field: &str, plaintext_json: &str) -> Value {
    let cipher = XChaCha20Poly1305::new_from_slice(&[42; 32]).unwrap();
    let nonce = [7; 24];
    let mut bytes = plaintext_json.as_bytes().to_vec();
    cipher
        .encrypt_in_place(
            XNonce::from_slice(&nonce),
            format!("{record}\0{field}").as_bytes(),
            &mut bytes,
        )
        .unwrap();
    let mut envelope = vec![1];
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&bytes);
    let mut object = Object::new();
    object.insert(
        JsString::from(record_sealed::SEALED_MARK),
        Value::String(STANDARD.encode(envelope).into()),
    );
    Value::Object(object)
}

struct Fixture {
    record: String,
    model: Option<(Value, Value)>,
    current_checks: usize,
    fail_current_at: usize,
}
impl CurrentKeys for Fixture {
    fn assert_current(&mut self) -> record_value::Result<()> {
        self.current_checks += 1;
        if self.current_checks >= self.fail_current_at {
            Err(trillion_local::cause!(ValueError::Source))
        } else {
            Ok(())
        }
    }
    fn key(&mut self, _: &str) -> record_value::Result<KeyState> {
        Ok(KeyState::Present(SecretFieldKey::from_bytes(
            Zeroizing::new([42; 32]),
        )))
    }
}
impl Supply for Fixture {
    fn stored(&mut self, id: &str) -> record_value::Result<Option<StoredRecord>> {
        Ok((id == "root").then(|| StoredRecord {
            id: id.into(),
            record_type: "message".into(),
            sequence: "synthetic".into(),
            value_json: self.record.clone(),
            meta_json: None,
            protected_key_present: true,
        }))
    }
}
impl CurrentRecordModel for Fixture {
    fn current_model_data(&mut self) -> record_value::Result<Option<(Value, Value)>> {
        Ok(self.model.clone())
    }
}
fn fixture(model: Option<(Value, Value)>, inner: Value) -> Fixture {
    fixture_with_body_field(model, "text", inner)
}
fn fixture_with_body_field(
    model: Option<(Value, Value)>,
    body_field: &str,
    inner: Value,
) -> Fixture {
    let mut body = Object::new();
    body.insert(body_field.into(), inner);
    let mut payload = Object::new();
    payload.insert(
        "words".into(),
        sealed("root", "payload.words", r#""legacy""#),
    );
    let mut root = Object::new();
    root.insert("body".into(), Value::Object(body));
    root.insert("payload".into(), Value::Object(payload));
    root.insert(
        "legacy-flat".into(),
        sealed("root", "legacy-flat", r#""flat""#),
    );
    Fixture {
        record: encoded(&Value::Object(root)),
        model,
        current_checks: 0,
        fail_current_at: usize::MAX,
    }
}
fn model() -> (Value, Value) {
    (
        json(r#"{"kinds":[{"type":"message","erasable":[["body","text"]]}]}"#),
        json(
            r#"{"message":[["legacy","text"]],"legacy-kind":[["payload","words"],"legacy-flat"]}"#,
        ),
    )
}

#[test]
fn current_model_data_opens_array_path_and_keeps_legacy_union() {
    let (model, erasable) = model();
    let mut source = fixture(
        Some((model, erasable)),
        sealed("root", "body.text", r#""opened""#),
    );
    let policy = record_model_policy::open_policy(&mut source).unwrap();
    let record = record_value::read("root", &mut source, &policy, Limits::default())
        .unwrap()
        .unwrap();
    assert_eq!(
        encoded(record.value()),
        r#"{"body":{"text":"opened"},"payload":{"words":"legacy"},"legacy-flat":"flat"}"#
    );
}

#[test]
fn object_without_kinds_keeps_real_legacy_only_erasable_policy() {
    let declarations = (
        json("{}"),
        json(r#"{"legacy-kind":[["payload","words"],"legacy-flat"]}"#),
    );
    let mut source = fixture(Some(declarations), Value::String("ordinary".into()));
    let policy = record_model_policy::open_policy(&mut source).unwrap();
    let record = record_value::read("root", &mut source, &policy, Limits::default())
        .unwrap()
        .unwrap();
    assert_eq!(
        encoded(record.value()),
        r#"{"body":{"text":"ordinary"},"payload":{"words":"legacy"},"legacy-flat":"flat"}"#
    );
}

#[test]
fn dotted_string_declaration_does_not_mean_a_nested_path() {
    let declarations = (json("{}"), json(r#"{"legacy-kind":["payload.words"]}"#));
    let mut payload = Object::new();
    payload.insert(
        "words".into(),
        sealed("root", "payload.words", r#""must-remain-opaque""#),
    );
    let mut root = Object::new();
    root.insert("payload".into(), Value::Object(payload));
    let mut source = Fixture {
        record: encoded(&Value::Object(root)),
        model: Some(declarations),
        current_checks: 0,
        fail_current_at: usize::MAX,
    };
    let policy = record_model_policy::open_policy(&mut source).unwrap();
    assert_eq!(
        record_value::read("root", &mut source, &policy, Limits::default())
            .err()
            .unwrap(),
        trillion_local::cause!(ValueError::OpaqueField)
    );
}

#[test]
fn per_kind_declaration_replaces_legacy_paths_for_the_same_type() {
    let declarations = (
        json(r#"{"kinds":[{"type":"message","erasable":[["body","text"]]}]}"#),
        json(r#"{"message":[["legacy","text"]]}"#),
    );
    let mut body = Object::new();
    body.insert("text".into(), sealed("root", "body.text", r#""declared""#));
    let mut legacy = Object::new();
    legacy.insert(
        "text".into(),
        sealed("root", "legacy.text", r#""replaced""#),
    );
    let mut root = Object::new();
    root.insert("body".into(), Value::Object(body));
    root.insert("legacy".into(), Value::Object(legacy));
    let mut source = Fixture {
        record: encoded(&Value::Object(root)),
        model: Some(declarations),
        current_checks: 0,
        fail_current_at: usize::MAX,
    };
    let policy = record_model_policy::open_policy(&mut source).unwrap();
    assert_eq!(
        record_value::read("root", &mut source, &policy, Limits::default())
            .err()
            .unwrap(),
        trillion_local::cause!(ValueError::OpaqueField)
    );
}

#[test]
fn absent_model_is_not_an_empty_policy_and_currentness_is_rechecked() {
    let mut source = fixture(None, Value::Null);
    assert_eq!(
        record_model_policy::open_policy(&mut source).err().unwrap(),
        ModelError::MissingCurrentModel
    );
    let (model, erasable) = model();
    let mut source = fixture(Some((model, erasable)), Value::Null);
    source.fail_current_at = 2;
    assert_eq!(
        record_model_policy::open_policy(&mut source).err().unwrap(),
        ModelError::Source
    );
}

#[test]
fn undeclared_nested_path_refuses_instead_of_treating_ciphertext_as_plaintext() {
    let (model, erasable) = model();
    let mut source = fixture_with_body_field(
        Some((model, erasable)),
        "other",
        sealed("root", "body.other", r#""secret""#),
    );
    let policy = record_model_policy::open_policy(&mut source).unwrap();
    assert_eq!(
        record_value::read("root", &mut source, &policy, Limits::default()).unwrap_err(),
        trillion_local::cause!(ValueError::OpaqueField)
    );
}

#[test]
fn malformed_model_and_declaration_bounds_refuse() {
    for malformed_model in [Value::Null, Value::Bool(false), Value::Number(4.0)] {
        let mut source = fixture(Some((malformed_model, json("{}"))), Value::Null);
        assert_eq!(
            record_model_policy::open_policy(&mut source).err().unwrap(),
            trillion_local::cause!(ModelError::Invalid)
        );
    }
    let mut source = fixture(
        Some((json(r#"{"kinds":[{"erasable":["x"]}]}"#), json("{}"))),
        Value::Null,
    );
    assert_eq!(
        record_model_policy::open_policy(&mut source).err().unwrap(),
        trillion_local::cause!(ModelError::Invalid)
    );
    let huge = Value::Array(vec![Value::Null; 100_001]);
    let mut source = fixture(Some((json(r#"{"kinds":[]}"#), huge)), Value::Null);
    assert_eq!(
        record_model_policy::open_policy(&mut source).err().unwrap(),
        trillion_local::cause!(ModelError::Bounds)
    );
}
