/**
 * #229 Auto-ducking proof (video-compose music_bed `duck`): the music bed already sidechaincompresses keyed by
 * the spine speech (video-compose.mjs:1925-1936, DATA field `duck` from compose-timeline). That RENDER path had
 * NO offline proof; the only music_bed test set no `duck`. This closes the L155 gap on an existing capability, it
 * does NOT rebuild it (L093/L131: the feature exists, the proof did not).
 *
 * Oracle (definitive offline render, distinct-frequency separation): the music bed is a pure 1000 Hz tone; the
 * spine carries a 350 Hz "speech" tone ONLY in [1.5,2.5] and is silent elsewhere. We render with duck and without,
 * then measure the MUSIC BAND only (bandpass 900 to 1100 Hz, so the 350 Hz speech is rejected) inside a speech
 * window vs a silent gap window. With ducking the music band is far quieter under speech than in the gap; the
 * no-duck control stays flat. Fabricated DATA cannot make one real render duck and another not.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../../do-work/video-compose.mjs', import.meta.url).pathname;
const W = 320, H = 240, FPS = 24;
let work, clip, music;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }

// mean loudness (dBFS) of ONLY the music band (bandpass around 1000 Hz) inside [s,e]. Lower dB = quieter music.
function musicBandDb(file, s, e) {
  // volumedetect prints its report to STDERR, so read stderr (not stdout).
  const out = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(s), '-t', String(e - s), '-i', file,
    '-af', 'bandpass=f=1000:width_type=h:w=200,volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const m = out.match(/mean_volume:\s*(-inf|-?[0-9.]+) dB/);
  assert.ok(m, `volumedetect emitted a mean_volume for [${s},${e}]`);
  return m[1] === '-inf' ? -120 : Number(m[1]);
}

function edlWith(duck) {
  return {
    base: { color: 'black' }, tracks: [],
    spine: { segments: [{ kind: 'clip', id: 's0', source: clip, in: 0, out: 4 }] },
    audio_graph: { music_bed: { artifact: music, duck, trim: [0, 4], fade_in: { st: 0, d: 0.01 }, fade_out: { st: 3.99, d: 0.01 }, volume: 0.9 } },
    encode: { width: W, height: H, fps: FPS },
  };
}
function render(duck, name) {
  const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(f, JSON.stringify(edlWith(duck)));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
  return out;
}

before(() => {
  work = tempFolder(join(tmpdir(), 'duck-'));
  music = join(work, 'music.m4a');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=4:sample_rate=48000', '-c:a', 'aac', music]);
  // gray video + a 350 Hz speech tone present ONLY in [1.5,2.5], silence elsewhere (the ducking key).
  clip = join(work, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=gray:s=${W}x${H}:d=4:r=${FPS}`,
    '-f', 'lavfi', '-i', 'aevalsrc=exprs=0.9*sin(350*2*PI*t)*between(t\\,1.5\\,2.5):d=4:s=48000',
    '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
});

const SPEECH = [1.7, 2.3];   // inside the speech burst
const GAP = [3.0, 3.8];      // spine silent, music at full level

test('OFFLINE RENDER: with duck the music band drops under speech and swells back in the gap (L155)', () => {
  const out = render(true, 'ducked');
  const speechDb = musicBandDb(out, ...SPEECH);
  const gapDb = musicBandDb(out, ...GAP);
  assert.ok(gapDb - speechDb > 2.5, `music ducked measurably under speech (gap ${gapDb.toFixed(1)} vs speech ${speechDb.toFixed(1)})`);
});

test('CONTROL: with no duck the music band is roughly flat across speech and gap, and duck made the difference', () => {
  const ducked = render(true, 'ducked2');
  const control = render(false, 'control');
  const dSpeech = musicBandDb(ducked, ...SPEECH), dGap = musicBandDb(ducked, ...GAP);
  const cSpeech = musicBandDb(control, ...SPEECH), cGap = musicBandDb(control, ...GAP);
  assert.ok(Math.abs(cGap - cSpeech) < 2.5, `no-duck music is flat across windows (gap ${cGap.toFixed(1)} vs speech ${cSpeech.toFixed(1)})`);
  assert.ok((dGap - dSpeech) > (cGap - cSpeech) + 2, `ducking caused the suppression (${(dGap - dSpeech).toFixed(1)} vs control ${(cGap - cSpeech).toFixed(1)})`);
  assert.ok(dSpeech < cSpeech - 2, `under speech, duck makes music quieter than the control (${dSpeech.toFixed(1)} vs ${cSpeech.toFixed(1)})`);
});
