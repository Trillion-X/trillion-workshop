// Purpose: Measure one complete public bootstrap burst against the SAME real
// selected LocalAccount and WorkspaceSessions used by canonical private reads.
// Invariants: Reuse the parent synthetic fixture, preserve eight private slots,
// and take one coherent SQL interval around all 256 HTTP asset responses.
// Security: No installed account, customer state, new session or debug endpoint.
// A zero mock-call counter is not a substitute for the real shared SQL meter.

use super::*;
use content_crypto::advanced::blake3;
use std::{io, net::SocketAddr, time::Duration};
use tokio::{net::TcpStream, sync::Barrier, task::JoinSet};

const PROGRAMS: usize = 256;

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn exchange(
    address: SocketAddr,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    ready: Option<Arc<Barrier>>,
) -> (u16, String, Vec<u8>) {
    tokio::time::timeout(Duration::from_secs(15), async {
        let stream = TcpStream::connect(address).await.unwrap();
        if let Some(ready) = ready {
            ready.wait().await;
        }
        let cookie = cookie
            .map(|value| format!("Cookie: nm_session={value}\r\n"))
            .unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {address}\r\n{cookie}Connection: close\r\n\r\n"
        );
        let mut written = 0;
        while written < request.len() {
            stream.writable().await.unwrap();
            match stream.try_write(&request.as_bytes()[written..]) {
                Ok(0) => panic!("HTTP request write ended"),
                Ok(count) => written += count,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Err(error) => panic!("HTTP request write: {error}"),
            }
        }
        let mut bytes = Vec::new();
        loop {
            stream.readable().await.unwrap();
            let mut chunk = [0_u8; 8192];
            match stream.try_read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => {
                    bytes.extend_from_slice(&chunk[..count]);
                    assert!(bytes.len() < 1024 * 1024, "bounded fixture response");
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Err(error) => panic!("HTTP response read: {error}"),
            }
        }
        let boundary = bytes
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap();
        let headers = String::from_utf8(bytes[..boundary].to_vec())
            .unwrap()
            .to_ascii_lowercase();
        let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
        let mut body = bytes[boundary + 4..].to_vec();
        if headers.contains("transfer-encoding: chunked") {
            let mut decoded = Vec::new();
            let mut remaining = body.as_slice();
            loop {
                let end = remaining
                    .windows(2)
                    .position(|part| part == b"\r\n")
                    .unwrap();
                let length = usize::from_str_radix(
                    std::str::from_utf8(&remaining[..end])
                        .unwrap()
                        .split(';')
                        .next()
                        .unwrap(),
                    16,
                )
                .unwrap();
                remaining = &remaining[end + 2..];
                if length == 0 {
                    break;
                }
                decoded.extend_from_slice(&remaining[..length]);
                assert_eq!(&remaining[length..length + 2], b"\r\n");
                remaining = &remaining[length + 2..];
            }
            body = decoded;
        }
        (status, headers, body)
    })
    .await
    .expect("bounded complete HTTP exchange")
}

