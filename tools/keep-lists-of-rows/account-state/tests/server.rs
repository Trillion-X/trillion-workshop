// tests/server.rs
//
// Purpose: Tests the HTTP server contract for authentication, scoped record operations, cursors, and token-file handling.
//
// Non-Negotiable Invariants:
// - Authentication and fixed scope checks precede mutation; retries preserve committed changes and stale requests conflict.
//
// Key Concepts:
// - The HTTP API binds calls to a fixed authenticated account/resource scope and paged cursors.
// - Mutation retries use request keys and versions; JSON null is data, while deletion is a separate tombstone.
//
// Security Considerations:
// - Local fixtures only; browser-boundary ambiguity, oversized input, invalid limits, and insecure or unbounded token files are refused.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Route table contract checks. Run only in the implementation owner's serialized suite.
use axum::{body::{to_bytes, Body}, http::{header, HeaderMap, Request, StatusCode}, Router};
use serde_json::{json, Value};
use std::{fs, path::Path};
use tempfile::TempDir;
use tower::ServiceExt;
use trillion_local::{server::{route_table, ServerConfig, MAX_BODY_BYTES}, store::{Mutation, Store}};

struct Fixture { app: Router, bearer: String, _directory: TempDir }
fn write_token(path: &Path) -> String {
    // Synthetic fixture data, never a real service credential.
    let token = "test-only-".repeat(6);
    fs::write(path, format!("{token}\n")).unwrap();
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    token
}
fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let token_path = directory.path().join("bearer");
    let bearer = write_token(&token_path);
    let config = ServerConfig::from_token_file("alice", "notes", &token_path).unwrap();
    let mut store = Store::open(directory.path().join("records.sqlite")).unwrap();
    for (account, resource) in [("bob", "notes"), ("alice", "private")] {
        store.mutate(account, resource, Mutation { id: "foreign".into(), expected_version: 0,
            request_key: "foreign-create".into(), deleted: false, value: json!({"private":true}) }).unwrap();
    }
    Fixture { app: route_table(store, config), bearer, _directory: directory }
}
async fn call(
    fixture: &Fixture, authenticated: bool, method: &str, path: &str,
    body: Option<Value>, headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Value) {
    let mut request = Request::builder().method(method).uri(path).header(header::HOST, "127.0.0.1");
    if authenticated { request = request.header(header::AUTHORIZATION, format!("Bearer {}", fixture.bearer)); }
    let bytes = if let Some(body) = body {
        request = request.header(header::CONTENT_TYPE, "application/json");
        serde_json::to_vec(&body).unwrap()
    } else { Vec::new() };
    let mut request = request.body(Body::from(bytes)).unwrap();
    for (key, value) in headers { request.headers_mut().insert(
        axum::http::HeaderName::from_bytes(key.as_bytes()).unwrap(), value.parse().unwrap()); }
    let response = fixture.app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), MAX_BODY_BYTES * 2).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8(bytes.to_vec()).unwrap()));
    (status, headers, body)
}
fn put(value: Value, version: i64, key: &str) -> Value {
    json!({"expected_version":version,"request_key":key,"value":value})
}

