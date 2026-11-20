/**
 * #186 Mirror: a kaleidoscope-style self-fold that reflects one half of the frame onto the other, via a geq
 * coordinate remap (no trig). DATA mirror: true | { axis: 'h' | 'v' }. 'h' folds left onto right, 'v' folds
 * top onto bottom. Distinct from `flip` (a full flip, not a symmetric fold).
 *
 * Proof: DATA resolution (bare true => {axis h}; nested {axis}; flat mirror_axis; unknown axis => h),
 * materialize pass-through, AND a real OFFLINE render whose oracle is SYMMETRY: a source with a bright bar
 * ONLY in the left half is asymmetric, but after an h-fold the output is left-right symmetric (every column X
 * equals its mirror W-1-X) and gains a second bar (the reflection). We measure the left-right asymmetry (sum
 * of |px[X]-px[W-1-X]|): large on the base, near-zero after mirror. PLUS a byte-identical determinism proof. L155.
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
function grayRow(file, ss, y) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  const r = []; for (let x = 0; x < W; x++) r.push(raw[y * W + x]); return r;
}
const lrAsymmetry = (row) => { let s = 0; for (let x = 0; x < W / 2; x++) s += Math.abs(row[x] - row[W - 1 - x]); return s; };
const brightCount = (row) => row.filter((v) => v > 120).length;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'mir-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'mir-render-'));
  bar = join(work, 'bar.mp4'); // a bright bar ONLY in the left half (x=80..90), so the frame is asymmetric.
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=r='if(between(X,80,90),240,20)':g='if(between(X,80,90),240,20)':b='if(between(X,80,90),240,20)'", '-pix_fmt', 'yuv420p', bar]);
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

test('resolves mirror: bare `true` => {axis h}; nested {axis}; flat mirror_axis', () => {
  assert.deepEqual(clipTx(view([setTx({ mirror: true })])).mirror, { axis: 'h' });
  assert.deepEqual(clipTx(view([setTx({ mirror: { axis: 'v' } })])).mirror, { axis: 'v' });
  assert.deepEqual(clipTx(view([setTx({ mirror_axis: 'v' })])).mirror, { axis: 'v' });
});

test('resolves mirror: unknown axis falls back to h; absent stays undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ mirror: { axis: 'diagonal' } })])).mirror, { axis: 'h' });
  assert.equal(clipTx(view([setTx({})])).mirror, undefined);
});

test('materialize emits mirror (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ mirror: { axis: 'v' } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].mirror, { axis: 'v' });
});

test('OFFLINE RENDER: an h-fold makes the asymmetric frame left-right symmetric and adds the reflected bar (L155)', () => {
  const y = Math.floor(H / 2);
  const base = grayRow(render({}, 'mir-off', true), 0.5, y);
  const mir = grayRow(render({ mirror: { axis: 'h' } }, 'mir-on', true), 0.5, y);

  assert.ok(lrAsymmetry(base) > 1500, `the base frame is left-right asymmetric (bar only on the left): ${lrAsymmetry(base)}`);
  assert.ok(lrAsymmetry(mir) < 400, `the h-fold makes it left-right symmetric: ${lrAsymmetry(mir)}`);
  assert.ok(brightCount(mir) > brightCount(base) * 1.6, `the fold adds the reflected bar: ${brightCount(mir)}px vs ${brightCount(base)}px`);

  const a = render({ mirror: { axis: 'h' } }, 'mir-det-a', true);
  const b = render({ mirror: { axis: 'h' } }, 'mir-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic mirror renders of the same EDL are byte-identical');
});
