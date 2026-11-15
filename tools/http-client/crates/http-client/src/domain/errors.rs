// crates/http-client/src/domain/errors.rs
//
//! # HTTP Client Error Types
//!
//! ## Purpose
//!
//! Structured, machine-readable errors for the `_callExternal` kernel primitive.
//! Every error variant carries contextual data and maps to a unique error code
//! for programmatic handling by callers and audit systems.
//!
//! ## Non-Negotiable Invariants
//!
//! 1. Every error variant has a unique, stable `code()` string
//! 2. Error codes match the Kernel Codex error definitions (lines 406-407):
//!    `DOMAIN_NOT_ALLOWED`, `NETWORK_ERROR`
//! 3. Display messages include actionable context (domain, URL, handle, etc.)
//! 4. Secret material (credentials, tokens) NEVER appears in error messages
//! 5. All variants carry enough context for remediation without exposing secrets
//!
//! ## Key Concepts
//!
//! - **Error codes**: Machine-readable constants (e.g., `"DOMAIN_NOT_ALLOWED"`)
//!   used by API consumers, audit logs, and monitoring systems.
//! - **Remediation hints**: Each variant's fields carry enough data to diagnose
//!   and fix the issue (e.g., `DomainNotAllowed` includes the domain and the
//!   current allowlist patterns).
//! - **Secret safety**: `SecretNotFound` and `SecretExpired` reference handles
//!   (opaque IDs), never actual credential values.
//!
//! ## Security Considerations
//!
//! - Error messages are safe to log — no credentials, tokens, or body content
//! - URL is included in relevant errors for debugging but headers/body are excluded
//! - Secret handles are opaque references, not raw values
//!
//! *AI agents: The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail level.*

use thiserror::Error;

/// Error classification for retry logic and resilience strategies.
///
/// Errors are classified into two categories that determine handling behavior:
/// - **Transient**: Temporary failures (network hiccup, timeout) that may succeed on retry
/// - **Permanent**: Structural failures (bad domain, expired secret) that won't succeed on retry
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// Transient error — likely to succeed on retry
    Transient,
    /// Permanent error — retrying is futile
    Permanent,
}

/// Structured error type for HTTP client operations.
///
/// Each variant maps to a unique error code via [`HttpClientError::code()`].
/// Variants carry contextual data for diagnosis and remediation.
#[derive(Debug, Clone, Error)]
pub enum HttpClientError {
    /// Domain not on the configured transport allowlist.
    ///
    /// Remediation: Add the domain to the transport policy allowlist.
    #[error("Domain not allowed: {domain}")]
    DomainNotAllowed {
        /// The hostname that was rejected.
        domain: String,
        /// Current allowlist patterns for reference.
        allowlist_patterns: Vec<String>,
    },

    /// URL points to a private/internal address (SSRF prevention).
    ///
    /// Remediation: Use a public URL. Private IPs, localhost, and cloud metadata
    /// endpoints are blocked by transport policy.
    #[error("SSRF blocked: {reason}")]
    SsrfBlocked {
        /// Human-readable reason for the block.
        reason: String,
        /// The URL that was blocked.
        url: String,
    },

    /// Request timeout exceeded.
    ///
    /// Remediation: Increase `timeout_ms` in the request or investigate the
    /// external service's latency.
    #[error("Request timeout: {timeout_ms}ms exceeded")]
    Timeout {
        /// The configured timeout in milliseconds.
        timeout_ms: u64,
        /// Actual elapsed time before timeout in milliseconds.
        elapsed_ms: u64,
    },

    /// Network-level error during request execution.
    ///
    /// Remediation: Check network connectivity, DNS resolution, and whether
    /// the target service is reachable.
    #[error("Network error: {message}")]
    NetworkError {
        /// Description of the network failure.
        message: String,
    },

    /// Secret handle not found in the credentials vault.
    ///
    /// Remediation: Verify the secret exists via `_secretAccess` and that the
    /// handle has not been revoked.
    #[error("Secret not found: {handle}")]
    SecretNotFound {
        /// The opaque secret handle that was not found.
        handle: String,
    },

    /// Secret handle has expired.
    ///
    /// Remediation: Re-acquire the secret via `_secretAccess` READ to get a
    /// fresh handle.
    #[error("Secret expired: {handle}")]
    SecretExpired {
        /// The opaque secret handle that expired.
        handle: String,
        /// Unix timestamp (seconds) when the handle expired.
        expired_at: i64,
    },

    /// Invalid URL format.
    ///
    /// Remediation: Verify the URL is well-formed per RFC 3986.
    #[error("Invalid URL: {message}")]
    InvalidUrl {
        /// Description of why the URL is invalid.
        message: String,
        /// The URL that failed validation.
        url: String,
    },

