# Customers, reports and journeys

Source-first ports of old trillion's six HQ modules at `old-trillion-before-worker-retire` (`b6ae0ebf815f2f5271eed34e6e023c7e1767ec04`). `source-map.json` pins each original source. The public factories take configuration already read from authenticated list rows; the only JSON policy copies here are test fixtures.

The original admission, browser-capture, sketch, consent, grouping, input checks and managed-submission replay logic stay in their original source files. Source assertions are copied without changing their expectations; their map names the original tests.

Current owners replace retired Worker dependencies:

- Records and their conditional writes: `tools/records-door` and the Rust generic records job. `do-work/journey-records.mjs` stores individual journey rows, reads paged summaries, erases an account and sweeps retained rows through that door.
- Report list definitions and row merges: the existing async `listsOverDoor` owner. `keepHandOffOverDoor` uses absence CAS for a first submission and preserves retry joins and later review/outcome fields.
- Telemetry privacy: `tools/gate-telemetry-by-privacy`.
- Exact and keyed byte hashes: `tools/content-identity`; hashes preserve the former hex values and submission IDs.
- HQ choices: a live scoped records door with conditional writes. Only the trusted signed-in account can change its choice. Turning activity off first records the off choice, then awaits required erasure; an erasure failure is surfaced and a retry can finish it. Live reads replace the old isolate cache.

These modules are reusable public implementations, not a newly installed cross-account route. Runtime callers must supply authenticated actor/recipient context, a genuinely operator-scoped telemetry door, the existing notification/files/AI-work owners, and the application's page renderer. Input cannot choose or mint those authorities. Cross-account native delivery and the old HTTP routes have not been verified in this slice, and no enabled tool row claims otherwise. `customersPage` accepts the shell's `htmlPage`; its pure section construction and operator checks remain intact.

`node --test tools/see-customers-and-their-journeys/test/*.test.mjs` proves seven original source assertions and nine records-door behaviors. The door tests exercise paging, conditional first writes, erasure, report retry recovery, conflict refusal and preservation of later review/outcome values. Required erasure refuses a missing log, retries finish failed erasure, and unavailable customer data remains a failure. Live consent reads stay isolated to their current door, and concurrent writes preserve the winning choice. They do not claim engine persistence or installed cross-account delivery proof.
