// Delivery of the rows of work when an account's AI connects (do-work/work-for-ais-delivery.mjs), ported from the old owner's
// test/work-for-ais.test.mjs: one handoff per row, audiences and A/B groups, windows, triggers, the per-account cache, the
// retry after a failed handoff, the set-up and first-matches rows from the shipped DATA, the live (held) handoff, one run per
// account, the rows cache, and the cap on remembered accounts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeWorkDelivery, ACCOUNTS_KEPT } from '../do-work/work-for-ais-delivery.mjs';
import { handoffFor } from '../do-work/work-for-ais-rules.mjs';
import { NOW, DAY, HOUR, rules, matches, row, rule, group, factsFor } from './work-for-ais-fakes.mjs';

const shipped = rules.rows;
const SETUP_ROW = shipped.find(item => item.trigger === 'setup-unfinished').id;

// A fleet of accounts: each has its own facts and its own store of handoffs (idempotent by once_per), and a count of the
// facts it was asked for, so a test can show delivery never reads an account that did not connect.
function fleet(accounts, rows, { now = () => NOW, handOffResult = null } = {}) {
  const stores = new Map(Object.keys(accounts).map(id => [id, new Map()]));
  const asked = [];
  const delivery = makeWorkDelivery({
    rowsNow: async () => rows(),
    factsOf: async accountId => { asked.push(accountId); return factsFor(accountId, accounts[accountId] ?? {}); },
    matches,
    handOff: async (accountId, handoff) => {
      const store = stores.get(accountId);
      if (!store.has(handoff.once_per)) store.set(handoff.once_per, handoff);
      return handOffResult ? handOffResult(accountId, handoff) : undefined;
    },
    now,
    rules,
  });
  return { delivery, stores, asked, jobs: id => [...(stores.get(id)?.values() ?? [])].map(handoff => handoff.input.work_for_ais.row).sort() };
}

test('a row with no audience reaches everyone, once, as a handoff to whichever AI takes it first', async () => {
  const f = fleet({ a: {}, b: {} }, () => [row('hello')]);
  assert.deepEqual(await f.delivery.deliver('a'), ['hello']);
  assert.deepEqual(await f.delivery.deliver('a'), [], 'a second connection hands nothing more');
  assert.deepEqual(f.jobs('a'), ['hello']);
  const handoff = [...f.stores.get('a').values()][0];
  assert.equal(handoff.once_per, 'work-for-ais:hello');
  assert.equal(handoff.to_agent, undefined, 'no AI is named: whichever takes it first');
  assert.equal(handoff.job, 'do hello');
});

test('an audience of one account reaches that account and no other', async () => {
  const f = fleet({ a: {}, b: {} }, () => [row('just-a', { audience: group(rule('account_id', 'is_any_of', { values: ['a'] })) })]);
  await f.delivery.deliver('a'); await f.delivery.deliver('b');
  assert.deepEqual(f.jobs('a'), ['just-a']);
  assert.deepEqual(f.jobs('b'), [], 'a row for account A never reaches account B');
});

test('a cohort group and a bucket range (an A/B test) reach exactly their members', async () => {
  const rows = () => [
    row('pilot-tour', { audience: group(rule('cohorts', 'has_any_of', { values: ['pilot'] })) }),
    row('variant-a', { audience: group(rule('bucket', 'between', { min: 0, max: 49 })) }),
    row('variant-b', { audience: group(rule('bucket', 'between', { min: 50, max: 99 })) }),
  ];
  const f = fleet({ low: { bucket: 10, cohorts: ['pilot'] }, high: { bucket: 70, cohorts: ['other'] } }, rows);
  await f.delivery.deliver('low'); await f.delivery.deliver('high');
  assert.deepEqual(f.jobs('low'), ['pilot-tour', 'variant-a']);
  assert.deepEqual(f.jobs('high'), ['variant-b']);
});

