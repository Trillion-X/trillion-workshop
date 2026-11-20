/**
 * #125 Spotlight / positioned radial focus: darken the frame away from a chosen center to pull the eye to
 * a subject anywhere in frame. A POSITIONED vignette (x0/y0 accept w/h expressions), so it is distinct
 * from the fixed centered `vignette` look: cx/cy place the focus, strength scales the falloff. Blind DATA
 * over one filter (L069/L090).
 *
 * Proof (L155): DATA resolution + clamp + identity drop, materialize object pass-through, AND a real
 * offline render proving POSITIONING: a spotlight at (0.2,0.2) darkens the FAR corner more than the NEAR
 * corner while the focus center stays brightest (a fixed centered vignette could not show that asymmetry).
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
let work, gray;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function grayMean(file, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', file,
    '-vf', `format=gray,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0;
  for (let i = 0; i < raw.length; i++) s += raw[i];
  return s / raw.length;
}
const TL = { x: 4, y: 4, w: 30, h: 30 };
const BR = { x: 166, y: 166, w: 30, h: 30 };
const CENTER = { x: 85, y: 85, w: 30, h: 30 };

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'spot-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'spot-render-'));
  gray = join(work, 'gray.mp4');
  // A flat mid-gray 200x200 frame so the ONLY luma variation in the output is the spotlight falloff.
  ffmpeg(['-f', 'lavfi', '-i', 'color=0xA0A0A0:s=200x200:r=24:d=1', '-pix_fmt', 'yuv420p', gray]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'g.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => gray, { width: 200, height: 200, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('spotlight resolves from a nested {cx,cy,strength} object', () => {
  assert.deepEqual(clipTx(view([setTx({ spotlight: { cx: 0.2, cy: 0.3, strength: 0.8 } })])).spotlight, { cx: 0.2, cy: 0.3, strength: 0.8 });
});

test('spotlight resolves from flat spotlight_x/y/strength; defaults center', () => {
  assert.deepEqual(clipTx(view([setTx({ spotlight_strength: 0.6 })])).spotlight, { cx: 0.5, cy: 0.5, strength: 0.6 });
});

test('strength 0 is identity and dropped', () => {
  assert.equal(clipTx(view([setTx({ spotlight: { cx: 0.2, cy: 0.2, strength: 0 } })])).spotlight, undefined);
});

test('materialize emits spotlight (snake_case object) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ spotlight: { cx: 0.25, cy: 0.75, strength: 0.5 } })]));
  const { edl } = materializeExportEdl(comp, () => 'g.mp4', {});
  assert.deepEqual(edl.spine.segments[0].spotlight, { cx: 0.25, cy: 0.75, strength: 0.5 });
});

test('OFFLINE RENDER: a centered spotlight darkens the corners below the center (L155)', () => {
  const out = render({ spotlight: { cx: 0.5, cy: 0.5, strength: 0.9 } }, 'center');
  const corner = grayMean(out, TL);
  const center = grayMean(out, CENTER);
  assert.ok(corner < center - 15, `corner ${corner.toFixed(1)} darker than center ${center.toFixed(1)}`);
});

test('OFFLINE RENDER: POSITIONING, a spotlight at (0.2,0.2) darkens the far corner more than the near corner (L155)', () => {
  const out = render({ spotlight: { cx: 0.2, cy: 0.2, strength: 0.9 } }, 'topleft');
  const near = grayMean(out, TL);   // near the focus, brighter
  const far = grayMean(out, BR);    // far from the focus, darker
  assert.ok(far < near - 15, `far corner ${far.toFixed(1)} much darker than near corner ${near.toFixed(1)} (proves the focus is positioned, not centered)`);
});
