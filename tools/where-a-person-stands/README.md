# tools/where-a-person-stands/

Where a person stands on one thing made for them (a title, a voice take, a plan, a file): agree, disagree or partly, with their own words for why. A stand is kept as one `stance` record per thing, named `stance:<identity>`, through the Workshop's `keeps_records`, so the engine's ordinary record write keeps it. A change of mind is a new version of the same record, so every earlier stand is that record's history and never a copy inside it. The reader takes those versions and says the stand now, the person's words and every stand before it. Taken from the decision engine's record-stance owner: the stands, the person-only rule and the refusals are the same. What changes is that its earlier list and file-name lookup are not code here. Versions replace the list, and a file is named by its identity.

## Files

| File | Purpose |
|------|---------|
| `read-data/stances.json` | The record kind (`stance`), its id prefix, the stands a person can take (`agree`, `disagree`, `partly`) and the words of every refusal. A new stand is one row. |
| `do-work/where-a-person-stands.mjs` | Builds the record to keep and reads stands back from versions. Its header holds the four invariants. |
| `do-work/keep-where-you-stand.mjs` | `tool:keep-where-you-stand`: the stance record to keep, or `{ error }` for a stand that is not the person's or a thing named by anything but its identity. |
| `do-work/read-where-you-stand.mjs` | `tool:read-where-you-stand`: each thing's stand now, its why and its earlier stands. |
| `part.json` | `do-work/where-a-person-stands.mjs` is public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:keep-where-you-stand` (with `keeps_records`) and `tool:read-where-you-stand`. |
| `test/where-a-person-stands.test.mjs` | Identity refs, person-only stands, verbatim words, newest-wins and earlier stands, silence as no stand, and both rows' samples run as the container runs them. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| Stance record | `{ type: "stance", id: "stance:1f:<hex>", artifact: "1f:<hex>", stance: "agree" \| "disagree" \| "partly" \| null, said?, why?, by, at }` | One thing's stand. `stance: null` takes the stand back. `why` is kept exactly as given. |
| `artifactOf` | `(ref) -> "1f:<hex>"` | The identity a ref names (`1f:` + 64 hex, with or without `file:`). A name is refused. |
| `stanceRecordId` | `(ref) -> "stance:1f:<hex>"` | The one record that keeps a thing's stand. |
| `stanceRecord` | `({ artifact_ref, stance, why?, answered_by: "person", by?, at? }) -> record` | The record to keep. Refuses anything but the person's own stand. |
| `standsFrom` | `(versions, artifact_ref?) -> [{ artifact, stance, said, why, by, at, earlier }]` | Versions in any order, as values or `{ value }` / `{ payload }`. The newest by `at` is the stand and every older one is in `earlier`, oldest first. A thing with no record reads `stance: null`. |
| `stanceChoices` | `() -> [{ id, label }]` | The stands a person can take. |

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the scripts).

**Depended on by:** `tool-rows.json` and `test/where-a-person-stands.test.mjs`.
