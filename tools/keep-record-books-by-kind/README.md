# Client health issue books

`read-data/client-health.mjs` ports the client-health owner from `Trillion-X/trillion`,
`src/client-health.mjs` at `b6ae0ebf815f2f5271eed34e6e023c7e1767ec04`
(`old-trillion-before-worker-retire`).

`clientHealthWork(issue, settings)` preserves the issue key's BLAKE3-derived id,
configured allowlists, interpolation, priority and stable once-per key. Settings
are trusted DATA read from the operator's lists and supplied by the runtime.

`reportClientHealthIssue(context, issue)` takes the issue's record as it is kept
(`context.stored.records`, read by the caller), those settings, and the existing
`prepareProducedTask` public function from `tools/plan-tasks-and-todo-lists/task-moves.mjs`.
It answers `{ handoff_id, key, keep }`: the issue and its job to keep, each issue
record with the value it expected. The caller keeps `keep` in one conditional write
under `key`, so a refusal changes neither record and concurrent reports converge on
one handoff. A kept handoff answers `keep: []`. Input never selects an account.
The canonical hash comes from `tools/content-identity`; the caller's store owns
durability, rights and atomic conditions.

`makeClientHealthIssue({ list, put, hand, settings })` retains the old book-local
adapter, including retry after a busy handoff, and now accepts async record calls.

Run `node --test test/client-health.test.mjs` to verify stable private work, the
kept-issue and missing-record refusals, and the retry behavior of the book adapter.

The broader `book-handlers.mjs` registry is still held. Its price-experiment,
service-watch, service-check and other handlers need their own current feature
owners before the registry can be moved without importing the retired engine.
This folder does not claim those missing handlers.

The `prepareProducedTask` host dependency is present in shared work but is absent from published Workshop main at `1083a00a`. The tests use a synthetic binding to qualify the answer and the refusals; this does not qualify operator installation.

That publication observation is historical: the public projection at
`fba3eca9e7037b8c80761fe488e414db7733ec81` exports `prepareProducedJob` from
`tools/hand-work-to-ais/read-data/ai-work.mjs`. The operator still supplies that
function to this port. Its presence does not prove that an operator has installed
the client-health binding.

The folder's own `test/client-health.test.mjs` also checks that private facts do
not enter work, every declared grouping value is validated, asynchronous durable
writes are awaited, and an issue without its record list is refused rather than
treated as unkept.
