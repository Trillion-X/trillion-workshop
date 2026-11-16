# Keep measurements current

Collect generic operation catalogs, source revisions, execution receipts, meter DATA and qualified supplier prices. Preserve history through the measurement ledger and existing records door. This package imports no product engine and adds no feature to an engine.

## Unattended collection


`tool:refresh-measurement-history` takes the configuration (`config`) and the forecast rows the caller read from its store (`forecasts`), collects current evidence, and returns checked observation and forecast rows with this refresh's own OS CPU, wall and peak RSS; it reads and keeps nothing and has no wakes, because a result nothing writes would be lost. A new process is new physical work. Monetary monitoring cost remains unknown.

The `measurement_source_config` value (record `measurement-source-config:default`) supplies bounded source roots, receipt roots and the meter/price books. The native runtime supplies the granted read folder through task DATA. Configured paths do not grant access: every source, receipt and external book must resolve within that grant. Packaged books are also allowed. Missing sources produce incomplete coverage.


`tool:keep-measurements-current` exposes the collector separately: it takes the configuration (`config`), prices and prior refresh state in the request and returns observations, forecast and coverage; it reads and keeps nothing. `tool:refresh-provider-prices` projects packaged supplier price DATA; it does not fetch new tariffs. Conditional regions, tiers, plans and allowances remain excluded from scalar pricing. Public list prices do not prove an account's plan or invoice.

## Evidence rules

The one coverage evaluator is `read-data/coverage.mjs`. DATA adapters in `catalog-adapters.json` and `receipt-adapters.json` describe input formats. Compatible new operations require no feature parser branch. Receipt contents and all source/meter/price revisions are pinned through the existing BLAKE3 owner.

An old receipt keeps its producer revision. Scanning current source never relabels old work. A source mismatch cannot price the new source. Unknown values, failed useful work, missing meters, missing prices, incomplete discovery and ambiguous currencies remain visible. Scalar money totals require exactly one known currency.

A catalog scan is not proof that every producer emits telemetry. Missing native, model, provider, billing or capacity evidence must remain incomplete. Local probes and emulators do not establish hosted capacity or an invoice.

## Checks and delivery

Focused tests cover source drift, new operations, changed or dropped receipts, replay, corrections, independent physical runs, units, currencies, partial failures, task grants and the actual shared records-door child consumer. They do not prove an installed scheduler, app screen or provider invoice. Verify those separately through the live account.
