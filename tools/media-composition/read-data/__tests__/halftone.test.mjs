/**
 * #163 Halftone: render the frame as a comic / newspaper dot-screen. Each `size`-px cell becomes a black
 * dot on white whose radius grows as the local brightness drops (dark = big dots, bright = tiny/none), so
 * the image reads as 1-bit ink dots. The dot is INK (0) when its distance to the cell center (normalized to
 * the cell half-size) is below 1.42*sqrt(1-luma), making the dot AREA linear in darkness. Distinct from
 * posterize (which keeps banded colors); this is a monochrome print screen.
 *
 * Proof: DATA resolution (nested {size} + flat halftone_size; size < 2 dropped; clamps 2..40, rounds),
 * materialize pass-through, AND a real offline render on a gradient where the output is ~1-bit (only black
 * and white) and the white-fraction rises from the dark end to the bright end (L155).
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
let work, grad, gray;
const W = 320;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
function whiteFrac(raw, x0, x1, y0 = 60, y1 = 180) {
  let w = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 3; if (i < raw.length) { n++; if (raw[i] > 127) w++; } }
  return n ? w / n : 0;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'ht-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'ht-render-'));
  grad = join(work, 'grad.mp4'); // smooth black->white gradient
  // An EXACT ramp, the source convention the rest of this suite folder already uses. `gradients`
  // is a RANDOM-gradient generator and draws a different pattern per run, so a pixel assertion
  // against it passes or fails on the draw. Its sibling `posterize` was red in the corpus for
  // that reason while this one happened to keep drawing a usable gradient.
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=2:r=24',
    '-vf', "geq=lum='X*255/W':cb=128:cr=128", '-pix_fmt', 'yuv420p', grad]);
  gray = join(work, 'gray.mp4'); // flat mid-gray: every pixel is a mid value (128)
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x808080:s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', gray]);
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

const render = (params, name, source = grad) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => source, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves halftone: nested {size} + flat halftone_size; size < 2 dropped; clamps 2..40 + rounds', () => {
  assert.deepEqual(clipTx(view([setTx({ halftone: { size: 6 } })])).halftone, { size: 6 });
  assert.deepEqual(clipTx(view([setTx({ halftone_size: 5.6 })])).halftone, { size: 6 }); // rounded
  assert.deepEqual(clipTx(view([setTx({ halftone: { size: 100 } })])).halftone, { size: 40 }); // clamped
  assert.equal(clipTx(view([setTx({ halftone: { size: 1 } })])).halftone, undefined); // < 2 dropped
});

test('materialize emits halftone (snake-cased top-level, nested verbatim)', () => {
  const comp = composeTimeline(view([setTx({ halftone: { size: 6 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].halftone, { size: 6 });
});

test('OFFLINE RENDER: output is ~1-bit dots and the white-fraction rises dark->bright (L155)', () => {
  const out = render({ halftone: { size: 6 } }, 'ht');
  const f = frame(out, 0.0);
  // 1-bit: nearly every pixel is near-black or near-white (few mid values).
  let mid = 0, tot = 0;
  for (let i = 0; i < f.length; i += 3) { tot++; if (f[i] > 40 && f[i] < 215) mid++; }
  assert.ok(mid / tot < 0.15, `output is ~1-bit (few mid-gray pixels): midFrac=${(mid / tot).toFixed(3)}`);
  const dark = whiteFrac(f, 20, 70);
  const bright = whiteFrac(f, 250, 300);
  assert.ok(dark < 0.35, `dark end is mostly ink: white-frac=${dark.toFixed(2)}`);
  assert.ok(bright > 0.75, `bright end is mostly paper: white-frac=${bright.toFixed(2)}`);
  assert.ok(bright > dark + 0.4, `dots grow toward the dark end: dark=${dark.toFixed(2)} bright=${bright.toFixed(2)}`);
});

test('OFFLINE RENDER: a flat mid-gray stays mid without halftone but binarizes WITH it (regression)', () => {
  const midFrac = (out) => {
    const f = frame(out, 1.0); let mid = 0, tot = 0;
    for (let i = 0; i < f.length; i += 3) { tot++; if (f[i] > 40 && f[i] < 215) mid++; }
    return mid / tot;
  };
  const plain = midFrac(render({}, 'ht-gray-off', gray));
  const halftoned = midFrac(render({ halftone: { size: 6 } }, 'ht-gray-on', gray));
  assert.ok(plain > 0.9, `flat gray stays mid without halftone: midFrac=${plain.toFixed(3)}`);
  assert.ok(halftoned < 0.15, `halftone binarizes the gray into ink dots: midFrac=${halftoned.toFixed(3)}`);
});
