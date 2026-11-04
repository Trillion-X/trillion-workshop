# tools/keep-a-record-library-valid/

Keeps a library of record files valid, works one piece through a bank of questions with evidence, rebuilds the files derived from other files, keeps the evidence of pictures taken from a video pinned by file identity, and adopts a reviewed packet of that evidence. Workshop tools, both run on the person's own computer by their AI. **The code knows no record kinds**: every file, id field, relation, setting and command comes from a schema file the person gives with `--schema`, so one library can be a plant nursery's and another a bakery's.

- `tool:check-a-record-library` reads the schema's checks and prints one report: which passed, and exactly which ids or values break each one that did not.
- `tool:work-a-piece-through-a-question-bank` picks a small routed set of questions for one piece, records each answer with the BLAKE3 identity of the files that show it, says when an answer's evidence has since changed, and adds findings to the findings library. A recorded answer establishes structure and file identity, not that the answer is true.
- `rebuild-data` regenerates the files that are made from other files (parsed tables, card lists, folder censuses, a database read, spreadsheet forms) by the `builders` rows of the schema, or with `--check` lists which are stale.
- `project-frame-manifest`, `frame-pages`, `finalize-page-journal`, `validate-page-journal` and `locate-quote` keep the pictures taken from a video, the reviewer's notes on them and their review pages joined and pinned by BLAKE3 identity, and find where a quote is said.
- `adopt-window` adopts a saved, reviewed packet of that evidence into the person's timeline table, word template and investigation record, or attaches the evidence to the template alone.

## Running it

```
python3 -I do-work/keep_a_record_library.py --library DIR --schema FILE COMMAND ...
```

