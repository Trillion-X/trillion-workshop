/**
 * #154 Spotlight follow: the L069 generalization of the static #125 positioned radial focus. A DATA
 * `track` of {at (fraction 0..1 of clip), cx, cy} keyframes moves the darkening center over the clip,
 * so the bright focus FOLLOWS a moving subject (the ball, a face, a cursor). The render interpolates
 * cx/cy piecewise-linearly and drives ffmpeg `vignette` with eval=frame time expressions in clip-local t.
 *
 * A computed-geometry primitive the static seam cannot express (a moving center, not a fixed one).
 * Proof: DATA resolution (sorts by at, clamps 0..1, needs >= 2 valid points else no track), materialize
 * pass-through (nested track verbatim), AND a real offline render where the bright side moves left to
 * right over time (left brighter than right early, right brighter than left late; L155 temporal), while
 * a plain static spotlight (no track) keeps its center bright and corners dark (regression).
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
function meanLum(file, ss, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) s += (raw[i] + raw[i + 1] + raw[i + 2]) / 3;
  return s / (raw.length / 3);
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'spot-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'spot-render-'));
  src = join(work, 'gray.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=gray:s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', src]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-08T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => src, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves track: sorts by at, clamps 0..1, keeps only >= 2 valid points, drops invalid entries', () => {
  const a = clipTx(view([setTx({ spotlight: { cx: 0.5, cy: 0.5, strength: 0.9, track: [
    { at: 1, cx: 0.8, cy: 0.5 }, { at: 0, cx: 0.2, cy: 0.5 },
  ] } })])).spotlight;
  assert.deepEqual(a.track, [{ at: 0, cx: 0.2, cy: 0.5 }, { at: 1, cx: 0.8, cy: 0.5 }]); // sorted by at
  const clamped = clipTx(view([setTx({ spotlight: { cx: 0.5, cy: 0.5, strength: 0.5, track: [
    { at: -1, cx: -0.5, cy: 2 }, { at: 5, cx: 0.4, cy: 0.4 },
  ] } })])).spotlight.track;
  assert.deepEqual(clamped, [{ at: 0, cx: 0, cy: 1 }, { at: 1, cx: 0.4, cy: 0.4 }]); // clamped 0..1
  const one = clipTx(view([setTx({ spotlight: { cx: 0.5, cy: 0.5, strength: 0.5, track: [{ at: 0, cx: 0.2, cy: 0.5 }] } })])).spotlight;
  assert.equal(one.track, undefined); // single point is just the static center, no track
  const filtered = clipTx(view([setTx({ spotlight: { cx: 0.5, cy: 0.5, strength: 0.5, track: [
    { at: 0, cx: 0.2, cy: 0.5 }, { at: 'x', cx: 1, cy: 1 }, { at: 1, cx: 0.8, cy: 0.5 },
  ] } })])).spotlight.track;
  assert.deepEqual(filtered, [{ at: 0, cx: 0.2, cy: 0.5 }, { at: 1, cx: 0.8, cy: 0.5 }]); // non-finite entry dropped
});

test('materialize emits spotlight with nested track verbatim (snake-cased top-level)', () => {
  const comp = composeTimeline(view([setTx({ spotlight: { cx: 0.5, cy: 0.5, strength: 0.8, track: [
    { at: 0, cx: 0.2, cy: 0.5 }, { at: 1, cx: 0.8, cy: 0.5 },
  ] } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].spotlight, { cx: 0.5, cy: 0.5, strength: 0.8, track: [
    { at: 0, cx: 0.2, cy: 0.5 }, { at: 1, cx: 0.8, cy: 0.5 },
  ] });
});

test('OFFLINE RENDER: the bright focus FOLLOWS the track left to right over time (L155 temporal)', () => {
  // track cx 0.2 -> 0.8 over the 2s clip; center left early, right late. Sample mid-height left vs right.
  const out = render({ spotlight: { cx: 0.5, cy: 0.5, strength: 0.95, track: [
    { at: 0, cx: 0.2, cy: 0.5 }, { at: 1, cx: 0.8, cy: 0.5 },
  ] } }, 'spot-follow');
  const box = (x) => ({ x, y: 110, w: 12, h: 20 });
  const leftEarly = meanLum(out, 0.1, box(40));
  const rightEarly = meanLum(out, 0.1, box(268));
  const leftLate = meanLum(out, 1.9, box(40));
  const rightLate = meanLum(out, 1.9, box(268));
  assert.ok(leftEarly > rightEarly + 20, `center left early: L=${leftEarly.toFixed(1)} R=${rightEarly.toFixed(1)}`);
  assert.ok(rightLate > leftLate + 20, `center right late: L=${leftLate.toFixed(1)} R=${rightLate.toFixed(1)}`);
});

test('OFFLINE RENDER: a static spotlight (no track) keeps its center bright and corners dark (regression)', () => {
  const out = render({ spotlight: { cx: 0.5, cy: 0.5, strength: 0.95 } }, 'spot-static');
  const center = meanLum(out, 1.0, { x: 150, y: 110, w: 20, h: 20 });
  const corner = meanLum(out, 1.0, { x: 6, y: 6, w: 12, h: 12 });
  assert.ok(center > corner + 30, `center brighter than corner: C=${center.toFixed(1)} corner=${corner.toFixed(1)}`);
});
