# Measurement ledger

Generic cost evidence checks and unit-aware aggregation. The tool reads and keeps nothing: the caller passes observations, forecasts and billing evidence in the request (read from its store) and the answer holds the checked rows or the totals; the caller writes returned rows through its store's own tools. It opens no database and imports no product source: the person's AI reads rows from its own Postgres and inserts the returned rows there with plain SQL (`tool:run-sql-in-my-database`). The editable contract lives in `DATA.json`; The row runs `do-work/ledger-tool.mjs` `run` on the command every function tool uses (`tools/workflows/do-work/run-a-function.mjs`: the request on standard input, `{ result }` or `{ error }` as the last line of output). `what-this-tool-does-and-how-to-run-it.json` provides `check_observations`, `aggregate`, `check_forecast`, `check_billing` and `latest_refresh_state`.

## Records and Lists

Rows are immutable by event/version identity:

- `record:cost-measurement-observation`: `record:cost-measurement-observation:<encoded event_id>`.
- `record:cost-measurement-forecast`: `record:cost-measurement-forecast:<encoded forecast_id>:v<version>`.
- `record:cost-measurement-billing`: `record:cost-measurement-billing:<encoded billing_id>:v<version>`.

`DATA.json` contains full schema proposals for `list:cost-measurements`, `list:cost-forecasts`, and `list:cost-billing-reconciliation`. Source files do not establish that an account has installed them.

## Correctness

Observations require provider, operation, metric semantics, physical unit, currency, scenario, source revision, run, window and explicit measured/assumed/unknown scope. Unknown values are `null`. Missing retry and error counts carry explicit unknown status, and their aggregates report coverage instead of silently adding zero. Aggregation defaults group by all identity and billing dimensions; counters/money add, gauges select the latest `observed_at`, duration samples expose count/min/max/sum. An unknown-only aggregate remains unknown; mixed known/unknown or explicit partial coverage returns partial, never complete.

Corrections append a new event linked with `corrects_event_id`. The old record remains; aggregate reads omit it after a valid replacement, and reject missing targets, dimension changes, forks or cycles. `check_observations` returns each observation as a row with its stable id, and rejects duplicate event IDs in one batch; the caller decides how to write them.

Forecast versions may be incomplete and remain visible with `completeness: "incomplete"`; they cannot claim complete while any component is unknown. Billing is a separate record family and is never added to an alternative scenario.

## Historical import preparation

`read-data/import-audit.mjs` converts caller-supplied run, case, and privacy-safe usage evidence into granular observations. `do-work/prepare-import.mjs` reads a manifest and writes prepared JSON for the account route. With the optional argument `check`, it writes the exact `{action: "check_observations", observations}` input consumed by this package's row. The 2026-10-31 manifest imports 60 simulation runs, 40 provider/scenario sensitivity cells, six Codex worker usage streams, local inference attempts, current native/collector receipts, and local provider unit probes. It preserves separate counters, provider-reported tokens, measured local wall time, unknown retry/error coverage, and explicit unknown CPU or price. Traffic subtotals with unpriced components are partial; every alternative provider scenario remains isolated. No native/hosted values are inferred where source evidence is absent.

Keep historical provenance in the caller's private manifest. Customer content, prompts, transcripts and secret values are prohibited in evidence fields.

`read-data/verify-import.mjs` reconciles every prepared observation with the rows the caller passes as `records` (read from its store). It reports exact, missing and different records separately, including changed field names; a partial import cannot report completion. It reads and keeps nothing.
