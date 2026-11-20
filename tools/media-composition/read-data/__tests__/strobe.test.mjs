/**
 * #159 Strobe / stop-motion: quantize motion to `rate` updates per second by holding each shown frame
 * (the choppy stop-motion / stutter look). Unlike speed, the clip DURATION is unchanged; only the motion
 * cadence drops (the render decimates to `rate` fps then restores the output fps, so each visible frame is
 * held). Distinct from motionBlur (blends frames) and trails (persistence).
 *
 * Proof: DATA resolution (nested {rate} + flat strobe_rate; rate <= 0 dropped), materialize pass-through,
 * AND a real offline render on a moving source (testsrc2) where frames WITHIN one strobe hold are
 * identical while frames ACROSS holds differ, and a no-strobe render changes continuously (L155 temporal).
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
let work, motion;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
function diffPx(a, b) {
  let n = 0; for (let i = 0; i + 2 < Math.min(a.length, b.length); i += 3) if (Math.abs(a[i] - b[i]) > 30) n++;
  return n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'strb-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'strb-render-'));
  motion = join(work, 'motion.mp4'); // testsrc2 changes every frame
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=24:d=2', '-pix_fmt', 'yuv420p', motion]);
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
  const { edl } = materializeExportEdl(comp, () => motion, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves strobe: nested {rate} + flat strobe_rate; rate <= 0 dropped', () => {
  assert.deepEqual(clipTx(view([setTx({ strobe: { rate: 6 } })])).strobe, { rate: 6 });
  assert.deepEqual(clipTx(view([setTx({ strobe_rate: 8 })])).strobe, { rate: 8 });
  assert.equal(clipTx(view([setTx({ strobe: { rate: 0 } })])).strobe, undefined);
  assert.equal(clipTx(view([setTx({ strobe: { rate: -4 } })])).strobe, undefined);
});

test('materialize emits strobe (snake-cased top-level, nested verbatim)', () => {
  const comp = composeTimeline(view([setTx({ strobe: { rate: 6 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].strobe, { rate: 6 });
});

test('OFFLINE RENDER: frames HOLD within a strobe interval and JUMP across it; no-strobe changes continuously (L155)', () => {
  // rate 6 on a 24fps output -> each visible frame held ~1/6s (0.167). Within [0,0.167) frames are identical.
  const out = render({ strobe: { rate: 6 } }, 'strobe');
  const plain = render({}, 'strobe-off');
  const withinHold = diffPx(frame(out, 0.02), frame(out, 0.12));   // same hold
  const acrossHold = diffPx(frame(out, 0.02), frame(out, 0.30));   // different hold
  const plainWithin = diffPx(frame(plain, 0.02), frame(plain, 0.12));
  assert.equal(withinHold, 0, `strobe holds frames within the interval: diff=${withinHold}`);
  assert.ok(acrossHold > 500, `strobe jumps across intervals: diff=${acrossHold}`);
  assert.ok(plainWithin > 500, `no strobe changes continuously in the same window: diff=${plainWithin}`);
});
