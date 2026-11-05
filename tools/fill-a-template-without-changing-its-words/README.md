# fill-a-template-without-changing-its-words

Word-level templates, so changed words cannot hide inside rewritten chunks. A template keeps the author's literal words (and every other measured value) of any piece of content: a spoken script, a post, a slide, an article section, a page. Only the author's own specifics become typed slots. A fill may change slots only, every change is visible word by word, and events tied to words (a transition, a graphic, a caption, a section break) follow those words when the script is rewritten.

Four commands, run by the person's AI on the person's own computer, and `build.py`, which keeps a whole library of templates and drift reports up to date. Python 3, standard library only.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The six Workshop rows: `tool:make-a-word-template`, `tool:fill-a-word-template`, `tool:check-words-against-a-word-template`, `tool:re-time-events-tied-to-words`, `tool:write-a-word-template-from-the-words-i-keep-and-the-slots`, `tool:make-spoken-line-candidates-one-slot-at-a-time`. All `on-your-computer`. |
| `part.json` | The modules other code may import: the core, the operations, the renderer and the registry. |
| `do-work/make_template.py` | `make_template.py <spec.json or one measurement> <out.template.json>`: measures a piece into a template and writes `<out>.md` beside it. |
| `do-work/fill.py` | `fill.py <template.json> <fills.json> <out.md> [--piece out.piece.json]`: fills the slots from sourced values. |
| `do-work/drift.py` | `drift.py <template.json> <script.md or piece.json> [--check] [--exceptions exc.json] [--json report.json]`: judges a piece against the template, dimension by dimension. |
| `do-work/build.py` | `build.py <discovery.json> [--registry R] [--only TEXT] [--force]`: rebuilds every template, fill and drift a discovery file describes, only where an input changed, and writes an INDEX. |
| `do-work/retime.py` | `retime.py <piece.json> <new-transcript.json> <out.piece.json> [--report]`: moves every token bound to words to where those words now play. |
| `do-work/token_table_from_parts.py` | `token_table_from_parts.py --request FILE [--request FILE ...]`: writes word-template tables by hand from kept words and slot words (README: Hand-written token tables). |
| `do-work/vary_slots_one_at_a_time.py` | `vary_slots_one_at_a_time.py --request FILE [--request FILE ...]`: the candidates of a spoken line, one slot varying at a time, each with its script, shot file and claims file (README: Slot candidates). |
| `read-data/request_files.py` | `load_request`: one or more request files laid over each other key by key, or standard input, with the person's settings row (`settings_record`, through tools/settings `request_settings`) and `settings` laid under it. |
| `read-data/wt_core.py` | Errors, words, source checks and the readers (the only per-format code). |
| `read-data/wt_ops.py` | The operations, drift and metrics. |
| `read-data/wt_render.py` | The template markdown, the fill markdown and the drift text. |
| `read-data/dimensions.json` | The generic registry (data): value kinds, media, readers, slot rules, tokenizer and 25 dimensions for words, layout and colour. A craft's own dimensions are the person's: a row of their `list:settings` (`--settings-record`) or a registry file (`--registry`). |
| `test/test_settings_record.py` | The registry, discovery and films read from a made-up `list:settings` row (`--settings-record`, `--scope`): the template remembers the row, fill and drift ask for it again, a registry file beats the row, the most specific scope wins, a changed row rebuilds, and every refusal says how to fix it. |
| `test/test_word_template.py`, `test/test_bound_to.py` | Unit tests: operation matrix, a data-only dimension, a data-only medium and value kind, flipped assumptions, every reader, incremental library builds, binding and re-timing. |
| `test/test_token_table_from_parts.py`, `test/test_vary_slots.py` | The two hand-written-table commands on made-up words: ids, slot bookkeeping, the files written, a dropped sentence, layered request files, the settings row and `settings` laid under the request (also through the settings wrapper), a row for another tool or retired refused, every refusal. |
| `test/sample_registry.py` | The registry the tests use: the shipped one plus invented tasting-sample dimensions and a few sound and rhythm dimensions, so no one person's vocabulary is in the repository. |
| `test/fill-a-template.test.mjs` | Runs the Python tests under `npm test`, then the four commands end to end on a written example. |

