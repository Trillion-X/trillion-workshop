# tools/show-records-grouped-as-a-list/

Browse groups: projects records described by data (fields, filters, relationships, labels, actions) into a list surface and turns a data-described action into one request for the owner of that action. `read-data/read-record-projection.mjs` folds a descriptor over records into a snapshot, `read-data/maintained-projection.mjs` keeps one projection current from upsert and delete events (a deleted record that comes back is shown again), `do-work/invoke-record-action.mjs` builds the request and hands it to a sender the caller supplies, `do-work/read-process-session-proof.mjs` reads proof records of a process session without running one. Package words (open, invite, request, a group name) are descriptor data in `data/` and fixtures; the code reads paths and passes values through. The package's three tests pass here (`node --test tests/*.test.mjs`).

## Files

| File | Purpose |
|------|---------|
| `data/record-projection-descriptors.json` | Data the package carried as written. |
| `do-work/README.md` | The package's own note, moved as written. |
| `do-work/invoke-record-action.mjs` | The package's code, moved as written. |
| `do-work/read-process-session-proof.mjs` | The package's code, moved as written. |
| `fixtures/record-projection-fixtures.json` | Data the package carried as written. |
| `from-bitfield-packages/README.md` | The package's own note, moved as written. |
| `read-data/README.md` | The package's own note, moved as written. |
| `read-data/maintained-projection.mjs` | The package's code, moved as written. |
| `read-data/read-record-projection.mjs` | The package's code, moved as written. |
| `tests/README.md` | The package's own note, moved as written. |
| `tests/action-adapter.test.mjs` | The package's code, moved as written. |
| `tests/boundary.test.mjs` | The package's code, moved as written. |
| `tests/projection.test.mjs` | The package's code, moved as written. |
| `things-to-store-and-run.json` | Data the package carried as written. |
| `moved-from.json` | Where each file came from: source path and commit in bitfield-packages, the identity of its source bytes and of its bytes here, the call rows applied, the held tests and the files that still call the retired runtime. |
| `part.json` | Nothing here is imported by this tree; the folder is a part another tree imports. |
| `README.md` | This file |

The original package README is kept at `from-bitfield-packages/README.md`.

## Dependencies

**Depends on:** `tools/keep-lists-of-rows` (the visual-database read model), the shared ui parts of the web client, Node 24.

**Depended on by:** nothing yet; a tool row and its screen wiring come once the held calls are swapped.