#[tokio::test]
async fn authentication_and_browser_boundaries_refuse_before_mutation() {
    let f = fixture();
    let payload = put(json!({"text":"must not save"}), 0, "refused");
    let (status, headers, _) = call(&f, false, "PUT", "/v1/records/a", Some(payload.clone()), &[]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(headers[header::WWW_AUTHENTICATE], "Bearer");
    for extra in [vec![("host", "attacker.invalid")], vec![("origin", "https://attacker.invalid")]] {
        let (status, headers, _) = call(&f, true, "PUT", "/v1/records/a", Some(payload.clone()), &extra).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!headers.contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }
    let (status, _, _) = call(&f, true, "GET", "/v1/records", None, &[("authorization", "Bearer wrong")]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (_, _, changes) = call(&f, true, "GET", "/v1/changes", None, &[]).await;
    assert_eq!(changes, json!([]));
}

#[tokio::test]
async fn fixed_scope_excludes_other_accounts_resources_and_client_overrides() {
    let f = fixture();
    let (status, _, body) = call(&f, true, "GET", "/v1/records", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!([]));
    let (status, _, _) = call(&f, true, "GET", "/v1/records/foreign", None, &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = call(&f, true, "GET", "/v1/records?account=bob", None, &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let mut forged = put(json!("x"), 0, "forged"); forged["account"] = json!("bob");
    let (status, _, _) = call(&f, true, "PUT", "/v1/records/foreign", Some(forged), &[]).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn json_null_is_a_record_and_delete_is_a_separate_tombstone() {
    let f = fixture();
    let (status, _, saved) = call(&f, true, "PUT", "/v1/records/null", Some(put(Value::Null, 0, "create-null")), &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["deleted"], false);
    let (status, headers, body) = call(&f, true, "GET", "/v1/records/null", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(body["record"]["version"], 1);
    assert_eq!(body["record"]["value"], Value::Null);
    assert_eq!(body["work"]["sql_statements"], 1);
    assert_eq!(body["work"]["rows_written"], 0);
    let (status, _, deleted) = call(&f, true, "DELETE", "/v1/records/null", Some(json!({"expected_version":1,"request_key":"delete-null"})), &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted["deleted"], true);
    let (status, _, absent) = call(&f, true, "GET", "/v1/records/null", None, &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(absent["record"], Value::Null);
    let (_, _, listed) = call(&f, true, "GET", "/v1/records", None, &[]).await;
    assert_eq!(listed, json!([]));
    let (_, _, changes) = call(&f, true, "GET", "/v1/changes", None, &[]).await;
    assert_eq!(changes.as_array().unwrap().len(), 2);
    assert_eq!(changes[0]["deleted"], false);
    assert_eq!(changes[1]["deleted"], true);
}

#[tokio::test]
async fn retries_reuse_the_change_and_stale_or_changed_requests_conflict() {
    let f = fixture();
    let input = put(json!({"text":"first"}), 0, "stable-create");
    let (_, _, first) = call(&f, true, "PUT", "/v1/records/a", Some(input.clone()), &[]).await;
    let (status, _, retry) = call(&f, true, "PUT", "/v1/records/a", Some(input), &[]).await;
    assert_eq!(status, StatusCode::OK); assert_eq!(first, retry);
    for input in [put(json!("changed"), 0, "stable-create"), put(json!("stale"), 99, "stale")] {
        let (status, _, _) = call(&f, true, "PUT", "/v1/records/a", Some(input), &[]).await;
        assert_eq!(status, StatusCode::CONFLICT);
    }
    let (_, _, changes) = call(&f, true, "GET", "/v1/changes", None, &[]).await;
    assert_eq!(changes.as_array().unwrap().len(), 1);
    assert_eq!(changes[0]["value"], json!({"text":"first"}));
}

#[tokio::test]
async fn list_and_change_cursors_are_ordered_and_scope_bound() {
    let f = fixture();
    for id in ["b", "a"] {
        let (status, _, _) = call(&f, true, "PUT", &format!("/v1/records/{id}"), Some(put(json!(id), 0, id)), &[]).await;
        assert_eq!(status, StatusCode::OK);
    }
    let (_, _, page) = call(&f, true, "GET", "/v1/records?limit=1", None, &[]).await;
    assert_eq!(page.as_array().unwrap().len(), 1); assert_eq!(page[0]["id"], "a");
    let (_, _, page) = call(&f, true, "GET", "/v1/records?after=a&limit=1", None, &[]).await;
    assert_eq!(page.as_array().unwrap().len(), 1); assert_eq!(page[0]["id"], "b");
    let (_, _, first) = call(&f, true, "GET", "/v1/changes?limit=1", None, &[]).await;
    assert_eq!(first[0]["id"], "b");
    let after = first[0]["sequence"].as_i64().unwrap();
    let (_, _, second) = call(&f, true, "GET", &format!("/v1/changes?after={after}&limit=1"), None, &[]).await;
    assert_eq!(second.as_array().unwrap().len(), 1); assert_eq!(second[0]["id"], "a");
}

#[tokio::test]
async fn oversized_bodies_and_invalid_limits_do_not_create_records() {
    let f = fixture();
    let (status, _, _) = call(&f, true, "PUT", "/v1/records/large", Some(put(json!("x".repeat(MAX_BODY_BYTES)), 0, "large")), &[]).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    for path in ["/v1/records?limit=0", "/v1/records?limit=101", "/v1/changes?after=-1", "/v1/changes?limit=101"] {
        let (status, _, _) = call(&f, true, "GET", path, None, &[]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (_, _, changes) = call(&f, true, "GET", "/v1/changes", None, &[]).await;
    assert_eq!(changes, json!([]));
}

#[test]
#[cfg(unix)]
fn token_files_require_private_permissions_and_bounded_nonempty_contents() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("bearer");
    write_token(&path);
    assert!(ServerConfig::from_token_file("alice", "notes", &path).is_ok());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(ServerConfig::from_token_file("alice", "notes", &path).err().unwrap().kind(), std::io::ErrorKind::PermissionDenied);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    for bytes in ["".to_owned(), "short".to_owned(), "x".repeat(515), "has spaces ".repeat(5)] {
        fs::write(&path, bytes).unwrap();
        assert!(ServerConfig::from_token_file("alice", "notes", &path).is_err());
    }
}
