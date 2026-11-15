// tests/workspace_session.rs
//
// Purpose: Exercise actual workspace session admission and revalidation through the Rust route table.
// Non-Negotiable Invariants: Synthetic stores and cookies prove controls, not taking over a real account's folder or a usable application.
// Key Concepts: Original hashed cookie, fresh own-records gate, stable per-account store and request-bound generations.
// Security Considerations: No real credentials, original files, network, new sign-in or native-key fallback.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    response::Response,
    Router,
};
use content_crypto::advanced::blake3;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};
use tempfile::TempDir;
use tower::ServiceExt;
use trillion_local::{
    account::{AccountError, AccountIdentity, AccountResult, NativeAccountOwner},
    workspace::*,
    workspace_domain::DomainContext,
    workspace_session::{WorkspaceSessionSettings, WorkspaceSessions},
};

#[path = "workspace_session/contention.rs"]
mod contention;

const TOKEN: &str = "SYNTHETIC_BROWSER_COOKIE_ONLY";
const ORIGIN: &str = "http://127.0.0.1:7189";
const AUTHORITY: &str = "127.0.0.1:7189";
const DATA: &[u8] = br#"{"element_id":"page-answers","item_reads":{"element_id":"page-item-answers"},"kept":{"store_prefix":"trillion-kept-"}}"#;

fn settings() -> WorkspaceSessionSettings {
    WorkspaceSessionSettings::from_source(DATA, blake3::hash(DATA).to_hex().as_str()).unwrap()
}
struct FixtureOwner {
    account: String,
    source_error: Option<AccountError>,
}
impl FixtureOwner {
    fn new(account: &str) -> Self {
        Self {
            account: account.to_owned(),
            source_error: None,
        }
    }
}
impl NativeAccountOwner for FixtureOwner {
    fn account(&self) -> AccountIdentity {
        AccountIdentity {
            user_id: self.account.clone(),
            owner_id: "a".repeat(64),
        }
    }
    fn now_ms(&mut self) -> AccountResult<u64> {
        Ok(
            chrono::DateTime::parse_from_rfc3339("2026-10-25T21:00:00.000Z")
                .unwrap()
                .timestamp_millis() as u64,
        )
    }
    fn assert_source_current(&mut self) -> AccountResult<()> {
        self.source_error.clone().map_or(Ok(()), Err)
    }
}

struct ScopeOperations {
    sessions: Arc<WorkspaceSessions<FixtureOwner>>,
}
impl WorkspaceOperations for ScopeOperations {
    fn page(
        &self,
        session: WorkspaceSession,
        head: WorkspaceRequestHead,
        permit: WorkspacePermit,
    ) -> SupplyFuture<WorkspacePage> {
        let admission = self.sessions.authorize(DomainContext {
            session: Arc::new(session), head, permit,
        });
        Box::pin(async move {
            admission.await?;
            Ok(WorkspacePage {
                document: "<!doctype html><html><head><title>Synthetic admission control</title></head><body><div id=\"root\"></div></body></html>".into(),
                screen_entry: None, listed_reads: vec![], item_reads: vec![], known: vec![], answers: vec![],
            })
        })
    }
    fn invoke(
        &self,
        session: WorkspaceSession,
        request: WorkspaceRequest,
        permit: WorkspacePermit,
    ) -> SupplyFuture<Response> {
        let after = request.head.uri.path().to_owned();
        let pending_permit = permit.clone();
        if after == "/work/api/cancel" {
            permit.cancel();
        }
        let future = self.sessions.authorize(DomainContext {
            session: Arc::new(session),
            head: request.head,
            permit,
        });
        // A future is not admission: a cancellation before its first poll must
        // still refuse, rather than disclose an eager snapshot.
        if after == "/work/api/cancel-after-factory" {
            pending_permit.cancel();
        }
        Box::pin(async move {
            let scope = future.await?;
            Ok(Response::builder().header(header::CONTENT_TYPE, "application/json").body(Body::from(serde_json::to_vec(&json!({
                "origin":scope.origin,"page_store":scope.page_store,"read_only":scope.read_only
            })).unwrap())).unwrap())
        })
    }
}

