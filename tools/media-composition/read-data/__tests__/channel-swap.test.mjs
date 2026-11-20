/**
 * #190 Channel swap: the "wrong colors" / alien / infrared look, swapping two RGB channels via a FIXED
 * `colorchannelmixer` matrix. DATA channelSwap: true | { pair: 'rb' | 'rg' | 'gb' }. bare true seeds 'rb'
 * (the classic red<->blue swap). Distinct from a continuous hue rotation (this is a discrete channel swap)
 * and from duotone (a 2-color ramp). No DATA reaches the filter string (one of 3 constant matrices).
 *
 * Note: channelSwap is camelCase, so materialize snake-cases the top-level key to `channel_swap` (the dispatch
 * in video-compose.mjs reads segment.channel_swap).
 *
 * Proof: DATA resolution (bare true seeds 'rb'; nested {pair}; flat channel_swap_pair; unknown falls back to
 * 'rb'; absent undefined), materialize pass-through (as `channel_swap`), AND a real OFFLINE render whose oracle
 * is a CHANNEL CROSSOVER: a source with a pure RED bar (high R, low B) becomes a pure BLUE bar (low R, high B)
 * after an 'rb' swap. PLUS a byte-identical determinism proof. L155.
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
let work, red;
const W = 320, H = 240, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const digestHex = (file) => Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function rgbFrame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// mean of one channel (offset 0=R,1=G,2=B) over a band at row y, columns [x0,x1).
function chan(raw, y, off, x0, x1) {
  let s = 0, n = 0;
  for (let x = x0; x < x1; x++) { s += raw[(y * W + x) * 3 + off]; n++; }
  return Math.round(s / n);
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'csw-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'csw-render-'));
  red = join(work, 'red.mp4'); // a pure RED bar (r=240,g=20,b=20) on gray (110).
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=r='if(between(X,120,200),240,110)':g='if(between(X,120,200),20,110)':b='if(between(X,120,200),20,110)'", '-pix_fmt', 'yuv420p', red]);
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
  const { edl } = materializeExportEdl(comp, () => red, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves channelSwap: bare `true` seeds rb; nested {pair}; flat channel_swap_pair', () => {
  assert.deepEqual(clipTx(view([setTx({ channelSwap: true })])).channelSwap, { pair: 'rb' });
  assert.deepEqual(clipTx(view([setTx({ channelSwap: { pair: 'gb' } })])).channelSwap, { pair: 'gb' });
  assert.deepEqual(clipTx(view([setTx({ channel_swap_pair: 'rg' })])).channelSwap, { pair: 'rg' });
});

test('resolves channelSwap: unknown pair falls back to rb; absent undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ channelSwap: { pair: 'zz' } })])).channelSwap, { pair: 'rb' });
  assert.equal(clipTx(view([setTx({})])).channelSwap, undefined);
});

test('materialize emits channel_swap (camelToSnake top-level key, nested value verbatim)', () => {
  const comp = composeTimeline(view([setTx({ channelSwap: { pair: 'gb' } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].channel_swap, { pair: 'gb' });
});

test('OFFLINE RENDER: an rb swap turns the red bar blue (R and B channels cross over) (L155)', () => {
  const y = Math.floor(H / 2);
  const base = rgbFrame(render({}, 'csw-off', true), 0.5);
  const sw = rgbFrame(render({ channelSwap: { pair: 'rb' } }, 'csw-on', true), 0.5);

  const baseR = chan(base, y, 0, 120, 200), baseB = chan(base, y, 2, 120, 200);
  const swR = chan(sw, y, 0, 120, 200), swB = chan(sw, y, 2, 120, 200);

  assert.ok(baseR > 180 && baseB < 60, `base bar is RED: R=${baseR} B=${baseB}`);
  assert.ok(swR < 60, `after rb swap the bar's red goes low: ${swR}`);
  assert.ok(swB > 180, `after rb swap the bar's blue goes high: ${swB}`);
  // the channels crossed over: R was dominant, now B is.
  assert.ok(baseR - baseB > 120 && swB - swR > 120, `R and B crossed over: base R${baseR}/B${baseB} swap R${swR}/B${swB}`);

  const a = render({ channelSwap: { pair: 'rb' } }, 'csw-det-a', true);
  const b = render({ channelSwap: { pair: 'rb' } }, 'csw-det-b', true);
  assert.equal(digestHex(a), digestHex(b), 'two deterministic channel-swap renders of the same EDL are byte-identical');
});
