import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintOf, providerClient, rentMachine, readMachine, readPrice, pointName, forgetName, releaseMachine, watchLease, readLease,
} from '../do-work/rent-a-machine.mjs';

// The lease functions over a made-up provider (example.test answers nothing) and an in-memory lease store: one lease owns
// one machine and key, ownership is read back before anything is removed, a lost answer is reconciled, a stored key is
// reused by fingerprint, and names are made and removed only when the record still carries this lease's mark.

const keyLine = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample0 builder@example.test';

function machineRow() {
  const base = 'https://provider.example.test/v1';
  return {
    id: 'synthetic-host', name: 'Synthetic host', base, lease_label_key: 'lease-owner', fingerprint: { hash: 'md5', encoding: 'colon-hex' },
    auth: { header: 'authorization', prefix: 'Bearer ' }, error_code_at: 'error.code',
    placement: { size: 'small-1', location: 'region-1', image: 'linux-1' },
    fill: { labels: { '{lease_label_key}': '{name}' } },
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
      owner_at: 'labels.{lease_label_key}', address_at: 'public_net.ipv4.ip', state_at: 'status',
    },
    access_key: {
      find: 'find_key', list_at: 'ssh_keys', create: 'create_key', read: 'read_key', found_at: 'ssh_key', remove: 'delete_key',
      id_is: 'ssh_key_id', id_pattern: '^\\d+$', id_at: 'ssh_key.id', owner_at: 'labels.{lease_label_key}',
    },
    price: { read: 'read_price', list_at: 'server_types.0.prices', location_at: 'location', monthly_at: 'price_monthly.gross', currency: 'EUR' },
  };
}

function nameRow() {
  const base = 'https://dns.example.test/v1';
  return {
    id: 'synthetic-dns', name: 'Synthetic DNS', base, lease_label_key: 'lease',
    auth: { header: 'authorization', prefix: 'Bearer ' }, error_code_at: 'error.code', placement: {},
    requests: {
      find_zone: { method: 'GET', url: `${base}/zones?name={zone}` },
      find_records: { method: 'GET', url: `${base}/zones/{zone_id}/records?type=A&name={host_name}` },
      create_record: { method: 'POST', url: `${base}/zones/{zone_id}/records`, body_template: { type: 'A', name: '{host_name}', content: '{address}', ttl: 60, proxied: false, comment: '{lease_label_key} {name}' } },
      read_record: { method: 'GET', url: `${base}/zones/{zone_id}/records/{record_id}` },
      delete_record: { method: 'DELETE', url: `${base}/zones/{zone_id}/records/{record_id}` },
    },
    zone: { find: 'find_zone', list_at: 'result', id_is: 'zone_id', id_pattern: '^[a-z0-9-]+$', id_at: 'id', name_at: 'name' },
    record: {
      find: 'find_records', list_at: 'result', create: 'create_record', created_at: 'result', read: 'read_record', found_at: 'result', remove: 'delete_record',
      id_is: 'record_id', id_pattern: '^[a-z0-9-]+$', id_at: 'id', owner_at: 'comment', owner_is: '{lease_label_key} {name}', address_at: 'content', name_at: 'name',
    },
  };
}

function memoryStore(initial = null, { failSave = false } = {}) {
  let value = initial == null ? null : structuredClone(initial);
  const writes = [];
  return {
    writes,
    async read() { return value == null ? null : structuredClone(value); },
    async save(next) {
      writes.push(structuredClone(next));
      if (failSave) throw new Error('receipt changed while this tool was running');
      value = structuredClone(next);
    },
    value: () => (value == null ? null : structuredClone(value)),
  };
}

const response = value => new Response(JSON.stringify(value), { status: 200 });

test('the provider client allows only declared price and DNS calls and encodes query values', async () => {
  const host = machineRow(), dns = nameRow(), urls = [];
  const fetchImpl = async (url, options = {}) => {
    urls.push({ url, method: options.method });
    return options.method === 'DELETE' ? new Response(null, { status: 204 }) : response({ ok: true });
  };
  const hostRequest = providerClient(host, 'test-token', { fetchImpl });
  const dnsRequest = providerClient(dns, 'test-token', { fetchImpl });
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
  const provider = machineRow(), store = memoryStore(), calls = [], fingerprint = fingerprintOf(keyLine, provider.fingerprint);
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/servers?name=build-1') return { servers: [] };
    if (path === `/ssh_keys?fingerprint=${encodeURIComponent(fingerprint)}`) return { ssh_keys: [{ id: 41, fingerprint }] };
    if (path === '/servers' && method === 'POST') return { server: { id: 51, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.51' } } } };
    if (path === '/servers/51' && method === 'GET') return { server: { id: 51, status: 'running', labels: { 'lease-owner': 'build-1' }, public_net: { ipv4: { ip: '192.0.2.51' } } } };
    if (path === '/servers/51' && method === 'DELETE') return {};
    throw new Error(`Unexpected ${method} ${path}`);
  };
  const lease = await rentMachine({ request, store, provider, name: 'build-1', publicKey: keyLine, now: () => 1000 });
  assert.deepEqual([lease.schema, lease.serverType, lease.location, lease.image], ['machine-lease/1', 'small-1', 'region-1', 'linux-1']);
  assert.equal(lease.sharedSshKeyId, 41);
  assert.equal(lease.sshKeyId, null);
  assert.equal(calls.find(call => call.path.startsWith('/ssh_keys?')).path, `/ssh_keys?fingerprint=${encodeURIComponent(fingerprint)}`);
  const create = calls.find(call => call.path === '/servers' && call.method === 'POST');
  assert.deepEqual(create.body.ssh_keys, [41]);
  assert.deepEqual(create.body.labels, { 'lease-owner': 'build-1' });
  await releaseMachine({ request, store, provider });
  assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.path), ['/servers/51']);
  assert.equal(calls.some(call => call.path.startsWith('/ssh_keys/')), false);
});

