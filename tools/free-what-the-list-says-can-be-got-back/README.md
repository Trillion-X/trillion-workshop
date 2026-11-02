# tools/free-what-the-list-says-can-be-got-back/

Frees disk space safely. A person keeps a list whose rows say where a big file or folder is on their computer and how to get it back (a download address, a model's fetch source, or the plan files that remake it). This tool takes rows of that list, checks each way back **now**, and moves the ones that hold to the Trash. It is a dry run unless the request says `dry_run: false`.

## Search before building (the job is new)

- Capability rows (`capabilities.json`): none frees disk space or removes a person's files. Nearest by words: the Gmail row (trashes mail in a mailbox), the files screen row (deletes names in the person's Namespace), the connected-drives tool (lists a drive, removes nothing). The new row names all three in `distinct_from`.
- Code (`grep -rE "rmSync|unlinkSync|rmtree|\.Trash"` over `tools/`): only tests, a headless-browser cleanup and the speech tool's own work files. No tool removes a person's files.
- Nearest existing piece: the Mac's disk-guard (a launchd job whose script lives in agent scratch, outside every owner). It deletes stale build output and scratch only, and its header says it never touches media or sources. This tool does not change it; it is the generic route for files the person's list can get back, with the list's shape and the proof held as data.

## Files

| File | Purpose |
|------|---------|
| `do-work/free-what-the-list-says-can-be-got-back.mjs` | `tool:free-what-the-list-says-can-be-got-back`: the granted folder in argv, `{ rows, dry_run?, shape? }` on standard input, `{ result }` or `{ error }` on the last line. |
| `read-data/kept-file-shape.json` | DATA: the list's field names (path, state, kind, frees, hold, source addresses, recipe files), its state words and the quiet hours. |
| `read-data/url-checks.json` | DATA: how a source is asked whether it still answers (a video address is asked through its oEmbed, because a removed video still serves a page). |
| `part.json` | Nothing is public. |
| `tool-rows.json` | The row. It runs on the person's computer with the `change-a-folder` grant and internet (to ask the sources). |
| `test/free.test.mjs` | The rules on made-up folders, a made-up git repository with an upstream, and a stand-in source: every refusal, a dry run that moves nothing, a real run that moves, and the command run as the engine runs it. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `run` | `(folder, { rows, dry_run?, shape? }, deps?) -> { dry_run, rows[], can_free_count, can_free_bytes, freed_count, freed_bytes }` | Judges every row, and on a real run moves the freed ones. |
| `judgeRow` | `(row, { folder, shape, now?, answers? }) -> { id, free, reason?, bytes, path? }` | One row's verdict; a row stays with a reason unless every check holds. |
| `moveToTrash` | `(path) -> destination` | A same-volume rename into the Trash; never a copy, never a delete; a refused move is an error, with no fallback. |

## Rules

A row is freed only when: its state is the saved word; no hold is written; `frees` is `file` or `folder` (a `none` row describes a group); the path is inside the granted folder, is not a link, matches `file` or `folder`, and git tracks nothing under it; there is at least one proof (a source address, a fetch source or a recipe file) and all hold; nothing under it changed in the last quiet hours. Anything else stays, with the reason in the answer. Space comes back when the Trash is emptied.

## Dependencies

**Depends on:** Node's own modules and the `git` command. **Depended on by:** `tool-rows.json`.
