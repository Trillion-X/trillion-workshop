/**
 * #147 Countdown ring: a circular arc HUD that sweeps clockwise from 12 o'clock over the clip (the
 * Instagram-story / intro countdown the LINEAR #143 progress bar cannot express). DATA `countdownRing`
 * {radius?, thickness?, color?, x?, y?, mode?}. The render is a POLAR configuration of the same geq
 * single-color-replace + T-in-geq HUD family: a pixel is on the ring iff its distance from center is in
 * [R-w, R+w] AND its clockwise angle-from-top is <= the swept fraction of a full turn. mode 'fill' GROWS
 * the arc (elapsed); 'deplete' SHRINKS it (default).
 *
 * Proof: DATA resolution (aliases, mode clamp, drop non-positive radius/thickness), materialize pass-through,
 * AND real offline renders where the arc sweeps clockwise over time (L155 temporal: a point at ~7 o'clock is
 * OFF early and ON late in fill mode, and the inverse in deplete mode; the center is never touched).
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
function meanRGB(file, ss, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  const n = raw.length / 3;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}
const isRed = (c) => c.r > 150 && c.r > c.g + 60 && c.r > c.b + 60;
const isGray = (c) => Math.abs(c.r - c.g) < 30 && Math.abs(c.g - c.b) < 30 && c.r < 180;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'ring-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'ring-render-'));
  src = join(work, 'gray.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=gray:s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', src]);
});

const view = (decisions, dur = 2) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: dur, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
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

// on-ring sample windows for a default ring (cx=160, cy=120, R=0.3*240=72). A point at clockwise angle
// theta from top: X = cx + R*sin(theta), Y = cy - R*cos(theta). 1 o'clock is ~0.785 rad, 7 o'clock is ~3.665.
const ONE_OCLOCK = { x: 209, y: 67, w: 4, h: 4 };   // theta 0.785 maps to (211, 69)
const SEVEN_OCLOCK = { x: 122, y: 180, w: 4, h: 4 }; // theta 3.665 maps to (124, 182)
const CENTER = { x: 158, y: 118, w: 4, h: 4 };

test('resolves radius/thickness/color/x/y/mode; aliases (ring/countdownRing); drops non-positive radius/thickness', () => {
  const a = clipTx(view([setTx({ countdownRing: { radius: 0.25, thickness: 0.04, color: 'red', x: 0.5, y: 0.5, mode: 'fill' } })])).countdownRing;
  assert.deepEqual(a, { radius: 0.25, thickness: 0.04, color: 'red', x: 0.5, y: 0.5, mode: 'fill' });
  // alias `ring`; unknown mode dropped; non-positive radius/thickness dropped but the object still resolves.
  const b = clipTx(view([setTx({ ring: { color: 'white', mode: 'bogus', radius: 0, thickness: -1 } })])).countdownRing;
  assert.deepEqual(b, { color: 'white' });
  assert.equal(clipTx(view([])).countdownRing, undefined);
});

test('materialize emits countdown_ring.{radius,thickness,color,mode} (nested, verbatim)', () => {
  const comp = composeTimeline(view([setTx({ countdownRing: { radius: 0.3, thickness: 0.03, color: 'red', mode: 'deplete' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].countdown_ring, { radius: 0.3, thickness: 0.03, color: 'red', mode: 'deplete' });
});

test('OFFLINE RENDER fill: the arc GROWS clockwise; a 7 o\'clock point is OFF early and ON late; center never touched (L155)', () => {
  const out = render({ countdownRing: { color: 'red', mode: 'fill' } }, 'ring-fill');
  // 1 o'clock (theta 0.785) is reached early (prog >= 0.785 by t~0.25s): red at t=0.5.
  assert.ok(isRed(meanRGB(out, 0.5, ONE_OCLOCK)), '1 o\'clock filled early');
  // 7 o'clock (theta 3.665) is reached late (t~1.17s): gray at t=0.5, red at t=1.5.
  assert.ok(isGray(meanRGB(out, 0.5, SEVEN_OCLOCK)), '7 o\'clock not yet filled at t=0.5');
  assert.ok(isRed(meanRGB(out, 1.5, SEVEN_OCLOCK)), '7 o\'clock filled at t=1.5 (arc grew)');
  assert.ok(isGray(meanRGB(out, 1.5, CENTER)), 'center is never part of the ring');
});

test('OFFLINE RENDER deplete: the arc SHRINKS (inverse of fill), 7 o\'clock ON early and OFF late', () => {
  const out = render({ countdownRing: { color: 'red', mode: 'deplete' } }, 'ring-deplete');
  assert.ok(isRed(meanRGB(out, 0.5, SEVEN_OCLOCK)), '7 o\'clock present early (deplete: prog large)');
  assert.ok(isGray(meanRGB(out, 1.5, SEVEN_OCLOCK)), '7 o\'clock gone late (deplete: prog small)');
});
