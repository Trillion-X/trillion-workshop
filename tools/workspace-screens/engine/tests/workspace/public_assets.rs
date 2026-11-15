// Stable public file aliases over synthetic pinned bytes; never an installed product account.
use super::*;
use content_crypto::advanced::blake3;
use std::{io::Read, net::TcpStream, time::Duration};

const IMAGE: &[u8] = b"\0\0\x01\0pinned image bytes";
const TARGET: &str = "/workspace/named/picture-content.ico";

fn with_public_assets(f: &Fixture, aliases: Value) -> Result<WorkspaceAssets, WorkspaceError> {
    fs::write(f.directory.path().join(TARGET.trim_start_matches('/')), IMAGE).unwrap();
    let mut manifest: Value = serde_json::from_slice(&f.manifest).unwrap();
    manifest["public_assets"] = aliases;
    let manifest = serde_json::to_vec(&manifest).unwrap();
    fs::write(f.directory.path().join("workspace/files.json"), &manifest).unwrap();
    WorkspaceAssets::open(f.directory.path(), blake3::hash(&manifest).to_hex().as_str(), &tree_pin(f.directory.path()))
}

fn wire(address: std::net::SocketAddr, method: &str, path: &str) -> (u16, String, Vec<u8>) {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n").unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    let end = bytes.windows(4).position(|value| value == b"\r\n\r\n").unwrap();
    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
    (headers.split_whitespace().nth(1).unwrap().parse().unwrap(), headers, bytes[end + 4..].to_vec())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn public_assets_root_files_are_public_exact_bytes_and_target_mime_over_http() {
    let f = fixture();
    // MIME belongs to the pinned target, deliberately different from this alias's suffix.
    let assets = Arc::new(with_public_assets(&f, json!({"/picture.svg": TARGET, "/second.ico": TARGET})).unwrap());
    let (sessions, operations) = supplies();
    sessions.allowed.store(false, Ordering::SeqCst);
    let app = app(assets, sessions.clone(), operations.clone(), None, WorkspaceLimits::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let checked = tokio::task::spawn_blocking(move || {
        for alias in ["/picture.svg", "/second.ico"] {
            let (status, headers, body) = wire(address, "GET", alias);
            assert_eq!(status, 200);
            assert_eq!(body, IMAGE);
            let headers = headers.to_ascii_lowercase();
            assert!(headers.contains("content-type: image/x-icon\r\n"));
            assert!(headers.contains("cache-control: no-cache\r\n"));
            assert!(headers.contains(&format!("content-length: {}\r\n", IMAGE.len())));
            assert!(!headers.contains("immutable"));
            let (status, headers, body) = wire(address, "HEAD", alias);
            assert_eq!(status, 200);
            assert!(body.is_empty());
            assert!(headers.to_ascii_lowercase().contains("content-type: image/x-icon\r\n"));
        }
        let (status, headers, body) = wire(address, "GET", TARGET);
        assert_eq!(status, 200);
        assert_eq!(body, IMAGE);
        assert!(headers.to_ascii_lowercase().contains("cache-control: public, max-age=31536000, immutable\r\n"));
        assert_eq!(wire(address, "POST", "/picture.svg").0, 400);
    }).await;
    server.abort();
    checked.unwrap();
    assert_eq!(sessions.checks.load(Ordering::SeqCst), 0, "public assets consult no account session");
    assert_eq!(operations.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn public_assets_do_not_admit_private_or_unlisted_addresses() {
    let f = fixture();
    let assets = Arc::new(with_public_assets(&f, json!({"/picture.ico": TARGET})).unwrap());
    let (sessions, operations) = supplies();
    sessions.allowed.store(false, Ordering::SeqCst);
    let app = app(assets, sessions.clone(), operations.clone(), None, WorkspaceLimits::default());
    for path in ["/work/api/viewer", "/work/api/records", "/work/live"] {
        let response = app.clone().oneshot(request("GET", path, Body::empty())).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
    }
    for path in ["/unlisted.ico", "/%70icture.ico", "/picture.ico/child", "/../picture.ico"] {
        let response = app.clone().oneshot(request("GET", path, Body::empty())).await.unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER, "{path}");
        assert!(to_bytes(response.into_body(), 1024).await.unwrap().is_empty());
    }
    assert_eq!(sessions.checks.load(Ordering::SeqCst), 7);
    assert_eq!(operations.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn public_assets_reject_noncanonical_aliases_and_unpinned_targets_on_open() {
    let f = fixture();
    for alias in ["/", "picture.ico", "//picture.ico", "/.hidden", "/picture.", "/picture.ico/child", "/../picture.ico", "/%70icture.ico", "/picture.ico?x", "/picture.ico#x", "/picture\\.ico", "/pictüre.ico", "/work/api/viewer", "/work", "/mcp", "/sign-in", "/workspace/files.json"] {
        assert!(with_public_assets(&f, json!({alias: TARGET})).is_err(), "{alias}");
    }
    for target in ["/workspace/files.json", "/workspace/named/missing.ico", "/workspace/named/../named/picture-content.ico", "/workspace/named/%70icture-content.ico", "/work/api/records", "/workshop/modules/anything/image.ico", "/private/image.ico"] {
        assert!(with_public_assets(&f, json!({"/picture.ico": target})).is_err(), "{target}");
    }
    for aliases in [Value::Null, json!([]), json!({"/picture.ico": 1}), json!({"/picture.ico": null})] {
        assert!(with_public_assets(&f, aliases).is_err());
    }
    fs::write(f.directory.path().join("collision.json"), b"another pinned file").unwrap();
    assert!(with_public_assets(&f, json!({"/collision.json": TARGET})).is_err());
    assert!(with_public_assets(&f, json!({})).is_ok(), "empty optional map is valid DATA");
}

#[test]
fn public_assets_read_refuses_changed_or_escaping_target_bytes() {
    let f = fixture();
    let assets = with_public_assets(&f, json!({"/picture.ico": TARGET})).unwrap();
    assert_eq!(assets.read("/picture.ico").unwrap(), IMAGE);
    let target = f.directory.path().join(TARGET.trim_start_matches('/'));
    fs::write(&target, vec![b'x'; IMAGE.len()]).unwrap();
    assert!(matches!(assets.read("/picture.ico"), Err(WorkspaceError::Integrity(_))));
    let outside = tempfile::tempdir().unwrap();
    let external = outside.path().join("picture.ico");
    fs::write(&external, IMAGE).unwrap();
    fs::remove_file(&target).unwrap();
    std::os::unix::fs::symlink(&external, &target).unwrap();
    assert!(matches!(assets.read("/picture.ico"), Err(WorkspaceError::Integrity(_))));
}
