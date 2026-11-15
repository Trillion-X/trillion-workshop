//! Synthetic credential and actual LocalAccount catalog-source join controls.
//! No production credential directory, account or provider is read or changed.
use super::*;
use content_crypto::advanced::blake3;
use crate::{
    import::FilePin,
    local_account::{SelectedLocalState, EXISTING_APP_KV_STORE},
};
use rusqlite::Connection;
use serde_json::json;
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};

const USER: &str = "fixture-account";
const PUBLISHER: &str = "fixture-publisher";
const REFERENCE: &str = "fixture-publisher-ref";

struct Fixture {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    credentials: PathBuf,
    receipt: FilePin,
}
impl Fixture {
    fn new(mut alter: impl FnMut(&mut Value, &mut Vec<Value>)) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let credentials = root.join("fixture-credentials");
        fs::create_dir(&credentials).unwrap();
        // The window's sign-in token: a pass of the account's sign-in tool (src/account/signed_in.rs).
        let token = crate::account::signed_in::test_token(&"b".repeat(64));
        fs::write(root.join("browser-session.key"), &token).unwrap();
        fs::set_permissions(
            root.join("browser-session.key"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let policy = Connection::open(root.join("policy.sqlite")).unwrap();
        policy
            .execute_batch(
                "CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)",
            )
            .unwrap();
        drop(policy);
        let kv_folder = root.join("storage/kv").join(EXISTING_APP_KV_STORE);
        fs::create_dir_all(kv_folder.join("blobs")).unwrap();
        let kv = Connection::open(kv_folder.join("current.sqlite")).unwrap();
        kv.execute_batch("CREATE TABLE _mf_entries(key TEXT PRIMARY KEY,blob_id TEXT NOT NULL,expiration INTEGER)").unwrap();
        let session = blake3::hash(token.as_bytes()).to_hex().to_string();
        kv.execute(
            "INSERT INTO _mf_entries VALUES(?,'aa',NULL)",
            [format!("session:{session}")],
        )
        .unwrap();
        fs::write(
            kv_folder.join("blobs/aa"),
            json!({"userId":USER}).to_string(),
        )
        .unwrap();
        drop(kv);
        let owner = "a".repeat(64);
        let mut rows = vec![
            json!({"binding":"ACCOUNT_CONTROL","originalId":"c".repeat(64),"names":[format!("policy:{owner}")],"sqlite":"policy.sqlite"}),
            json!({"binding":"PERSON","originalId":owner,"localId":"d".repeat(64),"className":"PersonStore","names":[USER]}),
            json!({"binding":"PERSON","originalId":"e".repeat(64),"localId":"f".repeat(64),"className":"PersonStore","names":[PUBLISHER]}),
        ];
        let mut receipt = json!({"complete":true,"account":{"userId":USER,"ownerId":owner},
            "environment":{"WORKSHOP_IDENTITY":"1".repeat(64),"OPERATOR_ACCOUNT_ID":USER},
            "bindingCredentials":{"MARKETPLACE_PUBLISHER_ACCOUNT_ID":REFERENCE}});
        alter(&mut receipt, &mut rows);
        let index = rows
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(root.join("objects.jsonl"), &index).unwrap();
        receipt["objects"] = json!({"path":"objects.jsonl","bytes":index.len(),"fileIdentity":blake3::hash(index.as_bytes()).to_hex().as_str(),"count":rows.len()});
        let bytes = serde_json::to_vec(&receipt).unwrap();
        fs::write(root.join("restore-receipt.json"), &bytes).unwrap();
        Self {
            _temporary: temporary,
            root,
            credentials,
            receipt: FilePin {
                bytes: bytes.len() as u64,
                blake3: blake3::hash(&bytes).to_hex().to_string(),
            },
        }
    }
    fn write_credential(&self, value: &str) {
        let path = self.credentials.join(REFERENCE);
        fs::write(&path, value).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn open(&self) -> LocalAccount {
        LocalAccount::open_selected_after_handoff(
            SelectedLocalState {
                root: self.root.clone(),
                receipt: self.receipt.clone(),
                app_kv_sqlite: PathBuf::from("storage/kv")
                    .join(EXISTING_APP_KV_STORE)
                    .join("current.sqlite"),
                app_kv_store: EXISTING_APP_KV_STORE.into(),
                prior_processes: vec![],
            },
        )
        .unwrap()
    }
    fn metadata(&self, owner: &LocalAccount) -> Result<CatalogMetadata, Failure> {
        owner.catalog_metadata_with(
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(5),
            |reference| ProtectedBindingIdentity::fixture_in_home(reference, &self.credentials),
        )
    }
}

#[test]
fn actual_selected_receipt_resolves_protected_publisher_to_original_person_address() {
    let fixture = Fixture::new(|_, _| {});
    fixture.write_credential(&format!("\u{feff} {PUBLISHER}\n"));
    let owner = fixture.open();
    let before = owner.sql_work().unwrap().work.sql_statements;
    let metadata = fixture.metadata(&owner).unwrap();
    assert_eq!(
        metadata.publisher_person_id("OPERATOR_ACCOUNT_ID").unwrap(),
        Some("a".repeat(64))
    );
    assert_eq!(
        metadata
            .publisher_person_id("MARKETPLACE_PUBLISHER_ACCOUNT_ID")
            .unwrap(),
        Some("e".repeat(64))
    );
    assert!(!metadata
        .settings
        .contains_key("MARKETPLACE_PUBLISHER_ACCOUNT_ID"));
    assert_eq!(
        owner.sql_work().unwrap().work.sql_statements,
        before,
        "the catalog identity join adds no SQL or account history work"
    );
}

#[test]
fn public_publisher_needs_no_credential_read_and_operator_can_be_genuinely_absent() {
    let fixture = Fixture::new(|receipt, _| {
        receipt
            .as_object_mut()
            .unwrap()
            .remove("bindingCredentials");
        receipt["environment"]
            .as_object_mut()
            .unwrap()
            .remove("OPERATOR_ACCOUNT_ID");
        receipt["environment"]["MARKETPLACE_PUBLISHER_ACCOUNT_ID"] = json!(PUBLISHER);
    });
    let owner = fixture.open();
    let metadata = owner
        .catalog_metadata_with(
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(5),
            |_| panic!("public publisher must never consult credentials"),
        )
        .unwrap();
    assert_eq!(
        metadata.publisher_person_id("OPERATOR_ACCOUNT_ID").unwrap(),
        None
    );
    assert_eq!(
        metadata
            .publisher_person_id("MARKETPLACE_PUBLISHER_ACCOUNT_ID")
            .unwrap(),
        Some("e".repeat(64))
    );
}

#[test]
fn source_conflicts_or_wrong_binding_do_not_resolve_or_invent_a_publisher() {
    for case in ["conflict", "wrong-binding", "invalid-reference"] {
        let fixture = Fixture::new(|receipt, _| match case {
            "conflict" => {
                receipt["environment"]["MARKETPLACE_PUBLISHER_ACCOUNT_ID"] = json!(PUBLISHER)
            }
            "wrong-binding" => {
                receipt["bindingCredentials"] = json!({"OPERATOR_ACCOUNT_ID":REFERENCE})
            }
            _ => {
                receipt["bindingCredentials"]["MARKETPLACE_PUBLISHER_ACCOUNT_ID"] =
                    json!("../other")
            }
        });
        let owner = fixture.open();
        assert!(
            matches!(
                owner.catalog_metadata_with(
                    &AtomicBool::new(false),
                    Instant::now() + Duration::from_secs(5),
                    |_| panic!("invalid source must not resolve credentials")
                ),
                Err(Failure::Source(_))
            ),
            "{case}"
        );
    }
}

#[test]
fn absent_and_failed_credential_resolution_both_withhold_catalog_instead_of_empty_success() {
    let fixture = Fixture::new(|_, _| {});
    let owner = fixture.open();
    assert!(matches!(fixture.metadata(&owner), Err(Failure::Source(_))));
    for error in [
        crate::cause!(BindingError::Missing),
        crate::cause!(BindingError::Unavailable),
        crate::cause!(BindingError::Custody),
        crate::cause!(BindingError::Changed),
    ] {
        assert!(matches!(
            owner.catalog_metadata_with(
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(5),
                |_| Err(error)
            ),
            Err(Failure::Source(_))
        ));
    }
}

#[test]
fn missing_or_wrong_person_coverage_does_not_hash_the_account_name_as_address() {
    for case in ["publisher-missing", "own-address-wrong", "partial-original"] {
        let fixture = Fixture::new(|_, rows| match case {
            "publisher-missing" => {
                rows.pop();
            }
            "own-address-wrong" => rows[1]["originalId"] = json!("2".repeat(64)),
            _ => rows[2]["partial_original"] = json!(true),
        });
        fixture.write_credential(PUBLISHER);
        let owner = fixture.open();
        match fixture.metadata(&owner) {
            Ok(metadata) => assert!(matches!(metadata.publisher_person_id("MARKETPLACE_PUBLISHER_ACCOUNT_ID"), Err(Failure::Source(_) ))),
            Err(error) => assert!(matches!(error, Failure::Source(_))),
        }
    }
}

#[test]
fn credential_replacement_withdraws_retained_metadata_even_for_public_operator_lookup() {
    let fixture = Fixture::new(|_, _| {});
    fixture.write_credential(PUBLISHER);
    let owner = fixture.open();
    let metadata = fixture.metadata(&owner).unwrap();
    fs::rename(
        fixture.credentials.join(REFERENCE),
        fixture.credentials.join("prior"),
    )
    .unwrap();
    fixture.write_credential(PUBLISHER);
    assert!(matches!(metadata.assert_current(), Err(Failure::Source(_) )));
    assert!(matches!(metadata.publisher_person_id("OPERATOR_ACCOUNT_ID"), Err(Failure::Source(_) )));
    assert!(matches!(metadata.publisher_person_id("MARKETPLACE_PUBLISHER_ACCOUNT_ID"), Err(Failure::Source(_) )));
}

#[test]
fn receipt_change_during_credential_resolution_withholds_metadata() {
    let fixture = Fixture::new(|_, _| {});
    fixture.write_credential(PUBLISHER);
    let owner = fixture.open();
    let answer = owner.catalog_metadata_with(
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(5),
        |reference| {
            let value = ProtectedBindingIdentity::fixture_in_home(reference, &fixture.credentials)?;
            use std::io::Write;
            fs::OpenOptions::new()
                .append(true)
                .open(fixture.root.join("restore-receipt.json"))
                .unwrap()
                .write_all(b" ")
                .unwrap();
            Ok(value)
        },
    );
    assert!(matches!(answer, Err(Failure::Source(_))));
}

#[test]
fn public_and_protected_placeholder_identity_both_remain_refused() {
    let placeholder = crate::account_source::binding_identity::restore_placeholder_identity().unwrap();
    for public in [true, false] {
        let fixture = Fixture::new(|receipt, rows| {
            if public {
                receipt
                    .as_object_mut()
                    .unwrap()
                    .remove("bindingCredentials");
                receipt["environment"]["MARKETPLACE_PUBLISHER_ACCOUNT_ID"] =
                    json!(placeholder);
            }
            rows[2]["names"] = json!([placeholder]);
        });
        fixture.write_credential(placeholder);
        let owner = fixture.open();
        match fixture.metadata(&owner) {
            Ok(metadata) => assert!(matches!(metadata.publisher_person_id("MARKETPLACE_PUBLISHER_ACCOUNT_ID"), Err(Failure::Source(_) ))),
            Err(error) => assert!(matches!(error, Failure::Source(_))),
        }
    }
}

/// An account made by `account create` names no WORKSHOP_IDENTITY: its shipped rows are the rows of the Workshop copy
/// installed in its state folder, as one part whose BLAKE3 is the identity, with no publisher projected over them. A tool
/// installed later changes the identity, so metadata read before it is no longer current. Nothing is read from the KV
/// for the parts, and nothing from old Trillion.
#[test]
fn a_created_account_takes_its_shipped_rows_from_its_installed_workshop() {
    let temporary = tempfile::tempdir().unwrap();
    let state = fs::canonicalize(temporary.path()).unwrap().join("state");
    let key = crate::secrets::secrets_key::ComputerKey::from_bytes(vec![7u8; 32]).unwrap();
    let created = crate::account::create::create_account(&state, &key, &crate::account::rows::StartingRows::for_tests()).unwrap();
    let install = |tool: &str| {
        let folder = state.join("workshop/tools").join(tool);
        fs::create_dir_all(&folder).unwrap();
        let rows = json!({"records":[{"payload":{"kind":"ai-tool-descriptor","id":format!("tool:{tool}"),"label":tool}}]});
        fs::write(folder.join("tool-rows.json"), serde_json::to_vec(&rows).unwrap()).unwrap();
    };
    let mut owner = LocalAccount::open_selected_after_handoff(created.selection).unwrap();
    let cancel = AtomicBool::new(false);
    let deadline = || Instant::now() + Duration::from_secs(5);

    // Before its first install the account has no tools: an empty catalog, not a refusal.
    let before = owner.catalog_metadata(&cancel, deadline()).unwrap();
    assert_eq!(before.workshop_identity, blake3::hash(b"[]").to_hex().as_str());

    install("first");
    assert!(before.assert_current().is_err(), "an install after the read withdraws the metadata");
    let metadata = owner.catalog_metadata(&cancel, deadline()).unwrap();
    let rows = json!([{"kind":"ai-tool-descriptor","id":"tool:first","label":"first"}]);
    let bytes = serde_json::to_vec(&rows).unwrap();
    let identity = metadata.workshop_identity.clone();
    assert_eq!(identity, blake3::hash(&bytes).to_hex().as_str());
    for setting in PUBLISHER_SETTINGS {
        assert_eq!(metadata.publisher_person_id(setting).unwrap(), None, "no restored publisher shelf");
    }
    let budget = || ReadBudget { bytes: 1 << 20, deadline: deadline() };
    let mut read = |key: &str| owner.catalog_raw_read_observed(&metadata, key, budget(), &cancel, None).unwrap();
    assert_eq!(read(&format!("workshop:rows:{identity}:parts")), Some(b"1".to_vec()));
    assert_eq!(read(&format!("workshop:rows:{identity}:0")), Some(bytes));
    assert_eq!(read(&format!("workshop:rows:{identity}:1")), None);
    assert!(owner
        .catalog_raw_read_observed(&metadata, &format!("workshop:rows:{}:0", "1".repeat(64)), budget(), &cancel, None)
        .is_err(), "only the installed identity's parts are answered");
    metadata.assert_current().unwrap();
    install("second");
    assert!(metadata.assert_current().is_err());
}

/// A receipt that names a publisher but no WORKSHOP_IDENTITY is a torn carried account: it is refused, never read as
/// the installed copy without its publisher.
#[test]
fn a_receipt_with_a_publisher_but_no_identity_is_refused() {
    let fixture = Fixture::new(|receipt, _| {
        receipt["environment"] = json!({"OPERATOR_ACCOUNT_ID": USER});
    });
    let owner = fixture.open();
    assert!(matches!(fixture.metadata(&owner), Err(Failure::Source(_))));
    let fixture = Fixture::new(|receipt, _| {
        receipt.as_object_mut().unwrap().remove("environment");
    });
    let owner = fixture.open();
    assert!(matches!(fixture.metadata(&owner), Err(Failure::Source(_))), "a credential-backed publisher still needs its identity");
}
