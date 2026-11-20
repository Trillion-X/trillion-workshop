/**
 * #160 Scanlines (CRT / retro): darken periodic horizontal lines. Each row is scaled by
 * 1 - depth*(0.5+0.5*cos(2PI*(Y/period + roll*t))), so the dark band repeats every `period` px and, when
 * roll > 0, scrolls over time (the CRT roll). A COMPUTED per-pixel pattern the static grade seam cannot
 * express portably (it needs Y + t).
 *
 * Proof: DATA resolution (nested {depth,period,roll} + flat scanlines_*; depth <= 0 dropped; clamps),
 * materialize pass-through, AND a real offline render on a gray clip where row brightness OSCILLATES with Y
 * (dark line vs bright gap) and, with roll, a FIXED row's brightness changes over time (L155 temporal).
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
let work, gray;
const W = 320;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
function rowLum(raw, y) {
  let s = 0, n = 0; for (let x = 0; x < W; x += 4) { const i = (y * W + x) * 3; if (i < raw.length) { s += raw[i]; n++; } }
  return n ? s / n : -1;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'scan-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'scan-render-'));
  gray = join(work, 'gray.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x808080:s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', gray]);
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
  const { edl } = materializeExportEdl(comp, () => gray, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves scanlines: nested {depth,period,roll} + flat scanlines_*; depth <= 0 dropped; clamps', () => {
  assert.deepEqual(clipTx(view([setTx({ scanlines: { depth: 0.5, period: 4, roll: 3 } })])).scanlines, { depth: 0.5, period: 4, roll: 3 });
  assert.deepEqual(clipTx(view([setTx({ scanlines_depth: 2, scanlines_period: 6 })])).scanlines, { depth: 1, period: 6 }); // depth clamped to 1
  assert.equal(clipTx(view([setTx({ scanlines: { depth: 0 } })])).scanlines, undefined);
  assert.equal(clipTx(view([setTx({ scanlines: { depth: -1 } })])).scanlines, undefined);
});

test('materialize emits scanlines (snake-cased top-level, nested verbatim)', () => {
  const comp = composeTimeline(view([setTx({ scanlines: { depth: 0.6, period: 4, roll: 2 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].scanlines, { depth: 0.6, period: 4, roll: 2 });
});

test('OFFLINE RENDER: row brightness OSCILLATES with Y (dark line vs bright gap), and rolls over time (L155)', () => {
  // roll 3 waves/sec: a 0.5s gap is 1.5 cycles (not an integer, so the phase genuinely shifts).
  const out = render({ scanlines: { depth: 0.6, period: 6, roll: 3 } }, 'scan');
  const f0 = frame(out, 0.0);
  // over a 6px period, the brightest row and darkest row within [y..y+5] differ substantially.
  const lums = [];
  for (let y = 40; y < 52; y++) lums.push(rowLum(f0, y));
  const spread = Math.max(...lums) - Math.min(...lums);
  assert.ok(spread > 40, `rows oscillate (dark line vs bright gap): spread=${spread.toFixed(1)} lums=${lums.map((n) => Math.round(n))}`);
  // rolling: a fixed row's brightness changes over time (sample 1.5 cycles apart to avoid phase alignment).
  const y = 45;
  const t0 = rowLum(f0, y), t1 = rowLum(frame(out, 0.5), y);
  assert.ok(Math.abs(t0 - t1) > 20, `scanline rolls over time at a fixed row: t0=${t0.toFixed(1)} t1=${t1.toFixed(1)}`);
});

test('OFFLINE RENDER: no scanlines leaves the gray flat (regression)', () => {
  const out = render({}, 'scan-off');
  const f0 = frame(out, 0.0);
  const lums = [];
  for (let y = 40; y < 52; y++) lums.push(rowLum(f0, y));
  const spread = Math.max(...lums) - Math.min(...lums);
  assert.ok(spread < 10, `flat gray without scanlines: spread=${spread.toFixed(1)}`);
});
