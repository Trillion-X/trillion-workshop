/**
 * #171 Hue rotation. `hueShift` spins the color wheel by `degrees` (-360..360), scales chroma by an
 * optional `saturation` (0..3), and, with an optional `cycleRate` (deg/sec), continuously rotates the hue
 * over time for an animated rainbow cycle (one field, two capabilities, L069). It compiles to a single
 * ffmpeg `hue=h='<deg>[+/-<rate>*t]':s=<sat>` fragment; every value is numeric + clamped, so the h/s
 * expressions carry no free text (injection-safe). Distinct from colorAdjust (no hue). Blind DATA (L090).
 *
 * Proof: DATA resolution (nested + flat + bare-number + clamps + disabled-at-identity), materialize
 * pass-through, AND a real OFFLINE render (deterministic mode #170) on a SOLID RED source where a 120deg
 * hue rotation moves red -> green (the green channel overtakes red), while the plain render stays red (L155).
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
let work, red;
const FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
// mean R,G,B over a center crop at time ss (rgb24 raw bytes, stride 3).
function meanRGB(file, ss) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24,crop=160:120:80:60', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22 });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n };
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'hue-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'hue-render-'));
  red = join(work, 'red.mp4'); // solid pure red so a hue rotation is unambiguous
  ffmpeg(['-f', 'lavfi', '-i', `color=0xff0000:s=320x240:d=2:r=${FPS}`, '-pix_fmt', 'yuv420p', red]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-09T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => red, { width: 320, height: 240, fps: FPS, deterministic: true });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves hue shift: nested + flat + bare-number; clamps; disabled at identity', () => {
  assert.deepEqual(clipTx(view([setTx({ hue_shift: { degrees: 120, saturation: 1.5, cycleRate: 45 } })])).hueShift, { degrees: 120, saturation: 1.5, cycleRate: 45 });
  assert.deepEqual(clipTx(view([setTx({ hue_shift_degrees: 90 })])).hueShift, { degrees: 90 }); // flat
  assert.deepEqual(clipTx(view([setTx({ hue_shift: 200 })])).hueShift, { degrees: 200 }); // bare number = degrees
  assert.deepEqual(clipTx(view([setTx({ hue_shift: { degrees: 999, saturation: 9, cycleRate: 9999 } })])).hueShift, { degrees: 360, saturation: 3, cycleRate: 720 }); // clamped
  assert.deepEqual(clipTx(view([setTx({ hue_shift: { degrees: 0, cycleRate: 30 } })])).hueShift, { degrees: 0, cycleRate: 30 }); // a spin alone enables it
  assert.equal(clipTx(view([setTx({ hue_shift: { degrees: 0 } })])).hueShift, undefined); // identity: no shift, no spin
  assert.equal(clipTx(view([setTx({})])).hueShift, undefined);
});

test('materialize emits hue_shift (snake-cased top-level, nested object verbatim)', () => {
  const comp = composeTimeline(view([setTx({ hue_shift: { degrees: 120, saturation: 1.5 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].hue_shift, { degrees: 120, saturation: 1.5 });
});

test('OFFLINE RENDER: 120deg hue rotation moves solid RED toward GREEN (L155)', () => {
  const plain = render({}, 'hue-plain');
  const p = meanRGB(plain, 0.5);
  assert.ok(p.r > 150 && p.r > p.g + 40 && p.r > p.b + 40, `plain source is red: ${JSON.stringify(p)}`);

  const shifted = render({ hue_shift: { degrees: 120 } }, 'hue-120');
  const s = meanRGB(shifted, 0.5);
  // 120deg on the color wheel maps red -> green: green now dominates, and red dropped hard.
  assert.ok(s.g > s.r + 30, `hue-rotated frame is now green-dominant: ${JSON.stringify(s)}`);
  assert.ok(s.r < p.r - 40, `red channel fell after the hue rotation: plain.r=${p.r.toFixed(1)} shifted.r=${s.r.toFixed(1)}`);
});
