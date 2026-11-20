/**
 * #234 Cover-text / thumbnail-title proof (author-cover-text.mjs): burn a bold title onto the poster (the top
 * social CTR lever). Reuses the injection-safe textfile+drawtext approach; no new render engine (L069).
 *
 * Proof (L155, definitive offline render): a plain dark poster with NO bright pixels. burnCoverText writes a WHITE
 * title; the output image gains many near-white pixels (the text) that the input did not have, and an empty title
 * adds none. A PURE test proves the title rides a textfile (never text=, so a `:`/`'` in the title cannot break the
 * graph) and that a malformed color is sanitized to a safe token.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { burnCoverText, coverTextDrawFilter, safeColor } from '../../do-work/author-cover-text.mjs';

const PY = '/opt/homebrew/anaconda3/bin/python3';
let work, poster;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
// count of near-white pixels (R,G,B all > 200) in an image.
function whitePixels(file) {
  const py = `from PIL import Image
im=Image.open('${file}').convert('RGB'); px=im.load(); w,h=im.size; n=0
for y in range(0,h,2):
  for x in range(0,w,2):
    R,G,B=px[x,y]
    if R>200 and G>200 and B>200: n+=1
print(n)`;
  return Number(execFileSync(PY, ['-c', py], { encoding: 'utf8' }).trim());
}

before(() => {
  work = tempFolder(join(tmpdir(), 'cover-t-'));
  poster = join(work, 'poster.png');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x102040:s=640x360', '-frames:v', '1', poster]);   // solid dark blue, no bright pixels
});

test('PURE: the title rides a textfile (injection-safe) and colors are sanitized to safe tokens', () => {
  const frag = coverTextDrawFilter({ textfile: '/tmp/t.txt', size: 60, color: '#ff0000', boxColor: '#000000' });
  assert.match(frag, /textfile='\/tmp\/t\.txt'/, 'text comes from a textfile, never text=');
  assert.ok(!/:text=/.test(frag), 'no raw :text= param that a title could inject through (title rides the textfile)');
  assert.equal(safeColor('#ff0000'), '0xFF0000');
  assert.equal(safeColor("white:x='inject"), 'white', 'a malformed color falls back to a safe token');
  assert.equal(safeColor('black@0.5'), 'black@0.5');
});

test('OFFLINE RENDER: burning a white title adds bright text pixels the plain poster did not have (L155)', () => {
  const before0 = whitePixels(poster);
  assert.ok(before0 < 20, `the plain poster has essentially no bright pixels (${before0})`);
  const out = join(work, 'cover.png');
  burnCoverText(poster, 'FEDERER FOREHAND', out, { size: 54, color: '#ffffff', boxColor: '#000000', yFrac: 0.72 });
  const after = whitePixels(out);
  assert.ok(after > 300, `the burned title added many bright text pixels (${after})`);

  const empty = join(work, 'empty.png');
  burnCoverText(poster, '', empty, { size: 54, color: '#ffffff' });
  assert.ok(whitePixels(empty) < 20, 'an empty title adds no text');
});
