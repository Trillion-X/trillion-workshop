/**
 * #128 Rounded corners (the Screen Studio / Arc "beautiful card" finisher): round the FINAL composited
 * frame, filling the four cut corners with `background`. `radius` is a 0..0.5 fraction of the shorter
 * side (resolution-independent). One linear geq single-color replace over rgb (no alpha, no extra input),
 * so it composes with every prior finisher. The corner color is PARSED to RGB ints, so injection is
 * structurally impossible. Own field, completes the framed-clip family (#124 border, #126 frame).
 *
 * Proof (L155): DATA resolution (nested/flat, dropped at <=0, clamped to 0.5), materialize object
 * pass-through, AND a real offline render on a solid clip where the corners become the background color
 * while the center and the edge-midpoints stay the source color (the dx=0/dy=0 bands are inside).
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

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'rc-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'rc-render-'));
  src = join(work, 'green.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=200x200:d=1:r=24', '-pix_fmt', 'yuv420p', src]);
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
  const { edl } = materializeExportEdl(comp, () => src, { width: 200, height: 200, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('rounded corners resolve from a nested {radius,background} object', () => {
  assert.deepEqual(clipTx(view([setTx({ roundedCorners: { radius: 0.25, background: '#ff0000' } })])).roundedCorners, { radius: 0.25, background: '#ff0000', feather: 0 });
});

test('rounded corners resolve from flat corner_radius/corner_background (background defaults to black)', () => {
  assert.deepEqual(clipTx(view([setTx({ corner_radius: 0.2 })])).roundedCorners, { radius: 0.2, background: 'black', feather: 0 });
  assert.deepEqual(clipTx(view([setTx({ corner_radius: 0.2, corner_background: 'white' })])).roundedCorners, { radius: 0.2, background: 'white', feather: 0 });
});

test('rounded corners are dropped when radius <= 0 (identity)', () => {
  assert.equal(clipTx(view([setTx({ roundedCorners: { radius: 0, background: '#fff' } })])).roundedCorners, undefined);
  assert.equal(clipTx(view([setTx({ corner_radius: -0.3 })])).roundedCorners, undefined);
});

test('rounded corners radius is clamped to a 0.5 max (a full-circle cap)', () => {
  assert.equal(clipTx(view([setTx({ corner_radius: 0.9 })])).roundedCorners.radius, 0.5);
});

test('materialize emits rounded_corners (snake_case object) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ roundedCorners: { radius: 0.3, background: '#101010' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].rounded_corners, { radius: 0.3, background: '#101010', feather: 0 });
});

test('OFFLINE RENDER: the four corners become the background color, the center stays the source color (L155)', () => {
  // radius 0.3 of a 200px shorter side => R = 60px. A green clip on red corners.
  const out = render({ roundedCorners: { radius: 0.3, background: '#ff0000' } }, 'red-corners');
  const CORNER = { w: 12, h: 12 };
  const tl = meanRGB(out, { x: 0, y: 0, ...CORNER });
  const br = meanRGB(out, { x: 188, y: 188, ...CORNER });
  const center = meanRGB(out, { x: 90, y: 90, w: 20, h: 20 });
  // corners are red bg: R high, G/B low.
  assert.ok(tl.r > 180 && tl.g < 80 && tl.b < 80, `top-left corner is red: ${JSON.stringify(tl)}`);
  assert.ok(br.r > 180 && br.g < 80 && br.b < 80, `bottom-right corner is red: ${JSON.stringify(br)}`);
  // center stays green source: G dominant, R low.
  assert.ok(center.g > 90 && center.r < 80, `center is green source: ${JSON.stringify(center)}`);
});

test('OFFLINE RENDER: the edge-midpoints stay source (only the corner arcs are cut), and a black default is honored (L155)', () => {
  const out = render({ corner_radius: 0.3 }, 'black-corners');
  const topMid = meanRGB(out, { x: 92, y: 0, w: 16, h: 10 });
  const leftMid = meanRGB(out, { x: 0, y: 92, w: 10, h: 16 });
  const tl = meanRGB(out, { x: 0, y: 0, w: 12, h: 12 });
  // edge-midpoints are on the vertical/horizontal edge bands (dx=0 or dy=0) => still green source.
  assert.ok(topMid.g > 90 && topMid.r < 80, `top edge-mid stays source: ${JSON.stringify(topMid)}`);
  assert.ok(leftMid.g > 90 && leftMid.r < 80, `left edge-mid stays source: ${JSON.stringify(leftMid)}`);
  // default background is black: the corner is dark on all channels.
  assert.ok(tl.r < 60 && tl.g < 60 && tl.b < 60, `default corner is black: ${JSON.stringify(tl)}`);
});

test('#133 feather resolves (nested + flat) and clamps to 0..1; defaults to 0', () => {
  assert.equal(clipTx(view([setTx({ roundedCorners: { radius: 0.3, feather: 0.5 } })])).roundedCorners.feather, 0.5);
  assert.equal(clipTx(view([setTx({ corner_radius: 0.3, corner_feather: 0.4 })])).roundedCorners.feather, 0.4);
  assert.equal(clipTx(view([setTx({ corner_radius: 0.3, corner_feather: 5 })])).roundedCorners.feather, 1);
  assert.equal(clipTx(view([setTx({ corner_radius: 0.3 })])).roundedCorners.feather, 0);
});

test('#133 OFFLINE RENDER: a feathered corner blends src->bg on the ARC while straight edges stay hard source (L155)', () => {
  // radius 0.4 => R=80, feather 0.5 => inner=40. On the diagonal, cd crosses 40..80 as a source->red ramp.
  const out = render({ roundedCorners: { radius: 0.4, background: '#ff0000', feather: 0.5 } }, 'feathered-corner');
  const center = meanRGB(out, { x: 92, y: 92, w: 16, h: 16 });   // full source
  const band = meanRGB(out, { x: 38, y: 38, w: 8, h: 8 });       // on the arc -> blend (both r and g)
  const farCorner = meanRGB(out, { x: 1, y: 1, w: 6, h: 6 });    // cd>>R -> full red
  const topMid = meanRGB(out, { x: 96, y: 0, w: 8, h: 6 });      // dx=0 gate -> hard source
  assert.ok(center.g > 90 && center.r < 60, `center is full source: ${JSON.stringify(center)}`);
  assert.ok(farCorner.r > 180 && farCorner.g < 60, `far corner is full bg: ${JSON.stringify(farCorner)}`);
  assert.ok(topMid.g > 90 && topMid.r < 60, `straight top edge stays hard source: ${JSON.stringify(topMid)}`);
  // arc band is a genuine BLEND: both red and green present (a hard cut would be one or the other).
  assert.ok(band.r > 40 && band.r < 230 && band.g > 25 && band.g < 130, `arc band is a source/bg blend: ${JSON.stringify(band)}`);
});
