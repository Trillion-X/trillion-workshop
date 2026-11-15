//! # Slot Protocol
//!
//! The universal dispatch mechanism for all capabilities in the Architect platform.
//! This is a TRUE LEAF crate — zero heavy dependencies.
//!
//! ## Architecture
//!
//! Dependency Inversion: `envelope-engine` (heavy runtime) imports `slot-protocol` (leaf).
//! Slot crates import ONLY `slot-protocol` for types. They NEVER import `envelope-engine`.
//!
//! The Slot trait provides a single, model-agnostic dispatch interface:
//!
//! - **Physics only**: Slots receive opaque Envelope entries, return receipts (Hash), advertise methods.
//! - **No enumeration (L090)**: All slots dispatch to `Arc<dyn Slot>`. Core never pattern-matches on slot type.
//! - **Envelope-backed registry**: SlotRegistry resolves slots by querying state. ArcSwap cache is read-through, not authority.
//! - **Zero Society vocabulary**: No CrudSlot, WorkflowSlot, WasmSlot type names. Tests use generic TestSlotA, TestSlotB.
//!
//! ## Core Types (Envelope Protocol — extracted from envelope-engine)
//!
//! - [`Envelope`] — The irreducible structural envelope for all data
//! - [`PartitionKey`] — Partition-isolated causal boundary (Blake3-256)
//! - [`FactAddress`] — Entity identity (Blake3-256)
//! - [`Hash`] — Crypto-agile hash (Multihash wrapper)
//! - [`PathSegment`] — Optional structural sub-address
//! - [`EnvelopeError`] — Machine-readable error codes (FE_xxx)
//! - [`EnvelopeSelector`] — Subscription filter for Delta delivery
//! - [`ConflictSet`] — First-class conflict object (multi-writer)
//!
//! ## Slot Dispatch Types
//!
//! - [`Slot`] — The universal trait for dispatch
//! - [`SlotRegistry`] — Resolves slots by name via Envelope state
//! - [`MethodDescriptor`] — Advertises slot capabilities (no input/output schemas)
//! - [`SlotRequest`] — Wire format with content-addressed policy keys
//! - [`SlotDescriptor`] — Boot-time topology declaration
//!
//! ## Key Invariants
//!
//! 1. **Receipt semantics**: `dispatch()` returns `Result<Hash, EnvelopeError>` (admission receipt, not result)
//! 2. **Opaque payloads**: Platform never deserializes Envelope payloads
//! 3. **Generic dispatch**: Registry works with any `Arc<dyn Slot>`; zero type matching
//! 4. **Content-addressed policies**: Policy keys are Blake3-256 hashes, not strings
//! 5. **Optional notifications**: `subscribe()` returns `Option<Receiver<Arc<Envelope>>>`
//!
//! ## Usage Example
//!
//! ```ignore
//! use slot_protocol::{Slot, SlotRegistry, MethodDescriptor, Envelope, Hash};
//! use std::sync::Arc;
//!
//! // Create a registry
//! let registry = SlotRegistry::new();
//!
//! // Register a slot (in real code, this comes from Envelope state)
//! let my_slot: Arc<dyn Slot> = Arc::new(MySlotImpl);
//! registry.register("my_slot".to_string(), my_slot);
//!
//! // Resolve and dispatch
//! let slot = registry.resolve("my_slot")?;
//! let receipt = slot.dispatch(vec![envelope])?;
//!
//! // List methods
//! let methods = slot.methods();
//! ```

// ============================================================================
// Protocol-Level Identity Types
// ============================================================================
pub mod actor;
pub mod auth;

// ============================================================================
// Envelope Protocol Types (leaf — extracted from envelope-engine)
// ============================================================================
pub mod conflict;
pub mod delta;
pub mod engine_operation;
pub mod envelope_error;
pub mod envelope_type;
pub mod immutable_content;
pub mod json_bytes;
pub mod newtypes;
pub mod query;
pub mod query_context;
pub mod reply_delivery;
pub mod selector;
pub mod transaction_overlay;

// ============================================================================
// Slot Dispatch Types
// ============================================================================
pub mod collection;
pub mod descriptor;
pub mod dispatch_handle;
pub mod dispatch_slot;
pub mod error;
pub mod handler;
pub mod method;
pub mod policy;
pub mod registry;
pub mod request_reply;
pub mod slot;
pub mod slot_state;
pub mod wire;

// ============================================================================
// Re-exports: Protocol Identity
// ============================================================================
pub use actor::ActorContext;
pub use auth::{AuthorizationContext, LatestAcceptedCapabilityExpiry};

