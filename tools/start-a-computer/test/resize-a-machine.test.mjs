import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readProvider, providerClient, resizeMachine, fileStore } from '../do-work/rent-a-machine.mjs';

// Every call goes to a made-up provider (example.test answers nothing): a fake answers it, and no network is used.
const canary = 'provider-credential-canary-0123456789';
const providerFile = name => fileURLToPath(new URL(`../made-up-providers/${name}.json`, import.meta.url));
const RENTED = providerFile('rented-machine');
const rented = readProvider(RENTED);
const folder = () => tempFolder(join(tmpdir(), 'resize-a-machine-'));
const clock = () => { let t = Date.parse('2026-11-21T10:00:00Z'); return () => (t += 1000); };

// A machine on the made-up provider: `change` is ok, error (the action ends in error), stuck (never finishes) or refuse (HTTP 422);
// `powerOn` is ok or refuse; `noPriceFor` names a size the price list does not carry.
function machine({ type = 'cx23', status = 'running', change = 'ok', powerOn = 'ok', noPriceFor = null } = {}) {
  const state = { type, status, next: 500, actions: new Map(), calls: [], bodies: [] };
  const respond = (body, code = 200) => new Response(JSON.stringify(body), { status: code });
  const fetchImpl = async (address, request) => {
    assert.equal(request.headers.authorization, `Bearer ${canary}`);
    const path = address.slice(rented.base.length), route = path.split('?')[0];
    const body = request.body && JSON.parse(request.body);
    state.calls.push(`${request.method} ${path}`);
    const action = /^\/actions\/(\d+)$/.exec(route);
    if (request.method === 'GET' && action) return respond({ action: state.actions.get(Number(action[1])) });
    if (request.method === 'GET' && route === '/servers/1234') {
      return respond({ server: { id: 1234, name: 'example-machine', labels: { 'example-lease': 'example-machine' }, status: state.status, server_type: { name: state.type }, public_net: { ipv4: { ip: '192.0.2.10' } } } });
    }
    const price = route === '/server_types' && /^name=([a-z0-9]+)$/.exec(path.split('?')[1] ?? '');
    if (request.method === 'GET' && price) {
      const prices = price[1] === noPriceFor ? [] : [{ location: 'hel1', price_monthly: { gross: price[1] === 'cx33' ? '7.12' : '4.51' } }];
      return respond({ server_types: [{ name: price[1], prices }] });
    }
    const post = /^\/servers\/1234\/actions\/(poweroff|change_type|poweron)$/.exec(route);
    if (request.method === 'POST' && post) {
      const kind = post[1];
      if ((kind === 'change_type' && change === 'refuse') || (kind === 'poweron' && powerOn === 'refuse')) return respond({ error: { code: 'action_failed' } }, 422);
      const id = state.next++;
      const failing = kind === 'change_type' && change === 'error', stuck = kind === 'change_type' && change === 'stuck';
      state.actions.set(id, { id, status: failing ? 'error' : stuck ? 'running' : 'success' });
      if (kind === 'poweroff') state.status = 'off';
      if (kind === 'change_type') state.bodies.push(body);
      if (kind === 'change_type' && !failing && !stuck) state.type = body.server_type;
      if (kind === 'poweron') state.status = 'running';
      return respond({ action: { id, status: 'running' } });
    }
    return respond({ error: { code: 'not_found' } }, 404);
  };
  return { fetchImpl, state };
}

async function leaseIn(dir) {
  const store = fileStore(join(dir, 'lease.json'));
  await store.save({ schema: 'machine-lease/1', provider: rented.id, providerFile: RENTED, name: 'example-machine', serverType: 'cx23', location: 'hel1', image: 'ubuntu-24.04', startedAt: 1, expiresAt: null, state: 'running', serverId: 1234, sshKeyId: 77, address: '192.0.2.10' });
  return store;
}

const resizing = (fake, store, extra = {}) => resizeMachine({ request: providerClient(rented, canary, { fetchImpl: fake.fetchImpl }), store, provider: rented, size: 'cx33', wait: async () => {}, now: clock(), ...extra });

test('a resize prices both sizes, powers off, changes the type keeping the disk, powers on, and reads back', async () => {
  const fake = machine(), store = await leaseIn(folder());
  const answer = await resizing(fake, store);
  assert.deepEqual(fake.state.calls, [
    'GET /servers/1234', 'GET /server_types?name=cx23', 'GET /server_types?name=cx33',
    'POST /servers/1234/actions/poweroff', 'GET /actions/500',
    'POST /servers/1234/actions/change_type', 'GET /actions/501',
    'POST /servers/1234/actions/poweron', 'GET /actions/502',
    'GET /servers/1234',
  ]);
  assert.deepEqual(fake.state.bodies, [{ server_type: 'cx33', upgrade_disk: false }]);
  assert.deepEqual(answer, {
    from: 'cx23', to: 'cx33', price_from: { cents: 451, currency: 'EUR' }, price_to: { cents: 712, currency: 'EUR' },
    off_at: '2026-11-21T10:00:01.000Z', on_at: '2026-11-21T10:00:02.000Z', seconds_down: 1, status: 'running',
  });
  assert.equal((await store.read()).serverType, 'cx33');
});

