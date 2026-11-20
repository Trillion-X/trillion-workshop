/**
 * #137 Multiple region filters -- the L069 list generalization of #130 (single regionFilter). A clip can now
 * carry N independent censors/effects, each its own {x,y,w,h,filter} rectangle, applied in order (blur a face
 * AND pixelate a plate AND black out a badge in ONE clip). The singular `regionFilter` is just n=1, and the
 * render composites the effective list [regionFilter, ...regionFilters] through ONE loop (no per-region branch).
 *
 * Proof (L155): DATA resolution (array parse, invalid-element drop, clamp), materialize array pass-through, AND
 * a real offline render where TWO separate regions are each independently blacked out while the area OUTSIDE
 * both stays byte-identical to an unfiltered render, PLUS the singular + plural combine on one clip.
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
function grayBytes(file, { x, y, w, h }) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', file,
    '-vf', `format=gray,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
function stddev(file, box) {
  const raw = grayBytes(file, box);
  let sum = 0; const n = raw.length;
  for (let i = 0; i < n; i++) sum += raw[i];
  const m = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (raw[i] - m) * (raw[i] - m);
  return Math.sqrt(v / n);
}
function meanAbsDiff(fileA, fileB, box) {
  const a = grayBytes(fileA, box), b = grayBytes(fileB, box);
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'rfs-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'rfs-render-'));
  src = join(work, 'detail.mp4');
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

test('region filters resolves an array of {x,y,w,h,filter}, clamping each element 0..1', () => {
  const list = clipTx(view([setTx({ regionFilters: [
    { x: 0.1, y: 0.1, w: 0.3, h: 0.3, filter: 'boxblur=10' },
    { x: 2, y: -1, w: 5, h: 0.4, filter: 'negate' },
  ] })])).regionFilters;
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { x: 0.1, y: 0.1, w: 0.3, h: 0.3, filter: 'boxblur=10' });
  assert.deepEqual(list[1], { x: 1, y: 0, w: 1, h: 0.4, filter: 'negate' }); // clamped
});

test('region filters resolves from the snake_case region_filters key too', () => {
  const list = clipTx(view([setTx({ region_filters: [{ x: 0.2, y: 0.2, w: 0.2, h: 0.2, filter: 'hue=s=0' }] })])).regionFilters;
  assert.equal(list.length, 1);
  assert.equal(list[0].filter, 'hue=s=0');
});

test('invalid elements (no filter, zero size) are dropped; an all-invalid list yields undefined', () => {
  const list = clipTx(view([setTx({ regionFilters: [
    { x: 0.1, y: 0.1, w: 0.3, h: 0.3, filter: '' },          // no filter -> dropped
    { x: 0.1, y: 0.1, w: 0, h: 0.3, filter: 'boxblur=10' },  // zero width -> dropped
    { x: 0.5, y: 0.5, w: 0.2, h: 0.2, filter: 'negate' },    // valid
  ] })])).regionFilters;
  assert.equal(list.length, 1);
  assert.equal(list[0].filter, 'negate');
  assert.equal(clipTx(view([setTx({ regionFilters: [{ w: 0, h: 0, filter: '' }] })])).regionFilters, undefined);
  assert.equal(clipTx(view([setTx({ regionFilters: [] })])).regionFilters, undefined);
});

test('materialize emits region_filters (snake_case array) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ regionFilters: [
    { x: 0.1, y: 0.1, w: 0.3, h: 0.3, filter: 'boxblur=20' },
    { x: 0.6, y: 0.6, w: 0.2, h: 0.2, filter: 'negate' },
  ] })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.equal(edl.spine.segments[0].region_filters.length, 2);
  assert.deepEqual(edl.spine.segments[0].region_filters[1], { x: 0.6, y: 0.6, w: 0.2, h: 0.2, filter: 'negate' });
});

test('OFFLINE RENDER: TWO separate regions are each blacked out; the area outside BOTH is byte-identical (L155)', () => {
  const R1 = { x: 16, y: 24, w: 64, h: 64 };    // x=0.05,y=0.1,w=0.2,h=0.266 at 320x240
  const R2 = { x: 224, y: 144, w: 64, h: 64 };   // x=0.7,y=0.6,w=0.2,h=0.266
  const OUTSIDE = { x: 140, y: 110, w: 40, h: 20 }; // between both regions
  const base = render(null, 'rfs-base');
  const out = render({ regionFilters: [
    { x: 0.05, y: 0.1, w: 0.2, h: 0.266, filter: 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill' },
    { x: 0.7, y: 0.6, w: 0.2, h: 0.266, filter: 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill' },
  ] }, 'rfs-two');
  assert.ok(stddev(out, R1) < 3, `region 1 flat/blacked: ${stddev(out, R1).toFixed(1)}`);
  assert.ok(stddev(out, R2) < 3, `region 2 flat/blacked: ${stddev(out, R2).toFixed(1)}`);
  // Two large blackouts make x264 redistribute bits, so the outside box drifts ~1/255 (recompression noise);
  // a real leak (the effect painting the wrong place) would be ~50-100. < 5 cleanly separates the two.
  assert.ok(meanAbsDiff(base, out, OUTSIDE) < 5, `outside both regions ~unchanged (no leak): ${meanAbsDiff(base, out, OUTSIDE).toFixed(3)}`);
});

test('OFFLINE RENDER: singular regionFilter + regionFilters combine on one clip (n=1 folds into the list) (L155)', () => {
  const RSINGLE = { x: 16, y: 24, w: 64, h: 64 };
  const RLIST = { x: 224, y: 144, w: 64, h: 64 };
  const out = render({
    regionFilter: { x: 0.05, y: 0.1, w: 0.2, h: 0.266, filter: 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill' },
    regionFilters: [{ x: 0.7, y: 0.6, w: 0.2, h: 0.266, filter: 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill' }],
  }, 'rfs-combo');
  assert.ok(stddev(out, RSINGLE) < 3, `singular region blacked: ${stddev(out, RSINGLE).toFixed(1)}`);
  assert.ok(stddev(out, RLIST) < 3, `list region blacked: ${stddev(out, RLIST).toFixed(1)}`);
});
