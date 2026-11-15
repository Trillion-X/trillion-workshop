//! # HTTP Client
//!
//! ## Purpose
//!
//! Package-owned outside-request slot. The production path is the routed
//! `slot::http-client` work path: caller envelopes enter the WASM slot, the slot
//! validates configured URL grants, resolves configured credential handles
//! through the credential owner, and delegates real transport to the configured
//! process/session target.
//!
//! ## Non-Negotiable Invariants
//!
//! 1. Production side effects go through `slot_entry` + `slot_work`, not native exports
//! 2. URL validation comes from caller-context grants, not package-specific code branches
//! 3. Secret material from credential handles is NEVER logged
//! 4. Transport target and process descriptor are package data
//! 5. HTTP methods are open validated tokens, not a closed product enum
//! 6. Native HTTP code is test fixture support only
//!
//! ## WASM Compatibility
//!
//! This crate compiles as a WASI slot. Runtime-owned callers await the exported
//! async component functions through the command lane.
//!
//! ```bash
//! # Check WASM slot compilation
//! cargo check --target wasm32-wasip2 --no-default-features
//!
//! # Run focused package tests
//! cargo test
//! ```
//!
//! ## Key Concepts
//!
//! - **CallExternalRequest**: Typed outside-request input
//! - **CallExternalResponse**: Typed outside-request receipt
//! - **HttpMethod**: Open validated HTTP method token
//! - **OAuth2ClientCredentialUse**: Provider-neutral client credential placement
//! - **HttpClientError**: Structured, machine-readable error with codes and remediation context
//!
//! ## Security Considerations
//!
//! - URL validation happens before transport delegation
//! - This crate handles credential-handle injection but not raw secret ownership
//! - No `.unwrap()` in production code — all errors are explicit and structured
//!
//! *AI agents: keep this crate as a configured slot owner. Do not reintroduce
//! native public side-effect exports or package-specific shared Physics.*

pub mod core;
pub mod domain;
// The wasi slot entry (wit-bindgen guest). A web host (wasm32-unknown-unknown)
// cannot supply its component-model imports and uses `run_in_a_web_worker`.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub mod slot_entry;
pub mod slot_work;
pub mod talk_to_other_slots;
// Web host entry (Cloudflare Worker / browser through wasm-bindgen).
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub mod run_in_a_web_worker;

// ============================================================================
// Public API Re-exports
//
// Consumers should `use http_client::TypeName` directly.
// The internal module structure (core/, domain/) is an implementation detail.
// ============================================================================

// -- Test-support traits. Production side effects use slot_work plus process/session. --
pub use core::traits::{AuditLogger, SecretsResolver, UrlValidator};
pub use core::traits::{HttpExecutor, HttpExecutorResponse};

// -- Domain types --
pub use domain::types::{
    AddressedCallExternalBody, CallExternalBody, CallExternalRequest, CallExternalResponse,
    CredentialInjection, CredentialPlacement, HttpMethod, OAuth2ClientCredentialUse,
    OAuth2RefreshedTokens,
};

// -- Errors --
pub use domain::errors::ErrorClass;
pub use domain::errors::HttpClientError;

// The routed WASM slot is the only production side-effect entry.
