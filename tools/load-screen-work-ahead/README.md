# tools/load-screen-work-ahead/

Starts a screen's work before the person asks for it, and keeps a screen's lazily loaded code loading when the network
or a deploy gets in the way. Moved here byte for byte from Trillion-X/trillion (`moved-from.json` names each file's
source path, commit and identity); the tests import the TypeScript directly instead of through a bundle. It is a
library the web client imports (`part.json` `imported_by`), not a row the engine runs.

## Files

| File | Purpose |
|------|---------|
| `parts/ui/show/intent-prefetch/intent-prefetch.ts`, `intent-prefetch.json`, `index.ts`, `README.md` | `watchIntent`: the pointer's path predicts the one target it is heading for and starts loading it with an abort signal, aborted when the path turns away; ambiguous paths, touch and save-data devices start nothing. Look-ahead and thresholds are DATA. |
| `parts/ui/show/load-later/load-code.ts` | `loadCode`: a named lazy dependency retried with backoff while the tab is visible; a failed chunk is told apart from a failed module (`CodeLoadFailure`, `failedFetchAddress`) so the page can mend itself. |
| `test/intent-prefetch.test.mjs`, `test/load-code.test.mjs` | The original tests and assertions. |
| `moved-from.json` | Where each file came from. |

## How to run the tests

```
node --test 'tools/load-screen-work-ahead/test/*.test.mjs'
```
