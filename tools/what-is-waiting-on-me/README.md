# tools/what-is-waiting-on-me/

Everything that waits on one person, gathered from the places it is kept into one answer. `tool:what-is-waiting-on-me` takes the person's own list of sources (one row per place that holds things up: which records wait, how a card reads) and the records of each source, and gives back one card per waiting record, newest first, a count per source and a sentence. Ported from the app's Waiting on you answer (`src/waiting-on-you.json` and its card reader); the old source list is not carried, so the starter rows are the person's to write.

The tool names no source, kind of record or thing that can wait. A source row is `{ id, label, title, where?, detail?, opens?, at?, id_field?, most? }`: `where` is a list of tests on the record's fields (`equals`, `in`, `present` or `absent`), and `title`, `detail` and `opens` are templates with `{path}` holes over the record's own fields (`opens` is the address the card takes the person to). The caller reads each source's records from the person's account, so this tool holds no records right, and a source whose records were not handed in is told as `unread`, never as nothing waiting. A record that gives its card no title is not shown and is counted as skipped.

## Files

| File | Purpose |
|------|---------|
| `read-data/waiting.mjs` | `whatIsWaitingOnMe`: the filter, the templates, the merge and the sentence. Its header lists the invariants. |
| `read-data/waiting-words.json` | The default sentences; a request may bring its own. |
| `do-work/what-is-waiting-on-me.mjs` | The command of the tool. |
| `tool-rows.json` | The row, with a sample run. |
| `part.json` | Nothing here is imported by other code. |
| `test/waiting.test.mjs` | Made-up sources and records: what waits, order, skipped, unread, most, sentences, the same answer in any order, refused rows, and the row. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `whatIsWaitingOnMe` | `({ sources, found, words? }) -> { cards, sources: [{ id, label, waiting, skipped, unread }], count, said }` | The one gathering. |
| card | `{ source, label, id, title, detail?, opens?, at? }` | One thing waiting. |

## Dependencies

**Depends on:** Node 24 only.

**Depended on by:** `tool-rows.json`; the workflows that name `tool:what-is-waiting-on-me`.
