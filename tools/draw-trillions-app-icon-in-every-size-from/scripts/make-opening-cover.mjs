// scripts/make-opening-cover.mjs
//
// PURPOSE
//   Writes the opening cover (parts/ui/show/thread-cover) into the iPhone app's resources, so the app shows the same
//   cover as the web page from the moment it launches, before its page has any bytes:
//     ios/App/thread-cover.html                          the cover as a page by itself
//     ios/App/Assets.xcassets/CoverNeedle.imageset/      the needle alone, which the app draws natively with the
//                                                        straight thread as the cover's first frame
//     ios/App/Assets.xcassets/CoverPaper.colorset/       the cover's paper, the colour iOS shows while it launches the
//                                                        app (UILaunchScreen in ios/project.yml), so no white comes first
//     node scripts/make-opening-cover.mjs
//   test/thread-cover.test.mjs fails while any written file is stale.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is decided here: the files are threadCoverPage() (wearing the look new accounts start with, src/page-look.mjs),
//      coverNeedleSvg() and the cover's paper colour over thread-cover.json, byte for byte.
//   2. The written files are derived output; they are never edited by hand.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { coverNeedleSvg, threadCoverPage } from '../../organize-my-files/parts/ui/show/thread-cover/thread-cover.mjs';
import setup from '../../organize-my-files/parts/ui/show/thread-cover/thread-cover.json' with { type: 'json' };
import { PAGE_LOOK } from '../src/page-look.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const IOS_COVER = join(ROOT, 'ios/App/thread-cover.html');
export const IOS_NEEDLE_SET = join(ROOT, 'ios/App/Assets.xcassets/CoverNeedle.imageset');
export const IOS_PAPER_SET = join(ROOT, 'ios/App/Assets.xcassets/CoverPaper.colorset');
// The screen-look tool's show folder, which holds the faces (fonts.css) and their licences.
const SCREEN_LOOK_SHOW = join(ROOT, '../screen-look/show');

// One channel of a #rrggbb colour as the asset catalogue writes it.
const channel = (hex, at) => `0x${hex.slice(1 + at * 2, 3 + at * 2).toUpperCase()}`;

/** The look the cover page wears by itself: the faces parts/screen-look/show/fonts.css declares, read from the app's
 *  bundle root (ios/carry-licensed-faces.sh carries there the faces licensed for apps, so only those get an @font-face
 *  here, read from licences.json; a face left out falls back to the next family of the look's font variable, the system face), and the look's font variables. */
export function coverLook() {
  const licences = JSON.parse(readFileSync(join(SCREEN_LOOK_SHOW, 'fonts/licences.json'), 'utf8'));
  const carried = new Set(licences.faces.filter(face => face.licensed_for.includes('app')).map(face => face.family));
  const faces = readFileSync(join(SCREEN_LOOK_SHOW, 'fonts.css'), 'utf8')
    .match(/@font-face\s*\{[^}]*\}/g)
    .filter(rule => carried.has(/font-family:\s*'([^']+)'/.exec(rule)?.[1]))
    .join('').replace(/url\('fonts\//g, "url('").replace(/\s+/g, ' ');
  const palette = Object.fromEntries(Object.entries(PAGE_LOOK.palette).filter(([name]) => name.startsWith('--font-')));
  return { faces, palette };
}

/** Every file this writes, by path, with its bytes. */
export function openingCoverFiles() {
  return {
    [IOS_COVER]: threadCoverPage(undefined, coverLook()),
    [join(IOS_NEEDLE_SET, 'cover-needle.svg')]: coverNeedleSvg(),
    [join(IOS_NEEDLE_SET, 'Contents.json')]: `${JSON.stringify({
      images: [{ filename: 'cover-needle.svg', idiom: 'universal' }],
      info: { author: 'xcode', version: 1 },
      properties: { 'preserves-vector-representation': true, 'template-rendering-intent': 'original' },
    }, null, 2)}\n`,
    [join(IOS_PAPER_SET, 'Contents.json')]: `${JSON.stringify({
      colors: [{
        color: { 'color-space': 'srgb', components: { alpha: '1.000', blue: channel(setup.look.paper, 2), green: channel(setup.look.paper, 1), red: channel(setup.look.paper, 0) } },
        idiom: 'universal',
      }],
      info: { author: 'xcode', version: 1 },
    }, null, 2)}\n`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [path, bytes] of Object.entries(openingCoverFiles())) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    process.stdout.write(`wrote ${path}\n`);
  }
}
