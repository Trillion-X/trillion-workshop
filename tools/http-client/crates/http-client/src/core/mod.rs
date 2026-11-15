//! # HTTP Client Core Module
//!
//! ## Purpose
//!
//! Core test-support traits for the package-owned outside-request slot. The
//! production side-effect path lives in `slot_work/call_external.rs`; this
//! module keeps reusable fixture abstractions and raw response shapes out of
//! the routed owner.
//!
//! ## Non-Negotiable Invariants
//!
//! 1. No production native execution route is declared here
//! 2. URL validation, credential resolution, and audit logging are caller/runtime concerns
//! 3. Secret material from credential handles is NEVER logged
//! 4. No `.unwrap()` in production code — all errors are structured
//! 5. Native `reqwest` support is a test fixture, not package authority
//!
//! ## WASM Compatibility
//!
//! Without the `native` feature, only these types are available:
//! - `HttpExecutor` trait
//! - `HttpExecutorResponse` struct
//! - `HttpClientError` enum (domain module)
//! - `HttpMethod` token (domain module)
//!
//! ## Key Concepts
//!
//! - `HttpExecutor`: fixture trait used by tests that need an HTTP-like executor
//! - `HttpExecutorResponse`: raw response shape used by those fixtures
//! - `ReqwestHttpExecutor`: native test fixture behind `all(test, feature = "native")`

/// Platform-agnostic HTTP execution trait (always available, works on WASM)
pub mod traits;
