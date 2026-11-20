# executor/

**The orchestration and execution engine for the Workflow Engine.** Contains the automation mode orchestrator (`execute_workflow`), interactive mode executor (`execute_definition_interactive`), graph step handlers, and the workflow boundary adapter for plain `ask/read/write` execution.

## Files

| File | Purpose |
|------|---------|
| `mod.rs` | AsyncWorkflowExecutor |
| `automation.rs` | Automation mode: DefinitionStore trait, execute_workflow orchestration, built-in step handlers (`read`, `write`, `ask`, `return`, `fail`, `action`, `run-owner-requested-definition`, `loop`, `wait`); a step waiting for its answer (`WorkflowError::Waiting`) opens none of its children and ends the run `paused` while independent branches still run, and a failed step keeps `WorkflowError::evidence()` as its output; RetryPolicy, skip-propagation state grouping for branch-aware merge execution, and nested action/loop delta propagation so inner `write` steps return through the same `StepHandlerResult.writes` path as top-level writes; nested action final output is collected by the canonical compiled step ID, not by authoring-time blank IDs |
| `context.rs` | OutsideAccess trait, ExecutorDeps, BindingResolver for direct binding resolution; context paths are selected field-by-field so `context.partition_key` does not serialize the whole execution context; `ask_with_pending_writes` lets a boundary adapter expose transaction-local writes to owners that understand that context without workflow-core knowing target-specific query schemas; target-owned rows selected from retained step JSON bytes become byte-backed row sources for declared byte writers; transform dispatch includes ops-core `append`, `stringify`, `encode`, and `decode` for explicit structural and byte encoding transforms; a scope's member set is CLOSED by the struct behind it, so an unknown member of `start`, `context`, `context.actor`, `context.platform`, `loop`, or `steps` returns a structured `TemplateResolutionFailed` naming the valid members, matching the unknown-SCOPE error one level up |
| `interactive.rs` | Interactive execution mode: `execute_definition_interactive()` loads a definition, validates input, executes all steps, and projects query results by moving owned execution fields instead of deep-clearing completed contexts before a WASM reply is serialized; nested action writes are preserved in `InteractiveExecutionResult.writes`; input validation supports both legacy map schemas whose keys are required fields and JSON-schema-style objects whose `required` array is authoritative while `properties` remains metadata |
| `polling.rs` | Event polling: TriggerEvent, EventStore/EventPoller, PollConfig |
| `value_to_bytes.rs` | Private generic writer for `payload_bytes.value_to_bytes`; converts resolved rows/groups/columns into canonical byte layouts such as RTBL `cell_table` |
| `step_executor.rs` | StepExecutor: resolves step config, asks outside work, reads direct state, snapshots accumulated pending writes for outside-work dispatch, decodes arbitrary outside-work bytes through an explicit UTF-8 gate before JSON parsing, retains JSON response bytes for downstream streaming, preserves compute-process output metadata including exact Envelope rewrite metadata, defaults declared byte-writer row bindings to target-owned data, and accumulates writes without stamping the caller partition unless the declaration explicitly supplies a `partition_key` |

## Key Types

## Nested Action Invariant

