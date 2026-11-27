# Local Files

Local file selection and file-tree package records for Bitfield Studio.

Device filesystem work routes through the macOS native `local.files` target,
not `compute.process`. The target scopes direct access to the signed-in user's
home and mounted volumes; paths explicitly selected in the OS picker are added
for that runner session. Deletes are recoverable moves to Trash.

The package-owned evidence verifier uses the admitted `node` alias in leaf
containment with `OPENSSL_CONF` explicitly empty. On macOS this prevents Node
from attempting a sandbox-forbidden read of the host OpenSSL configuration;
the verifier remains hermetic and receives only its declared mounted inputs.

## Rules

- Large local selections must not return file bytes through slot stdout.
- `choose-local-files` supports metadata-only selection for callers that need to stage bytes through a storage primitive.
- Large media files can be read in bounded ranges through `read_file_range` (up to 16 MiB per call) without copying the whole file into chunk storage first. Whole-file inline reads remain capped at 128 MiB for backward compatibility.
- Media workflows that need durable engine-log residency should still convert selected local paths into addressed chunk storage; workflows that only need to read byte ranges can use `read_file_range` directly.
- `do-work` and `read-data` are declared public source roots because other packages call the generic local-file selection/read helpers across the package boundary.
- Public source roots are pre-admission source declarations only; they are not runtime truth after the log projection owns admitted package records.

## `read_file_range_bytes`

Same bounds, containment and clamp as `read_file_range`, but the reply payload IS the requested range: no JSON envelope and no base64. A caller that wants file metadata keeps using `read_file_range`; a caller that wants bytes asks for bytes, and the difference is one DATA value in the request rather than a second handler.

## The row

`what-this-tool-does-and-how-to-run-it.json` holds `tool:plan-choosing-and-saving-files-on-my-computer`. It runs `run/plan-local-files.mjs` `planLocalFiles`, which calls `chooseLocalFiles` or `saveLocalFileCopy` with the workspace's `#workspace-records` stood in by `run/requests-kept-here.mjs` (mapped by `run/package.json`): each `local.files` request is kept and answered, a choose from the picker reply handed in, a save as a Mac that wrote and read back the copy would. The row lays `do-work/` and `read-data/` under `run/` in the run, so only there does the stand-in replace the workspace's sender. Nothing on any computer is opened, picked, written or read.

## Restored from bitfield-packages `local-files`

The package held more than the three files above: the local file tree screen (`show/LocalFileTree.tsx`, 1132 lines, and its mount), the native iOS mount (`show-ios-jscore/`), and the device operations it calls (choose a folder, create a folder or an empty file, rename, move to the trash, reveal, ask for a display or a content digest, send a selection, verify addressed evidence, read the local roots and a directory), with their tests. The three files already here (`do-work/choose-local-files.ts`, `do-work/save-local-file-copy.ts`, `read-data/invoke-local-files-target.ts`) are the later, evolved copies and were kept; the package's older copies of them were not moved over them. Moved byte for byte and not yet wired to a tool row.

| File | Purpose |
|------|---------|
| `do-work/ask-local-file-content-digest.mjs` | PURPOSE |
| `do-work/ask-local-file-content-digest.test.ts` | This is a CLI, so it is exercised as one. Importing it would run it against this test's argv, |
| `do-work/ask-local-file-display.ts` | The package's code, moved as written. |
| `do-work/choose-local-folder.ts` | Opens the operating system folder picker through the native files target and returns |
| `do-work/create-local-directory.ts` | Creates a local directory through the native device-files capability. |
| `do-work/create-local-empty-file.ts` | Creates an empty local file through the native device-files capability. |
| `do-work/move-local-path-to-trash.ts` | Moves a local path to Trash through the native device-files capability. |
| `do-work/rename-local-path.ts` | Renames/moves a local path through the native device-files capability. |
| `do-work/reveal-local-path.test.ts.held` | Held test: mocks and imports `@bitfield/runtime-kit` (retired package runtime) |
| `do-work/reveal-local-path.ts` | Reveals a local path through the native device-files capability. |
| `do-work/save-local-file-contract.test.ts.held` | Held test: reads the package's things-to-store-and-run.json from the folder above do-work |
| `do-work/save-local-file-copy.test.ts.held` | Held test: loads read-data/invoke-local-files-target.ts, this tree's evolved copy |
| `do-work/send-local-file-selection.ts` | The package's code, moved as written. |
| `do-work/verify-selected-addressed-evidence.mjs` | Verify immutable staged bytes and emit the Local Files custody receipt. |
| `do-work/verify-selected-addressed-evidence.test.ts` | Exercised as a process for the same reason as its sibling: the request file in, the receipt |
| `from-bitfield-packages-local-files/README.md` | The package's own note, moved as written. |
| `from-bitfield-packages-local-files/things-to-store-and-run.json` | Data the package carried as written. |
| `local-files-native-boundary.test.ts.held` | Held test: walks `process.cwd()/packages/local-files`, the package's own folder, to prove no device operation goes throug |
| `read-data/names-and-content-identities-from-a-folder-tree.mjs` | A table of names and content identities from a folder tree, yielded one row at a time. |
| `read-data/names-and-content-identities-from-a-folder-tree.test.mjs` | Each case names the failure it prevents, and three of them are failures this corpus already |
| `read-data/read-local-directory.ts` | Reads one user-authorized local directory through the native files target. |
| `read-data/read-local-file-roots.test.ts.held` | Held test: imports `@bitfield/runtime-kit` through read-data/read-local-file-roots.ts (retired package runtime) |
| `read-data/read-local-file-roots.ts` | Reads selectable local file roots as a DATA-driven feed: a |
| `show-ios-jscore/README.md` | The package's own note, moved as written. |
| `show-ios-jscore/mount-local-files-jscore.js` | Invariants: Local Files owns file-list projection and emits generic native |
| `show/LocalFileTree.test.tsx.held` | Held test: a React component test (jsdom, testing-library) |
| `show/LocalFileTree.tsx` | PURPOSE |
| `show/mount-local-file-tree.tsx` | The package's code, moved as written. |
| `from-bitfield-packages-local-files/moved-from.json` | Source path and commit of each file, identities, call rows, held tests, files that still call the retired runtime. |

Still on the retired runtime (original bytes, import paths changed): `do-work/ask-local-file-display.ts`, `do-work/send-local-file-selection.ts`, `read-data/read-local-file-roots.ts`.
