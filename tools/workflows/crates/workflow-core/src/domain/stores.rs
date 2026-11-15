// crates/workflow-core/src/domain/stores.rs
//
// Purpose:
//   Store trait definitions and their referenced types (TriggerEvent,
//   AttributeFactRow). Previously in workflow-protocol leaf crate,
//   merged here because the crate had only 2 consumers and the circular
//   dep that justified its existence was eliminated.
//
// Contains:
//   - TriggerEvent: Physics-shaped event for trigger matching
//   - AttributeFactRow: Raw fact row from entity data store
//   - DefinitionStore: Trait for loading Definition objects
//   - EventStore: Trait for polling trigger events
//   - ContentStore: DELETED (GPH) — pre-TGD, replaced by opaque Envelope dispatch

use super::errors::WorkflowResult;
use super::types::EntityId;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

// ============================================================================
// TRIGGER EVENT TYPE
// ============================================================================

/// A trigger event that drives workflow execution.
///
/// Physics-shaped: zero domain vocabulary. The workflow engine matches on
/// `kind` and routes opaquely. Domain-specific fields (actor, organization,
/// contract) live in opaque `metadata` bytes — the data slot packs them
/// during poll, consumers deserialize at their boundary (L098).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerEvent {
    /// UUIDv7 primary key for time-ordered uniqueness
    pub id: String,
    /// Generic scoping key (partition, partition, tenant — consumer decides)
    pub scope: String,
    /// Generic discriminant for trigger matching (replaces event_type)
    pub kind: String,
    /// Opaque event payload — each consumer deserializes its own types
    pub payload: Vec<u8>,
    /// When the event occurred (ISO 8601)
    pub timestamp: String,
    /// Idempotency key for deduplication
    pub idempotency_key: Option<String>,
    /// Opaque metadata — domain-specific fields (actor_id, org_id, contract_id)
    /// packed by the data slot, never inspected by the workflow engine
    pub metadata: Vec<u8>,
}

// ============================================================================
// DATABASE ROW TYPE
// ============================================================================

/// A single fact row from the entity data store.
///
/// Used by DefinitionStore and other stores to return raw database rows
/// that are then assembled into domain objects.
///
/// Field names match the wire format (JSON serialization). Use accessor
/// methods (`entity()`, `property()`, `entity_type()`, `value()`) in
/// consumer code to avoid coupling to the wire format field names.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttributeFactRow {
    /// The entity this fact belongs to
    pub subject_id: String,
    /// The property being described
    pub property_id: String,
    /// The type context for this fact
    pub type_id: String,
    /// The JSON-encoded value
    pub value_json: Option<String>,
}

impl AttributeFactRow {
    /// The entity ID this fact belongs to.
    #[inline]
    pub fn entity(&self) -> &str {
        &self.subject_id
    }

    /// The property key being described.
    #[inline]
    pub fn property(&self) -> &str {
        &self.property_id
    }

    /// The entity type context.
    #[inline]
    pub fn entity_type(&self) -> &str {
        &self.type_id
    }

    /// The JSON-encoded value, if present.
    #[inline]
    pub fn value(&self) -> Option<&str> {
        self.value_json.as_deref()
    }
}

// ============================================================================
// STORE TRAITS
// ============================================================================

use super::types::Definition;

/// Generic definition store — ONE trait for all definition kinds (L069 + L090).
///
/// Slot-owned stores return assembled `Definition` objects directly. Adding
/// "pipeline" or any new kind requires ZERO trait changes — the `kind`
/// parameter filters generically.
#[async_trait]
pub trait DefinitionStore: Send + Sync {
    /// Fetch a definition by ID.
    fn get_by_id(&self, id: &str, partition_key: &str) -> WorkflowResult<Option<Definition>>;

    /// Fetch a shared definition by ID without cloning the full definition body.
    ///
    /// Hot action/loop replay paths should prefer this over `get_by_id()` when
    /// they only need read access to the loaded definition.
    fn get_by_id_shared(
        &self,
        id: &str,
        partition_key: &str,
    ) -> WorkflowResult<Option<Arc<Definition>>> {
        Ok(self.get_by_id(id, partition_key)?.map(Arc::new))
    }

    /// Fetch a definition by slug/name.
    fn get_by_slug(&self, slug: &str, partition_key: &str) -> WorkflowResult<Option<Definition>>;

    /// Fetch active definitions, optionally filtered by kind.
    /// `kind = None` returns all active. `kind = Some("action")` filters.
    fn get_active(
        &self,
        partition_key: &str,
        kind: Option<&str>,
    ) -> WorkflowResult<Vec<Definition>>;

    /// Fetch definitions matching a trigger source (for workflow polling).
    fn get_by_trigger(
        &self,
        trigger_source: &str,
        partition_key: &str,
    ) -> WorkflowResult<Vec<Definition>>;

    /// Fetch participant entity IDs linked to an interaction via participation table.
    /// Default: returns empty vec.
    fn get_participant_ids(
        &self,
        _interaction_id: &str,
        _partition_key: &str,
    ) -> WorkflowResult<Vec<EntityId>> {
        Ok(Vec::new())
    }
}

// Old ActionStore / WorkflowStore traits DELETED per L030 (no backward compatibility).

/// Trait for polling events that trigger workflows.
///
/// Host layers implement this to provide database access to events.
/// The polling engine uses this to find new events and mark them as processed.
#[async_trait]
pub trait EventStore: Send + Sync {
    /// Poll for new (unprocessed) events in a partition.
    ///
    /// Returns up to `batch_size` events ordered by timestamp.
    /// The definition of "unprocessed" is left to the host implementation
    /// (cursor, flag, separate table, etc.).
    fn poll_new_events(
        &self,
        partition_key: &str,
        batch_size: u32,
    ) -> WorkflowResult<Vec<TriggerEvent>>;

    /// Mark an event as processed.
    ///
    /// Called after all matching workflows have been executed for this event.
    /// The host layer decides how to record this (update flag, insert into
    /// tracking table, advance cursor, etc.).
    fn mark_event_processed(&self, event_id: &str, partition_key: &str) -> WorkflowResult<()>;
}

// ============================================================================
// CONTENT STORE
// ============================================================================

// ContentStore + AsyncBoxFuture: DELETED (GPH) — pre-TGD synchronous CAS trait.
// Post-TGD: content access is an opaque Envelope-dispatched capability.