Nested `action` and `loop` execution returns inner `write` deltas through the same `StepHandlerResult.writes` path as top-level write steps. Forked action/loop contexts inherit existing pending writes for transaction-local read visibility, but the returned delta contains only writes produced inside the fork. Nested action final output is read by canonical compiled step ID (`step_0` for blank authored IDs), so generated IDs and explicit IDs use one output path.

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `AsyncWorkflowExecutor` | `new() / with_context(ctx) / with_guards_factory() / with_circuit_state()` | Production executor carrying the workflow boundary adapter |
| `ExecutorDeps` | `struct: outside_access, partition_key, circuit_state, registries, definition_store, product_word_ids` (the host's word `AsyncWorkflowExecutor::new` takes; `compute.process` replies decode under it) | Slim dependency bag for step/definition execution |
| `OutsideAccess` | `trait: ask(name, partition_key, payload, context) / ask_with_pending_writes(name, partition_key, payload, context, pending_writes) / read(from, partition_key)` | Workflow-owned boundary for work and state outside the core engine. `context` is opaque caller-context bytes and is never interpreted by workflow-core. The default pending-write method delegates to `ask`; slot wrappers opt in only for owners that expose transaction-local visibility through their own context schema. |
| `BindingResolver` | `resolve_value(value, ctx) -> Result<Value, WorkflowError>` | Resolves `$kind: binding` nodes: the run's scopes are selected here, and every `transform` step is evaluated by the shared evaluator (tools/shared-code/crates/composition-ast `create_core_registry`) the formula and trigger engines also use. No operator name appears in this crate. |
| `StepExecutor` | `execute_step(step, id, ctx, deps, actor, timeout) -> Result<StepOutput, WorkflowError>` | Full single-step lifecycle: resolve bindings, ask/read/write, capture output; direct `read` supports data-declared `fallback_output` so optional reads can remain generic and package-agnostic. That fallback answers both ways a read can come back with nothing: an address that failed at the store, and an address that resolved to nothing because the binding pointed at an absent field. With no fallback declared, an empty address fails with a message naming the field that was empty, and a value that is neither a string nor empty fails as a malformed definition regardless of any fallback. Ask steps pass a snapshot of already-accumulated pending writes to the boundary adapter, preserving atomic final write admission while allowing target-owned read-your-own-writes overlays. Write steps leave `PendingWrite.partition_key` unset by default so the slot wrapper inherits the already-selected Envelope partition exactly once; only an explicit write declaration may override the destination partition. |
| `payload_bytes.value_to_bytes` | `{"value_to_bytes":"cell_table","rows":[...] \| {"format":"json","source":{"kind":"bytes","ref":"step_id"},"path":[...]},"group_by"?:{"path":[...]},"columns":[{"value":{"value_to_bytes":"text"}}]}` | Data-declared write-byte layout. Workflow owns only generic row/group/column byte production; `cell_table` emits canonical RTBL bytes with zeroed reserved header bytes; column `match` predicates support exact `equals` and membership `in` comparisons through type-tagged canonical predicate keys allocated from the declaration, not repeated JSON equality over untyped values or row-key allocation in the WASM hot path; `source.parse.after_parse_path` can extract scalar fields from JSON text or already-typed JSON values; text cells accept JSON scalars, `json` cells accept structured JSON values, and `json_text` cells accept already-serialized JSON text after validation so workflow can write bytes without rebuilding an upstream payload tree; text and `json_text` cells are visited as borrowed bytes and copied directly into the final RTBL buffer rather than cloned into intermediate strings/vectors; a binding under a declared byte-writer `rows` field defaults to target-owned row data, so retained `steps.<id>.output.<path>` bytes can be streamed directly, including grouped row writes. Byte-backed row streaming projects only roots named by `group_by`, column sources, and column predicates; those root strings are resolved once into numeric selectors before row replay, and ignored row subtrees are skipped by the deserializer and never become workflow row state. |
| `cell_table.group_by` keying | Owned typed scalar keys plus canonical compound keys over JSON values | Grouping keeps null/bool/string keys typed, numbers allocate only their normalized textual key, and arrays/objects use the canonical structural writer with object fields sorted. Package data can group rows deterministically without product-specific key rules, per-row scalar JSON stringification, borrowed row-key lifetimes, repeated hot-path path string scans, row-object materialization for undeclared fields, or tree-search mutation in the streamed WASM hot path. Grouped decoded rows and grouped byte-backed rows use a key-to-index map plus a final sorted group order, are measured first, and are then written directly into the final RTBL byte buffer, so workflow does not retain one heap allocation per non-empty grouped cell or materialize retained response bytes as a decoded row array. |
| `ask` output decoding | `{"output":{"decode":"json"}}`, `{"output":{"decode":"bytes"}}`, or `{"output":{"decode":"artifact"}}` | Outside work returns opaque bytes. JSON decode validates UTF-8 before parsing and still retains the original response bytes by step id for downstream declared writers. Byte decode records only a `{kind:"bytes",ref,size}` output plus raw bytes. Artifact decode requests immutable reply delivery and records only `{kind:"immutable_content",content_hash}`; it retains no body. A later process `step_bytes` source resolves an artifact directly as `BlobRef { hash }`, or publishes intentionally-inline retained bytes once through the existing immutable-content owner. Malformed replies, bad references, and publication failures become structured `WorkflowError` values instead of component-model WASM traps. |

## Immutable Artifact Invariant

The executor never re-serializes an artifact body into a process descriptor.
`ProcessOutputStorage::ImmutableContent` is normalized as metadata with its
`content_hash` preserved and `bytes = null`; process consumers mount that hash
through the existing `BlobRef` input source. Artifact identity resolution must
fail closed when the referenced step has neither a valid immutable identity nor
intentionally retained raw bytes.
| `return` step | `{"kind":"return","config":{"value": ...}}` | Pure workflow projection: resolves `config.value` through BindingAST and returns that JSON value without I/O, so workflows can materialize byte refs before crossing the reply boundary |
| `WAIT_ASK` | `const &str = "wait"` (automation.rs) | A wait the build cannot hold itself (any event; on a build without timers, any time not yet passed) is asked of outside work under this name with `{ "wait": <condition> }` and context `{ "step_id" }`: an answer ends it, `not-answered-yet` pauses the run there, so no later step runs early |
| `NOT_ANSWERED_YET` | `const &str = "not-answered-yet"` (context.rs) | An ask reply `{"$kind": "not-answered-yet", ...}` means the answer is not there yet: the step fails with `WorkflowError::Waiting` (the reply kept as its output, status `paused`) and the run ends `paused`; a host that keeps its earlier answers runs the definition again to go on |
| Holding an answer to rules | a `return` step whose value is the rules as bindings, an `on_result` edge on its output to a `fail` step, and one onwards | The engine has no check kind: a rule is a binding over the run, judged by the shared evaluator (tools/workflows/read-data/check-bindings.mjs makes them from a recipe step's `checks`) |
| `values` binding | `{"$kind":"binding","values":["steps","draft","items","*","id"],"take":"all"}` | Every value at a path from `input` or `steps` (`"*"` steps into lists); `take: "all"` gives the list, otherwise the first value or null |
| `record_step_output` | `fn(ctx, step_id, output)` | Records a StepOutput into ExecutionContext for subsequent step access |
| `RetryPolicy` | `struct: max_attempts, base_delay_ms, backoff` | Configurable retry behavior for workflow execution |
| `EventPoller` | `new(executor) / poll_once() / start_polling()` | Event polling engine that watches the EventStore |
| `PollConfig` | `struct: poll_interval_ms, batch_size, partition_id, retry_policy` | Configurable polling parameters |

## WASM Compatibility

Files in this module use `#[cfg(feature = "native")]` to gate tokio timer operations:

| File | Native-only Code | WASM Behavior |
|------|------------------|---------------|
| `automation.rs` | `tokio::time::sleep` in retry/Wait; `futures::try_join_all` in Parallel branches and parallel Loop iterations | Delays skipped; parallel branches and loop iterations run sequentially |
| `polling.rs` | `tokio::time::sleep` in poll loop | Sleep skipped |
| `step_executor.rs` | `tokio::time::timeout` wrapping dispatch | Dispatch runs without timeout |

On WASM builds, async timeout sleeping is skipped and dispatch runs directly. Step/run duration measurement still uses `web_time::Instant`, the existing cross-platform monotonic clock, so workflow timing remains available without calling `std::time::Instant` in component-model WASM.

## Closed-Scope Invariant

A binding names a SCOPE and then a MEMBER of it, and both sets are closed by the engine:
scopes by the match in `resolve_select_binding`, members by the Rust struct behind each scope.
An unknown name in either position is a defect in the binding, never an absent value, and both
now return `TemplateResolutionFailed`.

`select_json_path` is deliberately exempt and must stay exempt. It walks user-authored data,
where the set of paths is OPEN and absence is an ordinary answer. Making it strict would be the
same mistake mirrored.

`loop` is included despite its member set being unknowable when the DATA is authored, because
`loop_state.item_var` names the item and IS known at resolution. A set that is open at authoring
time can still be closed at resolution time, and resolution is where the check belongs.

Returning `Value::Null` for an unknown member is what previously let `{"from":"context","path":"now"}`
resolve to nothing across five packages with no error raised anywhere: `Value::Null` was carrying
"this member does not exist" and "this value is legitimately absent" at once.

## Edge Condition Scope

`domain::handlers::evaluate_step_output_condition` builds a FRESH `ExecutionContext` whose
`start.input` is the source step's `StepOutput` and whose every other field is `Default`. So an
edge condition reads only `input.output`, `input.status`, `input.error`, `input.duration_ms`;
`steps`, `context`, `start.started_at` and `loop` are all empty inside a condition.

An edge therefore cannot compare a caller-supplied value against a value a step fetched, which is
the natural shape of an admission decision. Such decisions need a COMBINING STEP whose single
output carries the verdict; step configs keep the full binding scope, and only the edge is
restricted.

Declaring any edge also disables the implicit sequence for the WHOLE definition
(`compile_definition`: `use_implicit_sequence = edges.is_empty()`). There is no partial mode, so
adding one branch to a definition with no edges requires declaring the complete edge set.

## Definition Compilation

Definition compilation resolves extra-property placeholders with a structural JSON
walk. It never stringifies a step config, performs text substitution over the
serialized document, then reparses JSON. That keeps the hot compilation path
bounded by the existing Value tree and avoids parse/stringify traps in WASM.

## Dependencies

**Depends on:** `domain::types` (ExecutionContext, StepOutput, DefinitionOutput, Step, StartData, WorkflowInstance), `domain::errors` (WorkflowError), `guards` (GuardsFactory), `loader` (DefinitionStore, load_definition_by_id), `slot-protocol` (ActorContext), `trigger-ast` (DefinitionDispatch), `tokio` (timeout — **native only**), `futures` (try_join_all for concurrent parallel branches — **native only**), `serde_json`

**Depended on by:** `workflow-core/src/lib.rs` re-exports all public types; `crates/workflow` uses this library underneath the slot boundary.