test('a machine already at the size answers unchanged and nothing is powered off', async () => {
  const fake = machine({ type: 'cx33' });
  assert.deepEqual(await resizing(fake, await leaseIn(folder())), { unchanged: true, from: 'cx33', to: 'cx33' });
  assert.deepEqual(fake.state.calls, ['GET /servers/1234']);
});

test('a refused type change after the power-off still asks for the power-on, and the error says what the machine reads back as', async () => {
  const fake = machine({ change: 'refuse' }), store = await leaseIn(folder());
  await assert.rejects(resizing(fake, store), error => {
    assert.match(error.message, /did not finish: Example Test Cloud refused POST \/servers\/1234\/actions\/change_type/);
    assert.match(error.message, /Power-on was sent and done\. The machine reads cx23 running\.$/);
    return true;
  });
  assert.deepEqual(fake.state.calls, [
    'GET /servers/1234', 'GET /server_types?name=cx23', 'GET /server_types?name=cx33',
    'POST /servers/1234/actions/poweroff', 'GET /actions/500',
    'POST /servers/1234/actions/change_type',
    'POST /servers/1234/actions/poweron', 'GET /actions/501',
    'GET /servers/1234',
  ]);
  assert.equal((await store.read()).serverType, 'cx23');
});

test('a change action that ends in error still powers on, and the error names the action', async () => {
  const fake = machine({ change: 'error' });
  await assert.rejects(resizing(fake, await leaseIn(folder())), /action 501 ended in error[\s\S]*Power-on was sent and done/);
  assert.ok(fake.state.calls.includes('POST /servers/1234/actions/poweron'));
});

test('a power-on that is refused is reported, and the lease keeps the size the machine reads back as', async () => {
  const fake = machine({ powerOn: 'refuse' }), store = await leaseIn(folder());
  await assert.rejects(resizing(fake, store), /did not finish: Example Test Cloud refused POST \/servers\/1234\/actions\/poweron \(HTTP 422, action_failed\)\. Power-on failed\. The machine reads cx33 off\./);
  assert.equal((await store.read()).serverType, 'cx33');
});

test('each wait is bounded by the row: its tries and spacing, then it stops and the power-on still follows', async () => {
  const fake = machine({ change: 'stuck' }), waits = [];
  const bounded = { ...rented, resize: { ...rented.resize, tries: 2, every_ms: 7 } };
  await assert.rejects(resizeMachine({ request: providerClient(bounded, canary, { fetchImpl: fake.fetchImpl }), store: await leaseIn(folder()), provider: bounded, size: 'cx33', wait: async ms => { waits.push(ms); }, now: clock() }), /action 501 was still running after 2 checks/);
  assert.deepEqual(waits, [7, 7]);
  assert.equal(fake.state.calls.filter(call => call === 'GET /actions/501').length, 3);
  assert.ok(fake.state.calls.includes('POST /servers/1234/actions/poweron'));
});

test('a resize that would upgrade the disk is refused before the machine is read', async () => {
  const fake = machine();
  await assert.rejects(resizing(fake, await leaseIn(folder()), { keep_disk: false }), /keeps its disk/);
  assert.deepEqual(fake.state.calls, []);
});

test('a machine that is not running is not powered off', async () => {
  const fake = machine({ status: 'off' });
  await assert.rejects(resizing(fake, await leaseIn(folder())), /The machine is off; a resize needs it running\./);
  assert.deepEqual(fake.state.calls, ['GET /servers/1234']);
});

test('a size with no price at the lease location is refused before the power-off', async () => {
  const fake = machine({ noPriceFor: 'cx33' });
  await assert.rejects(resizing(fake, await leaseIn(folder())), /has no monthly price for cx33 at hel1/);
  assert.equal(fake.state.calls.some(call => call.startsWith('POST')), false);
});

test('only the row-declared operations are sent: an undeclared action is refused before any call', async () => {
  const fake = machine(), request = providerClient(rented, canary, { fetchImpl: fake.fetchImpl });
  await assert.rejects(request('POST', '/servers/1234/actions/rebuild', {}), /operation was refused/);
  await assert.rejects(request('DELETE', '/actions/500'), /operation was refused/);
  assert.deepEqual(fake.state.calls, []);
});

test('the Hetzner row declares the same resize job and requests as the made-up description', () => {
  const hetzner = readProvider(fileURLToPath(new URL('../providers/hetzner.json', import.meta.url)));
  assert.deepEqual(hetzner.resize, rented.resize);
  for (const name of ['power_off_server', 'change_server_type', 'power_on_server', 'read_action']) {
    assert.equal(hetzner.requests[name].method, rented.requests[name].method, name);
    assert.equal(hetzner.requests[name].url.slice(hetzner.base.length), rented.requests[name].url.slice(rented.base.length), name);
    assert.deepEqual(hetzner.requests[name].body_template, rented.requests[name].body_template, name);
  }
});

test('the resize command reads its key from stdin: none given is refused before any call, and a usage error exits 2', async () => {
  const cli = fileURLToPath(new URL('../do-work/resize-a-machine.mjs', import.meta.url)), dir = folder();
  await leaseIn(dir);
  const refused = spawnSync(process.execPath, [cli, join(dir, 'lease.json'), 'cx33'], { input: '', encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /credential was refused/);
  const usage = spawnSync(process.execPath, [cli], { input: '', encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: resize-a-machine\.mjs LEASE_FILE SIZE/);
});
