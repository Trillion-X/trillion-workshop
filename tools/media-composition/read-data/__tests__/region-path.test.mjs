/**
 * #139 Keyframe motion path: a region filter with `path` [{x,y,at}, ...] traces the censor through N waypoints
 * with piecewise-linear interpolation over time. The L069 generalization of #138 motion (a 2-point path);
 * precedence is path > motion > static. A censor can now go right, then back left, then up, following any route.
 * Bounds-clamped numbers only, so injection is impossible.
 *
 * Proof (L155 temporal): DATA resolution (path parse, sort by at, drop <2 points, clamp), materialize nested
 * array pass-through, AND a real offline render where the censored rectangle sits at EACH waypoint at ITS time
 * (a 3-waypoint out-and-back), while a waypoint position is uncensored at the times the censor is elsewhere.
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
function meanGray(file, ss, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', `format=gray,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0; for (let i = 0; i < raw.length; i++) s += raw[i];
  return s / raw.length;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'rp-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'rp-render-'));
  src = join(work, 'detail.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', src]);
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

const BLACKOUT = 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill';

test('path resolves an array of >=2 {x,y,at}, sorted by at, clamped 0..1 / at>=0', () => {
  const p = clipTx(view([setTx({ regionFilter: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, filter: 'boxblur=10', path: [
    { x: 0.7, y: 0.5, at: 1 }, { x: 2, y: -1, at: -3 }, { x: 0.4, y: 0.4, at: 0.5 },
  ] } })])).regionFilter.path;
  assert.equal(p.length, 3);
  assert.deepEqual(p[0], { x: 1, y: 0, at: 0 });      // was at:-3 -> clamped, sorts first
  assert.deepEqual(p[1], { x: 0.4, y: 0.4, at: 0.5 });
  assert.deepEqual(p[2], { x: 0.7, y: 0.5, at: 1 });
});

test('path is dropped when fewer than 2 valid points remain', () => {
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, filter: 'boxblur=10', path: [{ x: 0.5, y: 0.5, at: 0 }] } })])).regionFilter.path, undefined);
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, filter: 'boxblur=10', path: [] } })])).regionFilter.path, undefined);
});

test('path works on a #137 list element too', () => {
  const list = clipTx(view([setTx({ regionFilters: [
    { x: 0.1, y: 0.1, w: 0.2, h: 0.2, filter: 'negate' },
    { x: 0.05, y: 0.3, w: 0.2, h: 0.2, filter: 'boxblur=10', path: [{ x: 0.05, y: 0.3, at: 0 }, { x: 0.7, y: 0.3, at: 1 }] },
  ] })])).regionFilters;
  assert.equal(list[0].path, undefined);
  assert.equal(list[1].path.length, 2);
});

test('materialize emits region_filter.path (nested array preserved) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ regionFilter: { x: 0.05, y: 0.3, w: 0.2, h: 0.2, filter: BLACKOUT, path: [{ x: 0.05, y: 0.3, at: 0 }, { x: 0.7, y: 0.6, at: 1.5 }] } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].region_filter.path, [{ x: 0.05, y: 0.3, at: 0 }, { x: 0.7, y: 0.6, at: 1.5 }]);
});

test('OFFLINE RENDER: a 3-waypoint out-and-back path sits at each waypoint at its time (L155 temporal)', () => {
  // left (0.05) @ 0 -> right (0.7) @ 0.75 -> back left (0.05) @ 1.5, at fixed y.
  const LEFT = { x: 20, y: 96, w: 40, h: 48 };    // ~ x=0.05*320=16, sample inside
  const RIGHT = { x: 228, y: 96, w: 40, h: 48 };   // ~ x=0.7*320=224
  const out = render({ regionFilter: { x: 0.05, y: 0.366, w: 0.2, h: 0.266, filter: BLACKOUT, path: [
    { x: 0.05, y: 0.366, at: 0 }, { x: 0.7, y: 0.366, at: 0.75 }, { x: 0.05, y: 0.366, at: 1.5 },
  ] } }, 'rp-track');
  const leftStart = meanGray(out, 0, LEFT);        // censor at left at t=0 -> black
  const rightMid = meanGray(out, 0.75, RIGHT);      // censor at right at t=0.75 -> black
  const leftBack = meanGray(out, 1.6, LEFT);        // after the last waypoint (t>=1.5) the censor holds at left -> black
  const rightStart = meanGray(out, 0, RIGHT);       // right uncensored at t=0 (censor was left)
  assert.ok(leftStart < 5, `left censored at t=0: ${leftStart.toFixed(1)}`);
  assert.ok(rightMid < 5, `right censored at t=0.75: ${rightMid.toFixed(1)}`);
  assert.ok(leftBack < 5, `back-left censored near t=1.5: ${leftBack.toFixed(1)}`);
  assert.ok(rightStart > 20, `right uncensored at t=0: ${rightStart.toFixed(1)}`);
});

test('OFFLINE RENDER: path takes precedence over motion (censor follows the path, not the 2-point motion)', () => {
  const RIGHT = { x: 228, y: 96, w: 40, h: 48 };
  // motion says stay left-ish; path says go right by t=0.75. Path must win.
  const out = render({ regionFilter: { x: 0.05, y: 0.366, w: 0.2, h: 0.266, filter: BLACKOUT,
    motion: { toX: 0.05, toY: 0.366, start: 0, duration: 2 },
    path: [{ x: 0.05, y: 0.366, at: 0 }, { x: 0.7, y: 0.366, at: 0.75 }] } }, 'rp-prec');
  assert.ok(meanGray(out, 0.75, RIGHT) < 5, `path won: right censored at t=0.75: ${meanGray(out, 0.75, RIGHT).toFixed(1)}`);
});
