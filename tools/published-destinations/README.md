# tools/published-destinations/

Reads the destination screens an owner has published (a progress page, a results page: a statement, sections of items, stats and bars) and checks that one is honest to publish. It works nothing out: no totals, ranks or scores are made here, so what comes back is what the owner published, or nothing. Ported from bitfield-packages `destination-surface`: its pure reader and its honest-state rule. Its screens, the open section registry and the one-time repair that wrote and retracted rows in the old runtime were not brought in. The Workshop tools that run it in the tool container are rows in `tool-rows.json`.

## Files

| File | Purpose |
|------|---------|
| `read-data/read-destination.mjs` | Bounded decoders, the subject-scoped finder and the list of items to celebrate. |
| `read-data/check-honest-state.mjs` | Every reason a descriptor is not honest to publish. |
| `do-work/find-a-destination.mjs` | `tool:find-a-destination`. |
| `do-work/check-a-destination-is-honest.mjs` | `tool:check-a-destination-is-honest`. |
| `part.json` | The two read-data files are public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder. |
| `test/published-destinations.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `decodeDestinationDescriptor` | `(raw) -> descriptor or null` | Reads a descriptor within bounds (64 sections, 200 items, 24 stats, 96 bars); a section's `presentation` is an open key. |
| `findDestinationDescriptor` | `(rows, ref, subjectRef?) -> descriptor or null` | A descriptor for one subject is found only for that subject. |
| `finishedCelebratingRefs` | `(descriptor) -> refs` | Items the owner flagged whose own percent is 100 or more. |
| `honestStateProblems` | `(descriptor, {refuseKeys}) -> problems` | Values the owner has to work out must start empty; keys the person refuses are found anywhere. No key is refused by default. |

## Dependencies

**Depends on:** nothing (Node 24 in the tool container).

**Depended on by:** `tool-rows.json`, Trillion's deploy (it bundles the files a row names), `test/published-destinations.test.mjs`.
