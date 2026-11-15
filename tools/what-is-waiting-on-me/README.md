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

## Screens

Moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity); the client build opens each from this folder as a screen module and shares the web shell's files it imports with the page.

| File | Purpose |
|------|---------|
| `web/src/workspace/waiting-screen.tsx` | The screen: Waiting on you, one thing at a time (`tool:screen-waiting`) |
| `show/waiting-mount.tsx` | Its mount entry: the one `mount(element, props)` export the row's `screen.module.entry` names |

## Current records and page binding

`tool:read-what-is-waiting-on-me` (`read-data/waiting-records.mjs`) binds the same aggregator to the current records door and declared reader tools. The person's `record:waiting-sources` rows extend or override `read-data/waiting-sources.json`; create, inspect, edit and remove those source definitions through the generic record/list management surface. Source rows keep the original `title`, `where`, `detail`, `at` and card templates and add `read` (a record query, or a current tool with its collection/cursor paths) and optional section metadata. New sources remain subject to the tool descriptor's exact record and nested-run grants. No source definition widens that authority.

The grounded adapters read asks, real post records, blocked AI jobs, notification devices and paged decision summaries. Given assignments, new work, service sign-ins and unnamed voice sessions remain unread: their original admitted shared-space, activity/seen, sealed connection and speaker/Namespace owners have no equivalent current adapter here. The answer retains each missing source and its error. `complete` requires every declared source to be read with no skipped cards; a bound, missing owner or refusal never means nothing waits.

`tool:finish-what-is-waiting-on-me` performs only a source's declared same-record completion with a conditional write and actual target readback. The asks transition comes from the original list's `done_sets`. Rounds reuse the exact pure `read-data/work-rounds.mjs` owner, adopted from the original copy without changing its bytes (the source receipt is `moved-from.json`): one command counts/logs/restarts one round, keeps its retry identity on that same row, and sets Done only at the planned final round. Other sources are refused until their action owner is declared; no draft is approved or published by this tool.

The round module's original copied bytes remain in commit `6bc50c6bbb9b3301dc8cda3ebd9b035ae63ba345`; Git records its move into the active library. The copied and current modules both have BLAKE3 identity `1f:e25d8973b94731c5f517220b300a6a9bdb7b61be196bb5ad8178d30b81cc3ad7`. The existing source receipt retains the original repository, source paths and commits, with the current destination updated.

The Apps waiting screens and the hold's existing read lifecycle consume this projection. A known item may remain visible with explicit partial coverage; an empty incomplete answer is unavailable. These are source-qualified bindings, not evidence of installed full coverage.
