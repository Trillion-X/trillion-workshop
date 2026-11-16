import test from 'node:test';
import assert from 'node:assert/strict';
import { hostingProvider, hostingProviders, dnsProviders, currentDoor } from '../read-data/public-door-rows.mjs';
import { keptReceipts } from '../read-data/door-receipts.mjs';
import { leaseClient, provisionHostLease, removeHostLease, readHostLease } from '../do-work/portable-host-lease.mjs';
import { movePublicDoor } from '../do-work/move-public-door.mjs';
import { seeWhereTheDoorRuns, heldFrom, heldVariable } from '../do-work/door-tools.mjs';
import { connectionValues, listDoor } from './door-world.mjs';

const TOKEN = 'FAKE_PROVIDER_TOKEN_0123456789', KEY = 'ssh-ed25519 AAAATEST';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const flyApp = r => { if (r.connection_id === 'service_connection:fly') r.rents_a_host.placement.which_app = 'door'; };

test('the service-connections rows handed in are the lists: each step names a request of its own row, credentials only by vault name', async t => {
  const connections = connectionValues();
  assert.deepEqual(hostingProviders(connections).map(r => r.id), ['fly', 'hetzner', 'own-box']);
  assert.deepEqual(dnsProviders(connections).map(r => r.id), ['cloudflare']);
  for (const row of [...hostingProviders(connections), ...dnsProviders(connections)]) {
    if (row.base) assert.match(row.vault_key, /^[a-z0-9-]+$/);
    for (const part of [row.host, row.access_key].filter(Boolean)) for (const step of ['find', 'create', 'read', 'remove']) if (part[step]) assert.ok(row.requests[part[step]]?.url.startsWith(row.base), `${row.id} ${step}`);
    assert.ok(!JSON.stringify(row).match(/"(token|secret|password)"\s*:/i), `${row.id} holds no credential value`);
  }
  const placement = currentDoor(connections);
  assert.deepEqual([placement.hosting_provider, placement.dns_provider], ['hetzner', 'cloudflare']);
  const seen = await seeWhereTheDoorRuns({}, { door: await listDoor(t) });
  assert.deepEqual(seen.hosting_providers.map(r => [r.id, r.move_ready]), [['fly', false], ['hetzner', true], ['own-box', true]]);
  assert.deepEqual(seen.dns_providers, [{ id: 'cloudflare', name: 'Cloudflare', vault_key: 'cloudflare-api-token' }]);
});

test('a held value comes only from the mount its vault name names', () => {
  assert.equal(heldVariable('hetzner-api-token'), 'HETZNER_API_TOKEN');
  assert.equal(heldFrom('hetzner-api-token', { HETZNER_API_TOKEN: ` ${TOKEN}\n` }), TOKEN);
  assert.throws(() => heldFrom('cloudflare-api-token', { HETZNER_API_TOKEN: TOKEN }), /no held value named cloudflare-api-token.*CLOUDFLARE_API_TOKEN/);
});

