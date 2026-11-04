import assert from 'node:assert/strict';
import test from 'node:test';
import { readToolData, makeWorkshop } from '../../keep-and-wake-ai-sessions-on-this-computer/src/workshop.mjs';
import { makePayers } from '../src/payers.mjs';
import { publicToolCatalog } from '../../browse-and-search-every-marketplace-listing-without-signing/src/public-tool-catalog.mjs';
import { makeMakerPayouts } from '../../keep-and-wake-ai-sessions-on-this-computer/src/maker-payouts.mjs';
import payoutSettings from '../../keep-and-wake-ai-sessions-on-this-computer/src/maker-payouts.json' with { type: 'json' };
import { handleWorkshopRequest } from '../../keep-and-wake-ai-sessions-on-this-computer/src/workshop.mjs';

const rows = [
  { kind: 'tool-placement', id: 'placement:model', label: 'Trillion', executor: 'model-runtime', reachable_from: ['hosted'] },
  { kind: 'tool-licence-class', id: 'licence:maker-own', label: 'Maker owned', licences: ['MIT'], allowed_placements: ['placement:model'], store_bytes: true },
];
const descriptor = {
  id: 'tool:turn-words', label: 'Turn words', job: 'Turn a word into a result',
  input_schema: { type: 'object', required: ['word'], properties: { word: { type: 'string' } } },
  output_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 } } },
  verify: [{ kind: 'sample-run', input: { word: 'sample' }, output_selector: '$.text', contains: 'made sample' }],
  invoke: { kind: 'model', model: 'words', input: { text: { fill: { from: 'input', field: 'word' } } } },
  licence_class: 'licence:maker-own', placements: ['placement:model'],
};

function market() {
  const tools = new Map(), priceRows = new Map(), sales = new Map();
  return {
    tools, priceRows, sales,
    published: async () => [...tools.values()],
    prices: async () => [...priceRows.values()],
    publishPriced: async ({ row, price, maker }) => { tools.set(row.id, { row, maker }); priceRows.set(price.id, { row: price, maker }); },
    publish: async ({ row, maker }) => { tools.set(row.id, { row, maker }); },
    unpublish: async ({ id, maker }) => tools.get(id)?.maker === maker && tools.delete(id),
    post: async sale => { if (!sales.has(sale.sale_id)) sales.set(sale.sale_id, sale); },
    refund: async saleId => { const sale = sales.get(saleId); if (sale && !sale.refunded_at) sales.set(saleId, { ...sale, refunded_at: '2026-10-04T00:00:00Z' }); },
    salesFor: async seller => [...sales.values()].filter(sale => sale.seller === seller),
  };
}

function account(shared, maker, { fail = false, payouts = null } = {}) {
  const tasks = new Map(), saved = new Map(), charges = new Map();
  let executions = 0;
  const payers = makePayers({
    credit: async () => ({ effects: [], offer: { id: 'credit', allowances: [{ access: 'tool-spend', per: 'once', amount_micros: 1000000, currency: 'usd' }] }, access: 'tool-spend', lifecycle: { transitions: [] } }),
    charges: { read: async id => charges.get(id), write: async charge => { charges.set(charge.task_id, charge); }, list: async () => [...charges.values()] },
    limits: async () => ({ limits: [], own: [] }), gateways: async () => [], platform: { holds: async () => false },
    sales: { post: shared.post, refund: shared.refund }, topUp: { words: 'Add credit.', next_call: null },
  });
  const workshop = makeWorkshop({
    host: 'hosted', maker, payers, payouts,
    market: { published: shared.published, prices: shared.prices, publishPriced: shared.publishPriced, publish: shared.publish, unpublish: shared.unpublish, sales: () => shared.salesFor(maker) },
    data: async () => readToolData(rows.map(payload => ({ payload }))),
    store: {
      readTask: async id => tasks.get(id) ?? null, writeTask: async task => { tasks.set(task.task_id, structuredClone(task)); },
      dueTasks: async () => [], nextDueAt: async () => null, lastCompleted: async () => null, taskCards: async () => [],
      readSavedTools: async () => [...saved.values()], writeSavedTool: async row => { saved.set(row.id, row); },
      putBytes: async () => {}, readBytes: async () => null,
      readEffect: async () => null, writeEffect: async () => {},
    },
    pool: { recordRun: async () => {}, recordReport: async () => {}, stats: async ids => Object.fromEntries(ids.map(id => [id, { runs: 0, contract_passed: 0, reported_met: 0, reported_failed: 0 }])) },
    executors: { 'model-runtime': async ({ invocation }) => { executions += 1; return { text: fail && invocation.input.text === 'bad' ? '' : `made ${invocation.input.text}` }; } },
  });
  return { workshop, tasks, charges, payers, executions: () => executions };
}

