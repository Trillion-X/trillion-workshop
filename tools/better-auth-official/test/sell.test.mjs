// tools/better-auth-official/test/sell.test.mjs
//
// A plan on the account, sold through Stripe (sell.mjs): a buy address sends a signed-in person to a Checkout for the offer its row
// names, with its price and free days, and a person not signed in to sign-in and back. A Stripe event signed with the webhook secret
// puts the plan on the account (checkout.session.completed), changes it (customer.subscription.updated) and takes it off
// (customer.subscription.deleted); a replayed event leaves one row in the same state, and an event with a bad signature is refused and
// changes nothing. Stripe is a stand-in HTTP server here (settings.sell.stripe_api), and every event is signed with Stripe's own scheme.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stripe from 'stripe';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const OFFER = 'offer:example-seat';
const PRICE = 'price_example_seat';
const WEBHOOK_SECRET = 'whsec_a_scratch_secret_for_this_test_only';
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

// The stand-in Stripe: the customers, subscriptions and Checkout Sessions the plugin asks for, and every request it was sent.
const sent = [];
const stripeState = { customers: [], subscription: null, sessions: [] };
const subscriptionObject = changes => ({
  id: 'sub_example_1', object: 'subscription', customer: 'cus_example_1', status: 'trialing', cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
  trial_start: NOW, trial_end: NOW + 7 * DAY, schedule: null, metadata: {},
  items: { object: 'list', data: [{ id: 'si_example_1', quantity: 1, current_period_start: NOW, current_period_end: NOW + 7 * DAY, price: { id: PRICE, recurring: { interval: 'month' } } }] },
  ...changes,
});
const json = (response, status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const stand = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const url = new URL(request.url, 'http://stripe.test');
  sent.push({ method: request.method, path: url.pathname, form: new URLSearchParams(body), query: url.searchParams, authorization: request.headers.authorization });
  if (request.method === 'GET' && url.pathname === '/v1/customers/search') return json(response, 200, { object: 'search_result', data: [], has_more: false });
  if (request.method === 'POST' && url.pathname === '/v1/customers') {
    const form = new URLSearchParams(body);
    const customer = { id: 'cus_example_1', object: 'customer', email: form.get('email'), metadata: {} };
    stripeState.customers.push(customer);
    return json(response, 200, customer);
  }
  if (request.method === 'GET' && url.pathname === '/v1/subscriptions') return json(response, 200, { object: 'list', data: stripeState.subscription ? [stripeState.subscription] : [], has_more: false });
  if (request.method === 'GET' && url.pathname === '/v1/subscriptions/sub_example_1') return json(response, 200, stripeState.subscription);
  if (request.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
    const id = `cs_test_example${stripeState.sessions.length + 1}`;
    const form = new URLSearchParams(body);
    const session = { id, object: 'checkout.session', mode: 'subscription', url: `https://checkout.stripe.test/c/pay/${id}`, client_reference_id: form.get('client_reference_id'), metadata: Object.fromEntries([...form].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value])) };
    stripeState.sessions.push(session);
    return json(response, 200, session);
  }
  return json(response, 404, { error: { message: `the stand-in has no ${request.method} ${url.pathname}` } });
}).listen(0, '127.0.0.1');
await new Promise(done => stand.once('listening', done));

const dir = tempFolder(join(tmpdir(), 'sell-'));
const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const settings = {
  ...shipped, email_password: { require_verification: false }, disabled_paths: [], rate_limit: { ...shipped.rate_limit, enabled: false },
  sell: { ...shipped.sell, enabled: true, success_path: '/welcome', cancel_path: '/', offers: [{ offer_id: OFFER, price_id: PRICE, trial_days: 7 }], stripe_api: { host: '127.0.0.1', port: stand.address().port, protocol: 'http' }, stripe_retries: 0 },
};
writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
process.env.BETTER_AUTH_SETTINGS = join(dir, 'settings.json');
const store = await startStore();
process.env.BETTER_AUTH_STORE_CONNECTION = await store.database();
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
process.env[settings.sell.stripe_key_env] = 'sk_test_a_scratch_key_for_this_test_only';
process.env[settings.sell.webhook_secret_env] = WEBHOOK_SECRET;
const { auth, pool } = await import('../auth.mjs');
const { BUY_PATH, buyAnswer, sellPlugins } = await import('../sell.mjs');
store.hold(pool);
test.after(async () => { stand.close(); await store.stop(); });
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(auth.options)).runMigrations();

