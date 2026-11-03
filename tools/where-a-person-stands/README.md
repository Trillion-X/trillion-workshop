# tools/where-a-person-stands/

Where a person stands on one thing made for them (a title, a voice take, a plan, a file): agree, disagree or partly, with their own words for why. Each kind of thing and identity gets one `stance` record, named `stance:<kind>:<identity>`. The Workshop's `keeps_records` writes it, so the engine's ordinary record write keeps it. A change of mind is a new version of the same record, so every earlier stand is part of that record's history and never a copy inside it. The reader takes those versions and gives the current stand, the person's words, and every stand before it.

`do-work/artifact-ref.mjs` is the only place that decides how a thing is identified. A text is `1f:` + BLAKE3 of the text after the owner's DATA fold, so the same title typed again finds the same stand. A file or JSON view is BLAKE3 of its bytes. Every check that keys a stand on a thing imports it. `tool:plan-a-stance-reload` turns stands kept elsewhere into these records' versions, earlier stands first, and says what would change before anything is written.

Words said elsewhere (a chat, a transcript, a note) are kept only when they are there. Send the source's whole text as `source_text` and `why` must appear in it literally, at or after `after_line` (in a `.jsonl` source, also JSON-escaped), or nothing is kept. The record then carries `said_from`: the source's name, the BLAKE3 identity of its bytes, the byte range and the line, so anyone can check the words against the file. A stand may also name one `rule` of the person's: an agree on an exact text then waives that rule there alone (`tools/check-against-a-persons-rules-and-verdicts`), and it is its own record, `stance:<kind>:<identity>:rule:<rule>`.

`do-work/rulings.mjs` keeps a lighter log: rulings on single lines (good or bad, by whom, under which rule) from anyone, append-only, each (text, verdict, by, rule) once. Only the rulings by the people the caller names become calibration examples for a small model.

This is taken from the decision engine's record-stance owner: the stands, the person-only rule and the refusals are the same. Its earlier list and its file-name lookup are not code here. Versions replace the list, and a thing is named by its identity.

## Files

| File | Purpose |
|------|---------|
| `read-data/stances.json` | The record kind (`stance`), its id prefix, the stands a person can take (`agree`, `disagree`, `partly`) and the words of every refusal. A new stand is one row. |
| `do-work/artifact-ref.mjs` | The one identity of a judged thing: `foldWith` (the DATA fold), `textRef`, `bytesRef`, `viewRef`, `artifactRef`. |
| `do-work/where-a-person-stands.mjs` | Builds the record to keep, reads stands back from versions, and plans a reload. Its header holds the invariants. |
| `do-work/keep-where-you-stand.mjs` | `tool:keep-where-you-stand`: the stance record to keep, or `{ error }` for a stand that is not the person's or a thing it cannot identify. |
| `do-work/read-where-you-stand.mjs` | `tool:read-where-you-stand`: one thing's stand now, its why and its earlier stands, from the history the caller read (it reads no records itself). |
| `do-work/rulings.mjs` | `freshRulings` (what to append to an append-only rulings log) and `examplesFromRulings` (calibration examples from the real rulings and the person's own speech, leaving out texts ruled both ways or trained on). Reads and writes no file. |
| `test/said-words-and-rulings.test.mjs` | Words found literally in their source (and in JSON lines), `said_from`, waiver stands with a rule, a reload that skips unverified words and kept versions, and the rulings log and its examples. |
| `do-work/plan-stance-reload.mjs` | `tool:plan-a-stance-reload`: the versions to write and a summary (by kind, refs changed, fold collisions). It writes nothing. |
| `part.json` | `do-work/where-a-person-stands.mjs` and `do-work/artifact-ref.mjs` are public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:keep-where-you-stand` (with `keeps_records`), `tool:read-where-you-stand` and `tool:plan-a-stance-reload`. Each packs `@noble/hashes` (BLAKE3) into the container. |
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
| `planReload` | `({ stances, fold, by?, sources?, kept? }) -> { writes, summary }` | Rows kept elsewhere become versions (each record's `earlier` first, oldest first). A row naming a `source` is checked against `sources`; a version in `kept` is not written again. `summary` holds `rows`, `records`, `versions`, `by_kind`, `refs_changed`, `collisions`, `already` and `unverified`. |
| `freshRulings` / `examplesFromRulings` | `(existing, rows, { at? }) -> rows` / `({ rulings, real?, needs?, speech?, speech_set?, exclude?, bad_label?, contexts? }) -> { items, left_out }` | The rulings log, append-only, and its calibration examples. |
| `stanceChoices` | `() -> [{ id, label }]` | The stands a person can take. |

## Reading a stand: two steps

A tool run is not given the person's record history, so the AI that holds their key reads it and hands it over:

1. Page `records:history` at `@own-records` with `{ id: "stance:<kind>:<identity>", limit: 100 }`, then again with `before_version: <next>` until `next` is null. Each page is `{ versions: [{ version, value, deleted, at }], next }`, newest first.
2. Run `tool:read-where-you-stand` with `{ versions: <every page's versions together>, next: <the last page's next> }`.

The identity comes from `do-work/artifact-ref.mjs` (or `stanceRecordId`), so the AI asks for the same record the keep tool wrote.

## Reload dry-run

Nothing is written. The fold comes from its owner's DATA:

```
jq -n --slurpfile s <export>.json --slurpfile r <rules>.json '{stances: $s[0].stances, fold: $r[0].fold, summary_only: true}' \
  | node tools/where-a-person-stands/do-work/plan-stance-reload.mjs
```

## Dependencies

**Depends on:** `tools/content-identity` (the BLAKE3 identity of bytes, packed at `/opt/content-identity` by each row), `@noble/hashes` (packed at `/opt/node_modules/@noble/hashes` by each row), Node 24 in the tool container.

**Depended on by:** `tool-rows.json` and `test/where-a-person-stands.test.mjs`.
