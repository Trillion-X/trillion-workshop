# crates/workflow-core

Workflow orchestration engine — blind graph execution over slot-owned state.

## Purpose

Reusable workflow orchestration library used underneath `slot::workflow`. This crate owns:

1. **Workflow-owned definition execution** — load a workflow-owned `Definition` from workflow-owned cache state and execute it.
2. **Blind graph sequencing** — step ordering, loops, waits, joins, retries, and execution context.
3. **Plain boundary model** — `ask/read/write` stay plain in workflow core and are translated at the `workflow` slot edge.
4. **Partition separation** — workflow keeps its own logical `partition_key` string for workflow state, while cross-slot `ask/read` dispatch carries the real `slot_protocol::PartitionKey` unchanged.

This crate does **not** own EEAF, database routing, or another slot's domain state.
Workflow-core tests use anonymous test target names for boundary mechanics; concrete package query targets belong to package data and package-owned code, not this crate.

## Architecture Overview

```
┌──────────────────────────────────────┐
│  WORKFLOW-OWNED STATE                 │
│  - Definition cache                   │
│  - Execution context                  │
│  - Graph/native step semantics        │
├──────────────────────────────────────┤
│  BLIND ORCHESTRATION                  │
│  - action / loop / wait / joins       │
│  - retries / sequencing / DAG         │
│  - binding resolution                 │
├──────────────────────────────────────┤
│  PLAIN BOUNDARY TRANSLATION           │
│  - ask / read / write                 │
│  - no EEAF/domain knowledge           │
└──────────────────────────────────────┘
```

**Execution modes:**
- **Automation mode** (`execute_workflow`): orchestrates a `Definition` with full control-flow (branches, loops, parallelism, waits)
- **Interactive mode** (`execute_definition`): executes a `Definition` in interactive mode using the unified definition surface

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Crate manifest — root-inherited deps: serde, tokio, async-trait, thiserror, tracing, futures, uuid, chrono |
| `src/lib.rs` | Public API re-exports: domain types, executor traits, kernel bridge, loaders |
| `src/domain/types.rs` | Domain types: unified `Definition`, graph-native `Step`/`StepEdge`, `LoopConfig`, `WaitCondition`, `ExecutionContext`, `ExecutionStatus` — Physics layer types |
| `src/api.rs` | Canonical workflow wire contracts, including `ExecuteDefinitionRequest` and its response-shaping flags |
| `src/domain/errors.rs` | `WorkflowError` — 28 variants with machine-readable codes and remediation hints |
| `src/domain/canonical.rs` | Canonical workflow execution sequences and patterns |
| `src/domain/mod.rs` | Domain module exports |
| `src/executor/mod.rs` | The executor: `AsyncWorkflowExecutor<B>` |
| `src/executor/automation.rs` | Orchestration engine: `execute_workflow()`, graph step handlers, `DefinitionStore` trait, `RetryPolicy` |
| `src/executor/step_executor.rs` | Step execution: resolves bindings, asks outside work, reads state, captures outputs |
| `src/executor/value_to_bytes.rs` | Private write-payload byte encoder for data-declared `value_to_bytes` layouts such as RTBL `cell_table` rows |
| `src/executor/polling.rs` | Event-driven execution: `EventPoller`, `EventStore` trait, `PollConfig`, `TriggerEvent`, `WorkflowExecutionOutcome` |
| `src/executor/context.rs` | Execution context management: `TemplateResolver`, `record_step_output()`, variable binding resolution |
| `src/executor/simulation.rs` | Dry-run execution (no side effects) for validation and testing |
| `src/executor/interactive.rs` | Interactive execution mode: `execute_definition_interactive()` — loads a definition, validates input, executes all steps sequentially |
| `src/stores/cached_definition_store.rs` | Workflow-owned in-memory definition cache hydrated from workflow-owned definition bytes |
| `src/stores/remote_event_store.rs` | Opaque event-store dispatch target supplied by caller |
| `src/loader.rs` | Definition loaders such as `load_definition_by_id()` and `load_active_definitions()` |
| `src/kernel_bridge.rs` | `KernelBridge`, `KernelBridgeBuilder`, `create_bridge()` — host-to-kernel communication factory |
| `src/guards/mod.rs` | `GuardsFactory` — permission, constraint, and audit guard creation |
| `src/guards/permission_adapter.rs` | `PermissionProviderAdapter` — permission enforcement integration |

