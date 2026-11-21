// The reading's settings from the framework rows (src/settings-from-rows.mjs). The rows are made up here: the person's own
// texts never go in the repository. The order each row keeps is the order the reading walks it in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { awarenessSettingsOf } from '../src/settings-from-rows.mjs';

const scalars = JSON.parse(readFileSync(new URL('../src/awareness-settings.json', import.meta.url), 'utf8'));
const rows = [
  { id: 'record:awareness-framework:stages--focus', ask: 'Where focus goes.', label: 'Focus', choices: null, extra: '{"id":"focus","order":1}' },
  { id: 'record:awareness-framework:stages--awareness', ask: 'What is happening.', label: 'Happening', choices: null, extra: '{"id":"awareness","order":0}' },
  { id: 'record:awareness-framework:traits--values', ask: 'A value.', label: 'Values', choices: null, extra: '{"id":"values","order":0}' },
  { id: 'record:awareness-framework:pursuit_judgements--worthwhile', ask: 'Worth it?', label: 'Worthwhile', choices: '[{"id":"yes","label":"Yes","tone":"good"}]', extra: '{"id":"worthwhile","order":0}' },
  { id: 'record:awareness-framework:settings--words', ask: null, label: null, choices: null, extra: '{"id":"words","value":{"heading":"Awareness"}}' },
];

test('the stages are walked in their order, and each keeps its own id, label and ask', () => {
  const settings = awarenessSettingsOf({ scalars, rows });
  assert.deepEqual(settings.stages, [
    { id: 'awareness', label: 'Happening', ask: 'What is happening.' },
    { id: 'focus', label: 'Focus', ask: 'Where focus goes.' },
  ]);
});

test('traits and judgements come from their rows; a judgement keeps its choices', () => {
  const settings = awarenessSettingsOf({ scalars, rows });
  assert.deepEqual(settings.traits, [{ id: 'values', label: 'Values', ask: 'A value.' }]);
  assert.deepEqual(settings.pursuit_judgements, [{ id: 'worthwhile', label: 'Worthwhile', ask: 'Worth it?', choices: [{ id: 'yes', label: 'Yes', tone: 'good' }] }]);
});

test('a settings section comes from its row, and the scalars stay as the DATA says', () => {
  const settings = awarenessSettingsOf({ scalars, rows });
  assert.deepEqual(settings.words, { heading: 'Awareness' });
  assert.equal(settings.every_minutes, scalars.every_minutes);
  assert.equal(settings.readings_per_day, scalars.readings_per_day);
});
