# tools/package-store-reviews/

Reviews of what a store lists, as generic records: a descriptor file says what a review, a rating, a report, a helpful vote and a developer reply are, and the code validates action input against it, builds the owner-action request and the generic record event, and folds a projection of reviews from the events. Moved here byte for byte from bitfield-packages `packages/package-store-reviews`, where Workshop held nothing of it. A prepared restore: the files are the originals and are not yet wired to a tool row.

## Files

| File | Purpose |
|------|---------|
| `moved-from.json` | The receipt, with the tests held and why. |
| `data/generic-record-contracts.json`, `consumer-reader-contracts.json`, `render-state-matrix.json` | The descriptors: every human word is data here, not code. |
| `read-data/descriptor-contracts.ts`, `fold-generic-record-events.ts`, `read-generic-record-projection.ts` | The descriptors indexed, the events folded into a projection. |
| `do-work/validate-action-input.ts`, `build-owner-action-request.ts`, `write-generic-record-event.ts` | Action input checked, the owner-action request and the event write built. |
| `__tests__/`, `tests/`, `show/`, `show-ios-jscore/` | The package's tests and fixtures (all six held: they read `packages/package-store-reviews/data/...` from the repository root, or need a DOM). |

## What is held

The tests read the descriptor files by the path `packages/package-store-reviews/data/...` from the root of the source repository; here the folder is `tools/package-store-reviews/data/`, so they cannot find them. The bytes are not changed.
