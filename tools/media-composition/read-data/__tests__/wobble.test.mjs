/**
 * #157 Wobble / wave-warp: a per-frame sinusoidal horizontal displacement (the underwater / dream /
 * heat-haze look). Each output pixel samples the source at X + amplitude*sin(2PI*(Y/wavelength + speed*t)),
 * so every row shifts by a phase that depends on Y (wavy down the frame) and animates with t.
 * wavelength = H / frequency. A COMPUTED per-frame geometric primitive the static grade seam cannot express.
 *
 * Proof: DATA resolution (nested {amplitude,frequency,speed} + flat wobble_*; amplitude <= 0 dropped),
 * materialize pass-through, AND a real offline render on a hard red|blue vertical edge where the edge
 * x-position VARIES BY ROW at a fixed time (wavy) and MOVES over time at a fixed row (animated), L155.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
let composeTimeline, materializeExportEdl;
let work, edge;
const W = 320, H = 240;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function frameRGB(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// first x on a row where the pixel is clearly blue (past the red|blue edge)
function edgeX(raw, y) {
  for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; if (i + 2 < raw.length && raw[i + 2] > raw[i] + 40) return x; }
  return -1;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'wob-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'wob-render-'));
  edge = join(work, 'edge.mp4'); // left half red, right half blue: hard vertical edge at x=160
  ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=160x240:d=2:r=24', '-f', 'lavfi', '-i', 'color=blue:s=160x240:d=2:r=24',
    '-filter_complex', '[0][1]hstack=2', '-pix_fmt', 'yuv420p', edge]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-08T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => edge, { width: W, height: H, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves wobble: nested {amplitude,frequency,speed} + flat wobble_*; amplitude <= 0 dropped', () => {
  assert.deepEqual(clipTx(view([setTx({ wobble: { amplitude: 10, frequency: 4, speed: 1 } })])).wobble, { amplitude: 10, frequency: 4, speed: 1 });
  assert.deepEqual(clipTx(view([setTx({ wobble_amplitude: 6 })])).wobble, { amplitude: 6 });
  assert.equal(clipTx(view([setTx({ wobble: { amplitude: 0 } })])).wobble, undefined);
  assert.equal(clipTx(view([setTx({ wobble: { amplitude: -3 } })])).wobble, undefined);
});

test('materialize emits wobble (snake-cased top-level, nested verbatim)', () => {
  const comp = composeTimeline(view([setTx({ wobble: { amplitude: 12, frequency: 2, speed: 0.5 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].wobble, { amplitude: 12, frequency: 2, speed: 0.5 });
});

test('OFFLINE RENDER: the edge is WAVY by row and ANIMATES over time (L155)', () => {
  // amplitude 20, frequency 2 -> wavelength 120; peak rows y=30 (+20 -> edge ~140) and y=90 (-20 -> edge ~180).
  const out = render({ wobble: { amplitude: 20, frequency: 2, speed: 0.5 } }, 'wob');
  const f0 = frameRGB(out, 0.0);
  const y30 = edgeX(f0, 30), y90 = edgeX(f0, 90);
  assert.ok(y30 > 0 && y90 > 0, `edge found at both rows: y30=${y30} y90=${y90}`);
  assert.ok(Math.abs(y30 - y90) > 20, `edge is wavy (differs by row): y30=${y30} y90=${y90}`);
  const f1 = frameRGB(out, 1.0);
  const y30late = edgeX(f1, 30);
  assert.ok(Math.abs(y30late - y30) > 20, `edge animates over time at a fixed row: t0=${y30} t1=${y30late}`);
});

test('OFFLINE RENDER: no wobble leaves a straight, static edge (regression)', () => {
  const out = render({}, 'wob-off');
  const f0 = frameRGB(out, 0.0);
  const y30 = edgeX(f0, 30), y90 = edgeX(f0, 90);
  assert.ok(Math.abs(y30 - y90) <= 4, `edge is straight without wobble: y30=${y30} y90=${y90}`);
});
