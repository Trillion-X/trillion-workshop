# tools/read-and-write-gmail/

A person's Gmail, through the Google account they connected: search and read mail and threads, organize, trash and restore them, keep drafts and send one, and set the signature they send as. Each tool is one `http` row in `tool-rows.json`, one Gmail request, run by the engine as the Google account the run's input names in `connection` (`{ connection_id, connected_at }`, the handle the mail screen binds a run to). The person's token for that account stays in their vault: the engine places it in the Authorization header as the request leaves, refreshes it when it has expired, and never shows it to the tool, the screen or an AI. Ported from the earlier Connections screen's Gmail requests (the google-account entry of `parts/service-connections/records.json`), request for request.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The 21 rows, `tool:google-account-<request>`: each one's address, method, query or body, input and output schema, the `google-account` connection taken from `input.connection`, and the token's header. |
| `test/rows.test.mjs` | Every row takes its account from `input.connection` only, puts the token only in the Authorization header, reaches only Gmail over https, and reads only with GET. |

## How to run one

Through the person's door like any Workshop tool, for example `tools:run` with `{ "tool": "tool:google-account-find_my_mailbox", "input": { "connection": { "connection_id": "service_connection:google-account" } } }`. The answer is Gmail's own reply. A send (`tool:google-account-send_draft`) is kept once per request key, so sending the same key again answers the first reply.

## Tests

`npm test` at the top of the repository runs `test/rows.test.mjs` with the rest.
