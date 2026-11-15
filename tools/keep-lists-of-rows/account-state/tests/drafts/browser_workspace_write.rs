// Included below the existing selected producer fixture. All credentials and
// saved sessions here are explicit synthetic supplies, never the real account.
use super::*;
use content_crypto::advanced::blake3;
use crate::{account, workspace::WorkspaceSession, workspace_domain::DomainCommand};

mod connection_management_http {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/mcp_connection_management_http.rs"));
}

fn browser_fixture() -> (
    Fixture,
    crate::native_boot::SelectedAccount,
    Arc<WorkspaceSession>,
) {
    let fixture = Fixture::new();
    let id = blake3::hash("b".repeat(64).as_bytes()).to_hex().to_string();
    let now = millis();
    fs::write(
        fixture.root.join("storage/kv/trillion-local-app/blobs/aa"),
        json!({
            "userId":"synthetic-user", "created_at":iso(now), "browser_generation":0,
            "reach":{"private":true,"spaces":"all"}, "ceiling":{"private":true,"spaces":"all"}
        })
        .to_string(),
    )
    .unwrap();
    let policy = Connection::open(fixture.root.join("policy.sqlite")).unwrap();
    directory(
        &policy,
        &format!("policy-source:sign-in:session:{id}"),
        json!({
            "made":{"private":true,"spaces":"all"}, "ceiling":{"private":true,"spaces":"all"},
            "chosen":null, "last_used":iso(now)
        }),
    );
    drop(policy);
    let mut owner = fixture.selected();
    let admitted =
        account::current_browser(&mut owner, &id).expect("actual synthetic browser owner");
    let generation = serde_json::to_string(&(
        &admitted.account.owner_id,
        admitted.browser_generation,
        admitted.policy_epoch,
    ))
    .unwrap();
    let session = Arc::new(WorkspaceSession {
        account_id: admitted.account.user_id,
        session_id: id,
        generation,
    });
    (fixture, owner, session)
}
fn browser_command(key: &str) -> DomainCommand {
    DomainCommand {
        operation: "workspace:write".into(),
        input: input(),
        request_key: key.into(),
        key_carried: true,
    }
}
fn withdraw_browser(f: &Fixture) {
    Connection::open(f.root.join("storage/kv/trillion-local-app/current.sqlite"))
        .unwrap()
        .execute("DELETE FROM _mf_entries WHERE key LIKE 'session:%'", [])
        .unwrap();
}

