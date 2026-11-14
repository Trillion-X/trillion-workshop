# tools/funnels-screen/from-bitfield-packages/

The receipt (`moved-from.json`) of the package `packages/funnel-offer-graph` moved here from bitfield-packages byte for byte, into `../funnel-offer-graph/` with the package's own layout. Only import paths differ.

## Files

| File | Purpose |
|------|---------|
| `moved-from.json` | Each moved file's source path and commit and the identity of its bytes there and here. |
| `../funnel-offer-graph/read-data/funnel-definition.ts`, `funnel-composition.ts`, `stage-detail-visual-database.ts` | The stage_address contract with its types, the live-variant fold, the stage drill-in row actions (`stageRowActionSpecs`, `buildStageActionRequest`), the in-screen variant edit (`buildVariantUpsertWrite`) and the stage drill-in table projection. |
| `../funnel-offer-graph/read-data/resolve-funnel-flow.ts`, `stage-projection.ts` | The package's complete resolver (with `advanceFunnel`, `funnelStepAtCursor`, `resolveCtaLinks`) and layout (`layoutStages`, tornado, measures). `../read-data/` holds the shorter copies the live Funnels screen imports; they leave when that screen reads these. |
| `../funnel-offer-graph/do-work/create-funnel.ts` | Drafting a funnel and the write that keeps it (`buildFunnelDefinitionWrite`). |
| `../funnel-offer-graph/show/mount-funnel-canvas.tsx` | The package's Funnels surface: tornado canvas, stage drawer over a visual-database table with row actions, A/B variant strip and in-screen variant edit. Held: it reads through `useBitfieldData` and `sendRequestToBitfieldTarget` (the retired package runtime) and imports `graph-canvas`, `screen-arrangement` (in trillion-apps `web/parts/`) and `visual-database` (in no tree here). |
| `../funnel-offer-graph/**/*.test.ts(x)` | The package's vitest specs, moved with the code. |

## Dependencies

**Depends on:** `tools/ui`, and the held imports named above.
