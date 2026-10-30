// Runs the seam (do-work/audio_transcription.py) for real around the package's own transcribe-audio.py, on a tone made here with
// ffmpeg and a stand-in for whisper-cli that loops the way Whisper does. Checks what the seam adds: the package's result with
// the recording's length, nothing left beside the recording, the loops found, and only the looped window heard again (context off)
// and spliced in at the right seconds. The package's own tests run unchanged in do-work/__tests__. Needs python3, ffmpeg, ffprobe.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const script = join(folder, 'do-work', 'audio_transcription.py');
const fake = join(folder, 'test', 'fake_whisper_cli.py');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const run = (command, argv, env = {}) => spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
const have = tool => run(tool, ['-version']).status === 0;
const skip = have('ffmpeg') && have('ffprobe') && run('python3', ['--version']).status === 0 ? false : 'needs python3, ffmpeg and ffprobe on the computer';
const lastLine = out => JSON.parse(out.trim().split('\n').pop()).result;

let work, recordings, audio, model, log, transcript;
const env = () => ({ FAKE_WHISPER_LOG: log });
const engine = () => ['--model-path', model, '--whisper-cli', fake];
const tool = (...argv) => run('python3', [script, ...argv], env());
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);

before(() => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), 'audio-transcription-'));
  recordings = join(work, 'recordings');
  mkdirSync(recordings);
  audio = join(recordings, 'take-one.wav');
  model = join(work, 'model.bin');
  log = join(work, 'calls.jsonl');
  transcript = join(work, 'take-one.json');
  writeFileSync(model, 'not a real model');
  assert.equal(run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', audio]).status, 0, 'a tone is made');
});

test('the row runs on the person\'s computer and names the scripts that exist', () => {
  assert.equal(row.id, 'tool:transcribe-audio-and-repair-whisper-loops');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.ok(existsSync(script));
  assert.ok(existsSync(join(folder, 'do-work', 'process-scripts', 'transcribe-audio.py')));
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.licence_class, 'licence:maker-own');
});

test('the pure readers keep their promises', () => {
  const out = run('python3', ['-B', join(folder, 'test', 'test_whisper_loops.py')]);
  assert.equal(out.status, 0, out.stderr);
});

test('transcribe runs the package script, keeps its result and leaves nothing beside the recording', () => {
  const out = tool('transcribe', '--audio', audio, '--out', transcript, ...engine());
  assert.equal(out.status, 0, out.stderr);
  const doc = JSON.parse(readFileSync(transcript, 'utf8'));
  assert.equal(doc.language, 'en');
  assert.equal(Math.round(doc.duration), 60);
  assert.deepEqual(doc.segments.map(s => [s.segment_index, s.start, s.end]), [[0, 0, 3], [1, 20, 36], [2, 50, 55]]);
  assert.deepEqual(doc.words.slice(0, 3).map(w => w.t), ['hello', 'there', 'everyone']);
  assert.ok(doc.words.every(w => w.timing_source === 'segment_uniform_estimate'));
  assert.match(doc.command_run_id, /^package::audio-transcription::command-run-request::/);
  assert.deepEqual(readdirSync(recordings), ['take-one.wav']);
  assert.deepEqual(calls().map(c => c.again), [false]);
});

test('find-loops names the transcript and the seconds that loop', () => {
  const result = lastLine(tool('find-loops', '--transcript', transcript).stdout);
  assert.deepEqual(result.transcripts_with_loops, [{ transcript, segments: 1, seconds: 16 }]);
  assert.equal(result.total_looped_seconds, 16);
});

test('repair hears only the looped window again with the context off, drops what still loops and splices at the right seconds', () => {
  const out = tool('repair', '--transcript', transcript, '--audio', audio, ...engine());
  assert.equal(out.status, 0, out.stderr);
  const doc = JSON.parse(readFileSync(transcript, 'utf8'));
  assert.deepEqual(doc.repaired_windows, [[16, 40]]);
  assert.deepEqual(doc.segments.map(s => [s.segment_index, s.text]), [[0, 'hello there everyone'], [1, 'this is what was really said'], [2, 'goodbye for now']]);
  assert.equal(doc.segments[1].start, 16);
  assert.equal(doc.words.find(w => w.t === 'really').start, 17.33);
  assert.equal(doc.full_text, 'hello there everyone this is what was really said goodbye for now');
  assert.deepEqual(doc.removed_hallucinated, []);
  assert.deepEqual(calls().map(c => c.again), [false, true], 'one more listen, for the one window');
  assert.deepEqual(lastLine(tool('find-loops', '--transcript', transcript).stdout).transcripts_with_loops, []);
  assert.equal(lastLine(tool('repair', '--transcript', transcript, '--audio', audio, ...engine()).stdout).skipped, true);
  assert.equal(calls().length, 2);
});

test('a clean transcript is left alone', () => {
  const clean = join(work, 'clean.json');
  writeFileSync(clean, JSON.stringify({ duration: 10, segments: [{ segment_index: 0, start: 0, end: 2, text: 'Fine.' }], words: [] }));
  assert.equal(lastLine(tool('repair', '--transcript', clean, '--audio', audio, ...engine()).stdout).clean, true);
});

test('a recognizer that cannot produce a transcript says why and the exit says so', () => {
  const bad = tool('transcribe', '--audio', audio, '--out', join(work, 'bad.json'), '--model-path', model, '--whisper-cli', join(work, 'no-such-whisper'));
  assert.equal(bad.status, 2);
  assert.ok(lastLine(bad.stdout).failed.code);
});
