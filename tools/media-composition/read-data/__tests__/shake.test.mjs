/**
 * #146 Camera shake: the CapCut/action "impact" hit + handheld rumble, the creative INVERSE of #85
 * stabilize. DATA `shake` {amplitude, frequency?, decay?}. The render crops an aspect-preserving inset
 * window whose x/y offset oscillates over time (sin/cos at slightly different frequencies), then scales
 * back to fill, so the whole frame jitters. `decay`>0 fades the amplitude to 0 over the clip (a single
 * impact) instead of a sustained rumble. One animated-crop string, the same primitive as reframe/ken-burns.
 *
 * Proof: DATA resolution (clamp 0..0.2, amplitude<=0 dropped, aliases, frequency/decay pass-through),
 * materialize pass-through, AND a real offline render where the frame ACTUALLY MOVES across time
 * (L155 temporal corollary: a pixel-diff across frames, never a value-change proxy) plus a no-shake
 * regression where the frame is stable.
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
let work, src;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
// mean RGB of a small window, read as raw rgb24 bytes (never od: 16-byte line-wrap misaligns triplets).
function meanRGB(file, ss, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  const n = raw.length / 3;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}
const isRed = (c) => c.r > 150 && c.r > c.b + 60;
const isBlue = (c) => c.b > 150 && c.b > c.r + 60;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'shk-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'shk-render-'));
  // a sharp vertical edge: left half red, right half blue. Camera shake sweeps this edge horizontally,
  // so a fixed column near the center flips color across frames = the motion is visible in pixels.
  src = join(work, 'split.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=320x240:d=2:r=24', '-vf', 'drawbox=x=160:y=0:w=160:h=240:color=blue:t=fill', '-pix_fmt', 'yuv420p', src]);
});

const view = (decisions, dur = 2) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: dur, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => src, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('amplitude clamps to 0..0.2, drops when <=0; frequency/decay pass through; aliases resolve', () => {
  const a = clipTx(view([setTx({ shake: { amplitude: 0.9, frequency: 12, decay: 2 } })])).shake;
  assert.deepEqual(a, { amplitude: 0.2, frequency: 12, decay: 2 });
  assert.equal(clipTx(view([setTx({ shake: { amplitude: 0 } })])).shake, undefined);
  assert.equal(clipTx(view([setTx({ shake: { amplitude: -1 } })])).shake, undefined);
  // aliases: `amount` for amplitude, `hz` for frequency, and `camera_shake`/`cameraShake` for the block.
  assert.deepEqual(clipTx(view([setTx({ camera_shake: { amount: 0.05, hz: 6 } })])).shake, { amplitude: 0.05, frequency: 6 });
  // a bare amplitude (no frequency/decay) is the sustained-rumble default.
  assert.deepEqual(clipTx(view([setTx({ shake: { amplitude: 0.04 } })])).shake, { amplitude: 0.04 });
});

test('materialize emits shake.{amplitude,frequency,decay} (nested, verbatim)', () => {
  const comp = composeTimeline(view([setTx({ shake: { amplitude: 0.05, frequency: 8, decay: 1.5 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].shake, { amplitude: 0.05, frequency: 8, decay: 1.5 });
});

test('OFFLINE RENDER: shake MOVES the frame (a fixed column flips color across frames); no-shake is stable (L155)', () => {
  // freq 1 Hz so the edge sweeps a clean half-cycle: at t=0.25 the offset is +max, at t=0.75 it is -max,
  // so the red/blue edge sweeps PAST the center column x=160 (blue -> red). That color flip IS the motion.
  const out = render({ shake: { amplitude: 0.05, frequency: 1 } }, 'shk');
  const early = meanRGB(out, 0.25, { x: 160, y: 110, w: 4, h: 20 });
  const late = meanRGB(out, 0.75, { x: 160, y: 110, w: 4, h: 20 });
  assert.ok(isBlue(early), `shake t=0.25 the edge moved right so x160 is blue: ${JSON.stringify(early)}`);
  assert.ok(isRed(late), `shake t=0.75 the edge moved left so x160 is red: ${JSON.stringify(late)}`);

  // regression: no shake -> the edge is fixed at x=160, so the same column reads the SAME color both times.
  const plain = render(null, 'shk-none');
  const p1 = meanRGB(plain, 0.25, { x: 160, y: 110, w: 4, h: 20 });
  const p2 = meanRGB(plain, 0.75, { x: 160, y: 110, w: 4, h: 20 });
  assert.ok(Math.abs(p1.r - p2.r) < 20 && Math.abs(p1.b - p2.b) < 20, `no-shake column is stable: ${JSON.stringify(p1)} vs ${JSON.stringify(p2)}`);
});

test('OFFLINE RENDER: decay makes the shake ALIVE early and DEAD late (env=max(0,1-decay*t) reaches 0)', () => {
  // decay 1.2 => env is 0 for t >= 1/1.2 = 0.833s. So two nearby EARLY frames differ (the edge is sweeping
  // past x=160 at 6 Hz), while two LATE frames are identical (the shake has fully died out, edge at rest).
  const out = render({ shake: { amplitude: 0.08, frequency: 6, decay: 1.2 } }, 'shk-decay');
  const e1 = meanRGB(out, 0.10, { x: 160, y: 110, w: 6, h: 20 });
  const e2 = meanRGB(out, 0.18, { x: 160, y: 110, w: 6, h: 20 });
  const l1 = meanRGB(out, 1.00, { x: 160, y: 110, w: 6, h: 20 });
  const l2 = meanRGB(out, 1.10, { x: 160, y: 110, w: 6, h: 20 });
  const early = Math.abs(e1.r - e2.r) + Math.abs(e1.b - e2.b);
  const late = Math.abs(l1.r - l2.r) + Math.abs(l1.b - l2.b);
  assert.ok(early > 80, `shake alive early (frame moves): delta=${early.toFixed(0)} ${JSON.stringify(e1)} vs ${JSON.stringify(e2)}`);
  assert.ok(late < 20, `shake dead late (frame at rest): delta=${late.toFixed(0)} ${JSON.stringify(l1)} vs ${JSON.stringify(l2)}`);
});
