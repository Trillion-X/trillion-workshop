/**
 * #198 RGB split (chromatic glitch): offset the red plane left and the blue plane right by `amount` px via
 * ffmpeg's native `rgbashift`, so the image ghosts into a red-left / blue-right double edge (the datamosh /
 * anaglyph / lo-fi glitch look). DATA rgbSplit: true | { amount: 1..30 }. bare true seeds 6. Distinct from
 * #197 chromaBleed (a chroma BLUR with no offset, a soft smear) and from lens_fringe (RADIAL edge-only
 * fringing): this is a UNIFORM linear channel translation. The named one-click toggle over a clamped DATA
 * amount, NOT the opaque fixed-strength `rgbashift` grade preset.
 *
 * Proof: DATA resolution (bare true seeds 6; nested {amount}; flat rgb_split_amount / rgbSplitAmount; clamp
 * 1..30 round; amount<1 dropped; absent undefined), materialize pass-through as `rgb_split`, AND a real
 * OFFLINE render whose oracle is CHANNEL-TRANSLATION: a white vertical bar on black gets a red fringe on the
 * left of the bar (R shifted left, so red pokes out where the picture is still black) and a blue fringe on
 * the right, while the base bar has neither. PLUS a byte-identical determinism proof. L155.
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
let work, bar;
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
  const dir = tempFolder(join(tmpdir(), 'rsp-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'rsp-render-'));
  bar = join(work, 'bar.mp4'); // white vertical bar (x 150..170) on a black field.
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`,
    '-vf', 'drawbox=x=150:y=0:w=20:h=240:color=white:t=fill', '-pix_fmt', 'yuv420p', bar]);
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
  const { edl } = materializeExportEdl(comp, () => bar, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves rgbSplit: bare `true` seeds 6; nested {amount}; flat rgb_split_amount / rgbSplitAmount', () => {
  assert.deepEqual(clipTx(view([setTx({ rgbSplit: true })])).rgbSplit, { amount: 6 });
  assert.deepEqual(clipTx(view([setTx({ rgbSplit: { amount: 14 } })])).rgbSplit, { amount: 14 });
  assert.deepEqual(clipTx(view([setTx({ rgb_split_amount: 3 })])).rgbSplit, { amount: 3 });
  assert.deepEqual(clipTx(view([setTx({ rgbSplitAmount: 22 })])).rgbSplit, { amount: 22 });
});

test('resolves rgbSplit: clamps 1..30 with rounding; amount<1 dropped; absent undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ rgbSplit: { amount: 99 } })])).rgbSplit, { amount: 30 });
  assert.deepEqual(clipTx(view([setTx({ rgbSplit: { amount: 8.6 } })])).rgbSplit, { amount: 9 });
  assert.equal(clipTx(view([setTx({ rgbSplit: { amount: 0 } })])).rgbSplit, undefined);
  assert.equal(clipTx(view([setTx({ rgbSplit: { amount: -4 } })])).rgbSplit, undefined);
  assert.equal(clipTx(view([setTx({})])).rgbSplit, undefined);
});

test('materialize emits rgb_split (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ rgbSplit: { amount: 14 } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].rgb_split, { amount: 14 });
});

test('OFFLINE RENDER: red fringes left of the bar and blue fringes right of it (L155)', () => {
  const A = 12;
  const base = rgbFrame(render({}, 'rsp-off', true), 0.5);
  const split = rgbFrame(render({ rgbSplit: { amount: A } }, 'rsp-on', true), 0.5);

  // base: just left of the bar (x=145) and just right of it (x=175) is pure black.
  const [bLr, bLg, bLb] = px(base, 145);
  const [bRr, bRg, bRb] = px(base, 175);
  assert.ok(bLr < 20 && bLg < 20 && bLb < 20, `base left of bar is black: ${bLr},${bLg},${bLb}`);
  assert.ok(bRr < 20 && bRg < 20 && bRb < 20, `base right of bar is black: ${bRr},${bRg},${bRb}`);

  // rgbSplit rh=-A: the red plane moves LEFT, so red pokes out into the black just left of the bar
  // (red high, blue/green still low there). bh=+A: the blue plane moves RIGHT, so blue pokes out just
  // right of the bar (blue high, red/green still low there).
  const [nLr, nLg, nLb] = px(split, 145);
  const [nRr, nRg, nRb] = px(split, 175);
  assert.ok(nLr > 200 && nLb < 80, `red fringe appears left of the bar: R${nLr} B${nLb}`);
  assert.ok(nRb > 200 && nRr < 80, `blue fringe appears right of the bar: R${nRr} B${nRb}`);

  const a = render({ rgbSplit: { amount: A } }, 'rsp-det-a', true);
  const b = render({ rgbSplit: { amount: A } }, 'rsp-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic rgb-split renders of the same EDL are byte-identical');
});
