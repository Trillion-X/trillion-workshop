// crates/http-client/tests/error_classification.rs
//! Integration tests for ErrorClass classification

use http_client::{ErrorClass, HttpClientError};

#[test]
fn test_timeout_is_transient() {
    let err = HttpClientError::Timeout {
        timeout_ms: 5000,
        elapsed_ms: 5001,
    };
    assert_eq!(err.classify(), ErrorClass::Transient);
    assert!(err.is_retryable());
}

#[test]
fn test_network_error_is_transient() {
    let err = HttpClientError::NetworkError {
        message: "connection reset".into(),
    };
    assert_eq!(err.classify(), ErrorClass::Transient);
    assert!(err.is_retryable());
}

#[test]
fn test_domain_not_allowed_is_permanent() {
    let err = HttpClientError::DomainNotAllowed {
        domain: "evil.example.com".into(),
        allowlist_patterns: vec![],
    };
    assert_eq!(err.classify(), ErrorClass::Permanent);
    assert!(!err.is_retryable());
    assert!(err.is_fatal());
}

#[test]
fn test_ssrf_blocked_is_permanent() {
    let err = HttpClientError::SsrfBlocked {
        reason: "private IP".into(),
        url: "http://192.168.1.1".into(),
    };
    assert_eq!(err.classify(), ErrorClass::Permanent);
}

#[test]
fn test_secret_expired_is_permanent() {
    let err = HttpClientError::SecretExpired {
        handle: "h1".into(),
        expired_at: 0,
    };
    assert_eq!(err.classify(), ErrorClass::Permanent);
    assert!(!err.is_retryable());
}

#[test]
fn test_remediation_non_empty() {
    let errors = [
        HttpClientError::DomainNotAllowed {
            domain: "x".into(),
            allowlist_patterns: vec![],
        },
        HttpClientError::SsrfBlocked {
            reason: "x".into(),
            url: "x".into(),
        },
        HttpClientError::Timeout {
            timeout_ms: 1,
            elapsed_ms: 2,
        },
        HttpClientError::NetworkError {
            message: "x".into(),
        },
        HttpClientError::SecretNotFound { handle: "x".into() },
        HttpClientError::SecretExpired {
            handle: "x".into(),
            expired_at: 0,
        },
        HttpClientError::InvalidUrl {
            message: "x".into(),
            url: "x".into(),
        },
        HttpClientError::HttpsRequired { url: "x".into() },
        HttpClientError::PermissionDenied {
            reason: "x".into(),
            actor_id: "x".into(),
        },
        HttpClientError::InvalidRequest {
            message: "x".into(),
        },
    ];
    for e in &errors {
        assert!(
            !e.remediation().is_empty(),
            "empty remediation for {:?}",
            e.code()
        );
    }
}
