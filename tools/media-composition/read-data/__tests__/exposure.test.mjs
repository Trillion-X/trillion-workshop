/**
 * #191 Exposure: brighten or darken in LINEAR light by a number of photographic stops (the exponential
 * Lightroom "exposure" slider), via ffmpeg's native `exposure` filter. DATA exposure: true | { stops: -2..2 }.
 * bare true seeds 0.6; stops 0 is identity (dropped). Distinct from the plain LINEAR eq brightness (an
 * additive offset): a stop multiplies light, so it lifts shadows far more than a fixed add would.
 *
 * Proof: DATA resolution (bare true seeds 0.6; nested {stops}; flat exposure_stops; clamp -2..2; stops 0
 * dropped; absent undefined), materialize pass-through, AND a real OFFLINE render whose oracle is BRIGHTENING:
 * a mid-dark gray bar gets clearly brighter after a positive exposure, and a negative exposure darkens it. A
 * moderate stop value keeps the bar off the 255 ceiling so the gain is measurable (not clip-masked). PLUS a
 * byte-identical determinism proof. L155.
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
const mean = (row, lo, hi) => { let s = 0, n = 0; for (let x = lo; x < hi; x++) { s += row[x]; n++; } return Math.round(s / n); };

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'exp-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'exp-render-'));
  bar = join(work, 'bar.mp4'); // a mid-DARK gray bar (value 70) on darker gray (40), well below the 255 ceiling.
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=r='if(between(X,120,200),70,40)':g='if(between(X,120,200),70,40)':b='if(between(X,120,200),70,40)'", '-pix_fmt', 'yuv420p', bar]);
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

test('resolves exposure: bare `true` seeds 0.6; nested {stops}; flat exposure_stops', () => {
  assert.deepEqual(clipTx(view([setTx({ exposure: true })])).exposure, { stops: 0.6 });
  assert.deepEqual(clipTx(view([setTx({ exposure: { stops: 1.2 } })])).exposure, { stops: 1.2 });
  assert.deepEqual(clipTx(view([setTx({ exposure_stops: -0.8 })])).exposure, { stops: -0.8 });
});

test('resolves exposure: clamps -2..2; stops 0 dropped; absent undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ exposure: { stops: 9 } })])).exposure, { stops: 2 });
  assert.deepEqual(clipTx(view([setTx({ exposure: { stops: -9 } })])).exposure, { stops: -2 });
  assert.equal(clipTx(view([setTx({ exposure: { stops: 0 } })])).exposure, undefined);
  assert.equal(clipTx(view([setTx({})])).exposure, undefined);
});

test('materialize emits exposure (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ exposure: { stops: 1.2 } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].exposure, { stops: 1.2 });
});

test('OFFLINE RENDER: a positive exposure brightens the dark bar, a negative one darkens it (L155)', () => {
  const y = Math.floor(H / 2);
  const base = mean(grayRow(render({}, 'exp-off', true), 0.5, y), 120, 200);
  const up = mean(grayRow(render({ exposure: { stops: 0.8 } }, 'exp-up', true), 0.5, y), 120, 200);
  const down = mean(grayRow(render({ exposure: { stops: -0.8 } }, 'exp-down', true), 0.5, y), 120, 200);

  assert.ok(base > 40 && base < 110, `the base bar is mid-dark, off the ceiling: ${base}`);
  assert.ok(up > base + 20, `a positive exposure clearly brightens the bar: ${up} vs ${base}`);
  assert.ok(down < base - 10, `a negative exposure darkens the bar: ${down} vs ${base}`);

  const a = render({ exposure: { stops: 0.8 } }, 'exp-det-a', true);
  const b = render({ exposure: { stops: 0.8 } }, 'exp-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic exposure renders of the same EDL are byte-identical');
});
