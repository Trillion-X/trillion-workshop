# tools/pair-unknown-senders/

Holds a message from a sender the person has not paired yet and gives that sender a short code. When the person approves the code, the sender joins that source's paired list and their next message goes through. Nothing here names a source or a platform: sources and senders are the event's own ids. The pairing is kept in the person's own Postgres, as rows of the table `sender_pairing`, read and written with plain SQL.

## Files

| File | Purpose |
|------|---------|
| `read-data/sender-pairing.mjs` | `makeSenderPairing({ facts, now, random?, rules? })`: request, approve, revoke, list and isPaired. Moved byte for byte from Trillion-X/trillion `src/sender-pairing.mjs`. |
| `read-data/sender-pairing.json` | The alphabet (no 0, O, 1 or I), the code length (8), its lifetime (60 minutes), the cap on waiting codes per source (3) and every word said. Moved byte for byte. |
| `read-data/pairing-tools.mjs` | The four rows' functions: hands the pairing facts kept as rows of the table `sender_pairing` (id = the fact's name) to the pairing. |
| `sql/100-sender-pairing.sql`, `sql/101-sender-pairing-source.sql` | The table `sender_pairing` (id, value jsonb, source_id taken from the value, updated_at) and its index on source_id; one statement each, `create ... if not exists`, run before a row runs by `tools/workflows`' `do-work/run-with-sql.mjs`. |
| `tool-rows.json` | `tool:pair-an-unknown-sender`, `tool:approve-a-pairing-code`, `tool:unpair-a-sender`, `tool:list-paired-senders`; container rows run by `tools/workflows`' `do-work/run-with-sql.mjs`: no records door; each reaches only the local port the computer reports as `own-rows-postgres`, with the held connection string `own-rows-postgres-connection` on descriptor 3 and the `pg` libraries pinned as `tool:run-sql-in-my-database` pins them. |
| `ports/sender-pairing.json` | The port contract (SOURCE_FIRST_PORT from trillion). `ports/sender-pairing-door.json` claims the adapter that hands the pairing its SQL facts as NO_PRIOR_OWNER. |
| `part.json` | Nothing here is imported by other code. |
| `test/sender-pairing.test.mjs` | Trillion's test of the pairing rules with its assertions unchanged, the same rules over the table on a real PostgreSQL server, and each shipped row run as the engine runs it. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `makeSenderPairing` | `({ facts: { read, list, write }, now?, random?, rules? }) => { request, approve, revoke, list, isPaired }` | A sender with a code waiting gets the same code again; a source with `max_pending` codes waiting issues no more; a code works once, before it expires, for its own source. |
| `factsOver` | `(sql) => facts` | The facts the pairing reads and writes, as rows of the table `sender_pairing`; a write to a name replaces its row, so the newest value is current and writing it again changes nothing. A prefix is matched as plain text (`starts_with`), never as a pattern. |

## Moved from Trillion

Trillion-X/trillion `src/sender-pairing.mjs` and `src/sender-pairing.json`, with `test/sender-pairing.test.mjs`'s first test. Its second test runs `src/events.mjs` (the event rules that name `paired_senders`), which stays in trillion until it moves; the old copy stays there until then.

## Dependencies

**Depends on:** `tools/workflows` (`do-work/run-with-sql.mjs`, `read-data/sql.mjs`, `read-data/with-sql.mjs`, and its test helper), Node's standard library.

**Depended on by:** `tool-rows.json`. In Trillion-X/trillion, `src/events.mjs` still imports its own copy.
