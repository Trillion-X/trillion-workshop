// The name one value is sealed under in a locked box (src/held-values.mjs). The vault accepts only [a-zA-Z0-9_-], so a
// name made of anything else (`origin:<id>`, a URL, a person's words) goes in as its UTF-8 bytes in hex after its kind.
import { bytesToHex } from '@noble/hashes/utils.js';

/** `boxName('storage-key', 'archive')` -> `storage-key-61726368697665`. */
export const boxName = (kind, name) => `${kind}-${bytesToHex(new TextEncoder().encode(String(name)))}`;
