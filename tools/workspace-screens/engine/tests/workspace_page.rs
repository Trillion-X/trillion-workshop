// tests/workspace_page.rs
// Purpose: Consume the actual captured shared shell, real retained assets and typed stream with explicit synthetic domain answers.
// Non-Negotiable Invariants: This is not a real account or a claim that missing startup producers work.
// Security Considerations: Synthetic cookies only; preserve actual artifacts and source pins; no network or browser.
// AI Assistant Directive: Preserve and extend these contracts and their qualification limits.
// Native lead deliberately exported this actual consumer target for qualification.

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    response::Response,
    Router,
};
use content_crypto::advanced::blake3;
use http_body::Body as HttpBody;
use serde_json::{json, Value};
use std::{
    fs,
    future::poll_fn,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tower::ServiceExt;
use trillion_local::{
    workspace::*,
    workspace_domain::{DomainContext, StartupContract, WorkspacePageOwner},
    workspace_page::{CapturedWorkspaceShell, WorkspacePageProducer},
    workspace_stream::StreamLimits,
};

#[path = "workspace_page/current_shell.rs"]
mod current_shell_controls;

const TOKEN: &str = "SYNTHETIC_PAGE_COOKIE_ONLY";
const ORIGIN: &str = "http://127.0.0.1:7189";
const CAPTURE: &str = "dcfb6e1c7dd996a2f9fd5dd9ae831b609e29a2a2aed1e3f6901c8fb23efd7d26";
const FIRST: &str = "8a6165409748a5467c0d3d14941c6348d067b34501f8bc43af280048ef3e943a";
fn incident() -> PathBuf {
    PathBuf::from(std::env::var_os("RETIRED_SNAPSHOT_ROOT").expect("RETIRED_SNAPSHOT_ROOT test setting"))
}
fn retired_fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/retired-snapshot")
}
fn shell_root() -> PathBuf {
    retired_fixtures().join("workspace-rust-shell")
}
fn source_root() -> PathBuf {
    retired_fixtures().join("frontend-contract")
}
fn first() -> Vec<u8> {
    fs::read(source_root().join("src/workspace/first-answers.json")).unwrap()
}
fn startup() -> Arc<StartupContract> {
    let inputs = fs::read(source_root().join("src/workspace/inputs.json")).unwrap();
    Arc::new(
        StartupContract::from_sources(
            &first(),
            FIRST,
            &inputs,
            "d2d387fed189455f9fd65bbe0af1560dd584ce97df67cb1d52e0df04460c3b70",
        )
        .unwrap(),
    )
}
fn assets() -> Arc<WorkspaceAssets> {
    static ASSETS: OnceLock<Arc<WorkspaceAssets>> = OnceLock::new();
    ASSETS
        .get_or_init(|| {
            let built =
                incident().join(".local/workspace-admin-policy-init-20261025/frontend/built");
            let modules = ScreenModules::open(
                &built,
                "fd30c9e90ac85aa4247c993e93c4befd8e899a27a918cc501809aec2e4924d5e",
            )
            .unwrap();
            Arc::new(
                WorkspaceAssets::open_with_modules(
                    built.join("assets"),
                    "8a2fc361978922174c9590e7dd1b647521886a41dc4b59e2fb71e39de66b0f7d",
                    "1f06041037bd840f063aef1743ced50abb942df4fd5d5adea7fc371695181693",
                    Some(modules),
                )
                .unwrap(),
            )
        })
        .clone()
}
struct Sessions {
    allowed: AtomicBool,
    calls: AtomicUsize,
}
impl CurrentSession for Sessions {
    fn current(
        &self,
        head: WorkspaceRequestHead,
        _: WorkspacePermit,
    ) -> SupplyFuture<WorkspaceSession> {
        let allowed = self.allowed.load(Ordering::SeqCst)
            && head
                .headers
                .get(header::COOKIE)
                .is_some_and(|v| v == format!("nm_session={TOKEN}").as_str());
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if !allowed {
                return Err(trillion_local::cause!(WorkspaceError::Unauthorized));
            }
            Ok(WorkspaceSession {
                account_id: "fixture-user".into(),
                session_id: blake3::hash(TOKEN.as_bytes()).to_hex().to_string(),
            })
        })
    }
}
struct Api {
    calls: AtomicUsize,
    paths: Mutex<Vec<String>>,
    held: Mutex<Option<WorkspacePermit>>,
    slow: bool,
    raw_body: Mutex<Option<(u16, Vec<u8>)>>,
}
impl WorkspaceOperations for Api {
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
        request: WorkspaceRequest,
        permit: WorkspacePermit,
    ) -> SupplyFuture<Response> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.paths
            .lock()
            .unwrap()
            .push(request.head.uri.to_string());
        self.held.lock().unwrap().replace(permit);
        let path = request.head.uri.path().to_owned();
        let revision = path == "/work/api/screen-revision";
        let slow = self.slow && path == "/work/api/pursuits";
        let raw = if path == "/work/api/viewer" {
            self.raw_body.lock().unwrap().clone()
        } else {
            None
        };
        Box::pin(async move {
            if slow {
                return std::future::pending().await;
            }
            if let Some((status, bytes)) = raw {
                return Ok(Response::builder()
                    .status(status)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(bytes))
                    .unwrap());
            }
            let value = if revision {
                json!({"revision":7})
            } else {
                json!({"fixture_only_path":path,"text":"</script><img src=x>"})
            };
            Ok(Response::builder()
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-trillion-next-before", "fixture-next")
                .header("x-trillion-collection-coverage", "{\"complete\":false}")
                .body(Body::from(serde_json::to_vec(&value).unwrap()))
                .unwrap())
        })
    }
}
struct Pages {
    producer: Arc<WorkspacePageProducer>,
    startup: Arc<StartupContract>,
    api: Arc<Api>,
}
impl WorkspaceOperations for Pages {
    fn page(
        &self,
        _: WorkspaceSession,
        _: WorkspaceRequestHead,
        _: WorkspacePermit,
    ) -> SupplyFuture<WorkspacePage> {
        Box::pin(async { Err(trillion_local::cause!(WorkspaceError::Unavailable)) })
    }
    fn page_response(
        &self,
        session: WorkspaceSession,
        head: WorkspaceRequestHead,
        permit: WorkspacePermit,
    ) -> SupplyFuture<WorkspacePageResponse> {
        self.producer.page_response(
            DomainContext {
                session: Arc::new(session),
                head,
                permit,
            },
            self.startup.clone(),
        )
    }
    fn invoke(
        &self,
        session: WorkspaceSession,
        request: WorkspaceRequest,
        permit: WorkspacePermit,
    ) -> SupplyFuture<Response> {
        self.api.invoke(session, request, permit)
    }
}
struct Fixture {
    app: Router,
    api: Arc<Api>,
    sessions: Arc<Sessions>,
}
fn fixture(slow: bool) -> Fixture {
    let shell = Arc::new(CapturedWorkspaceShell::open(shell_root(), CAPTURE).unwrap());
    let sessions = Arc::new(Sessions {
        allowed: AtomicBool::new(true),
        calls: AtomicUsize::new(0),
    });
    let api = Arc::new(Api {
        calls: AtomicUsize::new(0),
        paths: Mutex::new(vec![]),
        held: Mutex::new(None),
        slow,
        raw_body: Mutex::new(None),
    });
    let producer = Arc::new(
        WorkspacePageProducer::new(
            shell,
            assets(),
            ORIGIN,
            &first(),
            FIRST,
            sessions.clone(),
            api.clone(),
            None,
            StreamLimits {
                document_timeout: Duration::from_millis(25),
                read_timeout: Duration::from_millis(150),
                ..StreamLimits::default()
            },
        )
        .unwrap(),
    );
    let app = route_table(
        assets(),
        WorkspaceSupplies {
            sessions: Some(sessions.clone()),
            operations: Some(Arc::new(Pages {
                producer,
                startup: startup(),
                api: api.clone(),
            })),
            live: None,
            dom: WorkspaceDom::from_source(&first(), FIRST).unwrap(),
        },
        WorkspaceLimits::default(),
    )
    .unwrap();
    Fixture { app, api, sessions }
}
fn request(path: &str) -> Request<Body> {
    Request::builder()
        .uri(path)
        .header(header::HOST, "127.0.0.1:7189")
        .header(header::COOKIE, format!("nm_session={TOKEN}"))
        .body(Body::empty())
        .unwrap()
}

