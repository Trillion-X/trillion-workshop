# tools/free-what-the-list-says-can-be-got-back/

Checks a person's list of local files and folders and their listed ways back, then moves eligible paths to recoverable macOS Trash only when `dry_run: false`. The default dry run moves nothing. It never permanently deletes files or empties Trash. A move to Trash does not establish that physical disk space was freed.

## Existing owner and source preservation

The connected-drive owner, `tools/work-on-connected-drives/read-data/file-transfer.mjs`, already uses `/usr/bin/trash` for recoverable moves after checking copies. This tool reuses that native API with its own list eligibility checks; it adds no dependency or parallel Trash store. The local-files README names a native Trash action, but the named TypeScript file is absent in this checkout. The old Trillion `origin/main` source search did not expose another local Trash implementation in `src`, `parts`, `computer`, `macos`, `records` or `scripts`.

This repair adopts a stopped, untracked prototype. Its original seven files were preserved as native Git blobs before editing (listed in file order below): README `fdecfd15c557e6a8b287acd7502263bbab5290c9`, tool rows `09a2954f8ddb760b47d7dc70d82315e0126b4c1d`, part `17420f1a1d84810c9e157abde2947cb29a17fbfc`, kept-file shape `0a282c63634495e23afc52abee1b3f6f43b262b5`, URL checks `1b6e755eb977841269b4410524f93d5de1d6465c`, source `ad974d0c71cd0f9f6503b3a1f330b85d63ab06f2`, tests `2709739b566c081bad5c5f442bebc5823b41d4a7`. These are Git object IDs, not new content identities. The original prototype permanently deleted eligible paths; the repair changes disposal and its result words while retaining the opposing eligibility checks. This source preservation does not establish the prototype's original authorship or independent qualification.

The adopting checkout retains those original objects through local `refs/proposals/free-files-before-recoverable-disposal/{readme,tool-rows,part,kept-file-shape,url-checks,source,tests}` refs. They preserve the original source bytes without staging foreign changes or resetting the working tree; they are not a product deployment or a public provenance claim.

## Files

| File | Purpose |
|------|---------|
| `do-work/free-what-the-list-says-can-be-got-back.mjs` | `tool:free-what-the-list-says-can-be-got-back`: the granted folder in argv, `{ rows, dry_run?, shape? }` on standard input, `{ result }` or `{ error }` on the last line. |
| `read-data/kept-file-shape.json` | DATA: the list's field names (path, state, kind, frees, hold, source addresses, recipe files), its state words and the quiet hours. |
| `read-data/url-checks.json` | DATA: how a source is asked whether it still answers (a video address is asked through its oEmbed, because a removed video still serves a page). |
| `part.json` | Nothing is public. |
| `tool-rows.json` | The row. It runs on the person's computer with the `change-a-folder` grant and internet (to ask the sources). |
| `test/free.test.mjs` | Synthetic repositories and files only: eligibility refusals, dry run, denied and ineffective moves, source replacement, destination collision, recoverable move/readback, the native Trash command and CLI contract. Fixture cleanup also uses native Trash. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `run` | `(folder, { rows, dry_run?, shape? }, deps?) -> { dry_run, rows[], eligible_count, eligible_path_bytes, trashed_count, trashed_path_bytes, freed_bytes: null }` | Checks eligibility separately from disposal. A failed move returns no `next_value`. |
| `judgeRow` | `(row, { folder, shape, now?, answers? }) -> { id, free, reason?, bytes, path? }` | One row's verdict; a row stays with a reason unless every check holds. |
| `movePathToTrash` | `(path)` | Asks `/usr/bin/trash -s` for a native recoverable move and checks the old path is absent. Never permanently deletes or chooses/overwrites a Trash destination itself. |

## Rules

A row is eligible only when its state is the saved word, no hold is written, `frees` is `file` or `folder` (a `none` row describes a group), its regular file or folder is inside the grant, the path is not a link, git tracks nothing under it, at least one listed source or recipe exists and every listed check passes, and nothing under it changed in the quiet hours. Source and descendant metadata are compared before/after asynchronous checks and immediately before disposal. Changes, denials and missing paths stay with reasons. This is not an atomic lock against another process changing a path during the native move.

A source answering is an availability check, not proof that it still supplies identical, complete bytes. Recipe checks establish tracked, unchanged and pushed files, not a successful reconstruction. Those original checks are retained without claiming a recovery-byte proof. Native Trash supplies the immediate recovery path.

Only a confirmed move returns `trashed: true` and `next_value` with `states.trashed` (default `Mac copy moved to Trash`). The caller owns list writeback. `path_bytes`, `eligible_path_bytes` and `trashed_path_bytes` describe observed path allocation (`blocks * 512`), with possible hard-link/shared-block overlap; they are not bytes reclaimed. A refused path has `path_bytes: null`, rather than repeating an unverified byte count from its list row. `freed_bytes` is always `null` because actual physical space reclaimed is unmeasured. The old `free`/`freed` result names were replaced in this unqualified prototype to avoid asserting a disk-space result.

## Runtime boundary

The descriptor retains only `change-a-folder`. The current native sandbox owner is `trillion-rust/crates/computer-sandbox-sbpl/computer-capabilities.json`; that capability permits file access inside the granted folder. A native Trash move can require a destination or service outside it. This tool does not add a broad grant, bypass the sandbox or fall back to deletion. A denial is a disposal failure, independently of eligibility. Source tests and an uncontained synthetic native move do not establish installation, publication, permission for a real user-file operation or successful contained customer use.

On this Mac on 2026-11-07, the focused tests used that owner's actual base and `change-a-folder` DATA (provided as `TRASH_PROOF_SANDBOX_DATA`) with canonical synthetic paths. Reading the source with `/bin/cat` under the same profile succeeded; `/usr/bin/trash -s` returned status 5, Cocoa error 513 and underlying access-denied error -5000, leaving the source bytes intact. A synthetic run outside that profile succeeded through the real runner. This establishes a contained native permission boundary to repair in the existing sandbox owner; it does not establish a customer Trash operation. No sandbox policy was changed.

## Dependencies

**Depends on:** Node's own modules, `git`, and macOS `/usr/bin/trash`. **Depended on by:** `tool-rows.json`.
