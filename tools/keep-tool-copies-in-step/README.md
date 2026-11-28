# tools/keep-tool-copies-in-step/

`tool:keep-tool-copies-in-step` keeps the tool folders a project copied into its own tools folder (with
`tool:add-a-tool-to-a-project`, whose `read-data/record.ts` names the folder once as `TOOLS_FOLDER`) in step with where
they came from. For each line of the folder's record `where-each-tool-comes-from.json` it compares three versions of the folder and settles the safe cases: it brings
upstream changes to the project as a branch (merged on its own only for a trusted source whose project tests pass),
offers the project's changes upstream (through the source's landing owner, or on a review branch), refuses conflicts
with their diff, and skips forks. `workflow:keep-tool-copies-in-step` runs it when a push fact arrives.

## The three versions

| Name | What it is | Where it is read |
|---|---|---|
| base (b) | the files the copy started from | the record line's `files` (hashes) and, for a file changed on both sides, its bytes fetched at `copied_at_commit` |
| project (l) | the copy now | the files git lists in the tool's folder (tracked, or new and not ignored); every regular file when the project is not a git checkout |
| upstream (u) | the source now | the folder at the commit the registry's pointer names now (`paths` only, when the pointer names them), checked against the pointer's `files_blake3`; for a direct `{repo, path, commit}` line, the repository's HEAD |

## The algebra (read-data/classify.ts)

Per file, in this order:

| b / l / u | Verdict | What apply does |
|---|---|---|
| l == u (both absent included) | `same` | nothing |
| u == b, l != b | `project-only` (`deleted-project` when l is absent) | offered upstream; the project is not touched |
| l == b, u != b | `upstream-only` (`deleted-upstream` when u is absent) | upstream's bytes (or the deletion) in the project branch |
| all present and different | `both-clean` when `git merge-file -p` exits 0, else `both-conflict`; a NUL byte on any side: `both-conflict`, never merged | the merge in the project branch, and offered upstream |
| one absent, the others different | `both-conflict` | nothing |
| a path gone on one side, its exact bytes arrived at one new path on the same side, the other side touching neither | `renamed-project` / `renamed-upstream` on both paths | moved on the other side |
| one base file renamed to two different paths, one per side | `both-conflict` on all three paths | nothing |

The tool's state is the strongest over its files: `both-conflict` > `both-clean` (also: different files changed on each
side) > `project-only` > `upstream-only` > `none-changed`. Every file `same` while the base differs (both sides made the
same change) is `upstream-only`: the record advances and no file moves. A line with `synced: false` is `forked` and is
not read at all (no registry read, no fetch, no file read). A `made-here` line is `skipped`.

## Invariants

- Nothing a person wrote is overwritten. A tool with any `both-conflict` file is left byte for byte as it was, the files
  that would have merged cleanly included, and each conflicting file is answered with its unified diff (base to project,
  then base to upstream). git's conflict-marked output is never written or answered.
- A three-way-different file is decided from the base bytes, never from hashes alone. A base that cannot be fetched, or
  whose bytes are not what the record names, makes the file a conflict.
- `apply` re-reads everything. The record must still have the BLAKE3 identity `plan` read (else
  `record-changed-meanwhile`), and every tool must still be what `plan` found (else `changed-since-plan`).
- An upstream change never goes straight into the project's files (plan B4). The project must be a git checkout whose
  record is committed. Each change is one commit on the project's HEAD holding the tool's files and its advanced record
  line (the record text made by the add tool's `writeProjectRecord`), kept as a branch with a compare-and-set on its ref,
  and pushed to the project's `origin` with a lease when it has one. Sources whose owner (read from the repository
  address: `github.com/OWNER/...`, `git@host:OWNER/...`) is in the record's `"trust": [...]` list share one branch,
  `sync/upstream/trusted`; it is merged with `git merge --ff-only` only when the record's `"test": [words]` exits 0 on an
  export of that commit, and git refuses the merge if HEAD or those files moved. Every other source waits on
  `sync/upstream/<tool>` for the project's owner. `waiting` answers each branch and why: `not-trusted`,
  `no-test-command`, `tests-not-green`, `project-moved`. A pull request needs a GitHub key; while none bound to
  api.github.com is held, `gap` names that and no pull request is opened.
- A settled tool's line advances to exactly the upstream version it was compared with (`copied_at_commit`,
  `copied_at_files_blake3`, `files`; `from.commit` too for a direct line), and `closure_blake3` is made again for every line
  that reaches it. A tool with a conflict keeps its line.
- A project change goes upstream through the source's own landing owner when `land_through` names one for that
  repository on this computer (for the Workshop checkout: `land_paths.py`, whose queue three-way merges it onto main):
  its words, then `--lane`, `--message-file` and one `--edit PATH=cat FILE` or `--remove PATH` per file; the landed commit
  is read from its answer. Any other repository gets the change only as branch `sync/<project>/<tool>` (`<project>` is the project folder's name), a commit made on
  the upstream commit with the changed files, pushed with `--force-with-lease=<ref>:<sha read just before>` and
  `push.negotiate`, so only the changed objects are sent. A default branch is never pushed. The commit's author, committer,
  message and times are fixed by its parent, so offering the same change again makes the same commit and pushes nothing
  (`already: true`).
- Fetch, hash and record code is the add tool's (`../add-a-tool-to-a-project/read-data/`), imported, never copied. A local
  clone named in `clones` (inside the granted folder) that holds a commit is read instead of the network, as the add tool
  reads it; the bytes and identities are the same either way. The record names a registry only by its address (the add
  tool records a local registry as its git origin address), so a registry is read from the clone in `clones` whose origin
  is that address, else fetched from it. A record line written before that change names its registry by a folder path;
  readRegistry reads it only when the folder's git origin is an address, and otherwise the line is refused (`bad-from`)
  with words that name the one-time rewrite of its registry fields. A push still goes to the pointer's repository address.

## How it runs

```
node do-work/sync.ts GRANTED-FOLDER < {"op":"plan","project":".","only":["screen-look"],"fact":{...},"clones":["the-workshop-clone"]}
node do-work/sync.ts GRANTED-FOLDER < {"op":"apply","project":".","plan":<plan's answer>,"clones":["the-workshop-clone"],"land_through":[{"repo":"...","command":["python3","land_paths.py","--repo","..."]}]}
```

It runs on the person's computer under the capability `use-git-in-a-folder` (the granted folder, read and written, and the
system's git, which every step here runs); `change-a-folder` alone gives no git, so a sandboxed run could not fetch or merge.

`plan` answers `{record_blake3, because?, tools: {name: {state, files, upstream_commit, renames?, why?, said?}}}` and
writes nothing. `apply` answers `{settled, forked, conflicts: [{tool, path, diff}], unchanged, pushed: [{tool, repo,
branch, commit, already, landed_by?}], waiting: [{tools, branch, commit, why, said, pull_request}], gap?, skipped: [{tool,
why}], refused: [{tool, why, said}]}`. `settled` names the tools merged into the project. A conflict is an answer (exit 0); exit 2 means
the tool could not run.

Refusals (`why`): `not-in-registry`, `bad-from`, `fetch-refused`, `identity-mismatch`, `no-base`,
`record-changed-meanwhile`, `changed-since-plan`, `push-refused`, `landing-refused`, `not-a-git-project`,
`record-not-committed`; `made-here` for a skipped line.

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
