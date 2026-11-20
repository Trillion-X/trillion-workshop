/**
 * #153 Highlight sweep (kinetic-caption "highlighter marker"): a translucent colored box over a NORMALIZED
 * region {x,y,w,h} that WIPES left-to-right over [start, start+duration], revealing a phrase as it is spoken.
 * DATA singular `highlightSweep` + list `highlightSweeps` (named distinctly from #98 auto-highlight/auto-shorts).
 * A computed-timing primitive the static grade seam cannot express: the render composites the effective list,
 * one timed geq blend each (geq's time var is T; `clip` is unavailable so the wipe front uses min/max).
 *
 * Proof: DATA resolution (requires x,y,w,h with w,h>0; clamps opacity; singular + list), materialize pass-
 * through, AND a real offline render where a point on the RIGHT of the box is un-highlighted early and
 * highlighted late (the wipe passes it, L155 temporal), while the LEFT is highlighted from the start.
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
const isYellow = (c) => c.r > 150 && c.g > 150 && c.b < 110;
const isGray = (c) => Math.abs(c.r - c.g) < 30 && Math.abs(c.g - c.b) < 30 && c.b > 90;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'hlsw-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'hlsw-render-'));
  src = join(work, 'gray.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=gray:s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', src]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-08T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => src, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves x/y/w/h (required, w/h>0) + color/opacity/start/duration; singular + list; drops invalid', () => {
  const a = clipTx(view([setTx({ highlightSweep: { x: 0.25, y: 0.4, w: 0.5, h: 0.2, color: 'yellow', opacity: 2, start: 0, duration: 1 } })])).highlightSweep;
  assert.deepEqual(a, { x: 0.25, y: 0.4, w: 0.5, h: 0.2, color: 'yellow', opacity: 1, start: 0, duration: 1 });
  assert.equal(clipTx(view([setTx({ highlightSweep: { x: 0, y: 0, w: 0, h: 0.2 } })])).highlightSweep, undefined); // w=0 dropped
  const list = clipTx(view([setTx({ highlightSweeps: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, { x: 0, y: 0, w: 0 }] })])).highlightSweeps;
  assert.deepEqual(list, [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }]); // invalid entry dropped
});

test('materialize emits highlight_sweep + highlight_sweeps (snake-cased top-level, nested verbatim)', () => {
  const comp = composeTimeline(view([setTx({ highlightSweep: { x: 0.25, y: 0.4, w: 0.5, h: 0.2, color: 'yellow' }, highlightSweeps: [{ x: 0.1, y: 0.7, w: 0.3, h: 0.1 }] })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].highlight_sweep, { x: 0.25, y: 0.4, w: 0.5, h: 0.2, color: 'yellow' });
  assert.deepEqual(edl.spine.segments[0].highlight_sweeps, [{ x: 0.1, y: 0.7, w: 0.3, h: 0.1 }]);
});

test('OFFLINE RENDER: the highlight WIPES left-to-right (right of box un-highlighted early, highlighted late; left always) (L155)', () => {
  // box x=0.25..0.75 (bx=80..240), y=0.4..0.6 (96..144); yellow op 0.5; wipe start 0 dur 1.
  const out = render({ highlightSweep: { x: 0.25, y: 0.4, w: 0.5, h: 0.2, color: 'yellow', opacity: 0.5, start: 0, duration: 1 } }, 'hlsw');
  const rightEarly = meanRGB(out, 0.1, { x: 198, y: 112, w: 6, h: 10 });
  const rightLate = meanRGB(out, 0.9, { x: 198, y: 112, w: 6, h: 10 });
  const leftEarly = meanRGB(out, 0.1, { x: 88, y: 112, w: 6, h: 10 });
  assert.ok(isGray(rightEarly), `right of box not yet wiped at t=0.1: ${JSON.stringify(rightEarly)}`);
  assert.ok(isYellow(rightLate), `right of box highlighted at t=0.9 (wipe passed): ${JSON.stringify(rightLate)}`);
  assert.ok(isYellow(leftEarly), `left of box highlighted from the start: ${JSON.stringify(leftEarly)}`);
});

test('OFFLINE RENDER: outside the box stays untouched (regression)', () => {
  const out = render({ highlightSweep: { x: 0.25, y: 0.4, w: 0.5, h: 0.2, color: 'yellow' } }, 'hlsw-out');
  assert.ok(isGray(meanRGB(out, 0.9, { x: 20, y: 20, w: 8, h: 8 })), 'top-left corner untouched');
});
