# tools/connected-drives/

The drives connected to the person's computer, what is in one folder on one of them, what is on one by kind of file, the icon Finder shows for one, and which programs are using one. It runs on the person's own computer as `computer` rows. They hold one capability, `see-connected-drives`, and only while the person has granted it. Nothing here writes, stops a program or ejects.

## Readers

How a place knows its drives is a reader row in `read-data/drives.json`, tried in order. A reader is chosen only when its `at` path exists on the place the run is on; the tool never asks what kind of machine it is, and a place with no reader has no drives it can see.

| Reader | Chosen when the place has | Reads | Icon | Eject |
|--------|---------------------------|-------|------|-------|
| `finder-volumes` | `/usr/sbin/diskutil` | the folders under `/Volumes` that Finder shows, `mount`, `diskutil`'s identity, `/usr/sbin/lsof` | Finder's, through `osascript` | when diskutil says the drive is external |
| `mount-table` | `/proc/self/mountinfo` | block-device (`/dev/...`) mounts inside `/media`, `/run/media` or `/mnt`, `/usr/bin/lsof` | none: answers `icon: 'none'` | never: every drive answers `ejectable: false` |

## Files

| File | Purpose |
|------|---------|
| `read-data/drives.mjs` | `listConnectedDrives`, `listDriveFolder`, `seeWhatIsOnADrive`, `getADriveIcon` and `nameWhatHoldsADrive`, run by `tools/records-door`'s `run-an-export.mjs`. |
| `read-data/drives.json` | The readers, the icon sizes, and the bounds of one look at what is on a drive (files, milliseconds, largest files named). |
| `read-data/drive-mount-table.mjs` | The `mount-table` reader: mountinfo lines parsed, and the block-device mounts inside the reader's mount roots. |
| `read-data/draw-icon.js` | The icon macOS draws for a path, as a PNG (`osascript -l JavaScript`, the path an argument). |
| `read-data/drive-identity.mjs` | What one mounted volume is (real mount, internal, kind, ejectable), from diskutil's plist. |
| `read-data/drive-folder.mjs` | One folder on a drive, a page at a time, and `driveOf`, the check that a path really is on a connected drive. |
| `read-data/drive-processes.mjs` | The programs with files open on a drive, from `lsof -Fpcn`, and `readProcessRows`, each process named the way the person knows it (from `ps`; a script by its script). |
| `read-data/file-kinds.mjs`, `read-data/file-kinds.json` | What kind of file a name is (videos, audio, pictures, ...), as DATA. |
| `tool-rows.json` | `tool:list-connected-drives`, `tool:list-a-drive-folder`, `tool:see-what-is-on-a-drive`, `tool:get-a-drive-icon`, `tool:name-what-holds-a-drive`. |
| `part.json` | `drives.mjs` (`enumerateDevices`), `drive-folder.mjs` (`driveOf`) and `drive-processes.mjs`, which `tools/work-on-connected-drives` imports. |
| `test/drives.test.mjs` | Tests against a pretend `/Volumes`, a pretend mount table and pretend commands. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `enumerateDevices` | `({ exec?, root?, reader? }) => Promise<device[]>` | Every drive the place's reader lists, one per real mount: under `/Volumes`, Finder-shown (not `nobrowse`) with its diskutil identity; or inside the mount table's mount roots. |
| `chooseReader` | `({ reader?, root?, exists? }) => reader \| null` | The first reader row whose `at` exists here (or the one a test names). |
| `listDriveFolder` | `({ path, offset?, limit?, hidden? }) => folder page` | Folders first, then files, numbers in names in order. A path whose real path is off every connected drive is refused. |
| `walkDrive` | `(mount, { most_files, most_ms, largest_kept }) => { files, bytes, complete, kinds, largest }` | One bounded look at a drive. It stops at its bounds and answers `complete: false`, so a run never outlasts its time. |
| `nameWhatHoldsADrive` | `({ mount }) => { mount, processes }` | Only kernel-reported open files count. This run and launchd are never named. |

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library, and the programs of the place's reader: `mount`, `diskutil`, `lsof` and `osascript` for `finder-volumes`; the kernel mount table and `lsof` for `mount-table`.

**Depended on by:** `tool-rows.json`; `tools/work-on-connected-drives` (the public files `part.json` lists). The engine sends old trillion's `tool:trillion-media-drives`, `-drive-folder`, `-drive-holders`, `-drive-kinds` and `-drive-icon` to these rows (trillion-rust `product/renamed-tools.json`). The local engine runs the rows on the person's computer (`computer` kind) after the person grants `see-connected-drives`.
