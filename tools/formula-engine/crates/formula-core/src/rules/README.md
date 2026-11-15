# Formula Engine Rules - ops-core Delegation Guide

This document explains how formula-engine rules delegate to ops-core for pure operation logic, and which rules require special handling.

## Architecture Principle

The formula-engine rules follow a **graph rewriting + delegation** pattern:

1. **Rules handle graph rewriting**: Extract values from the Manifold, write results back
2. **ops-core handles pure operations**: Mathematical, text, logical computations
3. **Rules keep context-dependent logic**: Anything requiring `SolverContext` or `EvaluationContext`

This separation allows ops-core to be reused by other engines (like composition-engine) while keeping formula-engine's graph rewriting logic isolated.

## Standard Delegation Pattern

```rust
use ops_core::{OpValue, OpError, EvalContext};

// Convert formula-engine Value to ops-core OpValue
fn to_op_value(val: &Value) -> OpValue {
    OpValue::from(val.inner().clone())
}

// Convert ops-core OpValue back to formula-engine Value
fn from_op_value(op_val: OpValue) -> Value {
    Value(op_val.into_inner())
}

// In the rule's rewrite() method:
let input = get_op_value(manifold, edge.input_nodes[0])?;
let result = ops_core::module::operation(&input, &default_ctx())
    .map_err(op_error_to_rule_error)?;
if let Some(output_node) = manifold.get_node_mut(edge.output_node) {
    *output_node = Node::Resolved(from_op_value(result));
}
```

## Delegation Status by File

### Fully Delegated to ops-core

| File | Rules | Notes |
|------|-------|-------|
| `logical.rs` | AndRule, OrRule, NotRule, IfRule, etc. | All logical operations |
| `math.rs` | AddRule, SubRule, MulRule, SinRule, etc. | 33 math rules, uses `strict_ctx()` for Decimal precision |
| `text.rs` | ConcatRule, UpperRule, TrimRule, etc. | All text operations |
| `array.rs` | SumRule, AverageRule, FilterRule, etc. | All array operations |
| `conversion.rs` | ValueRule, TextRule, IsNumberRule, etc. | Type conversion operations |
| `graph.rs` | ParentsRule, ChildrenRule, etc. | Delegates for validation; ops-core has stubs |

### Partially Delegated

| File | Delegated | Not Delegated | Reason |
|------|-----------|---------------|--------|
| `datetime.rs` | 18+ rules (DateRule, TimeRule, etc.) | `NowRule`, `UserTzRule` | Require `EvaluationContext` for deterministic NOW() and user timezone |
| `crypto.rs` | `HashRule` (SHA256), `HmacRule` (SHA256) | SHA512, SHA3_256, BLAKE3, HMAC-SHA512, HMAC-SHA3_256 | ops-core only implements SHA256; formula-engine needs additional algorithms |

### Cannot Delegate (Context-Dependent)

| File | Rules | Reason |
|------|-------|--------|
| `security.rs` | `CanRule`, `CurrentUserRule`, `GetEntityRule`, `HasRoleRule`, `EmitEventRule` | Require real `SolverContext` for permission checks via `has_permission()` and `get_actor_id()`. ops-core only has stubs that return false/placeholders. |

## Why Some Rules Cannot Delegate

### 1. Context-Dependent Rules (security.rs, datetime.rs partial)

These rules need access to the `EvaluationContext` which contains:
- `actor_id` - The current user executing the formula
- `actor_permissions` - Permission strings for the user
- `now_timestamp` - Frozen timestamp for deterministic NOW()
- `user_timezone` - User's configured timezone

The ops-core stubs cannot provide these values. They must come from the caller's evaluation context.

**Example - CurrentUserRule**:
```rust
// CANNOT delegate - needs real context
let actor_id = ctx.evaluation_context.get_actor_id();
let result = make_entity_ref(&actor_id);
```

### 2. Extended Algorithm Support (crypto.rs)

The formula-engine spec requires more cryptographic algorithms than ops-core provides:

| Algorithm | ops-core | formula-engine |
|-----------|----------|----------------|
| SHA256 | ✅ | ✅ (delegated) |
| SHA512 | ❌ | ✅ (local) |
| SHA3_256 | ❌ | ✅ (local) |
| BLAKE3 | ❌ | ✅ (local) |
| HMAC-SHA256 | ✅ | ✅ (delegated) |
| HMAC-SHA512 | ❌ | ✅ (local) |
| HMAC-SHA3_256 | ❌ | ✅ (local) |

The crypto rules check the algorithm and delegate to ops-core when possible, falling back to local implementations for extended algorithms.

### 3. Stub Implementations (graph.rs)

Graph traversal rules (PARENTS, CHILDREN, NEIGHBORS, TRAVERSE) are stubs in both formula-engine and ops-core. The actual graph traversal is performed by caller-provided data access. The rules delegate to ops-core for:
- Input type validation (EntityReference or string ID)
- Returning empty arrays as stub results

A caller can inject real graph data through the `SolverContext` without formula-core knowing which storage system produced it.

## Adding New Rules

When adding a new rule:

1. **Check if ops-core has the operation** - Look in `crates/ops-core/src/`
2. **If yes**: Delegate using the standard pattern above
3. **If no, and it's a pure function**: Consider adding to ops-core first, then delegate
4. **If it needs context**: Keep the implementation in the rule, document why

## FloatMode Note

ops-core supports two float modes:
- `FloatMode::Strict` - Uses `Decimal` for precise arithmetic (financial calculations)
- `FloatMode::Fast` - Uses `f64` for scientific functions (sin, cos, exp, log)

Most formula-engine math rules use `strict_ctx()` for Decimal precision. Scientific functions like SIN, COS, EXP, LOG use `fast_ctx()` because Decimal doesn't support these operations.
