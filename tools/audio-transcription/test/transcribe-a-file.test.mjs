// tools/audio-transcription/test/transcribe-a-file.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { keepTranscript } from '../read-data/keep-transcript.mjs';
import { MODEL_REPO, transcribeAFile, transcriptOfHeard } from '../read-data/transcribe-a-file.mjs';

const IDENTITY = `1f:${'ab'.repeat(32)}`;

test('a word or segment without finite times is dropped, and Whisper control tokens are not words', () => {
  const heard = {
    full_text: ' Hello there ',
    language: 'en',
    segments: [
      { start: 0, end: 1.5, text: ' Hello there ', words: [
        { word: ' Hello', start: 0, end: 0.5 },
        { word: '[_BEG_]', start: 0, end: 0 },
        { word: ' there', start: 0.6, end: NaN },
        { word: ' there', start: 0.6, end: 1.2 },
      ] },
      { start: NaN, end: 2, text: 'lost', words: [] },
    ],
  };
  const answer = transcriptOfHeard(heard);
  assert.equal(answer.text, 'Hello there');
  assert.equal(answer.language, 'en');
  assert.equal(answer.segments.length, 1);
  assert.deepEqual(answer.segments[0].words.map(word => word.word), ['Hello', 'there']);
  assert.equal(answer.produced_by, 'mlx_whisper');
});

test('a recording is refused without a file, in words', async () => {
  await assert.rejects(transcribeAFile({}, {}), error => error.status === 400 && /Give `file`/.test(error.message));
});

test('a recording is heard as a copy, the copy is removed, and the answer says it was heard whole', async () => {
  const seen = [];
  const host = { readWholeFile: async () => ({ title: 'clip.m4a', size: 4, bytes: Buffer.from('mock') }) };
  const hear = async (file, { language }) => {
    seen.push({ file, language });
    return { text: 'ok', segments: [{ start: 0, end: 1, text: 'ok', words: [] }], language: 'en', produced_by: 'mlx_whisper' };
  };
  const answer = await transcribeAFile({ file: 'clip.m4a', language: 'en' }, host, { hear });
  assert.equal(answer.heard_whole, true);
  assert.equal(answer.text, 'ok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].language, 'en');
  assert.equal(existsSync(seen[0].file), false);
  assert.equal(MODEL_REPO, 'mlx-community/whisper-small-mlx');
});

test('a transcript is kept under its recording identity, and never without one', () => {
  const transcript = { text: 'ok', segments: [], language: 'en', produced_by: 'mlx_whisper' };
  const list = keepTranscript({ identity: IDENTITY, transcript });
  assert.deepEqual(list.keep, [{ id: IDENTITY, type: 'transcript', value: { identity: IDENTITY, ...transcript }, expected: null }]);
  assert.throws(() => keepTranscript({ identity: 'clip.m4a', transcript }), /Give `identity`/);
  assert.throws(() => keepTranscript({ identity: IDENTITY }), /Give `transcript`/);
});
