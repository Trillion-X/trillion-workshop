// Include as a child module in selected_workspace_write.rs, after its actual
// Fixture and request helpers. The child uses only those synthetic fixtures.
use super::{Fixture, iso, local_read_http_request_for_protocol, millis};
use crate::account::SecretNativeKey;
use axum::body::{Body, Bytes};
use http_body::{Body as HttpBody, Frame as Chunk, SizeHint};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    future::Future,
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::oneshot;
use tower::ServiceExt;

struct GatedRequestBody {
    reached_auth_boundary: Option<oneshot::Sender<()>>,
    release: oneshot::Receiver<Bytes>,
    sent: bool,
}
impl HttpBody for GatedRequestBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Chunk<Bytes>, io::Error>>> {
        let this = self.get_mut();
        if this.sent {
            return Poll::Ready(None);
        }
        if let Some(reached) = this.reached_auth_boundary.take() {
            let _ = reached.send(());
        }
        match Pin::new(&mut this.release).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Ok(bytes)) => {
                this.sent = true;
                Poll::Ready(Some(Ok(Chunk::data(bytes))))
            }
            Poll::Ready(Err(_)) => Poll::Ready(Some(Err(io::ErrorKind::Interrupted.into()))),
        }
    }
    fn is_end_stream(&self) -> bool {
        self.sent
    }
    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

fn mutate_kv(fixture: &Fixture, statement: &str, values: &[&str]) {
    let db = Connection::open(
        fixture
            .root
            .join("storage/kv/trillion-local-app/current.sqlite"),
    )
    .unwrap();
    db.execute(statement, rusqlite::params_from_iter(values.iter().copied()))
        .unwrap();
}

fn personal_key_entry(fixture: &Fixture) -> String {
    format!(
        "personal-key:{}",
        SecretNativeKey::parse(&fixture.token).unwrap().identity()
    )
}

fn rewrite_key_entry_aba(fixture: &Fixture) {
    let entry = personal_key_entry(fixture);
    let kv_path = fixture
        .root
        .join("storage/kv/trillion-local-app/current.sqlite");
    let db = Connection::open(&kv_path).unwrap();
    let original_blob_id: String = db
        .query_row(
            "SELECT blob_id FROM _mf_entries WHERE key=?",
            [&entry],
            |row| row.get(0),
        )
        .unwrap();
    let blobs = fixture.root.join("storage/kv/trillion-local-app/blobs");
    let original_bytes = fs::read(blobs.join(&original_blob_id)).unwrap();
    let replacement_blob_id = "abababababababababababababababababababababababababababababababab";
    fs::write(blobs.join(replacement_blob_id), &original_bytes).unwrap();
    db.execute(
        "UPDATE _mf_entries SET blob_id=? WHERE key=?",
        [replacement_blob_id, entry.as_str()],
    )
    .unwrap();
    db.execute(
        "UPDATE _mf_entries SET blob_id=? WHERE key=?",
        [original_blob_id.as_str(), entry.as_str()],
    )
    .unwrap();
    assert_eq!(fs::read(blobs.join(&original_blob_id)).unwrap(), original_bytes);
}

