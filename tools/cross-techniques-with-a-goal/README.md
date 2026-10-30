# tools/cross-techniques-with-a-goal/

Keeps every technique a person captures by **why it works**, in words shared by every other technique, so any technique can be used for any goal in any medium: a stick-figure video's "the viewer is the one who did nothing" can serve a sales page, because both are stored as the same mechanism, not as "video". Two Workshop tools, both run on the person's own computer with models they name:

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

## The vocabulary rule (code-enforced)

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

No single line separates the two sets: a shared word pulls different terms together. Only the band between the two lines is judged. In the 2026-10-30 backfill, the judge kept "reliability" apart from "reproducibility" (0.635) and "recognisability" apart from "comprehension" (0.649). A single line would have merged both.

A term's meaning is whatever any proposal of it said: a writer that reuses a term leaves `says` empty, and the fold fills it from the proposal that defined it before anything is embedded or judged.

Need tags (`needs_tags.tag_min` 0.467) were measured over `do-work/need-tag-pairs.json`: right tags 0.468-0.543, wrong ones 0.450-0.549, 2 of 22 misplaced. A tag is a lead for pairing, never a fact.

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
| `do-work/technique-conventions.json` | Bound fields, measured lines, the words the writer reads, instructions and Claude-written worked examples, crossing prompts and limits. |
| `do-work/reuse-line-pairs.json` | The hand-labelled term pairs (vocabulary lines). |
| `do-work/need-tag-pairs.json` | The hand-labelled need/property pairs (`needs_tags.tag_min`). |
| `test/vocabulary-and-settle.test.mjs` | Admission order, the band, provisional terms, the fold, stale "none" judgments, definitions filled in, `rowText`. |
| `test/cross-medium.test.mjs` | 20 rows from 4 media crossed with a sales page (a fifth medium) on the writer's recorded answers; the exact joins on their own. |
| `test/record-cassette.mjs` | Re-records the writer's answers for the fixture from a live model. |
| `test/fixtures/` | The cross-medium rows and their vocabulary (from the 2026-10-30 backfill, ids renamed), and the recorded writer answers. |

## A library of row files

`say-why-for-files.mjs` reads one JSON request on standard input and prints `{ result }` as its last line. Source files are only read. Each source gets a sidecar `<name>.nxn.json` (or the path given), and one lexicon file holds the shared vocabulary.

- **`list`**: the rows with no current proposal (`{ source, id, text }`).
- **`propose`**: asks `models.writing` for proposals, a few rows per call.
- **`take`**: puts proposals written elsewhere onto their rows (`{ proposed_by, rows }` files).
- **`settle`**: folds proposals into the lexicon. Use `fresh: true` for every row from an empty lexicon, otherwise only changed rows are folded. `judge: "ask"` judges now; `"recorded"` reads `judgments_file` and writes what is still to judge to `waiting_file`.
- **`rows`**: the joined rows (`carry` fields plus crossing fields) ready for crossing.

A sidecar row carries `from_hash` (BLAKE3 of the source row) and `settled_from` (BLAKE3 of its proposal), so every step only touches what changed.

## Dependencies

**Depends on:** Node 22.6+, `tools/content-identity` (only `say-why-for-files.mjs`), an OpenAI-compatible chat model (both tools) and embedding model (say-why only). On Ollama: `qwen2.5:14b-instruct` and `embeddinggemma`.

**Depended on by:** the intake recipe step that describes new techniques.
