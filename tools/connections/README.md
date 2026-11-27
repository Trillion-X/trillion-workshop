# tools/connections/

A person's connected accounts: the services this account is connected to, one row a connection. The owner of what old
trillion kept as its held-values connection summaries (`src/connection-summaries.mjs`, the held-values operation `list`,
the row `tool:list-connections`; Trillion-X/trillion before 4ffa1dc4a2). Token refresh stays in the engine's running
tools (trillion-rust `src/tool_runs/tools/http/refresh.rs`); connecting, checking and disconnecting are not here yet.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:list-connections` | `{ connection_records, held_connections }` → `{ connections }`: one row a connection in connection id order (`connection_id, service, vendor, account_label?, status?, can_send, connected_at?, grant_scopes_known, grant_scopes?, capabilityChoices?, last_checked?, connected_by?`) | in a small container, no internet; reads no store, both lists come in the input |
| `tool:find-the-account-of-a-service` | `{ service, held_connections }` → `{ connection_id, accounts, which? }`: which of the person's accounts of a service a call means when it names the service with no account (`service_connection:stripe`); one held is the answer, several are named and none chosen. Moved from the engine (trillion-rust tools.rs `connection_found`) by the engine boundary audit, Nov 21 2026: a caller asks it before starting a tool | in a small container, no internet; reads only what it is handed |

## Where a connection lives on today's engine

- Its summary row: the person's own `connection` record (id `connection:` + the connection id, URL-encoded). The
  caller's AI reads those records from the person's store and hands them in as `connection_records`; this tool reads
  no record and keeps nothing. The same records `tools/social-posts` reads for its destinations.
- That it holds values: the engine's vault, by the names alone. The caller reads them with `secrets:names` at the
  account's door (the account files `held_connections` read this once cited, trillion-rust
  `src/account_files/account-files-routes.json`, is not on the engine's main as of Nov 21 2026) and turns them into
  `[{ connection_id, fields }]` with `read-data/held-connections-of-names.mjs` (`service-connection-<hex id>[-field-<hex field>]`);
  no value, expiry or handle leaves the vault. It hands that list in as `held_connections`. A call without it is refused.

Until every connection the vault holds has its record, a connection with no record is listed from what the names say
(its id, its vendor from the id, its service's name from `tools/connect-a-service-and-seal-its-key/records.json`) and its
other facts are left out as unknown, as old `list` answered from the facts until its summary rows were all made.

## Files

| File | Purpose |
|------|---------|
| `do-work/list-connections.mjs` | `listConnections(input)`, the row's run; `connectionSources` reads the two sources it is handed. |
| `do-work/list-connections.json` | The connection id prefix. |
| `read-data/held-connections-of-names.mjs`, `.json` | `heldConnectionsOfNames(names)`: the `held_connections` list both rows take, from the vault's held names alone (`secrets:names` at the account's door), so a page can hand it in; runs in a page and in node. |
| `test/held-connections-of-names.test.mjs` | The names read over made-up names, and that what they write is what `tool:find-the-account-of-a-service` takes. |
| `what-this-tool-does-and-how-to-run-it.json` | The row. |
| `ports/list-connections.json` | The port contract (source: old `src/held-values.mjs` `list`). |
| `test/list-connections.test.mjs` | The old held-values listing assertions over made-up records and held names, and the row's run. |

## Dependencies

**Depends on:** `tools/find-and-keep-my-connections/src/connection-records.mjs` (`connectionSummaryOf`,
`connectionIdFromRecord`), `tools/connect-a-service-and-seal-its-key/records.json`, `tools/workflows` (`do-work/run-a-function.mjs`, the runner).
**Depended on by:** `tools/see-what-my-business-took-in-this-month` (`tool:read-business` runs it).
