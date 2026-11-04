# parts/funnel-offer-graph/

A funnel as DATA (a graph of offer stages with the outcomes that lead between them, optional price tests, and which field of the person's records names a stage and holds money), resolved into stages with live measures and drawn as a tornado on the shared canvas. Ported from bitfield-packages `packages/funnel-offer-graph` (its resolver, measure reduction, tornado layout, stage bar and stage drawer); the stage drill-in now uses the shared record views instead of visual-database, and the Bitfield feeds, create-funnel writes and in-place price edits were not brought in.

## Files

| File | Purpose |
|------|---------|
| `read-data/resolve-funnel-flow.ts` | `resolveFunnelFlow`, `readFunnelNode`, `resolveExperimentWinnerAmount`: graph + nodes + price tests into one flow in the order a buyer meets it. |
| `read-data/stage-projection.ts` | `funnelStages` (one funnel row and its facts into measured stages), `reduceStageMeasures` (a fact with a whole-number `count` counts that many visits, as counted visitors do), `layoutTornado`. |
| `show/FunnelCanvas.tsx` | The tornado: stage bars filled to their conversion, outcome edges, and the chosen stage's numbers and records beside it. |
| `part.json` | The public files. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| funnel row | `{ kind: 'funnel-graph', id, title, currency?, entry_node, nodes: [{ id, title?, offer: { name, amount_cents, recurring? }, transitions: [{ on, to }] }], experiments?, variants?, offer_experiments?, measures?: { stage_field, amount_field, facts?, facts_file? } }` | One funnel, kept as one JSON file. |
| `funnelStages` | `(row, facts) => Funnel \| null` | Stages with visits, conversions, rate, revenue and share of the step before. |
| `layoutTornado` | `(stages) => { frames, edges }` | Bars as wide as who entered, centred and narrowing. |
| `FunnelCanvas` | `({ funnel })` | Draws it. |

## Dependencies

**Depends on:** `parts/graph-canvas`, `parts/ui` (and its record views), `parts/workflow-canvas` (WorkflowEdge), React.

**Depended on by:** `src/workspace/funnels-screen.tsx` (the Funnels screens), `test/workflow-funnel-page-screens.test.mjs`.