## How to run it

```
python3 -I tools/fill-a-template-without-changing-its-words/do-work/make_template.py <spec.json | transcript.json | post.json | slide folder> <out>/TEMPLATE.json
python3 -I tools/fill-a-template-without-changing-its-words/do-work/fill.py  <TEMPLATE.json> <fills.json> <out.md> [--piece out.piece.json]
python3 -I tools/fill-a-template-without-changing-its-words/do-work/drift.py <TEMPLATE.json> <script.md | any piece.json> [--check] [--exceptions exc.json] [--json r.json]
python3 -I tools/fill-a-template-without-changing-its-words/do-work/retime.py <piece.json> <new-transcript.json> <out.piece.json> [--report]
python3 -I tools/fill-a-template-without-changing-its-words/do-work/build.py <discovery.json> [--registry dimensions.json] [--only TEXT] [--force]
python3 -I tools/fill-a-template-without-changing-its-words/test/test_word_template.py
```

Each command prints one summary line and exits 0, or prints `name: what is wrong, and how to fix it` on standard error and exits 2 (`drift.py --check` exits 1 when a judged dimension misses its threshold). `tesseract` is needed only to read images (the `ocr_images` reader); when it is missing those dimensions are `pending` with the reason.

## A whole library (`build.py`)

`build.py` reads a discovery file (JSON, paths relative to its `root`) and rebuilds, one piece at a time, only what changed: each output's inputs (sources, spec, fill, registry and the tool's own code) are stamped by size and modification time in the manifest, so a second run with nothing changed rebuilds nothing.

| key | holds |
|---|---|
| `references` | a group or list of groups `{glob, items?: "directories" \| "files", skip_names?, medium, out, spec?, sources}`: every folder (or file) the glob finds becomes a reference template. `{dir}`, `{parent_dir}`, `{id}`, `{path}`, `{name}` are filled in `out`, `spec` and `sources`; a source may be `{from_file, regex, path}` to take a path out of another file. Entries no longer found are retired from the manifest; their files stay. |
| `templates` | `[{spec, out}]`: more templates built from specs. |
| `fill_values` | `{glob, template, suffix?}`: each fill-values file filled into its template (`fill.py`), written beside it as `.md` and `.piece.json`. |
| `fills` | `{glob, template, out, skip_dir_prefix?, skip_names?}`: each filled script judged against its template (`drift.py`). |
| `films` | a JSON file `{"films": [{film, reference_template, script?, column?, render?: {medium, sources}, render_template?, why?}]}`: a finished piece judged against its reference, by its script, a measured render, or both; `why` is shown while nothing can be judged yet. |
| `manifest`, `index` | where the stamps and summaries are kept, and where the INDEX (Markdown counts and tables) is written. |
| `film_drifts`, `renders` | folders for film drift reports and render measurements (default `drift/films` and `renders` beside the manifest). |
| `registry` | the person's registry (or `--registry`). |

The last line printed is the run's counts: `{templates_built, templates_unchanged, templates_failed, drifts_built, drifts_unchanged, drifts_failed, seconds}`.

## Hand-written token tables

