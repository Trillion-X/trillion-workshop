# tools/keep-and-wake-ai-sessions-on-this-computer/

Keep every message, web chat and written file of each AI session on this computer as the person's records, ask the person's Trillion before building, take open work handed to this computer's AIs, wake their stopped sessions, run the tools a job needs here, and set up this computer's AI apps with the account's key, hooks and MCP connection.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees` (`move-rows/trillion-harness-to-workshop.json`), from the tag `old-trillion-before-worker-retire` (b6ae0ebf81): Trillion-X/trillion PR #243 deleted these harness files when it retired the old Worker, with no ported home. `moved-from.json` names each file's source path and commit and the identity of its bytes there and here; only import paths differ. The folder keeps the source tree's own paths under it (`harness/`, `harness/wake-handlers/`, `src/`, `parts/`, `records/`, `server.json`), so the files import each other as they did. Files the Workshop already held byte for byte (in `tools/record-log`, `tools/set-up-my-account` and nine more) are imported from there, not copied.

One folder, not one per script: the scripts read each other's settings files by path (`harness/setup.mjs` reads `harness/setup.json`; `harness/take-open-work.json` names `harness/keychain-mcp-bridge.mjs` beside it), so a split would part a reader from what it reads.

The person's Claude Code cloud sessions (claude.ai/code) are AI sessions too, run off this computer: `harness/read-cloud-sessions.mjs` lists them for one Claude sign-in on this computer (`list`), cuts each one's messages down to what it was asked, what it said last, its pull requests and pushes and the questions it asked (`read`), and sends one a message as the person's next turn (`send`). It uses the same account pages Claude Code's own `--teleport` and the claude.ai/code page use (`/v1/sessions`, `/v1/sessions/<id>/events`), with the sign-in Claude Code keeps in the Keychain for that config folder; the token stays in memory and in the Authorization header only. Written here, not moved: `moved-from.json` does not name it.

## Who imports it

- `tools/run-on-a-persons-computer` (the computer's own tools) imports `../harness/account-key.mjs`, `../harness/setup.mjs` and `../harness/setup.json`, written for the old tree's layout; on this repository's main those paths reach nothing. They are repointed here by the lane that gives that folder its rows.
- Trillion-X/trillion-apps `test/native-harness-setup.test.mjs` imports `../harness/setup.mjs` the same way.

## Tests

The 21 test files moved with the group. Run here, they give the same results by test name as at the tag, but for the tests that need the old tree's own `computer/` and `scripts/` files (moved earlier to `tools/run-on-a-persons-computer` and to trillion-apps), named in the moving PR.

`test/read-cloud-sessions.test.mjs` runs `whatItSaid` over made-up session events: the task, later asks and last messages kept apart, pull requests and pushes found in tool results, questions from the question tool, and sub-agent messages left out.

## Not yet

- Rows: `tool-rows.json` offers the two commands a person's AI runs here, both through `harness/setup.mjs`: setting up the hooks in an AI app (inspect, apply, remove) and its Trillion MCP entry (inspect, preview, register, unregister). The other scripts are hooks or long-running helpers that setup starts, not rows; adapting their `../src/` imports to the records door is still a later lane.
- `src/` holds the old app's files these scripts imported (the import closure), each still in its old shape.
