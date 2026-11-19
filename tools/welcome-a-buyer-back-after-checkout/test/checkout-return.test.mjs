import test from 'node:test';
import assert from 'node:assert/strict';
import { returnAddress, makeCheckoutReturn, checkoutReturnInHand } from '../read-data/checkout-return.mjs';

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

const handed = record => ({ records: [{ id: 'checkout-return:yours', type: 'checkout-return', value: record?.value ?? null }] });

test('the handed context expires and a keep carries the record it expected', () => {
  let at = 1000;
  const owner = checkoutReturnInHand({ welcome, afterPurchase, now: () => at });
  const first = owner.keep({ from: 'extension', return: 'https://example.com' }, handed(null));
  assert.deepEqual(first.came_from, { from: 'extension', return: 'https://example.com/' });
  assert.deepEqual(first.keep, [{ id: 'checkout-return:yours', type: 'checkout-return', expected: null,
    value: { came_from: { from: 'extension', return: 'https://example.com/' }, expires_at: 61_000 } }]);
  const held = { type: 'checkout-return', value: first.keep[0].value };
  assert.deepEqual(owner.kept(handed(held)), { from: 'extension', return: 'https://example.com/' });
  at += 60_000;
  assert.equal(owner.kept(handed(held)), null);
  const second = owner.keep({ from: 'extension', return: 'https://other.example' }, handed(held));
  assert.deepEqual(second.keep[0].expected, held);
});

test('leaving the record out is refused, never read as absent, and unsafe input keeps nothing', () => {
  const owner = checkoutReturnInHand({ welcome, afterPurchase });
  for (const stored of [undefined, {}, { records: [] }, { records: [{ id: 'another', type: 'checkout-return', value: null }] }]) {
    assert.throws(() => owner.kept(stored), /Hand in the checkout-return:yours record/);
    assert.throws(() => owner.keep({ from: 'extension', return: 'https://example.com' }, stored), /Hand in the checkout-return:yours record/);
  }
  assert.equal(owner.kept(handed(null)), null);
  assert.throws(() => owner.keep({ from: 'unlisted', return: 'https://example.com' }, handed(null)), /listed origin/);
  assert.throws(() => owner.keep({ from: 'extension', return: 'javascript:alert(1)' }, handed(null)), /safe return/);
});

test('handed reads reject malformed, withdrawn-origin and expired retained contexts', () => {
  const owner = checkoutReturnInHand({ welcome, afterPurchase, now: () => 1000 });
  for (const invalid of [{}, { expires_at: '2000' }, { expires_at: 1000, came_from: { from: 'extension', return: 'https://example.com' } },
    { expires_at: 2000, came_from: { from: 'withdrawn', return: 'https://example.com' } },
    { expires_at: 2000, came_from: { from: 'extension', return: 'https://user:pass@example.com' } }]) {
    assert.equal(owner.kept(handed({ value: invalid })), null);
  }
  assert.deepEqual(owner.kept(handed({ value: { expires_at: 2000, came_from: { from: 'extension', return: 'https://example.com' } } })),
    { from: 'extension', return: 'https://example.com/' });
});
