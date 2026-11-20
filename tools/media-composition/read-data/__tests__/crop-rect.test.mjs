/**
 * #120 Manual crop / zoom rect: select a NORMALIZED 0..1 sub-rectangle {x,y,w,h} of the source and the
 * render scales it to fill the canvas. The explicit-region twin of auto-reframe (aspect-follow) and Ken
 * Burns / punch-in (center zoom): any off-center crop, logo removal, or manual zoom, as blind DATA over
 * one expression crop (crop=w=iw*W:...), zero engine branching (L069/L090).
 *
 * Proof (L155): DATA resolution + clamping + full-frame drop, materialize snake_case object pass-through,
 * AND real offline renders where cropping to a chosen quadrant of a 4-color frame fills the WHOLE output
 * with that quadrant's color (crop is a zoom).
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
let work, quad;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}

// Mean R/G/B of the whole rendered frame at 0.5s: after a crop-to-quadrant the whole output should be
// that quadrant's solid color.
function meanRGB(file) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', file,
    '-vf', 'format=rgb24,scale=2:2', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n };
}
const dominant = (c) => (c.r > c.g && c.r > c.b ? 'red' : c.g > c.r && c.g > c.b ? 'green' : c.b > c.r && c.b > c.g ? 'blue' : 'gray');

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'crop-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'crop-render-'));
  quad = join(work, 'quad.mp4');
  // A 200x200 frame split into 4 solid quadrants: red TL, green TR, blue BL, white BR. Cropping to a
  // quadrant then fills the whole output with that color, so the dominant channel identifies the crop.
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=200x200:r=24:d=1',
    '-vf', 'drawbox=x=0:y=0:w=100:h=100:color=red:t=fill,drawbox=x=100:y=0:w=100:h=100:color=green:t=fill,'
      + 'drawbox=x=0:y=100:w=100:h=100:color=blue:t=fill,drawbox=x=100:y=100:w=100:h=100:color=white:t=fill',
    '-pix_fmt', 'yuv420p', quad]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'q.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });
const clipTx = (view0) => view0.lanes ? composeTimeline(view0).lanes.find((l) => l.role === 'video').clips[0].transform : null;

const render = (cropRect, name) => {
  const comp = composeTimeline(view(cropRect ? [setTx({ crop_rect: cropRect })] : []));
  const { edl } = materializeExportEdl(comp, () => quad, { width: 200, height: 200, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('crop_rect resolves onto the clip transform as normalized fractions', () => {
  const t = clipTx(view([setTx({ crop_rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 } })]));
  assert.deepEqual(t.cropRect, { x: 0.5, y: 0, w: 0.5, h: 0.5 });
});

test('a full-frame crop (0,0,1,1) is identity and dropped', () => {
  const t = clipTx(view([setTx({ crop_rect: { x: 0, y: 0, w: 1, h: 1 } })]));
  assert.equal(t.cropRect, undefined);
});

test('crop_rect clamps into frame (x+w never exceeds 1)', () => {
  const t = clipTx(view([setTx({ crop_rect: { x: 0.8, y: 0, w: 0.5, h: 0.5 } })]));
  assert.equal(t.cropRect.x, 0.8);
  assert.ok(Math.abs(t.cropRect.w - 0.2) < 1e-9, `w clamped to 0.2, got ${t.cropRect.w}`);
});

test('flat crop_x/crop_y/crop_w/crop_h also resolve', () => {
  const t = clipTx(view([setTx({ crop_x: 0, crop_y: 0.5, crop_w: 0.5, crop_h: 0.5 })]));
  assert.deepEqual(t.cropRect, { x: 0, y: 0.5, w: 0.5, h: 0.5 });
});

test('materialize emits crop_rect (snake_case object) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ crop_rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } })]));
  const { edl } = materializeExportEdl(comp, () => 'q.mp4', {});
  assert.deepEqual(edl.spine.segments[0].crop_rect, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
});

test('OFFLINE RENDER: the plain clip shows all four colors (mixed, not solid) (L155)', () => {
  // The uncropped frame averaged is a muddy mix; assert no single primary dominates strongly.
  const c = meanRGB(render(null, 'plain'));
  assert.ok(c.r > 40 && c.g > 40 && c.b > 40, `all channels present in the full frame: ${JSON.stringify(c)}`);
});

test('OFFLINE RENDER: crop to top-left fills the output with RED (L155)', () => {
  assert.equal(dominant(meanRGB(render({ x: 0, y: 0, w: 0.5, h: 0.5 }, 'tl'))), 'red');
});

test('OFFLINE RENDER: crop to top-right fills the output with GREEN (L155)', () => {
  assert.equal(dominant(meanRGB(render({ x: 0.5, y: 0, w: 0.5, h: 0.5 }, 'tr'))), 'green');
});

test('OFFLINE RENDER: crop to bottom-left fills the output with BLUE (L155)', () => {
  assert.equal(dominant(meanRGB(render({ x: 0, y: 0.5, w: 0.5, h: 0.5 }, 'bl'))), 'blue');
});
