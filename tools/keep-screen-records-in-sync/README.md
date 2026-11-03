# tools/keep-screen-records-in-sync/

The browser side of keeping a screen's records in step with the person's store: which tab runs work that must happen
once, how a pushed change reaches every screen, what the device
keeps between visits, and which requests may wait for which. Moved here byte for
byte from Trillion-X/trillion (`moved-from.json` names each file's source path, commit and identity); only import
paths in the tests differ. It is a library the web client imports (`part.json` `imported_by`), not a row the engine
runs.

What a screen draws while a write is still in flight (`src/workspace/pending-changes.ts`) is not here: it moves with the
rest of the device copy to `tools/keep-my-records-on-this-device/`.

## Files

| File | Purpose |
|------|---------|
| `src/workspace/tab-leader.ts` | `leadBrowser(name, run)` elects one tab to own a job (the live socket) with Web Locks; `inOneTab(name, work)` runs a poll in exactly one tab; without Web Locks every tab is its own leader. |
| `src/workspace/request-classes.ts`, `src/workspace/request-classes.json` | Requests sorted into classes by DATA (critical writes, interactive reads, background catalogue lists), each with its own concurrency and the classes it yields to. |
| `src/workspace/store-changes.ts`, `first-answers.json`, `store-change-reads.json` | The one listener every screen shares for "the store changed": one socket for the whole browser (the lock-holding tab hands frames to the others over a BroadcastChannel), reads gathered at most once every few seconds and only while shown, pushed events routed to one typed handler registry, and a read redone only when a newer revision touches what it depended on. |
| `src/live-protocol.mjs`, `src/live-protocol.json`, `src/record-depends.mjs` | The live protocol the socket speaks (hello, numbered requests, catch-up, dirty notices, window ops) and what a read depended on. |
| `parts/ui/show/request/kept-values.ts`, `kept-values.json` | The device cache of last answers in IndexedDB, sealed with AES-GCM under the caller's key, swept by idle and age, least recently used past a cap, never dropping a value marked unsynced. |
| `test/*.test.mjs` | The original tests and assertions. `test/store-changes-one-stream.test.mjs` moves the mocked clock on before its takeover check (old trillion's copy failed there); the bundle-based tests import the TypeScript directly. |
| `moved-from.json` | Where each file came from. |

## How to run the tests

```
node --test 'tools/keep-screen-records-in-sync/test/*.test.mjs'
```