| Command | Does |
|---|---|
| `validate` | Runs every check, table check, builder and derived-file command in the schema. Exit 0 all passed, 1 something broke, 2 a file or the schema could not be read. |
| `start PIECE --profile ID [--limit N]` | Writes `PIECE/investigation.json` with a small question set. Refuses to overwrite one. |
| `next PIECE` | The questions whose prerequisites are done, and those still waiting. |
| `evidence PIECE --q ID --status S --file PATH --note TEXT` | Answers a question. A missing file is refused, a file of unchanged bytes is not recorded twice. `--append` adds sources instead of replacing; `--defect` marks a finding against the piece; `--caught-by ID` names a check that already caught it. |
| `finding PIECE --kind K --title T --field NAME=VALUE ...` | Adds a finding to the piece and to the findings library. |
| `progress PIECE` | Counts by status, defects, whether each evidence file still matches its recorded identity, and which answers rest on changed or missing files. |
| `rebuild-data [--check] [--out DIR] [--input NAME=PATH ...]` | Rebuilds every file the schema's `builders` derive from sources (into the library, or under `DIR` by each output's own path). `--check` writes nothing, lists the stale outputs and exits 1 if any. `--input` gives a file a builder reads that is not in the library, such as a database; a builder whose input is not given is named as not checked. |
| `project-frame-manifest --manifest F --output F` | A frame manifest as records whose files carry their BLAKE3 identity; the extraction tool's own digest fields are dropped. Needs `frame_evidence`. |
| `frame-pages MANIFEST OUTPUT [--per-page N] [--tile-width N] [--quality N] [--font F] [--candidate-pairs]` | Labelled review pages of already-extracted frames, or of adjacent before/after pairs. Needs Pillow; the same inputs and font give the same bytes. Needs no schema. |
| `finalize-page-journal --manifest F --extraction-readback F --page-observation F --page-readback F --output F` | Joins the manifest, the extraction readback and the person's page notes into one journal where every frame, time, path and identity must agree. Never overwrites one. Needs `frame_evidence`. |
| `validate-page-journal JOURNAL` | Rechecks every join and every pinned file of a journal. Needs `frame_evidence`. |
| `locate-quote --transcript F --json3 F (--quote T \| --quote-file F)` | The physical lines of a transcript and the caption times where a literal quote occurs exactly once. Needs no library or schema. |
| `adopt-window INPUT` | Adopts a saved reviewed packet (the input's `schema` member picks intervals or evidence-only) into the files that own it. Refuses before any write unless every file it names still has the bytes it was pinned with. Needs `adoption` and `frame_evidence`. |

`--library` is the folder every file in the schema is relative to. `evidence`, `start` and `finding` take the schema's lock file, so two writers never interleave.

## The schema

A JSON file with these keys. Every name below inside a row (a pool, a field, a stage, a status) is the person's own.

| Key | Holds |
|---|---|
| `lock` | The lock file, relative to the library. |
| `pools` | `{ name: { file, path, id } }`: a named set of records. `path` is dotted keys; a key ending in `[]` means every item of that list (`weeks[].chores`); an empty path means the file is the list itself. `id` is the field holding a record's id. |
| `checks` | An ordered list of check rows (below). The report lists them in this order. |
| `tables` | `[{ name, globs, vocabulary, extra_columns }]`: tab-separated files checked column by column against a vocabulary `{ fields: { column: { one_of } or { list_of } or { number: true } or { free_text: true } } }`. `extra_columns` names other allowed columns and their kind. The check is called `<name>_values_in_vocabulary`. |
| `derived` | `[{ name, command, report_as?, only_if_exists? }]`: a command that says whether a derived file still equals what its source generates. Exit 0 means current; exit 1 means stale, and its output may be `{ "stale": [names] }`; any other exit is an error. `{root}` and `{python}` are filled in. `report_as` collects the stale names under that key of the report; `only_if_exists` skips the row when that file is absent. The command is the person's own and runs as the person. |
| `builders` | `[{ name, kind, output, format?, ... }]`: how each derived file is built from its sources (below). |
| `frame_evidence` | The label strings of a page journal: `projection_schema`, `journal_schema`, `journal_final_status`, `observation_schema`, `readback_schema`, `state_field`, `readback_hash_field`, `validation_scope`. |
| `adoption` | The names an adoption writes and reads: the word template's registry and vocabulary files, the spec file and the spec member that holds evidence, the timeline table's file and columns, reader and dimension ids, slot types and rules, receipt file names, schema labels and the question an adoption answers. `adopt-window` refuses a profile that lacks one (it lists them). |
| `scope` | The sentence the report ends with, saying what the checks do and do not prove. |
| `investigation` | The settings of `start`, `next`, `evidence`, `finding` and `progress` (below). |

### Check rows

Each row has a `name` (the key in the report) and a `kind`. A check answers `true` (holds) or the sorted list of what breaks it.

| Kind | Reads | Breaks when |
|---|---|---|
| `ids-unique` | `pool` | two records share an id |
| `count-equals` | `pool`, `count_in: { file, path }` | the count a file states is not the number of records |
| `references` | `from: { pool, field, many?, only_if_set? }`, `into: [pools]`, `report?: "owners"` | a value is in none of the `into` pools; lists the missing values, or with `owners` the ids of the records holding them |
| `list-equals-joined` | `pool`, `list`, `via`, `through: { pool, list }`, `count` | a record's list is not the union of the lists of the records `via` names, or its `count` field is not the list's length |
| `not-chained` | `pool`, `field` | a record's reference points at a record that itself carries the reference |
| `routes-known` | `pool`, `field`, `default`, `known`, `prefixes` | a route expression names a tag that is not in `known` and has none of the `prefixes` |
| `ids-named-in-text` | `globs`, `pattern` (one group), `into` | a text names an id that is in none of the pools; lists `file:id` |
| `text-table-matches-field` | `doc`, `heading`, `row` (two groups: key, cell), `ids_in_cell`, `id_prefix`, `pool`, `field`, `keys_in` | a table in a text says a key answers some ids, and the records' own field says otherwise. Left out of the report when the text has no such table. |
| `investigation-records` | `report: "ids"` or `"shape"` | an investigation record has a node whose id is in no question pool, a status outside the schema's, a `caught_by` that is no check, a `depends_on` that is no node (`ids`); or evidence that is not a list of `{ id, path, identity.value }` (`shape`) |

### The investigation settings

| Key | Holds |
|---|---|
| `pools` | The pool each role reads: `questions`, `profiles`, `groups`, `checks` (the ids an answer may say already caught it) and `findings`. A question is `{ id, stage, question, verify_by, source, routes?, same_as? }`; a profile `{ id, groups }`; a group `{ id, questions, tools }`. |
| `piece_globs` | Where the investigation records are, for `validate`. |
| `scope_node` | The first node of every record: `{ id, question, verify_by, stage, group, tools }`. Every question depends on it. |
| `selection` | `{ default_limit, rule, skip_stages_by_target_kind }`. Questions are taken one per group in turn until the limit; one with `same_as`, a false route, or a skipped stage is dropped and its reason recorded. |
| `prerequisites` | `{ rule, closing_stages }`: a question of a closing stage also depends on every chosen question outside them. |
| `target_kinds` | `{ default, rules: [{ kind, under }] }`: a piece inside a folder is that kind. |
| `piece_header` | `{ file, heading, tag_fields, implied_tags }`: the piece's header is the fenced block under that heading in that file; its tag fields give the tags routes are tested against, and `implied_tags` adds tags (`kind:*` implies for any `kind:` tag). |
| `statuses`, `done_statuses`, `claim_labels` | The words an answer may carry; the first label is the default. |
| `authority` | What a run may not do, copied into every record. |
| `finding_id_prefix`, `finding_kinds` | `{ kind: { required: [fields], match?: { pool, field, found, missing } } }`. `match` looks the title up in a pool and gives a `next_step` text (`{id}` is filled). |

### Builder rows

A builder is `{ name, kind, output, format?, ... }`; `output` is the path of the derived file under the library. Its `kind` is one of:

| Kind | Builds |
|---|---|
| `markdown-rows` | One record for each line of a markdown table that starts with `row_prefix` and matches `row_regex` (named groups), under the headings that start with `group_heading`. `fields` maps each output field to `{ from, as?, split?, replace? }`, `{ heading: true }` or `{ const }`; `id` adds sequential ids; `unreadable` is the refusal text for a line that does not match; `document` is the ordered JSON object written. |
| `cross-cards` | One card for each name in a table of a text (`names`) times each template row of a JSON file (`templates`), using the records of an earlier builder (`items_from`, `item_key`); `card` says how each field is filled. |
| `folder-table` | One tab-separated row for each folder two levels below `root`, saying which of the declared `outputs` (a file or a folder) it holds. |
| `sqlite-rows` | The rows of one table of a database file the caller names with `--input`, read-only, in rowid order. |
| `json-to-tsv` | A list in a JSON file as tab-separated text, with optional column defaults. |

A `format` row sets `{ json: { indent, ensure_ascii, trailing_newline } }` (default indent 1, ASCII escapes, no final newline) or `{ tsv: { newline } }` (default CRLF). A document value is a literal or `{ "from": "source_path" | "count" | "rows" | "names" | "lenses" | "database" | "missing" }`; text may hold `{count}`-style placeholders. A file is stale when its bytes differ from a fresh build.

### Route grammar

`all`; a comma means any, `+` means all, `(not x)` excludes `x`: `herb + outdoor (not indoor), root`.

## Files

| File | Purpose |
|---|---|
| `do-work/keep_a_record_library.py` | The command line above. |
| `read-data/library.py` | `Store` (the schema, its pools, the lock), `at_path`, the BLAKE3 file identity, JSON reading and atomic writing. |
| `read-data/checks.py` | The check kinds, the table check, the derived-file commands and `validate`. |
| `read-data/routes.py` | The piece header, tags, the route grammar, target kinds, question selection and the findings search. |
| `read-data/investigation.py` | `start`, `next_open`, `record_evidence`, `add_finding`, `progress` and the checks of investigation records. |
| `read-data/derived_data.py` | The builders and the staleness test. |
| `read-data/quote_locator.py` | `locate_quote`: where a literal quote occurs, once, in a transcript and a JSON3 caption file. |
| `read-data/frame_evidence.py` | The frame-manifest projection, review pages (Pillow), candidate-pair pages, and the finalize and validate of page journals. |
| `read-data/json_patch.py` | An in-place change of one JSON object's members that leaves every other byte of the file as it was. |
| `read-data/adoption.py` | `adopt_intervals` and `adopt_source_evidence_only`, driven by the schema's `adoption` profile. |
| `test/test_keep_a_record_library.py` | Every kind of check passing and failing, the investigation loop, findings and the derived-file commands, on a made-up greenhouse library. |
| `test/test_derived_data.py` | Every builder kind, the stale check and the rebuild commands, on a made-up garden. |
| `test/test_frame_evidence.py` | The quote locator, the manifest projection, page journals and review pages, on made-up bytes and captions. |
| `test/test_adoption.py` | Both adoptions, with exact preimages, refusals that write nothing and the timestamp rules, on made-up pieces. |
| `test/keep-a-record-library-valid.test.mjs` | Runs those tests under `npm test`. |
| `test/fixtures/greenhouse/` | The made-up library and its `schema.json`: the example to copy a schema from. |

## Dependencies

**Depends on:** Python 3.10+; for every command that records or checks a file identity, BLAKE3 (the `blake3` python module, else the `b3sum` command); Pillow, only for `frame-pages`; the `sqlite3` command, only for a `sqlite-rows` builder; and, only for `adopt-window`, the public modules `wt_core` and `wt_ops` of the Workshop tool `fill-a-template-without-changing-its-words`, read from the folder beside this one.

**Depended on by:** nothing in this repository. A library's own schema file lives with the library.
