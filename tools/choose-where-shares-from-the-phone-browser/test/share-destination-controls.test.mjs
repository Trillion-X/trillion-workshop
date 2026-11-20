// The source lineage is in ../moved-from.json. These controls exercise the
// ported owner and trusted request-scoped callbacks, not an HTTP admission gate.
// Case: source:bGVhZC02NiAyMDI2LTExLTAzIDIxOjAwIE1TVDogcmVzdG9yZSBsYW5lcyBhZnRlciB0aGUgYWNjb3VudCByZXN0b3JlIChvbmUgZGVjaXNpb24tZW5naW5lIHRyZWUsIHZvaWNlLCBtZW1vcmllcywgbG9zdCBsaXN0cyk.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handoffIdFor, makeAgents } from 'trillion-workshop/tools/shared-code/src/agents.mjs';
import { agentStoreForTests } from 'trillion-workshop/tools/shared-code/test/agent-store-for-tests.mjs';
import { handleShareDestinationsRequest, makeShareDestinations, memoryShareHistory } from '../read-data/share-destinations.mjs';
import { actionForAddress, routingAction, siteAction, startingAction } from '../read-data/share-starting-action.mjs';

// All account, person, item and policy values here are synthetic.
const starters = {
  private: { id: 'private', label: 'My account', description: 'Only me', on_by_default: true },
  pursuit: { shown: true, on_by_default: false, untitled_label: 'Untitled pursuit', with_people: 'With {names}', more_people: '{names} and {more} more', names_shown: 2 },
  focused: { first: true, on_by_default: true },
  route_itself: { action: { id: 'route-it-yourself', label: 'Choose a place', words: 'Read this and choose a permitted place.' }, connect: {} },
  saved_example_actions: [], workflow_job: 'Workflow {workflow}: {run_id}', default_action_by_site: [],
  person_share_sources: [], share_said: 'Shared {items}', tool_places: { takes: 'things', id_prefix: 'tool-place:' }, kept_share_folders: [],
};
const inboundWords = { priority: { from_person: 5 } };
const permitted = { id: 'pursuit:allowed', title: 'Allowed studio', depth: 0, space_id: 'space-allowed', others: [], people_count: 1 };
const foreign = { id: 'pursuit:foreign', title: 'FOREIGN LABEL MUST NOT LEAVE', depth: 0, space_id: 'space-foreign', others: ['FOREIGN PERSON MUST NOT LEAVE'], people_count: 2 };
const action = { id: 'read', label: 'Read', words: 'Read the shared item.' };
const things = [{ kind: 'text', text: 'A made-up shared note.' }];

function persisted() {
  let choices = null;
  return {
    store: { choices: () => structuredClone(choices), putChoices: value => { choices = structuredClone(value); } },
    history: memoryShareHistory(),
    choices: () => structuredClone(choices),
  };
}

const acknowledged = async (path, body) => path === '/handoffs'
  ? { handoff: { handoff_id: `job:${body.request_key}` } }
  : { placed: (body.items ?? []).map((_, index) => ({ item_id: `item:${body.request_key}:${index}` })) };

