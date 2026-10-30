# tools/content-identity/

The one owner of internal content identities: BLAKE3-256 of exact bytes, written `1f:<64 hex digits>`. Byte inputs and
ordered chunk inputs give the same identity. It reads no file and makes no network or account call; the code that has
the bytes hands them in, whole or in bounded chunks. A library: it offers no tool of its own, and every row whose code
imports it packs `read-data` beside its own files (with the `@noble/hashes` module, licence included).

## Files

| File | Purpose |
|------|---------|
| `read-data/identity.mjs` | `makeHashCodeHexFromBytes(bytes)` and `makeHashCodeHexFromChunks(chunks)`. |
| `part.json` | `read-data/identity.mjs` is public. |
| `test/identity.test.mjs` | The published BLAKE3 vectors, and chunked input equal to whole input at every split. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `makeHashCodeHexFromBytes` | `(bytes: Uint8Array) -> "1f:<hex>"` | The identity of bytes; anything else is a TypeError. |
| `makeHashCodeHexFromChunks` | `(chunks: Iterable<Uint8Array>) -> "1f:<hex>"` | The same identity, read chunk by chunk in order. |

## Dependencies

**Depends on:** `@noble/hashes` (BLAKE3).

**Depended on by:** `tools/where-a-person-stands` (`do-work/artifact-ref.mjs`: the identity of a file, a JSON view or folded text).

## Invariants

- One identity per byte sequence, whatever the chunking; a different order of chunks is a different identity.
- Nothing but bytes is hashed: text is turned into bytes by its caller, after whatever fold the caller's DATA declares.
