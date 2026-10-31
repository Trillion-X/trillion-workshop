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
  - `records:list { type, order?, prefix?, above?, below?, reverse?, limit? (1..999), after? }` gives
    `{ records, next }`. With no order it lists the greatest id first. Keep paging until `next` is null.
  - `records:write { records: [{ id, type, value | null }] }` gives `{ changed, write_count }`. Every record carries
    its type, and every id must be inside a rights item, or the whole write is refused. One write carries 1 to
    `invoke.records.most_writes` records. Left out, that is the engine cap of 256; declaring more refuses the run.
    The request key makes a write safe to send again.
  - A run that wake starts has every value it writes stamped with the wake's cause (`_wake_cause`), so its own
    change does not wake it again. Such a run may not remove records. A run an AI starts at the door has no cause.
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
| `read-data/records-door.mjs` | `openRecordsDoor()`: `read(type, id)`, `list(query)` (every page, as an async iterator), `write(records, { key })`, `files(operation, input)`; `RecordsDoorError` with the door's code. |
| `do-work/run-an-export.mjs` | `node run-an-export.mjs <module file> <export>`: calls `fn(input, { door })` with the run's input and prints `{ result }` or `{ error }`. The door opens on first use, so a function that reads no records needs none. |
| `test/fake-door.mjs` | A stand-in door on loopback: records in memory, bearer and rights checks, cut pages, busy answers, event-stream answers, saved write receipts. |
| `test/run-row.mjs` | `runRow(row, input, { records })`: runs a row's argv the way the container does (`/opt/<folder>` laid on `tools/<folder>`), with the fake door on the row's descriptor and exactly the row's rights. |
| `test/records-door.test.mjs` | The client and the driver against the fake door. |

## Dependencies

**Depends on:** nothing outside Node.

**Depended on by:** `tools/saved-examples`, `tools/tell-the-person`, `tools/social-posts`, `tools/recently-deleted`
(their rows pack this folder, and their tests use `test/run-row.mjs`).
