/**
 * #140 Ease curves for censor motion/path: `ease` ('smooth' | 'in' | 'out') shapes the #138 motion / #139
 * path interpolation so a censor accelerates and decelerates instead of moving at robotic constant speed.
 * Absent / 'linear' = constant speed. Applies to whichever of motion/path is active; ease with no motion/path
 * is meaningless and dropped. Enum-safe string (only 3 accepted values), so injection is impossible.
 *
 * Proof (L155 temporal): DATA resolution (accepted values, dropped when invalid or without motion/path),
 * materialize pass-through, AND a real offline render where an 'in' (accelerating) pan LAGS a linear pan early:
 * a box the linear censor already covers at t=0.3 is still uncensored under ease-in (the eased censor is behind).
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
  const dir = tempFolder(join(tmpdir(), 're-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 're-render-'));
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
const panTx = (ease) => ({ regionFilter: { x: 0.05, y: 0.366, w: 0.2, h: 0.266, filter: BLACKOUT,
  motion: { toX: 0.7, toY: 0.366, start: 0, duration: 1.5 }, ...(ease ? { ease } : {}) } });

test('ease resolves the accepted values (smooth / in / out) alongside motion', () => {
  assert.equal(clipTx(view([setTx(panTx('smooth'))])).regionFilter.ease, 'smooth');
  assert.equal(clipTx(view([setTx(panTx('in'))])).regionFilter.ease, 'in');
  assert.equal(clipTx(view([setTx(panTx('out'))])).regionFilter.ease, 'out');
});

test('ease is dropped for an unknown value, for linear, and when no motion/path is present', () => {
  assert.equal(clipTx(view([setTx(panTx('bogus'))])).regionFilter.ease, undefined);
  assert.equal(clipTx(view([setTx(panTx('linear'))])).regionFilter.ease, undefined);
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, filter: BLACKOUT, ease: 'smooth' } })])).regionFilter.ease, undefined);
});

test('ease works on a #137 list element and on a #139 path', () => {
  const list = clipTx(view([setTx({ regionFilters: [
    { x: 0.05, y: 0.3, w: 0.2, h: 0.2, filter: 'negate', path: [{ x: 0.05, y: 0.3, at: 0 }, { x: 0.7, y: 0.3, at: 1 }], ease: 'out' },
  ] })])).regionFilters;
  assert.equal(list[0].ease, 'out');
});

test('materialize emits region_filter.ease on the EDL clip', () => {
  const comp = composeTimeline(view([setTx(panTx('smooth'))]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.equal(edl.spine.segments[0].region_filter.ease, 'smooth');
});

test('OFFLINE RENDER: an ease-in pan LAGS a linear pan early (accelerating), then both arrive (L155 temporal)', () => {
  // At t=0.3 (of dur 1.5, f=0.2): linear censor x~57.6 covers x=100; ease-in x~24 does NOT reach x=100 yet.
  const LAGBOX = { x: 100, y: 96, w: 16, h: 48 };
  const linear = render(panTx(null), 're-linear');
  const easeIn = render(panTx('in'), 're-easein');
  const linEarly = meanGray(linear, 0.3, LAGBOX);   // linear censor already here -> black
  const easeEarly = meanGray(easeIn, 0.3, LAGBOX);  // eased censor still behind -> source
  assert.ok(linEarly < 5, `linear censor covers the box early: ${linEarly.toFixed(1)}`);
  assert.ok(easeEarly > 20, `ease-in censor still behind (lagging) early: ${easeEarly.toFixed(1)}`);
  // Both reach the end position by t>=duration (x=0.7*320=224).
  const END = { x: 236, y: 96, w: 24, h: 48 };
  assert.ok(meanGray(linear, 1.9, END) < 5 && meanGray(easeIn, 1.9, END) < 5, 'both arrive at the end');
});
