// crates/http-client/src/domain/types.rs
//
//! # HTTP Client Domain Types
//!
//! ## Purpose
//!
//! Request/response types for the approved outside-request route.
//!
//! ## Non-Negotiable Invariants
//!
//! 1. `CallExternalRequest` carries a data-owned approved outside request
//! 2. `CallExternalResponse` carries an outside request receipt
//! 3. `HttpMethod` is an open RFC token, not a closed Rust method list
//! 4. `credential_injections` carry opaque handles — raw credentials are NEVER stored here
//! 5. `body` has exactly one owner shape: inline bytes or a content-addressed blob reference
//! 6. Blob-referenced bodies stay hash-only until the configured transport process mounts them
//!
//! ## Key Concepts
//!
//! - **CallExternalRequest**: The approved outside request descriptor. Contains
//!   URL, open method token, headers, optional body, optional credential-handle
//!   injections, optional request authorization, and optional timeout.
//! - **CallExternalResponse**: The outside request receipt. Contains HTTP status
//!   code, response headers, response body bytes, and measured latency.
//! - **HttpMethod**: Validated open method token. Extension methods are data,
//!   not enum variants.
//!
//! ## Security Considerations
//!
//! - Credential handles are opaque references from a credential owner — never raw credentials
//! - URL validation (allowlist, SSRF) is NOT performed by these pure types
//! - Response body is raw bytes — callers must validate content before interpreting
//!
//! *AI agents: The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail level.*

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;

// ---------------------------------------------------------------------------
// CallExternalRequest
// ---------------------------------------------------------------------------

/// Body source for one approved outside request.
///
/// Inline bytes preserve the existing JSON byte-array wire shape. Large or
/// reusable bodies use a self-describing CAS `blob_ref`; the HTTP slot passes
/// that address to the process owner as an input mount instead of expanding the
/// bytes into workflow or transport-request state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CallExternalBody {
    /// Bytes owned directly by the request.
    Inline(Vec<u8>),
    /// Content-addressed bytes owned by Envelope CAS.
    Addressed(AddressedCallExternalBody),
}

/// Addressed body sources use the same fundamental source vocabulary as
/// process input mounts. The tagged shape is data-driven and provider-neutral.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AddressedCallExternalBody {
    /// Read the exact request body from an Envelope CAS multihash.
    BlobRef { hash: String },
}

impl From<Vec<u8>> for CallExternalBody {
    fn from(bytes: Vec<u8>) -> Self {
        Self::Inline(bytes)
    }
}

/// Request to call an external HTTP service.
///
/// Per Kernel Codex Section 7 (Law of Open Boundaries):
/// - URL must pass the caller/runtime's configured policy checks
/// - URL must pass SSRF prevention before I/O
/// - credential handles (if provided) are resolved by the HTTP slot at execution time
///
/// Matches proto `CallExternalRequest` (the-kernel-codex.md lines 530-537).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallExternalRequest {
    /// Target URL (must be HTTPS in production).
    /// Validated by the runtime path before execution.
    pub url: String,

    /// HTTP method token for the request.
    pub method: HttpMethod,

    /// Request headers as key-value pairs.
    /// Secret material is NEVER placed here directly — use `credential_injections` instead.
    #[serde(default)]
    pub headers: HashMap<String, String>,

    /// Request body source (for POST/PUT/PATCH).
    /// `None` means no body. `Some(Inline(vec![]))` means an explicit empty
    /// body. `Addressed(BlobRef { .. })` keeps the body hash-only until the
    /// configured transport owner mounts it.
    #[serde(default)]
    pub body: Option<CallExternalBody>,

    /// Opaque credential handles plus caller-declared placement rules.
    ///
    /// The raw credential is NEVER stored in this field — only opaque handles.
    /// At execution time, the configured credential resolver target resolves
    /// each handle and this slot injects the credential into the requested
    /// header or query parameter.
    #[serde(default)]
    pub credential_injections: Vec<CredentialInjection>,

    /// Optional protocol-level authorization performed inside this slot before
    /// the outbound request is sent.
    ///
    /// OAuth2 refresh-token authorization deliberately lives here instead of in
    /// caller workflows: the refreshed access token is transient secret
    /// material and must never become workflow output or durable package data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization: Option<RequestAuthorization>,

    /// Request timeout in milliseconds.
    /// `None` uses the platform default (30,000ms).
    #[serde(default)]
    pub timeout_ms: Option<u64>,

    /// Where to send the answer AS IT ARRIVES, rather than only when it is
    /// whole.
    ///
    /// A reply that takes the better part of a minute and appears all at once
    /// is indistinguishable, for most of that minute, from one that is never
    /// coming. The bytes exist long before then: they arrive continuously and
    /// were being discarded into a buffer until the end.
    ///
    /// This slot does not read or interpret the value. It hands it to the
    /// transport owner, which knows how to deliver a part of an answer to
    /// somewhere the caller named. Absent, nothing changes and the whole
    /// response comes back exactly as before, which is what every caller that
    /// has not asked for this keeps getting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deliver_parts_to: Option<serde_json::Value>,
}

