/**
 * #184 Binarize: pure 1-bit black/white at a luma cutoff via a luma LUT (the notan / silkscreen stamp look).
 * DATA binarize: true | { cutoff: 0..1 }. Distinct from #175 posterize (quantizes to N COLOR levels, keeps
 * hue) and #173 solarize (inverts above a cutoff, keeps gradients): binarize collapses to exactly TWO luma
 * values (0 and 255) with chroma neutralized.
 *
 * Proof: DATA resolution (bare true => 0.5; nested {cutoff}; flat binarize_cutoff; clamp 0..1), materialize
 * pass-through, AND a real OFFLINE render whose oracle is the binarize signature on a horizontal luma RAMP
 * (0 on the left, 255 on the right): the output is BIMODAL (every pixel is near-0 or near-255, nothing in
 * between), and the black/white split column moves with the cutoff (cutoff 0.25 splits near x=W/4, cutoff
 * 0.75 near x=3W/4). Convention-agnostic, PLUS a byte-identical determinism proof. L155.
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
let work, ramp;
const W = 320, H = 240, FPS = 24;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const digestHex = (file) => Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function frameRow(file, ss, y) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  const row = [];
  for (let x = 0; x < W; x++) row.push(raw[(y * W + x) * 3]);
  return row;
}
// index of the first column that crosses into "white" (>128), scanning left to right.
const splitCol = (row) => { for (let x = 0; x < row.length; x++) if (row[x] > 128) return x; return row.length; };
const midtoneCount = (row) => row.filter((v) => v > 40 && v < 215).length;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'bin-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'bin-render-'));
  ramp = join(work, 'ramp.mp4'); // a horizontal luma ramp: 0 at the left edge, 255 at the right edge.
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', `geq=r='255*X/${W - 1}':g='255*X/${W - 1}':b='255*X/${W - 1}'`, '-pix_fmt', 'yuv420p', ramp]);
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
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => ramp, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves binarize: bare `true` => 0.5; nested {cutoff}; flat binarize_cutoff', () => {
  assert.deepEqual(clipTx(view([setTx({ binarize: true })])).binarize, { cutoff: 0.5 });
  assert.deepEqual(clipTx(view([setTx({ binarize: { cutoff: 0.75 } })])).binarize, { cutoff: 0.75 });
  assert.deepEqual(clipTx(view([setTx({ binarize_cutoff: 0.25 })])).binarize, { cutoff: 0.25 });
});

test('resolves binarize: cutoff clamps 0..1; absent stays undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ binarize: { cutoff: 3 } })])).binarize, { cutoff: 1 });
  assert.deepEqual(clipTx(view([setTx({ binarize: { cutoff: -1 } })])).binarize, { cutoff: 0 });
  assert.equal(clipTx(view([setTx({})])).binarize, undefined);
});

test('materialize emits binarize (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ binarize: { cutoff: 0.75 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].binarize, { cutoff: 0.75 });
});

test('OFFLINE RENDER: binarize collapses the ramp to two luma values and the split follows the cutoff (L155)', () => {
  const y = Math.floor(H / 2);
  const baseMid = midtoneCount(frameRow(render(null, 'bin-off', true), 0.5, y));
  const q = frameRow(render({ binarize: { cutoff: 0.25 } }, 'bin-q', true), 0.5, y);
  const t = frameRow(render({ binarize: { cutoff: 0.75 } }, 'bin-t', true), 0.5, y);

  // the plain ramp is ALL midtones; binarize leaves almost none (bimodal to 0 and 255).
  assert.ok(baseMid > W * 0.6, `the plain ramp is full of midtones: ${baseMid}px`);
  assert.ok(midtoneCount(q) < W * 0.1, `binarize removes the midtones (bimodal): ${midtoneCount(q)}px`);

  // the split column tracks the cutoff: 0.25 splits near x=W/4, 0.75 near x=3W/4.
  const sq = splitCol(q), st = splitCol(t);
  assert.ok(Math.abs(sq - W * 0.25) < W * 0.08, `cutoff 0.25 splits near x=${Math.round(W * 0.25)}: got ${sq}`);
  assert.ok(Math.abs(st - W * 0.75) < W * 0.08, `cutoff 0.75 splits near x=${Math.round(W * 0.75)}: got ${st}`);
  assert.ok(st > sq, `a higher cutoff pushes the split rightward: ${st} > ${sq}`);

  const a = render({ binarize: { cutoff: 0.5 } }, 'bin-det-a', true);
  const b = render({ binarize: { cutoff: 0.5 } }, 'bin-det-b', true);
  assert.equal(digestHex(a), digestHex(b), 'two deterministic binarize renders of the same EDL are byte-identical');
});
