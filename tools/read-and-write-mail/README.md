# tools/read-and-write-mail/

A person's mail, on whichever mail provider their account is on: find, read, organize, trash and restore mail and conversations, keep and send drafts, and set the signature they send with. Each tool is one `container` row in `tool-rows.json` named for its job. It takes `provider` (an id of `read-data/mail-providers.json`) and `connection` (`{ connection_id, connected_at }`, the account of that provider, by its handle only), runs as that account, and answers the provider-neutral rows of `read-data/neutral.mjs`, never the provider's own payload. The person's key stays in their vault: the engine hands it to the run alone (descriptor 4), renews it when it has expired, and the run places it only in the Authorization header of a request to the provider's own host.

Earlier this folder was `tools/read-and-write-gmail/`: 21 `http` rows named `tool:google-account-<request>`, and the mail screen read Gmail's MIME payload itself (`gmail-email.ts`). Vendors are reached by connection role, never by name (the person's own rule, Nov 14 2026; case engines-already-do-it-sweep-2026-11-14, lane 12, findings 23 and 24), so the provider is a row and its wire format is one adapter file behind that row.

## What differs between providers, and where it is written

| Fact | Where |
|------|-------|
| Which connection kind reaches the account, which host a key may go to, how the key is renewed, which operations it offers, its label and folder words, its web page for a message | `read-data/mail-providers.json`, one row per provider |
| Each row's `by_input` variants (connection kind and renewal) | derived from that file; `test/mail-tools.test.mjs` fails when a tool row differs from it |
| The provider's requests and replies (MIME parts and `labelIds` for Gmail; Microsoft Graph message resources for Outlook) | `read-data/adapters/<adapter>.mjs`, kept as code because a wire format is Physics |
| The neutral message, its labels (`inbox`, `unread`, `starred`, `important`, `draft`, `sent`, `trash`, `spam`) and its header names | `read-data/neutral.mjs` |

A new provider is a row in `mail-providers.json` and an adapter file. No tool id, tool row or screen names one.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The 19 rows. Each `invoke.by_input` (`input: provider`) holds one variant per provider row: its `connection` `{ vendor, from_input: "connection" }` and its `refresh`. |
| `read-data/mail.mjs` | The one entry: `providerFor`, `makeCall` (the key and the host guard), `perform`, and one export per operation, run by `tools/workflows/do-work/run-a-function.mjs`. |
| `read-data/mail-providers.json` | The provider rows and the words of a refusal. |
| `read-data/neutral.mjs` | `neutralMessage`, `HEADER_FIELDS`, the neutral/wire label words. |
| `read-data/adapters/gmail.mjs` | Gmail's requests, MIME decoding (plain text only, links, attachments, drafts that need the original) and composing (UTF-8 headers, header newlines stripped, reply references). |
| `read-data/adapters/outlook.mjs` | Microsoft Graph's mail requests. No signature operations (Graph keeps none), and a draft cannot carry In-Reply-To or References lines. |
| `read-data/adapters/agentmail.mjs` | AgentMail's REST requests for the reads (inboxes, messages, search, threads). The provider's key is a plain vault key (`secret_name`, no connection, no renewal). A neutral id carries its inbox first: `<inbox_id>/<message_id>`. Sends, drafts and label changes are not offered. |
| `kits/<tool>.json` | One kit per tool, each worked example naming the MCP call and the neutral answer. |
| `test/mail-adapters.test.mjs` | Both adapters through stand-in providers: the same operation giving the same neutral row, the key only in the Authorization header to the provider's own host (an attachment's signed download is fetched without the key, only from the row's download_hosts), a refusal and a missing operation said in words, Gmail's wire rules. |
| `test/mail-tools.test.mjs` | The rows against the provider file; no vendor in a tool id or label. |

## The tools

`find-my-mailbox`, `list-new-mail`, `find-mail`, `read-mail-headers`, `read-a-mail`, `read-a-conversation`, `organize-mail`, `organize-a-conversation`, `trash-mail`, `restore-mail`, `trash-a-conversation`, `restore-a-conversation`, `list-mail-drafts`, `read-a-mail-draft`, `save-a-mail-draft`, `delete-a-mail-draft`, `send-a-mail-draft`, `list-send-as-addresses`, `set-a-mail-signature`, `keep-a-mail-attachment` (ids `tool:<name>`). `keep-a-mail-attachment` writes one attachment's bytes to the run's kept output (data only, never opened) and answers `{name, bytes, media_type, blake3}`; it is offered by Gmail and AgentMail, not Outlook, and its download address must be https and at most 16 MiB. `find-mail` takes a `folder` (inbox, starred, sent, drafts, trash, all) or `text` to search all mail in the provider's own search words. A send is kept once per request key, so sending the same key again answers the first reply.

For a kept attachment, optional `name` supplies the display name through `invoke.outputs[].keep_as.name_from`. The Files keeper uses it as one plain name inside this tool's output folder; it is not an absolute destination path. With no name, the keeper uses its default run name. The actual Files placement is `files.attachment.name` (also returned under `result.files.attachment.name`), not the adapter's `result.name`. To place an already-kept attachment elsewhere, use the existing `tool:your-files` `move_names` operation with the source's `expected_version`, verify the target independently, and then reconcile the resource row. Moving a name does not download or copy its bytes.

## How to run one

Through the person's door like any Workshop tool, for example `tools:run` with `{ "tool": "tool:find-my-mailbox", "input": { "provider": "gmail", "connection": { "connection_id": "service_connection:google-account" } } }`.

## Screens

The mail screens read the neutral row only (`tools/workspace-screens/web/src/workspace/mail-message.ts`, `mail-accounts.ts` for the accounts and each one's provider row; the Mail screen and its action bar in `tools/calendar/web/src/workspace/`), and `tools/workspace-screens/test/mail-screens-name-no-provider.test.mjs` fails when one names a provider.

## Tests

`npm test` at the top of the repository runs `test/*.test.mjs` with the rest.
