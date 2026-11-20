/**
 * #199 Mono mix (B&W color-filter): collapse the frame to monochrome using per-channel weights r,g,b via
 * ffmpeg's native `colorchannelmixer`, where EVERY output channel is the same weighted sum r*R + g*G + b*B.
 * This is the darkroom color-filter-for-B&W trick: a red-weighted mix brightens reds and darkens blue sky.
 * DATA monoMix: true | { r, g, b } weights. bare true seeds the red filter {0.7, 0.2, 0.1}. THE GENERATIVE
 * monochrome primitive (L069): equal weights = plain grayscale, r-heavy = red filter, etc. Distinct from #195
 * colorize (a single-hue WASH that keeps luma IN COLOR) and #190 channelSwap (permutes channels, stays color).
 *
 * Proof: DATA resolution (bare true = red filter; nested {r,g,b}; flat mono_mix_r/g/b; clamp each 0..2 round3;
 * all-zero sum dropped; absent undefined), materialize pass-through as `mono_mix`, AND a real OFFLINE render
 * whose oracle is WEIGHTED-MONO DIVERGENCE: a source with a red patch and a blue patch of EQUAL grayscale
 * brightness renders both as the SAME gray under equal weights, but the red patch goes BRIGHT and the blue
 * patch goes DARK under the red filter, and every output pixel is monochrome (R=G=B). PLUS a byte-identical
 * determinism proof. L155.
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
let work, patches;
const W = 320, H = 240, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function rgbFrame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// [R,G,B] at (x, middle row).
function px(raw, x) {
  const i = (120 * W + x) * 3;
  return [raw[i], raw[i + 1], raw[i + 2]];
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'mmx-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'mmx-render-'));
  // left half a saturated red (240,20,20), right half a saturated blue (20,20,240): under equal-weight gray
  // both are (280/3)~93; under a red filter red goes bright and blue goes dark.
  patches = join(work, 'patches.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`,
    '-vf', "geq=r='if(lt(X,160),240,20)':g='20':b='if(lt(X,160),20,240)'", '-pix_fmt', 'yuv420p', patches]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'b.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-10T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name, deterministic) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => patches, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves monoMix: bare `true` = red filter {0.7,0.2,0.1}; nested {r,g,b}; flat mono_mix_r/g/b', () => {
  assert.deepEqual(clipTx(view([setTx({ monoMix: true })])).monoMix, { r: 0.7, g: 0.2, b: 0.1 });
  assert.deepEqual(clipTx(view([setTx({ monoMix: { r: 0.2, g: 0.6, b: 0.2 } })])).monoMix, { r: 0.2, g: 0.6, b: 0.2 });
  assert.deepEqual(clipTx(view([setTx({ mono_mix_r: 0.5, mono_mix_g: 0.3, mono_mix_b: 0.2 })])).monoMix, { r: 0.5, g: 0.3, b: 0.2 });
});

test('resolves monoMix: clamps each weight 0..2 round3; missing components => 0; all-zero dropped; absent undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ monoMix: { r: 9, g: -1, b: 0.1234 } })])).monoMix, { r: 2, g: 0, b: 0.123 });
  assert.deepEqual(clipTx(view([setTx({ monoMix: { r: 1 } })])).monoMix, { r: 1, g: 0, b: 0 });
  assert.equal(clipTx(view([setTx({ monoMix: { r: 0, g: 0, b: 0 } })])).monoMix, undefined);
  assert.equal(clipTx(view([setTx({})])).monoMix, undefined);
});

test('materialize emits mono_mix (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ monoMix: { r: 0.2, g: 0.6, b: 0.2 } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].mono_mix, { r: 0.2, g: 0.6, b: 0.2 });
});

test('OFFLINE RENDER: red filter brightens red / darkens blue, equal weights keep them equal, output is mono (L155)', () => {
  const redFilter = rgbFrame(render({ monoMix: { r: 0.7, g: 0.2, b: 0.1 } }, 'mmx-red', true), 0.5);
  const equal = rgbFrame(render({ monoMix: { r: 0.334, g: 0.333, b: 0.333 } }, 'mmx-eq', true), 0.5);

  const [rLr, rLg, rLb] = px(redFilter, 60);   // red patch under red filter
  const [rRr, rRg, rRb] = px(redFilter, 260);  // blue patch under red filter
  const [eLr] = px(equal, 60);                  // red patch under equal weights
  const [eRr] = px(equal, 260);                 // blue patch under equal weights

  // output is monochrome: every rendered pixel has R=G=B.
  assert.ok(rLr === rLg && rLg === rLb, `red-filter red patch is mono: ${rLr},${rLg},${rLb}`);
  assert.ok(rRr === rRg && rRg === rRb, `red-filter blue patch is mono: ${rRr},${rRg},${rRb}`);

  // red filter: red patch bright, blue patch dark, a wide divergence.
  assert.ok(rLr > 150, `red filter makes the red patch bright gray: ${rLr}`);
  assert.ok(rRr < 70, `red filter makes the blue patch dark gray: ${rRr}`);
  assert.ok(rLr - rRr > 90, `red filter diverges the two patches: red ${rLr} vs blue ${rRr}`);

  // equal weights: the two equal-luma patches stay close together (no color-filter divergence).
  assert.ok(Math.abs(eLr - eRr) < 20, `equal weights keep the two patches near-equal gray: ${eLr} vs ${eRr}`);

  const a = render({ monoMix: { r: 0.7, g: 0.2, b: 0.1 } }, 'mmx-det-a', true);
  const b = render({ monoMix: { r: 0.7, g: 0.2, b: 0.1 } }, 'mmx-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic mono-mix renders of the same EDL are byte-identical');
});
