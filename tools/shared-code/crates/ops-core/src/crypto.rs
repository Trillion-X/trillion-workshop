//! Crypto operators for the Architect Platform
//!
//! This module provides generic hash and encoding operators with capability-based dispatch.
//! Algorithms and encodings are registered capabilities, not hardcoded function names.
//!
//! # Design
//!
//! `HashCapability` and `EncodingCapability` hold type-erased closures for registered
//! algorithms/encodings. The generic `hash(input, algorithm)`, `encode(input, encoding)`,
//! and `decode(input, encoding)` functions dispatch through capabilities, allowing users
//! to add new algorithms without code changes.
//!
//! # Supported Hash Algorithms
//!
//! - **blake3**: BLAKE3 cryptographic hash (the system's internal content-identity algorithm)
//! - **sha256**: SHA-256 cryptographic hash (external interop only)
//! - **md5**: MD5 (legacy, cryptographically broken)
//! - **fast**: FNV-1a 64-bit non-cryptographic hash for bucketing
//!
//! # Supported Encodings
//!
//! - **base64**: Standard base64
//! - **base64url**: URL-safe base64 (- and _ instead of + and /)
//! - **hex**: Hexadecimal
//!
//! # Null Propagation
//!
//! All operators propagate null: `hash(null, "sha256") = null`

use crate::{EvalContext, OpError, OpValue};
use base64::Engine;
use content_crypto::advanced::sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;

// ============================================================================
// Hash Capability
// ============================================================================

/// Type alias for a hash function closure.
type HashFn = Arc<dyn Fn(&str) -> Result<String, OpError> + Send + Sync>;

/// Hash algorithm capability with registered hash functions.
///
/// This struct holds type-erased closures for each registered hash algorithm.
/// Adding a new algorithm requires registering a closure — no new function definitions needed.
#[derive(Clone)]
pub struct HashCapability {
    algorithms: HashMap<String, HashFn>,
}

impl HashCapability {
    /// Create a new HashCapability with all built-in algorithms registered.
    pub fn new() -> Self {
        let mut cap = Self {
            algorithms: HashMap::new(),
        };
        cap.register_builtin_algorithms();
        cap
    }

    /// Register a custom hash algorithm.
    pub fn register(&mut self, algorithm: String, hash_fn: HashFn) {
        self.algorithms.insert(algorithm, hash_fn);
    }

    /// Get the list of available algorithms.
    pub fn available_algorithms(&self) -> Vec<String> {
        let mut algos: Vec<_> = self.algorithms.keys().cloned().collect();
        algos.sort();
        algos
    }

    /// Register all built-in hash algorithms (blake3, sha256, md5, fast).
    ///
    /// blake3 is the system's internal content-identity algorithm; sha256 and
    /// md5 remain available as user-selectable algorithms for external
    /// interop (vendor APIs and third-party protocols that mandate them).
    fn register_builtin_algorithms(&mut self) {
        // BLAKE3 (internal content identity; 64-char lowercase hex digest)
        self.register(
            "blake3".to_string(),
            Arc::new(|input| {
                let digest = content_crypto::Multihash::blake3(input.as_bytes()).digest;
                Ok(bytes_to_hex(&digest))
            }),
        );

        // SHA-256
        self.register(
            "sha256".to_string(),
            Arc::new(|input| {
                let mut hasher = Sha256::new();
                hasher.update(input.as_bytes());
                let hash = hasher.finalize();
                Ok(bytes_to_hex(&hash))
            }),
        );

        // MD5
        self.register(
            "md5".to_string(),
            Arc::new(|input| {
                let hash = md5_hash(input.as_bytes());
                Ok(bytes_to_hex(&hash))
            }),
        );

        // Fast (FNV-1a 64-bit)
        self.register(
            "fast".to_string(),
            Arc::new(|input| {
                let hash = fnv1a_64(input.as_bytes());
                Ok(hash.to_string())
            }),
        );
    }

