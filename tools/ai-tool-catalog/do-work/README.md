# parts/ai-tool-catalog/do-work

Turns lists nobody typed by hand (a package's own records, a web address, a remote tool server) into Workshop tool rows (`ai-tool-descriptor`), and speaks to remote tool servers.

## Files

| File | Purpose |
|------|---------|
| `derive-tool-rows-from-sources.mjs` | Reads each `tool-row-source` row's list and pours every entry into the row's template. A list is `list.records` (`{ package, kind, file?, each_of?, not_carried_into_each? }`: the payloads of one kind in the package's `records.json`, or in the records file `file` names inside the package), `list.url`, `list.mcp`, or `list.openapi` (`{ url, headers?, connection?, only? }`). `lay_over` adds fields to matching rows. Every row passes the catalog decoder or is reported as refused. |
| `derive-tool-rows-from-sources-cli.mjs` | Explicit command entry: `node parts/ai-tool-catalog/do-work/derive-tool-rows-from-sources-cli.mjs <records file or folder> ...`. Prints derived IDs, unread sources and refusals. The sibling library stays inert when imported or bundled into another program. |
| `read-openapi.mjs` | An API's own description (OpenAPI 3.x or Swagger 2.0 JSON) as list entries, one per operation: its address with path holes, query and header leaves, a JSON body input, an input schema from its parameters (local `$ref`s followed, cycles cut), the licence it declares, and `credential_injections` for a key or bearer token in a header from the connection the source names. Deprecated operations and ones it cannot sign in for are held back with why. |
| `talk-to-a-tool-server.mjs` | One Model Context Protocol conversation with a remote tool server over streamable HTTP: start it, read every page of its tools, call one tool. Sends nothing itself and holds no key; the caller's `post` does. |
| `sign-in-to-a-tool-server.mjs` | Signs a person in to a remote tool server that asks for OAuth 2.1 as the Model Context Protocol describes (protected-resource and authorization-server discovery, dynamic registration, the sign-in itself). |

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

**Depends on:** `../read-data/read-ai-tool-catalog.ts` (`admitToolDescriptor`), the packages' own records files under `parts/`.
**Depended on by:** `scripts/workshop-rows.mjs` (the deploy's shared rows), `src/tool-servers.mjs`, `src/live-tool-sources.mjs`, tests (`test/engine-tools.test.mjs`, `test/make-pictures-and-sounds.test.mjs`).