test('the Fly row drives the same lease through its own requests: rent, reuse, refuse foreign paths, release; a lost create removes only its machine', async () => {
  for (const lose of [false, true]) {
    const machines = new Map([['ffffffffffffff', { id: 'ffffffffffffff', name: 'someone-else', config: { metadata: {} } }]]), calls = [];
    const fetchImpl = async (url, { method, headers, body }) => {
      const { host, pathname, search } = new URL(url), id = pathname.split('/')[5]; calls.push(`${method} ${pathname}${search}`);
      assert.equal(host, 'api.machines.dev'); assert.equal(headers.authorization, `Bearer ${TOKEN}`);
      if (pathname === '/v1/apps/door/machines') {
        if (method === 'GET') return json([...machines.values()]);
        const b = JSON.parse(body), m = { id: '0123456789abcd', name: b.name, region: b.region, config: b.config, private_ip: 'fdaa::3' };
        machines.set(m.id, m); return lose ? json({ error: 'gateway lost' }, 502) : json(m);
      }
      if (!machines.has(id)) return json({ error: 'not_found' }, 404);
      if (method === 'DELETE') { assert.equal(search, '?force=true'); machines.delete(id); return json({ ok: true }); }
      return json(machines.get(id));
    };
    const receipts = keptReceipts(), lease = 'lease-fly-door-two', row = hostingProvider('fly', connectionValues(flyApp)), request = leaseClient(row, TOKEN, { fetchImpl });
    const options = { request, receipts, file: lease, name: 'door-two', publicKey: KEY, provider: row, lifetime: 'service', expiresAt: null };
    if (lose) {
      await assert.rejects(provisionHostLease(options), /HTTP 502, gatewaylost/);
      assert.deepEqual([[...machines.keys()], (await readHostLease(receipts, lease)).state], [['ffffffffffffff'], 'removed']);
      continue;
    }
    const rented = await provisionHostLease(options);
    assert.deepEqual([rented.provider, rented.serverId, rented.serverType], ['fly', '0123456789abcd', 'shared-cpu-2x']);
    assert.equal(machines.get('0123456789abcd').config.metadata['door-lease'], 'door-two');
    assert.equal((await provisionHostLease(options)).reused, true);
    await assert.rejects(request('GET', '/servers?name=x'), /operation was refused/);
    await assert.rejects(request('DELETE', '/apps/other/machines/0123456789abcd'), /operation was refused/);
    await removeHostLease({ request, receipts, file: lease, provider: row });
    assert.deepEqual([[...machines.keys()], (await readHostLease(receipts, lease)).state], [['ffffffffffffff'], 'removed']);
    assert.deepEqual(calls.filter(c => !c.startsWith('GET')), ['POST /v1/apps/door/machines', 'DELETE /v1/apps/door/machines/0123456789abcd?force=true']);
  }
});

