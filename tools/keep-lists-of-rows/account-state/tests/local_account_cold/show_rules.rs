//! Actual same-owner show-rule composition controls over isolated synthetic
//! account/workspace/KV fixtures. A missing real ICU profile fails, never skips.
use super::*;
use std::sync::{atomic::AtomicBool, Arc};
use trillion_local::{
    ecma_json,
    tool_label_locale::{self, Profile, QualifiedLocale},
};

fn locale() -> QualifiedLocale {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("crates/icu-collation/profile.json");
    let profile: Profile =
        serde_json::from_slice(&fs::read(path).expect("actual qualified ICU profile required"))
            .unwrap();
    tool_label_locale::open(&profile).expect("actual qualified ICU runtime required")
}
fn fixture(operator: bool) -> Fixture {
    fixture_with(Some(operator))
}
/// `None`: the receipt names no operator at all, as for an account made by `account create`.
fn fixture_with(operator: Option<bool>) -> Fixture {
    let mut f = Fixture::new().with_workspace("@own-records");
    // The show-rules DATA is the installed Workshop's (src/local_account/show_rules/data.json), as for every account.
    super::workshop_data::install_show_rules_data(&f.root);
    let user = f.user.clone();
    if let Some(operator) = operator {
        edit_fixture_receipt(
            &mut f,
            |r| r["environment"] = json!({"OPERATOR_ACCOUNT_ID":if operator{user}else{"other-synthetic-operator".to_string()}}),
        );
    }
    record(
        &f,
        "show-rules",
        json!({"rules":[{"id":"mine","subject":"control","effect":"hide","when":null,"on":true}],"attribute_fields":[{"id":"team","label":"Team","kind":"tags"}]}),
    );
    f
}
/// The account opened after its first start, which carries the original workspace records written so far into its
/// workspace store (`own_records_step`); the reader reads only that store.
fn started(f: &Fixture) -> LocalAccount {
    let has_log: bool = Connection::open(f.root.join("records.sqlite"))
        .unwrap()
        .query_row("SELECT count(*)>0 FROM sqlite_schema WHERE name='record_log'", [], |r| r.get(0))
        .unwrap();
    if !has_log {
        add_current_record_log(f, r#"{"answer":"one"}"#);
    }
    let mut owner = f.open().unwrap();
    first_start(&mut owner, &f.session);
    owner
}
fn record(f: &Fixture, label: &str, value: Value) {
    Connection::open(f.root.join("records.sqlite")).unwrap().execute("INSERT OR REPLACE INTO workspace_records(label,value,written_at) VALUES(?,?,'test-original-time')",[label,&value.to_string()]).unwrap();
}
fn service(f: &Fixture, label: &str, value: Value) {
    let blob = if label == "show-rules" { "bb" } else { "cc" };
    fs::write(
        f.root
            .join("storage/kv/trillion-local-app/blobs")
            .join(blob),
        value.to_string(),
    )
    .unwrap();
    Connection::open(&f.kv)
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO _mf_entries(key,blob_id,expiration) VALUES(?,?,NULL)",
            [format!("service-record:{label}"), blob.into()],
        )
        .unwrap();
}
fn output(v: &ecma_json::Value) -> Value {
    serde_json::from_str(&ecma_json::stringify(v, Default::default()).unwrap()).unwrap()
}

