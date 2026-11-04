# tools/keep-a-long-job-resumable/

Keeps a long job on the person's own computer (a meeting summary, a transcription) under a key, so a closed laptop neither loses nor duplicates the work. Starting with a key already used gives back that same job. Its output is kept as numbered pieces, any client can read on from a cursor, and anyone with the id can finish or cancel it. It runs as a `computer` row with one capability: the folder the person granted, where the jobs file is kept.

## Files

| File | Purpose |
|------|---------|
| `read-data/durable-job.mjs` | `createJobs({ settings?, file?, now? })`: start, append, read, finish, cancel and list over one jobs file. `jobTools.job(input, { file })`: the old tool table's entry. `job({ input, folder })`: the export the row runs, keeping the jobs file in the granted folder. |
| `read-data/durable-job.json` | The jobs file's name, how long a stream stays readable, how many jobs and pieces are kept, the stream address, the state words and every sentence said. |
| `tool-rows.json` | `tool:job`, a `computer` row with `capabilities: ["change-a-folder"]`, run by `tools/records-door`'s `run-an-export.mjs`; standard input is `{ input, folder }`, `folder` filled from the grant. |
| `part.json` | Nothing here is imported by other code. |
| `test/durable-job.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `createJobs` | `({ settings?, file?, now? }) => { start, append, read, finish, cancel, list }` | A job's id is BLAKE3 of its key, so starting twice is one job with the first seed and version. Pieces are numbered; `read(id, cursor)` gives exactly the pieces after `cursor`. A finished, cancelled or expired job takes no more output; an expired job cannot be read. |
| `job` | `({ input, folder }) => answer` | `input.action` is `start`, `append`, `read`, `finish`, `cancel` or `list` (the default). Refuses without a granted folder. |

## Moved from Trillion

`computer/durable-job.mjs` and `computer/durable-job.json` of Trillion-X/trillion (deleted there in `dc79bb0a`), moved one to one. What changed: the jobs file was `~/.trillion/jobs/jobs.json` in the Mac app's own folder; it is now `jobs.json` in the folder the person grants, so `jobTools.job` takes the file and `job` is the export `run-an-export.mjs` calls. The old app had no test of this module; the tests here check its four written invariants.

## Not yet

- The run has not been proved end to end on the engine; the tests run the module with a temporary folder.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), `@noble/hashes` (BLAKE3) and Node's standard library.

**Depended on by:** `tool-rows.json`. The engine runs the row on the person's computer (`computer` kind) after the person grants `change-a-folder`.
