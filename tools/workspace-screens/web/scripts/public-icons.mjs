// The icons are the files of the tool that draws the app icon in every size (draw-the-apps-icon-in-every-size-from/assets).
// The web icon DATA also feeds the cross-platform generator. Keep those existing bytes in the pinned
// workspace tree; files.json declares only these root-file aliases public to the native asset owner.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import icons from '../src/public-icons.json' with { type: 'json' };

export function writePublicIcons(named) {
  mkdirSync(named, { recursive: true });
  return Object.fromEntries(icons.map(({ name }) => {
    const bytes = readFileSync(new URL(`../../../draw-the-apps-icon-in-every-size-from/assets/${name}`, import.meta.url));
    const extension = extname(name);
    const file = `public-${basename(name, extension)}-${bytesToHex(blake3(bytes))}${extension}`;
    writeFileSync(join(named, file), bytes);
    return [`/${name}`, `/workspace/named/${file}`];
  }));
}
