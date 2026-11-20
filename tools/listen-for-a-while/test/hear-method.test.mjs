// The hear step of hearing-sources, on an injected hearer: each source's recording is heard once with the hearing options, the words come back in time order labelled by source, and the session record names the hearer. The default hearer is audio-transcription's hearFile; running it needs a local model, so that path is not run here.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hearSourcesOfACall, sourcesSettings } from '../read-data/hearing-sources.mjs';

const ROW = { id: 'whisper-test', label: 'whisper test', check: ['whisper-cli', '--version'] };
const runnable = { exists: () => true, run: () => {} };

const settings = sourcesSettings();
const fakeHearer = calls => async (recording, hearing) => {
  calls.push({ recording, hearing });
  return recording.endsWith('/mic.wav')
    ? { segments: [{ start: 0, end: 2, text: 'Hello team.' }], produced_by: 'fake' }
    : { segments: [{ start: 2.5, end: 5, text: 'Hi, can you hear me?' }], produced_by: 'fake' };
};

test('each source recording is heard once with the hearing options, and the words come back in time order labelled by source', async () => {
  const calls = [];
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'hear-method-')), 'sessions.json');
  const { words, session } = await hearSourcesOfACall(
    { sources: [{ source: 'system-audio', path: '/sys.wav' }, { source: 'microphone', path: '/mic.wav' }] },
    { settings, at: 1000, hear: fakeHearer(calls), hearing: { modelPath: '/m.bin', produced_by: 'whisper-test', rows: [ROW] }, picking: runnable, file },
  );
  assert.deepEqual(calls.map(call => call.recording).sort(), ['/mic.wav', '/sys.wav'], 'one pass per source file');
  assert.ok(calls.every(call => call.hearing.modelPath === '/m.bin'), 'the hearing options reach the hearer');
  assert.deepEqual(words.map(word => [word.speaker, word.text]), [['Me', 'Hello team.'], ['Others', 'Hi, can you hear me?']]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.length, 1, 'the session record is kept');
  assert.equal(session.program, 'whisper-test');
});

test('an empty request is refused before any recording is heard', async () => {
  const calls = [];
  await assert.rejects(hearSourcesOfACall({ sources: [] }, { settings, hear: fakeHearer(calls), hearing: { rows: [ROW] }, picking: runnable }), /Give sources/);
  assert.equal(calls.length, 0);
});

test('a computer with no hearing program that runs is refused before any recording is heard', async () => {
  const calls = [];
  await assert.rejects(
    hearSourcesOfACall({ sources: [{ source: 'microphone', path: '/mic.wav' }] }, { settings, hear: fakeHearer(calls), hearing: { rows: [ROW] }, picking: { exists: () => false } }),
    /no program that hears recordings/,
  );
  assert.equal(calls.length, 0);
});

test('the first hearing program that runs here is picked and named in the session record', async () => {
  const calls = [];
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'hear-method-')), 'sessions.json');
  const missing = { id: 'not-installed', label: 'not installed', check: ['nope-cli'] };
  const { session } = await hearSourcesOfACall(
    { sources: [{ source: 'microphone', path: '/mic.wav' }] },
    { settings, hear: fakeHearer(calls), hearing: { rows: [missing, ROW] }, picking: { exists: file => file.endsWith('/whisper-cli'), run: () => {} }, file },
  );
  assert.equal(calls[0].hearing.program.id, 'whisper-test');
  assert.equal(session.program, 'whisper-test');
});

test('the picked hearing row is what runs: its program, model and ffmpeg reach the seam, not the request options', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hear-method-'));
  const fakeSeam = path.join(dir, 'fake-seam.mjs');
  writeFileSync(fakeSeam, [
    "import { writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const out = args[args.indexOf('--out') + 1];",
    "writeFileSync(out + '.args', JSON.stringify(args));",
    "writeFileSync(out, JSON.stringify({ full_text: 'hi', segments: [{ start: 0, end: 1, text: 'hi' }], language: 'en' }));",
  ].join('\n'));
  const row = { id: 'whisper-test', label: 'whisper test', check: ['whisper-cli', '--version'], model: '/row-model.bin', ffmpeg: '/row/ffmpeg' };
  const file = path.join(dir, 'sessions.json');
  const { session } = await hearSourcesOfACall(
    { sources: [{ source: 'microphone', path: path.join(dir, 'mic.wav') }] },
    { settings, file, picking: { exists: name => name.endsWith('/whisper-cli'), run: () => {} },
      hearing: { rows: [row], modelPath: '/request-model.bin', ffmpeg: '/request/ffmpeg', python: process.execPath, script: fakeSeam } },
  );
  const seen = JSON.parse(readFileSync(path.join(dir, 'mic.wav.heard.json.args'), 'utf8'));
  const value = flag => seen[seen.indexOf(flag) + 1];
  assert.ok(value('--whisper-cli').endsWith('/whisper-cli'), 'the row program is the whisper-cli that runs');
  assert.equal(value('--model-path'), '/row-model.bin', 'the row model is used, not the request model');
  assert.equal(value('--ffmpeg'), '/row/ffmpeg', 'the row ffmpeg is used, not the request ffmpeg');
  assert.equal(session.program, 'whisper-test');
});
