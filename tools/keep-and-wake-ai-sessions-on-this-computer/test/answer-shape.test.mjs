// test/answer-shape.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerIssue, uncheckable, UnsupportedSchema } from '../harness/answer-shape.mjs';

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
  assert.throws(() => answerIssue({ word: 'ready' }, { if: { type: 'object' } }), UnsupportedSchema);
  assert.throws(() => answerIssue({ word: 'ready' }, { type: 'object', properties: { word: { format: 'email' } } }), UnsupportedSchema);
  assert.throws(() => answerIssue({ word: 'ready' }, { type: 'object', additionalProperties: { type: 'string' } }), UnsupportedSchema);
  assert.throws(() => answerIssue('x', { type: 'string', pattern: '(' }), UnsupportedSchema);
});

test('lengths, patterns, item counts and bounds are checked as JSON Schema means them, and annotations constrain nothing', () => {
  const TEXT = { type: 'string', minLength: 3, maxLength: 5, description: 'a short word', title: 'Word' };
  assert.equal(answerIssue('abc', TEXT), null);
  assert.equal(answerIssue('ab', TEXT), 'result must be at least 3 characters, not 2');
  assert.equal(answerIssue('abcdef', TEXT), 'result must be at most 5 characters, not 6');
  assert.equal(answerIssue('héé', TEXT), null, 'characters, not bytes');
  assert.equal(answerIssue('2026-11-22', { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), null);
  assert.equal(answerIssue('Nov 22', { type: 'string', pattern: '^\\d{4}' }), 'result must match ^\\d{4}');
  const LIST = { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', minLength: 1 } };
  assert.equal(answerIssue(['a'], LIST), null);
  assert.equal(answerIssue([], LIST), 'result must hold at least 1 items, not 0');
  assert.equal(answerIssue(['a', 'b', 'c'], LIST), 'result must hold at most 2 items, not 3');
  assert.equal(answerIssue([''], LIST), 'result[0] must be at least 1 characters, not 0');
  assert.equal(answerIssue(5, { type: 'number', minimum: 1, maximum: 4 }), 'result must be at most 4, not 5');
  assert.equal(answerIssue(0, { type: 'integer', minimum: 1 }), 'result must be at least 1, not 0');
});

test('anyOf takes any fitting shape and oneOf exactly one', () => {
  const EITHER = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
  assert.equal(answerIssue('a', EITHER), null);
  assert.equal(answerIssue(true, EITHER), 'result must fit one of its 2 allowed shapes');
  const ONE = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
  assert.equal(answerIssue(1.5, ONE), null);
  assert.equal(answerIssue(2, ONE), 'result must fit exactly one of its 2 shapes, not 2');
});

test('uncheckable reads a schema alone: null when every keyword at every depth is checked, else the first keyword it is not', () => {
  const STEP = { type: 'object', required: ['links'], properties: { links: { type: 'array', minItems: 1, items: { type: 'object', properties: { url: { type: 'string', minLength: 1, description: 'the address' } }, additionalProperties: false } } } };
  assert.equal(uncheckable(STEP), null);
  assert.equal(uncheckable({ type: 'object', properties: { at: { type: 'string', format: 'date-time' } } }), 'the step\'s submit names the keyword "format", which this computer does not check');
  assert.match(uncheckable({ oneOf: [{ type: 'string' }, { not: {} }] }), /keyword "not"/);
  assert.match(uncheckable({ type: 'object', additionalProperties: { type: 'string' } }), /additionalProperties \(a schema\)/);
  assert.match(uncheckable({ type: 'strings' }), /type strings/);
});
