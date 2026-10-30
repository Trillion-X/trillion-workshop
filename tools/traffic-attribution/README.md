# tools/traffic-attribution/

Traffic measurement under a funnel: tracked links with UTM fields, visitors, leads and sales broken down by where they came from, what ad spend brings back, and conversions sent back to the ad platforms. Four Workshop tools run in the deployed tool container: `tool:make-tracked-link`, `tool:break-down-visits-and-sales`, `tool:measure-ad-return` (spend joined to first-touch sign-ups, customers and revenue: cost per sign-up, CAC, LTV, LTV:CAC and payback months against a 5x target) and `tool:prepare-ad-conversions` (sign-ups and payments as Meta Conversions API and Google Ads Data Manager events, sent by those connections' own tools in Trillion's service connections; off until a destination is turned on). Ported from bitfield-packages `packages/traffic-attribution` (its link builder, fact folding and projection; the beacons, board screens and ingest process were not brought in).

## Files

| File | Purpose |
|------|---------|
| `read-data/tracked-link.mjs` | `buildTrackedLink`: sets `bf_project`, `utm_source`, `utm_campaign` and optional `utm_medium`, `utm_content`; refuses a non-web address or one with account details. |
| `read-data/traffic-address.ts` | The one place a `traffic::` address is built, and `isValidProjectId`. |
| `read-data/registry.ts` | Tracked-project rows: `readTrackedProject(s)`, `buildTrackedProjectRecord` (outcomes, dimensions, currency). |
| `read-data/browser-traffic-visit.ts` | A browser visit's signals (its size limits are what `observe-traffic.ts` checks against), with the ad click ids the page keeps in cookies (`getCookie`). |
| `read-data/click-ids.ts` | `isClickIdSignal`, `clickIdsOf`, `clickIdsToAdd`: which signals are ad click ids, read from cookies or made from another click id (fbc from fbclid). |
| `read-data/ad-return.json` | DATA: the LTV:CAC target (5), the click id signals, the cookie and derived click ids, and the spend shapes that turn a Meta Ads or Google Ads spend answer into spend rows. |
| `read-data/ad-conversions.json` | DATA: each ad platform's conversion upload: its connection tool, account fields, batch limit, oldest event, email and phone plain-form steps, the facts one of which must match, and the event template. |
| `read-data/aggregate-by-dimension.ts` | `aggregateByDimension`: addressed facts grouped by one entity dimension with metrics (`countEntities`, `countEntitiesWhere`, `sumOverEntities`, `ratio`). |
| `read-data/traffic-attribution.ts` | `projectTrafficAttribution`: grouped rows plus field, view and action descriptors, and `formatAttributionValue`. |
| `read-data/traffic-signals-rollup.ts` | One row per visitor (first-touch signals, outcomes, value): `readTrafficSignalsAggregate`, `buildTrafficSignalUpsert`, `rowsToFacts`. |
| `read-data/map-fact-fields.ts` | `mapFactFields`: a fact's fields renamed for an outside venue. |
| `do-work/observe-traffic.ts` | Visit and conversion facts and `groupObserverFactsByProject`, which folds them into one row per first-touch visitor with outcomes and value. |
| `do-work/derive-projection.ts` | `deriveProjection`, `configForProject`, `availableDimensionIds`, `aggregateHasRevenue`: the breakdown's columns (visitors, one count and rate per outcome, revenue when value flows). |
| `do-work/make-a-tracked-link.mjs` | The link tool's command: `{ destination, project, source, campaign, medium?, content? }`. |
| `do-work/break-down-visits-and-sales.mjs` | The breakdown tool's command: `{ project, visits, conversions?, break_down_by? }`. |
| `do-work/measure-ad-return.mjs` | The ad return tool's command: `{ project, visits, conversions?, paying_outcome, signup_outcome?, break_down_by?, spend?, spend_answers?, revenue_months?, gross_margin?, monthly_churn?, customer_lifetime_months?, target_ltv_to_cac? }`. |
| `do-work/prepare-ad-conversions.mjs` | The conversion tool's command: `{ project, destinations?, visits, conversions, now? }` → `{ sends: [{ destination, tool_id, input, events }], skipped, said }`. |
| `records.json` | The four tool rows. The ad return row also carries the two `tools/unit-economics` files it imports, placed beside this folder at `/opt/parts/`, so that import resolves the same way inside the container and in this repository. |
| `tool-rows.json` | The tool-row source that lists `records.json`'s rows into the Workshop. |
| `test/ad-return.test.mjs` | Runs each tool's command the way its row runs it. |
| `part.json` | No public files: only the tool runs this code. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `buildTrackedLink` | `({ destination, projectId, source, campaign, medium?, content? }) => string` | The link. |
| `aggregateByDimension` | `(facts: AddressedFact[], { dimension, metrics, dimensionId? }) => { dimensionId, groups, totalEntities }` | The grouping. |
| `projectTrafficAttribution` | `(facts, TrafficAttributionConfig) => TrafficAttributionProjection` | Rows and descriptors. |
| `groupObserverFactsByProject` | `(visitFacts, conversionFacts) => { [projectId]: { kind: 'traffic-signals', rows } }` | One row per first-touch visitor. |
| `deriveProjection` | `(project, aggregate, dimensionId?) => TrafficAttributionProjection` | Rows per dimension value with raw numbers and display text. |
| `measureAdReturn` | `(input) => { rows, paid, total, spend_from, spend_not_matched, unknown, ... }` | One row per value of `break_down_by` (spend with no visitors included, untagged visitors as `(not tagged)`), `paid` over the values that carry spend, `total` blended over everyone; CAC, LTV, LTV:CAC and payback come from `computeUnitEconomics`. |
| `prepareAdConversions` | `(input) => { sends, skipped, said }` | Each turned-on destination's events, hashed by the platform's rule and batched to its limit. |
| `makeATrackedLink`, `breakDownVisitsAndSales` | the tools' work | Exported for tests. |

## Invariants

- A visitor counts once, by first touch; a conversion without an outcome counts toward the project's first outcome; revenue columns appear only when conversions carry a value.
- No source, campaign or outcome name is written in code; every breakdown the visits carry is offered in `can_break_down_by`, except an ad click id, which is one click per value.
- A figure the numbers cannot give (no spend, no paying customer, no gross margin, no churn or lifetime) is null and `unknown` says what would give it; spend in another currency than the project's is refused, never converted.
- Conversions go nowhere until a destination says `on: true`. A plain email or phone never leaves `prepareAdConversions`; each is made plain by the platform's own rule and hashed with SHA-256, as both platforms require. An event's id is the conversion's `event_id`, else `project:visitor:outcome`, so a retry is the same event and each platform counts it once.
- Nothing here creates, changes or turns on a campaign, or spends money.

## Dependencies

**Depends on:** `tools/unit-economics` (`computeUnitEconomics`), Node 24. The spend and conversion tools it names live on Trillion's Meta Ads and Google Ads connections (`tool:meta-ads-read-campaign-spend`, `tool:meta-ads-send-conversion-events`, `tool:google-ads-read-campaign-spend`, `tool:google-ads-read-keyword-spend`, `tool:google-ads-send-conversions`).

**Depended on by:** Trillion's tool runner, which reads `tool-rows.json`; Trillion's ad connection tests, which read `read-data/ad-conversions.json`, `read-data/ad-return.json` and `prepareAdConversions`.
