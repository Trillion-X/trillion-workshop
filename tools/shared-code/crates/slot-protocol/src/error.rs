//! Error types for slot protocol operations.

pub use crate::envelope_error::EnvelopeError;

use thiserror::Error;

/// Slot-specific errors.
#[derive(Debug, Clone, Error)]
pub enum SlotError {
    /// Slot not found in the registry.
    #[error("slot not found: {name}")]
    NotFound { name: String },

    /// Method not supported by the slot.
    #[error("method not supported: {method}")]
    MethodNotSupported { method: String },

    /// Slot error from envelope engine.
    #[error("envelope error: {0}")]
    Envelope(#[from] EnvelopeError),
}
