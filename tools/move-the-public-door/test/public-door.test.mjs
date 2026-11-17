import test from 'node:test';
import assert from 'node:assert/strict';
import { hostingProvider, hostingProviders, currentDoor } from '../read-data/public-door-rows.mjs';
import { keptReceipts, receiptStore } from '../read-data/door-receipts.mjs';
import { providerClient, rentMachine } from '../../start-a-computer/do-work/rent-a-machine.mjs';
import { movePublicDoor } from '../do-work/move-public-door.mjs';
import { seeWhereTheDoorRuns, heldFrom, HOSTING_KEY, DNS_KEY } from '../do-work/door-tools.mjs';
import { connectionValues, listDoor, DNS } from './door-world.mjs';

const TOKEN = 'FAKE_PROVIDER_TOKEN_0123456789', KEY = 'ssh-ed25519 AAAATEST';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('the service-connections rows handed in are the lists: each step names a request of its own row, credentials only by vault name', async t => {
  const connections = connectionValues();
  assert.deepEqual(hostingProviders(connections).map(r => r.id), ['example-cloud', 'no-public-address', 'own-box']);
  for (const row of hostingProviders(connections)) {
    if (row.base) assert.match(row.vault_key, /^[a-z0-9-]+$/);
    for (const part of [row.host, row.access_key].filter(Boolean)) for (const step of ['find', 'create', 'read', 'remove']) if (part[step]) assert.ok(row.requests[part[step]]?.url.startsWith(row.base), `${row.id} ${step}`);
    assert.ok(!JSON.stringify(row).match(/"(token|secret|password)"\s*:/i), `${row.id} holds no credential value`);
  }
  const placement = currentDoor(connections);
  assert.equal(placement.hosting_provider, 'example-cloud');
  const seen = await seeWhereTheDoorRuns({}, { door: await listDoor(t) });
  assert.deepEqual(seen.hosting_providers.map(r => [r.id, r.move_ready]), [['example-cloud', true], ['no-public-address', false], ['own-box', true]]);
});

test('a held value comes only from the fixed variable its row mounts', () => {
  assert.equal(heldFrom(HOSTING_KEY, { [HOSTING_KEY]: ` ${TOKEN}\n` }), TOKEN);
  assert.throws(() => heldFrom(DNS_KEY, { [HOSTING_KEY]: TOKEN }), /no held value under DNS_API_TOKEN/);
});

