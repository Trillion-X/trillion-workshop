# stdio-mcp-gateway

Serves stdio Model Context Protocol servers as streamable-HTTP ones (MCP 2025-06-18), dependency-free Node.

- `do-work/gateway.mjs` `createGateway({ apps, ... })`: the request handler. `POST /<app>/mcp` starts the app's stdio server on `initialize` (a process and working folder per session, `Mcp-Session-Id` returned), forwards later messages by id and answers JSON (or one SSE event when only `text/event-stream` is accepted). A request with no session id is answered one-off (start, initialize, ask, stop). `GET` opens a notification stream, `DELETE` ends the session, `GET /` is a health list. Sessions are capped, least-recently-used idle ones are stopped to make room, idle and old ones are reaped, and an unknown session answers 404 so the caller initializes again.
- `do-work/serve.mjs`: `node serve.mjs <config.json>`, the config being DATA (`apps`: name to `{ cli, args }`, plus limits).

The apps and their config come from `records/hosted-mcp-apps.json` through `src/hosted-mcp-apps.mjs`; the container image that runs this is the `service:craft-mcp` hosted-service row. Test: `test/stdio-mcp-gateway.test.mjs` (a fake stdio server).

## Files

| File | Purpose |
|------|---------|
| `part.json` | Which files other code may import (`do-work/gateway.mjs`, `do-work/serve.mjs`) |
| `do-work/gateway.mjs` | `createGateway({ apps, ... })`: the request handler above |
| `do-work/serve.mjs` | The gateway as a web server over a config file |
| `do-work/ask-a-stdio-server-once.mjs` | `askAStdioMcpServerOnce({ cli, args, env, app, request, protocol_version, timeout_seconds })`: the gateway's one-off flow as one run, a POST with no session id handed to the handler in-process with no port opened (what `tool-rows.json` runs) |
| `test/echo-mcp-server.mjs` | A made-up stdio MCP server with one tool, `echo`, for the row's sample |
| `tool-rows.json` | The row `tool:ask-a-command-line-mcp-server-once`, with a sample that asks the made-up echo server's `echo` tool |
| `README.md` | This file |

## The row

`tool:ask-a-command-line-mcp-server-once` runs `do-work/ask-a-stdio-server-once.mjs` in a small container with no internet: it starts the server the input names, initializes it, asks one request and stops it. It does not keep sessions or serve on a port; that is `do-work/serve.mjs` in the hosted service.
