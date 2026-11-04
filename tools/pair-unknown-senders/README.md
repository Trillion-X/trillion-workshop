# tools/pair-unknown-senders/

Holds a message from a sender the person has not paired yet and gives that sender a short code. When the person approves the code, the sender joins that source's paired list and their next message goes through. Nothing here names a source or a platform: sources and senders are the event's own ids. The pairing is kept as the person's own `sender-pairing` records, read and written through their records door.

## Files

| File | Purpose |
|------|---------|
| `read-data/sender-pairing.mjs` | `makeSenderPairing({ facts, now, random?, rules? })`: request, approve, revoke, list and isPaired. Moved byte for byte from Trillion-X/trillion `src/sender-pairing.mjs`. |
| `read-data/sender-pairing.json` | The alphabet (no 0, O, 1 or I), the code length (8), its lifetime (60 minutes), the cap on waiting codes per source (3) and every word said. Moved byte for byte. |
| `read-data/pairing-tools.mjs` | The four rows' functions: hands the pairing facts kept as `sender-pairing` records (id = the fact's name) through the records door. |
| `tool-rows.json` | `tool:pair-an-unknown-sender`, `tool:approve-a-pairing-code`, `tool:unpair-a-sender`, `tool:list-paired-senders`; container rows run by `tools/records-door`'s `run-an-export.mjs`. |
| `ports/sender-pairing.json` | The port contract (SOURCE_FIRST_PORT from trillion). `ports/sender-pairing-door.json` claims the door adapter as NO_PRIOR_OWNER. |
| `part.json` | Nothing here is imported by other code. |
| `test/sender-pairing.test.mjs` | Trillion's test of the pairing rules with its assertions unchanged, and the rows run against the stand-in records door. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `makeSenderPairing` | `({ facts: { read, list, write }, now?, random?, rules? }) => { request, approve, revoke, list, isPaired }` | A sender with a code waiting gets the same code again; a source with `max_pending` codes waiting issues no more; a code works once, before it expires, for its own source. |
| `factsOverDoor` | `(door, type?) => facts` | The facts the pairing reads and writes, as records of one kind; each write is sent with a key made from its name and value. |

## Moved from Trillion

Trillion-X/trillion `src/sender-pairing.mjs` and `src/sender-pairing.json`, with `test/sender-pairing.test.mjs`'s first test. Its second test runs `src/events.mjs` (the event rules that name `paired_senders`), which stays in trillion until it moves; the old copy stays there until then.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs` and the door client), Node's standard library.

**Depended on by:** `tool-rows.json`. In Trillion-X/trillion, `src/events.mjs` still imports its own copy.