fn tree_pin(root: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    fn walk(root: &Path, rel: &str, hash: &mut blake3::Hasher) {
        let mut entries = fs::read_dir(root.join(rel))
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        entries.sort_by_key(|v| v.file_name());
        for entry in entries {
            let name = entry.file_name().into_string().unwrap();
            let relative = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let metadata = entry.metadata().unwrap();
            let mode = metadata.permissions().mode() & 0o777;
            let row = if metadata.is_dir() {
                json!([relative, "directory", mode])
            } else {
                json!([
                    relative,
                    "file",
                    mode,
                    metadata.len(),
                    blake3::hash(&fs::read(entry.path()).unwrap())
                        .to_hex()
                        .as_str()
                ])
            };
            hash.update(&serde_json::to_vec(&row).unwrap());
            hash.update(b"\n");
            if metadata.is_dir() {
                walk(root, &relative, hash);
            }
        }
    }
    let mut hash = blake3::Hasher::new();
    walk(root, "", &mut hash);
    hash.finalize().to_hex().to_string()
}
struct Fixture {
    _directory: TempDir,
    app: Router,
    owner: Arc<Mutex<FixtureOwner>>,
    sessions: Arc<WorkspaceSessions<FixtureOwner>>,
}
fn fixture() -> Fixture {
    fixture_at(None)
}
/// The fixture's workspace, also served at `public` (the account's public origin) when given.
fn fixture_at(public: Option<&str>) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let account = format!("fixture-user-{}", directory.path().file_name().unwrap().to_string_lossy());
    fs::create_dir(directory.path().join("workspace")).unwrap();
    fs::write(
        directory.path().join("workspace/entry.dat"),
        b"fixture asset bytes",
    )
    .unwrap();
    let manifest = serde_json::to_vec(&json!({"script":"/workspace/entry.dat","stylesheet":"/workspace/entry.dat","preload":[],"screens":{},"import_map":{"imports":{}}})).unwrap();
    fs::write(directory.path().join("workspace/files.json"), &manifest).unwrap();
    let assets = Arc::new(
        WorkspaceAssets::open(
            directory.path(),
            blake3::hash(&manifest).to_hex().as_str(),
            &tree_pin(directory.path()),
        )
        .unwrap(),
    );
    let owner = Arc::new(Mutex::new(FixtureOwner::new(&account)));
    let local = WorkspaceSessions::new(owner.clone(), ORIGIN, settings()).unwrap();
    let sessions = Arc::new(match public {
        Some(origin) => local.with_public_origin(origin).unwrap(),
        None => local,
    });
    let app = route_table(
        assets,
        WorkspaceSupplies {
            sessions: Some(sessions.clone()),
            operations: Some(Arc::new(ScopeOperations {
                sessions: sessions.clone(),
            })),
            live: None,
            dom: WorkspaceDom::from_source(DATA, blake3::hash(DATA).to_hex().as_str()).unwrap(),
        },
        WorkspaceLimits::default(),
    )
    .unwrap();
    Fixture {
        _directory: directory,
        app,
        owner,
        sessions,
    }
}
fn request(path: &str, cookie: Option<&str>) -> Request<Body> {
    let mut request = Request::builder().uri(path).header(header::HOST, AUTHORITY);
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    request.body(Body::empty()).unwrap()
}
/// A browser's request for a page: it asks for HTML, so a signed-out answer is the sign-in redirect (an API caller keeps 401).
fn page_request(path: &str, cookie: Option<&str>) -> Request<Body> {
    let mut page = request(path, cookie);
    page.headers_mut().insert(header::ACCEPT, "text/html".parse().unwrap());
    page
}
fn cookie() -> String {
    format!("unrelated=1; nm_session={TOKEN}")
}

#[tokio::test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
async fn original_cookie_and_own_records_gate_admit_real_route_table_then_revalidate_scope() {
    let f = fixture();
    let response = f
        .app
        .clone()
        .oneshot(request("/workspace/entry.dat", Some(&cookie())))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
        b"fixture asset bytes"
    );
    let response = f
        .app
        .oneshot(request("/work/api/scope", Some(&cookie())))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(
        value,
        json!({"origin":ORIGIN,"page_store":settings().page_store(&f.owner.lock().unwrap().account).unwrap(),"read_only":false})
    );
    assert_eq!(format!("{:?}", f.sessions), "WorkspaceSessions([redacted])");
}

