/**
 * #193 Auto-contrast (histogram equalization): redistribute a frame's tones so it uses the full range,
 * pulling detail out of a flat/low-contrast shot (the "auto levels / enhance" one-click), via ffmpeg's native
 * `histeq` filter. DATA histeq: true | { strength: 0..1 }. bare true seeds 0.5; strength 0 is identity
 * (dropped). Nonlinear, distinct from a plain LINEAR contrast scale (which just multiplies deviation).
 *
 * Proof: DATA resolution (bare true seeds 0.5; nested {strength}; flat histeq_strength; clamp 0..1; strength 0
 * dropped; absent undefined), materialize pass-through, AND a real OFFLINE render whose oracle is RANGE
 * EXPANSION: a low-contrast gradient (tones bunched in a narrow band) has its min pulled down and max pushed
 * up, so the used tonal range grows substantially. PLUS a byte-identical determinism proof. L155.
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
let work, lc;
const W = 320, H = 240, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function grayFrame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// tonal range (max - min) sampled across the whole frame.
function range(raw) {
  let mn = 255, mx = 0;
  for (let i = 0; i < W * H; i += 7) { const v = raw[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  return { mn, mx, span: mx - mn };
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'heq-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'heq-render-'));
  lc = join(work, 'lc.mp4'); // a LOW-CONTRAST horizontal gradient bunched in ~90..138 (a flat, hazy shot).
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=r='90+0.15*X':g='90+0.15*X':b='90+0.15*X'", '-pix_fmt', 'yuv420p', lc]);
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
  const { edl } = materializeExportEdl(comp, () => lc, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves histeq: bare `true` seeds 0.5; nested {strength}; flat histeq_strength', () => {
  assert.deepEqual(clipTx(view([setTx({ histeq: true })])).histeq, { strength: 0.5 });
  assert.deepEqual(clipTx(view([setTx({ histeq: { strength: 0.8 } })])).histeq, { strength: 0.8 });
  assert.deepEqual(clipTx(view([setTx({ histeq_strength: 0.3 })])).histeq, { strength: 0.3 });
});

test('resolves histeq: clamps 0..1; strength 0 dropped; absent undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ histeq: { strength: 9 } })])).histeq, { strength: 1 });
  assert.equal(clipTx(view([setTx({ histeq: { strength: 0 } })])).histeq, undefined);
  assert.equal(clipTx(view([setTx({ histeq: { strength: -1 } })])).histeq, undefined);
  assert.equal(clipTx(view([setTx({})])).histeq, undefined);
});

test('materialize emits histeq (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ histeq: { strength: 0.8 } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].histeq, { strength: 0.8 });
});

test('OFFLINE RENDER: auto-contrast expands the low-contrast tonal range (L155)', () => {
  const base = range(grayFrame(render({}, 'heq-off', true), 0.5));
  const eq = range(grayFrame(render({ histeq: { strength: 0.8 } }, 'heq-on', true), 0.5));

  assert.ok(base.span < 70, `the base is genuinely low-contrast (bunched tones): span ${base.span} (${base.mn}..${base.mx})`);
  assert.ok(eq.span > base.span + 50, `histeq expands the tonal range: span ${eq.span} (${eq.mn}..${eq.mx}) vs base ${base.span}`);
  assert.ok(eq.mn < base.mn && eq.mx > base.mx, `it pulls the min down and the max up: ${eq.mn}<${base.mn} and ${eq.mx}>${base.mx}`);

  const a = render({ histeq: { strength: 0.8 } }, 'heq-det-a', true);
  const b = render({ histeq: { strength: 0.8 } }, 'heq-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic histeq renders of the same EDL are byte-identical');
});
