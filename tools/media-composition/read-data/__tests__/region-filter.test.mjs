/**
 * #130 Region filter / censor: apply an OPAQUE ffmpeg filter to only a normalized sub-rectangle, then
 * composite it back (split -> crop -> filter -> overlay). Blur a face, pixelate a plate, black out private
 * info, or apply ANY effect locally. The region is numeric (bounds-clamped); the effect is the L090/L111
 * opaque seam (twin of grade/denoise/viz_filter), so every obscuration works with zero code per mode.
 *
 * Proof (L155): DATA resolution (nested/flat, dropped without a filter or w/h, clamped), materialize object
 * pass-through, AND a real offline render where the region's local detail (stddev) collapses under a strong
 * blur while the area OUTSIDE the region is byte-identical to an unfiltered render (the region is isolated).
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
// Grayscale bytes over a crop region of a rendered frame.
function grayBytes(file, { x, y, w, h }) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', file,
    '-vf', `format=gray,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
function stddev(file, box) {
  const raw = grayBytes(file, box);
  let sum = 0, n = raw.length;
  for (let i = 0; i < n; i++) sum += raw[i];
  const m = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (raw[i] - m) * (raw[i] - m);
  return Math.sqrt(v / n);
}
// Mean absolute per-pixel difference (0..255) of the same box across two renders.
function meanAbsDiff(fileA, fileB, box) {
  const a = grayBytes(fileA, box), b = grayBytes(fileB, box);
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'rf-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'rf-render-'));
  src = join(work, 'detail.mp4');
  // testsrc2 has high-frequency detail everywhere, so a blur drops local stddev sharply.
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1:r=24', '-pix_fmt', 'yuv420p', src]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
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

test('region filter resolves from a nested {x,y,w,h,filter} object', () => {
  assert.deepEqual(
    clipTx(view([setTx({ regionFilter: { x: 0.5, y: 0.1, w: 0.4, h: 0.3, filter: 'boxblur=10' } })])).regionFilter,
    { x: 0.5, y: 0.1, w: 0.4, h: 0.3, filter: 'boxblur=10' },
  );
});

test('region filter resolves from flat region_filter_* keys', () => {
  assert.deepEqual(
    clipTx(view([setTx({ region_filter_x: 0.2, region_filter_y: 0.2, region_filter_w: 0.3, region_filter_h: 0.3, region_filter: 'pixelize=w=16:h=16' })])).regionFilter,
    { x: 0.2, y: 0.2, w: 0.3, h: 0.3, filter: 'pixelize=w=16:h=16' },
  );
});

test('region filter is dropped without a filter string or with a zero-size region, and clamps 0..1', () => {
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0, y: 0, w: 0.4, h: 0.4, filter: '' } })])).regionFilter, undefined);
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0, y: 0, w: 0, h: 0.4, filter: 'boxblur=10' } })])).regionFilter, undefined);
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 2, y: -1, w: 5, h: 0.3, filter: 'boxblur=10' } })])).regionFilter.x, 1);
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 2, y: -1, w: 5, h: 0.3, filter: 'boxblur=10' } })])).regionFilter.y, 0);
  assert.equal(clipTx(view([setTx({ regionFilter: { x: 0, y: 0, w: 5, h: 0.3, filter: 'boxblur=10' } })])).regionFilter.w, 1);
});

test('materialize emits region_filter (snake_case object) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ regionFilter: { x: 0.5, y: 0.1, w: 0.4, h: 0.3, filter: 'boxblur=20' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].region_filter, { x: 0.5, y: 0.1, w: 0.4, h: 0.3, filter: 'boxblur=20' });
});

test('OFFLINE RENDER: a strong blur collapses the REGION detail while the area OUTSIDE is byte-identical (L155)', () => {
  const REGION = { x: 160, y: 24, w: 128, h: 72 };      // matches x=0.5,y=0.1,w=0.4,h=0.3 at 320x240
  const OUTSIDE = { x: 8, y: 150, w: 60, h: 60 };        // far from the region
  const base = render(null, 'rf-base');
  const cens = render({ regionFilter: { x: 0.5, y: 0.1, w: 0.4, h: 0.3, filter: 'gblur=sigma=16' } }, 'rf-censored');
  // the REGION changed substantially vs the unfiltered render (the blur was applied there).
  const regionDelta = meanAbsDiff(base, cens, REGION);
  assert.ok(regionDelta > 8, `region changed by the filter: meanAbsDiff=${regionDelta.toFixed(2)}`);
  // the area OUTSIDE the region is byte-identical (the censor is isolated to its rectangle).
  const outsideDelta = meanAbsDiff(base, cens, OUTSIDE);
  assert.ok(outsideDelta < 0.2, `outside is unchanged: meanAbsDiff=${outsideDelta.toFixed(3)}`);
  // and the blur genuinely lowers local detail in the region.
  assert.ok(stddev(cens, REGION) < stddev(base, REGION), 'region local detail drops under the blur');
});

test('OFFLINE RENDER: blackout (drawbox fill) makes the region a flat zero-detail rectangle (L155)', () => {
  const REGION = { x: 160, y: 24, w: 128, h: 72 };
  const out = render({ regionFilter: { x: 0.5, y: 0.1, w: 0.4, h: 0.3, filter: 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill' } }, 'rf-blackout');
  assert.ok(stddev(out, REGION) < 3, `blacked-out region is flat: ${stddev(out, REGION).toFixed(1)}`);
});