## Step Kinds

The orchestration layer is graph-native. Topology lives in `StepEdge`; node behavior lives in `Step.kind`:

| Step Kind | Role | Config | Execution |
|-----------|------|--------|-----------|
| **`read`** | Direct stone read | `{ from, fallback_output? }` | Reads direct state through the workflow slot boundary; raw bytes return as one metadata shape `{ kind: "bytes", ref, size }` and byte/text/base64 views resolve through that reference. `fallback_output` is a data-declared BindingAST-resolved value returned only when the direct read fails, allowing optional maintained-surface checks without package-specific workflow code |
| **`write`** | Direct stone write emission | `{ items }` | Returns writes to the stone via `QueryResult.writes` |
| **`ask`** | Ask outside code to do work | `{ name, input, context?, output? }` | Sends opaque input bytes and optional opaque caller-context bytes through the workflow slot boundary. `output.decode = "artifact"` requests immutable reply delivery and records only `{ kind: "immutable_content", content_hash }`; normal JSON and byte decoders preserve their existing explicit behavior. Process inputs resolve artifact identities as `BlobRef` mounts, so workflow does not encode artifact bodies into another request. |
| **`action`** | Execute a nested `Definition` by ID | `{ definition_id, input?, output_name? }` | Loads referenced definition and executes its steps |
| **`loop`** | Iterate over a collection | `{ source, item_var, max_iterations, definition_id }` | Re-executes a nested definition per iteration |
| **`wait`** | Temporal pause | `{ wait_condition }` | Suspends until condition is satisfied |

