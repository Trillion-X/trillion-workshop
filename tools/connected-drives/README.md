# tools/connected-drives/

The drives connected to the person's Mac, what is in one folder on one of them, what is on one by kind of file, the icon Finder shows for one, and which programs are using one. It runs on the person's own Mac as `computer` rows. They hold one capability, `see-connected-drives`, and only while the person has granted it. The capability covers the Mac's drive and icon services, the `mount`, `diskutil`, `lsof` and `osascript` commands, and reads under `/Volumes` only. Nothing here writes, stops a program or ejects.

## Files

| File | Purpose |
|------|---------|
| `read-data/drives.mjs` | `listConnectedDrives`, `listDriveFolder`, `seeWhatIsOnADrive`, `getADriveIcon` and `nameWhatHoldsADrive`, run by `tools/records-door`'s `run-an-export.mjs`. |
| `read-data/drives.json` | The icon sizes, and the bounds of one look at what is on a drive (files, milliseconds, largest files named). |
| `read-data/draw-icon.js` | The icon macOS draws for a path, as a PNG (`osascript -l JavaScript`, the path an argument). |
| `read-data/drive-identity.mjs` | What one mounted volume is (real mount, internal, kind, ejectable), from diskutil's plist. |
| `read-data/drive-folder.mjs` | One folder on a drive, a page at a time, and `driveOf`, the check that a path really is on a connected drive. |
| `read-data/drive-processes.mjs` | The programs with files open on a drive, from `lsof -Fpcn`. |
| `read-data/file-kinds.mjs`, `read-data/file-kinds.json` | What kind of file a name is (videos, audio, pictures, ...), as DATA. |
| `tool-rows.json` | `tool:list-connected-drives`, `tool:list-a-drive-folder`, `tool:see-what-is-on-a-drive`, `tool:get-a-drive-icon`, `tool:name-what-holds-a-drive`. |
| `part.json` | Nothing here is imported by other code. |
| `test/drives.test.mjs` | Tests against a pretend `/Volumes` and pretend commands. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `enumerateDevices` | `({ exec?, root? }) => Promise<device[]>` | Every volume under `/Volumes` that Finder shows (not `nobrowse`), each with its diskutil identity, one per disk. |
| `listDriveFolder` | `({ path, offset?, limit?, hidden? }) => folder page` | Folders first, then files, numbers in names in order. A path whose real path is off every connected drive is refused. |
| `walkDrive` | `(mount, { most_files, most_ms, largest_kept }) => { files, bytes, complete, kinds, largest }` | One bounded look at a drive. It stops at its bounds and answers `complete: false`, so a run never outlasts its time. |
| `nameWhatHoldsADrive` | `({ mount }) => { mount, processes }` | Only kernel-reported open files count. This run and launchd are never named. |

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library, and the Mac's `mount`, `diskutil`, `lsof` and `osascript`.

**Depended on by:** `tool-rows.json`. The local engine runs the rows on the person's computer (`computer` kind) after the person grants `see-connected-drives`.
