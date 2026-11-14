# Account Identity Package

Account Identity owns role-addressed identity materialization from declared source roles, rules, and output roles.

| File | Purpose |
|---|---|
| `README.md` | Explains the package source workshop. |
| `index.ts` | Public exports for the role materializer and owner-action entry. |
| `things-to-store-and-run.json` | Package boundary records for stored bytes, target descriptors, materialization data, owner action, and projections. |
| `read-data/README.md` | Read-data folder index. |
| `read-data/account-identity-materialization.ts` | Generic role-addressed materialization and role reply reader. |
| `read-data/account-identity-materialization.test.ts` | Unit and adversarial tests for the materializer. |
| `do-work/README.md` | Owner-action folder index. |
| `do-work/derive-account-identity.ts` | Target entry that materializes role rows from the declared spec. |
| `do-work/derive-account-identity.test.ts` | Owner-action tests. |
| `tests/assert-workflow-boundary.mjs` | Boundary conformance proof for workflow owner-action descriptors. |

| Type | Signature / Shape | Role |
|---|---|---|
| `RoleMaterializationSpec` | `{ kind, source_roles, rules, output_roles, projection? }` | Package data declaration for generic identity materialization. |
| `RoleAddressedMaterializationResult` | `{ kind, revision_key, roles, records, projection }` | Result returned by the owner target and consumed by adjacent packages by role. |
| `deriveAccountIdentity` | `(input) => RoleAddressedMaterializationResult` | Owner-action entry for `account-identity.derive`. |
| `readMaterializedRoleValue` | `(result, role) => string` | Reads a required role value from object, text, or bytes. |

**Depends on:** Runtime Kit package target descriptors and `slot::workflow` owner-action routing.

**Depended on by:** `packages/account-session`, `packages/checkout`, browser and iOS account-identity surfaces.

## Invariants

- The package result is role-addressed data, not the old three-field owner DTO.
- Source files are proposal material. Live package truth is written through the log-owned package path, not by copying this folder into a running app.
- Consumers may translate required role values into their own caller-language payloads, but account-identity owns how the role rows are built.