An `ask` answered `{"$kind": "not-answered-yet"}` (`NOT_ANSWERED_YET`) waits: the step is recorded `paused` with that reply as its output, nothing after it runs, independent branches still do, and the run ends `paused`. A host that keeps the answers it gave runs the same definition again to go on from there (the host's own runner). `{"$kind": "binding", "values": [path], "take": "all"?}` reads every value at a path, `"*"` stepping into lists.

`ask.input` resolves workflow binding ASTs before dispatch, but target-owned JSON
subtrees can be passed through unchanged in two ways.

`ask.context` uses the same binding/opaque-copy rules as `ask.input`, but it is
carried as caller context on the outgoing Envelope instead of being merged into
the target payload. Workflow does not interpret the context schema; the receiver
decides whether those bytes grant anything.

Use `opaque-json` when the literal workflow definition already contains the
target-owned subtree:

```json
{
  "$kind": "opaque-json",
  "value": { "any": "target-owned JSON, including its own $kind fields" }
}
```

Use `resolve_nested_bindings: false` when workflow must first select a value
from input or a prior step and then copy that selected value as target-owned
JSON:

```json
{
  "$kind": "binding",
  "select": {"from": "steps", "key": "producer", "path": "output.items"},
  "resolve_nested_bindings": false
}
```

Both forms preserve the same boundary: when the downstream target owns a JSON
grammar that also uses `$kind`, workflow resolves the requested boundary value
but does not open the target's internal vocabulary. The default remains
`resolve_nested_bindings: true`, so bindings-that-return-bindings still flatten
unless the workflow definition explicitly asks for opaque copy semantics.

Structural transforms exposed through the same BindingResolver adapter include
`op:core.append` for array-plus-one composition. Byte materialization stays
generic through `op:core.stringify` plus `op:core.encode`.

## Execution Modes

The workflow engine supports **two independent execution modes**:

| Mode | Entry Point | Model | Use Case |
|------|-------------|-------|----------|
| **Automation** | `execute_workflow()` | Orchestrates a `Definition` with full control-flow (branches, loops, waits, parallel) | Long-running multi-step workflows triggered by events or schedules |
| **Interactive** | `execute_definition_interactive()` | Executes a `Definition` as a flat sequence of steps in interactive mode | UI actions, keyboard shortcuts, event-driven headless operations |

Both modes execute the same plain step kinds and share the same `ExecutionContext` and binding resolution systems.

Owner-slot readiness uses the same cache as execution. The workflow slot records
the live payload hash for each hydrated definition address, then answers the
generic `owner_slot_hydration_status` query with exact address/hash evidence.
Runtime Kit can therefore block ready before a user action when a declared
workflow definition was not delivered to the owner slot.

`execute_definition` response shaping:
- `include_steps = true` (default) keeps the full per-step output map for interactive callers
- `include_steps = false` omits the full per-step output map for orchestration callers
- `include_output = false` omits the final `output` payload too, which is the correct replay/orchestration shape when the caller only needs completion status plus stone writes
- `decode_execute_definition_field_tuple` accepts the workflow-owned fast byte
  form for no-reply execute-definition calls. Runtime Kit may generate those
  bytes from package declarations, but workflow-core owns the reader and maps
  them back to the same `ExecuteDefinitionRequest` semantics.
- `receipt` on `ExecuteDefinitionRequest` is an optional caller-declared target
  for a generic workflow execution receipt. It records only workflow execution
  facts plus caller-supplied opaque evidence at the caller-selected address.
- `write` step payload shaping:
  - `payload` means structured JSON value and is encoded immediately when the step resolves
  - `payload_bytes` means the workflow already has canonical payload bytes and should pass them through directly
  - `payload_bytes.value_to_bytes` means the write declares a generic byte layout; workflow encodes bytes from resolved `rows` without domain vocabulary. `cell_table` writes canonical RTBL bytes with zeroed reserved header bytes, matching Runtime Kit readers and package descriptor projections. Column `match` predicates use generic comparison operators (`equals` or `in`) so one declaration can cover aliased source facts without product-specific code. `source.parse.after_parse_path` can extract scalar fields after parsing JSON text, so object-valued source facts can publish typed columns without package-side assembly. Text cells accept JSON scalar source values, `json` cells accept structured JSON values, and `json_text` cells accept already-serialized JSON text after validation when a producer has already selected the exact payload bytes to carry forward.

## Key Types

| Type | Signature / Shape | Role |
|------|---|---|
| **`Definition`** | `{ id, partition_key, kind, name, description, input_schema, steps, edges, trigger_type, trigger_source, is_active, version, extra, extra_properties }` | Unified executable entity for actions, workflows, pipelines, and future kinds |
| **`Step`** | `{ id, kind, config, join, join_config }` | Graph node — all kind-specific data is inside `config` |
| **`StepEdge`** | `{ from, to, kind, config }` | Pure topology between steps |
| **`WorkflowInstance`** | `{ id, status: Running\|Completed\|Failed, current_step, execution_context, started_at, completed_at }` | Execution state tracking for a workflow run |
| **`WaitCondition`** | `T1: Until { deadline }` \| `T2: Duration { millis }` \| `T3: Event { source, pattern }` \| `Race { conditions }` | Temporal primitive — 3 canonical variants (absolute, relative, event-driven) plus race combinator |
| **`WorkflowError`** | enum: `InvalidStep { step_id, reason, hint }` \| `InvalidDefinition { definition_id, reason, hint }` \| `PrimitiveDispatchFailed { reason, hint }` \| `WorkflowNotFound` \| `DefinitionNotFound` \| `StepNotFound` | Structured errors with machine-readable codes (`code()`) and remediation hints |
| **`execute_workflow`** | `async fn(store, action_store, workflow_id, trigger, actor) → Result<WorkflowInstance>` | Full workflow lifecycle: load, validate, execute steps, return instance |
| **`execute_wait_step`** | `async fn(wait_cond, execution_context) → Result<()>` | Dispatch on WaitCondition variants (T1/T2/T3 temporal primitives) |
| **`AsyncWorkflowExecutor<B>`** | Generic struct: `{ backend: B, registry, request_ctx, guards_factory, executed_count }` | Production executor carrying backend + context + optional guards factory |
| **`EnvelopeDispatchFn`** | `Fn(target_address, &PartitionKey, payload)` | Opaque cross-slot dispatch function that preserves the real Envelope routing partition |
| **`TemplateResolver`** | — | Resolves binding expressions against `ExecutionContext` |
| **`StepExecutor`** | — | Single-step lifecycle executor: resolve bindings, ask/read/write, capture output |
| **`record_step_output`** | `fn(context, step_id, output)` | Records a `StepOutput` into `ExecutionContext` for subsequent step access |

## Immutable Artifact Flow

Workflow's generic artifact path is identity-only. An ask with
`{"output":{"decode":"artifact"}}` asks the boundary adapter for immutable
reply delivery, stores the returned `content_hash` in its step output, and does
not retain raw response bytes. A later process binding that references that
step becomes `ProcessInputSource::BlobRef { hash }`.

Process result normalization preserves `content_hash` for declared
`immutable_content` outputs and leaves their `bytes` field empty. A missing or
malformed artifact identity, an immutable reply decode failure, or a CAS
publication failure returns a structured workflow error; workflow does not
inline a substitute body.
| **`DefinitionStore`** | trait: `fn get_by_id(&self, id, partition_key) -> Result<Option<Definition>>` | Unified trait for loading definitions from persistence |
| **`KernelBridge<B>`** | Generic struct carrying all `DispatchContext` dependencies | Fully-wired executor factory (production entry point) |
| **`KernelBridgeBuilder<B>`** | Builder pattern | Incremental `KernelBridge` configuration |
| **`create_bridge()`** | Factory function | Quick `KernelBridge` construction with required deps only |
| **`GuardsFactory`** | trait: `fn create_guards(&self, ...) → DataGuards` | Per-dispatch `DataGuards` construction (permission, constraint, audit) |
| **`RetryPolicy`** | `{ max_attempts, backoff_strategy }` | Configurable retry behavior (max_attempts, BackoffStrategy variant) |
| **`EventPoller`** | `{ store, config, pending_workflows }` | Event-driven workflow trigger mechanism |
## Dependencies

**Depends on:**
- `serde` / `serde_json` — Serialization of domain types and JSON parameters
- `thiserror` — Structured error definitions (WorkflowError)
- `async-trait` — Async trait definitions (AsyncWorkflowExecutor)
- `tokio` (native feature) — Async runtime for production execution
- `tracing` — Structured logging (never logs credentials or sensitive data)
- `futures` — Concurrent parallel loop/branch execution
- `uuid` — Unique transaction ID generation (journal_append primitive)
- `chrono` — RFC3339 timestamps for journal entries
- `governance` — ConstraintProviderAdapter for constraint validation
- `permissions` — PermissionProviderAdapter for permission enforcement (default-features disabled)
- `bitemporal` — Immutable journal backend for audit logging
- `transport` (native feature) — Transport policy for CallExternal URL validation
- `wasm-runtime` (native feature) — WASM execution for _execute primitive
- `embodiment-client` (native feature) — Job submission for _embodiment primitive
- `embodiment-protocol` (native feature) — ExecutionReceipt, ExecutionMode types
- `transport-config` (native feature) — TransportConfig, ConnectorRoute for connector resolution

**Depended on by:**
- `hosts/headless` — Executes workflows via Tauri commands
- `hosts/desktop` — Desktop shell action execution
- `runtime-loop` — Event-driven orchestration of workflow instances
- `composition-engine` / `composition-engine-wasm` — Action dispatch

## Depended On By

- `composition-engine` / `composition-engine-wasm` — action dispatch
- `hosts/desktop` — `DefinitionStore` implementation
