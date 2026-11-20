/**
 * #126 Framed clip (the Screen Studio / CleanShot "beautiful screen recording" look): shrink the clip to
 * `scale` and center it on a background (a solid color, or 'blur' = a blurred zoomed copy filling the
 * bars). Blind DATA over one scale+pad chain (solid) or a split/blur graph. Zero engine branching per
 * background beyond color-vs-blur (L069/L090).
 *
 * Proof (L155): DATA resolution (nested/flat, scale>=1 dropped), materialize object pass-through, AND real
 * offline renders where a solid-color frame makes the outer corner that color while the center stays the
 * source, a 'blur' frame makes the outer corner non-black, and a hostile color falls back to black.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
let composeTimeline, materializeExportEdl;
let work, red;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function meanRGB(file, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', file,
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n };
}
const isBlack = (c) => c.r < 30 && c.g < 30 && c.b < 30;
const dominant = (c) => (c.r > c.g && c.r > c.b ? 'red' : c.g > c.r && c.g > c.b ? 'green' : c.b > c.r && c.b > c.g ? 'blue' : 'gray');
const CORNER = { x: 2, y: 2, w: 16, h: 16 };
const CENTER = { x: 90, y: 90, w: 20, h: 20 };

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'frame-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'frame-render-'));
  red = join(work, 'red.mp4');
  // A solid RED 200x200 frame: after framing at scale<1, the center stays red and the outer padding
  // becomes the background (black/white = its color; blur = a red-ish blurred copy, still reddish).
  ffmpeg(['-f', 'lavfi', '-i', 'color=0xD00000:s=200x200:r=24:d=1', '-pix_fmt', 'yuv420p', red]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => red, { width: 200, height: 200, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('frame resolves from a nested {scale,background} object', () => {
  assert.deepEqual(clipTx(view([setTx({ frame: { scale: 0.8, background: 'blur' } })])).frame, { scale: 0.8, background: 'blur' });
});

test('frame resolves from flat frame_scale/frame_background; background defaults black', () => {
  assert.deepEqual(clipTx(view([setTx({ frame_scale: 0.7 })])).frame, { scale: 0.7, background: 'black' });
});

test('scale >= 1 is identity and dropped', () => {
  assert.equal(clipTx(view([setTx({ frame: { scale: 1, background: 'black' } })])).frame, undefined);
});

test('materialize emits frame (snake_case object) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ frame: { scale: 0.75, background: 'white' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].frame, { scale: 0.75, background: 'white' });
});

test('OFFLINE RENDER: a black-background frame makes the outer corner black, center stays source (L155)', () => {
  const out = render({ frame: { scale: 0.7, background: 'black' } }, 'black');
  assert.ok(isBlack(meanRGB(out, CORNER)), `outer corner is the black pad: ${JSON.stringify(meanRGB(out, CORNER))}`);
  assert.equal(dominant(meanRGB(out, CENTER)), 'red', `center stays the source (red): ${JSON.stringify(meanRGB(out, CENTER))}`);
});

test('OFFLINE RENDER: a white-background frame makes the outer corner white (L155)', () => {
  const c = meanRGB(render({ frame: { scale: 0.7, background: 'white' } }, 'white'), CORNER);
  assert.ok(c.r > 200 && c.g > 200 && c.b > 200, `outer corner is white: ${JSON.stringify(c)}`);
});

test('OFFLINE RENDER: a blur-background frame makes the outer corner NON-black (blurred content) (L155)', () => {
  const c = meanRGB(render({ frame: { scale: 0.7, background: 'blur' } }, 'blur'), CORNER);
  assert.ok(!isBlack(c) && c.r > c.b, `outer corner is blurred red content, not a black pad: ${JSON.stringify(c)}`);
});

test('OFFLINE RENDER: a filter-injection background falls back to black (L155)', () => {
  const c = meanRGB(render({ frame: { scale: 0.7, background: 'black,hflip' } }, 'evil'), CORNER);
  assert.ok(isBlack(c), `hostile background falls back to black: ${JSON.stringify(c)}`);
});
