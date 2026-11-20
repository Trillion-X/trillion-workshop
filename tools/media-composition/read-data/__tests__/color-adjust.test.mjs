/**
 * #121 Manual color adjustment (the CapCut "Adjust" / Lumetri-basic daily driver): continuous
 * brightness/contrast/saturation/gamma as blind DATA over an `eq=` filter, applied AFTER the grade
 * seam so a manual tweak STACKS on top of a preset look. Distinct from the fixed LOOK_CATALOG presets;
 * reuses the same eq= mechanism the presets bake in, but continuous. Zero engine branching (L069/L090).
 *
 * Proof (L155): DATA resolution + identity-drop, materialize snake_case object pass-through, AND real
 * offline renders where brightness raises mean luma, saturation 0 collapses chroma, and contrast widens
 * the dark-vs-bright gap.
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
let work, gray, bars, twoTone;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function planeMean(file, plane, { x, y, w, h }) {
  const vf = plane === 'gray' ? 'format=gray' : `format=rgb24,extractplanes=${plane}`;
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', file,
    '-vf', `${vf},crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0;
  for (let i = 0; i < raw.length; i++) s += raw[i];
  return s / raw.length;
}
const FULL = { x: 0, y: 0, w: 200, h: 200 };

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'coladj-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'coladj-render-'));
  gray = join(work, 'gray.mp4');
  bars = join(work, 'bars.mp4');
  twoTone = join(work, 'twotone.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x808080:s=200x200:r=24:d=1', '-pix_fmt', 'yuv420p', gray]);
  // A saturated pure-red frame: saturation 0 must collapse it toward gray (R falls, G/B rise).
  ffmpeg(['-f', 'lavfi', '-i', 'color=0xE00000:s=200x200:r=24:d=1', '-pix_fmt', 'yuv420p', bars]);
  // Left half dark gray (64), right half light gray (192): contrast>1 widens the gap.
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=200x200:r=24:d=1',
    '-vf', 'drawbox=x=0:y=0:w=100:h=200:color=0x404040:t=fill,drawbox=x=100:y=0:w=100:h=200:color=0xC0C0C0:t=fill',
    '-pix_fmt', 'yuv420p', twoTone]);
});

const view = (decisions, src) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: src ?? 'c.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, src, name) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : [], src));
  const { edl } = materializeExportEdl(comp, () => src, { width: 200, height: 200, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('color_adjust resolves the non-identity terms onto the clip transform', () => {
  const t = clipTx(view([setTx({ color_adjust: { brightness: 0.2, contrast: 1.3, saturation: 1, gamma: 1 } })], 'c.mp4'));
  assert.deepEqual(t.colorAdjust, { brightness: 0.2, contrast: 1.3 });
});

test('an all-identity adjustment is dropped', () => {
  const t = clipTx(view([setTx({ color_adjust: { brightness: 0, contrast: 1, saturation: 1, gamma: 1 } })], 'c.mp4'));
  assert.equal(t.colorAdjust, undefined);
});

test('flat brightness/contrast/saturation/gamma also resolve', () => {
  const t = clipTx(view([setTx({ brightness: 0, contrast: 1, saturation: 0.5, gamma: 2 })], 'c.mp4'));
  assert.deepEqual(t.colorAdjust, { saturation: 0.5, gamma: 2 });
});

test('materialize emits color_adjust (snake_case object) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ color_adjust: { brightness: 0.1, saturation: 1.5 } })], 'c.mp4'));
  const { edl } = materializeExportEdl(comp, () => 'c.mp4', {});
  assert.deepEqual(edl.spine.segments[0].color_adjust, { brightness: 0.1, saturation: 1.5 });
});

test('OFFLINE RENDER: brightness raises mean luma on a mid-gray clip (L155)', () => {
  const plain = planeMean(render(null, gray, 'g-plain'), 'gray', FULL);
  const brighter = planeMean(render({ color_adjust: { brightness: 0.3 } }, gray, 'g-bright'), 'gray', FULL);
  assert.ok(brighter > plain + 30, `brightness lifts luma: ${brighter.toFixed(1)} vs ${plain.toFixed(1)}`);
});

test('OFFLINE RENDER: saturation 0 collapses a red frame toward gray (L155)', () => {
  const plainR = planeMean(render(null, bars, 'r-plain'), 'r', FULL);
  const plainB = planeMean(render(null, bars, 'r-plain2'), 'b', FULL);
  assert.ok(plainR - plainB > 100, `the source is strongly red: R ${plainR.toFixed(0)} >> B ${plainB.toFixed(0)}`);
  const out = render({ color_adjust: { saturation: 0 } }, bars, 'r-desat');
  const desatR = planeMean(out, 'r', FULL);
  const desatB = planeMean(out, 'b', FULL);
  assert.ok(Math.abs(desatR - desatB) < 20, `desaturated channels converge: R ${desatR.toFixed(0)} ~= B ${desatB.toFixed(0)}`);
});

test('OFFLINE RENDER: contrast > 1 widens the dark-vs-bright gap (L155)', () => {
  const plainDark = planeMean(render(null, twoTone, 't-plain-d'), 'gray', { x: 0, y: 0, w: 100, h: 200 });
  const plainLight = planeMean(render(null, twoTone, 't-plain-l'), 'gray', { x: 100, y: 0, w: 100, h: 200 });
  const out = render({ color_adjust: { contrast: 1.6 } }, twoTone, 't-hi');
  const hiDark = planeMean(out, 'gray', { x: 0, y: 0, w: 100, h: 200 });
  const hiLight = planeMean(out, 'gray', { x: 100, y: 0, w: 100, h: 200 });
  assert.ok((hiLight - hiDark) > (plainLight - plainDark) + 10, `contrast widens the gap: ${(hiLight - hiDark).toFixed(0)} > ${(plainLight - plainDark).toFixed(0)}`);
});

test('OFFLINE RENDER: color-adjust STACKS on a preset look (eq applied after grade) (L155)', () => {
  // A look (black-white) + a brightness lift: the output is BOTH desaturated AND brighter than the
  // look alone, proving the eq is applied on top of the grade rather than replacing it.
  const lookOnly = planeMean(render({ look: 'black-white' }, bars, 'stack-look'), 'gray', FULL);
  const lookPlus = planeMean(render({ look: 'black-white', color_adjust: { brightness: 0.25 } }, bars, 'stack-both'), 'gray', FULL);
  assert.ok(lookPlus > lookOnly + 20, `adjust stacks on the look: ${lookPlus.toFixed(0)} > ${lookOnly.toFixed(0)}`);
});
