// tools/audio-transcription/test/transcribe-a-file.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
  await assert.rejects(transcribeAFile({ program: '/granted/python3' }, {}), error => error.status === 400 && /Give `file`/.test(error.message));
});

test('a run without the granted Python is refused in words, and nothing is heard', async () => {
  let heard = false;
  const hear = async () => { heard = true; return {}; };
  await assert.rejects(transcribeAFile({ file: 'clip.m4a' }, {}, { hear }), error => error.status === 400 && /Give `program`/.test(error.message));
  assert.equal(heard, false);
});

test('the granted Python is the one the MLX seam is started with, never a default', async () => {
  const calls = [];
  const host = { readWholeFile: async () => ({ title: 'clip.m4a', size: 4, bytes: Buffer.from('mock') }) };
  const hear = async (file, options) => { calls.push(options.python); return { text: '', segments: [], language: null, produced_by: 'mlx_whisper' }; };
  await transcribeAFile({ file: 'clip.m4a', program: '/granted/anaconda/bin/python3' }, host, { hear });
  assert.deepEqual(calls, ['/granted/anaconda/bin/python3']);
});

test('a recording is heard as a copy, the copy is removed, and the answer says it was heard whole', async () => {
  const seen = [];
  const host = { readWholeFile: async () => ({ title: 'clip.m4a', size: 4, bytes: Buffer.from('mock') }) };
  const hear = async (file, { language }) => {
    seen.push({ file, language });
    return { text: 'ok', segments: [{ start: 0, end: 1, text: 'ok', words: [] }], language: 'en', produced_by: 'mlx_whisper' };
  };
  const answer = await transcribeAFile({ file: 'clip.m4a', language: 'en', program: '/granted/python3' }, host, { hear });
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

test('the tool row requires the granted program, so a run cannot start without one', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records;
  const row = rows.find(record => record.payload.id === 'tool:transcribe-file').payload;
  assert.deepEqual(row.input_schema.required, ['file', 'program']);
  assert.ok(row.input_schema.properties.program);
  assert.deepEqual(Object.keys(row.input_schema.properties.computer.properties['start-a-program'].properties).sort(), ['environment', 'models', 'program', 'program_kind']);
  assert.doesNotMatch(JSON.stringify(row.invoke), /python3/);
});

test('the tool row declares the stored reads its run needs, as tool:hear-a-recording does', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records;
  const payload = id => rows.find(record => record.payload.id === id).payload;
  assert.deepEqual(payload('tool:transcribe-file').stored, [{ files: '/', operations: ['find_file', 'read_file'] }]);
  assert.deepEqual(payload('tool:transcribe-file').stored, payload('tool:hear-a-recording').stored);
});
