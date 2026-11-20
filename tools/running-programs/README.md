# tools/running-programs/

The programs running on the person's computer and how much memory each one uses, the largest first, with each one's parent, session, start time, processor time and, when asked, its command line. It runs on the person's own computer, any computer that reports its programs, as a `computer` row. The list row holds one capability, `read-processes`, and only while the person has granted it: the system's list of processes, read-only.

The folder also holds the deciding and stopping steps of `workflow:stop-programs-left-running` (`tools/workflows/recipes/stop-programs-left-running.json`), which every ten minutes stops the programs a session that ended left running. Which programs those are is only the person's own rows: left-behind rows (how a program is left behind, how old, how busy, its command or name by pattern) and never-stop rows (commands or names never stopped). `tool:choose-programs-left-running` reads nothing and changes nothing; `tool:stop-programs-left-running` is the only row here that may signal another program (`close-apps`), and only asks it to end (SIGTERM), never forces it.

## Files

| File | Purpose |
|------|---------|
| `read-data/running-programs.mjs` | `listRunningPrograms`, run by `tools/workflows`' `do-work/run-a-function.mjs`; `readPrograms`, which uses the first reader in `running-programs.json` this computer has; and `readProcessTable`, the reader for a process table folder (`<pid>/comm`, `<pid>/status`), which starts no program. |
| `read-data/read-programs.js` | The reader: every process id, name, physical footprint and resident bytes, parent, session, start time and processor time from the system's process information (libproc, sysctl), through `osascript -l JavaScript`; with `commands <bytes>`, each command line (its arguments, never its environment). `ps` and `top` are setuid, and a sandboxed run may not start them. Measured on Nov 19 2026 under deny default plus `read-processes`: every field of the person's own programs is read. |
| `read-data/running-programs.json` | How many programs one answer names when none is asked, and at most; the readers a place may have, in order, each with the path whose presence says the computer has it; the units a process table states memory and times in; how many bytes of a command line are read. |
| `do-work/programs-left-running.mjs` | `chooseProgramsLeftRunning` (`tool:choose-programs-left-running`): which programs the person's left-behind rows describe and no never-stop row names; a list not given is refused, a field a row may not hold is refused, a program whose session still has an owner is always kept. `stopProgramsLeftRunning` (`tool:stop-programs-left-running`): asks each chosen program to end when it is still the same program (pid and start time), waits, and answers one stop row per program and one notice per sweep that ended any. |
| `do-work/programs-left-running.json` | The system's first process id, the fields each kind of rule row may hold, the grace time, how much of a command a stop row keeps, and the kind of news a sweep's notice is told as. |
| `kits/` | One kit per tool row. |
| `tool-rows.json` | `tool:list-running-programs`, `tool:choose-programs-left-running`, `tool:stop-programs-left-running`. |
| `read-data/mac-process-inspection.py` | The canonical read-only birth, session and captured group observer used by native admission cleanup. Ported byte for byte before adding the verified captured-group API; its source contract is `ports/native-process-observations.json`. It never signals a process or authorizes a lease release. |
| `part.json` | Declares the canonical process observer as a source API. |
| `test/mac-process-inspection.test.mjs` | Real kernel layout and birth checks, exited captured rows, malformed observations and unsupported-layout refusals. |
| `test/running-programs.test.mjs` | Tests with a pretend reader and a pretend process table, and one run of whichever real reader the test's place has. |
| `test/programs-left-running.test.mjs` | `workflow:stop-programs-left-running` run on the workflow engine with made-up programs, rows and store, and the real choosing and stopping functions with a pretend signal: a left-behind program is stopped, kept and told; a never-stop one, one with a live parent or session owner, a young one and an idle one are kept; a store with no never-stop row refuses the sweep. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `listRunningPrograms` | `({ name?, most?, commands? }) => { total, programs, complete }` | The programs whose name has `name` (any case), the largest footprint first, at most `most`. `complete: false` says the list was cut. |
| `readPrograms` | `({ exec?, readers?, has?, commands? }) => Promise<program[]>` | Each program as `{ pid, name, footprint_bytes, resident_bytes, parent_pid, session_id, started_at_ms, cpu_ms, command? }`. A value the person may not read is null, never a guess. A reader that could not list refuses with what to grant. |
| `chooseProgramsLeftRunning` | `({ programs, complete, left_behind, never_stop }) => { read, picked, kept, said }` | The programs to stop, each with the row that chose it and why. |
| `stopProgramsLeftRunning` | `({ programs, grace_ms? }) => Promise<{ stops, notices }>` | One stop per program (outcome ended, still-running, already-gone, not-the-same-program or not-allowed) and at most one notice. |

## Dependencies

**Depends on:** `tools/workflows` (`do-work/run-a-function.mjs`), Node's standard library, and one reader the computer has: a process table folder, or `osascript` with libproc.

**Depended on by:** `tool-rows.json`. The local engine runs the rows on the person's computer (`computer` kind) for its owner, with nothing more to allow (installing it or switching its job on is the one yes) (the stop row also holds `close-apps`). `tools/workflows/recipes/stop-programs-left-running.json` asks the three rows in order.
