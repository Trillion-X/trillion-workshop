# crates/

The Cargo workspace of this tool: `content-chunks/`, content-defined chunk boundaries (gear hash, normalized sizes) and streaming BLAKE3 with WebAssembly SIMD, one implementation for every holder: the device that splits and uploads a file, and the Worker that checks each chunk as it arrives. `Chunker(min, average, max).push(bytes) -> lengths`, `finish()`, `Identity.update/hex`, `digest_hex(bytes)`.

Its built module is `../built-stored-bytes/content-chunks/` (`identity.json` names the crate and the BLAKE3 identity of the wasm).

## Files

| Folder | Purpose |
|--------|---------|
| `content-chunks/` | The crate; `src/lib.rs` holds the chunker and the identity. |

## Dependencies

**Depended on by:** `../built-stored-bytes/content-chunks/`.
