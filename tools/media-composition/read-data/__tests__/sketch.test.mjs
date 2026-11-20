/**
 * #165 Sketch / edge-detect: render the frame as a line-art or cartoon-shaded drawing by detecting edges.
 * `mode` selects the look ('colormix' = cartoon shading over the image; 'canny'/'wires' = white lines on
 * black); `strength` 0..1 lowers the detector thresholds so more edges are found. The render allowlists mode
 * to edgedetect's fixed capability set (no free text into the filter graph) and maps strength to low/high.
 *
 * Proof: DATA resolution (nested {mode,strength} + flat sketch_mode/sketch_strength + bare `sketch:true`;
 * strength clamps 0..1; unknown mode kept verbatim as DATA and the render falls back safely), materialize
 * pass-through, AND real offline renders: canny collapses a colored source to ~1-bit black-with-white-lines,
 * while colormix keeps mid tones but darkens the edges vs the plain source (L155).
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
let work, shapes;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
function stats(raw) {
  let blk = 0, wht = 0, mid = 0, tot = 0;
  for (let i = 0; i < raw.length; i += 3) { tot++; const v = raw[i]; if (v < 40) blk++; else if (v > 215) wht++; else mid++; }
  return { blk: blk / tot, wht: wht / tot, mid: mid / tot };
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'sk-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'sk-render-'));
  shapes = join(work, 'shapes.mp4'); // colored shapes on a gradient: fills + strong edges both present
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=2:r=12', '-pix_fmt', 'yuv420p', shapes]);
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

const render = (params, name, source = shapes) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => source, { width: 320, height: 240, fps: 12 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves sketch: nested {mode,strength} + flat + bare true; strength clamps; mode kept verbatim', () => {
  assert.deepEqual(clipTx(view([setTx({ sketch: { mode: 'canny', strength: 0.8 } })])).sketch, { mode: 'canny', strength: 0.8 });
  assert.deepEqual(clipTx(view([setTx({ sketch_mode: 'wires', sketch_strength: 0.3 })])).sketch, { mode: 'wires', strength: 0.3 });
  assert.deepEqual(clipTx(view([setTx({ sketch: true })])).sketch, {}); // bare true enables (render defaults cartoon)
  assert.deepEqual(clipTx(view([setTx({ sketch: { strength: 5 } })])).sketch, { strength: 1 }); // clamp high
  assert.deepEqual(clipTx(view([setTx({ sketch: { strength: -2 } })])).sketch, { strength: 0 }); // clamp low
  assert.equal(clipTx(view([setTx({})])).sketch, undefined);
  assert.equal(clipTx(view([setTx({ sketch: false })])).sketch, undefined); // false does not enable
});

test('materialize emits sketch (snake-cased top-level, nested object verbatim)', () => {
  const comp = composeTimeline(view([setTx({ sketch: { mode: 'colormix', strength: 0.5 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].sketch, { mode: 'colormix', strength: 0.5 });
});

test('OFFLINE RENDER: canny collapses to ~1-bit black-with-white-lines (L155)', () => {
  const plain = stats(frame(render({}, 'sk-plain'), 1.0));
  const canny = stats(frame(render({ sketch: { mode: 'canny', strength: 0.5 } }, 'sk-canny'), 1.0));
  // canny turns the colored source into mostly black ink with a few white edge px (1-bit line drawing).
  assert.ok(canny.blk > 0.7, `canny is mostly black ink: blk=${canny.blk.toFixed(2)}`);
  assert.ok(canny.blk > plain.blk + 0.2, `canny collapses the colored source to ink: plain.blk=${plain.blk.toFixed(2)} canny.blk=${canny.blk.toFixed(2)}`);
  assert.ok(canny.mid < 0.08, `canny is ~1-bit (few mid tones): mid=${canny.mid.toFixed(2)}`);
  assert.ok(canny.wht > 0.002, `canny draws white edge lines: wht=${canny.wht.toFixed(3)}`);
});

test('OFFLINE RENDER: colormix keeps mid tones but darkens edges vs plain (L155)', () => {
  const meanLuma = (out) => { const f = frame(out, 1.0); let s = 0, n = 0; for (let i = 0; i < f.length; i += 3) { s += f[i]; n++; } return s / n; };
  const plain = meanLuma(render({}, 'sk-cm-plain'));
  const cartoon = meanLuma(render({ sketch: { mode: 'colormix', strength: 0.7 } }, 'sk-cm-on'));
  const cartoonStats = stats(frame(render({ sketch: { mode: 'colormix', strength: 0.7 } }, 'sk-cm-on2'), 1.0));
  // colormix darkens (mixes black edge lines into the image) so mean brightness drops, but it is NOT 1-bit.
  assert.ok(cartoon < plain - 5, `colormix darkens the image with ink edges: plain=${plain.toFixed(1)} cartoon=${cartoon.toFixed(1)}`);
  assert.ok(cartoonStats.mid > 0.2, `colormix keeps mid tones (not 1-bit): mid=${cartoonStats.mid.toFixed(2)}`);
});
