// tests/workspace.rs
//
// Purpose: Qualify workspace connection mechanics and the explicit actual retained frontend consumer.
//
// Non-Negotiable Invariants: Keep synthetic account fixtures distinct from real account authority and rendered or installed app proof.
//
// Key Concepts: Independent artifact/body pins, hostile archive controls, scoped public code and permit lifetime witnesses.
//
// Security Considerations: Read original retained program bytes only; never execute them or mutate original account stores.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

// Purpose: Qualify workspace adapter mechanics with explicit synthetic supplies,
// then consume the actual retained frontend in a separately selected fixture.
// No fixture is a real sign-in, canonical-domain implementation or UI parity proof.
use axum::{
    body::{to_bytes, Body, Bytes},
    http::{header, Request, StatusCode},
    response::Response,
    Router,
};
use content_crypto::advanced::blake3;
use http_body::{Body as HttpBody, Frame as Chunk};
use serde_json::{json, Value};
use std::io::Write;
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
};
use tempfile::TempDir;
use tower::ServiceExt;
use trillion_local::workspace::*;
#[path = "workspace/static_programs.rs"]
mod static_programs;
#[path = "workspace/public_assets.rs"]
mod public_assets;

fn tree_pin(root: &Path) -> String {
    // Independent test spelling of the existing JSON-line tree format. The real
    // retained fixture below uses externally recorded fixed identities as oracle.
    use std::os::unix::fs::PermissionsExt;
    fn walk(root: &Path, relative: &str, hash: &mut blake3::Hasher) {
        let mut children = fs::read_dir(root.join(relative))
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let name = child.file_name().into_string().unwrap();
            let rel = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let meta = fs::symlink_metadata(child.path()).unwrap();
            let mode = meta.permissions().mode() & 0o777;
            let row = if meta.is_dir() {
                json!([rel, "directory", mode])
            } else {
                json!([
                    rel,
                    "file",
                    mode,
                    meta.len(),
                    blake3::hash(&fs::read(child.path()).unwrap())
                        .to_hex()
                        .as_str()
                ])
            };
            hash.update(serde_json::to_string(&row).unwrap().as_bytes());
            hash.update(b"\n");
            if meta.is_dir() {
                walk(root, &rel, hash);
            }
        }
    }
    let mut hash = blake3::Hasher::new();
    walk(root, "", &mut hash);
    hash.finalize().to_hex().to_string()
}
const DOM: &[u8] =
    br#"{"element_id":"page-answers","item_reads":{"element_id":"page-item-answers"}}"#;
const NONCE: &str = "fixture_nonce_0123456789";
fn dom() -> WorkspaceDom {
    WorkspaceDom::from_source(DOM, blake3::hash(DOM).to_hex().as_str()).unwrap()
}
struct Fixture {
    directory: TempDir,
    assets: Arc<WorkspaceAssets>,
    manifest: Vec<u8>,
}
fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir_all(directory.path().join("workspace/named")).unwrap();
    // Data-only fixtures; no new product JS, styles or renderer is written.
    for (name, value) in [
        ("entry.dat", "test entry bytes"),
        ("look.dat", "test look bytes"),
        ("shared.dat", "test shared bytes"),
    ] {
        fs::write(directory.path().join("workspace/named").join(name), value).unwrap();
    }
    let manifest = serde_json::to_vec(&json!({"script":"/workspace/named/entry.dat","stylesheet":"/workspace/named/look.dat",
        "preload":["/workspace/named/shared.dat"],"screens":{"fixture-screen":["/workspace/named/entry.dat"]},
        "import_map":{"imports":{"@fixture/shared":"/workspace/named/shared.dat"}}})).unwrap();
    fs::write(directory.path().join("workspace/files.json"), &manifest).unwrap();
    let assets = WorkspaceAssets::open(
        directory.path(),
        blake3::hash(&manifest).to_hex().as_str(),
        &tree_pin(directory.path()),
    )
    .unwrap();
    Fixture {
        directory,
        assets: Arc::new(assets),
        manifest,
    }
}
struct Sessions {
    allowed: AtomicBool,
    checks: AtomicUsize,
}
impl CurrentSession for Sessions {
    fn current(
        &self,
        request: WorkspaceRequestHead,
        _: WorkspacePermit,
    ) -> SupplyFuture<WorkspaceSession> {
        self.checks.fetch_add(1, Ordering::SeqCst);
        let allowed = self.allowed.load(Ordering::SeqCst)
            && request
                .headers
                .get(header::COOKIE)
                .is_some_and(|v| v == "fixture-session=yes");
        Box::pin(async move {
            if !allowed {
                Err(trillion_local::cause!(WorkspaceError::Unauthorized))
            } else {
                Ok(WorkspaceSession {
                    account_id: "fixture-account".into(),
                    session_id: "fixture-session".into(),
                })
            }
        })
    }
}
struct Operations {
    calls: AtomicUsize,
    held: Mutex<Option<WorkspacePermit>>,
    seen: Mutex<Vec<Value>>,
}
fn page() -> WorkspacePage {
    WorkspacePage { document:"<!doctype html><html lang=\"en\"><head><title>Fixture shell</title></head><body><div id=\"root\" data-fixture-preserved=\"yes\"></div></body></html>".into(),
        screen_entry:Some("fixture-screen".into()), listed_reads:vec!["/work/api/fixture?label=a&label=b".into()], item_reads:vec![],
        known:vec![("fixture-kept".into(), json!({"store":"fixture-only"}))],
        answers:vec![FirstAnswer { path:"/work/api/fixture?label=a&label=b".into(),copy:false,
            envelope:json!({"status":200,"body":{"text":"</script><img src=x>"},"next_before":"fixture-cursor"}).into() }] }
}
#[test]
fn asynchronous_app_script_follows_its_parsed_root_mount() {
    let fixture = fixture();
    let html = render_page(&fixture.assets, &dom(), page(), 1024 * 1024, NONCE).unwrap();
    let head_end = html.find("</head>").unwrap();
    let root_end = html.find("data-fixture-preserved=\"yes\"></div>").unwrap()
        + "data-fixture-preserved=\"yes\"></div>".len();
    let script = html.find("<script type=\"module\" async src=").unwrap();
    assert!(script>=root_end&&root_end>head_end,"a cached async module must not execute before its mount is parsed (script={script}, exclusive root end={root_end})");
    assert!(
        html.find("<link rel=\"stylesheet\"").unwrap() < head_end,
        "stylesheet discovery stays in the head"
    );
    assert!(
        script < html.find("data-page-answer=").unwrap(),
        "answer streaming must not hold up the app module"
    );
}

