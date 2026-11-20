/**
 * #131 Ellipse / circle mask (iris reveal, circular video, oval spotlight): show the clip through an ellipse
 * centered at cx/cy with normalized radii rx/ry, filling everything OUTSIDE with a background color. Same geq
 * single-color-replace family as #128 rounded corners (outside when ((X-cx)/rx)^2 + ((Y-cy)/ry)^2 > 1). The
 * bg is parsed to RGB ints, so injection is impossible.
 *
 * Proof (L155): DATA resolution (nested/flat, dropped without rx/ry, clamp), materialize object pass-through,
 * AND a real offline render where the center stays source, the corners become the bg, and the on-axis points
 * inside the radii stay source while the ones past the radii become bg.
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
  const dir = tempFolder(join(tmpdir(), 'em-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'em-render-'));
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

test('ellipse mask resolves from a nested {cx,cy,rx,ry,background} object (feather defaults to 0)', () => {
  assert.deepEqual(clipTx(view([setTx({ ellipseMask: { cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.3, background: '#ff0000' } })])).ellipseMask, { cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.3, background: '#ff0000', feather: 0 });
});

test('ellipse mask resolves from flat ellipse_mask_* keys, background defaults to black, center to 0.5', () => {
  assert.deepEqual(clipTx(view([setTx({ ellipse_mask_rx: 0.4, ellipse_mask_ry: 0.4 })])).ellipseMask, { cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.4, background: 'black', feather: 0 });
});

test('#132 feather resolves (nested + flat) and clamps to 0..1', () => {
  assert.equal(clipTx(view([setTx({ ellipseMask: { rx: 0.4, ry: 0.4, feather: 0.4 } })])).ellipseMask.feather, 0.4);
  assert.equal(clipTx(view([setTx({ ellipse_mask_rx: 0.4, ellipse_mask_ry: 0.4, ellipse_mask_feather: 0.5 })])).ellipseMask.feather, 0.5);
  assert.equal(clipTx(view([setTx({ ellipseMask: { rx: 0.4, ry: 0.4, feather: 3 } })])).ellipseMask.feather, 1);
});

test('ellipse mask is dropped unless rx,ry > 0, and cx/cy/rx/ry clamp to 0..1', () => {
  assert.equal(clipTx(view([setTx({ ellipseMask: { rx: 0, ry: 0.4 } })])).ellipseMask, undefined);
  assert.equal(clipTx(view([setTx({ ellipseMask: { cx: 3, cy: -1, rx: 0.4, ry: 0.4 } })])).ellipseMask.cx, 1);
  assert.equal(clipTx(view([setTx({ ellipseMask: { cx: 3, cy: -1, rx: 0.4, ry: 0.4 } })])).ellipseMask.cy, 0);
});

test('materialize emits ellipse_mask (snake_case object) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ ellipseMask: { cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.3, background: '#101010' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].ellipse_mask, { cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.3, background: '#101010', feather: 0 });
});

test('OFFLINE RENDER: the center shows source, the corners become the background color (L155)', () => {
  // rx=0.375 (=120px), ry=0.375 (=90px) centered, red bg. Corners are well outside the ellipse.
  const out = render({ ellipseMask: { cx: 0.5, cy: 0.5, rx: 0.375, ry: 0.375, background: '#ff0000' } }, 'circle');
  const center = meanRGB(out, { x: 150, y: 110, w: 20, h: 20 });
  const tl = meanRGB(out, { x: 0, y: 0, w: 12, h: 12 });
  const br = meanRGB(out, { x: 308, y: 228, w: 12, h: 12 });
  assert.ok(center.g > 90 && center.r < 80, `center is green source: ${JSON.stringify(center)}`);
  assert.ok(tl.r > 180 && tl.g < 80, `top-left corner is red bg: ${JSON.stringify(tl)}`);
  assert.ok(br.r > 180 && br.g < 80, `bottom-right corner is red bg: ${JSON.stringify(br)}`);
});

test('OFFLINE RENDER: an on-axis point inside the radius stays source, past the radius becomes bg (L155)', () => {
  // rx=0.375 => 120px, so along the horizontal axis (y=120) the ellipse spans x in [40,280].
  const out = render({ ellipseMask: { cx: 0.5, cy: 0.5, rx: 0.375, ry: 0.375, background: '#000000' } }, 'axis');
  const inside = meanRGB(out, { x: 60, y: 116, w: 8, h: 8 });   // x=64 inside [40,280]
  const outside = meanRGB(out, { x: 6, y: 116, w: 8, h: 8 });   // x=10 outside -> black bg
  assert.ok(inside.g > 90, `inside-radius on-axis stays source: ${JSON.stringify(inside)}`);
  assert.ok(outside.r < 60 && outside.g < 60 && outside.b < 60, `outside-radius on-axis is black bg: ${JSON.stringify(outside)}`);
});

test('#132 OFFLINE RENDER: a feathered edge blends source->bg (a mid-band pixel is BETWEEN the two, not a hard cut) (L155)', () => {
  // rx=0.375 (=120px), feather 0.4 with a red bg. On the horizontal axis the edge is x=280; the feather band
  // (t0=(0.6)^2=0.36 => |dx|/120 from 0.6..1 => x from 232..280) is a source->red gradient.
  const out = render({ ellipseMask: { cx: 0.5, cy: 0.5, rx: 0.375, ry: 0.375, background: '#ff0000', feather: 0.4 } }, 'feathered');
  const center = meanRGB(out, { x: 152, y: 116, w: 8, h: 8 });   // full source
  const band = meanRGB(out, { x: 252, y: 116, w: 8, h: 8 });     // |dx|/120 ~0.8 -> mid feather -> blend
  const far = meanRGB(out, { x: 4, y: 116, w: 8, h: 8 });        // far outside -> full red
  assert.ok(center.g > 90 && center.r < 60, `center is full source: ${JSON.stringify(center)}`);
  assert.ok(far.r > 180 && far.g < 60, `far is full bg: ${JSON.stringify(far)}`);
  // the band pixel is a genuine BLEND: both red and green present (a hard cut would be one or the other).
  assert.ok(band.r > 40 && band.r < 230 && band.g > 25 && band.g < 130, `band is a source/bg blend: ${JSON.stringify(band)}`);
});

// #135 fraction of the whole frame that is the green SOURCE (revealed area) at time t.
function greenFraction(file, t) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let g = 0, n = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { if (raw[i] < 60 && raw[i + 1] > 90 && raw[i + 2] < 60) g++; n++; }
  return g / n;
}

test('#135 reveal resolves (nested + flat), only when duration > 0', () => {
  assert.deepEqual(clipTx(view([setTx({ ellipseMask: { rx: 0.4, ry: 0.4, reveal: { from: 0, to: 1, start: 0, duration: 0.8 } } })])).ellipseMask.reveal, { from: 0, to: 1, start: 0, duration: 0.8 });
  assert.deepEqual(clipTx(view([setTx({ ellipse_mask_rx: 0.4, ellipse_mask_ry: 0.4, ellipse_mask_reveal_duration: 1.5, ellipse_mask_reveal_to: 1 })])).ellipseMask.reveal, { from: 0, to: 1, start: 0, duration: 1.5 });
  assert.equal(clipTx(view([setTx({ ellipseMask: { rx: 0.4, ry: 0.4, reveal: { duration: 0 } } })])).ellipseMask.reveal, undefined);
  assert.equal(clipTx(view([setTx({ ellipseMask: { rx: 0.4, ry: 0.4 } })])).ellipseMask.reveal, undefined);
});

test('#135 OFFLINE RENDER: an iris-in reveal GROWS the revealed source area over time (multi-frame pixel diff, L155 temporal)', () => {
  // iris in: radii scale from 0 to full over 0.8s. Early frame = tiny circle (mostly bg), late = large.
  const out = render({ ellipseMask: { cx: 0.5, cy: 0.5, rx: 0.44, ry: 0.44, background: '#000000', reveal: { from: 0, to: 1, start: 0, duration: 0.8 } } }, 'iris-in');
  const early = greenFraction(out, 0.05);
  const late = greenFraction(out, 0.9);
  assert.ok(early < 0.05, `early frame is almost all background (tiny circle): ${early.toFixed(3)}`);
  assert.ok(late > early + 0.2, `revealed source area GROWS over time: early=${early.toFixed(3)} late=${late.toFixed(3)}`);
});
