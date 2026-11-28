# tools/keep-tool-copies-in-step/

`tool:keep-tool-copies-in-step` keeps the tool folders a project copied (with `tool:add-a-tool-to-a-project`, each at
the place its record line names, `at`) in step with where they came from. It reads the project from a clone it keeps itself in its own state folder, fetched from the project's
repository address (`repo`) at the tip of its branch (`main` unless `branch` names another); no working checkout of the
project, and no deploy folder, is ever read or written. The record is the project's one `where-each-tool-comes-from.json`,
found in the tip's file list wherever it is (the add tool's `recordPlaceIn`; two are refused). For each of its lines it
compares three versions of the folder, offers each upstream change to the project
as one branch `sync/upstream/<record line>/<upstream commit>`, refuses conflicts with their diff, and skips forks. It
never merges, never fast-forwards and never pushes any other ref. `workflow:keep-tool-copies-in-step` runs it when a push
fact arrives, and once a day.

## The three versions

| Name | What it is | Where it is read |
|---|---|---|
| base (b) | the files the copy started from | the record line's `files` (hashes) and, for a file changed on both sides, its bytes fetched at `copied_at_commit` |
| project (l) | the copy now | the tool's folder at the tip of the project's branch, in the tool's own clone (`<state>/projects/<repo>-<id>`: a depth-1, blob-less fetch and a sparse checkout of only the record and each line's `at`) |
| upstream (u) | the source now | the folder at the commit the registry's pointer names now (`paths` only, when the pointer names them), checked against the pointer's `files_blake3`; for a direct `{repo, path, commit}` line, the repository's HEAD |

## The algebra (read-data/classify.ts)

Per file, in this order:

| b / l / u | Verdict | What apply does |
|---|---|---|
| l == u (both absent included) | `same` | nothing |
| u == b, l != b | `project-only` (`deleted-project` when l is absent) | nothing: the project's change stays in the project, and nothing is pushed |
| l == b, u != b | `upstream-only` (`deleted-upstream` when u is absent) | upstream's bytes (or the deletion) in the project branch |
| all present and different | `both-clean` when `git merge-file -p` exits 0, else `both-conflict`; a NUL byte on any side: `both-conflict`, never merged | the merge in the project branch |
| one absent, the others different | `both-conflict` | nothing |
| a path gone on one side, its exact bytes arrived at one new path on the same side, the other side touching neither | `renamed-project` / `renamed-upstream` on both paths | an upstream rename is made on the project branch; a project rename stays in the project |
| one base file renamed to two different paths, one per side | `both-conflict` on all three paths | nothing |

The tool's state is the strongest over its files: `both-conflict` > `both-clean` (also: different files changed on each
side) > `project-only` > `upstream-only` > `none-changed`. Every file `same` while the base differs (both sides made the
same change) is `upstream-only`: the record advances and no file moves. A line with `synced: false` is `forked` and is
not read at all (no registry read, no fetch, no file read). A `made-here` line is `skipped`.

A change in a needed tool is an upstream change of the tool that needs it. Its `closure_blake3` (the identity the add tool
makes over every folder it reaches through `needs_tools`) is made again over the upstream versions; when it differs, the
plan names `closure: {recorded, upstream}` and a tool whose own files are all `none-changed` is `upstream-only`. It moves
on the branch of the first needed tool that moves, and is refused `needs-not-settled` when none of them moves.

A pointer's `paths` bound what upstream is. Only those files are fetched and compared, so a file outside them is never
brought, and a file the pointer drops is `deleted-upstream` and goes from the branch; it is never added again. A file the
project dropped while its pointer still names it is `deleted-project`: the project's own change, which stays.

A record line whose `files` do not hash to its `copied_at_files_blake3` was edited by hand. It is `local-edit`: no
registry read and no fetch is made for it, it is never used as the version a copy started from, and `apply` reports it in
`refused`. Adding the tool again writes a true line.

## Invariants

- Nothing a person wrote is overwritten. A tool with any `both-conflict` file is left byte for byte as it was, the files
  that would have merged cleanly included, and each conflicting file is answered with its unified diff (base to project,
  then base to upstream). git's conflict-marked output is never written or answered.
- A three-way-different file is decided from the base bytes, never from hashes alone. A base that cannot be fetched, or
  whose bytes are not what the record names, makes the file a conflict.
- `apply` re-reads everything. The record must still have the BLAKE3 identity `plan` read (else
  `record-changed-meanwhile`), and every tool must still be what `plan` found (else `changed-since-plan`).
