# tools/where-a-person-stands/

Where a person stands on one thing made for them (a title, a voice take, a plan, a file): agree, disagree or partly, with their own words for why. Each kind of thing and identity gets one `stance` record, named `stance:<kind>:<identity>`. The Workshop's `keeps_records` writes it, so the engine's ordinary record write keeps it. A change of mind is a new version of the same record, so every earlier stand is part of that record's history and never a copy inside it. The reader takes those versions and gives the current stand, the person's words, and every stand before it.

`do-work/artifact-ref.mjs` is the only place that decides how a thing is identified. A text is `1f:` + BLAKE3 of the text after the owner's DATA fold, so the same title typed again finds the same stand. A file or JSON view is BLAKE3 of its bytes. Every check that keys a stand on a thing imports it. `tool:plan-a-stance-reload` turns stands kept elsewhere into these records' versions, earlier stands first, and says what would change before anything is written.

Words said elsewhere (a chat, a transcript, a note) are kept only when they are there. Send the source's whole text as `source_text` and `why` must appear in it literally, at or after `after_line` (in a `.jsonl` source, also JSON-escaped), or nothing is kept. The record then carries `said_from`: the source's name, the BLAKE3 identity of its bytes, the byte range and the line, so anyone can check the words against the file. A stand may also name one `rule` of the person's: an agree on an exact text then waives that rule there alone (`tools/check-against-a-persons-rules-and-verdicts`), and it is its own record, `stance:<kind>:<identity>:rule:<rule>`.

Rulings are lighter: rulings on single lines (good, bad or escalated, by whom, under which rule) from anyone, such as a line a checker flagged. Each is a row of a list in the person's own account, one record per (text, verdict, by, rule) (`record:<row type>:<BLAKE3 hex>`), and a ruling already in the list is not written again, so the first one keeps its time. A write holding a row the person's `refuse` setting names (a test piece, a temporary folder) is refused whole. Only the rulings by the people the person names count: they become calibration examples for a small model (`tool:make-examples-from-rulings`), the options a person picked or rejected become examples too (`tool:make-examples-from-picks`), and `tool:count-real-rulings` says whether there are enough real bad rulings for a model row to fail lines and how many each row catches. `tool:count-where-a-person-stands` counts the stands read back by kind.

Who counts, the fields a ruling needs, the number needed, the bad label, the refused pieces and folders, the place pattern and the words a hand-given ruling may use are the person's setting for this tool: a row of `list:settings` (`record:setting:where-a-person-stands~<scope kind>~<scope id>`), handed in as `settings_record` (the record as `records:read` gives it) and read with the one shared reader, `tools/settings` (`setting`). The input's own fields win over it, which is how a test runs with no account.

The rulings tools are the copy gate's verdict log, moved from trillion-launch-video `tools/copy-gate/verdicts.mjs` (at 5a9ba398): its log file became the person's list, its `ask-rules.json` `promote_when` and `verdict-log.json` refusals became the setting, and its `add --by <person>`, `backfill` and `stances` commands are `tool:keep-where-you-stand`, `tool:plan-a-stance-reload` and `tool:read-where-you-stand` with `tool:count-where-a-person-stands`. Its `stance-items` are `tool:make-examples-from-where-a-person-stands` in `tools/check-against-a-persons-rules-and-verdicts`. The port contracts are in `ports/`. Old trillion had no owner of either job: `git grep -i -E "verdict|ruling"` finds nothing in its `parts/judge-words`, and its one person-scoped DATA kind was `setting` (`src/decision-store.mjs` before 4ffa1dc4a2, lines 8 and 751-762), which `tools/settings` ports.

This is taken from the decision engine's record-stance owner: the stands, the person-only rule and the refusals are the same. Its earlier list and its file-name lookup are not code here. Versions replace the list, and a thing is named by its identity.

## Files

