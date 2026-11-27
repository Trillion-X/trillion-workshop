# Remove objects from an S3-compatible store

One container tool, `tool:remove-objects-from-an-s3-store`. It removes the exact objects a person names from an S3-compatible
store they keep in their vault (Backblaze B2, Cloudflare R2, any store that speaks S3). It also lists one page of a prefix, so a
removal is read before and after it. It is the delete half of `tools/put-an-object-in-an-s3-store`, and it opens the store the
same way. It signs with `tools/read-objects-in-an-s3-store`'s `signRequest`, so the Workshop has one AWS Signature Version 4
owner.

It lists by the store's held name. `tool:read-objects-in-an-s3-store` cannot: its row is bound to a connected Cloudflare R2
service (`connection: {vendor, from_input: account_id}`). A store kept in the vault by name, such as `files-store`, had no tool
that could read or remove its objects until this one (Nov 26 2026).

## How a removal goes

1. **Which store.** The input's `store` names the store's five values in the person's vault: `<store>-key-id`,
   `<store>-secret`, `<store>-endpoint` (an https root with no path), `<store>-bucket` and `<store>-region`. The engine mounts them
   on descriptors 3 to 7 (`secret_name_from_input` with a `held_suffix` each), only for the account's owner. Each value reaches
   only the hosts the vault keeps for it, so every request goes to the store's own endpoint and nowhere else.
2. **Which keys.** `keys` is an exact list of 1 to 1000 object keys. A key that ends in `/` (a prefix), holds `*` or `?`, is
   named twice, or is not a plain key (empty, over 1024 bytes, a leading slash, a dot segment, a control character) refuses the
   whole list. Nothing is sent, so a mistyped pattern never empties a folder.
3. **Read, then remove.** Each key is read with a signed `HEAD`. A key that is not there answers `absent`. A key that is there
   is removed with a signed `DELETE` and answers `removed` with its size. A key the store will not read or remove answers
   `failed` with the store's status, and the other keys still go. A refused key (401 or 403) stops the run with words that say
   the vault's key is not current.
4. **The answer.** `{ store, results: [{ key, result, bytes?, why? }], removed, absent, failed }`. With `action: list` and a
   `prefix`, it answers `{ store, prefix, objects: [{ key, size, last_modified }], truncated, next_token }` instead, and
   removes nothing. No answer or error holds a key value, a signature, the endpoint or the bucket. The engine withholds a whole
   output that holds a held value.

Whether anyone may read the objects is the bucket's own setting. This tool never changes a bucket.

## Files

| File | Purpose |
|------|---------|
| `do-work/remove-objects.ts` | `removeObjects(input, { store })`: list, or check the keys, read and remove each; `exactKeys`, the key rule |
| `what-this-tool-does-and-how-to-run-it.json` | The row `tool:remove-objects-from-an-s3-store` (kind `container`, the store's five values on descriptors 3 to 7) |
| `kits/remove-objects-from-an-s3-store.json` | How a person's AI uses the tool, with a worked example |
| `test/remove-objects.test.ts` | A made-up store held in memory that answers signed HEAD, DELETE and listing: each key's answer, the requests and their signed region, every refusal (nothing sent), one failed key among others, a refused key, a listing |

Run the focused check from the repository root:

```
node --test tools/remove-objects-from-an-s3-store/test/remove-objects.test.ts
```

The test is synthetic. A live store answering a removal needs the store's values in the vault and the tool run through the
engine.

## Dependencies

**Depends on:** `tools/read-objects-in-an-s3-store/do-work/read-objects.mjs` (`signRequest`, `endpointOrigin`,
`parseListing`); `tools/put-an-object-in-an-s3-store/do-work/put-object.mjs` (`checkedKey`, the one object key rule); Node's
`fetch` and `fs`.

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json`.
