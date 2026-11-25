# tools/email-sending-domains/

Which domains a person's email-sending account (Resend) may send from, how each stands, and how many there are; adding a domain to send from (with the DNS records its owner must add), reading one domain and each record's state, and asking the account to check its records again; and a new key that may only send email, kept in the person's vault under its own name, with the account's keys listed and one removed by its id. None sends email or changes DNS. The person's own held key reaches the one tool process on a private pipe (descriptor 3) and never appears in the request, argv, a file, the environment or the answer.

## Files

| File | Purpose |
|------|---------|
| `do-work/list-email-sending-domains.mjs` | `tool:list-email-sending-domains`: reads the key from descriptor 3, asks the provider once and answers `{ domains: [{ name, status }], count }`. |
| `do-work/list-resend-webhooks.mjs` | `tool:list-resend-webhooks`: reads the key from descriptor 3, asks the provider's webhook list once (GET /webhooks) and answers `{ webhooks: [{ id, url, status, events }], count }`: never the key, a webhook's signing secret (the list gives none, and this tool never reads one webhook) or the raw reply. It changes no webhook. |
| `do-work/list-sent-emails.mjs` | `tool:list-sent-emails`: reads the key from descriptor 3 and the input on stdin, asks GET /emails a page of 100 at a time (at most 50 pages) until an email is older than the window of `days`, and answers `{ emails: [{ id, to, subject, created_at, last_event }], count, complete }`: never the key, a body or the raw reply. |
| `do-work/read-a-sent-email.mjs` | `tool:read-a-sent-email`: reads the key from descriptor 3 and the input on stdin, asks for one sent email once (GET /emails/{email_id}) and answers `{ id, from, to, subject, created_at, last_event }`: never the key, the email's body or the raw reply. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:list-email-sending-domains`, with `credential_mounts: [{ secret_name: "resend-api-key", fd: 3 }]`; and `tool:make-a-sending-key`, an `http` row that asks Resend for a `sending_access` key with the held key placed in its Authorization header, and keeps the reply's `token` in the vault under the input's `keep_as` (`reply_holds_values`), the held word in its place. A `keep_as` already held is never replaced, and then nothing is sent (the engine's src/runtime/workshop/http.rs). `tool:add-an-email-sending-domain` (POST /domains), `tool:read-an-email-sending-domain` (GET /domains/{domain_id}) and `tool:check-an-email-sending-domain` (POST /domains/{domain_id}/verify) are `http` rows with the same held key in the Authorization header, as are `tool:list-sending-keys` (GET /api-keys: ids, names and dates, never a key) and `tool:remove-a-sending-key` (DELETE /api-keys/{api_key_id}). |
| `part.json` | Nothing here is imported by other code. |
| `test/list-email-sending-domains.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |
| `test/list-sent-emails.test.mjs` | Tests for `tool:list-sent-emails`: its row's private pipe, stdin and sample read, paging to the window's start with the key and bodies left out, the last page, a bad `days`, and its refusals. |
| `test/read-a-sent-email.test.mjs` | Tests for `tool:read-a-sent-email`: its row's private pipe, stdin and sample read, the answer's fields with the key and the body left out, an id refused before any ask, and its refusals. |
| `test/list-resend-webhooks.test.mjs` | Tests for `tool:list-resend-webhooks`: its row's private pipe and sample read, the answer's fields with the key and a signing secret left out, an empty account, and its refusals. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `listDomains` | `({ key, fetchImpl? }) => Promise<{ domains: { name, status }[], count }>` | One provider read with the handed key; refusals say how to fix the connection and never include the key. |
| `listSentEmails` | `({ key, days, now?, fetchImpl? }) => Promise<{ emails: { id, to, subject, created_at, last_event }[], count, complete }>` | Pages through the account's sent emails back to the window's start with the handed key; the same refusals. |
| `readSentEmail` | `({ key, email_id, fetchImpl? }) => Promise<{ id, from, to, subject, created_at, last_event }>` | One read of one sent email with the handed key; the same refusals, and one for an unknown email. |
| `listWebhooks` | `({ key, fetchImpl? }) => Promise<{ webhooks: { id, url, status, events }[], count }>` | One read of the account's webhooks with the handed key; the same refusals. |

## Dependencies

**Depends on:** Node's `fetch` and `node:fs`.

**Depended on by:** `tool-rows.json` (`tool:list-email-sending-domains`), run on the person's computer by Trillion's local engine (trillion-rust `src/runtime/workshop.rs`).