    /// Compute a hash using the specified algorithm.
    pub fn hash(&self, input: &str, algorithm: &str) -> Result<String, OpError> {
        match self.algorithms.get(algorithm) {
            Some(hash_fn) => hash_fn(input),
            None => {
                let available = self.available_algorithms();
                Err(OpError::InvalidArgument {
                    operation: "hash".to_string(),
                    reason: format!(
                        "Algorithm '{}' not registered. Available algorithms: {}",
                        algorithm,
                        available.join(", ")
                    ),
                })
            }
        }
    }
}

impl Default for HashCapability {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for HashCapability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HashCapability")
            .field("available_algorithms", &self.available_algorithms())
            .finish()
    }
}

// ============================================================================
// Encoding Capability
// ============================================================================

/// Type alias for an encoding function closure.
type EncodeFn = Arc<dyn Fn(&str) -> Result<String, OpError> + Send + Sync>;

/// Type alias for a decoding function closure.
type DecodeFn = Arc<dyn Fn(&str) -> Result<String, OpError> + Send + Sync>;

/// Encoding capability with registered encode/decode functions.
///
/// This struct holds type-erased closures for each registered encoding.
/// Adding a new encoding requires registering encoder/decoder pairs — no new function definitions needed.
#[derive(Clone)]
pub struct EncodingCapability {
    encoders: HashMap<String, EncodeFn>,
    decoders: HashMap<String, DecodeFn>,
}

impl EncodingCapability {
    /// Create a new EncodingCapability with all built-in encodings registered.
    pub fn new() -> Self {
        let mut cap = Self {
            encoders: HashMap::new(),
            decoders: HashMap::new(),
        };
        cap.register_builtin_encodings();
        cap
    }

    /// Register a custom encoding (encoder/decoder pair).
    pub fn register(&mut self, encoding: String, encoder: EncodeFn, decoder: DecodeFn) {
        self.encoders.insert(encoding.clone(), encoder);
        self.decoders.insert(encoding, decoder);
    }

    /// Get the list of available encodings.
    pub fn available_encodings(&self) -> Vec<String> {
        let mut encodings: Vec<_> = self.encoders.keys().cloned().collect();
        encodings.sort();
        encodings
    }

    /// Register all built-in encodings (base64, base64url, hex).
    fn register_builtin_encodings(&mut self) {
        // Base64
        self.register(
            "base64".to_string(),
            Arc::new(|input| {
                let encoded = base64::engine::general_purpose::STANDARD.encode(input.as_bytes());
                Ok(encoded)
            }),
            Arc::new(|input| {
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(input)
                    .map_err(|_| OpError::InvalidArgument {
                        operation: "decode".to_string(),
                        reason: "invalid Base64 string".to_string(),
                    })?;
                String::from_utf8(decoded).map_err(|_| OpError::InvalidArgument {
                    operation: "decode".to_string(),
                    reason: "decoded bytes are not valid UTF-8".to_string(),
                })
            }),
        );

        // Base64 URL-safe
        self.register(
            "base64url".to_string(),
            Arc::new(|input| {
                let encoded = base64::engine::general_purpose::URL_SAFE.encode(input.as_bytes());
                Ok(encoded)
            }),
            Arc::new(|input| {
                let decoded = base64::engine::general_purpose::URL_SAFE
                    .decode(input)
                    .map_err(|_| OpError::InvalidArgument {
                        operation: "decode".to_string(),
                        reason: "invalid URL-safe Base64 string".to_string(),
                    })?;
                String::from_utf8(decoded).map_err(|_| OpError::InvalidArgument {
                    operation: "decode".to_string(),
                    reason: "decoded bytes are not valid UTF-8".to_string(),
                })
            }),
        );

        // Hex
        self.register(
            "hex".to_string(),
            Arc::new(|input| Ok(bytes_to_hex(input.as_bytes()))),
            Arc::new(|input| {
                let bytes = hex_to_bytes(input).map_err(|_| OpError::InvalidArgument {
                    operation: "decode".to_string(),
                    reason: "invalid hexadecimal string".to_string(),
                })?;
                String::from_utf8(bytes).map_err(|_| OpError::InvalidArgument {
                    operation: "decode".to_string(),
                    reason: "decoded bytes are not valid UTF-8".to_string(),
                })
            }),
        );
    }

