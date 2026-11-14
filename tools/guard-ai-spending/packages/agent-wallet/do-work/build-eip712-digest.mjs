#!/usr/bin/env node
// package-set://bitfield-studio/packages/agent-wallet/do-work/build-eip712-digest.mjs
//
// THE GENERIC EIP-712 DIGEST BUILDER (pure, no secret, no network).
//
// Turns a DATA-supplied EIP-712 typed-data document {domain, types, primaryType,
// message} into the 32-byte signing DIGEST:
//
//     digest = keccak256( 0x19 0x01 ‖ domainSeparator ‖ hashStruct(primaryType, message) )
//
// This is the EIP-712 standard (https://eips.ethereum.org/EIPS/eip-712) transcribed
// exactly. It is the PUBLIC half of the two-step signing split:
//   STEP 1 (THIS script): build the digest from public request data — NO private key.
//   STEP 2 (credentials-vault `sign` op): sign the digest INSIDE the vault — key never leaves.
//   STEP 3 (executor computed-injection seam): put the signature in the HTTP header.
//
// Because the typed-data document is DATA, this ONE script serves EVERY EIP-712
// signer with ZERO code change (L069 generative primitive):
//   - x402 ERC-3009 `TransferWithAuthorization` (the EVM USDC payment authorization)
//   - Polymarket CTF-Exchange V2 `Order` (and the Neg-Risk exchange variant)
//   - any future EIP-712 venue — it's a new DATA descriptor, never a new code path.
//
// ## Non-Negotiable Invariants (1000x)
//
//   1. NO private key, NO secret, NO network. Input is the public typed-data only.
//      The output is a digest; signing is the vault's job (HSM pattern).
//   2. NO venue vocabulary in code. There is no "x402" and no "polymarket" branch —
//      the domain, the type-set, the primaryType, and the message are all DATA. The
//      script knows only "EIP-712 typed-data → digest".
//   3. NO closed type enum. EIP-712 atomic types (uintN/intN/bytesN/bool/address/
//      bytes/string) are handled by the SPEC's encoding rules, structs/arrays by
//      recursion — adding a new struct type needs ZERO code change here.
//   4. Self-contained: a pure-JS keccak-256 (FIPS-202 Keccak-f[1600], Ethereum 0x01
//      pad-domain) is inlined — NO npm install, NO @noble dependency at runtime. A
//      known-answer self-test runs at startup; a transcription bug fails LOUD (exit 2),
//      it never emits a wrong digest silently.
//   5. Deterministic: same typed-data in → same digest out, byte-for-byte.
//
// ## Contract (positional — process.argv[2..] under `node build-eip712-digest.mjs ...`)
//
//   argv[2] = output path for the result JSON
//   argv[3] = typed-data JSON text — the EIP-712 document:
//             {
//               "domain":  { "name", "version", "chainId", "verifyingContract", "salt"? },
//               "types":   { "<StructName>": [ { "name", "type" }, ... ], ... },
//                          // EIP712Domain is OPTIONAL — if omitted it is derived from
//                          // which domain fields are present (the standard field order).
//               "primaryType": "<StructName>",
//               "message": { ...the struct field values... }
//             }
//             Field values: numbers/decimal-strings/0x-hex for uint/int, 0x-hex for
//             address/bytesN/bytes, JS strings for `string`, arrays for `T[]`.
//
// ## Output (stdout AND the output file)
//
//   { "ok": true,
//     "digest_hex": "0x<64 hex>",      // the 32-byte EIP-712 digest
//     "digest_b64": "<base64>",        // STANDARD base64 of the 32 digest bytes
//                                      //   -> feed straight into the vault sign-op's
//                                      //      message_b64 with scheme:"secp256k1"
//     "domain_separator_hex": "0x...", // (debug) the keccak256 of the domain
//     "struct_hash_hex": "0x...",      // (debug) hashStruct(primaryType, message)
//     "primary_type": "<StructName>" }
//
//   On failure: { "ok": false, "error": "<message>" } + a non-zero exit (2).

