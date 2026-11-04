import test from 'node:test';
import assert from 'node:assert/strict';
import { provisionHostLease, readHostLease, removeHostLease, watchHostLease, leaseClient } from '../do-work/portable-host-lease.mjs';
import { hostingProvider } from '../read-data/public-door-rows.mjs';
import { doorReceipts } from '../read-data/door-receipts.mjs';
import { doorWorld } from './door-world.mjs';

// The Hetzner row of the person's list and a fake provider answering its requests; the lease is a Public door receipt.
async function world(t, { ambiguous = false } = {}) {
  const { door } = await doorWorld(t), provider = await hostingProvider('hetzner', door), receipts = doorReceipts(door), lease = 'lease-mcp-test', calls = [];
  let server, key;
  const request = async (method, path, body) => {
    calls.push({ method, path });
    if (method === 'GET' && path.startsWith('/servers?')) return { servers: server ? [server] : [] };
    if (method === 'POST' && path === '/ssh_keys') { key = { id: 12, labels: body.labels }; return { ssh_key: key }; }
    if (method === 'POST' && path === '/servers') {
      server = { id: 34, name: body.name, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.34' } } };
      if (ambiguous) throw new Error('The create answer was lost.');
      return { server };
    }
    if (method === 'GET' && path === '/servers/34') return server ? { server } : { absent: true };
    if (method === 'GET' && path === '/ssh_keys/12') return key ? { ssh_key: key } : { absent: true };
    if (method === 'DELETE' && path === '/servers/34') { server = null; return {}; }
    if (method === 'DELETE' && path === '/ssh_keys/12') { key = null; return {}; }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  return { door, request, receipts, lease, file: lease, provider, calls, server: () => server, changeOwner: () => { server.labels = { 'door-lease': 'another' }; },
    options: { request, receipts, file: lease, provider, name: 'mcp-test', publicKey: 'ssh-ed25519 AAAATEST', serverType: 'small', location: 'near', image: 'linux', expiresAt: 2000, now: () => 1000 } };
}

test('one lease owns one host and key; retry reuses it, removal is exact and repeatable', async t => {
  const w = await world(t);
  const lease = await provisionHostLease(w.options);
  assert.equal(lease.address, '192.0.2.34');
  assert.equal((await provisionHostLease(w.options)).reused, true);
  assert.equal(w.calls.filter(c => c.method === 'POST').length, 2);
  await removeHostLease(w);
  await removeHostLease(w);
  assert.equal((await readHostLease(w.receipts, w.lease)).state, 'removed');
  assert.equal(w.calls.filter(c => c.method === 'DELETE').length, 2);
});

test('a foreign relabelled host is never removed', async t => {
  const w = await world(t);
  await provisionHostLease(w.options);
  w.changeOwner();
  await assert.rejects(removeHostLease(w), /left untouched/);
  assert.equal(w.calls.filter(c => c.method === 'DELETE').length, 0);
});

test('a retained service has no automatic deletion deadline', async t => {
  const w = await world(t);
  const lease = await provisionHostLease({ ...w.options, lifetime: 'service', expiresAt: null });
  assert.equal(lease.expiresAt, null);
  await watchHostLease({ request: w.request, receipts: w.receipts, file: w.lease, provider: w.provider, now: () => Number.MAX_SAFE_INTEGER });
  assert.equal(w.calls.filter(c => c.method === 'DELETE').length, 0);
  assert.equal((await readHostLease(w.receipts, w.lease)).state, 'running');
  await removeHostLease(w);
  assert.equal((await readHostLease(w.receipts, w.lease)).state, 'removed');
});

test('a lost create answer reconciles the labelled host and cleans its exact IDs', async t => {
  const w = await world(t, { ambiguous: true });
  await assert.rejects(provisionHostLease(w.options), /answer was lost/);
  assert.equal(w.server(), null);
  assert.equal((await readHostLease(w.receipts, w.lease)).state, 'removed');
  assert.deepEqual(w.calls.filter(c => c.method === 'DELETE').map(c => c.path), ['/servers/34', '/ssh_keys/12']);
});

test('deadline cleanup retries provider failure, and a host already removed still cleans its key', async t => {
  const w = await world(t);
  await provisionHostLease(w.options);
  let clock = 1000, fail = true, reports = 0;
  const request = async (method, path, body) => {
    if (path === '/servers/34' && method === 'GET' && fail) { fail = false; throw new Error('temporarily unreachable'); }
    return w.request(method, path, body);
  };
  await watchHostLease({ request, receipts: w.receipts, file: w.lease, provider: w.provider, now: () => clock, wait: async ms => { clock += ms; }, report: () => { reports++; } });
  assert.equal(reports, 1);
  assert.equal((await readHostLease(w.receipts, w.lease)).state, 'removed');
  const elsewhere = doorReceipts(w.door);
  await elsewhere.save(w.lease, { ...await readHostLease(elsewhere, w.lease), state: 'running' });
  await removeHostLease(w);
  assert.equal((await readHostLease(w.receipts, w.lease)).state, 'removed');
});

test('host shape/deadline and provider paths refuse before network; credentials never enter errors', async t => {
  const w = await world(t);
  let calls = 0;
  await assert.rejects(provisionHostLease({ request: async () => { calls++; }, receipts: w.receipts, file: w.lease, provider: w.provider, name: 'bad', publicKey: 'bad' }), /configuration/);
  const request = leaseClient(w.provider, 'SENTINEL-SECRET', { fetchImpl: async () => { calls++; return { status: 403, ok: false, json: async () => ({ error: { code: 'forbidden', message: 'SENTINEL-SECRET' } }) }; } });
  await assert.rejects(request('POST', '/other'), /operation was refused/);
  await assert.rejects(request('POST', '/servers'), error => !error.message.includes('SENTINEL-SECRET') && error.message.includes('forbidden'));
  assert.equal(calls, 1);
});

test('a receipt changed by another run meanwhile is refused, never written over', async t => {
  const w = await world(t);
  await provisionHostLease(w.options);
  const elsewhere = doorReceipts(w.door);
  await elsewhere.save(w.lease, { ...await readHostLease(elsewhere, w.lease), note: 'changed elsewhere' });
  await assert.rejects(w.receipts.save(w.lease, { ...await readHostLease(doorReceipts(w.door), w.lease), state: 'removed' }), /changed while this tool was running/);
});
