# tools/use-trillion-from-a-shell/

The `trillion` command: any AI that can run a shell (Claude Code, Codex, Cursor, Gemini CLI, opencode, a script) sees the person's AIs and their AI jobs, hands and takes work, lists and runs Workshop tools and runs any engine operation, with no MCP connection of its own. Moved from Trillion-X/trillion `harness/trillion.mjs` with the files it installs beside itself (record:library:rea:F-0829, F-0183).

- **One road.** Every command is ONE call of the engine's one MCP tool, `run_resource_operation {address, method, request_key, input}`, over MCP JSON-RPC at the account's door: the Trillion Mac app's local door when this computer has one (`local-door.mjs` reads the loopback port from the app's own declaration on every call), else the public origin. The only other addresses are the origin's own sign-in (OAuth with PKCE to a loopback redirect). The engine and `tools/hand-work-to-ais` decide; nothing here decides, stores or routes work.
- **The credential** is the account's existing key (the Mac app's Keychain item, else a 0600 file, else `TRILLION_KEY`) or the sign-in `login` kept. It is read into memory only and sent as a bearer token to the door; never printed, put on a command line or logged.
- **Every call carries one request key**, reused on every retry, so a retry is answered as the first call was.
- **It never updates itself.** A copy an owner installed (its `install-owner.json` marker beside it, for example the Mac app's) is never rewritten by a copy without a marker; `trillion update` names that owner (F-0183).
- **Settings are DATA** (`trillion.json`): the door, the work table, every refusal's words and every place written. A new AI app is one `skills` row and one `agents` row.

The local door itself (the Mac app's loopback server, its bind interface and how it checks the bearer) is the Mac app's and the engine's, not this folder's: this folder is the client.

## Replaying recorded writes

When an account's rows must be brought back (a restore from an older copy), the AIs' own transcripts on this computer hold every row they wrote. `records replay-from-transcripts --since TIME` reads each transcript file changed since TIME (subagent transcripts included) and keeps every records:write whose own result proves it succeeded:

- an MCP `run_resource_operation` call (a tool_use row and its tool_result row, or one completed McpToolCall item);
- a shell `op @own-records records:write ARG`, read with the command's own argument parser, where ARG is literal text, a heredoc, a here-string, piped `echo`/`printf`/`cat FILE`, or a FILE the transcript itself wrote (Write, Edit, `cat > FILE <<'EOF'`) or that is unchanged on disk since the call answered.

Input built at run time (jq, a variable, a loop) is listed as unresolved, never guessed. The newest write of each record id wins by the time of its call; a null value is a removal; `expected` is dropped; a record whose newest value looks like a credential is listed by id only and never kept. The dry run writes `summary.json`, `records.jsonl`, `conflicts.jsonl`, `skipped.jsonl` and `credential-like.json` (readable only by the user) into a new folder under `replay-inventory` beside the command's state folder, and sends nothing. `records replay-from-transcripts --write --inventory FOLDER` writes that folder's rows through `records:write` in batches (at most 256 records and `batch.max_bytes`), one request key per batch made from the folder name, skips batches `written.jsonl` already records, then reads back the first, middle and last record of each type into `readback.json`.

## Files

| File | Purpose |
|------|---------|
| `do-work/trillion.mjs` | The command (`trillion help` lists every command): `main`, `installProgram`, `updateWords`, `keyStore`, `aiOf`, `stateOf` and the rest it exports. |
| `do-work/trillion.json` | Its settings: origin, key places, install set and owner marker, skills per AI app, agent ids, the work table, words. |
| `do-work/trillion-skill.md` | The skill text `setup` writes for each AI app. |
| `do-work/ag-ui-agent.mjs`, `do-work/ag-ui-wire.mjs` | `trillion serve --ag-ui URL`: any AG-UI agent runs each job taken. |
| `do-work/local-door.mjs` | `localDoorAddress({ runtime, home })`: the Mac app's loopback MCP address, read from its own declaration each call. Also used by `tools/register-trillion-in-my-ai-apps`. |
| `do-work/replay-recorded-writes.mjs` | `records replay-from-transcripts`: brings back the rows this computer's AIs wrote, from their own transcripts (see Replaying recorded writes). |
| `do-work/replay-recorded-writes.json` | Its DATA: where in each AI app's own folder (the app's `skills` row in `trillion.json`) its transcripts are, which transcript rows are calls, results and file writes (`shapes`), what proves a write succeeded or was refused, the credential shapes, the inventory folder name, the batch limits and request-key prefix, and how many rows of each type are read back. |
| `test/trillion-cli.test.mjs`, `test/trillion-cli-owner.test.mjs`, `test/trillion-cli-install-owner.test.mjs` | The old repository's tests of the command, moved with it. |
| `test/replay-recorded-writes.test.mjs` | Synthetic transcripts: a success is kept in each shape, a refused, unknown or unanswered call is skipped and listed, the newest write wins across files, removals are carried, malformed lines and shell escapes are tolerated, file inputs come only from the transcript or an unchanged file, credential-like rows stay out, and a dry run is written back in batches, resumed and read back. |
| `ports/replay-recorded-writes.json` | The NO_PRIOR_OWNER claim for `do-work/replay-recorded-writes.mjs`, with the search that found no older owner. |
| `tool-rows.json` | `tool:use-trillion-from-a-shell` (`on-your-computer`). |
| `part.json` | `do-work/local-door.mjs` is imported by another folder. |