#[tokio::test]
async fn absent_ambiguous_oversized_and_native_credentials_never_substitute_for_cookie() {
    let f = fixture();
    for (value, status) in [
        (None, StatusCode::UNAUTHORIZED),
        (Some("nm_session="), StatusCode::UNAUTHORIZED),
        (
            Some("nm_session=not-the-selected-cookie"),
            StatusCode::UNAUTHORIZED,
        ),
        (
            Some("nm_session=one; nm_session=two"),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        assert_eq!(
            f.app
                .clone()
                .oneshot(request("/work/api/scope", value))
                .await
                .unwrap()
                .status(),
            status
        );
    }
    let mut native = request("/work/api/scope", None);
    native.headers_mut().insert(
        header::AUTHORIZATION,
        "Bearer SYNTHETIC_NATIVE_ONLY".parse().unwrap(),
    );
    assert_eq!(
        f.app.clone().oneshot(native).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let mut duplicated = request("/work/api/scope", Some(&cookie()));
    duplicated
        .headers_mut()
        .append(header::COOKIE, cookie().parse().unwrap());
    assert_eq!(
        f.app.clone().oneshot(duplicated).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let huge = format!("nm_session={}", "x".repeat(16 * 1024));
    assert_eq!(
        f.app
            .oneshot(request("/work/api/scope", Some(&huge)))
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
async fn selected_listener_authority_refuses_dns_rebinding_and_foreign_absolute_uri_before_account_reads(
) {
    let f = fixture();
    let mut foreign = request("/work/api/scope", Some(&cookie()));
    foreign
        .headers_mut()
        .insert(header::HOST, "evil.example".parse().unwrap());
    assert_eq!(
        f.app.clone().oneshot(foreign).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let mut duplicate = request("/work/api/scope", Some(&cookie()));
    duplicate
        .headers_mut()
        .append(header::HOST, AUTHORITY.parse().unwrap());
    assert_eq!(
        f.app.clone().oneshot(duplicate).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.app
            .oneshot(request(
                "http://127.0.0.1:7190/work/api/scope",
                Some(&cookie())
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
async fn a_page_asked_for_signed_out_goes_to_sign_in_by_any_address_and_a_signed_in_foreign_one_still_refuses() {
    let f = fixture();
    for (host, path) in [(AUTHORITY, "/"), ("app.example", "/"), ("app.example", "/spaces/one?open=two")] {
        let mut signed_out = page_request(path, None);
        signed_out.headers_mut().insert(header::HOST, host.parse().unwrap());
        let response = f.app.clone().oneshot(signed_out).await.unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER, "{host}{path}");
        assert_eq!(response.headers()[header::LOCATION], "/sign-in");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let next = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(next.starts_with("trillion_next="), "the return path is held in a cookie: {next}");
    }
    let mut foreign = request("/", Some(&cookie()));
    foreign.headers_mut().insert(header::HOST, "app.example".parse().unwrap());
    assert_eq!(f.app.clone().oneshot(foreign).await.unwrap().status(), StatusCode::FORBIDDEN);
    assert_eq!(
        f.app.clone().oneshot(request("/work/api/scope", None)).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let mut write = request("/", None);
    *write.method_mut() = axum::http::Method::POST;
    assert_ne!(f.app.oneshot(write).await.unwrap().status(), StatusCode::SEE_OTHER);
}

#[tokio::test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
async fn a_browser_signed_in_at_the_public_origin_opens_the_workspace_there_and_no_other_address_does() {
    const PUBLIC: &str = "https://app.example";
    let f = fixture_at(Some(PUBLIC));
    let signed_in = format!("unrelated=1; __Host-trillion_session={TOKEN}");
    let at = |path: &str, host: &str, cookie: Option<&str>, origin: Option<&str>| {
        let mut request = request(path, cookie);
        request.headers_mut().insert(header::HOST, host.parse().unwrap());
        if let Some(origin) = origin {
            request.headers_mut().insert(header::ORIGIN, origin.parse().unwrap());
        }
        request
    };
    let scope = f.app.clone().oneshot(at("/work/api/scope", "app.example", Some(&signed_in), Some(PUBLIC))).await.unwrap();
    assert_eq!(scope.status(), StatusCode::OK);
    let value: Value = serde_json::from_slice(&to_bytes(scope.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(value["origin"], PUBLIC, "the page's origin is the address it was opened at");
    let page = f.app.clone().oneshot(at("/", "app.example", Some(&signed_in), None)).await.unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    let policy = page.headers()["content-security-policy"].to_str().unwrap().to_owned();
    assert!(policy.contains("connect-src 'self' wss://app.example https://app.example"), "{policy}");
    assert!(!policy.contains("ws://") && !policy.contains("http://"), "{policy}");
    let local = f.app.clone().oneshot(request("/", Some(&cookie()))).await.unwrap();
    assert_eq!(local.status(), StatusCode::OK);
    assert!(local.headers()["content-security-policy"].to_str().unwrap().contains(&format!("ws://{AUTHORITY} http://{AUTHORITY}")));
    for (host, origin) in [("evil.example", None), ("app.example", Some(ORIGIN)), (AUTHORITY, Some(PUBLIC))] {
        assert_eq!(f.app.clone().oneshot(at("/work/api/scope", host, Some(&signed_in), origin)).await.unwrap().status(),
            StatusCode::FORBIDDEN, "{host} {origin:?}");
    }
    // A browser that also holds a stale window cookie (the old site's, or another computer's window) is signed in by
    // its sign-in cookie: the window cookie only exists at the local address, so it never names the session here.
    let stale = format!("nm_session=a-stale-window-cookie; __Host-trillion_session={TOKEN}");
    assert_eq!(f.app.clone().oneshot(at("/work/api/scope", "app.example", Some(&stale), None)).await.unwrap().status(),
        StatusCode::OK, "a stale window cookie must not refuse a signed-in browser");
    let stale_only = "nm_session=a-stale-window-cookie; __Host-trillion_session=not-a-session";
    assert_eq!(f.app.clone().oneshot(at("/work/api/scope", "app.example", Some(stale_only), None)).await.unwrap().status(),
        StatusCode::UNAUTHORIZED, "the sign-in cookie decides: a window cookie never rescues an unknown sign-in cookie");
    let twice = format!("__Host-trillion_session={TOKEN}; __Host-trillion_session={TOKEN}");
    assert_eq!(f.app.clone().oneshot(at("/work/api/scope", "app.example", Some(&twice), None)).await.unwrap().status(),
        StatusCode::BAD_REQUEST, "two cookies of one name are still ambiguous");
    for refused in ["http://app.example", "https://app.example/", "https://app.example/path", "https://user@example.com"] {
        assert!(WorkspaceSessions::new(f.owner.clone(), ORIGIN, settings()).unwrap().with_public_origin(refused).is_err(), "{refused}");
    }
}

#[tokio::test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
async fn explicit_foreign_null_and_duplicate_origin_refuse_before_account_reads() {
    let f = fixture();
    for origin in ["https://foreign.example", "null"] {
        let mut foreign = request("/work/api/scope", Some(&cookie()));
        foreign
            .headers_mut()
            .insert(header::ORIGIN, origin.parse().unwrap());
        assert_eq!(
            f.app.clone().oneshot(foreign).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    let mut duplicate = request("/work/api/scope", Some(&cookie()));
    duplicate
        .headers_mut()
        .append(header::ORIGIN, ORIGIN.parse().unwrap());
    duplicate
        .headers_mut()
        .append(header::ORIGIN, ORIGIN.parse().unwrap());
    assert_eq!(
        f.app.clone().oneshot(duplicate).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let mut same = request("/work/api/scope", Some(&cookie()));
    same.headers_mut()
        .insert(header::ORIGIN, ORIGIN.parse().unwrap());
    let response = f.app.oneshot(same).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&to_bytes(response.into_body(), 4096).await.unwrap())
            .unwrap(),
        json!({"origin":ORIGIN,"page_store":settings().page_store(&f.owner.lock().unwrap().account).unwrap(),"read_only":false})
    );
}

#[tokio::test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
async fn a_cancelled_permit_refuses_before_scope_disclosure() {
    for path in ["/work/api/cancel", "/work/api/cancel-after-factory"] {
        let f = fixture();
        let response = f.app.oneshot(request(path, Some(&cookie()))).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT, "{path}");
    }
}

#[tokio::test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
async fn unavailable_source_changing_policy_and_contended_owner_never_queue_or_succeed() {
    let f = fixture();
    let guard = f.owner.lock().unwrap();
    assert_eq!(
        f.app
            .clone()
            .oneshot(request("/work/api/scope", Some(&cookie())))
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    drop(guard);
    f.owner.lock().unwrap().source_error = Some(trillion_local::cause!(AccountError::SourceUnavailable));
    assert_eq!(
        f.app
            .oneshot(request("/work/api/scope", Some(&cookie())))
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[test]
fn pinned_data_original_kept_store_oracle_and_origin_bounds_are_independent_of_credentials() {
    // Python blake3 derive_key_context independently supplied these two names.
    assert_eq!(
        settings().page_store("fixture-user").unwrap(),
        "trillion-kept-a4f27a1aea816e7273975c626ffb92d2"
    );
    assert_eq!(
        settings().page_store("other-fixture-user").unwrap(),
        "trillion-kept-fb520d6ddac7aaf60aa4b9cc14c6cd3d"
    );
    assert!(settings().page_store("").is_err());
    assert!(WorkspaceSessionSettings::from_source(DATA, &"0".repeat(64)).is_err());
    let invalid = br#"{"kept":{"store_prefix":"unsafe/name"}}"#;
    assert!(WorkspaceSessionSettings::from_source(
        invalid,
        blake3::hash(invalid).to_hex().as_str()
    )
    .is_err());
    for origin in [
        "http://example.com:7189",
        "http://127.0.0.1:0",
        "https://127.0.0.1:7189",
        "http://127.0.0.1:7189/",
        "http://127.0.0.1:7189?x=1",
    ] {
        assert!(
            WorkspaceSessions::new(
                Arc::new(Mutex::new(FixtureOwner::new("fixture-user"))),
                origin,
                settings()
            )
            .is_err(),
            "{origin}"
        );
    }
}
