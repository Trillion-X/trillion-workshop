# tools/work-on-connected-drives/

The drive tools that change things on a person's computer: copy or move files and folders between drives (each copy checked before it is named), list and pause/resume/stop the file work on drives, find every place the same file is, and eject a drive after stopping what holds it. They run on the person's own Mac as `computer` rows, one process per run, through `tools/workflows`' `do-work/run-a-function.mjs`: each is a function of its input that keeps nothing. Every row holds `see-connected-drives`; `tool:media-transfer` also holds `change-a-folder` (the person grants the drive folder it may write into). What only reads a drive (list the drives, one folder, what is on one by kind, its icon, what holds it) is `tools/connected-drives`; its code is imported from there, one copy.

Moved here from `Trillion-X/trillion` `computer/drive-tools/` (2026-11-02); run through the engine since 2026-11-03. Old trillion's five read rows of this folder (`tool:trillion-media-drives`, `-drive-icon`, `-drive-kinds`, `-drive-folder`, `-drive-holders`) were the same jobs as `tools/connected-drives`' rows and are gone: the engine already sends those ids to the connected-drives rows (trillion-rust `product/renamed-tools.json`).

## Files

| File | Purpose |
|------|---------|
| `read-data/drives.mjs` | `listDriveWork`, `controlDriveWork`, `copyOrMoveBetweenDrives`, `ejectADrive` (run by `run-a-function`), and eject itself: stops this run's own work on the drive first, asks every other holder to quit, then `diskutil eject`. The drives come from `tools/connected-drives` `enumerateDevices`. |
| `read-data/file-places.mjs` | `findEveryPlaceAFileIs`: every connected-drive path and every name among the person's own files handed in as `input.stored.files` (bytes, text or a given identity, matched by BLAKE3 identity) that holds the same bytes as one file; it reports unreadable folders, or that no files were handed in, instead of claiming a partial scan is complete. |
| `read-data/drive-work.mjs` | All the work on the drives (transfers, other programs holding a drive) with pause, resume, stop and resume-at, and the part of eject that stops that work gracefully first. |
| `read-data/file-transfer.mjs` | Copy or move files and folders to folders on connected drives, inside the run that asks: each copy checked by BLAKE3 before it gets its name, a move's sources trashed only after every copy is checked; progress in `<state>/progress.json`. |
| `read-data/work-control.mjs` | A job's pause/stop choice in `<state>/control.json` and the checkpoint a worker passes between chunks. |
| `what-this-tool-does-and-how-to-run-it.json` | `tool:media-file-places`, `-work`, `-work-control`, `-transfer` and `-eject`, `computer` rows. `file-places` also declares `stored`: the person's files under `/`, handed in by the caller. |
| `part.json` | Nothing here is imported by other code. |
| `test/drives.test.mjs` | Hidden volumes, every row's export and capabilities, and a real copy in a temporary folder. |
| `test/file-places.test.mjs` | Every place a file is, over pretend drives and files handed in. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `listDriveWork()` … `ejectADrive(input)` | `(input) -> Promise<answer>` | What a row runs; a failure throws with `status` and words. |
| `findEveryPlaceAFileIs(input)` | `({ path, stored: { files } }) -> { path, identity, places, complete, files_not_given? }` | `stored.files` is the person's own files, handed in by the caller. |
| `createTransfers({ folder, runWorker? })` | `-> { start, preview, list, restart }` | Starts a transfer in `<folder>/<id>` (the run's home folder) and runs it until it ends. |

## Not yet

Checked against trillion-rust `src/runtime/workshop/computer-capabilities.json` (`base` lines 10-20, `see-connected-drives` lines 65-75, `change-a-folder` lines 35-43) and the run's life (`src/runtime/workshop/container.rs:284-285`, `src/runtime.rs:1162-1165`). What each run starts or touches, and what is missing:

- **Stopping another program** (eject asking each holder to quit, `controlDriveWork` `stop` on a `program:<pid>`): `process.kill(pid, 'SIGTERM')` on another process. `base` allows `(allow signal (target self))` only, so the kill fails with EPERM and the answer says the program was not stopped (`stopped: false`, or 409). Needs a capability with `(allow signal (target others))`, for example `stop-a-program`; a rule that broad also needs the person's words to say so.
- **Eject is wider than its grant's words**: `diskutil eject` / `diskutil unmount` run under `see-connected-drives` (its rules allow `/usr/sbin/diskutil` and the DiskArbitration lookup), whose words say "see". Either `see-connected-drives` narrows to `diskutil info`, or eject gets its own capability (`eject-a-drive`: the same `/usr/sbin/diskutil` exec and `com.apple.DiskArbitration.diskarbitrationd` lookup, words "Eject a drive connected to this Mac"). Until then the row asks only for `see-connected-drives`.
- **Work that outlives one run** (a transfer the person pauses in one run and resumes in another, `resume_at`, `listDriveWork` showing a transfer another run started): the run's `HOME`/`TMPDIR` is its private folder, removed when the run ends (container.rs:284-285), and a run that leaves a process behind is stopped as `DescendantsRemain` (runtime.rs:1162-1165). So a transfer runs inside the run that starts it, its state lasts only that run, `listDriveWork` lists only programs holding a drive, and pause/resume/stop/resume-at of a transfer from another run answer 404. Needs an engine feature: a per-tool state folder kept between runs (rule `(allow file-read* file-write* (subpath "{tool_state}"))`) and a run kind that may keep working after it answers.
- **A move's sources to the Trash**: `/usr/bin/trash` (executable under `base`) moves into the source drive's `.Trashes`, which only `change-a-folder` over that drive's root allows, and its Finder/FileManager service lookups are in no capability (not measured). One `change-a-folder` grant per tool also means every destination, and a move's sources, must be inside the one folder granted; a copy to two drives needs a second folder grant, which the engine does not have.
- **Utility priority**: old trillion started the worker under `/usr/sbin/taskpolicy -c utility`; `/usr/sbin/taskpolicy` is in no rule, so a transfer runs at the run's own priority.
- **The hardware profile** (iPhones and unmounted devices from `/usr/sbin/system_profiler`, merged into old trillion's drive list): `/usr/sbin/system_profiler` is in no rule. Dropped with the read rows; `tools/connected-drives` lists mounted volumes only.
- `ps` (`/bin/ps`, `base`) names the holders: `see-connected-drives` allows `process-info-listpids` and `process-info-pidinfo (target others)`, which it needs. `lsof`, `mount`, `diskutil info`, and reads under `/Volumes` are all inside the rows' capabilities.
- None of these rows has been run end to end on the engine on a Mac; the tests use pretend drives.

## Dependencies

**Depends on:** `tools/connected-drives` (`drives.mjs` `enumerateDevices`, `drive-folder.mjs` `driveOf`, `drive-processes.mjs`), `tools/workflows` (`do-work/run-a-function.mjs`), `tools/content-identity` (`identity.mjs`), `@noble/hashes`, macOS `diskutil`, `lsof`, `ps` and `/usr/bin/trash`.

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json`.
