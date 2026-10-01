# tools/person-profile/

Lays out one person's (or any record's) profile from a description of what to show: title and subtitle, fields with values, related lists, and the actions whose rules hold. Ported from bitfield-packages `person-profile`: its interpreter unchanged. Its screens, reader-keyed wrapper and the action requests it sent to the old runtime were not brought in. The Workshop tool that runs it in the tool container is a row in `tool-rows.json`.

## Files

| File | Purpose |
|------|---------|
| `read-data/described-record-surface.ts` | The pure interpreter: sources plus a layout description in, a laid-out profile out. |
| `do-work/lay-out-a-profile.mjs` | `tool:lay-out-a-profile`. |
| `part.json` | The interpreter is public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:lay-out-a-profile`. |
| `test/described-record-surface.test.ts` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `DescribedRecordSurfaceDescriptor` | `{kind, surfaceId, identity?, fields?, relationships?, actions?}` | What the profile shows. |
| `projectDescribedRecordSurface` | `({descriptor, sources, readerId?}) -> DescribedRecordSurface` | The laid-out profile: identity, visible fields with values, related lists with items, visible actions. |
| `readPath` | `(source, path) -> unknown` | One value by its path of member names. |

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the `.ts` file by stripping its types).

**Depended on by:** `tool-rows.json`, Trillion's deploy (it bundles the files a row names), `test/described-record-surface.test.ts`, Trillion's `test/crm-tools.test.mjs`.
