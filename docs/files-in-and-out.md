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

Updated 2026-11-04 by trillion-rust #107, trillion-apps #27 and trillion-apps #21 (after trillion-rust #83 and trillion-apps #15).

1. **The person's own page reaches files.** Done in trillion-rust #83: one `owner-routes.json` row (`@namespace`,
   prefix `/files/`) and the files door's own `page_call`. `GET /work/api/files/<operation>?input=<JSON>` serves the
   door's `page.reads`, and `POST /work/api/files/<operation>` with the input as its body serves the rest. The page's
   session admits the call, and it runs through `AccountFilesDoor::call_while`, the same call an AI's key makes.
   trillion-apps #15 moved uploads, `keepText`, removing names and folder listings to it. trillion-apps #27 and
   #21 move the rest that the door answers (`web/src/workspace/files-door.mjs`):
   - transcripts, summaries, facts, previews and meeting results: `read_file_results` (a page GET), (trillion-apps #27), `read_file_results_many`, `record_file_results`, `merge_file_result`
   - a file by its name or identity: `find_file`
   - text and small JSON files: `read_file`, one 256 KiB window at a time
   - saving an edit list: `write_file`
   - Delete and Archive from Files and Media, and Put back: `set_aside` / `put_back` by name, every page of a folder.
     The door keeps one set-aside tree, so Delete and Archive differ only in their words for now.
2. **Recent files and kept file facts are account rows.** trillion-rust #83 ports old `src/recent-files.mjs` one to
   one (`@account-files/recent/files`, `@account-files/recent/order`; `recent_files`, `record_file_use`).
   trillion-rust #107 removes the separate `@account-files/facts` rows: `set_file_facts` is now the results merge
   of kind `facts` in the one results owner (`src/account_files/results.rs`), and `read_file_results` with kind
   `facts` reads them, as old `src/file-tools.mjs:135` merged them into `src/namespace-results.mjs:424`. An AI's
   facts and the page's facts are one value.
3. **Still open: these page calls name routes the engine does not answer.** Each needs an owner first. None is a
   rename.
   - Media shown by address (`<img>`, `<video>`, `<audio>` with HTTP Range, and `bytesAddress` in
     `file-picture.ts`, `file-screen.tsx`, `chat-records.ts`, `shared-before.tsx`, `screen-view.tsx` and the media
     editor's panels). The door answers JSON windows only, and `share_file` needs a delivery owner that this
     computer does not have yet.
   - A recording still being made (`growingFiles`, length not known) and saved text versions
     (`saveTextVersion`). The door's `write_file_start` needs `byte_length` up front.
   - Leases (`/work/api/namespace/leases` in `upload.ts`, `tool-screen.tsx`, `community-screen.tsx`,
     `screen-view.tsx`).
   - Recently Deleted's listing with days left, keep-for, storage and release rules
     (`recently-deleted-screen.tsx`, `storage-release-panel.tsx`), file tidy (`file-tidy-screen.tsx`, a Workshop
     feature), and preview making (`made-previews.ts`).
   - This tool's `do-work/namespace-client.mjs` is still the hosted service's client, for programs on a computer.
4. **The live read-back** of a file put in and taken out through the person's page, against a synthetic account on
   a computer (for example `https://place-fsn1.gettrillion.ai`), was not run from the cloud session. Its network
   proxy refuses that host (`CONNECT tunnel failed, response 403`). The same steps run in trillion-rust
   `tests/local_workspace/files_page.rs`
   (`the_page_puts_a_file_in_in_pieces_lists_it_reads_a_range_back_and_removes_it`).
