// Canonical BLAKE3 multihash helpers shared by Meaning Search process leaves.
// Workshop seam: the BLAKE3 owner here is tools/content-identity, and canonical text is checked as exactly the form
// the error below names, as the package's Python twin checks it.
import { makeHashCodeHexFromBytes } from '../../../content-identity/read-data/identity.mjs';

export function isCanonicalMultihash(value) {
  if (typeof value !== 'string' || value.length !== 67 || !value.startsWith('1f:')) return false;
  return /^1f:[0-9a-f]{64}$/.test(value);
}

export function requireCanonicalMultihash(value, label) {
  if (!isCanonicalMultihash(value)) {
    throw new ValueError(`${label} must be canonical multihash text (1f:<64 lowercase hex>)`);
  }
  return value;
}

export function mintCanonicalMultihashOfBytes(value) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("canonical multihash input must be Uint8Array bytes");
  }
  return makeHashCodeHexFromBytes(value);
}

export function mintCanonicalMultihashOfText(value) {
  if (typeof value !== "string") {
    throw new TypeError("canonical multihash text input must be a string");
  }
  return mintCanonicalMultihashOfBytes(new TextEncoder().encode(value));
}

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValueError";
  }
}
