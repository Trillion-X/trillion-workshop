/**
 * #182 Smooth: edge-PRESERVING light smooth via ffmpeg `smartblur`, the mobile-editor "beauty" / noise
 * soften. DATA smooth: true | { amount: 0..1 }. Distinct from #123 sharpen (opposite), from #177 defocus
 * (a full gaussian blur that also blurs edges), and from the heavy out-of-process `denoise` binary field
 * (a separate ML denoiser). This is a light in-filter smooth that ADDS that capability to the toggle set.
 *
 * Proof: DATA resolution (bare true => 0.6; nested {amount}; flat smooth_amount; clamp 0..1; 0 dropped),
 * materialize pass-through, AND a real OFFLINE render whose oracle is the SMOOTH signature: a flat NOISY
 * region loses variance (its stddev drops), so the noise is softened. Convention-agnostic (it measures that
 * the flat-region variance actually fell), PLUS a byte-identical determinism proof. L155.
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
let work, noisy;
const W = 200, H = 200, FPS = 24;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
// Stddev of the gray channel over an interior band at 0.5s, a flat noisy region; smoothing lowers it.
function bandStddev(file, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', file,
    '-vf', `format=gray,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0; for (let i = 0; i < raw.length; i++) s += raw[i];
  const mean = s / raw.length;
  let v = 0; for (let i = 0; i < raw.length; i++) v += (raw[i] - mean) ** 2;
  return Math.sqrt(v / raw.length);
}
const FLAT_BAND = { x: 40, y: 40, w: 120, h: 120 };

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'smooth-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'smooth-render-'));
  noisy = join(work, 'noisy.mp4'); // flat mid-gray with baked static noise (seeded, so renders are stable).
  ffmpeg(['-f', 'lavfi', '-i', `color=gray:s=200x200:d=1:r=${FPS}`, '-vf', 'noise=alls=30:allf=t+u:all_seed=8675309', '-pix_fmt', 'yuv420p', noisy]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'n.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-10T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name, deterministic) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => noisy, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves smooth: bare `true` => 0.6; nested {amount}; flat smooth_amount', () => {
  assert.deepEqual(clipTx(view([setTx({ smooth: true })])).smooth, { amount: 0.6 });
  assert.deepEqual(clipTx(view([setTx({ smooth: { amount: 0.9 } })])).smooth, { amount: 0.9 });
  assert.deepEqual(clipTx(view([setTx({ smooth_amount: 0.4 })])).smooth, { amount: 0.4 });
});

test('resolves smooth: amount clamps to 1; 0 (identity) and absent stay undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ smooth: { amount: 5 } })])).smooth, { amount: 1 });
  assert.equal(clipTx(view([setTx({ smooth: { amount: 0 } })])).smooth, undefined);
  assert.equal(clipTx(view([setTx({})])).smooth, undefined);
});

test('materialize emits smooth (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ smooth: { amount: 0.9 } })]));
  const { edl } = materializeExportEdl(comp, () => 'n.mp4', {});
  assert.deepEqual(edl.spine.segments[0].smooth, { amount: 0.9 });
});

test('OFFLINE RENDER: smooth lowers the flat-region noise variance vs the plain clip (L155)', () => {
  const plain = bandStddev(render(null, 'smooth-off', true), FLAT_BAND);
  const smoothed = bandStddev(render({ smooth: { amount: 1 } }, 'smooth-on', true), FLAT_BAND);
  assert.ok(smoothed < plain - 2, `smooth softens the flat-region noise: stddev ${smoothed.toFixed(2)} < ${plain.toFixed(2)}`);

  const a = render({ smooth: { amount: 1 } }, 'smooth-det-a', true);
  const b = render({ smooth: { amount: 1 } }, 'smooth-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic smooth renders of the same EDL are byte-identical');
});
