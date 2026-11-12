# Service Connections

Every service a person can connect to Trillion as DATA (one descriptor per service in `records.json`), plus the connect, rename and disconnect request builders and the connect dialog that read those descriptors.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:list-every-connection` | The one Connections list: every service in `records.json` (how it connects: key, sign-in, or carried by the person's computer, with its steps) and every place on the person's computer in `tools/bring-in-new-items-from-this-computer/computer/computer-sources.json` (what it arrives as, its switch), in one set of category words (`do-work/connection-categories.json`), sorted by category; given `tool:look-for-the-places-on-this-computer`'s answer, each place says whether it is there | in a small container, no internet |
| `tool:trade-a-gmail-sign-in-code-for-its-tokens`, `tool:trade-a-youtube-sign-in-code-for-its-tokens`, `tool:trade-an-instagram-sign-in-code-for-its-short-token`, `tool:trade-a-short-instagram-token-for-a-long-one` | The token requests a sign-in callback makes, one per step of a descriptor's `acquire` (its `token_url`, then each `then`): the sign-in app's id and secret are placed from the vault only as the request leaves (`{{name}}` placeholders bound to the token host), and the reply's tokens are kept in the vault as the new connection's own fields (`reply_holds_values`), so no token is ever in a run's answer | http, to the service's token host |

## Files

| File | Purpose |
|------|---------|
| `records.json` | `{ package, things: [...] }`: one published record per service (`package::service-connections::published-record::<vendor>`) whose `payload` names the service, its capabilities, `credentialFields`, `helperLinks` (each `{ id, label, url, description?, tone? }`: a button on Connections, `tone` its look such as `primary`, a `description` a step above it), `domain`, `category`, `verifyRequest`, an `acquire` flow when it signs in by its own flow, `carriedBy` when only the person's own computer can reach it, and `sendsFrom` when the service refuses requests from servers' addresses. `scripts/workshop-rows.mjs` turns each into a Workshop connect row through the row source `source:service-connection-descriptors` in `records/workshop-tool-records.json`. |
| `do-work/list-every-connection.mjs` | The run of `tool:list-every-connection`: reads both owners' rows as they are, names no service or place. |
| `do-work/connection-categories.json` | Which service category is which list category (`Messaging` is `Messages`...), so both kinds group together. |
| `tool-rows.json` | The rows above. |
| `do-work/connect-by-signing-in.mjs` | The byte copy of the old sign-in start (trillion `src/connect.mjs` lines 473-484 at tag old-trillion-before-worker-retire), the first commit of its port. |
| `ports/connect-by-signing-in.json` | The port contract of `do-work/connect-by-signing-in.mjs`. |
| `test/list-every-connection.test.mjs` | Made-up rows of both owners, and the row run over the real ones. |
| `work-contract.json` | The owner record work contract the readers interpret: record kinds, columns, facts, actions and secrets. |
| `part.json` | The files other parts and `src/` may import (`public`). |
| `do-work/connect-service.ts` | The connect write path: raw credential bytes go to the host's value store first, connection metadata to the owner action with only the handle. |
| `do-work/disconnect-service.ts` | Request builder for disconnecting one connected account. |
| `do-work/rename-service-connection.ts` | Request builder for renaming one connected account's label. |
| `do-work/external-effect-attempt.ts` | The states of one outside effect attempt (prepared, dispatching, unknown, succeeded, rejected, cancelled). |
| `do-work/engine-seams.ts` | `engineSeams()`: refuses a connect call that passes no seams; Trillion always passes its own (`src/held-values.mjs`). |
| `do-work/mint-credential-handle.ts` | Browser-side client that hands raw credential material straight to the value owner. |
| `do-work/shell-redirect-acquisition.ts` | An OAuth authorization-code acquire with no child process: the shell opens the provider and completes on its own redirect. |
| `do-work/workflow-actions.ts` | The owner-action bridge; with no owner-action host it fails in words and callers pass the host's seams. |
| `read-data/owner-record-work-contract.ts` | Interpreter for the generic record work contract (records, columns, facts, actions, secrets). |
| `read-data/read-service-connection-options.ts` | Decodes the service descriptors from the published records. |
| `read-data/calendar-connection-options.ts` | Discovers provider-declared calendars and binds reads/writes to the exact current connected account; provider tools, role names and response paths come from each calendar source's `calendar_connection` data. |
| `read-data/read-service-connections.ts` | Reads a person's connected accounts through the work contract's columns. |
| `show/ServiceConnectionDialog.tsx` | The connect dialog, drawn entirely from a service's descriptor. |
| `show/ConnectedAccountsSection.tsx` | The connected-accounts list inside the connect dialog. |
| `show/mount-service-connection-dialog.tsx` | Mounts the dialog and completes a shell-redirect sign-in. |

## Key types / functions

| Name | Shape | Role |
|------|-------|------|
| descriptor `payload` | `{ provider, name, capabilities, credentialFields?, helperLinks?, domain, category, verifyRequest, acquire?, carriedBy?, sendsFrom? }` | One service. A new service is one record here, never code. |
| `carriedBy` | `{ steps: [string] }` | The service lives on the person's own computer (iMessage, WhatsApp): the Trillion helper `computer/carry-connections.mjs` carries it, Connections shows it under "On your computer" with these steps, and `src/carried-connections.mjs` reaches it. |
| `sendsFrom` | `[{ placement, next_when_answered?: [status] }]` | Where the connection's requests leave from, in order (`src/send-from.mjs`): each a Workshop placement (`placement:this-worker` sends from Trillion, `placement:your-computer-network` from the person's own computer through its helper), and the next one is tried only when this one answers a status listed. Carried onto the connect row as `invoke.connects.sends_from`; the tools that use the connection, its posts and its check all send through it. |
| `engineSeams(context)` | → `ServiceConnectionSeams` | Where the contract, value store, owner actions and clock come from. |

## Dependencies

**Depends on:** `src/held-values.mjs` (the seams Trillion passes), `parts/ui` (the dialog's components).
**Depended on by:** `scripts/workshop-rows.mjs` and `records/workshop-tool-records.json` (connect rows), `src/account-screens.mjs` (Connections), `src/connect-with-a-key.mjs`, `src/carried-connections.mjs` (services a computer carries).

## Reported access for an operation

A capability can declare `required_scope_alternatives_by_tool`, mapping its
existing tool IDs to alternatives of required provider scopes. Each inner array
is ANDed; alternatives are ORed, so broader accepted provider grants can be
declared without hard-coded provider branches. `read-data/grant-requirements.ts`
returns satisfied, missing or unknown for diagnostic presentation only. It does
not authorize a request or replace current provider checks. Unknown grants and
malformed/empty declarations remain unknown; explicitly reported empty grants
can establish missing access.

Shared Connections names affected operations using the admitted tool catalogue
and keeps the existing exact-account Sign in again action. Stored scopes are
last reported at sign-in and are not a live authorization oracle. A capability
choice remains independent. Google Calendar requests Calendar List read access
for the list-calendars and colors operations; metadata-only Calendar scopes do
not satisfy that API contract. Existing accounts keep their original grants
until the person completes the provider's sign-in flow.

Gmail declares every existing operation against its official method contract.
The search and full-message tools omit the metadata-only alternative because
their actual request parameters require broader access. Sending a saved draft
requires compose/modify/full-mail access; send-only access does not cover it.
Signature settings use their own declared access. These rows add diagnostics,
not new requested grants or a second account flow. The personal OAuth modifier
does not infer administrator delegation from a reported scope string.

Calendar and Gmail operation labels live beside their request DATA. The generic Workshop row source carries those labels into every derived tool consumer; permission diagnostics never turn internal tool IDs into display text.
