# tools/running-programs/

The programs running on the person's computer and how much memory each one uses, the largest first. It runs on the person's own computer, any place that reports its programs, as a `computer` row. The row holds one capability, `read-processes`, and only while the person has granted it: the system's list of processes and each one's name and memory, read-only. Nothing here stops, signals or starts a program besides its own reader.

## Files

| File | Purpose |
|------|---------|
| `read-data/running-programs.mjs` | `listRunningPrograms`, run by `tools/records-door`'s `run-an-export.mjs`; `readPrograms`, which uses the first reader in `running-programs.json` this place has; and `readProcessTable`, the reader for a process table folder (`<pid>/comm`, `<pid>/status`), which starts no program. |
| `read-data/read-programs.js` | The reader: every process id, name, physical footprint and resident bytes from the system's process information (libproc), through `osascript -l JavaScript`. `ps` and `top` are setuid, and a sandboxed run may not start them. |
| `read-data/running-programs.json` | How many programs one answer names when none is asked, and at most; the readers a place may have, in order, each with the path whose presence says the place has it. |
| `tool-rows.json` | `tool:list-running-programs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/running-programs.test.mjs` | Tests with a pretend reader and a pretend process table, and one run of whichever real reader the test's place has. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `listRunningPrograms` | `({ name?, most? }) => { total, programs, complete }` | The programs whose name has `name` (any case), the largest footprint first, at most `most`. `complete: false` says the list was cut. |
| `readPrograms` | `({ exec?, readers?, has? }) => Promise<program[]>` | Each program as `{ pid, name, footprint_bytes, resident_bytes }`. Memory is null for a program the person may not read, never a guess. A reader that could not list refuses with what to grant. |

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library, and one reader the place has: a process table folder, or `osascript` with libproc.

**Depended on by:** `tool-rows.json`. The local engine runs the row on the person's computer (`computer` kind) after the person grants `read-processes`.
