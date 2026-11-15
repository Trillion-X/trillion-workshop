// Include beneath browser_controls in selected_workspace_write's existing
// synthetic producer fixture. Reuse its selected owner, browser session,
// writer, store and actual local workspace HTTP consumer.
use super::*;

fn browser_records_request() -> axum::http::Request<axum::body::Body> {
    axum::http::Request::builder()
        .method("GET")
        .uri("/work/api/records?label=saved-board")
        .header("host", "127.0.0.1:7189")
        .header("origin", "http://127.0.0.1:7189")
        .header("cookie", format!("nm_session={}", "b".repeat(64)))
        .body(axum::body::Body::empty())
        .unwrap()
}

async fn read_saved_board(app: &axum::Router) -> (axum::http::StatusCode, Value) {
    use tower::ServiceExt;

    let response = app
        .clone()
        .oneshot(browser_records_request())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let body = serde_json::from_slice(&bytes).unwrap();
    (status, body)
}

#[tokio::test]
async fn browser_save_read_lost_response_same_key_recovery_keeps_same_saved_data() {
    use tower::ServiceExt;

    let (fixture, owner, _) = browser_fixture();
    let app = browser_http_app(&fixture, owner);
    let first = app
        .clone()
        .oneshot(browser_http_request(
            "browser-same-data-followthrough",
            "http://127.0.0.1:7189",
            input(),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), axum::http::StatusCode::OK);
    drop(first); // The accepted save response and body are lost after commit.
    let committed = state(&fixture);

    let (read_status, before_retry) = read_saved_board(&app).await;
    assert_eq!(read_status, axum::http::StatusCode::OK);
    let saved = json!({"items":["written"]});
    assert_eq!(before_retry, json!({"records":{"saved-board":saved}}));

    let retry = app
        .clone()
        .oneshot(browser_http_request(
            "browser-same-data-followthrough",
            "http://127.0.0.1:7189",
            input(),
        ))
        .await
        .unwrap();
    assert_eq!(retry.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(retry.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let retry_body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(retry_body["written"], 1);
    assert_eq!(state(&fixture), committed);

    let (fresh_status, after_retry) = read_saved_board(&app).await;
    assert_eq!(fresh_status, axum::http::StatusCode::OK);
    assert_eq!(after_retry, before_retry);
    assert_eq!(state(&fixture), committed);
}

#[tokio::test]
async fn browser_withdrawal_refuses_same_key_recovery_without_a_second_effect() {
    use tower::ServiceExt;

    let (fixture, owner, _) = browser_fixture();
    let app = browser_http_app(&fixture, owner);
    let first = app
        .clone()
        .oneshot(browser_http_request(
            "browser-withdrawn-followthrough",
            "http://127.0.0.1:7189",
            input(),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), axum::http::StatusCode::OK);
    drop(first);
    let committed = state(&fixture);

    withdraw_browser(&fixture);
    let (read_status, refused_read) = read_saved_board(&app).await;
    assert_ne!(read_status, axum::http::StatusCode::OK);
    assert!(
        refused_read.get("records").is_none(),
        "withdrawn browser must receive no saved data"
    );
    let retry = app
        .oneshot(browser_http_request(
            "browser-withdrawn-followthrough",
            "http://127.0.0.1:7189",
            input(),
        ))
        .await
        .unwrap();
    assert_ne!(retry.status(), axum::http::StatusCode::OK);
    assert_eq!(state(&fixture), committed);
}
