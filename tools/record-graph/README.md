# tools/record-graph/

The one generic record graph over any of the person's records: relations, entities and activities written and read through records:read, records:list and records:write only, as the engine's record model DATA, with every walk bounded by `read-data/record-graph.json`. A relation is participation between any two records with the role as data (`record:crm:pat` is the `dad` of `me`) and an order key per side; an entity is an organisation, group or place made once by its name; an activity is one record per thing that happened, with every record that took part under its own role. Ported from Trillion's `src/record-model-tools.mjs` (`relate`, `orderedRelations`, `contactHistory`, the `relate_records` and `read_model` tools) over `src/record-model.json`; the walks over the whole graph are new. Nothing here is in the engine: the engine stores generic records, and these tools are the only code that reads them as a graph.

## The model

| Record | Id | Value |
|---|---|---|
| `relation` | `relation:<hash of [subject, role, object]>` | `{ subject, role, object, alive, subject_order, object_order, said? }`: each end orders its links of one role on its own (fractional keys, ties by id); `alive: false` ends it and keeps its places. |
| `organisation`, `group`, `place` | `<kind>:<slug of the name>` | `{ name }`, made once, the first time a relation, an activity or `entities` names it. |
| `activity` | `activity:<hash of [kind, at, source, participants]>` | `{ kind, at, participants: [{ record, role }], summary?, direction?, said?, source? }`. |

`me` is `record:person:me` (`relations.self`). Saying the same thing again writes nothing: the ids are the old relate's, so records it kept read the same here.

## How the reads go through the door

- One end's relations are `records:list { type: relation, where: { subject | object: <id>, role? } }`, at most `relations.side_most` (the old engine's participation index read as "what holds this end").
- A history reads the `activity` kind (narrowed at the door by `where: { kind }` when kinds are named), at most `activities.scan_most` rows, keeping those this record took part in: the door has no index into the participants list.
- A walk (neighbours, paths, shared hubs) reads the relations (and activities) once, at most `graph.scan_most` of each kind, with only the fields it needs, and walks them in memory: a relation is an edge between its ends; an activity is a record each participant reaches under its role. `hops_most`, `path_length_most`, `paths_most`, `visits_most`, `steps_most` and `members_most` bound the walk. Any answer a bound cut says `complete: false`.

## Files

