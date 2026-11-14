# Account Identity Work

Owner-action helpers for role-addressed identity materialization.

| File | Purpose |
|---|---|
| `README.md` | Indexes the owner-action folder. |
| `derive-account-identity.ts` | Entry target that runs the package materialization spec and returns role-addressed records/projection data. |
| `derive-account-identity.test.ts` | Proves target payload decoding, idempotence, and no fixed result fields. |

| Type | Signature / Shape | Role |
|---|---|---|
| `DeriveAccountIdentityInput` | `{ materialization_spec?, input?, email? }` | Target payload accepted by the owner action. |
| `deriveAccountIdentity` | `(input) => RoleAddressedMaterializationResult` | Materializes declared output roles from declared source roles/rules. |

**Depends on:** `../read-data/account-identity-materialization`.

**Depended on by:** `things-to-store-and-run.json` target descriptor `account-identity.derive`.