test('a maker price is published, disclosed and charged once per completed run; a failed run returns its charge', async () => {
  const shared = market();
  const maker = account(shared, 'maker:alpha');
  const buyer = account(shared, 'maker:beta', { fail: true });
  await maker.workshop.save({ descriptor, check: false });
  const published = await maker.workshop.publish({ tool_id: descriptor.id, usage_price: { amount_micros: 10000, currency: 'usd' }, show_on_public_site: true });
  assert.match(published.price_ref, /^price:/);
  assert.equal(shared.priceRows.size, 1);
  assert.deepEqual(publicToolCatalog({ published: [...shared.tools.values()] }).items, [{ kind: 'tool', title: 'Turn words', job: descriptor.job, from: 'maker', price: '$0.0100', per: 'completed run' }]);
  const [card] = (await buyer.workshop.find({ job: descriptor.job })).candidates;
  assert.deepEqual(card.price, { amount: '$0.0100', per: 'completed run', before_markup: true });
  const first = await buyer.workshop.run({ tool_id: descriptor.id, input: { word: 'good' }, request_key: 'paid-once' });
  assert.equal(first.state, 'completed');
  assert.equal(first.payment.charged, '$0.01');
  assert.equal(buyer.charges.get(first.task_id).micros, 10000);
  assert.equal(shared.sales.size, 1);
  assert.equal((await maker.workshop.sales()).earned, '$0.0100');
  assert.deepEqual((await maker.workshop.sales()).payout.payee, { state: 'not_set_up', needs: [] });
  assert.equal((await maker.workshop.sales()).payout.owed, '$0.0100');
  assert.equal((await maker.workshop.sales()).payout.payable, '$0.0000');
  await assert.rejects(maker.workshop.setUpPayouts({ origin: 'https://app.test' }), /Payouts are not open/);
  const repeated = await buyer.workshop.run({ tool_id: descriptor.id, input: { word: 'good' }, request_key: 'paid-once' });
  assert.equal(repeated.task_id, first.task_id);
  assert.equal(shared.sales.size, 1);
  const failed = await buyer.workshop.run({ tool_id: descriptor.id, input: { word: 'bad' }, request_key: 'failed-once' });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.payment.given_back, true);
  assert.ok(buyer.charges.get(failed.task_id).given_back_at);
  assert.equal(shared.sales.size, 1);
  assert.equal((await buyer.workshop.run({ tool_id: descriptor.id, input: { word: 'bad' }, request_key: 'failed-once' })).task_id, failed.task_id);
  await buyer.payers.settle(buyer.tasks.get(first.task_id), { failed: true });
  await buyer.payers.settle(buyer.tasks.get(first.task_id), { failed: true });
  assert.ok(shared.sales.get(first.task_id).refunded_at);
  assert.equal((await maker.workshop.sales()).earned, '$0.0000');
});

