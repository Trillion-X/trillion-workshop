# tools/live-records/

The person's own records, as the engine's records door reaches them: read, list, search and write records, recover a write's receipt, and
read and write workspace labels. The engine runs `live-records` as a session that takes calls (tool `tool:your-records`), so every caller
(a run, an AI, a device) reaches the records through the engine's one door and the program opens no port. The records are rows in the
person's own SQL database (their own Postgres, or a SQLite file for a person with none).

The contract callers already use is `tools/records-door/README.md`; this tool answers it and changes none of it.

## What runs

`live-records mcp --state FOLDER [--settings FILE] [--computer JSON]` speaks MCP over stdio. Each operation of the door is a tool of the
same name (`mcp-tools.json`); the engine sends one `tools/call` for each call a caller makes at the records address, with the input the
caller's rights already narrowed, and two fields of its own (`settings.json` `call_fields`): `call_key`, the call's request key, and
`after_byte`, where the next page of a byte-paged answer starts.

| Operation | Answers |
|-----------|---------|
| `records:read { id, type }` | `{ id, type, value }`; value is null when the record is absent or of another type |
| `records:list { type, prefix?, above?, below?, reverse?, limit?, after?, fields?, where? }` | `{ records, next }`: ids greatest first (`reverse: false` for the other way), a page cut before a message is full, `next` the last id read, null at the end; `where` reads on until `limit` rows match or a walk bound is reached |
| `records:search { question, type?, limit? }` | `{ question, terms, results, unavailable, pending }`: records holding every asked word at the start of a word, each type ranked newest first and the types merged by reciprocal rank |
| `records:write { records: [{ id, type, value \| null, expected? }], check_only? }` | `{ changed, write_count }`; all or nothing; the same `call_key` answers the first receipt, another body under it is `original_command_conflict` |
| `records:result { request_key, operation, input }` | the receipt of the original write; none kept is `original_workspace_source_unavailable`, outcome `unknown` |
| `workspace:read { selection: { labels, prefixes: [] } }` | `{ status, content_type, text }`, text `{ "records": { label: payload } }` |
| `workspace:write { writes: [{ address_label, payload }] }` | `{ changed, write_count }` |

A refusal is `isError` with `{ code, outcome }` and no words: `original_input_refused`, `original_command_conflict`,
`original_workspace_source_unavailable` (outcome `unknown` when a write may have committed) or `selected_owner_unavailable`. An answer that
does not fit one message (`bounds.answer_bytes`) is `{ byte_page: { total, blake3, offset, length, base64, next_after_byte } }`; the same call
with `after_byte` set to `next_after_byte` answers the next page, from the same call run again, so no page is kept between calls.

## Where the records are

A record of type T is the row `id` of the scope `<records>T` in the shared rows (`rows-store`, settings.json `scopes`): the generic table, one
JSON value a row, listed by id with an index on (scope, id). A workspace label is a row of the scope `workspace`. A write's receipt is a row of
the scope `receipts`, written in the same transaction as the rows it changed (`Rows::mutate_all`), which is what makes a retry safe. The
database is a setting, never code: `store` is `{"postgres": {"connection": "own-rows-postgres-connection"}}` (the connection attached on
descriptor 8, read once, never printed) or `{"sqlite": {"file": NAME}}`.

## What is not here

Each is refused with `original_input_refused`, never ignored: a declared `order` of a list, a typed `view`, a list `snapshot`, a write's
`queries` and compact `expected: { type, identity }`, a read `at` a time (history), `scope` (another history), and records:history,
records:outside_choices and references. The engine's former record store kept those over its own files; they are built here when a caller
needs one. Two things differ from it: two record types never share an id (a record is its type and its id), and `where` reads by walking the
type's ids (a million at most, `walk_seconds` at most), not through a declared order. Receipts are kept for ever (one small row for each write).

## Files

| File | Purpose |
|------|---------|
| `src/main.rs` | The program: `mcp --state FOLDER` |
| `src/serve/mod.rs`, `src/serve/mcp.rs` | Open the run (state folder, attached connection, rows); the MCP server over stdio, a thread for each call |
| `src/records/mod.rs` | The operations by name, the refusal, input checks, `records:read` |
| `src/records/list.rs`, `search.rs`, `write.rs` | `records:list`; `records:search`; the writes, the receipt, `records:result` and the workspace labels |
| `src/answer.rs` | An answer too big for a message as byte pages |
| `src/attached.rs`, `src/settings.rs` | The attached connection read once; the settings and their bounds, each with its why |
| `settings.json`, `mcp-tools.json` | DATA: where the rows are, the scopes, the bounds; the tools the server lists |
| `rows-store/` | The shared crate: the rows in SQL (`Rows`, `RecordRows`, `SqlStore`) and the refusal causes; also used by `tools/live-namespace` |
| `tool-rows.json`, `kits/your-records.json` | The tool's row and its kit |

## Dependencies

**Depends on:** `rows-store` (this folder), `rows-store/content-crypto` (BLAKE3), serde_json, base64, zeroize, libc. The door's contract:
`tools/records-door`.

**Depended on by:** the engine's records door (the engine's served-address DATA names `tool:your-records` for the records address); every tool whose
row declares `invoke.records` reaches its records through it. `tools/live-namespace` depends on `rows-store` here.

## Build and test

    cd tools/live-records && cargo build --release && cargo test
    cd rows-store && cargo test

The Postgres side of the store runs its tests when `NAMESPACE_POSTGRES_TEST_CONNECTION` holds the connection string of a throwaway database.
