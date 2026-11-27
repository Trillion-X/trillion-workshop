# tools/keep-the-last-good-answer/

Ask a live source. If it answers, return that answer and the record that keeps it. If it does not, hand back the last answer the caller holds, so a fallback is always the last thing that was really true rather than whatever was true when something was built. Ported from the package `keep-the-last-good-answer`: the primitive and its 28 checks are unchanged. The one row binds the primitive to the web and returns its result: a tool here runs once and keeps nothing between runs, so the answer carries `to_keep`, the one record the person's own write keeps, and the next ask hands it back as `last_answer`.

## Files

| File | Purpose |
|------|---------|
| `do-work/keep-the-last-good-answer.mjs` | The whole primitive: three injected collaborators, no disk, no network, no product word. Copied unchanged. |
| `read-data/ask-and-keep.mjs` | `tool:ask-a-web-address-or-give-the-last-answer`: the live read (a web address, JSON or text, up to 256 KiB), the last answer handed in as `last_answer`, the record to keep (`to_keep`, one `kept-answer` record per key) and the words of the answer. |
| `do-work/ask-a-web-address.mjs` | The row's program: one JSON request on standard input, the answer as JSON on the last line. |
| `part.json` | The primitive is public, so another tool may import it. |
| `what-this-tool-does-and-how-to-run-it.json` | The row: a container run with `may_reach` and no records door. |
| `test/keep-the-last-good-answer.test.mjs` | The package's 28 checks, every one a way a naive version gets it wrong. Touches no file, socket or clock. Copied unchanged. |
| `test/ask-and-keep.test.mjs` | The row as the container runs it, with no records door and a source on this computer's loopback; the function with its web handed in for the failures a real address rarely gives. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `keepTheLastGoodAnswer` | `({ askTheSource, readWhatWasKept?, keepThisAnswer? }) -> () -> Promise<Answer>` | Builds the holder. Throws `TypeError` without `askTheSource`. |
| `Answer` | `{ origin, value, sourceFailure, keepFailure, keptFailure }` | All five keys are always present, null when they do not apply. Failures are returned, never raised and never logged. |
| `FROM_THE_SOURCE` / `FROM_WHAT_WAS_KEPT` / `NOTHING_TO_GIVE` | strings | Where the answer came from; the caller never has to guess. |
| `askAndKeep` | `(input, { fetch?, now? }) -> { origin, answer, kept_at, to_keep, source_failure, retry_after_seconds, said }` | The row's function. `input` is `{ address, key, wait_seconds?, last_answer? }`; `to_keep` is the record to keep when the address answered, null otherwise. |
| `retryAfterSeconds` | `(header, now?) -> number \| null` | Reads a `Retry-After` header: whole seconds or an HTTP date, a past date is 0, held to a day; null when missing or unreadable. |

## Invariants

- A source that answers with nothing has not answered, and never replaces a good kept answer. `0`, `''`, `false` and `[]` are answers.
- The tool keeps nothing and reads no records: the answer holds what to keep, and the caller hands the last answer back.
- A source that answers 429 or 503 with `Retry-After` has its wait returned (`retry_after_seconds`) and said; the tool never waits or asks again itself. The idea comes from the MIT-licensed `bloxwap/smart-hyperevm` and `bloxwap/smart-solana` transports (https://github.com/bloxwap/smart-hyperevm and https://github.com/bloxwap/smart-solana); the code here is written fresh.
- Nothing logs. Timeouts and retries belong to the ask, the only party that knows what a slow answer means.

## Dependencies

**Depends on:** Node 24.

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json`.
