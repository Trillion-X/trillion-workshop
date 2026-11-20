// The node hearing path (read-data/hear-with-programs.mjs) with fake ffmpeg and whisper-cli programs: ffmpeg is run to make the WAV,
// whisper-cli is run with the package's arguments and -ng, and the words come from its JSON. No Python runs.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hearWithPrograms, wordRows } from '../read-data/hear-with-programs.mjs';
import { hearSourcesTool, sourcesSettings } from '../../listen-for-a-while/read-data/hearing-sources.mjs';

const folder = tempFolder(path.join(os.tmpdir(), 'hear-with-programs-test-'));
const fakeFfmpeg = path.join(folder, 'ffmpeg');
const fakeWhisper = path.join(folder, 'whisper-cli');
const recording = path.join(folder, 'call.m4a');
writeFileSync(fakeFfmpeg, '#!/bin/sh\nlast=""; for a in "$@"; do last="$a"; done\nprintf "RIFF" > "$last"\n');
writeFileSync(fakeWhisper, [
  '#!/bin/sh',
  'if [ "$1" = "--help" ]; then exit 0; fi',
  'printf "%s\\n" "$@" > "$HEAR_TEST_DIR/argv.txt"',
  'base=""; while [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then base="$2"; fi; shift; done',
  'printf \'%s\' \'{"result":{"language":"en"},"transcription":[{"offsets":{"from":0,"to":2000},"text":" Hello team."},{"offsets":{"from":2000,"to":4000},"text":" Yes, I can hear you."}]}\' > "$base.json"',
].join('\n') + '\n');
chmodSync(fakeFfmpeg, 0o755);
chmodSync(fakeWhisper, 0o755);
writeFileSync(recording, 'not really audio');

test('hearWithPrograms runs ffmpeg then whisper-cli with -ng and returns the words in time order', async () => {
  const env = { ...process.env, HEAR_TEST_DIR: folder };
  const heard = await hearWithPrograms(recording, { modelPath: '/m.bin', whisperCli: fakeWhisper, ffmpeg: fakeFfmpeg, env });
  assert.equal(heard.text, 'Hello team. Yes, I can hear you.');
  assert.deepEqual(heard.segments.map(segment => [segment.start, segment.end]), [[0, 2], [2, 4]]);
  assert.equal(heard.language, 'en');
  const args = readFileSync(path.join(folder, 'argv.txt'), 'utf8').trim().split('\n');
  assert.ok(args.includes('-ng'), 'the GPU is off for the sandbox');
  assert.equal(args[args.indexOf('-m') + 1], '/m.bin');
  assert.equal(args[args.indexOf('-ml') + 1], '1');
  assert.ok(args.includes('-sow'));
});

test('hearWithPrograms refuses a request with no model before any program runs', async () => {
  await assert.rejects(hearWithPrograms(recording, { modelPath: '', whisperCli: fakeWhisper, ffmpeg: fakeFfmpeg }), /Give the Whisper model/);
});

test('tool:hear-sources hears a source through the picked whisper-cli and no Python', async () => {
  const settings = sourcesSettings();
  const saved = process.env.HEAR_TEST_DIR;
  process.env.HEAR_TEST_DIR = folder;
  try {
    const bytes = readFileSync(recording).toString('base64');
    const { words, session } = await hearSourcesTool(
      { sources: [{ source: 'microphone', path: 'call.m4a' }], stored: { files: { 'call.m4a': { base64: bytes } } }, model_path: '/m.bin', whisper_cli: fakeWhisper, ffmpeg: fakeFfmpeg },
      { settings, scratch: folder, file: path.join(folder, 'sessions.json') },
    );
    assert.deepEqual(words.map(word => [word.speaker, word.text]), [['Me', 'Hello team.'], ['Me', 'Yes, I can hear you.']]);
    assert.equal(session.program, 'whisper-cli');
  } finally {
    if (saved === undefined) delete process.env.HEAR_TEST_DIR; else process.env.HEAR_TEST_DIR = saved;
  }
});

test('tool:hear-sources refuses a source whose bytes were not handed in', async () => {
  await assert.rejects(
    hearSourcesTool({ sources: [{ source: 'microphone', path: 'call.m4a' }], model_path: '/m.bin', whisper_cli: fakeWhisper, ffmpeg: fakeFfmpeg }, { settings: sourcesSettings(), scratch: folder }),
    /was not handed in: its bytes come in as stored.files/,
  );
});

test('tool:hear-sources refuses a recording over the most bytes one run takes, and takes one at the limit', async () => {
  const bytes = Buffer.from('12345');
  const call = (most_bytes, name) => hearSourcesTool(
    { sources: [{ source: 'microphone', path: name }], stored: { files: { [name]: { base64: bytes.toString('base64') } } }, model_path: '/m.bin', whisper_cli: fakeWhisper, ffmpeg: fakeFfmpeg },
    { settings: sourcesSettings(), scratch: folder, file: path.join(folder, 'limit-sessions.json'), most_bytes },
  );
  await assert.rejects(call(4, 'over.m4a'), /5 bytes, more than one run takes \(4\)/);
  const { words } = await call(5, 'at-limit.m4a');
  assert.equal(words.length, 2);
});

test('a special token is dropped, as transcribe-audio.py drops it', () => {
  const rows = wordRows({ transcription: [
    { offsets: { from: 0, to: 80 }, text: ' [_BEG_]' },
    { offsets: { from: 80, to: 160 }, text: ' <|en|>' },
    { offsets: { from: 160, to: 300 }, text: ' Hello' },
  ] });
  assert.deepEqual(rows.map(row => row.text), ['Hello']);
});

test('a punctuation token is kept, as the old path kept it', () => {
  const rows = wordRows({ transcription: [{ offsets: { from: 10, to: 80 }, text: ' -' }, { offsets: { from: 80, to: 200 }, text: ' Yes,' }] });
  assert.deepEqual(rows.map(row => row.text), ['-', 'Yes,']);
});

test('an empty token is dropped', () => {
  const rows = wordRows({ transcription: [{ offsets: { from: 0, to: 10 }, text: '   ' }, { offsets: { from: 10, to: 20 }, text: '' }, { offsets: { from: 20, to: 40 }, text: ' Hi' }] });
  assert.deepEqual(rows.map(row => row.text), ['Hi']);
});