test('a missing shared key is created, but ambiguous or invalid shared key identities refuse host creation', async t => {
  const provider = machineRow(), fingerprint = fingerprintOf(keyLine, provider.fingerprint);
  for (const [label, found, expected] of [
    ['none', [], 'create-key'],
    ['multiple', [{ id: 41 }, { id: 42 }], 'refuse'],
    ['missing identity', [{}], 'refuse'],
    ['invalid identity', [{ id: 'not-a-number' }], 'refuse'],
  ]) {
    await t.test(label, async () => {
      const store = memoryStore(), calls = [];
      const request = async (method, path, body) => {
        calls.push({ method, path, body });
        if (path === '/servers?name=build-1') return { servers: [] };
        if (path === `/ssh_keys?fingerprint=${encodeURIComponent(fingerprint)}`) return { ssh_keys: found };
        if (path === '/ssh_keys' && method === 'POST') return { ssh_key: { id: 43 } };
        if (path === '/servers' && method === 'POST') return { server: { id: 53, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.53' } } } };
        throw new Error(`Unexpected ${method} ${path}`);
      };
      const options = { request, store, provider, name: 'build-1', publicKey: keyLine, now: () => 1000 };
      if (expected === 'refuse') {
        await assert.rejects(rentMachine(options));
        assert.equal(calls.some(call => call.path === '/servers' && call.method === 'POST'), false);
      } else {
        const lease = await rentMachine(options);
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
  const dns = nameRow(), provider = machineRow();
  const initial = { schema: 'machine-lease/1', provider: provider.id, name: 'build-1', state: 'running', address: '192.0.2.70' };
  const store = memoryStore(initial), calls = [];
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
  const pointed = await pointName({ request, store, provider: dns, zone: 'example.test', hostName: 'app.example.test' });
  assert.deepEqual([pointed.names, pointed.zoneId, pointed.recordId, pointed.hostName], [dns.id, 'zone-1', 'record-1', 'app.example.test']);
  assert.deepEqual(calls.find(call => call.method === 'POST').body, {
    type: 'A', name: 'app.example.test', content: '192.0.2.70', ttl: 60, proxied: false, comment: 'lease build-1',
  });
  record.comment = 'lease somebody-else';
  await assert.rejects(forgetName({ request, store, provider: dns }), /left untouched/);
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
  record.comment = 'lease build-1';
  const forgotten = await forgetName({ request, store, provider: dns });
  assert.equal(forgotten.recordId, null);
  assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.path), ['/zones/zone-1/records/record-1']);
});

test('DNS refuses a preexisting record or ambiguous zone before creating anything', async t => {
  const dns = nameRow(), store = memoryStore({ schema: 'machine-lease/1', provider: 'synthetic-host', name: 'build-1', state: 'running', address: '192.0.2.71' });
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
      await assert.rejects(pointName({ request, store, provider: dns, zone: 'example.test', hostName: 'app.example.test' }),
        scenario === 'record-exists' ? /already points somewhere/ : /no one zone/);
      assert.equal(calls.some(call => call.method === 'POST'), false);
    });
  }
});

test('reading a host checks live ownership, and receipt conflict stops before host creation', async t => {
  const provider = machineRow(), base = { schema: 'machine-lease/1', provider: provider.id, name: 'build-1', state: 'running', serverId: 51, address: '192.0.2.51' };
  const changed = memoryStore(base);
  await assert.rejects(readMachine({ request: async () => ({ server: { id: 51, labels: { 'lease-owner': 'different' } } }), store: changed, provider }), /no longer owned/);

  const conflict = memoryStore(null, { failSave: true }), calls = [];
  const request = async (method, path) => {
    calls.push({ method, path });
    if (path === '/servers?name=build-2') return { servers: [] };
    if (path.startsWith('/ssh_keys?fingerprint=')) return { ssh_keys: [] };
    if (path === '/ssh_keys') return { ssh_key: { id: 91 } };
    if (path === '/servers') return { server: { id: 92, labels: {}, public_net: { ipv4: { ip: '192.0.2.92' } } } };
    throw new Error(`Unexpected ${method} ${path}`);
  };
  await assert.rejects(rentMachine({ request, store: conflict, provider, name: 'build-2', publicKey: keyLine, now: () => 1000 }), /receipt changed/);
  assert.equal(calls.some(call => call.method === 'POST'), false);
});

// The lease lifecycle over a made-up host that keeps one server and one key.
function host({ ambiguous = false } = {}) {
  const provider = machineRow(), store = memoryStore(), calls = [];
  let server, key;
  const request = async (method, path, body) => {
    calls.push({ method, path });
    if (method === 'GET' && path.startsWith('/servers?')) return { servers: server ? [server] : [] };
    if (method === 'GET' && path.startsWith('/ssh_keys?')) return { ssh_keys: [] };
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
  const options = { request, store, provider, name: 'mcp-test', publicKey: keyLine, now: () => 1000 };
  return { request, store, provider, calls, options, server: () => server, changeOwner: () => { server.labels = { 'lease-owner': 'another' }; } };
}
const deletes = w => w.calls.filter(c => c.method === 'DELETE');

test('one lease owns one host and key; retry reuses it, removal is exact and repeatable', async () => {
  const w = host();
  assert.equal((await rentMachine(w.options)).address, '192.0.2.34');
  assert.equal((await rentMachine(w.options)).reused, true);
  assert.equal(w.calls.filter(c => c.method === 'POST').length, 2);
  await releaseMachine(w);
  await releaseMachine(w);
  assert.equal((await readLease(w.store)).state, 'removed');
  assert.equal(deletes(w).length, 2);
});

test('a foreign relabelled host is never removed', async () => {
  const w = host();
  await rentMachine(w.options);
  w.changeOwner();
  await assert.rejects(releaseMachine(w), /left untouched/);
  assert.equal(deletes(w).length, 0);
});

test('a lease with no deadline is never removed by its watcher', async () => {
  const w = host();
  assert.equal((await rentMachine(w.options)).expiresAt, null);
  await watchLease({ request: w.request, store: w.store, provider: w.provider, now: () => Number.MAX_SAFE_INTEGER });
  assert.equal(deletes(w).length, 0);
  assert.equal((await readLease(w.store)).state, 'running');
});

test('a lost create answer reconciles the labelled host and cleans its exact IDs', async () => {
  const w = host({ ambiguous: true });
  await assert.rejects(rentMachine(w.options), /answer was lost/);
  assert.equal(w.server(), null);
  assert.equal((await readLease(w.store)).state, 'removed');
  assert.deepEqual(deletes(w).map(c => c.path), ['/servers/34', '/ssh_keys/12']);
});

test('deadline cleanup retries provider failure, and a host already removed still cleans its key', async () => {
  const w = host();
  await rentMachine({ ...w.options, expiresAt: 2000 });
  let clock = 1000, fail = true, reports = 0;
  const request = async (method, path, body) => {
    if (path === '/servers/34' && method === 'GET' && fail) { fail = false; throw new Error('temporarily unreachable'); }
    return w.request(method, path, body);
  };
  await watchLease({ request, store: w.store, provider: w.provider, now: () => clock, wait: async ms => { clock += ms; }, report: () => { reports += 1; } });
  assert.equal(reports, 1);
  assert.equal((await readLease(w.store)).state, 'removed');
  await w.store.save({ ...await readLease(w.store), state: 'running' });
  await releaseMachine(w);
  assert.equal((await readLease(w.store)).state, 'removed');
});

test('a machine shape or deadline that is refused sends nothing, and the credential never enters an error', async () => {
  const w = host();
  let calls = 0;
  await assert.rejects(rentMachine({ request: async () => { calls += 1; }, store: w.store, provider: w.provider, name: 'bad', publicKey: 'bad' }), /configuration/);
  await assert.rejects(rentMachine({ ...w.options, expiresAt: 5 }), /time in the future/);
  const request = providerClient(w.provider, 'SENTINEL-SECRET', { fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'SENTINEL-SECRET' } }), { status: 403 }); } });
  await assert.rejects(request('POST', '/other'), /operation was refused/);
  await assert.rejects(request('POST', '/servers'), error => !error.message.includes('SENTINEL-SECRET') && error.message.includes('forbidden'));
  assert.equal(calls, 1);
});

test('a hosting row that names no lease_label_key is refused before anything is sent', async () => {
  const w = host(), { lease_label_key, ...bare } = w.provider;
  let calls = 0;
  await assert.rejects(rentMachine({ ...w.options, provider: bare, request: async () => { calls += 1; } }), /lease_label_key/);
  assert.equal(calls, 0);
});
