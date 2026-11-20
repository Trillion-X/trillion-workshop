// Each sign-in's calls are counted as they are admitted: past its tier's limit a call is refused with when to ask again;
// the count is by sign-in so another sign-in is never slowed; the tier is DATA picked by the plan's accesses, what signed
// in and how it was approved; and the counts shown to a person are the limit and the last minute's use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allLastMinute, callerOfProps, callsTier, callsWords, lastMinute, noteCall, refusalFor, SIGN_IN_CALLS,
} from '../read-data/call-limits.mjs';

const settings = SIGN_IN_CALLS;
const tierOf = id => settings.tiers.find(tier => tier.id === id);

test('a call past its tier\'s limit is refused with the words, the status and Retry-After; the limit itself still goes', () => {
  const tier = tierOf('weaker');
  assert.equal(refusalFor({ tier, count: tier.limit }), null, 'the last call inside the limit goes');
  const refused = refusalFor({ tier, count: tier.limit + 1 });
  assert.equal(refused.status, 429);
  assert.equal(refused.retry_after, String(settings.retry_after_seconds));
  assert.equal(refused.body.retry_after_seconds, settings.retry_after_seconds);
  assert.equal(refused.body.error, 'This sign-in made more than 300 calls in 60 seconds. Wait a minute, or ask for several things in one call.');
});

test('the tier follows the plan, what signed in and how it was approved, all as DATA', () => {
  assert.equal(callsTier().id, 'standard', 'nothing known: the default');
  assert.equal(callsTier({ holds: ['access:decision-kept'], caller: 'key', approved_by: 'key' }).id, 'plan');
  assert.equal(callsTier({ holds: ['access:decision-kept'], caller: 'app', approved_by: 'email' }).id, 'weaker', 'an app approved by an emailed code stays careful even on the plan');
  assert.equal(callsTier({ caller: 'app', approved_by: 'passkey' }).id, 'standard');
  assert.equal(callsTier({ caller: 'app' }).id, 'standard', 'an app with no approval named is not in the weaker list');
  assert.equal(callerOfProps({ key_id: 'k' }), 'key');
  assert.equal(callerOfProps({ client_id: 'c' }), 'app');
  assert.equal(callerOfProps({}), 'account');
});

test('the default rule is last and every rule names a tier that exists', () => {
  const last = settings.rules.at(-1);
  assert.equal(last.when, undefined, 'the last rule has no when, so it always holds');
  assert.ok(settings.rules.every(rule => tierOf(rule.tier)), 'every rule names a tier');
  assert.ok(settings.tiers.every(tier => tier.limit / tier.period_seconds <= 50), 'no tier lets one sign-in run more than 50 calls a second');
});

test('counts are by sign-in, a new minute restarts a sign-in, and an idle sign-in shows no use', () => {
  let counts = new Map();
  const start = Date.parse('2026-10-05T12:00:10Z');
  counts = noteCall(counts, 'key:a', start);
  counts = noteCall(counts, 'key:a', start);
  counts = noteCall(counts, 'grant:b', start);
  assert.equal(lastMinute(counts, 'key:a', start), 2);
  assert.equal(lastMinute(counts, 'grant:b', start), 1, 'another sign-in is counted apart');
  const nextMinute = start + 60_000;
  assert.equal(lastMinute(counts, 'key:a', nextMinute), 2, 'just after the minute turns the last minute still shows');
  counts = noteCall(counts, 'key:a', nextMinute);
  assert.equal(lastMinute(counts, 'key:a', nextMinute), 1);
  const later = start + 180_000;
  assert.deepEqual(allLastMinute(counts, later), {}, 'an idle sign-in shows no use');
});

test('a call changes no earlier count: the answer is a new Map', () => {
  const before = noteCall(new Map(), 'key:a', 0);
  const after = noteCall(before, 'key:a', 0);
  assert.equal(before.get('key:a').count, 1, 'the earlier map is not changed');
  assert.equal(after.get('key:a').count, 2);
});

test('a full count keeps the sign-ins already counted and drops the oldest new one', () => {
  let counts = new Map();
  counts = noteCall(counts, 'a', 1, 2);
  counts = noteCall(counts, 'b', 2, 2);
  counts = noteCall(counts, 'c', 3, 2);
  assert.equal(lastMinute(counts, 'a', 3), 0, 'the oldest is forgotten');
  assert.equal(lastMinute(counts, 'b', 3), 1);
  assert.equal(lastMinute(counts, 'c', 3), 1);
  counts = noteCall(counts, 'b', 4, 2);
  assert.equal(lastMinute(counts, 'b', 4), 2, 'an existing sign-in is counted when the map is full, not evicted');
});

test('Connections says the limit and the last minute\'s use', () => {
  const tier = { limit: 1200 };
  assert.equal(callsWords(tier, 0), 'Up to 1,200 calls a minute');
  assert.equal(callsWords(tier, 37), 'Up to 1,200 calls a minute · 37 in the last minute');
});
