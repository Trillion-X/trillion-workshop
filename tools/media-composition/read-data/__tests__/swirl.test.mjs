/**
 * #185 Swirl: a rotational twist (strongest at the center, fading to zero at the edge) via a geq coordinate
 * remap, the same sampling mechanism the beat-glitch / gradient-map effects use. DATA swirl: true |
 * { strength: -1..1 } (sign = twist direction). A geometric distortion distinct from #178 fisheye (radial
 * bulge), #181 perspective (keystone), and wobble (traveling wave).
 *
 * Proof: DATA resolution (bare true => 0.6; nested {strength}; flat swirl_strength; clamp -1..1; 0 dropped),
 * materialize pass-through, AND a real OFFLINE render whose oracle is the ROTATIONAL signature: a straight
 * FULL-HEIGHT vertical bar has the same centroid on every row when un-swirled, but a swirl rotates each row
 * by a different angle (twist depends on radius), so the bar's per-row centroids SPREAD apart. We measure the
 * spread (max centroid - min centroid across three rows): near-zero base, large under swirl. This also
 * exercises the escaped-comma geq end to end through materialize + video-compose. PLUS a byte-identical
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
const rowCentroid = (raw, y) => { let sx = 0, n = 0; for (let x = 0; x < W; x++) { if (raw[y * W + x] > 120) { sx += x; n++; } } return n ? sx / n : null; };
const centroidSpread = (raw) => { const c = [40, 120, 200].map((y) => rowCentroid(raw, y)); if (c.some((v) => v === null)) return null; return Math.max(...c) - Math.min(...c); };

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'swirl-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'swirl-render-'));
  bar = join(work, 'bar.mp4'); // a straight FULL-HEIGHT bright vertical bar, off-center at x=236..244.
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=r='if(between(X,236,244),240,20)':g='if(between(X,236,244),240,20)':b='if(between(X,236,244),240,20)'", '-pix_fmt', 'yuv420p', bar]);
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

test('resolves swirl: bare `true` => 0.6; nested {strength}; flat swirl_strength', () => {
  assert.deepEqual(clipTx(view([setTx({ swirl: true })])).swirl, { strength: 0.6 });
  assert.deepEqual(clipTx(view([setTx({ swirl: { strength: -0.8 } })])).swirl, { strength: -0.8 });
  assert.deepEqual(clipTx(view([setTx({ swirl_strength: 0.5 })])).swirl, { strength: 0.5 });
});

test('resolves swirl: strength clamps -1..1; 0 and absent stay undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ swirl: { strength: 4 } })])).swirl, { strength: 1 });
  assert.deepEqual(clipTx(view([setTx({ swirl: { strength: -9 } })])).swirl, { strength: -1 });
  assert.equal(clipTx(view([setTx({ swirl: { strength: 0 } })])).swirl, undefined);
  assert.equal(clipTx(view([setTx({})])).swirl, undefined);
});

test('materialize emits swirl (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ swirl: { strength: -0.8 } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].swirl, { strength: -0.8 });
});

test('OFFLINE RENDER: a swirl spreads the straight bar per-row centroids; the base bar stays vertical (L155)', () => {
  const base = centroidSpread(grayFrame(render({}, 'swirl-off', true), 0.5));
  const sw = centroidSpread(grayFrame(render({ swirl: { strength: 1 } }, 'swirl-on', true), 0.5));
  assert.ok(base !== null && sw !== null, `the bar is visible in both renders: base=${base} sw=${sw}`);
  assert.ok(base < 3, `the base bar is vertical (per-row centroids agree): spread=${base?.toFixed(1)}`);
  assert.ok(sw > 10, `the swirl twists the bar (per-row centroids spread apart): spread=${sw?.toFixed(1)}`);

  const a = render({ swirl: { strength: 1 } }, 'swirl-det-a', true);
  const b = render({ swirl: { strength: 1 } }, 'swirl-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic swirl renders of the same EDL are byte-identical');
});