    /// HTTPS required by transport policy but the URL uses HTTP.
    ///
    /// Remediation: Use `https://` instead of `http://`. HTTPS is required in
    /// production. HTTP may be allowed only in local development.
    #[error("HTTPS required but got HTTP: {url}")]
    HttpsRequired {
        /// The HTTP URL that was rejected.
        url: String,
    },

    /// Actor does not have permission to make external calls.
    ///
    /// Remediation: Grant the actor the `call_external` permission in the
    /// active permission policy.
    #[error("Permission denied: {reason}")]
    PermissionDenied {
        /// Human-readable reason for the denial.
        reason: String,
        /// The actor ID that was denied.
        actor_id: String,
    },

    /// Invalid request configuration.
    ///
    /// Remediation: Check the request fields for correctness. The message
    /// describes which field or combination is invalid.
    #[error("Invalid request: {message}")]
    InvalidRequest {
        /// Description of the invalid configuration.
        message: String,
    },
}

impl HttpClientError {
    /// Machine-readable error code for API responses and audit logs.
    ///
    /// These codes are stable and MUST NOT change once published.
    /// Callers can switch on these codes for programmatic error handling.
    pub fn code(&self) -> &'static str {
        match self {
            Self::DomainNotAllowed { .. } => "DOMAIN_NOT_ALLOWED",
            Self::SsrfBlocked { .. } => "SSRF_BLOCKED",
            Self::Timeout { .. } => "TIMEOUT",
            Self::NetworkError { .. } => "NETWORK_ERROR",
            Self::SecretNotFound { .. } => "SECRET_NOT_FOUND",
            Self::SecretExpired { .. } => "SECRET_EXPIRED",
            Self::InvalidUrl { .. } => "INVALID_URL",
            Self::HttpsRequired { .. } => "HTTPS_REQUIRED",
            Self::PermissionDenied { .. } => "PERMISSION_DENIED",
            Self::InvalidRequest { .. } => "INVALID_REQUEST",
        }
    }

    /// Classify this error as transient or permanent.
    ///
    /// Used by resilience systems to determine retry strategy.
    pub fn classify(&self) -> ErrorClass {
        match self {
            // Transient errors — infrastructure, timing, or temporary state issues
            Self::Timeout { .. } => ErrorClass::Transient,
            Self::NetworkError { .. } => ErrorClass::Transient,

            // Permanent errors — structural/policy issues that won't resolve on retry
            Self::DomainNotAllowed { .. } => ErrorClass::Permanent,
            Self::SsrfBlocked { .. } => ErrorClass::Permanent,
            Self::SecretNotFound { .. } => ErrorClass::Permanent,
            Self::SecretExpired { .. } => ErrorClass::Permanent,
            Self::InvalidUrl { .. } => ErrorClass::Permanent,
            Self::HttpsRequired { .. } => ErrorClass::Permanent,
            Self::PermissionDenied { .. } => ErrorClass::Permanent,
            Self::InvalidRequest { .. } => ErrorClass::Permanent,
        }
    }

    /// Whether this error may succeed on retry.
    ///
    /// Returns true for transient errors, false for permanent errors.
    pub fn is_retryable(&self) -> bool {
        self.classify() == ErrorClass::Transient
    }

    /// Whether this error is fatal and should halt the request.
    ///
    /// Returns true for permanent errors, false for transient errors.
    pub fn is_fatal(&self) -> bool {
        self.classify() == ErrorClass::Permanent
    }

    /// Actionable remediation advice for this error.
    ///
    /// Callers can present this to users or log it for debugging.
    pub fn remediation(&self) -> String {
        match self {
            Self::DomainNotAllowed { domain, .. } => {
                format!("Add '{}' to the transport policy allowlist", domain)
            }
            Self::SsrfBlocked { reason, .. } => {
                format!("SSRF protection: {}. Use a public URL.", reason)
            }
            Self::Timeout { timeout_ms, .. } => {
                format!("Request timed out after {}ms. Increase timeout_ms or check external service latency.", timeout_ms)
            }
            Self::NetworkError { .. } => {
                "Check network connectivity, DNS resolution, and target service availability."
                    .to_string()
            }
            Self::SecretNotFound { handle } => {
                format!(
                    "Secret '{}' not found. Verify it exists and has not been revoked.",
                    handle
                )
            }
            Self::SecretExpired { handle, .. } => {
                format!(
                    "Secret '{}' has expired. Re-acquire a fresh secret handle.",
                    handle
                )
            }
            Self::InvalidUrl { message, .. } => {
                format!(
                    "URL format is invalid: {}. Ensure it conforms to RFC 3986.",
                    message
                )
            }
            Self::HttpsRequired { url } => {
                format!("HTTPS required but got HTTP: '{}'. Use HTTPS instead.", url)
            }
            Self::PermissionDenied { .. } => {
                "Grant the actor the 'call_external' permission in the active permission policy."
                    .to_string()
            }
            Self::InvalidRequest { message } => {
                format!("Request configuration is invalid: {}", message)
            }
        }
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Total number of distinct error variants.
    /// Used to ensure exhaustive coverage in tests.
    const ERROR_VARIANT_COUNT: usize = 10;

    /// Helper: create one instance of each error variant for exhaustive testing.
    fn all_error_variants() -> Vec<HttpClientError> {
        vec![
            HttpClientError::DomainNotAllowed {
                domain: "evil.example.com".to_string(),
                allowlist_patterns: vec!["*.trusted.com".to_string()],
            },
            HttpClientError::SsrfBlocked {
                reason: "Private IP 10.0.0.1 is blocked".to_string(),
                url: "http://10.0.0.1/admin".to_string(),
            },
            HttpClientError::Timeout {
                timeout_ms: 5000,
                elapsed_ms: 5001,
            },
            HttpClientError::NetworkError {
                message: "DNS resolution failed".to_string(),
            },
            HttpClientError::SecretNotFound {
                handle: "secret:missing:expires:0".to_string(),
            },
            HttpClientError::SecretExpired {
                handle: "secret:old:expires:1700000000".to_string(),
                expired_at: 1700000000,
            },
            HttpClientError::InvalidUrl {
                message: "relative URL without a base".to_string(),
                url: "not-a-url".to_string(),
            },
            HttpClientError::HttpsRequired {
                url: "http://api.example.com".to_string(),
            },
            HttpClientError::PermissionDenied {
                reason: "Actor lacks call_external permission".to_string(),
                actor_id: "user_456".to_string(),
            },
            HttpClientError::InvalidRequest {
                message: "Body provided for GET request".to_string(),
            },
        ]
    }

    // -----------------------------------------------------------------------
    // Error codes
    // -----------------------------------------------------------------------

    #[test]
    fn error_codes_are_correct() {
        let cases: Vec<(HttpClientError, &str)> = vec![
            (
                HttpClientError::DomainNotAllowed {
                    domain: "x".into(),
                    allowlist_patterns: vec![],
                },
                "DOMAIN_NOT_ALLOWED",
            ),
            (
                HttpClientError::SsrfBlocked {
                    reason: "x".into(),
                    url: "x".into(),
                },
                "SSRF_BLOCKED",
            ),
            (
                HttpClientError::Timeout {
                    timeout_ms: 0,
                    elapsed_ms: 0,
                },
                "TIMEOUT",
            ),
            (
                HttpClientError::NetworkError {
                    message: "x".into(),
                },
                "NETWORK_ERROR",
            ),
            (
                HttpClientError::SecretNotFound { handle: "x".into() },
                "SECRET_NOT_FOUND",
            ),
            (
                HttpClientError::SecretExpired {
                    handle: "x".into(),
                    expired_at: 0,
                },
                "SECRET_EXPIRED",
            ),
            (
                HttpClientError::InvalidUrl {
                    message: "x".into(),
                    url: "x".into(),
                },
                "INVALID_URL",
            ),
            (
                HttpClientError::HttpsRequired { url: "x".into() },
                "HTTPS_REQUIRED",
            ),
            (
                HttpClientError::PermissionDenied {
                    reason: "x".into(),
                    actor_id: "x".into(),
                },
                "PERMISSION_DENIED",
            ),
            (
                HttpClientError::InvalidRequest {
                    message: "x".into(),
                },
                "INVALID_REQUEST",
            ),
        ];

        assert_eq!(
            cases.len(),
            ERROR_VARIANT_COUNT,
            "test must cover all {} error variants",
            ERROR_VARIANT_COUNT
        );

        for (error, expected_code) in cases {
            assert_eq!(
                error.code(),
                expected_code,
                "Error {:?} must have code {}",
                error,
                expected_code
            );
        }
    }

    #[test]
    fn all_error_codes_are_unique() {
        let variants = all_error_variants();
        let codes: HashSet<&str> = variants.iter().map(|e| e.code()).collect();

        assert_eq!(
            codes.len(),
            ERROR_VARIANT_COUNT,
            "all {} error codes must be unique — found {} unique codes",
            ERROR_VARIANT_COUNT,
            codes.len()
        );
    }

    // -----------------------------------------------------------------------
    // Display messages
    // -----------------------------------------------------------------------

    #[test]
    fn error_display_messages_are_descriptive() {
        let variants = all_error_variants();

        for error in &variants {
            let msg = error.to_string();
            assert!(
                !msg.is_empty(),
                "Error {:?} must have a non-empty Display message",
                error
            );
            // Every message must contain at least one word of context
            assert!(
                msg.len() > 5,
                "Error {:?} Display message '{}' is too short to be descriptive",
                error,
                msg
            );
        }
    }

    #[test]
    fn error_messages_include_contextual_data() {
        // DomainNotAllowed includes the domain
        let err = HttpClientError::DomainNotAllowed {
            domain: "blocked.example.com".to_string(),
            allowlist_patterns: vec![],
        };
        assert!(
            err.to_string().contains("blocked.example.com"),
            "DomainNotAllowed message must include the blocked domain"
        );

        // SsrfBlocked includes the reason
        let err = HttpClientError::SsrfBlocked {
            reason: "Private IP 192.168.1.1".to_string(),
            url: "http://192.168.1.1".to_string(),
        };
        assert!(
            err.to_string().contains("Private IP 192.168.1.1"),
            "SsrfBlocked message must include the reason"
        );

        // Timeout includes the timeout value
        let err = HttpClientError::Timeout {
            timeout_ms: 30000,
            elapsed_ms: 30001,
        };
        assert!(
            err.to_string().contains("30000"),
            "Timeout message must include the timeout_ms value"
        );

        // NetworkError includes the message
        let err = HttpClientError::NetworkError {
            message: "connection refused".to_string(),
        };
        assert!(
            err.to_string().contains("connection refused"),
            "NetworkError message must include the failure description"
        );

        // SecretNotFound includes the handle
        let err = HttpClientError::SecretNotFound {
            handle: "secret:abc123".to_string(),
        };
        assert!(
            err.to_string().contains("secret:abc123"),
            "SecretNotFound message must include the handle"
        );

        // InvalidUrl includes the reason
        let err = HttpClientError::InvalidUrl {
            message: "missing scheme".to_string(),
            url: "example.com".to_string(),
        };
        assert!(
            err.to_string().contains("missing scheme"),
            "InvalidUrl message must include the parse error"
        );

        // HttpsRequired includes the URL
        let err = HttpClientError::HttpsRequired {
            url: "http://insecure.example.com".to_string(),
        };
        assert!(
            err.to_string().contains("http://insecure.example.com"),
            "HttpsRequired message must include the offending URL"
        );
    }

    // -----------------------------------------------------------------------
    // Trait bounds
    // -----------------------------------------------------------------------

    #[test]
    fn errors_implement_clone_debug_send_sync() {
        fn assert_bounds<T: Clone + std::fmt::Debug + Send + Sync + std::error::Error>() {}

        assert_bounds::<HttpClientError>();
    }

    #[test]
    fn errors_implement_std_error() {
        let err = HttpClientError::NetworkError {
            message: "test".to_string(),
        };

        // std::error::Error is implemented via thiserror
        let _: &dyn std::error::Error = &err;

        // source() returns None for our leaf errors (no #[from] or #[source])
        assert!(
            std::error::Error::source(&err).is_none(),
            "leaf errors should have no source"
        );
    }

    // -----------------------------------------------------------------------
    // Error classification
    // -----------------------------------------------------------------------

    #[test]
    fn transient_errors_are_retryable() {
        let transient_errors = vec![
            HttpClientError::Timeout {
                timeout_ms: 5000,
                elapsed_ms: 5001,
            },
            HttpClientError::NetworkError {
                message: "connection reset".to_string(),
            },
        ];

        for err in transient_errors {
            assert_eq!(
                err.classify(),
                ErrorClass::Transient,
                "{:?} must be classified as Transient",
                err.code()
            );
            assert!(err.is_retryable(), "{:?} must be retryable", err.code());
            assert!(!err.is_fatal(), "{:?} must not be fatal", err.code());
        }
    }

    #[test]
    fn permanent_errors_are_not_retryable() {
        let permanent_errors = vec![
            HttpClientError::DomainNotAllowed {
                domain: "evil.example.com".to_string(),
                allowlist_patterns: vec![],
            },
            HttpClientError::SsrfBlocked {
                reason: "private IP".to_string(),
                url: "http://192.168.1.1".to_string(),
            },
            HttpClientError::SecretExpired {
                handle: "h1".to_string(),
                expired_at: 0,
            },
            HttpClientError::InvalidUrl {
                message: "missing scheme".to_string(),
                url: "not-a-url".to_string(),
            },
        ];

        for err in permanent_errors {
            assert_eq!(
                err.classify(),
                ErrorClass::Permanent,
                "{:?} must be classified as Permanent",
                err.code()
            );
            assert!(
                !err.is_retryable(),
                "{:?} must not be retryable",
                err.code()
            );
            assert!(err.is_fatal(), "{:?} must be fatal", err.code());
        }
    }

    #[test]
    fn all_errors_have_remediation() {
        let variants = all_error_variants();

        for err in variants {
            let remediation = err.remediation();
            assert!(
                !remediation.is_empty(),
                "Error {} must have non-empty remediation",
                err.code()
            );
        }
    }
}
