//! Concurrent HTTP reads keep the same selected account and wait for its mutex.
//! Request admission waits for the same owner before it takes a current read.
//! Records, heads and show-rules retain their actual owner-backed delivery
//! witnesses in the body. These controls distinguish request admission from
//! first-chunk delivery. All account files and credentials are fixtures.
use super::*;
#[cfg(feature = "exact-native-locale")]
use content_crypto::advanced::blake3;
use http_body::Body as _;
use std::{future::poll_fn, pin::Pin, task::Poll, time::Duration};
use trillion_local::kept_runs::{KeptRuns, Settings as KeptSettings};

async fn pending_chunk(body: &mut Body) {
    let first = poll_fn(|cx| Poll::Ready(Pin::new(&mut *body).poll_frame(cx))).await;
    assert!(
        first.is_pending(),
        "temporary same-owner contention must keep the chunk pending"
    );
}
async fn refuse_first_chunk(mut body: Body) {
    let chunk = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await;
    assert!(
        matches!(chunk, Some(Err(_))),
        "changed authority must withhold the first private chunk"
    );
    assert!(
        poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
            .await
            .is_none()
    );
}
fn install_heads(f: &Fixture) {
    let db = Connection::open(&f.records).unwrap();
    db.execute_batch("CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT);
        CREATE TABLE record_erasable_keys(record_id TEXT PRIMARY KEY,key BLOB,erased_at TEXT,erased_fields TEXT);").unwrap();
    let tx = db.unchecked_transaction().unwrap();
    let mut runs = KeptRuns::create(&tx, "record_keys", KeptSettings::default()).unwrap();
    tx.execute(
        "INSERT INTO record_keys_meta(key,value) VALUES('engine','\"record-log\"')",
        [],
    )
    .unwrap();
    runs.put(
        "i\0told-the-person",
        json!(["kept-list","told-sequence",{"items":[{"seq":8}]}]),
    )
    .unwrap();
    runs.flush(&tx, &json!(0)).unwrap();
    tx.execute("INSERT INTO record_log(id,transaction_id,actor_context,application_time,system_time,part,parts,envelopes) VALUES('01234567-89ab-7cde-8f01-234567890abc','fixture-head','{}','valid','system',0,1,'[]')",[]).unwrap();
    tx.commit().unwrap();
}
#[tokio::test]
async fn owner_contention_requests_wait_then_viewer_and_records_succeed_together() {
    let f = Fixture::new_with_viewer(&[("contention-record", "true")], Some(VIEWER_PROGRAMS));
    let held = f.owner.lock().unwrap();
    let viewer = f
        .app
        .clone()
        .oneshot(request("GET", "/work/api/viewer", None));
    let records = f.app.clone().oneshot(request(
        "GET",
        "/work/api/records?label=contention-record",
        None,
    ));
    let reads = async {
        tokio::join!(
            async {
                let r = viewer.await.unwrap();
                let status = r.status();
                (status, to_bytes(r.into_body(), 1024 * 1024).await)
            },
            async {
                let r = records.await.unwrap();
                let status = r.status();
                (status, to_bytes(r.into_body(), 1024 * 1024).await)
            }
        )
    };
    tokio::pin!(reads);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut reads)
            .await
            .is_err(),
        "held actual owner must keep admitted reads pending"
    );
    drop(held);
    let ((viewer_status, viewer), (record_status, records)) = reads.await;
    assert_eq!(viewer_status, StatusCode::OK);
    assert_eq!(record_status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&viewer.unwrap()).unwrap()["user_id"],
        f.user
    );
    assert!(
        String::from_utf8(records.unwrap().to_vec())
            .unwrap()
            .contains("contention-record")
    );
}
#[tokio::test]
async fn owner_contention_record_admission_wait_rechecks_selected_adoption() {
    {
        let f = Fixture::new(&[("private-contention-canary", "true")]);
        let held = f.owner.lock().unwrap();
        let read = f.app.clone().oneshot(request(
            "GET",
            "/work/api/records?label=private-contention-canary",
            None,
        ));
        tokio::pin!(read);
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut read)
                .await
                .is_err(),
            "record admission must wait for the retained selected owner"
        );
        // This is the already installed Selection's descriptor. Replacing
        // a records file before the first snapshot is not the same as
        // changing a source whose current incarnation was already read.
        let descriptor = f._temp.path().join("adoption.json");
        let mut bytes = fs::read(&descriptor).unwrap();
        bytes.push(b' ');
        fs::write(&descriptor, bytes).unwrap();
        drop(held);
        let response = read.await.unwrap();
        assert_ne!(
            response.status(),
            StatusCode::OK,
            "changed installed adoption descriptor during admission wait must refuse the record snapshot"
        );
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("private-contention-canary"));
    }
}
#[tokio::test]
async fn owner_contention_prepared_heads_wait_then_deliver_original_head_values() {
    let f = Fixture::new(&[]);
    install_heads(&f);
    let response = f
        .app
        .clone()
        .oneshot(request("GET", "/work/api/screen-revision", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    let held = f.owner.lock().unwrap();
    pending_chunk(&mut body).await;
    drop(held);
    let bytes = to_bytes(body, 65536).await.unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["heads"]["told"], 8);
    assert_eq!(value["heads"]["records"], own_records_stamp(&f.records));
}
#[tokio::test]
async fn owner_contention_cancelled_permit_during_heads_body_wait_refuses_even_while_held() {
    let f = Fixture::new(&[]);
    install_heads(&f);
    let response = f
        .app
        .clone()
        .oneshot(request("GET", "/work/api/screen-revision", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let context = f.adapter.head_context.lock().unwrap().take().unwrap();
    let mut body = response.into_body();
    let held = f.owner.lock().unwrap();
    pending_chunk(&mut body).await;
    context.permit.cancel();
    refuse_first_chunk(body).await;
    drop(held);
}
#[cfg(feature = "exact-native-locale")]
fn locale_workspace(f: &Fixture) -> (Router, Arc<ExecutorAdapter>) {
    let path = std::env::var_os("TRILLION_TEST_ICU_PROFILE")
        .expect("explicit native locale control requires qualified ICU profile");
    let profile: trillion_local::tool_label_locale::Profile =
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let locale = Arc::new(trillion_local::tool_label_locale::open(&profile).unwrap());
    let settings =
        WorkspaceSessionSettings::from_source(SETTINGS, blake3::hash(SETTINGS).to_hex().as_str())
            .unwrap();
    let sessions = WorkspaceSessions::new(f.owner.clone(), ORIGIN, settings).unwrap();
    let local = Arc::new(
        LocalWorkspace::new(f.owner.clone(), sessions.clone())
            .unwrap()
            .with_show_rules(locale),
    );
    let adapter = Arc::new(ExecutorAdapter {
        inner: local,
        input_override: Mutex::new(None),
        operation_override: Mutex::new(None),
        head_context: Mutex::new(None),
    });
    let first=br#"{"paths":{},"workspace_records_path":"/work/api/records","startup_record_inputs":[],"startup_preferences":[],"screen_revision":"/work/api/screen-revision","screens":{},"item_reads":{"screens":{}}}"#;
    let operations = CanonicalWorkspace::new(
        OwnerRoutes::from_source(OWNER_ROUTES, blake3::hash(OWNER_ROUTES).to_hex().as_str())
            .unwrap(),
        StartupContract::from_sources(
            first,
            blake3::hash(first).to_hex().as_str(),
            b"{}",
            blake3::hash(b"{}").to_hex().as_str(),
        )
        .unwrap(),
        adapter.clone(),
        None,
    );
    let root = f._temp.path().join("assets");
    let manifest = fs::read(root.join("workspace/files.json")).unwrap();
    let assets = WorkspaceAssets::open(
        &root,
        blake3::hash(&manifest).to_hex().as_str(),
        &tree_pin(&root),
    )
    .unwrap();
    let app = workspace::route_table(
        Arc::new(assets),
        WorkspaceSupplies {
            sessions: Some(Arc::new(sessions)),
            operations: Some(Arc::new(operations)),
            live: None,
            dom: WorkspaceDom::from_source(DOM, blake3::hash(DOM).to_hex().as_str()).unwrap(),
        },
        WorkspaceLimits::default(),
    )
    .unwrap();
    (app, adapter)
}
#[cfg(feature = "exact-native-locale")]
#[tokio::test]
#[ignore = "native explicitly selects with its qualified pinned ICU profile"]
async fn owner_contention_three_real_startup_gets_wait_then_all_succeed() {
    let f = Fixture::new_with_viewer(
        &[
            (
                "show-rules",
                r#"{"rules":[{"id":"contention-rule","subject":"control","effect":"hide","when":null,"on":true}]}"#,
            ),
            ("contention-record", "true"),
        ],
        Some(VIEWER_PROGRAMS),
    );
    let (app, _adapter) = locale_workspace(&f);
    let held = f.owner.lock().unwrap();
    let read = |path: &'static str| {
        let app = app.clone();
        async move {
            let response = app.oneshot(request("GET", path, None)).await.unwrap();
            let status = response.status();
            (
                status,
                to_bytes(response.into_body(), 8 * 1024 * 1024).await,
            )
        }
    };
    let reads = async {
        tokio::join!(
            read("/work/api/viewer"),
            read("/work/api/records?label=contention-record"),
            read("/work/api/show-rules")
        )
    };
    tokio::pin!(reads);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut reads)
            .await
            .is_err()
    );
    drop(held);
    let (viewer, records, rules) = reads.await;
    assert_eq!(viewer.0, StatusCode::OK);
    assert_eq!(records.0, StatusCode::OK);
    assert_eq!(rules.0, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&viewer.1.unwrap()).unwrap()["user_id"],
        f.user
    );
    assert!(
        String::from_utf8(records.1.unwrap().to_vec())
            .unwrap()
            .contains("contention-record")
    );
    let rules: Value = serde_json::from_slice(&rules.1.unwrap()).unwrap();
    assert_eq!(rules["authority"], "operator");
    assert!(
        rules["rules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|rule| rule["id"] == "contention-rule")
    );
}
#[cfg(feature = "exact-native-locale")]
#[tokio::test]
#[ignore = "native explicitly selects with its qualified pinned ICU profile"]
async fn owner_contention_show_rules_body_waits_then_rechecks_cancel() {
    for action in ["deliver", "cancel"] {
        let f = Fixture::new_with_viewer(
            &[(
                "show-rules",
                r#"{"rules":[{"id":"contention-rule","subject":"control","effect":"hide","when":null,"on":true}]}"#,
            )],
            Some(VIEWER_PROGRAMS),
        );
        let (app, adapter) = locale_workspace(&f);
        let response = app
            .oneshot(request("GET", "/work/api/show-rules", None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let context = adapter.head_context.lock().unwrap().take().unwrap();
        let mut body = response.into_body();
        let held = f.owner.lock().unwrap();
        pending_chunk(&mut body).await;
        if action == "cancel" {
            context.permit.cancel();
            refuse_first_chunk(body).await;
            drop(held);
            continue;
        }
        drop(held);
        let bytes = to_bytes(body, 8 * 1024 * 1024).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(
            value["rules"]
                .as_array()
                .unwrap()
                .iter()
                .any(|rule| rule["id"] == "contention-rule")
        );
    }
}
#[cfg(feature = "exact-native-locale")]
#[tokio::test]
#[ignore = "native explicitly selects with its qualified pinned ICU profile"]
async fn owner_contention_expired_ready_show_rules_body_does_not_gain_a_new_deadline() {
    let f = Fixture::new_with_viewer(&[], Some(VIEWER_PROGRAMS));
    let (app, _adapter) = locale_workspace(&f);
    let response = app
        .oneshot(request("GET", "/work/api/show-rules", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // The account's original prepared witness has a two-second deadline. A
    // brand new OwnerWait at first poll must not extend that existing deadline.
    tokio::time::sleep(Duration::from_millis(2100)).await;
    refuse_first_chunk(response.into_body()).await;
}

#[tokio::test]
async fn owner_contention_expired_ready_heads_keep_the_original_delivery_deadline() {
    let f = Fixture::new(&[]);
    install_heads(&f);
    let response = f
        .app
        .clone()
        .oneshot(request("GET", "/work/api/screen-revision", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // This witness was prepared with the original five-second heads deadline.
    // Delay its FIRST poll: a fresh wait helper must not renew prepared authority.
    tokio::time::sleep(Duration::from_millis(5100)).await;
    refuse_first_chunk(response.into_body()).await;
}

// Formerly known-bad opposing controls. Activate only with the complete
// selected-source records delivery guard mounted by this patch.
#[tokio::test]
async fn known_bad_prepared_records_body_must_withhold_after_permit_cancellation() {
    let f = Fixture::new(&[("private-delivery-canary", "true")]);
    let response = f
        .app
        .clone()
        .oneshot(request(
            "GET",
            "/work/api/records?label=private-delivery-canary",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let context = f.adapter.head_context.lock().unwrap().take().unwrap();
    context.permit.cancel();
    refuse_first_chunk(response.into_body()).await;
}
