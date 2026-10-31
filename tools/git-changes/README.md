# tools/git-changes/

See and commit the changes in a project folder on the person's own computer: which files changed and where each stands (staged for the next commit, changed but not staged, or new), how one file differs from the last commit, choosing files for the next commit, taking them out again, and committing what is chosen. It runs on the person's Mac as `computer` rows. They hold one capability, `use-git-in-a-folder`, and only while the person has granted it for one folder. Nothing is sent anywhere: there is no push, pull, fetch, branch change or reset.

## Files

| File | Purpose |
|------|---------|
| `read-data/git-changes.mjs` | `seeChangesInAProject`, `seeAFilesChange`, `stageChanges`, `unstageChanges` and `commitChanges`, run by `tools/records-door`'s `run-an-export.mjs`. Also `renderArgv` (a command template as its argument list), `parsePorcelain` and `parseBranchHeader` (the reading of `git status --porcelain --branch`) and `startGit`. Ported from the old git-worktree package's two process scripts. |
| `read-data/git-commands.json` | DATA: the five git commands as templates, the settings every command starts with (`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`), the time limit and the most output returned. |
| `tool-rows.json` | `tool:see-changes-in-a-project`, `tool:see-a-files-change`, `tool:stage-changes`, `tool:unstage-changes` and `tool:commit-changes`. All `computer` rows with `capabilities: ["use-git-in-a-folder"]`; each takes `folder`. |
| `part.json` | Nothing here is imported by other code. |
| `test/git-changes.test.mjs` | Templates, the reading of status lines, all five tools against a real git in a throwaway folder with made-up files and a made-up author, the refusals, the output bound and the rows. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `renderArgv` | `(template, project, input) => string[]` | A string is an argument as it is; `{ from: 'project' \| 'input', path, spread? }` is a value from the granted project or the input, a list spread into many arguments. Empty values are dropped. |
| `parsePorcelain` | `(stdout) => { branch, ahead, behind, changes[{ file_path, bucket, status }] }` | A file staged and changed again appears in both buckets. Staged first, then unstaged, then untracked, each in name order. |
| change row | `{ file_path, bucket: 'staged' \| 'unstaged' \| 'untracked', status }` | `status` is git's one letter (`M`, `A`, `D`, `R`, `?`). |
| function deps | `fn(input, context, { git? })` | A test or a caller may hand in its own `git(argv)`; the tools use it in place of starting git. |

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library, and the `git` command on the computer.

**Depended on by:** `tool-rows.json`. The local engine runs the rows on the person's computer (`computer` kind) after the person grants `use-git-in-a-folder` for a folder.

## Invariants

- Git is started with a list of arguments, never through a shell, and always as `git -C <folder>`; a file name or a message that begins with a dash is data (`--` before file names, `-m` before the message).
- Git is told its folder by `-C` alone: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the other settings that point git at a repository (`drop_env` in the DATA) are taken out of its environment, so a caller's own repository is never the one changed.
- `folder` must be a full path. Which folders the run can reach is the person's grant, not this code.
- A refusal from git comes back in git's own words (the last 8,192 characters), and output past 4,000,000 characters is refused rather than cut.
- Credentials, remotes and hooks are the person's own git settings; this folder reads and writes none of them.

## Capability this folder needs

`use-git-in-a-folder` is not yet a row in the engine's `product/computer-capabilities.json`. It is a folder-parameter capability like `change-a-folder`: it grants the files in the one folder (read and write, since staging and committing write `.git`) and the right to start git. Until that row exists a run that names it is refused before anything starts.
