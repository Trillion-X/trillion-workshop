# tools/person-list/

Search a list of people (or any records) by any field and show each with a title, subtitle and detail; rank people by the points their activity earns, with levels; merge people a source sends into the rows of a list, each person once. Ported from bitfield-packages `person-list`: its two readers unchanged. Its screens and the requests they sent to the old runtime were not brought in: `search-people` is `tool:find-people`, `refresh-people` has nothing to refresh (the records door reads the person's records as they are now), and `read-activity-effects` became the records-door read in `rank-recorded-activity.mjs`. The three Workshop tools that run it in the tool container are rows in `tool-rows.json`.

## Files

| File | Purpose |
|------|---------|
| `read-data/read-people.ts` | Reads records through field descriptors (which keys to read, which is the title, subtitle, detail), joins extra field values and filters by search text. |
| `read-data/read-leaderboard.ts` | Scores activity by weight per kind over each metric's window, ranks people and finds each one's level. |
| `do-work/find-people.mjs` | `tool:find-people`: search people from records in the input or a JSON file from the person's files; without field descriptors every field is read and searched. |
| `do-work/rank-people.mjs` | `tool:rank-people-by-activity`: ranked people with points, every metric and level. |
| `read-data/rank-activity.mjs` | The scoring both ranking tools share: activity in, ranked people with points, counts and level out. |
| `read-data/rank-recorded-activity.mjs` | `tool:rank-people-by-recorded-activity`: reads the person's `person-activity` records through the records door (`fields` maps another record shape by dotted path) and ranks them. Ported from the package's `read-activity-effects.ts`. |
| `do-work/merge-people.mjs` | Pure merge of people from one source into a list's rows: matched by a shared phone number (by its last digits) or email, else by a name only one row and one person have (and no phone or email on the row disagrees), else by that source's own row, else added; a source's own row folds into the person's other row when nothing typed on it would be lost; only changed values are written, nothing a person typed is lost. Used by Trillion's `src/list-people.mjs`. |
| `part.json` | Both readers and `merge-people.mjs` are public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:find-people`, `tool:rank-people-by-activity`, `tool:rank-people-by-recorded-activity`. |
| `test/read-leaderboard.test.ts` | Tests for this folder, run by `npm test` at the top of the repository. |
| `test/read-people.test.ts` | Tests for this folder, run by `npm test` at the top of the repository. |
| `test/rank-people-tools.test.mjs` | The recorded-activity row run as the container runs it, against the fake records door with exactly the row's rights. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `RecordFieldDescriptor` | `{key, label?, sourceKeys?, searchable?, displayRole?: 'title' \| 'subtitle' \| 'detail' \| 'metric' \| 'chip', order?}` | One field to read and how to show it. |
| `decodeRecordFieldDescriptors` | `(raw) -> RecordFieldDescriptor[]` | Snake-case DATA to descriptors. |
| `decodeAddressedRecords` | `(rows, descriptors) -> {id, fields}[]` | Records with the described fields. |
| `joinFieldValuesToRecords` | `(records, fieldValues, descriptors) -> {records, withFieldValues}` | Adds title, subtitle and detail. |
| `filterAddressedRecords` | `(records, search, descriptors) -> records` | Records whose searchable fields contain the text. |
| `decodeLeaderboardConfig` | `(raw) -> {weights, levels, metrics, sortMetricKey} \| null` | The scoring, or null when incomplete. |
| `rankActors` | `(rows, weights, metrics, now, sortMetricKey) -> {actorRef, metricValues, rank}[]` | Ranked people. |
| `levelFor` | `(points, levels) -> {level, name, min_points}` | The highest level the points reach. |
| `sourceRowId` | `(sourceId, key) -> string` | The row id a source's own person gets (`<source>:<key>`, at most 200 characters). |
| `mergePeople` | `({rows, fills, source, people}) -> {writes: [{id, values}], removes: [row id], added, updated, unchanged}` | The rows to write and the source rows folded away; `fills` are `{from, field_id, merge: fill \| keys \| union, match?: unique, normalize?: digits \| lowercase \| words, suffix_digits?, join?, as_list?}`. |

## Dependencies

**Depends on:** `tools/records-door` (the recorded-activity row packs it); otherwise nothing (Node 24 in the tool container runs the `.ts` files by stripping their types).

**Depended on by:** Trillion's `src/list-people.mjs` and `test/list-people.test.mjs` (merge-people), `tool-rows.json`, Trillion's deploy (it bundles the files a row names), `test/read-people.test.ts`, `test/read-leaderboard.test.ts`, Trillion's `test/crm-tools.test.mjs`.
