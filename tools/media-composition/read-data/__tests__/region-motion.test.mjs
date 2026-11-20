/**
 * #138 Animated / tracking censor: a region filter with `motion` {toX,toY,start,duration} slides its
 * crop+overlay from {x,y} to {toX,toY} over [start, start+duration] seconds, so a blur/blackout FOLLOWS a
 * moving subject. Composes #137 (region list) with #135 (temporal): the same motion works on the singular
 * region and on every list element. Bounds-clamped numbers only, so injection is impossible.
 *
 * Proof (L155 temporal corollary): DATA resolution (nested motion, dropped when duration<=0, clamp),
 * materialize nested pass-through, AND a real offline render where the censored rectangle is at the START
 * position early and at the END position late, while the END position is NOT censored early (it moved there).
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
// Mean gray over a crop of a rendered frame AT a given timestamp (motion is time-varying, so seek matters).
function meanGray(file, ss, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', `format=gray,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0; for (let i = 0; i < raw.length; i++) s += raw[i];
  return s / raw.length;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'rm-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'rm-render-'));
  src = join(work, 'detail.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', src]);
});

const view = (decisions, dur = 1) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: dur, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name, dur) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : [], dur));
  const { edl } = materializeExportEdl(comp, () => src, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('region motion resolves from a nested motion {toX,toY,start,duration}, clamped 0..1 / start>=0', () => {
  const rf = clipTx(view([setTx({ regionFilter: { x: 0.05, y: 0.3, w: 0.2, h: 0.2, filter: 'boxblur=10', motion: { toX: 2, toY: -1, start: -5, duration: 1.5 } } })])).regionFilter;
  assert.deepEqual(rf.motion, { toX: 1, toY: 0, start: 0, duration: 1.5 });
});

test('region motion is dropped when duration <= 0 or absent (a static region stays static)', () => {
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, filter: 'boxblur=10', motion: { toX: 0.5, toY: 0.5, start: 0, duration: 0 } } })])).regionFilter.motion, undefined);
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, filter: 'boxblur=10' } })])).regionFilter.motion, undefined);
});

test('region motion works on a #137 list element too', () => {
  const list = clipTx(view([setTx({ regionFilters: [
    { x: 0.1, y: 0.1, w: 0.2, h: 0.2, filter: 'negate' },
    { x: 0.05, y: 0.3, w: 0.2, h: 0.2, filter: 'boxblur=10', motion: { toX: 0.7, toY: 0.3, start: 0.2, duration: 1 } },
  ] })])).regionFilters;
  assert.equal(list[0].motion, undefined);
  assert.deepEqual(list[1].motion, { toX: 0.7, toY: 0.3, start: 0.2, duration: 1 });
});

test('materialize emits region_filter.motion (nested object preserved) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ regionFilter: { x: 0.05, y: 0.3, w: 0.2, h: 0.2, filter: 'boxblur=20', motion: { toX: 0.7, toY: 0.3, start: 0, duration: 1.5 } } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].region_filter.motion, { toX: 0.7, toY: 0.3, start: 0, duration: 1.5 });
});

test('OFFLINE RENDER: the censor is at the START pos early and the END pos late; END pos is uncensored early (L155 temporal)', () => {
  const START = { x: 16, y: 88, w: 64, h: 64 };   // x=0.05 at 320
  const END = { x: 224, y: 88, w: 64, h: 64 };     // x=0.7 at 320
  const out = render({ regionFilter: { x: 0.05, y: 0.366, w: 0.2, h: 0.266, filter: 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill', motion: { toX: 0.7, toY: 0.366, start: 0, duration: 1.5 } } }, 'rm-track', 2);
  // Sample frame 0 (ss=0, motion factor exactly 0) so the censor is precisely at the start rect (by t=0.05
  // it has already crept a few px, leaving a thin source strip that inflates the mean).
  const startEarly = meanGray(out, 0, START);       // censor here at t=0 -> black
  const endLate = meanGray(out, 1.9, END);          // censor moved here late -> black
  const endEarly = meanGray(out, 0, END);           // censor NOT here at t=0 -> source content
  assert.ok(startEarly < 5, `start pos censored early: ${startEarly.toFixed(1)}`);
  assert.ok(endLate < 5, `end pos censored late (it tracked): ${endLate.toFixed(1)}`);
  assert.ok(endEarly > 20, `end pos uncensored early (censor was elsewhere): ${endEarly.toFixed(1)}`);
});

test('OFFLINE RENDER: a static region (no motion) still renders in place (regression)', () => {
  const R = { x: 16, y: 88, w: 64, h: 64 };
  const out = render({ regionFilter: { x: 0.05, y: 0.366, w: 0.2, h: 0.266, filter: 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill' } }, 'rm-static', 1);
  assert.ok(meanGray(out, 0.5, R) < 5, `static region blacked in place: ${meanGray(out, 0.5, R).toFixed(1)}`);
});