    /// Encode a string using the specified encoding.
    pub fn encode(&self, input: &str, encoding: &str) -> Result<String, OpError> {
        match self.encoders.get(encoding) {
            Some(encoder) => encoder(input),
            None => {
                let available = self.available_encodings();
                Err(OpError::InvalidArgument {
                    operation: "encode".to_string(),
                    reason: format!(
                        "Encoding '{}' not registered. Available encodings: {}",
                        encoding,
                        available.join(", ")
                    ),
                })
            }
        }
    }

    /// Decode a string using the specified encoding.
    pub fn decode(&self, input: &str, encoding: &str) -> Result<String, OpError> {
        match self.decoders.get(encoding) {
            Some(decoder) => decoder(input),
            None => {
                let available = self.available_encodings();
                Err(OpError::InvalidArgument {
                    operation: "decode".to_string(),
                    reason: format!(
                        "Encoding '{}' not registered. Available encodings: {}",
                        encoding,
                        available.join(", ")
                    ),
                })
            }
        }
    }
}

impl Default for EncodingCapability {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for EncodingCapability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EncodingCapability")
            .field("available_encodings", &self.available_encodings())
            .finish()
    }
}

// ============================================================================
// Generic Hash, Encode, Decode Functions
// ============================================================================

/// Generic hash operator: hash(input, algorithm) -> string
///
/// Dispatches to the registered algorithm for the specified hash function.
/// Returns null if input is null.
pub fn hash(input: &OpValue, algorithm: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if input.is_null() {
        return Ok(OpValue::null());
    }

    let text = input.as_str("hash input")?;
    let algo_str = algorithm.as_str("algorithm")?;

    let cap =
        ctx.capabilities
            .get::<HashCapability>()
            .ok_or_else(|| OpError::InvalidOperation {
                operation: "hash".to_string(),
                reason: "HashCapability not registered in context".to_string(),
            })?;

    let result = cap.hash(text, algo_str)?;
    Ok(OpValue::string(result))
}

/// Keyed message code: `hmac(message, key, algorithm, encoding) -> string` (RFC 2104).
///
/// `algorithm` is "sha256" (the default) or "sha512"; `encoding` is "hex" (the default) or "base64". This is the
/// code a service signs a webhook body with, so a rule can check a signature it was handed. Null message or key
/// propagates.
pub fn hmac(
    message: &OpValue,
    key: &OpValue,
    algorithm: &OpValue,
    encoding: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    use content_crypto::advanced::sha2::Sha512;
    use hmac::{Hmac, Mac};

    if message.is_null() || key.is_null() {
        return Ok(OpValue::null());
    }
    let text = message.as_str("hmac message")?;
    let secret = key.as_str("hmac key")?;
    let algorithm = if algorithm.is_null() { "sha256" } else { algorithm.as_str("hmac algorithm")? };
    let encoding = if encoding.is_null() { "hex" } else { encoding.as_str("hmac encoding")? };
    let refuse = |reason: String| OpError::InvalidArgument { operation: "hmac".to_string(), reason };

    let code: Vec<u8> = match algorithm.to_ascii_lowercase().as_str() {
        "sha256" => {
            let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|e| refuse(e.to_string()))?;
            mac.update(text.as_bytes());
            mac.finalize().into_bytes().to_vec()
        }
        "sha512" => {
            let mut mac = Hmac::<Sha512>::new_from_slice(secret.as_bytes()).map_err(|e| refuse(e.to_string()))?;
            mac.update(text.as_bytes());
            mac.finalize().into_bytes().to_vec()
        }
        other => return Err(refuse(format!("unknown algorithm {other}; use sha256 or sha512"))),
    };
    match encoding.to_ascii_lowercase().as_str() {
        "hex" => Ok(OpValue::string(bytes_to_hex(&code))),
        "base64" => Ok(OpValue::string(base64::engine::general_purpose::STANDARD.encode(code))),
        other => Err(refuse(format!("unknown encoding {other}; use hex or base64"))),
    }
}

