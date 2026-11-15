//! # HTTP Executor Test Fixtures
//!
//! ## Purpose
//!
//! Shared fixture abstractions for tests that need an HTTP-like executor. The
//! production package side-effect path uses `slot_work/call_external.rs` and the
//! configured process/session target instead of a native public executor.
//!
//! ## Non-Negotiable Invariants
//!
//! 1. `HttpExecutor` trait is object-safe (`Box<dyn HttpExecutor>` compiles)
//! 2. `HttpExecutor` trait is `Send + Sync` (thread-safe across async boundaries)
//! 3. `ReqwestHttpExecutor` is ONLY available in tests with `feature = "native"`
//! 4. `HttpExecutorResponse` is platform-agnostic fixture data
//! 5. No `.unwrap()` in production code — all errors are explicit and structured
//!
//! ## Key Concepts
//!
//! - **HttpExecutor**: Fixture abstraction for HTTP request execution.
//! - **HttpExecutorResponse**: Raw response from any fixture implementation. Contains
//!   status code, headers, and body as platform-agnostic types.
//! - **Feature gating**: `reqwest` and `tokio` dependencies stay behind the
//!   `native` feature and the `ReqwestHttpExecutor` itself is test-only.
//!
//! ## Security Considerations
//!
//! - URL validation is NOT the responsibility of this trait.
//! - Secret injection is NOT the responsibility of this trait.
//! - Timeout enforcement is the executor's responsibility — implementations MUST
//!   respect `timeout_ms`.
//!
//! *AI agents: do not promote this fixture trait back into a production native
//! side-effect route.*

use std::collections::HashMap;

use crate::domain::errors::HttpClientError;
use crate::domain::types::HttpMethod;

// ---------------------------------------------------------------------------
// HttpExecutorResponse
// ---------------------------------------------------------------------------

/// Raw HTTP response from the executor.
///
/// Platform-agnostic — both `reqwest::Response` and `web_sys::Response` produce this.
/// This struct contains only primitive types that work across all targets.
///
/// ## Fields
///
/// - `status`: HTTP status code (e.g., 200, 404, 500)
/// - `headers`: Response headers as key-value pairs (header names lowercased)
/// - `body`: Response body as raw bytes
#[derive(Debug, Clone)]
pub struct HttpExecutorResponse {
    /// HTTP status code (e.g., 200, 404, 500).
    pub status: u16,

    /// Response headers as key-value pairs.
    /// Header names are lowercased for consistency across platforms.
    pub headers: HashMap<String, String>,

    /// Response body as raw bytes.
    pub body: Vec<u8>,
}

// ---------------------------------------------------------------------------
// HttpExecutor Trait
// ---------------------------------------------------------------------------

/// Platform-agnostic HTTP execution trait.
///
/// Implementations:
/// - **Native (desktop/server):** `ReqwestHttpExecutor` wraps `reqwest::Client`
/// - **WASM (browser):** Future `WasmHttpExecutor` would use `web_sys::fetch`
///
/// ## Object Safety
///
/// This trait is object-safe: `Box<dyn HttpExecutor>` and `&dyn HttpExecutor` compile.
/// The `async_trait` macro handles the async method transformation.
///
/// ## Thread Safety
///
/// The trait requires `Send + Sync` bounds, making it safe to use across async
/// task boundaries and in multi-threaded contexts.
///
/// ## Timeout Enforcement
///
/// Implementations MUST respect `timeout_ms`. If the request exceeds this duration,
/// implementations MUST return `HttpClientError::Timeout`.
#[async_trait::async_trait]
pub trait HttpExecutor: Send + Sync {
    /// Execute an HTTP request and return the raw response.
    ///
    /// ## Parameters
    ///
    /// - `method`: validated HTTP method token
    /// - `url`: Parsed URL (already validated by TransportPolicy)
    /// - `headers`: Request headers to send (including any injected Authorization)
    /// - `body`: Optional request body bytes
    /// - `timeout_ms`: Maximum time to wait for response (MUST be enforced)
    ///
    /// ## Returns
    ///
    /// - `Ok(HttpExecutorResponse)` on successful HTTP response (any status code)
    /// - `Err(HttpClientError::Timeout)` if request exceeds `timeout_ms`
    /// - `Err(HttpClientError::NetworkError)` on connection/DNS/TLS failures
    /// - `Err(HttpClientError::InvalidRequest)` if request cannot be constructed
    async fn execute(
        &self,
        method: HttpMethod,
        url: url::Url,
        headers: HashMap<String, String>,
        body: Option<Vec<u8>>,
        timeout_ms: u64,
    ) -> Result<HttpExecutorResponse, HttpClientError>;
}

