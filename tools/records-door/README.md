# tools/records-door/

How a Workshop tool reaches the person's own records: the client for the records door the run was handed, and the one
command that runs a tool written as a function. A library: it offers no tool of its own, and every row that reads or
writes records packs `do-work` and `read-data` here at `/opt/records-door`.

## The contract

A row asks for the door in its invoke, with one rights item per record kind:

```json
"invoke": {
  "kind": "container",
  "argv": ["node", "/opt/records-door/do-work/run-an-export.mjs", "/opt/<folder>/read-data/<file>.mjs", "<export>"],
  "stdin": { "fill": { "from": "input" } },
  "records": { "fd": 3, "rights": [{ "kind": "<record type>", "operations": ["records:read", "records:list", "records:write"] }] }
}
```

- A rights item may narrow its kind to one record (`"id": "<id>"`) or an id prefix (`"prefix": "<start>"`), never
  both. Nothing gets a blanket right on a kind when it reads only one record of it.
- The run gets one JSON line on that descriptor: `{ url, resource, capability }`. The capability can do no more than
  the row's rights and the person's own key. It is never printed, logged or returned.
- A rights item `{ "files": "/" | "/<folder>/", "operations": [...] }` reaches the person's Namespace files under that
  folder instead of a record kind. The descriptor then also holds `files_resource`, and `door.files(operation, input)`
  calls the files door's operations there (list_files `{ folder?, after?, limit? }` answers `{ names, next_after, folders }`;
  read_file `{ name_or_identity, offset?, length? }` answers one part of a file's bytes). A run handed no files right is
  refused before anything is sent (`no_files`).
- Without `"internet": true` the run can reach only the door's loopback port.
- Operations (`run_resource_operation` at `@own-records`):
  - `records:read { id, type }` gives `{ id, type, value }`. value is null when the record is absent or of another kind.
  - `records:list { type, order?, prefix?, above?, below?, reverse?, fields?, where?, limit? (1..999), after? }` gives
    `{ records, next }`. With no order it lists the greatest id first. Keep paging until `next` is null. `fields` (at
    most 64 top-level names) narrows each value to those fields; `[]` gives ids and types only. `where` (at most 64
    top-level names, each with a value) keeps only the rows whose fields equal those values as JSON; `limit` then
    bounds the rows read, so a page may show fewer rows, or none, and still name a next page.
  - `records:write { records: [{ id, type, value | null, expected? }] }` gives `{ changed, write_count }`. Every
    record carries its type, and every id must be inside a rights item, or the whole write is refused. When present,
    `expected` is `null` to require the id to be absent, or `{ type, value }` to require the exact current kind and
    whole value. A mismatch refuses the complete write before any item changes; the condition is not stored with the
    record. When omitted, the write remains unconditional. One write carries 1 to `invoke.records.most_writes` records.
    Left out, that is the engine cap of 256; declaring more refuses the run. The request key makes a write safe to
    send again.
  - A run that wake starts has every value it writes stamped with the wake's cause (`_wake_cause`), so its own
    change does not wake it again. Such a run may not remove records. A run an AI starts at the door has no cause.
- The door answers within one bounded message. A list page holds as many rows as fit (fewer than `limit`, with a
  `next`). A record too big to fit alone (or a list whose first row is) is answered as pages of its own bytes:
  `{ byte_page: { total, blake3, offset, length, base64, next_after_byte } }`. The same call with `after_byte` set to
  `next_after_byte` answers the next page, until it is null. The client joins the pages, checks their length and
  BLAKE3, and answers what the call would have answered (`read-data/byte-pages.mjs` `wholeAnswer`, which other doors
  use too).
- `invoke.records` holds only `fd`, `rights` and `most_writes`; any other key refuses the row.
- A refusal is `{ isError: true, structuredContent: { code, outcome: "not_started" | "unknown", request_key? } }`,
  with no words. The client gives each code its words:
  - `current_workspace_rights_refused`: outside the rights or the person's grant;
  - `original_input_refused`: bad input;
  - `original_workspace_source_unavailable`: the records cannot be reached;
  - `selected_owner_unavailable`: busy.
- A busy answer (HTTP 503 or `selected_owner_unavailable`), and any call whose outcome is `unknown`, is sent again
  with the same request key after a growing wait, never a new key. HTTP 401 means the run's capability is gone.
- An id right reads and writes only that id and never lists. A prefix right reads and writes ids under it, and lists
  only with no order and a `prefix` that starts with its own. A call passes when any rights item of its kind allows it.

## Files

| File | Purpose |
|------|---------|
| `read-data/records-door.mjs` | `openRecordsDoor()`: `readRecord(type, id)` returns the exact `{ type, value }` snapshot or `null`; `read(type, id)` remains value-only; `list(query)` (every page, as an async iterator), `write(records, { key })`, `files(operation, input)`; `RecordsDoorError` with the door's code. |
| `do-work/run-an-export.mjs` | `node run-an-export.mjs <module file> <export>`: calls `fn(input, { door })` with the run's input and prints `{ result }` or `{ error }`. The door opens on first use, so a function that reads no records needs none. |
| `read-data/byte-pages.mjs` | `wholeAnswer(answer, again)`: an answer that came as byte pages, read on with `again(after_byte)`, joined, checked and parsed. Pure, so a page bundles it too. |
| `read-data/write-batches.mjs` | `writeBatches(records, { rows, bytes })`: records in order as writes that each fit one door message (at most `rows` records and `bytes` bytes of JSON; a larger record alone), since a write over the 64 KiB message is refused whole. Pure, so a page bundles it too. |
| `test/fake-door.mjs` | A stand-in door on loopback: records in memory, bearer and rights checks, cut pages, byte pages, busy answers, event-stream answers, saved write receipts. |
| `test/run-row.mjs` | `runRow(row, input, { records })`: runs a row's argv the way the container does (`/opt/<folder>` laid on `tools/<folder>`), with the fake door on the row's descriptor and exactly the row's rights. |
| `test/records-door.test.mjs` | The client and the driver against the fake door. |

## Dependencies

**Depends on:** Node, and `tools/content-identity` (the BLAKE3 check of joined byte pages).

**Depended on by:**
- `tools/saved-examples`, `tools/tell-the-person`, `tools/social-posts`, `tools/recently-deleted`, `tools/person-list`: their rows pack this folder, and their tests use `test/run-row.mjs`;
- `tools/meaning-search` and `tools/documents-as-list-rows`: their rows pack this folder and read the person's files with `door.files`;
- `tools/read-a-list-view`: its door joins byte pages with `read-data/byte-pages.mjs`, and its refresh cuts writes with `read-data/write-batches.mjs`;
- `tools/decide-with-a-method`: its rows pack this folder, and a decision too large for one write is cut with `read-data/write-batches.mjs`.