// A test payment provider: answers the operation rows maker-payouts.json names, never a real payment service.
function testProvider() {
  const calls = [];
  const accounts = new Map();
  return {
    calls, accounts,
    run: async ({ operation_id, input_facts, idempotency_key }) => {
      calls.push({ operation_id, input_facts, idempotency_key });
      if (operation_id === 'operation:create-connected-account') { const id = `acct_test_${accounts.size + 1}`; accounts.set(id, { id, capabilities: { transfers: 'inactive' }, requirements: { currently_due: ['external_account', 'individual.dob.day'] } }); return accounts.get(id); }
      if (operation_id === 'operation:read-connected-account') return accounts.get(input_facts.provider_object_ref);
      if (operation_id === 'operation:create-account-link') return { url: `https://connect.test/setup/${input_facts.operation_subject.account}` };
      if (operation_id === 'operation:create-login-link') return { url: `https://connect.test/dashboard/${input_facts.provider_object_ref}` };
      throw new Error(`unexpected ${operation_id}`);
    },
  };
}

test('a maker sets up payouts once through the payment provider and reads what is owed and payable', async () => {
  const shared = market();
  const provider = testProvider();
  let kept = null;
  const payouts = makeMakerPayouts({ maker: 'maker:alpha', sales: () => shared.salesFor('maker:alpha'), payee: { read: async () => kept, keep: async value => { kept = value; } }, provider, config: { ...payoutSettings, minimum_micros: 500000 } });
  const maker = account(shared, 'maker:alpha', { payouts });
  const buyer = account(shared, 'maker:beta');
  await maker.workshop.save({ descriptor, check: false });
  await maker.workshop.publish({ tool_id: descriptor.id, usage_price: { amount_micros: 400000, currency: 'usd' } });
  await buyer.workshop.run({ tool_id: descriptor.id, input: { word: 'one' }, request_key: 'sale-one' });
  assert.equal((await maker.workshop.sales()).payout.owed, '$0.4000');

  const request = new Request('https://app.test/tools/payouts', { method: 'POST', body: JSON.stringify({ email: 'maker@inbox.gettrillion.ai' }) });
  const started = await (await handleWorkshopRequest(maker.workshop, request)).json();
  assert.equal(started.url, 'https://connect.test/setup/acct_test_1');
  assert.deepEqual(started.payee, { state: 'needs_details', needs: ['external_account', 'individual.dob.day'] });
  assert.equal(started.payable, '$0.0000');
  const opened = provider.calls.find(call => call.operation_id === 'operation:create-connected-account');
  assert.equal(opened.idempotency_key, 'payee:maker:alpha');
  assert.equal(opened.input_facts.operation_subject.controller.stripe_dashboard.type, 'express');
  assert.equal(opened.input_facts.operation_subject.email, 'maker@inbox.gettrillion.ai');
  assert.equal(provider.calls.find(call => call.operation_id === 'operation:create-account-link').input_facts.operation_subject.return_url, 'https://app.test/marketplace');

  await maker.workshop.setUpPayouts({ origin: 'https://app.test' });
  assert.equal(provider.calls.filter(call => call.operation_id === 'operation:create-connected-account').length, 1);

  provider.accounts.set('acct_test_1', { id: 'acct_test_1', capabilities: { transfers: 'active' }, requirements: { currently_due: [] } });
  const ready = await maker.workshop.setUpPayouts({ origin: 'https://app.test' });
  assert.equal(ready.url, 'https://connect.test/dashboard/acct_test_1');
  assert.equal(ready.payee.state, 'ready');
  assert.equal(ready.payable, '$0.0000', 'below the minimum nothing is payable yet');
  await buyer.workshop.run({ tool_id: descriptor.id, input: { word: 'two' }, request_key: 'sale-two' });
  const status = (await maker.workshop.sales()).payout;
  assert.equal(status.owed, '$0.8000');
  assert.equal(status.payable, '$0.8000');
  assert.equal(status.next, 'Ready to be paid.');
  assert.equal((await account(shared, 'maker:gamma').workshop.sales()).payout.owed, '$0.0000', 'another maker is owed nothing from these sales');
});