import { writeFileSync } from "node:fs";

// ============================================================================
// keccac-256 — FIPS-202 Keccak-f[1600], rate 1088 bits (136 bytes), Ethereum
// 0x01 pad-domain. Pure JS, self-contained. This is the standard permutation
// transcribed; the self-test below guards against a transcription bug.
// ============================================================================

// Round constants (RC) and rho offsets for Keccak-f[1600], as 64-bit values split
// into [low32, high32] little-endian halves (JS has no native 64-bit ints we can
// bit-twiddle, so every lane is a {lo, hi} pair).
const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000],
  [0x80008000, 0x80000000], [0x0000808b, 0x00000000], [0x80000001, 0x00000000],
  [0x80008081, 0x80000000], [0x00008009, 0x80000000], [0x0000008a, 0x00000000],
  [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000],
  [0x00008003, 0x80000000], [0x00008002, 0x80000000], [0x00000080, 0x80000000],
  [0x0000800a, 0x00000000], [0x8000000a, 0x80000000], [0x80008081, 0x80000000],
  [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];
// rho rotation offsets + pi lane permutation, DERIVED from the FIPS-202 recurrence
// rather than hand-copied — zero transcription risk. The spec walks the lanes
// (x,y) starting at (1,0) for 24 steps; at step t the rho offset is the t-th
// triangular number mod 64, and pi maps lane (x,y) -> (y, (2x+3y) mod 5).
// RHO[i] / PI[i] are indexed by the lane index i = x + 5*y.
const RHO = new Array(25).fill(0);
const PI = new Array(25);
PI[0] = 0; // lane (0,0) is fixed
(function deriveRhoPi() {
  let x = 1, y = 0;
  for (let t = 0; t < 24; t++) {
    const src = x + 5 * y;
    RHO[src] = (((t + 1) * (t + 2)) / 2) % 64;
    const nx = y;
    const ny = (2 * x + 3 * y) % 5;
    PI[src] = nx + 5 * ny; // lane src moves to position PI[src]
    x = nx;
    y = ny;
  }
})();

// Rotate a 64-bit lane {lo,hi} left by n bits (0..63).
function rotl64(lo, hi, n) {
  n &= 63;
  if (n === 0) return [lo >>> 0, hi >>> 0];
  if (n < 32) {
    const nlo = ((lo << n) | (hi >>> (32 - n))) >>> 0;
    const nhi = ((hi << n) | (lo >>> (32 - n))) >>> 0;
    return [nlo, nhi];
  }
  // n >= 32: swap halves then rotate by n-32.
  const m = n - 32;
  if (m === 0) return [hi >>> 0, lo >>> 0];
  const nlo = ((hi << m) | (lo >>> (32 - m))) >>> 0;
  const nhi = ((lo << m) | (hi >>> (32 - m))) >>> 0;
  return [nlo, nhi];
}

