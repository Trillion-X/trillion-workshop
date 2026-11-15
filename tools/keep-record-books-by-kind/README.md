# Client health issue books

`read-data/client-health.mjs` ports the client-health owner from `Trillion-X/trillion`,
`src/client-health.mjs` at `b6ae0ebf815f2f5271eed34e6e023c7e1767ec04`
(`old-trillion-before-worker-retire`).

`clientHealthWork(issue, settings)` preserves the issue key's BLAKE3-derived id,
configured allowlists, interpolation, priority and stable once-per key. Settings
are trusted DATA read from the operator's lists and supplied by the runtime.

`reportClientHealthIssue(context, issue)` receives the runtime-selected operator
records door, those settings, and the existing `prepareProducedJob` public
function from `tools/hand-work-to-ais/read-data/ai-work.mjs`. It creates the issue
and the job in one conditional records-door write. Concurrent reports converge
on one handoff. A refusal changes neither record. Input never selects an account.
The canonical hash comes from `tools/content-identity`; the Rust records owner
owns durability, rights and atomic conditions.

`makeClientHealthIssue({ list, put, hand, settings })` retains the old book-local
adapter, including retry after a busy handoff, and now accepts async record calls.

Run `node --test test/client-health-records-door.test.mjs` to verify stable private
work, concurrent reports and refusal/retry behavior over the shared door fixture.

The broader `book-handlers.mjs` registry is still held. Its price-experiment,
service-watch, service-check and other handlers need their own current feature
owners before the registry can be moved without importing the retired engine.
This folder does not claim those missing handlers.

The `prepareProducedJob` host dependency is present in shared work but is absent from published Workshop main at `1083a00a`. The door tests use a synthetic binding to qualify atomicity and refusals; this does not qualify operator installation.

That publication observation is historical: the public projection at
`fba3eca9e7037b8c80761fe488e414db7733ec81` exports `prepareProducedJob` from
`tools/hand-work-to-ais/read-data/ai-work.mjs`. The operator still supplies that
function to this port. Its presence does not prove that an operator has installed
the client-health binding.

The folder's own `test/client-health.test.mjs` also checks that private facts do
not enter work, every declared grouping value is validated, asynchronous durable
writes are awaited, and unavailable reads or unresolved write conflicts never
report a successful handoff. These tests add to the records-door tests above.
