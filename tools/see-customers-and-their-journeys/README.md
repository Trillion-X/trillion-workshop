# Customers, reports and journeys

Source-first ports of old trillion's six HQ modules at `old-trillion-before-worker-retire` (`b6ae0ebf815f2f5271eed34e6e023c7e1767ec04`). `source-map.json` pins each original source. The public factories take configuration already read from authenticated list rows; the only JSON policy copies here are test fixtures.

The original admission, browser-capture, sketch, consent, grouping, input checks and managed-submission replay logic stay in their original source files. Source assertions are copied without changing their expectations; their map names the original tests.

Current owners replace retired Worker dependencies:

- Journey rows, their summaries, erasure and the sweep: `workflow:keep-customer-journeys-and-their-choices` (the person's own store). `read-data/journey.mjs` only decides which rows an event becomes and summarizes rows it is given; `do-work/journey-records.mjs` is removed.
- Report list definitions and row merges: the existing async `listsOverDoor` owner. `keepHandOffOverDoor` uses absence CAS for a first submission and preserves retry joins and later review/outcome fields.
- Telemetry privacy: `tools/gate-telemetry-by-privacy`.
- Exact and keyed byte hashes: `tools/content-identity`; hashes preserve the former hex values and submission IDs.
- HQ choices: `workflow:keep-customer-journeys-and-their-choices` keeps them in the person's store. `read-data/hq-sharing.mjs` only decides the value to keep and whether the account's rows must be erased; only the signed-in account can change its own choice.

These modules are reusable public implementations, not a newly installed cross-account route. Runtime callers must supply authenticated actor/recipient context, a genuinely operator-scoped telemetry door, the existing notification/files/AI-work owners, and the application's page renderer. Input cannot choose or mint those authorities. Cross-account native delivery and the old HTTP routes have not been verified in this slice, and no enabled tool row claims otherwise. `customersPage` accepts the shell's `htmlPage`; its pure section construction and operator checks remain intact.

`node --test tools/see-customers-and-their-journeys/test/*.test.mjs` proves the seven original source assertions, the values of choices and journey rows (`test/sharing-and-journeys.test.mjs`), the report retry behaviour (`test/records-door.test.mjs`) and the former-name counter. The store behaviours that the door tests used to cover (conditional writes, paging, erasure, required erasure retries, concurrent choice conflicts) are proven on three kinds of store in the recipe's proof, not here. They do not claim engine persistence or installed cross-account delivery proof.
