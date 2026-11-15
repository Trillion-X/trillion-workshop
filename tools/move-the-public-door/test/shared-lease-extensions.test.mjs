import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintOf, leaseClient, provisionHostLease, readHostState, readPrice, pointName, forgetName,
  removeHostLease,
} from '../do-work/portable-host-lease.mjs';

const keyLine = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample0 builder@example.test';

function machineRow() {
  const base = 'https://provider.example.test/v1';
  return {
    id: 'synthetic-host', name: 'Synthetic host', base,
    auth: { header: 'authorization', prefix: 'Bearer ' }, error_code_at: 'error.code',
    placement: { size: 'small-1', location: 'region-1', image: 'linux-1' },
    fill: { labels: { 'lease-owner': '{name}' } },
    requests: {
      find_hosts: { method: 'GET', url: `${base}/servers?name={name}` },
      create_host: { method: 'POST', url: `${base}/servers`, body_template: { name: '{name}', size: '{size}', location: '{location}', image: '{image}', ssh_keys: ['{ssh_key_id}'], labels: '{labels}' } },
      read_host: { method: 'GET', url: `${base}/servers/{server_id}` },
      delete_host: { method: 'DELETE', url: `${base}/servers/{server_id}` },
      find_key: { method: 'GET', url: `${base}/ssh_keys?fingerprint={fingerprint}` },
      create_key: { method: 'POST', url: `${base}/ssh_keys`, body_template: { name: '{key_name}', public_key: '{public_key}', labels: '{labels}' } },
      read_key: { method: 'GET', url: `${base}/ssh_keys/{ssh_key_id}` },
      delete_key: { method: 'DELETE', url: `${base}/ssh_keys/{ssh_key_id}` },
      read_price: { method: 'GET', url: `${base}/server_types?name={size}` },
    },
    host: {
      find: 'find_hosts', list_at: 'servers', name_at: 'name', create: 'create_host', created_at: 'server',
      read: 'read_host', found_at: 'server', remove: 'delete_host', id_is: 'server_id', id_pattern: '^\\d+$',
      owner_at: 'labels.lease-owner', address_at: 'public_net.ipv4.ip', state_at: 'status',
    },
    access_key: {
      find: 'find_key', list_at: 'ssh_keys', create: 'create_key', read: 'read_key', found_at: 'ssh_key', remove: 'delete_key',
      id_is: 'ssh_key_id', id_pattern: '^\\d+$', id_at: 'ssh_key.id', owner_at: 'labels.lease-owner',
    },
    price: { read: 'read_price', list_at: 'server_types.0.prices', location_at: 'location', monthly_at: 'price_monthly.gross', currency: 'EUR' },
  };
}

function nameRow() {
  const base = 'https://dns.example.test/v1';
  return {
    id: 'synthetic-dns', name: 'Synthetic DNS', base,
    auth: { header: 'authorization', prefix: 'Bearer ' }, error_code_at: 'error.code', placement: {},
    requests: {
      find_zone: { method: 'GET', url: `${base}/zones?name={zone}` },
      find_records: { method: 'GET', url: `${base}/zones/{zone_id}/records?type=A&name={host_name}` },
      create_record: { method: 'POST', url: `${base}/zones/{zone_id}/records`, body_template: { type: 'A', name: '{host_name}', content: '{address}', ttl: 60, proxied: false, comment: 'lease {name}' } },
      read_record: { method: 'GET', url: `${base}/zones/{zone_id}/records/{record_id}` },
      delete_record: { method: 'DELETE', url: `${base}/zones/{zone_id}/records/{record_id}` },
    },
    zone: { find: 'find_zone', list_at: 'result', id_is: 'zone_id', id_pattern: '^[a-z0-9-]+$', id_at: 'id', name_at: 'name' },
    record: {
      find: 'find_records', list_at: 'result', create: 'create_record', created_at: 'result', read: 'read_record', found_at: 'result', remove: 'delete_record',
      id_is: 'record_id', id_pattern: '^[a-z0-9-]+$', id_at: 'id', owner_at: 'comment', owner_is: 'lease {name}', address_at: 'content', name_at: 'name',
    },
  };
}

function receiptStore(initial = null, { failSave = false } = {}) {
  let value = initial == null ? null : structuredClone(initial);
  const writes = [];
  return {
    writes,
    receipts: {
      async read() { return value == null ? null : structuredClone(value); },
      async save(_file, next) {
        writes.push(structuredClone(next));
        if (failSave) throw new Error('receipt changed while this tool was running');
        value = structuredClone(next);
        return structuredClone(value);
      },
    },
    value: () => value == null ? null : structuredClone(value),
  };
}

const response = value => ({ status: 200, ok: true, json: async () => value });

