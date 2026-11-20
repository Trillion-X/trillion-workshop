/**
 * #216 Transition audio crossfade (acrossfade): a video crossfade (xfade / custom expr) previously mapped
 * `anullsrc` (SILENCE) for the transition segment's audio, so the mix went DEAD during every transition. The
 * fix blends the two subclips' audio with `acrossfade=d=dur` (equal-power tail-of-A into head-of-B), keyed on
 * the same `dur` as the visual xfade. Zero new render code beyond the mapping, and every normalized subclip
 * carries a stereo track (video-compose's silent path muxes anullsrc), so [0:a]/[1:a] always exist and it
 * never errors.
 *
 * Proof (L155, spectral per the #208 re-encode-robust lesson): subclip A is a 440 Hz tone, B is an 880 Hz tone.
 * Render the transition through the REAL exported createTransitionRenderers.xfade (the exact edited code path,
 * injected with the compositor's I/O shape). Oracle: BOTH tones carry real energy in the transition audio
 * (Goertzel@440 AND Goertzel@880 well above the noise floor), which the OLD silent anullsrc mapping could
 * never produce, and A dominates the first half while B dominates the second (the crossfade direction). PLUS
 * byte-determinism, and the custom-`expr` renderer proven the same way.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { blake3 } from '@noble/hashes/blake3.js';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransitionRenderers } from '../../do-work/effect-registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const W = 240, H = 160, FPS = 24, SR = 8000;
const DUR = 0.5;
let work, clipA, clipB, R;
let trN = 0;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');

// magnitude of frequency F over a mono downmix of the file (re-encode-robust spectral oracle, #208).
function tone(file, F, { half } = {}) {
  const seek = half === 'first' ? ['-t', String(DUR / 2)] : half === 'second' ? ['-ss', String(DUR / 2)] : [];
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, ...seek,
    '-af', `pan=mono|c0=0.5*c0+0.5*c1,aresample=${SR}`, '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
  const n = Math.floor(raw.length / 2); const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = raw.readInt16LE(i * 2);
  const w = 2 * Math.PI * F / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < s.length; i++) { const s0 = s[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  const re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w);
  return Math.sqrt(re * re + im * im) / (s.length || 1);
}

before(() => {
  work = tempFolder(join(tmpdir(), 'trxfade-'));
  clipA = join(work, 'a.mp4'); // 440 Hz tone (the outgoing clip's tail)
  clipB = join(work, 'b.mp4'); // 880 Hz tone (the incoming clip's head)
  ffmpeg(['-f', 'lavfi', '-i', `color=navy:s=${W}x${H}:d=${DUR}:r=${FPS}`, '-f', 'lavfi', '-i', `sine=frequency=440:d=${DUR}`,
    '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipA]);
  ffmpeg(['-f', 'lavfi', '-i', `color=maroon:s=${W}x${H}:d=${DUR}:r=${FPS}`, '-f', 'lavfi', '-i', `sine=frequency=880:d=${DUR}`,
    '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipB]);

  // inject the compositor's I/O shape (the exact deps createTransitionRenderers is called with in video-compose).
  R = createTransitionRenderers({
    trPath: () => join(work, `tr-${trN++}.mp4`),
    ff: (args, label) => { try { ffmpeg(args); } catch (e) { throw new Error(`${label}: ${e.stderr?.toString().slice(-300) ?? e.message}`); } },
    V: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], A: ['-c:a', 'aac'],
    W, H, FPS, materializeRef: () => '', execFileSync,
  });
});

test('xfade transition audio is NOT silent: both tones carry real energy and A crossfades to B (L155)', () => {
  const out = R.xfade(clipA, clipB, DUR, { type: 'fade' });
  const a440 = tone(out, 440), b880 = tone(out, 880);
  // the OLD anullsrc mapping made this segment silent, so both would be ~0. acrossfade blends both in.
  assert.ok(a440 > 50, `outgoing 440 Hz present in transition audio (${a440.toFixed(1)})`);
  assert.ok(b880 > 50, `incoming 880 Hz present in transition audio (${b880.toFixed(1)})`);
  // direction: 440 (A) dominates the first half, 880 (B) dominates the second half (equal-power crossfade).
  const a1 = tone(out, 440, { half: 'first' }), a2 = tone(out, 440, { half: 'second' });
  const b1 = tone(out, 880, { half: 'first' }), b2 = tone(out, 880, { half: 'second' });
  assert.ok(a1 > a2, `440 fades OUT across the transition (first ${a1.toFixed(1)} > second ${a2.toFixed(1)})`);
  assert.ok(b2 > b1, `880 fades IN across the transition (second ${b2.toFixed(1)} > first ${b1.toFixed(1)})`);
});

test('custom-expr transition also blends audio (not silent), byte-deterministic (L155)', () => {
  const spec = { expr: 'A*(1-P)+B*P' }; // linear custom dissolve
  const o1 = R.expr(clipA, clipB, DUR, spec);
  const o2 = R.expr(clipA, clipB, DUR, spec);
  assert.ok(tone(o1, 440) > 50 && tone(o1, 880) > 50, 'custom-expr transition carries both tones (not silent)');
  assert.equal(hashFile(o1), hashFile(o2), 'two custom-expr transition renders are byte-identical');
});
