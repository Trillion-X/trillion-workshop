/**
 * #189 Vibrance: a nonlinear "smart saturation" that boosts the saturation of MUTED colors while protecting
 * already-vivid ones, via ffmpeg's native `vibrance` filter. DATA vibrance: true | { intensity: -1..1 }. bare
 * true seeds 0.6; intensity 0 is identity (dropped). The nonlinear counterpart to the plain linear saturation
 * control (which scales every pixel equally).
 *
 * Proof: DATA resolution (bare true seeds 0.6; nested {intensity}; flat vibrance_intensity; clamp -1..1;
 * intensity 0 dropped; absent undefined), materialize pass-through, AND a real OFFLINE render whose oracle is
 * CHROMA GAIN: a source with a MUTED color bar (small max-min per pixel) gains chroma after a positive vibrance
 * (the muted color pops). PLUS a byte-identical determinism proof. L155.
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
let work, muted;
const W = 320, H = 240, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function rgbFrame(file, ss) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  return raw;
}
// mean per-pixel chroma (max - min of r,g,b) over a horizontal band at row y, columns [x0,x1).
function chroma(raw, y, x0, x1) {
  let s = 0, n = 0;
  for (let x = x0; x < x1; x++) {
    const i = (y * W + x) * 3; const r = raw[i], g = raw[i + 1], b = raw[i + 2];
    s += Math.max(r, g, b) - Math.min(r, g, b); n++;
  }
  return Math.round(s / n);
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'vib-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'vib-render-'));
  muted = join(work, 'muted.mp4'); // a MUTED cyan-ish bar (r=90,g=150,b=150) on neutral gray (110).
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=320x240:d=2:r=${FPS}`, '-vf', "geq=r='if(between(X,120,200),90,110)':g='if(between(X,120,200),150,110)':b='if(between(X,120,200),150,110)'", '-pix_fmt', 'yuv420p', muted]);
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
  const { edl } = materializeExportEdl(comp, () => muted, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves vibrance: bare `true` seeds 0.6; nested {intensity}; flat vibrance_intensity', () => {
  assert.deepEqual(clipTx(view([setTx({ vibrance: true })])).vibrance, { intensity: 0.6 });
  assert.deepEqual(clipTx(view([setTx({ vibrance: { intensity: 0.4 } })])).vibrance, { intensity: 0.4 });
  assert.deepEqual(clipTx(view([setTx({ vibrance_intensity: -0.5 })])).vibrance, { intensity: -0.5 });
});

test('resolves vibrance: clamps -1..1; intensity 0 dropped; absent undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ vibrance: { intensity: 5 } })])).vibrance, { intensity: 1 });
  assert.deepEqual(clipTx(view([setTx({ vibrance: { intensity: -9 } })])).vibrance, { intensity: -1 });
  assert.equal(clipTx(view([setTx({ vibrance: { intensity: 0 } })])).vibrance, undefined);
  assert.equal(clipTx(view([setTx({})])).vibrance, undefined);
});

test('materialize emits vibrance (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ vibrance: { intensity: 0.4 } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].vibrance, { intensity: 0.4 });
});

test('OFFLINE RENDER: a positive vibrance boosts the muted color bar chroma, leaves the gray bg near-neutral (L155)', () => {
  const y = Math.floor(H / 2);
  const base = rgbFrame(render({}, 'vib-off', true), 0.5);
  const vib = rgbFrame(render({ vibrance: { intensity: 1 } }, 'vib-on', true), 0.5);

  const baseBar = chroma(base, y, 120, 200), vibBar = chroma(vib, y, 120, 200);
  const baseBg = chroma(base, y, 0, 60), vibBg = chroma(vib, y, 0, 60);

  assert.ok(baseBar > 20, `the base bar is a real (muted) color, not gray: chroma=${baseBar}`);
  assert.ok(vibBar > baseBar * 1.4, `vibrance boosts the muted bar chroma: ${vibBar} vs ${baseBar}`);
  assert.ok(baseBg < 20 && vibBg < 30, `the neutral-gray bg stays near-neutral (vibrance protects it): base ${baseBg}, vib ${vibBg}`);

  const a = render({ vibrance: { intensity: 1 } }, 'vib-det-a', true);
  const b = render({ vibrance: { intensity: 1 } }, 'vib-det-b', true);
  assert.equal(hashFile(a), hashFile(b), 'two deterministic vibrance renders of the same EDL are byte-identical');
});