// ---------------------------------------------------------------------------
// ReqwestHttpExecutor (native feature only)
// ---------------------------------------------------------------------------

/// Native HTTP executor using `reqwest::Client`.
///
/// This implementation is ONLY available when the `native` feature is enabled.
/// It is excluded from WASM builds where `reqwest` cannot compile.
///
/// ## Connection Pooling
///
/// The wrapped `reqwest::Client` handles connection pooling internally. Reusing
/// a single `ReqwestHttpExecutor` across requests amortizes TCP/TLS handshakes.
///
/// ## Timeout Implementation
///
/// Uses `tokio::time::timeout` to enforce the caller-specified `timeout_ms`.
/// If the timeout elapses, returns `HttpClientError::Timeout`.
#[cfg(all(test, feature = "native"))]
pub struct ReqwestHttpExecutor {
    /// The underlying reqwest client (handles connection pooling).
    client: reqwest::Client,
}

#[cfg(all(test, feature = "native"))]
impl ReqwestHttpExecutor {
    /// Create a new executor wrapping an existing `reqwest::Client`.
    ///
    /// ## Arguments
    ///
    /// - `client`: A configured `reqwest::Client`. The caller controls timeouts,
    ///   redirect policies, and TLS configuration on this client.
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }

    /// Create a new executor with a default `reqwest::Client`.
    ///
    /// The default client has sensible defaults for timeouts, redirects, and TLS.
    /// Use `new()` if you need custom configuration.
    pub fn with_default_client() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    /// Get a reference to the underlying `reqwest::Client`.
    ///
    /// Useful for inspecting client configuration or reusing across executors.
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }
}

#[cfg(all(test, feature = "native"))]
impl std::fmt::Debug for ReqwestHttpExecutor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReqwestHttpExecutor")
            .field("client", &"reqwest::Client { ... }")
            .finish()
    }
}

#[cfg(all(test, feature = "native"))]
#[async_trait::async_trait]
impl HttpExecutor for ReqwestHttpExecutor {
    async fn execute(
        &self,
        method: HttpMethod,
        url: url::Url,
        headers: HashMap<String, String>,
        body: Option<Vec<u8>>,
        timeout_ms: u64,
    ) -> Result<HttpExecutorResponse, HttpClientError> {
        use std::time::{Duration, Instant};

        let reqwest_method =
            reqwest::Method::from_bytes(method.as_str().as_bytes()).map_err(|e| {
                HttpClientError::InvalidRequest {
                    message: format!("invalid HTTP method token: {e}"),
                }
            })?;

        // Build the request
        let mut req_builder = self.client.request(reqwest_method, url.as_str());

        // Set headers
        for (key, value) in &headers {
            req_builder = req_builder.header(key.as_str(), value.as_str());
        }

        // Set body if provided
        if let Some(body_bytes) = body {
            req_builder = req_builder.body(body_bytes);
        }

        // Build the request (can fail if headers are malformed)
        let request = req_builder
            .build()
            .map_err(|e| HttpClientError::InvalidRequest {
                message: e.to_string(),
            })?;

        // Execute with timeout
        let timeout_duration = Duration::from_millis(timeout_ms);
        let start = Instant::now();

        let response = tokio::time::timeout(timeout_duration, self.client.execute(request))
            .await
            .map_err(|_| HttpClientError::Timeout {
                timeout_ms,
                elapsed_ms: start.elapsed().as_millis() as u64,
            })?
            .map_err(|e| HttpClientError::NetworkError {
                message: e.to_string(),
            })?;

        // Extract response data
        let status = response.status().as_u16();

        let mut response_headers = HashMap::new();
        for (key, value) in response.headers() {
            if let Ok(v) = value.to_str() {
                response_headers.insert(key.as_str().to_string(), v.to_string());
            }
        }

        let body = response
            .bytes()
            .await
            .map_err(|e| HttpClientError::NetworkError {
                message: format!("Failed to read response body: {}", e),
            })?
            .to_vec();

        Ok(HttpExecutorResponse {
            status,
            headers: response_headers,
            body,
        })
    }
}

// ---------------------------------------------------------------------------
// URL Validation Trait (replaces transport::policy::TransportPolicy import)
// ---------------------------------------------------------------------------

