# Account Identity Read Data

Read helpers for role-addressed identity materialization.

| File | Purpose |
|---|---|
| `README.md` | Indexes the read-data folder. |
| `account-identity-materialization.ts` | Decodes a role-addressed materialization spec, executes generic source/rule/output mapping, and reads role values from materialized replies. |
| `account-identity-materialization.test.ts` | Proves arbitrary output roles, idempotence, reply decoding, and fixed-field rejection. |

| Type | Signature / Shape | Role |
|---|---|---|
| `RoleMaterializationSpec` | `{ kind, source_roles, rules, output_roles, projection? }` | Data-owned declaration for source roles, generic rules, and output roles. |
| `MaterializedRoleRow` | `{ role, label, value, copyable?, hidden? }` | One materialized output value addressed by role. |
| `RoleAddressedMaterializationResult` | `{ kind, revision_key, roles, records, projection }` | Owner-action result and projection payload shape. |
| `materializeRoleAddressedRecords` | `(spec, input) => RoleAddressedMaterializationResult` | Runs generic role materialization without branching on package role names. |
| `readMaterializedRoleValue` | `(result, role) => string` | Reads a required role value from result bytes or objects. |

**Depends on:** Web-standard `TextEncoder` and `makeHashCodeHexFromBytes` from `@bitfield/runtime-kit/protocol`, backed by the shared Rust multihash owner.

**Depended on by:** `packages/account-identity/do-work`, `packages/account-session/do-work/start-returning-login.ts`, `packages/checkout/do-work/gate-checkout.ts`.
