# tools/free-what-the-list-says-can-be-got-back/

Checks a person's list of local files and folders and their listed ways back, then moves eligible paths to recoverable macOS Trash only when `dry_run: false`. The default dry run moves nothing. It never permanently deletes files or empties Trash. A move to Trash does not establish that physical disk space was freed.

## Existing owner and source preservation

The old Trillion `computer/drive-tools/file-transfer.mjs:103` at `9b5614150bf2ff506cb296337b79af328ffc7381` already invokes recoverable native Trash after checking copies. The current physical owner is `trillion-rust/crates/computer-sandbox-sbpl/src/trash_source.rs`. This tool retains its own list eligibility checks and asks that native owner through the host action route (`workflows/read-data/host-actions.mjs`). It has no child-side Trash command or fallback.

This repair adopts a stopped, untracked prototype. Its original seven files were preserved as native Git blobs before editing (listed in file order below): README `fdecfd15c557e6a8b287acd7502263bbab5290c9`, tool rows `09a2954f8ddb760b47d7dc70d82315e0126b4c1d`, part `17420f1a1d84810c9e157abde2947cb29a17fbfc`, kept-file shape `0a282c63634495e23afc52abee1b3f6f43b262b5`, URL checks `1b6e755eb977841269b4410524f93d5de1d6465c`, source `ad974d0c71cd0f9f6503b3a1f330b85d63ab06f2`, tests `2709739b566c081bad5c5f442bebc5823b41d4a7`. These are Git object IDs, not new content identities. The original prototype permanently deleted eligible paths; the repair changes disposal and its result words while retaining the opposing eligibility checks. This source preservation does not establish the prototype's original authorship or independent qualification.

The adopting checkout retains those original objects through local `refs/proposals/free-files-before-recoverable-disposal/{readme,tool-rows,part,kept-file-shape,url-checks,source,tests}` refs. They preserve the original source bytes without staging foreign changes or resetting the working tree; they are not a product deployment or a public provenance claim.

## Files

| File | Purpose |
|------|---------|
| `do-work/free-what-the-list-says-can-be-got-back.mjs` | `tool:free-what-the-list-says-can-be-got-back`: `freeWhatTheListSays({ folder, input: { rows, dry_run?, shape? } }, context)`, run by the workflows `run-a-function` runner: the granted folder and the input on standard input, `{ result }` or `{ error }` on the last line. |
| `read-data/kept-file-shape.json` | DATA: the list's field names (path, state, kind, frees, hold, source addresses, recipe files), its state words and the quiet hours. |
| `read-data/url-checks.json` | DATA: how a source is asked whether it still answers (a video address is asked through its oEmbed, because a removed video still serves a page). |
| `part.json` | Nothing is public. |
| `what-this-tool-does-and-how-to-run-it.json` | The row. It runs on the person's computer with the `change-a-folder` grant and internet (to ask the sources). |
| `test/free.test.mjs` | Synthetic repositories, parent actions and fd3 HTTP descriptors, through the actual workflows runner: eligibility, recoverable stand-in moves/readback, refusal, unknown, busy and lost answers, and a missing grant refused. Tests and fixture cleanup never invoke real Trash. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `run` | `(folder, { rows, dry_run?, shape? }, deps?) -> { dry_run, rows[], eligible_count, eligible_path_bytes, trashed_count, trashed_path_bytes, freed_bytes: null }` | Checks eligibility separately from disposal. A failed move returns no `next_value`. |
| `judgeRow` | `(row, { folder, shape, now?, answers? }) -> { id, free, reason?, bytes, path? }` | One row's verdict; a row stays with a reason unless every check holds. |
| `host.parentActions.trashSource` | `({ path, expected_generation })` | The host action route (`workflows/read-data/host-actions.mjs`) asks the authenticated native parent once, with no retry. Only `outcome: moved` plus an absent old path produces moved-state writeback. |

## Rules

A row is eligible only when its state is the saved word, no hold is written, `frees` is `file` or `folder` (a `none` row describes a group), its regular file or folder is inside the grant, the path is not a link, git tracks nothing under it, at least one listed source or recipe exists and every listed check passes, and nothing under it changed in the quiet hours. Source and descendant metadata are compared before/after asynchronous checks and immediately before disposal. Changes, denials and missing paths stay with reasons. This is not an atomic lock against another process changing a path during the native move.

A source answering is an availability check, not proof that it still supplies identical, complete bytes. Recipe checks establish tracked, unchanged and pushed files, not a successful reconstruction. Those original checks are retained without claiming a recovery-byte proof. Native Trash supplies the immediate recovery path.

Only a confirmed move returns `trashed: true` and `next_value` with `states.trashed` (default `Mac copy moved to Trash`). `trash_outcome` distinguishes `moved`, `not_started` and `unknown`; `trashed: false` with `unknown` does not establish that the source stayed. Unknown stops later disposal without retry or moved-state writeback. The caller owns list writeback. `path_bytes`, `eligible_path_bytes` and `trashed_path_bytes` describe observed path allocation (`blocks * 512`), with possible hard-link/shared-block overlap; they are not bytes reclaimed. A refused eligibility check has `path_bytes: null`, rather than repeating an unverified byte count from its list row. `freed_bytes` is always `null` because physical space reclaimed is unmeasured.

## Runtime boundary

The row retains only `change-a-folder` and declares `invoke.parent_actions: { fd: 3 }`. The native runner writes its private action descriptor to that fd; the literal `--parent-actions-fd 3` selects it for the workflows `run-a-function` runner, which hands the function its host actions as `host` (`workflows/read-data/host-actions.mjs`), read only when the function first uses one. Task JSON cannot supply the account, parent bearer, grant or physical scope. The parent checks the original live run, current grant, folder identity and exact generation at the effect. No broad Trash grant or child-side deletion fallback is added. The frozen `43380fa0` eligibility and generation producer is unchanged.

The earlier direct-command tests on 2026-11-07 found a sandbox denial while an uncontained synthetic move succeeded. Those historical results do not qualify this new parent route. Current source tests use synthetic physical effects and the actual child CLI/SDK over fd3. Native issuer-to-physical integration, installation and customer use require their own proof; no real Trash move is claimed here.

## Dependencies

**Depends on:** Node, `git`, the workflows `run-a-function` runner with its `read-data/host-actions.mjs` host action route, and the authenticated native parent. **Depended on by:** `what-this-tool-does-and-how-to-run-it.json`.
