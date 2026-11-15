// tests/workspace_domain.rs
//
// Purpose: Check actual route DATA translation, startup read planning and browser-to-domain dispatch.
// Non-Negotiable Invariants: Fixture capabilities are not real account/domain authority or full app proof.
// Key Concepts: Opposing route/host cases, exact source pins, preserved keys and resource selection.
// Security Considerations: No provider, original database, credential or old backend is opened.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use axum::{
    body::{to_bytes, Body},
    http::{HeaderMap, Request, StatusCode},
    Router,
};
use content_crypto::advanced::blake3;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tower::ServiceExt;
use trillion_local::{workspace::*, workspace_domain::*};
fn pin(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
const ROUTES:&[u8]=br#"{"families":[{"family":"tools","exact":["/tools"],"prefix":["/tools/"],"methods":["GET","POST"]},{"family":"screens","browser":true,"exact":["/screens"],"prefix":[]}]}"#;
const FIRST:&[u8]=br#"{"paths":{"z":"/work/api/z","a":"/work/api/a"},"workspace_records_path":"/work/api/records","startup_record_inputs":["look","layout"],"startup_preferences":["theme"],"screen_revision":"/work/api/screen-revision","screens":{"home":["/work/api/a","/work/api/home"]},"item_reads":{"screens":{"file":[{"path":["/work/api/namespace/files/",{"input":"id"}]}]}}}"#;
const INPUTS: &[u8] = br#"{"look":{"address":"screen look"},"layout":{"address":"layout:main"}}"#;
fn routes() -> OwnerRoutes {
    OwnerRoutes::from_source(ROUTES, &pin(ROUTES)).unwrap()
}
fn startup() -> StartupContract {
    StartupContract::from_sources(FIRST, &pin(FIRST), INPUTS, &pin(INPUTS)).unwrap()
}
#[test]
fn family_routes_preserve_method_browser_and_query_contract() {
    let r = routes();
    let call = r
        .resolve(
            "/tools/find",
            "GET",
            "label=a&label=b&q=hello%20world",
            None,
            None,
        )
        .unwrap()
        .unwrap();
    assert_eq!(call.operation, "tools:request");
    assert_eq!(
        call.input,
        json!({"path":"/tools/find?label=a%2Cb&q=hello+world","method":"GET","body":{}})
    );
    assert!(r
        .resolve("/tools", "DELETE", "", None, None)
        .unwrap()
        .is_none());
    let removed=br#"{"families":[{"family":"elsewhere","host":"edge","exact":["/elsewhere"],"prefix":[]}]}"#;
    assert_eq!(
        OwnerRoutes::from_source(removed, &pin(removed))
            .unwrap()
            .resolve("/elsewhere", "GET", "", None, None)
            .unwrap()
            .unwrap()
            .operation,
        "elsewhere:request"
    );
    assert!(r.resolve("/screens", "GET", "", None, None).is_err());
    let browser = json!({"origin":"https://fixture","user_agent":"fixture","visitor":""});
    assert_eq!(
        r.resolve("/screens", "GET", "", None, Some(browser.clone()))
            .unwrap()
            .unwrap()
            .input["browser"],
        browser
    );
    assert!(OwnerRoutes::from_source(ROUTES, &"0".repeat(64)).is_err());
}
#[test]
fn declared_routes_resolve_only_owners_mounted_here() {
    // One copy: the engine reads its own pinned product DATA; no launch selection names a route table.
    let routes = OwnerRoutes::from_product().unwrap();
    assert_eq!(
        routes
            .resolve(
                "/resource-connections",
                "POST",
                "",
                Some(json!({"operation":"register"})),
                None
            )
            .unwrap()
            .unwrap()
            .operation,
        "resource-connections:request"
    );
    assert!(routes
        .resolve("/resource-connections", "GET", "", None, None)
        .unwrap()
        .is_none());
    // One screen of the catalogue is the generic screen host's, for any id under /screens/ (old src/screen-host.mjs).
    assert_eq!(
        routes
            .resolve("/screens/ai", "GET", "", None, Some(json!({})))
            .unwrap()
            .unwrap()
            .operation,
        "screen-host:request"
    );
    for (path, method) in [
        ("/screen-view/read", "POST"),
        ("/tours/presentation", "GET"),
        ("/screens/ai", "POST"),
        ("/scope/focus", "POST"),
        ("/show-rules/set", "POST"),
    ] {
        assert!(
            routes
                .resolve(path, method, "", Some(json!({})), Some(json!({})))
                .unwrap()
                .is_none(),
            "{method} {path}"
        );
    }
}
#[test]
fn startup_keeps_source_order_single_label_read_and_item_copy_separation() {
    let c = startup();
    let p = c.plan(Some("home"), &BTreeMap::new()).unwrap();
    assert_eq!(p.listed_reads,vec!["/work/api/screen-revision","/work/api/z","/work/api/a","/work/api/records?label=screen%20look&label=layout%3Amain&label=workspace-preference%3Atheme","/work/api/home"]);
    let missing = c.plan(Some("file"), &BTreeMap::new()).unwrap();
    assert!(missing.item_reads.is_empty());
    let p = c
        .plan(
            Some("file"),
            &BTreeMap::from([("id".into(), "one/two ?".into())]),
        )
        .unwrap();
    assert_eq!(
        p.item_reads,
        vec!["/work/api/namespace/files/one%2Ftwo%20%3F"]
    );
    assert!(p.listed_reads.contains(&p.item_reads[0]));
    assert!(!p.copied_reads.contains(&p.item_reads[0]));
    assert!(StartupContract::from_sources(FIRST, &pin(FIRST), b"{}", &pin(b"{}")).is_err());
}
#[test]
#[ignore = "requires the preserved actual frontend source DATA; explicitly select in sole shared queue"]
fn actual_pinned_startup_data_is_consumed() {
    let root = PathBuf::from(
        std::env::var_os("RETIRED_SNAPSHOT_ROOT").expect("RETIRED_SNAPSHOT_ROOT test setting"),
    );
    let first = fs::read(root.join("src/workspace/first-answers.json")).unwrap();
    let inputs = fs::read(root.join("src/workspace/inputs.json")).unwrap();
    let plan = StartupContract::from_sources(
        &first,
        "8a6165409748a5467c0d3d14941c6348d067b34501f8bc43af280048ef3e943a",
        &inputs,
        "6a580e935bc7a96cebefa683da4160e185f2d63ee5321e77d6295a3090d67f93",
    )
    .unwrap()
    .plan(
        Some("file"),
        &BTreeMap::from([("id".into(), "actual:file".into())]),
    )
    .unwrap();
    let labels = plan
        .copied_reads
        .iter()
        .find(|v| v.starts_with("/work/api/records?"))
        .unwrap();
    assert_eq!(labels.matches("label=").count(), 11);
    assert!(labels.starts_with("/work/api/records?label=screen-arrangement-layout-state&label=screen-arrangement-own-layouts&label=layout-presets"));
    assert_eq!(plan.item_reads.len(), 3);
    assert!(plan
        .item_reads
        .iter()
        .all(|p| !plan.copied_reads.contains(p)));
}
struct Executor {
    calls: Mutex<Vec<Value>>,
    keys: AtomicUsize,
    read_only: AtomicBool,
    heads: AtomicUsize,
}
impl CanonicalWorkspaceExecutor for Executor {
    fn authorize(&self, _: DomainContext) -> SupplyFuture<BrowserScope> {
        let read_only = self.read_only.load(Ordering::SeqCst);
        Box::pin(async move {
            Ok(BrowserScope {
                origin: "http://127.0.0.1:9999".into(),
                page_store: "fixture-store".into(),
                read_only,
            })
        })
    }
    fn request_key(&self, _: DomainContext, _: String, _: Value) -> SupplyFuture<String> {
        self.keys.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok("fixture-original-captured-key".into()) })
    }
    fn select_resource(&self, _: DomainContext, c: DomainCommand) -> SupplyFuture<String> {
        self.calls.lock().unwrap().push(json!({"phase":"select","operation":c.operation,"input":c.input,"key":c.request_key,"carried":c.key_carried}));
        Box::pin(async { Ok("fixture-selected-resource".into()) })
    }
    fn execute(&self, _: DomainContext, r: String, c: DomainCommand) -> SupplyFuture<DomainAnswer> {
        self.calls.lock().unwrap().push(json!({"phase":"execute","operation":c.operation,"input":c.input,"key":c.request_key,"carried":c.key_carried,"resource":r}));
        Box::pin(async {
            Ok(DomainAnswer::Json {
                body: json!([{"fixture":true}]),
                next_before: Some("fixture-next".into()),
                collection_coverage: Some(json!({"complete":false})),
            })
        })
    }
    fn heads(&self, _: DomainContext) -> SupplyFuture<DomainAnswer> {
        self.heads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok(DomainAnswer::Http {
                status: StatusCode::TOO_MANY_REQUESTS,
                headers: {
                    let mut headers = HeaderMap::new();
                    headers.insert("retry-after", "2".parse().unwrap());
                    headers
                },
                body: br#"{"error":"fixture busy","step_needed":"fixture"}"#.to_vec(),
            })
        })
    }
}
struct Session;
impl CurrentSession for Session {
    fn current(
        &self,
        _: WorkspaceRequestHead,
        _: WorkspacePermit,
    ) -> SupplyFuture<WorkspaceSession> {
        Box::pin(async {
            Ok(WorkspaceSession {
                account_id: "fixture".into(),
                session_id: "fixture-sign-in".into(),
            })
        })
    }
}
fn app() -> (tempfile::TempDir, Router, Arc<Executor>) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("workspace")).unwrap();
    fs::write(dir.path().join("workspace/program.dat"), b"fixture bytes").unwrap();
    let manifest=serde_json::to_vec(&json!({"script":"/workspace/program.dat","stylesheet":"/workspace/program.dat","preload":[],"screens":{},"import_map":{"imports":{}}})).unwrap();
    fs::write(dir.path().join("workspace/files.json"), &manifest).unwrap();
    let mut hasher = blake3::Hasher::new();
    let mode = fs::metadata(dir.path().join("workspace"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    for row in [
        json!(["workspace", "directory", mode]),
        json!([
            "workspace/files.json",
            "file",
            fs::metadata(dir.path().join("workspace/files.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            manifest.len(),
            pin(&manifest)
        ]),
        json!([
            "workspace/program.dat",
            "file",
            fs::metadata(dir.path().join("workspace/program.dat"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            13,
            pin(b"fixture bytes")
        ]),
    ] {
        hasher.update(serde_json::to_string(&row).unwrap().as_bytes());
        hasher.update(b"\n");
    }
    let assets = WorkspaceAssets::open(
        dir.path(),
        &pin(&manifest),
        hasher.finalize().to_hex().as_str(),
    )
    .unwrap();
    let executor = Arc::new(Executor {
        calls: Mutex::new(vec![]),
        keys: AtomicUsize::new(0),
        read_only: AtomicBool::new(false),
        heads: AtomicUsize::new(0),
    });
    let dom = br#"{"element_id":"page-answers","item_reads":{"element_id":"page-item-answers"}}"#;
    let operations = CanonicalWorkspace::new(routes(), startup(), executor.clone(), None);
    let app = route_table(
        Arc::new(assets),
        WorkspaceSupplies {
            sessions: Some(Arc::new(Session)),
            operations: Some(Arc::new(operations)),
            live: None,
            dom: WorkspaceDom::from_source(dom, &pin(dom)).unwrap(),
        },
        WorkspaceLimits::default(),
    )
    .unwrap();
    (dir, app, executor)
}
fn ask(method: &str, path: &str, body: &str) -> axum::http::request::Builder {
    let _ = body;
    Request::builder().method(method).uri(path)
}
#[tokio::test]
async fn actual_route_table_keeps_keys_selected_resource_array_metadata_and_transport_heads() {
    let (_dir, app, e) = app();
    let r = app
        .clone()
        .oneshot(
            ask("GET", "/work/api/records?label=a&label=b", "")
                .header("idempotency-key", "carried-original")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["x-trillion-next-before"], "fixture-next");
    assert_eq!(
        to_bytes(r.into_body(), 4096).await.unwrap().as_ref(),
        br#"[{"fixture":true}]"#
    );
    let c = e.calls.lock().unwrap();
    assert_eq!(c[0]["input"], json!({"selection":{"labels":["a","b"]}}));
    assert_eq!(c[0]["key"], c[1]["key"]);
    assert_eq!(c[1]["resource"], "fixture-selected-resource");
    drop(c);
    assert_eq!(e.keys.load(Ordering::SeqCst), 0);
    let r = app
        .clone()
        .oneshot(
            ask("HEAD", "/work/api/tools", "")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert!(to_bytes(r.into_body(), 4096).await.unwrap().is_empty());
    assert_eq!(e.keys.load(Ordering::SeqCst), 1);
    let before = e.calls.lock().unwrap().len();
    let r = app
        .oneshot(
            ask("GET", "/work/api/screen-revision", "")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.headers()["retry-after"], "2");
    assert_eq!(e.calls.lock().unwrap().len(), before);
    assert_eq!(e.heads.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn browser_refusals_and_absent_owners_never_dispatch() {
    let (_dir, app, e) = app();
    let r = app
        .clone()
        .oneshot(
            ask("POST", "/work/api/tools", "{}")
                .header("origin", "https://foreign.invalid")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let r = app
        .clone()
        .oneshot(
            ask("POST", "/work/api/tools", "{}")
                .header("origin", "http://127.0.0.1:9999")
                .header("x-trillion-page-store", "old-store")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::CONFLICT);
    let body = to_bytes(r.into_body(), 4096).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["failure_code"],
        "request-refused"
    );
    e.read_only.store(true, Ordering::SeqCst);
    let r = app
        .clone()
        .oneshot(
            ask("POST", "/work/api/tools", "{}")
                .header("origin", "http://127.0.0.1:9999")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let r = app
        .clone()
        .oneshot(ask("GET", "/", "").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    // The page policy requires the actual listener Host before it reaches
    // the deliberately absent page owner. API refusals above need no page.
    let r = app
        .clone()
        .oneshot(
            ask("GET", "/", "")
                .header("host", "127.0.0.1:9999")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    for path in [
        "/work/api/namespace/files/id",
        "/work/api/tours/presentation?part=tour-words",
        "/work/api/ai-connection",
    ] {
        let r = app
            .clone()
            .oneshot(ask("GET", path, "").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND, "{path}");
        let body = to_bytes(r.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["failure_code"],
            NO_OWNER_CODE,
            "{path}"
        );
    }
    assert!(e.calls.lock().unwrap().is_empty());
    assert_eq!(e.keys.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn viewer_read_uses_the_supplied_canonical_owner_and_ignores_query_text() {
    let (_dir, app, executor) = app();
    let response = app
        .oneshot(
            ask("GET", "/work/api/viewer?ignored=one&ignored=two", "")
                .header("idempotency-key", "viewer-carried-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(response.into_body(), 4096).await.unwrap().as_ref(),
        br#"[{"fixture":true}]"#
    );
    let calls = executor.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["phase"], "select");
    assert_eq!(calls[1]["phase"], "execute");
    for call in calls.iter() {
        assert_eq!(call["operation"], "viewer:read");
        assert_eq!(call["input"], json!({}));
        assert_eq!(call["key"], "viewer-carried-key");
        assert_eq!(call["carried"], true);
    }
    assert_eq!(calls[1]["resource"], "fixture-selected-resource");
    assert_eq!(executor.keys.load(Ordering::SeqCst), 0);
}
#[test]
fn every_page_route_names_its_engine_owner_or_none() {
    // The resolution the Mac release proof runs over every route the built web client names (trillion-local route-owners).
    let routes = OwnerRoutes::from_product().unwrap();
    let owned = |method, path| {
        trillion_local::local_workspace::route_owner(&routes, method, path).is_some()
    };
    for path in [
        "/work/api/records?label=a",
        "/work/api/viewer",
        "/work/api/screen-revision",
        "/work/api/screens",
        "/work/api/screens/connect-ai",
        "/work/api/screens/look",
        "/work/api/pursuits",
        "/work/api/client-version",
        "/work/api/workshop/screens",
        "/work/api/door/records:list",
    ] {
        assert!(owned("GET", path), "{path}");
    }
    assert!(owned("POST", "/work/api/resource-connections"));
    for path in [
        "/work/api/activity",
        "/work/api/new-work",
        "/work/api/waiting-on-you",
        "/work/api/ai-work",
        "/work/api/tours/presentation",
        "/work/api/ai-connection",
        "/work/api/namespace/growing",
        "/work/api/records/erase",
        "/work/api/records/conflicts/x",
        "/work/api/workshop/describe/tool%3Afoo",
    ] {
        assert!(!owned("GET", path), "{path}");
    }
    // Old trillion's page roads to the account files and records doors (their DATA `old_paths`): a ported path is owned, a file
    // name in a GET's URL included (refused 400, as old src/namespace.mjs:2304-2321 refused it).
    for path in [
        "/work/api/namespace/summary",
        "/work/api/namespace/files/x",
        "/work/api/recent-files",
        "/work/api/records/note-1",
    ] {
        assert!(owned("GET", path), "{path}");
    }
    for path in [
        "/work/api/namespace/listing",
        "/work/api/namespace/files/lookup",
        "/work/api/namespace/write",
    ] {
        assert!(owned("POST", path), "{path}");
    }
    assert!(!owned("GET", "/elsewhere"));
}
#[test]
fn the_page_reaches_only_the_records_doors_reads() {
    // The route row named after the door's resource turns GET /door/<operation>?input=<JSON> into the door's own call.
    let routes = OwnerRoutes::from_product().unwrap();
    let door = trillion_local::record_value::account_routes::Door::shipped().unwrap();
    let call = |path: &str, query: &str| {
        let c = routes
            .resolve(path, "GET", query, None, None)
            .unwrap()
            .unwrap();
        door.page_call(&c.operation, &c.input).unwrap()
    };
    let input = "input=%7B%22type%22%3A%22pursuit%22%2C%22reverse%22%3Atrue%7D";
    assert_eq!(
        call("/door/records:list", input).unwrap(),
        (
            "records:list".to_owned(),
            json!({"type":"pursuit","reverse":true})
        )
    );
    assert_eq!(
        call("/door/records:read", "").unwrap(),
        ("records:read".to_owned(), json!({}))
    );
    for (path, query) in [
        ("/door/records:write", ""),
        ("/door/wake:switch", ""),
        ("/door/records:read", "input=%5B1%5D"),
        ("/door/records:read", "input=%7B%7D&other=1"),
        ("/door/records:read", "input=not-json"),
    ] {
        assert!(call(path, query).is_err(), "{path}?{query}");
    }
    assert!(
        routes
            .resolve("/door/records:list", "POST", "", Some(json!({})), None)
            .unwrap()
            .is_none(),
        "reads only"
    );
    assert!(door
        .page_call(
            "screen-host:request",
            &json!({"path":"/door/records:read","method":"GET"})
        )
        .is_none());
}
