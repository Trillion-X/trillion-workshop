import test from 'node:test';
import assert from 'node:assert/strict';
import { platformPlanRefusalFor, PlanPolicyUnavailable } from '../read-data/platform-plan-refusal.mjs';
import { withheldFeature } from './platform-policy-fixture.mjs';
import comparison from '../src/plan-comparison.json' with { type: 'json' };
import { readToolData } from 'trillion-workshop/tools/ai-tool-catalog/read-data/read-ai-tool-catalog.ts';

const workshop = comparison.features.find(row => row.id === 'workshop');
const paid = () => ({ capabilities: [workshop.access], limits: {} });
const free = () => ({ capabilities: [workshop.access], limits: { [workshop.access]: [{ count: 5, per: 'month' }] } });
const included = id => ({ id, settings: { included_in_every_plan: true } });
const request = (toolId = 'tool:synthetic', method = 'POST', path = '/tools/run') => new Request(`https://synthetic.example${path}`, {
  method, ...(method === 'POST' ? { body: JSON.stringify({ tool_id: toolId }), headers: { 'content-type': 'application/json' } } : {}),
});

function fixture({ placements = ['paid'], catalogue, access = free() } = {}) {
  const calls = [];
  const words = [];
  const env = Object.freeze({ synthetic: true });
  const state = { access, catalogue: catalogue === undefined ? {
    tools: [{ id: 'tool:synthetic', placements }],
    placements: [included('included'), included('also-included'), { id: 'paid', settings: { included_in_every_plan: false } }, { id: 'unspecified' }],
  } : catalogue };
  const owners = {
    env,
    access: () => { calls.push('access'); return state.access; },
    decisionAllowance: async current => { calls.push('allowance'); assert.equal(current, state.access); return { count: 5, per: 'month' }; },
    fact: name => { calls.push('fact'); assert.equal(name, 'owner_user_id'); return 'owner:synthetic'; },
    loadWorkshopRows: async current => { calls.push('catalogue'); assert.equal(current, env); return state.catalogue; },
    withheldFeature,
    withheldWords: input => { calls.push('words'); words.push(input); return JSON.stringify(input); },
    upgradeArmFor: async (current, owner) => { calls.push('arm'); assert.equal(current, env); assert.equal(owner, 'owner:synthetic'); return 'offer:synthetic'; },
  };
  return { state, calls, words, owners, producer: platformPlanRefusalFor(owners) };
}

test('the real predicate produces the original refusal body through the owner word and price suppliers', async () => {
  const { producer, words } = fixture();
  const body = await producer.refusalFor(request(), { origin: 'https://synthetic.example' });
  assert.deepEqual(body, { error: JSON.stringify(words[0]), upgrade_needed: true, feature: { id: workshop.id, label: workshop.label } });
  assert.deepEqual(words[0], {
    feature: { id: workshop.id, label: workshop.label }, allowance: { count: 5, per: 'month' },
    origin: 'https://synthetic.example', offerId: 'offer:synthetic',
  });
});

test('every explicitly included placement exempts the tool, retaining refusal-before-exemption order', async () => {
  const { producer, calls } = fixture({ placements: ['included', 'also-included'] });
  assert.equal(await producer.refusalFor(request()), null);
  assert.deepEqual(calls, ['access', 'allowance', 'fact', 'arm', 'words', 'catalogue']);
});

test('empty, unknown, unspecified or mixed placements do not imply the every-plan exemption', async () => {
  for (const placements of [undefined, [], ['unknown'], ['included', 'paid'], ['included', 'unspecified']]) {
    const { producer } = fixture({ catalogue: {
      tools: [{ id: 'tool:synthetic', ...(placements === undefined ? {} : { placements }) }],
      placements: [included('included'), { id: 'paid', settings: { included_in_every_plan: false } }, { id: 'unspecified' }],
    } });
    assert.equal((await producer.refusalFor(request())).upgrade_needed, true);
  }
  assert.equal((await fixture().producer.refusalFor(request('tool:unknown'))).upgrade_needed, true);
});