impl WorkspaceOperations for Operations {
    fn page(
        &self,
        _: WorkspaceSession,
        _: WorkspaceRequestHead,
        _: WorkspacePermit,
    ) -> SupplyFuture<WorkspacePage> {
        Box::pin(async { Ok(page()) })
    }
    fn invoke(
        &self,
        session: WorkspaceSession,
        request: WorkspaceRequest,
        permit: WorkspacePermit,
    ) -> SupplyFuture<Response> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.seen.lock().unwrap().push(json!({"account":session.account_id,"method":request.head.method.as_str(),"uri":request.head.uri.to_string(),
            "key":request.head.headers.get("idempotency-key").and_then(|v|v.to_str().ok()),"body":String::from_utf8(request.body.to_vec()).unwrap()}));
        let path = request.head.uri.path();
        if matches!(
            path,
            "/work/api/hold-worker" | "/work/api/hold-upgrade" | "/work/liveish"
        ) {
            *self.held.lock().unwrap() = Some(permit);
        }
        let response = if path == "/work/api/large" {
            Response::new(Body::from(vec![0_u8; 4096]))
        } else if path == "/work/api/unknown-large" {
            Response::new(Body::new(UnknownBody(Some(vec![0_u8; 4096]))))
        } else if matches!(path, "/work/api/hold-upgrade" | "/work/liveish") {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
            response
        } else {
            Response::new(Body::from("{\"fixture\":true}"))
        };
        Box::pin(async move { Ok(response) })
    }
}
struct UnknownBody(Option<Vec<u8>>);
impl HttpBody for UnknownBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Chunk<Bytes>, io::Error>>> {
        Poll::Ready(
            self.0
                .take()
                .map(|bytes| Ok(Chunk::data(Bytes::from(bytes)))),
        )
    }
}
struct Live {
    held: Mutex<Option<WorkspacePermit>>,
}
impl WorkspaceLive for Live {
    fn subscribe(
        &self,
        _: WorkspaceSession,
        _: axum::extract::Request,
        permit: WorkspacePermit,
    ) -> SupplyFuture<Response> {
        *self.held.lock().unwrap() = Some(permit);
        Box::pin(async {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
            Ok(response)
        })
    }
}
fn supplies() -> (Arc<Sessions>, Arc<Operations>) {
    (
        Arc::new(Sessions {
            allowed: AtomicBool::new(true),
            checks: AtomicUsize::new(0),
        }),
        Arc::new(Operations {
            calls: AtomicUsize::new(0),
            held: Mutex::new(None),
            seen: Mutex::new(vec![]),
        }),
    )
}
fn app(
    assets: Arc<WorkspaceAssets>,
    sessions: Arc<Sessions>,
    operations: Arc<Operations>,
    live: Option<Arc<dyn WorkspaceLive>>,
    limits: WorkspaceLimits,
) -> Router {
    route_table(
        assets,
        WorkspaceSupplies {
            sessions: Some(sessions),
            operations: Some(operations),
            live,
            dom: dom(),
        },
        limits,
    )
    .unwrap()
}
fn request(method: &str, path: &str, body: impl Into<Body>) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, "127.0.0.1:9999")
        .header(header::COOKIE, "fixture-session=yes")
        .header("idempotency-key", "fixture-original-key")
        .body(body.into())
        .unwrap()
}

fn module_fixture(entries: &[(&str, tar::EntryType, &[u8])]) -> (TempDir, String, String) {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("screen-modules")).unwrap();
    let mut archive = tar::Builder::new(Vec::new());
    for (name, kind, body) in entries {
        let mut header = tar::Header::new_ustar();
        header.set_mode(0o644);
        header.set_size(body.len() as u64);
        header.set_mtime(0);
        header.set_entry_type(*kind);
        // Explicit hostile header fixture, without invoking an extractor or
        // letting the builder normalize away the path we need to test.
        assert!(name.len() < 100);
        header.as_mut_bytes()[..100].fill(0);
        header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
        if kind.is_symlink() || kind.is_hard_link() {
            header.set_link_name("../outside").unwrap();
        }
        header.set_cksum();
        archive.append(&header, *body).unwrap();
    }
    let raw = archive.into_inner().unwrap();
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&raw).unwrap();
    let raw = gzip.finish().unwrap();
    let hash = blake3::hash(&raw).to_hex().to_string();
    fs::write(
        directory
            .path()
            .join("screen-modules")
            .join(format!("{hash}.tar.gz")),
        raw,
    )
    .unwrap();
    let manifest=serde_json::to_vec(&json!({"modules":{"fixture":{"bundle":format!("1f:{hash}"),"file":"entry.js","files":entries.len()}}})).unwrap();
    fs::write(directory.path().join("screen-modules.json"), &manifest).unwrap();
    (
        directory,
        blake3::hash(&manifest).to_hex().to_string(),
        format!("/workshop/modules/1f%3A{hash}/entry.js"),
    )
}

// Explicit synthetic PUBLIC program source. It grants no account/resource rights
// and is not the production content supply owed by native composition.
#[derive(Default)]
struct SavedProgramSource {
    archives: Mutex<BTreeMap<String, Vec<u8>>>,
}
impl saved_modules::PublicScreenArchiveSource for SavedProgramSource {
    fn read_admitted_public_screen_archive(
        &self,
        identity: saved_modules::ScreenBundleIdentity,
        limit: usize,
    ) -> SupplyFuture<Option<Vec<u8>>> {
        let bytes = self
            .archives
            .lock()
            .unwrap()
            .get(identity.as_str())
            .cloned();
        Box::pin(async move {
            if bytes.as_ref().is_some_and(|body| body.len() > limit) {
                Err(trillion_local::cause!(WorkspaceError::TooLarge))
            } else {
                Ok(bytes)
            }
        })
    }
}

