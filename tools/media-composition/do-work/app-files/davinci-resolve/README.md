# davinci-resolve

The helper DaVinci Resolve runs itself when it opens, so the person's AIs work in the open project in every edition, including the free one, which runs no outside program's scripts and, from 21.1, no Python script from its menu.

## Files

| File | Purpose |
|------|---------|
| `trillion-resolve-bridge.scriptlib` | Resolve runs every `.scriptlib` in its `Fusion/Scripts` folder when it opens, in its own LuaJIT with the live `resolve` object. This one serves that object on 127.0.0.1 with the same signed one-line JSON protocol as davinci-resolve-mcp's in-app bridge (`resolve_bridge.py`), so that MCP server drives it unchanged. Placed by `../../apps-here.json` row `davinci-resolve` (`places`, macOS). |

## Key types / functions (inside the scriptlib)

| Name | Shape | Role |
|------|-------|------|
| request line | `{ protocol: "1.0", id, timestamp, nonce, operation, arguments, signature }` | One request per connection; `signature` is HMAC-SHA256 (CommonCrypto `CCHmac`) over the sorted-key compact JSON without it |
| reply line | `{ id, ok: true, result }` or `{ id, ok: false, error: { code, message } }` | Sorted keys, compact, newline-terminated |
| operations | `health`, `call`, `list_methods`, `get_attribute`, `release_handles`, `shutdown` | `call` runs one method on a named root (`resolve`, `project_manager`, `project`, `media_pool`, `current_timeline`) or a bridge-minted handle `h:<session>:<n>`; live objects come back as `{ __handle__, __type__, __shape__ }` |
| `list_methods` | `{ type, shape, methods }` | Read from Resolve's own `GetHelp(<class>)`, so `hasattr` on the client stays truthful |
| `ensure_config` | reads or mints `$HOME/.config/davinci-resolve-mcp/bridge.json` (0600) | The shared loopback token; an existing one (from davinci-resolve-mcp's installer) is reused |
| `M.serve_blocking(cfg)` | blocking `accept` on the script thread | The OS wakes it on connect; Resolve's interface keeps running |

## Measured (free DaVinci Resolve 21.1.1, macOS)

- The scriptlib runs at startup in two Lua states; one has LuaJIT `ffi` (the bridge runs there), the other has none and the file returns at once.
- That state has no `io`, `require`, `package` or `fu.UIManager`; sockets, files and HMAC go through `ffi` to libc and CommonCrypto.
- A nonblocking accept polled with `bmd.wait` stalls (the wait only returns on activity); a blocking accept answers every request, backgrounded or not.
- Proof: davinci-resolve-mcp's own `resolve_bridge_client.connect()` listed the project's timelines and `Timeline.AddMarker` returned True.

## Dependencies

- **Depends on:** DaVinci Resolve's LuaJIT (`ffi`, `bit`, `os`, `resolve`), libc sockets, CommonCrypto; the token file above.
- **Depended on by:** davinci-resolve-mcp (MIT, its `resolve_bridge_client.py` falls back to the in-app bridge when external scripting is refused); `../../use-an-app-here.mjs` places it.