fn program(index: usize) -> Vec<u8> {
    format!(
        "export const synthetic = {index};\n// {}\n",
        "fixture-program-only ".repeat(256)
    )
    .into_bytes()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn public_bootstrap_256_modules_keeps_selected_account_sql_unchanged() {
    let f = Fixture::new(&[("kept", r#"{"original":true}"#)]);
    let records_before = fs::read(&f.records).unwrap();
    let assets_root = tempfile::tempdir().unwrap();
    fs::create_dir_all(assets_root.path().join("workspace/named")).unwrap();
    let paths = (0..PROGRAMS)
        .map(|index| format!("/workspace/named/bootstrap-{index}.js"))
        .collect::<Vec<_>>();
    for (index, path) in paths.iter().enumerate() {
        fs::write(
            assets_root.path().join(path.trim_start_matches('/')),
            program(index),
        )
        .unwrap();
    }
    fs::write(
        assets_root.path().join("workspace/named/style.css"),
        b"/* synthetic */",
    )
    .unwrap();
    let manifest = serde_json::to_vec(&json!({"script":paths[0],"stylesheet":"/workspace/named/style.css","preload":paths,"screens":{},"import_map":{"imports":{}}})).unwrap();
    fs::write(assets_root.path().join("workspace/files.json"), &manifest).unwrap();
    let assets = Arc::new(
        WorkspaceAssets::open(
            assets_root.path(),
            blake3::hash(&manifest).to_hex().as_str(),
            &tree_pin(assets_root.path()),
        )
        .unwrap(),
    );
    // A later filesystem file is not in the pinned admitted inventory.
    fs::write(
        assets_root.path().join("workspace/named/unknown.js"),
        b"not admitted",
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let settings =
        WorkspaceSessionSettings::from_source(SETTINGS, blake3::hash(SETTINGS).to_hex().as_str())
            .unwrap();
    let sessions =
        WorkspaceSessions::new(f.owner.clone(), &format!("http://{address}"), settings).unwrap();
    assert!(sessions.has_owner(&f.owner));
    let local = Arc::new(LocalWorkspace::new(f.owner.clone(), sessions.clone()).unwrap());
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
    let canonical = Arc::new(CanonicalWorkspace::new(routes, startup, local, None));
    let limits = WorkspaceLimits::default();
    assert_eq!(limits.max_inflight, 8);
    let app = workspace::route_table(
        assets,
        WorkspaceSupplies {
            sessions: Some(Arc::new(sessions)),
            operations: Some(canonical),
            live: None,
            dom: WorkspaceDom::from_source(DOM, blake3::hash(DOM).to_hex().as_str()).unwrap(),
        },
        limits,
    )
    .unwrap();
    let _server = Server(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));

    // Positive control: the same HTTP route table, session and selected owner reads an
    // actual stored record and charges the existing shared SQLite observer.
    let initial = f.owner.lock().unwrap().sql_work().unwrap();
    let (status, _, body) = exchange(address, "GET", "/work/api/records", Some(TOKEN), None).await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"records":{"kept":{"original":true}}})
    );
    let before = f.owner.lock().unwrap().sql_work().unwrap();
    assert!(
        before.work.sql_statements > initial.work.sql_statements,
        "positive control must charge real account SQL"
    );
    assert!(before.live_connections > 0);
    assert_eq!(before.active_statements, 0);

    // One whole-bootstrap interval. All sockets connect before the barrier
    // opens; no per-request overlapping subtraction or fabricated empty owner.
    let ready = Arc::new(Barrier::new(PROGRAMS));
    let mut jobs = JoinSet::new();
    for (index, path) in paths.iter().cloned().enumerate() {
        let ready = ready.clone();
        jobs.spawn(async move {
            let (status, headers, body) =
                exchange(address, "GET", &path, Some(TOKEN), Some(ready)).await;
            assert_eq!(status, 200, "{path}");
            assert!(headers.contains("content-type: text/javascript; charset=utf-8"));
            assert!(headers.contains("access-control-allow-origin: *"));
            assert_eq!(body, program(index));
        });
    }
    while let Some(result) = jobs.join_next().await {
        result.unwrap();
    }
    let after = f.owner.lock().unwrap().sql_work().unwrap();
    assert_eq!(
        serde_json::to_value(&after.work).unwrap(),
        serde_json::to_value(&before.work).unwrap(),
        "all shared account SQL counters must remain unchanged across complete public bootstrap"
    );
    assert_eq!(
        serde_json::to_value(&after.families).unwrap(),
        serde_json::to_value(&before.families).unwrap()
    );
    assert_eq!(after.live_connections, before.live_connections);
    assert_eq!(after.active_statements, 0);

    // After the measured interval, private reads still require current rights.
    let (status, _, body) = exchange(address, "GET", "/work/api/records", Some(TOKEN), None).await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"records":{"kept":{"original":true}}})
    );
    let private_after = f.owner.lock().unwrap().sql_work().unwrap();
    assert!(private_after.work.sql_statements > after.work.sql_statements);
    assert_eq!(
        exchange(address, "GET", "/work/api/records", None, None)
            .await
            .0,
        401
    );
    let (status, headers, _) = exchange(address, "GET", "/", None, None).await;
    assert_eq!(status, 303);
    assert!(headers.contains("location: /sign-in\r\n"), "the bare home address carries no next (old trillion src/pages.mjs:193-200): {headers}");
    assert_eq!(
        exchange(
            address,
            "GET",
            "/workspace/named/unknown.js",
            Some(TOKEN),
            None
        )
        .await
        .0,
        404
    );
    for path in [
        "/workspace/%2e%2e/private",
        "/workspace/named/%2fbootstrap-0.js",
        "/workspace/named/%5cbootstrap-0.js",
        "/workspace/named/%00",
    ] {
        assert_eq!(
            exchange(address, "GET", path, Some(TOKEN), None).await.0,
            400
        );
    }
    assert_eq!(
        exchange(address, "POST", &paths[0], Some(TOKEN), None)
            .await
            .0,
        400
    );
    let (status, headers, body) = exchange(address, "HEAD", &paths[0], None, None).await;
    assert_eq!(status, 200);
    assert!(headers.contains("content-type: text/javascript"));
    assert!(body.is_empty());
    fs::write(
        assets_root.path().join(paths[0].trim_start_matches('/')),
        b"tampered fixture",
    )
    .unwrap();
    assert_eq!(
        exchange(address, "GET", &paths[0], Some(TOKEN), None)
            .await
            .0,
        503
    );
    assert_eq!(
        exchange(address, "GET", &paths[1], Some(TOKEN), None)
            .await
            .0,
        200
    );
    assert_eq!(fs::read(&f.records).unwrap(), records_before);
    eprintln!(
        "public bootstrap SQL receipt: modules={PROGRAMS} private_slots=8 exact_bodies=true MIME=javascript CORS=* sql_before={} sql_after={} families_unchanged=true active_statements=0 real_private_before_after=200 tampered=503",
        serde_json::to_string(&before.work).unwrap(),
        serde_json::to_string(&after.work).unwrap()
    );
}
