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
| `groups` / `groups_from` | Groups by hand (`{ id, owner: [globs], to }`), or one per row of an owner index that names a destination (`index`, `rows`, `owner`, `to`, `label`). |
| `keep` | Globs that stay in the source. A group that owns or imports one is held, with the file named. |
| `read_as_rows` | Globs of content that becomes rows of the person's own lists (moved there separately, not by this tool). A moved file that imports one is not held for it: the content is not followed, moved or deleted, the moved file keeps its import as written, and the plan names it under the group's `reads_rows` and the file's `reads_rows` (the receipt keeps them too). Once adapted, the moved file takes those rows from its caller. A file in both `keep` and `read_as_rows` is read as rows. |
| `provider_calls` | Patterns that must not be left in a moved file. A group with one left is held, with file and line. |
| `not_provider_calls` | `{ file, id, found, why }`: a detector match that is no provider call (a parameter named `env` that holds the process environment, say), by the source file, the detector and the exact matched text. That match holds nothing; every other match still does. |
| `calls` | `{ id, find, replace, means }`: a provider call swapped for the call the records door offers. |

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
  holds byte for byte), how its imports change and which calls are swapped. And the source files that stay and import a
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

## Files

| File | Purpose |
|------|---------|
| `do-work/move-code.mjs` | `tool:move-code-between-trees`: the request, the three steps, refusals in words. |
| `read-data/code-tree.mjs` | A tree read at one commit from git's objects; owner globs. |
| `read-data/imports.mjs` | The module requests in a file (with their places), resolving them, writing one from another place. |
| `read-data/plan-move.mjs` | The plan. |
| `read-data/swap-calls.mjs` | Call rows and provider detectors. |
| `read-data/apply-move.mjs` | Carrying out a plan; receipts; owner rows. |
| `read-data/check-move.mjs` | The proof from receipts. |
| `move-rows/` | One row per pair of trees. |
| `test/move-code.test.mjs` | Two made-up trees in throwaway git repositories: placement, holds, swaps, apply, a lane that moves some groups, check, and a changed byte caught. |

## Dependencies

**Depends on:** `tools/content-identity` (BLAKE3 identities), git, Node.

**Depended on by:** `tool-rows.json`; the lanes that move the old app's features here.
