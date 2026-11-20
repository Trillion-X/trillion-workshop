// The Stripe money read names the connection it reads with: the handle the person's connections list gives for that
// vendor (input.connection.connection_id), so the read finds the key that account holds. A service whose connections
// are unknown is not read, so it is drawn as unread; one of which several accounts are held is refused, naming them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyServices, readMoney } from '../do-work/business-screen.mjs';

const rows = { tools: [{ id: 'tool:stripe-events-read_money_since', invoke: { kind: 'http', connection: { vendor: 'stripe', from_input: 'connection' } } }] };
const account = 'service_connection:stripe:example-shop';

test('each connected Stripe service carries the handle of its own account from the connections list', () => {
  const [service] = moneyServices(rows, [{ connection_id: account, vendor: 'stripe', status: 'connected' }]);
  assert.equal(service.connection_id, account);
  assert.equal(service.connected, true);
  assert.equal(moneyServices(rows, [])[0].connection_id, undefined);
});

test('the money read is run with that connection named in its input, and without one when unknown', async () => {
  const seen = [];
  const run = async (tool_id, input) => { seen.push({ tool_id, input }); return { data: [], has_more: false }; };
  const since = new Date('2026-11-01T00:00:00.000Z');
  await readMoney({ services: moneyServices(rows, [{ connection_id: account, vendor: 'stripe' }]), run, since });
  const unknown = await readMoney({ services: moneyServices(rows, null), run, since });
  assert.deepEqual(seen.map(call => call.input), [{ since: Math.floor(since.getTime() / 1000), connection: { connection_id: account } }]);
  assert.equal(unknown[0].money, null);
});

test('several held Stripe accounts are refused plainly, naming them', async () => {
  const held = ['service_connection:stripe:one', 'service_connection:stripe:two'];
  const services = moneyServices(rows, held.map(connection_id => ({ connection_id, vendor: 'stripe' })));
  await assert.rejects(readMoney({ services, run: async () => ({ data: [] }), since: new Date() }), error => held.every(id => error.message.includes(id)) && /more than one stripe account/i.test(error.message));
});
