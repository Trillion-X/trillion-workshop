// The outcomes of the retired repository src/service-values.mjs (tag before-worker-retire, b6ae0ebf81), each as an assertion
// over the ported do-work/sign-in-app-values.mjs. The box is an in-memory stand-in for the account's locked box.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answerServiceValuesRequest, dropOwnSignInApp, keepOwnSignInApp, keepServiceValues, MAX_VALUE_LENGTH, ownSignInAppFact,
  ownSignInAppName, ownSignInAppNames, removeServiceValues, revealServiceValue, serviceValueNames, serviceValueStates,
  servicePlainValues, signInAppSetups,
} from '../do-work/sign-in-app-values.mjs';

const memoryBox = () => {
  const held = new Map();
  return {
    held,
    exists: name => held.has(name),
    write: (name, value) => held.set(name, value),
    reveal: name => held.get(name),
    remove: name => held.delete(name),
  };
};
const memoryPlain = () => {
  const facts = new Map();
  return { facts, read: name => facts.get(name), write: (name, value) => facts.set(name, value), remove: name => facts.delete(name) };
};

// Rows of the old shape: one hosted sign-in tool, one event source whose signing secret is held with the same connection.
const rows = {
  tools: [
    { id: 'tool:connect-acme', label: 'Acme', invoke: { provider: 'acme', connects: { connection: 'acme-connection', acquire: { client_auth: 'basic', hosted_client: { id_name: 'acme-client-id', secret_name: 'acme-client-secret', made_at: { label: 'Acme developer page', url: 'https://acme.example/dev' } } } } } },
    { id: 'tool:acme-proof', invoke: { connection: 'acme-connection' } },
  ],
  event_sources: [
    { label: 'Acme events', signature: { secret_name: 'acme-delivery-secret' }, route_key_proof: { tool_id: 'tool:acme-proof' } },
  ],
};
const formRow = { id: 'tool:connect-tiny', label: 'Tiny', invoke: { provider: 'tiny', connects: { acquire: { client_auth: 'form' } } } };
const noneRow = { id: 'tool:connect-open', label: 'Open', invoke: { provider: 'open', connects: { acquire: { client_auth: 'none' } } } };

test('the held names come from the DATA: the sign-in app id is plain, its secret and the delivery secret are not', () => {
  const names = serviceValueNames(rows);
  assert.deepEqual([...names.keys()], ['acme-delivery-secret', 'acme-client-id', 'acme-client-secret']);
  assert.equal(names.get('acme-client-id').plain, true);
  assert.equal(names.get('acme-client-secret').plain, false);
  assert.equal(names.get('acme-delivery-secret').plain, false);
  assert.equal(names.get('acme-delivery-secret').label, 'Signs deliveries for Acme events');
});

test('the setup lists the id, the secret, then the delivery secret held with the same connection, once', () => {
  const setup = signInAppSetups(rows).get('acme');
  assert.deepEqual(setup.values.map(value => value.name), ['acme-client-id', 'acme-client-secret', 'acme-delivery-secret']);
  assert.equal(setup.made_at.url, 'https://acme.example/dev');
});

test('keeping values seals them, keeps the id readable and makes the Basic value only for a Basic service', () => {
  const box = memoryBox();
  const plain = memoryPlain();
  const kept = keepServiceValues({ box, rows, values: { 'acme-client-id': '  id-1  ', 'acme-client-secret': 'sec-1' }, readPlain: plain.read, writePlain: plain.write });
  assert.deepEqual(kept.saved, ['acme-client-id', 'acme-client-secret']);
  assert.equal(box.held.get('acme-client-id'), 'id-1', 'the id is trimmed before it is kept');
  assert.equal(plain.facts.get('acme-client-id'), 'id-1', 'the id is also kept readable');
  assert.equal(plain.facts.has('acme-client-secret'), false, 'a secret is never kept readable');
  assert.equal(box.held.get('acme-client-secret-basic'), btoa('id-1:sec-1'));
});

test('a service with a form sign-in gets no Basic value, and an id already held is reused for it', () => {
  const formRows = { tools: [{ ...formRow, invoke: { provider: 'tiny', connects: { acquire: { client_auth: 'form', hosted_client: { id_name: 'tiny-id', secret_name: 'tiny-secret' } } } } }] };
  const box = memoryBox();
  const plain = memoryPlain();
  plain.facts.set('tiny-id', 'held-id');
  keepServiceValues({ box, rows: formRows, values: { 'tiny-secret': 'sec' }, readPlain: plain.read, writePlain: plain.write });
  assert.equal(box.held.has('tiny-secret-basic'), false);
  assert.equal(box.held.has('tiny-id'), false, 'an id not given is not written again');
});

test('a name the DATA does not list is refused before anything is kept, and so is a value over the cap', () => {
  const box = memoryBox();
  const plain = memoryPlain();
  assert.throws(() => keepServiceValues({ box, rows, values: { 'acme-client-id': 'ok', 'other-name': 'x' }, readPlain: plain.read, writePlain: plain.write }), /other-name is not a value this service holds\./);
  assert.equal(box.held.size, 0, 'nothing was kept when one name is refused');
  assert.throws(() => keepServiceValues({ box, rows, values: { 'acme-client-secret': 'x'.repeat(MAX_VALUE_LENGTH + 1) }, readPlain: plain.read, writePlain: plain.write }), /acme-client-secret is too long\./);
});

