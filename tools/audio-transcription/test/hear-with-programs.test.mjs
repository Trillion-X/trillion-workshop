// The node hearing path (read-data/hear-with-programs.mjs) with fake ffmpeg and whisper-cli programs: ffmpeg is run to make the WAV,
// whisper-cli is run with the package's arguments and -ng, and the words come from its JSON. No Python runs.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hearWithPrograms } from '../read-data/hear-with-programs.mjs';
import { hearSourcesTool, sourcesSettings } from '../../listen-for-a-while/read-data/hearing-sources.mjs';

const folder = mkdtempSync(path.join(os.tmpdir(), 'hear-with-programs-test-'));
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
    const { words, session } = await hearSourcesTool(
      { sources: [{ source: 'microphone', path: recording }], model_path: '/m.bin', whisper_cli: fakeWhisper, ffmpeg: fakeFfmpeg },
      { settings, file: path.join(folder, 'sessions.json') },
    );
    assert.deepEqual(words.map(word => [word.speaker, word.text]), [['Me', 'Hello team.'], ['Me', 'Yes, I can hear you.']]);
    assert.equal(session.program, 'whisper-cli');
  } finally {
    if (saved === undefined) delete process.env.HEAR_TEST_DIR; else process.env.HEAR_TEST_DIR = saved;
  }
});
