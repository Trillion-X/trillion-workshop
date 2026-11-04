# tools/gate-telemetry-by-privacy/

The one gate a telemetry sink reads before it sends or keeps anything about a page or an event. The decision comes from the privacy class of what was served, never from the sink: the longest matching route on the surface names the class, a class the handler declared can only make it more private, and a surface and path no route names (or a declared class that is not a row) is `unknown`, which feeds no sink. Every class, sink and route is a row of `read-data/telemetry-privacy.json`. The row runs in the tool container with no records door.

## Files

| File | Purpose |
|------|---------|
| `read-data/telemetry-gate.mjs` | `classOf`, `sends`, `pageSends` and `TELEMETRY_PRIVACY`. Moved byte for byte from Trillion-X/trillion `src/telemetry-gate.mjs`. |
| `read-data/telemetry-privacy.json` | The classes (ranked `public` to `unknown`) and the sinks each may feed, the four sinks, the routes per surface and the header a handler declares a class with. Moved byte for byte. |
| `read-data/gate-tools.mjs` | The row's function `gateTelemetryRow`: `{ surface, path, declared?, sink? }` in, `{ class, sinks, sink?, may_send? }` out; a sink that is not a row is refused. |
| `tool-rows.json` | `tool:gate-telemetry-by-privacy`, a container row run by `tools/records-door`'s `run-an-export.mjs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/telemetry-privacy-gate.test.mjs` | Trillion's test of the gate with its assertions unchanged, and the row run as the container runs it. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `classOf` | `({ surface, path, declared? }) => classId` | Longest whole-path-part route prefix; the more private (higher rank) of route and declared class wins; fails closed to `unknown_class`. |
| `sends` | `(classId, sink) => boolean` | Whether a class may feed a sink. |
| `pageSends` | `({ surface, path, headers }, sink) => boolean` | The same for a served response, its declared class read from the `header` row. |
| `gateTelemetryRow` | `({ surface, path, declared?, sink? }) => { class, sinks, sink?, may_send? }` | The row's function. |

## Moved from Trillion

Trillion-X/trillion `src/telemetry-gate.mjs` and `src/telemetry-privacy.json`, with `test/telemetry-privacy-gate.test.mjs`'s first test. Its other three tests run `src/interactions.mjs` (`admitPageBatch`, `serverEvent`, `noteInteractions`) and `src/interaction-routes.mjs` (`withInteractionScript`), the sinks that stay in trillion until they move; the old copy stays there until then. `test/egress-and-telemetry.test.mjs` does not test the gate on its own, so nothing of it moved.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library.

**Depended on by:** `tool-rows.json`. In Trillion-X/trillion, `src/interaction-routes.mjs` and `src/interactions.mjs` still import their own copy.
