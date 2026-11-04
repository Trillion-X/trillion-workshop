# tools/keep-and-wake-ai-sessions-on-this-computer/

Keep every message, web chat and written file of each AI session on this computer as the person's records, ask the person's Trillion before building, take open work handed to this computer's AIs, wake their stopped sessions, run the tools a job needs here, and set up this computer's AI apps with the account's key, hooks and MCP connection.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees` (`move-rows/trillion-harness-to-workshop.json`), from the tag `old-trillion-before-worker-retire` (b6ae0ebf81): Trillion-X/trillion PR #243 deleted these harness files when it retired the old Worker, with no ported home. `moved-from.json` names each file's source path and commit and the identity of its bytes there and here; only import paths differ. The folder keeps the source tree's own paths under it (`harness/`, `harness/wake-handlers/`, `src/`, `parts/`, `records/`, `server.json`), so the files import each other as they did. Files the Workshop already held byte for byte (in `tools/record-log`, `tools/set-up-my-account` and nine more) are imported from there, not copied.

One folder, not one per script: the scripts read each other's settings files by path (`harness/setup.mjs` reads `harness/setup.json`; `harness/take-open-work.json` names `harness/keychain-mcp-bridge.mjs` beside it), so a split would part a reader from what it reads.

## Who imports it

- `tools/run-on-a-persons-computer` (the computer's own tools) imports `../harness/account-key.mjs`, `../harness/setup.mjs` and `../harness/setup.json`, written for the old tree's layout; on this repository's main those paths reach nothing. They are repointed here by the lane that gives that folder its rows.
- Trillion-X/trillion-apps `test/native-harness-setup.test.mjs` imports `../harness/setup.mjs` the same way.

## Tests

The 21 test files moved with the group. Run here, they give the same results by test name as at the tag, but for the tests that need the old tree's own `computer/` and `scripts/` files (moved earlier to `tools/run-on-a-persons-computer` and to trillion-apps), named in the moving PR.

## Not yet

- No tool row: nothing here is offered to an AI as a row yet. Each script is a hook or a long-running helper started by `harness/setup.mjs` and `harness/wake-sessions.mjs`; the rows (and the adaptation of their `../src/` imports to the records door) are the next lane.
- `src/` holds the old app's files these scripts imported (the import closure), each still in its old shape.
