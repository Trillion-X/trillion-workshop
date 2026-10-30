# tools/running-programs/

The programs running on the person's Mac and how much memory each one uses, the largest first. It runs on the person's own Mac as a `computer` row. The row holds one capability, `read-processes`, and only while the person has granted it: the system's list of processes and each one's name and memory, read-only. Nothing here stops, signals or starts a program besides its own reader.

## Files

| File | Purpose |
|------|---------|
| `read-data/running-programs.mjs` | `listRunningPrograms`, run by `tools/records-door`'s `run-an-export.mjs`, and `readPrograms`, which starts the reader and reads its one JSON line. |
| `read-data/read-programs.js` | The reader: every process id, name, physical footprint and resident bytes from the system's process information (libproc), through `osascript -l JavaScript`. `ps` and `top` are setuid, and a sandboxed run may not start them. |
| `read-data/running-programs.json` | How many programs one answer names when none is asked, and at most. |
| `tool-rows.json` | `tool:list-running-programs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/running-programs.test.mjs` | Tests with a pretend reader, and one run of the real reader on this Mac. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `listRunningPrograms` | `({ name?, most? }) => { total, programs, complete }` | The programs whose name has `name` (any case), the largest footprint first, at most `most`. `complete: false` says the list was cut. |
| `readPrograms` | `({ exec? }) => Promise<program[]>` | Each program as `{ pid, name, footprint_bytes, resident_bytes }`. Memory is null for a program the person may not read, never a guess. A reader that could not list refuses with what to grant. |

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library, and the Mac's `osascript`.

**Depended on by:** `tool-rows.json`. The local engine runs the row on the person's computer (`computer` kind) after the person grants `read-processes`.