test('only POST /tools/run can receive the placement exemption', async () => {
  const { producer } = fixture({ placements: ['included'] });
  assert.equal(await producer.runsInEveryPlan(request()), true);
  assert.equal(await producer.runsInEveryPlan(request(undefined, 'GET')), false);
  assert.equal(await producer.runsInEveryPlan(request(undefined, 'POST', '/tasks/run')), false);
  assert.equal((await producer.refusalFor(request(undefined, 'GET'))).upgrade_needed, true);
  assert.equal((await producer.refusalFor(request(undefined, 'POST', '/tasks/run'))).upgrade_needed, true);
  assert.equal(await producer.runsInEveryPlan(new Request('https://synthetic.example/tools/run', { method: 'POST', body: '{' })), false);
});

test('current unlimited access bypasses the paid-feature refusal and does not need a placement lookup', async () => {
  const { producer, calls } = fixture({ access: paid() });
  assert.equal(await producer.refusalFor(request()), null);
  assert.deepEqual(calls, ['access']);
  assert.equal(await producer.refusalFor(request(undefined, 'GET', '/account')), null);
});

test('each refusal uses the current owner snapshot, while seller-only access does not qualify', async () => {
  const { producer, state } = fixture({ access: paid() });
  assert.equal(await producer.refusalFor(request()), null);
  state.access = { capabilities: [], limits: {}, granted: [{ access: workshop.access, by: 'seller:synthetic' }], held_access_refs: [workshop.access] };
  assert.equal((await producer.refusalFor(request())).upgrade_needed, true);
  state.access = paid();
  assert.equal(await producer.refusalFor(request()), null);
});

test('auth or reach refusal fields never replace the platform policy', async () => {
  for (const otherRefusal of [{ authenticated: false }, { reach: { private: false, spaces: [] } }, { accepted: false, code: 'current_workspace_rights_refused' }]) {
    const { producer } = fixture({ access: { ...paid(), ...otherRefusal } });
    assert.equal(await producer.refusalFor(request()), null, 'null answers only the plan question, never operation admission');
  }
});

test('unavailable or malformed access stays unavailable even for an every-plan tool', async () => {
  for (const access of [null, true, undefined, {}, { capabilities: [], limits: null }, { capabilities: [], limits: { x: false } }]) {
    const { producer, state, calls } = fixture({ placements: ['included'] });
    state.access = access;
    await assert.rejects(producer.refusalFor(request()), error => error instanceof PlanPolicyUnavailable && error.upgrade_needed === undefined);
    assert.deepEqual(calls, ['access']);
  }
  const failed = new Error('synthetic authoritative source unavailable');
  const { owners } = fixture({ placements: ['included'] });
  owners.access = () => { throw failed; };
  await assert.rejects(platformPlanRefusalFor(owners).refusalFor(request()), error => error === failed);
});

test('unavailable catalogue or required allowance propagates rather than inventing a plan outcome', async () => {
  const failed = new Error('synthetic source unavailable');
  for (const supplier of ['loadWorkshopRows', 'decisionAllowance']) {
    const { owners } = fixture();
    owners[supplier] = async () => { throw failed; };
    await assert.rejects(platformPlanRefusalFor(owners).refusalFor(request()), error => error === failed);
  }
  for (const catalogue of [null, {}, { tools: [], placements: null }, { tools: [{ id: 'tool:synthetic', placements: 'included' }], placements: [] },
    { tools: [{ id: 'duplicate' }, { id: 'duplicate' }], placements: [] }]) {
    await assert.rejects(fixture({ catalogue }).producer.refusalFor(request()), PlanPolicyUnavailable);
  }
});

test('the named offer wins and the original optional arm failure still leaves the word supplier its null arm', async () => {
  const named = fixture();
  await named.producer.refusalFor(request(), { offerId: 'offer:named' });
  assert.equal(named.words[0].offerId, 'offer:named');
  assert.equal(named.calls.includes('fact') || named.calls.includes('arm'), false);
  const missing = fixture();
  missing.owners.upgradeArmFor = async () => { throw new Error('synthetic optional arm unavailable'); };
  await platformPlanRefusalFor(missing.owners).refusalFor(request());
  assert.equal(missing.words[0].offerId, null);
});