| File | Purpose |
|------|---------|
| `read-data/stances.json` | The record kind (`stance`), its id prefix, the stands a person can take (`agree`, `disagree`, `partly`) and the words of every refusal. A new stand is one row. |
| `do-work/artifact-ref.mjs` | The one identity of a judged thing: `foldWith` (the DATA fold), `textRef`, `bytesRef`, `viewRef`, `artifactRef`. |
| `do-work/where-a-person-stands.mjs` | Builds the record to keep, reads stands back from versions, and plans a reload. Its header holds the invariants. |
| `do-work/keep-where-you-stand.mjs` | `tool:keep-where-you-stand`: the stance record to keep, or `{ error }` for a stand that is not the person's or a thing it cannot identify. |
| `do-work/read-where-you-stand.mjs` | `tool:read-where-you-stand`: one thing's stand now, its why and its earlier stands, from the history the caller read (it reads no records itself). |
| `read-data/rulings.json` | The record id prefix of a ruling row and the words of every refusal. |
| `do-work/rulings.mjs` | `examplesFromRulings` (calibration examples from the real rulings and the person's own speech, leaving out texts ruled both ways or trained on) and `withSettings` (the person's setting under the input of every rulings tool); `makeExamplesFromRulings` is `tool:make-examples-from-rulings`. |
| `do-work/ruling-records.mjs` | `rulingRecords` (the records:write input that keeps the rulings not already in the list, refusing a write that holds a refused row) around `freshRulings`; `keepRulings` is `tool:keep-rulings-on-lines`. |
| `do-work/picks.mjs` | `examplesFromPicks` (examples the picked and rejected options imply); `makeExamplesFromPicks` is `tool:make-examples-from-picks`. |
| `do-work/ruling-status.mjs` | `rulingStatus` (real bad rulings against the number needed, then what each model row catches once the check's results on them are sent); `countRealRulings` is `tool:count-real-rulings`. |
| `ports/*.json` | The port contracts of `ruling-records.mjs`, `picks.mjs` and `ruling-status.mjs`. |
| `test/said-words-and-rulings.test.mjs` | Words found literally in their source (and in JSON lines), `said_from`, waiver stands with a rule, a reload that skips unverified words and kept versions and checks every earlier stand against its own source, ruling records and a refused write, examples from rulings and from picks, and the count of real rulings. |
| `test/rulings-from-the-verdict-log.test.mjs` | The copy gate's verdict-log tests on the list: once per (text, verdict, by, rule), refused test pieces, temporary and scratch folders, real film rulings only, t_fail, the default kind, hand-given words, the pick ledger, the stand count, the input alone without a setting, and the setting read by tools/settings. |
| `do-work/plan-stance-reload.mjs` | `tool:plan-a-stance-reload`: the versions to write and a summary (by kind, refs changed, fold collisions). It writes nothing. |
| `part.json` | `do-work/where-a-person-stands.mjs`, `do-work/artifact-ref.mjs`, `do-work/rulings.mjs`, `do-work/ruling-records.mjs`, `do-work/picks.mjs` and `do-work/ruling-status.mjs` are public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:keep-where-you-stand` (with `keeps_records`), `tool:read-where-you-stand`, `tool:plan-a-stance-reload`, `tool:keep-rulings-on-lines`, `tool:make-examples-from-rulings`, `tool:make-examples-from-picks`, `tool:count-real-rulings` and `tool:count-where-a-person-stands`. Each packs `@noble/hashes` (BLAKE3) into the container; the rulings rows run through `tools/records-door` `run-an-export` and pack `tools/settings`. |
| `test/where-a-person-stands.test.mjs` | The fold order, BLAKE3 test vectors, identity refs, person-only stands, verbatim words, newest-wins with earlier stands, silence as no stand, the reload plan, and every row's sample run as the container runs it. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| Stance record | `{ type: "stance", id: "stance:<kind>:1f:<hex>", kind, artifact: "1f:<hex>", text? \| contains? \| view?, stance: "agree" \| "disagree" \| "partly" \| null, said?, why?, by, at }` | One thing's stand. `stance: null` takes the stand back. `why` is kept exactly as given. |
| `foldWith` | `(fold) -> (text) -> text` | The DATA fold `{ lowercase?, quotes?, collapse_space?, strip_trailing? }`, applied in that order, with a trim before the trailing cut and a trim after it. |
| `textRef` / `bytesRef` / `viewRef` | `(text, fold)` / `(bytes)` / `(json) -> "1f:<hex>"` | BLAKE3-256 of the folded text's UTF-8, of the bytes, or of `JSON.stringify(view)`. |
| `artifactRef` | `({ text?, contains?, view? }, fold) -> "1f:<hex>"` | A view by its bytes, otherwise the text or part folded. |
| `stanceRecord` | `({ kind, artifact_ref \| text \| contains \| view, fold?, stance, why?, answered_by: "person", by?, at?, rule?, source_text?, source?, after_line? }) -> record` | The record to keep. Refuses anything but the person's own stand, a name instead of an identity, text without a fold, a bad rule id, and words not literally in the `source_text` sent. |
| `verbatimInSource` | `(why, source_text, { after_line?, source?, json_lines? }) -> { ok, reason, binding }` | Where the words are in their source: `{ source?, blake3, text, byte_start, byte_end, line, encoding? }`. |
| `standFrom` | `({ versions, next }) -> { id, kind, artifact, ..., stance, said, why, by, at, version, taken_back?, earlier, complete }` | The exact records:history output (the versions of every page read, together, and the last page's `next`). Ordered by `version` with overlaps counted once; the newest is the stand and every older one is in `earlier`, oldest first, a tombstone marked `deleted`. No version, a tombstone or a stand taken back reads `stance: null` with `taken_back`. `complete` is false while `next` is not null. |
| `planReload` | `({ stances, fold, by?, sources?, kept? }) -> { writes, summary }` | Rows kept elsewhere become versions (each record's `earlier` first, oldest first). A row or earlier stand naming a `source` is checked against `sources`, and a row that fails is listed in `unverified` by its record id; a version in `kept` is not written again. `summary` holds `rows`, `records`, `versions`, `by_kind`, `refs_changed`, `collisions`, `already` and `unverified`. |
| `rulingRecords` | `({ rows, existing?, row_type, refuse?, place?, by_hand?, hand_rulings?, at? }) -> { write: { records }, fresh }` | Rulings as list rows, one record per (text, verdict, by, rule), only those not in `existing`. |
| `examplesFromRulings` | `({ rulings, real?, needs?, speech?, speech_set?, exclude?, bad_label?, contexts?, verdicts? }) -> { items, left_out }` | Calibration examples from the real rulings. |
| `examplesFromPicks` | `({ films: [{ name, gate, decisions, files, units }], rulings?, real?, needs?, bad_label?, rejected? }) -> { items, left_out, units_needed }` | Examples the picks imply; `units_needed` names the specs whose lines to read and send again. |
| `rulingStatus` | `({ rulings, real?, needs?, needed?, verdict?, default_kind?, rules?, results? }) -> { real_bad_film, needed, promotion_allowed, counts, bad_lines, escalated_by_any?, per_rule?, unanswered? }` | The count, then what each model row catches once the check's results on `bad_lines` are sent. |
| `countStands` | `({ stands }) -> { read, by_kind, with_history, taken_back }` | The stands read back, counted. |
| `stanceChoices` | `() -> [{ id, label }]` | The stands a person can take. |

## Reading a stand: two steps

A tool run is not given the person's record history, so the AI that holds their key reads it and hands it over:

1. Page `records:history` at `@own-records` with `{ id: "stance:<kind>:<identity>", limit: 100 }`, then again with `before_version: <next>` until `next` is null. Each page is `{ versions: [{ version, value, deleted, at }], next }`, newest first.
2. Run `tool:read-where-you-stand` with `{ versions: <every page's versions together>, next: <the last page's next> }`.

The identity comes from `do-work/artifact-ref.mjs` (or `stanceRecordId`), so the AI asks for the same record the keep tool wrote.

## Keeping a ruling: two steps

1. Page the person's rulings list (`records:list` `{ type: "record:<row_type>" }` at `@own-records`) for the rulings already in it.
2. Read the person's setting (`records:read` `record:setting:where-a-person-stands~person~<id>`) and run `tool:keep-rulings-on-lines` with `{ settings_record: <that record>, rows, existing }` and send its `write` with `records:write` at `@own-records`.

The same pages are the `rulings` the example and count tools take.

## Counting real rulings: two steps

1. Run `tool:count-real-rulings` with `{ settings_record, rulings }`: it answers the count and `bad_lines`.
2. Check `bad_lines` with the person's model rows (`tools/check-against-a-persons-rules-and-verdicts`), then run it again with `rules` (those rows) and `results` (the check's results) for what each row catches.

## Reload dry-run

Nothing is written. The fold comes from its owner's DATA:

```
jq -n --slurpfile s <export>.json --slurpfile r <rules>.json '{stances: $s[0].stances, fold: $r[0].fold, summary_only: true}' \
  | node tools/where-a-person-stands/do-work/plan-stance-reload.mjs
```

## Dependencies

**Depends on:** `tools/settings` (the one reader of the person's setting, packed at `/opt/settings`), `tools/records-door` (`run-an-export`, packed at `/opt/records-door`), `tools/content-identity` (the BLAKE3 identity of bytes, packed at `/opt/content-identity` by each row), `@noble/hashes` (packed at `/opt/node_modules/@noble/hashes` by each row), Node 24 in the tool container.

**Depended on by:** `tool-rows.json` and `test/where-a-person-stands.test.mjs`.
