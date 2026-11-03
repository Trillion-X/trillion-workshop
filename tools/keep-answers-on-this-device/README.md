# tools/keep-answers-on-this-device/

Keeps the last answer to a question on this device so a screen paints what it last knew the moment it opens, then brings it up to date. `parts/ui/show/request/kept-values.ts` keeps each value as one string under one key in IndexedDB, sealed with AES-GCM under the caller's key when one is given. An open never waits for ever: a store held by another tab that will not let go (a stuck tab, an upgrade it blocks) gives up after `open_timeout_ms`, reads as nothing kept and records why (`keptValuesProblems`). Every value carries its row layout (`schema`) and role; another layout reads as nothing kept. Nothing kept lasts for ever: idle and old values, then the least recently used past `entries_most`, are swept, and an unsynced value (the only copy) is never swept. `src/workspace/memory-budget.ts` holds the copy kept in memory to a budget: the least recently used entries the caller says may go are let go first.

Moved here byte for byte from Trillion-X/trillion; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. The folder keeps the source tree's own paths under it.

## Files

| File | Purpose |
|------|---------|
| `parts/ui/show/request/kept-values.ts` | `createKeptValues(name, { key? })`, `forgetKeptValues`, `keptValuesProblems`. |
| `parts/ui/show/request/kept-values.json` | Open timeout, eviction ages, the entry cap, the touch and sweep timing, the row layout number. |
| `src/workspace/memory-budget.ts` | `touch(map, key)` and `trimToBudget(map, sizeOf, evictable, budget)`. |
| `part.json` | The tree that imports these files. |
| `test/kept-values-eviction.test.mjs` | Old trillion's sweep, touch and row-layout tests with their assertions unchanged, against a fake IndexedDB. |
| `test/client-data-layer.test.mjs` | Old trillion's memory budget and stuck-tab tests with their assertions unchanged. |

## Invariants

- Storage that is missing, refused or held by another tab makes every read answer nothing kept and every write a no-op; the screen then asks its owner, as on first use.
- Nothing here decides what is fresh: the caller stores the revision its owner reported and sends it back.
- Only an entry the caller says may go is ever let go from memory, and never the one just used.

## Dependencies

**Depends on:** a browser's IndexedDB and Web Crypto (the tests stand in for IndexedDB); Node 24 for the tests.