async fn held_http_read(
    app: &axum::Router,
    fixture: &Fixture,
    protocol: &str,
) -> (
    tokio::task::JoinHandle<Result<axum::response::Response, std::convert::Infallible>>,
    oneshot::Receiver<()>,
    oneshot::Sender<Bytes>,
    Bytes,
) {
    let mut request = local_read_http_request_for_protocol(
        fixture,
        "request-auth-source-fact",
        "synthetic-source-fact-client",
        "@own-records",
        protocol,
    );
    let bytes = axum::body::to_bytes(
        std::mem::replace(request.body_mut(), Body::empty()),
        65_536,
    )
    .await
    .unwrap();
    let (reached_tx, reached_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    *request.body_mut() = Body::new(GatedRequestBody {
        reached_auth_boundary: Some(reached_tx),
        release: release_rx,
        sent: false,
    });
    let task = tokio::spawn(app.clone().oneshot(request));
    (task, reached_rx, release_tx, bytes)
}

#[tokio::test]
async fn current_key_reobserves_unrelated_kv_commit_before_dispatch_and_chunk() {
    for protocol in ["2025-06-18", "2026-07-28"] {
        let fixture = Fixture::new();
        let app = crate::native_boot::mcp_local::route_table(
            Arc::new(Mutex::new(fixture.selected())),
            "127.0.0.1:28788".into(),
        )
        .unwrap();
        let (task, authenticated, release, bytes) = held_http_read(&app, &fixture, protocol).await;
        authenticated.await.unwrap();

        // A commit to another key bumps the whole SQLite data_version. It must
        // invalidate the retained source memo and trigger one exact-key read,
        // not revoke the authenticated key by itself.
        mutate_kv(
            &fixture,
            "INSERT INTO _mf_entries(key,blob_id,expiration) VALUES(?,?,NULL)",
            &["personal-key:unrelated-request-auth-control", "cc"],
        );
        fs::write(
            fixture
                .root
                .join("storage/kv/trillion-local-app/blobs/cc"),
            b"{}",
        )
        .unwrap();
        release.send(bytes).unwrap();
        let response = task.await.unwrap().unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{protocol}");

        // A second unrelated commit after operation preparation invalidates
        // the original broad generation at the last chunk. The existing
        // final-output path must reobserve this exact key and current rights.
        mutate_kv(
            &fixture,
            "INSERT INTO _mf_entries(key,blob_id,expiration) VALUES(?,?,NULL)",
            &["personal-key:unrelated-chunk-control", "dd"],
        );
        fs::write(
            fixture
                .root
                .join("storage/kv/trillion-local-app/blobs/dd"),
            b"{}",
        )
        .unwrap();
        let response = axum::body::to_bytes(response.into_body(), 65_536)
            .await
            .unwrap();
        let reply: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(reply["result"]["isError"], false, "{protocol}");
        assert_eq!(reply["result"]["structuredContent"]["status"], 200, "{protocol}");
        let saved: Value = serde_json::from_str(reply["result"]["structuredContent"]["text"].as_str().unwrap()).unwrap();
        assert_eq!(saved["records"]["saved-board"], json!({"items":["kept"]}), "{protocol}");
    }
}

#[tokio::test]
async fn current_key_reobservation_allows_same_value_key_source_aba() {
    for protocol in ["2025-06-18", "2026-07-28"] {
        // Between auth and operation: only the physical index generation
        // changes. The exact current key bytes and claims remain valid.
        let fixture = Fixture::new();
        let app = crate::native_boot::mcp_local::route_table(
            Arc::new(Mutex::new(fixture.selected())),
            "127.0.0.1:28788".into(),
        )
        .unwrap();
        let (task, authenticated, release, bytes) = held_http_read(&app, &fixture, protocol).await;
        authenticated.await.unwrap();
        rewrite_key_entry_aba(&fixture);
        release.send(bytes).unwrap();
        let response = task.await.unwrap().unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{protocol}");
        let bytes = axum::body::to_bytes(response.into_body(), 65_536)
            .await
            .unwrap();
        let reply: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(reply["result"]["isError"], false, "{protocol}");
        assert_eq!(reply["result"]["structuredContent"]["status"], 200, "{protocol}");
        let saved: Value = serde_json::from_str(reply["result"]["structuredContent"]["text"].as_str().unwrap()).unwrap();
        assert_eq!(saved["records"]["saved-board"], json!({"items":["kept"]}), "{protocol}");

        // Repeat after preparation but before the first response chunk. The
        // final check must reobserve current key contents instead of requiring
        // the ingress witness's SQLite generation to remain unchanged.
        let fixture = Fixture::new();
        let app = crate::native_boot::mcp_local::route_table(
            Arc::new(Mutex::new(fixture.selected())),
            "127.0.0.1:28788".into(),
        )
        .unwrap();
        let response = app
            .oneshot(local_read_http_request_for_protocol(
                &fixture,
                "same-value-key-source-aba",
                "synthetic-same-value-aba-client",
                "@own-records",
                protocol,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{protocol}");
        let (parts, body) = response.into_parts();
        assert!(!parts.headers.contains_key(axum::http::header::CONTENT_LENGTH));
        rewrite_key_entry_aba(&fixture);
        let bytes = axum::body::to_bytes(body, 65_536).await.unwrap();
        let reply: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(reply["result"]["isError"], false, "{protocol}");
        assert_eq!(reply["result"]["structuredContent"]["status"], 200, "{protocol}");
        let saved: Value = serde_json::from_str(reply["result"]["structuredContent"]["text"].as_str().unwrap()).unwrap();
        assert_eq!(saved["records"]["saved-board"], json!({"items":["kept"]}), "{protocol}");
    }
}

#[tokio::test]
async fn current_key_refuses_real_withdrawal_after_authentication() {
    for protocol in ["2025-06-18", "2026-07-28"] {
        let fixture = Fixture::new();
        let app = crate::native_boot::mcp_local::route_table(
            Arc::new(Mutex::new(fixture.selected())),
            "127.0.0.1:28788".into(),
        )
        .unwrap();
        let (task, authenticated, release, bytes) = held_http_read(&app, &fixture, protocol).await;
        authenticated.await.unwrap();
        mutate_kv(
            &fixture,
            "DELETE FROM _mf_entries WHERE key=?",
            &[&personal_key_entry(&fixture)],
        );
        release.send(bytes).unwrap();
        let response = task.await.unwrap().unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{protocol}");
        let response = axum::body::to_bytes(response.into_body(), 65_536)
            .await
            .unwrap();
        let reply: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(reply["result"]["isError"], true, "{protocol}");
        assert_ne!(reply["result"]["structuredContent"]["outcome"], "complete");
    }
}

#[tokio::test]
async fn current_key_rechecks_clock_expiry_after_authentication() {
    for protocol in ["2025-06-18", "2026-07-28"] {
        let fixture = Fixture::new();
        let key_blob = fixture
            .root
            .join("storage/kv/trillion-local-app/blobs/bb");
        let mut key: Value = serde_json::from_slice(&fs::read(&key_blob).unwrap()).unwrap();
        let expires_at = millis() + 2_000;
        key["expires_at"] = json!(iso(expires_at));
        fs::write(&key_blob, key.to_string()).unwrap();

        let app = crate::native_boot::mcp_local::route_table(
            Arc::new(Mutex::new(fixture.selected())),
            "127.0.0.1:28788".into(),
        )
        .unwrap();
        let (task, authenticated, release, bytes) = held_http_read(&app, &fixture, protocol).await;
        authenticated.await.unwrap();
        while millis() <= expires_at {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        release.send(bytes).unwrap();
        let response = task.await.unwrap().unwrap();
        let response = axum::body::to_bytes(response.into_body(), 65_536)
            .await
            .unwrap();
        let reply: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(reply["result"]["isError"], true, "{protocol}");
    }
}

#[tokio::test]
async fn current_key_chunk_withholds_withdrawn_key_under_both_protocol_versions() {
    for protocol in ["2025-06-18", "2026-07-28"] {
        let fixture = Fixture::new();
        let app = crate::native_boot::mcp_local::route_table(
            Arc::new(Mutex::new(fixture.selected())),
            "127.0.0.1:28788".into(),
        )
        .unwrap();
        let response = app
            .oneshot(local_read_http_request_for_protocol(
                &fixture,
                "request-auth-final-withdrawal",
                "synthetic-final-chunk-client",
                "@own-records",
                protocol,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{protocol}");
        let (parts, mut body) = response.into_parts();
        assert!(!parts.headers.contains_key(axum::http::header::CONTENT_LENGTH));
        assert!(http_body::Body::size_hint(&body).upper().is_none());
        mutate_kv(
            &fixture,
            "DELETE FROM _mf_entries WHERE key=?",
            &[&personal_key_entry(&fixture)],
        );
        let chunk = std::future::poll_fn(|cx| {
            HttpBody::poll_frame(Pin::new(&mut body), cx)
        })
        .await;
        assert!(matches!(chunk, Some(Err(_))), "{protocol}");
    }
}
