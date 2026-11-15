//! # Journal Writer Module
//!
//! The single write path for all workflow execution state. Provides:
//! - MPSC channel-based writer loop with group commit
//! - CBOR canonical encoding + SHA-256 hashing for chain integrity
//! - CRC32 framing for crash recovery
//! - CAS blob storage for large payloads
//! - JournalStore trait for database abstraction

// Workflow journal modules
// Infrastructure modules (latest accepted journal position, compactor, sync, resume, lease, writer) are provided by bitemporal
pub mod encoding;
pub mod platform;
pub mod projector;
