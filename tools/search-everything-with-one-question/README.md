# tools/search-everything-with-one-question/

One question over every list and file: what was said, seen, named or written, in one ranked answer with addresses and timed evidence.

`tool:search-everything-with-one-question` is the account-wide search. The caller hands in the person's records and files (`records`: `[{id, type, value}]`, `files`: `{path: text or {base64}}`), read from the person's own store in its own language; the run searches them and reads no store. It also asks each installed semantic index it finds among the records (`semantic-index-descriptor` rows, with their vector set files in `files`) through the internal readers under `meaning/`, and a file's content or moments need its kept descriptor and set. This tool does not invent transcripts or build a missing index while answering.

Each record kind, index, model and literal-word reader has its own ranking. The existing reciprocal rank finisher combines ranks, preserving model scores and source addresses in `moments[].evidence`. A model that fails is named in `unavailable`, while literal matches remain usable. A picture model's query encoder is named in `read-data/settings.json`. A vector the caller made with it is handed in as `query_vectors` and checked against the encoder's size; without one, a run whose host lets it run another tool asks the encoder once per question and model and checks the model identity it answers, and a run that cannot names the lane `unavailable` (reason `query_vector_not_handed_in`, with `needs` naming the encoder tool and its input). Either way the vector is reused across that model's sets. `places` and `sources` avoid irrelevant reads. Callers can restrict `index_ids`; `query_vectors` are qualified by exact model id and version, and models without an encoder in the settings encode the question themselves.

The former four meaning-search descriptors and duplicate container-named general search descriptor are removed. Their reader code and tests moved into this owner. The scoped-list row below is a least-privilege adapter for software that already knows its list; the HTTP route calls the same implementation. Media assembly reads each moment's original meaning score through its tested adapter, preserving its existing similarity floor.

The former result-search modules and their test live under `results/`; their SQL behavior is preserved without another descriptor. `inventory/` retains the existing source-inventory capture at its admitted, inactive stage. It has no active query or tool row, so this consolidation makes no stronger execution or source-provenance claim for it.

This is old trillion's `search` tool (Trillion-X/trillion `src/file-tools.mjs:125`, which asked GET `/namespace/search`,
`src/namespace.mjs:2127`, finished by `src/search.mjs:1750` `finish`). trillion-rust ported it into the engine, and under the engine's feature boundary (trillion-rust `engine-feature-boundary.json`) it moved here. The engine's record word index and file-name search it used are replaced by a search over what the caller hands in: the work (ranking, fusion, places, moments) stays here, and the records and files are the caller's own (a tool only does what the store cannot do; rule a-tool-is-only-what-the-store-cannot-do).

Lanes over the handed-in values:

- records: every record handed in holding every asked word (a word of its text starts with each term), each kind ranked as its own lane (rank 1, reciprocal rank `1 / (k + rank)`, k = 60). Address: `{ id, type }`, which opens the record in the person's own store.
- file names: the files whose names hold every asked word, scored `0.8 / (k + rank)`. Address: `{ path }`, the name the file was handed in under.

## What it does (`do-work/search-everything.mjs` `searchEverything`)

It is old `finish` (`src/search.mjs` lines 1750-1798 and 1893-1917 at b6ae0ebf), moved byte for byte and then adapted
(`ports/search-everything.json` names every change):

1. The lanes are the records handed in (`read-data/settings.json` `lanes`): each record kind is its own lane (rank 1), and
   the file names (rank 0.8), searched only when no `type` narrows the question. Both are searched with the same question at once.
2. A lane that was not handed its input (no `records`, or no `files`) is named in `unavailable` as
   `{ lane, place, source, reason }`, never guessed.
3. Each lane ranks its own hits; things are merged by reciprocal rank fusion (`rank / (k + rank in the lane)`, k = 60,
   summed over the lanes a thing was found in), best first, cut to `limit` (60 when left out). Each result is its
   owner's hit, with its `address`, plus `found_in`, `places`, `moments`, `said` and the fused `score`.

## Rows

| Row | Runs | Reaches |
|-----|------|---------|
| `tool:search-everything-with-one-question` | a small container, with the declared picture query encoder (`door.run`, another tool's run, an ability of the host and no records operation; the only thing a run reaches outside its input) | the records and file names handed in (`records`, `files`), and each semantic index among them |
| `tool:search-everything-in-a-small-container` | the same search, in its own small container, through the function runner (`tools/workflows/do-work/run-a-function.mjs`) | the same handed-in values |
| `tool:search-one-of-my-lists` | a small container, through the function runner | the records of the one kind its `type` names, as handed in |
| `tool:answer-the-search-page-route` | HTTP adapter of the canonical search | the same account-wide answer |

No row declares a store right: the caller reads the person's records and files from the person's own store, in its own language, and hands them in (rule a-tool-is-only-what-the-store-cannot-do). Nothing here names a records method.

## Files

| File | Purpose |
|------|---------|
| `do-work/search-everything.mjs` | `searchEverything(input, { door })`: the search, as above, over its input; `door` is optional and used only to run the picture query encoder. `answerTheSearchRoute` is the page route over the same input. |
| `ports/search-everything.json` | The port contract: the old lines, the byte-copy commit, what was kept and what was adapted. |
| `read-data/settings.json` | Old `src/search.json`'s numbers and place labels, and the two lanes with their places, sources and ranks. |
| `test/search-everything.test.mjs` | The fusion, a lane not handed its input named unavailable, `type`, 10,000 rows across 3 lists, the rows' declared shape, and the runner run on the handed-in values; the run reaches no store. |
