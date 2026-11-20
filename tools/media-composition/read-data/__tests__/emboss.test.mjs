/**
 * #176 Emboss: monochrome relief / engraving via a 3x3 convolution. The sum-0 kernel + 128 bias maps flat
 * tone to mid-gray and surfaces edges as light/dark relief. DATA emboss: true | { depth: 0.2..4 } (depth
 * scales the kernel magnitude). Structural convolution, not a color grade or blur, so it is genuinely new
 * (not reachable via the fixed LOOK_CATALOG).
 *
 * Proof: DATA resolution (bare true => 1; nested {depth}; flat emboss_depth; clamp 0.2..4), materialize
 * pass-through, AND a real OFFLINE render on a hard vertical edge (left dark 40, right bright 220) where BOTH
 * flat halves collapse to ~mid-gray (128) in the embossed frame (the emboss signature) while the base halves
 * stay their two distinct tones, and the edge produces a BRIGHT relief spike far above the flat mid-gray,
 * PLUS a byte-identical determinism proof (two deterministic renders sha256-equal). L155.
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
let work, edge;
const W = 320, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
function meanR(raw, x, y) {
  let r = 0, n = 0;
  for (let dy = -2; dy <= 2; dy++) { const i = ((y + dy) * W + x) * 3; if (i >= 0 && i < raw.length) { r += raw[i]; n++; } }
  return r / n;
}
function maxRband(raw, x0, x1, y) {
  let mx = 0;
  for (let x = x0; x <= x1; x++) { const v = meanR(raw, x, y); if (v > mx) mx = v; }
  return mx;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'emb-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'emb-render-'));
  edge = join(work, 'edge.mp4'); // hard vertical edge: left dark (40), right bright (220), at x=160
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=lum='if(lt(X,160),40,220)':cb=128:cr=128", '-pix_fmt', 'yuv420p', edge]);
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
  const { edl } = materializeExportEdl(comp, () => edge, { width: 320, height: 240, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves emboss: bare `true` => depth 1; nested {depth}; flat emboss_depth', () => {
  assert.deepEqual(clipTx(view([setTx({ emboss: true })])).emboss, { depth: 1 });
  assert.deepEqual(clipTx(view([setTx({ emboss: { depth: 2.5 } })])).emboss, { depth: 2.5 });
  assert.deepEqual(clipTx(view([setTx({ emboss_depth: 3 })])).emboss, { depth: 3 });
});

test('resolves emboss: depth clamps 0.2..4; absent stays undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ emboss: { depth: 10 } })])).emboss, { depth: 4 });
  assert.deepEqual(clipTx(view([setTx({ emboss: { depth: 0.05 } })])).emboss, { depth: 0.2 });
  assert.equal(clipTx(view([setTx({})])).emboss, undefined);
});

test('materialize emits emboss (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ emboss: { depth: 2.5 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].emboss, { depth: 2.5 });
});

test('OFFLINE RENDER: flat tone collapses to mid-gray while the edge surfaces as relief (L155)', () => {
  // Emboss maps flat tone -> ~mid-gray (128) and turns edges into light/dark relief. The base edge frame has
  // two DISTINCT flat halves (40 and 220); the embossed frame collapses BOTH to ~128, and the edge produces a
  // bright relief spike far above that flat mid-gray. Determinism proof: a fixed convolution is reproducible.
  const emb = frame(render({ emboss: { depth: 1 } }, 'emb-a', true), 0.5);
  const base = frame(render({}, 'emb-off', true), 0.5);
  const y = 120;

  const baseLeft = meanR(base, 80, y);   // ~40
  const baseRight = meanR(base, 240, y); // ~220
  const embLeft = meanR(emb, 80, y);     // ~128 (flat -> mid-gray relief)
  const embRight = meanR(emb, 240, y);   // ~128
  const embEdgeMax = maxRband(emb, 150, 170, y); // bright relief spike at the edge

  assert.ok(baseRight - baseLeft > 120, `base edge frame has two distinct flat tones: L=${baseLeft.toFixed(1)} R=${baseRight.toFixed(1)}`);
  assert.ok(Math.abs(embLeft - 128) < 12, `emboss collapses the dark half to mid-gray: ${embLeft.toFixed(1)}`);
  assert.ok(Math.abs(embRight - 128) < 12, `emboss collapses the bright half to mid-gray: ${embRight.toFixed(1)}`);
  assert.ok(embEdgeMax > 190, `the edge surfaces as a bright relief spike above the flat mid-gray: ${embEdgeMax.toFixed(1)}`);

  const a = render({ emboss: { depth: 1 } }, 'emb-det-a', true);
  const b = render({ emboss: { depth: 1 } }, 'emb-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic emboss renders of the same EDL are byte-identical');
});