- Branches only. The one push the tool makes goes through `pushSyncBranch`, which refuses every ref but
  `refs/heads/sync/upstream/<record line>/<40-hex upstream commit>` before git starts (`ref-refused`): never `main`,
  a deploy branch, a tag or any other branch. It never force-pushes, never fast-forwards and never merges. Each upstream change
  is one commit on the tip of the project's branch holding the tool's files and its advanced record line (the record text
  made by the add tool's `writeProjectRecord`), with author, committer, message and times fixed by that tip, so the same
  change on the same tip is the same commit. It is pushed without force; a branch of that name holding another commit (the
  project's branch moved since) is answered `push-refused` with git's words.
- A pull request is opened only for a branch the push created, read from that push's own answer (`git push --porcelain`:
  `*` new, `=` already there), never from a read made before it. No GitHub key bound to api.github.com is held, so a
  created branch is answered `would_open: true` and `gap` names it. Two runs of one change make one branch and one
  `would_open`. Who merges a branch is the project's owner; trust and auto-merge belong to the pull request.
- A branch's line advances to exactly the upstream version it was compared with (`copied_at_commit`,
  `copied_at_files_blake3`, `files`; `from.commit` too for a direct line), and `closure_blake3` is made again for every line
  that reaches it. A tool with a conflict gets no branch.
- Project changes stay in the project (`project_only`); nothing is pushed for them.
- Fetch, hash and record code is the add tool's (`../add-a-tool-to-a-project/read-data/`), imported, never copied. A local
  clone named in `clones` (inside the state folder) that holds a commit is read instead of the network, as the add tool
  reads it; the bytes and identities are the same either way. The record names a registry only by its address (the add
  tool records a local registry as its git origin address), so a registry is read from the clone in `clones` whose origin
  is that address, else fetched from it. A record line written before that change names its registry by a folder path;
  readRegistry reads it only when the folder's git origin is an address, and otherwise the line is refused (`bad-from`)
  with words that name the one-time rewrite of its registry fields.

## How it runs

```
node do-work/sync.ts STATE-FOLDER < {"op":"plan","repo":"https://github.com/OWNER/PROJECT.git","only":["screen-look"],"fact":{...},"clones":["a-clone-in-the-state-folder"]}
node do-work/sync.ts STATE-FOLDER < {"op":"apply","repo":"https://github.com/OWNER/PROJECT.git","plan":<plan's answer>}
```

The state folder is the tool's own: it holds `projects/<repo>-<id>`, the clone of each project it keeps, and nothing else.
The run needs that folder read and written, the system's git, and the network to the project's and the sources' git
hosts. `plan` answers `{record_blake3, because?, tools: {name: {state, files, upstream_commit, renames?, why?, said?,
closure?}}}` and writes nothing but its own clone. `apply` answers `{forked, conflicts: [{tool, path, diff}], unchanged,
project_only, waiting: [{tools, branch, commit, created, would_open, pull_request}], gap?, skipped: [{tool, why}],
refused: [{tool, why, said}]}`. A conflict is an answer (exit 0); exit 2 means the tool could not run.

Refusals (`why`): `not-in-registry`, `bad-from`, `fetch-refused`, `identity-mismatch`, `no-base`,
`record-changed-meanwhile`, `changed-since-plan`, `push-refused`, `ref-refused`, `local-edit`, `needs-not-settled`;
`made-here` for a skipped line.

## Checked against land_paths

`read-data/golden-cases.json` holds 20 cases, each one tool folder's base, project and upstream files as text, the verdicts
this tool must give, and `land_paths`: the tree ai-command-center's `land_paths.merged_tree` made of the same three trees
(landing = project, origin = upstream), or `conflict`. It was run once by hand on Nov 28 2026 (land_paths.py at
ai-command-center 26d377df7a): from ai-command-center's hook library folder,
`PYTHONPATH=. python3 land-paths-compare.py golden-cases.json`, a script that makes a git repo per case with the base, landing
and origin commits, calls `land_paths.merged_tree(repo, base, landing, origin, ["t/"], set())` and records the merged
tree's files (a `SystemExit` is `conflict`). 19 of 20 cases settle to land_paths' exact tree; the one that differs is
marked `differs_from_land_paths`: both sides renamed one file to different names, which land_paths keeps as two copies
and this tool refuses as a conflict. `test/golden.test.ts` holds every case to that record.

## Files

| File | Purpose |
|---|---|
| `do-work/sync.ts` | `plan(input)`, `apply(input)`, the CLI |
| `read-data/classify.ts` | `classifyFile`, `classifyTool`: the algebra, no I/O |
| `read-data/merge-text.ts` | `mergeText` (git merge-file -p), `threeWayDiff` |
| `read-data/golden-cases.json` | the state table and land_paths' result for each case |
| `test/*.test.ts` | `node --import ./test-helpers/own-tmpdir.mjs --test tools/keep-tool-copies-in-step/test/*.test.ts` |
