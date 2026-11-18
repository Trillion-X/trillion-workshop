// Hearing the sources of a call separately (computer/hearing-sources.mjs, DATA in hearing-sources.json).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hearSources, recordSession, sourcesSettings } from '../computer/hearing-sources.mjs';

const settings = sourcesSettings();
const files = {
  '/mic.wav': { segments: [{ start: 0, end: 2, text: 'Hello team.' }, { start: 6, end: 8, text: ' ' }, { start: 7, end: 9, text: 'Yes I can.' }] },
  '/sys.wav': { segments: [{ start: 2.5, end: 5, text: 'Hi, can you hear me?' }] },
};

test('each source is heard on its own and the words come back in time order labelled by their source row', async () => {
  const heard = []; const words = await hearSources([{ source: 'system-audio', path: '/sys.wav' }, { source: 'microphone', path: '/mic.wav' }], { settings, at: 1000, hear: async file => { heard.push(file); return files[file]; } });
  assert.deepEqual(heard.sort(), ['/mic.wav', '/sys.wav'], 'one pass per source file, nothing mixed');
  assert.deepEqual(words.map(w => [w.start_ms, w.speaker, w.me, w.text]), [[1000, 'Me', true, 'Hello team.'], [3500, 'Others', false, 'Hi, can you hear me?'], [8000, 'Me', true, 'Yes I can.']]);
});

test('an unknown source and an empty request are refused with their own words', async () => {
  await assert.rejects(hearSources([{ source: 'camera', path: '/x' }], { settings, hear: async () => ({}) }), /no source camera. Sources: microphone, system-audio/);
  await assert.rejects(hearSources([], { settings, hear: async () => ({}) }), /Give sources/);
});

test('the session record names the program and flags with a content id, refuses secret-looking flags and keeps a bounded list', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'hs-')), 'sessions.json');
  const record = recordSession({ program: 'mlx-whisper', flags: { relay: false, no_training: true }, sources: ['microphone'], at: 5 }, { settings: { ...settings, most_sessions: 2 }, file });
  assert.match(record.id, /^[0-9a-f]{16}$/);
  assert.throws(() => recordSession({ program: 'p', flags: { api_token: 'x' }, sources: [] }, { settings, file }), /looks like a secret/);
  recordSession({ program: 'p', sources: [], at: 6 }, { settings: { ...settings, most_sessions: 2 }, file });
  recordSession({ program: 'p', sources: [], at: 7 }, { settings: { ...settings, most_sessions: 2 }, file });
  const kept = JSON.parse(readFileSync(file, 'utf8')).sessions;
  assert.deepEqual(kept.map(s => s.at), [6, 7]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  console.log('REAL readback of the session record file:', JSON.stringify(kept[0]));
});
