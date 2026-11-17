# tools/ai-tool-catalog/do-work

Turns lists nobody typed by hand (a package's own records, a web address, a remote tool server) into Workshop tool rows (`ai-tool-descriptor`), and speaks to remote tool servers.

## Files

| File | Purpose |
|------|---------|
| `derive-tool-rows-from-sources.mjs` | Reads each `tool-row-source` row's list and pours every entry into the row's template. A list is `list.records` (`{ package, kind, file?, each_of?, not_carried_into_each? }`: the payloads of one kind in the package's `records.json`, or in the records file `file` names inside the package), `list.url`, `list.mcp`, or `list.openapi` (`{ url, headers?, connection?, only? }`). `lay_over` adds fields to matching rows. Every row passes the catalog decoder or is reported as refused. |
| `derive-tool-rows-from-sources-cli.mjs` | Explicit command entry: `node tools/ai-tool-catalog/do-work/derive-tool-rows-from-sources-cli.mjs <records file or folder> ...`. Prints derived IDs, unread sources and refusals. The sibling library stays inert when imported or bundled into another program. |
| `read-openapi.mjs` | An API's own description (OpenAPI 3.x or Swagger 2.0 JSON) as list entries, one per operation: its address with path holes, query and header leaves, a JSON body input, an input schema from its parameters (local `$ref`s followed, cycles cut), the licence it declares, and `credential_injections` for a key or bearer token in a header from the connection the source names. Deprecated operations and ones it cannot sign in for are held back with why. |
| `talk-to-a-tool-server.mjs` | One Model Context Protocol conversation with a remote tool server over streamable HTTP: start it, read every page of its tools, call one tool. Sends nothing itself and holds no key; the caller's `post` does. |
| `sign-in-to-a-tool-server.mjs` | Signs a person in to a remote tool server that asks for OAuth 2.1 as the Model Context Protocol describes (protected-resource and authorization-server discovery, dynamic registration, the sign-in itself). |
| `tool-server-lifecycle.mjs` | Builds the exact original added-source rows and sequences public/key addition, OAuth setup and callback completion through opaque native intake. Its native account/fact/vault/callback seams are mandatory; the module registers no route. Known sealed receipts can finish interrupted metadata publication after restart. Unknown exchanges retain the original request key and never send another code request. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `toolRowsFromSources` | `(payloads, request?) → { rows, unread, refused, per_person }` | Every tool row the `tool-row-source` payloads yield now. |
| `rowsFromList` | `(source, list) → { rows, refused }` | One source's entries through its `entry` map and `row` template. |
| `recordsList` | `({ package, kind, file?, each_of?, not_carried_into_each? }, folder?) → entries` | A package's records of one kind as list entries, each with `record_address` and `record_name`. |
| `readList` | `(source, request?, options?) → entries` | The list a source names, wherever it lives. |
| `fillFromEntry` | `(template, entry) → value` | Fills `{ fill: { from: "entry", field } }` now; every other `fill` is left for run time. |
| `payloadsIn` | `(path) → payloads` | The record payloads in a records file or folder. |
| `openapiEntries` | `(document, { url?, connection?, only?, headers? }) → { entries, held_back, licence, api }` | Every operation in an API description as list entries. |
| `openapiList` | `({ url, headers?, connection?, only? }, request?) → entries` | An API description read from its address now. |
| `toolServerList` | `({ url, sign_in? }, { request?, post? }) → tools` | A remote tool server's own tool list. |

## Dependencies

The lifecycle host must validate the original state, browser session, account and full server address before `facts.consumePending(key, {state, callback_intake})` changes pending state. `callbacks.recover(state)` is a scoped facade over the same native HTTP/vault receipt owner, with no separate store: `null`, `{status:'kept', pending, result:{kept:true, expires_at}, request_key}`, `{status:'refused', request_key}`, or `{status:'unknown', request_key}`. The pending projection contains only `server`, `found`, `client_id`, `redirect_uri`, and `started_at`. Keys, codes, tokens, and PKCE verifiers stay native. Source/controller tests do not prove a native route is mounted.

`vault.acceptKeyIntake` replaces the server's previously held key, as the original `src/tool-servers.mjs:148` did, and returns only `{changed:true, rollback_handle}`. The native rollback witness holds the previous sealed envelope. A refused replacement restores it only while the exact written generation remains current; a later replacement is preserved. No previous key value or sealed envelope crosses into the child.

**Depends on:** `../read-data/read-ai-tool-catalog.ts` (`admitToolDescriptor`), the packages' own records files under `parts/`.
**Depended on by:** `scripts/workshop-rows.mjs` (the deploy's shared rows), `src/tool-servers.mjs`, `src/live-tool-sources.mjs`, tests (`test/engine-tools.test.mjs`, `test/make-pictures-and-sounds.test.mjs`).
