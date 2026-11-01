import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { resolveUsagePricing, settleResourcePool, priceUsageTree, cashClearing, compareAmounts, addAmounts, resourceReservationQuote, multiplyAmounts, divideAmounts } from '../read-data/resource-usage.mjs';
import { manageUsagePricing, priceResourceUsage, keepResourceUsageObservation, settleSharedResourceCost, correctResourceUsageSettlement, readResourceUsageSettlement, usageRecordTypes } from '../do-work/resource-usage.mjs';

const key = { supplier_pool: 'pool:a', tariff_version: 'tariff:1', cost_class: 'source-transfer', invoice_period: '2026-10', currency: 'usd', resource_id: 'resource:source-bytes' };
const at = '2026-10-31T12:00:00Z';
const rule = (id, scope = {}, markup_bps = '3000', effective_at = '2026-01-01T00:00:00Z') => ({ id, scope, markup_bps, effective_at });
const terms = (markup_bps = '3000') => ({ resource_id: key.resource_id, rule_ref: 'rule:default:v1', markup_bps });
const payer = (id, excess = '1', extra = {}) => ({ payer_id: id, kind: 'customer', excess_units: excess, max_unit_cost: '1', authorized_total: '1000000', terms: terms(), ...extra });
const settle = (payers, amount = '1', extra = {}) => settleResourcePool({ settlement_key: key, invoice: { status: 'confirmed', amount, evidence_ref: 'invoice:observed' }, payers, ...extra });
const equal = (actual, expected) => assert.equal(compareAmounts(actual, expected), 0, `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);

test('resource, plan and client overrides resolve from effective DATA; purchased terms stay pinned', () => {
  const rules = [rule('default'), rule('resource', { resource_id: 'resource:storage' }, '2000'), rule('plan', { plan_id: 'plan:a' }, '4000'), rule('client', { client_id: 'client:a' }, '1000')];
  const read = extra => resolveUsagePricing({ rules, at, resource_id: 'resource:storage', ...extra });
  assert.equal(read({}).markup_bps, '2000');
  assert.equal(read({ plan_id: 'plan:a' }).markup_bps, '4000');
  assert.equal(read({ plan_id: 'plan:a', client_id: 'client:a' }).markup_bps, '1000');
  const pinned = read({});
  assert.equal(read({ rules: [rule('new-default', {}, '9000')], pinned_terms: pinned }).markup_bps, '2000');
  assert.throws(() => read({ rules: [rule('one'), rule('two')] }), /equally specific/);
  assert.throws(() => read({ rules: [] }), /No effective/);
});

test('human-facing percentages convert exactly and conflicting representations refuse', () => {
  const base = { at, resource_id: key.resource_id };
  const human = { id: 'human', effective_at: '2026-01-01T00:00:00Z', markup_percent: '12.50' };
  assert.equal(resolveUsagePricing({ ...base, rules: [human] }).markup_bps, '1250');
  assert.throws(() => resolveUsagePricing({ ...base, rules: [{ ...human, markup_bps: '3000' }] }), /disagree/);
  assert.throws(() => resolveUsagePricing({ ...base, rules: [{ ...human, markup_percent: '12.505' }] }), /two decimal/);
});

test('future versions and retirement preserve earlier-time pricing, without reselling a retired rule', () => {
  const rules = [ { ...rule('same'), version: 1 }, { ...rule('same', {}, '5000', '2026-11-01T00:00:00Z'), version: 2 }, { ...rule('same', {}, '5000', '2026-12-01T00:00:00Z'), version: 3, state: 'retired' } ];
  const read = time => resolveUsagePricing({ rules, at: time, resource_id: key.resource_id });
  assert.equal(read(at).markup_bps, '3000');
  assert.equal(read('2026-11-15T00:00:00Z').markup_bps, '5000');
  assert.throws(() => read('2026-12-02T00:00:00Z'), /No effective/);
});

test('extreme reader receives only actual pool cost plus its markup; included neighbors stay zero', () => {
  const result = settle([payer('heavy', '2999969.7', { max_unit_cost: '0.01' }), payer('neighbors', '0')], '0.997');
  assert.equal(result.state, 'reconciled');
  equal(result.allocations[0].supplier_cost, '0.997');
  equal(result.allocations[0].charged, '1.2961');
  equal(result.allocations[1].charged, '0');
  equal(result.company_cost, '0');
});

test('pre-dispatch quotes keep included supplier funding separate from customer excess and require the real atomic owner', () => {
  const quote = extra => resourceReservationQuote({ requested_units: '10', remaining_included_units: '10', max_unit_cost: '0.01', terms: terms(), customer_available: '0', company_available: '0.1', ...extra });
  const included = quote({});
  assert.equal(included.state, 'quote_within_supplied_balances'); assert.equal(included.requires_atomic_reservation, true);
  equal(included.customer_liability, '0'); equal(included.company_liability, '0.1');
  assert.equal(quote({ company_available: '0' }).state, 'funding_required');
  const excess = quote({ remaining_included_units: '0', company_available: '0', customer_available: '0.129' });
  assert.equal(excess.state, 'customer_budget_exceeded'); equal(excess.customer_liability, '0.13');
});

test('platform work, contractual caps and unmatched cost cannot be shifted to an innocent customer', () => {
  const rows = [payer('c', '1', { authorized_total: '0.13' }), { payer_id: 'platform', kind: 'platform', excess_units: '1' }, payer('included', '0')];
  const result = settle(rows, '2');
  equal(result.allocations[0].supplier_cost, '0.1');
  equal(result.allocations[0].charged, '0.13');
  equal(result.allocations[1].supplier_cost, '1');
  equal(result.allocations[2].charged, '0');
  equal(result.company_cost, '1.9');
  assert.equal(result.state, 'funding_required');
  assert.equal(settle(rows, '2', { company_funding: '1.9' }).state, 'reconciled');
  const noExcess = settle([payer('included', '0')], '1');
  equal(noExcess.customer_charged, '0');
  equal(noExcess.company_residual, '1');
  assert.equal(noExcess.state, 'funding_required', 'no silent company-funded free grant');
});

test('exact allocation conserves cost and rate/authorization ceilings across reordered inputs', () => {
  for (let a = 0; a <= 8; a++) for (let b = 0; b <= 8; b++) {
    const payers = [payer('a', String(a), { max_unit_cost: '0.07', authorized_total: '0.26' }), payer('b', String(b), { max_unit_cost: '0.11', terms: terms('5000') })];
    const first = settle(payers, '0.731'); const second = settle([...payers].reverse(), '0.731');
    for (const row of first.allocations) {
      assert.deepEqual(row, second.allocations.find(p => p.payer_id === row.payer_id));
      if (row.payer_id === 'a') assert.ok(compareAmounts(row.charged, '0.26') <= 0);
    }
    equal(addAmounts(first.customer_supplier_cost, first.company_cost), '0.731');
  }
});

test('incomplete supplier evidence and independent billing scopes are refused', () => {
  assert.throws(() => settleResourcePool({ settlement_key: key, invoice: { status: 'estimated', amount: '1', evidence_ref: 'estimate' }, payers: [] }), /confirmed supplier invoice/);
  assert.throws(() => settle([payer('c', '1', { settlement_key: { ...key, supplier_pool: 'pool:b' } })]), /another supplier/);
  assert.throws(() => settle([payer('c'), payer('c')]), /twice/);
  assert.throws(() => settle([payer('c', '1', { authorized_total: '-1' })]), /negative/);
  assert.throws(() => settle([payer('c')], 0.997), /integer decimal string/);
});

test('nested details and visibility never change totals or mark up already priced rollups', () => {
  const tree = { id: 'usage', label: 'Usage', currency: 'usd', children: [
    { id: 'storage', resource_id: 'resource:storage', label: 'Storage', currency: 'usd', cost: '1', quantity: '100', unit: 'GB-month' },
    { id: 'work', label: 'Work', currency: 'usd', presentation: { visible: false }, children: [
      { id: 'ai', resource_id: 'resource:ai', label: 'AI', currency: 'usd', cost: '2' },
    ] },
  ] };
  const priced = priceUsageTree({ tree, rules: [rule('default'), rule('ai', { resource_id: 'resource:ai' }, '1000')], at });
  equal(priced.base_cost, '3'); equal(priced.markup_amount, '0.5'); equal(priced.charged, '3.5');
  assert.equal(priced.children[1].presentation.visible, false);
  equal(priced.children[1].charged, '2.2');
  assert.equal(priced.children[1].markup_bps, null);
  assert.throws(() => priceUsageTree({ tree: { ...tree, cost: '1' }, rules: [rule('default')], at }), /rollup cannot/);
  tree.children[1].children[0].currency = 'eur';
  assert.throws(() => priceUsageTree({ tree, rules: [rule('default')], at }), /different currencies/);
});

test('subcent balances carry without assigning another customer a rounding cent', () => {
  const first = cashClearing({ amount: '0.006', ceiling: '0.006' }); equal(first.amount, '0'); equal(first.carry, '0.006');
  const next = cashClearing({ amount: '0.006', carry: first.carry, ceiling: '0.012' }); equal(next.amount, '0.01'); equal(next.carry, '0.002');
  assert.throws(() => cashClearing({ amount: '1', quantum: '0' }), /positive/);
});

function memoryDoor() {
  const records = new Map(); const keys = new Map(); const writes = []; let failAfterCommit = false;
  const door = {
    async read(type, id) { const row = records.get(id); return row?.type === type ? structuredClone(row.value) : null; },
    async *list({ type, prefix = '', above, below, reverse } = {}) { if (!reverse) throw new Error('Native unordered kind reads require descending id order.'); for (const [id, row] of [...records].sort(([a], [b]) => b.localeCompare(a))) if (row.type === type && id.startsWith(prefix) && (!above || id > above) && (!below || id < below)) yield { id, ...structuredClone(row) }; },
    async write(rows, { key: requestKey } = {}) {
      if (keys.has(requestKey)) return keys.get(requestKey);
      assert.ok(Buffer.byteLength(JSON.stringify(rows)) < 60000, 'bounded record write does not reproduce the 413 boundary');
      for (const row of rows) if (Object.hasOwn(row, 'expected')) assert.deepEqual(records.get(row.id) ?? null, row.expected, 'current record snapshot must match');
      for (const row of rows) records.set(row.id, { type: row.type, value: structuredClone(row.value) });
      writes.push(rows); keys.set(requestKey, { changed: true });
      if (failAfterCommit) { failAfterCommit = false; throw new Error('unknown delivery after committed write'); }
      return { changed: true };
    },
  };
  return { door, writes, records, failNext() { failAfterCommit = true; } };
}

test('pricing configuration CRUD uses version conflicts, exact retries and immutable purchased snapshots', async () => {
  const { door } = memoryDoor();
  const input = { action: 'save', rule_id: 'default', expected_version: 0, request_key: 'create', rule: rule('ignored') };
  const saved = await manageUsagePricing(input, { door });
  assert.equal(saved.rule.version, 1);
  assert.deepEqual(await manageUsagePricing(input, { door }), saved);
  await assert.rejects(manageUsagePricing({ ...input, rule: rule('changed', {}, '5000') }, { door }), /different input/);
  await assert.rejects(manageUsagePricing({ ...input, request_key: 'stale' }, { door }), /changed/);
  const pinned = (await priceResourceUsage({ at, resource_id: key.resource_id }, { door })).terms;
  await manageUsagePricing({ ...input, expected_version: 1, request_key: 'new', rule: rule('ignored', {}, '5000', '2026-11-01T00:00:00Z') }, { door });
  assert.equal((await priceResourceUsage({ at, resource_id: key.resource_id }, { door })).terms.markup_bps, '3000');
  await manageUsagePricing({ action: 'delete', rule_id: 'default', expected_version: 2, effective_at: '2026-12-01T00:00:00Z', request_key: 'delete' }, { door });
  await assert.rejects(priceResourceUsage({ at: '2026-12-02T00:00:00Z', resource_id: key.resource_id }, { door }), /No effective/);
  assert.equal((await priceResourceUsage({ at: '2026-12-02T00:00:00Z', resource_id: key.resource_id, pinned_terms: pinned }, { door })).terms.markup_bps, '3000');
  assert.equal((await manageUsagePricing({ action: 'read', rule_id: 'default', version: 1 }, { door })).rule.state, 'active');
});

test('source observations keep unknown outcomes and corrections without rewriting evidence', async () => {
  const { door } = memoryDoor();
  const observation = { event_id: 'attempt:1', payer_id: 'c', settlement_key: key, observed_at: at, state: 'unknown', evidence_ref: 'engine:attempt:1' };
  await keepResourceUsageObservation({ request_key: 'unknown', observation }, { door });
  await assert.rejects(keepResourceUsageObservation({ request_key: 'overwrite', observation: { ...observation, state: 'observed', source_units: '1', delivered_units: '1', excess_units: '1' } }, { door }), /immutable/);
  const confirmed = await keepResourceUsageObservation({ request_key: 'confirmed', observation: { ...observation, event_id: 'attempt:1-confirmed', supersedes: 'resource-usage-observation:attempt%3A1', state: 'observed', source_units: '10', delivered_units: '20', excess_units: '2' } }, { door });
  const result = await settleSharedResourceCost({ settlement_id: 'pool-period', request_key: 'settle', settlement_key: key, invoice: { status: 'confirmed', amount: '0.1', evidence_ref: 'supplier:invoice' }, payers: [payer('c')], observation_refs: ['resource-usage-observation:attempt%3A1', confirmed.record_id] }, { door });
  assert.equal(result.settlement.result.state, 'reconciled');
  const page = await readResourceUsageSettlement({ settlement_id: 'pool-period' }, { door });
  equal(page.allocations[0].excess_units, '2');
});

test('settlement corrections preserve old versions and pinned terms, produce explicit credits and do not send money', async () => {
  const { door } = memoryDoor();
  const first = { settlement_id: 'invoice:1', request_key: 'settle', settlement_key: key, invoice: { status: 'confirmed', amount: '1', evidence_ref: 'invoice:1' }, payers: [payer('c')] };
  const saved = await settleSharedResourceCost(first, { door });
  assert.deepEqual(await settleSharedResourceCost(first, { door }), saved);
  const corrected = await correctResourceUsageSettlement({ ...first, request_key: 'correction', expected_version: 1, reason: 'supplier credit', invoice: { ...first.invoice, amount: '0.5' } }, { door });
  assert.equal(corrected.settlement.collection_state, 'not_sent_to_payment_provider');
  const page = await readResourceUsageSettlement({ settlement_id: first.settlement_id }, { door });
  equal(page.allocations[0].delta.amount, '-0.65');
  assert.equal(page.allocations[0].delta.action, 'refund_or_credit_required');
  equal((await readResourceUsageSettlement({ settlement_id: first.settlement_id, version: 1 }, { door })).allocations[0].charged, '1.3');
  await assert.rejects(correctResourceUsageSettlement({ ...first, request_key: 'reprice', expected_version: 2, reason: 'not allowed', payers: [payer('c', '1', { terms: terms('9000') })] }, { door }), /preserve the original/);
});

test('a pool with hundreds of payers uses bounded allocation records and version-scoped pagination', async () => {
  const { door, writes } = memoryDoor();
  const payers = Array.from({ length: 240 }, (_, i) => payer(`payer:${i}`, '1'));
  const input = { settlement_id: 'large', request_key: 'large', settlement_key: key, invoice: { status: 'confirmed', amount: '1', evidence_ref: 'invoice:large' }, payers };
  const saved = await settleSharedResourceCost(input, { door });
  assert.equal(saved.settlement.allocation_count, 240);
  assert.ok(writes.every(rows => rows.length <= 16));
  const first = await readResourceUsageSettlement({ settlement_id: 'large', limit: 100 }, { door });
  assert.equal(first.allocations.length, 100); assert.ok(first.next);
  const second = await readResourceUsageSettlement({ settlement_id: 'large', limit: 100, after: first.next }, { door });
  const third = await readResourceUsageSettlement({ settlement_id: 'large', limit: 100, after: second.next }, { door });
  assert.equal(third.allocations.length, 40); assert.equal(third.next, null);
  await assert.rejects(readResourceUsageSettlement({ settlement_id: 'large', after: 'foreign:cursor' }, { door }), /another settlement/);
});

test('an unknown write outcome resumes with the same input and cannot duplicate a ledger event', async () => {
  const world = memoryDoor(); world.failNext();
  const input = { action: 'save', rule_id: 'default', expected_version: 0, request_key: 'retry', rule: rule('default') };
  await assert.rejects(manageUsagePricing(input, world), /unknown delivery/);
  assert.equal((await manageUsagePricing(input, world)).rule.version, 1);
  assert.equal([...world.records.values()].filter(row => row.type === usageRecordTypes.ruleVersion).length, 1);
});

test('two simultaneous pricing edits cannot both replace the same current version', async () => {
  const { door } = memoryDoor();
  const create = i => manageUsagePricing({ action: 'save', rule_id: 'same', expected_version: 0, request_key: `create:${i}`, rule: rule('same', {}, String(i * 1000)) }, { door });
  const results = await Promise.allSettled([create(1), create(2)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});

function throughRunner(name, input, descriptor) {
  return new Promise((resolve, reject) => {
    const fd = openSync(descriptor, 'r');
    const child = spawn(process.execPath, [new URL('../../records-door/do-work/run-an-export.mjs', import.meta.url).pathname, new URL('../do-work/take-payments.mjs', import.meta.url).pathname, name], { stdio: ['pipe', 'pipe', 'pipe', fd] });
    let stdout = '', stderr = '';
    child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
    child.on('error', reject);
    child.on('close', code => { closeSync(fd); try { resolve({ code, answer: JSON.parse(stdout.trim().split('\n').at(-1)), stderr }); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify(input));
  });
}

test('the actual Marketplace export runner uses the mounted records capability, retries unknown writes and refuses foreign record rights', async () => {
  const rights = Object.values(usageRecordTypes).map(kind => ({ kind, operations: ['records:read', 'records:list', 'records:write'] }));
  const server = await startFakeDoor({ rights, unknownFirst: 1, eventStream: true, pageCut: 1 });
  try {
    const saved = await throughRunner('manageUsagePricing', { action: 'save', rule_id: 'runner', expected_version: 0, request_key: 'runner-create', rule: rule('runner') }, server.descriptor);
    assert.equal(saved.code, 0, saved.stderr); assert.equal(saved.answer.result.rule.version, 1);
    const priced = await throughRunner('priceResourceUsage', { at, resource_id: key.resource_id }, server.descriptor);
    assert.equal(priced.code, 0); assert.equal(priced.answer.result.terms.markup_bps, '3000');
    assert.ok(server.calls.some((call, index, calls) => call.method === 'records:write' && calls.some((other, j) => j !== index && other.key === call.key)), 'the unknown write retries one key');
    const settled = await throughRunner('settleSharedResourceCost', { settlement_id: 'runner', request_key: 'runner-settle', settlement_key: key, invoice: { status: 'confirmed', amount: '0.1', evidence_ref: 'invoice:runner' }, payers: [payer('c')] }, server.descriptor);
    assert.equal(settled.code, 0, settled.answer.error); assert.equal(settled.answer.result.settlement.result.state, 'reconciled');
    const read = await throughRunner('readResourceUsageSettlement', { settlement_id: 'runner' }, server.descriptor);
    assert.equal(read.code, 0); equal(read.answer.result.allocations[0].charged, '0.13');
    assert.ok(server.calls.some(call => call.method === 'records:list' && call.input.reverse === true), 'pagination direction is explicit');
  } finally { await server.close(); }
  const readOnly = await startFakeDoor({ rights: Object.values(usageRecordTypes).map(kind => ({ kind, operations: ['records:read', 'records:list'] })) });
  try {
    const refused = await throughRunner('manageUsagePricing', { action: 'save', rule_id: 'refused', expected_version: 0, request_key: 'refused', rule: rule('refused') }, readOnly.descriptor);
    assert.equal(refused.code, 1); assert.match(refused.answer.error, /may not reach/); assert.equal(readOnly.kept.size, 0);
  } finally { await readOnly.close(); }
});


test('exact component projection multiplies and divides without cash rounding', () => {
  equal(multiplyAmounts('0.015', {n:'1',d:'30'}), '0.0005');
  equal(divideAmounts('0.02', '30'), {n:'1',d:'1500'});
  assert.throws(() => divideAmounts('1', '0'), /nonpositive/);
});
