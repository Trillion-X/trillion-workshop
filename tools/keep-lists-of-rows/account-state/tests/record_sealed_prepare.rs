//! Synthetic keys and values only. This qualifies the original crypto wire
//! primitive, not selected-key persistence, erasure, rights or native writes.
use base64::{engine::general_purpose::STANDARD, Engine};
use content_crypto::advanced::blake3;
use chacha20poly1305::{
    aead::{AeadInPlace, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use trillion_local::{
    ecma_json::{self, JsString, Object, Value},
    record_sealed::{self, prepare::seal, Error, SecretFieldKey, SEALED_MARK},
};
use zeroize::Zeroizing;

const KEY: [u8; 32] = [42; 32];
const ID: &str = "execution:synthetic-child";

#[test]
fn exact_bytes_match_the_actual_original_seal_and_open_runtime() {
    let bytes = include_bytes!("fixtures/record-sealed-original-vectors.json");
    assert_eq!(
        blake3::hash(bytes).to_hex().as_str(),
        "084df8a52e6edfa02cabeb941885828aa4b7c63e0fac8e89f34a97f0fbffdc81"
    );
    let oracle: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    assert_eq!(oracle["schema"], "trillion.original-erasable-seal-vectors/v1");
    let mut actual_key = [0_u8; 32];
    let supplied = oracle["synthetic_key_bytes"].as_array().unwrap();
    assert_eq!(supplied.len(), actual_key.len());
    for (byte, value) in actual_key.iter_mut().zip(supplied) {
        *byte = u8::try_from(value.as_u64().unwrap()).unwrap();
    }
    let secret = key(actual_key);
    let vectors = oracle["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 6);
    for vector in vectors {
        let id = vector["record_id"].as_str().unwrap();
        let Value::String(field) = json(vector["field_json"].as_str().unwrap()) else {
            panic!("original field is a string")
        };
        let value = json(vector["value_json"].as_str().unwrap());
        let object = seal(
            &secret,
            id,
            &field,
            &value,
            vector["key_owner"].as_str(),
            Default::default(),
        )
        .unwrap();
        assert_eq!(text(&object), vector["envelope_base64"].as_str().unwrap());
        assert_eq!(
            ecma_json::stringify(&Value::Object(object.clone()), Default::default()).unwrap(),
            vector["sealed_json"].as_str().unwrap()
        );
        let opened = opened(&object, id, &field, &secret).unwrap();
        assert_eq!(
            ecma_json::stringify(&opened, Default::default()).unwrap(),
            vector["opened_json"].as_str().unwrap()
        );
    }
}

fn key(bytes: [u8; 32]) -> SecretFieldKey {
    SecretFieldKey::from_bytes(Zeroizing::new(bytes))
}
fn json(raw: &str) -> Value {
    ecma_json::parse(raw.as_bytes(), Default::default()).unwrap()
}
fn text(object: &Object) -> String {
    let Some(Value::String(encoded)) = object.get(&SEALED_MARK.into()) else {
        panic!("sealed marker must be text")
    };
    encoded.to_rust_string().unwrap()
}
fn wire(object: &Object) -> Vec<u8> {
    STANDARD.decode(text(object)).unwrap()
}
fn replaced(object: &Object, bytes: &[u8]) -> Object {
    let mut out = object.clone();
    out.insert(
        SEALED_MARK.into(),
        Value::String(STANDARD.encode(bytes).into()),
    );
    out
}
fn opened(object: &Object, id: &str, field: &JsString, secret: &SecretFieldKey) -> Option<Value> {
    record_sealed::open(secret, id, field, object, Default::default())
        .unwrap()
        .map(|(value, _)| value)
}

/// Independent literal-byte transcription of the reviewed original formula.
/// It uses a one-shot 32-byte keyed BLAKE3 output truncated to 24 bytes and a
/// combined material buffer, opposing production's streaming XOF derivation.
/// JSON bytes and TextEncoder output are hand-supplied; no production serializer
/// or prepare helper is used to calculate this expected ciphertext.
fn original_reference(key: &[u8; 32], id: &str, utf8_field: &str, plain: &[u8]) -> String {
    let associated = [id.as_bytes(), &[0], utf8_field.as_bytes()].concat();
    let material = [associated.as_slice(), &[0], plain].concat();
    let hashed = blake3::keyed_hash(key, &material);
    let nonce = &hashed.as_bytes()[..24];
    let cipher = XChaCha20Poly1305::new_from_slice(key).unwrap();
    let mut ciphertext = plain.to_vec();
    cipher
        .encrypt_in_place(XNonce::from_slice(nonce), &associated, &mut ciphertext)
        .unwrap();
    STANDARD.encode([&[1_u8][..], nonce, ciphertext.as_slice()].concat())
}

#[test]
fn sealed_bytes_match_original_manual_json_utf8_nonce_and_version_layout() {
    let value = json(r#"{"z":-0,"10":"ten","2":"two","a":"é😀"}"#);
    let object = seal(
        &key(KEY),
        ID,
        &"input".into(),
        &value,
        None,
        Default::default(),
    )
    .unwrap();
    assert!(record_sealed::is_sealed(&object));
    assert_eq!(object.len(), 1);
    assert_eq!(
        text(&object),
        original_reference(
            &KEY,
            ID,
            "input",
            r#"{"2":"two","10":"ten","z":0,"a":"é😀"}"#.as_bytes()
        )
    );
    assert_eq!(wire(&object)[0], 1);
    assert_eq!(
        wire(&object).len(),
        41 + r#"{"2":"two","10":"ten","z":0,"a":"é😀"}"#.len()
    );
}

#[test]
fn same_value_key_and_ad_are_identical_and_each_changed_input_changes_ciphertext() {
    let secret = key(KEY);
    let field = JsString::from("input");
    let value = json(r#"{"value":"same words"}"#);
    let prepare = |secret: &SecretFieldKey, id: &str, field: &JsString, value: &Value| {
        seal(secret, id, field, value, None, Default::default()).unwrap()
    };
    let first = prepare(&secret, ID, &field, &value);
    let second = prepare(&secret, ID, &field, &value);
    assert_eq!(first, second);
    for changed in [
        prepare(&secret, ID, &field, &json(r#"{"value":"changed words"}"#)),
        prepare(&secret, "execution:another-child", &field, &value),
        prepare(&secret, ID, &"output".into(), &value),
        prepare(&key([43; 32]), ID, &field, &value),
    ] {
        assert_ne!(text(&first), text(&changed));
        assert_ne!(&wire(&first)[1..25], &wire(&changed)[1..25]);
    }
}

#[test]
fn existing_opener_round_trips_original_json_semantics_including_lone_surrogates() {
    let secret = key(KEY);
    let field = JsString::from("input");
    for (source, expected) in [
        ("null", "null"),
        ("true", "true"),
        ("-0", "0"),
        ("1e999", "null"),
        (r#""\ud800x\udfff""#, r#""\ud800x\udfff""#),
        (r#"[1,"é😀",{"b":2,"a":1}]"#, r#"[1,"é😀",{"b":2,"a":1}]"#),
    ] {
        let object = seal(&secret, ID, &field, &json(source), None, Default::default()).unwrap();
        let value = opened(&object, ID, &field, &secret).unwrap();
        assert_eq!(
            ecma_json::stringify(&value, Default::default()).unwrap(),
            expected
        );
        assert_eq!(
            text(&object),
            original_reference(&KEY, ID, "input", expected.as_bytes())
        );
    }
}

#[test]
fn field_ad_uses_textencoder_replacement_for_lone_surrogates() {
    let secret = key(KEY);
    let field = JsString::from_units(vec![b'a' as u16, 0xd800, b'b' as u16]);
    let value = json(r#""\ud800""#);
    let object = seal(&secret, ID, &field, &value, None, Default::default()).unwrap();
    assert_eq!(
        text(&object),
        original_reference(&KEY, ID, "a�b", br#""\ud800""#)
    );
    assert!(opened(&object, ID, &field, &secret).is_some());
    assert!(opened(&object, ID, &"a�b".into(), &secret).is_some());
    assert!(opened(&object, ID, &"a?b".into(), &secret).is_none());
}

#[test]
fn normal_string_property_order_is_not_sorted_and_numeric_keys_follow_ecmascript_order() {
    let secret = key(KEY);
    let a = json(r#"{"z":1,"2":2,"a":3,"10":4}"#);
    let b = json(r#"{"a":3,"10":4,"z":1,"2":2}"#);
    let sa = seal(&secret, ID, &"input".into(), &a, None, Default::default()).unwrap();
    let sb = seal(&secret, ID, &"input".into(), &b, None, Default::default()).unwrap();
    assert_eq!(
        text(&sa),
        original_reference(&KEY, ID, "input", br#"{"2":2,"10":4,"z":1,"a":3}"#)
    );
    assert_eq!(
        text(&sb),
        original_reference(&KEY, ID, "input", br#"{"2":2,"10":4,"a":3,"z":1}"#)
    );
    assert_ne!(sa, sb);
}

#[test]
fn another_key_owner_is_metadata_and_never_replaces_original_record_ad() {
    let secret = key(KEY);
    let field = JsString::from("input");
    let value = json(r#""message words""#);
    let own = seal(&secret, ID, &field, &value, None, Default::default()).unwrap();
    let explicit_own = seal(&secret, ID, &field, &value, Some(ID), Default::default()).unwrap();
    assert_eq!(own, explicit_own);
    let other = seal(
        &secret,
        ID,
        &field,
        &value,
        Some("message:synthetic"),
        Default::default(),
    )
    .unwrap();
    assert_eq!(other.len(), 2);
    assert_eq!(
        record_sealed::key_owner(ID, &other).unwrap(),
        "message:synthetic"
    );
    assert_eq!(text(&own), text(&other));
    assert!(opened(&other, ID, &field, &secret).is_some());
    assert!(opened(&other, "message:synthetic", &field, &secret).is_none());
    assert!(opened(&other, ID, &field, &key([43; 32])).is_none());
    let names: Vec<_> = other
        .insertion_entries()
        .map(|(name, _)| name.to_rust_string().unwrap())
        .collect();
    assert_eq!(names, [SEALED_MARK, "k"]);
}

#[test]
fn wrong_record_field_key_and_tampered_version_nonce_ciphertext_or_tag_do_not_open() {
    let secret = key(KEY);
    let field = JsString::from("input");
    let object = seal(
        &secret,
        ID,
        &field,
        &json(r#"{"words":"private"}"#),
        None,
        Default::default(),
    )
    .unwrap();
    assert!(opened(&object, "other-record", &field, &secret).is_none());
    assert!(opened(&object, ID, &"output".into(), &secret).is_none());
    assert!(opened(&object, ID, &field, &key([0; 32])).is_none());
    let bytes = wire(&object);
    for at in [0, 1, 24, 25, bytes.len() - 1] {
        let mut changed = bytes.clone();
        changed[at] ^= 1;
        assert!(opened(&replaced(&object, &changed), ID, &field, &secret).is_none());
    }
}

#[test]
fn plaintext_limits_refuse_instead_of_truncating_or_emitting_an_unopenable_value() {
    let secret = key(KEY);
    let field = JsString::from("input");
    let value = json(r#"["words"]"#);
    let default = ecma_json::Limits::default();
    let limits = [
        ecma_json::Limits {
            input_bytes: 3,
            ..default
        },
        ecma_json::Limits {
            output_bytes: 3,
            ..default
        },
        ecma_json::Limits {
            depth: 0,
            ..default
        },
        ecma_json::Limits {
            nodes: 1,
            ..default
        },
        ecma_json::Limits {
            string_units: 2,
            ..default
        },
        ecma_json::Limits {
            total_string_units: 2,
            ..default
        },
        ecma_json::Limits {
            container_entries: 0,
            ..default
        },
    ];
    for limits in limits {
        assert_eq!(
            seal(&secret, ID, &field, &value, None, limits),
            Err(trillion_local::cause!(Error::Bounds))
        );
    }
    let limits = ecma_json::Limits {
        input_bytes: ecma_json::HARD_BYTES + 1,
        ..default
    };
    assert_eq!(
        seal(&secret, ID, &field, &value, None, limits),
        Err(trillion_local::cause!(Error::InvalidLimits))
    );
    assert_eq!(format!("{secret:?}"), "SecretFieldKey([redacted])");
    assert_eq!(format!("{}", trillion_local::cause!(Error::Bounds)), "sealed field exceeds bounds");
}

#[test]
fn exact_plaintext_byte_boundary_round_trips_without_changing_the_limits() {
    let secret = key(KEY);
    let limits = ecma_json::Limits {
        input_bytes: 4,
        output_bytes: 4,
        ..Default::default()
    };
    let object = seal(&secret, ID, &"input".into(), &Value::Null, None, limits).unwrap();
    let opened = record_sealed::open(&secret, ID, &"input".into(), &object, limits)
        .unwrap()
        .unwrap();
    assert_eq!(opened, (Value::Null, 4));
}
