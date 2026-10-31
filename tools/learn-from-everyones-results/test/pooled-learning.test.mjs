// Ported from the old app's test/pooled-learning.test.mjs. Everyone's results teach the pool while no one's result is
// readable: noise is added in the person's store, answers need a minimum of people, repeated questions get the same
// noise, poisoned shards cannot move the answer, a withdrawal changes only what it removes, and a candidate choice is
// promoted only past a noise-aware bar. The rules are the pool's settings as the old app shipped them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateOnRead, armFor, debias, promotedArm, randomizedResponse, shardOf, truthProbability } from '../read-data/pooled-learning.mjs';

const rules = { epsilon: 1.0986, min_people: 10, shards: 16, query_epsilon: 1, people_bucket: 5, share_step: 0.05 };
let seed = 7;
const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
// n people, a share of whom it worked for, each sending one randomized bit from their own store.
const people = (n, workedShare, prefix = 'p') => Array.from({ length: n }, (_, index) => {
  const contributor = `${prefix}${index}`;
  return { contributor, shard: shardOf(contributor, rules.shards), worked: randomizedResponse(index < n * workedShare, rules.epsilon, random()) };
});
const ask = { question: 'q', version: 'v1' };

test('the bit that leaves a store is the truth only with probability 3/4, and the pool recovers the share from many', () => {
  assert.ok(Math.abs(truthProbability(rules.epsilon) - 0.75) < 0.001);
  const rows = people(20000, 0.3);
  const reported = rows.filter(row => row.worked).length / rows.length;
  assert.ok(Math.abs(debias(reported, rules.epsilon) - 0.3) < 0.02, `recovered ${debias(reported, rules.epsilon)}`);
});

test('under the minimum number of people there is no answer at all', () => {
  assert.deepEqual(aggregateOnRead(people(rules.min_people - 1, 1), rules, ask), { enough: false, people_at_least: 5 });
  assert.equal(aggregateOnRead(people(rules.min_people, 1), rules, ask).enough, true);
});

test('one person sending many results counts once', () => {
  const honest = people(400, 0.2);
  const flood = Array.from({ length: 5000 }, () => ({ contributor: 'loud', shard: shardOf('loud', rules.shards), worked: true }));
  const clean = aggregateOnRead(honest, rules, ask).worked_share;
  assert.equal(aggregateOnRead([...honest, ...flood], rules, ask).people_at_least, 400);
  assert.ok(Math.abs(aggregateOnRead([...honest, ...flood], rules, ask).worked_share - clean) <= 0.05);
});

test('fake people filling a few shards move the median far less than they move a plain average', () => {
  const honest = people(1600, 0.2);
  const poisonedShards = new Set([0, 1, 2]);
  const fakes = Array.from({ length: 4000 }, (_, index) => `fake${index}`).filter(id => poisonedShards.has(shardOf(id, rules.shards))).map(contributor => ({ contributor, shard: shardOf(contributor, rules.shards), worked: true }));
  const robust = aggregateOnRead([...honest, ...fakes], rules, ask).worked_share;
  const all = [...honest, ...fakes];
  const plain = debias(all.filter(row => row.worked).length / all.length, rules.epsilon);
  assert.ok(Math.abs(robust - 0.2) <= 0.1, `median answer ${robust}`);
  assert.ok(plain > 0.4, `a plain average is dragged to ${plain}`);
});

test('the same question over the same pool gets the same answer; a withdrawal changes the version and the rows', () => {
  const rows = people(60, 0.5);
  assert.deepEqual(aggregateOnRead(rows, rules, ask), aggregateOnRead(rows, rules, ask));
  const without = rows.filter(row => row.contributor !== 'p0');
  assert.equal(aggregateOnRead(without, rules, { question: 'q', version: 'v2' }).people_at_least, 55);
});

const choice = { id: 'rewrite_model', control: 'a', candidates: ['b'], min_trials: 30, promote_at_z: 3, guardrail_margin: 0.02 };
test('a candidate is promoted only when it clearly wins and its guardrail holds', () => {
  assert.equal(promotedArm(choice, { a: { trials: 400, successes: 200, guardrail_hits: 40 }, b: { trials: 400, successes: 320, guardrail_hits: 40 } }), 'b');
  assert.equal(promotedArm(choice, { a: { trials: 400, successes: 200, guardrail_hits: 40 }, b: { trials: 400, successes: 215, guardrail_hits: 40 } }), 'a', 'a small gain is treated as noise');
  assert.equal(promotedArm(choice, { a: { trials: 400, successes: 200, guardrail_hits: 40 }, b: { trials: 400, successes: 320, guardrail_hits: 80 } }), 'a', 'a worse guardrail blocks promotion');
  assert.equal(promotedArm(choice, { a: { trials: 10, successes: 1, guardrail_hits: 0 }, b: { trials: 10, successes: 10, guardrail_hits: 0 } }), 'a', 'too few trials');
  assert.equal(armFor(choice, 'case-1'), armFor(choice, 'case-1'));
});
