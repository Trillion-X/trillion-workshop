import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  machineProvider, nameProvider, providerClient, rentMachine, releaseMachine, readMachine, readPrice, pointName,
  forgetName, fingerprintOf,
} from '../do-work/rent-a-machine.mjs';
import { startAPlace, placeConfig, readRequest } from '../do-work/start-a-place.mjs';

const canary = 'provider-credential-canary-0123456789';
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample0 someone@example.com';
const folder = () => mkdtempSync(join(tmpdir(), 'start-a-place-'));
const hetzner = machineProvider('hetzner'), existing = machineProvider('existing-machine'), cloudflare = nameProvider('cloudflare');

// A provider that answers from a table of `METHOD path` -> body (or a function of the request body).
function provider(base, table, calls = []) {
  return async (address, request) => {
    assert.ok(address.startsWith(base));
    assert.equal(request.headers.authorization, `Bearer ${canary}`);
    const key = `${request.method} ${address.slice(base.length)}`, body = request.body && JSON.parse(request.body);
    calls.push([key, body]);
    const answer = table[key];
    if (answer === undefined) return { status: 404, ok: false, json: async () => ({ error: { code: 'not_found' } }) };
    const value = typeof answer === 'function' ? answer(body) : answer;
    return { status: value.status ?? 200, ok: (value.status ?? 200) < 300, json: async () => value };
  };
}

test('the rows name every provider call and their credentials by vault handle only', () => {
  const rows = JSON.parse(readFileSync(new URL('../read-data/providers.json', import.meta.url), 'utf8'));
  for (const row of [...rows.machines, ...rows.names].filter(r => r.base)) {
    assert.match(row.vault_key, /^[a-z0-9-]+$/);
    for (const asked of Object.values(row.requests)) assert.ok(asked.url.startsWith(row.base), asked.url);
  }
  assert.equal(existing.base, null);
});

test('the client sends only the calls its row declares', async () => {
  const request = providerClient(hetzner, canary, { fetchImpl: provider(hetzner.base, { 'GET /servers?name=a-place': { servers: [] } }) });
  assert.deepEqual(await request('GET', '/servers?name=a-place'), { servers: [] });
  await assert.rejects(request('DELETE', '/volumes/7'), /operation was refused/);
  await assert.rejects(request('DELETE', '/servers/abc'), /operation was refused/);
  assert.throws(() => providerClient(hetzner, ''), /credential was refused/);
});

