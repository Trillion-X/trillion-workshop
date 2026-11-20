/**
 * #148 Marker-synced flashes (beat-sync pulses): DATA `pulses` [{at, strength?, duration?}] briefly brighten
 * the frame at each clip-local timestamp (a triangular flash peaking at `at`). The music-video "hit on the
 * beat" as a COMPUTED timing primitive the static `grade` seam cannot express: the render folds the whole
 * list into ONE eq=brightness expression (eval=frame). A beat-detector producer writes the DATA (L090).
 *
 * Proof: DATA resolution (at/t alias, strength clamp, drop non-positive duration + empty, pulses/flashes/beats
 * aliases), materialize pass-through, AND a real offline render where luminance SPIKES at each beat time and
 * sits at baseline between them (L155 temporal), with a no-pulses regression that stays flat.
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
function lum(file, ss) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24,crop=40:40:140:100', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0;
  for (let i = 0; i < raw.length; i++) s += raw[i];
  return s / raw.length;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'pulse-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'pulse-render-'));
  src = join(work, 'gray.mp4');
  // a mid-gray source (lum ~64) so a positive brightness flash is unambiguous.
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x404040:s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', src]);
});

const view = (decisions, dur = 2) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: dur, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-08T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => src, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves at/t; clamps strength 0..1; drops non-positive duration + empty; aliases pulses/flashes/beats', () => {
  const a = clipTx(view([setTx({ pulses: [{ at: 0.5, strength: 2, duration: 0.2 }, { t: 1.2, strength: -1 }] })])).pulses;
  assert.deepEqual(a, [{ at: 0.5, strength: 1, duration: 0.2 }, { at: 1.2, strength: 0 }]);
  assert.equal(clipTx(view([setTx({ pulses: [] })])).pulses, undefined);
  assert.equal(clipTx(view([setTx({ pulses: [{ strength: 0.5 }] })])).pulses, undefined); // no `at` -> dropped -> empty
  assert.deepEqual(clipTx(view([setTx({ beats: [{ at: 1 }] })])).pulses, [{ at: 1 }]);
  assert.deepEqual(clipTx(view([setTx({ flashes: [{ at: 0.25, strength: 0.4 }] })])).pulses, [{ at: 0.25, strength: 0.4 }]);
});

test('materialize emits pulses array (verbatim)', () => {
  const comp = composeTimeline(view([setTx({ pulses: [{ at: 0.5, strength: 0.6 }, { at: 1.2, strength: 0.6, duration: 0.16 }] })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].pulses, [{ at: 0.5, strength: 0.6 }, { at: 1.2, strength: 0.6, duration: 0.16 }]);
});

test('OFFLINE RENDER: luminance SPIKES at each beat and returns to baseline between (L155)', () => {
  const out = render({ pulses: [{ at: 0.5, strength: 0.6 }, { at: 1.2, strength: 0.6 }] }, 'pulses');
  const beat1 = lum(out, 0.5);
  const between = lum(out, 0.8);
  const beat2 = lum(out, 1.2);
  assert.ok(beat1 > between + 80, `beat1 flashes above baseline: ${beat1.toFixed(0)} vs ${between.toFixed(0)}`);
  assert.ok(beat2 > between + 80, `beat2 flashes above baseline: ${beat2.toFixed(0)} vs ${between.toFixed(0)}`);
});

test('OFFLINE RENDER: no pulses leaves brightness flat (regression)', () => {
  const out = render(null, 'pulses-none');
  const a = lum(out, 0.5);
  const b = lum(out, 0.8);
  assert.ok(Math.abs(a - b) < 12, `no-pulses brightness is flat: ${a.toFixed(0)} vs ${b.toFixed(0)}`);
});

test('#150/#151 resolves kind flash/punch/shake per pulse (unknown dropped)', () => {
  const p = clipTx(view([setTx({ pulses: [{ at: 0.5, kind: 'punch' }, { at: 1, kind: 'flash' }, { at: 1.4, kind: 'shake' }, { at: 1.5, kind: 'bogus' }] })])).pulses;
  assert.deepEqual(p, [{ at: 0.5, kind: 'punch' }, { at: 1, kind: 'flash' }, { at: 1.4, kind: 'shake' }, { at: 1.5 }]);
});

test('#150 OFFLINE RENDER punch: a centered zoom-in PUSHES an off-center edge outward at the beat (L155)', () => {
  // an off-center red|blue edge at x=200; a centered zoom at the beat moves it rightward past a fixed column.
  const psrc = join(work, 'split.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=320x240:d=2:r=24', '-vf', 'drawbox=x=200:y=0:w=120:h=240:color=blue:t=fill', '-pix_fmt', 'yuv420p', psrc]);
  const comp = composeTimeline(view([setTx({ pulses: [{ at: 0.5, strength: 0.4, kind: 'punch' }] })]));
  const { edl } = materializeExportEdl(comp, () => psrc, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, 'punch.json'); const out = join(work, 'punch.mp4');
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  const col = (ss) => {
    const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', out,
      '-vf', 'format=rgb24,crop=4:20:206:110', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
    let r = 0, b = 0, n = raw.length / 3;
    for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; b += raw[i + 2]; }
    return { r: r / n, b: b / n };
  };
  const rest = col(0.2);
  const beat = col(0.5);
  assert.ok(rest.b > rest.r + 60, `at rest x206 is blue (edge ~200): ${JSON.stringify(rest)}`);
  assert.ok(beat.r > beat.b + 60, `at the punch x206 is red (edge pushed right): ${JSON.stringify(beat)}`);
});

test('#151 OFFLINE RENDER shake: the frame JITTERS at the beat and is STATIC between beats (L155)', () => {
  // a centered red|blue edge; a beat-gated shake jitters the frame near the beat, still between beats.
  const ssrc = join(work, 'shk-split.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=320x240:d=2:r=24', '-vf', 'drawbox=x=160:y=0:w=160:h=240:color=blue:t=fill', '-pix_fmt', 'yuv420p', ssrc]);
  const comp = composeTimeline(view([setTx({ pulses: [{ at: 0.5, strength: 0.9, kind: 'shake' }] })]));
  const { edl } = materializeExportEdl(comp, () => ssrc, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, 'shk.json'); const out = join(work, 'shk.mp4');
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  const col = (ss) => {
    const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', out,
      '-vf', 'format=rgb24,crop=4:20:160:110', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
    let r = 0, b = 0, n = raw.length / 3;
    for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; b += raw[i + 2]; }
    return { r: r / n, b: b / n };
  };
  // between beats: two nearby frames identical (static).
  const s1 = col(0.15); const s2 = col(0.25);
  const still = Math.abs(s1.r - s2.r) + Math.abs(s1.b - s2.b);
  // at the beat: two nearby frames differ (the edge jitters).
  const b1 = col(0.50); const b2 = col(0.52);
  const moving = Math.abs(b1.r - b2.r) + Math.abs(b1.b - b2.b);
  assert.ok(still < 20, `static between beats: delta=${still.toFixed(0)}`);
  assert.ok(moving > 80, `jitters at the beat: delta=${moving.toFixed(0)}`);
});