// The Keccak-f[1600] permutation over a state of 25 lanes (each {lo,hi}).
function keccakF(state) {
  const C = new Array(5);
  const D = new Array(5);
  for (let round = 0; round < 24; round++) {
    // θ (theta)
    for (let x = 0; x < 5; x++) {
      let lo = state[x][0], hi = state[x][1];
      for (let y = 1; y < 5; y++) {
        lo ^= state[x + 5 * y][0];
        hi ^= state[x + 5 * y][1];
      }
      C[x] = [lo >>> 0, hi >>> 0];
    }
    for (let x = 0; x < 5; x++) {
      const [rlo, rhi] = rotl64(C[(x + 1) % 5][0], C[(x + 1) % 5][1], 1);
      D[x] = [(C[(x + 4) % 5][0] ^ rlo) >>> 0, (C[(x + 4) % 5][1] ^ rhi) >>> 0];
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y][0] = (state[x + 5 * y][0] ^ D[x][0]) >>> 0;
        state[x + 5 * y][1] = (state[x + 5 * y][1] ^ D[x][1]) >>> 0;
      }
    }
    // ρ (rho) + π (pi): rotate each lane, then permute lane positions.
    const B = new Array(25);
    for (let i = 0; i < 25; i++) {
      const [rlo, rhi] = rotl64(state[i][0], state[i][1], RHO[i]);
      B[PI[i]] = [rlo, rhi];
    }
    // χ (chi)
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const b0 = B[x + 5 * y];
        const b1 = B[((x + 1) % 5) + 5 * y];
        const b2 = B[((x + 2) % 5) + 5 * y];
        state[x + 5 * y][0] = (b0[0] ^ (~b1[0] & b2[0])) >>> 0;
        state[x + 5 * y][1] = (b0[1] ^ (~b1[1] & b2[1])) >>> 0;
      }
    }
    // ι (iota)
    state[0][0] = (state[0][0] ^ RC[round][0]) >>> 0;
    state[0][1] = (state[0][1] ^ RC[round][1]) >>> 0;
  }
  return state;
}

// keccak256(bytes: Uint8Array) -> Uint8Array(32).
function keccak256(input) {
  const RATE = 136; // 1088 bits / 8 = 136 bytes
  const state = [];
  for (let i = 0; i < 25; i++) state.push([0, 0]);

  // Absorb full rate-blocks, with Ethereum's 0x01 ‖ pad10*1 padding into a copy.
  const padLen = RATE - (input.length % RATE);
  const padded = new Uint8Array(input.length + padLen);
  padded.set(input);
  padded[input.length] ^= 0x01;       // domain separation (Keccak, not SHA3-0x06)
  padded[padded.length - 1] ^= 0x80;  // final pad bit

  for (let off = 0; off < padded.length; off += RATE) {
    // XOR this block into the state (little-endian lanes), then permute.
    for (let i = 0; i < RATE; i++) {
      const byte = padded[off + i];
      const lane = (i / 8) | 0;
      const bytePos = i % 8;
      if (bytePos < 4) {
        state[lane][0] = (state[lane][0] ^ (byte << (8 * bytePos))) >>> 0;
      } else {
        state[lane][1] = (state[lane][1] ^ (byte << (8 * (bytePos - 4)))) >>> 0;
      }
    }
    keccakF(state);
  }

  // Squeeze 32 bytes (fits within the first rate block — no extra permute needed).
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const lane = (i / 8) | 0;
    const bytePos = i % 8;
    const half = bytePos < 4 ? state[lane][0] : state[lane][1];
    out[i] = (half >>> (8 * (bytePos % 4))) & 0xff;
  }
  return out;
}

// ============================================================================
// byte / hex helpers
// ============================================================================

function hexToBytes(hex) {
  let s = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) s = "0" + s;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
    if (Number.isNaN(out[i])) throw new Error(`invalid hex: ${hex}`);
  }
  return out;
}

function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return "0x" + s;
}

function utf8Bytes(str) {
  return new Uint8Array(Buffer.from(str, "utf8"));
}

