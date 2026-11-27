# tools/pair-unknown-senders/

Holds a message from a sender the person has not paired yet and gives that sender a short code. When the person approves the code, the sender joins that source's paired list and their next message goes through. Nothing here names a source or a platform: sources and senders are the event's own ids. The pairing facts are the person's own: each row is a function of its input, given the facts the caller read from wherever the person keeps them (`facts`, by name), and its answer lists in `keep` the facts to write back. Nothing here reaches a database.

## Files

| File | Purpose |
|------|---------|
| `read-data/sender-pairing.mjs` | `makeSenderPairing({ facts, now, random?, rules? })`: request, approve, revoke, list and isPaired. Moved byte for byte from Trillion-X/trillion `src/sender-pairing.mjs`. |
| `read-data/sender-pairing.json` | The alphabet (no 0, O, 1 or I), the code length (8), its lifetime (60 minutes), the cap on waiting codes per source (3) and every word said. Moved byte for byte. |
| `read-data/pairing-tools.mjs` | The four rows' functions: hands the given pairing facts to the pairing (`factsFrom`) and answers what it wrote as `keep`. |
| `what-this-tool-does-and-how-to-run-it.json` | `tool:pair-an-unknown-sender`, `tool:approve-a-pairing-code`, `tool:unpair-a-sender`, `tool:list-paired-senders`; container rows run by `tools/workflows`' `do-work/run-a-function.mjs`: no door, no held value, no internet, input `facts` beside the call's own fields, answer `keep` beside its own. |
| `ports/sender-pairing.json` | The port contract (SOURCE_FIRST_PORT from trillion). `ports/sender-pairing-door.json` claims the adapter that hands the pairing its given facts as NO_PRIOR_OWNER. |
| `part.json` | Nothing here is imported by other code. |
| `test/sender-pairing.test.mjs` | Trillion's test of the pairing rules with its assertions unchanged, the same rules over given facts with what they keep, and each shipped row run as the engine runs it. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `makeSenderPairing` | `({ facts: { read, list, write }, now?, random?, rules? }) => { request, approve, revoke, list, isPaired }` | A sender with a code waiting gets the same code again; a source with `max_pending` codes waiting issues no more; a code works once, before it expires, for its own source. |
| `factsFrom` | `(facts) => { read, list, write, kept }` | The facts the pairing reads and writes, over the given values; every write is gathered in `kept`, the newest value per name being current. A prefix is matched as plain text, never as a pattern. |

## Moved from Trillion

Trillion-X/trillion `src/sender-pairing.mjs` and `src/sender-pairing.json`, with `test/sender-pairing.test.mjs`'s first test. Its second test runs `src/events.mjs` (the event rules that name `paired_senders`), which stays in trillion until it moves; the old copy stays there until then.

## Dependencies

**Depends on:** `tools/workflows` (`do-work/run-a-function.mjs`), Node's standard library.

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json`. In Trillion-X/trillion, `src/events.mjs` still imports its own copy.