test('the provider client allows only declared price and DNS calls and encodes query values', async () => {
  const host = machineRow(), dns = nameRow(), urls = [];
  const fetchImpl = async (url, options = {}) => {
    urls.push({ url, method: options.method });
    return options.method === 'DELETE' ? { status: 204, ok: true, json: async () => { throw new Error('204 has no body'); } } : response({ ok: true });
  };
  const hostRequest = leaseClient(host, 'test-token', { fetchImpl });
  const dnsRequest = leaseClient(dns, 'test-token', { fetchImpl });
  await hostRequest('GET', '/server_types?name=small-1');
  await dnsRequest('GET', '/zones?name=alpha%2Bbeta.example.test');
  assert.deepEqual(await dnsRequest('DELETE', '/zones/zone-1/records/record-1'), {});
  await assert.rejects(hostRequest('GET', '/billing?all=true'), /operation was refused/);
  assert.deepEqual(urls.slice(0, 3), [
    { url: `${host.base}/server_types?name=small-1`, method: 'GET' },
    { url: `${dns.base}/zones?name=alpha%2Bbeta.example.test`, method: 'GET' },
    { url: `${dns.base}/zones/zone-1/records/record-1`, method: 'DELETE' },
  ]);
});

test('a matching shared SSH key is reused by fingerprint and never removed with the host', async () => {
  const provider = machineRow(), store = receiptStore(), file = 'lease-1', calls = [], fingerprint = fingerprintOf(keyLine);
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/servers?name=build-1') return { servers: [] };
    if (path === `/ssh_keys?fingerprint=${encodeURIComponent(fingerprint)}`) return { ssh_keys: [{ id: 41, fingerprint }] };
    if (path === '/servers' && method === 'POST') return { server: { id: 51, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.51' } } } };
    if (path === '/servers/51' && method === 'GET') return { server: { id: 51, status: 'running', labels: { 'lease-owner': 'build-1' }, public_net: { ipv4: { ip: '192.0.2.51' } } } };
    if (path === '/servers/51' && method === 'DELETE') return {};
    throw new Error(`Unexpected ${method} ${path}`);
  };
  const lease = await provisionHostLease({ request, receipts: store.receipts, file, provider, name: 'build-1', publicKey: keyLine, lifetime: 'service', now: () => 1000, schema: 'place-lease/1' });
  assert.deepEqual([lease.schema, lease.serverType, lease.location, lease.image], ['place-lease/1', 'small-1', 'region-1', 'linux-1']);
  assert.equal(lease.sharedSshKeyId, 41);
  assert.equal(lease.sshKeyId, null);
  assert.equal(calls.find(call => call.path.startsWith('/ssh_keys?')).path, `/ssh_keys?fingerprint=${encodeURIComponent(fingerprint)}`);
  const create = calls.find(call => call.path === '/servers' && call.method === 'POST');
  assert.deepEqual(create.body.ssh_keys, [41]);
  assert.deepEqual(create.body.labels, { 'lease-owner': 'build-1' });
  await removeHostLease({ request, receipts: store.receipts, file, provider });
  assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.path), ['/servers/51']);
  assert.equal(calls.some(call => call.path.startsWith('/ssh_keys/')), false);
});

