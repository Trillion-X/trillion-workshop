# tools/work-on-connected-drives/

The drive tools a person's computer keeps for them: list the drives, read a drive's icon, kinds of file and folders, find every place the same file is, name what holds a drive, list and pause/resume/stop the long file work on drives, copy or move between drives, and eject. Unlike `tools/connected-drives` (which only reads, once per run), these write, stop programs and eject, and they share one state, so they run inside one long-lived tool host on the person's computer: eject stops this computer's own transfers first, and transfers paused or set to resume at a time are found again after a restart.

Moved here from `Trillion-X/trillion` `computer/drive-tools/` (2026-11-02). What `tools/connected-drives` already held (which disk a mount is, one folder a page at a time, the programs holding a drive, kinds of file) is imported from there, one copy; trillion's process naming (`readProcessRows`) was folded into it.

## Files

| File | Purpose |
|------|---------|
| `read-data/drives.mjs` | The tool table (`driveTools`) and one exported function per row (`listDrives`, `getADriveIcon`, `seeWhatKindsOfFileADriveHolds`, `listADriveFolder`, `nameWhatHoldsThisDrive`, `listDriveWork`, `controlDriveWork`, `copyOrMoveBetweenDrives`, `ejectADrive`), plus the device listing (`enumerateDevices`: /Volumes enriched from the hardware profile, one per disk, leaving out what Finder hides), and eject (stops this computer's own work on the drive first, asks every other holder to quit, then `diskutil eject`). |
| `read-data/drive-icon.mjs` | Finder's icon for a drive as a PNG, kept per mount. |
| `read-data/drive-inventory.mjs` | What is on a drive by kind of file, read in the background and kept for 6 hours. |
| `read-data/file-places.mjs` | `findEveryPlaceAFileIs`: every connected-drive path and Trillion-space name that holds the same bytes as one file; it reports unreadable folders instead of claiming a partial scan is complete. |
| `read-data/drive-work.mjs` | All the work running on the drives (transfers, other programs) with pause, resume, stop and resume-at, and the part of eject that stops that work gracefully first. |
| `read-data/file-transfer.mjs` | Copy or move files and folders to folders on connected drives as its own worker process: each copy checked by BLAKE3 before it gets its name, a move's sources trashed only after every copy is checked; progress in `<state>/progress.json`. |
| `read-data/work-control.mjs` | A job's pause/stop choice in `<state>/control.json` and the checkpoint a worker passes between chunks. |
| `tool-rows.json` | The ten `tool:trillion-media-*` rows on placement:your-computer, `computer-tool` runs handed to the computer's tool host. |
| `part.json` | Nothing here is imported by other code. |
| `test/drives.test.mjs` | Hidden volumes, the exported functions, the host's handed functions, and a real copy in a temporary folder. |
| `test/file-places.test.mjs` | Every place a file is, over pretend drives. |
| `test/fixtures/host.mjs` | A pretend tool host's handed functions (synthetic data). |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `listDrives(input, context)` … `ejectADrive(input)` | `(input, context) -> Promise<answer>` | What a row's host calls; a failure throws with `status` and words. |
| `handedFunction(given)` | `{ module: file URL, export } -> { module, export } \| null` | A host function the context names. Only `file:` modules. |
| `enumerateDevices()` | `-> [{ name, mount, kind, internal, ejectable, size_bytes, free_bytes, ... }]` | Every drive the computer knows. |
| `hiddenIn(mountOutput)` | `-> Set<mount point>` | The mount points `/sbin/mount` lists as `nobrowse`, which are never drives. |
| `createTransfers({ folder })` | `-> { start, preview, list, restart }` | Starts and lists transfers, each in `<folder>/<id>` (`$HOME/.trillion/computer-sources/transfers`). |

## What the host hands in

- `context.drive_sync` `{ module, export }`: a host function answering the sync status of the host's own drive; `listDrives` carries its answer as `trillion_drive`. Left out, the answer has no `trillion_drive`.
- `context.note_written` `{ module, export }`: a host function told each path a transfer wrote, kept in the transfer's `job.json` so a resumed worker still tells it. Left out, nothing is noted.
- `context.origin`, `context.key`: the account `findEveryPlaceAFileIs` reads the Trillion space from.

## Dependencies

**Depends on:** `tools/connected-drives` (`drives.mjs` `hiddenIn`, `drive-identity.mjs`, `drive-folder.mjs`, `drive-processes.mjs`, `file-kinds.mjs`), `@noble/hashes`, macOS `diskutil`, `lsof`, `ps`, `system_profiler`, `osascript`, `taskpolicy`, `/usr/bin/trash`.

**Depended on by:** `tool-rows.json`; the Trillion Mac app's tool host (`computer/mac-tools.json` in Trillion-X/trillion), which imports `read-data/drives.mjs` once and runs these functions on placement:your-computer.
