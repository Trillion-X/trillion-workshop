# Put an object in an S3-compatible store

One computer tool, `tool:put-an-object-in-an-s3-store`: puts one file from a folder the person granted into one key of an
S3-compatible store (Backblaze B2, Cloudflare R2, any store that takes S3 PutObject). A key that already holds an object is
replaced, so a fixed key (a download's stable name, an update feed) always answers the newest bytes. It is the write half of
`tools/read-objects-in-an-s3-store`, and signs with that tool's `signRequest`, so the Workshop has one AWS Signature Version 4
owner.

## How a put goes

1. **Which store.** The input's `store` names the store's five values in the person's vault: `<store>-key-id`,
   `<store>-secret`, `<store>-endpoint` (an https root with no path), `<store>-bucket` and `<store>-region`. The engine
   mounts them on descriptors 3 to 7 (`secret_name_from_input` with a `held_suffix` each), only for the account's owner. Each
   value reaches only the hosts the vault keeps for it, so the request goes to the store's own endpoint and nowhere else.
2. **Which file.** `file` is a name inside the folder the run was granted (`computer.read-a-folder.folder`). A name that
   leaves it, by dots, by an absolute path or by a link, names nothing.
3. **One signed PUT.** The file is read by stream once for its SHA-256, which is signed as the payload hash, so the store
   refuses bytes that differ from the ones hashed. Then it is read by stream again and sent as the body of one path-style
   `PUT /<bucket>/<key>` with its `Content-Length`, the given `Content-Type` and, when given, `Cache-Control`. One put takes up
   to 5 GiB. Memory holds one piece whatever the size.
4. **The answer.** `{ store, key, bytes, blake3, sha256, etag }`: the file's BLAKE3 is its content identity, its SHA-256
   the payload hash the store signed. No key value, signature or raw store reply is answered or logged, and nor is the
   store's address: it is made of the endpoint and bucket the vault holds, and the engine withholds a whole output that
   holds a held value, so until Nov 25 2026 every put that named it reached its caller as null.

Whether anyone may read the object is the bucket's own setting (a public bucket serves every key it holds); this tool never
changes a bucket.

## Files

| File | Purpose |
|------|---------|
| `do-work/put-object.mjs` | `putObject(given, { store })`: checks, hashes, signs and sends; `fileInFolder` and `checkedKey`, the refusals |
| `tool-rows.json` | The row `tool:put-an-object-in-an-s3-store` (kind `computer`, capability `read-a-folder`) |
| `kits/put-an-object-in-an-s3-store.json` | How a person's AI uses the tool, with a worked example |
| `test/put-object.test.mjs` | A made-up store that keeps what one PUT sends: the address, the signed region and payload hash, the bytes; every refusal |

Run the focused check from the repository root:

```
node --test tools/put-an-object-in-an-s3-store/test/put-object.test.mjs
```

The test is synthetic. A live store accepting a put needs the store's values in the vault and the tool run through the engine.

## Dependencies

**Depends on:** `tools/read-objects-in-an-s3-store/do-work/read-objects.mjs` (`signRequest`, `endpointOrigin`); Node's `fetch`,
`crypto` and `fs`.

**Depended on by:** `tool-rows.json`; a Mac app release, which publishes its disk images and its Sparkle
appcast to the `downloads-store` bucket with it.
