# tools/person-profile/

Lays out one person's (or any record's) profile from a description of what to show: title and subtitle, fields with values, related lists, and the actions whose rules hold. Ported from bitfield-packages `person-profile`: its interpreter, reader-keyed materialization and action-request builder unchanged, and its member-profile save moved onto the records door. Its screens (`show/`, `show-ios-jscore/`) and the browser cache that followed a save came in later (see "Moved from the package, later"). The Workshop tools that run it in the tool container are rows in `tool-rows.json`.

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

## Moved from the package, later

The screens, the iOS model and the rest the first port left out are here, byte for byte from the package at its last commit (`from-bitfield-packages/moved-from.json` is the receipt; a test's made-up member name replaces a real first name through the receipt's `calls`).

| File | Purpose |
|------|---------|
| `show/PersonProfileSurface.tsx`, `show/person-profile-screen-model.ts`, `show/mount-person-profile.tsx` | The profile screen: it draws the laid-out profile, its fields, related lists and actions, and mounts as the profile surface. |
| `show-ios-jscore/person-profile-jscore-model.js` | The same screen model for JavaScriptCore on the phone. |
| `do-work/save-member-profile.ts`, `do-work/save-profile-field.ts` | The package's member-profile save with the browser cache that followed a save, and the one-field save. `do-work/save-member-profile.mjs` is the records-door form of the same save and is the one the tool rows run; the `.ts` form calls the retired package runtime. |
| `tests/load-ts-module.mjs`, `tests/backend-proof.test.mjs.held`, `do-work/save-member-profile.test.ts.held`, `show/PersonProfileSurface.test.tsx`, `show-ios-jscore/person-profile-jscore.test.mjs` | The package's remaining tests and helper. |
| `things-to-store-and-run.json` | The package's own boundary file (the profile descriptor and its input descriptor), kept as data and not wired to a tool row. |

The two held tests are named in the receipt's `held` key. The screen's data layer (`sendRequestToBitfieldTarget`, `useBitfieldData`) and the shared UI parts it imports are not in this tree, so no tool row opens the screen yet.

## Dependencies

**Depends on:** `tools/records-door` for the two member-profile tools (Node 24 in the tool container runs the `.ts` files by stripping their types).

**Depended on by:** `tool-rows.json`, Trillion's deploy (it bundles the files a row names), `test/described-record-surface.test.ts`, Trillion's `test/crm-tools.test.mjs`.
