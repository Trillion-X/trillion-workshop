//! Synthetic capability executor around the REAL HTTP route table and command adapter.
//! It captures the adapter's original context/value; it cannot construct or bless
//! an ordered-input connection. No account, provider or cloud operation is performed.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use content_crypto::advanced::blake3;
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;
use trillion_local::{workspace::*, workspace_domain::*};

pub const ORIGIN: &str = "http://127.0.0.1:9999";
pub const ROUTES: &[u8] = br#"{"families":[{"family":"tools","exact":["/tools"],"prefix":["/tools/"],"methods":["GET","POST"]},{"family":"controls","exact":["/controls/read"],"prefix":[],"addressed":[{"method":"GET","prefix":"/controls/","to_method":"POST","to_path":"/controls/read","rest_field":"id"}]},{"family":"screens","browser":true,"exact":["/screens"],"prefix":[]}]}"#;
const FIRST: &[u8] = br#"{"paths":{},"workspace_records_path":"/work/api/records","startup_record_inputs":[],"screen_revision":"/work/api/screen-revision","screens":{},"item_reads":{"screens":{}}}"#;
fn pin(value: &[u8]) -> String {
    blake3::hash(value).to_hex().to_string()
}
struct Sessions(Mutex<Option<WorkspaceSession>>);
impl CurrentSession for Sessions {
    fn current(
        &self,
        _: WorkspaceRequestHead,
        _: WorkspacePermit,
    ) -> SupplyFuture<WorkspaceSession> {
        let session = self.0.lock().unwrap().take();
        Box::pin(async move { session.ok_or(trillion_local::cause!(WorkspaceError::Unauthorized)) })
    }
}
struct Capture {
    captured: Arc<Mutex<Option<(DomainContext, DomainCommand)>>>,
}
impl CanonicalWorkspaceExecutor for Capture {
    fn authorize(&self, _: DomainContext) -> SupplyFuture<BrowserScope> {
        Box::pin(async {
            Ok(BrowserScope {
                origin: ORIGIN.into(),
                page_store: "fixture".into(),
                read_only: false,
            })
        })
    }
    fn request_key(&self, _: DomainContext, _: String, _: Value) -> SupplyFuture<String> {
        Box::pin(async { Ok("fixture-generated-original-key".into()) })
    }
    fn select_resource(
        &self,
        context: DomainContext,
        command: DomainCommand,
    ) -> SupplyFuture<String> {
        let checked = command
            .ordered_input(&context)
            .map(|_| "fixture-resource".into());
        Box::pin(async move { checked })
    }
    fn execute(
        &self,
        context: DomainContext,
        _: String,
        command: DomainCommand,
    ) -> SupplyFuture<DomainAnswer> {
        *self.captured.lock().unwrap() = Some((context, command));
        Box::pin(async {
            Ok(DomainAnswer::Json {
                body: json!({"fixture":true}),
                next_before: None,
                collection_coverage: None,
            })
        })
    }
    fn heads(&self, _: DomainContext) -> SupplyFuture<DomainAnswer> {
        Box::pin(async { Err(trillion_local::cause!(WorkspaceError::Unavailable)) })
    }
}
pub struct Routed {
    pub context: DomainContext,
    pub command: DomainCommand,
    // Retain response and assets as long as the captured command is in use.
    pub response: Response,
    _assets: tempfile::TempDir,
}
pub fn session() -> WorkspaceSession {
    WorkspaceSession {
        account_id: "fixture-account".into(),
        session_id: "fixture-session".into(),
        generation: "fixture-generation".into(),
    }
}
pub async fn route(
    session: WorkspaceSession,
    method: &str,
    path: &str,
    body: &str,
    key: Option<&str>,
) -> Result<Routed, StatusCode> {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::create_dir(root.join("workspace")).unwrap();
    let bytes = b"fixture";
    fs::write(root.join("workspace/program.dat"), bytes).unwrap();
    let manifest=serde_json::to_vec(&json!({"script":"/workspace/program.dat","stylesheet":"/workspace/program.dat","preload":[],"screens":{},"import_map":{"imports":{}}})).unwrap();
    fs::write(root.join("workspace/files.json"), &manifest).unwrap();
    let mut tree = blake3::Hasher::new();
    for row in [
        json!([
            "workspace",
            "directory",
            fs::metadata(root.join("workspace"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        ]),
        json!([
            "workspace/files.json",
            "file",
            fs::metadata(root.join("workspace/files.json"))
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
            fs::metadata(root.join("workspace/program.dat"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            bytes.len(),
            pin(bytes)
        ]),
    ] {
        tree.update(serde_json::to_string(&row).unwrap().as_bytes());
        tree.update(b"\n");
    }
    let assets =
        WorkspaceAssets::open(root, &pin(&manifest), tree.finalize().to_hex().as_str()).unwrap();
    let captured = Arc::new(Mutex::new(None));
    let owner = CanonicalWorkspace::new(
        OwnerRoutes::from_source(ROUTES, &pin(ROUTES)).unwrap(),
        StartupContract::from_sources(FIRST, &pin(FIRST), b"{}", &pin(b"{}")).unwrap(),
        Arc::new(Capture {
            captured: captured.clone(),
        }),
        None,
    );
    let dom = br#"{"element_id":"answers","item_reads":{"element_id":"items"}}"#;
    let app = forwarder(
        Arc::new(assets),
        WorkspaceSupplies {
            sessions: Some(Arc::new(Sessions(Mutex::new(Some(session))))),
            operations: Some(Arc::new(owner)),
            live: None,
            dom: WorkspaceDom::from_source(dom, &pin(dom)).unwrap(),
        },
        WorkspaceLimits::default(),
    )
    .unwrap();
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("origin", ORIGIN);
    if let Some(key) = key {
        request = request.header("idempotency-key", key);
    }
    let response = app
        .oneshot(request.body(Body::from(body.to_owned())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    if status != StatusCode::OK {
        assert!(captured.lock().unwrap().is_none());
        return Err(status);
    }
    let (context, command) = captured
        .lock()
        .unwrap()
        .take()
        .expect("actual execute captured command");
    Ok(Routed {
        context,
        command,
        response,
        _assets: temp,
    })
}
pub fn route_blocking(
    session: WorkspaceSession,
    method: &str,
    path: &str,
    body: &str,
    key: &str,
) -> Routed {
    let method = method.to_owned();
    let path = path.to_owned();
    let body = body.to_owned();
    let key = key.to_owned();
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(route(session, &method, &path, &body, Some(&key)))
            .ok()
            .expect("fixture HTTP route admitted")
    })
    .join()
    .unwrap()
}
