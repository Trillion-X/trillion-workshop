# tools/cross-techniques-with-a-goal/

Keeps every technique a person captures by **why it works**, in words shared by every other technique, so any technique can be used for any goal in any medium: a radio drama's "the narrator speaks to you as your younger self" can serve a sales page, because both are stored as the same mechanism, not as "radio". Two Workshop tools, both run on the person's own computer with models they name:

- `tool:say-why-a-technique-works` gives technique rows their crossing fields and grows the shared vocabulary.
- `tool:cross-techniques-with-a-goal` crosses all of them with a goal: the techniques whose mechanism serves it, from any medium; pairs that compound; one concrete line for each. It needs only a chat model.

## The crossing fields

| Field | Holds | Shared vocabulary? |
|---|---|---|
| `mechanism` | Why it works, as what it does to a person's mind or to a system; never names a medium | Yes: the `mechanism` vocabulary |
| `operates_on` | The abstract property it changes (attention over time, trust, perceived effort, recognisability, reproducibility) | Yes: the `property` vocabulary |
| `needs` | Preconditions, each `{ says, property }`: the property it is about, or `null` when none is close | `property` tag only |
| `produces` | Its effects, plain phrases | No |
| `from_medium` | Where it was found | No (kept to show the crossing) |
| `proposed` | The writer's own answer, kept as evidence | No |

Which fields are vocabulary-bound is DATA: `bound.why` and `bound.changes` in `do-work/technique-conventions.json`.

Nothing about any person's techniques ships here: their rows, vocabulary and row shape come with each request. By default the writer reads `name`, `kind` and `description` first, then every other words field; a request names its own with `reading` (`first`, `skip`, ...), and `say-why-for-files.mjs` also takes `carry`, the source fields copied onto crossing rows. The worked examples the writer sees are made up.

## The vocabulary rule (code-enforced)

For a reviewed subset, `settle` accepts `row_ids` and leaves other sidecar rows unchanged. Each source can name `exclude_rows: [{ id, from_hash }]` to withhold an exact source version from every operation and remove its stale sidecar inference on checkpoint. `from_hash` is the existing 32-digit BLAKE3 of the source row's JavaScript JSON serialization; changing the source makes the old exclusion inapplicable. Source files remain read-only.

`require_judgment: true` requires a current judgment before adding or merging any unfamiliar meaning, including pairs above the automatic reuse line or below the new-term line. A matching term or alias with a different or missing definition also waits for judgment. Both definitions must be present and exact to reuse a known term directly. Use bound recorded judgments to keep missing definitions and unreviewed pairs held.

A vocabulary (`{ says, reuse_at, new_below, terms: [{ term, says, aliases, from, vector }] }`) grows by itself; no term is in code. Every proposed term goes through `admit` (`do-work/vocabulary.mjs`):

1. The same words as a term or one of its aliases: that term.
2. Else the nearest term at least `reuse_at` close in meaning: that term; the proposal becomes its alias.
3. Else, if any term is at least `new_below` close: a judge picks one of them or none.
4. Else: a new term.

A proposal waiting on a judgment enters as a **provisional** term, so later proposals are judged against it; rows that touch a provisional term are held whole, and provisional terms are never saved.

### Measured lines

`do-work/measure-reuse-line.mjs` embeds the hand-labelled pairs in `do-work/reuse-line-pairs.json` (10 same, 11 different). With `embeddinggemma`, 768 dims, document form `title: {term} | text: {says}` (2026-10-30):

| Measure | Value |
|---|---|
| Least close "same" pair | 0.439 (progressive disclosure / chunking) |
| Closest "different" pair | 0.713 (perceived effort / perceived value) |
| Best single line | 0.552, still misplacing 3 of 21 pairs |
| `new_below` / `reuse_at` | 0.43 / 0.72 |

No single line separates the two sets: a shared word pulls different terms together. Only the band between the two lines is judged. Terms such as "reliability" and "reproducibility" can sit inside the band, close in meaning yet different; the judge keeps them apart where a single line would merge them.

A term's meaning is whatever any proposal of it said: a writer that reuses a term leaves `says` empty, and the fold fills it from the proposal that defined it before anything is embedded or judged.

Need tags (`needs_tags.tag_min` 0.366) were measured over the made-up pairs in `do-work/need-tag-pairs.json`: right tags 0.381-0.710, wrong ones 0.226-0.402, 1 of 24 misplaced. A tag is a lead for pairing, never a fact. Plain made-up needs separate more cleanly than real ones, so a person re-measures the line over pairs from their own needs (`measure-reuse-line.mjs` with `pairs` in the request).