/// Opaque credential handle plus the HTTP location that should receive it.
///
/// This is deliberately provider-agnostic. Anthropic's `x-api-key`, OpenAI's
/// `Authorization: Bearer ...`, Google's API-key query/header forms, and any
/// future provider are all Society data expressed as placement rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialInjection {
    /// Opaque handle minted by the credential owner. Empty when the caller
    /// supplies `secret_name` instead (http-client mints the handle itself).
    #[serde(default)]
    pub handle: String,
    /// Vault key of a stored secret. When present (non-empty), http-client mints
    /// a handle from it (vault `read`) then resolves it — so a caller that only
    /// knows the connected-service secret name (DATA) never has to pre-mint a
    /// handle. Mutually exclusive in practice with `handle`.
    #[serde(default)]
    pub secret_name: Option<String>,
    /// Where the resolved value should be placed in the outgoing HTTP request.
    pub placement: CredentialPlacement,
}

/// Request-level authorization that can derive transient credentials from
/// opaque secret handles without exposing the derived value to callers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RequestAuthorization {
    /// Exchange OAuth2 client/refresh-token credentials for a fresh access
    /// token, validate the granted scopes, then inject that access token into
    /// the real outbound request according to `placement`.
    #[serde(rename = "oauth2_refresh_token")]
    OAuth2RefreshToken {
        /// OAuth2 token endpoint URL.
        token_url: String,
        /// Opaque handle resolving to the OAuth client id.
        client_id_handle: String,
        /// Opaque handle resolving to the OAuth client secret when the provider
        /// requires a confidential client.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_secret_handle: Option<String>,
        /// Opaque handle resolving to the refresh token.
        refresh_token_handle: String,
        /// Each inner group is satisfied when any one of its scopes is granted;
        /// all groups must be satisfied.
        #[serde(default)]
        required_scope_groups: Vec<Vec<String>>,
        /// Optional path to the provider's reported granted scopes in its refresh reply.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        granted_scopes_path: Option<Vec<String>>,
        /// Where the fresh access token is placed on the outbound request.
        placement: CredentialPlacement,
        /// How OAuth client credentials are used during token refresh.
        ///
        /// This is provider-neutral data handled inside `http-client` because
        /// plaintext credential values only exist inside this owner boundary.
        #[serde(default)]
        client_credential_use: OAuth2ClientCredentialUse,
    },
}

/// Provider-neutral OAuth2 client credential use during refresh-token exchange.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OAuth2ClientCredentialUse {
    /// Send `client_id` and optional `client_secret` as form fields.
    #[default]
    BodyFormFields,
    /// Send client credentials in `Authorization: Basic base64(id:secret)`.
    BasicAuthorizationHeader,
}

