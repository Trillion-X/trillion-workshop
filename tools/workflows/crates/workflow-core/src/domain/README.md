# crates/workflow-core/src/domain

Canonical domain types and errors for the workflow engine.

## Purpose

Defines the Rust structs that mirror executable definitions, execution state, and graph topology. These are the single source of truth for workflow concepts in code (Physics layer).

## Unified Executable Model

The core executable model is collapsed to one generic `Definition` plus graph-native `Step` and `StepEdge` types:

1. **`Definition`** — unified executable entity. `kind` is opaque Society data (`action`, `workflow`, `pipeline`, etc.).
2. **`Step`** — a graph node. `kind` identifies the registered step handler. `config` holds opaque JSON for that kind.
3. **`StepEdge`** — pure topology between nodes. Branching and orchestration are graph properties, not separate step structs.

## Files

| File | Purpose |
|------|---------|
| `mod.rs` | Module declarations, re-exports |
| `types.rs` | All domain structs: `Definition`, `Step`, `StepEdge`, `WorkflowInstance`, `ExecutionContext`, `StepOutput`, `DefinitionOutput`, request/response types |
| `errors.rs` | `WorkflowError` enum — 30 structured variants (incl. `Waiting` and `CheckFailed`, whose `evidence()` a waiting or failed step keeps as data) with named fields (`reason`, `hint`, domain IDs), `code()` for SCREAMING_SNAKE_CASE error codes, `is_recoverable()` for graceful degradation, `reason()`/`hint()` accessors, serde tagged serialization |

## Key Types in `errors.rs`

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `WorkflowError` | `enum` (30 variants, `#[serde(tag = "code")]`) | Structured error enum — zero opaque `(String)` variants, all use named fields |
| `WorkflowError::evidence()` | `fn(&self) -> serde_json::Value` | What a failed or waiting step keeps as its output: `{problems}` for `CheckFailed`, the host's reply for `Waiting`, `{dispatch_failed: {dispatch, reason}}` for `PrimitiveDispatchFailed` (the answerer could not be reached; nothing about the step was decided), null otherwise |
| `WorkflowError::code()` | `fn(&self) -> &'static str` | Unique SCREAMING_SNAKE_CASE error code per variant (e.g., `"READ_ERROR"`, `"WORKFLOW_NOT_FOUND"`) |
| `WorkflowError::is_recoverable()` | `fn(&self) -> bool` | `true` for `Timeout`, `ExternalCallFailed`, `TemplateResolutionFailed` — caller can retry or use defaults |
| `WorkflowError::reason()` | `fn(&self) -> &str` | Extract human-readable reason from any variant |
| `WorkflowError::hint()` | `fn(&self) -> &str` | Extract actionable remediation advice from any variant |
| `WorkflowResult<T>` | `type = Result<T, WorkflowError>` | Alias for workflow results |

## Key Types in `types.rs`

| Type | Purpose |
|------|---------|
| `Definition` | Unified executable entity — `kind`, `steps`, `edges`, trigger config, and metadata |
| `Step` | Graph node — `kind`, opaque `config`, join strategy, join config; ask steps may expose optional opaque caller context through `config.context` |
| `StepEdge` | Graph topology — `from`, `to`, `kind`, and opaque edge config |
| `LoopConfig` | Loop step configuration — `source`, `item_var`, `max_iterations: Option<i32>`, `parallel: bool` (default false, `#[serde(default)]`) |
| ~~`KernelPrimitive`~~ | **DELETED in E.17** — primitive names are now opaque strings; the engine does not enumerate what primitives exist |
| `StepOutput` | Result of a single step execution — `primitive`, `status`, `output: Value`, `duration_ms` |
| `DefinitionOutput` | Combined result of all executed steps — `definition_id`, `status`, `steps: HashMap<String, StepOutput>`, `final_output`; query callers may request an empty `steps` projection without mutating or deep-clearing the completed `ExecutionContext` |
| `ExecutionContext.writes` | Transaction-local pending writes accumulated during execution. Forked action/loop contexts keep inherited writes visible for read-your-own-writes behavior, while `write_delta_start` ensures the fork emits only writes produced inside that scope. |
| `ExecutionContext.raw_step_bytes` | Side-channel keyed by step id for retained response bytes; bindings can materialize explicit byte refs, while declared byte writers can stream selected JSON paths without cloning decoded `StepOutput.output` trees |
| `ExecutionContext.step_output` | Scope-aware step-output lookup used to resolve an immutable artifact identity before any raw-byte fallback is considered |

Artifact step outputs are normal structured `StepOutput.output` values:
`{ kind: "immutable_content", content_hash }`. They are not entered into
`raw_step_bytes`; only deliberately inline result paths retain those bytes.
| `PlatformInfo` | Compile-time target report for workflow context. It uses Rust's platform constants when populated and falls back to Rust cfg facts for targets like `wasm32-wasip2` where `std::env::consts::OS` can be empty. |

## Dependencies

**Depends on:** `serde`, `serde_json`, `thiserror`, `slot-protocol`

**Depended on by:** `crates/workflow-core/src/lib.rs` re-exports all domain types; `crates/workflow/src/lib.rs` re-exports the public compatibility surface for slot callers.
