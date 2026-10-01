# tools/relationship-graph/

Who is connected to whom: records in, and a description of which records are connections and how to read each, out comes each person or company once with the connections it is in and each connection with its ends and details. Ported from bitfield-packages `relationship-graph`: its reader, descriptor and model unchanged. The request builders for the old runtime's graph and owner actions were not brought in. The Workshop tool that runs it in the tool container is a row in `tool-rows.json`.

## Files

| File | Purpose |
|------|---------|
| `read-data/connection-model.ts` | The shapes: descriptor, selector expression, nodes, connections, issues. |
| `read-data/connection-descriptor.ts` | The selector expressions (`literal`, `record-address`, `json-path`, `row-path`, `include-all`, `exists`, `equals`, `and`, `json-field-equals`) and the descriptor check. |
| `read-data/read-connection-graph.ts` | Reads rows into the connection map, sorted, with an issue for each row that could not be read. |
| `do-work/map-who-is-connected.mjs` | `tool:map-who-is-connected`, from records in the input or a JSON file from the person's files. |
| `part.json` | The reader and the model are public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:map-who-is-connected`. |
| `test/read-connection-graph.test.ts` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `ConnectionProjectionDescriptor` | `{kind: 'generic-connection-projection-descriptor', id, record_selectors, views?, actions?}` | Which records are connections and how to read them. |
| `readConnectionGraph` | `(rows, descriptor, registry?) -> ConnectionGraphModel` | The map: `nodes`, `connections`, `issues`, `changed`. |
| `evaluateSelector` | `(expression, {row, payload}, registry?) -> unknown` | One selector expression against one row. |

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the `.ts` files by stripping their types).

**Depended on by:** `tool-rows.json`, Trillion's deploy (it bundles the files a row names), `test/read-connection-graph.test.ts`, Trillion's `test/crm-tools.test.mjs`.