/// Platform-agnostic URL validation trait.
///
/// Validates outbound URLs against security policies (domain allowlist, SSRF
/// prevention, HTTPS requirements). The host injects a concrete implementation
/// backed by TransportPolicy or any other URL validation mechanism.
///
/// This trait decouples http-client from the transport crate (CI-11).
#[async_trait::async_trait]
pub trait UrlValidator: Send + Sync {
    /// Validate a URL before making an HTTP request.
    ///
    /// Returns Ok(()) if the URL passes all security checks.
    /// Returns Err(HttpClientError) with the specific violation.
    fn validate(&self, url: &url::Url) -> Result<(), HttpClientError>;
}

// ---------------------------------------------------------------------------
// Secrets Resolution Trait (replaces credentials-vault import)
// ---------------------------------------------------------------------------

/// Platform-agnostic secret handle resolution trait.
///
/// Resolves secret handles (e.g., API keys, tokens) to their plaintext values
/// for injection into HTTP request headers. The host injects a concrete
/// implementation backed by CredentialsVault or any other secrets store.
///
/// This trait decouples http-client from the credentials-vault crate (CI-11).
#[async_trait::async_trait]
pub trait SecretsResolver: Send + Sync {
    /// Resolve a secret handle to its plaintext value.
    ///
    /// The caller_id identifies who is requesting the secret (for audit/ACL).
    /// Returns the plaintext secret value on success.
    /// Returns Err(HttpClientError::SecretNotFound/SecretExpired) on failure.
    async fn resolve_secret(
        &self,
        handle: &str,
        caller_id: &str,
    ) -> Result<String, HttpClientError>;
}

// ---------------------------------------------------------------------------
// Audit Logger Trait (replaces bitemporal + auth imports)
// ---------------------------------------------------------------------------

/// Platform-agnostic audit logging trait for HTTP calls.
///
/// Records metadata about completed HTTP calls (URL, method, status, latency)
/// for security auditing. The host injects a concrete implementation backed by
/// the journal system or any other audit mechanism.
///
/// This trait decouples http-client from the bitemporal and auth crates (CI-11).
#[async_trait::async_trait]
pub trait AuditLogger: Send + Sync {
    /// Log an HTTP call for audit purposes.
    ///
    /// Best-effort — failures should be logged but not propagated to the caller.
    /// Secret material is NEVER passed to this function.
    async fn log_call(
        &self,
        actor_id: &str,
        url: &str,
        method: &str,
        status_code: u16,
        latency_ms: u64,
        has_secret: bool,
    ) -> Result<(), String>;
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // HttpExecutorResponse tests
    // -----------------------------------------------------------------------

    #[test]
    fn http_executor_response_is_clone_debug_send_sync() {
        fn assert_bounds<T: Clone + std::fmt::Debug + Send + Sync>() {}
        assert_bounds::<HttpExecutorResponse>();
    }

    #[test]
    fn http_executor_response_fields_accessible() {
        let mut headers = HashMap::new();
        headers.insert("content-type".to_string(), "application/json".to_string());

        let response = HttpExecutorResponse {
            status: 200,
            headers,
            body: b"test body".to_vec(),
        };

        assert_eq!(response.status, 200);
        assert_eq!(
            response.headers.get("content-type").map(String::as_str),
            Some("application/json")
        );
        assert_eq!(response.body, b"test body");
    }

    // -----------------------------------------------------------------------
    // HttpExecutor trait tests
    // -----------------------------------------------------------------------

    #[test]
    fn http_executor_trait_is_object_safe() {
        // Compile-time proof: Box<dyn HttpExecutor> must compile
        fn assert_object_safe(_: Box<dyn HttpExecutor>) {}
        fn assert_ref_object_safe(_: &dyn HttpExecutor) {}

        // These functions existing and compiling proves object safety
        let _ = assert_object_safe;
        let _ = assert_ref_object_safe;
    }

    #[test]
    fn http_executor_trait_is_send_sync() {
        // The trait definition itself requires Send + Sync, so any implementor
        // must be Send + Sync. This is a compile-time proof, not a runtime test.
        fn assert_implementor_is_send_sync<T: HttpExecutor + Send + Sync>() {}

        // MockHttpExecutor implements HttpExecutor, so if this compiles,
        // we've proven that HttpExecutor requires Send + Sync.
        assert_implementor_is_send_sync::<MockHttpExecutor>();
    }

    // -----------------------------------------------------------------------
    // ReqwestHttpExecutor tests (native feature only)
    // -----------------------------------------------------------------------

    #[cfg(feature = "native")]
    mod native_tests {
        use super::*;

