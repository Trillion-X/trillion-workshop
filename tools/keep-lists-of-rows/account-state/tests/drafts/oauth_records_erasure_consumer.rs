// Actual selected OAuth read preparation -> mutable canonical field-key owner
// -> final Mac response chunk. Every account, grant, key and byte is synthetic.
use super::oauth_records_consumer_controls::with_generic_records;
use super::oauth_test_support::SyntheticOAuthIssuer;
use super::*;
use crate::{
    legacy_records::StoredRecord,
    local_account::own_records,
    mcp::RequestDisclosure,
    records::{Mutation, Records},
    sqlite_work::WorkMeter,
    storage::record_store_resources,
};
use axum::body::Body;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::sync::Mutex;
use zeroize::Zeroizing;

const SEALED_ID: &str = "oauth-sealed-note";
const PROTECTED_WORDS: &str = "LATE_ERASURE_MUST_WITHHOLD_THIS_PLAINTEXT";

fn sealed_record(record_type: &str, words: &str) -> StoredRecord {
    let key = crate::record_sealed::SecretFieldKey::from_bytes(Zeroizing::new([0x39; 32]));
    let field = crate::record_sealed::prepare::seal(
        &key,
        SEALED_ID,
        &crate::ecma_json::JsString::from("words"),
        &crate::ecma_json::Value::String(words.into()),
        None,
        Default::default(),
    )
    .unwrap();
    let mut value = crate::ecma_json::Object::new();
    value.insert("words".into(), crate::ecma_json::Value::Object(field));
    let record = StoredRecord {
        id: SEALED_ID.into(),
        record_type: record_type.into(),
        sequence: "synthetic-sealed-sequence".into(),
        value_json: crate::ecma_json::stringify(
            &crate::ecma_json::Value::Object(value),
            Default::default(),
        )
        .unwrap(),
        meta_json: None,
        protected_key_present: true,
    };
    record
}

fn sealed_note() -> StoredRecord {
    sealed_record("note", PROTECTED_WORDS)
}

fn prefill_record_in_store(store: &mut impl Records, resource: &str, record: &StoredRecord) {
    for (resource, id, value) in [
        (
            resource,
            record.id.as_str(),
            crate::storage::record_store::native::body(record),
        ),
        (
            own_records::KEYS,
            record.id.as_str(),
            json!({"key": STANDARD.encode([0x39; 32])}),
        ),
    ] {
        store
            .mutate(
                OWNER,
                resource,
                Mutation {
                    id: id.into(),
                    expected_version: 0,
                    request_key: format!("synthetic-sealed-prefill-{resource}"),
                    deleted: false,
                    value,
                },
            )
            .unwrap();
    }
}

fn prefill_sealed_note_in_store(store: &mut impl Records, resource: &str) {
    prefill_record_in_store(store, resource, &sealed_note());
}

fn prefill_sealed_note(fixture: &Fixture) {
    let mut store =
        record_store_resources::open(&fixture.root.join("records.sqlite"), WorkMeter::new()).unwrap();
    prefill_sealed_note_in_store(&mut store, own_records::RESOURCE);
}

/// Install a real source-owned affinity and place the value and key in the
/// resulting verified work resource. The ordinary selected OAuth reader must
/// discover that route through its retained route context.
fn prefill_routed_sealed_note(fixture: &Fixture) -> String {
    prefill_routed_record(fixture, &sealed_note())
}

fn prefill_routed_record(fixture: &Fixture, record: &StoredRecord) -> String {
    use crate::local_account::resource_affinity::{Identity, ResolveRequest};
    let directory = crate::local_account::resource_affinity::store::AffinityDirectory::new(
        &fixture.root, WorkMeter::new(), OWNER, "1",
    ).unwrap();
    let route = directory.install_and_resolve(&ResolveRequest {
        owner: OWNER.into(), generation: "1".into(),
        identities: vec![Identity { kind: "own-record".into(), id: record.id.clone() }],
        group: None,
    }, || Ok(())).unwrap().resource;
    let (_, mut store) = record_store_resources::open_state_resource(&route, &fixture.root, WorkMeter::new()).unwrap();
    prefill_record_in_store(&mut store, own_records::RESOURCE, record);
    route
}

