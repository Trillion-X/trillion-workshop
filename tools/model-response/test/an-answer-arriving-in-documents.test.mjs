// Ported from bitfield-packages packages/model-response (ebf06ab600, 5482a2a3c)
// to node:test: the streamed-answer folding tests and the JSON-still-arriving
// tests, asserting the same outcomes as the vitest originals.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  documentsInTheRun,
  oneAnswerFromTheRun,
  readUnfinishedJson,
  textSoFarAt,
  wordsInTheRun,
} from '../read-data/an-answer-arriving-in-documents.ts';

const PATH = ['candidates', 0, 'content', 'parts', 0, 'text'];
const DELTA_TEXT = ['delta', 'text'];

function event(text, extra = {}) {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...extra }] })}\n`;
}

function textDelta(text) {
  return `event: step.delta\ndata: ${JSON.stringify({ event_type: 'step.delta', index: 0, delta: { type: 'text', text } })}\n\n`;
}

function thoughtDelta(content) {
  return `event: step.delta\ndata: ${JSON.stringify({ event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content } })}\n\n`;
}

test('folding a run produces the same shape a single answer has, with all the words in it', () => {
  const run = event('The app ') + event('finds the ') + event('needle mover.');
  assert.deepEqual(oneAnswerFromTheRun(run, PATH), {
    candidates: [{ content: { parts: [{ text: 'The app finds the needle mover.' }] } }],
  });
});

test('folding keeps what only the last document knows, such as why it stopped', () => {
  const run = event('Half ') + event('done.', { finishReason: 'STOP' });
  const folded = oneAnswerFromTheRun(run, PATH);
  assert.equal(folded.candidates[0].finishReason, 'STOP');
  assert.equal(wordsInTheRun(run, PATH), 'Half done.');
});

test('a half written document at the end is skipped, not an error', () => {
  const run = event('Kept') + 'data: {"candidates":[{"content":{"parts":[{"text":"cut';
  assert.equal(documentsInTheRun(run).length, 1);
  assert.equal(wordsInTheRun(run, PATH), 'Kept');
});

test('an answer that never arrived folds to nothing rather than throwing', () => {
  assert.deepEqual(oneAnswerFromTheRun('', PATH), {});
  assert.deepEqual(oneAnswerFromTheRun('data: [DONE]\n', PATH), {});
});

test('folds a different answer shape from a different declared path', () => {
  const run = `data: ${JSON.stringify({ delta: { chunk: 'A' } })}\n`
    + `data: ${JSON.stringify({ delta: { chunk: 'B' } })}\n`;
  assert.deepEqual(oneAnswerFromTheRun(run, ['delta', 'chunk']), { delta: { chunk: 'AB' } });
});

test('a path naming nothing is no words rather than a wrong answer', () => {
  assert.equal(wordsInTheRun(event('x'), ['nowhere']), '');
  assert.equal(wordsInTheRun(event('x'), []), '');
});

test('shows the words of a field whose closing quote has not arrived', () => {
  assert.equal(textSoFarAt('{"reply":"What I under', ['reply']), 'What I under');
});

test('shows nothing while only the key has arrived, never the braces', () => {
  assert.equal(textSoFarAt('{"reply":', ['reply']), '');
  assert.equal(textSoFarAt('{"rep', ['reply']), '');
  assert.equal(textSoFarAt('', ['reply']), '');
});

test('decodes escapes, and holds back an escape cut in half', () => {
  assert.equal(textSoFarAt('{"reply":"Line one\\nLine \\"two\\"', ['reply']), 'Line one\nLine "two"');
  assert.equal(textSoFarAt('{"reply":"Half \\', ['reply']), 'Half ');
  assert.equal(textSoFarAt('{"reply":"Caf\\u00e9 and \\u00', ['reply']), 'Café and ');
});

test('reads past finished fields to the one being written', () => {
  const text = '{"questions":[{"id":"q-7","text":"Who pays?"}],"count":3,"reply":"Send five';
  assert.equal(textSoFarAt(text, ['reply']), 'Send five');
  assert.deepEqual(readUnfinishedJson(text), {
    questions: [{ id: 'q-7', text: 'Who pays?' }],
    count: 3,
    reply: 'Send five',
  });
});

test('does not guess a number that may still be growing', () => {
  assert.deepEqual(readUnfinishedJson('{"count":12'), {});
  assert.deepEqual(readUnfinishedJson('{"count":12,'), { count: 12 });
});

test('agrees with JSON.parse once the document is complete', () => {
  const whole = { reply: 'Done.\nNext step: ask one buyer.', questions: [{ id: 'a', kinds: ['x', 'y'] }], ok: true, none: null };
  assert.deepEqual(readUnfinishedJson(JSON.stringify(whole)), whole);
});

test('takes only text deltas, then reads the reply field out of the joined JSON', () => {
  const run = thoughtDelta('Planning the answer')
    + textDelta('{"re')
    + textDelta('ply":"Send a direct ')
    + textDelta('message to five buyers');
  const joined = wordsInTheRun(run, DELTA_TEXT);
  assert.equal(joined, '{"reply":"Send a direct message to five buyers');
  assert.equal(textSoFarAt(joined, ['reply']), 'Send a direct message to five buyers');
});

test('never goes backwards as more of the run arrives', () => {
  const parts = ['{"reply":"', 'Send ', 'a di', 'rect\\n', 'message', '"}'];
  let run = '';
  let previous = '';
  for (const part of parts) {
    run += textDelta(part);
    const now = textSoFarAt(wordsInTheRun(run, DELTA_TEXT), ['reply']);
    assert.equal(now.startsWith(previous), true);
    previous = now;
  }
  assert.equal(previous, 'Send a direct\nmessage');
});
