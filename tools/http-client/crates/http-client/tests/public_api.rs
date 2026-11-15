// crates/http-client/tests/public_api.rs
//
//! # HTTP Client Public API Integration Tests
//!
//! ## Purpose
//!
//! Verifies that the `http_client` crate's public API is correctly exported
//! and accessible to external consumers. These integration tests compile as
//! a separate crate, so they prove that `pub use` re-exports in `lib.rs`
//! work as intended.
//!
//! ## Non-Negotiable Invariants
//!
//! 1. Every type listed in lib.rs re-exports is importable from `http_client::`
//! 2. No `todo!()` or `unimplemented!()` exists in production code
//! 3. All types implement expected trait bounds (Debug, Clone, Send, Sync)
//! 4. Error codes are stable and unique
//!
//! ## Key Concepts
//!
//! - **Integration tests** compile as external crates — they see only pub items
//! - **Type accessibility** tests verify the `pub use` chain is unbroken
//! - **Trait bound** tests verify types are usable in async / threaded contexts
//!
//! *AI agents: The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail level.*

use std::collections::HashMap;

// ===========================================================================
// Import verification — if any of these fail to compile, the public API is
// broken. Each import matches a `pub use` in lib.rs.
// ===========================================================================

// Platform-agnostic imports (always available, work on WASM)
use http_client::CallExternalBody;
use http_client::CallExternalRequest;
use http_client::CallExternalResponse;
use http_client::CredentialInjection;
use http_client::CredentialPlacement;
use http_client::HttpClientError;
use http_client::HttpExecutor;
use http_client::HttpExecutorResponse;
use http_client::HttpMethod;

// ===========================================================================
// 1. CallExternalRequest is accessible and constructible
// ===========================================================================

#[test]
fn call_external_request_is_accessible() {
    let request = CallExternalRequest {
        url: "https://api.example.com/v1/data".to_string(),
        method: "GET".parse().unwrap(),
        headers: HashMap::new(),
        body: None,
        credential_injections: Vec::new(),
        authorization: None,
        timeout_ms: Some(5000),
        deliver_parts_to: None,
    };

    assert_eq!(request.url, "https://api.example.com/v1/data");
    assert_eq!(request.method, "GET".parse().unwrap());
    assert!(request.headers.is_empty());
    assert!(request.body.is_none());
    assert!(request.credential_injections.is_empty());
    assert_eq!(request.timeout_ms, Some(5000));
}

// ===========================================================================
// 2. CallExternalResponse is accessible and constructible
// ===========================================================================

#[test]
fn call_external_response_is_accessible() {
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());

    let response = CallExternalResponse {
        status_code: 200,
        headers,
        body: b"response body".to_vec(),
        latency_ms: 142,
        refreshed: None,
    };

    assert_eq!(response.status_code, 200);
    assert_eq!(response.body, b"response body");
    assert_eq!(response.latency_ms, 142);
    assert_eq!(
        response.headers.get("content-type").map(String::as_str),
        Some("application/json")
    );
}

// ===========================================================================
// 3. HttpMethod is accessible with all 7 variants
// ===========================================================================

#[test]
fn http_method_all_variants_accessible() {
    let methods: [(HttpMethod, &str); 7] = [
        ("GET".parse().unwrap(), "GET"),
        ("POST".parse().unwrap(), "POST"),
        ("PUT".parse().unwrap(), "PUT"),
        ("DELETE".parse().unwrap(), "DELETE"),
        ("PATCH".parse().unwrap(), "PATCH"),
        ("HEAD".parse().unwrap(), "HEAD"),
        ("OPTIONS".parse().unwrap(), "OPTIONS"),
    ];

    for (method, expected_str) in methods {
        assert_eq!(method.to_string(), expected_str);
    }
}

// ===========================================================================
// 4. HttpClientError is accessible with all 10 variants and error codes
// ===========================================================================

