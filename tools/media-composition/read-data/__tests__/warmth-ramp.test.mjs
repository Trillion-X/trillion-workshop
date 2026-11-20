/**
 * #158 Warmth ramp: an ANIMATED white-balance shift over the clip (sunset / day-to-night / mood change).
 * warmth K ramps linearly from `from` to `to` over [start, start+duration] (duration defaults to the clip
 * length), then red *= (1+K) and blue *= (1-K): positive K is warmer/oranger, negative is cooler/bluer.
 * A COMPUTED time-ramp the static grade/colorAdjust seam cannot express (those are constant).
 *
 * Proof: DATA resolution (nested {from,to,start,duration} + flat warmth_*; clamps -1..1; needs from AND
 * to), materialize pass-through, AND a real offline render on a gray clip that is WARM early (R>B) and
 * COOL late (B>R), crossing neutral in the middle (L155 temporal).
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

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function meanRGB(file, ss) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24,crop=40:40:140:100', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let r = 0, g = 0, b = 0; const n = raw.length / 3;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
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

test('resolves warmthRamp: nested {from,to,start,duration} + flat warmth_*; clamps -1..1; needs from AND to', () => {
  assert.deepEqual(clipTx(view([setTx({ warmthRamp: { from: 0.5, to: -0.5, start: 0, duration: 2 } })])).warmthRamp, { from: 0.5, to: -0.5, start: 0, duration: 2 });
  assert.deepEqual(clipTx(view([setTx({ warmth_from: 2, warmth_to: -3 })])).warmthRamp, { from: 1, to: -1 }); // clamped -1..1
  assert.equal(clipTx(view([setTx({ warmthRamp: { from: 0.4 } })])).warmthRamp, undefined); // missing `to` dropped
});

test('materialize emits warmth_ramp (snake-cased top-level, nested verbatim)', () => {
  const comp = composeTimeline(view([setTx({ warmthRamp: { from: 0.4, to: -0.4, start: 0, duration: 2 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].warmth_ramp, { from: 0.4, to: -0.4, start: 0, duration: 2 });
});

test('OFFLINE RENDER: the gray clip goes WARM early and COOL late, crossing neutral (L155 temporal)', () => {
  const out = render({ warmthRamp: { from: 0.5, to: -0.5, start: 0, duration: 2 } }, 'warm');
  const early = meanRGB(out, 0.05);
  const mid = meanRGB(out, 1.0);
  const late = meanRGB(out, 1.9);
  assert.ok(early.r > early.b + 40, `warm early (R>B): ${JSON.stringify(early)}`);
  assert.ok(Math.abs(mid.r - mid.b) < 25, `near neutral mid: ${JSON.stringify(mid)}`);
  assert.ok(late.b > late.r + 40, `cool late (B>R): ${JSON.stringify(late)}`);
});

test('OFFLINE RENDER: no warmth ramp leaves the gray neutral (regression)', () => {
  const out = render({}, 'warm-off');
  const c = meanRGB(out, 1.0);
  assert.ok(Math.abs(c.r - c.b) < 12 && Math.abs(c.r - c.g) < 12, `stays neutral gray: ${JSON.stringify(c)}`);
});
