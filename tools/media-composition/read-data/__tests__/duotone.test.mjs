/**
 * #127 Duotone (the Instagram / CapCut two-color gradient map): map the clip's LUMA to a gradient between
 * a `shadow` color (dark tones) and a `highlight` color (bright tones), both #RRGGBB hex. A linear chain
 * (format=gray + per-channel curves), no geq, parameterized by any two colors (own field, not a fixed
 * look). Blind DATA (L069/L090); hex is parsed to floats so injection is structurally impossible.
 *
 * Proof (L155): DATA resolution (nested/flat, invalid-hex dropped, normalize), materialize object
 * pass-through, AND a real offline render on a black->white ramp where the dark end becomes the shadow
 * color and the bright end becomes the highlight color.
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
let work, ramp;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function meanRGB(file, { x, y, w, h }) {
  // Sample frame 0 (no input seek). The source is static (gradients speed=0), so every frame is identical;
  // an imprecise `-ss` input-seek could land on a transitional/keyframe-reconstructed frame and read the
  // wrong values (the old flaky failure). Frame 0 of a static render is deterministic.
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n };
}
const near = (a, b, tol = 40) => Math.abs(a - b) <= tol;
const DARK = { x: 0, y: 80, w: 20, h: 40 };    // left = luma ~0
const BRIGHT = { x: 180, y: 80, w: 20, h: 40 }; // right = luma ~255

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'duo-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'duo-render-'));
  ramp = join(work, 'ramp.mp4');
  // A horizontal black->white luma ramp (gradients source), so the left is dark tones (=> shadow color)
  // and the right is bright tones (=> highlight color) after the duotone map. speed=0 FREEZES the gradient:
  // without it `gradients` animates over time, so sampling absolute colors at t=0.5 was NONDETERMINISTIC
  // (a flaky failure under parallel load). speed=0 makes the ramp static and the test deterministic.
  // An EXACT ramp, the source convention the rest of this suite folder already uses. `gradients`
  // is a RANDOM-gradient generator, and `speed=0` freezes its ANIMATION rather than its PATTERN,
  // so each run rendered different footage. Its siblings `posterize` and `split-tone` both went
  // red for exactly that, while this one happened to keep drawing a usable ramp.
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=200x200:d=1:r=24',
    '-vf', "geq=lum='X*255/W':cb=128:cr=128", '-pix_fmt', 'yuv420p', ramp]);
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
  const { edl } = materializeExportEdl(comp, () => ramp, { width: 200, height: 200, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('duotone resolves from a nested {shadow,highlight} object and normalizes hex', () => {
  assert.deepEqual(clipTx(view([setTx({ duotone: { shadow: '#0B1E6B', highlight: 'FF5EA8' } })])).duotone, { shadow: '0b1e6b', highlight: 'ff5ea8' });
});

test('duotone resolves from flat duotone_shadow/duotone_highlight', () => {
  assert.deepEqual(clipTx(view([setTx({ duotone_shadow: '#111111', duotone_highlight: '#f5f5f5' })])).duotone, { shadow: '111111', highlight: 'f5f5f5' });
});

test('duotone is dropped unless BOTH colors are valid 6-digit hex', () => {
  assert.equal(clipTx(view([setTx({ duotone: { shadow: '#123', highlight: '#ffffff' } })])).duotone, undefined);
  assert.equal(clipTx(view([setTx({ duotone: { shadow: 'not-a-color', highlight: '#ffffff' } })])).duotone, undefined);
  assert.equal(clipTx(view([setTx({ duotone: { shadow: '#000000' } })])).duotone, undefined);
});

test('materialize emits duotone (snake_case object) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ duotone: { shadow: '#0b1e6b', highlight: '#ff5ea8' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].duotone, { shadow: '0b1e6b', highlight: 'ff5ea8' });
});

test('OFFLINE RENDER: duotone maps the dark end to the shadow color and the bright end to the highlight color (L155)', () => {
  // shadow = strong blue (#0000c0), highlight = strong yellow (#f0f000).
  const out = render({ duotone: { shadow: '#0000c0', highlight: '#f0f000' } }, 'blue-yellow');
  const dark = meanRGB(out, DARK);
  const bright = meanRGB(out, BRIGHT);
  // dark tones -> blue: B dominant, R low.
  assert.ok(dark.b > dark.r + 60 && dark.b > dark.g + 60, `dark end is blue: ${JSON.stringify(dark)}`);
  // bright tones -> yellow: R and G high, B low.
  assert.ok(bright.r > 150 && bright.g > 150 && bright.b < 90, `bright end is yellow: ${JSON.stringify(bright)}`);
});

test('OFFLINE RENDER: a mono duotone stays gray at both ends but darkens shadows toward the shadow color (L155)', () => {
  const out = render({ duotone: { shadow: '#111111', highlight: '#f5f5f5' } }, 'mono');
  const dark = meanRGB(out, DARK);
  const bright = meanRGB(out, BRIGHT);
  assert.ok(near(dark.r, dark.g, 20) && near(dark.g, dark.b, 20) && dark.r < 70, `dark end is near-black gray: ${JSON.stringify(dark)}`);
  assert.ok(near(bright.r, bright.g, 20) && bright.r > 190, `bright end is near-white gray: ${JSON.stringify(bright)}`);
});
