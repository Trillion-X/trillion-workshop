/**
 * #129 Drop shadow (the Screen Studio "floating card" finisher): shrink the clip to `scale`, cast a
 * blurred offset dark copy behind it on a `background`, and overlay the sharp card on top. A
 * self-contained compositing subgraph (split of the single input: sharp card + a shadow layer = a solid
 * `color` rect at the card size padded onto the `background` canvas at the offset, then blurred). No
 * extra input source. Superset of #126 frame. Completes the framed-clip family (#124/#126/#128).
 *
 * Proof (L155): DATA resolution (nested/flat/boolean, defaults, clamp), materialize object pass-through,
 * AND a real offline render where the pad on the shadow-offset side is darker than the opposite side and
 * the card center stays the source color.
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
let work, src;

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
const lum = (p) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'ds-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'ds-render-'));
  src = join(work, 'green.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=1:r=24', '-pix_fmt', 'yuv420p', src]);
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
  const { edl } = materializeExportEdl(comp, () => src, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('drop shadow resolves from a nested object, filling Screen Studio defaults for missing fields', () => {
  assert.deepEqual(clipTx(view([setTx({ dropShadow: { dx: 10 } })])).dropShadow, { scale: 0.85, blur: 16, dx: 10, dy: 16, color: 'black', background: 'white', cornerRadius: 0 });
});

test('drop shadow resolves from a flat drop_shadow:true (all defaults)', () => {
  assert.deepEqual(clipTx(view([setTx({ drop_shadow: true })])).dropShadow, { scale: 0.85, blur: 16, dx: 0, dy: 16, color: 'black', background: 'white', cornerRadius: 0 });
});

test('drop shadow resolves flat drop_shadow_* overrides', () => {
  assert.deepEqual(
    clipTx(view([setTx({ drop_shadow_scale: 0.7, drop_shadow_blur: 24, drop_shadow_dx: 5, drop_shadow_dy: 8, drop_shadow_color: 'black', drop_shadow_background: 'gray' })])).dropShadow,
    { scale: 0.7, blur: 24, dx: 5, dy: 8, color: 'black', background: 'gray', cornerRadius: 0 },
  );
});

test('drop shadow is absent when not requested, and scale is clamped to 0.1..0.99', () => {
  assert.equal(clipTx(view([setTx({ look: 'dreamy' })])).dropShadow, undefined);
  assert.equal(clipTx(view([setTx({ dropShadow: { scale: 5 } })])).dropShadow.scale, 0.99);
  assert.equal(clipTx(view([setTx({ dropShadow: { scale: 0.01 } })])).dropShadow.scale, 0.1);
});

test('materialize emits drop_shadow (snake_case object) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ dropShadow: { scale: 0.8, blur: 12, dx: 3, dy: 12, color: 'black', background: 'white' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].drop_shadow, { scale: 0.8, blur: 12, dx: 3, dy: 12, color: 'black', background: 'white', cornerRadius: 0 });
});

test('OFFLINE RENDER: the pad on the shadow-offset side is darker than the opposite side; the card stays source (L155)', () => {
  // white canvas, card 0.8, shadow offset down-right (dx=14, dy=18) with black shadow.
  const out = render({ dropShadow: { scale: 0.8, blur: 14, dx: 14, dy: 18, color: 'black', background: 'white' } }, 'card');
  const center = meanRGB(out, { x: 150, y: 110, w: 20, h: 20 });
  const shadowSide = meanRGB(out, { x: 296, y: 220, w: 16, h: 12 }); // bottom-right pad, toward the offset
  const cleanSide = meanRGB(out, { x: 8, y: 8, w: 16, h: 12 });      // top-left pad, away from the offset
  // card center is the green source.
  assert.ok(center.g > 90 && center.r < 80, `card center is green source: ${JSON.stringify(center)}`);
  // the shadow-offset pad is meaningfully darker than the opposite pad (the soft shadow lands there).
  assert.ok(lum(cleanSide) - lum(shadowSide) > 30, `shadow side darker: clean=${lum(cleanSide).toFixed(0)} shadow=${lum(shadowSide).toFixed(0)}`);
  // the clean side is still near the white background.
  assert.ok(lum(cleanSide) > 200, `clean side near white bg: ${lum(cleanSide).toFixed(0)}`);
});

test('#134 cornerRadius resolves (nested + flat) and clamps 0..0.5; defaults 0', () => {
  assert.equal(clipTx(view([setTx({ dropShadow: { cornerRadius: 0.2 } })])).dropShadow.cornerRadius, 0.2);
  assert.equal(clipTx(view([setTx({ drop_shadow_corner_radius: 0.15 })])).dropShadow.cornerRadius, 0.15);
  assert.equal(clipTx(view([setTx({ dropShadow: { cornerRadius: 9 } })])).dropShadow.cornerRadius, 0.5);
  assert.equal(clipTx(view([setTx({ drop_shadow: true })])).dropShadow.cornerRadius, 0);
});

test('#134 OFFLINE RENDER: a rounded floating card has bg-colored (rounded) corners, source center, and a shadow (L155)', () => {
  // card scale 0.8 => 256x192 centered at (32,24); cornerRadius 0.18 rounds the card corners to white.
  const out = render({ dropShadow: { scale: 0.8, blur: 14, dx: 14, dy: 18, color: 'black', background: 'white', cornerRadius: 0.18 } }, 'rounded-card');
  const center = meanRGB(out, { x: 150, y: 110, w: 20, h: 20 });      // green source
  const cardCorner = meanRGB(out, { x: 36, y: 28, w: 8, h: 8 });      // card top-left corner -> rounded to white
  const cardTopMid = meanRGB(out, { x: 152, y: 26, w: 16, h: 6 });    // card straight top edge -> green (hard)
  const shadowSide = meanRGB(out, { x: 296, y: 220, w: 16, h: 12 });  // shadow still present
  assert.ok(center.g > 90 && center.r < 80, `card center is green source: ${JSON.stringify(center)}`);
  assert.ok(cardCorner.r > 180 && cardCorner.g > 180 && cardCorner.b > 180, `card corner is rounded to white bg: ${JSON.stringify(cardCorner)}`);
  assert.ok(cardTopMid.g > 90 && cardTopMid.r < 80, `card straight top edge stays source: ${JSON.stringify(cardTopMid)}`);
  assert.ok(lum(shadowSide) < 200, `the shadow is still cast: ${lum(shadowSide).toFixed(0)}`);
});