#[test]
fn original_shared_shell_exact_capture_typed_slot_and_cover_are_consumed() {
    let shell = CapturedWorkspaceShell::open(shell_root(), CAPTURE).unwrap();
    let opened = shell.document(ORIGIN, false).unwrap();
    let original = fs::read_to_string(shell_root().join("opening.html")).unwrap();
    let early = fs::read_to_string(shell_root().join("early-socket.txt")).unwrap();
    // Independent byte slicing of the fixed captured slot is the exact oracle.
    let expected = format!("{}{}{}", &original[..328], ORIGIN, &original[365..]);
    let expected = expected.replacen("<body>", &format!("<body><script>{early}</script>"), 1);
    assert_eq!(opened, expected);
    assert!(opened.contains("trillionCover"));
    let repainted = shell.document(ORIGIN, true).unwrap();
    assert!(repainted.contains("<meta http-equiv=\"refresh\" content=\"0\"/>"));
    assert!(!repainted.contains("trillionEarlySocket"));
    assert!(CapturedWorkspaceShell::open(shell_root(), &"0".repeat(64)).is_err());
    assert!(shell.document("http://foreign.example", false).is_err());
    // The account's public origin, where a browser signed in there opens the page: its canonical address is that origin.
    let public = shell.document("https://app.example", false).unwrap();
    assert!(public.contains("<link rel=\"canonical\" href=\"https://app.example/\"/>"));
    for refused in ["https://app.example/path", "https://user@example.com", "ftp://app.example", "https://app.example\"x"] {
        assert!(shell.document(refused, false).is_err(), "{refused}");
    }
}

