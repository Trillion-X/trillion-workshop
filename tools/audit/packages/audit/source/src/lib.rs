// /crates/audit/src/lib.rs
//
// Audit crate for SOC2/HIPAA/GDPR compliance.
// Provides tamper-proof audit logging with cryptographic signatures.

pub mod envelope_handler;
pub mod signing;
pub mod sink;

pub use envelope_handler::{create_query_handler, AuditQueryHandler, WriteObservation};
pub use signing::{generate_keypair, sign_event, verify_event, verify_hash_chain};
pub use sink::{AuditError, AuditEvent, AuditSink, QueryCriteria};