/// Provider-agnostic credential placement inside an HTTP request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CredentialPlacement {
    /// Inject into a request header.
    Header {
        /// Header name, e.g. `Authorization` or `x-api-key`.
        name: String,
        /// Optional prefix, e.g. `Bearer `.
        #[serde(default)]
        prefix: String,
        /// Optional suffix.
        #[serde(default)]
        suffix: String,
    },
    /// A short-lived signed token made from the held value at send time and put
    /// in a header. The held value never leaves: only the token is placed. The
    /// value may carry a key id before `key_id_separator` (for example
    /// `<id>:<secret>`); the id goes in the token header as `kid`, the rest is
    /// the signing key, decoded per `key_encoding` (`hex`, `base64` or `raw`).
    /// `format` names the token format and `algorithm` its signature; only a
    /// JSON Web Token signed with `HS256` is made today, and anything else is
    /// refused rather than guessed.
    SignedToken {
        /// Header name, e.g. `Authorization`.
        name: String,
        /// Optional prefix, e.g. `Ghost ` or `Bearer `.
        #[serde(default)]
        prefix: String,
        /// Token format; `jwt`.
        format: String,
        /// Signature algorithm; `HS256`.
        algorithm: String,
        /// Splits the held value into key id and key; absent means no key id.
        #[serde(default)]
        key_id_separator: Option<String>,
        /// How the key part is decoded before signing.
        key_encoding: String,
        /// Claims added to the token payload beside `iat` and `exp`.
        #[serde(default)]
        claims: serde_json::Map<String, serde_json::Value>,
        /// Seconds from now until the token expires.
        lifetime_seconds: u64,
    },
    /// Inject into the URL query string.
    Query {
        /// Query parameter name.
        name: String,
        /// Optional prefix.
        #[serde(default)]
        prefix: String,
        /// Optional suffix.
        #[serde(default)]
        suffix: String,
    },
    /// Append one field to an `application/x-www-form-urlencoded` request
    /// body, for example the `refresh_token` of an OAuth token request. The
    /// request must name that content type and carry an inline body or none;
    /// anything else is refused rather than guessed.
    FormField {
        /// Form field name.
        name: String,
        /// Optional prefix.
        #[serde(default)]
        prefix: String,
        /// Optional suffix.
        #[serde(default)]
        suffix: String,
    },
}

// ---------------------------------------------------------------------------
// HttpMethod
// ---------------------------------------------------------------------------

/// Validated HTTP method token.
///
/// This type validates the RFC token grammar but deliberately does not own a
/// finite list of known methods. Method vocabulary is request data.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HttpMethod(String);

impl HttpMethod {
    /// Build a method token from caller data.
    pub fn new(value: impl Into<String>) -> Result<Self, ParseHttpMethodError> {
        let value = value.into();
        validate_method_token(&value).map(|()| Self(value.to_ascii_uppercase()))
    }

    /// Return the method token as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for HttpMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Error returned when parsing an invalid HTTP method string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseHttpMethodError {
    /// The invalid input that could not be parsed.
    pub invalid_input: String,
}

impl fmt::Display for ParseHttpMethodError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "BHTTP_METHOD_TOKEN_INVALID: invalid HTTP method token")
    }
}

impl std::error::Error for ParseHttpMethodError {}

impl FromStr for HttpMethod {
    type Err = ParseHttpMethodError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::new(s)
    }
}

