# tools/pin-files-by-content/

Keeps a folder's pin file in step with its files. For each file a program reads from the folder (an engine's product data files, for example), the pin file records the byte count and the BLAKE3 hash, so the program can refuse a file whose bytes changed after it was pinned. `check` says which pins are stale, missing or left over. `write` brings the pins up to date with the files.

## Running it

```
node tools/pin-files-by-content/do-work/pin-files.mjs (check | write) --root DIR --pin-file PATH --folder PATH [--match GLOB] [--unpinned-ok PATH ...] [--shape FILE]
```

- `--pin-file` and `--folder` are paths under `--root`. `--root` is the repository, or the folder the person granted.
- Every file under the folder is pinned. Folders whose names start with `.` are skipped.
- `--match` keeps only the files whose path under the folder matches a glob. In the glob, `*` stays inside one folder and `**` crosses folders.
- `--unpinned-ok` names a file under the folder that is never pinned (a `package.json` that only marks a module root, for example). Repeat it for more files.
- The command prints `{ ok, pinned, added, changed, gone, unchanged, written }`.
  - `added`: files that have no pin.
  - `changed`: files whose path, byte count or hash differs from their pin.
  - `gone`: pins whose file no longer exists.
- Exit codes:
  - 0: the pins match the files, or `write` updated them.
  - 1: `check` found a difference.
  - 2: a path or the pin file could not be read. The reason is on standard error.

## The pin file

Its shape is DATA: `read-data/pin-shape.json`, or the file that `--shape` names. When no shape is given:

```json
{ "files": { "<path without extension>": { "path": "<path under the folder>", "pin": { "bytes": 1234, "blake3": "<64 hex>" } } } }
```

| Shape key | Holds |
|---|---|
| `entries_at` | The key the entries are under. |
| `path_key`, `pin_key`, `bytes_key`, `hash_key` | The keys inside an entry. |
| `strip_extension` | Whether the entry's name is the path without its extension. |
| `hash_form` | `hex` writes the bare hex that `b3sum` prints. `identity` writes the content-identity form, `1f:` followed by the hex. |
| `indent` | The spaces the JSON is indented with. The file always ends with a newline. |

When `write` updates the pins:
- Every other key in the pin file stays as it was.
- Entries keep their order, and new entries follow in name order, so only the lines of what changed differ.
- It writes nothing when `check` would pass.

Measured 2026-10-30 on an engine repository's 55 product data files:
- `check` agreed with `b3sum` and with the committed pins.
- A pin that was changed and then rewritten came out byte for byte the same as the committed file.

## Files

| File | Purpose |
|---|---|
| `read-data/pins.mjs` | `pinFiles(...)`: the check and the write. |
| `read-data/pin-shape.json` | The default shape of a pin file. |
| `do-work/pin-files.mjs` | The command line above. |
| `test/pin-files-by-content.test.mjs` | Added, changed and gone pins, the kept keys and order, a shape as DATA, the root check and the exit codes, on a made-up app's settings. |

## Dependencies

**Depends on:** Node and `tools/content-identity` (BLAKE3, with `@noble/hashes`).

**Depended on by:** `tools/workflows/recipes/set-up-a-checked-repository.json`.
