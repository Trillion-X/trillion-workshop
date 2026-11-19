// The credit reward kind: a referrer's customer credit for each sale, keyed by the credit's id, and a friend's one-time
// discount. Each tool runs as its row runs it, with no records door; a made-up bakery's rule rows and a made-up sale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf as run, rowOf } from '../../../test-helpers/run-a-row.mjs';
import records from '../records.json' with { type: 'json' };
import { readRewardRules } from '../read-data/referral-reward-rules.mjs';

const rows = { records: records.things };
const give = rowOf(rows, 'tool:give-referral-rewards');

const answerOf = async (row, input, { records = [] } = {}) => {
  const { result, ...ran } = await run(row, { ...input, rules: records }, {});
  assert.deepEqual(ran.calls ?? [], [], 'no records door is handed to the run');
  return { ...result, ...ran };
};

const rule = (id, value) => ({ id: `referral-reward-rule:${id}`, type: 'record:referral-reward-rule', value: { state: 'active', code_points_at: 'product_id', ...value } });
const referrerCredit = rule('referrer-credit', { label: 'Twenty-five off the next invoice', earner: 'referrer', reward: 'credit', amount_cents: 2500, currency: 'USD', offer_ids: ['offer:loaf'] });
const friendOnce = rule('friend-once', { label: 'Twenty-five off the first month', earner: 'friend', reward: 'discount', amount_cents: 2500, currency: 'usd', duration: 'once', offer_ids: ['offer:loaf'] });

const created = { kind: 'referral_code_created', subject: 'ada@example.com', material: { event_type: 'referral_code_created', referral_code: 'LOAF-1234', target: { on: 'product_id', value: 'loaf' }, occurred_at: '2026-01-01T00:00:00Z' } };
const sale = { id: 'sale-1', product_id: 'loaf', offer_id: 'offer:loaf', amount_cents: 9900, buyer: 'bo@example.com', occurred_at_ms: Date.UTC(2026, 5, 1) };

test('a referrer credit is one customer credit per sale, keyed by its id and named to the referrer', async () => {
  const input = { events: [created], codes: ['loaf-1234'], sales: [sale, sale] };
  const answer = await answerOf(give, input, { records: [referrerCredit] });
  assert.equal(answer.status, 0, answer.error);
  const id = 'credit:referral:referral-reward-rule:referrer-credit:sale-1';
  assert.deepEqual(answer.credits, [{ id, subject: 'ada@example.com', amount_cents: 2500, currency: 'usd', description: 'Twenty-five off the next invoice' }]);
  assert.deepEqual(answer.credits_refused, []);
  assert.deepEqual(answer.rows, { adjustments: [], access_grants: [] }, 'a credit is not a row the store keeps');

  const again = await answerOf(give, input, { records: [referrerCredit] });
  assert.deepEqual(again.credits, answer.credits, 'asking again gives the same credit');
});

test('a credit needs the sale id, so it is given once; a sale with no id is refused in the answer with why', async () => {
  const answer = await answerOf(give, { events: [created], codes: ['LOAF-1234'], sales: [{ ...sale, id: undefined }] }, { records: [referrerCredit] });
  assert.deepEqual(answer.credits, []);
  const [item] = answer.checked[0].rewards;
  assert.equal(item.reward, 'credit');
  assert.equal(item.refused, 'the sale needs an id so the reward is given once');
});

test('a credit goes to the referrer only, and needs whole cents above 0 and a currency', () => {
  const read = readRewardRules([
    rule('friend-credit', { label: 'x', earner: 'friend', reward: 'credit', amount_cents: 2500, currency: 'usd' }),
    rule('zero-credit', { label: 'x', earner: 'referrer', reward: 'credit', amount_cents: 0, currency: 'usd' }),
    rule('no-currency', { label: 'x', earner: 'referrer', reward: 'credit', amount_cents: 2500 }),
    rule('good-credit', { label: 'x', earner: 'referrer', reward: 'credit', amount_cents: 2500, currency: 'usd' }),
  ]);
  assert.deepEqual(read.rules.map(item => item.id), ['referral-reward-rule:good-credit']);
  assert.deepEqual(read.refused.map(item => item.id), ['referral-reward-rule:friend-credit', 'referral-reward-rule:zero-credit', 'referral-reward-rule:no-currency']);
  const problemsOf = id => read.refused.find(item => item.id === id).problems;
  assert.deepEqual(problemsOf('referral-reward-rule:friend-credit'), ['a credit goes to the referrer, on their next invoice']);
  assert.deepEqual(problemsOf('referral-reward-rule:zero-credit'), ['a credit needs amount_cents, a whole number of cents above 0']);
  assert.deepEqual(problemsOf('referral-reward-rule:no-currency'), ['a credit needs currency, a three-letter code']);
});

test('a friend discount that lasts once is the checkout code row take-payments takes off the first invoice only', async () => {
  const answer = await answerOf(give, { events: [created], codes: ['LOAF-1234'] }, { records: [friendOnce] });
  assert.equal(answer.status, 0, answer.error);
  assert.equal(answer.rows.adjustments.length, 1);
  const [row] = answer.rows.adjustments;
  assert.equal(row.value.duration, 'once');
  assert.deepEqual(row.value.adjustment, { kind: 'amount_cents', amount_cents: 2500, currency: 'usd' });
  assert.deepEqual(row.value.applies_to, { offer_ids: ['offer:loaf'] });
  assert.deepEqual(answer.credits, [], 'the friend gets a discount, not a credit');
});
