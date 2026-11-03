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

test('the readers behind transcribe-many, judge, index and text keep their promises', () => {
  const out = run('python3', ['-B', join(folder, 'test', 'test_transcript_reports.py')]);
  assert.equal(out.status, 0, out.stderr);
});

test('transcribe-many does every recording in a folder once, with its path and when it was made', { skip }, () => {
  const folderOfTakes = join(work, 'takes');
  mkdirSync(folderOfTakes);
  for (const name of ['A001.wav', 'A002.wav']) {
    assert.equal(run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=60', join(folderOfTakes, name)]).status, 0);
  }
  writeFileSync(join(folderOfTakes, 'A001M01.XML'), '<Meta><CreationDate value="2031-04-05T06:07:08+01:00"/></Meta>');
  const many = join(work, 'many');
  const before = calls().length;
  const first = tool('transcribe-many', '--recordings', folderOfTakes, '--pattern', '*.wav', '--out-dir', many, '--workers', '2', ...engine());
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual([lastLine(first.stdout).ok, lastLine(first.stdout).skipped], [2, 0]);
  const one = JSON.parse(readFileSync(join(many, 'A001.json'), 'utf8'));
  assert.equal(one.source, join(folderOfTakes, 'A001.wav'));
  assert.deepEqual([one.recorded_at, one.recorded_at_from], ['2031-04-05T06:07:08+01:00', 'sidecar:A001M01.XML']);
  assert.equal(JSON.parse(readFileSync(join(many, 'A002.json'), 'utf8')).recorded_at_from, 'file-modified-time');
  const again = lastLine(tool('transcribe-many', '--recordings', folderOfTakes, '--pattern', '*.wav', '--out-dir', many, ...engine()).stdout);
  assert.deepEqual([again.ok, again.skipped], [0, 2]);
  assert.equal(calls().length - before, 2, 'a recording already done is not heard again');
});

test('repair-many repairs each transcript from the recording it names, and index counts the folder', { skip }, () => {
  const many = join(work, 'many');
  const paths = ['A001.json', 'A002.json'].map(name => join(many, name));
  const out = tool('repair-many', '--transcript', ...paths, '--workers', '2', ...engine());
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(lastLine(out.stdout).transcripts.map(t => t.status), ['repaired 1 windows, removed 0', 'repaired 1 windows, removed 0']);
  assert.deepEqual(JSON.parse(readFileSync(paths[1], 'utf8')).repaired_windows, [[16, 40]]);
  const orphan = join(work, 'orphan.json');
  writeFileSync(orphan, JSON.stringify({ duration: 10, segments: [], words: [] }));
  const refused = tool('repair-many', '--transcript', orphan, ...engine());
  assert.equal(refused.status, 2);
  assert.match(lastLine(refused.stdout).transcripts[0].status, /names no source recording/);
  const index = lastLine(tool('index', '--transcripts', many).stdout);
  assert.deepEqual({ ...index, index: undefined }, { index: undefined, recordings: 2, hours: 0.03, silent: 0, segments: 6, words: 24 });
  const lines = readFileSync(join(many, 'index.tsv'), 'utf8').trim().split('\n');
  assert.equal(lines[0], 'name\tduration\twords\tsegments\tfirst_line');
  assert.equal(lines[1], 'A001\t60.0\t12\t3\thello there everyone');
});

test('judge rejects an answer too thin or looped to trust, and text writes timed paragraphs only from one it accepts', { skip }, () => {
  const thin = join(work, 'many', 'A001.json');
  const verdict = lastLine(tool('judge', '--transcript', thin).stdout).verdicts[0];
  assert.equal(verdict.accepted, false);
  assert.match(verdict.reasons.join(), /words per minute 12/);
  const refused = tool('text', '--transcript', thin, '--out', join(work, 'thin.txt'));
  assert.equal(refused.status, 2);
  assert.ok(!existsSync(join(work, 'thin.txt')), 'nothing is written for a rejected answer');
  assert.equal(tool('text', '--transcript', thin, '--out', join(work, 'thin.txt'), '--even-if-rejected').status, 0);
  const words = Array.from({ length: 90 }, (_, i) => `w${i}`);
  const good = join(work, 'good.json');
  writeFileSync(good, JSON.stringify({ duration: 60, source: '/recordings/B007.wav',
    segments: [0, 1, 2].map(i => ({ start: i * 20, end: i * 20 + 18, text: words.slice(i * 30, i * 30 + 30).join(' ') })),
    words: words.map((t, i) => ({ t, start: i * 0.6, end: i * 0.6 + 0.5 })) }));
  assert.equal(lastLine(tool('judge', '--transcript', good).stdout).rejected, 0);
  const made = tool('text', '--transcript', good, '--out', join(work, 'good.txt'));
  assert.equal(made.status, 0, made.stderr);
  const text = readFileSync(join(work, 'good.txt'), 'utf8').split('\n');
  assert.deepEqual(text.slice(0, 4), ['# B007', 'Source: /recordings/B007.wav', 'Transcript: whisper, word timings in good.json', '']);
  assert.ok(text[4].startsWith('[0:00] w0 w1') && text[4].includes('w59'), 'the first two segments are one paragraph');
  assert.ok(text[5].startsWith('[0:40] w60'));
});
