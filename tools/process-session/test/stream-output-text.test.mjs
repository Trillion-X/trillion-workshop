// tools/process-session/test/stream-output-text.test.mjs
//
// A stream spec's conditions are decided by the formula engine: the lines a rule matches, the text it takes, a spec read
// by chat's interpretStream too. Built on a blank stream of made-up lines; no account is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conditionHolds, extractStreamText, setStreamConditionEngine, streamConditionsLoaded } from '../read-data/stream-output-text.ts';
import { makeRowFilter } from 'trillion-workshop/tools/formula-engine/rules/filter-rows-by-rules.mjs';
import operators from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json' with { type: 'json' };
import { interpretStream } from 'trillion-workshop/tools/messages-screen/read-data/stream-parse-spec.ts';

const wasm = () => readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm')));

test('a condition throws until the engine is loaded, never guessing', () => {
  assert.equal(streamConditionsLoaded(), false);
  assert.throws(() => conditionHolds({ a: 1 }, { path: ['a'], exists: true }), /not loaded/);
});

test('conditions hold as the hand-written interpreter held them', async () => {
  const filter = makeRowFilter({ operators, wasm });
  await filter.load();
  setStreamConditionEngine(filter.holdsNow);
  assert.equal(streamConditionsLoaded(), true);
  const event = { type: 'delta', delta: { kind: 'text', n: 0, off: false }, nothing: null };
  assert.equal(conditionHolds(event, { path: ['type'], equals: 'delta' }), true);
  assert.equal(conditionHolds(event, { path: ['type'], equals: 'other' }), false);
  assert.equal(conditionHolds(event, { path: ['delta', 'kind'], equals: 'text' }), true);
  assert.equal(conditionHolds(event, { path: ['delta', 'n'], exists: true }), true);
  assert.equal(conditionHolds(event, { path: ['delta', 'off'], exists: true }), true);
  assert.equal(conditionHolds(event, { path: ['nothing'], exists: true }), false);
  assert.equal(conditionHolds(event, { path: ['missing'], exists: true }), false);
  assert.equal(conditionHolds(event, { path: ['missing'], exists: false }), true);
  assert.equal(conditionHolds(event, { path: ['nothing'], exists: false }), true);
  assert.equal(conditionHolds(event, { path: ['type'], exists: false }), false);
  assert.equal(conditionHolds(event, { path: ['type'], exists: true, equals: 'delta' }), true);
  assert.equal(conditionHolds(event, { path: ['type'], exists: true, equals: 'x' }), false);
  assert.equal(conditionHolds(event, { path: ['type'] }), true, 'no test holds');
});

test('extractStreamText takes the text of the first rule whose conditions all hold, in stream order', () => {
  const spec = {
    lineFormat: 'jsonl',
    events: [
      { when: [{ path: ['type'], equals: 'delta' }, { path: ['delta', 'text'], exists: true }], textPaths: [['delta', 'text']] },
      { when: [{ path: ['type'], equals: 'final' }], textPaths: [['text']] },
    ],
  };
  const lines = [{ type: 'delta', delta: { text: 'Hel' } }, { type: 'tool' }, { type: 'delta', delta: { other: 1 } }, { type: 'delta', delta: { text: 'lo' } }, { type: 'final', text: '!' }]
    .map(line => JSON.stringify(line)).join('\n');
  assert.equal(extractStreamText(`${lines}\n{"type":"del`, spec), 'Hello!');
});

test('chat reads the same spec shape through the same engine', () => {
  const spec = {
    lineFormat: 'jsonl',
    events: [{ when: [{ path: ['type'], equals: 'say' }], emit: { kind: 'text', textPaths: [['text']] } }],
  };
  const messages = interpretStream(`${JSON.stringify({ type: 'say', text: 'Hi there' })}\n${JSON.stringify({ type: 'noise', text: 'x' })}\n`, spec, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(messages.map(message => message.content), ['Hi there']);
});