test('a missing shared key is created, but ambiguous or invalid shared key identities refuse host creation', async t => {
  const provider = machineRow(), fingerprint = fingerprintOf(keyLine);
  for (const [label, found, expected] of [
    ['none', [], 'create-key'],
    ['multiple', [{ id: 41 }, { id: 42 }], 'refuse'],
    ['missing identity', [{}], 'refuse'],
    ['invalid identity', [{ id: 'not-a-number' }], 'refuse'],
  ]) {
    await t.test(label, async () => {
      const store = receiptStore(), calls = [];
      const request = async (method, path, body) => {
        calls.push({ method, path, body });
        if (path === '/servers?name=build-1') return { servers: [] };
        if (path === `/ssh_keys?fingerprint=${encodeURIComponent(fingerprint)}`) return { ssh_keys: found };
        if (path === '/ssh_keys' && method === 'POST') return { ssh_key: { id: 43 } };
        if (path === '/servers' && method === 'POST') return { server: { id: 53, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.53' } } } };
        throw new Error(`Unexpected ${method} ${path}`);
      };
      const options = { request, receipts: store.receipts, file: label, provider, name: 'build-1', publicKey: keyLine, lifetime: 'service', now: () => 1000, schema: 'place-lease/1' };
      if (expected === 'refuse') {
        await assert.rejects(provisionHostLease(options));
        assert.equal(calls.some(call => call.path === '/servers' && call.method === 'POST'), false);
      } else {
        const lease = await provisionHostLease(options);
        assert.equal(lease.sshKeyId, 43);
        assert.equal(calls.some(call => call.path === '/ssh_keys' && call.method === 'POST'), true);
      }
    });
  }
});

test('price reads the matching location in monthly cents and refuses a missing location', async () => {
  const provider = machineRow(), calls = [];
  const request = async (method, path) => {
    calls.push({ method, path });
    return { server_types: [{ prices: [
      { location: 'region-2', price_monthly: { gross: '8.9900' } },
      { location: 'region-1', price_monthly: { gross: '6.9900' } },
    ] }] };
  };
  assert.deepEqual(await readPrice({ request, provider }), { cents: 699, currency: 'EUR' });
  await assert.rejects(readPrice({ request, provider, placement: { location: 'missing' } }), /no monthly price/);
  assert.deepEqual(calls.map(call => call.path), ['/server_types?name=small-1', '/server_types?name=small-1']);
});

test('DNS points one exact unproxied A record, rereads ownership before deleting, and refuses a foreign record', async () => {
  const dns = nameRow(), provider = machineRow(), file = 'lease-dns';
  const initial = { schema: 'place-lease/1', provider: provider.id, name: 'build-1', state: 'running', address: '192.0.2.70' };
  const store = receiptStore(initial), calls = [];
  let record = null;
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/zones?name=example.test') return { result: [{ id: 'zone-1', name: 'example.test' }] };
    if (path === '/zones/zone-1/records?type=A&name=app.example.test') return { result: record ? [record] : [] };
    if (path === '/zones/zone-1/records' && method === 'POST') { record = { id: 'record-1', ...body }; return { result: record }; }
    if (path === '/zones/zone-1/records/record-1' && method === 'GET') return { result: record };
    if (path === '/zones/zone-1/records/record-1' && method === 'DELETE') { record = null; return {}; }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  const pointed = await pointName({ request, receipts: store.receipts, file, provider: dns, zone: 'example.test', hostName: 'app.example.test' });
  assert.deepEqual([pointed.names, pointed.zoneId, pointed.recordId, pointed.hostName], [dns.id, 'zone-1', 'record-1', 'app.example.test']);
  assert.deepEqual(calls.find(call => call.method === 'POST').body, {
    type: 'A', name: 'app.example.test', content: '192.0.2.70', ttl: 60, proxied: false, comment: 'lease build-1',
  });
  record.comment = 'lease somebody-else';
  await assert.rejects(forgetName({ request, receipts: store.receipts, file, provider: dns }), /left untouched/);
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
  record.comment = 'lease build-1';
  const forgotten = await forgetName({ request, receipts: store.receipts, file, provider: dns });
  assert.equal(forgotten.recordId, null);
  assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.path), ['/zones/zone-1/records/record-1']);
});

test('DNS refuses a preexisting record or ambiguous zone before creating anything', async t => {
  const dns = nameRow(), store = receiptStore({ schema: 'place-lease/1', provider: 'synthetic-host', name: 'build-1', state: 'running', address: '192.0.2.71' });
  for (const scenario of ['record-exists', 'multiple-zones']) {
    await t.test(scenario, async () => {
      const calls = [];
      const request = async (method, path) => {
        calls.push({ method, path });
        if (path === '/zones?name=example.test') return { result: scenario === 'multiple-zones'
          ? [{ id: 'zone-1', name: 'example.test' }, { id: 'zone-2', name: 'example.test' }]
          : [{ id: 'zone-1', name: 'example.test' }] };
        if (path === '/zones/zone-1/records?type=A&name=app.example.test') return { result: [{ id: 'other-record', name: 'app.example.test' }] };
        throw new Error(`Unexpected ${method} ${path}`);
      };
      await assert.rejects(pointName({ request, receipts: store.receipts, file: scenario, provider: dns, zone: 'example.test', hostName: 'app.example.test' }),
        scenario === 'record-exists' ? /already points somewhere/ : /no one zone/);
      assert.equal(calls.some(call => call.method === 'POST'), false);
    });
  }
});

test('reading a host checks live ownership, and receipt conflict stops before host creation', async t => {
  const provider = machineRow(), base = { schema: 'place-lease/1', provider: provider.id, name: 'build-1', state: 'running', serverId: 51, address: '192.0.2.51' };
  const changed = receiptStore(base);
  await assert.rejects(readHostState({ request: async () => ({ server: { id: 51, labels: { 'lease-owner': 'different' } } }), receipts: changed.receipts, file: 'lease', provider }), /no longer owned/);

  const conflict = receiptStore(null, { failSave: true }), calls = [];
  const request = async (method, path) => {
    calls.push({ method, path });
    if (path === '/servers?name=build-2') return { servers: [] };
    if (path.startsWith('/ssh_keys?fingerprint=')) return { ssh_keys: [] };
    if (path === '/ssh_keys') return { ssh_key: { id: 91 } };
    if (path === '/servers') return { server: { id: 92, labels: {}, public_net: { ipv4: { ip: '192.0.2.92' } } } };
    throw new Error(`Unexpected ${method} ${path}`);
  };
  await assert.rejects(provisionHostLease({ request, receipts: conflict.receipts, file: 'lease', provider, name: 'build-2', publicKey: keyLine, lifetime: 'service', now: () => 1000 }), /receipt changed/);
  assert.equal(calls.some(call => call.method === 'POST'), false);
});
