/**
 * #183 Directional blur: a single-axis motion streak via ffmpeg `avgblur` (separable box average). DATA
 * directionalBlur: true | { amount: 0..1, axis: 'h' | 'v' }. `axis` picks which axis gets the blur radius,
 * the other axis stays 1. This ADDS a capability the set lacked: an ANISOTROPIC blur, distinct from #177
 * defocus (symmetric gblur that blurs both axes equally), from #zoom-blur (radial) and motion-blur (temporal).
 *
 * Proof: DATA resolution (bare true => {0.6,'h'}; nested {amount,axis}; flat directional_blur_amount/axis;
 * clamp 0..1; axis defaults 'h'), materialize pass-through (camelCase field snake-cased to directional_blur),
 * AND a real OFFLINE render whose oracle is ANISOTROPY on a crisp VERTICAL edge: an 'h' streak WIDENS the
 * edge (it blurs across X), while a 'v' streak of the same amount does NOT widen it (it blurs along Y, and a
 * vertical edge has no Y variation). That axis-dependence is the directional signature a symmetric blur can
 * never show. PLUS a byte-identical determinism proof. L155.
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
let work, edge;
const W = 320, H = 240, FPS = 24;
const DARK = 40, BRIGHT = 210, TOL = 10;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// width of the transition band on the middle row: count columns whose red is strictly between the two levels.
function hTransitionWidth(raw) {
  const y = Math.floor(H / 2); let n = 0;
  for (let x = 0; x < W; x++) { const v = raw[(y * W + x) * 3]; if (v > DARK + TOL && v < BRIGHT - TOL) n++; }
  return n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'dirb-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'dirb-render-'));
  edge = join(work, 'edge.mp4'); // a crisp VERTICAL edge: DARK left of center, BRIGHT right of center.
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', `geq=r='if(lt(X,160),${DARK},${BRIGHT})':g='if(lt(X,160),${DARK},${BRIGHT})':b='if(lt(X,160),${DARK},${BRIGHT})'`, '-pix_fmt', 'yuv420p', edge]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'e.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-10T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name, deterministic) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => edge, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves directionalBlur: bare `true` => {0.6, h}; nested {amount, axis}; flat params', () => {
  assert.deepEqual(clipTx(view([setTx({ directionalBlur: true })])).directionalBlur, { amount: 0.6, axis: 'h' });
  assert.deepEqual(clipTx(view([setTx({ directionalBlur: { amount: 0.9, axis: 'v' } })])).directionalBlur, { amount: 0.9, axis: 'v' });
  assert.deepEqual(clipTx(view([setTx({ directional_blur_amount: 0.4, directional_blur_axis: 'v' })])).directionalBlur, { amount: 0.4, axis: 'v' });
});

test('resolves directionalBlur: amount clamps to 1; unknown axis falls back to h; 0 and absent stay undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ directionalBlur: { amount: 5, axis: 'diagonal' } })])).directionalBlur, { amount: 1, axis: 'h' });
  assert.equal(clipTx(view([setTx({ directionalBlur: { amount: 0, axis: 'h' } })])).directionalBlur, undefined);
  assert.equal(clipTx(view([setTx({})])).directionalBlur, undefined);
});

test('materialize emits directional_blur (snake_case field, nested value verbatim)', () => {
  const comp = composeTimeline(view([setTx({ directionalBlur: { amount: 0.9, axis: 'v' } })]));
  const { edl } = materializeExportEdl(comp, () => 'e.mp4', {});
  assert.deepEqual(edl.spine.segments[0].directional_blur, { amount: 0.9, axis: 'v' });
});

test('OFFLINE RENDER: an h-streak widens the vertical edge; a v-streak of the same amount does NOT (anisotropy, L155)', () => {
  const base = hTransitionWidth(frame(render({}, 'dirb-off', true), 0.5));
  const hBlur = hTransitionWidth(frame(render({ directionalBlur: { amount: 1, axis: 'h' } }, 'dirb-h', true), 0.5));
  const vBlur = hTransitionWidth(frame(render({ directionalBlur: { amount: 1, axis: 'v' } }, 'dirb-v', true), 0.5));

  assert.ok(hBlur > base + 6, `the horizontal streak widens the vertical edge: transition ${hBlur}px > base ${base}px`);
  assert.ok(vBlur <= base + 2, `the vertical streak leaves the vertical edge sharp (anisotropy): transition ${vBlur}px ~ base ${base}px`);

  const a = render({ directionalBlur: { amount: 1, axis: 'h' } }, 'dirb-det-a', true);
  const b = render({ directionalBlur: { amount: 1, axis: 'h' } }, 'dirb-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic directional-blur renders of the same EDL are byte-identical');
});
