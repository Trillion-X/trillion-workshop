# tools/find-signals-of-need/

One finder for candidates that show a need: companies whose job post has stayed open for weeks, local businesses whose reviews name a delay or suddenly pick up, or any other list a person's source row describes. `tool:find-signals-of-need` reads a signal-source row, maps each item to fields, drops the items that fail its filters, adds up the weights of the signals each remaining item shows, and returns them best score first with the evidence for every signal. It sends nothing, keeps nothing and holds no credential.

Nothing about a site, a trade or a number ships in code. A source row (`sources.json`, or the person's own as `source_row`) says how an item maps to fields, which filters keep it and which signals score it; the numbers (21 days, 10 to 200 people, 90 days) and the words (`slow quote`) are its knobs. What a signal measures comes from `signal-measures.json`: a measure is a list of steps from a closed set (read, matching, within-days, count, share, age-days, number), so a new measure is a new row there and no code edit. Candidates behind a login (a map data or job board connection) arrive as `items` from the person's connection tool; a source row that declares a public `request` can read its address instead, filled from `parameters`.

A field an item lacks refuses a filter and keeps a signal quiet; it never counts as zero. The same items always give the same ranking (score, then key). Lists such as reviews stay out of the answer; the signals carry the value measured and up to three matching snippets.

## Files

| File | Purpose |
|------|---------|
| `sources.json` | Signal-source rows: `open-job-posts` and `local-businesses-by-place`, as samples of the shape. Each has `fields`, `filters`, `signals` and optionally `request` and `min_score`. |
| `signal-measures.json` | The steps a measure may use and the measures built from them, as DATA. |
| `read-data/signals.mjs` | `findSignals` and `sourceProblems`: the mapping, filters, measures, scoring and ranking. |
| `do-work/find-signals-of-need.mjs` | The command of `tool:find-signals-of-need`: JSON in, `{ result }` or `{ error }` out. |
| `tool-rows.json` | The Workshop row, with a sample run. It packs `research-a-creator-or-topic/do-work/fetch-text.mjs` for the public-address path. |
| `part.json` | Public files. |
| `test/find-signals-of-need.test.mjs` | The finder on made-up candidates: filters, scoring, ranking and ties, missing fields, refused source rows, a measure added only as a row, a stand-in fetch, and the row's command. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| signal-source row | `{ id, label, fields: { key, name, url?, place?, <name>: path or { path, each: { text, date } } }, filters: [{ of, measure, test }], signals: [{ id, says, weight, of, measure, matching?, within_days?, test }], request?: { url, items_path }, min_score? }` | What a source is. `test` is `{ at_least }`, `{ at_most }` or `{ between: [low, high] }`. |
| `findSignals` | `({ source or source_row, items?, parameters?, now?, limit? }, { sources, measures, fetchPage }) -> { source, count, prospects, skipped, said }` | `prospects`: `{ key, name, url, place, fields, signals: [{ id, says, weight, evidence: { value, matched? } }], score, rank }`. `count` is everyone who passed; `limit` (default 50, at most 500) cuts what is shown. `skipped` names each left-out item and why. |
| `sourceProblems` | `(row, measures?) -> string[]` | Every problem with a source row, each saying what to change. |

## Dependencies

**Depends on:** Node 24; `tools/research-a-creator-or-topic/do-work/fetch-text.mjs` for a row's public address (packed by the row; the engine's public-only proxy judges where it may go).

**Depended on by:** `tool-rows.json`; outreach workflows that name `tool:find-signals-of-need`.
