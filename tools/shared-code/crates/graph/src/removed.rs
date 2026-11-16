//! Removed: Result of removing a node from the graph.
//!
//! File: crates/graph/src/removed.rs
//! Purpose: Structure for P6 change propagation when a node is removed
//! Non-Negotiable Invariants:
//! - All severed edges (incoming + outgoing) are returned with metadata
//! - Metadata is E directly, NOT Option<E>
//! - E = () is zero-cost for graphs without edge metadata

/// All severed edges returned when a node is removed.
///
/// # Type Parameters
/// - `K`: Node key type
/// - `E`: Edge metadata type (default is empty tuple)
#[derive(Debug, Clone)]
pub struct Removed<K, E = ()>
where
    K: Clone,
    E: Clone,
{
    /// The key that was removed
    pub key: K,
    /// All incoming edges: (source_key, metadata)
    pub incoming: Vec<(K, E)>,
    /// All outgoing edges: (destination_key, metadata)
    pub outgoing: Vec<(K, E)>,
}