impl Serialize for HttpMethod {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for HttpMethod {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

fn validate_method_token(value: &str) -> Result<(), ParseHttpMethodError> {
    if value.is_empty() || !value.bytes().all(is_http_token_byte) {
        return Err(ParseHttpMethodError {
            invalid_input: value.to_string(),
        });
    }
    Ok(())
}

fn is_http_token_byte(byte: u8) -> bool {
    matches!(
        byte,
        b'!' | b'#'
            | b'$'
            | b'%'
            | b'&'
            | b'\''
            | b'*'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~'
            | b'0'..=b'9'
            | b'A'..=b'Z'
            | b'a'..=b'z'
    )
}

impl From<HttpMethod> for String {
    fn from(value: HttpMethod) -> Self {
        value.0
    }
}

// ---------------------------------------------------------------------------
// CallExternalResponse
// ---------------------------------------------------------------------------

/// Response from an external HTTP service.
///
/// Matches proto `CallExternalResponse` (the-kernel-codex.md lines 539-543),
/// extended with `latency_ms` for observability.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallExternalResponse {
    /// HTTP status code (e.g., 200, 404, 500).
    pub status_code: u16,

    /// Response headers as key-value pairs.
    #[serde(default)]
    pub headers: HashMap<String, String>,

    /// Response body as raw bytes.
    pub body: Vec<u8>,

    /// Response time in milliseconds (measured from request send to response complete).
    pub latency_ms: u64,

    /// What a token exchange made for this request (`authorization`) gave
    /// back: the access token it placed, how long that token lives and the
    /// refresh token that replaces the one it used, when the service rotates
    /// them. The caller keeps them, so a rotated refresh token is never lost
    /// and the access token is reused until it expires.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refreshed: Option<OAuth2RefreshedTokens>,
}

/// The tokens one OAuth2 refresh returned.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OAuth2RefreshedTokens {
    /// The fresh access token placed on the request.
    pub access_token: String,
    /// Seconds the access token lives, when the service says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<u64>,
    /// The refresh token to use next time, when the service issued a new one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// The provider value at the configured scope path, retained for the account's private grant record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub granted_scopes: Option<serde_json::Value>,
}

