# tools/plan-trips/

Says what is still open on a trip, in the order to deal with it, and how far a checklist (a packing list, say) is done. The Workshop tools `tool:rank-open-trip-things` and `tool:measure-a-checklist`, run in the tool container. Ported from the `travel-operations` package (the ranking of open itinerary, packing and booking things, the lane counts) and the `packing-list` package (progress and items by category).

## Files

| File | Purpose |
|------|---------|
| `read-data/trip-things.mjs` | `rankOpenTripThings`: reads the person's policy, turns each lane's rows into ranked things, sorts them, picks the focus and counts each lane. |
| `read-data/checklist.mjs` | `measureAChecklist`: done count, counted total, share done, and the items grouped. |
| `read-data/run-as-main.mjs` | How a command runs: one JSON request on standard input, one JSON line out. |
| `do-work/rank-open-trip-things.mjs` | The command of `tool:rank-open-trip-things`. |
| `do-work/measure-a-checklist.mjs` | The command of `tool:measure-a-checklist`. |
| `tool-rows.json` | The two tool rows. |
| `part.json` | No module here is offered to other tools. |
| `test/trip-things.test.mjs` | The ranking, lane counts, sort fields, detail words, skipped rows, refusals, and the checklist count and grouping, on `node:test` with a made-up trip. |
| `test/plan-trips-commands.test.mjs` | Both commands over standard input. |
| `test/plan-trips-rows.test.mjs` | Each row run from a folder holding only the files it packs, against its sample. |

## Key Types / Functions

| Function | Signature | Role |
|---|---|---|
| `rankOpenTripThings` | `({ policy, lanes, trip_name? }) => { trip_name, items, focus, later, lanes, skipped }` | Every row with a priority from the policy, most urgent first; the first open one is the focus. |
| `readPolicy` | `(policy) => { order, closed, lanes }` | Checks the policy: priority names in order (the last means closed), and for each lane a default priority, a priority per status and the fields to sort by. |
| `measureAChecklist` | `({ items, done_statuses, skipped_statuses }) => { done, total, ratio, groups }` | Share done among counted items, and every item under its group. |

## Invariants

- The tool knows no status, no lane and no urgency. Which statuses are urgent, which close a thing and how a lane orders its rows are the person's policy, given with each request; a lane the policy does not cover is refused, not guessed.
- Things of the same priority come lane by lane in the order the lanes were given, then by the lane's own `sort_by` fields (numbers as numbers, a missing value after every present one), then by id. The package this came from compared one joined text key across lanes, which interleaved lanes by accident of how each built its key; that is not carried.
- A tool keeps nothing between runs and writes nothing. The rows arrive in the request (read from the person's lists through the records door by the caller).
- A row with no id is left out and named under `skipped`.

## Dependencies

**Depends on:** Node 24 in the tool container (`node:stream/consumers`).

**Not carried:** the old operation records, action definitions, "mark packed" and "confirm" transitions, the create-a-thing actions, travel notes and candidate-fact evidence state, and the privacy classes (engine plumbing of the previous runtime, which writes through the records door now); the English reason sentences and the lane names (the person's words); the panel (a screen).

**Depended on by:** Trillion, which reads `tool-rows.json` when it deploys.
