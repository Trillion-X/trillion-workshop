# tools/email-sending-domains/

Which domains a person's email-sending account (Resend) may send from, how each stands, and how many there are. It only reads and sends no email. The person's own held key reaches the one tool process on a private pipe (descriptor 3) and never appears in the request, argv, a file, the environment or the answer.

## Files

| File | Purpose |
|------|---------|
| `do-work/list-email-sending-domains.mjs` | `tool:list-email-sending-domains`: reads the key from descriptor 3, asks the provider once and answers `{ domains: [{ name, status }], count }`. |
| `tool-rows.json` | The Workshop row Trillion reads for this folder: `tool:list-email-sending-domains`, with `credential_mounts: [{ secret_name: "resend-api-key", fd: 3 }]`. |
| `part.json` | Nothing here is imported by other code. |
| `test/list-email-sending-domains.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `listDomains` | `({ key, fetchImpl? }) => Promise<{ domains: { name, status }[], count }>` | One provider read with the handed key; refusals say how to fix the connection and never include the key. |

## Dependencies

**Depends on:** Node's `fetch` and `node:fs`.

**Depended on by:** `tool-rows.json` (`tool:list-email-sending-domains`), run on the person's computer by Trillion's local engine (trillion-rust `src/runtime/workshop.rs`).
