/**
 * #143 Animated progress bar: a clip-level colored band along the top/bottom that fills left-to-right over the
 * clip duration (the social-video watch-progress staple). DATA over compose-timeline (progressBar
 * {height,color,edge}) rendered with a per-frame geq band (X < W*T/D), color parsed to RGB ints (injection-safe).
 *
 * Proof (L155 temporal): DATA resolution (nested/flat, dropped when height<=0, edge default), materialize
 * pass-through, AND a real offline render where the bottom-left is the bar color early, the bottom-right becomes
 * the bar color only late (it fills over time), and a 'top' bar draws on the top edge instead.
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
// mean RGB over a crop, reading TRUE rgb (format=rgb24) not the yuv luma plane.
function meanRGB(file, ss, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  const n = raw.length / 3;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}
const isRed = (c) => c.r > 150 && c.r > c.g + 60 && c.r > c.b + 60;
const isGray = (c) => Math.abs(c.r - c.g) < 25 && Math.abs(c.g - c.b) < 25 && c.r > 80 && c.r < 180;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'pb-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'pb-render-'));
  src = join(work, 'gray.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', src]);
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

const RED = 'red';  // resolves via the named-color map to [255,0,0]
const BL = { x: 4, y: 231, w: 16, h: 6 };    // bottom-left band
const BR = { x: 296, y: 231, w: 16, h: 6 };  // bottom-right band
const TL = { x: 4, y: 3, w: 16, h: 6 };      // top-left band

test('progress bar resolves nested {height,color,edge}; edge defaults to bottom', () => {
  assert.deepEqual(clipTx(view([setTx({ progressBar: { height: 0.05, color: 'crimson', edge: 'top' } })])).progressBar, { height: 0.05, color: 'crimson', edge: 'top' });
  assert.deepEqual(clipTx(view([setTx({ progressBar: { height: 0.05, color: 'crimson' } })])).progressBar, { height: 0.05, color: 'crimson', edge: 'bottom' });
});

test('progress bar resolves from flat progress_bar_* keys', () => {
  assert.deepEqual(clipTx(view([setTx({ progress_bar_height: 0.04, progress_bar_color: 'white', progress_bar_edge: 'bottom' })])).progressBar, { height: 0.04, color: 'white', edge: 'bottom' });
});

test('progress bar is dropped when height <= 0; height clamps to 0..1', () => {
  assert.equal(clipTx(view([setTx({ progressBar: { height: 0, color: 'white' } })])).progressBar, undefined);
  assert.equal(clipTx(view([setTx({ progressBar: { height: 5, color: 'white' } })])).progressBar.height, 1);
});

test('materialize emits progress_bar (snake_case) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ progressBar: { height: 0.05, color: 'crimson' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].progress_bar, { height: 0.05, color: 'crimson', edge: 'bottom' });
});

test('OFFLINE RENDER: the bottom bar fills over time (left red early, right red only late) (L155 temporal)', () => {
  const out = render({ progressBar: { height: 0.06, color: RED } }, 'pb-fill');
  assert.ok(isRed(meanRGB(out, 0.15, BL)), `bottom-left is bar color early: ${JSON.stringify(meanRGB(out, 0.15, BL))}`);
  assert.ok(isGray(meanRGB(out, 0.15, BR)), `bottom-right still empty early: ${JSON.stringify(meanRGB(out, 0.15, BR))}`);
  assert.ok(isRed(meanRGB(out, 1.9, BR)), `bottom-right filled late: ${JSON.stringify(meanRGB(out, 1.9, BR))}`);
});

test('OFFLINE RENDER: a top-edge bar draws on the top instead of the bottom (L155)', () => {
  const out = render({ progressBar: { height: 0.06, color: RED, edge: 'top' } }, 'pb-top');
  assert.ok(isRed(meanRGB(out, 0.15, TL)), `top-left is bar color: ${JSON.stringify(meanRGB(out, 0.15, TL))}`);
  assert.ok(isGray(meanRGB(out, 0.15, BL)), `bottom-left stays source (no bottom bar): ${JSON.stringify(meanRGB(out, 0.15, BL))}`);
});
