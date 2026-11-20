// test/answer-shape.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerIssue, UnsupportedSchema } from '../harness/answer-shape.mjs';

const WORD = { type: 'object', required: ['word'], properties: { word: { type: 'string', enum: ['ready'] } }, additionalProperties: false };

test('an answer that matches the submit shape passes', () => {
  assert.equal(answerIssue({ word: 'ready' }, WORD), null);
});

test('an answer that breaks the enum, a required field, a type or an extra field is refused, and says where', () => {
  assert.equal(answerIssue({ word: 'blue' }, WORD), 'result.word must be one of "ready"');
  assert.equal(answerIssue({}, WORD), 'result.word is required');
  assert.equal(answerIssue('ready', WORD), 'result must be object, not string');
  assert.equal(answerIssue({ word: 'ready', extra: 1 }, WORD), 'result.extra is not allowed');
  assert.equal(answerIssue(null, WORD), 'result must be object, not null');
});

test('integer, number, boolean, null, arrays of types and items are checked', () => {
  assert.equal(answerIssue(3, { type: 'integer' }), null);
  assert.match(answerIssue(3.5, { type: 'integer' }), /must be integer, not number/);
  assert.equal(answerIssue(null, { type: ['string', 'null'] }), null);
  assert.equal(answerIssue(true, { type: 'boolean' }), null);
  assert.equal(answerIssue(['a', 'b'], { type: 'array', items: { type: 'string' } }), null);
  assert.equal(answerIssue(['a', 2], { type: 'array', items: { type: 'string' } }), 'result[1] must be string, not integer');
});

test('a schema keyword this computer does not check is refused by name, never passed', () => {
  assert.throws(() => answerIssue({ word: 'ready' }, { oneOf: [] }), UnsupportedSchema);
  assert.throws(() => answerIssue({ word: 'ready' }, { type: 'object', properties: { word: { pattern: 'r' } } }), UnsupportedSchema);
  assert.throws(() => answerIssue({ word: 'ready' }, { type: 'object', additionalProperties: { type: 'string' } }), UnsupportedSchema);
});
