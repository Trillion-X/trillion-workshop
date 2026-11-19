# tools/keep-and-wake-ai-sessions-on-this-computer/

Keep every message, web chat and written file of each AI session on this computer as the person's records, ask the person's Trillion before building, take open work handed to this computer's AIs, wake their stopped sessions, run the tools a task needs here, and set up this computer's AI apps with the account's key, hooks and MCP connection.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees` (`move-rows/older-repository-harness-to-workshop.json`), from the tag `old-trillion-before-worker-retire` (b6ae0ebf81): Trillion-X/trillion PR #243 deleted these harness files when it retired the old Worker, with no ported home. `moved-from.json` names each file's source path and commit and the identity of its bytes there and here; only import paths differ. The folder keeps the source tree's own paths under it (`harness/`, `harness/wake-handlers/`, `src/`, `parts/`, `records/`, `server.json`), so the files import each other as they did. Files the Workshop already held byte for byte (in `tools/record-log`, `tools/set-up-my-account` and nine more) are imported from there, not copied.

One folder, not one per script: the scripts read each other's settings files by path (`harness/setup.mjs` reads `harness/setup.json`; `harness/take-open-work.json` names `harness/keychain-mcp-bridge.mjs` beside it), so a split would part a reader from what it reads.

The person's Claude Code cloud sessions (claude.ai/code) are AI sessions too, run off this computer: `harness/read-cloud-sessions.mjs` lists them for one Claude sign-in on this computer (`list`), cuts each one's messages down to what it was asked, what it said last, its pull requests and pushes and the questions it asked (`read`), sends one a message as the person's next turn (`send`), and starts a new one with every repository it needs cloned from main and its first message (`start`; `claude --cloud` attaches only the repository it is run in, and a session asking for a second one waits on a permission only the person can give). It uses the same account pages Claude Code's own `--teleport` and the claude.ai/code page use (`/v1/sessions`, `/v1/sessions/<id>/events`), with the sign-in Claude Code keeps in the Keychain for that config folder; the token stays in memory and in the Authorization header only. `send` and `start` take the message, the brief, from a record of the person's Trillion by its id (`start .claude-account1 Trillion-X/trillion-workshop "Sort the list" record:brief:sort-the-list`: read with `records:read` through the Mac app's local door with the account key, its type the id up to its last `:`, its text the value when that is text, else the value's `brief`, `text`, `body`, `message` or `says`), or from standard input (`-` or nothing), so the lead never writes a brief file; a file that already exists is still read. Written here, not moved: `moved-from.json` does not name it.

## Who imports it

