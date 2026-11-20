/**
 * #136 Split-tone color grade (the cinematic 3-way "color wheels" look, e.g. teal shadows + orange
 * highlights): shift the RGB balance of shadows / midtones / highlights independently via ffmpeg
 * colorbalance. Distinct from #127 duotone (which REPLACES color) and #121 colorAdjust (global). All params
 * are clamped numbers, so injection is impossible.
 *
 * Proof (L155): DATA resolution (nested, dropped when neutral, clamp), materialize object pass-through, AND a
 * real offline render on a static luma ramp where the dark end gains the shadow tint (blue up) and the bright
 * end gains the highlight tint (blue down / warm). Static source + frame-0 sampling (deterministic).
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
// Sample frame 0 (no seek) of a static render; deterministic.
function meanRGB(file, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n };
}
const DARK = { x: 0, y: 80, w: 20, h: 40 };
const BRIGHT = { x: 180, y: 80, w: 20, h: 40 };

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'st-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'st-render-'));
  ramp = join(work, 'ramp.mp4');
  // An EXACT black->white luma ramp, computed per pixel. This used to come from `gradients`, which
  // is a random-gradient generator: `speed=0` freezes its ANIMATION, not its PATTERN, so the source
  // differed between runs and the dark crop did not reliably land on dark pixels. The suite measured
  // a mean blue of ~104 in a region a true ramp puts at ~13, and the render assertion below passed or
  // failed depending on which gradient that run happened to draw. `geq` has no random input at all,
  // so the header's "static source, deterministic" claim is now true rather than intended.
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

test('split tone resolves from a nested {shadows,mids,highlights} object, clamped -1..1', () => {
  const st = clipTx(view([setTx({ splitTone: { shadows: { b: 0.4, g: 0.2, r: -0.3 }, highlights: { r: 5, b: -0.3 } } })])).splitTone;
  assert.deepEqual(st.shadows, { r: -0.3, g: 0.2, b: 0.4 });
  assert.deepEqual(st.highlights, { r: 1, g: 0, b: -0.3 }); // r clamped to 1
  assert.deepEqual(st.mids, { r: 0, g: 0, b: 0 });
});

test('split tone is dropped when every channel is neutral (0)', () => {
  assert.equal(clipTx(view([setTx({ splitTone: { shadows: { r: 0, g: 0, b: 0 } } })])).splitTone, undefined);
  assert.equal(clipTx(view([setTx({ look: 'dreamy' })])).splitTone, undefined);
});

test('materialize emits split_tone (snake_case object) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ splitTone: { shadows: { b: 0.4 }, highlights: { r: 0.4 } } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].split_tone, { shadows: { r: 0, g: 0, b: 0.4 }, mids: { r: 0, g: 0, b: 0 }, highlights: { r: 0.4, g: 0, b: 0 } });
});

test('OFFLINE RENDER: teal shadows + orange highlights tint the dark end blue and the bright end warm (L155)', () => {
  const base = render(null, 'st-base');
  const graded = render({ splitTone: { shadows: { r: -0.3, g: 0.2, b: 0.4 }, highlights: { r: 0.4, g: 0.1, b: -0.3 } } }, 'st-graded');
  const bDark = meanRGB(base, DARK), gDark = meanRGB(graded, DARK);
  const bBright = meanRGB(base, BRIGHT), gBright = meanRGB(graded, BRIGHT);
  // shadows gain blue (teal) and lose red vs the ungraded ramp.
  assert.ok(gDark.b > bDark.b + 15, `shadows gained blue: base=${bDark.b.toFixed(0)} graded=${gDark.b.toFixed(0)}`);
  assert.ok(gDark.r < bDark.r + 2, `shadows did not gain red: base=${bDark.r.toFixed(0)} graded=${gDark.r.toFixed(0)}`);
  // highlights lose blue (warm/orange) vs the ungraded ramp.
  assert.ok(gBright.b < bBright.b - 15, `highlights lost blue (warm): base=${bBright.b.toFixed(0)} graded=${gBright.b.toFixed(0)}`);
});