test('renting stores the key, makes the machine with this lease\'s label, and releases only what it owns', async () => {
  const file = join(folder(), 'lease.json'), calls = [];
  const fetchImpl = provider(hetzner.base, {
    'GET /servers?name=a-place': { servers: [] },
    [`GET /ssh_keys?fingerprint=${encodeURIComponent(fingerprintOf(publicKey))}`]: { ssh_keys: [] },
    'POST /ssh_keys': body => ({ ssh_key: { id: 11, labels: body.labels } }),
    'POST /servers': body => ({ server: { id: 22, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.10' } } } }),
    'GET /servers/22': { server: { id: 22, status: 'running', labels: { 'place-lease': 'a-place' }, public_net: { ipv4: { ip: '192.0.2.10' } } } },
    'DELETE /servers/22': {},
    'GET /ssh_keys/11': { ssh_key: { id: 11, labels: { 'place-lease': 'a-place' } } },
    'DELETE /ssh_keys/11': {},
  }, calls);
  const request = providerClient(hetzner, canary, { fetchImpl });
  const lease = await rentMachine({ request, file, provider: hetzner, name: 'a-place', publicKey, placement: { size: 'cax11' }, lifetime: 'service' });
  assert.deepEqual([lease.state, lease.serverId, lease.sshKeyId, lease.address, lease.serverType, lease.location], ['running', 22, 11, '192.0.2.10', 'cax11', 'hel1']);
  const made = calls.find(([key]) => key === 'POST /servers')[1];
  assert.deepEqual([made.server_type, made.ssh_keys, made.labels], ['cax11', [11], { 'place-lease': 'a-place' }]);
  assert.deepEqual(await readMachine({ request, file, provider: hetzner }), { state: 'running', address: '192.0.2.10' });
  assert.equal((await releaseMachine({ request, file, provider: hetzner })).state, 'removed');
  assert.ok(calls.some(([key]) => key === 'DELETE /servers/22') && calls.some(([key]) => key === 'DELETE /ssh_keys/11'));
  assert.ok(!readFileSync(file, 'utf8').includes(canary));
});

test('a public key the provider already holds is used as it is and never removed', async () => {
  const file = join(folder(), 'lease.json'), calls = [];
  const fetchImpl = provider(hetzner.base, {
    'GET /servers?name=a-place': { servers: [] },
    [`GET /ssh_keys?fingerprint=${encodeURIComponent(fingerprintOf(publicKey))}`]: { ssh_keys: [{ id: 5, labels: {} }] },
    'POST /servers': body => ({ server: { id: 23, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.11' } } } }),
    'GET /servers/23': { server: { id: 23, labels: { 'place-lease': 'a-place' } } },
    'DELETE /servers/23': {},
  }, calls);
  const request = providerClient(hetzner, canary, { fetchImpl });
  const lease = await rentMachine({ request, file, provider: hetzner, name: 'a-place', publicKey, lifetime: 'service' });
  assert.deepEqual([lease.sshKeyId, lease.sharedSshKeyId], [null, 5]);
  assert.deepEqual(calls.find(([key]) => key === 'POST /servers')[1].ssh_keys, [5]);
  await releaseMachine({ request, file, provider: hetzner });
  assert.ok(!calls.some(([key]) => key.startsWith('POST /ssh_keys') || key.startsWith('DELETE /ssh_keys')));
});

test('a machine someone else labelled is left untouched', async () => {
  const file = join(folder(), 'lease.json');
  writeFileSync(file, JSON.stringify({ schema: 'place-lease/1', provider: 'hetzner', name: 'a-place', state: 'running', serverId: 30, sshKeyId: null }));
  const request = providerClient(hetzner, canary, { fetchImpl: provider(hetzner.base, { 'GET /servers/30': { server: { id: 30, labels: { 'place-lease': 'another' } } } }) });
  await assert.rejects(releaseMachine({ request, file, provider: hetzner }), /no longer owned by this lease/);
});

test('an existing machine is adopted at its address and only forgotten on release', async () => {
  const file = join(folder(), 'lease.json');
  const lease = await rentMachine({ request: null, file, provider: existing, name: 'a-pi', placement: { address: '192.0.2.40' }, lifetime: 'service' });
  assert.deepEqual([lease.state, lease.adopted, lease.address], ['running', true, '192.0.2.40']);
  assert.equal(await readPrice({ request: null, provider: existing, placement: {} }), null);
  assert.deepEqual(await readPrice({ request: null, provider: existing, placement: { monthly_price_cents: 300 } }), { cents: 300, currency: null });
  assert.equal((await releaseMachine({ request: null, file, provider: existing })).state, 'removed');
  await assert.rejects(rentMachine({ request: null, file: join(folder(), 'l.json'), provider: existing, name: 'a-pi', placement: { address: 'not-an-address' }, lifetime: 'service' }), /configuration was refused/);
});

test('the price is the size\'s monthly price at the lease\'s location, in cents', async () => {
  const request = providerClient(hetzner, canary, { fetchImpl: provider(hetzner.base, { 'GET /server_types?name=cax11': { server_types: [{ prices: [
    { location: 'fsn1', price_monthly: { gross: '7.9900' } }, { location: 'hel1', price_monthly: { gross: '6.9900' } },
  ] }] } }) });
  assert.deepEqual(await readPrice({ request, provider: hetzner, placement: { size: 'cax11' } }), { cents: 699, currency: 'EUR' });
  await assert.rejects(readPrice({ request, provider: hetzner, placement: { size: 'cax11', location: 'ash' } }), /no monthly price/);
});

test('the public name points at the machine with this lease\'s mark, and only that record is removed', async () => {
  const file = join(folder(), 'lease.json'), zone = 'a'.repeat(32), record = 'b'.repeat(32), calls = [];
  writeFileSync(file, JSON.stringify({ schema: 'place-lease/1', provider: 'hetzner', name: 'a-place', state: 'running', address: '192.0.2.10' }));
  const fetchImpl = provider(cloudflare.base, {
    'GET /zones?name=example.com': { result: [{ id: zone, name: 'example.com' }] },
    [`GET /zones/${zone}/dns_records?type=A&name=place.example.com`]: { result: [] },
    [`POST /zones/${zone}/dns_records`]: body => ({ result: { id: record, ...body } }),
    [`GET /zones/${zone}/dns_records/${record}`]: { result: { id: record, comment: 'place-lease a-place' } },
    [`DELETE /zones/${zone}/dns_records/${record}`]: { result: { id: record } },
  }, calls);
  const request = providerClient(cloudflare, canary, { fetchImpl });
  const lease = await pointName({ request, file, provider: cloudflare, zone: 'example.com', hostName: 'place.example.com' });
  assert.deepEqual([lease.recordId, lease.hostName], [record, 'place.example.com']);
  assert.deepEqual(calls.find(([key]) => key.startsWith('POST'))[1], { type: 'A', name: 'place.example.com', content: '192.0.2.10', ttl: 60, proxied: false, comment: 'place-lease a-place' });
  assert.equal((await forgetName({ request, file, provider: cloudflare })).recordId, null);
  assert.ok(calls.some(([key]) => key.startsWith('DELETE')));
});

test('the place config takes the machine\'s own fields and values read from the release', async () => {
  const run = async (_machine, command) => {
    assert.equal(command, "cat '/opt/place/current/data/new-accounts.json'");
    return JSON.stringify({ sign_in_ways: [{ way: 'passkey' }] });
  };
  const config = await placeConfig({}, {
    port: 7199, name: { host_name: 'place.example.com' }, place_config: { report: { takes_new_accounts: true }, router: 'router.example.com:443' },
    config_from_release: [{ at: ['new_accounts', 'sign_in_ways'], file: 'data/new-accounts.json', key: 'sign_in_ways' }],
  }, { cents: 699, currency: 'EUR' }, run);
  assert.deepEqual(config, {
    report: { takes_new_accounts: true, reach: 'https://place.example.com', cost_per_month_cents: 699 }, router: 'router.example.com:443',
    listen: '127.0.0.1:7199', accounts: '/var/lib/place/accounts', place_key_file: '/var/lib/place/place.key', public_origin: 'https://place.example.com',
    new_accounts: { sign_in_ways: [{ way: 'passkey' }] },
  });
  const behind = await placeConfig({}, { port: 7199, name: { host_name: 'place.example.com' }, public_origin: 'https://front.example.com' }, null, run);
  assert.deepEqual([behind.public_origin, behind.report.reach], ['https://front.example.com', 'https://place.example.com']);
});

test('a request\'s paths are read relative to its own file', () => {
  const here = folder(), file = join(here, 'request.json');
  writeFileSync(file, JSON.stringify({ lease_file: 'lease.json', machine: { provider: 'existing-machine' }, ssh: { known_hosts: 'known_hosts' }, engine: { release: { tarball: 'r.tar.gz' } } }));
  const request = readRequest(file);
  assert.deepEqual([request.lease_file, request.ssh.known_hosts, request.engine.release.tarball], [join(here, 'lease.json'), join(here, 'known_hosts'), join(here, 'r.tar.gz')]);
});

test('starting a place on an existing machine sets it up, installs the release, serves and reads it back', async () => {
  const here = folder(), commands = [];
  const run = async (_machine, command, input) => {
    commands.push(command);
    if (command === 'uname -m') return 'aarch64\n';
    if (command.startsWith('cat ')) return JSON.stringify({ sign_in_ways: [] });
    if (command.startsWith('install -o place')) assert.equal(JSON.parse(input).public_origin, 'https://place.example.com');
    if (command.includes("'place' 'id' '/var/lib/place/place.json'")) return 'f'.repeat(64);
    return '';
  };
  const answer = await startAPlace({
    lease_file: join(here, 'lease.json'), machine: { provider: 'existing-machine', name: 'a-pi', placement: { address: '192.0.2.40' }, lifetime: 'service' },
    name: { host_name: 'place.example.com' }, ssh: { known_hosts: join(here, 'known_hosts') }, port: 7199,
    engine: { file: 'engine', data_env: 'ENGINE_DATA', data_dir: 'data', id_argv: ['place', 'id'], release_name: 'r1', release: { on_machine: '/opt/build/release' } },
    config_from_release: [{ at: ['new_accounts', 'sign_in_ways'], file: 'data/new-accounts.json', key: 'sign_in_ways' }],
  }, { run, fetchImpl: async address => ({ status: address === 'https://place.example.com/sign-up' ? 200 : 404 }), wait: async () => {} });
  assert.deepEqual([answer.arch, answer.place_id, answer.sign_up_status, answer.release, answer.price], ['aarch64', 'f'.repeat(64), 200, '/opt/place/releases/r1', null]);
  assert.match(commands.find(c => c.startsWith('sh -s')), /^sh -s -- 'place\.example\.com' '7199' 'engine' 'ENGINE_DATA' 'data'$/);
  assert.ok(commands.some(c => c.includes('systemctl restart place.service')));
});

test('the place config carries the request\'s release feed and default places', async () => {
  const key = 'b'.repeat(64), id = 'e'.repeat(64);
  const release_feed = { urls: ['https://releases.example.com/engine-releases/feed.json'], public_keys: [key], releases: '/opt/place/releases' };
  const default_places = { holders: ['this-place', id], answering: ['this-place'] };
  const config = await placeConfig({}, { port: 7199, name: { host_name: 'place.example.com' }, release_feed, default_places }, null, async () => '');
  assert.deepEqual([config.release_feed, config.default_places], [release_feed, default_places]);
  const without = await placeConfig({}, { port: 7199, name: { host_name: 'place.example.com' } }, null, async () => '');
  assert.ok(!('release_feed' in without) && !('default_places' in without));
  await assert.rejects(placeConfig({}, { port: 7199, name: { host_name: 'p.example.com' }, release_feed: { ...release_feed, public_keys: ['short'] } }, null), /64 lowercase hex/);
  await assert.rejects(placeConfig({}, { port: 7199, name: { host_name: 'p.example.com' }, release_feed: { ...release_feed, urls: ['http://insecure.example.com/feed.json'] } }, null), /https addresses/);
  await assert.rejects(placeConfig({}, { port: 7199, name: { host_name: 'p.example.com' }, default_places: { answering: [id] } }, null), /holders must name/);
});

test('a start writes both fields into the place config it installs, and a bad feed is refused before anything is rented', async () => {
  const here = folder(), written = [];
  const run = async (_machine, command, input) => {
    if (command === 'uname -m') return 'x86_64\n';
    if (command.startsWith('install -o place')) written.push(JSON.parse(input));
    return '';
  };
  const release_feed = { urls: ['https://releases.example.com/engine-releases/feed.json'], public_keys: ['a'.repeat(64)], releases: '/opt/place/releases' };
  const default_places = { holders: ['this-place'], answering: ['this-place'] };
  const request = {
    lease_file: join(here, 'lease.json'), machine: { provider: 'existing-machine', name: 'a-pi', placement: { address: '192.0.2.41' }, lifetime: 'service' },
    name: { host_name: 'place.example.com' }, ssh: { known_hosts: join(here, 'known_hosts') }, port: 7199,
    engine: { file: 'engine', data_env: 'ENGINE_DATA', data_dir: 'data', release_name: 'r1', release: { on_machine: '/opt/build/release' } },
    release_feed, default_places,
  };
  await startAPlace(request, { run, fetchImpl: async () => ({ status: 200 }), wait: async () => {} });
  assert.deepEqual([written[0].release_feed, written[0].default_places], [release_feed, default_places]);
  const lease = join(here, 'second-lease.json');
  await assert.rejects(startAPlace({ ...request, lease_file: lease, release_feed: { urls: [] } }, { run }), /release_feed/);
  assert.throws(() => readFileSync(lease), /ENOENT/);
});

test('the sign-up check answers the way a browser does and its passkey signs what it says', async () => {
  const { checkASignUp, softwarePasskey, assertion } = await import('../do-work/check-a-sign-up.mjs');
  const { createVerify, createPublicKey } = await import('node:crypto');
  const origin = 'https://front.example', address = 'c'.repeat(64), seen = [];
  const fetchImpl = async (url, request) => {
    const path = url.slice(origin.length), body = request.body && JSON.parse(request.body);
    seen.push([request.method, path, request.headers.origin ?? null, request.headers.cookie ?? null]);
    const answer = (status, json, cookie) => ({ status, headers: { get: name => (name === 'set-cookie' ? cookie ?? null : null) }, text: async () => JSON.stringify(json ?? {}) });
    if (path === '/sign-up') return answer(200);
    if (path === '/sign-up/options') return answer(200, { options: { challenge: 'up-1', rp: { id: 'example' } } });
    if (path === '/sign-up/finish') {
      const client = JSON.parse(Buffer.from(body.response.clientDataJSON, 'base64url'));
      assert.deepEqual([client.type, client.challenge, client.origin], ['webauthn.create', 'up-1', origin]);
      assert.equal(body.response.publicKeyAlgorithm, -7);
      return answer(200, { address });
    }
    if (path === `/a/${address}/passkey/options`) return answer(200, { challenge: 'in-1', rpId: 'example' });
    if (path === `/a/${address}/passkey/finish`) return answer(200, { ok: true }, 'session=s1; Path=/; Secure; HttpOnly');
    if (path === `/a/${address}/sign-in/security`) return answer(request.headers.cookie === 'session=s1' ? 200 : 303);
    return answer(404);
  };
  const answer = await checkASignUp(origin, { fetchImpl });
  assert.equal(answer.address, address);
  assert.equal(answer.signed_in_read, true);
  assert.deepEqual(answer.steps.map(step => step.status), [200, 200, 200, 200, 200, 200, 303]);
  assert.ok(seen.filter(([method]) => method === 'POST').every(([, , sent]) => sent === origin));
  assert.ok(!JSON.stringify(answer).includes('s1'));

  // The assertion is a valid ES256 signature over authenticatorData || SHA-256(clientDataJSON).
  const passkey = softwarePasskey();
  const signed = assertion(passkey, { challenge: 'c', rpId: 'example' }, origin);
  const auth = Buffer.from(signed.response.authenticatorData, 'base64url'), client = Buffer.from(signed.response.clientDataJSON, 'base64url');
  const { createHash } = await import('node:crypto');
  const verify = createVerify('sha256').update(Buffer.concat([auth, createHash('sha256').update(client).digest()]));
  assert.ok(verify.verify(createPublicKey({ key: passkey.spki, format: 'der', type: 'spki' }), Buffer.from(signed.response.signature, 'base64url')));
  await assert.rejects(checkASignUp('https://front.example/path', { fetchImpl }), /ORIGIN is https:\/\/host/);
});
