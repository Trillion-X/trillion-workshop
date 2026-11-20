/**
 * #141 Censor opacity fade: `fade` {in,out} ramps the censor from transparent to full over `in` seconds at the
 * start and back to transparent over `out` seconds before the clip end (progressive redaction / reveal). It
 * composes with ANY position (static / #138 motion / #139 path): the render blends the original crop and the
 * filtered crop per-frame (A=orig, B=filtered, opacity ramps A->B). Bounds-checked seconds, no injection.
 *
 * Proof (L155 temporal): DATA resolution (in/out kept only when > 0, dropped otherwise), materialize
 * pass-through, AND a real offline render where a fade-in blackout shows SOURCE at t=0 and full BLACK after the
 * ramp, and a fade-out shows BLACK mid-clip and SOURCE at the end.
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
  const dir = tempFolder(join(tmpdir(), 'rd-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'rd-render-'));
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
const REGION = { x: 176, y: 92, w: 48, h: 56 };  // inside x=0.5,y=0.35,w=0.3,h=0.35 at 320x240

test('fade resolves {in,out} keeping only positive values', () => {
  assert.deepEqual(clipTx(view([setTx({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: BLACKOUT, fade: { in: 1, out: 0.5 } } })])).regionFilter.fade, { in: 1, out: 0.5 });
  assert.deepEqual(clipTx(view([setTx({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: BLACKOUT, fade: { in: 1 } } })])).regionFilter.fade, { in: 1 });
});

test('fade is dropped when neither in nor out is positive', () => {
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: BLACKOUT, fade: { in: 0, out: -2 } } })])).regionFilter.fade, undefined);
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: BLACKOUT } })])).regionFilter.fade, undefined);
});

test('materialize emits region_filter.fade on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: BLACKOUT, fade: { in: 1 } } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].region_filter.fade, { in: 1 });
});

test('OFFLINE RENDER: fade-in shows SOURCE at t=0 and full BLACK after the ramp (L155 temporal)', () => {
  const out = render({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: BLACKOUT, fade: { in: 1 } } }, 'rd-in');
  const early = meanGray(out, 0, REGION);     // opacity 0 -> source
  const late = meanGray(out, 1.9, REGION);    // opacity 1 -> black
  assert.ok(early > 20, `censor transparent at t=0 (source): ${early.toFixed(1)}`);
  assert.ok(late < 5, `censor full after fade-in: ${late.toFixed(1)}`);
});

test('OFFLINE RENDER: fade-out shows BLACK mid-clip and SOURCE at the end (L155 temporal)', () => {
  // clip is 2s; fade out over the last 1s, so ~t=1.9 is near transparent, t=0.5 is full.
  const out = render({ regionFilter: { x: 0.5, y: 0.35, w: 0.3, h: 0.35, filter: BLACKOUT, fade: { out: 1 } } }, 'rd-out');
  const mid = meanGray(out, 0.5, REGION);     // still full black
  const end = meanGray(out, 1.95, REGION);    // faded back to source
  assert.ok(mid < 5, `censor full mid-clip: ${mid.toFixed(1)}`);
  assert.ok(end > 20, `censor faded out at the end (source): ${end.toFixed(1)}`);
});

test('OFFLINE RENDER: fade composes with motion (a fading, moving censor)', () => {
  // pan across; fade-in. At t=0 the start position is source (opacity 0); after the ramp the moved position is black.
  const START = { x: 20, y: 96, w: 40, h: 48 };
  const out = render({ regionFilter: { x: 0.05, y: 0.366, w: 0.2, h: 0.266, filter: BLACKOUT,
    motion: { toX: 0.05, toY: 0.366, start: 0, duration: 2 }, fade: { in: 0.8 } } }, 'rd-move');
  assert.ok(meanGray(out, 0, START) > 20, `moving censor transparent at t=0: ${meanGray(out, 0, START).toFixed(1)}`);
  assert.ok(meanGray(out, 1.9, START) < 5, `moving censor opaque after fade-in: ${meanGray(out, 1.9, START).toFixed(1)}`);
});
