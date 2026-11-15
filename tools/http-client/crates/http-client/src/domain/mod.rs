//! # HTTP Client Domain Module
//!
//! ## Purpose
//!
//! Pure data types for the package-owned outside-request slot. Zero I/O, zero
//! platform dependencies: only type definitions and error structures.
//!
//! ## Non-Negotiable Invariants
//!
//! 1. No I/O in this module — types only
//! 2. All types implement Serialize + Deserialize for cross-boundary transport
//! 3. All errors are structured with machine-readable codes
//! 4. Generic values stay data; package-specific labels do not become code
//!
//! ## Key Concepts
//!
//! - `types`: Request/response types and the open `HttpMethod` token
//! - `errors`: Structured error types with error codes and remediation context
//!
//! *AI agents: keep domain types open and serializable. Do not replace generic
//! configuration/data with closed product enums.*

pub mod errors;
pub mod types;