// One fake world for a move: the example-cloud rows' API with a door already rented there, example-dns, public DNS and HTTPS proof.
async function rentedDoor({ proofFails = false } = {}) {
  const calls = [], record = 'b'.repeat(8), dnsRows = [{ id: record, kind: 'A', host: 'door.example.com', value: '192.0.2.34', ttl: 300, proxied: false }];
  let server = null, key = null;
  const fetchImpl = async (url, { method, body }) => {
    const u = new URL(url), path = u.pathname + u.search; calls.push(`${method} ${u.host}${path}`);
    if (u.host === 'api.example.test') {
      if (method === 'GET' && u.pathname === '/v1/servers') return json({ servers: server ? [server] : [] });
      if (method === 'POST' && path === '/v1/ssh_keys') { key = { id: 12, labels: JSON.parse(body).labels }; return json({ ssh_key: key }); }
      if (method === 'POST' && path === '/v1/servers') { const b = JSON.parse(body); server = { id: 34, name: b.name, labels: b.labels, public_net: { ipv4: { ip: '192.0.2.34' } } }; return json({ server }); }
      if (path === '/v1/servers/34') { if (!server) return json({}, 404); if (method === 'DELETE') server = null; return json({ server }); }
      if (path === '/v1/ssh_keys/12') { if (!key) return json({}, 404); if (method === 'DELETE') key = null; return json({ ssh_key: key }); }
    }
    if (u.host === 'dns.example.test') {
      const p = u.pathname.replace('/v1/', '');
      if (p === 'zones') return json({ ok: true, items: u.searchParams.get('domain') === 'example.com' ? [{ id: 'a'.repeat(8), account: 'e'.repeat(8) }] : [] });
      if (p.endsWith('/rules') || p.endsWith('/links')) return json({ ok: true, items: [] });
      if (method === 'PATCH') { Object.assign(dnsRows[0], JSON.parse(body)); return json({ ok: true, item: dnsRows[0] }); }
      return json({ ok: true, items: structuredClone(dnsRows), pages: 1 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const w = { calls, dnsRows, fetchImpl, vaultAsked: [], proved: [], rented: () => ({ server, key }), resolve4: async () => [dnsRows[0].value], wait: async () => {} };
  w.credential = async name => { w.vaultAsked.push(name); return TOKEN; };
  w.prove = async (...args) => { w.proved.push(args); if (proofFails) throw new Error('download answered 404'); };
  w.oldLease = 'lease-rented-door-one';
  w.connections = connectionValues(r => {
    if (r.id === 'own-box') r.rents_a_host.placement.address = '198.51.100.7';
    if (r.kind === 'public-door-placement') Object.assign(r, { hostname: 'door.example.com', server_id: 34, address: "192.0.2.34", lease_file: w.oldLease });
  });
  w.kept = keptReceipts();
  const rentedProvider = hostingProvider('example-cloud', w.connections);
  await rentMachine({ request: providerClient(rentedProvider, TOKEN, { fetchImpl }), store: receiptStore(w.kept, w.oldLease), name: 'door-one', publicKey: KEY, provider: rentedProvider });
  calls.length = 0;
  return w;
}
// Move the door the way a caller does: the rows and the old lease's receipt handed in, the answer holding what the move made.
const moveFrom = (w, options) => movePublicDoor({ ...options, ...w, dns: DNS, receipts: w.kept.all() });

test('move the door from the rented host to an own box: every step in order, proof pinned to the new address, then the old lease goes', async () => {
  const w = await rentedDoor(), order = [];
  const steps = { setupHost: async lease => order.push(`setup ${lease.address}`), publishDownload: async (lease, placement) => order.push(`publish ${placement.address}`) };
  const { door, receipt, receipts } = await moveFrom(w, { to: 'own-box', name: 'door-two', steps });
  assert.deepEqual(receipt.done.map(s => s.id), ['rented', 'set-up', 'download-published', 'dns-cut', 'proven', 'old-released', 'door-row-made']);
  assert.deepEqual(order, ['setup 198.51.100.7', 'publish 198.51.100.7']);
  assert.equal(w.dnsRows[0].value, '198.51.100.7');
  assert.deepEqual(w.proved, [['https://door.example.com/healthz', 'door.example.com', '198.51.100.7'], ['https://door.example.com/download/App.dmg', 'door.example.com', '198.51.100.7']]);
  assert.deepEqual([w.rented(), receipts[w.oldLease].state], [{ server: null, key: null }, 'removed']);
  assert.deepEqual(w.vaultAsked, ['example-dns-token', 'example-cloud-token']);
  assert.deepEqual([door.kind, door.id, door.hosting_provider, door.address, door.dns_record, door.unknown_because, door.lease_file, door.hostname], ['public-door-placement', 'current', 'own-box', '198.51.100.7', 'b'.repeat(8), undefined, 'lease-own-box-door-two', 'door.example.com']);
  assert.deepEqual(receipts['door-move'].done.map(s => s.id), receipt.done.map(s => s.id));
  assert.deepEqual(Object.keys(receipts).sort(), ['dns-cutover-own-box-door-two', 'door-move', w.oldLease, 'lease-own-box-door-two'].sort());
});

test('a failed proof rolls DNS back and keeps the old host', async () => {
  const w = await rentedDoor({ proofFails: true }), steps = { setupHost: async () => {}, publishDownload: async () => {} };
  const failed = await moveFrom(w, { to: 'own-box', name: 'door-two', steps, attempts: 3 }).then(() => null, error => error);
  assert.match(failed.message, /not proven \(download answered 404\); DNS was rolled back/);
  assert.deepEqual([w.dnsRows[0].value, failed.receipts[w.oldLease].state, failed.receipts['lease-own-box-door-two'].state], ['192.0.2.34', 'running', 'running']);
  assert.deepEqual(failed.receipts['door-move'].done.map(s => s.id), ['rented', 'set-up', 'download-published', 'dns-cut', 'dns-rolled-back']);
  assert.equal(w.calls.filter(c => c.startsWith('DELETE')).length, 0);
});

test('a row that is not move-ready is refused by its own reason before any network or vault call', async () => {
  const w = await rentedDoor();
  await assert.rejects(moveFrom(w, { to: 'no-public-address', name: 'door-two', steps: {} }), /cannot move to A host with no public address: A host with no public IPv4 address/);
  await assert.rejects(moveFrom(w, { to: 'vercel', name: 'door-two', steps: {} }), /No hosting provider row is named "vercel"/);
  assert.deepEqual([w.calls.length, w.vaultAsked.length], [0, 0]);
});
