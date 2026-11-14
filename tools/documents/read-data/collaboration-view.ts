import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Stable, room-safe view tag for one document address. The room already owns membership checks. */
export function documentCollaborationView(address: string): string {
  return `document-${bytesToHex(blake3(new TextEncoder().encode(address)))}`;
}
