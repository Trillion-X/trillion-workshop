# parts/sealed-records

Records only the person's own devices can open: a device seals a record with a key only its devices hold, and the person's store keeps and syncs the ciphertext without being able to read it (zero-knowledge sync). It also seals names deterministically (so a store can match and compare-and-set names it cannot read), shares a sealed record by a link whose key rides only in the URL fragment, and seals a file with a key of its own that only the sealed record naming the file carries.

## Files

| File | Purpose |
|------|---------|
| `part.json` | The part's public files |
| `do-work/sealed-records.mjs` | Derive or make a sealing key, seal and open a record, check that a value is a sealed value and nothing more; seal names deterministically; seal a record for a link; seal and open a file's bytes |
| `do-work/sealed-records.json` | DATA: the BLAKE3 derive-key context of each derived key (`contexts`), the longest sealed name, the fragment parameter a link key rides in, the sealed file reference kind and id prefix, the largest sealed link copy |
| `do-work/sealed-copy.mjs` | Sealed records on one device's copy (parts/device-copy): unlock the person's one sealing key from their passphrase, seal, open, open back for good, and search inside sealed records after opening |
| `do-work/share-a-sealed-record.mjs` | `shareASealedRecord({ op, id, record, address, link, copy })`: seal one record for a link whose key rides after the #, or open it from that link (what `tool-rows.json` runs) |
| `moved-from.json` | Where `do-work/sealed-records.mjs` came from (Trillion-X/trillion at 4ffa1dc4a2^) and the identity of its bytes |
| `tool-rows.json` | The row `tool:share-a-record-by-a-sealed-link`, with a sample that seals a made-up note and opens it again from its link |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `SEALED_TYPE` | `'sealed'` | The record kind a sealed value is kept under |
| `keyFromPassphrase(passphrase, salt)` | `→ { key: Uint8Array(32), key_id }` | argon2id (19 MiB, 2 passes) key from a passphrase the person keeps |
| `newSealingKey()` | `→ { key, key_id }` | A random key the person moves between devices themselves |
| `sealRecord(key, id, { type, value })` | `→ Promise<{ sealed: { v: 1, key_id, nonce, ciphertext } }>` | AES-256-GCM with a fresh nonce and the record id as additional data |
| `openRecord(key, id, value)` | `→ Promise<{ type, value }>` | Opens on a device; refuses another key, a changed value or one moved to another id |
| `isSealedValue(value)` | `→ boolean` | True only for exactly the sealed shape, so plain text can never travel under the sealed kind |
| `SEALING_TYPE`, `SEALING_ID` | `'sealing'`, `'sealing:key'` | The one record per person holding `{ salt, key_id }` (no secret), so every device derives the same key |
| `unlockSealing(store, passphrase)` | `→ { key, key_id, isNew }` | Makes the sealing record the first time; later refuses a passphrase whose key_id differs |
| `hasSealing(store)` | `→ boolean` | Whether a passphrase has been set yet |
| `sealOnCopy(store, key, id, { sealable })` | `→ Promise<{ id, sealed: true }>` | Seals one record of a sealable kind in one write |
| `openOnCopy(store, key, id)` | `→ Promise<{ type, value }>` | One sealed record opened on this device |
| `unsealOnCopy(store, key, id)` | `→ Promise<{ id, sealed: false }>` | Keeps it as itself again |
| `sealName(key, text, scope)` / `openName(key, sealed, scope)` | `→ base64url` / `→ text` | Deterministic AES-SIV under a key derived with `contexts.names`: same name, key and scope give the same text, so a store matches and dedupes it unread |
| `sealedIdentity(value)` | `→ '1f:<64 hex>'` | BLAKE3 content identity of a sealed value (a sealed link copy's `content_id`) |
| `sealForLink(id, record)` | `→ Promise<{ link_key, sealed_copy: { content_id, value } }>` | A record sealed with a fresh key of a link's own; only `sealed_copy` goes to the server |
| `linkWithKey(address, linkKey)` / `linkKeyOf(link)` | `→ link` / `→ { key, key_id }` | The link key in and out of the URL fragment (`#k=`), never sent to a server |
| `checkedLinkCopy(copy)` / `openFromLink(link, id, copy)` | `→ copy` / `→ Promise<{ type, value }>` | The server's whole-shape and identity check; the holder's open |
| `sealFileBytes(bytes)` / `fileReference(...)` / `openFileBytes(reference, ciphertext)` | `→ { identity, ciphertext, file_key }` / `→ { type, value }` / `→ bytes` | A file sealed with its own fresh key, kept under the BLAKE3 identity of its sealed bytes; the reference record carries the key |
| `shareSealedOnCopy(store, key, id)` | `→ Promise<{ link_key, sealed_copy }>` | One sealed record of a copy, opened and sealed again for a link |
| `sealFileOnCopy(store, key, { bytes, name })` / `openFileOnCopy(store, key, id, ciphertext)` | `→ { id, identity, ciphertext }` / `→ { name, media_type, bytes }` | A sealed file on a copy: its sealed reference record has the id `sealed-file:` + the file's sealed name |
| `findSealed(store, key, { words, fields, limit })` | `→ Promise<[{ id, type, title, sealed: true }]>` | Search inside sealed records, on the device, after opening |

## Dependencies

**Depends on:** `@noble/hashes` (argon2id, BLAKE3 for key_id, identities and derived keys), `@noble/ciphers` (AES-SIV for sealed names), the platform's WebCrypto (AES-GCM).

**Depended on by:** `src/record-copies.mjs` (a device copy's sealed records are taken only whole, as a sealed value or a removal; `src/record-copies.json` lists `sealed` as changeable). Device copies seal and open on the device through `sealed-copy.mjs`: the browser's worker (`parts/device-copy/do-work/device-copy-worker.mjs`, reached from `src/workspace/device-copy.ts` and the sharing sheet's lock row). `src/record-sharing.mjs` offers the switch (`sealed`) on `src/record-copies.json` `sealable_types`, and makes and serves sealed links (`checkedLinkCopy`; roles in `src/record-sharing.json` `sealed.link_roles`; the public sealed page was src/record-share-pages.mjs, now the Workshop tool tools/write-public-share-files). The browser worker answers `share_sealed`, `open_link`, `seal_file`, `open_file`.

## Invariants

1. The key never leaves a device; nothing here sends it.
2. A fresh 12-byte nonce per seal; the record id is bound as additional data.
3. `key_id` is the first 16 hex of the key's BLAKE3 identity and reveals nothing of the key or the record.
4. The store never opens a sealed value; it checks only the shape, orders versions and keeps both sides of a conflict apart like any record.
5. A sealed name is deterministic on purpose and reveals only equality, so it seals names and identities, never record bodies.
6. A sealed link's key lives only in the link's fragment; the server keeps only the sealed copy and its BLAKE3 content_id, and a writer replaces it only by naming the content_id it replaced.
7. A sealed file's key lives only inside the sealed record that names it.
