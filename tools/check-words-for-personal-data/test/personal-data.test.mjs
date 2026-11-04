// tools/check-words-for-personal-data/test/personal-data.test.mjs (moved from Trillion test/personal-data.test.mjs)
// Words are checked on this Mac for personal data before they go to a model that is not here (F-0308, F-0761).
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPersonalData, luhn } from '../read-data/personal-data.mjs';

const noModel = async () => ({ error: 'no model here answered' });

test('rules find emails, valid card numbers and national ids, never a card number that fails the checksum, and answer counts only', async () => {
  const text = 'Mail jo@example.org or jo2@example.org. Card 4111 1111 1111 1111 and not 4111 1111 1111 1112. SSN 123-45-6789.';
  const answer = await checkPersonalData({ text }, { ask: noModel });
  const by = Object.fromEntries(answer.kinds.map(row => [row.kind, row]));
  assert.equal(by['email-address'].count, 2);
  assert.equal(by['payment-card'].count, 1);
  assert.equal(by['us-social-security-number'].count, 1);
  assert.equal(answer.model_checked, false);
  assert.match(answer.said, /only the shapes found by rule were checked/);
  assert.deepEqual(answer.choices.map(choice => choice.id), ['share', 'local', 'keep']);
  assert.doesNotMatch(JSON.stringify(answer), /example\.org|4111|6789/);
  assert.equal(luhn('4111111111111111'), true);
  console.log('readback:', JSON.stringify(answer.kinds), '|', answer.said);
});

test('the model on this Mac adds kinds at or above the threshold; clean words offer no choice', async () => {
  const ask = async body => ({ answers: Object.fromEntries(Object.keys(body.questions).map(kind => [kind, { type: 'noul', noul: kind === 'health-details' ? 0.9 : 0.2 }])) });
  const answer = await checkPersonalData({ text: 'She was told to rest after the surgery.' }, { ask });
  assert.deepEqual(answer.kinds, [{ kind: 'health-details', how: 'model', share: 0.9 }]);
  assert.equal(answer.model_checked, true);
  const clean = await checkPersonalData({ text: 'The weather is mild today.' }, { ask: async body => ({ answers: Object.fromEntries(Object.keys(body.questions).map(kind => [kind, { noul: 0.01 }])) }) });
  assert.equal(clean.contains, false);
  assert.deepEqual(clean.choices, []);
  await assert.rejects(checkPersonalData({ text: '  ' }), /Give the words to check/);
});
