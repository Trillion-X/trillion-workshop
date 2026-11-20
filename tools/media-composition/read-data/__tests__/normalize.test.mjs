/**
 * #196 Auto white-balance (normalize): independently stretch each RGB channel's range to full, which fixes a
 * color cast AND maximizes contrast, via ffmpeg's native `normalize` filter at independence 1. DATA normalize:
 * true | { strength: 0..1 }. bare true seeds 1.0. Distinct from #193 auto-contrast (histeq, a luma-only
 * histogram equalization that CANNOT correct a color cast): normalize's per-channel independence is what
 * neutralizes the cast.
 *
 * Proof: DATA resolution (bare true seeds 1.0; nested {strength}; flat normalize_strength; clamp 0..1;
 * strength 0 dropped; absent undefined), materialize pass-through, AND a real OFFLINE render whose oracle is
 * WHITE-BALANCE + RANGE: a BLUE-cast, low-contrast source (R bunched low, B bunched high) has each channel
 * stretched to full range, so the per-channel span grows AND the big B-minus-R cast gap collapses toward
 * neutral. PLUS a byte-identical determinism proof. L155.
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
let work, cast;
const W = 320, H = 240, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function rgbFrame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// [min,max,value-at-center-x] of one channel (offset 0=R,2=B) along the middle row.
function chan(raw, off) {
  const y = 120; let mn = 255, mx = 0;
  for (let x = 0; x < W; x += 3) { const v = raw[(y * W + x) * 3 + off]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const center = raw[(y * W + 160) * 3 + off];
  return { mn, mx, span: mx - mn, center };
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'nrm-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'nrm-render-'));
  cast = join(work, 'cast.mp4'); // a BLUE-cast, low-contrast source: R low+narrow, B high+narrow.
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=r='60+0.09*X':g='100+0.06*X':b='150+0.12*X'", '-pix_fmt', 'yuv420p', cast]);
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
  const { edl } = materializeExportEdl(comp, () => cast, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves normalize: bare `true` seeds 1.0; nested {strength}; flat normalize_strength', () => {
  assert.deepEqual(clipTx(view([setTx({ normalize: true })])).normalize, { strength: 1 });
  assert.deepEqual(clipTx(view([setTx({ normalize: { strength: 0.7 } })])).normalize, { strength: 0.7 });
  assert.deepEqual(clipTx(view([setTx({ normalize_strength: 0.4 })])).normalize, { strength: 0.4 });
});

test('resolves normalize: clamps 0..1; strength 0 dropped; absent undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ normalize: { strength: 9 } })])).normalize, { strength: 1 });
  assert.equal(clipTx(view([setTx({ normalize: { strength: 0 } })])).normalize, undefined);
  assert.equal(clipTx(view([setTx({ normalize: { strength: -1 } })])).normalize, undefined);
  assert.equal(clipTx(view([setTx({})])).normalize, undefined);
});

test('materialize emits normalize (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ normalize: { strength: 0.7 } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].normalize, { strength: 0.7 });
});

test('OFFLINE RENDER: auto white-balance stretches each channel and neutralizes the blue cast (L155)', () => {
  const base = rgbFrame(render({}, 'nrm-off', true), 0.5);
  const norm = rgbFrame(render({ normalize: { strength: 1 } }, 'nrm-on', true), 0.5);

  const bR = chan(base, 0), bB = chan(base, 2);
  const nR = chan(norm, 0), nB = chan(norm, 2);

  // base: narrow per-channel spans, big blue cast (B way above R at the center).
  assert.ok(bR.span < 60 && bB.span < 70, `base channels are low-contrast: Rspan ${bR.span} Bspan ${bB.span}`);
  assert.ok(bB.center - bR.center > 70, `base has a strong blue cast (B >> R): R${bR.center} B${bB.center}`);

  // normalize: each channel stretched wide, and the cast gap at the center collapses toward neutral.
  assert.ok(nR.span > bR.span + 80 && nB.span > bB.span + 80, `normalize expands each channel range: Rspan ${nR.span} Bspan ${nB.span}`);
  assert.ok(Math.abs(nB.center - nR.center) < 40, `the blue cast is neutralized (R and B close again): R${nR.center} B${nB.center}`);

  const a = render({ normalize: { strength: 1 } }, 'nrm-det-a', true);
  const b = render({ normalize: { strength: 1 } }, 'nrm-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic normalize renders of the same EDL are byte-identical');
});
