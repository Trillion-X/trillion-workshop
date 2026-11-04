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

`tool-rows.json` holds `tool:plan-choosing-and-saving-files-on-my-computer`. It runs `run/plan-local-files.mjs` `planLocalFiles`, which calls `chooseLocalFiles` or `saveLocalFileCopy` with the workspace's `#workspace-records` stood in by `run/requests-kept-here.mjs` (mapped by `run/package.json`): each `local.files` request is kept and answered, a choose from the picker reply handed in, a save as a Mac that wrote and read back the copy would. The row lays `do-work/` and `read-data/` under `run/` in the run, so only there does the stand-in replace the workspace's sender. Nothing on any computer is opened, picked, written or read.
