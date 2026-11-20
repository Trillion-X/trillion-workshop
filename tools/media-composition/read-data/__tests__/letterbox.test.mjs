/**
 * #149 Letterbox / cinematic bars: mask the frame to a target aspect ratio with solid bars, the bar
 * thickness COMPUTED from the frame ratio vs the target (top/bottom when the target is WIDER than the frame,
 * left/right when it is TALLER). DATA `letterbox` true (default 2.39) OR {aspect, color}. A computed-geometry
 * primitive a static `grade` filter cannot express portably (it needs W/H).
 *
 * Proof: DATA resolution (number aspect, "w:h" string, color, boolean true), materialize pass-through, AND
 * real offline renders: a WIDE target (2.39) yields black TOP/BOTTOM bars with a gray middle, and a TALL
 * target (1.0 on a 4:3 frame) yields black LEFT/RIGHT bars with a gray middle.
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
function lum(file, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0;
  for (let i = 0; i < raw.length; i++) s += raw[i];
  return s / raw.length;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'lb-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'lb-render-'));
  src = join(work, 'gray.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=gray:s=320x240:d=1:r=12', '-pix_fmt', 'yuv420p', src]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-08T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => src, { width: 320, height: 240, fps: 12 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves aspect (number + "w:h" string) + color; boolean true -> default; presence turns it on', () => {
  assert.deepEqual(clipTx(view([setTx({ letterbox: { aspect: 2.39, color: 'black' } })])).letterbox, { aspect: 2.39, color: 'black' });
  assert.deepEqual(clipTx(view([setTx({ letterbox: { aspect: '21:9' } })])).letterbox, { aspect: 21 / 9 });
  assert.deepEqual(clipTx(view([setTx({ letterbox: true })])).letterbox, {});
  assert.equal(clipTx(view([])).letterbox, undefined);
});

test('materialize emits letterbox.{aspect,color} (nested, verbatim)', () => {
  const comp = composeTimeline(view([setTx({ letterbox: { aspect: 2.39, color: 'black' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].letterbox, { aspect: 2.39, color: 'black' });
});

test('OFFLINE RENDER wide target (2.39 on 4:3): black TOP/BOTTOM bars, gray middle, gray sides', () => {
  const out = render({ letterbox: { aspect: 2.39 } }, 'lb-wide'); // bar = round((240 - 320/2.39)/2) = 53
  assert.ok(lum(out, { x: 140, y: 20, w: 40, h: 10 }) < 20, 'top bar black');
  assert.ok(lum(out, { x: 140, y: 214, w: 40, h: 10 }) < 20, 'bottom bar black');
  assert.ok(lum(out, { x: 140, y: 115, w: 40, h: 10 }) > 90, 'middle is gray');
  assert.ok(lum(out, { x: 4, y: 115, w: 10, h: 10 }) > 90, 'no side bars (left edge gray at mid-height)');
});

test('OFFLINE RENDER tall target (1.0 on 4:3): black LEFT/RIGHT bars, gray middle', () => {
  const out = render({ letterbox: { aspect: 1.0 } }, 'lb-tall'); // bar = round((320 - 240*1.0)/2) = 40
  assert.ok(lum(out, { x: 10, y: 115, w: 10, h: 10 }) < 20, 'left bar black');
  assert.ok(lum(out, { x: 300, y: 115, w: 10, h: 10 }) < 20, 'right bar black');
  assert.ok(lum(out, { x: 155, y: 115, w: 10, h: 10 }) > 90, 'middle is gray');
});