const ORIGIN = settings.base_url;
const API = `${ORIGIN}${settings.base_path}`;
const post = (path, body) => auth.handler(new Request(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) }));
async function signedIn(email) {
  assert.equal((await post('/sign-up/email', { email, password: 'scratch-password-123', name: 'Scratch Person' })).status, 200);
  // The plugin sells only to a proven address; signing in by email code proves it on a real sign-in.
  await pool.query('update "user" set "emailVerified" = true where email = $1', [email]);
  const token = (await post('/sign-in/email', { email, password: 'scratch-password-123' })).headers.get('set-auth-token');
  const { rows: [user] } = await pool.query('select id from "user" where email = $1', [email]);
  return { headers: new Headers({ authorization: `Bearer ${token}` }), id: user.id };
}
const buy = (path, headers = new Headers()) => buyAnswer(auth, settings.sell, new URL(path, ORIGIN), headers, () => {});
const stripeSigner = new Stripe('sk_test_signer_only');
function event(type, object, secret = WEBHOOK_SECRET, id = `evt_${type}`) {
  const payload = JSON.stringify({ id, object: 'event', type, created: NOW, data: { object } });
  return auth.handler(new Request(`${API}/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSigner.webhooks.generateTestHeaderString({ payload, secret }) }, body: payload }));
}
const rows = async referenceId => (await pool.query('select plan, status, "stripeSubscriptionId", "trialEnd" from subscription where "referenceId" = $1', [referenceId])).rows;
const plans = async headers => (await auth.api.listActiveSubscriptions({ headers })).map(row => `${row.plan} ${row.status}`);

test('an address that names no offer the settings list is 404 and nothing reaches Stripe', async () => {
  const before = sent.length;
  for (const path of ['/buy/offer%3Anot-sold', '/buy/', '/buy/%E0%A4%A']) assert.equal((await buy(path)).status, 404, path);
  assert.equal(sent.length, before);
});

test('a person not signed in goes to sign-in, which comes back to the same buy address', async () => {
  const answer = await buy('/buy/offer%3Aexample-seat?jv=visitor-1');
  assert.equal(answer.status, 303);
  const next = new URL(answer.headers.location, ORIGIN);
  assert.equal(next.pathname, settings.sell.sign_in_path);
  assert.equal(next.searchParams.get('next'), '/buy/offer%3Aexample-seat?jv=visitor-1');
});

test('a bought plan goes on the account by a signed event, a replay keeps one row, a bad signature changes nothing, and a cancel takes it off', async () => {
  const person = await signedIn('buyer@example.test');

  // The buy: one Checkout for the offer's price, with its free days, made for this account.
  const answer = await buy('/buy/offer%3Aexample-seat?jv=visitor-2&utm_source=school&other=dropped', person.headers);
  assert.equal(answer.status, 303);
  assert.equal(answer.headers.location, 'https://checkout.stripe.test/c/pay/cs_test_example1');
  const made = sent.find(request => request.path === '/v1/checkout/sessions');
  assert.equal(made.authorization, `Bearer ${process.env[settings.sell.stripe_key_env]}`, 'the key travels only as the Authorization header');
  assert.equal(made.form.get('mode'), 'subscription');
  assert.equal(made.form.get('line_items[0][price]'), PRICE);
  assert.equal(made.form.get('subscription_data[trial_period_days]'), '7');
  assert.equal(made.form.get('client_reference_id'), person.id);
  assert.equal(made.form.get('customer'), 'cus_example_1');
  assert.equal(made.form.get('metadata[jv]'), 'visitor-2');
  assert.equal(made.form.get('metadata[utm_source]'), 'school');
  assert.equal(made.form.get('metadata[offer_id]'), OFFER);
  assert.equal(made.form.get('metadata[other]'), null, 'only attribution reaches Stripe');
  assert.match(made.form.get('success_url'), /\/subscription\/success\?callbackURL=%2Fwelcome&checkoutSessionId=\{CHECKOUT_SESSION_ID\}$/);
  const [waiting] = await rows(person.id);
  assert.equal(waiting.status, 'incomplete', 'no plan before Stripe says the checkout completed');
  assert.deepEqual(await plans(person.headers), []);

  // Stripe says the checkout completed: the plan is on, in its free days.
  const session = stripeState.sessions[0];
  stripeState.subscription = subscriptionObject({});
  const completed = { ...session, subscription: 'sub_example_1', customer: 'cus_example_1', payment_status: 'no_payment_required', status: 'complete' };
  assert.equal((await event('checkout.session.completed', completed)).status, 200);
  assert.deepEqual(await plans(person.headers), [`${OFFER} trialing`]);
  const [on] = await rows(person.id);
  assert.equal(on.stripeSubscriptionId, 'sub_example_1');
  assert.equal(new Date(on.trialEnd).getTime(), (NOW + 7 * DAY) * 1000);

  // The same event again: one row, the same state.
  assert.equal((await event('checkout.session.completed', completed)).status, 200);
  assert.deepEqual((await rows(person.id)).map(row => `${row.plan} ${row.status}`), [`${OFFER} trialing`]);

  // Buying what the account already holds goes to the success page with no second Checkout.
  const sessions = stripeState.sessions.length;
  assert.deepEqual([(await buy('/buy/offer%3Aexample-seat', person.headers)).headers.location, stripeState.sessions.length], ['/welcome', sessions]);

  // A cancel with a bad signature, and one with no signature, is refused and changes nothing.
  const canceled = subscriptionObject({ status: 'canceled', canceled_at: NOW, ended_at: NOW });
  assert.equal((await event('customer.subscription.deleted', canceled, 'whsec_not_the_secret')).status, 400);
  const unsigned = await auth.handler(new Request(`${API}/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'customer.subscription.deleted', data: { object: canceled } }) }));
  assert.equal(unsigned.status, 400);
  assert.deepEqual(await plans(person.headers), [`${OFFER} trialing`]);

  // The free days end and it is paid: the plan stays on, active.
  stripeState.subscription = subscriptionObject({ status: 'active', trial_end: NOW });
  assert.equal((await event('customer.subscription.updated', stripeState.subscription)).status, 200);
  assert.deepEqual(await plans(person.headers), [`${OFFER} active`]);

  // The cancel, then the same cancel again: the plan is off, one row.
  stripeState.subscription = canceled;
  for (const _ of [1, 2]) assert.equal((await event('customer.subscription.deleted', canceled)).status, 200);
  assert.deepEqual(await plans(person.headers), []);
  assert.deepEqual((await rows(person.id)).map(row => `${row.plan} ${row.status}`), [`${OFFER} canceled`]);
});

test('the plugin starts only with its key and signing secret, and an offer id in lower case', () => {
  const sell = { ...settings.sell };
  assert.deepEqual(sellPlugins({ ...sell, enabled: false }, {}), []);
  assert.throws(() => sellPlugins(sell, { [sell.webhook_secret_env]: WEBHOOK_SECRET }), new RegExp(sell.stripe_key_env));
  assert.throws(() => sellPlugins(sell, { [sell.stripe_key_env]: 'sk_test_x' }), new RegExp(sell.webhook_secret_env));
  const env = { [sell.stripe_key_env]: 'sk_test_x', [sell.webhook_secret_env]: WEBHOOK_SECRET };
  assert.throws(() => sellPlugins({ ...sell, offers: [{ offer_id: 'offer:Seat', price_id: PRICE, trial_days: 0 }] }, env), /offer:Seat must be lower case/);
  assert.equal(sellPlugins(sell, env).length, 1);
});

test('the front door sends the buy path to this tool', () => {
  const fragment = readFileSync(new URL('../on-a-computer/caddy-route-better-auth-buy.caddy', import.meta.url), 'utf8');
  assert.ok(fragment.includes(`handle ${BUY_PATH}* {`), 'the fragment routes the path sell.mjs answers');
});
