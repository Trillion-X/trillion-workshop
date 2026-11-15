// Include from tests/local_workspace.rs after native route integration.
// Purpose: Exercise fatal-bootstrap show-rules rejection through the real
// workspace route table and canonical executor using only the existing synthetic
// LocalAccount fixture, which deliberately has no show-rules sources.
// Invariant: missing owner sources never become an empty successful response.

use super::*;
use content_crypto::advanced::blake3;

fn show_rules_route_table(fixture: &Fixture) -> Router {
    // The show-rules DATA is the installed Workshop's (src/local_account/show_rules/data.json), as for every account.
    super::workshop_data::install_show_rules_data(fixture.records.parent().unwrap());
    // Native explicitly supplies its already-qualified public ICU profile.
    // This never substitutes a fixture collation for production text behavior.
    let profile_path = std::env::var_os("TRILLION_TEST_ICU_PROFILE")
        .expect("Native must supply the qualified ICU profile for this explicit control");
    let profile: trillion_local::tool_label_locale::Profile =
        serde_json::from_slice(&fs::read(profile_path).unwrap()).unwrap();
    let locale = Arc::new(trillion_local::tool_label_locale::open(&profile).unwrap());
    let settings =
        WorkspaceSessionSettings::from_source(SETTINGS, blake3::hash(SETTINGS).to_hex().as_str())
            .unwrap();
    let sessions = WorkspaceSessions::new(fixture.owner.clone(), ORIGIN, settings).unwrap();
    let local = Arc::new(
        LocalWorkspace::new(fixture.owner.clone(), sessions.clone())
            .unwrap()
            .with_show_rules(locale),
    );
    let routes =
        OwnerRoutes::from_source(OWNER_ROUTES, blake3::hash(OWNER_ROUTES).to_hex().as_str())
            .unwrap();
    let first = br#"{"paths":{},"workspace_records_path":"/work/api/records","startup_record_inputs":[],"startup_preferences":[],"screen_revision":"/work/api/screen-revision","screens":{},"item_reads":{"screens":{}}}"#;
    let startup = StartupContract::from_sources(
        first,
        blake3::hash(first).to_hex().as_str(),
        b"{}",
        blake3::hash(b"{}").to_hex().as_str(),
    )
    .unwrap();
    let operations = Arc::new(CanonicalWorkspace::new(routes, startup, local, None));
    let root = fixture._temp.path().join("assets");
    let manifest = fs::read(root.join("workspace/files.json")).unwrap();
    let assets = Arc::new(
        WorkspaceAssets::open(
            &root,
            blake3::hash(&manifest).to_hex().as_str(),
            &tree_pin(&root),
        )
        .unwrap(),
    );
    workspace::route_table(
        assets,
        WorkspaceSupplies {
            sessions: Some(Arc::new(sessions)),
            operations: Some(operations),
            live: None,
            dom: WorkspaceDom::from_source(DOM, blake3::hash(DOM).to_hex().as_str()).unwrap(),
        },
        WorkspaceLimits::default(),
    )
    .unwrap()
}

#[tokio::test]
#[ignore = "Native explicitly selects this with its qualified pinned ICU profile"]
async fn actual_show_rules_http_returns_original_shape_for_a_known_operator() {
    // The original fixture explicitly declares OPERATOR_ACCOUNT_ID=USER.
    // This source-specific rule must survive the actual owner and HTTP path;
    // a default response with no rules cannot satisfy this positive control.
    let fixture = Fixture::new_with_viewer(
        &[(
            "show-rules",
            r#"{"rules":[{"id":"actual-http-source","subject":"control","effect":"hide","when":null,"on":true}]}"#,
        )],
        Some(VIEWER_PROGRAMS),
    );
    let app = show_rules_route_table(&fixture);
    let response = app
        .oneshot(request("GET", "/work/api/show-rules", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["authority"], "operator");
    assert!(
        value["rules"]
            .as_array()
            .is_some_and(|rules| { rules.iter().any(|rule| rule["id"] == "actual-http-source") })
    );
    assert!(
        value["subjects"]
            .as_object()
            .is_some_and(|rows| !rows.is_empty())
    );
    assert!(
        value["operators"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
    );
    assert!(value["controls"].is_array() || value["controls"].is_object());
}

#[tokio::test]
#[ignore = "Native explicitly selects this with its qualified pinned ICU profile"]
async fn prepared_show_rules_withholds_body_after_workspace_source_changes() {
    let fixture = Fixture::new_with_viewer(&[], Some(VIEWER_PROGRAMS));
    let app = show_rules_route_table(&fixture);
    let response = app
        .oneshot(request("GET", "/work/api/show-rules", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // This known source changes after preparation but before the first body
    // chunk. The same engine might project identical visible rules; the old
    // source witness must nevertheless withhold that prepared response.
    crate::workspace_put(&fixture.records, "show-rules", Some(r#"{"rules":[]}"#));
    assert!(
        to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .is_err()
    );
}

#[tokio::test]
#[ignore = "Native explicitly selects this with its qualified pinned ICU profile"]
async fn prepared_show_rules_withholds_body_after_current_policy_check() {
    let fixture = Fixture::new_with_viewer(&[], Some(VIEWER_PROGRAMS));
    let app = show_rules_route_table(&fixture);
    let response = app
        .oneshot(request("GET", "/work/api/show-rules", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let gate = fixture._temp.path().join("state/browser-gate.sqlite");
    let db = Connection::open(gate).unwrap();
    let changed = db
        .execute(
            "UPDATE policy_directory SET value='\"fixture-policy-fence\"' WHERE name='fence'",
            [],
        )
        .unwrap();
    assert_eq!(changed, 1);
    drop(db);
    assert!(
        to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn show_rules_missing_owner_source_does_not_fall_back_to_empty_success() {
    let fixture = Fixture::new(&[]);
    let response = fixture
        .app
        .clone()
        .oneshot(request("GET", "/work/api/show-rules", None))
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert_ne!(body.as_ref(), br#"{"rules":[]}"#);
    assert_ne!(body.as_ref(), br#"{}"#);
}

#[tokio::test]
async fn show_rules_unsupported_method_is_refused() {
    let fixture = Fixture::new(&[]);
    let response = fixture
        .app
        .clone()
        .oneshot(request("POST", "/work/api/show-rules", Some("{}")))
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::OK);
}

