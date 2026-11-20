/**
 * #178 Fisheye: barrel / pincushion lens distortion via ffmpeg `lenscorrection` (k1 coefficient). DATA
 * fisheye: true | { strength: -1..1 }. Negative k1 bulges the frame outward from center (barrel/fisheye),
 * positive pinches it inward (pincushion). This is the first OPTICAL/geometric warp effect - it MOVES pixels
 * (it does not recolor or soften them), so it is genuinely new (no color grade or blur does this).
 *
 * Proof: DATA resolution (bare true => -0.4; nested {strength}; flat fisheye_strength; clamp -1..1),
 * materialize pass-through, AND a real OFFLINE render of a thin off-center vertical bar whose CENTROID moves
 * OUTWARD under a negative strength (bulge) and INWARD under a positive strength (pinch), while the base bar
 * stays put - a directional geometric-displacement proof, PLUS a byte-identical determinism proof. L155.
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
// centroid x of the bright bar on row y (bar R ~240 on black ~20, so >120 is robust to codec wobble).
function barCentroid(raw, y) {
  let sx = 0, n = 0;
  for (let x = 0; x < W; x++) { const r = raw[(y * W + x) * 3]; if (r > 120) { sx += x; n++; } }
  return n ? sx / n : null;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'fish-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'fish-render-'));
  bar = join(work, 'bar.mp4'); // a thin bright vertical bar at x=236..244 (off-center; center is 160)
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=lum='if(between(X,236,244),240,20)':cb=128:cr=128", '-pix_fmt', 'yuv420p', bar]);
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

test('resolves fisheye: bare `true` => -0.4; nested {strength}; flat fisheye_strength', () => {
  assert.deepEqual(clipTx(view([setTx({ fisheye: true })])).fisheye, { strength: -0.4 });
  assert.deepEqual(clipTx(view([setTx({ fisheye: { strength: -0.6 } })])).fisheye, { strength: -0.6 });
  assert.deepEqual(clipTx(view([setTx({ fisheye_strength: 0.5 })])).fisheye, { strength: 0.5 });
});

test('resolves fisheye: strength clamps -1..1; absent stays undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ fisheye: { strength: -3 } })])).fisheye, { strength: -1 });
  assert.deepEqual(clipTx(view([setTx({ fisheye: { strength: 5 } })])).fisheye, { strength: 1 });
  assert.equal(clipTx(view([setTx({})])).fisheye, undefined);
});

test('materialize emits fisheye (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ fisheye: { strength: -0.6 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].fisheye, { strength: -0.6 });
});

test('OFFLINE RENDER: the bar centroid moves OUTWARD (bulge) and INWARD (pinch), directional (L155)', () => {
  // A negative strength (barrel) bulges the frame outward, so an off-center bar moves AWAY from center; a
  // positive strength (pincushion) pinches inward, so it moves TOWARD center. The base bar stays put. Proving
  // both directions makes this an unambiguous geometric-displacement proof, not just "something changed".
  const y = 120;
  const baseC = barCentroid(frame(render({}, 'fish-off', true), 0.5), y);
  const bulgeC = barCentroid(frame(render({ fisheye: { strength: -0.6 } }, 'fish-bulge', true), 0.5), y);
  const pinchC = barCentroid(frame(render({ fisheye: { strength: 0.6 } }, 'fish-pinch', true), 0.5), y);

  assert.ok(baseC !== null && bulgeC !== null && pinchC !== null, `the bar is visible in every render: base=${baseC} bulge=${bulgeC} pinch=${pinchC}`);
  assert.ok(Math.abs(baseC - 240) < 6, `the base bar sits at its authored position ~240: ${baseC.toFixed(1)}`);
  assert.ok(bulgeC - baseC > 5, `barrel bulge pushes the off-center bar OUTWARD (away from center): ${bulgeC.toFixed(1)} vs base ${baseC.toFixed(1)}`);
  assert.ok(baseC - pinchC > 3, `pincushion pinch pulls the bar INWARD (toward center): ${pinchC.toFixed(1)} vs base ${baseC.toFixed(1)}`);

  const a = render({ fisheye: { strength: -0.6 } }, 'fish-det-a', true);
  const b = render({ fisheye: { strength: -0.6 } }, 'fish-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic fisheye renders of the same EDL are byte-identical');
});
