# tools/move-code-between-trees/

Moves groups of code files from one repository to another byte for byte, with every file they import and their tests,
deletes the originals so one copy remains, and proves the moved files are the same bytes and still load and pass their
tests. It is not a one-off script: a new pair of trees, a new group or a new provider call is a new row.

## The move row

Every choice is data in a move row (`move-rows/<pair>.json`):

| Field | What it says |
|-------|--------------|
| `source` | `name`, the `commit` to move from (a request's `source_commit` overrides it), `test_folders` (where tests that may move with a group live) and `owner_index` (the file whose rows name owners: rows whose files all moved leave it, `drop_fields` are removed from them). Both owner indexes keep their own layout: a staying row keeps its text, a new or changed row is written on one line the way the index's one-line rows are. |
| `destination` | `name`, `package` (the name the source imports moved files by), `shared_folder` (where a file more than one group needs is kept once) and `owner_index` (where moved rows go, and which `fields` they keep). |
| `groups` / `groups_from` | Groups by hand (`{ id, owner: [globs], to, joins_tool?, held_until?, owner_only? }`), or one per row of an owner index that names a destination (`index`, `rows`, `owner`, `to`, `label`). A `to` that is already a tool holds the group (the tool has the feature in its own shape) unless `joins_tool` says in words what the group brings that the tool does not have; its files then land inside the tool under their source path, the tool keeps its own README and rows, and a path it already holds is still refused. `held_until` holds the group in the row's own words: what must be true before it can move. `owner_only` moves just the files the owner globs name and follows no import: what they import stays where it is, the moved files keep those imports as written, and the plan and the receipt name each such file under `stays` (a screen moved out of an app shell that the shell keeps serving, say; whatever builds the moved file resolves the kept imports). |
| `keep` | Globs that stay in the source. A group that owns or imports one is held, with the file named. |
| `read_as_rows` | Globs of content that becomes rows of the person's own lists (moved there separately, not by this tool). A moved file that imports one is not held for it: the content is not followed, moved or deleted, the moved file keeps its import as written, and the plan names it under the group's `reads_rows` and the file's `reads_rows` (the receipt keeps them too). Once adapted, the moved file takes those rows from its caller. A file in both `keep` and `read_as_rows` is read as rows. |
| `homes_in_packages` | `{ from, home, source_identity }`: a source file that already has a home in a package the destination depends on (an earlier move carried it to that package's tree, and the receipt there names it). It is not followed or moved and holds nothing, even when `keep` names it; a moved file that imports it imports `home` (the package specifier) instead, and its receipt keeps the file's `homes`. The plan refuses a row whose `source_identity` is not the source file's identity at the commit. `check` resolves each home from the moved file through the installed package and proves it is the source file's bytes once import paths are set aside. |
| `adapted_homes` | `{ from, home, why }`: a source file the destination holds in another shape at `home` (an earlier lane adapted it, so it is not the same bytes once import paths are set aside). It is not followed or moved; what moves imports it at `home`, and its receipt entry says `adapted` with `why`. `check` proves `home` is there; the tests carried against it prove by their own run that the adaptation kept what they check. The plan refuses a `home` the destination does not hold. |
| `host_provides` | Package names the program that builds the moved files supplies itself (`react` for a web client's screens): the destination does not declare them and no group is held for want of one. |
| `provider_calls` | Patterns that must not be left in a moved file. A group with one left is held, with file and line. |
| `not_provider_calls` | `{ file, id, found, why }`: a detector match that is no provider call (a parameter named `env` that holds the process environment, say), by the source file, the detector and the exact matched text. That match holds nothing; every other match still does. |
| `calls` | `{ id, find, replace, means }`: a provider call swapped for the call the records door offers, or a real person's name swapped for a made-up one (a public tree holds made-up data only; `find` may match the name by its place so the receipt does not spell it). A file's receipt entry names the calls applied to it (`calls`); a data file with calls is proved against its source once they are swapped, like code. |
| `leave_tests` | `{ path, why }`: a test that moves with no group although it reaches one (a test of another tree's screens, a test that reads the source tree's own import text). |

`move-rows/trillion-to-workshop.json` moves the old Trillion app's features into this repository. Groups come from the
rows of its `capabilities.json` that name `moves_to`; sign-in, the stores and the Worker entry stay (they are engine
work, ported to Rust); KV calls swap for records door reads and writes. The opinion content (methods, the named
records, communities, cases, the content settings and the tours) is `read_as_rows`: it becomes rows of the account
owner's lists, and the logic that reads it moves here and reads those rows. `src/action-completeness.mjs` and its
policy stay with the source, whose development standard names them. A credential read from an env binding has no
call swap (the door hands credentials by handle through a row's `invoke.connection`), so such a group is held.

## Steps

One JSON request on standard input, `{ result }` or `{ error: { code, message } }` on the last line.

- `plan` changes nothing. For each group: its owner files, its import closure (relative imports and the tree's own
  `#names`, followed to the end), the tests that move with it (a test in a test folder whose every import moves), and
  every reason it is held. For each file: where it lands (its group's folder under the source's own path, so the files
  import each other as they did; or `shared_folder` when more than one group needs it; or a file the destination already
  holds byte for byte; or the file already at the place it would land, when its bytes there differ from the source's in
  import paths only; or a file an earlier move carried to another place, with the same bytes once import paths are set
  aside: what moves imports it there, and nothing reached only through it moves), how its imports change and which calls
  are swapped. A test moves with a group when every file it reaches moves, is test help, or is home already in the
  destination, so a lane that moves the last of a test's imports carries the test too. And the source files that stay and import a
  moved file: they import it from `destination.package` instead (a file read by its address,
  `new URL('<path>', import.meta.url)`, is found with `import.meta.resolve`).
- `apply` plans, then carries out the plan on both working copies. It refuses before writing anything when a source
  file differs from the commit planned at, or a destination path is taken. `apply_groups` carries out some groups only;
  shared files still land where the whole plan puts them, and a planned file that waits imports what moved from the
  package until its own lane moves it. Each destination folder gets `moved-from.json`: each file's source path and
  commit, the identity of its source bytes and its bytes here, and the call rows applied. A folder that is not a tool
  gets `part.json` `{ imported_by: [<source name>] }` and a README.
- `check` proves a move from its receipts on a clean checkout of the destination: identities match; each file's bytes
  equal its source commit's bytes once the receipt's calls are swapped and import paths are set aside; every import
  reaches the same file at its new place; the source no longer holds it (`source_after_folder`); every module loads in
  a fresh Node process (a `.tsx`/`.jsx` file is compiled when a compiler is installed); its own tests pass.

`node tools/move-code-between-trees check` from the root of a checkout needs no source tree: it judges every receipt the
checkout tracks, at any depth, from the checkout alone (`read-data/check-receipts.mjs`). A receipt is one object whose
`files` is a list; each file names `from` (or `from_path_identity` when the source path is private), the full 40-hex
`commit`, `to` (which exists) and `source_identity`; its bytes here are `identity`, or, for a file changed here after
its byte copy, `identity_at_move` are its bytes at `byte_copy_commit` (a full commit of this checkout, read from git),
with `port_contract` naming the contract in its tool's `ports/` when there is one. Every other commit a receipt records
(a `values` row's) is full too; a short `deleted_by` is a note, since no proof reads it. It prints one JSON answer and
exits 0 when every receipt is whole, 1 when not. `node tools/move-code-between-trees settle [--history <ref>]` rewrites each entry that does not say what its file is: for a file changed after its copy it names the commit that holds the bytes the receipt named (`identity_at_move` and `byte_copy_commit`), or, when no commit of the checkout ever held them, the bytes the file has now with `adapted` saying so; an entry whose file is gone is dropped (`read-data/settle-receipts.mjs`); run `check` after it. `--source <checkout>` (and `--source-after <folder>`, `--no-run`) also
runs the proof above against that tree, where a file changed after its copy is proved by its bytes at
`byte_copy_commit`.

## Files

| File | Purpose |
|------|---------|
| `do-work/move-code.mjs` | `tool:move-code-between-trees`: the request, the three steps, refusals in words. |
| `read-data/code-tree.mjs` | A tree read at one commit from git's objects; owner globs. |
| `read-data/imports.mjs` | The module requests in a file (with their places), resolving them, writing one from another place. |
| `read-data/plan-move.mjs` | The plan. |
| `read-data/swap-calls.mjs` | Call rows and provider detectors. |
| `read-data/apply-move.mjs` | Carrying out a plan; receipts; owner rows. |
| `read-data/check-move.mjs` | The proof from receipts, against the source tree. |
| `read-data/check-receipts.mjs` | Every receipt whole, judged from the destination checkout alone. |
| `read-data/settle-receipts.mjs` | Each receipt entry that does not say what its file is made to say it. |
| `index.js` | `node tools/move-code-between-trees check`: the receipts judged, and proved against `--source` when given. |
| `move-rows/` | One row per pair of trees. |
| `test/move-code.test.mjs` | Two made-up trees in throwaway git repositories: placement, holds, swaps, apply, a lane that moves some groups, check, a changed byte caught, and receipts judged with no source: a map of names, short commits, a change after the copy said and unsaid; a kept file imported from its home in a package; a data file with calls proved once they are swapped, and another change caught. |

## Dependencies

**Depends on:** `tools/content-identity` (BLAKE3 identities), git, Node.

**Depended on by:** `tool-rows.json`; the lanes that move the old app's features here.
