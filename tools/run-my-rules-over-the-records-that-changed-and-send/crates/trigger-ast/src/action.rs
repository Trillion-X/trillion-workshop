// crates/trigger-ast/src/action.rs
//!
//! Definition dispatch type — the output of trigger evaluation.
//!
//! When a trigger matches an event, it produces a `DefinitionDispatch` describing
//! which definition entity to invoke and with what context. This type is shared
//! between interaction-engine (producer) and workflow (consumer) via this leaf
//! crate, eliminating the direct dependency between them.
//!
//! # Architecture (L088 leaf extraction)
//!
//! ```text
//! interaction-engine ──→ trigger-ast (leaf) ←── workflow
//!                          DefinitionDispatch
//! ```
//!
//! interaction-engine evaluates triggers and produces DefinitionDispatch.
//! workflow receives DefinitionDispatch and executes the referenced definition.
//! Both import the type from this leaf crate — neither depends on the other.

use serde::{Deserialize, Serialize};

/// Definition to be dispatched when a trigger matches.
///
/// Produced by the interaction engine's trigger evaluation pipeline.
/// Consumed by the workflow engine's definition-dispatch executor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefinitionDispatch {
    /// The trigger that matched
    pub trigger_id: String,
    /// The definition entity ID to invoke
    pub definition_id: String,
    /// Priority of the trigger (for debugging/conflict resolution)
    pub priority: u8,
    /// Additional context from the trigger evaluation
    pub context: serde_json::Value,
}
