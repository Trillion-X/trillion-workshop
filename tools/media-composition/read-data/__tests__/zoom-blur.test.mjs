/**
 * #167 Zoom / radial blur: motion streaks radiating from a center point (the "speed zoom" hype look). geq
 * has no radial-blur primitive, so the render AVERAGES taps sampled toward the center: out = mean over k of
 * src(cx+(X-cx)*f_k, cy+(Y-cy)*f_k), f_k from 1 down to 1-0.26*strength. The average smears along each
 * radial line, reading as zoom streaks that are strongest far from the center and near-zero at the center.
 *
 * Proof: DATA resolution (nested {strength,cx,cy} + flat zoom_blur_*; strength <= 0 dropped; strength/cx/cy
 * clamp 0..1), materialize pass-through, AND a real offline render where sharp off-center detail is smeared
 * (edge softness rises a lot) while the exact center stays sharp (L155).
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
let work, dots;
const W = 320;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// edge softness = fraction of mid-gray (anti-aliased/smeared) pixels in a box; sharp b/w detail has few.
function smearFrac(raw, x0, x1, y0, y1) {
  let mid = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 3; if (i < raw.length) { n++; const v = raw[i]; if (v > 40 && v < 215) mid++; } }
  return n ? mid / n : 0;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'zb-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'zb-render-'));
  // white text near the top-left corner (far from center) + a small centered mark: radial blur smears the
  // corner text but leaves the center sharp.
  dots = join(work, 'dots.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=320x240:d=2:r=12', '-vf',
    "drawtext=text='AAAA':fontcolor=white:fontsize=40:x=20:y=20,drawbox=x=158:y=118:w=4:h=4:color=white:t=fill",
    '-pix_fmt', 'yuv420p', dots]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-09T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name, source = dots) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => source, { width: 320, height: 240, fps: 12 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves zoom blur: nested {strength,cx,cy} + flat; strength<=0 dropped; clamps 0..1', () => {
  assert.deepEqual(clipTx(view([setTx({ zoom_blur: { strength: 0.6, cx: 0.4, cy: 0.7 } })])).zoomBlur, { strength: 0.6, cx: 0.4, cy: 0.7 });
  assert.deepEqual(clipTx(view([setTx({ zoom_blur_strength: 0.5 })])).zoomBlur, { strength: 0.5 });
  assert.deepEqual(clipTx(view([setTx({ zoom_blur: { strength: 5, cx: 9, cy: -3 } })])).zoomBlur, { strength: 1, cx: 1, cy: 0 });
  assert.equal(clipTx(view([setTx({ zoom_blur: { strength: 0 } })])).zoomBlur, undefined);
  assert.equal(clipTx(view([setTx({})])).zoomBlur, undefined);
});

test('materialize emits zoom_blur (snake-cased top-level, nested object verbatim)', () => {
  const comp = composeTimeline(view([setTx({ zoom_blur: { strength: 0.6, cx: 0.5, cy: 0.5 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].zoom_blur, { strength: 0.6, cx: 0.5, cy: 0.5 });
});

test('OFFLINE RENDER: off-center detail is smeared into streaks, the center stays sharp (L155)', () => {
  const plain = frame(render({}, 'zb-off'), 1.0);
  const blurred = frame(render({ zoom_blur: { strength: 0.8, cx: 0.5, cy: 0.5 } }, 'zb-on'), 1.0);

  // corner text box (far from center): sharp b/w before, heavily smeared after.
  const cornerPlain = smearFrac(plain, 20, 130, 20, 70);
  const cornerBlur = smearFrac(blurred, 20, 130, 20, 70);
  assert.ok(cornerPlain < 0.15, `corner text is sharp before blur: smear=${cornerPlain.toFixed(3)}`);
  assert.ok(cornerBlur > cornerPlain + 0.1, `off-center detail is smeared by the radial blur: plain=${cornerPlain.toFixed(3)} blur=${cornerBlur.toFixed(3)}`);

  // exact center mark: taps converge there, so it stays essentially unchanged (still black around it).
  const centerPlain = smearFrac(plain, 150, 170, 110, 130);
  const centerBlur = smearFrac(blurred, 150, 170, 110, 130);
  assert.ok(Math.abs(centerBlur - centerPlain) < 0.2, `the center is barely affected: plain=${centerPlain.toFixed(3)} blur=${centerBlur.toFixed(3)}`);
});
