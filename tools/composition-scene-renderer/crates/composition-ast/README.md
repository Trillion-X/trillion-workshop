# composition-ast/

Pure Binding AST and validation vocabulary shared by slots and pure compute crates.

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Crate manifest for framework-agnostic binding AST types |
| `src/binding/ast.rs` | Binding structs, select sources, diagnostics, and serde boundary rules |
| `src/binding/validator.rs` | Shape/operator validation over raw JSON Binding AST values plus already-typed Binding AST values |
| `src/binding/evaluator.rs` | Pure binding evaluation against caller-provided context; `select_with_resolver` exposes the canonical selection step alone |
| `src/binding/prepared.rs` | `PreparedBinding`: validate, parse paths and resolve operators once, then evaluate one binding over many `OpValue` inputs with the same meaning as `evaluate_binding_with_resolver` |
| `src/binding/path.rs` | Path parsing, safe traversal (`get_at_path`) and `is_forbidden_key` |
| `src/binding/operators/` | Generic operator registry and pure operator adapters |
| `src/kernel/` | Kernel-facing AST projection types |

## Literal Null Contract

`{"select":{"from":"literal","value":null}}` is a valid explicit literal seed.
The serde boundary preserves that present-null value as `Some(Value::Null)` so
typed Binding AST round trips do not degrade it into a missing `value` field.

## Typed Evaluation Contract

`evaluate_binding*` receives a typed `Binding`, so it validates that typed AST
directly instead of serializing it back into JSON first. Raw JSON validation
still uses `validate_binding_shape`; hot typed evaluation uses
`validate_binding_ast_shape` to keep Binding execution portable across native
and component-model WASM without a per-evaluation JSON round-trip.

## Prepared Evaluation (one binding, many rows)

`PreparedBinding::prepare(&binding, &resolver)` does the per-binding work once
(shape validation, path parsing, operator lookup, argument conversion, nested
binding parsing). `evaluate(&OpValue, &ctx, &resolver)` then reads `self` paths
straight from the `OpValue` tree, so a large field is shared by reference
count, never copied. Every other select source is delegated to the canonical
selection code, and a context that preserves runtime bindings is evaluated by
`evaluate_binding_with_resolver`. The equivalence test in `prepared.rs` checks
value and diagnostics against the canonical evaluator for every select source
and failure path. The formula engine's row evaluator
(`packages/formula-engine/evaluate-over-rows`) uses it to filter tens of
thousands of rows per request.

The core operators share one `EvalContext` per float mode (`ctx_fast`,
`ctx_strict` in `operators/core/mod.rs`), built once per process; building one
per operator call cost more than the operators themselves.

## Component Thing To Put On Screen Metadata

`NodeProps.things_to_put_on_screen` is an ordered opaque array of exact-byte thing-to-put-on-screen
candidates for component nodes. The AST preserves those records without
interpreting capability strings, platform names, package names, or artifact
meaning. Shells select candidates by registered capability; the kernel
vocabulary only carries the data.

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `Binding` | `{ $kind, select?, transform?, default?, meta? }` | Declarative select-then-transform pipeline |
| `evaluate_binding_with_resolver` | `(&Binding, &Value, &BindingEvaluationContext, &OperatorResolver, Option<EvaluationOptions>) -> EvaluationResult` | Canonical single evaluation |
| `select_with_resolver` | `(Option<&BindingSelect>, &Value, &BindingEvaluationContext, &OperatorResolver) -> Value` | Canonical selection step alone |
| `PreparedBinding` | `prepare(&Binding, &OperatorResolver)`, `evaluate(&OpValue, &ctx, &resolver) -> PreparedResult` | One binding over many inputs |
| `create_core_registry` | `() -> Result<OperatorRegistry, RegistryError>` | Every core operator, delegating to ops-core |
| `is_forbidden_key` | `(&str) -> bool` | Keys no path may read |

## Dependencies

**Depends on:** `ops-core` (operator semantics, `OpValue`), `serde`, `serde_json`, `regex`, `lazy_static`, `rust_decimal`, `chrono`.

**Depended on by:** `formula-engine` (slot and `evaluate-over-rows`), `trigger-engine`, `composition-engine-core`, `projection-compiler`, and other slots that evaluate bindings.
