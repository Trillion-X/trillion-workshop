# tools/keep-a-record-library-valid/

Keeps a library of record files valid, works one piece through a bank of questions with evidence, rebuilds the files derived from other files, keeps the evidence of pictures taken from a video pinned by file identity, and adopts a reviewed packet of that evidence. Workshop tools, both run on the person's own computer by their AI. **The code knows no record kinds**: every file, id field, relation, setting and command comes from a schema file the person gives with `--schema`, so one library can be a plant nursery's and another a bakery's.

- `tool:check-a-record-library` reads the schema's checks and prints one report: which passed, and exactly which ids or values break each one that did not.
- `tool:work-a-piece-through-a-question-bank` picks a small routed set of questions for one piece, records each answer with the BLAKE3 identity of the files that show it, says when an answer's evidence has since changed, and adds findings to the findings library. A recorded answer establishes structure and file identity, not that the answer is true.
- `rebuild-data` regenerates the files that are made from other files (parsed tables, card lists, folder censuses, a database read, spreadsheet forms) by the `builders` rows of the schema, or with `--check` lists which are stale.
- `project-frame-manifest`, `frame-pages`, `finalize-page-journal`, `validate-page-journal` and `locate-quote` keep the pictures taken from a video, the reviewer's notes on them and their review pages joined and pinned by BLAKE3 identity, and find where a quote is said.
- `adopt-window` adopts a saved, reviewed packet of that evidence into the person's timeline table, word template and investigation record, or attaches the evidence to the template alone.
- `tool:gate-a-pieces-delivery-checklist` (`gate`, `answer`, `answer-from-render-check`, `sweep`, `content-gates`, `audition-gates`, `audit-watch`, `scope-options`) holds a piece back until every routed MUST check of its delivery checklist has a pass row, per option where a check is asked per option: rows written by a person with evidence, or by a machine (the render check, the sweep, the copy check on the person's own branch, their verdict rows, the fact gate, the audio measure) carrying the pin of what measured it, and every row carrying the BLAKE3 of the files it judged. It also audits what is already linked for the person to watch.
- `measure-reference` measures one reference video (probe, frame sheets, cut scan, motion rhythm, sound timeline) with the programs the caller names, and answers one JSON line.

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
| `gate PIECE --stage S[,S] [--option O[,O]] [--at STAGE]` | Every routed MUST check of the stages that is unanswered, failed, stale or advisory where advice does not pass; starts the piece's investigation record when it has none. Exit 1 when anything is open. |
| `answer PIECE --check ID --answer pass\|fail\|n/a --evidence TEXT --by NAME [--option O]` | Appends one row to the piece's answers file, with the BLAKE3 pins of the files it covers. A machine's name is refused; a MUST check is never n/a. |
| `answer-from-render-check PIECE --json REPORT [--option O]` | The rows a `tools/check-a-rendered-video` `--json` report settles, check by check, only for checks whose pin is the reviewed one and only for shipped previews older than the report. |
| `sweep PIECE --previews DIR ... [--only IDS]` | Runs every render check over every option of the folders, records their rows and the sweep's own, lists faults by rule, and writes a fresh-viewer review pack per folder (its rules are the person's branch rows). |
| `content-gates PIECE --lane-dir DIR [--option IDS] [--at STAGE]` | The copy row, the verdict row and the fact row of each option, from the copy check (`check-a-films-copy.mjs` on the person's branch), their verdict rows and their fact gate. |
| `audition-gates PIECE --file F ... [--at STAGE]` | The audio row (loudness, true peak, head, tail and gaps against the marks) and the verdict row of each audio-only audition file. |
| `audit-watch PIECE [--hold] [--file F ...]` | Every file linked into a watch folder (or each file named) whose option has an open or failed MUST row; `--hold` moves those links to the lane's held-back folder. |
| `scope-options PIECE [--lane L]` | The option ids a whole-lane gate covers: each lane's latest round plus the live picks. |
| `measure-reference VIDEO OUT --hf-media P --motion-tools DIR --earshot-python P [--ffprobe P] [--node P] [--pages-python P] [--earshot-threads N]` | Measures one reference video into a new folder (below). One JSON line out; exit 1 when a step failed, 2 when a program is missing. Needs no library or schema. |
| `adopt-window INPUT` | Adopts a saved reviewed packet (the input's `schema` member picks intervals or evidence-only) into the files that own it. Refuses before any write unless every file it names still has the bytes it was pinned with. Needs `adoption` and `frame_evidence`. |

`--library` is the folder every file in the schema is relative to. `evidence`, `start`, `finding`, `gate`, `answer`, `answer-from-render-check`, `audit-watch` and `scope-options` take the schema's lock file, so two writers never interleave; `sweep`, `content-gates` and `audition-gates` run their checks unlocked and lock only while they record.

`--schema` is the schema file, or the person's `list:settings` row `record:setting:keep-a-record-library-valid~<scope_kind>~<scope_id>` (a file holding the record as `records:read` gives it, or several of them), whose settings are the schema; it is read with the one shared reader, `tools/settings` `setting`. With several rows, `--scope KIND=ID` (repeatable, most specific first) names the one to read.

The delivery gate's run options: `--door-records FILE` or `--door-mcp '<MCP client argv JSON>'` is the person's records door, through which the copy check reads their branch of `list:checks` (without it the copy and verdict rows cannot be pinned and are listed as open with what they need); `--render-check-limits FILE` overrides `delivery_gate.render_check.limits`; `--copy-check-arg ARG` (repeatable, `--name=value` for a value) hands the copy check more arguments, such as `--no-model` or `--decider-python=P`.

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
| `delivery_gate` | The settings of the delivery gate's commands (below "The delivery gate settings"): the checklist pool, the answers file, the film config file and folders, every pattern, the render check's mapping and reviewed pins, the copy check's branch, the content gate roles, the fact layouts and the audition marks. |

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

### The delivery gate settings

The checklist is a pool (`checklist_pool`) whose file holds `stages: [{ id, checks: [{ id, check, routes, verify, must, per_option?, rule_id?, rule?, advisory_passes_at? }] }]`, `delivery_stages`, `default_delivery_stage`, `publish_phase` and `after_phase` (ids the gate never asks). A check's `routes` use the route grammar below over the piece header's tags.

| Key | Holds |
|---|---|
| `checklist_pool` | The pool of the checklist's checks; its file is the checklist document. |
| `answers_file` | The piece's append-only answers file (one JSON row a line; the newest row for a check and option wins). |
| `film_config_file`, `films_folder`, `film_defaults` | A piece's own config file (`verdict_file`, `picked_verdicts`, `checklist_gate: { option_globs, spec_globs?, fact_gate? }`, `option_ids: "path"`); a folder directly under `films_folder` without one gets `film_defaults`. |
| `not_previews_pattern`, `watch_folder_pattern`, `compilation_pattern` | Folders that never hold previews; folders whose files are put in front of the person; a file name that stands for every preview of its folder. |
| `watch_round_pattern`, `watch_suffixes`, `held_back_folder` | A watch folder's round (one group); the file suffixes audit-watch reads; the lane folder held links move to. |
| `lane_prefix`, `preview_round_pattern`, `rebuild_spec_glob` | A lane is the nearest folder whose name starts with the prefix; a preview's round is the pattern's group in its folder name; where an option's spec names `rebuild_of`. |
| `option_moment_patterns`, `moment_aliases` | `{ with_round, round_one }`: an option id's moment and round, so a later pick of the same moment supersedes an earlier one; an alias renames a renumbered moment. |
| `sweep_preview_glob`, `sweep_stages`, `audit_stages`, `audit_at`, `phase_id_pattern` | What a sweep reads, the stages the sweep and audit-watch gate, the delivery stage audit-watch gates at, and the id part of a publish or after phase entry. |
| `default_profile`, `min_evidence_chars`, `answer_words`, `judgment_rules`, `file_pin_cache` | The run profile the gate starts an investigation with; the shortest evidence; the answers a person may give; rules judged by review, whose fail on a rebuild of a picked design waits for the person; the folder of the file pin cache. |
| `proven_flags`, `film_qa_report_globs`, `spec_globs`, `file_media` | Flags an option's own files prove (from its spec, or from a render-check finding); where its reports and spec are; a medium that applies per file by suffix. |
| `film_qa_checks`, `film_qa_unmapped_rule`, `film_qa_check_pins`, `not_measured_blip_s`, `machine_by` | Render check name to rule ids (with `finding_match`), the rule an unmatched FAIL fails, the reviewed pin of each check, the shortest unmeasured span that withholds a row, the name its rows carry. |
| `render_check` | `{ limits }`: the render check's limits file under the library (or `--render-check-limits`). |
| `sweep_rule`, `sweep_by` | The rule the sweep's own row answers and the name it carries. |
| `copy_check` | `{ branch, settings_record }`: the person's branch of `list:checks` and the id of the copy check's own `list:settings` row. |
| `content_gate_roles`, `content_gates` | `{ copy, verdict, fact, audio }` rule ids, and each content gate's row writer name (`by`; the fact gate's `tool`, a path under the library). |
| `content_gate_lane_previews`, `content_gate_spoken_paths`, `content_gate_text_keys`, `content_gate_fields`, `content_gate_text_optional`, `content_gate_artifact_sources` | Which previews a lane gates, where a spec names its spoken words, how a spec's drawn text is read (with the render check's own text fields), and which artifact each verdict kind reads (`spec`, `strings`, `voice`). |
| `fact_round_pattern`, `fact_layouts` | Where an option's fact shots and claims are: `[{ root, ids, needs_round? }]` with `{lane}`, `{piece}`, `{option}`, `{option_base}` and `{round}` filled. |
| `audition` | `{ artifact_kind, marks: { loudness_lufs, true_peak_dbtp_max, quiet_db, quiet_min_s, head_s_max, tail_s_max, gap_s_max } }`. |