function host({ state = persisted(), targets = [permitted], send: receive = acknowledged } = {}) {
  const agents = makeAgents({ store: agentStoreForTests(), starters: [action] });
  let current = structuredClone(targets), unavailable = false, toolsUnavailable = false;
  const sent = [];
  const owner = () => makeShareDestinations({
    starters, inboundWords, store: state.store, history: state.history, instructions: agents,
    pursuits: async () => { if (unavailable) throw new Error('Current authorized targets unavailable.'); return structuredClone(current); },
    tools: async () => { if (toolsUnavailable) throw new Error('Current authorized tools unavailable.'); return []; },
    focus: async () => null,
    send: async (path, body) => { sent.push({ path, body: structuredClone(body) }); return receive(path, body); },
    readLink: async () => null, later: () => {},
  });
  let shares = owner();
  const call = async (path, method = 'GET', body) => {
    const request = new Request(`https://account.example${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const response = await handleShareDestinationsRequest(shares, request);
    return { status: response.status, body: await response.json() };
  };
  return {
    state, sent, call, restart: () => { shares = owner(); }, targets: value => { current = structuredClone(value); },
    unavailable: value => { unavailable = value; }, toolsUnavailable: value => { toolsUnavailable = value; },
  };
}

test('the selector uses the longest whole domain and the first matching shared address', () => {
  const defaults = [{ host_suffix: 'example.com', action_id: 'broad' }, { host_suffix: 'video.example.com', action_id: 'specific' }];
  assert.equal(actionForAddress(defaults, 'https://www.video.example.com/watch'), 'specific');
  for (const address of ['https://evilexample.com/', 'https://example.com.evil.test/', 'https://example.com@example.test/', 'https://user:pass@example.com/']) assert.equal(actionForAddress(defaults, address), null, address);
  const actions = [{ id: 'first' }, { id: 'broad' }, { id: 'specific' }];
  assert.equal(siteAction(['https://example.com/', 'https://video.example.com/'], actions, defaults).id, 'broad');
  assert.equal(startingAction(['https://unrelated.example/'], actions, defaults).id, 'first');
  assert.equal(routingAction(['https://unrelated.example/'], actions, defaults, { id: 'route' }).id, 'route');
  assert.deepEqual(defaults.map(row => row.action_id), ['broad', 'specific']);
});

test('the chosen target survives a new owner and delivery history keeps its exact destination', async () => {
  const h = host();
  const saved = await h.call('/share-destinations', 'POST', { destinations: [{ id: permitted.id, shown: true, on_by_default: true }] });
  assert.equal(saved.status, 200);
  assert.ok(h.state.choices().destinations.some(row => row.id === permitted.id && row.on_by_default));
  h.restart();
  assert.ok((await h.call('/share-destinations')).body.destinations.some(row => row.id === permitted.id && row.on_by_default));
  const sent = await h.call('/share-destinations/deliver', 'POST', { to: [permitted.id], items: things, request_key: 'chosen-target' });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body.delivered.map(row => row.id), [permitted.id]);
  assert.equal(h.sent[0].path, '/spaces/space-allowed/share');
  const history = await h.call('/shares');
  assert.equal(history.body.shares[0].share_id, 'chosen-target');
  assert.deepEqual(history.body.shares[0].sent_to, [{ id: permitted.id, label: permitted.title }]);
  assert.deepEqual(history.body.shares[0].items, things);
});

test('hidden and freshly removed targets cannot receive a share or reveal foreign labels', async () => {
  const h = host();
  assert.ok((await h.call('/share-destinations')).body.destinations.some(row => row.id === permitted.id));
  assert.equal((await h.call('/share-destinations', 'POST', { destinations: [{ id: permitted.id, shown: false }] })).status, 200);
  assert.ok((await h.call('/share-destinations/deliver', 'POST', { to: [permitted.id], items: things, request_key: 'hidden' })).status >= 400);
  h.targets([]);
  const current = await h.call('/share-destinations');
  assert.ok(!current.body.all_destinations.some(row => row.id === permitted.id));
  const denied = await h.call('/share-destinations/deliver', 'POST', { to: [foreign.id], items: things, request_key: 'foreign' });
  assert.ok(denied.status >= 400);
  assert.doesNotMatch(JSON.stringify([current.body, denied.body]), /FOREIGN LABEL|FOREIGN PERSON|space-foreign/);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.state.history.list({ limit: 20 }), []);
});

test('an unavailable current target provider never becomes a successful empty or stale read', async () => {
  const h = host();
  assert.equal((await h.call('/share-destinations')).status, 200);
  h.unavailable(true);
  const read = await h.call('/share-destinations');
  assert.ok(read.status >= 400);
  assert.equal(read.body.destinations, undefined);
  assert.ok((await h.call('/share-destinations/deliver', 'POST', { to: [permitted.id], items: things, request_key: 'unavailable' })).status >= 400);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.state.history.list({ limit: 20 }), []);
});

test('an unavailable current tool provider is not reported as an empty authorized list', async () => {
  const h = host();
  assert.equal((await h.call('/share-destinations')).status, 200);
  h.toolsUnavailable(true);
  const read = await h.call('/share-destinations');
  assert.ok(read.status >= 400);
  assert.equal(read.body.destinations, undefined);
  assert.equal(h.sent.length, 0);
});

test('a lost answer recovers with the same request key and updates one history row', async () => {
  const accepted = new Map();
  let fail = true, effects = 0;
  const h = host({ send: async (path, body) => {
    const prior = accepted.get(body.request_key);
    const answer = prior ?? { placed: [{ item_id: 'item:once' }] };
    if (!prior) { accepted.set(body.request_key, answer); effects += 1; }
    if (fail) { fail = false; throw new Error('The delivery answer was lost.'); }
    return answer;
  } });
  const input = { to: [permitted.id], items: things, request_key: 'retry-once' };
  const first = await h.call('/share-destinations/deliver', 'POST', input);
  assert.equal(first.status, 200);
  assert.equal(first.body.stopped_at.id, permitted.id);
  assert.deepEqual(first.body.delivered, []);
  const second = await h.call('/share-destinations/deliver', 'POST', input);
  assert.equal(second.body.stopped_at, null);
  assert.deepEqual(second.body.delivered.map(row => row.id), [permitted.id]);
  assert.equal(effects, 1, 'the receiver realizes the stable request key once');
  assert.deepEqual(h.sent.map(row => row.body.request_key), ['retry-once', 'retry-once']);
  const history = await h.call('/shares');
  assert.equal(history.body.shares.length, 1);
  assert.equal(history.body.shares[0].share_id, 'retry-once');
  assert.deepEqual(history.body.shares[0].sent_to.map(row => row.id), [permitted.id]);
  assert.equal(history.body.shares[0].stopped_at, undefined);
});

test('a private handoff without the receiving owner id stays unconfirmed and is retried with the same key', async () => {
  let answer = {};
  const h = host({ send: async () => answer });
  const input = { to: ['private'], items: things, request_key: 'missing-handoff', action: 'read' };
  const first = await h.call('/share-destinations/deliver', 'POST', input);
  assert.deepEqual(first.body.delivered, []);
  assert.equal(first.body.stopped_at.id, 'private');
  answer = { handoff: { handoff_id: 'job:confirmed' } };
  const recovered = await h.call('/share-destinations/deliver', 'POST', input);
  assert.equal(recovered.body.stopped_at, null);
  assert.deepEqual(recovered.body.handoff_ids, ['job:confirmed']);
  assert.deepEqual(h.sent.map(row => row.body.request_key), ['missing-handoff', 'missing-handoff']);
});

test('a missing or short Space receipt cannot report the selected share as delivered', async () => {
  for (const reply of [{}, { placed: [] }, { placed: [{ item_id: 'item:only-one' }] }]) {
    let answer = reply;
    const h = host({ send: async () => answer });
    const input = { to: [permitted.id], items: [...things, { kind: 'text', text: 'A second made-up note.' }], request_key: 'missing-items' };
    const first = await h.call('/share-destinations/deliver', 'POST', input);
    assert.deepEqual(first.body.delivered, []);
    assert.equal(first.body.stopped_at.id, permitted.id);
    answer = { placed: [{ item_id: 'item:one' }, { item_id: 'item:two' }] };
    const recovered = await h.call('/share-destinations/deliver', 'POST', input);
    assert.equal(recovered.body.stopped_at, null);
    assert.deepEqual(recovered.body.delivered.map(row => row.id), [permitted.id]);
    assert.deepEqual(h.sent.map(row => row.body.request_key), ['missing-items', 'missing-items']);
  }
});

test('a refused preference update leaves the earlier chosen destination unchanged', async () => {
  const h = host();
  assert.equal((await h.call('/share-destinations', 'POST', { destinations: [{ id: permitted.id, shown: true, on_by_default: true }] })).status, 200);
  const before = h.state.choices();
  const refused = await h.call('/share-destinations', 'POST', { destinations: [{ id: 'private', shown: false }], default_action_by_site: [{ host_suffix: 'example.com', action_id: 'read' }] });
  assert.ok(refused.status >= 400);
  assert.deepEqual(h.state.choices(), before);
  assert.equal(h.sent.length, 0);
});

// Ported from from-an-older-version/test/share-destinations.test.mjs.held (old lines 663 and 685), same assertions, against
// the live shares reader and the in-memory history. Neither calls a route or deliver_share (question 16).
test('a share kept before actions and runs were lists reads back as lists', async () => {
  const history = memoryShareHistory();
  history.keep({ share_id: 'old', at: '2026-10-01T00:00:00.000Z', items: [{ kind: 'link', url: 'https://example.com/' }], action: { id: 'which-pursuit', label: 'Which pursuit is this for?' }, workflow_run: { workflow_id: 'workflow:x', run_id: 'run:1' }, sent_to: [] });
  const agents = makeAgents({ store: agentStoreForTests(), starters: [action] });
  const shares = makeShareDestinations({ store: { choices: () => null, putChoices: () => {} }, history, instructions: agents, pursuits: async () => [], send: async () => ({}), readLink: async () => null, later: () => {} });
  const [row] = shares.shares({}).shares;
  assert.deepEqual(row.actions, [{ id: 'which-pursuit', label: 'Which pursuit is this for?' }]);
  assert.deepEqual(row.workflow_runs, [{ workflow_id: 'workflow:x', run_id: 'run:1' }]);
  assert.equal(row.action, undefined);
});

test('each listed share says what AI work it became, read by the request key its kept folder is named by', async () => {
  const history = memoryShareHistory();
  history.keep({ share_id: 'kept:/Shared from iPhone/KEY-1', at: '2026-10-03T19:00:00.000Z', items: [{ kind: 'file', name: 'IMG_1627.jpeg' }], sent_to: [], kept_in: '/Shared from iPhone/KEY-1' });
  history.keep({ share_id: 'kept:/Shared from iPhone/KEY-2', at: '2026-10-03T18:00:00.000Z', items: [{ kind: 'text', text: 'note' }], sent_to: [], kept_in: '/Shared from iPhone/KEY-2' });
  const agents = makeAgents({ store: agentStoreForTests(), starters: [action] });
  const done = { handoff_id: handoffIdFor('KEY-1'), state: 'finished', taken_by: 'agent-kept-filer', finished_at: '2026-10-03T20:00:00.000Z', outcome: 'Kept and filed.' };
  const shares = makeShareDestinations({ store: { choices: () => null, putChoices: () => {} }, history, instructions: agents, pursuits: async () => [], send: async () => ({}), readLink: async () => null, later: () => {}, aiWorkOf: id => (id === done.handoff_id ? done : null) });
  const [taken, waiting] = shares.shares({}).shares;
  assert.deepEqual(taken.ai_work, done);
  assert.equal(waiting.ai_work, undefined);
});
