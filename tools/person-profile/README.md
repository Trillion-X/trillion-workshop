# tools/person-profile/

Lays out one person's (or any record's) profile from a description of what to show: title and subtitle, fields with values, related lists, and the actions whose rules hold. Ported from bitfield-packages `person-profile`: its interpreter, reader-keyed materialization and action-request builder unchanged, and its member-profile save moved onto the records door. Its screens (`show/`, `show-ios-jscore/`), the browser cache that followed a save, and the old engine's boundary json were not brought in. The Workshop tools that run it in the tool container are rows in `tool-rows.json`.

## Files

| File | Purpose |
|------|---------|
| `read-data/described-record-surface.ts` | The pure interpreter: sources plus a layout description in, a laid-out profile out. |
| `do-work/lay-out-a-profile.mjs` | `tool:lay-out-a-profile`. |
| `read-data/described-record-materialization.ts` | The interpreter keyed by reader: the same source gives every reader the same laid-out profile. Carried unchanged but for its import. |
| `do-work/described-record-action.ts` | Builds the request for a profile action from its description: the action's fixed input, the values given and values bound from named sources. Carried unchanged. |
| `do-work/save-member-profile.mjs` | `tool:read-a-member-profile` and `tool:save-a-member-profile`: one `member-profile` record per member through the records door. A save changes only the fields given, keeps everything else the record holds, writes once and reads back before it says it saved. |
| `part.json` | The interpreter is public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:lay-out-a-profile`, `tool:read-a-member-profile`, `tool:save-a-member-profile` (the last two reach only `member-profile` records, through `tools/records-door`). |
| `test/described-record-surface.test.ts` | The interpreter's tests, run by `npm test` at the top of the repository. |
| `test/described-record-action.test.mjs`, `test/described-record-materialization.test.mjs` | The package's action and materialization tests. |
| `test/person-profile-boundary.test.mjs` | The package's guard that the generic parts name no profile-specific family or field word, and its projection and descriptor-driven action tests. |
| `test/member-profile.test.mjs` | The two member-profile tools run as the container runs them, against the fake records door. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `DescribedRecordSurfaceDescriptor` | `{kind, surfaceId, identity?, fields?, relationships?, actions?}` | What the profile shows. |
| `projectDescribedRecordSurface` | `({descriptor, sources, readerId?}) -> DescribedRecordSurface` | The laid-out profile: identity, visible fields with values, related lists with items, visible actions. |
| `readPath` | `(source, path) -> unknown` | One value by its path of member names. |

## Dependencies

**Depends on:** `tools/records-door` for the two member-profile tools (Node 24 in the tool container runs the `.ts` files by stripping their types).

**Depended on by:** `tool-rows.json`, Trillion's deploy (it bundles the files a row names), `test/described-record-surface.test.ts`, Trillion's `test/crm-tools.test.mjs`.
