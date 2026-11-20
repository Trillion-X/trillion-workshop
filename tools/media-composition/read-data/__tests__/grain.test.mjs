/**
 * #175 Grain: composable, tunable, reproducible analog film / sensor grain (fine per-pixel temporal noise)
 * via ffmpeg's `noise` filter. DATA grain: true | { amount: 1..100 }. amount -> `alls` strength; a FIXED seed
 * keeps it byte-reproducible (#170) while `allf=t+u` gives even, per-frame grain. Distinct from the fixed
 * `film-grain` LOOK preset (which replaces the whole grade at a baked strength) - this LAYERS on any grade at
 * a tunable strength; and distinct from #169 filmDamage (sparse scratches/dust flecks) - this is even grain.
 *
 * Proof: DATA resolution (bare true => 20; nested {amount}; flat grain_amount; clamp 1..100 + round),
 * materialize pass-through, AND a real OFFLINE render on a DEAD-FLAT gray source where the grained frame's
 * spatial variance in a flat region JUMPS far above the (near-zero) unfiltered variance (proving the grain
 * actually rendered), PLUS a byte-identical determinism proof (the fixed seed makes two deterministic renders
 * sha256-equal, so it is reproducible not just noisy). L155.
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
let work, gray;
const W = 320, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// spatial variance of the R channel over a WxH region (fine grain => high variance; flat gray => ~0).
function varianceR(raw, x0, y0, w, h) {
  const vals = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * W + x) * 3; if (i < raw.length) vals.push(raw[i]); }
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'grn-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'grn-render-'));
  gray = join(work, 'gray.mp4'); // dead-flat mid-gray so any spatial variance is unambiguously the grain
  ffmpeg(['-f', 'lavfi', '-i', `color=0x808080:s=320x240:d=2:r=${FPS}`, '-pix_fmt', 'yuv420p', gray]);
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
  const { edl } = materializeExportEdl(comp, () => gray, { width: 320, height: 240, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves grain: bare `true` => 20; nested {amount}; flat grain_amount', () => {
  assert.deepEqual(clipTx(view([setTx({ grain: true })])).grain, { amount: 20 });
  assert.deepEqual(clipTx(view([setTx({ grain: { amount: 45 } })])).grain, { amount: 45 });
  assert.deepEqual(clipTx(view([setTx({ grain_amount: 60 })])).grain, { amount: 60 });
});

test('resolves grain: amount clamps 1..100 and rounds; absent stays undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ grain: { amount: 500 } })])).grain, { amount: 100 });
  assert.deepEqual(clipTx(view([setTx({ grain: { amount: 0 } })])).grain, { amount: 1 });
  assert.deepEqual(clipTx(view([setTx({ grain: { amount: 45.6 } })])).grain, { amount: 46 });
  assert.equal(clipTx(view([setTx({})])).grain, undefined);
});

test('materialize emits grain (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ grain: { amount: 45 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].grain, { amount: 45 });
});

test('OFFLINE RENDER: grain adds spatial variance to a flat frame AND is byte-reproducible (L155)', () => {
  // On a DEAD-FLAT gray source the unfiltered frame has ~0 spatial variance; grain sprays fine per-pixel noise
  // so a flat region's variance JUMPS. Use a strong amount so the grain survives x264 on a flat plate.
  const g = frame(render({ grain: { amount: 80 } }, 'grn-a', true), 0.5);
  const base = frame(render({}, 'grn-off', true), 0.5);
  const x0 = 140, y0 = 100, w = 40, h = 40;
  const gVar = varianceR(g, x0, y0, w, h);
  const baseVar = varianceR(base, x0, y0, w, h);

  assert.ok(baseVar < 8, `unfiltered flat gray has ~no spatial variance: ${baseVar.toFixed(2)}`);
  assert.ok(gVar > baseVar + 20, `grain sprays real spatial variance onto the flat frame: ${gVar.toFixed(2)} vs base ${baseVar.toFixed(2)}`);

  // reproducibility: the fixed seed + deterministic single-thread => two renders are byte-identical (#170),
  // so the grain is a reproducible export, not just unrepeatable noise.
  const a = render({ grain: { amount: 80 } }, 'grn-det-a', true);
  const b = render({ grain: { amount: 80 } }, 'grn-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic grain renders of the same EDL are byte-identical');
});
