// Progress's facts from the account's screen (read-data/progress-facts.mjs). The screen is made up here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { progressFacts, pursuitStatus } from '../read-data/progress-facts.mjs';

const origin = { offer: 'A made-up plan', price: '0', url: 'https://example.com/pay' };
const pursuits = [
  { id: 'p1', title: 'Parent', now: 'a', after: 'b', status: 'active', spaces: [] },
  { id: 'p2', title: 'Child', now: 'c', after: 'd', status: 'paused', parents: ['p1'], spaces: [{ id: 's1', title: 'Work' }] },
];

test('a pursuit reads as Active, Paused or Recorded', () => {
  assert.deepEqual([pursuitStatus('active'), pursuitStatus('paused'), pursuitStatus('done')], ['Active', 'Paused', 'Recorded']);
});

test('a paying account gets the waiting decisions with their links, and the pursuits as a tree', () => {
  const facts = progressFacts({ origin, screen: {
    free: false, summaries: [{ case_id: 'source:x', goal: 'Choose', outcome_question: 'Did it work?' }, { case_id: 'source:y', goal: 'Plan' }],
    pursuits, pursuits_words: { measured: false }, space_pursuits: [{ space_id: 's1', item_id: 'i1', title: 'Item', body: { now: 'n' } }],
  }, sections_after: [{ heading: 'Made up' }] });
  assert.equal(facts.decisions, 2);
  assert.equal(facts.waiting_count, 1);
  assert.deepEqual(facts.waiting, [{ case_id: 'source:x', goal: 'Choose', question: 'Did it work?', href: '/decisions/source%3Ax' }]);
  assert.equal(facts.invite, null);
  assert.deepEqual(facts.pursuits.map(row => [row.title, row.under, row.status]), [['Parent', null, 'Active'], ['↳ Child', 'Parent', 'Paused']]);
  assert.deepEqual(facts.space_pursuits, [{ id: 's1:i1', title: 'Item', now: 'n', after: null, open: '/spaces/s1' }]);
  assert.deepEqual(facts.sections_after, [{ heading: 'Made up' }]);
});

test('with no pursuits, the invitation shows', () => {
  const facts = progressFacts({ origin, screen: { free: false, summaries: [], pursuits: [], pursuits_words: { measured: false } } });
  assert.match(facts.invite, /Nothing yet/);
});

test('a free account gets the keeps line and its allowance', () => {
  const facts = progressFacts({ origin, screen: { free: true, price_arm: 'pro', allowance: { count: 3, per: 'month', used: 1 }, space_pursuits: [] } });
  assert.equal(facts.free, true);
  assert.match(facts.lead, /Your decisions are not kept/);
  assert.match(facts.lead, /2 of 3 free decisions left this month/);
});