| File | Purpose |
|------|---------|
| `read-data/record-graph.json` | The DATA: relation and activity words and bounds (the engine's `product/record-model.json` `relations` and `activities`), read limits and walk bounds. |
| `read-data/graph-records.mjs` | Shared: the DATA, the old naming (`slug`, `textHash`), the two sides, bounded list reads, one end's relations, the activity read. |
| `read-data/fractional-order.mjs` | `isOrderKey`, `keyBetween`: Trillion's fractional order keys, unchanged. |
| `do-work/relate.mjs` | `tool:relate-records` (`relateRecords`): `relate` ported; writes in door-sized batches. |
| `read-data/read-around.mjs` | `tool:read-the-graph-around-a-record` (`readAround`): relations by side and role in order, `contactHistory`, neighbours; `orderedRelations` ported. |
| `read-data/graph-walk.mjs` | `loadGraph` (one bounded read of the graph), `projectGraphRecords` (pure supplied-record projection), `neighbours`, `paths` (shortest first, no record twice), `shared` (hubs and their members). |
| `read-data/find-connections.mjs` | `tool:find-how-records-connect` (`findConnections`): paths between two records, or what records share. |
| `part.json` | The three tools' functions, the walk and the DATA are public. |
| `tool-rows.json` | The Workshop rows: `tool:relate-records`, `tool:read-the-graph-around-a-record`, `tool:find-how-records-connect`. |
| `test/relate.test.mjs` | The old relate tests (participation, order and alive, activities), ported over the door. |
| `test/read-around.test.mjs` | The old history tests, the ordered read, a record's relations grouped, neighbours. |
| `test/find-connections.test.mjs` | Paths, shared hubs, refusals, every DATA bound, a graph of thousands of records. |
| `test/record-graph-rows.test.mjs` | The three rows run as the container runs them, with exactly their rights, and their verify samples. |
| `test/graph-door.mjs`, `test/fixtures.mjs` | The records-door client against the fake door; made-up activities the tests share. |

## Key Functions

| Name | Signature | Role |
|------|-----------|------|
| `relate` | `(door, { relations?, entities?, activities? }, { model? }) -> { relations, entities, activities? }` | Keeps relations, entities and activities, as the old relate did. |
| `orderedRelations` | `(door, { id, side, role, ended? }) -> { id, side, role, relations, complete }` | One end's relations of one role in that end's order. |
| `contactHistory` | `(door, { id, with?, kinds?, role?, since?, until?, limit? }) -> { id, activities, count, last_contact, complete }` | Everything that happened with a record, newest first. |
| `readAround` | `({ id, side?, role?, ended?, history?, hops?, roles?, kinds?, activities?, limit? }, { door }) -> { id, relations, history?, neighbours?, complete }` | The model around one record. |
| `findConnections` | `({ from?, to?, of?, max_length?, roles?, kinds?, activities?, ended?, limit? }, { door }) -> { paths } \| { hubs, members }` | The connection query over the whole graph. |

## Dependencies

**Depends on:** `tools/records-door` (the door client, the run driver and `write-batches.mjs`; tests use its fake door, and run the rows with `test-helpers/run-a-row.mjs`), and through it `tools/content-identity`.

**Depended on by:** `tools/organize-the-sidebar/read-data/read-knowledge-graph.ts` and the Apps group surface use `projectGraphRecords` for their graph feed. Trillion also offers the three rows to every person's AI.

## Supplied-record projection

`projectGraphRecords(rows, options = {}, model = MODEL)` is a pure adapter over the maintained record model. It shares relation/activity topology with `loadGraph`; it performs no door calls or writes. Input is records-door rows `{ id, type, value }`, or scoped-feed envelopes `{ address, type, payload }` (an explicit payload `type` or `kind` can also identify the record type). Addresses are identities, never type guesses. The options are the same `roles`, `kinds`, `ended` and `activities` filters as `loadGraph`.

A producer can also supply `{ records: rows, complete: false }` when its own scoped feed was cut; this flag survives even when no nodes were read. Arrays remain supported. The result is `{ nodes: [{ id, attributes }], connections: [{ id, endpoints: [{ node_id, role }], attributes }], complete, read }`. A relation is one connection with its role retained as an attribute. An activity is its actual record node, with a spoke to each participant under that participant's role; three participants produce three spokes, never three pairwise participant links. Source attributes provide labels. An endpoint absent from the supplied records stays a reference so the existing consumer can show “Missing record”; this function never manufactures its record. Unrelated records and malformed relations/activities add no graph membership. Repeated source IDs are kept once, first supplied value winning.

Untyped source rows and conflicting row/value identities are omitted and flag the result as incomplete. Self-relations remain visible as self-connectors; traversal retains its established exclusion of self steps. Each activity reads at most `activities.participants_most` participants, shared by the projection and door walk, and marks a cut incomplete. Each of relations, activities and other records is capped by `graph.scan_most` from the supplied editable model; a cut returns `complete: false` and per-category read counts. That completeness describes only the supplied scope, never the whole account. Upstream omissions remain unknown unless the producer explicitly carries `complete: false`. This is new projection glue over the maintained model, not a restoration of the retired arbitrary descriptor interpreter. Source tests cover the caller through its adapter, fold and render-frame builder. Apps `web/test/knowledge-graph-source-entry.test.mjs` additionally uses the real page resolver, React/UI/Canvas and an explicit test-only `WORKSHOP_GRAPH_SOURCE_ROOT` to qualify current source; its opt-in browser fixture (`GRAPH_SOURCE_BROWSER`) checks one positioned wrapper per node, labels within their nodes, selection and partial status with synthetic records and no account writes. Canvas placement belongs to GraphCanvas; the surface's render callback supplies only node content. An installed Apps package pin must separately adopt this Workshop revision before it can use this export; source fixtures do not establish a default producer or live/account wiring.
