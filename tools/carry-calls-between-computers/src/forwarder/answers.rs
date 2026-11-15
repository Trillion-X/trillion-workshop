// src/forwarder/answers.rs
//
// Purpose: the two HTTP pieces every front reads the same way: which account a path names (`named_path`) and a JSON
// answer whose refusal names its source cause (`json`). The forwarder (`gateway.rs`) and the computer
// (`native_entry/computer.rs`) both read a path with `named_path`, so a path never names one account at the front and
// another behind it.
//
// Non-Negotiable Invariants:
// - `/a/<address>/rest` names `<address>` and `/rest`; the discovery paths `/.well-known/<name>/a/<address>/rest` name
//   it and map to `/.well-known/<name>/rest` (RFC 8414 and 9728 put the well-known part before the resource's path).
// - A 4xx or 5xx JSON answer carries its cause id in the body (`cause`) and in `x-trillion-refusal-cause`, the header a
//   front reads to tell a server refusal from a person's answer. A success carries neither.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use axum::{
    body::Body,
    http::{header, HeaderName, HeaderValue, StatusCode},
    response::Response,
};
use serde_json::Value;

/// The header a refusal names its source cause in.
pub(crate) const REFUSAL_CAUSE_HEADER: &str = "x-trillion-refusal-cause";

/// The discovery documents that name an account after their well-known part.
const DISCOVERY: [&str; 2] = [".well-known/oauth-authorization-server", ".well-known/oauth-protected-resource"];

/// The address a path names and the path inside that account's routes. None when the path names no account.
pub(crate) fn named_path(path: &str) -> Option<(&str, String)> {
    fn split(rest: &str) -> (&str, String) {
        let end = rest.find('/').unwrap_or(rest.len());
        let (address, tail) = rest.split_at(end);
        (address, if tail.is_empty() { "/".to_string() } else { tail.to_string() })
    }
    if let Some(rest) = path.strip_prefix("/a/") {
        return Some(split(rest));
    }
    DISCOVERY.iter().find_map(|name| {
        let rest = path.strip_prefix('/')?.strip_prefix(name)?.strip_prefix("/a/")?;
        let (address, inner) = split(rest);
        let suffix = if inner == "/" { String::new() } else { inner };
        Some((address, format!("/{name}{suffix}")))
    })
}

/// A JSON answer with `headers`. A refusal (4xx or 5xx) keeps a `cause` the body already names, else names the
/// caller's site, in its body and its `x-trillion-refusal-cause` header. A header value that is not a header refuses
/// the whole answer 503, never sends it without that header.
#[track_caller]
pub(crate) fn json(status: StatusCode, value: &Value, headers: &[(&'static str, &str)]) -> Response {
    let caller = crate::refusal_cause::Cause::from_caller();
    let refusal = status.is_client_error() || status.is_server_error();
    let mut body = value.clone();
    let cause = refusal.then(|| {
        let cause = value.get("cause").and_then(Value::as_str).and_then(crate::refusal_cause::Cause::from_wire).unwrap_or(caller);
        if let Some(fields) = body.as_object_mut() {
            fields.insert("cause".into(), Value::from(cause.id()));
        }
        cause
    });
    let mut response = Response::new(Body::from(serde_json::to_vec(&body).unwrap_or_default()));
    *response.status_mut() = status;
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    for (name, value) in headers {
        let Ok(value) = HeaderValue::from_str(value) else {
            let mut refused = Response::new(Body::empty());
            *refused.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
            return named(refused, Some(crate::refusal_cause::Cause::from_caller()));
        };
        response.headers_mut().append(HeaderName::from_static(name), value);
    }
    named(response, cause)
}

/// Name a refusal's cause in its header.
fn named(mut response: Response, cause: Option<crate::refusal_cause::Cause>) -> Response {
    if let Some(cause) = cause {
        if let Ok(value) = HeaderValue::from_str(&cause.id()) {
            response.headers_mut().insert(REFUSAL_CAUSE_HEADER, value);
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_names_its_account_and_the_path_inside_it() {
        let address = "a".repeat(64);
        assert_eq!(named_path(&format!("/a/{address}")), Some((address.as_str(), "/".to_string())));
        assert_eq!(named_path(&format!("/a/{address}/mcp")), Some((address.as_str(), "/mcp".to_string())));
        assert_eq!(named_path(&format!("/.well-known/oauth-protected-resource/a/{address}/mcp")),
            Some((address.as_str(), "/.well-known/oauth-protected-resource/mcp".to_string())));
        assert_eq!(named_path(&format!("/.well-known/oauth-authorization-server/a/{address}")),
            Some((address.as_str(), "/.well-known/oauth-authorization-server".to_string())));
        for nobody in ["/", "/mcp", "/a", "/.well-known/oauth-protected-resource", "/.well-known/other/a/x"] {
            assert_eq!(named_path(nobody), None, "{nobody}");
        }
    }

    #[tokio::test]
    async fn a_refusal_names_its_cause_and_a_success_does_not() {
        let refused = json(StatusCode::CONFLICT, &serde_json::json!({"error": "contested"}), &[("cache-control", "no-store")]);
        let header = refused.headers()[REFUSAL_CAUSE_HEADER].to_str().unwrap().to_owned();
        assert_eq!(refused.headers()["cache-control"], "no-store");
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(refused.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["cause"], header.as_str());
        let fine = json(StatusCode::OK, &serde_json::json!({"state": "taken"}), &[]);
        assert!(fine.headers().get(REFUSAL_CAUSE_HEADER).is_none());
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(fine.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body, serde_json::json!({"state": "taken"}));
    }
}