function concatBytes(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// Encode a non-negative big integer (from number | decimal-string | 0x-hex) into a
// 32-byte big-endian word. Two's-complement for negatives (int types).
function toUint256Word(value, signed) {
  let v;
  if (typeof value === "bigint") v = value;
  else if (typeof value === "number") v = BigInt(value);
  else if (typeof value === "string") {
    v = value.startsWith("0x") || value.startsWith("0X") ? BigInt(value) : BigInt(value);
  } else {
    throw new Error(`cannot encode numeric from ${typeof value}`);
  }
  if (signed && v < 0n) {
    v = (1n << 256n) + v; // two's complement in 256 bits
  }
  const out = new Uint8Array(32);
  let tmp = v & ((1n << 256n) - 1n);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
  return out;
}

// Left-pad bytes to a 32-byte word (address, bytesN — addresses are right-aligned).
function leftPad32(bytes) {
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}
// Right-pad bytes to a 32-byte word (fixed bytesN are left-aligned per the spec).
function rightPad32(bytes) {
  const out = new Uint8Array(32);
  out.set(bytes.slice(0, 32), 0);
  return out;
}

// ============================================================================
// EIP-712 encoding (the spec, transcribed — generic over the DATA type-set)
// ============================================================================

const ATOMIC = /^(?:address|bool|string|bytes\d*|uint\d*|int\d*)$/;

function isDynamic(type) {
  return type === "string" || type === "bytes";
}
function isArray(type) {
  return type.endsWith("]");
}
function arrayElementType(type) {
  return type.slice(0, type.lastIndexOf("["));
}

// Collect the set of struct types `primaryType` depends on (for encodeType).
function findDependencies(primaryType, types, found = new Set()) {
  const base = primaryType.replace(/\[\d*\]$/, "");
  if (found.has(base) || !types[base]) return found;
  found.add(base);
  for (const field of types[base]) {
    findDependencies(field.type, types, found);
  }
  return found;
}

// encodeType(primaryType) per EIP-712: primary first, then the rest alphabetically.
function encodeType(primaryType, types) {
  const deps = findDependencies(primaryType, types);
  deps.delete(primaryType.replace(/\[\d*\]$/, ""));
  const ordered = [primaryType.replace(/\[\d*\]$/, ""), ...[...deps].sort()];
  let out = "";
  for (const t of ordered) {
    const fields = types[t].map((f) => `${f.type} ${f.name}`).join(",");
    out += `${t}(${fields})`;
  }
  return out;
}

function typeHash(primaryType, types) {
  return keccak256(utf8Bytes(encodeType(primaryType, types)));
}

// encodeData: the 32-byte-word concatenation of the type hash + each field's
// encoded value, per the EIP-712 `encodeData` rules.
function encodeData(primaryType, data, types) {
  const words = [typeHash(primaryType, types)];
  for (const field of types[primaryType]) {
    words.push(encodeField(field.type, data[field.name], types));
  }
  return concatBytes(...words);
}

// hashStruct(s) = keccak256(encodeData(s)).
function hashStruct(primaryType, data, types) {
  return keccak256(encodeData(primaryType, data, types));
}

// encodeField: produce the 32-byte word for ONE field value of `type`.
function encodeField(type, value, types) {
  // struct → hashStruct (recursive)
  if (types[type]) {
    return hashStruct(type, value, types);
  }
  // array T[] or T[n] → keccak256 of the concatenated encoded elements
  if (isArray(type)) {
    const elemType = arrayElementType(type);
    if (!Array.isArray(value)) throw new Error(`expected array for ${type}`);
    const encoded = value.map((v) => encodeField(elemType, v, types));
    return keccak256(concatBytes(...encoded));
  }
  if (type === "string") {
    return keccak256(utf8Bytes(value == null ? "" : String(value)));
  }
  if (type === "bytes") {
    return keccak256(hexToBytes(value == null ? "0x" : value));
  }
  if (type === "address") {
    return leftPad32(hexToBytes(value).slice(-20));
  }
  if (type === "bool") {
    return toUint256Word(value ? 1 : 0, false);
  }
  if (type.startsWith("bytes")) {
    // fixed bytesN — left-aligned 32-byte word
    return rightPad32(hexToBytes(value));
  }
  if (type.startsWith("uint")) {
    return toUint256Word(value, false);
  }
  if (type.startsWith("int")) {
    return toUint256Word(value, true);
  }
  throw new Error(`unsupported EIP-712 type: ${type}`);
}

// The EIP712Domain field order is fixed by the standard; derive it from which
// domain fields are present if the caller didn't supply an explicit EIP712Domain.
const DOMAIN_FIELD_ORDER = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
];

