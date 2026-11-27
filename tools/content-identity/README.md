# tools/content-identity/

The one owner of internal content identities: BLAKE3-256 of exact bytes, written `1f:<64 hex digits>`. Byte inputs and
ordered chunk inputs give the same identity, and a JSON value has one identity whatever order its keys were written in. It reads no file and makes no network or account call; the code that has
the bytes hands them in, whole or in bounded chunks. A library: it offers no tool of its own, and every row whose code
imports it packs `read-data` beside its own files (with the `@noble/hashes` module, licence included).

The compressor is the existing allocation-aware implementation in `read-data/blake3.mjs`, copied byte for byte
from lines 1–75 of the original `tools/live-namespace/do-work/blake3.mjs` at source commit
`b6ae0ebf815f2f5271eed34e6e023c7e1767ec04`. Its intermediate Workshop copy at
`a8585de191a9b337a2de58efdc3de08ef2b83373` has exactly the same bytes and MIT attribution.
The raw module was committed as `1296b0c7169386d56168cb9c848bdf4e4c581ee2` before the API began delegating to it.
It reuses Noble's tree, keyed/context, clone and XOF behavior while keeping compression scratch space per hasher.
The API re-exports this same implementation; the Namespace module retains its checkpoint-specific wrappers.
Callers packing individual files include both `read-data/identity.mjs` and `read-data/blake3.mjs`; callers packing
the `read-data` folder already include both. The compressor is internal to this library; the public entry stays
`read-data/identity.mjs`.

## Files

| File | Purpose |
|------|---------|
| `read-data/identity.mjs` | `makeHashCodeHexFromBytes(bytes)`, `makeHashCodeHexFromChunks(chunks)`, `makeHashCodeHexFromJson(value)` and `canonicalJson(value)`. |
| `read-data/manifest.mjs` | The identity of a folder of files: `manifestIdentity(files)` (the engine's `manifest_identity`, bare 64 hex), `identityOfDigests({path: hex})`, `fileDigest(bytes)` and `tarFiles(archive)` (the regular files of a `git archive` tar). Moved from `tools/workflows/do-work/pin-a-commit-by-its-files.mjs`; the pin of a commit, a registry pointer's `files_blake3` and a project record's `copied_at_files_blake3` all come from here. Public beside `identity.mjs` (part.json). |
| `test/manifest.test.mjs` | The golden pins of two Workshop folders at 01c2cc3a2, `identityOfDigests` equal to `manifestIdentity`, and the pin module keeping no copy. |
| `read-data/blake3.mjs` | The exact licensed compressor source, imported and re-exported by the identity API. |
| `do-work/identity-from-stdin.mjs` | Internal bridge: reads exact bytes from stdin and prints their identity for callers that cannot import ESM directly. It reads no file. |
| `part.json` | `read-data/identity.mjs` is public. |
| `test/identity.test.mjs` | The published BLAKE3 vectors, chunked input equal to whole input at every split, and one JSON identity for any key order. |
| `ports/identity-in-place.json` | The API's genuine pre-policy source baseline and preserved later APIs. |
| `ports/blake3-compressor.json` | The original compressor range, intermediate source pin and raw-module copy checkpoint. |
| `../../test/content-identity-packs.test.mjs` | Loads the API from actual caller file-list packs and checks byte and derived-key vectors. |
| `../../test/content-identity-source-contracts.test.mjs` | Checks both actual targets with the shared source judge and real repository history; unavailable history remains unproved. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `makeHashCodeHexFromBytes` | `(bytes: Uint8Array) -> "1f:<hex>"` | The identity of bytes; anything else is a TypeError. |
| `makeHashCodeHexFromChunks` | `(chunks: Iterable<Uint8Array>) -> "1f:<hex>"` | The same identity, read chunk by chunk in order. |
| `makeHashCodeHasher` | `() -> { update(chunk: Uint8Array), identity() -> "1f:<hex>" }` | The same identity fed piece by piece as a stream or socket hands the pieces over. |
| `makeKeyedHashHexFromBytes` | `(key: 32-byte Uint8Array, bytes: Uint8Array) -> "<hex>"` | BLAKE3's keyed mode: a message code only a key holder can make, never a content identity. |
| `makeDerivedKeyBytes` | `(bytes: Uint8Array, context: nonempty Uint8Array) -> Uint8Array` | The existing 32-byte BLAKE3 derived key bound to its protocol context. |
| `canonicalJson` | `(value) -> text` | A JSON value as text with every object's keys in code-point order and no spaces; NaN, Infinity and non-JSON values are a TypeError. |
| `makeHashCodeHexFromJson` | `(value) -> "1f:<hex>"` | The identity of the UTF-8 bytes of `canonicalJson(value)`. |

## Dependencies

**Depends on:** `@noble/hashes` (BLAKE3).

**Depended on by:** `tools/where-a-person-stands` (`do-work/artifact-ref.mjs`: the identity of a file, a JSON view or folded text),
`tools/media-composition` (stage reuse), `tools/legal-document-builder` (each document's identity),
`tools/what-runs-on-its-own` (`wakeKey`, the hex without `1f:`), `tools/cross-techniques-with-a-goal` (`hashOf`, its first 32 hex),
`tools/field-values` (`makeHashCodeHexFromJson`: the request key of each planned source call), `tools/decide-agent-actions` (`makeHashCodeHexFromJson`: an action's identity).

## Invariants

- One identity per byte sequence, whatever the chunking; a different order of chunks is a different identity.
- Nothing but bytes is hashed: text is turned into bytes by its caller, after whatever fold the caller's DATA declares.
