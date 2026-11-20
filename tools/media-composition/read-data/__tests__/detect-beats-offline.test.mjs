/**
 * #217 OFFLINE beat detector (detect-beats.mjs): the headless twin of detect-scenes.mjs, extracting mono PCM from
 * a FILE via ffmpeg and running the SHARED energy-flux picker (beat-onset-picker.mjs) to emit the beat-time list
 * beat-sync.ts turns into timeline splits. The autonomous export path for music-synced montage cuts (no browser
 * AudioBuffer, no librosa). Zero new render code (L069): it only writes beat DATA; the `split` fold does the cut.
 *
 * Proof (L155, offline, deterministic ground truth):
 *  1. metronome oracle: a click track at a KNOWN BPM (120 = every 0.5s, 90 = every 0.667s) is detected with the
 *     right tempo (estimated bpm and median inter-beat interval match the metronome, which fabricated data could
 *     not fake), and SILENCE (zero energy) yields zero beats (the picker's real contract: no onset without an
 *     energy rise). NOTE: this is a transient/percussive-onset picker, so flat non-percussive material (a held
 *     tone) can surface adaptive-threshold noise picks; music / clicks / footsteps / ball-bounces are the case.
 *  2. SSOT cross-check: the in-browser re-export (detect-beats-browser.ts) fed the SAME extracted PCM returns the
 *     IDENTICAL beats, proving one shared picker with two entry points (L030 canonical-single-source).
 *  3. determinism: two runs of the same file are byte-identical DATA.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectBeats, extractMonoPcm } from '../../do-work/detect-beats.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let work, click120, click90, silence, browserDetect;

// a click track: a 1000 Hz tone gated ON for the first 40 ms of each `period`-second window (a metronome).
function clickTrack(file, period) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `aevalsrc=exprs='sin(1000*2*PI*t)*lt(mod(t,${period}),0.04)':d=4:s=22050`, '-c:a', 'aac', file], { encoding: 'utf8' });
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const gaps = (b) => b.slice(1).map((t, i) => t - b[i]);

before(async () => {
  work = tempFolder(join(tmpdir(), 'beats-'));
  click120 = join(work, 'c120.m4a'); clickTrack(click120, 0.5);      // 120 BPM
  click90 = join(work, 'c90.m4a'); clickTrack(click90, 0.6667);      // 90 BPM
  silence = join(work, 'silence.m4a');                               // zero energy => zero flux => zero beats
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '4', '-c:a', 'aac', silence], { encoding: 'utf8' });

  // bundle the browser entry so we can prove it shares the exact picker.
  const out = join(work, 'bb.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', '--alias:@=' + join(here, '..', '..', '..', '..'),
    join(here, '..', '..', 'do-work', 'detect-beats-browser.ts'), `--outfile=${out}`], { encoding: 'utf8' });
  ({ detectBeatsFromChannel: browserDetect } = await import(out));
});

test('metronome oracle: a 120 BPM click is detected at ~120 BPM with ~0.5s spacing (L155)', () => {
  const r = detectBeats(click120);
  assert.ok(r.count >= 5, `found enough beats (${r.count})`);
  assert.ok(r.bpm >= 110 && r.bpm <= 130, `estimated bpm ~120 (${r.bpm})`);
  const m = median(gaps(r.beats));
  assert.ok(m >= 0.42 && m <= 0.58, `median inter-beat gap ~0.5s (${m.toFixed(3)})`);
});

test('metronome oracle: a 90 BPM click is detected at ~90 BPM with ~0.667s spacing (tempo-agnostic)', () => {
  const r = detectBeats(click90);
  assert.ok(r.bpm >= 80 && r.bpm <= 100, `estimated bpm ~90 (${r.bpm})`);
  const m = median(gaps(r.beats));
  assert.ok(m >= 0.60 && m <= 0.73, `median inter-beat gap ~0.667s (${m.toFixed(3)})`);
});

test('silence (zero energy) yields zero beats: no onset without an energy rise', () => {
  const r = detectBeats(silence);
  assert.equal(r.count, 0, `no beats on silence (${r.count})`);
  assert.equal(r.bpm, null, 'no tempo on silence');
});

test('SSOT: the in-browser re-export returns IDENTICAL beats from the same PCM (one shared picker)', () => {
  const { samples, sampleRate } = extractMonoPcm(click120);
  const offline = detectBeats(click120).beats;
  const browser = browserDetect(samples, sampleRate);
  assert.deepEqual(browser, offline, 'browser entry and offline producer share the exact picker output');
});

test('determinism: two detections of the same file are identical DATA', () => {
  assert.deepEqual(detectBeats(click120), detectBeats(click120));
});