        #[test]
        fn reqwest_http_executor_implements_http_executor() {
            fn assert_impl<T: HttpExecutor>() {}
            assert_impl::<ReqwestHttpExecutor>();
        }

        #[test]
        fn reqwest_http_executor_is_send_sync() {
            fn assert_send_sync<T: Send + Sync>() {}
            assert_send_sync::<ReqwestHttpExecutor>();
        }

        #[test]
        fn reqwest_http_executor_new_creates_executor() {
            let client = reqwest::Client::new();
            let executor = ReqwestHttpExecutor::new(client);

            // Just verify it doesn't panic and provides access to client
            let _ = executor.client();
        }

        #[test]
        fn reqwest_http_executor_with_default_client() {
            let executor = ReqwestHttpExecutor::with_default_client();

            // Just verify it doesn't panic and creates a working executor
            let _ = executor.client();
        }

        #[test]
        fn reqwest_http_executor_debug_impl() {
            let executor = ReqwestHttpExecutor::with_default_client();
            let debug_str = format!("{:?}", executor);

            assert!(debug_str.contains("ReqwestHttpExecutor"));
        }

        #[test]
        fn reqwest_http_executor_is_boxable() {
            let executor = ReqwestHttpExecutor::with_default_client();
            let boxed: Box<dyn HttpExecutor> = Box::new(executor);

            // Verify boxed executor is usable (type check)
            let _ = boxed;
        }
    }

    // -----------------------------------------------------------------------
    // Mock HttpExecutor for testing (always available)
    // -----------------------------------------------------------------------

    /// Mock HTTP executor for testing purposes.
    ///
    /// Returns a pre-configured response or error regardless of input.
    /// Useful for testing code that depends on `HttpExecutor` without
    /// making real network calls.
    pub struct MockHttpExecutor {
        /// The response to return (if Ok)
        pub response: Option<HttpExecutorResponse>,
        /// The error to return (if Err)
        pub error: Option<HttpClientError>,
    }

    impl MockHttpExecutor {
        /// Create a mock that returns a successful response.
        pub fn with_response(response: HttpExecutorResponse) -> Self {
            Self {
                response: Some(response),
                error: None,
            }
        }

        /// Create a mock that returns an error.
        pub fn with_error(error: HttpClientError) -> Self {
            Self {
                response: None,
                error: Some(error),
            }
        }
    }

    #[async_trait::async_trait]
    impl HttpExecutor for MockHttpExecutor {
        async fn execute(
            &self,
            _method: HttpMethod,
            _url: url::Url,
            _headers: HashMap<String, String>,
            _body: Option<Vec<u8>>,
            _timeout_ms: u64,
        ) -> Result<HttpExecutorResponse, HttpClientError> {
            if let Some(ref error) = self.error {
                return Err(error.clone());
            }
            if let Some(ref response) = self.response {
                return Ok(response.clone());
            }
            // Default: return empty 200 response
            Ok(HttpExecutorResponse {
                status: 200,
                headers: HashMap::new(),
                body: Vec::new(),
            })
        }
    }

    #[test]
    fn mock_http_executor_implements_http_executor() {
        fn assert_impl<T: HttpExecutor>() {}
        assert_impl::<MockHttpExecutor>();
    }

    #[tokio::test]
    async fn mock_http_executor_returns_configured_response() {
        let mut headers = HashMap::new();
        headers.insert("x-test".to_string(), "value".to_string());

        let mock = MockHttpExecutor::with_response(HttpExecutorResponse {
            status: 201,
            headers: headers.clone(),
            body: b"created".to_vec(),
        });

        let url = url::Url::parse("https://example.com/test").unwrap();
        let result = mock
            .execute("POST".parse().unwrap(), url, HashMap::new(), None, 5000)
            .await
            .expect("mock should succeed");

        assert_eq!(result.status, 201);
        assert_eq!(
            result.headers.get("x-test").map(String::as_str),
            Some("value")
        );
        assert_eq!(result.body, b"created");
    }

    #[tokio::test]
    async fn mock_http_executor_returns_configured_error() {
        let mock = MockHttpExecutor::with_error(HttpClientError::Timeout {
            timeout_ms: 1000,
            elapsed_ms: 1001,
        });

        let url = url::Url::parse("https://example.com/test").unwrap();
        let result = mock
            .execute("GET".parse().unwrap(), url, HashMap::new(), None, 5000)
            .await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code(), "TIMEOUT");
    }

    #[test]
    fn mock_http_executor_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<MockHttpExecutor>();
    }
}