#[test]
fn actual_show_rules_reads_personal_record_original_data_controls_and_proven_service_absence() {
    let f = fixture(false);
    let locale = locale();
    let mut owner = started(&f);
    let (value, witness) = owner
        .current_show_rules(&f.session, &locale, Arc::new(AtomicBool::new(false)))
        .unwrap();
    let value = output(&value);
    assert_eq!(value["authority"], "personal");
    assert_eq!(value["record"], "show-rules");
    assert!(value["rules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == "mine"));
    assert!(value["controls"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == "sidebar.position"));
    assert_eq!(value["attribute_fields"][0]["id"], "team");
    assert!(!value["operators"].as_array().unwrap().is_empty());
    assert!(!value["edit_authority"]["rules"]
        .as_array()
        .unwrap()
        .is_empty());
    owner
        .assert_show_rules_delivery_current(&f.session, Arc::new(AtomicBool::new(false)), &witness)
        .unwrap();
}
/// A receipt that names no operator proves there is none: the account reads its show rules as its own person. Nov 13
/// 2026: every account made by `account create` answered GET /work/api/show-rules 503 (show_rules.rs:208
/// SourceUnavailable), so its workspace never finished opening.
#[test]
fn an_account_whose_receipt_names_no_operator_reads_its_show_rules_as_personal() {
    let f = fixture_with(None);
    let locale = locale();
    let mut owner = started(&f);
    let (value, _) = owner
        .current_show_rules(&f.session, &locale, Arc::new(AtomicBool::new(false)))
        .unwrap();
    let value = output(&value);
    assert_eq!(value["authority"], "personal");
    assert!(value["rules"].as_array().unwrap().iter().any(|r| r["id"] == "mine"));
}
#[test]
fn actual_show_rules_operator_uses_own_giver_and_assigned_types() {
    let f = fixture(true);
    record(
        &f,
        "show-rules",
        json!({"types":[{"id":"team","label":"Team","rules":[{"id":"inherited","subject":"control","effect":"hide"}]}]}),
    );
    record(
        &f,
        "setup-context",
        json!({"accounts":{f.user.clone():{"cohorts":["team"]}}}),
    );
    let mut owner = started(&f);
    let locale = locale();
    let (value, _) = owner
        .current_show_rules(&f.session, &locale, Arc::new(AtomicBool::new(false)))
        .unwrap();
    let value = output(&value);
    assert_eq!(value["authority"], "operator");
    assert!(value["rules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == "type:team:inherited"));
}
#[test]
fn actual_show_rules_uses_real_formula_for_service_audience_and_given_edit_policy() {
    let f = fixture(false);
    let audience = json!({"kind":"group","combinator":"and","negate":false,"rules":[{"kind":"rule","field":"account_id","operator":"is_any_of","params":{"values":[f.user.clone()]}}]});
    service(
        &f,
        "show-rules",
        json!({"value":{"rules":[{"id":"aimed","subject":"control","effect":"hide","audience":audience}],"edit_rules":[{"id":"edit-aimed","effect":"deny","audience":audience}]}}),
    );
    let mut owner = started(&f);
    let locale = locale();
    let (value, _) = owner
        .current_show_rules(&f.session, &locale, Arc::new(AtomicBool::new(false)))
        .unwrap();
    let value = output(&value);
    assert!(value["rules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == "given:aimed"));
    assert!(value["edit_authority"]["rules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == "given:edit-aimed"));
}
#[test]
fn delivery_rechecks_real_workspace_service_session_policy_and_cancellation() {
    let locale = locale();
    for change in ["workspace", "service", "session", "policy", "cancel"] {
        let f = fixture(false);
        let mut owner = started(&f);
        let cancel = Arc::new(AtomicBool::new(false));
        let (_, witness) = owner
            .current_show_rules(&f.session, &locale, cancel.clone())
            .unwrap();
        match change {
            "workspace" => record(&f, "show-rules", json!({"rules":[]})),
            "service" => service(&f, "show-rules", json!({"value":{"rules":[]}})),
            "session" => {
                Connection::open(&f.kv)
                    .unwrap()
                    .execute(
                        "DELETE FROM _mf_entries WHERE key=?",
                        [format!("session:{}", f.session)],
                    )
                    .unwrap();
            }
            "policy" => {
                Connection::open(&f.policy)
                    .unwrap()
                    .execute(
                        "UPDATE policy_directory SET value='2' WHERE name='revision'",
                        [],
                    )
                    .unwrap();
            }
            "cancel" => cancel.store(true, std::sync::atomic::Ordering::Release),
            _ => unreachable!(),
        }
        assert!(
            owner
                .assert_show_rules_delivery_current(&f.session, cancel, &witness)
                .is_err(),
            "{change}"
        );
    }
}
#[test]
fn unavailable_settings_required_facts_and_malformed_service_never_become_empty_success() {
    let locale = locale();
    for case in [
        // A receipt that names no operator proves there is none (an account made by `account create`, read as personal:
        // an_account_whose_receipt_names_no_operator_reads_its_show_rules_as_personal); an unreadable environment
        // leaves the operator unknown.
        "unknown-operator",
        "required-plan",
        "malformed-service",
        "unsupported-date",
    ] {
        let mut f = fixture(false);
        match case {
            "unknown-operator" => edit_fixture_receipt(&mut f, |r| {
                r["environment"] = json!("not-an-environment");
            }),
            "required-plan" => service(
                &f,
                "show-rules",
                json!({"value":{"rules":[{"id":"needs-plan","audience":{"kind":"group","combinator":"and","negate":false,"rules":[{"kind":"rule","field":"plan","operator":"is_any_of","params":{"values":["free"]}}]}}]}}),
            ),
            "malformed-service" => {
                let blob = f.root.join("storage/kv/trillion-local-app/blobs/bb");
                service(&f, "show-rules", json!({"value":null}));
                fs::write(blob, b"not-json").unwrap();
            }
            "unsupported-date" => record(
                &f,
                "show-rules",
                json!({"rules":[{"id":"dated","until":1234}]}),
            ),
            _ => unreachable!(),
        }
        let mut owner = started(&f);
        assert!(
            owner
                .current_show_rules(&f.session, &locale, Arc::new(AtomicBool::new(false)))
                .is_err(),
            "{case}"
        );
    }
}

/// The service record a KV holds for `label`, as its reader would find it (the whole { label, value, identity, at }).
fn kept_service_record(f: &Fixture, label: &str) -> Option<Value> {
    let blob: Option<String> = Connection::open(&f.kv)
        .unwrap()
        .query_row(
            "SELECT blob_id FROM _mf_entries WHERE key=?",
            [format!("service-record:{label}")],
            |r| r.get(0),
        )
        .ok();
    blob.map(|blob| {
        serde_json::from_slice(
            &fs::read(f.root.join("storage/kv/trillion-local-app/blobs").join(blob)).unwrap(),
        )
        .unwrap()
    })
}

/// Old trillion publishServiceRecords + service-record-publication: the operator's store publishes show-rules and
/// setup-context when they are written; a second account's reader reads the giver's types from its own APP_KV.
#[test]
fn operator_publishes_show_rules_and_a_second_account_reads_the_givers_types() {
    use trillion_local::local_account::service_records::{serve, ServiceRecordKv};
    let operator = fixture(true);
    let reader = fixture(false);
    record(
        &operator,
        "show-rules",
        json!({"types":[{"id":"team","label":"Team","rules":[{"id":"given-hide","subject":"control","effect":"hide"}]}]}),
    );
    record(
        &operator,
        "setup-context",
        json!({"accounts":{reader.user.clone():{"cohorts":["team"]}}}),
    );
    // Each account's first start carries its original workspace records into its workspace store.
    for f in [&operator, &reader] {
        drop(started(f));
    }
    let locale = locale();
    // Before any publication the reader holds no giver: no given type.
    let (before, _) = reader
        .open()
        .unwrap()
        .current_show_rules(&reader.session, &locale, Arc::new(AtomicBool::new(false)))
        .unwrap();
    assert!(!output(&before)["rules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == "type:team:given-hide"));
    serve(vec![
        ServiceRecordKv::of_selected(&operator.selection()).unwrap(),
        ServiceRecordKv::of_selected(&reader.selection()).unwrap(),
    ]);
    // A write of a label service-records.json does not name publishes nothing.
    let mut owner = operator.open().unwrap();
    assert!(owner
        .publish_own_service_records(Some(&["not-a-service-record".into()]), Arc::new(AtomicBool::new(false)))
        .unwrap()
        .is_empty());
    let published = owner
        .publish_own_service_records(
            Some(&["show-rules".into(), "setup-context".into()]),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
    assert_eq!(published, vec!["setup-context".to_string(), "show-rules".to_string()]);
    let kept = kept_service_record(&reader, "show-rules").unwrap();
    assert_eq!(kept["label"], "show-rules");
    assert_eq!(kept["value"]["types"][0]["id"], "team");
    assert!(kept["identity"].as_str().unwrap().starts_with("1f:"));
    assert!(kept["at"].as_u64().unwrap() > 0);
    // The same value again writes nothing (same identity); the start publication of an unchanged record neither.
    assert!(owner
        .publish_own_service_records(Some(&["show-rules".into()]), Arc::new(AtomicBool::new(false)))
        .unwrap()
        .is_empty());
    drop(owner);
    let (after, _) = reader
        .open()
        .unwrap()
        .current_show_rules(&reader.session, &locale, Arc::new(AtomicBool::new(false)))
        .unwrap();
    let after = output(&after);
    assert_eq!(after["authority"], "personal");
    assert!(after["rules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == "type:team:given-hide"));
    // An account that is not the operator publishes nothing, even when its own record is named.
    assert!(reader
        .open()
        .unwrap()
        .publish_own_service_records(None, Arc::new(AtomicBool::new(false)))
        .unwrap()
        .is_empty());
    serve(Vec::new());
}

/// Old trillion service-records.mjs invariant 2: a publication no newer than the kept one, or with its identity,
/// writes nothing, so a late arrival never brings back an older value.
#[test]
fn an_older_service_record_publication_never_replaces_a_newer_one() {
    use trillion_local::local_account::service_records::{publish_service_records, ServiceRecordKv};
    let reader = fixture(false);
    let kv = ServiceRecordKv::of_selected(&reader.selection()).unwrap();
    let js = |raw: &str| ecma_json::parse(raw.as_bytes(), Default::default()).unwrap();
    let newer = js(r#"{"rules":[{"id":"newer"}]}"#);
    let older = js(r#"{"rules":[{"id":"older"}]}"#);
    assert_eq!(
        publish_service_records(&reader.root, &kv, &[("show-rules".into(), newer.clone())], 2_000).unwrap(),
        vec!["show-rules".to_string()]
    );
    assert!(publish_service_records(&reader.root, &kv, &[("show-rules".into(), older.clone())], 1_000)
        .unwrap()
        .is_empty());
    assert_eq!(kept_service_record(&reader, "show-rules").unwrap()["value"]["rules"][0]["id"], "newer");
    assert_eq!(kept_service_record(&reader, "show-rules").unwrap()["at"], 2_000);
    // The same identity later writes nothing either; another value later replaces it.
    assert!(publish_service_records(&reader.root, &kv, &[("show-rules".into(), newer)], 3_000)
        .unwrap()
        .is_empty());
    assert_eq!(
        publish_service_records(&reader.root, &kv, &[("show-rules".into(), older)], 3_000).unwrap(),
        vec!["show-rules".to_string()]
    );
    assert_eq!(kept_service_record(&reader, "show-rules").unwrap()["value"]["rules"][0]["id"], "older");
    // A label service-records.json does not name is refused.
    assert!(publish_service_records(&reader.root, &kv, &[("not-a-service-record".into(), js("1"))], 4_000).is_err());
}
