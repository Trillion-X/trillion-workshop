# blueprint/

Untrusted authoring layer that validates, normalizes, and resolves author-time BlueprintNodes into kernel-ready SceneNodes via a three-stage pipeline.

## Files

| File | Purpose |
|------|---------|
| `mod.rs` | Module declarations and public re-exports for all blueprint types and functions |
| `types.rs` | Blueprint types: `BlueprintNode`, `BlueprintScene`, `BlueprintStyle`, `BlueprintLayout`, `BlueprintAxis`, `BlueprintKind`, `StyleValue` (Token/Literal/Binding variants), `BlueprintProps`, `BlueprintA11y`, `BlueprintHandlers` |
| `guards.rs` | Validation: `validate_scene`, `validate_node`, `is_blueprint_node`, `is_blueprint_scene`. Produces structured `Diagnostic` errors with path and message |
| `normalize.rs` | Blueprint-to-SceneInit conversion: `normalize_scene`, `normalize_node_to_scene`, `normalize_from_json`, `normalize_from_value`. Strips authoring-only fields, converts to kernel-ready `SceneInit`, and preserves opaque component thing-to-put-on-screen metadata from `props.extra` |
| `resolver.rs` | Token resolution and style resolution: `resolve_tree`, `resolve_style`, `resolve_tree_with_tokens`, `resolve_tree_no_tokens`. Resolves `StyleValue::Token` refs to concrete `Magnitude` values via `TokenResolver` trait. Converts `BlueprintNode` tree to `SceneNode` tree while preserving opaque component thing-to-put-on-screen metadata. Children collected as `Vec<Arc<SceneNode>>` with `Arc::new()` wrapping (Task 168 P1) |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `BlueprintNode` | `{ id, kind, props, style, layout, children, ... }` | Author-time node (untrusted input) |
| `BlueprintScene` | `{ viewport, root }` | Top-level scene container with viewport |
| `BlueprintStyle` | `{ width, height, gap, padding, ... }` with `StyleValue` fields | Author-time style (may contain tokens/bindings) |
| `StyleValue` | `Token(TokenRef) / Literal(StyleLiteral) / Binding(BindingRef)` | Enum for unresolved style values |
| `Magnitude` | `Px(f64) / Percent(f64) / Auto / None` | Resolved style magnitude |
| `TokenResolver` | `trait: resolve(&self, path: &str) -> ResolveResult` | Token resolution interface |
| `HashMapResolver` | `new(tokens: TokenSet) / resolve(path) -> ResolveResult` | HashMap-backed token resolver |
| `resolve_tree` | `fn(node: &BlueprintNode, resolver: &dyn TokenResolver) -> SceneNode` | Full tree resolution: BlueprintNode -> SceneNode |
| `resolve_style` | `fn(style: &BlueprintStyle, resolver: &dyn TokenResolver) -> ResolvedStyle` | Style resolution: tokens -> magnitudes |
| `validate_scene` | `fn(scene: &BlueprintScene) -> ValidationResult` | Scene validation with structured diagnostics |
| `normalize_scene` | `fn(scene: &BlueprintScene) -> NormalizeResult<SceneInit>` | Blueprint -> SceneInit conversion |
| `Diagnostic` | `{ path, message, severity }` | Structured validation error |
| `ValidationError` | `{ diagnostics: Vec<Diagnostic> }` | Collection of validation errors |
| `NormalizeError` | `{ message, context }` | Normalization failure |

## Dependencies

**Depends on:** `super::kernel::types` (`SceneNode`, `NodeKind`, `NodeProps`, `ResolvedStyle`, `LayoutConfig`, `SceneInit`), `serde`, `serde_json`

**Depended on by:** `composition-engine-core::lib.rs`; the `composition-engine` slot wrapper re-exports this module for Rust compatibility.

## Architecture

```text
BlueprintNode (untrusted)
    | guards.validate()
    v
BlueprintNode (validated)
    | normalize.normalize_scene()
    v
SceneInit (normalized)
    | resolver.resolve_tree()
    v
SceneNode (resolved, kernel-ready)
```
