// packages/live-namespace/read-data/expected-current-from-content-hash.mjs
//
// PURPOSE
// Turn the `content_hash` a read-current reply reports into the `expected_current` a guarded
// write-batch entry requires. Two spellings of ONE multihash, decided by two different owners,
// joined in exactly one place.
//
// THE TWO SPELLINGS, read off their owners rather than guessed
//   read side   `content_hash: "<code hex>:<digest hex>"`
//               bitfield-crypto/src/multihash.rs `to_code_hex`: format!("{:x}:{}", code, hex(digest))
//   write side  `expected_current: { payload_hash_base64: <base64 of the multihash WIRE bytes> }`
//               engine-operation-target/src/lib.rs `expected_current_value`: base64 decode, then
//               `Multihash::decode`, which is varint(code) ++ varint(digest length) ++ digest
//               (bitfield-crypto/src/multihash.rs `encode`).
//
// A guarded write is what turns "two writers raced" from a silent last-one-wins into an explicit
// `FE_EXPECTED_CURRENT_MISMATCH`, so this small function is what makes the P151 write/write
// conflict OBSERVABLE at all.

const CODE_HEX = /^([0-9a-f]+):([0-9a-f]+)$/;

function varint(value) {
  const out = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0n);
  return out;
}

/** `"1f:d00c…"` -> `{ payload_hash_base64 }` as the engine's write precondition wants it. */
export function expectedCurrentFromContentHash(contentHash) {
  if (contentHash == null) return { payload_hash_base64: null };
  const match = CODE_HEX.exec(String(contentHash));
  if (match == null) {
    throw new Error(`content_hash must be <code hex>:<digest hex>, received ${JSON.stringify(contentHash)}`);
  }
  const code = BigInt(`0x${match[1]}`);
  const digest = Buffer.from(match[2], "hex");
  if (digest.length * 2 !== match[2].length) {
    throw new Error(`content_hash digest is not whole bytes: ${JSON.stringify(contentHash)}`);
  }
  const wire = Buffer.from([...varint(code), ...varint(digest.length), ...digest]);
  return { payload_hash_base64: wire.toString("base64") };
}

/** The inverse, so a test can prove the round trip rather than trust it. */
export function contentHashFromExpectedCurrent({ payload_hash_base64 }) {
  if (payload_hash_base64 == null) return null;
  const wire = Buffer.from(payload_hash_base64, "base64");
  let position = 0;
  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = wire[position];
      if (byte === undefined) throw new Error("truncated varint");
      position += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  const code = readVarint();
  const length = Number(readVarint());
  const digest = wire.subarray(position, position + length);
  if (digest.length !== length) throw new Error("digest shorter than its declared length");
  return `${code.toString(16)}:${digest.toString("hex")}`;
}
