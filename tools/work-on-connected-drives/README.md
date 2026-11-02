# computer/drive-tools/

The drive tools a person's Mac keeps for their Trillion: list the drives, read a drive's icon, kinds of file and folders, find every place the same file is, name what holds a drive, list and pause/resume/stop the long file work on drives, copy or move between drives, and eject. Answered by `../mac-tools.mjs` from the rows in `../mac-tools.json`; ported from Trillion Media (`<checkout>`), whose server answered them before.

## Files

| File | Purpose |
|------|---------|
| `drives.mjs` | The tool table (`driveTools`): each tool's function from its input to its answer, plus the device listing (`enumerateDevices`: /Volumes enriched from the hardware profile, one per disk, leaving out what Finder hides: a volume mounted `nobrowse`), identity, holders and eject (stops this Mac's own work on the drive first, asks every other holder to quit, then `diskutil eject`). Ported from Trillion Media's server.mjs. |
| `drive-identity.mjs` | Which disk a mount is, internal or not, its kind (External SSD, USB, Disk image, iPhone), and whether it may be ejected. |
| `drive-processes.mjs` | The programs holding a drive, from `lsof` and `ps`, named the way the person knows them. |
| `drive-folder.mjs` | One folder on a connected drive a page at a time, and `driveOf`, the check every tool uses that a path is on a connected drive. |
| `drive-icon.mjs` | Finder's icon for a drive as a PNG, kept per mount. |
| `drive-inventory.mjs` | What is on a drive by kind of file, read in the background and kept for 6 hours. |
| `file-places.mjs` | Every connected-drive path and Trillion-space name that holds the same bytes as one file; it reports unreadable folders instead of claiming a partial scan is complete. |\n| `drive-work.mjs` | All the work running on the Mac's drives (transfers, other programs) with pause, resume, stop and resume-at, and the part of eject that stops that work gracefully first. |
| `file-transfer.mjs` | Copy or move files and folders to folders on connected drives as its own worker process: each copy checked by BLAKE3 before it gets its name, a move's sources trashed only after every copy is checked; progress in `<state>/progress.json` (read by `../report-progress.json` row `drive-transfer`). |
| `work-control.mjs` | A job's pause/stop choice in `<state>/control.json` and the checkpoint a worker passes between chunks. |
| `file-kinds.mjs`, `file-kinds.json` | Kinds of file by extension (videos, pictures, sound, documents) and their labels. |
| `README.md` | This file. |

## Key functions

| Name | Shape | Role |
|------|-------|------|
| `driveTools` | from `drives.mjs` → `{ drives, icon, kinds, folder, holders, work, workControl, transfer, eject }`, each `(input) -> Promise<answer>` | What `mac-tools.json` names; a failure throws with `status` and words. |
| `enumerateDevices()` | from `drives.mjs` → `[{ name, mount, kind, internal, ejectable, size_bytes, free_bytes, ... }]` | Every drive the Mac knows. |
| `hiddenIn(mountOutput)` | from `drives.mjs` → `Set<mount point>` | The mount points `/sbin/mount` lists as `nobrowse` (simulator runtimes, system images), which are never drives. |
| `createTransfers({ folder })` | from `file-transfer.mjs` → `{ start, preview, list, restart }` | Starts and lists transfers, each in `<folder>/<id>` (`$HOME/.trillion/computer-sources/transfers`). |
| `createDriveWork({ cloud, cards, transfers, drives, findHolders })` | from `drive-work.mjs` → `{ list, control, stopHolding, holdersOf, armResumes }` | The work on drives and its controls. |
| `listFolder({ target, devices, offset, limit, hidden })` / `driveOf(target, devices)` | from `drive-folder.mjs` | One folder page; whether a path is on a drive. |

## Dependencies

**Depends on:** `@noble/hashes` (`../package.json`), macOS `diskutil`, `lsof`, `ps`, `system_profiler`, `osascript`, `taskpolicy`, `/usr/bin/trash`.
**Depended on by:** `../mac-tools.mjs` (through `../mac-tools.json`), `test/drives.test.mjs`.
