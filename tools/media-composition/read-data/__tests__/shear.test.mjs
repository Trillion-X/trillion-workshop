/**
 * #192 Shear: a parallelogram slant / skew of the frame via a geq coordinate remap (no trig), distinct from
 * #181 perspective (a trapezoid keystone) and rotate (a rigid turn). DATA shear: true | { amount: -1..1,
 * axis: 'h' | 'v' }. 'h' slants columns by row (the italic lean), 'v' slants rows by column. bare true seeds
 * { amount 0.3, axis h }. amount 0 is identity (dropped).
 *
 * Proof: DATA resolution (bare true seeds {0.3,h}; nested {amount,axis}; flat shear_amount/shear_axis; clamp
 * -1..1; amount 0 dropped; unknown axis => h), materialize pass-through, AND a real OFFLINE render whose oracle
 * is a LINEAR SLANT: a vertical bar's per-row x-centroid, flat on the base, becomes a straight line whose
 * x-position increases monotonically down the rows after an h-shear (and a negative amount reverses the slope).
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
const W = 320, H = 240, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function grayFrame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// x-centroid of the bright pixels on row y (-1 if none).
function rowCentroid(raw, y) {
  let s = 0, n = 0;
  for (let x = 0; x < W; x++) { if (raw[y * W + x] > 120) { s += x; n++; } }
  return n ? Math.round(s / n) : -1;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'shr-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'shr-render-'));
  bar = join(work, 'bar.mp4'); // a vertical bright bar at x=145..155 (same x on every row -> flat centroid).
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=r='if(between(X,145,155),240,20)':g='if(between(X,145,155),240,20)':b='if(between(X,145,155),240,20)'", '-pix_fmt', 'yuv420p', bar]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'b.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-10T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name, deterministic) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => bar, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves shear: bare `true` seeds {0.3,h}; nested {amount,axis}; flat shear_amount/shear_axis', () => {
  assert.deepEqual(clipTx(view([setTx({ shear: true })])).shear, { amount: 0.3, axis: 'h' });
  assert.deepEqual(clipTx(view([setTx({ shear: { amount: 0.5, axis: 'v' } })])).shear, { amount: 0.5, axis: 'v' });
  assert.deepEqual(clipTx(view([setTx({ shear_amount: -0.4, shear_axis: 'v' })])).shear, { amount: -0.4, axis: 'v' });
});

test('resolves shear: clamps -1..1; amount 0 dropped; unknown axis => h; absent undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ shear: { amount: 9 } })])).shear, { amount: 1, axis: 'h' });
  assert.deepEqual(clipTx(view([setTx({ shear: { amount: 0.4, axis: 'diag' } })])).shear, { amount: 0.4, axis: 'h' });
  assert.equal(clipTx(view([setTx({ shear: { amount: 0 } })])).shear, undefined);
  assert.equal(clipTx(view([setTx({})])).shear, undefined);
});

test('materialize emits shear (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ shear: { amount: 0.5, axis: 'v' } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].shear, { amount: 0.5, axis: 'v' });
});

test('OFFLINE RENDER: an h-shear turns the flat vertical bar into a linear slant; negative reverses it (L155)', () => {
  const base = grayFrame(render({}, 'shr-off', true), 0.5);
  const pos = grayFrame(render({ shear: { amount: 0.3, axis: 'h' } }, 'shr-pos', true), 0.5);
  const neg = grayFrame(render({ shear: { amount: -0.3, axis: 'h' } }, 'shr-neg', true), 0.5);

  const bTop = rowCentroid(base, 60), bBot = rowCentroid(base, 180);
  const pTop = rowCentroid(pos, 60), pMid = rowCentroid(pos, 120), pBot = rowCentroid(pos, 180);
  const nTop = rowCentroid(neg, 60), nBot = rowCentroid(neg, 180);

  assert.ok(Math.abs(bTop - bBot) < 6, `the base bar is vertical (flat centroid): top ${bTop} bot ${bBot}`);
  assert.ok(pBot - pTop > 25, `a positive h-shear slants the bar so bottom rows sit right of top rows: top ${pTop} bot ${pBot}`);
  assert.ok(pTop < pMid && pMid < pBot, `the slant is monotonic top-to-bottom: ${pTop} < ${pMid} < ${pBot}`);
  assert.ok(nTop - nBot > 25, `a negative amount reverses the slope: top ${nTop} bot ${nBot}`);

  const a = render({ shear: { amount: 0.3, axis: 'h' } }, 'shr-det-a', true);
  const b = render({ shear: { amount: 0.3, axis: 'h' } }, 'shr-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic shear renders of the same EDL are byte-identical');
});
