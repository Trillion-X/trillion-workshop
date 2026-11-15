use super::*;
use content_crypto::advanced::blake3;
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    time::Duration,
};

struct RefusingSessions {
    calls: AtomicUsize,
}
impl CurrentSession for RefusingSessions {
    fn current(
        &self,
        _: WorkspaceRequestHead,
        _: WorkspacePermit,
    ) -> SupplyFuture<WorkspaceSession> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(trillion_local::cause!(WorkspaceError::Unauthorized)) })
    }
}
fn wire(address: SocketAddr, method: &str, path: &str) -> (u16, String, Vec<u8>) {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    let end = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap();
    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, headers, bytes[end + 4..].to_vec())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn declared_program_burst_serves_over_real_http_without_account_admission() {
    let f = fixture();
    let mut manifest: Value = serde_json::from_slice(&f.manifest).unwrap();
    let mut paths = vec![];
    for i in 0..32 {
        let path = format!("/workspace/named/module-{i}.js");
        fs::write(
            f.directory.path().join(path.trim_start_matches('/')),
            format!("export const synthetic = {i};\n"),
        )
        .unwrap();
        paths.push(path);
    }
    manifest["script"] = json!(paths[0]);
    manifest["preload"] = json!(paths);
    let manifest = serde_json::to_vec(&manifest).unwrap();
    fs::write(f.directory.path().join("workspace/files.json"), &manifest).unwrap();
    let assets = Arc::new(
        WorkspaceAssets::open(
            f.directory.path(),
            blake3::hash(&manifest).to_hex().as_str(),
            &tree_pin(f.directory.path()),
        )
        .unwrap(),
    );
    let sessions = Arc::new(RefusingSessions {
        calls: AtomicUsize::new(0),
    });
    let (_, operations) = supplies();
    let app = route_table(
        assets,
        WorkspaceSupplies {
            sessions: Some(sessions.clone()),
            operations: Some(operations.clone()),
            live: None,
            dom: dom(),
        },
        WorkspaceLimits::default(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut jobs = tokio::task::JoinSet::new();
    for (i, path) in paths.into_iter().enumerate() {
        jobs.spawn_blocking(move || {
            let (status, headers, body) = wire(address, "GET", &path);
            assert_eq!(status, 200, "{path}");
            let headers = headers.to_ascii_lowercase();
            assert!(headers.contains("content-type: text/javascript; charset=utf-8"));
            assert!(headers.contains("access-control-allow-origin: *"));
            assert_eq!(body, format!("export const synthetic = {i};\n").as_bytes());
        });
    }
    while let Some(result) = jobs.join_next().await {
        result.unwrap();
    }
    assert_eq!(
        sessions.calls.load(Ordering::SeqCst),
        0,
        "public code must not consult current account rights"
    );
    let opposing = tokio::task::spawn_blocking(move || {
        for path in ["/work/api/viewer", "/work/api/records"] {
            assert_eq!(
                wire(address, "GET", path).0,
                401,
                "{path}: private route still admits current session"
            );
        }
        let (status, headers, _) = wire(address, "GET", "/");
        assert_eq!(status, 303, "/: a signed-out page goes to sign-in");
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("location: /sign-in\r\n"),
            "/: the bare home address carries no next (old trillion src/pages.mjs:193-200)"
        );
        for path in [
            "/workspace/%2e%2e/private",
            "/workspace/named/%2fmodule-0.js",
            "/workspace/named/%5cmodule-0.js",
            "/workspace/named/%00",
        ] {
            assert_eq!(wire(address, "GET", path).0, 400, "{path}");
        }
        assert_eq!(
            wire(address, "GET", "/workspace/named/not-pinned.js").0,
            404
        );
        assert_eq!(wire(address, "POST", "/workspace/named/module-0.js").0, 400);
        let (status, headers, body) = wire(address, "HEAD", "/workspace/named/module-0.js");
        assert_eq!(status, 200);
        assert!(body.is_empty());
        assert!(headers
            .to_ascii_lowercase()
            .contains("content-type: text/javascript"));
    })
    .await;
    server.abort();
    opposing.unwrap();
    assert_eq!(sessions.calls.load(Ordering::SeqCst), 3);
    assert_eq!(operations.calls.load(Ordering::SeqCst), 0);
    eprintln!("public program HTTP receipt: declared_modules=32 status=200 MIME=javascript exact_bodies=true private_routes=401 traversal=400 unpinned=404 mutating_method=400");
}

#[tokio::test]
async fn public_program_backpressure_does_not_borrow_private_operation_permits() {
    let f = fixture();
    let (sessions, operations) = supplies();
    let app = app(f.assets, sessions, operations.clone(), None, one_slot());
    let held = app
        .clone()
        .oneshot(request("GET", "/work/api/hold-worker", Body::empty()))
        .await
        .unwrap();
    assert_eq!(held.status(), StatusCode::OK);
    let bytes = app
        .clone()
        .oneshot(request("GET", "/workspace/named/entry.dat", Body::empty()))
        .await
        .unwrap();
    assert_eq!(bytes.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(bytes.into_body(), 1024).await.unwrap(),
        "test entry bytes"
    );
    assert_eq!(
        app.oneshot(request("GET", "/work/api/anything", Body::empty()))
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    drop(held);
    operations.held.lock().unwrap().take();
}
