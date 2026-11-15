import test from 'node:test';
import assert from 'node:assert/strict';
import { returnAddress, makeCheckoutReturn, checkoutReturnOverDoor } from '../read-data/checkout-return.mjs';

const welcome = {
  address: '/welcome', tours_address: '/tours', title: 'Welcome', keep_seconds: 60,
  welcome: { heading: 'Plan active', body: 'Ready', actions: [{ label: 'Tour', href: '/tours' }, { label: 'Home', href: '/' }] },
  origins: [{ from: 'extension', body: 'Back to work', steps: [{ heading: 'Return', action: { label: 'Go back', href: { from: 'return' } } }, { heading: 'Refresh' }] }],
};
const afterPurchase = offer => offer.after_purchase;

test('return addresses accept only bounded credential-free HTTP(S)', () => {
  for (const bad of [null, '', 'javascript:alert(1)', 'file:///tmp/a', 'https://user:pass@example.com', 'https://example.com/' + 'a'.repeat(2048)]) assert.equal(returnAddress(bad), null);
  assert.equal(returnAddress('https://example.com'), 'https://example.com/');
  assert.equal(returnAddress('http://example.com/a?b=1#c'), 'http://example.com/a?b=1#c');
});

test('origins and welcome sections come from rows and the shared purchased-offer wording', () => {
  const owner = makeCheckoutReturn({ welcome, afterPurchase });
  assert.equal(owner.cameFromOf(new URLSearchParams({ from: 'unlisted', return: 'https://example.com' })), null);
  const cameFrom = owner.cameFromOf(new URLSearchParams({ from: 'extension', return: 'https://example.com' }));
  const after = { heading: 'Bought', got: 'The plan.', pays: 'Paid once.', next: { label: 'Start', href: '/' }, tour: 'a b' };
  const page = owner.welcomePage(cameFrom, { after_purchase: after });
  assert.equal(owner.WELCOME_ADDRESS, '/welcome');
  assert.equal(page.robots, 'noindex'); assert.equal(page.island, null);
  const [section] = page.sections;
  assert.equal(section.heading, 'Bought');
  assert.equal(section.body, 'The plan. Paid once. Back to work');
  assert.deepEqual(section.steps[0].actions, [{ label: 'Go back', href: 'https://example.com/' }]);
  assert.deepEqual(section.steps[1].actions, []);
  assert.deepEqual(section.actions, [{ label: 'Start', href: '/' }, { label: 'Tour', href: '/tours?take=a%20b' }]);
});

test('KV host seam keeps and validates only the selected buyer context with its configured TTL', async () => {
  const owner = makeCheckoutReturn({ welcome, afterPurchase });
  const kept = new Map(); let ttl;
  const kv = { put: async (key, json, options) => { kept.set(key, JSON.parse(json)); ttl = options.expirationTtl; }, get: async key => kept.get(key) };
  await owner.keepCameFrom(kv, 'buyer', { from: 'extension', return: 'https://example.com' });
  assert.equal(ttl, 60);
  assert.equal(await owner.keptCameFrom(kv, 'another-buyer'), null);
  assert.deepEqual(await owner.keptCameFrom(kv, 'buyer'), { from: 'extension', return: 'https://example.com/' });
  kept.set('checkout-return:buyer', { from: 'extension', return: 'javascript:alert(1)' });
  assert.equal(await owner.keptCameFrom(kv, 'buyer'), null);
});

test('records-door context expires and conditional writes refuse another run overwriting it', async () => {
  let at = 1000, held = null;
  const door = { readRecord: async (type, id) => { assert.equal(type, 'checkout-return'); assert.equal(id, 'checkout-return:yours'); return structuredClone(held); }, write: async rows => {
    const [row] = rows; assert.deepEqual(row.expected, held);
    held = { type: row.type, value: structuredClone(row.value) };
  } };
  const owner = checkoutReturnOverDoor({ door, welcome, afterPurchase, now: () => at });
  await owner.keep({ from: 'extension', return: 'https://example.com' });
  assert.deepEqual(await owner.kept(), { from: 'extension', return: 'https://example.com/' });
  at += 60_000;
  assert.equal(await owner.kept(), null);
  const before = structuredClone(held);
  door.readRecord = async () => { const old = structuredClone(held); held = { type: 'checkout-return', value: { changed: true } }; return old; };
  await assert.rejects(owner.keep({ from: 'extension', return: 'https://other.example' }), /Expected values/);
  assert.notDeepEqual(held, before);
});

test('records-door outages remain unavailable and unsafe writes have no storage effect', async () => {
  let reads = 0, writes = 0;
  const door = { readRecord: async () => { reads++; throw new Error('Account unavailable'); },
    write: async () => { writes++; } };
  const owner = checkoutReturnOverDoor({ door, welcome, afterPurchase });
  await assert.rejects(owner.kept(), /Account unavailable/);
  await assert.rejects(owner.keep({ from: 'extension', return: 'https://example.com' }), /Account unavailable/);
  await assert.rejects(owner.keep({ from: 'unlisted', return: 'https://example.com' }), /listed origin/);
  await assert.rejects(owner.keep({ from: 'extension', return: 'javascript:alert(1)' }), /safe return/);
  assert.equal(reads, 2); assert.equal(writes, 0);
});

test('records-door reads reject malformed, withdrawn-origin and expired retained contexts', async () => {
  let value;
  const owner = checkoutReturnOverDoor({ welcome, afterPurchase, now: () => 1000,
    door: { readRecord: async () => ({ type: 'checkout-return', value }) } });
  for (const invalid of [undefined, {}, { expires_at: '2000' }, { expires_at: 1000, came_from: { from: 'extension', return: 'https://example.com' } },
    { expires_at: 2000, came_from: { from: 'withdrawn', return: 'https://example.com' } },
    { expires_at: 2000, came_from: { from: 'extension', return: 'https://user:pass@example.com' } }]) {
    value = invalid;
    assert.equal(await owner.kept(), null);
  }
  value = { expires_at: 2000, came_from: { from: 'extension', return: 'https://example.com' } };
  assert.deepEqual(await owner.kept(), { from: 'extension', return: 'https://example.com/' });
});
