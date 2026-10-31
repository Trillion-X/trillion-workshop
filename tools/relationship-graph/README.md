# tools/relationship-graph/

Who is connected to whom: records in, and a description of which records are connections and how to read each, out comes each person or company once with the connections it is in and each connection with its ends and details. Ported from bitfield-packages `relationship-graph`: its reader, descriptor and model unchanged. The two request builders are carried too, with the old runtime's targets (`slot::graph-query`, the owner-action target the old runtime sent to) taken out: the map is lowered into graph operations that are kept as records of the person's own through the records door, and a prepared action request is kept as a record for whatever owns the action. The Workshop tools that run it in the tool container are rows in `tool-rows.json`.

## Files

| File | Purpose |
|------|---------|
| `read-data/connection-model.ts` | The shapes: descriptor, selector expression, nodes, connections, issues. |
| `read-data/connection-descriptor.ts` | The selector expressions (`literal`, `record-address`, `json-path`, `row-path`, `include-all`, `exists`, `equals`, `and`, `json-field-equals`) and the descriptor check. |
| `read-data/read-connection-graph.ts` | Reads rows into the connection map, sorted, with an issue for each row that could not be read. |
| `do-work/map-who-is-connected.mjs` | `tool:map-who-is-connected`, from records in the input or a JSON file from the person's files. |
| `read-data/build-graph-query-request.ts` | Lowers a map into `put-node` and `put-connection` operations, without running any graph algorithm. |
| `do-work/request-connection-action.ts` | Prepares the request an action on a connection asks for: its target, and its input read through the action's `input_mapping`. |
| `do-work/keep-who-is-connected.mjs` | `tool:keep-who-is-connected`: reads the `connection` records through the records door and keeps the map as `graph-node` and `graph-connection` records. |
| `do-work/request-a-connection-action.mjs` | `tool:request-a-connection-action`: keeps the prepared request as a `connection-action-request` record. |
| `part.json` | The reader and the model are public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:map-who-is-connected`, `tool:keep-who-is-connected`, `tool:request-a-connection-action`. |
| `test/read-connection-graph.test.ts`, `test/build-graph-query-request.test.ts`, `test/request-connection-action.test.ts` | The package's three tests, run by `npm test` at the top of the repository. |
| `test/connection-tools.test.mjs` | The two records-door tools, run as the container runs them against the fake door, with made-up records. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `ConnectionProjectionDescriptor` | `{kind: 'generic-connection-projection-descriptor', id, record_selectors, views?, actions?}` | Which records are connections and how to read them. |
| `readConnectionGraph` | `(rows, descriptor, registry?) -> ConnectionGraphModel` | The map: `nodes`, `connections`, `issues`, `changed`. |
| `evaluateSelector` | `(expression, {row, payload}, registry?) -> unknown` | One selector expression against one row. |

## Dependencies

**Depends on:** `tools/records-door` (the two record-keeping tools pack it); otherwise nothing (Node 24 in the tool container runs the `.ts` files by stripping their types).

**Depended on by:** `tool-rows.json`, Trillion's deploy (it bundles the files a row names), `test/read-connection-graph.test.ts`, Trillion's `test/crm-tools.test.mjs`.
