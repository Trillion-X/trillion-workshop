/**
 * #197 Chroma bleed (VHS color smear): blur ONLY the chroma planes while leaving luma sharp, via ffmpeg's
 * native `boxblur` at luma_radius=0 + chroma_radius=r. Color smears sideways past hard edges (the wrong hue
 * bleeds across a sharp seam) while brightness detail stays crisp, the classic VHS/anime color-bleed look.
 * DATA chromaBleed: true | { radius: 1..40 }. bare true seeds 15. Distinct from every other blur (#177
 * defocus / gblur, #155 motion_blur, etc.) which soften LUMA too; chroma bleed keeps luma untouched.
 *
 * Proof: DATA resolution (bare true seeds 15; nested {radius}; flat chroma_bleed_radius / chromaBleedRadius;
 * clamp 1..40 round; radius<1 dropped; absent undefined), materialize pass-through as `chroma_bleed`, AND a
 * real OFFLINE render whose oracle is CHROMA-SIDEWAYS-SPREAD: a sharp red|green vertical seam has the wrong
 * channel bleed across on each side (G rises inside the red region, R rises inside the green region) while
 * the far-from-seam luma stays crisp. PLUS a byte-identical determinism proof. L155.
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
let work, seam;
const W = 320, H = 240, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const digestHex = (file) => Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
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
  const dir = tempFolder(join(tmpdir(), 'cbl-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'cbl-render-'));
  seam = join(work, 'seam.mp4'); // sharp vertical seam: left half pure red, right half pure green, at x=160.
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`,
    '-vf', "geq=r='if(lt(X,160),240,20)':g='if(lt(X,160),20,240)':b='20'", '-pix_fmt', 'yuv420p', seam]);
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
  const { edl } = materializeExportEdl(comp, () => seam, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves chromaBleed: bare `true` seeds 15; nested {radius}; flat chroma_bleed_radius / chromaBleedRadius', () => {
  assert.deepEqual(clipTx(view([setTx({ chromaBleed: true })])).chromaBleed, { radius: 15 });
  assert.deepEqual(clipTx(view([setTx({ chromaBleed: { radius: 22 } })])).chromaBleed, { radius: 22 });
  assert.deepEqual(clipTx(view([setTx({ chroma_bleed_radius: 8 })])).chromaBleed, { radius: 8 });
  assert.deepEqual(clipTx(view([setTx({ chromaBleedRadius: 30 })])).chromaBleed, { radius: 30 });
});

test('resolves chromaBleed: clamps 1..40 with rounding; radius<1 dropped; absent undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ chromaBleed: { radius: 99 } })])).chromaBleed, { radius: 40 });
  assert.deepEqual(clipTx(view([setTx({ chromaBleed: { radius: 12.6 } })])).chromaBleed, { radius: 13 });
  assert.equal(clipTx(view([setTx({ chromaBleed: { radius: 0 } })])).chromaBleed, undefined);
  assert.equal(clipTx(view([setTx({ chromaBleed: { radius: -5 } })])).chromaBleed, undefined);
  assert.equal(clipTx(view([setTx({})])).chromaBleed, undefined);
});

test('materialize emits chroma_bleed (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ chromaBleed: { radius: 22 } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].chroma_bleed, { radius: 22 });
});

test('OFFLINE RENDER: chroma bleeds sideways across the seam while luma stays sharp (L155)', () => {
  const base = rgbFrame(render({}, 'cbl-off', true), 0.5);
  const bled = rgbFrame(render({ chromaBleed: { radius: 20 } }, 'cbl-on', true), 0.5);

  // base: pure red just left of the seam, pure green just right of it.
  const [, bLg] = px(base, 150); // G inside the red region
  const [bRr] = px(base, 170);   // R inside the green region
  assert.ok(bLg < 40, `base red region has almost no green: G${bLg}`);
  assert.ok(bRr < 40, `base green region has almost no red: R${bRr}`);

  // chroma bleed: the WRONG channel smears across the seam on each side (green into red, red into green).
  const [, nLg] = px(bled, 150);
  const [nRr] = px(bled, 170);
  assert.ok(nLg > bLg + 30, `green bleeds into the red region past the seam: base G${bLg} -> bled G${nLg}`);
  assert.ok(nRr > bRr + 30, `red bleeds into the green region past the seam: base R${bRr} -> bled R${nRr}`);

  // luma stays sharp: far from the seam, brightness is untouched (a bright pixel stays bright).
  const [fr, fg, fb] = px(bled, 30);
  const lumaFar = 0.299 * fr + 0.587 * fg + 0.114 * fb;
  const [br0, bg0, bb0] = px(base, 30);
  const lumaBase = 0.299 * br0 + 0.587 * bg0 + 0.114 * bb0;
  assert.ok(Math.abs(lumaFar - lumaBase) < 12, `far-from-seam luma is preserved: base ${lumaBase.toFixed(1)} bled ${lumaFar.toFixed(1)}`);

  const a = render({ chromaBleed: { radius: 20 } }, 'cbl-det-a', true);
  const b = render({ chromaBleed: { radius: 20 } }, 'cbl-det-b', true);
  assert.equal(digestHex(a), digestHex(b), 'two deterministic chroma-bleed renders of the same EDL are byte-identical');
});
