# tools/connections/

A person's connected accounts: the services this account is connected to, one row a connection. The owner of what old
trillion kept as its held-values connection summaries (`src/connection-summaries.mjs`, the held-values operation `list`,
the row `tool:list-connections`; Trillion-X/trillion before 4ffa1dc4a2). Token refresh stays in the engine's running
tools (trillion-rust `src/tool_runs/tools/http/refresh.rs`); connecting, checking and disconnecting are not here yet.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:list-connections` | `{}` → `{ connections }`: one row a connection in connection id order (`connection_id, service, vendor, account_label?, status?, can_send, connected_at?, grant_scopes_known, grant_scopes?, capabilityChoices?, last_checked?, connected_by?`) | in a small container, no internet, over the records door |

## Where a connection lives on today's engine

- Its summary row: the person's own `connection` record (id `connection:` + the connection id, URL-encoded), read with
  `records:list`. The same records `tools/social-posts` reads for its destinations.
- That it holds values: the engine's vault, by the names alone. The account files door's `held_connections` read
  (trillion-rust `src/account_files/account-files-routes.json`) answers `{ connections: [{ connection_id, fields }] }`
  from the vault's names (`service-connection-<hex id>[-field-<hex field>]`); no value, expiry or handle leaves. It is
  account mechanics, the running tools job's vault (capabilities.json "run tools: ... hold its secrets"), so it stays in
  the engine and only this non-secret summary crosses the door.

Until every connection the vault holds has its record, a connection with no record is listed from what the names say
(its id, its vendor from the id, its service's name from `tools/connect-a-service-and-seal-its-key/records.json`) and its
other facts are left out as unknown, as old `list` answered from the facts until its summary rows were all made.

## Files

| File | Purpose |
|------|---------|
| `do-work/list-connections.mjs` | `listConnections(input, { door })`, the row's run; `connectionSources` reads the two sources. |
| `do-work/list-connections.json` | The record kind, the files door operation and the connection id prefix. |
| `tool-rows.json` | The row. |
| `ports/list-connections.json` | The port contract (source: old `src/held-values.mjs` `list`). |
| `test/list-connections.test.mjs` | The old held-values listing assertions over made-up records and held names, and the row's run. |

## Dependencies

**Depends on:** `tools/find-and-keep-my-connections/src/connection-records.mjs` (`connectionSummaryOf`,
`connectionIdFromRecord`), `tools/connect-a-service-and-seal-its-key/records.json`, `tools/records-door`.
**Depended on by:** `tools/see-what-my-business-took-in-this-month` (`tool:read-business` runs it).
