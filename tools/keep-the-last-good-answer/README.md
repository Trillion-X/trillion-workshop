# tools/keep-the-last-good-answer/

Ask a live source. If it answers, keep that answer. If it does not, hand back the one that was kept, so a fallback is always the last thing that was really true rather than whatever was true when something was built. Ported from the package `keep-the-last-good-answer`: the primitive and its 28 checks are unchanged. The one row binds the primitive to the web and to the person's own records, because no other Workshop tool needed it: a tool here runs once and keeps nothing between runs, and the only place a tool may keep something is the records door.

## Files

| File | Purpose |
|------|---------|
| `do-work/keep-the-last-good-answer.mjs` | The whole primitive: three injected collaborators, no disk, no network, no product word. Copied unchanged. |
| `read-data/ask-and-keep.mjs` | `tool:ask-a-web-address-or-give-the-last-answer`: the live read (a web address, JSON or text, up to 256 KiB), the kept read and the keep (one `kept-answer` record per key, through `tools/records-door`), and the words of the answer. |
| `part.json` | The primitive is public, so another tool may import it. |
| `tool-rows.json` | The row: a container run with `internet: true`, and the records door with the right to read and write `kept-answer` only, one write at a time. |
| `test/keep-the-last-good-answer.test.mjs` | The package's 28 checks, every one a way a naive version gets it wrong. Touches no file, socket or clock. Copied unchanged. |
| `test/ask-and-keep.test.mjs` | The row as the container runs it, against the fake records door and a source on this computer's loopback; the function with its collaborators handed in for the failures a real address rarely gives. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `keepTheLastGoodAnswer` | `({ askTheSource, readWhatWasKept?, keepThisAnswer? }) -> () -> Promise<Answer>` | Builds the holder. Throws `TypeError` without `askTheSource`. |
| `Answer` | `{ origin, value, sourceFailure, keepFailure, keptFailure }` | All five keys are always present, null when they do not apply. Failures are returned, never raised and never logged. |
| `FROM_THE_SOURCE` / `FROM_WHAT_WAS_KEPT` / `NOTHING_TO_GIVE` | strings | Where the answer came from; the caller never has to guess. |
| `askAndKeep` | `(input, { door, fetch?, now? }) -> { origin, answer, kept_at, source_failure, keep_failure, kept_failure, said }` | The row's function. `input` is `{ address, key, wait_seconds? }`. |

## Invariants

- A source that answers with nothing has not answered, and never replaces a good kept answer. `0`, `''`, `false` and `[]` are answers.
- Failing to keep never fails the answer. A kept answer that cannot be read is the same as none kept.
- Nothing logs. Timeouts and retries belong to the ask, the only party that knows what a slow answer means.

## Dependencies

**Depends on:** `tools/records-door` (the row packs it); Node 24.

**Depended on by:** `tool-rows.json`.