// NOTE: These types only carry request data. Validation policy is injected by
// the runtime path and is not encoded as a dependency on another slot/crate.

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // CallExternalRequest serialization
    // -----------------------------------------------------------------------

    #[test]
    fn call_external_request_serializes_to_json() {
        let mut headers = HashMap::new();
        headers.insert("Content-Type".to_string(), "application/json".to_string());

        let req = CallExternalRequest {
            url: "https://api.example.com/v1/data".to_string(),
            method: "POST".parse().unwrap(),
            headers,
            body: Some(CallExternalBody::Inline(b"hello".to_vec())),
            credential_injections: vec![CredentialInjection {
                handle: "secret:abc123:expires:1706500000".to_string(),
                secret_name: None,
                placement: CredentialPlacement::Header {
                    name: "Authorization".to_string(),
                    prefix: "Bearer ".to_string(),
                    suffix: String::new(),
                },
            }],
            authorization: None,
            timeout_ms: Some(5000),
            deliver_parts_to: None,
        };

        let json = serde_json::to_string(&req).expect("serialization must succeed");
        assert!(json.contains("\"url\":\"https://api.example.com/v1/data\""));
        assert!(json.contains("\"method\":\"POST\""));
        assert!(json.contains("\"Content-Type\":\"application/json\""));
        assert!(json.contains("\"credential_injections\""));
        assert!(json.contains("\"handle\":\"secret:abc123:expires:1706500000\""));
        assert!(json.contains("\"name\":\"Authorization\""));
        assert!(json.contains("\"timeout_ms\":5000"));
    }

    #[test]
    fn call_external_request_deserializes_from_json() {
        let json = r#"{
            "url": "https://api.example.com/data",
            "method": "GET",
            "headers": {"Authorization": "Bearer token"},
            "body": null,
            "credential_injections": [],
            "timeout_ms": 10000
        }"#;

        let req: CallExternalRequest =
            serde_json::from_str(json).expect("deserialization must succeed");

        assert_eq!(req.url, "https://api.example.com/data");
        assert_eq!(req.method, "GET".parse().unwrap());
        assert_eq!(
            req.headers.get("Authorization").map(String::as_str),
            Some("Bearer token")
        );
        assert!(req.body.is_none());
        assert!(req.credential_injections.is_empty());
        assert_eq!(req.timeout_ms, Some(10000));
    }

    #[test]
    fn call_external_request_deserializes_with_defaults() {
        // Minimal JSON — only required fields, optional fields use #[serde(default)]
        let json = r#"{
            "url": "https://example.com",
            "method": "GET"
        }"#;

        let req: CallExternalRequest =
            serde_json::from_str(json).expect("deserialization with defaults must succeed");

        assert_eq!(req.url, "https://example.com");
        assert_eq!(req.method, "GET".parse().unwrap());
        assert!(req.headers.is_empty(), "headers must default to empty map");
        assert!(req.body.is_none(), "body must default to None");
        assert!(
            req.credential_injections.is_empty(),
            "credential_injections must default to empty"
        );
        assert!(req.timeout_ms.is_none(), "timeout_ms must default to None");
    }

    #[test]
    fn call_external_request_deserializes_oauth2_refresh_authorization() {
        let json = r#"{
            "url": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
            "method": "GET",
            "authorization": {
                "kind": "oauth2_refresh_token",
                "token_url": "https://oauth2.googleapis.com/token",
                "client_id_handle": "client-id-handle",
                "client_secret_handle": "client-secret-handle",
                "refresh_token_handle": "refresh-token-handle",
                "required_scope_groups": [
                    ["https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"],
                    ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar"]
                ],
                "placement": {
                    "kind": "header",
                    "name": "Authorization",
                    "prefix": "Bearer ",
                    "suffix": ""
                }
            }
        }"#;

        let req: CallExternalRequest =
            serde_json::from_str(json).expect("OAuth2 authorization must deserialize");

        assert!(matches!(
            req.authorization,
            Some(RequestAuthorization::OAuth2RefreshToken { .. })
        ));
        let restored = serde_json::to_value(&req).expect("serialize request");
        assert_eq!(
            restored["authorization"]["kind"],
            serde_json::Value::String("oauth2_refresh_token".to_string())
        );
    }

    #[test]
    fn call_external_request_serialization_roundtrip() {
        let mut headers = HashMap::new();
        headers.insert("X-Request-Id".to_string(), "req-42".to_string());

        let original = CallExternalRequest {
            url: "https://api.stripe.com/v1/charges".to_string(),
            method: "POST".parse().unwrap(),
            headers,
            body: Some(CallExternalBody::Inline(vec![0x01, 0x02, 0x03])),
            credential_injections: vec![CredentialInjection {
                handle: "secret:stripe_key:expires:9999999999".to_string(),
                secret_name: None,
                placement: CredentialPlacement::Query {
                    name: "api_key".to_string(),
                    prefix: String::new(),
                    suffix: String::new(),
                },
            }],
            authorization: None,
            timeout_ms: Some(15000),
            deliver_parts_to: None,
        };

        let json = serde_json::to_string(&original).expect("serialize");
        let restored: CallExternalRequest = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(original.url, restored.url);
        assert_eq!(original.method, restored.method);
        assert_eq!(original.headers, restored.headers);
        assert_eq!(original.body, restored.body);
        assert_eq!(
            original.credential_injections,
            restored.credential_injections
        );
        assert_eq!(original.timeout_ms, restored.timeout_ms);
    }

    #[test]
    fn call_external_request_blob_body_roundtrips_as_one_addressed_source() {
        let hash = "1f:87979361c349cb3f6572a851608d8f51a5872cf53c227105c445e4e3c3ef1734";
        let request = CallExternalRequest {
            url: "https://api.example.com/v1/messages".to_string(),
            method: "POST".parse().unwrap(),
            headers: HashMap::new(),
            body: Some(CallExternalBody::Addressed(
                AddressedCallExternalBody::BlobRef {
                    hash: hash.to_string(),
                },
            )),
            credential_injections: Vec::new(),
            authorization: None,
            timeout_ms: None,
            deliver_parts_to: None,
        };

        let value = serde_json::to_value(&request).expect("serialize blob body");
        assert_eq!(
            value["body"],
            serde_json::json!({"kind": "blob_ref", "hash": hash})
        );
        let restored: CallExternalRequest =
            serde_json::from_value(value).expect("deserialize blob body");
        assert_eq!(restored.body, request.body);
    }

    // -----------------------------------------------------------------------
    // CallExternalResponse serialization
    // -----------------------------------------------------------------------

    #[test]
    fn call_external_response_serializes_to_json() {
        let mut headers = HashMap::new();
        headers.insert("content-type".to_string(), "application/json".to_string());

        let resp = CallExternalResponse {
            status_code: 200,
            headers,
            body: b"response body".to_vec(),
            latency_ms: 142,
            refreshed: None,
        };

        let json = serde_json::to_string(&resp).expect("serialization must succeed");
        assert!(json.contains("\"status_code\":200"));
        assert!(json.contains("\"latency_ms\":142"));
        assert!(json.contains("\"content-type\":\"application/json\""));
    }

    #[test]
    fn call_external_response_serialization_roundtrip() {
        let mut headers = HashMap::new();
        headers.insert("x-ratelimit-remaining".to_string(), "99".to_string());

        let original = CallExternalResponse {
            status_code: 429,
            headers,
            body: b"rate limited".to_vec(),
            latency_ms: 12,
            refreshed: None,
        };

        let json = serde_json::to_string(&original).expect("serialize");
        let restored: CallExternalResponse = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(original.status_code, restored.status_code);
        assert_eq!(original.headers, restored.headers);
        assert_eq!(original.body, restored.body);
        assert_eq!(original.latency_ms, restored.latency_ms);
    }

    // -----------------------------------------------------------------------
    // HttpMethod serialization + Display
    // -----------------------------------------------------------------------

    #[test]
    fn http_method_all_variants_serialize_to_uppercase() {
        let cases: [(HttpMethod, &str); 7] = [
            ("GET".parse().unwrap(), "\"GET\""),
            ("POST".parse().unwrap(), "\"POST\""),
            ("PUT".parse().unwrap(), "\"PUT\""),
            ("DELETE".parse().unwrap(), "\"DELETE\""),
            ("PATCH".parse().unwrap(), "\"PATCH\""),
            ("HEAD".parse().unwrap(), "\"HEAD\""),
            ("OPTIONS".parse().unwrap(), "\"OPTIONS\""),
        ];

        for (method, expected_json) in cases {
            let serialized = serde_json::to_string(&method).expect("serialize");
            assert_eq!(
                serialized, expected_json,
                "HttpMethod::{:?} must serialize to {}",
                method, expected_json
            );
        }
    }

    #[test]
    fn http_method_all_variants_deserialize_from_uppercase() {
        let cases = [
            ("\"GET\"", "GET".parse().unwrap()),
            ("\"POST\"", "POST".parse().unwrap()),
            ("\"PUT\"", "PUT".parse().unwrap()),
            ("\"DELETE\"", "DELETE".parse().unwrap()),
            ("\"PATCH\"", "PATCH".parse().unwrap()),
            ("\"HEAD\"", "HEAD".parse().unwrap()),
            ("\"OPTIONS\"", "OPTIONS".parse().unwrap()),
        ];

        for (json, expected) in cases {
            let deserialized: HttpMethod = serde_json::from_str(json).expect("deserialize");
            assert_eq!(
                deserialized, expected,
                "{} must deserialize to HttpMethod::{:?}",
                json, expected
            );
        }
    }

    #[test]
    fn http_method_display_trait_returns_uppercase() {
        assert_eq!("GET".parse::<HttpMethod>().unwrap().to_string(), "GET");
        assert_eq!("POST".parse::<HttpMethod>().unwrap().to_string(), "POST");
        assert_eq!("PUT".parse::<HttpMethod>().unwrap().to_string(), "PUT");
        assert_eq!(
            "DELETE".parse::<HttpMethod>().unwrap().to_string(),
            "DELETE"
        );
        assert_eq!("PATCH".parse::<HttpMethod>().unwrap().to_string(), "PATCH");
        assert_eq!("HEAD".parse::<HttpMethod>().unwrap().to_string(), "HEAD");
        assert_eq!(
            "OPTIONS".parse::<HttpMethod>().unwrap().to_string(),
            "OPTIONS"
        );
    }

    #[test]
    fn http_method_from_str_case_insensitive() {
        // Uppercase
        assert_eq!("GET".parse::<HttpMethod>().unwrap(), "GET".parse().unwrap());
        // Lowercase
        assert_eq!(
            "post".parse::<HttpMethod>().unwrap(),
            "POST".parse().unwrap()
        );
        // Mixed case
        assert_eq!("Put".parse::<HttpMethod>().unwrap(), "PUT".parse().unwrap());
        assert_eq!(
            "dElEtE".parse::<HttpMethod>().unwrap(),
            "DELETE".parse().unwrap()
        );
        assert_eq!(
            "patch".parse::<HttpMethod>().unwrap(),
            "PATCH".parse().unwrap()
        );
        assert_eq!(
            "HEAD".parse::<HttpMethod>().unwrap(),
            "HEAD".parse().unwrap()
        );
        assert_eq!(
            "options".parse::<HttpMethod>().unwrap(),
            "OPTIONS".parse().unwrap()
        );
    }

    #[test]
    fn http_method_from_str_rejects_invalid() {
        let extension = "CONNECT".parse::<HttpMethod>().expect("extension token");
        assert_eq!(extension.to_string(), "CONNECT");

        let err = "BAD METHOD".parse::<HttpMethod>().unwrap_err();
        assert_eq!(err.invalid_input, "BAD METHOD");
        assert!(err.to_string().contains("invalid HTTP method"));

        assert!("".parse::<HttpMethod>().is_err());
        assert!("GET/POST".parse::<HttpMethod>().is_err());
    }

    // -----------------------------------------------------------------------
    // Empty body handling
    // -----------------------------------------------------------------------

    #[test]
    fn empty_body_none_vs_some_empty() {
        // None body — no body sent
        let req_no_body = CallExternalRequest {
            url: "https://example.com".to_string(),
            method: "GET".parse().unwrap(),
            headers: HashMap::new(),
            body: None,
            credential_injections: Vec::new(),
            authorization: None,
            timeout_ms: None,
            deliver_parts_to: None,
        };
        assert!(req_no_body.body.is_none());

        // Some(vec![]) — empty body explicitly sent
        let req_empty_body = CallExternalRequest {
            url: "https://example.com".to_string(),
            method: "POST".parse().unwrap(),
            headers: HashMap::new(),
            body: Some(CallExternalBody::Inline(vec![])),
            credential_injections: Vec::new(),
            authorization: None,
            timeout_ms: None,
            deliver_parts_to: None,
        };
        assert_eq!(req_empty_body.body, Some(CallExternalBody::Inline(vec![])));

        // Verify they serialize differently
        let json_no_body = serde_json::to_value(&req_no_body).expect("serialize");
        let json_empty_body = serde_json::to_value(&req_empty_body).expect("serialize");
        assert!(
            json_no_body["body"].is_null(),
            "None body must serialize to null"
        );
        assert!(
            json_empty_body["body"].is_array(),
            "Some(vec![]) body must serialize to empty array"
        );
    }

    // -----------------------------------------------------------------------
    // Trait bounds: Clone, Debug, Send, Sync
    // -----------------------------------------------------------------------

    #[test]
    fn types_implement_clone_debug_send_sync() {
        fn assert_bounds<T: Clone + std::fmt::Debug + Send + Sync>() {}

        assert_bounds::<CallExternalRequest>();
        assert_bounds::<CallExternalResponse>();
        assert_bounds::<HttpMethod>();
        assert_bounds::<ParseHttpMethodError>();
    }
}
