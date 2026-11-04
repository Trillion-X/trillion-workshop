# content-media-evidence

Alex's content-media-evidence package as Trillion uses it: how a part stages a file it made (a recording) so the app keeps it, and how a board reads the evidence relations it keeps.

## Files

| File | Purpose |
|---|---|
| `do-work/content-media-work-loop.ts` | Staging a file (`stageContentMediaFile`), choosing local files, creating relations and submitting workflow actions, through the records seam |
| `read-data/content-media-evidence.ts` | Reading the evidence projection (`readEvidenceProjection`), relation addresses and canonical artifact refs |
| `read-data/content-media-evidence.test.ts` | Tests of those readers |

## Key Types / Functions

| Name | Signature / Shape | Role |
|---|---|---|
| `stageContentMediaFile` | `(input: { packageName, file, sourceId?, role?, pathLabels? }) => Promise<ContentMediaSourceRef>` | Hands the file itself to `content-media-evidence.materialize-artifact` and returns the source ref the part keeps |
| `ContentMediaSourceRef` | `{ role, media_type, display_name, artifact_ref }` | What a part keeps about a staged file |
| `submitWorkflowAction` / `createContentMediaRelation` | `(...) => Promise` | Owner actions sent to `slot::workflow` |
| `readEvidenceProjection` | `(raw: unknown, packageName: string) => EvidenceProjection` | Rows, relations and blockers of one package's evidence |
| `relationAddress` / `isRelationAddress` | `(scopeRef, idempotencyRef) => string` / `(value) => boolean` | The `package::content-media-evidence::relation::` address of a relation |
| `decodeCanonicalArtifactRef` | `(value, limits) => CanonicalArtifactRef` | Checks a stored artifact ref |

## Dependencies

**Depends on:** `#workspace-records` (`src/workspace/records.ts`); the materializer target is answered by `src/workspace/recordings.ts` (recording parts) and `src/workspace/backgrounds.ts` (anything else).
**Depended on by:** `parts/record-audio/do-work/recorded-file-artifact.ts`, `parts/record-video/do-work/recorded-file-artifact.ts`, both parts' `*-requests.ts` (types).

Ported from the Bitfield package `packages/content-media-evidence`; the work loop's one difference (the file itself goes to the materializer, so a recording of any length is kept) is listed in `scripts/port-sources.json`.
