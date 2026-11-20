/**
 * #179 Warmth: static white-balance / color-temperature tint via ffmpeg `colortemperature`. DATA warmth:
 * true | { amount: -1..1 }. amount maps to Kelvin: positive => low K => warm (orange), negative => high K =>
 * cool (blue), 0 => ~6500K neutral. Distinct from #178 fisheye (geometry) and from `warmthRamp` (which
 * ANIMATES warmth over the clip) - this is a fixed tunable grade the fixed warm/cool LOOK presets do not give.
 *
 * Proof: DATA resolution (bare true => 0.5; nested {amount}; flat warmth_amount; clamp -1..1), materialize
 * pass-through, AND a real OFFLINE render on a flat gray frame where a WARM amount raises R relative to B and
 * a COOL amount lowers it (a directional channel-balance proof around the neutral base), PLUS a byte-identical
 * determinism proof. L155.
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
// mean (R - B) over a center region: positive = warm (red-heavy), negative = cool (blue-heavy).
function warmthRB(raw, x0, y0, w, h) {
  let s = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * W + x) * 3; if (i + 2 < raw.length) { s += raw[i] - raw[i + 2]; n++; } }
  return s / n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'warm-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'warm-render-'));
  gray = join(work, 'gray.mp4'); // flat neutral gray so the base R-B is ~0 and any shift is unambiguous
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

test('resolves warmth: bare `true` => 0.5; nested {amount}; flat warmth_amount', () => {
  assert.deepEqual(clipTx(view([setTx({ warmth: true })])).warmth, { amount: 0.5 });
  assert.deepEqual(clipTx(view([setTx({ warmth: { amount: -0.6 } })])).warmth, { amount: -0.6 });
  assert.deepEqual(clipTx(view([setTx({ warmth_amount: 0.3 })])).warmth, { amount: 0.3 });
});

test('resolves warmth: amount clamps -1..1; absent stays undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ warmth: { amount: 4 } })])).warmth, { amount: 1 });
  assert.deepEqual(clipTx(view([setTx({ warmth: { amount: -3 } })])).warmth, { amount: -1 });
  assert.equal(clipTx(view([setTx({})])).warmth, undefined);
});

test('materialize emits warmth (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ warmth: { amount: -0.6 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].warmth, { amount: -0.6 });
});

test('OFFLINE RENDER: a warm amount reddens and a cool amount blues, around a neutral base (L155)', () => {
  // On a flat neutral gray, base R-B ~ 0. A positive (warm) amount shifts toward orange so R-B rises; a
  // negative (cool) amount shifts toward blue so R-B falls. Proving both directions around the neutral base
  // makes it a directional white-balance proof, not just "color changed".
  const x0 = 140, y0 = 100, w = 40, h = 40;
  const baseRB = warmthRB(frame(render({}, 'warm-off', true), 0.5), x0, y0, w, h);
  const warmRB = warmthRB(frame(render({ warmth: { amount: 0.6 } }, 'warm-warm', true), 0.5), x0, y0, w, h);
  const coolRB = warmthRB(frame(render({ warmth: { amount: -0.6 } }, 'warm-cool', true), 0.5), x0, y0, w, h);

  assert.ok(Math.abs(baseRB) < 10, `neutral base has ~balanced R and B: R-B=${baseRB.toFixed(1)}`);
  assert.ok(warmRB - baseRB > 20, `a warm amount reddens the frame (R-B rises): ${warmRB.toFixed(1)} vs base ${baseRB.toFixed(1)}`);
  assert.ok(baseRB - coolRB > 8, `a cool amount blues the frame (R-B falls): ${coolRB.toFixed(1)} vs base ${baseRB.toFixed(1)}`);

  const a = render({ warmth: { amount: 0.6 } }, 'warm-det-a', true);
  const b = render({ warmth: { amount: 0.6 } }, 'warm-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic warmth renders of the same EDL are byte-identical');
});