When no registry reader detects a piece's file, `token_table_from_parts.py` writes its token table from the person's words: for each template a `name`, `t0` and `t1`, a `source` (where the words came from), `parts` (`["K", "kept words"]` or `["S", SLOT, "words in the slot"]`) and `slots` (`{SLOT: [type, note]}`), with `out`, `registry` and `dim` (the dimension every word is written in) for the run. `registry` defaults to the shipped `read-data/dimensions.json`; when it is the person's own registry object, kept in their settings row as `make_template.py` reads it, the template names that row (`"registry": "setting:<row id>"`), exactly as `make_template.py --settings-record` does, so `fill.py` and `drift.py` ask for the same row. Every word becomes a token marked `KEEP` or `SLOT`, in order; a slot token carries its slot, type and note; only slots a word uses are listed; every other dimension is left pending with the reason. The output has the shape `make_template.py` writes, so `fill.py` and `drift.py` take it. The words, times and sources are the person's own and come in the request (a row of their records, written to a file), never from this folder.

## Slot candidates

`vary_slots_one_at_a_time.py` makes the candidates of a spoken line one slot at a time: `slots` (each `name`, a `base` pick, and `candidates` `{id: {text, claim}}`), `sentences` (a `template` with `{SLOT}` where a slot's words go, and `claim_from: SLOT` or a fixed `claim`), `id_prefix`, `script_path`, `shot_about`, `claims_about` and `out` (`here`: the folder of `lines/<id>.txt`, `lines.txt` and `manifest.json`; `narrator`: the folder of `shots/` and `claims/`, the layout of a film's narrator folder). It writes the base variant, then every other candidate with all other slots at their base pick. Each variant gets `<here>/lines/<id>.txt`, a shot file and a claims file with one `{"words", "kind": "claim", ...}` entry per sentence, taken from the candidate that formed it; a sentence whose filled words are empty is left out, and a picked candidate with words but no claim is refused. The last line is `{"result": {"variants", "ids"}}` or `{"error"}`.

Both commands take `--request FILE` more than once, laid over each other key by key (an object key is merged one level down), so the person's settings stay a row of their records and the paths stay with the run.

The person's settings are a row of their `list:settings`, `record:setting:fill-a-template-without-changing-its-words~<scope_kind>~<scope_id>` (`piece` and the line's id, for example), read with the one shared reader, `tools/settings/read-data/settings.py` `request_settings`. The request's `settings_record` is that row (as `records:read` gives it, its value, or a file of it; a row whose `tool` is another command's, or that is `retired`, is refused), and the request's own `settings` object lays over it. The result is laid under the request's other keys the same way, so the run's `out` paths win. These rows sit in the same folder as the registry row (`account~main`, read by `--settings-record`): when `settings_record` holds several rows, the request's `scope` (`"piece:<id>"` or a list, most specific first, the same as `--scope`) picks one. A request that names the row's id is run under `tools/settings/do-work/run-with-settings.mjs --folder fill-a-template-without-changing-its-words -- python3 -I <command>`, which reads it through the records door; without the wrapper an id is refused, so a named row is never silently ignored.

## Model

A **piece** (a reference, a fill, a measured render of your own, a family template, a series) contains **units** (slides, posts, sections, segments, scenes: the medium decides). Units contain **regions** (speech, headline, body, paragraph, media, ...). Regions contain **tokens**:

```
{"id", "unit", "region", "t"?, "t1"?, "parent"?, "refs"?: [{"to", "rel"}],
 "dims": {<dimension id>: value, ...}, "mark": "KEEP" | "SLOT", "slot"?, "slot_type"?, "slot_note"?, "slot_dims"?}
```

A token can carry any dimension. A token can sit inside another token (`parent`): a unit holds objects, an object holds its texture, the texture holds its colour. A token can point at any other token (`refs`): a sound `lands_on` a transition. A piece can contain whole pieces (`nest`): a series holds episodes. A slot can span many tokens and can recur (the launched thing is one slot used 8 times). `lines` group text tokens for reading; each line has a `job`.

A recurring slot keeps each timed occurrence when filled. Tokens with the same per-dimension line identity stay one phrase even when the unit changes; different line identities remain separate occurrences; when line metadata is absent, distinct units separate occurrences; legacy tokens without either keep adjacency grouping.

