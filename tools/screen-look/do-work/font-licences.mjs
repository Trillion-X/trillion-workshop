// tools/screen-look/do-work/font-licences.mjs
// The font licence gate. Every font file the repository tracks (.woff, .woff2, .ttf, .otf) must be a face file of the
// kit's own folder that licences.json names for the web. A font anywhere else, a file the licence DATA does not name,
// or a face whose licensed_for lacks "web" is refused, one line each; none means the gate passes.
// Usage: node tools/screen-look/do-work/font-licences.mjs [REPOSITORY]   (exit 1 on any refusal)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const KIT_FONTS = 'tools/screen-look/show/fonts/';
const FONT_FILE = /\.(woff2?|ttf|otf)$/i;

export const readLicences = (root = ROOT) => JSON.parse(readFileSync(resolve(root, KIT_FONTS, 'licences.json'), 'utf8'));
export const trackedPaths = (root = ROOT) =>
  execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);

export function fontLicenceRefusals(paths, licences) {
  const faceOf = new Map(licences.faces.flatMap(face => face.files.map(file => [file, face])));
  const refusals = [];
  for (const path of paths.filter(item => FONT_FILE.test(item))) {
    const inKit = path.startsWith(KIT_FONTS) && !path.slice(KIT_FONTS.length).includes('/');
    const face = inKit ? faceOf.get(basename(path)) : undefined;
    if (!face) refusals.push(`${path}: no face in ${KIT_FONTS}licences.json names this file`);
    else if (!face.licensed_for.includes('web')) refusals.push(`${path}: ${face.family} is not licensed for the web`);
  }
  return refusals;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? ROOT);
  const refusals = fontLicenceRefusals(trackedPaths(root), readLicences(root));
  for (const line of refusals) console.error(`font-licences: ${line}`);
  if (refusals.length) process.exit(1);
  console.log('font-licences: every tracked font has a licence that allows the web');
}