#[test]
fn browser_write_and_readback_use_original_journal_without_any_personal_key() {
    let (f, mut owner, session) = browser_fixture();
    Connection::open(f.root.join("storage/kv/trillion-local-app/current.sqlite"))
        .unwrap()
        .execute(
            "DELETE FROM _mf_entries WHERE key LIKE 'personal-key:%'",
            [],
        )
        .unwrap();
    let command = browser_command("ordinary-browser-save");
    let witness = owner
        .prepare_browser_workspace_write(
            session,
            &command,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    let first = owner
        .execute_browser_workspace_write(&witness, false, &mut Ids(0))
        .unwrap();
    assert!(!first.duplicate);
    let committed = state(&f);
    let saved = owner
        .execute_browser_workspace_write(&witness, true, &mut Ids(100))
        .unwrap();
    assert!(saved.duplicate);
    assert_eq!(first.value, saved.value);
    assert_eq!(state(&f), committed);
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    let context: String = db
        .query_row("SELECT context FROM resource_behavior_commands", [], |r| {
            r.get(0)
        })
        .unwrap();
    let context: Value = serde_json::from_str(&context).unwrap();
    assert_eq!(context["recorder"]["basis"], "authenticated");
    assert_eq!(context["recorder"]["app_basis"], "unknown");
    assert!(context.get("human_attestation").is_none());
}

#[test]
fn browser_withdrawal_after_commit_withholds_recovery_without_replaying_effect() {
    let (f, mut owner, session) = browser_fixture();
    let witness = owner
        .prepare_browser_workspace_write(
            session,
            &browser_command("browser-withdrawal"),
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    owner
        .execute_browser_workspace_write(&witness, false, &mut Ids(0))
        .unwrap();
    let committed = state(&f);
    withdraw_browser(&f);
    assert!(owner
        .execute_browser_workspace_write(&witness, true, &mut Ids(100))
        .is_err());
    assert_eq!(state(&f), committed);
}

#[test]
fn browser_recovery_only_refuses_missing_command_before_any_effect() {
    let (f, mut owner, session) = browser_fixture();
    let witness = owner
        .prepare_browser_workspace_write(
            session,
            &browser_command("never-started-browser"),
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    let before = state(&f);
    assert!(matches!(
        owner.execute_browser_workspace_write(&witness, true, &mut Ids(0)),
        Err(record_writer::Error::ProtectedResultUnavailable(_))
    ));
    assert_eq!(state(&f), before);
}

#[test]
fn native_key_cannot_replace_a_withdrawn_browser_session() {
    let (f, mut owner, session) = browser_fixture();
    withdraw_browser(&f);
    let before = state(&f);
    assert!(owner
        .prepare_browser_workspace_write(
            session,
            &browser_command("not-a-browser"),
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(5)
        )
        .is_err());
    assert_eq!(state(&f), before);
}

#[test]
fn browser_generation_change_withholds_the_original_pending_result() {
    let (f, mut owner, session) = browser_fixture();
    let witness = owner
        .prepare_browser_workspace_write(
            session,
            &browser_command("old-browser-tab"),
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    owner
        .execute_browser_workspace_write(&witness, false, &mut Ids(0))
        .unwrap();
    let committed = state(&f);
    let file = f.root.join("storage/kv/trillion-local-app/blobs/aa");
    let mut value: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    value["browser_generation"] = json!(1);
    fs::write(file, value.to_string()).unwrap();
    assert!(owner
        .execute_browser_workspace_write(&witness, true, &mut Ids(100))
        .is_err());
    assert_eq!(state(&f), committed);
}

fn browser_http_app(f: &Fixture, owner: crate::native_boot::SelectedAccount) -> axum::Router {
    browser_http_observed(f, owner).0
}
fn browser_http_observed(
    f: &Fixture,
    owner: crate::native_boot::SelectedAccount,
) -> (
    axum::Router,
    Arc<std::sync::Mutex<crate::native_boot::SelectedAccount>>,
) {
    browser_http_observed_at(f, owner, "http://127.0.0.1:7189")
}
fn browser_http_observed_at(
    f: &Fixture,
    owner: crate::native_boot::SelectedAccount,
    origin: &str,
) -> (
    axum::Router,
    Arc<std::sync::Mutex<crate::native_boot::SelectedAccount>>,
) {
    let routes = br#"{"families":[{"family":"fixture","exact":["/unused"],"prefix":[]}]}"#;
    browser_http_observed_with_routes(f, owner, origin, routes)
}
fn browser_http_observed_with_routes(
    f: &Fixture,
    owner: crate::native_boot::SelectedAccount,
    origin: &str,
    routes: &[u8],
) -> (
    axum::Router,
    Arc<std::sync::Mutex<crate::native_boot::SelectedAccount>>,
) {
    use crate::{
        local_workspace::LocalWorkspace,
        workspace::{self, WorkspaceAssets, WorkspaceDom, WorkspaceLimits, WorkspaceSupplies},
        workspace_domain::{CanonicalWorkspace, OwnerRoutes, StartupContract},
        workspace_session::{WorkspaceSessionSettings, WorkspaceSessions},
    };
    let owner = Arc::new(std::sync::Mutex::new(owner));
    let settings = br#"{"kept":{"store_prefix":"trillion-kept-"}}"#;
    let sessions = WorkspaceSessions::new(
        owner.clone(),
        origin,
        WorkspaceSessionSettings::from_source(settings, blake3::hash(settings).to_hex().as_str())
            .unwrap(),
    )
    .unwrap();
    let local = Arc::new(LocalWorkspace::new(owner.clone(), sessions.clone()).unwrap());
    let routes = OwnerRoutes::from_source(routes, blake3::hash(routes).to_hex().as_str()).unwrap();
    let first = br#"{"paths":{},"workspace_records_path":"/work/api/records","startup_record_inputs":[],"startup_preferences":[],"screen_revision":"/work/api/screen-revision","screens":{},"item_reads":{"screens":{}}}"#;
    let startup = StartupContract::from_sources(
        first,
        blake3::hash(first).to_hex().as_str(),
        b"{}",
        blake3::hash(b"{}").to_hex().as_str(),
    )
    .unwrap();
    let operations = Arc::new(CanonicalWorkspace::new(routes, startup, local, None));
    let assets = f.root.join("browser-http-assets");
    fs::create_dir_all(assets.join("workspace")).unwrap();
    fs::write(
        assets.join("workspace/entry.dat"),
        b"synthetic browser fixture",
    )
    .unwrap();
    let manifest = serde_json::to_vec(&json!({"script":"/workspace/entry.dat","stylesheet":"/workspace/entry.dat","preload":[],"screens":{},"import_map":{"imports":{}}})).unwrap();
    fs::write(assets.join("workspace/files.json"), &manifest).unwrap();
    fn tree(root: &Path, relative: &str, hash: &mut blake3::Hasher) {
        let mut entries = fs::read_dir(root.join(relative))
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            use std::os::unix::fs::PermissionsExt;
            let name = entry.file_name().into_string().unwrap();
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let metadata = entry.metadata().unwrap();
            let row = if metadata.is_dir() {
                json!([path, "directory", metadata.permissions().mode() & 0o777])
            } else {
                json!([
                    path,
                    "file",
                    metadata.permissions().mode() & 0o777,
                    metadata.len(),
                    blake3::hash(&fs::read(entry.path()).unwrap())
                        .to_hex()
                        .as_str()
                ])
            };
            hash.update(row.to_string().as_bytes());
            hash.update(b"\n");
            if metadata.is_dir() {
                tree(root, &path, hash);
            }
        }
    }
    let mut hash = blake3::Hasher::new();
    tree(&assets, "", &mut hash);
    let assets = Arc::new(
        WorkspaceAssets::open(
            &assets,
            blake3::hash(&manifest).to_hex().as_str(),
            hash.finalize().to_hex().as_str(),
        )
        .unwrap(),
    );
    let dom = br#"{"element_id":"page-answers","item_reads":{"element_id":"page-item-answers"}}"#;
    let app = workspace::route_table(
        assets,
        WorkspaceSupplies {
            sessions: Some(Arc::new(sessions)),
            operations: Some(operations),
            live: None,
            dom: WorkspaceDom::from_source(dom, blake3::hash(dom).to_hex().as_str()).unwrap(),
        },
        WorkspaceLimits::default(),
    )
    .unwrap();
    (app, owner)
}
fn browser_http_request(
    key: &str,
    origin: &str,
    input: Value,
) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::builder()
        .method("POST")
        .uri("/work/api/records")
        .header("host", "127.0.0.1:7189")
        .header("origin", origin)
        .header("cookie", format!("nm_session={}", "b".repeat(64)))
        .header("idempotency-key", key)
        .body(axum::body::Body::from(input.to_string()))
        .unwrap()
}

#[tokio::test]
async fn actual_browser_http_save_and_lost_body_retry_share_one_original_effect() {
    use tower::ServiceExt;
    let (f, owner, _) = browser_fixture();
    let app = browser_http_app(&f, owner);
    let first = app
        .clone()
        .oneshot(browser_http_request(
            "http-browser-save",
            "http://127.0.0.1:7189",
            input(),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), axum::http::StatusCode::OK);
    assert_eq!(
        first.headers()["x-trillion-request-key"],
        "http-browser-save"
    );
    let committed = state(&f);
    drop(first); // Accepted response/body is lost after commit.
    let retry = app
        .oneshot(browser_http_request(
            "http-browser-save",
            "http://127.0.0.1:7189",
            input(),
        ))
        .await
        .unwrap();
    assert_eq!(retry.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(retry.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["written"], 1);
    assert_eq!(state(&f), committed);
}

#[tokio::test]
async fn actual_browser_http_withdrawal_after_headers_delivers_the_answer_recovered_before_them() {
    use tower::ServiceExt;
    let (f, owner, _) = browser_fixture();
    let app = browser_http_app(&f, owner);
    let response = app
        .oneshot(browser_http_request(
            "http-withdraw-pending",
            "http://127.0.0.1:7189",
            input(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    // The committed result was recovered under fresh authority before the
    // headers; a later withdrawal neither resets the connection nor runs
    // another effect.
    let committed = state(&f);
    withdraw_browser(&f);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert!(!body.is_empty());
    assert_eq!(state(&f), committed);
}

#[tokio::test]
async fn actual_browser_http_cross_origin_save_is_refused_before_effect() {
    use tower::ServiceExt;
    let (f, owner, _) = browser_fixture();
    let before = state(&f);
    let app = browser_http_app(&f, owner);
    let response = app
        .oneshot(browser_http_request(
            "http-wrong-origin",
            "https://different.example",
            input(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
    assert_eq!(state(&f), before);
}

#[tokio::test]
async fn actual_browser_http_source_change_after_headers_keeps_the_recovered_conflict_words() {
    use tower::ServiceExt;
    let (f, owner, _) = browser_fixture();
    let app = browser_http_app(&f, owner);
    let mut conflict = input();
    conflict["writes"][0]["expected_identity"] = json!("1f:not-the-current-workspace-value");
    let response = app
        .oneshot(browser_http_request(
            "http-conflict-source",
            "http://127.0.0.1:7189",
            conflict,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    Connection::open(f.root.join("records.sqlite")).unwrap().execute(
        "UPDATE workspace_records SET value='[\"changed-after-commit\"]',written_at='new-source' WHERE label='saved-board'", []
    ).unwrap();
    // The conflict answer was recovered before the headers; a later source
    // change cannot reset the delivery or add an effect.
    let changed = state(&f);
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert!(!body.is_empty());
    assert_eq!(state(&f), changed);
}

#[test]
fn ordinary_browser_history_uses_original_save_kind_without_an_ai_turn() {
    let (f, mut owner, session) = browser_fixture();
    let mut command = browser_command("ordinary-browser-arrangement");
    command.input = json!({"writes":[{"address_label":"screen-arrangement-of::fixture", "payload":{"parts":["one"]}}]});
    let witness = owner
        .prepare_browser_workspace_write(
            session,
            &command,
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    owner
        .execute_browser_workspace_write(&witness, false, &mut Ids(0))
        .unwrap();
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    let kinds: Vec<String> = db
        .prepare("SELECT kind FROM workspace_document_revisions")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(!kinds.is_empty(), "actual versioned arrangement revision");
    assert!(kinds.iter().all(|kind| kind == "save"));
    let turns: i64 = db
        .query_row("SELECT COUNT(*) FROM workspace_revision_turns", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        turns, 0,
        "ordinary browser writes are not recorded as an AI turn"
    );
}

#[test]
fn browser_withdrawal_during_terminal_append_rolls_back_effect_and_journal() {
    let (f, mut owner, session) = browser_fixture();
    let witness = owner
        .prepare_browser_workspace_write(
            session,
            &browser_command("browser-terminal-withdrawal"),
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    let before = state(&f);
    struct WithdrawIds {
        next: u16,
        kv: PathBuf,
    }
    impl LogIds for WithdrawIds {
        fn next_log_id(&mut self) -> Option<String> {
            self.next += 1;
            if self.next == 1 {
                Connection::open(&self.kv)
                    .unwrap()
                    .execute("DELETE FROM _mf_entries WHERE key LIKE 'session:%'", [])
                    .unwrap();
            }
            Some(format!(
                "01234567-89ab-7{:03x}-8f01-000000000001",
                self.next
            ))
        }
    }
    let mut ids = WithdrawIds {
        next: 0,
        kv: f.root.join("storage/kv/trillion-local-app/current.sqlite"),
    };
    assert!(owner
        .execute_browser_workspace_write(&witness, false, &mut ids)
        .is_err());
    assert_eq!(ids.next, 1, "actual internal batch publication was reached");
    assert_eq!(state(&f), before);
}

#[tokio::test]
async fn actual_browser_http_erased_result_is_terminal_and_never_replayed() {
    use tower::ServiceExt;
    let (f, owner, _) = browser_fixture();
    let app = browser_http_app(&f, owner);
    let response = app
        .clone()
        .oneshot(browser_http_request(
            "http-erased-result",
            "http://127.0.0.1:7189",
            input(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    let permit: String = db
        .query_row(
            "SELECT permit_id FROM resource_behavior_commands",
            [],
            |r| r.get(0),
        )
        .unwrap();
    db.execute_batch("BEGIN IMMEDIATE;UPDATE record_log SET keys=NULL WHERE keys IS NOT NULL;")
        .unwrap();
    db.execute(
        "INSERT INTO record_erasable_keys VALUES(?,NULL,'erased','[\"value\"]')",
        [format!("resource-command-result:{permit}")],
    )
    .unwrap();
    db.execute_batch("COMMIT").unwrap();
    // The first answer was recovered before its headers, so the erasure after
    // them neither resets that delivery nor makes it replayable: the retry
    // below is terminal.
    let erased = state(&f);
    assert!(!axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap()
        .is_empty());
    let retry = app
        .oneshot(browser_http_request(
            "http-erased-result",
            "http://127.0.0.1:7189",
            input(),
        ))
        .await
        .unwrap();
    assert_eq!(retry.status(), axum::http::StatusCode::GONE);
    assert_eq!(state(&f), erased);
}

#[tokio::test]
async fn actual_browser_http_cost_keeps_full_admission_commit_and_delivery() {
    use tower::ServiceExt;
    let (f, selected, _) = browser_fixture();
    let (app, owner) = browser_http_observed(&f, selected);
    let before = owner.lock().unwrap().sql_work().unwrap();
    let response = app
        .oneshot(browser_http_request(
            "browser-whole-http-cost",
            "http://127.0.0.1:7189",
            input(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let committed = owner.lock().unwrap().sql_work().unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["written"],
        1
    );
    let delivered = owner.lock().unwrap().sql_work().unwrap();
    fn delta(a: &crate::scan::ReadWork, b: &crate::scan::ReadWork) -> Value {
        json!({
            "sql_statements":b.sql_statements.checked_sub(a.sql_statements).unwrap(),
            "sqlite_scan_visits":b.sqlite_scan_visits.checked_sub(a.sqlite_scan_visits).unwrap(),
            "fullscan_steps":b.fullscan_steps.checked_sub(a.fullscan_steps).unwrap(),
            "vm_steps":b.vm_steps.checked_sub(a.vm_steps).unwrap(),
            "rows_returned":b.rows_returned.checked_sub(a.rows_returned).unwrap(),
            "rows_written":b.rows_written.checked_sub(a.rows_written).unwrap()
        })
    }
    let total = delta(&before.work, &delivered.work);
    assert!(total["sql_statements"].as_u64().unwrap() > 0);
    assert!(total["rows_written"].as_u64().unwrap() > 0);
    eprintln!(
        "BROWSER_HTTP_ACTUAL_COST {}",
        json!({"scope":"synthetic selected owner already open/admitted; one actual HTTP save through full admission, original commit and first-chunk recovery; not live account, physical IO, wall time or provider bill", "prepare_commit":delta(&before.work,&committed.work),"first_frame_recovery":delta(&committed.work,&delivered.work),"total":total})
    );
}

#[tokio::test]
async fn actual_local_sdk_http_cost_keeps_auth_commit_and_protected_output() {
    use tower::ServiceExt;
    let f = Fixture::new();
    let owner = Arc::new(std::sync::Mutex::new(f.selected()));
    let app =
        crate::native_boot::mcp_local::route_table(owner.clone(), "127.0.0.1:28788".into()).unwrap();
    let before = owner.lock().unwrap().sql_work().unwrap();
    let response = app
        .oneshot(local_http_request(&f, "mcp-whole-http-cost", "2026-07-28"))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .unwrap();
    let body = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(body.contains("written"));
    assert!(!body.contains("isError\":true"));
    let saved = state(&f);
    assert_eq!(
        serde_json::from_str::<Value>(&saved.0).unwrap(),
        json!({"items":["written"]})
    );
    assert_eq!(saved.2, 1, "one actual original command was committed");
    let after = owner.lock().unwrap().sql_work().unwrap();
    let a = &before.work;
    let b = &after.work;
    eprintln!(
        "MCP_HTTP_ACTUAL_COST {}",
        json!({
            "scope":"synthetic selected owner already open; one real RMCP2026 HTTP operation through personal-key authentication, current gates, original writer and sealed output; not live account, physical IO, wall time or provider bill",
            "total":{
                "sql_statements":b.sql_statements.checked_sub(a.sql_statements).unwrap(),
                "sqlite_scan_visits":b.sqlite_scan_visits.checked_sub(a.sqlite_scan_visits).unwrap(),
                "fullscan_steps":b.fullscan_steps.checked_sub(a.fullscan_steps).unwrap(),
                "vm_steps":b.vm_steps.checked_sub(a.vm_steps).unwrap(),
                "rows_returned":b.rows_returned.checked_sub(a.rows_returned).unwrap(),
                "rows_written":b.rows_written.checked_sub(a.rows_written).unwrap()
            }
        })
    );
    assert!(b.rows_written > a.rows_written);
}

mod mcp_operation_source_revalidation {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/mcp_operation_source_revalidation.rs"));
}
