import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';

/** Native reads return code:hex; write preconditions require the full wire multihash. */
export function currentReadPrecondition(read: Record<string, unknown>): string | null {
  if (read.found === false) return null;
  // Current payload hashes use BLAKE3-256. Never turn an unreadable value into absence.
  if (read.found !== true || typeof read.content_hash !== 'string'
    || !/^1f:[0-9a-f]{64}$/.test(read.content_hash)) {
    throw new Error('Walkthrough state could not be verified. Try again.');
  }
  let binary = '';
  for (const byte of makeMultihashEncodedBytesFromCodeHex(read.content_hash)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