// One fake world for a move: the Hetzner rows' API with a door already rented there, Cloudflare DNS, public DNS and HTTPS proof.
async function hetznerDoor({ proofFails = false } = {}) {
  const calls = [], record = 'b'.repeat(32), dnsRows = [{ id: record, type: 'A', name: 'door.example.com', content: '192.0.2.34', ttl: 300, proxied: false }];
  let server = null, key = null;
  const fetchImpl = async (url, { method, body }) => {
    const u = new URL(url), path = u.pathname + u.search; calls.push(`${method} ${u.host}${path}`);
    if (u.host === 'api.hetzner.cloud') {
      if (method === 'GET' && u.pathname === '/v1/servers') return json({ servers: server ? [server] : [] });
      if (method === 'POST' && path === '/v1/ssh_keys') { key = { id: 12, labels: JSON.parse(body).labels }; return json({ ssh_key: key }); }
      if (method === 'POST' && path === '/v1/servers') { const b = JSON.parse(body); server = { id: 34, name: b.name, labels: b.labels, public_net: { ipv4: { ip: '192.0.2.34' } } }; return json({ server }); }
      if (path === '/v1/servers/34') { if (!server) return json({}, 404); if (method === 'DELETE') server = null; return json({ server }); }
      if (path === '/v1/ssh_keys/12') { if (!key) return json({}, 404); if (method === 'DELETE') key = null; return json({ ssh_key: key }); }
    }
    if (u.host === 'api.cloudflare.com') {
      const p = u.pathname.replace('/client/v4/', '');
      if (p === 'zones') return json({ success: true, result: u.searchParams.get('name') === 'example.com' ? [{ id: 'a'.repeat(32), account: { id: 'e'.repeat(32) } }] : [] });
      if (p.endsWith('workers/routes') || p.endsWith('workers/domains')) return json({ success: true, result: [] });
      if (method === 'PATCH') { Object.assign(dnsRows[0], JSON.parse(body)); return json({ success: true, result: dnsRows[0] }); }
      return json({ success: true, result: structuredClone(dnsRows), result_info: { total_pages: 1 } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const w = { calls, dnsRows, fetchImpl, vaultAsked: [], proved: [], hetzner: () => ({ server, key }), resolve4: async () => [dnsRows[0].content], wait: async () => {} };
  w.credential = async name => { w.vaultAsked.push(name); return TOKEN; };
  w.prove = async (...args) => { w.proved.push(args); if (proofFails) throw new Error('download answered 404'); };
  w.oldLease = 'lease-hetzner-door-one';
  w.connections = connectionValues(r => {
    if (r.id === 'own-box') r.rents_a_host.placement.address = '198.51.100.7';
    if (r.kind === 'public-door-placement') Object.assign(r, { hostname: 'door.example.com', server_id: 34, address: "192.0.2.34", lease_file: w.oldLease });
  });
  w.kept = keptReceipts();
  const hetzner = hostingProvider('hetzner', w.connections);
  await provisionHostLease({ request: leaseClient(hetzner, TOKEN, { fetchImpl }), receipts: w.kept, file: w.oldLease, name: 'door-one', publicKey: KEY, provider: hetzner, lifetime: 'service', expiresAt: null });
  calls.length = 0;
  return w;
}
// Move the door the way a caller does: the rows and the old lease's receipt handed in, the answer holding what the move made.
const moveFrom = (w, options) => movePublicDoor({ ...options, ...w, receipts: w.kept.all() });

test('move the door from Hetzner to an own box: every step in order, proof pinned to the new address, then the old lease goes', async () => {
  const w = await hetznerDoor(), order = [];
  const steps = { setupHost: async lease => order.push(`setup ${lease.address}`), publishDownload: async (lease, placement) => order.push(`publish ${placement.address}`) };
  const { door, receipt, receipts } = await moveFrom(w, { to: 'own-box', name: 'door-two', steps });
  assert.deepEqual(receipt.done.map(s => s.id), ['rented', 'set-up', 'download-published', 'dns-cut', 'proven', 'old-released', 'door-row-made']);
  assert.deepEqual(order, ['setup 198.51.100.7', 'publish 198.51.100.7']);
  assert.equal(w.dnsRows[0].content, '198.51.100.7');
  assert.deepEqual(w.proved, [['https://door.example.com/healthz', 'door.example.com', '198.51.100.7'], ['https://door.example.com/download/App.dmg', 'door.example.com', '198.51.100.7']]);
  assert.deepEqual([w.hetzner(), receipts[w.oldLease].state], [{ server: null, key: null }, 'removed']);
  assert.deepEqual(w.vaultAsked, ['cloudflare-api-token', 'hetzner-api-token']);
  assert.deepEqual([door.kind, door.id, door.hosting_provider, door.address, door.dns_record, door.unknown_because, door.lease_file, door.hostname], ['public-door-placement', 'current', 'own-box', '198.51.100.7', 'b'.repeat(32), undefined, 'lease-own-box-door-two', 'door.example.com']);
  assert.deepEqual(receipts['door-move'].done.map(s => s.id), receipt.done.map(s => s.id));
  assert.deepEqual(Object.keys(receipts).sort(), ['dns-cutover-own-box-door-two', 'door-move', w.oldLease, 'lease-own-box-door-two'].sort());
});

test('a failed proof rolls DNS back and keeps the old host', async () => {
  const w = await hetznerDoor({ proofFails: true }), steps = { setupHost: async () => {}, publishDownload: async () => {} };
  const failed = await moveFrom(w, { to: 'own-box', name: 'door-two', steps, attempts: 3 }).then(() => null, error => error);
  assert.match(failed.message, /not proven \(download answered 404\); DNS was rolled back/);
  assert.deepEqual([w.dnsRows[0].content, failed.receipts[w.oldLease].state, failed.receipts['lease-own-box-door-two'].state], ['192.0.2.34', 'running', 'running']);
  assert.deepEqual(failed.receipts['door-move'].done.map(s => s.id), ['rented', 'set-up', 'download-published', 'dns-cut', 'dns-rolled-back']);
  assert.equal(w.calls.filter(c => c.startsWith('DELETE')).length, 0);
});

test('a row that is not move-ready is refused by its own reason before any network or vault call', async () => {
  const w = await hetznerDoor();
  await assert.rejects(moveFrom(w, { to: 'fly', name: 'door-two', steps: {} }), /cannot move to Fly.io: A Fly Machine has no public IPv4/);
  await assert.rejects(moveFrom(w, { to: 'vercel', name: 'door-two', steps: {} }), /No hosting provider row is named "vercel"/);
  assert.deepEqual([w.calls.length, w.vaultAsked.length], [0, 0]);
});
