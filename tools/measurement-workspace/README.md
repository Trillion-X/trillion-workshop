# Measurement workspace

This package composes the generic measurement ledger into an account's existing Lists and saved screen system. It does not add a product route or import into Trillion core.

## Account records

`DATA.json` selects the real ledger list IDs and saved views already declared by `tools/measurement-ledger/DATA.json`. `read-data/composition.mjs` merges canonical ledger fields into each account list and adds all current canonical fields to the `all` view, so schema additions flow into saved Lists without hand-copying the measurement schema:

- `list:cost-measurements` with `record:cost-measurement-observation` rows;
- `list:cost-forecasts` with versioned `record:cost-measurement-forecast` rows;
- `list:cost-billing-reconciliation` with `record:cost-measurement-billing` rows.

Saved views use the platform's existing record shape `list-view:<list-id>:<view-id>`: the view carries its columns, rule filter, sort, grouping and America/Denver time zone. `read-data/composition.mjs` builds those account values from editable DATA. Writes should use the existing `@own-records records:write` operation and read back each record.

## Saved screen

`screen.mjs` is the account-only `tool:measurement-workspace` screen. It imports React and shared `@trillion/ui` parts, reads only the three declared record types through named screen requests, pages with a 500-row bound, and states when a read is incomplete. The browser-safe `ledger.mjs` is supplied from the canonical `tools/measurement-ledger/read-data/aggregation.mjs` at save time, so the display uses the same correction and unit-aware aggregation function as the ledger owner. Its Pricing inputs view calls the existing `tool:manage-usage-pricing` action; it adds no pricing logic or account-specific route.

`do-work/prepare-account-records.mjs` composes the intended `list:` and `list-view:` records. `do-work/prepare-tool-save.mjs` builds the exact `save_tool` input (`descriptor` and `files`) from this package and the current ledger source and DATA. It does not save or publish the tool. `tool-rows.json` contains the saved tool descriptor; request bindings are refreshed from `DATA.json` when packaging. Keep account data out of the public module archive.

## Data rules

- Every summary uses the ledger arithmetic with provider, operation, metric semantics, unit, currency, scope, scenario, source revision, run and time-window dimensions. Counter deltas and money sums never mix with gauges, durations or samples.
- `unknown` stays null; the screen labels a partial group and never treats missing rows as zero. It shows freshness as unknown until a source declares an expected cadence.
- Forecasts remain separate from billing and observations. Every forecast version remains addressable; component arrays appear as their own operation/unit/currency/scope rows and in opened record detail.
- Retry and error coverage remains visible in the summary; counts stay within each metric/run group so repeated attempt metadata is not added across metrics.
- Provider and operation filters are live and searchable. Opening a row shows its full stored record.

## Checks

Run `node --test tools/measurement-workspace/test/*.test.mjs`. The tests check exact account IDs, supported field kinds, saved view column consistency, aggregation dimensions and unknown values. Live after-pixels require the screen to be saved in Trillion and the installed account UI route to be healthy; a package preview is not delivery.

21st.dev and Mobbin MCP tools were absent in the authoring session, so no external component was copied. The design reuses the current account Lists and shared Screen Look/UI runtime.