Automatic unit assignment requires a timed record's full interval to fit inside the unit. A record spanning a boundary between units or an uncovered gap stays at piece level; its source times are preserved. Point events at a boundary join the incoming unit. Explicit source unit assignments remain authoritative. Endpoint arithmetic has a 1 ns tolerance; onset boundaries are half-open.

### Partial timed coverage

A source may cover only selected intervals. List only the units you have; gaps between them are not implicit units. Timed tokens join a unit only when `t0 <= token.t < t1`. A missing end is open; a numeric zero end remains finite. Tokens outside every recorded interval stay at piece level, so the whole transcript is preserved without assigning its tail to the last inspected unit.

## The registry is data (`read-data/dimensions.json`)

Nothing about what can be measured lives in code:

| section | holds | adding one |
|---|---|---|
| `dimensions` | id, name, media it applies to, region, `value_kind`, `measure` (reader + field, or a method that says how it would be measured), optional reader applicability, `drift` (threshold and limits), `auto_slot_rules`, `line_break_on_change`, `written_by` | one row |
| `value_kinds` | the comparator as data: `pair` (sequence = difflib, order = first with first, time = nearest within `tolerance_s`) + `test` (equal, equal_if, distance with a `metric`) + `split` | one row; a new metric is the only code (`wt_ops.METRICS`) |
| `media` | unit kind and regions per medium | one row |
| `readers` | what each reader reads, the tools it `needs`, how a bare file is `detect`ed | a new file format needs a reader function in `wt_core.py`; a spec can always supply records as data (`records`) instead |
| `slot_rules` | the automatic slot rules and their word lists per language | rows |
| `tokenizer` | scripts written without spaces (one token per character), line pause, chance-match filter | values |

Seeded: 25 generic dimensions across 11 media (video, carousel, static, text post, thread, article, newsletter, thumbnail and title, landing page, podcast, audio): spoken words, speaker, word duration, speaking rate; on-screen text, caption cards, post text, article copy, buttons, alt text, hashtags, mentions, links, media, posting day and hour; text and background colour; layout box, type size, type style, unit order, canvas size, image slot; drift status. Dimensions whose only measure is a `method` stay `pending` until a reader or a `records` overlay supplies them.

**Your own dimensions are a settings row.** A person keeps their registry (and, for `build.py`, their discovery) as one row of their generic list `list:settings`: type `record:setting`, id `record:setting:fill-a-template-without-changing-its-words~<scope_kind>~<scope_id>` (usually `account~main`), read through the shared reader `tools/settings/read-data/settings.py`. Its `settings` hold `{"registry": <a registry, the shape of dimensions.json>, "discovery"?: <what a discovery file holds; its "films" may be the films object itself>}`. Every command takes `--settings-record FILE` (the record as `records:read` gives it, its value, a list of them or a JSON file of them) and `--scope KIND:ID` (most specific first) when several rows are given. The order is: `--registry FILE`, then the row's registry, then the registry the piece remembers, then the shipped one. A template made from a row remembers `"registry": "setting:<row id>"`, so `fill.py`, `drift.py` and `retime.py` refuse it without the row instead of quietly measuring with another registry. `build.py --settings-record FILE` with no discovery file reads the row's discovery; a changed row rebuilds what it measured.

**Your own dimensions are your data.** Nothing here names one person's craft: the fields of a tasting sheet, a sound timeline, a checklist or a house style are dimensions in a registry file the person keeps, passed with `--registry FILE` (the template remembers it, so `fill.py` and `drift.py` use the same one). A registry row is `{id, media, region, value_kind, measure: [{reader, field, token}], drift}`; a reader row may set `id_prefix` for the ids it gives rows that have no id column (default `row`).

