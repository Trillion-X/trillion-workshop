// tools/where-a-person-stands/read-data/stance-facts.mjs: where a person stands on one record, from the stand kept on it
// and the stand rows. Each case is the record's stand as the decision screen reads it: the current stand, a stand on an
// earlier version, a stand taken back, a stand with words of why, and a stand row this owner adds (partly).
import test from 'node:test';
import assert from 'node:assert/strict';
import { stanceFacts } from '../read-data/stance-facts.mjs';
import stanceData from '../read-data/stances.json' with { type: 'json' };

const { stances } = stanceData;
const AT = '2026-11-20T10:00:00.000Z';
const choiceIds = facts => facts.choices.map(choice => choice.id);
const primaries = facts => facts.choices.filter(choice => choice.primary).map(choice => choice.id);

test('no stand kept: nothing said, no status, no stand chosen, every stand offered', () => {
  const facts = stanceFacts({ record: { decision_generation: 1 }, stance: null, stances });
  assert.deepEqual(facts, {
    said: null,
    earlier_said: null,
    why: null,
    detailed: false,
    status: null,
    choices: [
      { id: 'agree', label: 'I agree', icon: 'ThumbsUp', primary: false },
      { id: 'disagree', label: 'I disagree', icon: 'ThumbsDown', primary: false },
      { id: 'partly', label: 'Partly', icon: null, primary: false },
    ],
  });
});

test('a stand taken on the current version is said, toned and chosen, with its why', () => {
  const facts = stanceFacts({
    record: { decision_generation: 2 },
    stance: { stance: 'disagree', at: AT, why: 'the options were not weighed', decision_generation: 2 },
    stances,
  });
  assert.equal(facts.said, 'You disagree with this.');
  assert.equal(facts.earlier_said, null);
  assert.equal(facts.why, 'the options were not weighed');
  assert.equal(facts.detailed, true);
  assert.deepEqual(facts.status, { at: AT, tone: 'attention' });
  assert.deepEqual(primaries(facts), ['disagree']);
});

test('a stand with no why on the current version is not detailed', () => {
  const facts = stanceFacts({ record: {}, stance: { stance: 'agree', at: AT }, stances });
  assert.equal(facts.said, 'You agree with this.');
  assert.equal(facts.why, null);
  assert.equal(facts.detailed, false);
  assert.deepEqual(facts.status, { at: AT, tone: 'good' });
  assert.deepEqual(primaries(facts), ['agree']);
});

test('a stand taken on an earlier version is said as earlier, is not the primary choice, and is detailed', () => {
  const facts = stanceFacts({
    record: { decision_generation: 3 },
    stance: { stance: 'agree', at: AT, decision_generation: 2 },
    stances,
  });
  assert.equal(facts.said, null);
  assert.equal(facts.earlier_said, 'You agree with this.');
  assert.equal(facts.detailed, true);
  assert.deepEqual(facts.status, { at: AT, tone: 'good' }, 'the status tone is still the stand row\'s');
  assert.deepEqual(primaries(facts), []);
});

test('a record with no decision generation counts as generation 1, so a stand on generation 1 is current', () => {
  const current = stanceFacts({ record: {}, stance: { stance: 'agree', at: AT, decision_generation: 1 }, stances });
  assert.equal(current.said, 'You agree with this.');
  assert.equal(current.earlier_said, null);
  const earlier = stanceFacts({ record: {}, stance: { stance: 'agree', at: AT, decision_generation: 2 }, stances });
  assert.equal(earlier.said, null);
  assert.equal(earlier.earlier_said, 'You agree with this.');
});

test('a stand with no decision generation is never earlier', () => {
  const facts = stanceFacts({ record: { decision_generation: 5 }, stance: { stance: 'partly', at: AT }, stances });
  assert.equal(facts.said, 'You partly agree with this.');
  assert.equal(facts.earlier_said, null);
  assert.deepEqual(primaries(facts), ['partly']);
});

test('a stand taken back (no stand row) is said by nothing and chooses nothing', () => {
  const facts = stanceFacts({ record: {}, stance: { stance: null, at: AT, why: 'changed my mind' }, stances });
  assert.equal(facts.said, null);
  assert.equal(facts.earlier_said, null);
  assert.equal(facts.why, 'changed my mind');
  assert.equal(facts.detailed, true);
  assert.equal(facts.status, null);
  assert.deepEqual(primaries(facts), []);
});

test('a stand whose id is not a stand row says nothing and gives no status', () => {
  const facts = stanceFacts({ record: {}, stance: { stance: 'unknown', at: AT }, stances });
  assert.equal(facts.said, null);
  assert.equal(facts.status, null);
  assert.equal(facts.detailed, false);
  assert.deepEqual(primaries(facts), []);
});

test('the choices follow the stand rows in order, one per row, whatever the stand', () => {
  const facts = stanceFacts({ record: {}, stance: { stance: 'partly', at: AT }, stances });
  assert.deepEqual(choiceIds(facts), ['agree', 'disagree', 'partly']);
  assert.deepEqual(primaries(facts), ['partly']);
});

test('the stand rows keep the words and tone the old owner had, and add partly', () => {
  const byId = Object.fromEntries(stances.map(row => [row.id, row]));
  assert.equal(byId.agree.said, 'You agree with this.');
  assert.equal(byId.agree.label, 'I agree');
  assert.equal(byId.agree.tone, 'good');
  assert.equal(byId.disagree.said, 'You disagree with this.');
  assert.equal(byId.disagree.label, 'I disagree');
  assert.equal(byId.disagree.tone, 'attention');
  assert.equal(byId.partly.tone, undefined, 'partly has no tone: the old owner (src/record-stance.json) names none');
  for (const row of stances.filter(row => row.id !== 'partly')) assert.ok(row.id && row.label && row.said && row.tone, `row ${row.id} has every word and its tone`);
});
