/**
 * #181 Perspective: keystone / trapezoid tilt via ffmpeg `perspective` (4 source corners). DATA perspective:
 * true | { tilt: -1..1 }. Positive pulls the TOP corners inward (top narrower, "looking up"), negative pulls
 * the BOTTOM corners inward. A second OPTICAL/geometric warp after #178 fisheye (a planar keystone, distinct
 * from a barrel bulge).
 *
 * Proof: DATA resolution (bare true => 0.4; nested {tilt}; flat perspective_tilt; clamp -1..1), materialize
 * pass-through, AND a real OFFLINE render of a straight FULL-HEIGHT vertical bar: under a keystone the bar
 * becomes a SLANT (its centroid at the top row differs from the bottom row), while the base bar is vertical
 * (same centroid top and bottom). Convention-agnostic (it proves a row-dependent horizontal warp happened),
 * PLUS a byte-identical determinism proof. L155.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { blake3 } from '@noble/hashes/blake3.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
let composeTimeline, materializeExportEdl;
let work, bar;
const W = 320, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// centroid x of the bright bar on row y (bar ~240 on black ~20, so >120 is robust to codec wobble).
function barCentroid(raw, y) {
  let sx = 0, n = 0;
  for (let x = 0; x < W; x++) { if (raw[(y * W + x) * 3] > 120) { sx += x; n++; } }
  return n ? sx / n : null;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'persp-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'persp-render-'));
  bar = join(work, 'bar.mp4'); // a straight FULL-HEIGHT bright vertical bar at x=236..244 (off-center)
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=r='if(between(X,236,244),240,20)':g='if(between(X,236,244),240,20)':b='if(between(X,236,244),240,20)'", '-pix_fmt', 'yuv420p', bar]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-10T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name, deterministic) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => bar, { width: 320, height: 240, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves perspective: bare `true` => 0.4; nested {tilt}; flat perspective_tilt', () => {
  assert.deepEqual(clipTx(view([setTx({ perspective: true })])).perspective, { tilt: 0.4 });
  assert.deepEqual(clipTx(view([setTx({ perspective: { tilt: -0.6 } })])).perspective, { tilt: -0.6 });
  assert.deepEqual(clipTx(view([setTx({ perspective_tilt: 0.5 })])).perspective, { tilt: 0.5 });
});

test('resolves perspective: tilt clamps -1..1; absent stays undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ perspective: { tilt: 3 } })])).perspective, { tilt: 1 });
  assert.deepEqual(clipTx(view([setTx({ perspective: { tilt: -5 } })])).perspective, { tilt: -1 });
  assert.equal(clipTx(view([setTx({})])).perspective, undefined);
});

test('materialize emits perspective (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ perspective: { tilt: -0.6 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].perspective, { tilt: -0.6 });
});

test('OFFLINE RENDER: a keystone slants the straight vertical bar (top centroid != bottom), base stays vertical (L155)', () => {
  // Base: the bar is vertical, so its centroid is the same at the top and bottom rows. A keystone scales x
  // per-row, so the bar becomes a slant and its top-row centroid diverges from its bottom-row centroid.
  const base = frame(render({}, 'persp-off', true), 0.5);
  const ks = frame(render({ perspective: { tilt: 0.6 } }, 'persp-ks', true), 0.5);
  const yT = 40, yB = 200;

  const baseTop = barCentroid(base, yT), baseBot = barCentroid(base, yB);
  const ksTop = barCentroid(ks, yT), ksBot = barCentroid(ks, yB);
  assert.ok([baseTop, baseBot, ksTop, ksBot].every((v) => v !== null), `the bar is visible in every row/render: ${baseTop},${baseBot},${ksTop},${ksBot}`);

  assert.ok(Math.abs(baseTop - baseBot) < 3, `the base bar is vertical (same centroid top and bottom): top=${baseTop.toFixed(1)} bottom=${baseBot.toFixed(1)}`);
  assert.ok(Math.abs(ksTop - ksBot) > 8, `the keystone slants the bar (top centroid diverges from bottom): top=${ksTop.toFixed(1)} bottom=${ksBot.toFixed(1)}`);

  const a = render({ perspective: { tilt: 0.6 } }, 'persp-det-a', true);
  const b = render({ perspective: { tilt: 0.6 } }, 'persp-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic perspective renders of the same EDL are byte-identical');
});
