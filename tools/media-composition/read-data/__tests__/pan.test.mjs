/**
 * #215 Stereo PLACEMENT (pan-left / pan-right): AUDIO_FX_CATALOG presets that fold the clip's audio to ONE side
 * of the stereo field (the only audio rows that touch WHERE the sound sits, not its tone), so different sources
 * sit in different places in an assembled mix. `pan=stereo|c0=..|c1=..`, `audio_fx`-selected, applied blind
 * (L090, zero engine code).
 *
 * Proof (L155): a STEREO clip whose left channel is a 440 Hz tone and right is 880 Hz. Spectral per-channel
 * oracle (re-encode-robust, per the #208 lesson): after pan-left the RIGHT output channel has no tone, after
 * pan-right the LEFT output channel has no tone (measured by a Goertzel at 440 Hz on each extracted channel).
 * PLUS a catalog-DATA unit and byte-determinism.
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
const W = 240, H = 160, FPS = 24, SR = 8000, F0 = 440;
let composeTimeline, materializeExportEdl, AUDIO_FX_CATALOG, work, clip;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function goertzel(samples) {
  const w = 2 * Math.PI * F0 / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) { const s0 = samples[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  const re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w);
  return Math.sqrt(re * re + im * im) / samples.length;
}
// 440 Hz tone magnitude on one output channel (`pan=mono|c0=c0` = left, `c0=c1` = right).
function chanTone(file, chExpr) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-af', `pan=mono|c0=${chExpr},aresample=${SR}`, '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
  const n = Math.floor(raw.length / 2); const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = raw.readInt16LE(i * 2);
  return goertzel(s);
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'pan-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline, AUDIO_FX_CATALOG } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'pan-render-'));
  // STEREO: left = 440 Hz, right = 880 Hz, so each channel is independently identifiable.
  clip = join(work, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=navy:s=${W}x${H}:d=1:r=${FPS}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:d=1', '-f', 'lavfi', '-i', 'sine=frequency=880:d=1',
    '-filter_complex', '[1:a][2:a]join=inputs=2:channel_layout=stereo[a]', '-map', '0:v', '-map', '[a]',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
});

const view = (fx) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: fx ? [{ action: 'set-transform', label: 'pan', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-12T00:00:00.000Z', parameters: { audio_fx: fx } }] : [],
  markers: [],
});
const render = (name, fx) => {
  const comp = composeTimeline(view(fx));
  const { edl } = materializeExportEdl(comp, () => clip, { width: W, height: H, fps: FPS, deterministic: true });
  const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
  return out;
};

test('catalog DATA: pan-left/right fold to one side of the stereo field (zero engine code)', () => {
  assert.equal(AUDIO_FX_CATALOG['pan-left'], 'pan=stereo|c0=c0+c1|c1=0*c0');
  assert.equal(AUDIO_FX_CATALOG['pan-right'], 'pan=stereo|c0=0*c0|c1=c0+c1');
});

test('OFFLINE RENDER: pan-left silences the right channel, pan-right silences the left, deterministic (L155)', () => {
  const left = render('left', 'pan-left');
  const right = render('right', 'pan-right');
  const left2 = render('left2', 'pan-left');

  const lL = chanTone(left, 'c0'), lR = chanTone(left, 'c1');
  const rL = chanTone(right, 'c0'), rR = chanTone(right, 'c1');
  // pan-left: all audio on the LEFT output, the RIGHT output has no tone.
  assert.ok(lR < lL * 0.3, `pan-left silences the right channel (440Hz L ${lL.toFixed(1)} vs R ${lR.toFixed(1)})`);
  // pan-right: all audio on the RIGHT output, the LEFT output has no tone.
  assert.ok(rL < rR * 0.3, `pan-right silences the left channel (440Hz L ${rL.toFixed(1)} vs R ${rR.toFixed(1)})`);

  assert.equal(hashFile(left), hashFile(left2), 'two pan-left renders are byte-identical');
});
