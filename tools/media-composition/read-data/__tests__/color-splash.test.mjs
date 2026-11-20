/**
 * #180 Color splash (selective color): keep ONE hue and turn everything else gray (the classic "color pop").
 * DATA colorSplash: true | { color, similarity }. Renders via ffmpeg `colorhold` (the DATA color is sanitized
 * through colorToRgb255 into a numeric 0xRRGGBB hex, so no raw string reaches ffmpeg). Distinct from every
 * grade/blur/warp - it is a color-KEY, not a recolor. The camelCase field materializes to snake `color_splash`.
 *
 * Proof: DATA resolution (bare true => keep red/0.3; nested {color, similarity}; clamp similarity; absent
 * undefined), materialize pass-through (asserting the SNAKE key), AND a real OFFLINE render on a red|blue
 * split where keeping red leaves the red half SATURATED while the blue half collapses to GRAY (a
 * per-region saturation proof), PLUS a byte-identical determinism proof. L155.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { blake3 } from '@noble/hashes/blake3.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
let composeTimeline, materializeExportEdl;
let work, split;
const W = 320, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const digestHex = (file) => Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// mean saturation (max(rgb)-min(rgb)) over a region; ~0 = gray, high = a vivid color.
function meanSat(raw, x0, y0, w, h) {
  let s = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * W + x) * 3; if (i + 2 < raw.length) { const r = raw[i], g = raw[i + 1], b = raw[i + 2]; s += Math.max(r, g, b) - Math.min(r, g, b); n++; }
  }
  return s / n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'splash-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'splash-render-'));
  split = join(work, 'split.mp4'); // left half vivid red, right half vivid blue
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=r='if(lt(X,160),220,20)':g='20':b='if(lt(X,160),20,220)'", '-pix_fmt', 'yuv420p', split]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-10T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name, deterministic) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => split, { width: 320, height: 240, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves colorSplash: bare `true` => keep red at 0.3; nested {color, similarity}', () => {
  assert.deepEqual(clipTx(view([setTx({ colorSplash: true })])).colorSplash, { color: 'red', similarity: 0.3 });
  assert.deepEqual(clipTx(view([setTx({ colorSplash: { color: 'blue', similarity: 0.5 } })])).colorSplash, { color: 'blue', similarity: 0.5 });
});

test('resolves colorSplash: similarity clamps 0.01..1; missing color stays undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ colorSplash: { color: 'green', similarity: 4 } })])).colorSplash, { color: 'green', similarity: 1 });
  assert.deepEqual(clipTx(view([setTx({ colorSplash: { color: 'green', similarity: 0 } })])).colorSplash, { color: 'green', similarity: 0.01 });
  assert.equal(clipTx(view([setTx({ colorSplash: { similarity: 0.5 } })])).colorSplash, undefined); // no color => not enabled
  assert.equal(clipTx(view([setTx({})])).colorSplash, undefined);
});

test('materialize emits color_splash (camelCase field -> SNAKE key, nested value verbatim)', () => {
  const comp = composeTimeline(view([setTx({ colorSplash: { color: 'red', similarity: 0.3 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].color_splash, { color: 'red', similarity: 0.3 });
  assert.equal(edl.spine.segments[0].colorSplash, undefined); // NOT the camel key
});

test('OFFLINE RENDER: keeping red leaves the red half vivid while the blue half goes gray (L155)', () => {
  // On a red|blue split, keeping red must leave the red half SATURATED and collapse the blue half to GRAY
  // (saturation ~0). The base frame has both halves vivid. A per-region saturation proof.
  const y0 = 100, h = 40;
  const base = frame(render({}, 'splash-off', true), 0.5);
  const held = frame(render({ colorSplash: { color: 'red', similarity: 0.3 } }, 'splash-red', true), 0.5);

  const baseRed = meanSat(base, 60, y0, 40, h);   // left (red)
  const baseBlue = meanSat(base, 220, y0, 40, h);  // right (blue)
  const heldRed = meanSat(held, 60, y0, 40, h);
  const heldBlue = meanSat(held, 220, y0, 40, h);

  assert.ok(baseRed > 120 && baseBlue > 120, `base has both halves vivid: red=${baseRed.toFixed(1)} blue=${baseBlue.toFixed(1)}`);
  assert.ok(heldRed > 120, `the kept red half stays vivid: ${heldRed.toFixed(1)}`);
  assert.ok(heldBlue < 40, `the non-kept blue half collapses to gray: ${heldBlue.toFixed(1)} (base ${baseBlue.toFixed(1)})`);

  const a = render({ colorSplash: { color: 'red', similarity: 0.3 } }, 'splash-det-a', true);
  const b = render({ colorSplash: { color: 'red', similarity: 0.3 } }, 'splash-det-b', true);
  assert.equal(digestHex(a), digestHex(b), 'two deterministic color-splash renders of the same EDL are byte-identical');
});