Readers shipped: `transcript_words` (a word-timed transcript JSON), `segment_captions` (`[seconds] text` rows), `json3_captions` (JSON3 caption events), `filmcraft_project_captions` (the enabled caption cues of one FilmCraft project sequence, named by the source's `sequence_id`), `tsv_rows` (a table of units), `rhythm_segments` (a motion-rhythm JSON: one record per segment and a summary), `scan_events` (a temporal-scan JSON of change and flash candidates), `earshot_events` and `earshot_sections` (an earshot timeline text: its event lines, and its sections with loudness, true peak and tempo), `post_json` (a post as a public-post service returns it), `html_json_records` (an inert JSON script block in an HTML file), `ocr_images` (a folder of images read with `tesseract`). The sound and rhythm readers come with no dimensions in the shipped registry: the person's registry names which fields it measures (the tests' sample registry shows how).

## Slot rules (checkable)

A token is a SLOT only when it carries the author's own specific content. Everything else is KEEP: filler, function words, the author's verbs and judgements. Every slot in a template names its rule. Every keep override in a spec has a reason.

| rule | a token is a slot when | applied by |
|---|---|---|
| R1-number | it has a digit or is a number word (`slot_rules.number_words` for the piece's language) | auto |
| R2-product | it is the product's own name (`product_names` in the spec) | auto |
| R4-name | it is capitalised inside a sentence (not after `.` `!` `?` `:` or a line start, not ALL CAPS, not a function word); every other capitalised occurrence of the same word follows | auto |
| R3-launched-thing | it names the thing being launched; all occurrences share one slot | spec |
| R5-unit | it is the noun a number counts | spec |
| R6-who | it is the group the result is about | spec |
| R7-named-thing | it is a concrete noun naming the author's own feature, object or detail | spec |
| R8-specific-claim | it is a phrase that is only true of the author's product or subject | spec |
| R9-quoted-title | it is a title or a work's name | spec |
| R10-other-person | it was said or written by someone other than the author | spec |
| S1-content | a unit's action shows the author's own product, graphic or wordmark (form fields stay KEEP) | spec |
| S2-other-person | a unit is about another person | spec |

Exceptions to the auto rules are spec `keep` entries with reasons ("combined into one" is an idiom, not a count, so 'one' is kept). To check a template, every SLOT row in `TEMPLATE.md` lists its rule, and each spec `keep` shows its reason.

## Fill and sources

For speech, `transcript_words` is preferred when it contains nonempty word values matching the dimension's `where` filter; otherwise `segment_captions` can supply caption text. Caption input is one `[seconds] text`, `[seconds.fraction] text` or `[minutes:seconds] text` row per segment; ranges such as `[0.00-4.52] text` also keep a segment start and end. Seconds can have an `s` suffix and minutes can exceed 99. Segment times are provenance only: they do not create per-word timestamps, durations, speaking rates or speaker identities. Ordinary unbracketed headers before the first row are ignored; malformed numeric timestamp rows are errors.

Original JSON3 caption files are detected by the `json3_captions` reader. It reads `events[].segs[].utf8` in source order, ignoring window and style and append-newline events, and keeps each text event, its index, timestamps, display offsets and annotations under `notes.json3_caption_provenance`. Display values never become word timings or speakers; repeated or overlapping caption text is kept rather than guessed away.

`fills.json` gives each slot `{"value", "sources", "needs"?, "derived"?, "note"?}`. A value counts as sourced only when:

1. every source is checkable: a URL; `git:<repo>@<commit>` (the commit must exist); or a file with a line (`path:12`, `path#L12`), a timestamp (`path@12.5s`) or a time range (`path@12.5-18.2s`). File line citations use physical LF-delimited lines (CRLF is normalised; Unicode separators and a bare CR inside a record stay content);
2. the value's words (3+ letters, and every number) appear in a cited source's text: the line, or the commit message and diff. A URL or media timestamp cannot be read here and is marked "not checked". A value composed from a source must say how in `derived`; that text shows in the sources table.

A source can also be one of the person's recorded moments: a time range of a word-timed transcript (`transcript.words.json@8.4-15.2s`, checked against the words spoken inside it) or one row of a moments TSV cited by line (`moments.tsv:1234`, a header with the `moment_spans.tsv_columns` of `dimensions.json`). The fill then keeps `moments: [{source, clip, from, to, media}]`, where the value plays.

Otherwise the slot stays visibly empty (`[NUMBER: no source yet]`) and is listed with the reason and what would fill it. `fill.py` refuses any id that is not a slot. KEEP words cannot be changed by a fill.

A spec source can set `required: true`: if it is missing or unreadable, tokenization fails with the reader's reason instead of returning a piece whose dimensions only became pending. A measure can set `optional_if_reader_not_declared: true`; its dimension is omitted from `pending` only when every measure entry is optional and every referenced reader is absent from the piece's `sources`. A readable source with no qualifying values stays pending unless that source sets `allow_empty: true`.

TSV sources can declare `"id_column": "_record_id"` beside `path` and `missing_values`; each row then needs a unique, nonempty identity there, and insertion preserves record and token identities (without it the reader keeps ordinal `<id_prefix>-01`, `<id_prefix>-02`). `"tsv_rows": {"path": ..., "missing_values": ["unknown"]}` keeps those literal cells out of the measured values. Authored overlays may set distinct nonnegative integer `record_order` values to keep a source's sequence when identities sort differently.

The `html_json_records` reader consumes one explicitly selected inert `application/json` script block in an HTML file (`script_id` is required). Its array holds records with a unique string `id`, `fields` and optional nonnegative `t0`/`t1` seconds. No JavaScript executes; duplicate or missing selectors, executable or external scripts, malformed records and invalid intervals are refused. Authored intervals are source configuration; split words inherit the whole interval and never become inferred word onsets.

## Drift

`drift.py` judges every dimension present in both pieces by its value kind. A dimension it does not know is reported, never dropped. A dimension the target did not measure is listed, not judged.

- **Text**: difflib on normalised words (case-folded, NFKC, edge punctuation dropped, `25,000` = `25000`). Expected words are KEEP words, the declared sourced fill values, or one placeholder per empty slot. A chance match (an equal run shorter than `min_anchor_words` between changes holding `anchor_context_words` or more target words) counts as changed. Reports every KEEP word deleted, replaced or inserted, and every slot run as sourced, empty, unsourced, removed or reference-left (the author's own value left in). It prints a KEEP-preserved percentage, worst lines and an annotated line view (`[-deleted-]`, `{+inserted+}`, `<<sourced slot>>`, `[TYPE: empty]`).
- **Category and number**: in order. A category is compared by sequence alignment, so an added or missing unit shows as one change. A number passes within `drift.max` (absolute) or `drift.rel` (relative).
- **Timed events**: nearest event within `tolerance_s`, the same value when `match_value`. Times are absolute, so a piece of a different length shifts them.
- **Box**: 1 - IoU <= `max`. **Colour**: CIE76 delta-E <= `max`. **Vector**: euclidean <= `max`.
- `--exceptions`: `[{"dim", "line", "op": deleted|replaced|inserted, "words", "reason"}]`. A listed change with a reason counts as preserved and stays in the report as EXCUSED.
- `--check` exits 1 unless every judged dimension meets its threshold (100% by default), no unexcused value was inserted, and no slot fill is unsourced.
- `--annotated out.json` writes the template with a `drift.status` dimension on every token; the result is a piece, so it can be drifted, merged or nested again.

Script input: fenced ```` ```dim:<id> ```` blocks (what `fill.py` writes). Otherwise the markdown table column whose header starts with `--column` (default `line`) that holds the most words. Otherwise the whole text.

## Operations (all take pieces, all return a piece)

`tokenize` (make_template), `mark_keep`, `mark_slot`, `fill`, `drift`, `diff` (template vs template), `merge` (conflicting values are kept as `conflicts`, never silently picked), `fork`, `nest` (ids prefixed `<child>::`, so any depth and self-nesting never collide), `xref`, `bind`, `retime`, `delete` / `restore` (tombstones keep position and line membership), `aggregate` (streams pieces one at a time into a family template; shared values KEEP, differing ones become VARIES slots). `validate` lists errors and warnings, each with what is wrong and how to fix it. `OperationMatrix.test_every_pair` composes the 13 operations before `bind` and `retime` with each other and with themselves (169 combinations); every result is a valid piece.

## Events bound to words

A token may carry `bound_to` beside its time `t`: the word or phrase it responds to, so the time follows the words when the script is rewritten. The binding names no medium: a transition, a graphic, a slide, a caption or a page section are tied to a phrase the same way.

```
"bound_to": {"words": "launch day", "edge": "start", "offset_s": -0.1, "slot": "s-thing", "occurrence": 1}
```

`words` is required. `edge` is `start` (default) or `end` of the phrase. `offset_s` shifts the event from that edge. `slot` names a slot whose sourced fill value replaces `words`, so an event tied to a swapped specific follows the new specific. `occurrence` picks the nth repeat of the phrase. A spec declares bindings as `"binds": [{"tokens": [ids], "words": ..., ...}]`, applied after slots exist. `bind(piece, ids, words, ...)` writes the field; `retime(piece, timed_words)` (CLI `retime.py`, fed the word-timed transcript of the new voice-over) moves every bound token to where its words now play and keeps the length of an event that has an end time `t1`. Words missing from the new transcript leave the time unchanged and are listed in `notes.retime` with status `unmatched`. `validate` reports a malformed `bound_to` as an error.

## Source qualifications

A reader that measures something with automatic labels can set `ctx["<name>_provenance"] = {"reader", "source_path", "qualification"}`. The renderers show every such note under "Source qualifications" above the content, and keep it out of the plain notes list. No reader name is listed in the renderer.

## Key Types / Functions

| Name | Shape | Role |
|---|---|---|
| piece | `{schema: "word-template@1", piece, tokens, slots, lines, pending, notes, ...}` | What every operation takes and returns. |
| spec | `{schema: "word-template-spec@1", piece, sources, lines, slots, keeps, readings, records, binds}` | The judgement layer `make_template.py` reads. |
| `Registry.load(path?)` | `read-data/wt_core.py` | Loads `dimensions.json` or another registry. |
| `tokenize(spec, reg, root)`, `fill`, `drift`, `bind`, `retime` | `read-data/wt_ops.py` | The operations. |
| `render_template_md`, `render_fill_md` | `read-data/wt_render.py` | The readable views. |

## Dependencies

**Depends on:** Python 3 standard library; `tesseract` for the `ocr_images` reader only; `tools/settings/read-data/settings.py` (the shared settings reader) when `--settings-record` is given, or when a request of `token_table_from_parts.py` or `vary_slots_one_at_a_time.py` carries `settings_record`; `tools/settings/do-work/run-with-settings.mjs` (Node) only when that request names the row's id.

**Depended on by:** nothing in this repository; the Workshop rows run the six commands.

## Known limits

- The `ocr_images` reader cannot read text over busy photos; a reading by eye can be supplied as spec `records`, marked as such.
- Event times are absolute. A piece shorter or longer than its reference cannot match its event times, and the report shows that.
- A fill piece carries the template's KEEP values for dimensions it did not change (durations, event times). Only a measured render proves them.
- difflib is quadratic in the worst case. A 30,000-word piece drifts in seconds in the test, but highly repetitive text is the slow case.
- A dimension measured from an analysis file no shipped reader knows stays `pending` until a reader is added (one function in `wt_core.py` and one `readers` row) or the records are given as data.
- The FilmCraft reader reads `schema_version` 16 project files only, and never guesses the sequence: the source names it. It measures the editable project, not the exported pixels.
