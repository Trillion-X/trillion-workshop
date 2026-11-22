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
| `do-work/make-a-tracked-link.mjs` | The link tool's command: `{ destination, project, source, campaign, medium?, content?, go_base? }`. With `go_base` it also answers `touch` and `short_link` (see the journey kit). |
| `do-work/journey.mjs` | The journey kit's functions for a client site's server: the visitor cookie, the source a page keeps, the `/go/` redirect, checkout fields, the booking and sale steps, the touch row and short link. Every name comes from `read-data/journey.json`. |
| `read-data/consent.json` | DATA: the site's consent cookie name, its granted and denied values, and the Google Tag Manager consent update each answer sends (`consentGrantedOf` reads it). |
| `read-data/journey.json` | DATA: the visitor cookie's settings, the kept URL parameters, the step kinds and what each means, how a step joins to a person, Stripe's limits for checkout fields, and the TidyCal redirect's names. |
| `read-data/journey-steps.sql` | The tables `journey_touches` and `journey_steps` and the views `journey_email_visitor`, `journey_resolved_steps`, `journey_first_touch` and `funnel_by_source`, for a pursuit's `_for_who_runs_it` database. Idempotent: it applies again without change. |
| `do-work/break-down-visits-and-sales.mjs` | The breakdown tool's command: `{ project, visits, conversions?, break_down_by? }`. |
| `do-work/measure-ad-return.mjs` | The ad return tool's command: `{ project, visits, conversions?, paying_outcome, signup_outcome?, break_down_by?, spend?, spend_answers?, revenue_months?, gross_margin?, monthly_churn?, customer_lifetime_months?, target_ltv_to_cac? }`. |
| `do-work/prepare-ad-conversions.mjs` | The conversion tool's command: `{ project, destinations?, visits, conversions, now? }` → `{ sends: [{ destination, tool_id, input, events }], skipped, said }`. |
| `records.json` | The four tool rows. The ad return row also carries the two `tools/unit-economics` files it imports, placed beside this folder at `/opt/parts/`, so that import resolves the same way inside the container and in this repository. The link row also carries `do-work/journey.mjs`, its two DATA files and `tools/content-identity` (the email key's identity), placed the same way. |
| `tool-rows.json` | The tool-row source that lists `records.json`'s rows into the Workshop. |
| `test/ad-return.test.mjs` | Runs each tool's command the way its row runs it. |
| `test/journey.test.mjs` | The journey kit: cookie, source, `/go/`, checkout limits, booking and sale joins, and the SQL run in PGlite twice. |
| `part.json` | No public files: only the tool runs this code. |

## Journey kit (a client site's server)

The kit follows one visitor from a tracked post, ad, email or bio to a booking, a checkout and a paid sale, and keeps each step in the pursuit's own database. It is one library every client site imports from `workshop/tools/traffic-attribution/do-work/journey.mjs`, pinned by commit in the site's `data/workshop.json`. Nothing in it names a client, a provider's account or a site.

How a client sets it up:

1. Apply `read-data/journey-steps.sql` to the pursuit's `_for_who_runs_it` database (run it through `tool:run-sql-in-my-database`; running it again is harmless).
2. Import `journey.mjs` in the site server. Each database call takes a `query(sql, params)` that resolves to `{ rows }`, so the server passes its own pg client.
3. Mount three routes:
   - `GET /go/:id`: `goRedirect(query, id, { cookieHeader, refererHeader })`. Answer with its `status` and `location`; when `setCookie` is set, send it as a `Set-Cookie` header. A 404 is an unknown touch.
   - `GET /booked`: read the TidyCal redirect's query, then `keepStep(query, bookedStep({ params, visitor }))`.
   - Every page request: set the visitor cookie with `visitorOf(cookieHeader)` (send `setCookie` when it is set, HttpOnly), and keep `visitStep({ url, refererHeader, visitor })` when it is not null.
4. Checkout: when a Checkout Session is created, spread `checkoutAttribution(visitor, source)` into it and keep a `checkout` step. Set `metadata.offer_id` to the offer sold. When a payment succeeds, `keepStep(query, saleStepOf(session))`; the session id keeps a repeated webhook to one sale.
5. TidyCal: set the post-booking redirect to `https://<site>/booked?email={contact.email}&starts={booking.starts_at}&type={booking_type.title}`. Add `&booking={booking.id}` when the template carries the provider's booking id.
6. Static pages need the beacon. A page that the server never runs (a file served straight from `public/`) keeps no visit on its own. Put `journey.json`'s beacon script in the page and route `POST beacon.path` to `visitBeacon(query, { cookieHeader, body, siteOrigin, refererHeader, consent })`, which answers 204 and sets the cookie when consent is given. A foreign origin or an oversized body keeps nothing.
7. Consent: `visitorOf`, `goRedirect` and `visitBeacon` give no visitor id and set no cookie unless consent is granted: by default, the site's consent cookie (`read-data/consent.json`, value `granted`) decides it, and a caller may pass `consent` to decide it instead. Without consent a step keeps only the touch id of the link it followed, and `journey_resolved_steps` joins it by `touch:<id>`.
8. A `/go/` route answers 503 with `retryAfter` when the database cannot be read, and 404 only for a touch that is not there. A failed click write never holds the visitor back.
9. Tracked links: `tool:make-tracked-link` with `go_base` (the site's address) answers `touch` and `short_link`. The tool keeps no row: write `touch` into `journey_touches` with `tool:run-sql-in-my-database`, and post `short_link`. A visitor who follows it lands on `touch.destination` with the UTM fields and `t=<touch id>`.

Invariants:

- The raw email is never written: a step keeps `emailKey(email)`, the identity of its lower-cased, trimmed bytes.
- A visitor's first touch is their earliest step with a source; a direct visit with no kept parameter is not a touch.
- A step with a ref is kept once; `keepStep` answers `{ kept: false }` for a repeat.
- A booking or sale with no visitor joins to the visitor who gave that email; with neither, it counts under the unknown source (null utm fields).
- Sale values are the session's `amount_total` in the currency's minor units; `funnel_by_source` sums them and does not convert currencies.

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
| `visitorOf` | `(cookieHeader, cookie?) => { visitor, setCookie \| null }` | The visitor's id, kept or minted. |
| `sourceOf` | `(url, refererHeader) => object` | The kept parameters, referrer host and landing path; `{}` when none. |
| `visitStep` | `({ url, refererHeader, visitor }) => step \| null` | A page's visit step, when it came with a source. |
| `goRedirect` | `(query, touchId, { visitor?, cookieHeader?, refererHeader? }) => Promise<{ status, location, setCookie }>` | The `/go/` route: a click step, then the 302 to the destination. |
| `keepStep` | `(query, step) => Promise<{ kept }>` | Writes one step; a repeated ref is a no-op. |
| `checkoutAttribution` | `(visitor, source) => { client_reference_id?, metadata? }` | Checkout Session fields within Stripe's limits. |
| `bookedStep` | `({ params, visitor }) => step \| null` | The booking step from the TidyCal redirect. |
| `saleStepOf` | `(session) => step` | The sale step from a Checkout Session. |
| `emailKey` | `(email) => "1f:<hex>" \| null` | The email's key. |
| `makeTouch` | `({ destination, source, post_id?, offer_id?, base }) => { row, short_link }` | A touch row and its `/go/` link. |


## Invariants

- A visitor counts once, by first touch; a conversion without an outcome counts toward the project's first outcome; revenue columns appear only when conversions carry a value.
- No source, campaign or outcome name is written in code; every breakdown the visits carry is offered in `can_break_down_by`, except an ad click id, which is one click per value.
- A figure the numbers cannot give (no spend, no paying customer, no gross margin, no churn or lifetime) is null and `unknown` says what would give it; spend in another currency than the project's is refused, never converted.
- Conversions go nowhere until a destination says `on: true`. A plain email or phone never leaves `prepareAdConversions`; each is made plain by the platform's own rule and hashed with SHA-256, as both platforms require. An event's id is the conversion's `event_id`, else `project:visitor:outcome`, so a retry is the same event and each platform counts it once.
- Nothing here creates, changes or turns on a campaign, or spends money.

## Dependencies

**Depends on:** `tools/unit-economics` (`computeUnitEconomics`), Node 24. The spend and conversion tools it names live on Trillion's Meta Ads and Google Ads connections (`tool:meta-ads-read-campaign-spend`, `tool:meta-ads-send-conversion-events`, `tool:google-ads-read-campaign-spend`, `tool:google-ads-read-keyword-spend`, `tool:google-ads-send-conversions`).

**Depended on by:** Trillion's tool runner, which reads `tool-rows.json`; Trillion's ad connection tests, which read `read-data/ad-conversions.json`, `read-data/ad-return.json` and `prepareAdConversions`.
