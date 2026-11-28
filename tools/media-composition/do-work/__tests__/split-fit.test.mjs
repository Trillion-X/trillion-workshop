/**
 * file: tools/media-composition/do-work/__tests__/split-fit.test.mjs
 *
 * A fitted split cell (`sources[i].fit`): its crop is shown whole at `inner`, on a fill made of the same picture
 * scaled to cover the cell, blurred and darkened. Two layers:
 *   (1) PURE: the filter graph splits the cell's picture into the fill and the whole picture and lays one on the
 *       other at `inner`; a fit made for another cell size, or an `inner` outside the cell, is refused.
 *   (2) REAL: video-compose renders a stacked split with one fitted cell; the shown part is the source's picture
 *       (high PSNR against the crop scaled to `inner`), the fill beside it is darker than the picture.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSplitLayout } from '../split-layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'video-compose.mjs');
const ffmpegReady = spawnSync('ffmpeg', ['-version']).status === 0 ? false : 'ffmpeg is needed';
const fit = { fill: 'blur', cell: [360, 320], inner: { w: 180, h: 320, x: 90, y: 0 } };

test('a fitted cell is its whole crop at inner, on a blurred, darkened cover of itself', () => {
  const { filter } = buildSplitLayout({ count: 2, layout: 'v', width: 360, height: 640, fps: '30',
    sources: [{ crop: { w: 100, h: 100, x: 0, y: 0 } }, { crop: { w: 90, h: 160, x: 10, y: 0 }, fit, frames: 30 }] });
  assert.match(filter, /\[1:v\]crop=90:160:10:0,split\[f1a\]\[f1b\]/);
  assert.match(filter, /\[f1a\]scale=360:320:force_original_aspect_ratio=increase,crop=360:320,gblur=sigma=40,colorchannelmixer=rr=0.45:gg=0.45:bb=0.45\[f1fill\]/);
  assert.match(filter, /\[f1b\]scale=180:320\[f1whole\];\[f1fill\]\[f1whole\]overlay=90:0,setsar=1,fps=30,format=yuv420p,tpad=stop_mode=clone:stop=30\[v1\]/);
  assert.match(filter, /\[0:v\]crop=100:100:0:0,scale=360:320,/);          // a cell without a fit is unchanged
});

test('a fit made for another cell, or an inner picture outside the cell, is refused', () => {
  const build = f => buildSplitLayout({ count: 2, layout: 'v', width: 360, height: 640, fps: '30', sources: [{}, { fit: f }] });
  assert.throws(() => build({ ...fit, cell: [360, 360] }), /made for a 360,360 cell/);
  assert.throws(() => build({ ...fit, inner: { w: 180, h: 320, x: 200, y: 0 } }), /not a picture inside/);
  assert.throws(() => build({ ...fit, fill: 'black' }), /fit\.fill/);
});

test('the render shows the crop whole at inner and a darker fill around it', { skip: ffmpegReady }, () => {
  const work = tempFolder(join(tmpdir(), 'split-fit-'));
  const source = join(work, 'source.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x320:r=30:d=1', '-pix_fmt', 'yuv420p', source]);
  const crop = { w: 160, h: 320, x: 80, y: 0 };
  const edl = { encode: { width: 360, height: 640, fps: 30 }, base: { kind: 'color', color: 'black' },
    spine: { segments: [{ id: 'fit', kind: 'split', layout: 'v', sources: [
      { source, in: 0, out: 1, crop: { w: 320, h: 284, x: 0, y: 18 } },
      { source, in: 0, out: 1, crop, fit }] }] } };
  const edlFile = join(work, 'edl.json');
  const out = join(work, 'out.mp4');
  writeFileSync(edlFile, JSON.stringify(edl));
  const done = spawnSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  const gray = (input, vf, w, h) => new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', '-i', input, '-vf', vf,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 })).slice(0, w * h);
  const shownPart = gray(out, 'select=eq(n\\,15),crop=180:320:90:320', 180, 320);
  const expected = gray(source, 'select=eq(n\\,15),crop=160:320:80:0,scale=180:320', 180, 320);
  let mse = 0;
  for (let i = 0; i < shownPart.length; i += 1) mse += (shownPart[i] - expected[i]) ** 2;
  const psnr = 10 * Math.log10(255 ** 2 / (mse / shownPart.length));
  assert.ok(psnr > 28, `the shown part is the source's picture (PSNR ${psnr.toFixed(1)} dB)`);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const fill = gray(out, 'select=eq(n\\,15),crop=80:320:0:320', 80, 320);
  assert.ok(mean(fill) < mean(expected) * 0.75, `the fill is darker (${mean(fill).toFixed(1)} vs ${mean(expected).toFixed(1)})`);
});