test('blank values are skipped, so an all-blank save keeps nothing', () => {
  const box = memoryBox();
  const plain = memoryPlain();
  assert.deepEqual(keepServiceValues({ box, rows, values: { 'acme-client-id': '   ' }, readPlain: plain.read, writePlain: plain.write }), { saved: [] });
});

test('the plain values are the held ids only', () => {
  const box = memoryBox();
  const plain = memoryPlain();
  keepServiceValues({ box, rows, values: { 'acme-client-id': 'id-1', 'acme-client-secret': 'sec-1' }, readPlain: plain.read, writePlain: plain.write });
  assert.deepEqual(servicePlainValues({ rows, readPlain: plain.read }), { 'acme-client-id': 'id-1' });
});

test('reveal answers only a held name of the DATA, and says nothing when the box has none', () => {
  const box = memoryBox();
  box.write('acme-client-secret', 'sec-1');
  assert.equal(revealServiceValue({ box, rows, name: 'acme-client-secret' }), 'sec-1');
  assert.throws(() => revealServiceValue({ box, rows, name: 'other-name' }), /other-name is not a value this service holds\./);
  assert.throws(() => revealServiceValue({ box, rows, name: 'acme-delivery-secret' }), /Nothing is held under that name\./);
});

test('remove takes the id, the secret, the Basic value and the plain copy out, and ignores names the DATA does not list', () => {
  const box = memoryBox();
  const plain = memoryPlain();
  keepServiceValues({ box, rows, values: { 'acme-client-id': 'id-1', 'acme-client-secret': 'sec-1' }, readPlain: plain.read, writePlain: plain.write });
  const removed = removeServiceValues({ box, rows, names: ['acme-client-id', 'acme-client-secret', 'other-name'], removePlain: plain.remove });
  assert.deepEqual(removed, { removed: ['acme-client-id', 'acme-client-secret'] });
  assert.equal(box.held.size, 0);
  assert.equal(plain.facts.size, 0);
});

test('the states say which names are held, never a value', () => {
  const box = memoryBox();
  box.write('acme-client-secret', 'sec-1');
  assert.deepEqual(serviceValueStates({ box, rows }), { 'acme-delivery-secret': false, 'acme-client-id': false, 'acme-client-secret': true });
});

test('an account keeps its own sign-in app: the id readable, the secret sealed, the Basic value made, and a new one replaces it', () => {
  const box = memoryBox();
  const row = { id: 'tool:connect-acme', label: 'Acme', invoke: { provider: 'acme', connects: { acquire: { client_auth: 'basic' } } } };
  const id = keepOwnSignInApp({ box, row, client_id: ' mine ', client_secret: 'mine-secret' });
  assert.equal(id, 'mine');
  assert.equal(box.held.get(ownSignInAppName('tool:connect-acme', 'client_id')), 'mine');
  assert.equal(box.held.get(ownSignInAppName('tool:connect-acme', 'client_secret')), 'mine-secret');
  assert.equal(box.held.get(ownSignInAppName('tool:connect-acme', 'basic')), btoa('mine:mine-secret'));
  assert.equal(ownSignInAppFact('tool:connect-acme'), 'own-sign-in-app:tool:connect-acme');
  keepOwnSignInApp({ box, row: formRow, client_id: 'tiny', client_secret: 'tiny-secret' });
  keepOwnSignInApp({ box, row, client_id: 'second', client_secret: 'second-secret' });
  assert.equal(box.held.get(ownSignInAppName('tool:connect-acme', 'client_id')), 'second');
  assert.equal(box.held.has(ownSignInAppName('tool:connect-tiny', 'client_secret')), true, 'another row keeps its own app');
});