## How crossing works

Closeness in meaning is not used to decide whether a mechanism serves a goal. Measured 2026-10-30 for a budgeting-app sales page: wants scored 0.24-0.37 (document form) against the mechanisms that serve them, and 0.22-0.375 against ones that do not. Query form was lower still, 0.15-0.30. Embeddings measure topical likeness, not function. So `crossTechniquesWithAGoal` takes four steps:

1. **Wants:** the writer turns the goal into wants, each naming 1-3 terms from the property vocabulary (it is shown every property with its `says`).
2. **Join:** rows whose `operates_on` holds a wanted property are joined exactly (`candidatesFor`). Their mechanisms are ordered by how many media they span, then by row count.
3. **Pick:** the writer picks up to `picks_per_want` candidate mechanisms per want. `techniquesFor` takes rows holding a picked mechanism and a wanted property, round-robin over wants and media.
4. **Pairs and lines:** `pairsOf` builds "prepares" from `operates_on` joined to `needs[].property`, then "covers" from different wants. The writer writes one line per technique and pair.

A term the writer names that is not in the vocabulary, or a mechanism outside its candidate list, is dropped and listed in `unknown`.

## Files

| File | Purpose |
|---|---|
| `do-work/meaning.mjs` | OpenAI-compatible `embedder` (unit vectors cut to `dims`, wrapped in the model's query/document forms) and `writer` (JSON shaped by a schema, temperature 0); `cosine`; `sameMeaning`. |
| `do-work/vocabulary.mjs` | `admit`, `findTerm`, `nearest`, `withoutProvisional`, `emptyLexicon`, `boundFields`. |
| `do-work/say-why.mjs` | `makeProposer` (live writer, shown each row's nearest existing terms), `makeSettler` (the deterministic fold of proposals into the lexicon, needs tagged after the fold), `askingJudge`, `recordedJudge`, `rowText`. |
| `do-work/cross.mjs` | `candidatesFor`, `techniquesFor`, `pairsOf` (the exact joins) and `crossTechniquesWithAGoal` (wants, pick, lines through the writer). |
| `do-work/say-why-a-technique-works.mjs` | `tool:say-why-a-technique-works` command. |
| `do-work/cross-techniques-with-a-goal.mjs` | `tool:cross-techniques-with-a-goal` command. |
| `do-work/say-why-for-files.mjs` | A whole library of row files on one computer: `list`, `propose`, `take`, `settle`, `rows` (below). |
| `do-work/measure-reuse-line.mjs` | Measures a vocabulary's lines for one embedding model. |
| `do-work/place-rows-in-declared-terms.mjs` | Each row gets one term from a short list the person declares (the terms, or `terms_from` the file they keep them in), from its own free words, or `none`: `closeness` (to measure the line, kept in `technique-conventions.json` `placing_line`) and `place`. |
| `do-work/group-rows-by-meaning.mjs` | Rows across a library that say the same thing share one group, by `admit` with each row's words as the proposal: `pairs` (closeness bands, for labelling) and `group` (below). |
| `do-work/technique-conventions.json` | Bound fields, measured lines, the words the writer reads, instructions and Claude-written worked examples, crossing prompts and limits. |
| `do-work/reuse-line-pairs.json` | The hand-labelled term pairs (vocabulary lines). |
| `do-work/need-tag-pairs.json` | The made-up, hand-labelled need/property pairs (`needs_tags.tag_min`). |
| `test/vocabulary-and-settle.test.mjs` | Admission order, the band, provisional terms, the fold, stale "none" judgments, definitions filled in, `rowText`. |
| `test/cross-medium.test.mjs` | 20 rows from 4 media crossed with a sales page (a fifth medium) on the writer's recorded answers; the exact joins on their own. |
| `test/say-why-for-files.test.mjs` | A `.jsonl` source and its sidecar name; a writer with `seed: null` and `body` against a stand-in server that wraps its JSON in a thinking block and a fence. |
| `test/place-rows-in-declared-terms.test.mjs` | Terms are read by a `{ key: value }` path from the person's file; the first word that places gives the term (same words, then closeness at the measured line), else none; another meaning is refused. |
| `test/group-rows-by-meaning.test.mjs` | Same words and same meaning join the first row's group; the band is related, never merged; folds repeat exactly; pairs never come from one source. |
| `test/record-cassette.mjs` | Re-records the writer's answers for the fixture from a live model. |
| `test/fixtures/` | The cross-medium rows and their vocabulary (made up: four invented sources and a sales page goal), and the recorded writer answers. |

## Rows that say the same thing

`group-rows-by-meaning.mjs` reads one JSON request on standard input (`step`, `sources: [{ file, text: [fields], label?, id? }]`, `meaning`, `vectors_file`, `groups_file`, and for `pairs` the `bands` and `per_band`) and prints `{ result }`. Every row's words are embedded once (the vectors file keeps each vector with the BLAKE3 of its words). `group` folds rows in source order through `admit`: the same words, or closeness at or above `reuse_at`, join the group of the first row that said it (its id is the group's id); a row in the band keeps the groups it is close to as `related`, with their closeness, and is never merged, because a model judging its own kind of text agreed with every row it was shown. The groups file holds `rows: { id: { group, how, closeness?, related } }`, keyed by row id as `place-rows-in-declared-terms.mjs` keys its rows, so a list builder can look a row up; `related` is closest first, at most five. The lines are `technique-conventions.json` `row_lines`, kept beside the meaning they were measured with; `group` with another meaning is refused. A person measures lines for another meaning with `pairs`, labels the pairs, and runs `measure-reuse-line.mjs` with them: rows written as whole sentences sit closer together than terms do, and one line rarely separates them.

`place-rows-in-declared-terms.mjs` reads one JSON request on standard input (`step`, `terms` or `terms_from: { file, path }`, `out_file`, `sources: [{ file, words: [fields], id? }]`, `meaning`) and prints `{ result }`. A path step is a key, an index, or `{ key: value }`, the list element whose key holds that value, so a list field's `choices` are read where the person keeps them and never copied. The list never grows: a row's words are tried in order (main word first); the same words as a term or an alias give that term, else the closest term (vocabulary `nearest`) when it is at least `placing_line.at_least` close, the line `technique-conventions.json` keeps beside the meaning it was measured with (a request with another meaning is refused), else the next word; a row none of whose words place is `none`. `closeness` lists every word with its three closest terms, for a person to read and measure the line for another meaning; `place` writes `{ rows: { id: { term, from, how, closeness? } } }` and leaves the source rows unchanged.

## A library of row files

`say-why-for-files.mjs` reads one JSON request on standard input and prints `{ result }` as its last line. Source files are only read: a `.jsonl` file holds one row per line, any other file is JSON (a list of rows, or an object with `rows`). Each source gets a sidecar `<name>.nxn.json` (or the path given), and one lexicon file holds the shared vocabulary.

A model in a request is `{ url, model, key_env? }`; a writing model may also name `body` (more request fields its server reads, for example `{ "chat_template_kwargs": { "enable_thinking": false } }`) and `seed: null` (no seed is sent, because a server that batches requests, such as `mlx_lm.server`, batches only unseeded ones). A writer's answer may arrive inside a thinking block or a code fence; the JSON object in it is read.

- **`list`**: the rows with no current proposal (`{ source, id, text }`).
- **`propose`**: asks `models.writing` for proposals, a few rows per call.
- **`take`**: puts proposals written elsewhere onto their rows (`{ proposed_by, rows }` files).
- **`judge`**: judges `waiting_file` cases in batches (`batch_size`, default 24; optional `limit`) through `models.writing`, saving `judgments_file` after every batch. Answers carry a reason and a validated candidate index. This saves model calls; model choices still require semantic quality checks before a fold. Recorded choices retain `proposed_says` and `candidate_definitions`; a changed definition or an old record without these bindings cannot decide a fresh fold. Missing definitions remain waiting rather than proving a new term.
- **`settle`**: folds proposals into the lexicon. Use `fresh: true` for every row from an empty lexicon, otherwise only changed rows are folded. Rows are folded `checkpoint_every` at a time (100 by default) and the sidecars and lexicon are saved after each part, so a settle that stops keeps what it finished and the next run folds only the rest. With `judge: "ask"`, an answer that is not JSON leaves that term undecided (provisional) rather than ending the settle. `judge: "ask"` judges now; `"recorded"` reads `judgments_file` and writes what is still to judge to `waiting_file`.
- **`rows`**: the joined rows (`carry` fields plus crossing fields) ready for crossing.

A sidecar row carries `from_hash` (BLAKE3 of the source row) and `settled_from` (BLAKE3 of its proposal), so every step only touches what changed.
Joined rows and settling reject a proposal whose source hash is stale. A corrected source must receive a current proposal before its old inferred crossing fields can reappear.

## Dependencies

**Depends on:** Node 22.6+, `tools/content-identity` (only `say-why-for-files.mjs`), an OpenAI-compatible chat model (both tools) and embedding model (say-why only). On Ollama: `qwen2.5:14b-instruct` and `embeddinggemma`.

**Depended on by:** the intake recipe step that describes new techniques.
