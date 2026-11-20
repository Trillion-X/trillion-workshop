/**
 * #174 Pixelate: quantize the whole frame into blockSize-px square blocks (the retro 8-bit / mosaic look).
 * DATA pixelate: true | { blockSize: >=2 }. Renders via ffmpeg's dimension-preserving `pixelize=w=N:h=N`
 * (each NxN block collapses to one averaged color), so no scale-down/up dimension drift on the fixed canvas.
 * Distinct from #130 region censor (which pixelates a numeric RECT of the frame): this is a full-frame
 * stylistic quantization of the whole clip.
 *
 * Proof: DATA resolution (bare true => 12; nested {blockSize}; flat pixelate_block_size; clamp 2..256 + round),
 * materialize pass-through, AND a real OFFLINE render on a smooth horizontal luma gradient where, inside a
 * single block, the pixels FLATTEN to one value (the block average) while the SAME columns in the unfiltered
 * render still rise across the block (a base-vs-filtered + within-frame proof that the blocking actually
 * happened), and adjacent blocks differ (so it is not a global flat fill). L155.
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
let work, grad;
const W = 320;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// mean R over a small y band so a single-pixel x264 wobble cannot flip the result (y band stays inside one
// vertical block: blockSize 32, y 120 is in block [96,127], and 118..122 is well inside it).
function meanR(raw, x, y) {
  let r = 0, n = 0;
  for (let dy = -2; dy <= 2; dy++) { const i = ((y + dy) * W + x) * 3; if (i >= 0 && i < raw.length) { r += raw[i]; n++; } }
  return r / n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'pix-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'pix-render-'));
  grad = join(work, 'grad.mp4'); // exact horizontal black->white luma ramp (left dark, right bright)
  // Computed per pixel by `geq`, which has no random input. This was a `gradients` source, a
  // RANDOM-gradient generator whose pattern is unpinned between runs; the sibling split-tone suite
  // was intermittently red for exactly that reason. These assertions are relative (the base still
  // rises across the block), so they survived the varying source and hid the defect rather than
  // being immune to it. Pinned here too, so the comment above is a fact rather than an intention.
  // Slope is DOUBLE the frame width on purpose: geq clips at 255, so luma reaches white at the
  // half-way column and holds a flat white tail. That reproduces the property the scan below is
  // written against and documents ("ramps to white early... a hardcoded mid block lands in the flat
  // white tail"). A full-width ramp rises only 255/320 per column, so the 20-column probe span gains
  // 15.9 and never clears the test's >20 threshold: the scan finds no rising block and reports k=-1.
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=2:r=24',
    '-vf', "geq=lum='X*510/W':cb=128:cr=128", '-pix_fmt', 'yuv420p', grad]);
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

const render = (params, name) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => grad, { width: 320, height: 240, fps: 24, deterministic: true });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves pixelate: bare `true` => 12; nested {blockSize}; flat pixelate_block_size', () => {
  assert.deepEqual(clipTx(view([setTx({ pixelate: true })])).pixelate, { blockSize: 12 });
  assert.deepEqual(clipTx(view([setTx({ pixelate: { blockSize: 24 } })])).pixelate, { blockSize: 24 });
  assert.deepEqual(clipTx(view([setTx({ pixelate_block_size: 40 })])).pixelate, { blockSize: 40 });
});

test('resolves pixelate: blockSize clamps 2..256 and rounds; absent stays undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ pixelate: { blockSize: 1000 } })])).pixelate, { blockSize: 256 });
  assert.deepEqual(clipTx(view([setTx({ pixelate: { blockSize: 1 } })])).pixelate, { blockSize: 2 });
  assert.deepEqual(clipTx(view([setTx({ pixelate: { blockSize: 12.7 } })])).pixelate, { blockSize: 13 });
  assert.equal(clipTx(view([setTx({})])).pixelate, undefined);
});

test('materialize emits pixelate (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ pixelate: { blockSize: 24 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].pixelate, { blockSize: 24 });
});

test('OFFLINE RENDER: a block FLATTENS the gradient while the base still rises across it (L155)', () => {
  // Pixelate with blockSize N quantizes the frame into NxN squares. On a smooth L->R gradient, WITHIN one
  // block every column collapses to the block's single average, so two columns inside the SAME block become
  // (near-)equal; the UNFILTERED render still rises across those same columns. This `gradients` source ramps
  // to white early (well before the right edge), so we SCAN for a block that sits in the RISING region rather
  // than hardcoding an x (a hardcoded mid block lands in the flat white tail). Robust to codec wobble (meanR).
  const N = 32;
  // grab at ss=0.5 (steady-state, past any intro/fade frame) so the gradient is at full opacity every run;
  // grabbing at 0.0 intermittently caught a dimmed fade-in frame whose spread fell under the scan threshold.
  const px = frame(render({ pixelate: { blockSize: N } }, 'pix-32'), 0.5);
  const base = frame(render({}, 'pix-off'), 0.5);
  const y = 120;
  const aOf = (k) => k * N + 6;   // a column safely inside block k (away from the left seam)
  const bOf = (k) => k * N + 26;  // a second column inside block k (away from the right seam)

  // find the first block whose UNFILTERED gradient clearly rises across it (in the ramp, not the white tail).
  let k = -1;
  for (let j = 0; bOf(j) < W; j++) {
    if (Math.abs(meanR(base, aOf(j), y) - meanR(base, bOf(j), y)) > 20) { k = j; break; }
  }
  assert.ok(k >= 0, `found a rising block in the gradient ramp: k=${k}`);

  const baseSpread = Math.abs(meanR(base, aOf(k), y) - meanR(base, bOf(k), y)); // gradient rises across block k
  const pixSpread = Math.abs(meanR(px, aOf(k), y) - meanR(px, bOf(k), y));      // flattened to one value

  assert.ok(baseSpread > 20, `unfiltered gradient rises across block ${k}: spread=${baseSpread.toFixed(1)}`);
  assert.ok(pixSpread < 5, `pixelate flattens block ${k} to one value: spread=${pixSpread.toFixed(1)} (base ${baseSpread.toFixed(1)})`);

  // the neighbouring darker block k-1 (or k+1 at the ramp start) holds a DIFFERENT average => a real mosaic,
  // not a global flat fill.
  const kn = k > 0 ? k - 1 : k + 1;
  const thisBlock = meanR(px, aOf(k), y);
  const nbrBlock = meanR(px, aOf(kn), y);
  assert.ok(Math.abs(thisBlock - nbrBlock) > 15, `adjacent blocks differ (mosaic, not flat fill): ${thisBlock.toFixed(1)} vs ${nbrBlock.toFixed(1)}`);
});