test('a window holds the row back before it opens, delivers inside it and withdraws it after', async () => {
  const window = { from: '2026-10-08T10:00:00Z', until: '2026-10-08T14:00:00Z' };
  const at = ms => { const f = fleet({ a: {} }, () => [row('timed', { window })], { now: () => ms }); return f.delivery.deliver('a').then(() => f.jobs('a')); };
  assert.deepEqual(await at(Date.parse('2026-10-08T09:59:00Z')), []);
  assert.deepEqual(await at(Date.parse('2026-10-08T10:00:00Z')), ['timed']);
  assert.deepEqual(await at(Date.parse('2026-10-08T13:59:00Z')), ['timed']);
  assert.deepEqual(await at(Date.parse('2026-10-08T14:00:00Z')), []);
});

test('a row held back by its window arrives on a later connection once the window opens', async () => {
  let clock = Date.parse('2026-10-08T09:00:00Z');
  const f = fleet({ a: {} }, () => [row('later', { window: { from: '2026-10-08T10:00:00Z' } })], { now: () => clock });
  await f.delivery.deliver('a');
  assert.deepEqual(f.jobs('a'), []);
  clock = Date.parse('2026-10-08T10:30:00Z');
  await f.delivery.deliver('a');
  assert.deepEqual(f.jobs('a'), ['later']);
});

test('a trigger sets a row off once per account: connect, account-created and setup-unfinished', async () => {
  const rows = () => [row('on-connect'), row('on-new', { trigger: 'account-created' }), row('on-unfinished', { trigger: 'setup-unfinished' })];
  const f = fleet({ fresh: { createdAt: NOW - DAY, setupDone: false }, old: { createdAt: NOW - 90 * DAY, setupDone: true } }, rows);
  for (const id of ['fresh', 'old', 'fresh', 'old']) await f.delivery.deliver(id);
  assert.deepEqual(f.jobs('fresh'), ['on-connect', 'on-new', 'on-unfinished']);
  assert.deepEqual(f.jobs('old'), ['on-connect']);
  assert.equal(f.stores.get('fresh').size, 3, 'each row is one handoff however often the AI connects');
});

test('delivery is cached per account for cache_seconds and asks only for the account that connected', async () => {
  let clock = NOW;
  const f = fleet({ a: {}, b: {}, c: {} }, () => [row('x')], { now: () => clock });
  await f.delivery.deliver('a'); await f.delivery.deliver('a'); await f.delivery.deliver('a');
  assert.deepEqual(f.asked, ['a'], 'inside the cache the account is not read again, and no other account is read');
  clock += (rules.cache_seconds + 1) * 1000;
  await f.delivery.deliver('a');
  assert.deepEqual(f.asked, ['a', 'a']);
  assert.deepEqual(f.jobs('b'), []);
  assert.equal(rules.cache_seconds, 60, 'the cache is 60 seconds (DATA)');
});

test('the rows in force are read once per rows_cache_seconds, shared by every account that connects inside it', async () => {
  let clock = NOW;
  let reads = 0;
  const delivery = makeWorkDelivery({ rowsNow: async () => { reads += 1; return [row('x')]; }, factsOf: async id => factsFor(id), matches, now: () => clock, rules,
    handOff: async () => undefined });
  await Promise.all([delivery.deliver('a'), delivery.deliver('b'), delivery.deliver('c')]);
  assert.equal(reads, 1, 'three accounts at once read the rows once');
  clock += (rules.rows_cache_seconds - 1) * 1000;
  await delivery.deliver('d');
  assert.equal(reads, 1, 'inside 30 seconds the kept rows are used');
  clock += 2 * 1000;
  await delivery.deliver('e');
  assert.equal(reads, 2, 'after 30 seconds the rows are read again');
  assert.equal(rules.rows_cache_seconds, 30, 'the rows cache is 30 seconds (DATA)');
});

test('one run per account: overlapping calls for the same account share one delivery', async () => {
  let asked = 0;
  const delivery = makeWorkDelivery({ rowsNow: async () => [row('x')], factsOf: async id => { asked += 1; return factsFor(id); }, matches, now: () => NOW, rules,
    handOff: async () => undefined });
  const [first, second] = [delivery.deliver('a'), delivery.deliver('a')];
  assert.equal(first, second, 'the same run is returned');
  assert.deepEqual(await first, ['x']);
  assert.equal(asked, 1, 'the account is read once for both calls');
});

