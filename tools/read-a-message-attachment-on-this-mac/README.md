# tools/read-a-message-attachment-on-this-mac/

Answers the bytes of one attachment of the person's Messages database on their Mac, so the Messages screen can show a photo inline.

## Tool

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:read-a-message-attachment-on-this-mac` | Reads one `attachment` row of `~/Library/Messages/chat.db` (by row id or guid) and answers its file's bytes as base64, or a JPEG made by `sips` with `as: "jpeg"` and `most_px` | on the person's Mac, at its local door's `tools:run`, over the home folder granted with `read-a-folder` |

Input: `{ attachment: <row id or guid>, as?: "original" | "jpeg", most_px?: 64..4096 }`.

Output: `{ said, attachment: { id, guid, media_type, byte_length, transfer_name, as }, bytes_base64 }`, or `{ said, refused, ... }` with one of the refusal codes in the output schema. The words are in `read-data/words.json`.

## Files

- `read-data/attachment-read.mjs`: the reader (`readAttachment`), the path check, the request parse.
- `read-data/words.json`: what each refusal says.
- `do-work/read-a-message-attachment.mjs`: the program the Mac runs (stdin request, argv[2] the granted home folder, one JSON answer).
- `what-this-tool-does-and-how-to-run-it.json`: the tool's Workshop row.
- `test/read-a-message-attachment.test.mjs`: fixture tests on a made-up home folder and a made-up `chat.db`.

## Rules it keeps

- `chat.db` is copied with its `-wal` into a private folder and that copy is read read-only; the folder is removed after each answer.
- A file is read only when its path, with symlinks resolved, is inside `Library/Messages/Attachments`.
- Only attachment columns are selected. No message text is read, returned or logged.
- A file over 700 KiB is refused as `too_big`, so the base64 answer stays under the 1 MiB JSON limit; ask with `as: "jpeg"` for a smaller picture.
- It needs Full Disk Access for the engine on the Mac. Without it the answer is `messages_not_readable`.

Run the tests with `timeout -k 10 300 node --test tools/read-a-message-attachment-on-this-mac/test/`.