/// The real OAuth preparation returns its value while retaining the separate
/// final-body witness. The test changes the canonical key after this point.
fn prepared(
    fixture: &Fixture,
    issuer: &Arc<SyntheticOAuthIssuer>,
) -> (Body, Principal, Arc<RequestDisclosure>) {
    let owner = Arc::new(Mutex::new(fixture.selected()));
    let bearer = issuer.bearer();
    let identity = issuer
        .authority
        .validate_bearer(
            bearer.as_bytes(),
            millis() as i64,
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
    let principal = Principal {
        account_id: identity.account_id,
        sign_in: identity.sign_in,
        client_id: identity.client_id,
    };
    let disclosure = Arc::new(RequestDisclosure::default());
    let call = Operation { person_present: None,
        resource: "@own-records".into(),
        operation: "records:read".into(),
        request_key: "synthetic-erasure-protected-read".into(),
        input: json!({"id":SEALED_ID,"type":"note"}),
    };
    let value = crate::native_boot::mcp_selected_personal::oauth_records::invoke(
        owner,
        issuer.authority.clone(),
        &route(),
        &principal,
        bearer.as_bytes(),
        call,
        &disclosure,
        Arc::new(|| true),
        Some(Instant::now() + Duration::from_secs(10)),
    )
    .unwrap();
    assert_eq!(
        value["value"]["words"], PROTECTED_WORDS,
        "the reader must have actually opened the sealed field"
    );
    let held = disclosure
        .take()
        .unwrap()
        .expect("the actual final Mac body witness");
    let body = held
        .finish(
            Body::from(value.to_string()),
            &principal,
            Zeroizing::new(bearer.into_bytes()),
            disclosure.clone(),
        )
        .unwrap();
    (body, principal, disclosure)
}

async fn delivered(mut body: Body) -> (Vec<u8>, bool) {
    let mut bytes = Vec::new();
    let mut refused = false;
    while let Some(chunk) =
        std::future::poll_fn(|cx| http_body::Body::poll_frame(std::pin::Pin::new(&mut body), cx))
            .await
    {
        match chunk {
            Ok(chunk) => {
                if let Some(data) = chunk.data_ref() {
                    bytes.extend_from_slice(data);
                }
            }
            Err(_) => {
                refused = true;
                break;
            }
        }
    }
    (bytes, refused)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_generic_read_withholds_a_prepared_field_erased_before_final_mac_chunk() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    prefill_sealed_note(&fixture);
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let (body, principal, _disclosure) = prepared(&fixture, &issuer);
    let mut store =
        record_store_resources::open(&fixture.root.join("records.sqlite"), WorkMeter::new()).unwrap();
    store
        .mutate(
            OWNER,
            own_records::KEYS,
            Mutation {
                id: SEALED_ID.into(),
                expected_version: 1,
                request_key: "synthetic-key-erased-after-read".into(),
                deleted: false,
                value: json!({"erased":true}),
            },
        )
        .unwrap();
    drop(store);
    let still_valid = issuer
        .authority
        .validate_bearer(
            issuer.bearer().as_bytes(),
            millis() as i64,
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(
        still_valid.sign_in, principal.sign_in,
        "the grant stays current; the field key alone changed"
    );
    let (bytes, refused) = delivered(body).await;
    assert!(
        !String::from_utf8_lossy(&bytes).contains(PROTECTED_WORDS),
        "an erased field escaped from a value prepared before erasure"
    );
    assert!(
        refused,
        "the original protected chunk must be withheld after its key changes"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_generic_read_keeps_its_snapshot_when_only_an_unrelated_record_changes() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    prefill_sealed_note(&fixture);
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let (body, _, _disclosure) = prepared(&fixture, &issuer);
    let record = StoredRecord {
        id: "unrelated-after-read".into(),
        record_type: "note".into(),
        sequence: "unrelated-sequence".into(),
        value_json: json!({"words":"unrelated"}).to_string(),
        meta_json: None,
        protected_key_present: false,
    };
    let mut store =
        record_store_resources::open(&fixture.root.join("records.sqlite"), WorkMeter::new()).unwrap();
    store
        .mutate(
            OWNER,
            own_records::RESOURCE,
            Mutation {
                id: record.id.clone(),
                expected_version: 0,
                request_key: "synthetic-unrelated-after-read".into(),
                deleted: false,
                value: crate::storage::record_store::native::body(&record),
            },
        )
        .unwrap();
    drop(store);
    let (bytes, refused) = delivered(body).await;
    assert!(
        !refused,
        "an unrelated write must not withdraw the key of the prepared record"
    );
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["value"]["words"], PROTECTED_WORDS);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_routed_generic_read_withholds_a_field_erased_before_final_mac_chunk() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let resource = prefill_routed_sealed_note(&fixture);
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let (body, _, _disclosure) = prepared(&fixture, &issuer);

    let (_, mut store) = record_store_resources::open_state_resource(&resource, &fixture.root, WorkMeter::new()).unwrap();
    store.mutate(OWNER, own_records::KEYS, Mutation {
        id: SEALED_ID.into(), expected_version: 1,
        request_key: "synthetic-routed-key-erased-after-read".into(),
        deleted: false, value: json!({"erased":true}),
    }).unwrap();
    drop(store);

    let (bytes, refused) = delivered(body).await;
    assert!(!String::from_utf8_lossy(&bytes).contains(PROTECTED_WORDS),
        "an erased routed field escaped from a value prepared before erasure");
    assert!(refused, "the routed protected chunk must be withheld after its key changes");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_routed_generic_read_keeps_its_snapshot_after_an_unrelated_shard_write() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let resource = prefill_routed_sealed_note(&fixture);
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let (body, _, _disclosure) = prepared(&fixture, &issuer);

    let unrelated = StoredRecord {
        id: "unrelated-routed-after-read".into(), record_type: "note".into(),
        sequence: "unrelated-routed-sequence".into(), value_json: json!({"words":"unrelated"}).to_string(),
        meta_json: None, protected_key_present: false,
    };
    let (_, mut store) = record_store_resources::open_state_resource(&resource, &fixture.root, WorkMeter::new()).unwrap();
    store.mutate(OWNER, own_records::RESOURCE, Mutation {
        id: unrelated.id.clone(), expected_version: 0,
        request_key: "synthetic-unrelated-routed-after-read".into(),
        deleted: false, value: crate::storage::record_store::native::body(&unrelated),
    }).unwrap();
    drop(store);

    let (bytes, refused) = delivered(body).await;
    assert!(!refused, "an unrelated write to the key's shard must not withdraw it");
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["value"]["words"], PROTECTED_WORDS);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_routed_kind_check_and_answer_share_one_record_snapshot() {
    const PUBLIC_WORDS: &str = "PUBLIC_NOTE_SNAPSHOT";
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    let resource = prefill_routed_record(&fixture, &sealed_record("note", PUBLIC_WORDS));
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let bearer = issuer.bearer();
    let identity = issuer.authority.validate_bearer(
        bearer.as_bytes(), millis() as i64, Instant::now() + Duration::from_secs(10),
    ).unwrap();
    let principal = Principal {
        account_id: identity.account_id,
        sign_in: identity.sign_in,
        client_id: identity.client_id,
    };
    let owner = Arc::new(Mutex::new(fixture.selected()));
    let disclosure = Arc::new(RequestDisclosure::default());
    let call = Operation { person_present: None,
        resource: "@own-records".into(), operation: "records:read".into(),
        request_key: "synthetic-routed-kind-race".into(), input: json!({"id":SEALED_ID}),
    };
    let mut changed = sealed_record("voice-print", PROTECTED_WORDS);
    changed.sequence = "synthetic-routed-restricted-sequence".into();
    let answer = crate::native_boot::mcp_selected_personal::oauth_records::invoke_projection(
        owner.clone(),
        issuer.authority.clone(),
        &route(),
        &principal,
        bearer.as_bytes(),
        call,
        &disclosure,
        Arc::new(|| true),
        Some(Instant::now() + Duration::from_secs(10)),
        |read, operation, _| read.read_with_kind_interpose(operation, true, || {
            let (_, mut store) = record_store_resources::open_state_resource(&resource, &fixture.root, WorkMeter::new()).unwrap();
            store.mutate(OWNER, own_records::RESOURCE, Mutation {
                id: SEALED_ID.into(), expected_version: 1,
                request_key: "synthetic-note-became-device-only".into(),
                deleted: false, value: crate::storage::record_store::native::body(&changed),
            }).unwrap();
        }).map_err(crate::native_boot::mcp_local::personal_refusal),
    ).unwrap();

    assert_eq!(answer["type"], "note");
    assert_eq!(answer["value"]["words"], PUBLIC_WORDS,
        "answer must use the record the device-only check admitted");
    assert!(!answer.to_string().contains(PROTECTED_WORDS),
        "the newly restricted record's content must not enter the admitted answer");

    let custody = disclosure.take().unwrap().expect("selected OAuth final-body custody");
    let body = custody.finish(
        Body::from(answer.to_string()), &principal, Zeroizing::new(bearer.clone().into_bytes()), disclosure,
    ).unwrap();
    let (bytes, refused) = delivered(body).await;
    assert!(!refused);
    let delivered: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(delivered["value"]["words"], PUBLIC_WORDS);

    let fresh_call = Operation { person_present: None,
        resource: "@own-records".into(), operation: "records:read".into(),
        request_key: "synthetic-routed-device-only-current-read".into(), input: json!({"id":SEALED_ID}),
    };
    let fresh = crate::native_boot::mcp_selected_personal::oauth_records::invoke(
        owner, issuer.authority.clone(), &route(), &principal, bearer.as_bytes(), fresh_call,
        &RequestDisclosure::default(), Arc::new(|| true), Some(Instant::now() + Duration::from_secs(10)),
    );
    assert!(fresh.is_err(), "a fresh read must refuse the now device-only routed record");
}

#[test]
fn oauth_generic_physical_key_check_has_no_later_parent_source_callback() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    prefill_sealed_note(&fixture);
    let armed = Arc::new(AtomicBool::new(false));
    let callbacks = Arc::new(AtomicUsize::new(0));
    let root = fixture.root.clone();
    let parent = {
        let armed = armed.clone();
        let callbacks = callbacks.clone();
        Arc::new(move || {
            if armed.load(Ordering::Acquire) && callbacks.fetch_add(1, Ordering::AcqRel) == 1 {
                // A remote/share source owner can change a canonical field
                // key while checking its own currentness. Such a callback
                // must never run after the reader's physical key check.
                let mut store = record_store_resources::open(&root.join("records.sqlite"), WorkMeter::new()).unwrap();
                store.mutate(OWNER, own_records::KEYS, Mutation {
                    id: SEALED_ID.into(), expected_version: 1,
                    request_key: "synthetic-parent-after-key-fence".into(),
                    deleted: false, value: json!({"erased":true}),
                }).unwrap();
            }
            true
        })
    };
    let mut selected = fixture.selected();
    let read = crate::native_boot::mcp_selected_personal::workspace_read::AdmittedRecordsRead::for_checked_owner(
        &mut selected.owner, Arc::new(AtomicBool::new(false)),
        Instant::now() + Duration::from_secs(10), parent,
    ).unwrap();
    let answer = read.read(&Operation { person_present: None,
        resource: "@own-records".into(), operation: "records:read".into(),
        request_key: "synthetic-parent-callback-key-read".into(),
        input: json!({"id":SEALED_ID,"type":"note"}),
    }, true).unwrap();
    assert_eq!(answer["value"]["words"], PROTECTED_WORDS);
    armed.store(true, Ordering::Release);
    read.confirm_checked_owner(&mut selected.owner).unwrap();
    assert_eq!(callbacks.load(Ordering::Acquire), 1,
        "parent/source currentness must precede the exact final field-key check");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_generic_read_refuses_a_recreated_different_key_even_when_its_version_restarts() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    prefill_sealed_note(&fixture);
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let (body, _, _disclosure) = prepared(&fixture, &issuer);
    let mut store =
        record_store_resources::open(&fixture.root.join("records.sqlite"), WorkMeter::new()).unwrap();
    assert!(
        store
            .erase(OWNER, own_records::KEYS, SEALED_ID)
            .unwrap()
            .is_some()
    );
    // erase() preserves the CAS tombstone during the undo window. Advance
    // only this synthetic record store clock and run its real retirement owner before
    // recreating the identity; no direct SQL deletion bypasses that owner.
    drop(store);
    struct AfterUndoWindow(u64);
    impl crate::storage::record_store::Clock for AfterUndoWindow {
        fn now_ms(&self) -> i64 { self.0 }
    }
    let path = fixture.root.join("records.sqlite");
    let supply = crate::storage::sqlite::open_owned(
        &path, "record_store", crate::storage::sqlite::Bounds {
            value_bytes: 64 * 1024 * 1024, work: u64::MAX / 2,
            deadline: Duration::MAX, spend: crate::storage::sqlite::Spend::EachOperation,
            cancel: None, busy: Duration::from_secs(5),
        },
    ).unwrap();
    let limits = record_store_resources::native_limits(&supply, &path).unwrap();
    let after = millis() + crate::storage::record_store::settings::shipped().unwrap().undo_windows.records + 60_000;
    let mut store = crate::storage::record_store::RecordStore::new(supply, Box::new(AfterUndoWindow(after)), limits).unwrap();
    while store.retire(OWNER, own_records::KEYS).unwrap() > 0 {}
    assert_eq!(store.held_version(OWNER, own_records::KEYS, SEALED_ID).unwrap(), 0,
        "the actual retirement owner must remove the expired tombstone");
    store
        .mutate(
            OWNER,
            own_records::KEYS,
            Mutation {
                id: SEALED_ID.into(),
                expected_version: 0,
                request_key: "synthetic-erased-key-recreated-different".into(),
                deleted: false,
                value: json!({"key": STANDARD.encode([0x47; 32])}),
            },
        )
        .unwrap();
    assert_eq!(
        store
            .held_version(OWNER, own_records::KEYS, SEALED_ID)
            .unwrap(),
        1,
        "the replacement deliberately has the same numeric version as the original key"
    );
    drop(store);
    let (bytes, refused) = delivered(body).await;
    assert!(
        !String::from_utf8_lossy(&bytes).contains(PROTECTED_WORDS),
        "a version-only comparison released plaintext after the opening key changed"
    );
    assert!(
        refused,
        "the changed key identity must withhold the original prepared chunk"
    );
}

/// This fixture forwards the already prepared REAL selected-account body into
/// the typed delegation wrapper. It introduces no replacement record reader.
struct ActualPreparedBody {
    body: Body,
    principal: Principal,
    bearer: Zeroizing<Vec<u8>>,
}
impl crate::mcp::FinalBodyCustody for ActualPreparedBody {
    fn finish(
        self: Box<Self>,
        _: Body,
        principal: &Principal,
        bearer: Zeroizing<Vec<u8>>,
        _: Arc<dyn Send + Sync>,
    ) -> Result<Body, crate::refusal_cause::CodedError<()>> {
        if principal != &self.principal || bearer.as_slice() != self.bearer.as_slice() {
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        Ok(self.body)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_generic_erasure_guard_survives_the_typed_share_body_wrapper() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    prefill_sealed_note(&fixture);
    let issuer = Arc::new(SyntheticOAuthIssuer::new(&fixture));
    let (inner, parent, _inner_disclosure) = prepared(&fixture, &issuer);
    let child = RequestDisclosure::default();
    child.register(Box::new(ActualPreparedBody {
        body: inner,
        principal: parent.clone(),
        bearer: Zeroizing::new(issuer.bearer().into_bytes()),
    })).unwrap();
    let outer = Arc::new(RequestDisclosure::default());
    let recipient = Principal {
        account_id: parent.account_id.clone(),
        sign_in: "synthetic-share-recipient".into(),
        client_id: "synthetic-share-client".into(),
    };
    let call = Operation { person_present: None,
        resource: "@own-records".into(),
        operation: "records:read".into(),
        request_key: "synthetic-erasure-protected-read".into(),
        input: json!({"id":SEALED_ID,"type":"note"}),
    };
    // The grant proof is synthetic; exact principal/bearer/call binding is the
    // production typed transfer. The nested body retains the actual selected
    // OAuth authority and physical-key witness constructed above.
    let proof = crate::mcp::ShareActProof::admitted(
        &recipient, b"synthetic-share-bearer", &parent, issuer.bearer().as_bytes(),
        &call, Arc::new(|| true),
    );
    proof.transfer(&call, &child, &outer).unwrap();
    let body = outer.take().unwrap().unwrap().finish(
        Body::empty(), &recipient, Zeroizing::new(b"synthetic-share-bearer".to_vec()), outer.clone(),
    ).unwrap();
    let mut store = record_store_resources::open(&fixture.root.join("records.sqlite"), WorkMeter::new()).unwrap();
    store.mutate(OWNER, own_records::KEYS, Mutation {
        id: SEALED_ID.into(), expected_version: 1,
        request_key: "synthetic-key-erased-before-shared-frame".into(),
        deleted: false, value: json!({"erased":true}),
    }).unwrap();
    drop(store);
    let (bytes, refused) = delivered(body).await;
    assert!(!String::from_utf8_lossy(&bytes).contains(PROTECTED_WORDS),
        "the outer share wrapper released plaintext refused by the selected key owner");
    assert!(refused, "typed delegation must preserve the real protected inner body's refusal");
}

fn personal_prepared(fixture: &Fixture) -> Body {
    use crate::mcp::CallAnswerer;
    let principal = fixture.principal();
    let owner = Arc::new(Mutex::new(fixture.selected()));
    let local = crate::native_boot::mcp_local::LocalSelectedMcp::new(owner);
    let disclosure = Arc::new(RequestDisclosure::default());
    let value = local.invoke_with_disclosure(
        &principal, fixture.token.as_bytes(), Operation { person_present: None,
            resource: "@own-records".into(), operation: "records:read".into(),
            request_key: "synthetic-personal-protected-read".into(),
            input: json!({"id":SEALED_ID,"type":"note"}),
        }, &disclosure,
    ).unwrap();
    assert_eq!(value["value"]["words"], PROTECTED_WORDS,
        "the actual personal reader must have opened the sealed field");
    disclosure.take().unwrap().expect("actual personal final-body custody").finish(
        Body::from(value.to_string()), &principal,
        Zeroizing::new(fixture.token.as_bytes().to_vec()), disclosure.clone(),
    ).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn personal_generic_guarded_body_withholds_a_prepared_erased_field() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    prefill_sealed_note(&fixture);
    let body = personal_prepared(&fixture);
    let mut store = record_store_resources::open(&fixture.root.join("records.sqlite"), WorkMeter::new()).unwrap();
    store.mutate(OWNER, own_records::KEYS, Mutation {
        id: SEALED_ID.into(), expected_version: 1,
        request_key: "synthetic-personal-field-erased-before-frame".into(),
        deleted: false, value: json!({"erased":true}),
    }).unwrap();
    drop(store);
    let (bytes, refused) = delivered(body).await;
    assert!(!String::from_utf8_lossy(&bytes).contains(PROTECTED_WORDS),
        "personal Guarded released plaintext after its canonical field key was erased");
    assert!(refused, "the actual personal final-body guard must withhold the prepared chunk");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn personal_generic_guarded_body_keeps_snapshot_after_an_unrelated_commit() {
    let fixture = with_generic_records(Fixture::new_with_oauth_grant());
    prefill_sealed_note(&fixture);
    let body = personal_prepared(&fixture);
    let unrelated = StoredRecord {
        id: "personal-unrelated-after-read".into(), record_type: "note".into(),
        sequence: "personal-unrelated-sequence".into(),
        value_json: json!({"words":"unrelated"}).to_string(),
        meta_json: None, protected_key_present: false,
    };
    let mut store = record_store_resources::open(&fixture.root.join("records.sqlite"), WorkMeter::new()).unwrap();
    store.mutate(OWNER, own_records::RESOURCE, Mutation {
        id: unrelated.id.clone(), expected_version: 0,
        request_key: "synthetic-personal-unrelated-before-frame".into(),
        deleted: false, value: crate::storage::record_store::native::body(&unrelated),
    }).unwrap();
    drop(store);
    let (bytes, refused) = delivered(body).await;
    assert!(!refused, "an unrelated commit must preserve the personal reader's admitted snapshot");
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["value"]["words"], PROTECTED_WORDS);
}
