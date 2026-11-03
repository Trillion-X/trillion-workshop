# tools/keep-screen-records-in-sync/

The browser side of keeping a screen's records in step with the person's store: which tab runs work that must happen
once, what a screen draws while a write is still in flight, and which requests may wait for which. Moved here byte for
byte from Trillion-X/trillion (`moved-from.json` names each file's source path, commit and identity); only import
paths in the tests differ. It is a library the web client imports (`part.json` `imported_by`), not a row the engine
runs.

## Files

| File | Purpose |
|------|---------|
| `src/workspace/tab-leader.ts` | `leadBrowser(name, run)` elects one tab to own a job (the live socket) with Web Locks; `inOneTab(name, work)` runs a poll in exactly one tab; without Web Locks every tab is its own leader. |
| `src/workspace/pending-changes.ts`, `src/workspace/pending-layers.json` | Changes not yet acknowledged, laid over a read in layers (snapshot, optimistic, local), each dropped when its write ends or when the store already shows it. |
| `src/workspace/request-classes.ts`, `src/workspace/request-classes.json` | Requests sorted into classes by DATA (critical writes, interactive reads, background catalogue lists), each with its own concurrency and the classes it yields to. |
| `src/workspace/pending-changes.test.ts`, `test/*.test.mjs` | The original tests and assertions. |
| `moved-from.json` | Where each file came from. |

## How to run the tests

```
node --test tools/keep-screen-records-in-sync/
```
