/**
 * #187 Tile: repeat the whole frame in an NxN grid, via a geq coordinate remap `mod(X*n, W) / mod(Y*n, H)`
 * (no trig, no scaling filter). DATA tile: true | { count: 2..6 }. bare true means a 2x2 grid; count clamped to
 * 2..6 and rounded. Distinct from #186 mirror (a symmetric self-fold, not a repeat).
 *
 * Proof: DATA resolution (bare true gives {count 2}; nested {count}; flat tile_count; clamp 2..6 round; count<2
 * dropped; absent undefined), materialize pass-through, AND a real OFFLINE render whose oracle is SPATIAL
 * REPETITION: a source with a bright bar ONLY at x=80..90 becomes, after a 2x2 tile, TWO bars, because the
 * sampler maps output X to source mod(X*2,320), so the bar reappears where 2X equals 80..90 (x=40..45) and
 * where 2X-320 equals 80..90 (x=200..205). The oracle is SPATIAL band position, not pixel count: a mod(X*2)
 * remap compresses each copy 2x, so two half-width bars have roughly the same total bright px as one full-width
 * bar. So the base has one band mid-frame (60..180, nothing at the edges) and the tile grows bands at x<60 and
 * x>180 while emptying the middle. PLUS a byte-identical determinism proof. L155.
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
const brightXs = (row) => { const xs = []; for (let x = 0; x < W; x++) if (row[x] > 120) xs.push(x); return xs; };

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'tile-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'tile-render-'));
  bar = join(work, 'bar.mp4'); // a bright vertical bar ONLY at x=80..90, so there is exactly one band.
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

test('resolves tile: bare `true` gives {count 2}; nested {count}; flat tile_count', () => {
  assert.deepEqual(clipTx(view([setTx({ tile: true })])).tile, { count: 2 });
  assert.deepEqual(clipTx(view([setTx({ tile: { count: 4 } })])).tile, { count: 4 });
  assert.deepEqual(clipTx(view([setTx({ tile_count: 3 })])).tile, { count: 3 });
});

test('resolves tile: count clamps to 2..6 and rounds; count<2 dropped; absent undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ tile: { count: 9 } })])).tile, { count: 6 });
  assert.deepEqual(clipTx(view([setTx({ tile: { count: 3.7 } })])).tile, { count: 4 });
  assert.equal(clipTx(view([setTx({ tile: { count: 1 } })])).tile, undefined);
  assert.equal(clipTx(view([setTx({})])).tile, undefined);
});

test('materialize emits tile (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ tile: { count: 3 } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].tile, { count: 3 });
});

test('OFFLINE RENDER: a 2x2 tile repeats the single bar into two bands at new x positions (L155)', () => {
  const y = Math.floor(H / 2);
  const base = brightXs(grayRow(render({}, 'tile-off', true), 0.5, y));
  const tiled = brightXs(grayRow(render({ tile: { count: 2 } }, 'tile-on', true), 0.5, y));

  // base: exactly one band, at x=80..90, nothing at the frame edges (below 60 or above 180).
  assert.ok(base.length >= 6 && base.length <= 20, `the base has one ~11px band: ${base.length}px`);
  assert.ok(base.every((x) => x >= 60 && x <= 180), `the base band sits mid-frame: [${base[0]}..${base[base.length - 1]}]`);
  assert.equal(base.filter((x) => x < 60).length, 0, 'the base has NO band near x=40');
  assert.equal(base.filter((x) => x > 180).length, 0, 'the base has NO band near x=200');

  // tiled: the single band splits into TWO repeated bands, one near x=40 and one near x=200, and the
  // original mid-frame band (80..90) empties (the tile moved it to the edges). Spatial position, not count.
  assert.ok(tiled.some((x) => x >= 38 && x <= 48), `a repeated band appears near x=40: ${tiled.filter((x) => x < 60).join(',')}`);
  assert.ok(tiled.some((x) => x >= 198 && x <= 208), `a repeated band appears near x=200: ${tiled.filter((x) => x > 180).join(',')}`);
  assert.equal(tiled.filter((x) => x >= 75 && x <= 95).length, 0, 'the original mid-frame band is gone (moved to the edges by the tile)');

  const a = render({ tile: { count: 2 } }, 'tile-det-a', true);
  const b = render({ tile: { count: 2 } }, 'tile-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic tile renders of the same EDL are byte-identical');
});