function deriveDomainType(domain) {
  return DOMAIN_FIELD_ORDER.filter((f) => domain[f.name] !== undefined && domain[f.name] !== null);
}

// The full EIP-712 digest: keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(primary)).
function eip712Digest(doc) {
  const { domain, message, primaryType } = doc;
  const types = { ...doc.types };
  if (!types.EIP712Domain) types.EIP712Domain = deriveDomainType(domain);
  if (!primaryType) throw new Error("primaryType is required");
  if (!types[primaryType]) throw new Error(`types is missing the primaryType '${primaryType}'`);

  const domainSeparator = hashStruct("EIP712Domain", domain, types);
  const structHash = hashStruct(primaryType, message, types);
  const digest = keccak256(concatBytes(new Uint8Array([0x19, 0x01]), domainSeparator, structHash));
  return { digest, domainSeparator, structHash };
}

// ============================================================================
// Startup self-test — a transcription bug must fail LOUD, never emit a bad digest.
// ============================================================================

function selfTest() {
  // keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
  const empty = bytesToHex(keccak256(new Uint8Array(0)));
  if (empty !== "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") {
    throw new Error(`keccak256 self-test FAILED (empty): ${empty}`);
  }
  // keccak256("abc") = 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
  const abc = bytesToHex(keccak256(utf8Bytes("abc")));
  if (abc !== "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45") {
    throw new Error(`keccak256 self-test FAILED (abc): ${abc}`);
  }
  // EIP-712 KAT — the canonical "Mail" example from the EIP-712 spec.
  // Expected hashStruct(EIP712Domain) and final digest are published by the spec.
  const mail = {
    domain: {
      name: "Ether Mail",
      version: "1",
      chainId: 1,
      verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
    },
    types: {
      Person: [
        { name: "name", type: "string" },
        { name: "wallet", type: "address" },
      ],
      Mail: [
        { name: "from", type: "Person" },
        { name: "to", type: "Person" },
        { name: "contents", type: "string" },
      ],
    },
    primaryType: "Mail",
    message: {
      from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
      to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
      contents: "Hello, Bob!",
    },
  };
  const { digest } = eip712Digest(mail);
  const got = bytesToHex(digest);
  const want = "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2";
  if (got !== want) {
    throw new Error(`EIP-712 self-test FAILED (Mail): got ${got} want ${want}`);
  }
}

// ============================================================================
// main
// ============================================================================

function fail(msg) {
  const out = { ok: false, error: String(msg) };
  try {
    if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out));
  } catch (_) {}
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(2);
}

function main() {
  try {
    selfTest();
  } catch (e) {
    fail(`crypto self-test failed — refusing to emit a digest: ${e.message}`);
    return;
  }

  const outPath = process.argv[2];
  if (!outPath) fail("argv[2] (output path) is required");

  let doc;
  try {
    doc = JSON.parse(process.argv[3] || "");
  } catch (e) {
    fail(`argv[3] (typed-data JSON) is not valid JSON: ${e.message}`);
    return;
  }
  if (!doc || typeof doc !== "object") fail("typed-data document must be an object");
  if (!doc.domain || typeof doc.domain !== "object") fail("typed-data.domain is required");
  if (!doc.types || typeof doc.types !== "object") fail("typed-data.types is required");
  if (!doc.message || typeof doc.message !== "object") fail("typed-data.message is required");

  let result;
  try {
    result = eip712Digest(doc);
  } catch (e) {
    fail(`EIP-712 encoding failed: ${e.message}`);
    return;
  }

  const out = {
    ok: true,
    digest_hex: bytesToHex(result.digest),
    digest_b64: Buffer.from(result.digest).toString("base64"),
    domain_separator_hex: bytesToHex(result.domainSeparator),
    struct_hash_hex: bytesToHex(result.structHash),
    primary_type: doc.primaryType,
  };
  writeFileSync(outPath, JSON.stringify(out));
  process.stdout.write(JSON.stringify(out) + "\n");
}

main();