#[tokio::test]
#[ignore = "needs RETIRED_SNAPSHOT_ROOT: the retired snapshot's built frontend tree (about 82 MB) is not a committed fixture"]
async fn actual_shell_head_precedes_reads_then_original_key_and_current_answers_stream() {
    let f = fixture(true);
    let response = f.app.oneshot(request("/")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    let prefix = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
        .await
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    assert_eq!(
        f.api.calls.load(Ordering::SeqCst),
        0,
        "no canonical read may run before original head/body prefix"
    );
    let prefix = String::from_utf8(prefix.to_vec()).unwrap();
    assert!(prefix.contains("<link rel=\"canonical\" href=\"http://127.0.0.1:7189/\"/>"));
    assert!(prefix.contains("trillionEarlySocket") && prefix.contains("trillionCover"));
    assert!(prefix.contains("trillion-kept-a4f27a1aea816e7273975c626ffb92d2"));
    assert!(
        prefix.contains("SXxFCk1i66SjN0430LeqrQnOpqNuxYYm9JScmelNqLw"),
        "Python independently derived original per-sign-in key"
    );
    assert!(!prefix.contains(TOKEN) && !prefix.contains("nm_"));
    assert!(
        prefix.find("id=\"root\"").unwrap()
            < prefix.find("<script type=\"module\" async src=").unwrap()
    );
    let mut html = prefix;
    while let Some(chunk) = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await {
        html.push_str(std::str::from_utf8(&chunk.unwrap().into_data().unwrap()).unwrap());
    }
    assert!(html.ends_with("</body></html>"));
    assert!(html.contains("data-page-answer=\"/work/api/screen-revision\""));
    assert!(
        !html.contains("data-page-answer=\"/work/api/pursuits\""),
        "a pending read is omitted rather than invented as success or busy"
    );
    assert!(html.contains("\\u003c/script>\\u003cimg src=x>"));
    assert!(html.contains("fixture-next") && html.contains("collection_coverage"));
    assert_eq!(f.api.paths.lock().unwrap()[0], "/work/api/screen-revision");
    assert!(
        f.api.held.lock().unwrap().as_ref().unwrap().cancelled(),
        "no retention owner means EOF cancels work"
    );
}

#[tokio::test]
#[ignore = "needs RETIRED_SNAPSHOT_ROOT: the retired snapshot's built frontend tree (about 82 MB) is not a committed fixture"]
async fn session_withdrawal_after_head_prevents_every_canonical_read_and_disconnect_cancels_same_permit(
) {
    let f = fixture(false);
    let response = f.app.oneshot(request("/")).await.unwrap();
    let mut body = response.into_body();
    let _ = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
        .await
        .unwrap()
        .unwrap();
    f.sessions.allowed.store(false, Ordering::SeqCst);
    let _ = to_bytes(body, 1024 * 1024).await.unwrap();
    assert_eq!(f.api.calls.load(Ordering::SeqCst), 0);

    let f = fixture(true);
    let response = f.app.oneshot(request("/")).await.unwrap();
    let mut body = response.into_body();
    let _ = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
        .await
        .unwrap()
        .unwrap();
    let _ = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
        .await
        .unwrap()
        .unwrap();
    drop(body);
    assert!(f.api.held.lock().unwrap().as_ref().unwrap().cancelled());
}

#[tokio::test]
#[ignore = "needs RETIRED_SNAPSHOT_ROOT: the retired snapshot's built frontend tree (about 82 MB) is not a committed fixture"]
async fn old_tab_repaint_skips_reads_but_service_worker_navigation_keeps_normal_startup() {
    let f = fixture(false);
    let mut old = request("/");
    old.headers_mut()
        .insert("sec-fetch-dest", "empty".parse().unwrap());
    old.headers_mut()
        .insert(header::ACCEPT, "text/html".parse().unwrap());
    let response = f.app.clone().oneshot(old).await.unwrap();
    let html = String::from_utf8(
        to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(html.contains("<meta http-equiv=\"refresh\" content=\"0\"/>"));
    assert_eq!(f.api.calls.load(Ordering::SeqCst), 0);
    let mut navigation = request("/");
    navigation
        .headers_mut()
        .insert("sec-fetch-dest", "empty".parse().unwrap());
    navigation
        .headers_mut()
        .insert("sec-fetch-mode", "navigate".parse().unwrap());
    let response = f.app.oneshot(navigation).await.unwrap();
    let html = String::from_utf8(
        to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(!html.contains("<meta http-equiv=\"refresh\" content=\"0\"/>"));
    assert!(f.api.calls.load(Ordering::SeqCst) > 0);
}

#[tokio::test]
#[ignore = "needs RETIRED_SNAPSHOT_ROOT: the retired snapshot's built frontend tree (about 82 MB) is not a committed fixture"]
async fn original_utf16_body_survives_actual_page_stream_with_script_safety_and_normal_null_errors()
{
    use trillion_local::ecma_json as ecma;
    let cases:&[(u16,&[u8])]=&[
        (200,br#"{"s":"\ud800","pair":"\ud83d\ude00","text":"</script>&\u2028\u2029","2":"index","n":1e400}"#),
        (200,b"null"),
        (200,b"not-json"),
        (503,br#"{"error":"genuine supplied failure"}"#),
    ];
    for &(status, raw) in cases {
        let f = fixture(false);
        *f.api.raw_body.lock().unwrap() = Some((status, raw.to_vec()));
        let response = f.app.oneshot(request("/")).await.unwrap();
        let html = String::from_utf8(
            to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        let marker = "data-page-answer=\"/work/api/viewer\">";
        let start = html
            .find(marker)
            .expect("the actual viewer answer must be emitted")
            + marker.len();
        let end = start + html[start..].find("</script>").unwrap();
        let script = &html[start..end];
        assert!(
            !script.contains('<')
                && !script.contains('&')
                && !script.contains('\u{2028}')
                && !script.contains('\u{2029}')
        );
        let ecma::Value::Object(envelope) =
            ecma::parse(script.as_bytes(), ecma::Limits::default()).unwrap()
        else {
            panic!("answer envelope lost object shape")
        };
        assert_eq!(
            envelope.get(&"status".into()),
            Some(&ecma::Value::Number(f64::from(status)))
        );
        let body = envelope
            .get(&"body".into())
            .expect("body must not be dropped");
        let original = ecma::parse(raw, ecma::Limits::default()).unwrap_or(ecma::Value::Null);
        assert_eq!(
            ecma::stringify(body, ecma::Limits::default()).unwrap(),
            ecma::stringify(&original, ecma::Limits::default()).unwrap()
        );
        if raw.contains(&b'\\') {
            assert!(script.contains("\\ud800"));
            assert!(script.contains("\\u003c/script>\\u0026\\u2028\\u2029"));
            assert!(
                matches!(body, ecma::Value::Object(_)),
                "the original object must not become a JSON string or null"
            );
        }
    }
}

#[test]
fn fifo_and_symlink_capture_inputs_refuse_in_a_finite_child_process() {
    use std::{
        ffi::CString,
        os::unix::{ffi::OsStrExt, fs::symlink},
        process::{Command, Stdio},
        thread,
        time::Instant,
    };
    const CHILD_ROOT: &str = "TRILLION_PAGE_FIFO_CONTROL_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        assert!(CapturedWorkspaceShell::open(PathBuf::from(root), CAPTURE).is_err());
        return;
    }
    for case in ["receipt-fifo", "artifact-fifo", "receipt-symlink"] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        match case {
            "receipt-fifo" => {
                let path = CString::new(root.join("capture.json").as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            }
            "artifact-fifo" => {
                fs::copy(shell_root().join("capture.json"), root.join("capture.json")).unwrap();
                let path = CString::new(root.join("opening.html").as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            }
            _ => symlink(shell_root().join("capture.json"), root.join("capture.json")).unwrap(),
        }
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fifo_and_symlink_capture_inputs_refuse_in_a_finite_child_process")
            .arg("--test-threads=1")
            .env(CHILD_ROOT, root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started = Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "actual loader child refused incorrectly: {case}"
                );
                break;
            }
            if started.elapsed() > Duration::from_secs(5) {
                let _ = child.kill();
                let _ = child.wait();
                panic!("actual loader blocked on {case}; bounded child was reaped");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}
