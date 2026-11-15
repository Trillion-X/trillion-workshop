//! crates/composition-engine-core/src/lib.rs
//!
//! Composition Engine Core - reusable pure functional UI kernel.
//!
//! This crate owns the reusable composition implementation: binding evaluation,
//! blueprint normalization/resolution, bridge traits, host adapter traits, and
//! the kernel scene/layout/input/focus/fsm/ambient/compute/anchoring/text/
//! timeline/mapping/snapshot work. It is not a slot and does not own the
//! SharedBufferProtocol boundary.

pub mod binding;
pub mod blueprint;
pub mod bridge;
pub mod host;
pub mod kernel;

// Re-export everything from kernel for compatibility with the previous public API.
pub use kernel::*;

// Re-export main blueprint types.
pub use blueprint::{
    normalize_from_json, normalize_scene, resolve_tree, resolve_tree_with_tokens, validate_scene,
    BlueprintKind, BlueprintNode, BlueprintProps, BlueprintScene, BlueprintStyle, HashMapResolver,
    TokenResolver,
};

// Re-export main bridge types.
pub use bridge::{
    DataBridge, InMemoryDataBridge, InMemoryJournalBridge, JournalAppend, JournalBridge,
    JournalEntry, ReadParams, TransactAction, TransactParams,
};

// Re-export main host types.
pub use host::{
    FontMetrics, FontSpec, FullHost, InputAdapter, NullHost, RenderAdapter, SchedulerAdapter,
    TextMetricsAdapter,
};
