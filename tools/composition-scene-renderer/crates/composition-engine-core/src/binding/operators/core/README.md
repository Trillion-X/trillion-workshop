# binding/operators/core/

Flat registration list of 142 core binding operators — adapts `ops-core` functions to the composition-engine `Operator` trait with zero duplicated logic.

## Files

| File | Purpose |
|------|---------|
| `mod.rs` | Operator registration: `register_core_operators()`, `create_core_registry()`, helper functions (`get_arg`, `get_arg_str`, `get_values_array`), 142 `FnOperator` registrations across math/logical/text/array/crypto/datetime categories, and conformance tests |
| `map_to_nodes.rs` | `op:core.map_to_nodes` — template instantiation for repeater patterns; the one composition implementation-specific operator that requires evaluator access (no ops-core equivalent) |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `register_core_operators` | `fn(registry: &mut OperatorRegistry) -> Result<(), RegistryError>` | Registers all 142 operators into a mutable registry |
| `create_core_registry` | `fn() -> Result<OperatorRegistry, RegistryError>` | Creates a new registry with all core operators pre-registered |
| `CORE_OPERATORS_VERSION` | `u32 = 3` | Semantic version for the composed operator surface |
| `op_map_to_nodes` | `fn(input, args, ctx) -> OperatorResult` | Template instantiation with eager evaluation via resolver callback |

## Operator Categories

| Category | Count | Examples |
|----------|-------|---------|
| Math | ~20 | `op:core.add`, `op:core.sub`, `op:core.mul`, `op:core.div`, `op:core.math_d_round` |
| Logical | ~15 | `op:core.eq`, `op:core.not`, `op:core.if`, `op:core.equals`, `op:core.is_null` |
| Text | ~25 | `op:core.upper`, `op:core.format`, `op:core.len`, `op:core.starts_with` |
| Array | ~15 | `op:core.array_length`, `op:core.array_first`, `op:core.array_last`, `op:core.map_to_nodes` |
| Comparison | ~10 | `op:core.gt`, `op:core.lt`, `op:core.gte`, `op:core.lte`, `op:core.between` |
| Crypto | ~10 | `op:core.crypto_sha256`, `op:core.crypto_hmac`, `op:core.text_base64_encode` |
| Datetime | ~20 | `op:core.datetime_now`, `op:core.datetime_add`, `op:core.datetime_diff` |
| Type/Identity | ~10 | `op:core.identity`, `op:core.typeof`, `op:core.coalesce`, `op:core.default` |

## Architecture

```
ops-core (crate)              composition-engine/binding/operators/core/
┌─────────────────────┐       ┌──────────────────────────────────────────┐
│ Pure operator logic  │       │ Adaptation layer (zero logic)            │
│ text::format()       │◄──────│ FnOperator("text_format", |i,a,_| {    │
│ math::add()          │       │     text::format(i, get_values(a))      │
│ array::length()      │       │ })                                      │
└─────────────────────┘       └──────────────────────────────────────────┘
                                         │
                                         ▼ create_core_registry()
                              ┌──────────────────────────────────────────┐
                              │ OperatorRegistry (142 operators)          │
                              │ Used by: Projector, Kernel compute.rs    │
                              └──────────────────────────────────────────┘
```

## Non-Negotiable Invariants

1. **No operator logic in this module** — only registration. All semantics live in `ops-core`.
2. **One type system** — `OpValue` throughout the `Operator` trait boundary.
3. **`ops-core` is canonical** — if the operator exists in ops-core, this module delegates to it.
4. **`map_to_nodes` is the sole exception** — it requires composition-engine's evaluator for eager evaluation and has no ops-core equivalent.

## op:core.format Modes

This operator has three modes, checked in priority order:

| Mode | Trigger | Example Args | Input | Output |
|------|---------|-------------|-------|--------|
| prefix/suffix | `"prefix"` and/or `"suffix"` key | `{"prefix": "label:"}` | `"template:text"` | `"label:template:text"` |
| positional | `"values"` array | `{"values": ["world"]}` | `"Hello, {0}!"` | `"Hello, world!"` |
| identity | no recognized args | `None` | `"unchanged"` | `"unchanged"` |

Used by migrations 024, 036, 044 for generating unique child IDs in itemTemplate expansions.

## Membership Operators

- `op:core.array_contains` checks whether the selected input array contains `args.value`.

## Dependencies

**Depends on:** `ops-core` (operator logic), `super::registry` (`FnOperator`, `OperatorRegistry`, `OperatorContext`), `crate::binding::ast` (diagnostics)

**Depended on by:** `crate::binding::operators::mod` re-exports `create_core_registry`, `register_core_operators`; consumed by `projector::transform` and `kernel::compute` via `create_core_registry()`