test('an own sign-in app is refused without an id, without the secret its sign-in checks, and with an over-long secret', () => {
  const box = memoryBox();
  assert.throws(() => keepOwnSignInApp({ box, row: formRow, client_id: '', client_secret: 'x' }), /Give your sign-in app's client id/);
  assert.throws(() => keepOwnSignInApp({ box, row: formRow, client_id: 'id', client_secret: '' }), /checks your sign-in app with its secret: give client_secret too\./);
  assert.throws(() => keepOwnSignInApp({ box, row: formRow, client_id: 'id', client_secret: 'x'.repeat(MAX_VALUE_LENGTH + 1) }), /That client secret is too long\./);
  assert.equal(keepOwnSignInApp({ box, row: noneRow, client_id: 'open-id' }), 'open-id', 'a sign-in that sends no secret keeps only the id');
  assert.equal(box.held.has(ownSignInAppName('tool:connect-open', 'client_secret')), false);
});

test('dropping an own sign-in app removes its parts, and the names of its parts are checked', () => {
  const box = memoryBox();
  keepOwnSignInApp({ box, row: formRow, client_id: 'tiny', client_secret: 'tiny-secret' });
  dropOwnSignInApp({ box, toolId: 'tool:connect-tiny' });
  assert.equal(box.held.size, 0);
  assert.deepEqual(ownSignInAppNames({ toolId: 'tool:connect-tiny', needs: ['client_id', 'basic'] }), ['own-sign-in-app:tool:connect-tiny:client_id', 'own-sign-in-app:tool:connect-tiny:basic']);
  assert.throws(() => ownSignInAppNames({ toolId: 'tool:connect-tiny', needs: ['token'] }), /not "token"/);
});

test('the route: a visit goes to Connections, another origin is refused, bad JSON is refused', async () => {
  const operator = { keep: async () => ({}), reveal: async () => '', remove: async () => ({ removed: [] }) };
  const base = { origin: 'https://app.example', connectionsAddress: '/connections', signInAgainAddress: address => `/sign-in?return=${address}`, operator };
  assert.deepEqual(await answerServiceValuesRequest({ ...base, method: 'GET' }), { status: 302, location: 'https://app.example/connections' });
  assert.deepEqual(await answerServiceValuesRequest({ ...base, method: 'PUT' }), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await answerServiceValuesRequest({ ...base, method: 'POST', requestOrigin: 'https://evil.example', text: '{}' }), { status: 403, body: { error: 'Not allowed.' } });
  assert.deepEqual(await answerServiceValuesRequest({ ...base, method: 'POST', requestOrigin: 'https://app.example', text: 'nope' }), { status: 400, body: { error: 'Send the values as JSON.' } });
});

test('the route: a reveal needs a fresh sign-in, and a fresh one shows the value for 30 seconds', async () => {
  const seen = [];
  const operator = { keep: async () => ({}), reveal: async name => { seen.push(name); return 'sec-1'; }, remove: async () => ({ removed: [] }) };
  const base = { method: 'POST', origin: 'https://app.example', requestOrigin: 'https://app.example', connectionsAddress: '/connections', signInAgainAddress: address => `/sign-in?return=${address}`, operator };
  const stale = await answerServiceValuesRequest({ ...base, text: JSON.stringify({ action: 'reveal', name: 'acme-client-secret' }), fresh: false });
  assert.equal(stale.body.redirect, '/sign-in?return=/connections');
  assert.deepEqual(seen, [], 'nothing is read without a fresh sign-in');
  const fresh = await answerServiceValuesRequest({ ...base, text: JSON.stringify({ action: 'reveal', name: 'acme-client-secret' }), fresh: true });
  assert.deepEqual(fresh.body.reveal, { label: 'Copy it now. It hides again in 30 seconds.', text: 'sec-1', hide_after_seconds: 30 });
});

test('the route: a save and a removal say what happened and ask the screen to refresh', async () => {
  const operator = {
    keep: async values => ({ saved: Object.keys(values) }),
    reveal: async () => '',
    remove: async names => ({ removed: names }),
  };
  const base = { method: 'POST', origin: 'https://app.example', requestOrigin: 'https://app.example', connectionsAddress: '/connections', signInAgainAddress: a => a, operator };
  const one = await answerServiceValuesRequest({ ...base, text: JSON.stringify({ values: { 'acme-client-id': 'x' } }) });
  assert.deepEqual(one.body, { saved: ['acme-client-id'], said: 'Saved. It is locked away and never shown again.', refresh: true });
  const two = await answerServiceValuesRequest({ ...base, text: JSON.stringify({ values: { 'a': 'x', 'b': 'y' } }) });
  assert.equal(two.body.said, 'Saved. They are locked away and never shown again.');
  const none = await answerServiceValuesRequest({ ...base, text: JSON.stringify({ values: {} }) });
  assert.equal(none.body.said, 'Nothing to save: every box was empty.');
  const removed = await answerServiceValuesRequest({ ...base, text: JSON.stringify({ action: 'remove', names: ['acme-client-id'] }) });
  assert.deepEqual(removed.body, { removed: ['acme-client-id'], said: 'Removed. Paste the new sign-in app to connect this service again.', refresh: true });
  const nothing = await answerServiceValuesRequest({ ...base, text: JSON.stringify({ action: 'remove', names: [] }) });
  assert.equal(nothing.body.said, 'Nothing was held to remove.');
});

test('a refused save answers 400 with the words of the refusal', async () => {
  const box = memoryBox();
  const plain = memoryPlain();
  const operator = { keep: async values => keepServiceValues({ box, rows, values, readPlain: plain.read, writePlain: plain.write }), reveal: async () => '', remove: async () => ({ removed: [] }) };
  const answer = await answerServiceValuesRequest({ method: 'POST', origin: 'https://app.example', requestOrigin: 'https://app.example', text: JSON.stringify({ values: { 'nope': 'x' } }), connectionsAddress: '/c', signInAgainAddress: a => a, operator });
  assert.deepEqual(answer, { status: 400, body: { error: 'nope is not a value this service holds.' } });
});