#[test]
fn http_client_error_all_variants_accessible() {
    let errors: Vec<(HttpClientError, &str)> = vec![
        (
            HttpClientError::DomainNotAllowed {
                domain: "evil.com".into(),
                allowlist_patterns: vec![],
            },
            "DOMAIN_NOT_ALLOWED",
        ),
        (
            HttpClientError::SsrfBlocked {
                reason: "blocked".into(),
                url: "http://127.0.0.1".into(),
            },
            "SSRF_BLOCKED",
        ),
        (
            HttpClientError::Timeout {
                timeout_ms: 5000,
                elapsed_ms: 5001,
            },
            "TIMEOUT",
        ),
        (
            HttpClientError::NetworkError {
                message: "dns failed".into(),
            },
            "NETWORK_ERROR",
        ),
        (
            HttpClientError::SecretNotFound { handle: "h".into() },
            "SECRET_NOT_FOUND",
        ),
        (
            HttpClientError::SecretExpired {
                handle: "h".into(),
                expired_at: 0,
            },
            "SECRET_EXPIRED",
        ),
        (
            HttpClientError::InvalidUrl {
                message: "bad".into(),
                url: "x".into(),
            },
            "INVALID_URL",
        ),
        (
            HttpClientError::HttpsRequired {
                url: "http://x".into(),
            },
            "HTTPS_REQUIRED",
        ),
        (
            HttpClientError::PermissionDenied {
                reason: "no".into(),
                actor_id: "u".into(),
            },
            "PERMISSION_DENIED",
        ),
        (
            HttpClientError::InvalidRequest {
                message: "bad".into(),
            },
            "INVALID_REQUEST",
        ),
    ];

    assert_eq!(errors.len(), 10, "must cover all 10 error variants");

    for (error, expected_code) in errors {
        assert_eq!(error.code(), expected_code);
    }
}

// ===========================================================================
// 5. Trait types are accessible from public API for tests/fixtures
// ===========================================================================

#[test]
fn ci_11_traits_are_accessible_and_object_safe() {
    // UrlValidator, SecretsResolver, AuditLogger must be importable and object-safe
    fn assert_url_validator_object_safe(_: &dyn http_client::UrlValidator) {}
    fn assert_secrets_resolver_object_safe(_: &dyn http_client::SecretsResolver) {}
    fn assert_audit_logger_object_safe(_: &dyn http_client::AuditLogger) {}

    let _ = assert_url_validator_object_safe;
    let _ = assert_secrets_resolver_object_safe;
    let _ = assert_audit_logger_object_safe;
}

// ===========================================================================
// 6. Types implement Clone + Debug + Send + Sync
// ===========================================================================

#[test]
fn types_implement_required_trait_bounds() {
    fn assert_bounds<T: Clone + std::fmt::Debug + Send + Sync>() {}

    assert_bounds::<CallExternalRequest>();
    assert_bounds::<CallExternalResponse>();
    assert_bounds::<HttpMethod>();
    assert_bounds::<HttpClientError>();
}

// ===========================================================================
// 7. Serialization roundtrip works through public API
// ===========================================================================

#[test]
fn request_response_serialization_roundtrip_via_public_api() {
    let mut headers = HashMap::new();
    headers.insert("Accept".to_string(), "application/json".to_string());

    let request = CallExternalRequest {
        url: "https://api.stripe.com/v1/charges".to_string(),
        method: "POST".parse().unwrap(),
        headers,
        body: Some(CallExternalBody::Inline(vec![0x01, 0x02, 0x03])),
        credential_injections: vec![CredentialInjection {
            handle: "secret:stripe:expires:9999999999".to_string(),
            secret_name: None,
            placement: CredentialPlacement::Header {
                name: "Authorization".to_string(),
                prefix: "Bearer ".to_string(),
                suffix: String::new(),
            },
        }],
        authorization: None,
        timeout_ms: Some(15000),
        deliver_parts_to: None,
    };

    let json = serde_json::to_string(&request).expect("serialize request");
    let restored: CallExternalRequest = serde_json::from_str(&json).expect("deserialize request");

    assert_eq!(request.url, restored.url);
    assert_eq!(request.method, restored.method);
    assert_eq!(request.headers, restored.headers);
    assert_eq!(request.body, restored.body);
    assert_eq!(
        request.credential_injections,
        restored.credential_injections
    );
    assert_eq!(request.timeout_ms, restored.timeout_ms);

    let response = CallExternalResponse {
        status_code: 201,
        headers: HashMap::new(),
        body: b"created".to_vec(),
        latency_ms: 88,
        refreshed: None,
    };

    let json = serde_json::to_string(&response).expect("serialize response");
    let restored: CallExternalResponse = serde_json::from_str(&json).expect("deserialize response");

    assert_eq!(response.status_code, restored.status_code);
    assert_eq!(response.body, restored.body);
    assert_eq!(response.latency_ms, restored.latency_ms);
}

