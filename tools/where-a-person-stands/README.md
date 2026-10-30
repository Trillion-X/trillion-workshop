# tools/where-a-person-stands/

Where a person stands on one thing made for them (a title, a voice take, a plan, a file): agree, disagree or partly, with their own words for why. Each kind of thing and identity gets one `stance` record, named `stance:<kind>:<identity>`. The Workshop's `keeps_records` writes it, so the engine's ordinary record write keeps it. A change of mind is a new version of the same record, so every earlier stand is part of that record's history and never a copy inside it. The reader takes those versions and gives the current stand, the person's words, and every stand before it.

`do-work/artifact-ref.mjs` is the only place that decides how a thing is identified. A text is `1f:` + BLAKE3 of the text after the owner's DATA fold, so the same title typed again finds the same stand. A file or JSON view is BLAKE3 of its bytes. Every check that keys a stand on a thing imports it. `tool:plan-a-stance-reload` turns stands kept elsewhere into these records' versions, earlier stands first, and says what would change before anything is written.

This is taken from the decision engine's record-stance owner: the stands, the person-only rule and the refusals are the same. Its earlier list and its file-name lookup are not code here. Versions replace the list, and a thing is named by its identity.

## Files

| File | Purpose |
|------|---------|
| `read-data/stances.json` | The record kind (`stance`), its id prefix, the stands a person can take (`agree`, `disagree`, `partly`) and the words of every refusal. A new stand is one row. |
| `do-work/artifact-ref.mjs` | The one identity of a judged thing: `foldWith` (the DATA fold), `textRef`, `bytesRef`, `viewRef`, `artifactRef`. |
| `do-work/where-a-person-stands.mjs` | Builds the record to keep, reads stands back from versions, and plans a reload. Its header holds the invariants. |
| `do-work/keep-where-you-stand.mjs` | `tool:keep-where-you-stand`: the stance record to keep, or `{ error }` for a stand that is not the person's or a thing it cannot identify. |
| `do-work/read-where-you-stand.mjs` | `tool:read-where-you-stand`: each thing's stand now, its why and its earlier stands. |
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
| `stanceRecord` | `({ kind, artifact_ref \| text \| contains \| view, fold?, stance, why?, answered_by: "person", by?, at? }) -> record` | The record to keep. Refuses anything but the person's own stand, a name instead of an identity, and text without a fold. |
| `standsFrom` | `(versions, { artifact_ref?, kind? }) -> [{ id, kind, artifact, ..., stance, said, why, by, at, earlier }]` | Versions in any order, as values or `{ value }` / `{ payload }`. The newest by `at` is the stand, and every older one is in `earlier`, oldest first. A thing with no record reads `stance: null`. |
| `planReload` | `({ stances, fold, by? }) -> { writes, summary }` | Rows kept elsewhere become versions (each record's `earlier` first, oldest first). `summary` holds `rows`, `records`, `versions`, `by_kind`, `refs_changed` and `collisions`. |
| `stanceChoices` | `() -> [{ id, label }]` | The stands a person can take. |

## Reload dry-run

Nothing is written. The fold comes from its owner's DATA:

```
jq -n --slurpfile s <export>.json --slurpfile r <rules>.json '{stances: $s[0].stances, fold: $r[0].fold, summary_only: true}' \
  | node tools/where-a-person-stands/do-work/plan-stance-reload.mjs
```

## Dependencies

**Depends on:** `@noble/hashes` (BLAKE3; a dependency of this repository, packed into the container at `/opt/node_modules/@noble/hashes` by each row), Node 24 in the tool container.

**Depended on by:** `tool-rows.json` and `test/where-a-person-stands.test.mjs`.
