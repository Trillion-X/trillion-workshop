// crates/slot-protocol/src/actor.rs
//!
//! Actor identity context — who is performing an operation.
//!
//! This is a protocol-level type that flows through Envelope dispatch.
//! Every slot that performs authorized operations needs to know WHO
//! is acting. Placing this in slot-protocol (L088) eliminates the need
//! for slot crates to depend on the full auth crate.
//!
//! # Architecture (L088 leaf extraction)
//!
//! ```text
//! slot-protocol (leaf) ── ActorContext
//!       ↑         ↑         ↑
//!   target-a  target-b  target-c  ...N other crates
//! ```
//!
//! A higher package may define domain-specific identity data and re-export
//! ActorContext from here. Other crates import directly from slot-protocol —
//! no dependency on that higher package is needed.

use serde::{Deserialize, Serialize};

/// Identity context for the actor performing an operation.
///
/// Flows through Envelope dispatch to authorize operations.
/// Every slot that performs permission-checked work receives this.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ActorContext {
    /// The ID of the authenticated user performing the operation.
    pub user_id: String,

    /// Optional session identifier for correlating related operations.
    pub session_id: Option<String>,

    /// Optional client IP address for audit logging.
    pub ip_address: Option<String>,
}

impl ActorContext {
    /// Create an actor context with the given user ID.
    pub fn new(user_id: impl Into<String>) -> Self {
        Self {
            user_id: user_id.into(),
            session_id: None,
            ip_address: None,
        }
    }

    /// Create an actor context with user ID and session ID.
    pub fn with_session(user_id: impl Into<String>, session_id: impl Into<String>) -> Self {
        Self {
            user_id: user_id.into(),
            session_id: Some(session_id.into()),
            ip_address: None,
        }
    }
}
