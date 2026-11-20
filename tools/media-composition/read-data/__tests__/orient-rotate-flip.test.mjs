/**
 * #119 Whole-clip orientation: rotate quarter-turns (90/180/270) + mirror (flip h/v/hv). The "shot
 * sideways on a phone" fix plus a creative mirror, as blind DATA over the compositor (rotateDegrees ->
 * transpose, flip -> hflip/vflip; the render reorients then normalizes back to the target aspect).
 * Completes the previously-unreachable segment.flip render path and adds the rotate mapping. Zero
 * engine branching per orientation: a DATA field + one filter (L069/L090).
 *
 * Proof (L155): DATA resolution + quarter-turn snapping, materialize snake_case pass-through, AND real
 * offline renders where a bright top-left quadrant lands in the expected corner after each transform.
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
let work, quadrant;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}

// Mean brightness of one 100x100 quadrant of a 200x200 frame at 0.5s.
function quadMean(file, qx, qy) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', file,
    '-vf', `format=gray,crop=100:100:${qx}:${qy}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0;
  for (let i = 0; i < raw.length; i++) s += raw[i];
  return s / raw.length;
}
// Which corner (tl/tr/bl/br) is brightest in the rendered 200x200 frame.
function brightCorner(file) {
  const q = { tl: quadMean(file, 0, 0), tr: quadMean(file, 100, 0), bl: quadMean(file, 0, 100), br: quadMean(file, 100, 100) };
  return Object.entries(q).sort((a, b) => b[1] - a[1])[0][0];
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'orient-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'orient-render-'));
  quadrant = join(work, 'quad.mp4');
  // A square 200x200 clip, black with a WHITE 100x100 square in the TOP-LEFT. Square dims keep every
  // quarter-turn square (no letterbox), so the bright corner maps cleanly through rotate/flip.
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=200x200:r=24:d=1',
    '-vf', 'drawbox=x=0:y=0:w=100:h=100:color=white:t=fill', '-pix_fmt', 'yuv420p', quadrant]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'q.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });

const render = (params, name) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => quadrant, { width: 200, height: 200, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('rotate_degrees resolves onto the clip transform', () => {
  const comp = composeTimeline(view([setTx({ rotate_degrees: 90 })]));
  const clip = comp.lanes.find((l) => l.role === 'video').clips[0];
  assert.equal(clip.transform.rotateDegrees, 90);
});

test('rotate_degrees snaps to the nearest quarter-turn; 0/360 are dropped', () => {
  const rot = (d) => composeTimeline(view([setTx({ rotate_degrees: d })])).lanes.find((l) => l.role === 'video').clips[0].transform.rotateDegrees;
  assert.equal(rot(269), 270);
  assert.equal(rot(360), undefined);
  assert.equal(rot(0), undefined);
  assert.equal(rot(44), undefined); // rounds to 0 -> dropped
});

test('flip resolves h/v/hv and rejects garbage', () => {
  const flip = (v) => composeTimeline(view([setTx({ flip: v })])).lanes.find((l) => l.role === 'video').clips[0].transform.flip;
  assert.equal(flip('h'), 'h');
  assert.equal(flip('hv'), 'hv');
  assert.equal(flip('diagonal'), undefined);
});

test('materialize emits rotate_degrees + flip (snake_case) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ rotate_degrees: 90, flip: 'h' })]));
  const { edl } = materializeExportEdl(comp, () => 'q.mp4', {});
  const seg = edl.spine.segments[0];
  assert.equal(seg.rotate_degrees, 90);
  assert.equal(seg.flip, 'h');
});

test('OFFLINE RENDER: the plain clip keeps the bright quadrant top-left (L155)', () => {
  assert.equal(brightCorner(render(null, 'plain')), 'tl');
});

test('OFFLINE RENDER: rotate 90 clockwise moves top-left to top-right (L155)', () => {
  assert.equal(brightCorner(render({ rotate_degrees: 90 }, 'rot90')), 'tr');
});

test('OFFLINE RENDER: rotate 270 counter-clockwise moves top-left to bottom-left (L155)', () => {
  assert.equal(brightCorner(render({ rotate_degrees: 270 }, 'rot270')), 'bl');
});

test('OFFLINE RENDER: rotate 180 moves top-left to bottom-right (L155)', () => {
  assert.equal(brightCorner(render({ rotate_degrees: 180 }, 'rot180')), 'br');
});

test('OFFLINE RENDER: flip h mirrors top-left to top-right; flip v to bottom-left (L155)', () => {
  assert.equal(brightCorner(render({ flip: 'h' }, 'fliph')), 'tr');
  assert.equal(brightCorner(render({ flip: 'v' }, 'flipv')), 'bl');
});
