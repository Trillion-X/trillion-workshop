// tools/audio-transcription/test/extract-audio.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAudioArgv } from '../read-data/extract-audio.mjs';

test('the argv takes the audio only, mono 16 kHz PCM WAV, from a share URL', () => {
  const argv = extractAudioArgv({ source: 'https://files.example/share/x', output: '/tmp/out.wav' });
  assert.deepEqual(argv, ['ffmpeg', '-v', 'error', '-y', '-i', 'https://files.example/share/x', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', '/tmp/out.wav']);
});

test('a window is a seek before the input and a duration after it', () => {
  const argv = extractAudioArgv({ source: 'a.mp4', output: 'b.wav', start: 90, seconds: 30 });
  assert.deepEqual(argv.slice(0, 7), ['ffmpeg', '-v', 'error', '-y', '-ss', '90', '-i']);
  assert.deepEqual(argv.slice(-5), ['-t', '30', '-f', 'wav', 'b.wav']);
});

test('an empty source, an empty output or a non-positive window is refused in words', () => {
  assert.throws(() => extractAudioArgv({ source: ' ', output: 'b.wav' }), /Give `source`/);
  assert.throws(() => extractAudioArgv({ source: 'a.mp4', output: '' }), /Give `output`/);
  assert.throws(() => extractAudioArgv({ source: 'a.mp4', output: 'b.wav', seconds: 0 }), /positive number/);
  assert.throws(() => extractAudioArgv({ source: 'a.mp4', output: 'b.wav', start: -1 }), /0 or more/);
});
