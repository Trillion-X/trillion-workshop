/**
 * #177 Defocus: uniform full-frame gaussian blur (a focus pull / out-of-focus / soft reveal) via ffmpeg's
 * `gblur`. DATA defocus: true | { amount: 0.3..40 } (amount = blur radius/sigma). Distinct from motionBlur
 * (directional), zoomBlur (radial), tiltShift (band-only), glow (highlights-only), and the fixed `dreamy`
 * LOOK preset - it is the plain tunable isotropic blur none of them provide, and it composes on top of any.
 *
 * Proof: DATA resolution (bare true => 8; nested {amount}; flat defocus_amount; clamp 0.3..40), materialize
 * pass-through, AND a real OFFLINE render on a HARD vertical edge (left 40, right 220) where the sharp edge
 * (near-zero intermediate tones) becomes a SPREAD ramp full of mid-tone columns, while flat regions far from
 * the edge keep their tone, PLUS a byte-identical determinism proof (gblur is reproducible). L155.
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
// count columns whose tone is strictly BETWEEN the two flat tones (a spread edge has many; a sharp edge ~none).
function midToneCols(raw, x0, x1, y) {
  let n = 0;
  for (let x = x0; x <= x1; x++) { const v = meanR(raw, x, y); if (v > 80 && v < 180) n++; }
  return n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'def-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'def-render-'));
  edge = join(work, 'edge.mp4'); // hard vertical edge: left 40, right 220, at x=160
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

test('resolves defocus: bare `true` => amount 8; nested {amount}; flat defocus_amount', () => {
  assert.deepEqual(clipTx(view([setTx({ defocus: true })])).defocus, { amount: 8 });
  assert.deepEqual(clipTx(view([setTx({ defocus: { amount: 12 } })])).defocus, { amount: 12 });
  assert.deepEqual(clipTx(view([setTx({ defocus_amount: 20 })])).defocus, { amount: 20 });
});

test('resolves defocus: amount clamps 0.3..40; absent stays undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ defocus: { amount: 100 } })])).defocus, { amount: 40 });
  assert.deepEqual(clipTx(view([setTx({ defocus: { amount: 0.01 } })])).defocus, { amount: 0.3 });
  assert.equal(clipTx(view([setTx({})])).defocus, undefined);
});

test('materialize emits defocus (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ defocus: { amount: 12 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].defocus, { amount: 12 });
});

test('OFFLINE RENDER: defocus spreads a hard edge into a mid-tone ramp while flat tone survives (L155)', () => {
  // A hard edge jumps 40 -> 220 in ~1px (almost no intermediate tones). A uniform blur spreads that step over
  // ~amount px, so the edge band fills with mid-tone columns; flat regions far from the edge keep their tone.
  const d = frame(render({ defocus: { amount: 8 } }, 'def-a', true), 0.5);
  const base = frame(render({}, 'def-off', true), 0.5);
  const y = 120;

  const baseMid = midToneCols(base, 120, 200, y); // sharp edge => ~none
  const defMid = midToneCols(d, 120, 200, y);     // spread edge => a real ramp of intermediate tones
  assert.ok(baseMid < 4, `the base edge is sharp (few mid-tone columns): ${baseMid}`);
  assert.ok(defMid >= 6 && defMid > baseMid + 4, `defocus spreads the edge into a mid-tone ramp: ${defMid} (base ${baseMid})`);

  // flat tone survives far from the edge (blur of a flat region is that region).
  assert.ok(Math.abs(meanR(d, 40, y) - meanR(base, 40, y)) < 15, 'the dark flat far-left keeps its tone');
  assert.ok(Math.abs(meanR(d, 290, y) - meanR(base, 290, y)) < 15, 'the bright flat far-right keeps its tone');

  const a = render({ defocus: { amount: 8 } }, 'def-det-a', true);
  const b = render({ defocus: { amount: 8 } }, 'def-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic defocus renders of the same EDL are byte-identical');
});
