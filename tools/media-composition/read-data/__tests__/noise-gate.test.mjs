/**
 * #208 noise-gate AUDIO_FX preset: an AMPLITUDE gate (ffmpeg `agate`, a dynamics processor) that silences
 * audio BELOW a threshold so room-tone/hiss between spoken words drops out while speech passes. A DISTINCT
 * mechanism from the spectral afftdn/de-ess rows (those subtract a noise profile; this gates on level). One
 * pure DATA row in AUDIO_FX_CATALOG, selected by `audio_fx`, applied blind (L090, zero engine code).
 *
 * Proof (L155): a real OFFLINE render on a clip whose audio is a 440 Hz sine, LOUD for the first second then
 * QUIET (0.02) for the second. The oracle is SPECTRAL, not amplitude-RMS: the render re-encodes to aac, which
 * refills a gated-silent region with a broadband noise floor (so total RMS barely moves), but the DEFINING
 * behavior is still visible in the frequency domain: a Goertzel magnitude AT 440 Hz shows the quiet region's
 * TONE is removed by the gate while the loud region's tone is preserved. (This is exactly why the frequency
 * -based pitch oracle survives the render but an amplitude oracle does not.) PLUS: output differs from plain,
 * two renders are byte-identical (deterministic), and a catalog-DATA unit assert.
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
const W = 320, H = 240, FPS = 24, SR = 8000, F0 = 440;
let composeTimeline, materializeExportEdl, AUDIO_FX_CATALOG, work, clip;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
// Goertzel magnitude at F0 over a sample slice: how much true 440 Hz TONE is present (immune to the broadband
// aac noise floor that a gated-silent region gets refilled with, so it isolates the gate's real effect).
function goertzel(samples) {
  const w = 2 * Math.PI * F0 / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) { const s0 = samples[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  const re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w);
  return Math.sqrt(re * re + im * im) / samples.length;
}
// tone magnitude at 440 Hz over the first half (loud) and second half (quiet) of the audio.
function tone(file) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-af', `aresample=${SR}`, '-ac', '1', '-f', 's16le', '-'],
    { maxBuffer: 1 << 26 });
  const n = Math.floor(raw.length / 2), half = Math.floor(n / 2);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = raw.readInt16LE(i * 2);
  return { loud: goertzel(s.slice(0, half)), quiet: goertzel(s.slice(half)) };
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'gate-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline, AUDIO_FX_CATALOG } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'gate-render-'));
  // 440 Hz sine, LOUD (full) for the first second then QUIET (0.02) for the second: two separate sines
  // concatenated so the split is clean (loud well above the gate threshold, quiet well below). This is exactly
  // speech-then-room-tone: the loud part must pass, the quiet part's tone must be gated out.
  clip = join(work, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=navy:s=${W}x${H}:d=2:r=${FPS}`,
    '-f', 'lavfi', `-i`, `sine=frequency=${F0}:d=1`, '-f', 'lavfi', '-i', `sine=frequency=${F0}:d=1,volume=0.02`,
    '-filter_complex', '[1:a][2:a]concat=n=2:v=0:a=1[aud]', '-map', '0:v', '-map', '[aud]',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions, markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-11T00:00:00.000Z', parameters: params });
const render = (name, params) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => clip, { width: W, height: H, fps: FPS, deterministic: true });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('catalog DATA: noise-gate is an agate amplitude gate (distinct from spectral afftdn/de-ess; zero engine code)', () => {
  assert.equal(AUDIO_FX_CATALOG['noise-gate'], 'agate=threshold=0.08:ratio=9:attack=5:release=150');
  assert.ok(/^agate=/.test(AUDIO_FX_CATALOG['noise-gate']), 'uses agate (a level gate), not afftdn (spectral)');
});

test('OFFLINE RENDER: noise-gate removes the quiet-region tone and preserves the loud-region tone, deterministic (L155)', () => {
  const plain = render('plain');
  const gated = render('gated', { audio_fx: 'noise-gate' });
  const gated2 = render('gated2', { audio_fx: 'noise-gate' });

  const p = tone(plain), g = tone(gated);
  // defining behavior: the below-threshold (quiet) region's 440 Hz tone is gated OUT.
  assert.ok(g.quiet < p.quiet * 0.4, `noise-gate removes the quiet-region tone (440Hz mag plain ${p.quiet.toFixed(1)} -> gated ${g.quiet.toFixed(1)})`);
  // above-threshold (loud) region's tone is preserved (a gate is not a global cut).
  assert.ok(g.loud > p.loud * 0.7, `noise-gate preserves the loud-region tone (440Hz mag plain ${p.loud.toFixed(1)} -> gated ${g.loud.toFixed(1)})`);
  // two-sidedness: the gate hits the quiet region's tone far harder than the loud region's.
  assert.ok((g.quiet / p.quiet) < (g.loud / p.loud) * 0.6, 'gate attenuates below-threshold tone far more than above-threshold');

  assert.notEqual(hashFile(gated), hashFile(plain), 'noise-gate changed the rendered output vs no effect');
  assert.equal(hashFile(gated), hashFile(gated2), 'two noise-gate renders of the same EDL are byte-identical');
});
