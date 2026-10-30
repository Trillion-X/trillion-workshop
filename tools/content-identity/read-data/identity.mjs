// tools/content-identity/read-data/identity.mjs
//
// The one BLAKE3 identity of exact bytes, `1f:` and 64 hex digits, from the bytes at once or from ordered chunks
// without collecting them. Pure: no file, account or network operation; a reader hands in bytes or chunks.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Canonical internal identity for exact bytes. */
export function makeHashCodeHexFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Content identity requires bytes.');
  return `1f:${bytesToHex(blake3(bytes))}`;
}

/** Same identity from ordered byte chunks, without collecting the input. */
export function makeHashCodeHexFromChunks(chunks) {
  const hash = blake3.create();
  for (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('Content identity requires byte chunks.');
    hash.update(chunk);
  }
  return `1f:${bytesToHex(hash.digest())}`;
}