#[tokio::test]
async fn same_workspace_route_table_serves_later_saved_programs_without_admitting_private_operations(
) {
    let f = fixture();
    let (sessions, operations) = supplies();
    sessions.allowed.store(false, Ordering::SeqCst);
    let source = Arc::new(SavedProgramSource::default());
    let reader = Arc::new(saved_modules::SavedScreenModules::new(source.clone()));
    let app = route_table_with_saved_modules(
        f.assets,
        WorkspaceSupplies {
            sessions: Some(sessions.clone()),
            operations: Some(operations),
            live: None,
            dom: dom(),
        },
        WorkspaceLimits::default(),
        reader,
    )
    .unwrap();
    for text in [
        b"first saved public program".as_slice(),
        b"second distinct saved public program".as_slice(),
    ] {
        let (archive, _, url) = module_fixture(&[("entry.js", tar::EntryType::Regular, text)]);
        let response = app
            .clone()
            .oneshot(request("GET", &url, Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        drop(response);
        let bytes = fs::read(
            fs::read_dir(archive.path().join("screen-modules"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path(),
        )
        .unwrap();
        let identity = format!("1f:{}", blake3::hash(&bytes).to_hex());
        source
            .archives
            .lock()
            .unwrap()
            .insert(identity.clone(), bytes);
        let response = app
            .clone()
            .oneshot(request("GET", &url, Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-content-identity"], identity);
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
            text
        );
        let response = app
            .clone()
            .oneshot(request("HEAD", &url, Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            text.len().to_string()
        );
        assert!(to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .is_empty());
    }
    assert_eq!(sessions.checks.load(Ordering::SeqCst), 0);
    let response = app
        .oneshot(request("GET", "/work/api/fixture", Body::empty()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[test]
fn archive_owner_checks_identity_duplicate_alias_links_and_member_bounds() {
    let valid = [(
        "entry.js",
        tar::EntryType::Regular,
        b"fixture program bytes".as_slice(),
    )];
    let (root, pin, _) = module_fixture(&valid);
    assert!(ScreenModules::open(root.path(), &pin).is_ok());
    assert!(ScreenModules::open(root.path(), &"0".repeat(64)).is_err());
    for entries in [
        vec![
            ("entry.js", tar::EntryType::Regular, b"a".as_slice()),
            ("entry.js", tar::EntryType::Regular, b"b".as_slice()),
        ],
        vec![("../entry.js", tar::EntryType::Regular, b"a".as_slice())],
        vec![("a/../entry.js", tar::EntryType::Regular, b"a".as_slice())],
        vec![("entry.js", tar::EntryType::Symlink, b"".as_slice())],
        vec![("entry.js", tar::EntryType::Link, b"".as_slice())],
    ] {
        let (root, pin, _) = module_fixture(&entries);
        assert!(ScreenModules::open(root.path(), &pin).is_err());
    }
    let large = vec![b'x'; 8 * 1024 * 1024 + 1];
    let (root, pin, _) = module_fixture(&[("entry.js", tar::EntryType::Regular, &large)]);
    assert!(matches!(
        ScreenModules::open(root.path(), &pin),
        Err(WorkspaceError::TooLarge(_))
    ));
    let (root, pin, _) = module_fixture(&valid);
    let archive = fs::read_dir(root.path().join("screen-modules"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut bytes = fs::read(&archive).unwrap();
    bytes[0] ^= 1;
    fs::write(archive, bytes).unwrap();
    assert!(ScreenModules::open(root.path(), &pin).is_err());
}

#[tokio::test]
async fn public_identity_module_keeps_its_original_policy_without_admitting_account_api() {
    let f = fixture();
    let (modules, pin, url) = module_fixture(&[(
        "entry.js",
        tar::EntryType::Regular,
        b"fixture program bytes",
    )]);
    let mut manifest: Value = serde_json::from_slice(&f.manifest).unwrap();
    manifest["import_map"]["imports"]["@fixture/module"] = json!(url);
    let manifest = serde_json::to_vec(&manifest).unwrap();
    fs::write(f.directory.path().join("workspace/files.json"), &manifest).unwrap();
    assert!(WorkspaceAssets::open(
        f.directory.path(),
        blake3::hash(&manifest).to_hex().as_str(),
        &tree_pin(f.directory.path())
    )
    .is_err());
    let assets = Arc::new(
        WorkspaceAssets::open_with_modules(
            f.directory.path(),
            blake3::hash(&manifest).to_hex().as_str(),
            &tree_pin(f.directory.path()),
            Some(ScreenModules::open(modules.path(), &pin).unwrap()),
        )
        .unwrap(),
    );
    let (sessions, operations) = supplies();
    sessions.allowed.store(false, Ordering::SeqCst);
    let app = app(
        assets,
        sessions.clone(),
        operations,
        None,
        WorkspaceLimits::default(),
    );
    let ask = Request::builder()
        .uri(&url)
        .header(header::ORIGIN, "https://fixture-chunk.invalid")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(ask).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    assert!(response.headers()["x-content-identity"]
        .to_str()
        .unwrap()
        .starts_with("1f:"));
    assert_eq!(
        to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
        b"fixture program bytes"
    );
    assert_eq!(
        sessions.checks.load(Ordering::SeqCst),
        0,
        "public code is not an account session check"
    );
    let response = app
        .oneshot(request("GET", "/work/api/fixture", Body::empty()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(!response
        .headers()
        .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
}

#[test]
fn exact_manifest_complete_tree_paths_and_changed_asset_refuse() {
    let f = fixture();
    assert_eq!(f.assets.read("/workspace/files.json").unwrap(), f.manifest);
    for path in [
        "/workspace/../private",
        "/workspace/%2e%2e/private",
        "/workspace/named/%2fentry.dat",
        "/workspace/named/%5centry.dat",
        "/workspace/named/%00",
        "/workspace/named/%GG",
        "/workspace//entry.dat",
        "/other/entry.dat",
    ] {
        assert!(f.assets.read(path).is_err(), "{path}");
    }
    assert!(WorkspaceAssets::open(
        f.directory.path(),
        &"0".repeat(64),
        f.assets.tree_identity()
    )
    .is_err());
    assert!(WorkspaceAssets::open(
        f.directory.path(),
        f.assets.manifest_identity(),
        &"0".repeat(64)
    )
    .is_err());
    fs::write(
        f.directory.path().join("workspace/named/entry.dat"),
        "TEST entry bytes",
    )
    .unwrap();
    assert!(matches!(
        f.assets.read("/workspace/named/entry.dat"),
        Err(WorkspaceError::Integrity(_))
    ));
}

#[test]
fn a_kept_tree_opens_from_its_rows_and_still_refuses_a_changed_asset_on_read() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture();
    let kept = tempfile::tempdir().unwrap();
    let folder = kept.path().join("trees");
    let (manifest, tree) = (
        f.assets.manifest_identity().to_owned(),
        f.assets.tree_identity().to_owned(),
    );
    // The first open reads the tree and keeps its rows under the tree identity; the rows are the tree identity's bytes.
    let first =
        WorkspaceAssets::open_keeping(f.directory.path(), &manifest, &tree, None, Some(&folder))
            .unwrap();
    let rows = fs::read(folder.join(&tree)).unwrap();
    assert_eq!(
        content_crypto::advanced::blake3::hash(&rows)
            .to_hex()
            .as_str(),
        tree
    );
    assert_eq!(
        fs::metadata(&folder).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        first.read("/workspace/named/entry.dat").unwrap(),
        b"test entry bytes"
    );
    // A later open reads the kept rows, not the assets: an asset it cannot read does not stop the open, only its read.
    let entry = f.directory.path().join("workspace/named/entry.dat");
    fs::set_permissions(&entry, fs::Permissions::from_mode(0o000)).unwrap();
    let again =
        WorkspaceAssets::open_keeping(f.directory.path(), &manifest, &tree, None, Some(&folder))
            .unwrap();
    assert!(
        WorkspaceAssets::open(f.directory.path(), &manifest, &tree).is_err(),
        "reading the whole tree meets the unreadable asset"
    );
    assert!(again.read("/workspace/named/entry.dat").is_err());
    fs::set_permissions(&entry, fs::Permissions::from_mode(0o644)).unwrap();
    // A changed asset is refused when read, with the kept rows as with a full read.
    fs::write(&entry, "TEST entry bytes").unwrap();
    let changed =
        WorkspaceAssets::open_keeping(f.directory.path(), &manifest, &tree, None, Some(&folder))
            .unwrap();
    assert!(matches!(
        changed.read("/workspace/named/entry.dat"),
        Err(WorkspaceError::Integrity(_))
    ));
    assert_eq!(
        changed.read("/workspace/named/look.dat").unwrap(),
        b"test look bytes"
    );
    fs::write(&entry, "test entry bytes").unwrap();
    // Kept rows that are not the tree identity's bytes are never used: the tree is read again and kept again.
    fs::write(
        folder.join(&tree),
        rows.iter()
            .map(|b| if *b == b'1' { b'2' } else { *b })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    WorkspaceAssets::open_keeping(f.directory.path(), &manifest, &tree, None, Some(&folder))
        .unwrap();
    assert_eq!(fs::read(folder.join(&tree)).unwrap(), rows);
    // Another tree identity is refused whatever is kept.
    assert!(WorkspaceAssets::open_keeping(
        f.directory.path(),
        &manifest,
        &"0".repeat(64),
        None,
        Some(&folder)
    )
    .is_err());
}

#[test]
fn tree_refuses_external_symlink_and_missing_manifest_reference() {
    let f = fixture();
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::os::unix::fs::symlink(outside.path(), f.directory.path().join("workspace/outside"))
        .unwrap();
    assert!(WorkspaceAssets::open(
        f.directory.path(),
        f.assets.manifest_identity(),
        f.assets.tree_identity()
    )
    .is_err());
    fs::remove_file(f.directory.path().join("workspace/outside")).unwrap();
    let mut manifest: Value = serde_json::from_slice(&f.manifest).unwrap();
    manifest["script"] = json!("/workspace/missing");
    let bytes = serde_json::to_vec(&manifest).unwrap();
    fs::write(f.directory.path().join("workspace/files.json"), &bytes).unwrap();
    assert!(WorkspaceAssets::open(
        f.directory.path(),
        blake3::hash(&bytes).to_hex().as_str(),
        &tree_pin(f.directory.path())
    )
    .is_err());
}

#[tokio::test]
async fn missing_real_supplies_and_revoked_session_never_dispatch() {
    let f = fixture();
    let no = route_table(
        f.assets.clone(),
        WorkspaceSupplies {
            sessions: None,
            operations: None,
            live: None,
            dom: dom(),
        },
        WorkspaceLimits::default(),
    )
    .unwrap();
    for path in ["/", "/work/api/viewer", "/work/live"] {
        assert_eq!(
            no.clone()
                .oneshot(request("GET", path, Body::empty()))
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    assert_eq!(
        no.oneshot(request("GET", "/workspace/files.json", Body::empty()))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let (sessions, operations) = supplies();
    sessions.allowed.store(false, Ordering::SeqCst);
    let app = app(
        f.assets,
        sessions,
        operations.clone(),
        None,
        WorkspaceLimits::default(),
    );
    assert_eq!(
        app.oneshot(request("POST", "/work/api/arbitrary", Body::from("{}")))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(operations.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn html_keeps_supplied_shell_and_escapes_exact_first_answer_contract() {
    let f = fixture();
    let html = render_page(&f.assets, &dom(), page(), 1024 * 1024, NONCE).unwrap();
    assert!(html.contains("data-fixture-preserved=\"yes\""));
    assert!(html.contains("type=\"importmap\""));
    assert!(html.contains("id=\"page-answers\""));
    assert!(html.contains("id=\"page-item-answers\""));
    assert!(html.contains("data-page-answer=\"/work/api/fixture?label=a&amp;label=b\""));
    assert!(html.contains("\\u003c/script>\\u003cimg src=x>"));
    assert!(!html.contains("</script><img"));
    assert!(html.contains("\"next_before\":\"fixture-cursor\""));
    assert!(html.contains("/workspace/named/entry.dat"));
    let mut changed = page();
    changed.known.push(("page-answers".into(), json!([])));
    assert!(render_page(&f.assets, &dom(), changed, 1024 * 1024, NONCE).is_err());
    let mut changed = page();
    changed.document = "<html><head></head><body></body></html>".into();
    assert!(render_page(&f.assets, &dom(), changed, 1024 * 1024, NONCE).is_err());
    let mut changed = page();
    changed.answers[0].envelope = json!({"status":200,"body":"<".repeat(4096)}).into();
    assert!(matches!(
        render_page(&f.assets, &dom(), changed, 2048, NONCE),
        Err(WorkspaceError::TooLarge(_))
    ));
    assert!(WorkspaceDom::from_source(DOM, &"0".repeat(64)).is_err());
}

// The page policy is product DATA (src/server/page-policy.json); every HTML page carries it with a fresh
// nonce, the import map and the document's plain inline scripts carry that nonce, and connect-src names exactly the
// admitted loopback Host. A Host that is not a loopback socket address never reaches the header.
#[tokio::test]
async fn every_page_carries_the_data_policy_with_a_fresh_nonce_on_its_scripts() {
    let f = fixture();
    let (sessions, operations) = supplies();
    let app = app(
        f.assets,
        sessions,
        operations,
        None,
        WorkspaceLimits::default(),
    );
    let mut nonces = std::collections::BTreeSet::new();
    for _ in 0..2 {
        let response = app
            .clone()
            .oneshot(request("GET", "/", Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let policy = response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .to_owned();
        let nonce = policy
            .split("'nonce-")
            .nth(1)
            .unwrap()
            .split('\'')
            .next()
            .unwrap()
            .to_owned();
        assert_eq!(policy,format!("script-src 'self' 'nonce-{nonce}' 'wasm-unsafe-eval'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; connect-src 'self' ws://127.0.0.1:9999 http://127.0.0.1:9999"));
        assert_eq!(nonce.len(), 24);
        assert!(nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')));
        let html = String::from_utf8(
            to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(html.contains(&format!("<script type=\"importmap\" nonce=\"{nonce}\">")));
        assert!(nonces.insert(nonce), "each response has its own nonce");
    }
    for host in [
        "evil.example:9999",
        "localhost:9999",
        "10.0.0.1:9999",
        "127.0.0.1:0",
    ] {
        let request = Request::builder()
            .uri("/")
            .header(header::HOST, host)
            .header(header::COOKIE, "fixture-session=yes")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{host}");
        assert!(response.headers().get("content-security-policy").is_none());
    }
    let mut inline = page();
    inline.document = inline.document.replace(
        "<body>",
        "<body><script>window.cover=1</script><script type=\"text/plain\">x</script>",
    );
    let html = render_page(&fixture().assets, &dom(), inline, 1024 * 1024, NONCE).unwrap();
    assert!(html.contains(&format!(
        "<script nonce=\"{NONCE}\">window.cover=1</script>"
    )));
    assert!(!html.contains("<script>"));
    assert!(
        html.contains("<script type=\"text/plain\">x</script>"),
        "only a plain inline script is stamped"
    );
    assert!(render_page(&fixture().assets, &dom(), page(), 1024 * 1024, "short").is_err());
    assert!(render_page(
        &fixture().assets,
        &dom(),
        page(),
        1024 * 1024,
        "fixture\"nonce\"0123456789"
    )
    .is_err());
}

#[tokio::test]
async fn canonical_request_is_unchanged_and_body_bounds_precede_dispatch() {
    let f = fixture();
    let (sessions, operations) = supplies();
    let limits = WorkspaceLimits {
        request_bytes: 32,
        response_bytes: 1024,
        ..WorkspaceLimits::default()
    };
    let app = app(f.assets, sessions, operations.clone(), None, limits);
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            "/work/api/arbitrary?cursor=original",
            Body::from("{\"value\":null}"),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    drop(response);
    assert_eq!(
        operations.seen.lock().unwrap()[0],
        json!({"account":"fixture-account","method":"POST","uri":"/work/api/arbitrary?cursor=original","key":"fixture-original-key","body":"{\"value\":null}"})
    );
    assert_eq!(
        app.clone()
            .oneshot(request(
                "POST",
                "/work/api/arbitrary",
                Body::from(vec![0_u8; 33])
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(operations.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        app.clone()
            .oneshot(request("GET", "/work/api/large", Body::empty()))
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let response = app
        .oneshot(request("GET", "/work/api/unknown-large", Body::empty()))
        .await
        .unwrap();
    assert!(
        to_bytes(response.into_body(), 8192).await.is_err(),
        "oversized stream must error, never truncate to a successful EOF"
    );
}

/// One request at a time, and a request past it waits 50 ms for its permit before it is refused busy.
fn one_slot() -> WorkspaceLimits {
    WorkspaceLimits {
        max_inflight: 1,
        admission_wait: std::time::Duration::from_millis(50),
        ..WorkspaceLimits::default()
    }
}

#[tokio::test]
async fn admission_lasts_through_response_and_detached_worker_cancellation() {
    let f = fixture();
    let (sessions, operations) = supplies();
    let app = app(f.assets, sessions, operations.clone(), None, one_slot());
    let first = app
        .clone()
        .oneshot(request("GET", "/work/api/hold-worker", Body::empty()))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let second = app
        .clone()
        .oneshot(request("GET", "/work/api/anything", Body::empty()))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::SERVICE_UNAVAILABLE);
    drop(second);
    drop(first);
    assert!(operations
        .held
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .cancelled());
    assert_eq!(
        app.clone()
            .oneshot(request("GET", "/work/api/anything", Body::empty()))
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    operations.held.lock().unwrap().take();
    assert_eq!(
        app.oneshot(request("GET", "/work/api/anything", Body::empty()))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn ordinary_operation_upgrade_status_does_not_transfer_live_lifetime() {
    for path in ["/work/api/hold-upgrade", "/work/liveish"] {
        let f = fixture();
        let (sessions, operations) = supplies();
        let app = app(f.assets, sessions, operations.clone(), None, one_slot());
        let response = app
            .clone()
            .oneshot(request("GET", path, Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        drop(response);
        assert!(
            operations
                .held
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .cancelled(),
            "an ordinary operation's 101 response must still cancel detached work on drop"
        );
        assert_eq!(
            app.clone()
                .oneshot(request("GET", "/work/api/anything", Body::empty()))
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        operations.held.lock().unwrap().take();
        assert_eq!(
            app.oneshot(request("GET", "/work/api/anything", Body::empty()))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
}

#[tokio::test]
async fn live_upgrade_hands_lifetime_to_supplied_live_owner() {
    for path in ["/work/live?after=source", "/work/live/nested?after=source"] {
        let f = fixture();
        let (sessions, operations) = supplies();
        let live = Arc::new(Live {
            held: Mutex::new(None),
        });
        let app = app(
            f.assets,
            sessions,
            operations,
            Some(live.clone()),
            one_slot(),
        );
        let upgrade = app
            .clone()
            .oneshot(request("GET", path, Body::empty()))
            .await
            .unwrap();
        assert_eq!(upgrade.status(), StatusCode::SWITCHING_PROTOCOLS);
        drop(upgrade);
        assert!(
            !live.held.lock().unwrap().as_ref().unwrap().cancelled(),
            "101 HTTP body drop must not kill upgraded connection"
        );
        // An open socket takes no request's permit: the page's reads run beside it.
        assert_eq!(
            app.clone()
                .oneshot(request("GET", "/work/api/anything", Body::empty()))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        // A socket past the live bound is refused at once, and the held one keeps its lifetime.
        assert_eq!(
            app.clone()
                .oneshot(request("GET", path, Body::empty()))
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert!(!live.held.lock().unwrap().as_ref().unwrap().cancelled());
        let permit = live.held.lock().unwrap().take().unwrap();
        permit.cancel();
        drop(permit);
        assert_eq!(
            app.clone()
                .oneshot(request("GET", path, Body::empty()))
                .await
                .unwrap()
                .status(),
            StatusCode::SWITCHING_PROTOCOLS
        );
        live.held.lock().unwrap().take();
        assert_eq!(
            app.oneshot(request("GET", "/work/api/anything", Body::empty()))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
}

/// A page opens with more reads at once than run at once (the Mac app's boot sends a dozen): the ones past the permits
/// wait their turn and are answered, never refused busy while the permits are only briefly taken.
#[tokio::test]
async fn a_burst_past_the_slots_waits_its_turn_and_is_answered() {
    let f = fixture();
    let (sessions, operations) = supplies();
    let app = app(
        f.assets,
        sessions,
        operations.clone(),
        None,
        WorkspaceLimits {
            max_inflight: 1,
            ..WorkspaceLimits::default()
        },
    );
    let first = app
        .clone()
        .oneshot(request("GET", "/work/api/hold-worker", Body::empty()))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let waiting: Vec<_> = (0..12)
        .map(|_| {
            let app = app.clone();
            tokio::spawn(async move {
                let response = app
                    .oneshot(request("GET", "/work/api/anything", Body::empty()))
                    .await
                    .unwrap();
                let status = response.status();
                to_bytes(response.into_body(), 8192).await.unwrap();
                status
            })
        })
        .collect();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        waiting.iter().all(|task| !task.is_finished()),
        "no request past the slot is refused while it waits"
    );
    drop(first);
    operations.held.lock().unwrap().take();
    for task in waiting {
        assert_eq!(task.await.unwrap(), StatusCode::OK);
    }
}

/// The queue is bounded: a request past `max_waiting` is refused busy at once, and one that waits past
/// `admission_wait` is refused busy then.
#[tokio::test]
async fn the_queue_is_bounded_by_count_and_wait() {
    let f = fixture();
    let (sessions, operations) = supplies();
    let app = app(
        f.assets,
        sessions,
        operations.clone(),
        None,
        WorkspaceLimits {
            max_inflight: 1,
            max_waiting: 1,
            admission_wait: std::time::Duration::from_millis(300),
            ..WorkspaceLimits::default()
        },
    );
    let first = app
        .clone()
        .oneshot(request("GET", "/work/api/hold-worker", Body::empty()))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let queued = {
        let app = app.clone();
        tokio::spawn(async move {
            app.oneshot(request("GET", "/work/api/anything", Body::empty()))
                .await
                .unwrap()
                .status()
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let started = std::time::Instant::now();
    assert_eq!(
        app.clone()
            .oneshot(request("GET", "/work/api/anything", Body::empty()))
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(
        started.elapsed() < std::time::Duration::from_millis(100),
        "a full queue refuses at once"
    );
    assert_eq!(
        queued.await.unwrap(),
        StatusCode::SERVICE_UNAVAILABLE,
        "a request that waited past admission_wait is refused busy"
    );
    drop(first);
    operations.held.lock().unwrap().take();
    assert_eq!(
        app.oneshot(request("GET", "/work/api/anything", Body::empty()))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
#[ignore = "requires exact retained original frontend; run explicitly in owner's shared queue"]
async fn actual_retained_frontend_assets_and_declared_source_closure_are_consumed() {
    let package = std::env::var_os("TRILLION_FRONTEND_PACKAGE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(
                std::env::var_os("RETIRED_SNAPSHOT_ROOT")
                    .expect("RETIRED_SNAPSHOT_ROOT test setting"),
            )
            .join(".local/local-runtime-packages/20261025-canonical-dist")
        });
    let active = package.ancestors().nth(3).unwrap();
    let modules = ScreenModules::open(
        package.join("built"),
        "fd30c9e90ac85aa4247c993e93c4befd8e899a27a918cc501809aec2e4924d5e",
    )
    .unwrap();
    let assets = Arc::new(
        WorkspaceAssets::open_with_modules(
            package.join("built/assets"),
            "b39a619a100261c09f17381fcf54f7315509483e738df7621f28a2ff436b1cdd",
            "45815ef655bc8ebb56d273acb68ff2efc8a652ce799721cc5339adbc4b8f7894",
            Some(modules),
        )
        .unwrap(),
    );
    let declared: Vec<String> =
        serde_json::from_slice(&fs::read(package.join("built/workspace.inputs.json")).unwrap())
            .unwrap();
    assert_eq!(declared.len(), 6164);
    let mut categories = BTreeMap::<String, usize>::new();
    for name in declared {
        let rel = Path::new(&name);
        assert!(
            !rel.is_absolute()
                && !rel
                    .components()
                    .any(|p| matches!(p, std::path::Component::ParentDir))
        );
        assert_eq!(
            blake3::hash(&fs::read(package.join(rel)).unwrap()),
            blake3::hash(&fs::read(active.join(rel)).unwrap()),
            "source drift: {name}"
        );
        *categories
            .entry(if name.starts_with("node_modules/") {
                "dependency".into()
            } else {
                "project".into()
            })
            .or_default() += 1;
    }
    assert_eq!(categories.get("project"), Some(&2943));
    assert_eq!(categories.get("dependency"), Some(&3221));
    assert_eq!(assets.manifest()["screens"].as_object().unwrap().len(), 67);
    let selected = assets.manifest()["script"].as_str().unwrap().to_owned();
    let source = fs::read(package.join("src/workspace/first-answers.json")).unwrap();
    let (sessions, operations) = supplies();
    let app = route_table(
        assets.clone(),
        WorkspaceSupplies {
            sessions: Some(sessions),
            operations: Some(operations),
            live: None,
            dom: WorkspaceDom::from_source(&source, blake3::hash(&source).to_hex().as_str())
                .unwrap(),
        },
        WorkspaceLimits::default(),
    )
    .unwrap();
    for path in ["/workspace/files.json", &selected] {
        let expected = fs::read(
            package
                .join("built/assets")
                .join(path.trim_start_matches('/')),
        )
        .unwrap();
        let response = app
            .clone()
            .oneshot(request("GET", path, Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), 64 * 1024 * 1024)
                .await
                .unwrap()
                .as_ref(),
            expected.as_slice()
        );
    }
    // Independent Python tarfile readback supplied these exact entry identities.
    let expected = BTreeMap::from([
        (
            "1f:fd2dc0c31890a3c8a02bcd7c7292f7c464bb4ca7ee4a115d8262260b072f8b7c",
            "241d8ec1920a58007d2d06d3aaee2f49256986da774c3525b4bbfb1982d0a12f",
        ),
        (
            "1f:fac42b7418660bd52e80b35c5703b04ec4ac4bbcac1412656c91d78ac5c252b3",
            "29428d7f0c52d86e65aca0de9e9d82c191d95f33e813f48d7169ea9e741d5d92",
        ),
        (
            "1f:41ba636cf751d3b0f80856752ba172f5c87e0317d3d0465851ecd6660f64ecb0",
            "195bbd38819c629f9836424c607b31990a9e7752d618812112227d9b5cc4ba84",
        ),
        (
            "1f:c11966bc13f4f011e7de8a2d652cda459c8706178707c2c80e48a393825b7193",
            "4239097890c82ae07438e03834fc64952bef6d541c517da3c834db7584f29baa",
        ),
        (
            "1f:bfcbc10ca6234fd4c26f7c4f7b379a06188f10bfb24e8e3aed82b0c6747fd269",
            "d9e20dcc115193398c5ce3712a8a9077084563c81ada3a0969e08b8b4177405d",
        ),
    ]);
    let mut read = 0;
    for value in assets.manifest()["import_map"]["imports"]
        .as_object()
        .unwrap()
        .values()
    {
        let path = value.as_str().unwrap();
        if !path.starts_with("/workshop/modules/") {
            continue;
        }
        let response = app
            .clone()
            .oneshot(request("GET", path, Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let identity = response.headers()["x-content-identity"]
            .to_str()
            .unwrap()
            .to_owned();
        let body = to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(
            blake3::hash(&body).to_hex().as_str(),
            *expected.get(identity.as_str()).unwrap()
        );
        read += 1;
    }
    assert_eq!(read, 5);
}

struct StreamingOperations {
    started: Arc<AtomicUsize>,
    held: Mutex<Option<WorkspacePermit>>,
}
impl WorkspaceOperations for StreamingOperations {
    fn page(
        &self,
        _: WorkspaceSession,
        _: WorkspaceRequestHead,
        _: WorkspacePermit,
    ) -> SupplyFuture<WorkspacePage> {
        Box::pin(async { Err(trillion_local::cause!(WorkspaceError::Unavailable)) })
    }
    fn invoke(
        &self,
        _: WorkspaceSession,
        _: WorkspaceRequest,
        _: WorkspacePermit,
    ) -> SupplyFuture<Response> {
        Box::pin(async { Err(trillion_local::cause!(WorkspaceError::Unavailable)) })
    }
    fn page_response(
        &self,
        _: WorkspaceSession,
        _: WorkspaceRequestHead,
        permit: WorkspacePermit,
    ) -> SupplyFuture<WorkspacePageResponse> {
        use trillion_local::workspace_stream::{ReadSpec, StreamLimits, WorkspaceReadBatch};
        self.held.lock().unwrap().replace(permit.clone());
        let started = self.started.clone();
        Box::pin(async move {
            let mut page = page();
            page.answers.clear();
            page.listed_reads = vec![
                "/work/api/screen-revision".into(),
                "/work/api/fast?x=a&y=b".into(),
                "/work/api/slow".into(),
            ];
            let reads = WorkspaceReadBatch {
                confirm_session: Box::new(|| Box::pin(async { Ok(()) })),
                revision: ReadSpec::new(
                    "/work/api/screen-revision",
                    false,
                    Box::new(|| {
                        Box::pin(async {
                            Ok(Some(json!({"status":200,"body":{"revision":7}}).into()))
                        })
                    }),
                ),
                current: vec![
                    ReadSpec::new(
                        "/work/api/fast?x=a&y=b",
                        false,
                        Box::new(move || {
                            started.fetch_add(1, Ordering::SeqCst);
                            Box::pin(async {
                                Ok(Some(json!({"status":200,"body":{"text":"</script><img src=x>"},"next_before":"kept-cursor","collection_coverage":{"complete":false}}).into()))
                            })
                        }),
                    ),
                    ReadSpec::new(
                        "/work/api/slow",
                        false,
                        Box::new(|| Box::pin(std::future::pending())),
                    ),
                ],
                copies: vec![],
                permit,
                retention: None,
            };
            Ok(WorkspacePageResponse::Stream(WorkspaceStreamingPage {
                page,
                reads,
                limits: StreamLimits {
                    document_timeout: std::time::Duration::from_millis(30),
                    read_timeout: std::time::Duration::from_millis(150),
                    ..StreamLimits::default()
                },
            }))
        })
    }
}
#[tokio::test]
async fn actual_workspace_stream_emits_preserved_head_then_escaped_ready_answers_and_cancels_on_disconnect(
) {
    for disconnect in [false, true] {
        let f = fixture();
        let (sessions, _) = supplies();
        let operations = Arc::new(StreamingOperations {
            started: Arc::new(AtomicUsize::new(0)),
            held: Mutex::new(None),
        });
        let app = route_table(
            f.assets,
            WorkspaceSupplies {
                sessions: Some(sessions),
                operations: Some(operations.clone()),
                live: None,
                dom: dom(),
            },
            WorkspaceLimits::default(),
        )
        .unwrap();
        let response = app
            .oneshot(request("GET", "/", Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .starts_with("script-src 'self' 'nonce-"),
            "a streamed page carries the page policy too"
        );
        let mut body = response.into_body();
        let chunk = std::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
            .await
            .unwrap()
            .unwrap();
        let prefix = String::from_utf8(chunk.into_data().unwrap().to_vec()).unwrap();
        assert!(prefix.contains("data-fixture-preserved=\"yes\""));
        assert!(prefix.contains("type=\"module\""));
        assert!(!prefix.contains("data-page-answer="));
        assert_eq!(operations.started.load(Ordering::SeqCst), 0);
        if disconnect {
            drop(body);
        } else {
            let tail = tokio::time::timeout(
                std::time::Duration::from_millis(300),
                to_bytes(body, 1024 * 1024),
            )
            .await
            .unwrap()
            .unwrap();
            let tail = String::from_utf8(tail.to_vec()).unwrap();
            assert!(tail.contains("data-page-answer=\"/work/api/fast?x=a&amp;y=b\""));
            assert!(tail.contains("\\u003c/script>"));
            assert!(tail.contains("kept-cursor"));
            assert!(tail.contains("collection_coverage"));
            assert!(!tail.contains("<img src=x>"));
            assert!(!tail.contains("data-page-answer=\"/work/api/slow\""));
            assert!(tail.ends_with("</body></html>"));
            assert_eq!(operations.started.load(Ordering::SeqCst), 1);
        }
        assert!(
            operations
                .held
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .cancelled(),
            "no retention owner: document EOF or disconnect must cancel original pending work"
        );
    }
}

/// Ported from old trillion test/work-live-worker-route.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
/// deleted by Trillion-X/trillion #243: "a signed-in browser's /work/live upgrade reaches its own records book after its
/// subscribe admission" and "a signed-in browser's space board upgrade reaches its board room". The old Worker's resource
/// route block (which answered both 503 before their own handlers) is this route table: a signed-in browser's /work/live
/// upgrade, and a space board's /work/live/board/<id>, reach the account's live owner (`WorkspaceLive::subscribe`) after
/// the session check, never a resource-route refusal; one without its session reaches nothing. The old book's refusal
/// log line (src/failure-reason.mjs reasonOf) is left out: the live owner here logs no refusal reason.
#[tokio::test]
async fn old_work_live_worker_route_a_signed_in_browsers_live_and_board_upgrades_reach_the_live_owner(
) {
    for path in ["/work/live", "/work/live/board/space-one"] {
        let f = fixture();
        let (sessions, operations) = supplies();
        let live = Arc::new(Live {
            held: Mutex::new(None),
        });
        let app = app(
            f.assets,
            sessions.clone(),
            operations,
            Some(live.clone()),
            one_slot(),
        );
        let mut unsigned = request("GET", path, Body::empty());
        unsigned.headers_mut().remove(header::COOKIE);
        assert_eq!(
            app.clone().oneshot(unsigned).await.unwrap().status(),
            StatusCode::UNAUTHORIZED,
            "{path}: no session, no socket"
        );
        assert!(live.held.lock().unwrap().is_none());
        let upgrade = app
            .oneshot(request("GET", path, Body::empty()))
            .await
            .unwrap();
        assert_eq!(
            upgrade.status(),
            StatusCode::SWITCHING_PROTOCOLS,
            "{path}: the upgrade reaches the live owner, not a route refusal"
        );
        assert!(
            live.held.lock().unwrap().take().is_some(),
            "{path}: the live owner holds it"
        );
        assert!(
            sessions.checks.load(Ordering::SeqCst) >= 1,
            "{path}: after the session check"
        );
    }
}


#[tokio::test]
async fn workspace_refusal_response_preserves_public_fields_and_exact_cause() {
    use axum::response::IntoResponse;
    let first = trillion_local::cause!(WorkspaceError::NoOwner);
    let second = trillion_local::cause!(WorkspaceError::NoOwner);
    assert_ne!(first.cause(), second.cause());
    for error in [first, second] {
        let cause = error.cause();
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["failure_code"], "no-owner");
        assert_eq!(body["error"], "nothing here answers this request");
        assert_eq!(body["cause"], cause.id());
        assert_eq!(cause.file(), "tests/workspace.rs");
        assert_eq!(cause.condition(), "WorkspaceError::NoOwner");
    }
}