How a row counts: a person's row counts for a check no machine answers; a machine's row counts only when its `check_pin` is the pin required now (the render check's reviewed pin, `sweep`, or the content gate's pin: the copy check's code with the branch's generic rows as read for the copy row, with its verdict rows as read for the verdict row, the fact gate's bytes, this file and the marks for the audio row). Every row carries `file_pins`, the BLAKE3 of the files it covers; a covered file whose bytes differ makes it stale. The copy row counts every finding of the copy check except those of the person's verdict rows (the ids of the branch's verdict rows, its `judge_settings.stance_rule` and `novel.rule`, read by `do-work/branch-rules.mjs`); the verdict row counts only those.

### Measuring a reference video

`measure-reference VIDEO OUT` writes `probe.json`, a one-a-second frame sheet (`sheet-1fps/`), a hook sheet of the first five seconds at six a second (`sheet-hook/`), a cut scan (`scan/`, `scan.json`), the motion rhythm (`rhythm.json`) and a sound timeline (`earshot-timeline.txt`). It records evidence; it does not certify viewing or what anything means. Use a new, empty output folder: one that holds earlier evidence mixes two runs. A film longer than 120 seconds gets no one-a-second contact sheet (a long-film picture can exceed what a model reads): its frames are kept and laid out as small labelled pages (`review-pages/`) by this tool's `frame-pages`. Every program is an argument; the command checks them all before any media work.

Reading the pages: a pair page holds separate BEFORE and AFTER pictures; do not read neighbouring tiles as one picture. Confirm an apparent overlap, split layout, scale change or effect in the isolated original frames before adopting it. A contact sheet finds a change; it does not prove its kind or its exact start. Pages nobody has opened are not reviewed evidence. A pictured-word reading is a single-frame lookup: it does not establish how long a shot or graphic lasts.

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
| `read-data/delivery_gate.py` | The delivery gate: `gate`, `record_answer`, `routing`, `file_pins`, `stale_reason`, the render check's reports, `sweep`, `content_gates`, `audition_gates`, `audit_watch`, `scope_options` and their helpers. |
| `do-work/delivery_gate_commands.py` | The gate's command parsers and run options, and how each command runs. |
| `do-work/branch-rules.mjs` | The person's branch as the copy check reads it (`rulesOfBranch` through their records door): the ids of their verdict rows and the BLAKE3 of the rows as read; `--rules-out` writes the rows for a review pack. |
| `do-work/measure-reference.sh` | `measure-reference`, run by the command line or on its own. |
| `ports/*.json` | The port contracts of the delivery gate's files (`tools/check-a-port-against-its-source`). |
| `test/test_delivery_gate.py` | The gate, its rows, staleness, the render check's reports, the sweep, the content gates on the real copy check, audit-watch, scope-options, auditions, the schema as a settings row, the branch helper and `measure-reference` with stand-in programs, on a made-up library of films. |
| `test/fixtures/delivery/` | That library: its `schema.json` (with `delivery_gate`), a made-up checklist and a stand-in records door file (`data/check-records.json`) holding a made-up branch of `list:checks` and the copy check's settings row. |
| `read-data/adoption.py` | `adopt_intervals` and `adopt_source_evidence_only`, driven by the schema's `adoption` profile. |
| `test/test_keep_a_record_library.py` | Every kind of check passing and failing, the investigation loop, findings and the derived-file commands, on a made-up greenhouse library. |
| `test/test_derived_data.py` | Every builder kind, the stale check and the rebuild commands, on a made-up garden. |
| `test/test_frame_evidence.py` | The quote locator, the manifest projection, page journals and review pages, on made-up bytes and captions. |
| `test/test_adoption.py` | Both adoptions, with exact preimages, refusals that write nothing and the timestamp rules, on made-up pieces. |
| `test/keep-a-record-library-valid.test.mjs` | Runs those tests under `npm test`. |
| `test/fixtures/greenhouse/` | The made-up library and its `schema.json`: the example to copy a schema from. |

## Dependencies

**Depends on:** Python 3.10+; for every command that records or checks a file identity, BLAKE3 (the `blake3` python module, else the `b3sum` command); Pillow, only for `frame-pages`; the `sqlite3` command, only for a `sqlite-rows` builder; and, only for `adopt-window`, the public modules `wt_core` and `wt_ops` of the Workshop tool `fill-a-template-without-changing-its-words`, read from the folder beside this one.

For the delivery gate: `tools/settings` (the schema as a settings row); `tools/check-a-rendered-video` beside this folder (Python with numpy; some checks need OpenCV), for `answer-from-render-check`, `sweep`, the proven flags and a spec's drawn text; Node 22 with `tools/check-against-a-persons-rules-and-verdicts`, `tools/judge-words`, `tools/content-identity` and `tools/records-door`, for the copy and verdict rows and their pins; the person's fact gate (a path in their settings); ffmpeg and ffprobe for `audition-gates`. For `measure-reference`: the hf-media executable, a folder with `motion-rhythm.mjs`, a Python with `earshot`, ffprobe, node, and Pillow in the pages Python for a long film.

**Depended on by:** nothing in this repository. A library's own schema file lives with the library.

## Moved from launch-video

The delivery checklist gate moved from Trillion-X/trillion-launch-video `tools/content-investigation/cis.py` (b968a71, lines 756-1772 and the gate's part of `main()`), and `measure.sh` with the useful parts of `MEASUREMENT.md`. The first commit was the byte copy (with the person's name replaced); `ports/` holds the contracts. Each function kept its name and its job:

| cis.py | Here |
|---|---|
| `gate_cfg`, `answers_file`, `read_answers`, `machine_checks`, `rule_to_film_qa_check`, `required_pin`, `record_answer`, `answer_command`, `picked_rebuild_of`, `proven_tags`, `routing`, `file_scoped_tags`, `all_options`, `option_files`, `file_pins`, `stale_reason`, `recorded_before`, `gate`, `usable_check_pins`, `film_config`, `shipped_globs`, `option_id`, `film_previews`, `shipped_previews`, `locked`, `sweep`, `lane_spec`, `option_words`, `copy_gate_verdict`, `spoken_lines`, `lines_file`, `combine`, `run_copy_gate`, `run_verdict_rules`, `fact_gate_tool`, `run_fact_gate`, `content_gates`, `measure_audio`, `audition_gates`, `watch_folders`, `audit_watch`, `option_moment_round`, `scope_options`, `comma_list` | the same names in `read-data/delivery_gate.py` |
| `answers_from_filmqa`, command `answer-from-filmqa` | `answers_from_render_check`, command `answer-from-render-check` |
| `content_gate_pin` (BLAKE3 of the copy gate's files and the frozen `verdict-rules.json`) | `content_gate_pin`: the copy check's code and the branch rows as read (no file) |
| `his_rule_ids` (read `verdict-rules.json`) | `verdict_rule_ids` through `branch_rules` (`do-work/branch-rules.mjs`) |
| `run_check_mjs` (`tools/copy-gate/check.mjs --verdict-rules <file>`) | `run_check_mjs` (`check-a-films-copy.mjs --branch --settings-record` and the door; `copy_gate_verdict` gains `exclude` for the copy row) |
| `film_qa_tool` (`TRILLION_WORKSHOP`), `FILM_QA_LIMITS` | `film_qa_tool` (the render check beside this tool), `render_check_limits` (setting or `--render-check-limits`) |
| `start` (auto-start) and `parse_header`, `header_tags`, `route_applies` | `investigation.start`, `routes.py`, already here |
| `main()` gate parsers and dispatch | `do-work/delivery_gate_commands.py` |
| `measure.sh` (`HFM`, `VC`, `EARSHOT_PY`, `CIS_TOOLS`, `TRILLION_WORKSHOP` environment) | `do-work/measure-reference.sh` (every program an argument) |

What changed besides the names, so the person's data reads the same: every literal of that one library is a `delivery_gate` key (`pick-gate.json` is `film_config_file`, `films` is `films_folder`, `ROUND (\d+) ` is `watch_round_pattern`, `options-ch` is `lane_prefix`, `previews-round-(\d+)` is `preview_round_pattern`, `held-back-from-watch` is `held_back_folder`, `*.mp4` and `.mp4/.mov` are `sweep_preview_glob` and `watch_suffixes`, the moment regexes are `option_moment_patterns`, the fact layouts are `fact_layouts` and `fact_round_pattern`, `S5`/`S6` at `review` are `sweep_stages`, `audit_stages`, `audit_at`, the four content gate ids are `content_gate_roles`, `workflow_checklist.json` is the `checklist_pool`, the limits are `render_check.limits`). Renamed for the person, never one person's name: the output keys `waits_for_<the person's first name>` -> `waits_for_the_person` and `waits_for_<the person's first name>_picked_design` -> `waits_for_the_person_picked_design`; the person's first name, "his" and "him" -> "the person", "their" and "them" in every message and docstring; "film-qa" -> "the render check" in row evidence. A machine row recorded by the old gate under the copy, verdict or audio pin no longer counts (its pin named the frozen rule file or cis.py's bytes): run `content-gates` or `audition-gates` again. Dropped: the old test that the person's own checklist names every recipe rule of their frozen verdict file (`test_every_recipe_rule_is_a_per_option_check`): it checked one library's data against a file that no longer exists, not the gate.

Old Trillion had no counterpart: no delivery checklist, per-option answer rows, file-pinned rows or watch-folder audit (searched Trillion-X/trillion 45fe702 `parts/` and `src/` for `per_option`, `advisory_passes`, `unanswered_must`, `file_pins`, `delivery_stage`, `watch these`, `held-back`, and for `checklist`; `parts/content-media-evidence`, `parts/judge-words` and `parts/record-video` hold no such gate, `parts/media-composition` is not there). The nearest is `src/done-when.mjs:124` `makeDoneWhen`, which marks one waiting row done only when a rule over current facts passes: a done check, not a checklist of evidence rows per option.