test('missing suppliers, malformed feature output or absent words do not manufacture upgrade responses', async () => {
  assert.throws(() => platformPlanRefusalFor({}), PlanPolicyUnavailable);
  for (const [supplier, replacement] of [['withheldFeature', () => true], ['withheldWords', () => undefined]]) {
    const { owners } = fixture();
    owners[supplier] = replacement;
    await assert.rejects(platformPlanRefusalFor(owners).refusalFor(request()), PlanPolicyUnavailable);
  }
});

test('supplied owner methods keep their receiver rather than borrowing the plan composition', async () => {
  const { owners, state } = fixture();
  const seen = [];
  owners.access = function () { assert.equal(this, owners); seen.push('access'); return state.access; };
  owners.decisionAllowance = async function () { assert.equal(this, owners); seen.push('allowance'); return { count: 5, per: 'month' }; };
  owners.fact = function () { assert.equal(this, owners); seen.push('fact'); return 'owner:synthetic'; };
  owners.upgradeArmFor = async function () { assert.equal(this, owners); seen.push('arm'); return 'offer:synthetic'; };
  owners.withheldFeature = function (...args) { assert.equal(this, owners); seen.push('predicate'); return withheldFeature(...args); };
  owners.withheldWords = function () { assert.equal(this, owners); seen.push('words'); return 'synthetic words'; };
  owners.loadWorkshopRows = async function () { assert.equal(this, owners); seen.push('catalogue'); return state.catalogue; };
  assert.equal((await platformPlanRefusalFor(owners).refusalFor(request())).upgrade_needed, true);
  assert.deepEqual(seen, ['access', 'predicate', 'allowance', 'fact', 'arm', 'words', 'catalogue']);
});

const decodedCatalogue = placements => readToolData([
  { payload: { kind: 'ai-tool-descriptor', id: 'tool:synthetic', invoke: { kind: 'container' }, placements } },
  { payload: {
    kind: 'tool-placement', id: 'included', label: 'Synthetic included placement', executor: 'synthetic',
    reachable_from: ['hosted'], settings: { included_in_every_plan: true },
  } },
]);

test('the actual catalogue decoder retains mixed placement refs but refuses a runnable tool with none admitted', async () => {
  const mixed = decodedCatalogue(['included', 'missing']);
  assert.equal(mixed.tools.length, 1);
  assert.equal((await fixture({ catalogue: mixed }).producer.refusalFor(request())).upgrade_needed, true);
  const missing = decodedCatalogue(['missing']);
  assert.equal(missing.tools.length, 0);
  assert.ok(missing.refused.some(row => row.id === 'tool:synthetic'));
  assert.equal((await fixture({ catalogue: missing }).producer.refusalFor(request())).upgrade_needed, true,
    'a complete decoded catalogue without this tool gives no every-plan exemption');
  assert.equal(await fixture({ catalogue: decodedCatalogue(['included']) }).producer.refusalFor(request()), null);
});

test('a known runnable tool contradicting the decoder placement contract is unavailable rather than an upgrade', async () => {
  const { producer } = fixture({ catalogue: {
    tools: [{ id: 'tool:synthetic', invoke: { kind: 'container' }, placements: ['missing'] }], placements: [],
  } });
  await assert.rejects(producer.refusalFor(request()), error => error instanceof PlanPolicyUnavailable && error.upgrade_needed === undefined);
});

test('an unknown tool request and a descriptor-only unresolved ref retain the original non-exempt behavior', async () => {
  assert.equal((await fixture({ catalogue: decodedCatalogue(['included']) }).producer.refusalFor(request('tool:unknown'))).upgrade_needed, true);
  const descriptorOnly = readToolData([{ payload: { kind: 'ai-tool-descriptor', id: 'tool:synthetic', placements: ['missing'] } }]);
  assert.equal(descriptorOnly.tools.length, 1);
  assert.equal((await fixture({ catalogue: descriptorOnly }).producer.refusalFor(request())).upgrade_needed, true);
});
