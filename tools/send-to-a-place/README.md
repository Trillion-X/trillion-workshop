# send-to-a-place

Three rows post a note, or anything picked, to a place the person names: a public web address (a webhook) as JSON, a page in a Notion database, or a message in a Slack channel. The Notion and Slack rows go through the person's own connection.

Each row takes `things` (what is being sent, each `{ kind, label, address?, id? }`, the first one's address being its link) and `note` (the person's own words), plus the place's own field: `address` for the webhook, `database` for Notion, `channel` for Slack. A sharing place that has only the picked things and the note can fill every row, because `things` is the one required field.

## Files

| File | Purpose |
|---|---|
| `tool-rows.json` | Three `http` rows the engine runs (no code of their own): `tool:send-to-a-webhook` posts `{ title, link, words, things }` to `address`, refuses an address that is not public, waits at most 10 seconds and follows no redirect; `tool:add-to-notion` makes a page titled `title` (else the first thing's name) holding the note and a link; `tool:post-to-slack` posts the note with the link as an attachment, and Slack's own `ok: false` is told as a refusal in Slack's words. Each answers `{ status, said, answer? }`. |
| `test/send-to-a-place-rows.test.mjs` | The rows' promises: each is an `http` row a place finds by its name and a tray fills from `things`; the webhook holds no credential and does not follow a redirect, and its sample run fits its own input; the Notion and Slack rows take their token only from their own connection, only in the `Authorization` header; and no row names a person or a value of its own. |
| `part.json` | No public files. |

## The connections

`tool:add-to-notion` names `connection_id: service_connection:notion` and places the connection's `integration_token` as `Authorization: Bearer ...`; `tool:post-to-slack` names `service_connection:slack` and places its `bot_token` the same way. The engine reads the value from the person's held values, places it as the request leaves over https, and replaces it wherever it appears in the reply. The value is never in the row, the input, the receipt or the answer.

## Dependencies

- The engine's `http` invoke kind (`src/runtime/workshop/http.rs` in the engine): the request template with `from`, `otherwise` and `$when`, the public-only network policy, `follow_redirects`, `report_answer` and `answer_ok_field`, and the held value placed as a header.
- The person's Notion and Slack connections, for those two rows.
