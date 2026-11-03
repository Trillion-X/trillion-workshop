# tools/register-trillion-in-my-ai-apps/

Puts Trillion's MCP server entry into other AI apps' own config files (Claude Code, Codex, Gemini CLI, Cursor), and takes it out again, only when the person runs the explicit action for the apps they name. Moved from Trillion-X/trillion `harness/mcp-registration.mjs` (record:library:rea:F-0578) with the checked config writer `harness/config-file.mjs`, the local door reader `harness/local-door.mjs` (now in `tools/use-trillion-from-a-shell`) and the MCP branch of `harness/setup.mjs`.

- **Only the person's own action writes.** `mcp-preview` is its own action and writes nothing: it answers each file's exact before/after lines and a BLAKE3 `review_hash` of the whole plan. `mcp-register --reviewed <hash>` refuses every write when the plan changed.
- **The person's own entry is never touched.** An entry under the same name that matches none of its row's Trillion signatures is `custom`: never changed or removed. Every other key in the file is kept.
- **An app that is not on this computer** is answered `not_installed`; no folder or file is created for it.
- **Every write is checked**: locked, backed up beside the file, refused when the file changed meanwhile or is a symbolic link, and read back.
- **An entry is not a signed-in connection**: each result names the sign-in still to do in that app.
- **Addresses**: https, or http at the literal loopback host (`127.0.0.1`, `[::1]`) with no sign-in in it. The Claude Code and Codex rows run the installed Trillion Mac app's own node with its Keychain bridge, which reads the app's current loopback port for each call (`local-door.mjs`), so no port is copied into a config.

## Files

| File | Purpose |
|------|---------|
| `do-work/mcp-registration.mjs` | `registerMcp({ action, clients, url?, reviewed?, home?, env?, rules })`, `planClient`, `clientConfigPath`, `lineDiff`, `tomlTable`. |
| `do-work/config-file.mjs` | `writeConfig(path, transform, { codec })`: the locked, backed-up, read-back write; `hash` (BLAKE3), `json`, `read`. |
| `tools/use-trillion-from-a-shell/do-work/local-door.mjs` | (imported) `localDoorAddress({ runtime, home })`: the Mac app's loopback MCP address, read from its own declaration each call. |
| `do-work/register-in-ai-apps.mjs` | The command line: `--action mcp-inspect\|mcp-preview\|mcp-register\|mcp-unregister --client <ids> [--mcp-url <url>] [--reviewed <hash>]`. |
| `read-data/mcp-registration.json` | `mac_app` (path, payload, runtime) and `mcp_registration` (entry name, default address, one row per app: file, home variable, format, path, transport, entry, legacy fields to remove, signatures, sign-in). |
| `test/mcp-registration.test.mjs` | The old harness test's cases: preview writes nothing, a reviewed plan refuses after a change, per-app results, backups, custom entries left, odd TOML blocked, the command end to end. |
| `test/mcp-registration-loopback.test.mjs` | The old loopback test: loopback addresses kept, spoofed hosts refused, the local bridge adopted only for the app's current port. |
| `tool-rows.json` | `tool:register-trillion-in-my-ai-apps` (`on-your-computer`). |
| `part.json` | Nothing here is imported by other code. |
