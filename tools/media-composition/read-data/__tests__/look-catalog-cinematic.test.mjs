/**
 * The cinematic LOOK_CATALOG family (vignette, film-grain, bleach-bypass, dreamy, chromatic-aberration,
 * cyberpunk) as DATA rows over the existing opaque `grade` seam. Adding a look is adding a row: zero
 * engine code, the render blindly applies the resolved ffmpeg filter string (L090/enum-dissolution).
 *
 * Proof (L155): each look resolves its grade string through the reducer, materialize passes `grade`
 * onto the EDL, AND a real offline render shows the expected pixel signature (corner darkening for
 * vignette; flat-region variance for grain; per-channel edge separation for chromatic aberration),
 * plus EVERY catalog look renders without error and changes pixels vs the ungraded clip.
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
let composeTimeline, materializeExportEdl, LOOK_CATALOG;
let work, flatGray, whiteBar, colorBars;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}

// Mean of a plane over a rect at `seek` seconds. `plane` selects a single channel (r/g/b) or gray.
function planeMean(file, { x, y, w, h }, plane = 'gray', seek = 0.5) {
  const vf = plane === 'gray' ? 'format=gray' : `format=rgb24,extractplanes=${plane}`;
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(seek), '-i', file,
    '-vf', `${vf},crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum += raw[i];
  return sum / raw.length;
}

function planeStddev(file, rect, plane = 'gray', seek = 0.5) {
  const vf = plane === 'gray' ? 'format=gray' : `format=rgb24,extractplanes=${plane}`;
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(seek), '-i', file,
    '-vf', `${vf},crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum += raw[i];
  const mean = sum / raw.length;
  let v = 0;
  for (let i = 0; i < raw.length; i++) v += (raw[i] - mean) ** 2;
  return Math.sqrt(v / raw.length);
}

// The column index (0-based) of the brightest-transition in a single row of a plane: for a white bar
// on black, this is the bar's left edge. Used to prove chromatic aberration shifts R and B apart.
function edgeColumn(file, plane, rowY, seek = 0.5) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(seek), '-i', file,
    '-vf', `format=rgb24,extractplanes=${plane},crop=320:1:0:${rowY}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  for (let x = 0; x < raw.length; x++) if (raw[x] > 128) return x;
  return -1;
}

// The full RGB frame at `seek`, raw bytes: the universal "did the look change pixels" surface (a
// desaturating look like B&W preserves luma but collapses chroma, so a gray-plane check misses it).
function rgbFrame(file, seek = 0.5) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(seek), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
function meanAbsDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'look-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline, LOOK_CATALOG } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'look-render-'));
  flatGray = join(work, 'flat.mp4');
  whiteBar = join(work, 'bar.mp4');
  colorBars = join(work, 'bars.mp4');
  // Flat mid-gray: vignette must darken the corner vs the center; grain must add variance to it.
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x808080:s=320x180:r=24:d=1', '-pix_fmt', 'yuv420p', flatGray]);
  // A white vertical bar at x=158 on black: chromatic aberration shifts the R edge right, B edge left.
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=320x180:r=24:d=1',
    '-f', 'lavfi', '-i', 'color=white:s=4x180:r=24:d=1',
    '-filter_complex', '[0][1]overlay=x=158:y=0', '-pix_fmt', 'yuv420p', whiteBar]);
  // Saturated color bars: a look that renders must change pixels vs the ungraded clip.
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1', '-pix_fmt', 'yuv420p', colorBars]);
});

const view = (decisions, src = 'clip.mp4') => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: src, source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });

const render = (lookKey, srcFile, name) => {
  const comp = composeTimeline(view(lookKey ? [setTx({ look: lookKey })] : []));
  const { edl } = materializeExportEdl(comp, () => srcFile, { width: 320, height: 180, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('a look key resolves to its catalog grade string on the clip transform + EDL', () => {
  const comp = composeTimeline(view([setTx({ look: 'vignette' })]));
  const clip = comp.lanes.find((l) => l.role === 'video').clips[0];
  assert.equal(clip.transform.grade, LOOK_CATALOG['vignette']);
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', {});
  assert.equal(edl.spine.segments[0].grade, 'vignette=PI/4');
});

test('the 6 cinematic looks are present as DATA rows (zero engine code)', () => {
  for (const k of ['vignette', 'film-grain', 'bleach-bypass', 'dreamy', 'chromatic-aberration', 'cyberpunk']) {
    assert.ok(typeof LOOK_CATALOG[k] === 'string' && LOOK_CATALOG[k].length > 0, `${k} missing`);
  }
});

test('OFFLINE RENDER: vignette darkens the corner far below the center (L155)', () => {
  const out = render('vignette', flatGray, 'vig');
  const corner = planeMean(out, { x: 0, y: 0, w: 24, h: 24 });
  const center = planeMean(out, { x: 148, y: 78, w: 24, h: 24 });
  assert.ok(corner < center * 0.7, `vignette corner ${corner.toFixed(1)} << center ${center.toFixed(1)}`);
});

test('OFFLINE RENDER: film-grain adds variance to a flat region (L155)', () => {
  const flat = planeStddev(render(null, flatGray, 'flat-plain'), { x: 100, y: 60, w: 60, h: 60 });
  const grain = planeStddev(render('film-grain', flatGray, 'flat-grain'), { x: 100, y: 60, w: 60, h: 60 });
  assert.ok(grain > flat + 4, `grain stddev ${grain.toFixed(2)} > flat ${flat.toFixed(2)} + 4`);
});

test('OFFLINE RENDER: chromatic-aberration separates the R and B edges of a white bar (L155)', () => {
  const plain = render(null, whiteBar, 'bar-plain');
  const aberr = render('chromatic-aberration', whiteBar, 'bar-aberr');
  const rPlain = edgeColumn(plain, 'r', 90);
  const bPlain = edgeColumn(plain, 'b', 90);
  assert.equal(rPlain, bPlain, 'the plain bar has R and B aligned');
  const rEdge = edgeColumn(aberr, 'r', 90);
  const bEdge = edgeColumn(aberr, 'b', 90);
  // rgbashift rh=5 pushes the R channel right (edge moves to a higher column); bh=-5 pushes B left.
  assert.ok(rEdge > rPlain + 2, `R edge shifted right: ${rEdge} vs ${rPlain}`);
  assert.ok(bEdge < bPlain - 2, `B edge shifted left: ${bEdge} vs ${bPlain}`);
});

test('OFFLINE RENDER: every catalog look renders and changes pixels vs the ungraded clip (L155)', () => {
  const plain = rgbFrame(render(null, colorBars, 'bars-plain'));
  for (const k of Object.keys(LOOK_CATALOG)) {
    const out = render(k, colorBars, `bars-${k.replace(/[^a-z]/g, '')}`);
    // Universal proof: the graded RGB frame differs from the ungraded one. A desaturating look (B&W)
    // preserves luma but collapses chroma, so we compare the full RGB frame, not a gray plane.
    const diff = meanAbsDiff(rgbFrame(out), plain);
    assert.ok(diff > 0.5, `${k} left the frame unchanged (mean abs RGB diff ${diff.toFixed(3)})`);
  }
});
