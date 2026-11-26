/**
 * file: tools/media-composition/do-work/__tests__/split-cell-timing.test.mjs
 *
 * A split cell's own time: a held frame (`still`), a speed envelope per source (`speed_ramp`, a phase-synced
 * reference) and smooth slow motion (`speed_smooth`). Two layers:
 *   (1) PURE: buildSplitLayout puts hold -> ramp -> segment speed -> smooth before the scale, and the exact frame
 *       count last, in every cell that asks for it; a cell that asks for nothing is unchanged.
 *   (2) REAL: video-compose renders such splits, and plain slowed ones, to exactly the planned number of frames, and refuses a split whose
 *       cells would come out different lengths (a stack of unequal cells desyncs).
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSplitLayout } from '../split-layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'video-compose.mjs');
const work = tempFolder(join(tmpdir(), 'split-cell-timing-'));

test('a cell plays hold, then its ramp, then the segment speed, then smooth, before the scale; frames come last', () => {
  const { filter } = buildSplitLayout({
    count: 2, layout: 'v', width: 360, height: 640, fps: '30', speed: 0.25,
    sources: [{ ramp: 'RAMP', smooth: 'SMOOTH', frames: 48 }, { smooth: 'SMOOTH', frames: 48 }],
  });
  assert.match(filter, /\[0:v\]setpts=\(RAMP\)\/TB,setpts=PTS\/0\.25,SMOOTH,scale=360:320,setsar=1,fps=30,format=yuv420p,tpad=stop_mode=clone:stop=48\[v0\]/);
  assert.match(filter, /\[1:v\]setpts=PTS\/0\.25,SMOOTH,scale=360:320,setsar=1,fps=30,format=yuv420p,tpad=stop_mode=clone:stop=48\[v1\]/);
});

test('a held cell plays the hold fragment it is given (the compositor gives it the same one a clip still uses) before the scale', () => {
  const { filter } = buildSplitLayout({ count: 2, layout: 'h', width: 640, height: 360, fps: '30', sources: [{ hold: 'HOLD', frames: 15 }, { hold: 'HOLD', frames: 15 }] });
  assert.match(filter, /\[0:v\]HOLD,scale=320:360,/);
  assert.match(filter, /\[1:v\]HOLD,scale=320:360,/);
});

test('a cell that asks for no timing of its own is unchanged', () => {
  const { filter } = buildSplitLayout({ count: 2, layout: 'h', width: 640, height: 360, fps: '30', sources: [{}, {}] });
  assert.equal(filter, '[0:v]scale=320:360,setsar=1,fps=30,format=yuv420p[v0];[1:v]scale=320:360,setsar=1,fps=30,format=yuv420p[v1];[v0][v1]hstack=inputs=2[vout]');
});

const ffmpegReady = spawnSync('ffmpeg', ['-version']).status === 0;
const clips = {};
before(() => {
  if (!ffmpegReady) return;
  for (const [name, source] of [['a', 'testsrc2'], ['b', 'testsrc']]) {
    clips[name] = join(work, `${name}.mp4`);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${source}=size=320x240:rate=30:duration=4`, '-pix_fmt', 'yuv420p', clips[name]]);
  }
});

function compose(segment, name) {
  const edl = { encode: { width: 320, height: 480, fps: 30, crf: 30, preset: 'ultrafast' }, base: { kind: 'color', color: 'black' }, spine: { segments: [segment] } };
  const out = join(work, `${name}.mp4`);
  const edlFile = join(work, `${name}.json`);
  writeFileSync(edlFile, JSON.stringify(edl));
  return { out, done: spawnSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' }) };
}
function frames(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
}

test('REAL a ramped cell beside a cell at 1x, smooth at 0.25x and a held frame each come out exactly as planned', { skip: !ffmpegReady && 'ffmpeg is needed' }, () => {
  // 1.2 s of target at 1x; the reference plays 1.5 s of its source through 1.5x then 1x: 0.6 + 0.6 = 1.2 s.
  const synced = compose({ id: 'synced', kind: 'split', layout: 'v', sources: [
    { source: clips.b, in: 1.0, out: 2.5, speed_ramp: [{ t: 0, speed: 1.5 }, { t: 0.9, speed: 1 }] },
    { source: clips.a, in: 1.0, out: 2.2 }] }, 'synced');
  assert.equal(synced.done.status, 0, synced.done.stderr);
  assert.equal(frames(synced.out), 36);
  const slow = compose({ id: 'slow', kind: 'split', layout: 'v', speed: 0.25, speed_smooth: true, sources: [
    { source: clips.b, in: 1.0, out: 1.4 }, { source: clips.a, in: 2.0, out: 2.4 }] }, 'slow');
  assert.equal(slow.done.status, 0, slow.done.stderr);
  assert.equal(frames(slow.out), 48);
  const held = compose({ id: 'held', kind: 'split', layout: 'v', still: { duration: 0.5 }, sources: [
    { source: clips.b, in: 1.5 }, { source: clips.a, in: 2.0 }] }, 'held');
  assert.equal(held.done.status, 0, held.done.stderr);
  assert.equal(frames(held.out), 15);
});

test('REAL a plain slowed split (no smooth) comes out exactly its frames: 0.4 s at 0.25x is 48, 1 s at 0.4x is 75', { skip: !ffmpegReady && 'ffmpeg is needed' }, () => {
  // A plain slowed split renders with its old arguments and already ends on its frame; this keeps it so.
  const quarter = compose({ id: 'quarter', kind: 'split', layout: 'v', speed: 0.25, sources: [
    { source: clips.b, in: 1.0, out: 1.4 }, { source: clips.a, in: 2.0, out: 2.4 }] }, 'quarter');
  assert.equal(quarter.done.status, 0, quarter.done.stderr);
  assert.equal(frames(quarter.out), 48);
  const slow = compose({ id: 'slow', kind: 'split', layout: 'h', speed: 0.4, sources: [
    { source: clips.b, in: 0.5, out: 1.5 }, { source: clips.a, in: 1.0, out: 2.0 }] }, 'slow');
  assert.equal(slow.done.status, 0, slow.done.stderr);
  assert.equal(frames(slow.out), 75);
});

test('REAL a split whose cells would play different lengths is refused, saying each length', { skip: !ffmpegReady && 'ffmpeg is needed' }, () => {
  const { done } = compose({ id: 'uneven', kind: 'split', layout: 'v', sources: [
    { source: clips.b, in: 1.0, out: 2.0, speed_ramp: [{ t: 0, speed: 2 }] }, { source: clips.a, in: 1.0, out: 2.0 }] }, 'uneven');
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /cells would play 0\.5, 1 seconds; every cell must be the same length/);
});