// ============================================================================
// Re-exports: Envelope Protocol
// ============================================================================
pub use conflict::{BranchContext, ConflictBranch, ConflictSet, MergeAction, MergeError};
pub use delta::{DeltaPayload, WireAssert, WireDeltaGap};
pub use engine_operation::{
    decode_engine_operation_frame, encode_engine_operation_frame, EngineOperation,
    EngineOperationDescriptor, EngineOperationFrame, EngineOperationRegistry,
};
pub use envelope_error::EnvelopeError;
pub use envelope_type::{
    make_request_bytes_for_other_slots, make_request_bytes_for_other_slots_with_reply_delivery,
    read_request_bytes_from_other_slots, Envelope,
};
pub use immutable_content::{
    decode_immutable_content_request, decode_immutable_content_store_reply,
    encode_immutable_content_request, encode_immutable_content_store_reply,
    encode_immutable_content_store_request, ImmutableContentRef, ImmutableContentRequest,
    IMMUTABLE_CONTENT_ADDRESS,
};
pub use newtypes::{CapabilityHash, FactAddress, Hash, PartitionKey, PathSegment, PrincipalId};
pub use query::{
    decode_direct_read_reply, decode_list_live_state_reply, decode_list_live_state_request,
    encode_direct_read_reply, encode_direct_read_reply_parts, encode_list_live_state_reply,
    encode_list_live_state_request, DirectReadReply, ListLiveStateReply, ListLiveStateRequest,
    LiveStateEntryReply, LiveStateFieldEq, LIVE_STATE_ADDRESS,
};
pub use query_context::{
    combine_query_context, frame_caller_directive, split_query_context, QueryContextParts,
    SOURCE_DELTA_OP_RECONCILE_DIRECTIVE, SOURCE_DELTA_OP_RETRACT_DIRECTIVE,
};
pub use reply_delivery::{
    decode_other_slot_request, encode_other_slot_request, send_later_outcome_address,
    send_later_outcome_path, send_later_request_address, send_later_request_hash,
    send_later_request_path, OtherSlotRequest, ReplyDelivery, SendLaterOutcomeRecord,
    SendLaterOutcomeStatus, SendLaterReceipt, SendLaterRequestRecord,
};
pub use selector::{
    Delta, DeltaAssert, DeltaGap, EnvelopeSelector, LiveStateEntry, LiveStatePointer,
    SlotSubscription, SubscriptionBootstrapMode, SubscriptionContentMode, SubscriptionGapRecovery,
    SubscriptionIntent,
};
pub use transaction_overlay::{
    decode_transaction_overlay_manifest, decode_transaction_overlay_ref,
    encode_transaction_overlay_manifest, encode_transaction_overlay_ref,
    TransactionOverlayManifest, TransactionOverlayManifestEntry, TransactionOverlayRef,
};

// ============================================================================
// Re-exports: Slot Dispatch
// ============================================================================
pub use collection::{dispatch_multi, CollectionPolicy, Reply};
pub use descriptor::{verify_topology, AddressPattern, RoutingIntent, SlotDescriptor};
pub use dispatch_handle::{DispatchHandle, LiveStateScanControl, LiveStateScanVisitor, RootDiff};
pub use dispatch_slot::DispatchSlot;
pub use error::SlotError;
pub use handler::{
    decode_atomic_write_batch, decode_write_batch, deserialize_payload, encode_write_batch,
    encode_write_batch_with_preconditions, serialize_response, AtomicWriteBatch, EngineContext,
    ExpectedCurrentValue, HandlerTable, QueryBatchResult, QueryHandler, QueryResult, WriteEntry,
    WritePrecondition,
};
pub use method::MethodDescriptor;
pub use policy::{PolicyResolver, ResolvedPolicy};
pub use registry::{address_for_routable_name, SlotRegistry};
pub use request_reply::{
    build_reply_envelope, build_request_envelope, CorrelationId, RequestMetadata,
};
pub use shared_slot_batches::PlugCallPermissionRow;
pub use slot::Slot;
pub use slot_state::{
    apply_initial_slot_configs, apply_slot_config, deserialize_slot_config,
    process_slot_assertions, process_slot_retractions, remove_slot, serialize_slot_config,
    slot_config_path, SlotConfig, SlotMethodConfig, SlotPlugConfig, SlotQueryHandlerResolver,
    SlotRunnerConfig, SlotStoredBytesConfig,
};
pub use wire::SlotRequest;

// ============================================================================
// Re-exports: CAS byte reader seam for private runners.
pub mod cas_blob_writer;
pub mod cas_reader;

// Web host dispatch: plain wasm modules (wasm-bindgen hosts such as a Cloudflare
// Worker) reach other slots through a host-installed function instead of the
// wasi `talk-to-other-slots` import.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub mod web_host;
pub use cas_blob_writer::CasBlobWriter;
pub use cas_reader::CasReader;
