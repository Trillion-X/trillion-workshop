/**
 * #173 Solarize: partial per-channel tone inversion ABOVE a threshold (the darkroom / psychedelic
 * reflect-the-highlights look). DATA solarize: true | { threshold: 0..1 }. thr = round(threshold*255);
 * each output channel c maps to (c > thr ? 255 - c : c), so the shadows pass through unchanged while the
 * highlights fold back to dark. Distinct from #162 posterize (quantize the color count) and #172 gradient
 * map (remap luma to a color ramp): this is a per-channel reflection, not a quantization or a colorization.
 *
 * Proof: DATA resolution (bare true => 0.5; nested {threshold}; flat solarize_threshold; clamp 0..1),
 * materialize pass-through, AND a real OFFLINE render on a static black->white luma gradient where the
 * BRIGHT end (above the threshold) inverts to DARK while the DARK end (below the threshold) passes through
 * unchanged (a base-vs-filtered + within-frame proof that the highlight reflection actually happened). L155.
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
// mean R over a small column band so a single-pixel x264 wobble cannot flip the result.
function meanR(raw, x, y) {
  let r = 0, n = 0;
  for (let dy = -2; dy <= 2; dy++) { const i = ((y + dy) * W + x) * 3; if (i >= 0 && i < raw.length) { r += raw[i]; n++; } }
  return r / n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'sol-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'sol-render-'));
  grad = join(work, 'grad.mp4'); // static horizontal black->white luma gradient (left dark, right bright)
  // An EXACT ramp, the source convention the rest of this suite folder already uses. `gradients`
  // is a RANDOM-gradient generator and draws a different pattern per run, so a pixel assertion
  // against it passes or fails on the draw. Its sibling `posterize` was red in the corpus for
  // that reason while this one happened to keep drawing a usable gradient.
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=2:r=24',
    '-vf', "geq=lum='X*255/W':cb=128:cr=128", '-pix_fmt', 'yuv420p', grad]);
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
  const { edl } = materializeExportEdl(comp, () => grad, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves solarize: bare `true` => 0.5; nested {threshold}; flat solarize_threshold', () => {
  assert.deepEqual(clipTx(view([setTx({ solarize: true })])).solarize, { threshold: 0.5 });
  assert.deepEqual(clipTx(view([setTx({ solarize: { threshold: 0.3 } })])).solarize, { threshold: 0.3 });
  assert.deepEqual(clipTx(view([setTx({ solarize_threshold: 0.7 })])).solarize, { threshold: 0.7 });
});

test('resolves solarize: threshold clamps 0..1; absent stays undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ solarize: { threshold: 5 } })])).solarize, { threshold: 1 });
  assert.deepEqual(clipTx(view([setTx({ solarize: { threshold: -2 } })])).solarize, { threshold: 0 });
  assert.equal(clipTx(view([setTx({})])).solarize, undefined);
});

test('materialize emits solarize (verbatim, no camel hump to snake-case)', () => {
  const comp = composeTimeline(view([setTx({ solarize: { threshold: 0.5 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].solarize, { threshold: 0.5 });
});

test('OFFLINE RENDER: the threshold GATES the highlight inversion (L155)', () => {
  // Solarize is a threshold-gated per-channel reflection (a tent curve), NOT a global invert: a tone ABOVE
  // the threshold folds to 255-c, a tone BELOW it passes through. Prove that by holding a pixel fixed and
  // moving the threshold across it: threshold 0.5 (< a mid tone) reflects it, threshold 0.8 (> that mid tone)
  // leaves it. Robust to the source gradient geometry (we SCAN for a real mid-tone column, no hardcoded x).
  const lowThr = frame(render({ solarize: { threshold: 0.5 } }, 'sol-lo'), 0.0);  // thr 127.5
  const highThr = frame(render({ solarize: { threshold: 0.8 } }, 'sol-hi'), 0.0); // thr 204
  const pr = frame(render({}, 'sol-off'), 0.0);
  const y = 120;

  // a column whose UNFILTERED tone sits strictly between the two thresholds (127.5 < v < 204), and a white one.
  // 165..195 sits comfortably above thr 0.5 (127.5, so it reflects with a clear drop) and below thr 0.8
  // (204, so that threshold leaves it), avoiding the tent peak near 127.5 where the reflection is tiny.
  let xMid = -1, xWhite = -1;
  for (let x = 2; x < W; x++) { const v = meanR(pr, x, y); if (xMid < 0 && v > 165 && v < 195) xMid = x; if (xWhite < 0 && v > 230) xWhite = x; }
  assert.ok(xMid > 0, `found a mid-tone column between the thresholds: x=${xMid}`);
  assert.ok(xWhite > 0, `found a white highlight column: x=${xWhite}`);

  const pMid = meanR(pr, xMid, y);
  const loMid = meanR(lowThr, xMid, y);   // thr 127.5 < the mid tone => reflected (much darker)
  const hiMid = meanR(highThr, xMid, y);  // thr 204 > the mid tone => unchanged
  const loWhite = meanR(lowThr, xWhite, y);
  const pWhite = meanR(pr, xWhite, y);

  assert.ok(loMid < pMid - 60, `low threshold reflects the mid tone to dark: ${loMid.toFixed(1)} vs plain ${pMid.toFixed(1)}`);
  assert.ok(Math.abs(hiMid - pMid) < 30, `high threshold leaves the same mid tone unchanged: ${hiMid.toFixed(1)} vs plain ${pMid.toFixed(1)}`);
  assert.ok(pWhite > 200 && loWhite < 40, `the white highlight reflects to near-black: ${loWhite.toFixed(1)} (plain ${pWhite.toFixed(1)})`);
});
