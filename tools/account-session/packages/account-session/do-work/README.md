# Account Session Work

Target and browser-session helpers for the generic account session package.
`start-verified-browser-session` writes a browser-session record only after a
verified caller supplies account identity and browser identity.

| File | Purpose |
|---|---|
| `README.md` | Explains account-session work helpers. |
| `start-returning-login.ts` | Requests account-identity role rows, signs a login proof, and asks the delivery target to send the login link. |
| `start-returning-login.test.ts` | Proves account-session reads account-identity role rows and rejects missing required roles. |
| `authorize-transient-session-target.ts` | Verifies the configured signed account-session cookie from generic handshake evidence and emits a secret-safe authority reply for transient brokers. |
| `authorize-transient-session-target.test.ts` | Proves canonical and shell-fixture interoperability plus valid, forged, expired, missing, malformed, cookie-parsing, secrecy, and deterministic-session-reference behavior. |
| `fixtures/shell-transient-session-handshake-evidence.json` | Locks the shell broker's `{headers:[{name,value}]}` evidence representation for an exact interoperability test. |

| Type | Signature / Shape | Role |
|---|---|---|
| `startReturningLogin` | `(input: StartReturningLoginInput) => Promise<StartReturningLoginReceipt>` | Starts the returning-login flow after reading required identity roles. |
| `readReturningLoginIdentityReply` | `(payload: Uint8Array) => ReturningLoginIdentity` | Translates required account-identity roles into account-session caller language. |
| `authorizeTransientSessionTarget` | `(input: TransientSessionHandshakeEvidence) => Promise<TransientSessionAuthorityReply>` | Returns `{authorized:false}` or the canonical principal, non-secret session reference, and expiry; it owns no broker scope policy. |

**Depends on:** `@bitfield/runtime-kit`, `packages/account-identity/read-data/account-identity-materialization`, account authority access reads, login proof token crypto.

**Depended on by:** account-session target entries and browser account-session surfaces.
