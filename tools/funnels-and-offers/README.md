# tools/funnels-and-offers/

A person's sales funnels, read from their own records: the offers in order, the price a buyer is shown and where each outcome (bought, declined, anything they name) takes the buyer next; a funnel written as stages that point at workflow steps, offers, price options and measures; how many visitors reached and converted at each stage; and a new funnel drafted from a title and step names. Four Workshop tools run in the deployed tool container: `tool:walk-a-funnel`, `tool:read-a-funnel-definition`, `tool:measure-funnel-stages` and `tool:draft-a-funnel`. Ported from bitfield-packages `packages/funnel-offer-graph` (its resolver, its stage_address contract, its stage counting and its authoring builders); its canvas, tornado layout and drill-in drawer were not brought in (see Not brought in). Nothing here moves money or changes a price: a price shown is read.

## Files

| File | Purpose |
|------|---------|
| `read-data/funnel-flow.mjs` | `resolveFunnelFlow` (entry at its decided price, every step, breadth-first order, cycle-safe), `advanceFunnel`, `funnelStepAtCursor`, `resolveExperimentWinnerAmount`, `readFunnelNode`, `resolveCtaLinks`. |
| `read-data/funnel-definition.mjs` | The stage_address contract: `readFunnelDefinition`, `resolveFunnelDefinition` (the blind `$ref` join), `liveVariantMapFromDecisions`, and the drafting builders `buildNewFunnelDefinition`, `appendStage`, `slugify`. |
| `read-data/stage-measures.mjs` | `reduceStageMeasures`: per-stage visits, conversions, rate and revenue from facts, for any group-by field and amount field. |
| `read-data/read-offers.ts` | `readCheckoutOffers`, `discoveredPriceCents`: the one reader of a person's `commercial-offer` rows (price options, trials, per-unit prices and curves, charge dimensions, a buyer-chosen amount and the price-discovery rule that moves its floor). `tools/take-payments` prices, checks and sells from what it reads; any page that shows a price reads offers here. Its cases run in `tools/take-payments/test` (`read-offers-voluntary-policy`, `price-discovery`). |
| `do-work/walk-a-funnel.mjs` | The command of `tool:walk-a-funnel`. |
| `do-work/read-a-funnel-definition.mjs` | The command of `tool:read-a-funnel-definition`. |
| `do-work/measure-funnel-stages.mjs` | The command of `tool:measure-funnel-stages`. |
| `do-work/draft-a-funnel.mjs` | The command of `tool:draft-a-funnel`. |
| `records.json` | The four tool rows. |
| `tool-rows.json` | Lists `records.json`'s rows into the Workshop (`source:funnel-and-offer-tools`). |
| `part.json` | No public files: only the tools run this code. |
| `test/funnel-flow.test.mjs` | The package's resolver cases on a made-up bakery ladder. |
| `test/funnel-definition.test.mjs` | The contract, the join, the deletion test (a hiring pipeline) and the named-price-option rule. |
| `test/stage-measures.test.mjs` | The reducer. |
| `test/draft-a-funnel.test.mjs` | The builders and the command. |
| `test/emergent-funnels.test.mjs` | Forty funnels from forty domains resolve as data with no change to the resolver. |
| `test/funnels-and-offers-tools.test.mjs` | Each tool run the way its row runs it, the verify samples, refusals listing every problem. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| funnel-node | `{ id, entry?, offer: { amount_cents, name, recurring? }, transitions: [{ on, to }], route_path?, offer_ref? }` | One offer and the outcomes that move a buyer on. Outcomes are open strings. |
| `resolveFunnelFlow` | `(graphs, nodes, experiments?, variants?, offerExperiments?, graphId?) => flow \| null` | The flow; the entry shows the winning version of a settled experiment when one applies, else its own price. |
| `advanceFunnel` | `(flow, nodeId, outcome) => { next, target, terminal }` | A target that is not a node ends the flow. |
| funnel-definition | `{ kind, id, title?, stages: [{ stage_address, workflow_node_ref?, outcome_edges?, variant_surface_ref?, offer_price_ref?, price_option_ref?, metric_selectors?, title? }] }` | A funnel as stages that point at records kept elsewhere. |
| `resolveFunnelDefinition` | `(definitions, owners, funnelId?) => { id, title, stages } \| null` | Joins each stage to its records by `$ref` identity. |
| `reduceStageMeasures` | `(facts, stageIds, groupBy, amountField) => { [stage]: { visits, conversions, conversion_rate, revenue_cents } }` | Counts. |

## Invariants

- No offer, price, outcome, stage or funnel type is built in; all come from the person's records. A hiring pipeline resolves through the same code as a bakery's offers.
- A stage with several price options shows the option it names; with none named it shows no price. A position in a list is never a price.
- A winner of a price experiment decides a price only through a variant record that carries `amount_cents`. The package also read a bare winner key such as "47" as dollars; that guess is not carried.
- Only a settled (graduated, settled, concluded) experiment can decide a live price.
- Growing a funnel keeps every field of the person's record, including ones this tool does not read.
- The decided version of a surface comes from decisions handed in (what `tools/run-experiments` gives back); this folder decides nothing.

## Not brought in

- The funnel canvas, the narrowing tornado layout and stage layout (`layoutStages`, `layoutTornado`), the stage drill-in drawer and its visual-database bridge, and the row-action and variant-edit write builders aimed at the old engine's write batch: these draw a surface or write through the old engine, and stay with the screens. The stage's `detail_projection_ref` and `row_actions` fields are part of that and are not read.
- Choosing which version a visitor sees, counting results by version, and joining outcomes to what a visitor saw are `tools/run-experiments`. Visits and sales by where they came from are `tools/traffic-attribution`. This tool is the structure of a funnel and its per-stage counts; neither of those covers it.

## Dependencies

**Depends on:** Node in the tool container.

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names).
