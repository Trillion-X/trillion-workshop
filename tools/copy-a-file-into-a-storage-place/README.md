# tools/copy-a-file-into-a-storage-place/

Copies one of the person's files, any size, into a folder of a storage place they were given (a Google Drive folder someone shared,
their own OneDrive folder, any kind `read-data/storage-places.json` describes), or says plainly that they may not add files there.

## How a copy goes

1. **May this account add here?** The place's `check` request is asked as the person's account. A folder whose owner gave this
   account no right to add (Google Drive's `canAddChildren` false) is answered in words with the folder's name, and nothing is opened
   or sent.
2. **Open one upload.** The place's `open` request starts a resumable upload. It is the only request that carries the account's
   credential: its answer is the upload's own address, which takes the bytes with no other credential and is never answered or kept.
3. **Send the bytes a piece at a time.** Each piece is read from the file's address by byte range (a share link of the person's
   files, so the bytes come from their own route) and sent on with `Content-Range`, so memory holds one piece (8 MiB by default)
   whatever the file's size. The place's last answer names the new file.

The account is connected one of two ways (`via`, the row's `by_input` variants): the account's own token (`google-account`,
`microsoft-account`: refreshed by the engine from the person's connection) or Composio (`composio`: the Composio key on descriptor 4
and the connected account's id). Either way the key reaches only the place's own host or Composio.

A place whose every piece needs the account's own credential (Dropbox upload sessions, S3 multipart) does not fit this shape; it is
not listed until a piece can carry its credential.

## Files

| File | Purpose |
|------|---------|
| `do-work/copy-a-file-into-a-storage-place.mjs` | `copyAFileIntoAStoragePlace(input)`: check, open, send by piece; `makePlaceRequest`: one request as the account (bearer or Composio proxy) |
| `read-data/storage-places.json` | DATA: each kind of place, its check, open and piece rules |
| `tool-rows.json` | The row `tool:copy-a-file-into-a-storage-place` |
| `test/copy-a-file-into-a-storage-place.test.mjs` | A made-up place and source: a copy by pieces, a refused folder, a short source, a refused piece, both connection kinds |

## Proof so far

Nov 19 2026, 9:40 PM CST: the same three steps copied a 19,270,466-byte video from a share link into a Google Drive folder the
account owns (3 pieces: 308, 308, 200; the place's md5 equals the file's). A folder another person owns and gave only view rights
answered `canAddChildren: false`.

Not yet: a live run of this row through the engine. The vault's `composio-api-key` reaches a Composio project with no connected
accounts; the person's Google accounts are connected in another one.

## Dependencies

**Depends on:** Node's `fetch`; `tools/workflows/do-work/run-a-function.mjs` (the command the row runs).

**Depended on by:** `tool-rows.json`.
