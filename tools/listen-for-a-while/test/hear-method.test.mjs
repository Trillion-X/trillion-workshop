// The hear step of hearing-sources, on an injected hearer: each source's recording is heard once with the hearing options, the words come back in time order labelled by source, and the session record names the hearer. The default hearer is audio-transcription's hearFile; running it needs a local model, so that path is not run here.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hearSourcesOfACall, sourcesSettings } from '../read-data/hearing-sources.mjs';

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
    { settings, at: 1000, hear: fakeHearer(calls), hearing: { modelPath: '/m.bin', produced_by: 'whisper-test' }, file },
  );
  assert.deepEqual(calls.map(call => call.recording).sort(), ['/mic.wav', '/sys.wav'], 'one pass per source file');
  assert.ok(calls.every(call => call.hearing.modelPath === '/m.bin'), 'the hearing options reach the hearer');
  assert.deepEqual(words.map(word => [word.speaker, word.text]), [['Me', 'Hello team.'], ['Others', 'Hi, can you hear me?']]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.length, 1, 'the session record is kept');
  assert.equal(session.program, 'whisper-test');
});

test('an empty request is refused before any recording is heard', async () => {
  const calls = [];
  await assert.rejects(hearSourcesOfACall({ sources: [] }, { settings, hear: fakeHearer(calls) }), /Give sources/);
  assert.equal(calls.length, 0);
});