test('a failed handoff is tried again at the account\'s next call', async () => {
  let fail = true;
  const made = [];
  const delivery = makeWorkDelivery({ rowsNow: async () => [row('x')], factsOf: async id => factsFor(id), matches,
    handOff: async (id, handoff) => { if (fail) throw new Error('busy'); made.push(handoff.once_per); }, now: () => NOW, rules });
  await assert.rejects(delivery.deliver('a'), /busy/);
  fail = false;
  assert.deepEqual(await delivery.deliver('a'), ['x']);
  assert.deepEqual(made, ['work-for-ais:x']);
});

test('the set-up row reaches an account whose setup is unfinished and not one whose setup is done; a new account is also asked for its first matches', async () => {
  const setupRow = shipped.find(item => item.id === SETUP_ROW);
  assert.equal(setupRow.trigger, 'setup-unfinished');
  assert.equal(setupRow.audience.rules[0].field, 'setup_included', 'only plans that include setup');
  assert.equal(handoffFor(setupRow, rules).priority, 9);
  const f = fleet({ sofus: { setupIncluded: true, setupDone: false }, finished: { setupIncluded: true, setupDone: true },
    brandnew: { setupIncluded: true, setupDone: false, createdAt: NOW - 1000 } }, () => shipped);
  for (const id of ['sofus', 'finished', 'brandnew']) await f.delivery.deliver(id);
  assert.deepEqual(f.jobs('sofus'), [SETUP_ROW]);
  assert.deepEqual(f.jobs('brandnew'), ['first-matches', SETUP_ROW].sort());
  assert.deepEqual(f.jobs('finished'), []);
});

test('the first-matches row hands a new account once and an older account nothing', async () => {
  const f = fleet({ fresh: { createdAt: NOW - HOUR }, older: { createdAt: NOW - (rules.new_account_hours + 1) * HOUR } }, () => shipped);
  assert.deepEqual(await f.delivery.deliver('fresh'), ['first-matches']);
  assert.deepEqual(await f.delivery.deliver('fresh'), [], 'once per account');
  assert.deepEqual(await f.delivery.deliver('older'), []);
});

test('a plan that keeps nothing holds the work an hour: a live handoff is not remembered, so it is handed again', async () => {
  let clock = NOW;
  const made = [];
  const delivery = makeWorkDelivery({ rowsNow: async () => shipped, factsOf: async id => factsFor(id, { setupIncluded: true, setupDone: false }), matches,
    handOff: async (id, handoff) => { made.push(handoff.once_per); return { live: true }; }, now: () => clock, rules });
  assert.deepEqual(await delivery.deliver('free'), [SETUP_ROW]);
  clock += (rules.cache_seconds + 1) * 1000;
  assert.deepEqual(await delivery.deliver('free'), [SETUP_ROW], 'still unfinished, so it is handed again');
  assert.deepEqual(made, [`work-for-ais:${SETUP_ROW}`, `work-for-ais:${SETUP_ROW}`]);
});

test('a row that is not live is remembered as handed, and is not handed again after the cache', async () => {
  let clock = NOW;
  const f = fleet({ a: {} }, () => [row('kept')], { now: () => clock });
  assert.deepEqual(await f.delivery.deliver('a'), ['kept']);
  clock += (rules.cache_seconds + 1) * 1000;
  assert.deepEqual(await f.delivery.deliver('a'), [], 'remembered once made');
});

test('accounts remembered are capped: the oldest is let go past the cap, and its next connection is read again', async () => {
  const asked = [];
  const delivery = makeWorkDelivery({ rowsNow: async () => [row('x')], factsOf: async id => { asked.push(id); return factsFor(id); }, matches, now: () => NOW, rules,
    handOff: async () => undefined });
  assert.equal(ACCOUNTS_KEPT, 5000, 'the cap is 5000 accounts');
  await delivery.deliver('first');
  for (let index = 0; index < ACCOUNTS_KEPT; index += 1) await delivery.deliver(`other-${index}`);
  assert.equal(asked.filter(id => id === 'first').length, 1);
  await delivery.deliver('first');
  assert.equal(asked.filter(id => id === 'first').length, 2, 'the oldest account was let go and is read again');
  const recent = `other-${ACCOUNTS_KEPT - 1}`;
  await delivery.deliver(recent);
  assert.equal(asked.filter(id => id === recent).length, 1, 'a recent account is still remembered inside the cache');
});