/// Content identity of `input`: the digest AND the code that says what produced it.
///
/// `content_identity(input) -> "1f:<hex>"`. Null propagates, like every operator here.
///
/// ⛔ WHY THIS EXISTS BESIDE `hash`, WHICH ALREADY DOES BLAKE3. `hash(input, "blake3")` returns
/// `bytes_to_hex(digest)`, a BARE hex string. It is the right algorithm through the right owner
/// and it throws away the one thing that makes the value checkable: the multicodec code naming
/// what produced it. Whoever wants an identity out of it then writes the label themselves, in a
/// second expression, and that split is the exact defect this whole migration exists to close.
///
/// It produced real forged values. `"1f:" + hashlib.sha256(...)` shipped in four Python decoders,
/// `"1f:" + createHash("sha256")` in four JS files, one of them inside a function named
/// `canonicalMultihash`, so nobody read the body. Every one declared BLAKE3 and contained
/// SHA-256, and nothing downstream could tell, because trusting the prefix is the entire reason
/// a multihash carries one.
///
/// So this takes NO algorithm parameter, matching the decision the Rust owner already made and
/// wrote into its own docs: the algorithm choice lives in exactly one function. A caller cannot
/// hold the label and the digest apart, because it never receives them apart.
///
/// `hash` keeps its algorithm argument and its bare output, and that is correct: it serves
/// EXTERNAL interop, where an outside party defines both the algorithm and the encoding and this
/// system does not get to add a prefix. Minting a rival identity is the defect; honouring an
/// algorithm somebody else declares is the job. Two operators, two jobs, neither able to be
/// mistaken for the other at a call site.
pub fn content_identity(input: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if input.is_null() {
        return Ok(OpValue::null());
    }
    let text = input.as_str("content identity input")?;
    Ok(OpValue::string(
        content_crypto::Multihash::hash(text.as_bytes()).to_code_hex(),
    ))
}

/// Generic encode operator: encode(input, encoding) -> string
///
/// Dispatches to the registered encoder for the specified encoding.
/// Returns null if input is null.
pub fn encode(input: &OpValue, encoding: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if input.is_null() {
        return Ok(OpValue::null());
    }

    let text = input.as_str("encode input")?;
    let enc_str = encoding.as_str("encoding")?;

    let cap = ctx
        .capabilities
        .get::<EncodingCapability>()
        .ok_or_else(|| OpError::InvalidOperation {
            operation: "encode".to_string(),
            reason: "EncodingCapability not registered in context".to_string(),
        })?;

    let result = cap.encode(text, enc_str)?;
    Ok(OpValue::string(result))
}

/// Generic decode operator: decode(input, encoding) -> string
///
/// Dispatches to the registered decoder for the specified encoding.
/// Returns null if input is null.
pub fn decode(input: &OpValue, encoding: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if input.is_null() {
        return Ok(OpValue::null());
    }

    let text = input.as_str("decode input")?;
    let enc_str = encoding.as_str("encoding")?;

    let cap = ctx
        .capabilities
        .get::<EncodingCapability>()
        .ok_or_else(|| OpError::InvalidOperation {
            operation: "decode".to_string(),
            reason: "EncodingCapability not registered in context".to_string(),
        })?;

    let result = cap.decode(text, enc_str)?;
    Ok(OpValue::string(result))
}

// ============================================================================
// Hashing Functions (OLD — TO BE DELETED)
// ============================================================================

/// FNV-1a 64-bit hash — fast, deterministic, zero-dependency.
fn fnv1a_64(data: &[u8]) -> u64 {
    const FNV_OFFSET: u64 = 14695981039346656037;
    const FNV_PRIME: u64 = 1099511628211;

    let mut hash = FNV_OFFSET;
    for &byte in data {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

// ============================================================================
// Base64 Encoding/Decoding
// ============================================================================

// ============================================================================
// Hex Encoding/Decoding
// ============================================================================

// ============================================================================
// Helper Functions
// ============================================================================

/// Convert bytes to lowercase hexadecimal string.
fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        write!(&mut out, "{:02x}", b).unwrap();
    }
    out
}

