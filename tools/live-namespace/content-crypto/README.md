# content-crypto

Shared hashing and signature primitives — leaf crate with zero Architect
dependencies.

## Files

| File | Purpose |
|------|---------|
| `src/lib.rs` | `hash()` oneshot, `StreamingHasher`, multihash exports, signature exports, and advanced hash re-exports |
| `src/signature.rs` | Ed25519 signing, verification, and public-key derivation over caller-provided canonical bytes |
| `Cargo.toml` | Self-contained crate manifest with no workspace-inherited dependencies |

## Key Types / Functions

| Type / Function | Signature | Role |
|---|---|---|
| `Multihash` | `Multihash::blake3(bytes)` / `Multihash::sha256(bytes)` | Self-describing hash value |
| `Ed25519Signature` | `sign(bytes, private_key_hex)` / `verify(bytes, signature_hex, public_key_hex)` | Generic signature mechanics over canonical bytes |
| `hash` | `fn hash(bytes: &[u8]) -> [u8; 32]` | Blake3-256 hash of complete input |
| `StreamingHasher` | `new() → update(&[u8]) → finalize() -> [u8; 32]` | Incremental hash for large payloads |
| `advanced::blake3` / `advanced::sha2` | re-exported crates | Direct access when callers need algorithm-specific APIs |

## Dependencies

**Depends on:** `blake3`, `ed25519-dalek`, `sha2`, `hex`, `serde`,
`thiserror` (external only — zero Architect crate dependencies)
**Depended on by:** `envelope-engine` (Layer 1 ingress hashing), any crate needing content-addressing
