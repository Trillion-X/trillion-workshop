# Measurement ledger

Generic cost evidence storage and unit-aware aggregation through the person's existing account records door. There is no new database and no product-source import. The editable contract lives in `DATA.json`; `tool-rows.json` provides append, aggregate, versioned forecast and latest-refresh-state actions.

## Records and Lists

Records are immutable by event/version identity:

- `record:cost-measurement-observation`: `record:cost-measurement-observation:<encoded event_id>`.
- `record:cost-measurement-forecast`: `record:cost-measurement-forecast:<encoded forecast_id>:v<version>`.
- `record:cost-measurement-billing`: `record:cost-measurement-billing:<encoded billing_id>:v<version>`.

`DATA.json` contains full schema proposals for `list:cost-measurements`, `list:cost-forecasts`, and `list:cost-billing-reconciliation`. Create and read back these Lists through the account's existing records owner; source files do not establish that an account has installed them.

## Correctness

Observations require provider, operation, metric semantics, physical unit, currency, scenario, source revision, run, window and explicit measured/assumed/unknown scope. Unknown values are `null`. Missing retry and error counts carry explicit unknown status, and their aggregates report coverage instead of silently adding zero. Aggregation defaults group by all identity and billing dimensions; counters/money add, gauges select the latest `observed_at`, duration samples expose count/min/max/sum. An unknown-only aggregate remains unknown; mixed known/unknown or explicit partial coverage returns partial, never complete.

Corrections append a new event linked with `corrects_event_id`. The old record remains; aggregate reads omit it after a valid replacement, and reject missing targets, dimension changes, forks or cycles. `appendOnce` compares exact record values, treats exact replay as replay, rejects conflicting content under the same event ID, uses the records door's documented atomic `expected: null` write precondition, and reads back every write. Large appends are split to the row write cap using stable per-batch request keys.

Forecast versions may be incomplete and remain visible with `completeness: "incomplete"`; they cannot claim complete while any component is unknown. Billing is a separate record family and is never added to an alternative scenario.

## Historical import preparation

`read-data/import-audit.mjs` converts caller-supplied run, case, and privacy-safe usage evidence into granular observations. `do-work/prepare-import.mjs` reads a manifest and writes prepared JSON for the account route. With an optional append request key, it writes the exact `{action: "append", request_key, observations}` input consumed by this package's row. The row splits it within the write cap and byte limit, uses absent-ID preconditions, reads back each record, and treats exact replay as idempotent. The 2026-10-31 manifest imports 60 simulation runs, 40 provider/scenario sensitivity cells, six Codex worker usage streams, local inference attempts, current native/collector receipts, and local provider unit probes. It preserves separate counters, provider-reported tokens, measured local wall time, unknown retry/error coverage, and explicit unknown CPU or price. Traffic subtotals with unpriced components are partial; every alternative provider scenario remains isolated. No native/hosted values are inferred where source evidence is absent.

Keep historical provenance in the caller's private manifest and account records. Customer content, prompts, transcripts and secret values are prohibited in evidence fields.

`read-data/verify-import.mjs` reconciles every prepared observation with real account readback. It reports exact, missing and different records separately, including changed field names; a partial import cannot report completion. It makes no writes.
