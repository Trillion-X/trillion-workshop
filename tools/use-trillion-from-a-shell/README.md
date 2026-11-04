# tools/use-trillion-from-a-shell/

The `trillion` command: any AI that can run a shell (Claude Code, Codex, Cursor, Gemini CLI, opencode, a script) sees the person's AIs and their AI jobs, hands and takes work, lists and runs Workshop tools and runs any engine operation, with no MCP connection of its own. Moved from Trillion-X/trillion `harness/trillion.mjs` with the files it installs beside itself (record:library:rea:F-0829, F-0183).

- **One road.** Every command is ONE call of the engine's one MCP tool, `run_resource_operation {address, method, request_key, input}`, over MCP JSON-RPC at the account's door: the Trillion Mac app's local door when this computer has one (`local-door.mjs` reads the loopback port from the app's own declaration on every call), else the public origin. The only other addresses are the origin's own sign-in (OAuth with PKCE to a loopback redirect). The engine and `tools/hand-work-to-ais` decide; nothing here decides, stores or routes work.
- **The credential** is the account's existing key (the Mac app's Keychain item, else a 0600 file, else `TRILLION_KEY`) or the sign-in `login` kept. It is read into memory only and sent as a bearer token to the door; never printed, put on a command line or logged.
- **Every call carries one request key**, reused on every retry, so a retry is answered as the first call was.
- **It never updates itself.** A copy an owner installed (its `install-owner.json` marker beside it, for example the Mac app's) is never rewritten by a copy without a marker; `trillion update` names that owner (F-0183).
- **Settings are DATA** (`trillion.json`): the door, the work table, every refusal's words and every place written. A new AI app is one `skills` row and one `agents` row.

The local door itself (the Mac app's loopback server, its bind interface and how it checks the bearer) is the Mac app's and the engine's, not this folder's: this folder is the client.

## Files

| File | Purpose |
|------|---------|
| `do-work/trillion.mjs` | The command (`trillion help` lists every command): `main`, `installProgram`, `updateWords`, `keyStore`, `aiOf`, `stateOf` and the rest it exports. |
| `do-work/trillion.json` | Its settings: origin, key places, install set and owner marker, skills per AI app, agent ids, the work table, words. |
| `do-work/trillion-skill.md` | The skill text `setup` writes for each AI app. |
| `do-work/ag-ui-agent.mjs`, `do-work/ag-ui-wire.mjs` | `trillion serve --ag-ui URL`: any AG-UI agent runs each job taken. |
| `do-work/local-door.mjs` | `localDoorAddress({ runtime, home })`: the Mac app's loopback MCP address, read from its own declaration each call. Also used by `tools/register-trillion-in-my-ai-apps`. |
| `test/trillion-cli.test.mjs`, `test/trillion-cli-owner.test.mjs`, `test/trillion-cli-install-owner.test.mjs` | The old repository's tests of the command, moved with it. |
| `tool-rows.json` | `tool:use-trillion-from-a-shell` (`on-your-computer`). |
| `part.json` | `do-work/local-door.mjs` is imported by another folder. |
