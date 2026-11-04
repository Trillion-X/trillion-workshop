# tools/suggest-what-to-ask-on-a-screen

The ideas every workspace screen shows at its top for what to ask an AI there, read from one DATA file keyed by screen, each with the request a Do this for me button hands over. Moved from Trillion-X/trillion `src/work-examples.mjs` (a9ee258, #76); its DATA file came byte for byte from the old tree (`moved-from.json`).

## Files

| File | Purpose |
|------|---------|
| `work-examples.mjs` | `examplesFor(screen, deps)` and the old `/work/api/examples` handler, unchanged from the old tree |
| `workspace/examples.json` | The written ideas, keyed by screen, and the strip's words (from old trillion `src/workspace/examples.json`) |
| `ideas-for-a-screen.mjs` | `ideasForAScreen({ screen })`: one screen's written ideas as one run, with no stories, no account and no handoff (what `tool-rows.json` runs) |
| `moved-from.json` | Where `workspace/examples.json` came from, and both identities |
| `tool-rows.json` | The row `tool:list-ideas-for-what-to-ask-on-a-screen`, with a sample run that reads the calendar screen's ideas |
| `README.md` | This file |

## The row

`tool:list-ideas-for-what-to-ask-on-a-screen` runs `ideas-for-a-screen.mjs` in a small container with no internet, through `tools/records-door/do-work/run-an-export.mjs`. It reads only `workspace/examples.json` and writes nothing. Handing a request to an AI, published stories and ideas from the account's current tools stay with the app and the account.
