# Files in and out of Trillion through the Workshop

Checked 2026-11-04 against old trillion main `6eeb746`, trillion-rust main `27488fb` and trillion-workshop main
`f5c02c0`. This note covers the three capability rows about the person's files. It says where each one's code is now,
and which side of the door is missing when a tool asks for files.

## The three rows

| Row (old trillion `capabilities.json`) | Where its code is | Decision |
|---|---|---|
| browse, upload, open, rename, move and delete my files and folders | `tools/browse-and-upload-my-files` (moved by #76) | Done. Its control transport still points at the hosted `/mcp/api` service (`do-work/namespace-client.mjs:27`), which is paused. See "What is still open". |
| show my Trillion files in Finder and let any app read exact byte ranges of them without copying the file first (`moves_to: tools/show-my-files-in-finder`) | Deleted in old trillion `3d6dc7f9` (2026-10-30): the File Provider and FSKit extensions (Swift) and the Drive they read from on `127.0.0.1:7383`. Every list and byte read was HTTP to that Drive, and the Drive's only upstream was the paused hosted origin. | Not moved. There is nothing runnable left to move, and the commit says a Finder integration comes back later as a File Provider over the local door. Carrying the Swift over would bring back a client with nothing to talk to. Byte ranges are already served: `read_file {name_or_identity, offset, length}` at the files door. |
| let my AI find, list, read, write, send in pieces and show my files, with the most recent ones and the facts kept about each (`src/file-tools.mjs`, no `moves_to`) | Deleted in old trillion `4ffa1dc4` (2026-11-03), with the hosted Worker it ran in. Its 43 tool definitions call the Worker's own routes (`/namespace/file/lookup`, `/namespace/contents/read`, `/namespace/growing/<id>`, `/looks/page`) and the Worker's person store (SQLite tables such as `recent_file_uses`). | Not moved as a module. The engine's account files door now answers the core of this row natively, for every AI at the door: `list_files`, `find_file`, `read_file`, `write_file`, `write_file_start` / `_piece` / `_finish` / `_cancel` (send in pieces), `show_file`, `files_summary`, `search`, `set_aside`, `put_back`, `list_set_aside`, `move_names`, `copy_names` (trillion-rust `src/account_files/account-files-door.json`). The recent-files list and the kept file facts have no owner yet. See "What is still open". |

## The `@own-files` refusal

No door has an address named `@own-files`. Neither repository mentions it. The engine's files resource is
`@namespace` (trillion-rust `src/account_files/account-files-door.json`, `"resource": "@namespace"`). A sign-in is
granted `("@namespace", "*")` (trillion-rust `src/account/sign_in.rs:112`).

A Workshop tool run already gets a files door. The engine has nothing to add, and the tool side needs no new
address:

- A row declares a files right inside its records declaration: `"records": { "fd": 3, "rights": [{ "files": "/" |
  "/<folder>/", "operations": [...] }] }` (trillion-rust `src/account_rights/run_capability.rs:206`).
- The run's descriptor then carries `files_resource` (`run_capability.rs:656`).
- `tools/records-door` reads it (`read-data/records-door.mjs:68`), and `door.files(operation, input)` calls the
  files door (`tools/records-door/README.md`).
- Rows already doing this include `documents-as-list-rows`, `meaning-search`, `print-here`, `social-posts`,
  `take-payments`, `work-on-connected-drives` and `write-public-share-files`.

So the refusal came from the tool side asking for an address that does not exist. A tool that needs the person's
files declares a `files` rights item and calls `door.files(...)`. No engine change and no new door is needed.

## What a person outside the Mac can do with a file today

- **Through their AI**: an AI signed in to the person's door (at any computer that can reach it) calls
  `run_resource_operation` at `@namespace`. It can put a file in with `write_file` (small) or
  `write_file_start` / `write_file_piece` / `write_file_finish` (any size, in pieces), and get one out with
  `read_file` (exact byte ranges) or `show_file`.
- **Through a Workshop tool**: any row that declares a `files` right does the same within the folder it names.

## What is still open

1. **The person's own page has no route to files.** The page routes under `/work/api` are `@workshop-tools`
   and `@own-records` (GET) only (trillion-rust `src/server/owner-routes.json`). So the screen in
   `tools/browse-and-upload-my-files`, run in a browser, cannot reach `@namespace`. It still targets the hosted
   `/mcp/api`. Fixing this means one generic page-route family for the files door, owned by the engine (a new
   `owner-routes.json` row needs an owner the workspace executor mounts). It belongs in its own trillion-rust change.
2. **Recent files and kept file facts** (`recent_files`, `record_file_use`, `read_file_results`, `set_file_facts`)
   lived only in the Worker's person store, which has been deleted. Old trillion `4ffa1dc4^:src/recent-files.mjs`
   is store-shaped (`sql.exec` over a `recent_file_uses` table). It can be moved as a Workshop tool over the records
   door (one record kind for uses, one for facts) once that record kind is named. Until then no owner answers these
   four calls.
