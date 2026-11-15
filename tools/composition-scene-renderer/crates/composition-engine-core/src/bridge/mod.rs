//! crates/composition-engine-core/src/bridge/mod.rs
//!
//! Bridge Module — Abstract traits for platform integration.
//!
//! # Purpose
//! This module provides the abstract traits that platform adapters implement
//! to bridge the composition engine to external systems:
//!
//! - **DataBridge**: EEAF data access (read/transact/subscribe)
//! - **JournalBridge**: Bitemporal journal for undo/redo
//!
//! # Architecture
//! ```text
//! ┌─────────────────────────────────────────┐
//! │         Composition Engine              │
//! │  (kernel, blueprint, resolver, ...)     │
//! └─────────────────┬───────────────────────┘
//!                   │
//!                   ▼
//! ┌─────────────────────────────────────────┐
//! │            Bridge Traits                │
//! │  DataBridge, JournalBridge              │
//! └─────────────────┬───────────────────────┘
//!                   │ implements
//!                   ▼
//! ┌─────────────────────────────────────────┐
//! │         Platform Adapters               │
//! │  LibsqlDataBridge, WebDataBridge, ...    │
//! └─────────────────────────────────────────┘
//! ```
//!
//! # Non-Negotiable Invariants
//! - Bridge traits are async (all methods return Futures)
//! - No direct database/network calls in this crate
//! - Platform adapters live outside this crate
//!
//! # Provided Implementations
//! - `InMemoryDataBridge`: For testing
//! - `InMemoryJournalBridge`: For testing
//! - `DataBridgeJournal`: JournalBridge backed by DataBridge
//!
//! Ported from: frontends/web/composition-engine/bridge/

pub mod data;
pub mod journal;

// Re-export main types for convenience
pub use data::{
    // Trait
    DataBridge,
    // Errors
    DataBridgeError,
    DataResult,
    FilterCondition,
    // Implementations
    InMemoryDataBridge,
    OrderBy,
    // Types
    ReadParams,
    ReadResult,
    SortDirection,
    SubscribeParams,
    SubscriptionCallback,
    TransactAction,
    TransactParams,
    TransactResult,
    Unsubscribe,
};

pub use journal::{
    DataBridgeJournal,
    // Implementations
    InMemoryJournalBridge,
    // Types
    JournalAppend,
    JournalAppendResult,
    // Trait
    JournalBridge,
    JournalEntry,
    UndoRedoState,
};
