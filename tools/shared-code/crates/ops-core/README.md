# ops-core

Core operator implementations for the Architect EEAF expression evaluation engine, plus crypto-agile trust infrastructure.

## Files

| File | Purpose |
|------|---------|
| `lib.rs` | Main crate module exports and documentation |
| `context.rs` | Evaluation context (EvalContext, FloatMode) for operator configuration |
| `error.rs` | Structured error types (OpError) with machine-readable codes |
| `value.rs` | OpValue newtype wrapper around serde_json::Value with semantics |
| `crypto.rs` | Pure crypto operators (hash by algorithm name, content identity, encode/decode, hmac with sha256 or sha512) |
| `crypto_provider.rs` | Cryptographic provider trait, ClassicalProvider (Ed25519/X25519), HybridProvider (post-quantum ready) |
| `math.rs` | Math operators (add, sub, mul, div, sum, average, round, abs, max, min, etc.) |
| `conversion.rs` | Type conversion operators (to_number, to_string, to_boolean, to_array) |
| `datetime.rs` | Date/time operators (date_add, date_diff, now, format_date, start_of and end_of on a zone's wall clock, workdays, etc.) |
| `logical.rs` | Logical operators with tristate boolean semantics (and, or, not) |
| `text.rs` | Text operators with Unicode/grapheme support (upper, lower, len, concat, slice, replace, etc.) |
| `array.rs` | Array operators (length, first, last, nth, contains, unique, flatten, sort, etc.) |
| `security.rs` | Security operator stubs (can, current_user, has_role, get_entity, emit_event) |
| `graph.rs` | Graph traversal operators (parents, children, neighbors, traverse) over `ctx.graph`, which `graph_of_edges` builds from the edges a rule hands over. Entity references use the canonical `{"$ent_ref": "entity-id"}` shape. |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| **OpValue** | Newtype wrapper around `serde_json::Value` | Runtime value type for all operators; provides truthiness/equality semantics |
| **EvalContext** | `{ float_mode: FloatMode }` | Configuration for operator execution (strict/fast float mode) |
| **FloatMode** | Enum: `Strict` (rust_decimal) \| `Fast` (f64) | Controls float arithmetic precision |
| **OpError** | Enum: TypeMismatch, DivisionByZero, InvalidDate, etc. | Machine-readable errors with context |
| **CryptoProvider** | Trait: sign, verify, key_exchange, encrypt, decrypt, generate_keypair, public_key | Cryptographic operations interface |
| **ClassicalProvider** | Struct wrapping Ed25519/X25519 keys | Production-ready classical crypto implementation |
| **HybridProvider** | Struct wrapping ClassicalProvider + post-quantum placeholder | Future-proof crypto provider (feature-gated) |
| **Signature** | `{ signature_type: SignatureType, bytes: Vec<u8> }` | Digitally signed message with algorithm identifier |
| **SignatureType** | Enum: `Ed25519` \| `Hybrid_Ed25519_MlDsa65` | Algorithm identifier for crypto agility |
| **SharedSecret** | Private `Vec<u8>` with Zeroize derives | Cryptographically-derived shared secret with automatic zeroization |
| **KeyPair** | `{ public_key: Vec<u8>, secret_key: Vec<u8> }` with Zeroize derives | Asymmetric key pair with secure memory handling |
| **CryptoError** | Enum: VerificationFailed, InvalidKey, EncryptionFailed, DecryptionFailed, KeyExchangeFailed | Cryptographic operation errors |

## Dependencies

**Depends on:**
- serde — JSON serialization/deserialization
- serde_json — JSON value type
- ed25519-dalek — Ed25519 digital signatures
- x25519-dalek — X25519 elliptic curve Diffie-Hellman
- aes-gcm — AES-256-GCM authenticated encryption
- hkdf — HMAC-based Key Derivation Function
- sha2 — SHA-256 hashing
- chrono — Date/time parsing and arithmetic
- chrono-tz — Timezone support
- base64 — Base64 encoding/decoding
- rand — Cryptographic randomness
- rust_decimal — Arbitrary-precision decimal arithmetic
- thiserror — Error type derivation macros
- zeroize — Secure memory clearing for sensitive data
- subtle — Constant-time comparison operations
- unicode-segmentation — Grapheme cluster handling

**Depended on by:**
- workflow — Uses OpValue, EvalContext, and operator functions
- io-kernel — Uses crypto operators and CryptoProvider for signing/verification
- composition-engine — Uses operators for expression evaluation
- persistence-wasm — Uses operators for computed fields

## Non-Negotiable Invariants

1. **Sensitive key material MUST zeroize on drop** — KeyPair and SharedSecret have Zeroize + ZeroizeOnDrop derives
2. **ALL signature verification uses constant-time comparison** — ed25519-dalek's verify_strict() prevents timing attacks
3. **Nonces are cryptographically random** — 12 bytes per AES-256-GCM specification, using OsRng entropy
4. **Error messages NEVER leak key material** — No intermediate state, no key bytes in error text
5. **ClassicalProvider is production-ready** — HybridProvider defers to feature-gated post-quantum stubs

## AI Directive

Do NOT simplify this crate by removing:
- Zeroize derives and ZeroizeOnDrop — these are security-critical
- Constant-time comparison operations — timing attack mitigation is non-negotiable
- Detailed error handling — it is required for debugging without leaking secrets
- Extensive documentation and invariants — they prevent future mistakes
