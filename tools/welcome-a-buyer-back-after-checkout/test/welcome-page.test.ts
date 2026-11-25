import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';
import { readWelcomePage } from '../reads/read-the-welcome-page.ts';

const entry = new URL('../show/Welcome.tsx', import.meta.url).pathname;
const states = {
  none: { heading: 'Welcome to the school', body: 'Sign in to find your courses.', actions: [{ label: 'Open my courses', href: '/courses' }] },
  paid: { heading: 'You are in', body: 'Thank you.', actions: [{ label: 'Start', href: '/start' }, { label: 'Take the tour', href: '/tour' }] },
  waiting: { heading: 'Almost there', body: 'We are waiting for your payment.', actions: [] },
};

test('the server draws the state none: its heading with the last word solid, its body and its action', async () => {
  const html = await renderAView(entry, JSON.parse(JSON.stringify({ states })));
  assert.match(html, /Welcome to the/);
  assert.match(html, /school/);
  assert.match(html, /Sign in to find your courses\./);
  assert.match(html, /href="\/courses"/);
  assert.doesNotMatch(html, /You are in/);
  assert.doesNotMatch(html, /<script/);
});

test('a page whose rows hold no none state draws nothing', async () => {
  assert.equal(await renderAView(entry, { states: { paid: states.paid } }), '');
});

const rowsFor = (pages: Record<string, unknown>[], found: Record<string, unknown>[]) => async (sql: string) => (/from welcome_page/.test(sql) ? pages : found);

test('the read answers the page, and each state in place order with only actions that have a label and an address', async () => {
  const answer = await readWelcomePage({ database: 'd' }, rowsFor(
    [{ name: 'main', title: 'Welcome', address: '/welcome', tours_address: '/tour', keep_seconds: 3600 }],
    [{ state: 'none', heading: 'H', body: 'B', actions: [{ label: 'Go', href: '/go' }, { label: '', href: '/x' }, { label: 'No address' }] }, { state: 'paid', heading: 'P', body: null, actions: null }],
  ));
  assert.deepEqual(Object.keys(answer.states), ['none', 'paid']);
  assert.deepEqual(answer.states.none.actions, [{ label: 'Go', href: '/go' }]);
  assert.deepEqual(answer.states.paid, { heading: 'P', body: '', actions: [] });
  assert.equal(answer.keep_seconds, 3600);
  assert.equal(answer.tours_address, '/tour');
});

test('no page row is refused by name, and a name filters the page', async () => {
  await assert.rejects(readWelcomePage({ database: 'd' }, rowsFor([], [])), /no welcome page row/);
  await assert.rejects(readWelcomePage({ database: 'd', name: 'x' }, rowsFor([], [])), /no welcome page named x/);
  const asked: string[] = [];
  await readWelcomePage({ database: 'd', name: 'main' }, async sql => { asked.push(sql); return /welcome_page/.test(sql) ? [{ name: 'main' }] : []; });
  assert.match(asked[0], /where name = \$1/);
});

test('a checkout answer comes to paid only when it is complete and paid; any other answer waits; a failed read is none', async () => {
  const { checkoutState, CHECKOUT_ID } = await import('../show/checkout-state.ts');
  assert.equal(checkoutState({ status: 'complete', payment_status: 'paid' }), 'paid');
  assert.equal(checkoutState({ status: 'complete', payment_status: 'no_payment_required' }), 'paid');
  assert.equal(checkoutState({ status: 'complete', payment_status: 'unpaid' }), 'waiting');
  assert.equal(checkoutState({ status: 'open', payment_status: 'unpaid' }), 'waiting');
  assert.equal(checkoutState({}), 'waiting');
  assert.equal(checkoutState(null), 'none');
  assert.ok(CHECKOUT_ID.test('cs_test_a1B2c3D4e5F6g7'));
  assert.ok(!CHECKOUT_ID.test('cs_prod_a1B2c3D4e5F6g7') && !CHECKOUT_ID.test('cs_test_short') && !CHECKOUT_ID.test('../x'));
});
