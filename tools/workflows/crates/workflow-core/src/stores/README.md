# `crates/workflow-core/src/stores/`

Workflow store implementations. Definition lookup now comes from workflow-owned
definition cache state; event polling still uses opaque Envelope dispatch.

## Files

| File | Purpose |
|------|---------|
| `mod.rs` | Module declarations, `EnvelopeDispatchFn` type definition, boundary address helper, public re-exports |
| `remote_event_store.rs` | `RemoteEventStore` — polls events and marks processed through the configured remote address |
| `cached_definition_store.rs` | `CachedDefinitionStore` — workflow-owned in-memory definition cache hydrated from package-record live state |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `EnvelopeDispatchFn` | `dyn Fn(&str, &PartitionKey, Option<&[u8]>, Option<&[u8]>) -> Result<Arc<[u8]>, String> + Send + Sync` | Opaque dispatch function — routes requests plus optional caller-context bytes to a caller-supplied address using the real Envelope partition identity |
| `RemoteEventStore` | `new(Arc<EnvelopeDispatchFn>, target_address) -> Self` | Implements `EventStore` trait via opaque dispatch to a caller-supplied address |
| `CachedDefinitionStore` | `insert_definition`, `insert_definition_for_address`, `insert_definition_for_address_with_payload_hash`, `hydration_for_address`, `remove_definition_address`, `replace_definitions`, `clear` | In-memory workflow definition cache hydrated by the workflow slot from admitted package-record live state; address-owned entries select the active definition for each ID by source rank, so direct package workflow-definition records outrank legacy action workflow-step facts; hydration evidence records the live payload hash by address for pre-ready owner-slot proof |
| `CachedDefinitionStore` | `new() -> Self` | Implements `DefinitionStore` trait over workflow-owned definition state |

`CachedDefinitionStore` is not a cross-slot client. It is hydrated directly by
workflow's subscribed boot/runtime state. `RemoteEventStore` remains
payload-blind — it serializes JSON requests as bytes, dispatches through the
opaque function to a caller-supplied address, and deserializes JSON responses.
Definition retractions are address-scoped and definition-id owned. The cache
retains every asserting address and recomputes the active definition for the
affected ID after each assertion or retraction. Direct package workflow
definition records are the canonical source when they exist; legacy
`prop:action:workflow_steps` facts remain lower-ranked compatibility inputs for
IDs that do not yet have direct records. This keeps package-set runtime
activation and ordinary live-state churn from erasing an action still asserted
by another live address while preventing stale legacy rows from overriding a
completed direct-definition replacement.

When the workflow slot receives a subscribed delta, it records the live payload
hash beside the address-owned definition. `hydration_for_address` exposes only
that address-scoped evidence to the slot wrapper, allowing Runtime Kit readiness
to compare package live-set expected hashes with the bytes the workflow slot
actually hydrated.

The dispatch function now takes the real `slot_protocol::PartitionKey` instead
of display text. That prevents workflow from degrading a received Envelope
partition into string form and then hashing it again on the way back out.
The fourth argument carries optional opaque caller context. Store reads pass
`None`; ask steps may pass caller context through without workflow interpreting
or naming the receiver's grant vocabulary.

## Dependencies

**Depends on:**
- `workflow_core::domain` — trait definitions (`DefinitionStore`, `EventStore`)
- `serde_json` — request/response serialization

**Depended on by:**
- `crates/workflow-core/src/lib.rs` — re-exports `CachedDefinitionStore`, `RemoteEventStore`, `EnvelopeDispatchFn`
- `crates/workflow/src/slot_work/definition_state.rs` — exposes these store primitives to the slot wrapper
- Host layers — construct dispatch functions and pass to workflow stores
