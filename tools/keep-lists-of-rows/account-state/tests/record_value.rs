// Synthetic logical-value and real RustCrypto field tests. No current account,
// credentials, provider or production key. Canonical read mount is separately
// qualified over real SQLite below; fixture authority is never production proof.
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{AeadInPlace, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use std::collections::BTreeMap;
use trillion_local::{
    ecma_json::{self, JsString, Object, Value},
    legacy_records::StoredRecord,
    record_sealed::{self, SecretFieldKey},
    record_value::{self, CurrentKeys, Error, KeyState, Limits, OpenPolicy, Supply},
};
use zeroize::Zeroizing;
fn parse(raw: &str) -> Value {
    ecma_json::parse(raw.as_bytes(), ecma_json::Limits::default()).unwrap()
}
fn text(value: &Value) -> String {
    ecma_json::stringify(value, ecma_json::Limits::default()).unwrap()
}
fn sealed(id: &str, field: &str, raw: &str, owner: Option<&str>) -> Value {
    let cipher = XChaCha20Poly1305::new_from_slice(&[42; 32]).unwrap();
    let nonce = [7; 24];
    let mut bytes = raw.as_bytes().to_vec();
    cipher
        .encrypt_in_place(
            XNonce::from_slice(&nonce),
            format!("{id}\0{field}").as_bytes(),
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
    if let Some(owner) = owner {
        object.insert("k".into(), Value::String(owner.into()));
    }
    Value::Object(object)
}
struct Fixture {
    records: BTreeMap<String, String>,
    key_state: u8,
    stored_calls: Vec<String>,
    key_calls: Vec<String>,
    checks: usize,
    revoke_at: usize,
}
impl Fixture {
    fn new(root: Value) -> Self {
        Self {
            records: BTreeMap::from([("root".into(), text(&root))]),
            key_state: 0,
            stored_calls: Vec::new(),
            key_calls: Vec::new(),
            checks: 0,
            revoke_at: usize::MAX,
        }
    }
}
impl CurrentKeys for Fixture {
    fn assert_current(&mut self) -> record_value::Result<()> {
        self.checks += 1;
        if self.checks >= self.revoke_at {
            Err(trillion_local::cause!(Error::Source))
        } else {
            Ok(())
        }
    }
    fn key(&mut self, owner: &str) -> record_value::Result<KeyState> {
        self.key_calls.push(owner.into());
        match self.key_state {
            0 => Ok(KeyState::Present(SecretFieldKey::from_bytes(
                Zeroizing::new([42; 32]),
            ))),
            1 => Ok(KeyState::Missing),
            2 => Ok(KeyState::Erased),
            _ => Err(trillion_local::cause!(Error::Source)),
        }
    }
}
impl Supply for Fixture {
    fn stored(&mut self, id: &str) -> record_value::Result<Option<StoredRecord>> {
        self.stored_calls.push(id.into());
        Ok(self.records.get(id).map(|raw| StoredRecord {
            id: id.into(),
            record_type: "page".into(),
            sequence: "source-sequence".into(),
            value_json: raw.clone(),
            meta_json: None,
            protected_key_present: true,
        }))
    }
}
fn read(f: &mut Fixture) -> record_value::Result<Option<record_value::LogicalRecord>> {
    record_value::read("root", f, &OpenPolicy::default(), Limits::default())
}
#[test]
fn plain_value_preserves_ecmascript_order_surrogates_numbers_and_proto_data() {
    let value = parse(r#"{"z":1.00,"2":"two","1":"one","a":"\ud800","__proto__":{"ok":true}}"#);
    let mut f = Fixture::new(value);
    let result = read(&mut f).unwrap().unwrap();
    assert_eq!(
        text(result.value()),
        r#"{"1":"one","2":"two","z":1,"a":"\ud800","__proto__":{"ok":true}}"#
    );
    assert!(f.key_calls.is_empty());
    assert_eq!(result.sequence(), "source-sequence");
    assert_eq!(format!("{result:?}"), "LogicalRecord([redacted])");
}
#[test]
fn shared_values_expand_before_opening_and_missing_is_current_null() {
    let mut f = Fixture::new(parse(
        r#"{"left":{"\u0000shared":"shared"},"right":{"\u0000shared":"missing","ignored":"data"}}"#,
    ));
    f.records
        .insert("shared".into(), r#"{"z":1.00,"a":2}"#.into());
    let result = read(&mut f).unwrap().unwrap();
    assert_eq!(
        text(result.value()),
        r#"{"left":{"z":1,"a":2},"right":null}"#
    );
    assert_eq!(f.stored_calls, ["root", "shared", "missing"]);
}
#[test]
fn shared_cycles_source_failure_and_expansion_bounds_never_return_partial_values() {
    let mut f = Fixture::new(parse(r#"{"cycle":{"\u0000shared":"root"}}"#));
    assert!(matches!(read(&mut f), Err(Error::SharedCycle(_))));
    let mut f = Fixture::new(parse(r#"{"plain":"private-value-sentinel"}"#));
    f.revoke_at = 2;
    let error = read(&mut f).err().unwrap();
    assert_eq!(error, trillion_local::cause!(Error::Source));
    assert!(!error.to_string().contains("private-value-sentinel"));
    let mut f = Fixture::new(parse(r#"{"a":"large"}"#));
    let mut limits = Limits::default();
    limits.expansion_bytes = 1;
    assert!(matches!(
        record_value::read("root", &mut f, &OpenPolicy::default(), limits),
        Err(Error::Bounds(_))
    ));
}
#[test]
fn real_xchacha_field_opens_with_copied_key_owner_but_original_record_field_ad() {
    let mut root = Object::new();
    root.insert(
        "text".into(),
        sealed(
            "root",
            "text",
            r#"{"z":1.00,"a":"\ud800"}"#,
            Some("original-message"),
        ),
    );
    let mut f = Fixture::new(Value::Object(root));
    let result = read(&mut f).unwrap().unwrap();
    assert_eq!(text(result.value()), r#"{"text":{"z":1,"a":"\ud800"}}"#);
    assert_eq!(f.key_calls, ["original-message"]);
}
#[test]
fn missing_erased_and_wrong_ad_fields_are_null_but_unknown_key_source_refuses() {
    for state in [0, 1, 2, 3] {
        let mut root = Object::new();
        root.insert(
            "text".into(),
            sealed("different-record", "text", r#""secret""#, None),
        );
        let mut f = Fixture::new(Value::Object(root));
        f.key_state = state;
        let result = read(&mut f);
        if state == 3 {
            assert!(matches!(result, Err(Error::Source(_))))
        } else {
            assert_eq!(text(result.unwrap().unwrap().value()), r#"{"text":null}"#)
        }
    }
    let mut root = Object::new();
    root.insert(
        "wrong-field".into(),
        sealed("root", "text", r#""secret""#, None),
    );
    assert_eq!(
        text(
            read(&mut Fixture::new(Value::Object(root)))
                .unwrap()
                .unwrap()
                .value()
        ),
        r#"{"wrong-field":null}"#
    );
}
#[test]
fn nested_sealed_field_requires_declared_path_and_is_bound_to_dotted_name() {
    let mut child = Object::new();
    child.insert(
        "text".into(),
        sealed("root", "body.text", r#""opened""#, None),
    );
    let mut root = Object::new();
    root.insert("body".into(), Value::Object(child));
    let root = Value::Object(root);
    assert!(matches!(
        read(&mut Fixture::new(root.clone())),
        Err(Error::OpaqueField(_))
    ));
    let policy = OpenPolicy::new(vec![vec!["body".into(), "text".into()]]).unwrap();
    let result = record_value::read("root", &mut Fixture::new(root), &policy, Limits::default())
        .unwrap()
        .unwrap();
    assert_eq!(text(result.value()), r#"{"body":{"text":"opened"}}"#);
}
#[test]
fn key_revocation_after_resolution_withholds_plaintext_and_limits_key_work() {
    let mut root = Object::new();
    root.insert("text".into(), sealed("root", "text", r#""secret""#, None));
    let root = Value::Object(root);
    let mut f = Fixture::new(root.clone());
    let good = read(&mut f).unwrap().unwrap();
    assert!(text(good.value()).contains("secret"));
    let checks = f.checks;
    let mut f = Fixture::new(root.clone());
    f.revoke_at = checks;
    assert!(matches!(read(&mut f), Err(Error::Source(_))));
    let mut limits = Limits::default();
    limits.key_reads = 0;
    let mut f = Fixture::new(root);
    assert!(matches!(
        record_value::read("root", &mut f, &OpenPolicy::default(), limits),
        Err(Error::Bounds(_))
    ));
    assert!(f.key_calls.is_empty());
}
#[test]
fn malformed_envelope_and_authentication_failure_never_expose_ciphertext_as_value() {
    for raw in [r#"{"\u0000sealed":"!!!!"}"#, r#"{"\u0000sealed":"AQ=="}"#] {
        let mut root = Object::new();
        root.insert("text".into(), parse(raw));
        assert_eq!(
            text(
                read(&mut Fixture::new(Value::Object(root)))
                    .unwrap()
                    .unwrap()
                    .value()
            ),
            r#"{"text":null}"#
        );
    }
    let key = SecretFieldKey::from_bytes(Zeroizing::new([42; 32]));
    assert_eq!(format!("{key:?}"), "SecretFieldKey([redacted])");
    let Value::Object(mut object) = sealed("root", "text", r#""secret""#, None) else {
        unreachable!()
    };
    object.insert("extra".into(), Value::Bool(true));
    assert!(!record_sealed::is_sealed(&object));
}
#[test]
fn repeated_shared_expansion_is_charged_for_each_returned_copy() {
    let mut f = Fixture::new(parse(
        r#"[{"\u0000shared":"shared"},{"\u0000shared":"shared"}]"#,
    ));
    f.records
        .insert("shared".into(), r#"{"word":"copied"}"#.into());
    let mut limits = Limits::default();
    limits.shared_reads = 1;
    assert!(matches!(
        record_value::read("root", &mut f, &OpenPolicy::default(), limits),
        Err(Error::Bounds(_))
    ));
    assert_eq!(f.stored_calls, ["root", "shared"]);
}
#[test]
fn actual_current_sqlite_canonical_reader_supplies_stored_value_for_logical_crypto() {
    use rusqlite::{params, Connection, OpenFlags};
    use std::sync::{atomic::AtomicBool, Arc};
    use trillion_local::{
        import::ReadLimits,
        legacy_kept::{LegacyKept, Limits as KeptLimits},
        legacy_records::{Bounds, LegacyRecords},
        record_source::SnapshotRecordSql,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("current.sqlite");
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT);INSERT INTO record_keys_meta VALUES('engine','\"record-log\"');CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER);CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT);CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT);").unwrap();
    let mut root = Object::new();
    root.insert(
        "text".into(),
        sealed("root", "text", r#""actual-plaintext""#, None),
    );
    let raw = format!(
        "[\"page\",\"source-sequence\",{}]",
        text(&Value::Object(root))
    );
    let page = format!("[[\"i\\u0000root\",{raw}]]");
    writer
        .execute(
            "INSERT INTO record_keys_runs VALUES(1,1,1,?,0,0)",
            ["\"i\\u0000root\""],
        )
        .unwrap();
    writer
        .execute(
            "INSERT INTO record_keys_run_1 VALUES(0,?,?)",
            params!["\"i\\u0000root\"", page],
        )
        .unwrap();
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    let source = SnapshotRecordSql::begin(
        connection,
        ReadLimits::default(),
        || Ok(()),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    let mut records = LegacyRecords::open_source(source, Bounds::default()).unwrap();
    let kept = LegacyKept::new(KeptLimits::default()).unwrap();
    let mut keys = Fixture::new(Value::Null);
    let mut supply = record_value::CanonicalValues {
        records: &mut records,
        kept: &kept,
        keys: &mut keys,
    };
    let logical = record_value::read(
        "root",
        &mut supply,
        &OpenPolicy::default(),
        Limits::default(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(text(logical.value()), r#"{"text":"actual-plaintext"}"#);
    records.into_source().finish().unwrap();
}

#[test]
fn decrypted_graph_depth_counts_its_insertion_path_before_disclosure() {
    let nested = sealed(
        "root",
        "body.text",
        r#"{"a":{"b":{"c":{"d":{"e":true}}}}}"#,
        None,
    );
    let mut body = Object::new();
    body.insert("text".into(), nested);
    let mut root = Object::new();
    root.insert("body".into(), Value::Object(body));
    let policy = OpenPolicy::new(vec![vec!["body".into(), "text".into()]]).unwrap();
    let mut limits = Limits::default();
    limits.depth = 6;
    assert!(matches!(
        record_value::read(
            "root",
            &mut Fixture::new(Value::Object(root)),
            &policy,
            limits
        ),
        Err(Error::Bounds(_))
    ));
}
