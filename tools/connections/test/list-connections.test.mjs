// tool:list-connections. Ported from old trillion test/held-values.test.mjs (before 4ffa1dc4a2), whose listing
// assertions ran tool:list-connections over a store the connect, check, replace and disconnect operations wrote:
//   - a connection is listed by its id, with can_send as its last check left it;
//   - who connected it (connected_by) and the account's name (account_label) are the row's own;
//   - with no connection the list is empty;
//   - a disconnected connection stays listed, with can_send false;
//   - each connection is listed once (another account of the same service is its own row).
// Today the connect operations that wrote those facts have no owner a Workshop run reaches, so the rows are made-up
// `connection` records and the vault's held names (the account files read's held_connections), both handed in as input.
// And from old src/connection-summaries.mjs: rows come in connection id order, and until every connection has its
// row the list answers from the facts (here: what the held names say), never leaving a connection out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listConnections } from '../do-work/list-connections.mjs';
import { needingYouOf, connectedVendorsOf } from '../../find-and-keep-my-connections/src/connection-summaries.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';

const ROW = rowOf(JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')), 'tool:list-connections');
const AT = '2026-10-01T09:00:00.000Z';
const recordOf = value => ({ id: `connection:${encodeURIComponent(value.connection_id)}`, type: 'connection', value });
const stripe = (extra = {}) => recordOf({ connection_id: 'service_connection:stripe', service: 'Stripe', vendor: 'stripe', status: 'connected', can_send: true, connected_at: AT, grant_scopes_known: false, ...extra });

// Runs the tool the way the row does: the connection records and the vault's held names both come in the input, the tool
// reads no store and no door.
const listWith = ({ records = [], held = [] } = {}) => listConnections({ connection_records: records, held_connections: held });
const heldOf = (...ids) => ids.map(connection_id => ({ connection_id, fields: ['secret_key'] }));

test('a connection is listed by its id with can_send, from the records handed in and the held names', async () => {
  const { connections } = await listWith({ records: [stripe()], held: heldOf('service_connection:stripe') });
  assert.equal(connections[0].connection_id, 'service_connection:stripe');
  assert.equal(connections[0].can_send, true);
  assert.deepEqual(connections, [{ connection_id: 'service_connection:stripe', service: 'Stripe', vendor: 'stripe', status: 'connected', connected_at: AT, can_send: true, grant_scopes_known: false }]);
});

test('a connection an AI app made says which app made it, and one the person made says none; its account name is its own', async () => {
  let listed = (await listWith({ records: [stripe({ connected_by: 'Claude Code' })], held: heldOf('service_connection:stripe') })).connections;
  assert.equal(listed[0].connected_by, 'Claude Code');
  listed = (await listWith({ records: [stripe()], held: heldOf('service_connection:stripe') })).connections;
  assert.equal(listed[0].connected_by, undefined, 'the person connected it themselves, so no app is named');
  listed = (await listWith({ records: [recordOf({ connection_id: 'service_connection:instagram', service: 'Instagram', vendor: 'instagram', account_label: 'someone_posts', status: 'connected', can_send: true })], held: heldOf('service_connection:instagram') })).connections;
  assert.equal(listed[0].account_label, 'someone_posts');
});

test('with no connection the list is empty', async () => {
  assert.deepEqual((await listWith()).connections, []);
});

test('a check the service refused, and a disconnect, leave the connection listed with can_send false', async () => {
  const broken = await listWith({ records: [stripe({ can_send: false, last_checked: { at: AT, service_answered: 401 } })], held: heldOf('service_connection:stripe') });
  assert.equal(broken.connections[0].can_send, false);
  assert.deepEqual(broken.connections[0].last_checked, { at: AT, service_answered: 401 });
  // Disconnected: the values are gone from the vault, the connection's row stays.
  const gone = (await listWith({ records: [stripe({ status: 'disconnected', can_send: false })], held: [] })).connections[0];
  assert.equal(gone.can_send, false);
  assert.equal(gone.status, 'disconnected');
});

test('each connection is listed once, in connection id order, another account of a service its own row', async () => {
  const shop = recordOf({ connection_id: 'service_connection:stripe:shop-account', service: 'Stripe', vendor: 'stripe', account_label: 'Shop account', status: 'connected', can_send: true });
  const ids = async records => (await listWith({ records, held: heldOf('service_connection:stripe', 'service_connection:stripe:shop-account') })).connections.map(item => item.connection_id);
  assert.deepEqual(await ids([shop, stripe()]), ['service_connection:stripe', 'service_connection:stripe:shop-account']);
  assert.deepEqual(await ids([stripe(), shop, stripe()]), ['service_connection:stripe', 'service_connection:stripe:shop-account']);
});

test('until every held connection has its row the list answers from the facts: what the held names say, the rest unknown', async () => {
  const { connections } = await listWith({ records: [stripe()], held: heldOf('service_connection:notion', 'service_connection:stripe') });
  assert.deepEqual(connections, [
    { connection_id: 'service_connection:notion', service: 'Notion', vendor: 'notion', status: undefined, can_send: false, connected_at: undefined, grant_scopes_known: false },
    stripe().value,
  ]);
  assert.equal(JSON.parse(JSON.stringify(connections[0])).status, undefined, 'a status nobody kept is left out, never said');
  // A service with no descriptor is named by its vendor.
  const other = (await listWith({ held: heldOf('service_connection:made-up-service') })).connections[0];
  assert.equal(other.service, 'made-up-service');
  assert.equal(other.vendor, 'made-up-service');
});

test('a record shows only the row\'s own fields, and one that names another connection than its id is not a row', async () => {
  const leaky = stripe({ plain: { site: 'https://shop.example' }, held: ['secret_key'], secret_key: 'sk_test_made_up' });
  const forged = { ...stripe(), id: 'connection:service_connection%3Aother' };
  const { connections } = await listWith({ records: [leaky, forged], held: [] });
  assert.equal(connections.length, 1);
  assert.ok(!JSON.stringify(connections).includes('sk_test_made_up'));
  assert.equal(connections[0].plain, undefined);
});

test('held names left out or not a list are refused, never answered as having no connections', async () => {
  await assert.rejects(listConnections({ connection_records: [stripe()] }), /Send held_connections/);
  await assert.rejects(listConnections({ connection_records: [stripe()], held_connections: 'none' }), /Send held_connections/);
  await assert.rejects(listConnections({ connection_records: [stripe()], held_connections: { connections: heldOf('service_connection:stripe') } }), /Send held_connections/);
  // An empty list handed in is an answer (no connection holds values); a left-out one is not.
  assert.deepEqual((await listConnections({ connection_records: [], held_connections: [] })).connections, []);
  await assert.rejects(listConnections({ held_connections: [] }), /Send \{ connection_records/);
  await assert.rejects(listConnections({}), /Send \{ connection_records/);
});

test('the listing feeds the old summary readers: what needs the person and which vendors are connected', async () => {
  const records = [stripe(), recordOf({ connection_id: 'service_connection:x', service: 'X', vendor: 'x', status: 'disconnected', can_send: false })];
  const { connections } = await listWith({ records, held: heldOf('service_connection:stripe') });
  assert.deepEqual(connectedVendorsOf(connections), ['stripe']);
  assert.deepEqual(needingYouOf(connections).map(row => row.connection_id), ['service_connection:x']);
});

test('the row runs the way the engine runs it, over its sample', async () => {
  const [sample] = ROW.verify;
  const run = await answerOf(ROW, sample.input, sample);
  assert.equal(run.status, 0, run.error);
  assert.deepEqual(run.result.connections.map(row => row.connection_id), ['service_connection:notion', 'service_connection:stripe']);
  assert.equal(run.result.connections[0].service, 'Notion');
});

test('the row runs the workflows runner over this module, with no records door and no records right', async () => {
  assert.equal(ROW.invoke.records, undefined, 'the row declares no records door');
  assert.equal(ROW.invoke.run[1], '/opt/workflows/do-work/run-a-function.mjs');
  assert.ok(!JSON.stringify(ROW).includes('records-door'), 'no records-door mount or use is left in the row');
  const { connections } = await listWith({ records: [stripe()], held: heldOf('service_connection:stripe') });
  assert.equal(connections.length, 1);
  assert.equal(connections[0].connection_id, 'service_connection:stripe');
});