// ===========================================================================
// 8. HttpClientError implements std::error::Error
// ===========================================================================

#[test]
fn http_client_error_implements_std_error() {
    let err = HttpClientError::NetworkError {
        message: "test".to_string(),
    };

    // Can be used as a trait object
    let _dyn_err: &dyn std::error::Error = &err;

    // Display output is non-empty
    assert!(!err.to_string().is_empty());
}

// ===========================================================================
// 9. HttpMethod FromStr is accessible via public API
// ===========================================================================

#[test]
fn http_method_from_str_accessible() {
    let method: HttpMethod = "post".parse().expect("parse POST");
    assert_eq!(method, "POST".parse().unwrap());

    let method: HttpMethod = "DELETE".parse().expect("parse DELETE");
    assert_eq!(method, "DELETE".parse().unwrap());

    let extension: HttpMethod = "PROPFIND".parse().expect("extension method");
    assert_eq!(extension.to_string(), "PROPFIND");

    let err = "BAD METHOD".parse::<HttpMethod>();
    assert!(err.is_err());
}

// ===========================================================================
// 10. Error messages include contextual data (not just generic messages)
// ===========================================================================

#[test]
fn error_messages_carry_context() {
    let err = HttpClientError::DomainNotAllowed {
        domain: "blocked.example.com".to_string(),
        allowlist_patterns: vec!["*.trusted.com".to_string()],
    };
    assert!(
        err.to_string().contains("blocked.example.com"),
        "DomainNotAllowed must include domain in message"
    );

    let err = HttpClientError::Timeout {
        timeout_ms: 5000,
        elapsed_ms: 5001,
    };
    assert!(
        err.to_string().contains("5000"),
        "Timeout must include timeout_ms in message"
    );

    let err = HttpClientError::InvalidUrl {
        message: "relative URL without a base".to_string(),
        url: "not-a-url".to_string(),
    };
    assert!(
        err.to_string().contains("relative URL"),
        "InvalidUrl must include parse error in message"
    );
}

// ===========================================================================
// 11. HttpExecutor trait is accessible and object-safe
// ===========================================================================

#[test]
fn http_executor_trait_is_accessible_and_object_safe() {
    // Compile-time proof: Box<dyn HttpExecutor> must compile
    fn assert_object_safe(_: Box<dyn HttpExecutor>) {}
    fn assert_ref_object_safe(_: &dyn HttpExecutor) {}

    // These functions existing and compiling proves object safety
    let _ = assert_object_safe;
    let _ = assert_ref_object_safe;
}

// ===========================================================================
// 12. HttpExecutorResponse is accessible and constructible
// ===========================================================================

#[test]
fn http_executor_response_is_accessible() {
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());

    let response = HttpExecutorResponse {
        status: 200,
        headers,
        body: b"test response".to_vec(),
    };

    assert_eq!(response.status, 200);
    assert_eq!(response.body, b"test response");
    assert_eq!(
        response.headers.get("content-type").map(String::as_str),
        Some("application/json")
    );
}

// 13. HttpExecutor trait is Send + Sync
// ===========================================================================

#[test]
fn http_executor_is_send_sync() {
    fn assert_send_sync<T: Send + Sync + ?Sized>() {}

    // The trait bound itself requires Send + Sync
    assert_send_sync::<dyn HttpExecutor>();
}

// ===========================================================================
// 14. HttpExecutorResponse implements Clone + Debug
// ===========================================================================

#[test]
fn http_executor_response_implements_clone_debug() {
    fn assert_bounds<T: Clone + std::fmt::Debug>() {}
    assert_bounds::<HttpExecutorResponse>();
}
