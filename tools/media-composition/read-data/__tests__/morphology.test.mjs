/**
 * #194 Morphology (dilate / erode): a max/min neighbourhood filter that GROWS bright regions ('dilate', the
 * spread / chunky-bloom look) or SHRINKS them ('erode', the thin / etched look), via ffmpeg's native
 * `dilation` / `erosion`. DATA morphology: true | { mode: 'dilate' | 'erode', amount: 1..4 }. bare true seeds
 * { mode dilate, amount 2 }. Distinct from a smooth blur (this is a hard max/min, not an average).
 *
 * Proof: DATA resolution (bare true seeds {dilate,2}; nested {mode,amount}; flat morphology_mode/_amount;
 * clamp amount 1..4; unknown mode => dilate), materialize pass-through, AND a real OFFLINE render whose oracle
 * is a BRIGHT-AREA count change: a thin bright bar GROWS wider under dilate (more bright px) and SHRINKS under
 * erode (fewer bright px). PLUS a byte-identical determinism proof. L155.
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
function grayFrame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// count bright pixels on the middle row.
function brightOnRow(raw, y) { let n = 0; for (let x = 0; x < W; x++) if (raw[y * W + x] > 120) n++; return n; }

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'mrp-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'mrp-render-'));
  bar = join(work, 'bar.mp4'); // a thin bright bar (x=157..163) on dark, so grow/shrink is clearly measurable.
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=r='if(between(X,157,163),240,15)':g='if(between(X,157,163),240,15)':b='if(between(X,157,163),240,15)'", '-pix_fmt', 'yuv420p', bar]);
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

test('resolves morphology: bare `true` seeds {dilate,2}; nested {mode,amount}; flat morphology_mode/_amount', () => {
  assert.deepEqual(clipTx(view([setTx({ morphology: true })])).morphology, { mode: 'dilate', amount: 2 });
  assert.deepEqual(clipTx(view([setTx({ morphology: { mode: 'erode', amount: 3 } })])).morphology, { mode: 'erode', amount: 3 });
  assert.deepEqual(clipTx(view([setTx({ morphology_mode: 'erode', morphology_amount: 1 })])).morphology, { mode: 'erode', amount: 1 });
});

test('resolves morphology: clamps amount 1..4; unknown mode => dilate; absent undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ morphology: { mode: 'dilate', amount: 9 } })])).morphology, { mode: 'dilate', amount: 4 });
  assert.deepEqual(clipTx(view([setTx({ morphology: { mode: 'zzz' } })])).morphology, { mode: 'dilate', amount: 2 });
  assert.equal(clipTx(view([setTx({})])).morphology, undefined);
});

test('materialize emits morphology (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ morphology: { mode: 'erode', amount: 3 } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].morphology, { mode: 'erode', amount: 3 });
});

test('OFFLINE RENDER: dilate grows the bright bar, erode shrinks it (L155)', () => {
  const y = Math.floor(H / 2);
  const base = brightOnRow(grayFrame(render({}, 'mrp-off', true), 0.5), y);
  const dil = brightOnRow(grayFrame(render({ morphology: { mode: 'dilate', amount: 2 } }, 'mrp-dil', true), 0.5), y);
  const ero = brightOnRow(grayFrame(render({ morphology: { mode: 'erode', amount: 2 } }, 'mrp-ero', true), 0.5), y);

  assert.ok(base >= 5 && base <= 12, `the base bar is a thin ~7px band: ${base}px`);
  assert.ok(dil > base + 2, `dilate grows the bright bar wider: ${dil}px vs ${base}px`);
  assert.ok(ero < base - 2, `erode shrinks the bright bar: ${ero}px vs ${base}px`);

  const a = render({ morphology: { mode: 'dilate', amount: 2 } }, 'mrp-det-a', true);
  const b = render({ morphology: { mode: 'dilate', amount: 2 } }, 'mrp-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic morphology renders of the same EDL are byte-identical');
});