/// Convert hexadecimal string to bytes.
fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, ()> {
    if !hex.len().is_multiple_of(2) {
        return Err(());
    }

    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for i in (0..hex.len()).step_by(2) {
        let byte = u8::from_str_radix(&hex[i..i + 2], 16).map_err(|_| ())?;
        bytes.push(byte);
    }

    Ok(bytes)
}

/// Simple MD5 implementation for legacy compatibility.
/// Uses the standard MD5 algorithm.
fn md5_hash(input: &[u8]) -> [u8; 16] {
    // MD5 constants
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];

    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
        0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
        0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];

    // Initialize variables
    let mut a0: u32 = 0x67452301;
    let mut b0: u32 = 0xefcdab89;
    let mut c0: u32 = 0x98badcfe;
    let mut d0: u32 = 0x10325476;

    // Pre-processing: adding padding bits
    let orig_len_bits = (input.len() as u64) * 8;
    let mut msg = input.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&orig_len_bits.to_le_bytes());

    // Process each 64-byte chunk
    for chunk in msg.chunks(64) {
        let mut m = [0u32; 16];
        for (i, c) in chunk.chunks(4).enumerate() {
            m[i] = u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        }

        let mut a = a0;
        let mut b = b0;
        let mut c = c0;
        let mut d = d0;

        for i in 0..64 {
            let (f, g) = if i < 16 {
                ((b & c) | ((!b) & d), i)
            } else if i < 32 {
                ((d & b) | ((!d) & c), (5 * i + 1) % 16)
            } else if i < 48 {
                (b ^ c ^ d, (3 * i + 5) % 16)
            } else {
                (c ^ (b | (!d)), (7 * i) % 16)
            };

            let f = f.wrapping_add(a).wrapping_add(K[i]).wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(f.rotate_left(S[i]));
        }

        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    let mut result = [0u8; 16];
    result[0..4].copy_from_slice(&a0.to_le_bytes());
    result[4..8].copy_from_slice(&b0.to_le_bytes());
    result[8..12].copy_from_slice(&c0.to_le_bytes());
    result[12..16].copy_from_slice(&d0.to_le_bytes());
    result
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc_4231_case_2() {
        let ctx = EvalContext::fast();
        let message = OpValue::string("what do ya want for nothing?");
        let key = OpValue::string("Jefe");
        let sha256 = hmac(&message, &key, &OpValue::null(), &OpValue::null(), &ctx).unwrap();
        assert_eq!(sha256.as_str("t").unwrap(), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        let sha512 = hmac(&message, &key, &OpValue::string("sha512"), &OpValue::string("hex"), &ctx).unwrap();
        assert_eq!(
            sha512.as_str("t").unwrap(),
            "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737"
        );
        let base64 = hmac(&message, &key, &OpValue::null(), &OpValue::string("base64"), &ctx).unwrap();
        assert_eq!(base64.as_str("t").unwrap(), "W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=");
        assert!(hmac(&OpValue::null(), &key, &OpValue::null(), &OpValue::null(), &ctx).unwrap().is_null());
        assert!(hmac(&message, &key, &OpValue::string("md5"), &OpValue::null(), &ctx).is_err());
    }

    fn ctx() -> EvalContext {
        let mut ctx = EvalContext::strict();
        // Register HashCapability and EncodingCapability for tests
        ctx.capabilities.register(HashCapability::new());
        ctx.capabilities.register(EncodingCapability::new());
        ctx
    }

    // ===== HASH CAPABILITY TESTS =====

    mod hash {
        use super::*;

        #[test]
        fn test_hash_capability_available_algorithms() {
            let cap = HashCapability::new();
            let algos = cap.available_algorithms();
            assert!(algos.contains(&"sha256".to_string()));
            assert!(algos.contains(&"md5".to_string()));
            assert!(algos.contains(&"fast".to_string()));
        }

        /// ⛔ THESE VECTORS WERE MINTED BY A DIFFERENT IMPLEMENTATION, WHICH IS THE WHOLE POINT.
        /// Produced by the Python owner, `canonical_multihash.py --text <value>`, and asserted
        /// here against the Rust owner. A suite that computes its expected value with the code
        /// under test cannot notice two implementations of one identity drifting apart, and this
        /// system has three of them: Rust, JS through a WASM binding, and Python.
        ///
        /// The four inputs are chosen so no two of them can pass for each other: empty (the case
        /// every hasher special-cases), short ASCII (the classic vector), multi-byte UTF-8 with
        /// an astral-plane character (which catches an encoding disagreement rather than a
        /// hashing one), and a payload crossing BLAKE3's 1024-byte chunk boundary (which catches
        /// a streaming-versus-oneshot disagreement that no short input can reach).
        #[test]
        fn content_identity_agrees_with_the_python_owner() {
            let ctx = EvalContext::default();
            let identity = |text: &str| {
                content_identity(&OpValue::string(text), &ctx)
                    .unwrap()
                    .as_str("v")
                    .unwrap()
                    .to_string()
            };

            assert_eq!(
                identity(""),
                "1f:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
            );
            assert_eq!(
                identity("abc"),
                "1f:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"
            );
            assert_eq!(
                identity("héllo wörld 🌍"),
                "1f:f351a4d8b019d952e021f287f768680e6cc63be8f763a72e1dc5d190566bf155"
            );
            // 1100 bytes, past BLAKE3's 1024-byte chunk boundary. No short input can catch a
            // streaming-versus-oneshot disagreement, because below one chunk every
            // implementation takes the same path.
            assert_eq!(
                identity(&"x".repeat(1100)),
                "1f:71a054672a9a3370af0d6ed84f3511df3cb0b1e163bca90183f1753b43af4385"
            );
        }

        /// The label is not something a caller can supply, remove or contradict, and that is the
        /// property being tested rather than the digest. `hash` hands back a bare digest on
        /// purpose, for external interop; this one cannot.
        #[test]
        fn content_identity_carries_its_code_and_hash_does_not() {
            let ctx = EvalContext::default();
            let identified = content_identity(&OpValue::string("abc"), &ctx).unwrap();
            let identified = identified.as_str("v").unwrap();
            assert!(identified.starts_with("1f:"), "{identified}");

            let bare = HashCapability::new().hash("abc", "blake3").unwrap();
            assert!(!bare.contains(':'), "{bare}");
            assert_eq!(identified, format!("1f:{bare}"));

            assert!(content_identity(&OpValue::null(), &ctx).unwrap().is_null());
        }

        #[test]
        fn test_hash_sha256_golden() {
            let cap = HashCapability::new();
            // SHA-256 of empty string (well-known test vector)
            let result = cap.hash("", "sha256").unwrap();
            assert_eq!(
                result,
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            );
            // SHA-256 of "abc"
            let result = cap.hash("abc", "sha256").unwrap();
            assert_eq!(
                result,
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            );
        }

        #[test]
        fn test_hash_md5_golden() {
            let cap = HashCapability::new();
            // MD5 of empty string
            let result = cap.hash("", "md5").unwrap();
            assert_eq!(result, "d41d8cd98f00b204e9800998ecf8427e");
            // MD5 of "abc"
            let result = cap.hash("abc", "md5").unwrap();
            assert_eq!(result, "900150983cd24fb0d6963f7d28e17f72");
        }

        #[test]
        fn test_hash_fast_deterministic() {
            let cap = HashCapability::new();
            let input = "viewer123:ws:default:/about:groupA";
            let r1 = cap.hash(input, "fast").unwrap();
            let r2 = cap.hash(input, "fast").unwrap();
            assert_eq!(r1, r2);
        }

        #[test]
        fn test_hash_fast_returns_numeric_string() {
            let cap = HashCapability::new();
            let result = cap.hash("test", "fast").unwrap();
            assert!(result.parse::<u64>().is_ok());
        }

        #[test]
        fn test_hash_unknown_algorithm() {
            let cap = HashCapability::new();
            let result = cap.hash("test", "unknown-algo");
            assert!(result.is_err());
            let err = result.unwrap_err();
            assert!(err.to_string().contains("unknown-algo"));
            assert!(err.to_string().contains("not registered"));
        }

        #[test]
        fn test_hash_generic_operator_sha256() {
            let ctx = ctx();
            let input = OpValue::string("");
            let algo = OpValue::string("sha256");
            let result = hash(&input, &algo, &ctx).unwrap();
            assert_eq!(
                result.as_str("test").unwrap(),
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            );
        }

        #[test]
        fn test_hash_generic_operator_md5() {
            let ctx = ctx();
            let input = OpValue::string("abc");
            let algo = OpValue::string("md5");
            let result = hash(&input, &algo, &ctx).unwrap();
            assert_eq!(
                result.as_str("test").unwrap(),
                "900150983cd24fb0d6963f7d28e17f72"
            );
        }

        #[test]
        fn test_hash_generic_operator_fast() {
            let ctx = ctx();
            let input = OpValue::string("test");
            let algo = OpValue::string("fast");
            let result = hash(&input, &algo, &ctx).unwrap();
            let s = result.as_str("test").unwrap();
            assert!(s.parse::<u64>().is_ok());
        }

        #[test]
        fn test_hash_generic_operator_null_input() {
            let ctx = ctx();
            let input = OpValue::null();
            let algo = OpValue::string("sha256");
            let result = hash(&input, &algo, &ctx).unwrap();
            assert!(result.is_null());
        }

        #[test]
        fn test_hash_generic_operator_unknown_algorithm() {
            let ctx = ctx();
            let input = OpValue::string("test");
            let algo = OpValue::string("unknown");
            let result = hash(&input, &algo, &ctx);
            assert!(result.is_err());
        }
    }

    // ===== ENCODING CAPABILITY TESTS =====

    mod encoding {
        use super::*;

        #[test]
        fn test_encoding_capability_available_encodings() {
            let cap = EncodingCapability::new();
            let encodings = cap.available_encodings();
            assert!(encodings.contains(&"base64".to_string()));
            assert!(encodings.contains(&"base64url".to_string()));
            assert!(encodings.contains(&"hex".to_string()));
        }

        #[test]
        fn test_base64_roundtrip() {
            let cap = EncodingCapability::new();
            let original = "The quick brown fox jumps over the lazy dog";
            let encoded = cap.encode(original, "base64").unwrap();
            let decoded = cap.decode(&encoded, "base64").unwrap();
            assert_eq!(decoded, original);
        }

        #[test]
        fn test_base64_golden() {
            let cap = EncodingCapability::new();
            let encoded = cap.encode("Hello, World!", "base64").unwrap();
            assert_eq!(encoded, "SGVsbG8sIFdvcmxkIQ==");
        }

        #[test]
        fn test_base64url_roundtrip() {
            let cap = EncodingCapability::new();
            let original = "test+with/special=chars";
            let encoded = cap.encode(original, "base64url").unwrap();
            let decoded = cap.decode(&encoded, "base64url").unwrap();
            assert_eq!(decoded, original);
            // Verify URL-safe alphabet is used
            assert!(!encoded.contains('+'));
            assert!(!encoded.contains('/'));
        }

        #[test]
        fn test_hex_roundtrip() {
            let cap = EncodingCapability::new();
            let original = "Hello!";
            let encoded = cap.encode(original, "hex").unwrap();
            let decoded = cap.decode(&encoded, "hex").unwrap();
            assert_eq!(decoded, original);
        }

        #[test]
        fn test_hex_golden() {
            let cap = EncodingCapability::new();
            let encoded = cap.encode("abc", "hex").unwrap();
            assert_eq!(encoded, "616263");
        }

        #[test]
        fn test_encode_unknown_encoding() {
            let cap = EncodingCapability::new();
            let result = cap.encode("test", "unknown-enc");
            assert!(result.is_err());
            let err = result.unwrap_err();
            assert!(err.to_string().contains("unknown-enc"));
        }

        #[test]
        fn test_decode_unknown_encoding() {
            let cap = EncodingCapability::new();
            let result = cap.decode("test", "unknown-enc");
            assert!(result.is_err());
        }

        #[test]
        fn test_decode_invalid_base64() {
            let cap = EncodingCapability::new();
            let result = cap.decode("not valid base64!!!", "base64");
            assert!(result.is_err());
        }

        #[test]
        fn test_decode_invalid_hex() {
            let cap = EncodingCapability::new();
            let result = cap.decode("xyz", "hex");
            assert!(result.is_err());
        }

        #[test]
        fn test_encode_generic_operator_base64() {
            let ctx = ctx();
            let input = OpValue::string("Hello, World!");
            let enc = OpValue::string("base64");
            let result = encode(&input, &enc, &ctx).unwrap();
            assert_eq!(result.as_str("test").unwrap(), "SGVsbG8sIFdvcmxkIQ==");
        }

        #[test]
        fn test_decode_generic_operator_base64() {
            let ctx = ctx();
            let input = OpValue::string("SGVsbG8sIFdvcmxkIQ==");
            let enc = OpValue::string("base64");
            let result = decode(&input, &enc, &ctx).unwrap();
            assert_eq!(result.as_str("test").unwrap(), "Hello, World!");
        }

        #[test]
        fn test_encode_generic_operator_hex() {
            let ctx = ctx();
            let input = OpValue::string("abc");
            let enc = OpValue::string("hex");
            let result = encode(&input, &enc, &ctx).unwrap();
            assert_eq!(result.as_str("test").unwrap(), "616263");
        }

        #[test]
        fn test_decode_generic_operator_hex() {
            let ctx = ctx();
            let input = OpValue::string("616263");
            let enc = OpValue::string("hex");
            let result = decode(&input, &enc, &ctx).unwrap();
            assert_eq!(result.as_str("test").unwrap(), "abc");
        }

        #[test]
        fn test_encode_generic_operator_null_input() {
            let ctx = ctx();
            let input = OpValue::null();
            let enc = OpValue::string("base64");
            let result = encode(&input, &enc, &ctx).unwrap();
            assert!(result.is_null());
        }

        #[test]
        fn test_decode_generic_operator_null_input() {
            let ctx = ctx();
            let input = OpValue::null();
            let enc = OpValue::string("base64");
            let result = decode(&input, &enc, &ctx).unwrap();
            assert!(result.is_null());
        }
    }

    // ===== ADVERSARIAL TESTS =====

    mod adversarial {
        use super::*;

        #[test]
        fn test_double_hash_composition() {
            let ctx = ctx();
            let input = OpValue::string("test");
            let sha = OpValue::string("sha256");

            // Hash once
            let hash1 = hash(&input, &sha, &ctx).unwrap();

            // Hash the result (should work without error)
            let hash2 = hash(&hash1, &sha, &ctx).unwrap();
            assert!(!hash2.is_null());
        }

        #[test]
        fn test_cross_encoding_transcode() {
            let ctx = ctx();

            let original = "Hello!";
            let input = OpValue::string(original);
            let base64_enc = OpValue::string("base64");
            let hex_enc = OpValue::string("hex");

            // Encode to base64
            let b64 = encode(&input, &base64_enc, &ctx).unwrap();

            // Encode base64 result to hex
            let hex = encode(&b64, &hex_enc, &ctx).unwrap();

            // Decode hex back
            let from_hex = decode(&hex, &hex_enc, &ctx).unwrap();

            // Decode base64 back
            let result = decode(&from_hex, &base64_enc, &ctx).unwrap();

            // Should get original back
            assert_eq!(result.as_str("test").unwrap(), original);
        }
    }
}
