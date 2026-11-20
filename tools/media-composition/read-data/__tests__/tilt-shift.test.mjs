/**
 * #164 Tilt-shift: keep a horizontal band of the frame sharp and blur everything above and below it, the
 * toy-miniature / subject-focus look. The band is centered at `center` (0..1 of height), is `height` tall
 * (0..1), fades over `feather` (0..1), and the out-of-band region is Gaussian-blurred by `blur` sigma.
 * Rendered by splitting the frame, blurring one copy, and blending the two through a vertical band mask
 * m = max(0, 1 - max(0, dist-to-band) / feather_px), so inside the band the sharp copy wins.
 *
 * Proof: DATA resolution (nested {center,height,feather,blur} + flat tilt_shift_*; height <= 0 dropped;
 * center/height/feather clamp 0..1, blur>0 kept), materialize pass-through, AND a real offline render on a
 * fine vertical-stripe source where the CENTER band stays high-frequency (sharp) while the TOP is smeared
 * into low-frequency (blurred) (L155).
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
let work, stripes;
const W = 320;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// Mean absolute adjacent-pixel difference across a row range = high-frequency energy (sharpness).
// Fine stripes -> large adjacent diffs when sharp, near-zero once blurred smooth.
function sharpness(raw, y0, y1, x0 = 40, x1 = 280) {
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1 - 1; x++) {
    const i = (y * W + x) * 3, j = (y * W + x + 1) * 3;
    if (j < raw.length) { sum += Math.abs(raw[i] - raw[j]); n++; }
  }
  return n ? sum / n : 0;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'tsx-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'tsx-render-'));
  stripes = join(work, 'stripes.mp4'); // fine vertical black/white stripes: 4px period => strong high freq
  ffmpeg(['-f', 'lavfi', '-i', "color=black:s=320x240:d=2:r=24", '-vf',
    "geq=lum='if(lt(mod(X\\,4)\\,2)\\,255\\,0)':cb=128:cr=128", '-pix_fmt', 'yuv420p', stripes]);
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

const render = (params, name, source = stripes) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => source, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves tilt-shift: nested + flat; height<=0 dropped; center/height/feather clamp; blur kept', () => {
  assert.deepEqual(
    clipTx(view([setTx({ tilt_shift: { center: 0.5, height: 0.3, feather: 0.12, blur: 10 } })])).tiltShift,
    { center: 0.5, height: 0.3, feather: 0.12, blur: 10 });
  // flat form
  assert.deepEqual(
    clipTx(view([setTx({ tilt_shift_height: 0.4, tilt_shift_center: 0.6, tilt_shift_blur: 6 })])).tiltShift,
    { center: 0.6, height: 0.4, blur: 6 });
  // clamps: center/height/feather 0..1
  assert.deepEqual(
    clipTx(view([setTx({ tilt_shift: { center: 5, height: 9, feather: 3, blur: 4 } })])).tiltShift,
    { center: 1, height: 1, feather: 1, blur: 4 });
  // height <= 0 dropped entirely
  assert.equal(clipTx(view([setTx({ tilt_shift: { center: 0.5, height: 0 } })])).tiltShift, undefined);
  assert.equal(clipTx(view([setTx({})])).tiltShift, undefined);
});

test('materialize emits tilt_shift (snake-cased top-level, nested object verbatim)', () => {
  const comp = composeTimeline(view([setTx({ tilt_shift: { center: 0.5, height: 0.3, feather: 0.12, blur: 10 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].tilt_shift, { center: 0.5, height: 0.3, feather: 0.12, blur: 10 });
});

test('OFFLINE RENDER: center band stays sharp, top is blurred smooth (L155)', () => {
  // Center band height 0.3 => rows ~ [0.35..0.65]*240 = [84..156]. Sample rows 108..132 (in-band)
  // and rows 10..34 (top, far out of band).
  const plain = frame(render({}, 'ts-off'), 1.0);
  const tilted = frame(render({ tilt_shift: { center: 0.5, height: 0.3, feather: 0.08, blur: 12 } }, 'ts-on'), 1.0);

  const bandPlain = sharpness(plain, 108, 132);
  const topPlain = sharpness(plain, 10, 34);
  // Baseline: stripes are equally sharp everywhere before tilt-shift.
  assert.ok(bandPlain > 40, `plain stripes are sharp in the band: ${bandPlain.toFixed(1)}`);
  assert.ok(topPlain > 40, `plain stripes are sharp at the top: ${topPlain.toFixed(1)}`);

  const bandTilt = sharpness(tilted, 108, 132);
  const topTilt = sharpness(tilted, 10, 34);
  // In-band stays crisp; top is smeared into near-flat.
  assert.ok(bandTilt > 30, `focus band stays sharp: ${bandTilt.toFixed(1)}`);
  assert.ok(topTilt < 12, `top is blurred smooth: ${topTilt.toFixed(1)}`);
  assert.ok(bandTilt > topTilt * 3, `band is much sharper than the blurred top: band=${bandTilt.toFixed(1)} top=${topTilt.toFixed(1)}`);
});
