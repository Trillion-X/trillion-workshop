//! # Workflow
//!
//! Workflow Orchestration Engine — the "central nervous system" of Architect.
//!
//! Workflow core uses plain `ask/read/write` step kinds.
//! The workflow slot boundary translates those plain requests into the
//! existing Architect runtime operations. The workflow engine itself does not
//! know slot vocabulary.
//!
//! ## Execution Modes
//!
//! **Automation mode** (`execute_workflow`): Orchestrates a `Definition` with full control-flow (branches, loops, waits, parallelism). Long-running multi-step workflows.
//!
//! **Interactive mode** (`execute_definition`): Executes a `Definition` as a flat sequence of steps. UI actions, keyboard shortcuts, event-driven operations.
//!
//! ## Data Model
//!
//! - `definition`: unified executable entity with kind, trigger config, and graph steps
//! - `step`: graph node with kind-specific opaque config
//! - `workflow_instance`: entity for tracking execution state (Running, Completed, Failed, Paused, Cancelled)
//! - `edge`: graph topology between steps
//!
//! ## Architecture
//!
//! - Core types and domain logic live in `domain/` and `executor/`
//! - Orchestration engine in `executor/automation.rs`
//! - Workflow boundary translation in `executor/step_executor.rs` via `OutsideAccess`
//! - Store access via `DefinitionStore` + `EventStore` traits (domain/stores.rs)
//! - Slot boundary adapters live in the `workflow` crate

pub mod api;
#[cfg(feature = "native")]
pub mod daemon;
pub mod domain;
pub mod executor;
pub mod guards;
pub mod journal;
pub mod kernel_bridge;
pub mod loader;
pub mod stores;

// Re-export domain types (domain::types is the canonical location for workflow domain types)
pub use domain::*;

pub use executor::automation::{BackoffStrategy, RetryPolicy};
pub use executor::context::{record_step_output, BindingResolver};
pub use executor::polling::{EventPollResult, EventPoller, PollConfig, WorkflowExecutionOutcome};
pub use executor::step_executor::StepExecutor;
pub use executor::AsyncWorkflowExecutor;

pub use domain::{AttributeFactRow, DefinitionStore, EventStore, TriggerEvent};

// Re-export loader functions
pub use api::ExecuteDefinitionRequest;
#[cfg(feature = "native")]
pub use daemon::{DaemonConfig, DaemonHandle};
pub use kernel_bridge::{create_bridge, KernelBridge, KernelBridgeBuilder};
pub use loader::{
    load_active_definitions, load_definition_by_id, load_definition_by_slug,
    load_definitions_by_kind,
};
pub use stores::{CachedDefinitionStore, EnvelopeDispatchFn, RemoteEventStore};

pub use executor::budget::{BoundedExecutionError, BoundedRunLimits, BoundedRunUsage};
