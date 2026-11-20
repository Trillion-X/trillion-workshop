/**
 * #145 Progress-bar chapter markers: extend #143 progressBar with `markers` (normalized 0..1 tick positions)
 * + `markerColor`. The render draws contrasting tick columns ON TOP of the fill via the same geq band (a pixel
 * near any marker X in the band becomes markerColor). The YouTube/Opus chapter-scrubber staple, as DATA (L069).
 *
 * Proof (L155): DATA resolution (markers clamped, dropped empty, markerColor default), materialize pass-through,
 * AND a real offline render where a tick column at a marker X is markerColor while the fill between markers is
 * the bar color.
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
function meanRGB(file, ss, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  const n = raw.length / 3;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}
const isRed = (c) => c.r > 150 && c.r > c.g + 60 && c.r > c.b + 60;
const isBlack = (c) => c.r < 60 && c.g < 60 && c.b < 60;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'pbm-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'pbm-render-'));
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

test('markers resolve clamped 0..1; markerColor defaults to black; dropped when empty', () => {
  const pb = clipTx(view([setTx({ progressBar: { height: 0.06, color: 'red', markers: [0.25, 2, -1] } })])).progressBar;
  assert.deepEqual(pb.markers, [0.25, 1, 0]);
  assert.equal(pb.markerColor, 'black');
  assert.equal(clipTx(view([setTx({ progressBar: { height: 0.06, color: 'red', markers: [] } })])).progressBar.markers, undefined);
});

test('materialize emits progress_bar.markers + markerColor (nested, camelCase preserved)', () => {
  const comp = composeTimeline(view([setTx({ progressBar: { height: 0.06, color: 'red', markers: [0.33, 0.66], markerColor: 'black' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].progress_bar.markers, [0.33, 0.66]);
  assert.equal(edl.spine.segments[0].progress_bar.markerColor, 'black');
});

test('OFFLINE RENDER: chapter ticks are markerColor while the fill between is the bar color (L155)', () => {
  const out = render({ progressBar: { height: 0.08, color: 'red', markers: [0.33, 0.66], markerColor: 'black' } }, 'pbm');
  // at t=1.9 the bar is fully filled red; the tick columns at x~106 and x~211 are black.
  const tick1 = meanRGB(out, 1.9, { x: 105, y: 228, w: 2, h: 8 });
  const tick2 = meanRGB(out, 1.9, { x: 210, y: 228, w: 2, h: 8 });
  const fillMid = meanRGB(out, 1.9, { x: 150, y: 228, w: 8, h: 8 });
  assert.ok(isBlack(tick1), `tick1 is markerColor black: ${JSON.stringify(tick1)}`);
  assert.ok(isBlack(tick2), `tick2 is markerColor black: ${JSON.stringify(tick2)}`);
  assert.ok(isRed(fillMid), `fill between ticks is bar red: ${JSON.stringify(fillMid)}`);
});

test('OFFLINE RENDER: a plain progress bar (no markers) is unchanged (regression)', () => {
  const out = render({ progressBar: { height: 0.08, color: 'red' } }, 'pbm-plain');
  assert.ok(isRed(meanRGB(out, 1.9, { x: 105, y: 228, w: 4, h: 8 })), 'no ticks: the whole filled bar is red');
});
