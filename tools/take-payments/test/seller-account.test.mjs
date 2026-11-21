// tools/take-payments/test/seller-account.test.mjs
//
// Which of the seller's accounts a payment screen's named connection means, asked of tool:find-the-account-of-a-service
// (tools/connections, answering for real here) before a paid step runs: one held is that one, several stop the run with
// the accounts named, none or a caller who cannot read the vault's names keeps the connection as named.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTheAccountOfAService } from '../../connections/do-work/find-the-account-of-a-service.mjs';
import { startAnswer, completeAnswer } from '../web/src/workspace/checkout-answers.ts';
import { SELLER_ACCOUNT, sellerAccountOf } from '../web/src/workspace/seller-account.ts';

const hex = text => Buffer.from(text, 'utf8').toString('hex');
const held = (...ids) => ids.map(id => `service-connection-${hex(id)}-field-${hex('secret_key')}`);

function owner(answers = {}) {
  const calls = [];
  const run = async (tool, input) => {
    calls.push({ tool, input });
    if (tool === SELLER_ACCOUNT.tool) return { result: await findTheAccountOfAService(input) };
    return { result: typeof answers[tool] === 'function' ? answers[tool](input) : answers[tool] };
  };
  return { run, calls };
}

test('the one account of the named service the vault holds is the one run with', async () => {
  const { run, calls } = owner();
  assert.equal(await sellerAccountOf('service_connection:stripe', run, async () => held('service_connection:stripe:shop', 'service_connection:resend:mail')), 'service_connection:stripe:shop');
  assert.deepEqual(calls[0].input.held_connections, [
    { connection_id: 'service_connection:resend:mail', fields: ['secret_key'] },
    { connection_id: 'service_connection:stripe:shop', fields: ['secret_key'] },
  ], 'names only, never a value');
});

test('several accounts held: nothing starts, and the accounts are named', async () => {
  const { run } = owner();
  await assert.rejects(sellerAccountOf('service_connection:stripe', run, async () => held('service_connection:stripe:a', 'service_connection:stripe:b')), /service_connection:stripe:a, service_connection:stripe:b/);
});

test('none held, a connection that names an account, or a caller refused the names: the connection as named', async () => {
  const { run, calls } = owner();
  assert.equal(await sellerAccountOf('service_connection:stripe', run, async () => []), 'service_connection:stripe');
  assert.equal(await sellerAccountOf('service_connection:stripe:shop', run, async () => held('service_connection:stripe:other')), 'service_connection:stripe:shop');
  const asked = calls.length;
  assert.equal(await sellerAccountOf('service_connection:stripe', run, async () => null), 'service_connection:stripe', 'a buyer cannot read the names');
  assert.equal(await sellerAccountOf('service_connection:stripe', run, () => Promise.reject(new Error('refused'))), 'service_connection:stripe');
  assert.equal(calls.length, asked, 'no names, no question');
});

test('the checkout\'s paid steps run with the account the screen asked for', async () => {
  const material = { amountDueTodayCents: '4900', recurringAmountCents: '0' };
  const { run, calls } = owner({
    'tool:price-a-sale': { material },
    'tool:start-a-stripe-checkout': { redirectUrl: 'https://pay.example/c/1', providerSessionId: 'cs_1' },
    'tool:look-up-a-stripe-checkout': { payment_status: 'paid' },
  });
  const context = { sellerConnection: 'service_connection:stripe', sellerAccount: async () => 'service_connection:stripe:shop', origin: 'https://sell.example', path: '/checkout', store: null };
  await startAnswer({ offerId: 'offer:one' }, run, context);
  await completeAnswer({ session_id: 'cs_1' }, run, context);
  assert.deepEqual(calls.filter(call => call.input.seller_connection).map(call => call.input.seller_connection), ['service_connection:stripe:shop', 'service_connection:stripe:shop']);
});
