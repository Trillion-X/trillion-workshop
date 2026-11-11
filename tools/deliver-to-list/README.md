# tools/deliver-to-list/

Writes a message as one row of a list in the person's own records, through their own door. It is the sink a sign-up's emailed code goes to while no mail tool is connected: the code lands as a row of a list the sending account keeps, instead of in an inbox.

## Files

| File | Purpose |
|------|---------|
| `do-work/deliver-to-list.mjs` | The tool. Reads one JSON object on standard input and answers the shape the engine's delivery reads (`sent[0].messageId`, or `error` or `unknown`). |
| `tool-rows.json` | The Workshop row for `tool:deliver-to-list`. |
| `part.json` | The public file the engine may run. |
| `test/deliver-to-list.test.mjs` | Checks the row the message makes, and the answers. |

## Input

One JSON object: `config` (the door config file, as tools/read-a-list-view describes it), `row_type`, `to`, `subject`, `text`, `kind`, `idempotencyKey`. The row's id is the idempotency key and its type is `record:<row_type>`.

## Run the tests

From the root of the Workshop checkout: `node --test tools/deliver-to-list/test/`.
