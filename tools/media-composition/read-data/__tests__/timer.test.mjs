/**
 * #144 Live timer text: a clip-level burned-in timer. 'elapsed' counts up (MM:SS via %{pts:hms}); 'countdown'
 * ticks the whole seconds remaining down to 0 (via %{eif:ceil(D-t)}). DATA over compose-timeline (timer
 * {mode,corner,size,color}) rendered with a drawtext that has expansion ON (the static caption uses
 * expansion=none), so ffmpeg evaluates the time token per frame. Color via safeColor (injection-safe).
 *
 * Proof (L155 temporal corollary): DATA resolution (mode gate, corner default, flat keys), materialize
 * pass-through, AND a real offline render where the timer region (a) has bright text pixels (it is drawn) and
 * (b) CHANGES between two timestamps (the digits tick) -- a value-change proxy is not enough, we diff frames.
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
// gray bytes of a top strip (full width) at a timestamp.
function strip(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=gray,crop=320:64:0:0', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
const brightCount = (buf) => { let n = 0; for (let i = 0; i < buf.length; i++) if (buf[i] > 160) n++; return n; };
function changedCount(a, b) { const n = Math.min(a.length, b.length); let c = 0; for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i]) > 60) c++; return c; }

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'tm-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'tm-render-'));
  src = join(work, 'black.mp4');
  // black 2s source so the white timer text is the only bright thing in the strip.
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', src]);
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

test('timer resolves mode + corner (default tr) + color', () => {
  assert.deepEqual(clipTx(view([setTx({ timer: { mode: 'countdown', corner: 'bl', color: 'yellow' } })])).timer, { mode: 'countdown', corner: 'bl', color: 'yellow' });
  assert.deepEqual(clipTx(view([setTx({ timer: { mode: 'elapsed' } })])).timer, { mode: 'elapsed', corner: 'tr', color: 'white' });
});

test('timer is dropped for an unknown mode; resolves from flat timer_* keys', () => {
  assert.equal(clipTx(view([setTx({ timer: { mode: 'bogus' } })])).timer, undefined);
  assert.deepEqual(clipTx(view([setTx({ timer_mode: 'countdown', timer_corner: 'tl', timer_size: 60 })])).timer, { mode: 'countdown', corner: 'tl', size: 60, color: 'white' });
});

test('materialize emits timer (snake_case) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ timer: { mode: 'countdown', corner: 'tr' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].timer, { mode: 'countdown', corner: 'tr', color: 'white' });
});

test('OFFLINE RENDER: an elapsed timer draws text and its digits tick over time (L155 temporal)', () => {
  const out = render({ timer: { mode: 'elapsed', corner: 'tr', size: 48 } }, 'tm-up');
  const early = strip(out, 0.1);
  const late = strip(out, 1.5);
  assert.ok(brightCount(early) > 40, `timer text is drawn: ${brightCount(early)} bright px`);
  assert.ok(changedCount(early, late) > 20, `elapsed digits ticked between frames: ${changedCount(early, late)} changed px`);
});

test('OFFLINE RENDER: a countdown timer draws text and ticks down over time (L155 temporal)', () => {
  const out = render({ timer: { mode: 'countdown', corner: 'tr', size: 64 } }, 'tm-down');
  const early = strip(out, 0.1);
  const late = strip(out, 1.5);
  assert.ok(brightCount(early) > 40, `countdown text is drawn: ${brightCount(early)} bright px`);
  assert.ok(changedCount(early, late) > 20, `countdown digit changed between frames: ${changedCount(early, late)} changed px`);
});
