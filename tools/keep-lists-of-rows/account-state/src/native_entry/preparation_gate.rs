//! The native host's requests wait for the account's first start.
//!
//! While `native_boot::own_records_start` brings the account's own records onto record store, the store is half filled: before the
//! workspace phase a workspace read answers empty, and a write made then would be kept over the label the
//! migration carries. Until the preparation marks the records ready, every request this layer wraps (the page,
//! `/work/api`, local MCP) is answered busy: 503 with `Retry-After`, which the page and the quiet-write outbox
//! already ask again after. The host's own readiness probe is mounted outside this layer and still answers, so
//! the Mac app sees a live engine through a long first start.
//!
//! Non-Negotiable Invariants:
//! - No request reaches the account before `ready` is set; after it is set, every request passes unchanged.
//! - The busy answer names nothing about the account: a fixed status, header and body.
//!
//! AI Assistant Directive:
//! The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail.
use axum::{
    extract::{Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

/// Seconds a caller is asked to wait before asking again while the first start runs.
const RETRY_AFTER_SECONDS: &str = "5";

/// Wrap every route of `route_table` so it is answered busy until `ready` is set.
pub(crate) fn layer(route_table: Router, ready: Arc<AtomicBool>) -> Router {
    route_table.layer(middleware::from_fn_with_state(ready, gate))
}

async fn gate(State(ready): State<Arc<AtomicBool>>, request: Request, next: Next) -> Response {
    if ready.load(Ordering::Acquire) {
        return next.run(request).await;
    }
    let cause = crate::cause!(condition: account_records_not_ready);
    crate::quiet_eprintln!("http-refusal status=503 cause={cause}");
    let mut busy = (
        StatusCode::SERVICE_UNAVAILABLE,
        axum::Json(serde_json::json!({"error": "account preparing", "failure_code": "account_preparing", "cause": cause.id()})),
    )
        .into_response();
    let headers = busy.headers_mut();
    headers.insert(header::RETRY_AFTER, HeaderValue::from_static(RETRY_AFTER_SECONDS));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    busy
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, routing::get};
    use tower::ServiceExt;

    fn app(ready: &Arc<AtomicBool>) -> Router {
        layer(Router::new().route("/work/api/viewer", get(|| async { "served" })), ready.clone())
    }
    async fn ask(app: Router) -> Response {
        app.oneshot(Request::builder().uri("/work/api/viewer").body(Body::empty()).unwrap()).await.unwrap()
    }

    #[tokio::test]
    async fn a_request_before_the_records_are_ready_is_answered_busy_and_never_reaches_the_account() {
        let ready = Arc::new(AtomicBool::new(false));
        let answer = ask(app(&ready)).await;
        assert_eq!(answer.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(answer.headers()[header::RETRY_AFTER], "5");
        assert_eq!(answer.headers()[header::CACHE_CONTROL], "no-store");
        let body = axum::body::to_bytes(answer.into_body(), 1024).await.unwrap();
        let mut body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let cause = crate::refusal_cause::Cause::from_wire(body["cause"].as_str().unwrap()).unwrap();
        assert_eq!(cause.file(), "src/native_entry/preparation_gate.rs");
        body.as_object_mut().unwrap().remove("cause");
        assert_eq!(body, serde_json::json!({"error":"account preparing","failure_code":"account_preparing"}));
    }

    #[tokio::test]
    async fn once_ready_every_request_passes_unchanged() {
        let ready = Arc::new(AtomicBool::new(false));
        let route_table = app(&ready);
        ready.store(true, Ordering::Release);
        let answer = ask(route_table).await;
        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(&axum::body::to_bytes(answer.into_body(), 1024).await.unwrap()[..], b"served");
    }
}