- `tools/run-on-a-persons-computer` (the computer's own tools) imports `../harness/account-key.mjs`, `../harness/setup.mjs` and `../harness/setup.json`, written for the old tree's layout; on this repository's main those paths reach nothing. They are repointed here by the lane that gives that folder its rows.
- Trillion-X/trillion-apps `test/native-harness-setup.test.mjs` imports `../harness/setup.mjs` the same way.

## Tests

The 21 test files moved with the group. Run here, they give the same results by test name as at the tag, but for the tests that need the old tree's own `computer/` and `scripts/` files (moved earlier to `tools/run-on-a-persons-computer` and to trillion-apps), named in the moving PR.

`test/read-cloud-sessions.test.mjs` runs `whatItSaid` over made-up session events: the task, later asks and last messages kept apart, pull requests and pushes found in tool results, questions from the question tool, and sub-agent messages left out.

For the source rather than the summary, run `node tools/keep-and-wake-ai-sessions-on-this-computer/harness/read-cloud-sessions.mjs read-first <config-folder> <session-id> [offset] [length] [snapshot]` from the Workshop checkout. The config folder is one name directly below the home folder; the session is one exact provider id. The command reads that session's event pages in provider order only until the first actual user message. It uses the existing sign-in and authenticated GET road; it does not list accounts/sessions, start/send a turn or refresh credentials. Tool-result and subagent events are excluded; a first non-text user message is reported as such rather than replaced by a later text request.

The first call uses byte offset `0`; length defaults to 16 KiB and must be 1–64 KiB. The answer's `byte_page` names total UTF-8 bytes, offset, returned length, base64 bytes, completion and `next_after_byte`. Continue with the same folder/session, that next offset and `source.snapshot`; a changed full source event refuses continuation. Join decoded byte chunks before decoding UTF-8, then verify `1f:` plus `byte_page.blake3` with the canonical content-identity owner. These are raw text bytes, not JSON-answer pages for records-door's `wholeAnswer`. A string content is preserved whole; text blocks use the existing newline-join projection, with non-text block count and projection stated. Attachments, original block boundaries and provider JSON wire bytes are not claimed as lossless message content. Malformed UTF-16 text is refused rather than silently replaced during UTF-8 encoding.

The older `read` summary remains compatible: `first_task` still has its 4000 UTF-16-unit limit, now accompanied by explicit summary/truncation/total-unit metadata. The new read and its exported `dispatchCloudSessions`, `readFirstUserText` and `firstUserTextPage` are exercised with synthetic requests through the real GET/header-auth consumer; tests never call Keychain or the provider. This CLI runs from the complete checkout, whose root `package.json` includes `tools` and declares `@noble/hashes`; its identity import reuses `tools/content-identity/read-data/identity.mjs`. It is not a separately packed or installer-published harness payload.

From old trillion main at 5dc302be37 (the old-trillion sweep): `test/tell-a-chat-app.test.mjs` checks `harness/tell-a-chat-app.mjs` against a headless browser, and `scripts/publish-registry.mjs` lists a server in the official MCP Registry from the listing file its owner passes (`server.json` here holds only the host version; it signs in with the `gh` account's token, in memory only); `moved-from.json` names both.

## Not yet

- Rows: `tool-rows.json` offers the two commands a person's AI runs here, both through `harness/setup.mjs`: setting up the hooks in an AI app (inspect, apply, remove) and its Trillion MCP entry (inspect, preview, register, unregister). The other scripts are hooks or long-running helpers that setup starts, not rows; adapting their `../src/` imports to the records door is still a later lane.
- `src/` holds the old app's files these scripts imported (the import closure), each still in its old shape.

## Files moved from bitfield-packages (packages/eeaf)

Each file below is the package's own, byte for byte; `from-bitfield-packages/moved-from.json` names each source path and commit, the identity of its source bytes and of its bytes here, and the `calls` that made a real name or id made up. After the first commit only import paths changed. A file named `.held` is the same bytes with its test name taken off so the repository test does not run it; the reason is under `held` in the receipt. Most files import `@/packages/ui` and the retired package runtime (`@bitfield/runtime-kit`); the shared ui parts live in apps `tools/ui`, so the screens and targets here are prepared, not wired to a tool row.

| File | What it is |
|---|---|
| `tools/keep-and-wake-ai-sessions-on-this-computer/parts/eeaf/tests/eeaf-sqlite-store.test.mjs.held` | Proves the eleven tables exist, the address grammar matches `crates/eeaf-addressing`, records round-trip with no object stored as JSON text, changes write only changed rows and keep every earlier value, content-addressed children are stored once, and foreign k |

### Not carried

- 9 files: Rust source of the retired eeaf slot (WASI component); the engine's own eeaf store lives in trillion-rust src/eeaf_store*.rs, not in the Workshop
- 4 files: tests the retired eeaf slot or the package tree (live shell, cargo build, scene packages); not carried
- 3 files: generated build output of the retired package runtime (entry scope, built entry bytes); not carried
- 1 file: package README, package.json or ignore file; this folder has its own README
- 1 file: the package boundary file: record contracts, actions and surfaces for the retired package runtime (slot workflows, owner targets); not carried
- 1 file: the Workshop holds a later copy at tools/keep-and-wake-ai-sessions-on-this-computer/parts/eeaf/do-work/eeaf-sqlite-store.mjs (sealed log generations); kept

The receipt's `not_carried` names each path.

## Files moved from the engine (trillion-rust, hooks)

`from-the-engine-repository/` holds the engine's route for AI harness hook events byte for byte (`src/account/hooks.rs`, `hooks.json` and `hooks/`, 4,025 lines), removed from the engine on Nov 15 2026 because it is not one of the engine's five jobs. Receipt: `from-the-engine-repository/moved-from.json`. Not wired; `harness/` does this job here.
